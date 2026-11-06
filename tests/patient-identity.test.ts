import { randomUUID } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { beforeAll,beforeEach,afterAll,it,expect } from 'vitest';
import { createLocalDatabase,seedLocal } from '../packages/db/src/client.js';
import { ClinicRepository } from '../packages/db/src/repository.js';
import { DemoService } from '../apps/agent-api/src/demo-service.js';
import { withSavepoints } from '../packages/db/src/savepoints.js';
let local:Awaited<ReturnType<typeof createLocalDatabase>>,repo:ClinicRepository;
beforeAll(async()=>{local=await createLocalDatabase();repo=new ClinicRepository(local.db);});
beforeEach(async()=>{await local.engine.exec('truncate auth.users,public.clinics,public.therapists,public.patients restart identity cascade');await seedLocal(local.engine);for(const t of await repo.getTherapists())await repo.regenerate(String(t.id),Temporal.Now.plainDateISO('America/New_York').toString(),14);});
afterAll(async()=>{await local.db.close();});
async function setup(){
  const service=new DemoService(repo),chat=await service.create('Paciente Identidad QA',`bot:123:user:${randomUUID()}`);await repo.updatePatientDetails(chat.id,{phone:'2025550198'});
  const identity=(await local.db.query('select i.id,i.patient_id from public.patient_identities i join public.conversations c on c.identity_id=i.id where c.id=$1',[chat.id])).rows[0]!;
  const sibling=randomUUID();await local.db.query('insert into public.conversations(id,identity_id) values ($1,$2)',[sibling,identity.id]);
  const slot=(await local.db.query('select id,therapist_id from public.slots where active and starts_at>now() order by starts_at limit 1')).rows[0]!;
  return {chat,sibling,identity,slot};
}
it('finds appointments by the trusted patient identity even when booked in another conversation',async()=>{
  const {chat,sibling,slot}=await setup();await repo.selectSlot(sibling,String(slot.id));const booked=await repo.book(sibling,String(slot.id),randomUUID(),true);
  expect((await repo.getUpcomingAppointments(chat.id)).map(a=>a.id)).toContain(booked.id);
});
it('reuses an explicitly selected patient for a manual booking rather than creating a duplicate',async()=>{
  const {chat,slot,identity}=await setup();
  const result=await repo.createManualAppointment(String(slot.therapist_id),{slotId:String(slot.id),name:'Paciente Identidad QA',phone:'2025550198',conversationId:chat.id},randomUUID());
  expect(result.patient_id).toBe(identity.patient_id);expect(result.conversation_id).toBe(chat.id);
  expect((await local.db.query('select id from public.patients where phone=$1',['2025550198'])).rows).toHaveLength(1);
});
it('reprograms an owned appointment from a sibling chat and requires fresh confirmation',async()=>{
  const {chat,sibling,slot}=await setup();await repo.selectSlot(sibling,String(slot.id));const appointment=await repo.book(sibling,String(slot.id),randomUUID(),true);
  const service=new DemoService(repo,{model:'qa',async decide(){return {kind:'reschedule',appointmentId:null,filter:{therapist_id:null,date:null,not_before:null,not_after:null,horizon_days:14}};}});
  const options=await service.send(chat.id,{messageId:randomUUID(),text:'Quiero cambiar el turno'});expect(options.choices.some(c=>c.action==='select')).toBe(true);
  await service.send(chat.id,{messageId:randomUUID(),text:'El primero'});const result=await service.send(chat.id,{messageId:randomUUID(),text:'Sí, confirmo'});
  expect(result.hasAppointment).toBe(true);expect(result.choices.some(c=>c.action==='confirm')).toBe(false);
  expect((await repo.getUpcomingAppointments(chat.id))[0]).toMatchObject({id:appointment.id,version:1});
  expect((await local.db.query('select id from public.appointments where patient_id=(select patient_id from public.appointments where id=$1)',[appointment.id])).rows).toHaveLength(1);
});
it('does not use phone/name matching as patient authorization',async()=>{
  const {chat,slot}=await setup();const manual=await repo.createManualAppointment(String(slot.therapist_id),{slotId:String(slot.id),name:'Paciente Identidad QA',phone:'2025550198'},randomUUID());
  expect(await repo.getUpcomingAppointments(chat.id)).toHaveLength(0);
  const target=(await local.db.query('select id from public.slots where active and starts_at>now() and id<>$1 order by starts_at limit 1',[slot.id])).rows[0]!;
  await expect(repo.rescheduleAppointment(String(manual.id),String(target.id),randomUUID(),{expectedVersion:0,confirmed:true,conversationId:chat.id})).rejects.toMatchObject({code:'FORBIDDEN'});
});
it('links only after explicit confirmation, keeps appointment/history and records the original association',async()=>{
  const {chat,slot,identity}=await setup();const manual=await repo.createManualAppointment(String(slot.therapist_id),{slotId:String(slot.id),name:'Paciente Identidad QA',phone:'2025550198'},randomUUID());
  const source=String(manual.conversation_id);await repo.updatePatientDetails(source,{additional_info:'Nota manual QA'});
  await expect(repo.linkAppointmentPatient(String(manual.id),chat.id,randomUUID(),0,false)).rejects.toMatchObject({code:'CONFIRMATION_REQUIRED'});
  const key=randomUUID(),linked=await repo.linkAppointmentPatient(String(manual.id),chat.id,key,0,true);
  expect(linked).toMatchObject({id:manual.id,slot_id:manual.slot_id,therapist_id:manual.therapist_id,patient_id:identity.patient_id,conversation_id:chat.id,version:1});
  expect((await repo.getUpcomingAppointments(chat.id))[0]!.id).toBe(manual.id);
  expect((await repo.getPatientDetails(source)).additional_info).toBe('Nota manual QA');expect((await repo.getPatientDetails(chat.id)).additional_info).toBeNull();
  expect((await local.db.query('select previous_patient_id,previous_conversation_id from private.appointment_patient_links where appointment_id=$1',[manual.id])).rows[0]).toEqual({previous_patient_id:manual.patient_id,previous_conversation_id:manual.conversation_id});
  await repo.linkAppointmentPatient(String(manual.id),chat.id,key,0,true);expect((await local.db.query('select * from private.appointment_patient_links')).rows).toHaveLength(1);
  await expect(repo.linkAppointmentPatient(String(manual.id),chat.id,randomUUID(),0,true)).rejects.toMatchObject({code:'APPOINTMENT_CHANGED'});
});
it('creates a manual appointment on an existing paused chat without resuming the assistant',async()=>{
  const {chat,slot}=await setup();await new DemoService(repo).reply(chat.id,'Atención humana QA',randomUUID());
  const key=randomUUID(),input={slotId:String(slot.id),name:'Paciente Identidad QA',phone:'2025550198',conversationId:chat.id};
  const result=await repo.createManualAppointment(String(slot.therapist_id),input,key);await repo.createManualAppointment(String(slot.therapist_id),input,key);
  expect((await new DemoService(repo).get(chat.id)).status).toBe('human_led');
  expect((await local.db.query('select id from public.appointments where id=$1',[result.id])).rows).toHaveLength(1);
  expect((await new DemoService(repo).get(chat.id)).messages.filter(m=>m.text.includes('Recepción reservó'))).toHaveLength(1);
});
it('rejects changed contact instead of overwriting the selected existing patient',async()=>{
  const {chat,slot}=await setup();
  await expect(repo.createManualAppointment(String(slot.therapist_id),{slotId:String(slot.id),name:'Otra persona',phone:'2025550198',conversationId:chat.id},randomUUID())).rejects.toMatchObject({code:'PATIENT_DETAILS_CHANGED'});
  expect((await repo.getPatientDetails(chat.id)).name).toBe('Paciente Identidad QA');
});
it('searches only within the therapist scope and prefers the verified Telegram conversation',async()=>{
  const {chat,slot,identity}=await setup();await local.db.query('insert into private.telegram_bots(bot_id) values (123) on conflict do nothing');await local.db.query('insert into private.telegram_peers(bot_id,user_id,conversation_id) values (123,456,$1)',[chat.id]);
  expect(await repo.searchPatients('Identidad',String(slot.therapist_id))).toHaveLength(0);
  await repo.selectSlot(chat.id,String(slot.id));await repo.book(chat.id,String(slot.id),randomUUID(),true);
  const results=await repo.searchPatients('Identidad',String(slot.therapist_id));expect(results).toHaveLength(1);expect(results[0]).toMatchObject({id:identity.patient_id,conversation_id:chat.id,telegram:true});
});
it('keeps link audit data private and supports the backend login',async()=>{
  const {chat,slot}=await setup();const manual=await repo.createManualAppointment(String(slot.therapist_id),{slotId:String(slot.id),name:'Paciente Manual QA',phone:'2025550198'},randomUUID());
  await local.db.transaction(async db=>{await db.query('set local role nexo_backend');const scoped=new ClinicRepository(withSavepoints(db));await scoped.linkAppointmentPatient(String(manual.id),chat.id,randomUUID(),0,true);});
  await expect(local.db.transaction(async db=>{await db.query('set local role authenticated');await db.query('select * from private.appointment_patient_links');})).rejects.toThrow(/permission denied/);
});
