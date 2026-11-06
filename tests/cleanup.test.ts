import {randomUUID} from 'node:crypto';
import {Temporal} from '@js-temporal/polyfill';
import {beforeAll,afterAll,expect,it} from 'vitest';
import {createLocalDatabase,seedLocal} from '../packages/db/src/client.js';
import {ClinicRepository} from '../packages/db/src/repository.js';
import {DemoService} from '../apps/agent-api/src/demo-service.js';
import {buildApp} from '../apps/agent-api/src/app.js';
let local:Awaited<ReturnType<typeof createLocalDatabase>>,repo:ClinicRepository,demo:DemoService,app:ReturnType<typeof buildApp>;
const headers={authorization:`Bearer ${'cleanup-test-'.repeat(4)}`};
beforeAll(async()=>{local=await createLocalDatabase();await seedLocal(local.engine);repo=new ClinicRepository(local.db);demo=new DemoService(repo);app=buildApp(repo,'cleanup-test-'.repeat(4),{demo});
 for(const t of await repo.getTherapists())await repo.regenerate(String(t.id),Temporal.Now.plainDateISO('America/New_York').toString(),21);
});
afterAll(async()=>{await app.close();await local.db.close();});
const booked=async()=>{
 const chat=await demo.create('Paciente Limpieza');await repo.updatePatientDetails(chat.id,{phone:'2025550113'});
 const choices=await demo.send(chat.id,{messageId:randomUUID(),action:'start'}),slotId=choices.choices.find(c=>c.action==='select')!.slotId!;
 await repo.selectSlot(chat.id,slotId);const appointment=await repo.book(chat.id,slotId,randomUUID(),true);
 return{chat,slotId,appointment};
};
it('removes a booked slot from the agenda, frees it, and restores it without deleting the patient',async()=>{
 const {chat,slotId,appointment}=await booked();const url=`/v1/appointments/${appointment.id}`;
 const removed=await app.inject({method:'DELETE',url,headers});expect(removed.statusCode).toBe(200);
 expect((await demo.dashboard()).appointments.some(a=>a.id===appointment.id)).toBe(false);
 expect((await local.db.query('select status from public.appointments where id=$1',[appointment.id])).rows[0]!.status).toBe('cancelled');
 expect((await local.db.query('select status from private.delivery_jobs where appointment_id=$1',[appointment.id])).rows.every(r=>r.status==='cancelled')).toBe(true);
 expect((await repo.getPatientDetails(chat.id)).name).toBe('Paciente Limpieza');
 expect((await app.inject({method:'POST',url:`${url}/restore`,headers})).statusCode).toBe(200);
 expect((await local.db.query("select id from public.appointments where slot_id=$1 and status='confirmed'",[slotId])).rows).toHaveLength(1);
});
it('hides a conversation and messages, pauses the agent, keeps appointments and restores the previous state',async()=>{
 const {chat,appointment}=await booked();await demo.send(chat.id,{messageId:randomUUID(),action:'human'});
 const before=await demo.get(chat.id),url=`/v1/demo/conversations/${chat.id}`;
 expect((await app.inject({method:'DELETE',url,headers})).statusCode).toBe(200);
 expect((await app.inject({url,headers})).statusCode).toBe(404);
 expect((await demo.dashboard()).conversations.some(c=>c.id===chat.id)).toBe(false);
 expect((await local.db.query('select status from public.appointments where id=$1',[appointment.id])).rows[0]!.status).toBe('confirmed');
 expect((await app.inject({method:'POST',url:`${url}/messages`,headers,payload:{messageId:randomUUID(),text:'Hola'}})).statusCode).toBe(404);
 expect((await app.inject({method:'POST',url:`${url}/restore`,headers})).statusCode).toBe(200);
 const restored=await demo.get(chat.id);expect(restored.status).toBe('handed_off');expect(restored.messages).toEqual(before.messages);
});
it('rejects unauthorized cleanup and missing IDs without changing data',async()=>{
 const {chat,appointment}=await booked();
 for(const url of [`/v1/appointments/${appointment.id}`,`/v1/demo/conversations/${chat.id}`]){
  expect((await app.inject({method:'DELETE',url})).statusCode).toBe(401);
  expect((await app.inject({method:'POST',url:`${url}/restore`})).statusCode).toBe(401);
 }
 expect((await app.inject({method:'DELETE',url:`/v1/appointments/${randomUUID()}`,headers})).statusCode).toBe(404);
 expect((await app.inject({method:'DELETE',url:'/v1/demo/conversations/not-a-uuid',headers})).statusCode).toBe(400);
 expect((await demo.get(chat.id)).status).toBe('active');
});
it('makes repeated removal idempotent and prevents restoring over another booking, with rollback of notifications',async()=>{
 const {chat,appointment,slotId}=await booked();const url=`/v1/appointments/${appointment.id}`;
 await app.inject({method:'DELETE',url,headers});await app.inject({method:'DELETE',url,headers});
 const cancelled=(await app.inject({url:'/v1/demo/removed/appointments',headers})).json();expect(cancelled.some((a:{id:string})=>a.id===appointment.id)).toBe(true);
 const other=await demo.create('Otro Paciente');await repo.updatePatientDetails(other.id,{phone:'2025550114'});
 await repo.selectSlot(other.id,slotId);await repo.book(other.id,slotId,randomUUID(),true);
 const restore=await app.inject({method:'POST',url:`${url}/restore`,headers});expect(restore.statusCode).toBe(409);expect(restore.json().error).toBe('SLOT_UNAVAILABLE');
 expect((await local.db.query("select action from private.audit_events where conversation_id=$1 and action='appointment_cancelled'",[chat.id])).rows).toHaveLength(1);
 expect((await local.db.query('select status from private.delivery_jobs where appointment_id=$1',[appointment.id])).rows.every(r=>r.status==='cancelled')).toBe(true);
});
it('lists archived conversations for recovery and clears an old selection when restoring an active chat',async()=>{
 const chat=await demo.create('Paciente Recuperable');const offered=await demo.send(chat.id,{messageId:randomUUID(),action:'start'});
 await demo.send(chat.id,{messageId:randomUUID(),action:'select',slotId:offered.choices.find(c=>c.action==='select')!.slotId});
 await demo.archive(chat.id,true);await demo.archive(chat.id,true);
 const archived=(await app.inject({url:'/v1/demo/removed/conversations',headers})).json();expect(archived.some((c:{id:string})=>c.id===chat.id)).toBe(true);
 await demo.archive(chat.id,false);expect((await demo.get(chat.id)).status).toBe('active');
 expect(demo.sessions.get(chat.id)!.selected).toBeNull();
 expect((await local.db.query('select pending_slot_id from public.conversations where id=$1',[chat.id])).rows[0]!.pending_slot_id).toBeNull();
 expect((await local.db.query("select id from private.audit_events where conversation_id=$1 and action='conversation_archived'",[chat.id])).rows).toHaveLength(1);
});
