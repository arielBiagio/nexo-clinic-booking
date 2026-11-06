import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { Temporal } from '@js-temporal/polyfill';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createLocalDatabase, seedLocal, type Sql } from '../packages/db/src/client.js';
import { ClinicRepository } from '../packages/db/src/repository.js';
import { DemoService } from '../apps/agent-api/src/demo-service.js';
import type { IntentModel } from '../packages/agent/src/openrouter.js';
import { withSavepoints } from '../packages/db/src/savepoints.js';

let local:Awaited<ReturnType<typeof createLocalDatabase>>,repo:ClinicRepository;
beforeAll(async()=>{
  local=await createLocalDatabase();await seedLocal(local.engine);repo=new ClinicRepository(local.db);
  for(const t of await repo.getTherapists())await repo.regenerate(String(t.id),Temporal.Now.plainDateISO('America/New_York').toString(),14);
});
afterAll(async()=>{await local.db.close();});
const restart=(model?:IntentModel)=>new DemoService(new ClinicRepository(local.db),model);
async function selected(){
  const service=restart(),chat=await service.create('Paciente Historia QA');await repo.updatePatientDetails(chat.id,{phone:'2025550198'});
  const offered=await service.send(chat.id,{messageId:randomUUID(),action:'start'});
  const choice=offered.choices.find(c=>c.action==='select')!;
  const chosen=await service.send(chat.id,{messageId:randomUUID(),action:'select',slotId:choice.slotId});
  return {chat:chosen,choice};
}

it('retains ordered messages and pending choices through an actual database shutdown and reopen',async()=>{
  const root=resolve('.local');await mkdir(root,{recursive:true});const dataDir=await mkdtemp(resolve(root,'history-test-'));
  let disk:Awaited<ReturnType<typeof createLocalDatabase>>|undefined;
  try{
    disk=await createLocalDatabase({dataDir});await seedLocal(disk.engine);
    const r=new ClinicRepository(disk.db);for(const t of await r.getTherapists())await r.regenerate(String(t.id),Temporal.Now.plainDateISO('America/New_York').toString(),14);
    const service=new DemoService(r),chat=await service.create('Paciente Persistente');
    const expected=await service.send(chat.id,{messageId:randomUUID(),action:'start'});
    await disk.db.close();disk=undefined;disk=await createLocalDatabase({dataDir});
    const restored=await new DemoService(new ClinicRepository(disk.db)).get(chat.id);
    expect(restored.messages).toEqual(expected.messages);expect(restored.choices).toEqual(expected.choices);
    expect(restored.messages.map(m=>m.role)).toEqual(['assistant','patient','assistant']);
  }finally{
    await disk?.db.close();if(dirname(dataDir)!==root)throw new Error('Unexpected test path');await rm(dataDir,{recursive:true,force:true});
  }
});
it('preserves search preferences and model history after replacing the service instance',async()=>{
  const filter={therapist_id:null,date:null,not_before:'13:00',not_after:'17:00',horizon_days:14};
  const decide=vi.fn<IntentModel['decide']>().mockResolvedValue({kind:'availability',filter});
  const model={model:'qa',decide};let service=restart(model);const chat=await service.create();
  const first=await service.send(chat.id,{messageId:randomUUID(),text:'Quiero fisio por la tarde'});
  service=restart(model);await service.send(chat.id,{messageId:randomUUID(),text:'¿Y otro día?'});
  const context=decide.mock.calls.at(-1)![0];expect(context.search?.not_before).toBe('13:00');
  expect(context.history.slice(0,-1)).toEqual(first.messages.map(({role,text})=>({role,text})));
  expect(context.offered.length).toBeGreaterThan(0);
});
it('uses the previously offered ordinal after restart and requires confirmation',async()=>{
  const service=restart(),chat=await service.create();const offered=await service.send(chat.id,{messageId:randomUUID(),action:'start'});
  const fresh=restart(),chosen=await fresh.send(chat.id,{messageId:randomUUID(),text:'El primero'});
  expect(fresh.sessions.get(chat.id)!.selected).toBe(offered.choices.find(c=>c.action==='select')!.slotId);
  expect(chosen.messages.at(-1)!.text).toContain('nombre y teléfono');expect(chosen.hasAppointment).toBe(false);
});
it('confirms once across two service instances and deduplicates confirmations after restart',async()=>{
  const {chat}=await selected();const input={messageId:randomUUID(),action:'confirm' as const};
  const [a,b]=await Promise.all([restart().send(chat.id,input),restart().send(chat.id,input)]);
  expect(a.messages).toEqual(b.messages);expect(a.hasAppointment).toBe(true);
  expect((await local.db.query('select id from public.appointments where conversation_id=$1',[chat.id])).rows).toHaveLength(1);
  expect((await restart().send(chat.id,input)).messages).toEqual(a.messages);
});
it('rejects reuse of an input ID with a different payload or author',async()=>{
  const s=restart(),chat=await s.create(),messageId=randomUUID();await s.send(chat.id,{messageId,text:'Hola'});
  const before=await s.get(chat.id);
  await expect(restart().send(chat.id,{messageId,text:'Otro mensaje'})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
  await expect(restart().reply(chat.id,'Hola',messageId)).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
  expect((await restart().get(chat.id)).messages).toEqual(before.messages);
});
it('expires a pending selection across restart instead of restoring its confirm button',async()=>{
  const {chat}=await selected();await local.db.query("update public.conversations set pending_expires_at=now()-interval '1 minute' where id=$1",[chat.id]);
  const s=restart(),restored=await s.get(chat.id);expect(s.sessions.get(chat.id)!.selected).toBeNull();expect(restored.choices.some(c=>c.action==='confirm')).toBe(false);
  const result=await s.send(chat.id,{messageId:randomUUID(),action:'confirm'});expect(result.hasAppointment).toBe(false);
});
it('preserves staff replies, pause state, archive history and SQL inbox previews',async()=>{
  let s=restart();const chat=await s.create();await s.send(chat.id,{messageId:randomUUID(),action:'human'});
  const messageId=randomUUID(),expected=await s.reply(chat.id,'Hola, soy recepción QA',messageId);s=restart();
  expect((await s.reply(chat.id,'Hola, soy recepción QA',messageId)).messages).toEqual(expected.messages);
  const inbox=(await s.dashboard()).conversations.find(c=>c.id===chat.id)!;
  expect(inbox.preview).toBe('Hola, soy recepción QA');expect(inbox.messageCount).toBe(expected.messages.length);
  const paused=await s.send(chat.id,{messageId:randomUUID(),text:'Gracias'});expect(paused.status).toBe('human_led');expect(paused.messages.at(-1)!.role).toBe('patient');
  await s.archive(chat.id,true);await expect(restart().get(chat.id)).rejects.toMatchObject({code:'CONVERSATION_NOT_FOUND'});
  await restart().archive(chat.id,false);expect((await restart().get(chat.id)).messages).toEqual(paused.messages);
});
it('rolls back a booking together with transcript/state when persistence fails, then retries safely',async()=>{
  const {chat}=await selected();const input={messageId:randomUUID(),action:'confirm' as const};
  const fail=(db:Sql):Sql=>({query:async(text,values)=>{if(text.startsWith('insert into public.messages'))throw new Error('simulated storage failure');return db.query(text,values);},
    transaction:operation=>db.transaction(tx=>operation(fail(tx))),close:async()=>{}});
  await expect(new DemoService(new ClinicRepository(fail(local.db))).send(chat.id,input)).rejects.toThrow('simulated storage failure');
  expect((await restart().get(chat.id)).messages).toEqual(chat.messages);
  expect((await local.db.query('select id from public.appointments where conversation_id=$1',[chat.id])).rows).toHaveLength(0);
  expect((await restart().send(chat.id,input)).hasAppointment).toBe(true);
});
it('persists an unavailable-slot reply without leaving its transaction aborted',async()=>{
  const {chat,choice}=await selected();const other=await restart().create('Otro Paciente QA');await repo.updatePatientDetails(other.id,{phone:'2025550110'});
  await repo.selectSlot(other.id,choice.slotId!);await repo.book(other.id,choice.slotId!,randomUUID(),true);
  const result=await restart().send(chat.id,{messageId:randomUUID(),action:'confirm'});
  expect(result.hasAppointment).toBe(false);expect(result.messages.at(-1)!.text).toContain('ya no está disponible');
  expect((await restart().get(chat.id)).messages).toEqual(result.messages);
});
it('does not expose message bodies or runtime state to anonymous users or therapists',async()=>{
  const chat=await restart().create('Paciente Privado QA');
  await local.db.transaction(async db=>{
    await db.query('set local role authenticated');
    expect((await db.query('select body from public.messages where conversation_id=$1',[chat.id])).rows).toEqual([]);
  });
  await expect(local.db.transaction(async db=>{await db.query('set local role anon');await db.query('select body from public.messages');})).rejects.toThrow(/permission denied/);
  await expect(local.db.transaction(async db=>{await db.query('set local role authenticated');await db.query('select state from private.conversation_runtime');})).rejects.toThrow(/permission denied/);
});
it('lets the least-privileged backend role persist messages and context with RLS enabled',async()=>{
  const chat=await restart().create('Paciente Backend QA');
  await local.db.transaction(async db=>{
    await db.query('set local role nexo_backend');
    const s=new DemoService(new ClinicRepository(withSavepoints(db)));
    const result=await s.reply(chat.id,'Respuesta persistida QA',randomUUID());
    expect(result.messages.at(-1)!.text).toBe('Respuesta persistida QA');
  });
  expect((await restart().get(chat.id)).messages.at(-1)!.text).toBe('Respuesta persistida QA');
});
