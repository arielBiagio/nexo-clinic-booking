import { randomUUID } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createLocalDatabase,seedLocal } from '../packages/db/src/client.js';
import { ClinicRepository } from '../packages/db/src/repository.js';
import { DemoService } from '../apps/agent-api/src/demo-service.js';
import type { IntentModel } from '../packages/agent/src/openrouter.js';
let local:Awaited<ReturnType<typeof createLocalDatabase>>,repo:ClinicRepository;
beforeAll(async()=>{local=await createLocalDatabase();await seedLocal(local.engine);repo=new ClinicRepository(local.db);for(const t of await repo.getTherapists())await repo.regenerate(String(t.id),Temporal.Now.plainDateISO('America/New_York').toString(),14);});
afterAll(async()=>{await local.db.close();});
it.each(['El primer horario me sirve.','El primero','Prefiero la segunda opción','El último, por favor'])('keeps an unambiguous offered selection before asking for contact: %s',async text=>{
  const decide=vi.fn<IntentModel['decide']>().mockResolvedValue({kind:'reply',text:'Necesito tu nombre y teléfono.'});
  const service=new DemoService(repo,{model:'qa',decide}),chat=await service.create('Paciente QA');
  const offered=await service.send(chat.id,{messageId:randomUUID(),action:'start'}),slots=offered.choices.filter(c=>c.action==='select');
  const index=/segunda/.test(text)?1:/último/.test(text)?slots.length-1:0;
  await service.send(chat.id,{messageId:randomUUID(),text});
  expect(service.sessions.get(chat.id)!.selected).toBe(slots[index]!.slotId);
  expect(decide).not.toHaveBeenCalled();
  expect((await local.db.query('select id from public.appointments where conversation_id=$1',[chat.id])).rows).toHaveLength(0);
});
it.each(['El primero no me sirve','El primero del miércoles','El primero, pero con otro terapeuta'])('does not silently select a rejected or qualified option: %s',async text=>{
  const decide=vi.fn<IntentModel['decide']>().mockResolvedValue({kind:'reply',text:'¿Qué horario te conviene?'});
  const service=new DemoService(repo,{model:'qa',decide}),chat=await service.create('Paciente QA');await service.send(chat.id,{messageId:randomUUID(),action:'start'});
  await service.send(chat.id,{messageId:randomUUID(),text});expect(service.sessions.get(chat.id)!.selected).toBeNull();
});
it.each(['Ese horario no me sirve','El primero no me sirve'])('clears an already selected slot when rejected before a later confirmation: %s',async text=>{
  const decide=vi.fn<IntentModel['decide']>().mockResolvedValue({kind:'reply',text:'¿Qué otro horario te conviene?'});
  const service=new DemoService(repo,{model:'qa',decide}),chat=await service.create('Paciente QA');await repo.updatePatientDetails(chat.id,{phone:'2025550198'});
  await service.send(chat.id,{messageId:randomUUID(),action:'start'});await service.send(chat.id,{messageId:randomUUID(),text:'El primero'});
  expect(service.sessions.get(chat.id)!.selected).toBeTruthy();await service.send(chat.id,{messageId:randomUUID(),text});expect(service.sessions.get(chat.id)!.selected).toBeNull();
  await service.send(chat.id,{messageId:randomUUID(),text:'Sí, confirmo'});expect((await local.db.query('select id from public.appointments where conversation_id=$1',[chat.id])).rows).toHaveLength(0);
});
it('keeps the selected appointment when a negative answer concerns optional insurance',async()=>{
  const decide=vi.fn<IntentModel['decide']>().mockResolvedValue({kind:'reply',text:'El seguro es opcional.'});
  const service=new DemoService(repo,{model:'qa',decide}),chat=await service.create('Paciente QA');await service.send(chat.id,{messageId:randomUUID(),action:'start'});await service.send(chat.id,{messageId:randomUUID(),text:'El primero'});
  const selected=service.sessions.get(chat.id)!.selected;await service.send(chat.id,{messageId:randomUUID(),text:'No tengo seguro'});expect(service.sessions.get(chat.id)!.selected).toBe(selected);
});
