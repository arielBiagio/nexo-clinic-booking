import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Temporal } from '@js-temporal/polyfill';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createLocalDatabase, seedLocal } from '../packages/db/src/client.js';
import { ClinicRepository } from '../packages/db/src/repository.js';
import { DemoService } from '../apps/agent-api/src/demo-service.js';
import { OpenRouterModel, type IntentModel } from '../packages/agent/src/openrouter.js';
import { groundedPatientPatch } from '../packages/core/src/patient.js';
import { buildApp } from '../apps/agent-api/src/app.js';

let local:Awaited<ReturnType<typeof createLocalDatabase>>,repo:ClinicRepository;
beforeAll(async()=>{local=await createLocalDatabase();await seedLocal(local.engine);repo=new ClinicRepository(local.db);
  const today=Temporal.Now.plainDateISO('America/New_York').toString();for(const t of await repo.getTherapists())await repo.regenerate(String(t.id),today,21);
});
afterAll(async()=>local.db.close());
it('saves a patient name supplied in the conversation instead of merely acknowledging it',async()=>{
  const model:IntentModel={model:'test',decide:async()=>({kind:'patient',details:{name:'Martina Demo',phone:null,insurance:null,reported_reason:null,additional_info:null}})};
  const service=new DemoService(repo,model),chat=await service.create();
  const result=await service.send(chat.id,{messageId:randomUUID(),text:'Me llamo Martina Demo.'});
  expect(result.name).toBe('Martina Demo');
  expect(result.patient.name_collected).toBe(true);
  expect(result.messages.at(-1)!.text).toContain('teléfono');
});

const details={name:null,phone:null,insurance:null,reported_reason:null,additional_info:null};
const appointments=async(id:string)=>(await local.db.query('select id from public.appointments where conversation_id=$1',[id])).rows;
const pick=async(service:DemoService,id:string)=>{
  const offer=await service.send(id,{messageId:randomUUID(),action:'start'});
  const slotId=offer.choices.find(c=>c.action==='select')!.slotId!;
  return {slotId,chat:await service.send(id,{messageId:randomUUID(),action:'select',slotId})};
};
it('allows browsing but blocks both chat and direct booking until name AND phone exist, with no partial writes',async()=>{
  const service=new DemoService(repo),chat=await service.create();
  const {slotId,chat:selected}=await pick(service,chat.id);
  expect(selected.choices.some(c=>c.action==='confirm')).toBe(false);
  expect(selected.messages.at(-1)!.text).toContain('nombre y teléfono');
  await service.send(chat.id,{messageId:randomUUID(),action:'confirm'});
  await expect(repo.book(chat.id,slotId,'missing-contact-01',true)).rejects.toMatchObject({code:'PATIENT_DETAILS_REQUIRED'});
  await repo.updatePatientDetails(chat.id,{name:'Paciente Sin Teléfono'});
  await expect(repo.book(chat.id,slotId,'missing-contact-02',true)).rejects.toMatchObject({code:'PATIENT_DETAILS_REQUIRED'});
  expect(await appointments(chat.id)).toHaveLength(0);
  expect((await local.db.query("select * from private.audit_events where conversation_id=$1 and action='appointment_booked'",[chat.id])).rows).toHaveLength(0);
  await repo.updatePatientDetails(chat.id,{phone:'+1 (202) 555-0108'});
  expect((await service.get(chat.id)).choices.some(c=>c.action==='confirm')).toBe(true);
  await service.send(chat.id,{messageId:randomUUID(),action:'confirm'});
  expect(await appointments(chat.id)).toHaveLength(1);
});
it('collects contact in separate messages, keeps the selected slot and asks fresh consent instead of booking automatically',async()=>{
  const decide=vi.fn<IntentModel['decide']>();const service=new DemoService(repo,{model:'test',decide}),chat=await service.create();
  const {slotId}=await pick(service,chat.id);
  decide.mockResolvedValueOnce({kind:'patient',details:{...details,name:'Martina Demo'}});
  await service.send(chat.id,{messageId:randomUUID(),text:'Martina Demo'});
  decide.mockResolvedValueOnce({kind:'patient',details:{...details,phone:'202 555 0108'}});
  const saved=await service.send(chat.id,{messageId:randomUUID(),text:'Mi número es 202 555 0108, sí confirmo.'});
  expect(saved.patient.phone).toBe('2025550108');
  expect(saved.messages.at(-1)!.text).toContain('Martina Demo');
  expect(saved.messages.at(-1)!.text).toContain('¿Lo confirmás?');
  expect(service.sessions.get(chat.id)!.selected).toBe(slotId);
  expect(await appointments(chat.id)).toHaveLength(0);
  await service.send(chat.id,{messageId:randomUUID(),text:'Sí, confirmo.'});
  expect(await appointments(chat.id)).toHaveLength(1);
});
it('updates a name and optional patient-reported facts AFTER booking, without duplicating the appointment or losing contact',async()=>{
  const decide=vi.fn<IntentModel['decide']>();const service=new DemoService(repo,{model:'test',decide}),chat=await service.create('Nombre Anterior');
  await repo.updatePatientDetails(chat.id,{phone:'2025550109'});await pick(service,chat.id);
  await service.send(chat.id,{messageId:randomUUID(),action:'confirm'});
  const before=await appointments(chat.id);
  decide.mockResolvedValueOnce({kind:'patient',details:{...details,name:'Martina Demo',insurance:'Seguro Demo',reported_reason:'lumbalgia',additional_info:'necesito acceso por rampa'}});
  const input={messageId:randomUUID(),text:'Mi nombre correcto es Martina Demo. Tengo Seguro Demo. Mi diagnóstico referido es lumbalgia y necesito acceso por rampa.'};
  const updated=await service.send(chat.id,input);await service.send(chat.id,input);
  expect(updated.patient).toMatchObject({name:'Martina Demo',phone:'2025550109',insurance:'Seguro Demo',reported_reason:'lumbalgia',additional_info:'necesito acceso por rampa'});
  expect(updated.patient.intake_summary).toContain('no verificado');
  expect(await appointments(chat.id)).toEqual(before);
  expect(decide).toHaveBeenCalledTimes(1);
  const booked=(await repo.getUpcomingAppointments(chat.id))[0]!;
  const day=Temporal.Instant.from(new Date(String(booked.starts_at)).toISOString()).toZonedDateTimeISO('America/New_York').toPlainDate();
  const week=day.subtract({days:day.dayOfWeek-1}).toString();
  expect((await service.dashboard(week)).appointments.find(a=>a.conversation_id===chat.id)?.patient_name).toBe('Martina Demo');
  const audits=(await local.db.query("select action,entity_id from private.audit_events where conversation_id=$1 and action='patient_details_updated'",[chat.id])).rows;
  expect(audits).toHaveLength(2);expect(JSON.stringify(audits)).not.toContain('lumbalgia');
});
it('does not save a model-invented name, phone prefix or clinical interpretation',()=>{
  expect(()=>groundedPatientPatch({name:'Inventado',phone:'+12025550108'},'Hola')).toThrow();
  expect(()=>groundedPatientPatch({phone:'+12025550108'},'Mi teléfono es 2025550108')).toThrow();
  expect(groundedPatientPatch({name:'Martina Demo',reported_reason:'hernia lumbar'},'Me llamo Martina Demo y tengo una molestia')).toEqual({name:'Martina Demo'});
});
it('exposes a strict patient tool through the actual OpenRouter adapter, with no patient ID from the model',async()=>{
  const transport=vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({choices:[{finish_reason:'tool_calls',message:{content:null,tool_calls:[{type:'function',function:{name:'update_patient_details',arguments:JSON.stringify({...details,name:'Martina Demo',phone:'2025550108'})}}]}}]})));
  const decision=await new OpenRouterModel('mock-key',{fetch:transport}).decide({now:new Date().toISOString(),timeZone:'America/New_York',clinicName:'Demo',therapists:[],offered:[],selectedSlotId:null,history:[{role:'patient',text:'Martina Demo, 2025550108'}]});
  expect(decision).toMatchObject({kind:'patient',details:{name:'Martina Demo'}});
  const body=JSON.parse(String(transport.mock.calls[0]![1]!.body));
  const tool=body.tools.find((t:{function:{name:string}})=>t.function.name==='update_patient_details');
  expect(tool.function.strict).toBe(true);expect(tool.function.parameters.properties).not.toHaveProperty('patient_id');
});
it('handles GPT-4o mini returning contact plus selection together by saving ONLY contact and requiring a later confirmation',async()=>{
  const transport=vi.fn<typeof fetch>().mockImplementation(async()=>new Response(JSON.stringify({choices:[{finish_reason:'tool_calls',message:{content:null,tool_calls:[
    {type:'function',function:{name:'update_patient_details',arguments:JSON.stringify({...details,phone:'202 555 0108'})}},
    {type:'function',function:{name:'book_selected_slot',arguments:'{}'}},
  ]}}]})));
  const service=new DemoService(repo,new OpenRouterModel('mock-key',{fetch:transport})),chat=await service.create('Martina Demo');
  await pick(service,chat.id);
  const answer=await service.send(chat.id,{messageId:randomUUID(),text:'Mi teléfono es 202 555 0108.'});
  expect(answer.patient.phone).toBe('2025550108');expect(answer.status).toBe('active');
  expect(await appointments(chat.id)).toHaveLength(0);
  expect(answer.choices.some(c=>c.action==='confirm')).toBe(true);
});
it('authenticates profile reads/edits, derives identity from the conversation and validates phone/required data',async()=>{
  const service=new DemoService(repo),a=await service.create(),b=await service.create();
  const token='patient-test-token-'.repeat(3),app=buildApp(repo,token,{demo:service});const headers={authorization:`Bearer ${token}`};
  try{
    const url=`/v1/conversations/${a.id}/patient`;
    expect((await app.inject({url})).statusCode).toBe(401);
    for(const payload of [{phone:'123'},{name:''},{name:'Martina Demo',patient_id:b.id}])expect((await app.inject({method:'PATCH',url,headers,payload})).statusCode).toBe(400);
    expect((await app.inject({method:'PATCH',url,headers,payload:{name:'Martina Demo',phone:'202-555-0108',insurance:'Seguro Demo'}})).statusCode).toBe(200);
    expect((await repo.getPatientDetails(b.id)).phone).toBeNull();
    await app.inject({method:'PATCH',url,headers,payload:{insurance:''}});
    expect((await repo.getPatientDetails(a.id)).insurance).toBeNull();
    expect((await repo.getPatientDetails(a.id)).intake_summary).not.toContain('Seguro Demo');
    expect((await app.inject({url:`/v1/conversations/${randomUUID()}/patient`,headers})).statusCode).toBe(404);
  }finally{await app.close();}
});
it('persists the profile and summary through a database and service restart and applies migrations only once',async()=>{
  const root=resolve('.local');await mkdir(root,{recursive:true});const dataDir=await mkdtemp(resolve(root,'intake-test-'));
  let db:Awaited<ReturnType<typeof createLocalDatabase>>|undefined;
  try{
    db=await createLocalDatabase({dataDir});await seedLocal(db.engine);
    const r=new ClinicRepository(db.db),s=new DemoService(r),chat=await s.create();
    await r.updatePatientDetails(chat.id,{name:'Paciente Persistente',phone:'2025550110',insurance:'Seguro Demo'});
    const expected=await r.getPatientDetails(chat.id);await s.archive(chat.id,true);await db.db.close();db=undefined;
    db=await createLocalDatabase({dataDir});
    await expect(new DemoService(new ClinicRepository(db.db)).get(chat.id)).rejects.toMatchObject({code:'CONVERSATION_NOT_FOUND'});
    await new ClinicRepository(db.db).setConversationArchived(chat.id,false);
    const restored=await new DemoService(new ClinicRepository(db.db)).get(chat.id);
    expect(restored.patient).toEqual(expected);
    expect(restored.messages).toEqual(chat.messages);
    expect((await db.db.query<{name:string}>('select name from local_harness.migrations')).rows.map(row=>row.name).sort()).toEqual((await readdir(resolve('supabase/migrations'))).filter(name=>name.endsWith('.sql')).sort());
  }finally{
    await db?.db.close();
    if(dirname(dataDir)!==root)throw new Error('Unexpected test data path');
    await rm(dataDir,{recursive:true,force:true});
  }
});
