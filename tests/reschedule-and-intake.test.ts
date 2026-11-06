import { randomUUID } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { beforeAll,beforeEach,afterAll,it,expect,vi } from 'vitest';
import { createLocalDatabase,seedLocal } from '../packages/db/src/client.js';
import { ClinicRepository } from '../packages/db/src/repository.js';
import { DemoService } from '../apps/agent-api/src/demo-service.js';
import type { IntentModel } from '../packages/agent/src/openrouter.js';
import { OpenRouterModel } from '../packages/agent/src/openrouter.js';
import { buildApp } from '../apps/agent-api/src/app.js';
import { withSavepoints } from '../packages/db/src/savepoints.js';
import { renderNarration } from '../packages/agent/src/narration.js';
let local:Awaited<ReturnType<typeof createLocalDatabase>>,repo:ClinicRepository;
beforeAll(async()=>{local=await createLocalDatabase();repo=new ClinicRepository(local.db);});
beforeEach(async()=>{await local.engine.exec('truncate auth.users,public.clinics,public.therapists,public.patients restart identity cascade');await seedLocal(local.engine);for(const t of await repo.getTherapists())await repo.regenerate(String(t.id),Temporal.Now.plainDateISO('America/New_York').toString(),21);});
afterAll(async()=>{await local.db.close();});
async function booked(){const service=new DemoService(repo),chat=await service.create('Paciente Cambio QA');await repo.updatePatientDetails(chat.id,{phone:'2025550198'});
  const offered=await service.send(chat.id,{messageId:randomUUID(),action:'start'}),slot=offered.choices.find(c=>c.action==='select')!;
  await service.send(chat.id,{messageId:randomUUID(),action:'select',slotId:slot.slotId});await service.send(chat.id,{messageId:randomUUID(),action:'confirm'});
  const appointment=(await local.db.query('select * from public.appointments where conversation_id=$1',[chat.id])).rows[0]!;
  return {chat,service,appointment};}
it('stores an explicit diagnosis after confirmation even when the model would escalate it',async()=>{
  const {chat}=await booked(),decide=vi.fn<IntentModel['decide']>().mockResolvedValue({kind:'handoff',reason:'clinical'});
  const result=await new DemoService(repo,{model:'qa',decide}).send(chat.id,{messageId:randomUUID(),text:'Mi diagnóstico es lumbalgia, quería que quede anotado.'});
  expect((await repo.getPatientDetails(chat.id)).reported_reason).toContain('lumbalgia');expect(result.status).toBe('active');expect(decide).not.toHaveBeenCalled();
  expect((await local.db.query('select * from public.appointments where conversation_id=$1',[chat.id])).rows).toHaveLength(1);
});
it('moves the same appointment atomically and leaves the original slot free',async()=>{
  const {chat,appointment}=await booked(),t=String(appointment.therapist_id),today=Temporal.Now.plainDateISO('America/New_York');
  const slots=await repo.getAvailability(t,today.toZonedDateTime('America/New_York').toInstant().toString(),today.add({days:14}).toZonedDateTime('America/New_York').toInstant().toString());
  const target=slots[1]!,requestKey=randomUUID();
  const result=await repo.rescheduleAppointment(String(appointment.id),String(target.id),requestKey,{expectedVersion:0,confirmed:true,conversationId:chat.id});
  expect(result.id).toBe(appointment.id);expect(result.slot_id).toBe(target.id);
  expect((await local.db.query('select * from public.appointments where conversation_id=$1',[chat.id])).rows).toHaveLength(1);
  expect((await repo.getAvailability(t,today.toZonedDateTime('America/New_York').toInstant().toString(),today.add({days:14}).toZonedDateTime('America/New_York').toInstant().toString())).some(s=>s.id===appointment.slot_id)).toBe(true);
  const repeated=await repo.rescheduleAppointment(String(appointment.id),String(target.id),requestKey,{expectedVersion:0,confirmed:true,conversationId:chat.id});expect(repeated.id).toBe(result.id);
  expect((await local.db.query('select id from private.audit_events where entity_id=$1 and action=$2',[appointment.id,'appointment_rescheduled'])).rows).toHaveLength(1);
});

it('offers changes by chat, retains the original until fresh consent and preserves identity and contact',async()=>{
  const {chat,appointment}=await booked();
  const decide=vi.fn<IntentModel['decide']>().mockResolvedValue({kind:'reschedule',appointmentId:null,filter:{therapist_id:null,date:null,not_before:'13:00',not_after:'17:00',horizon_days:14}});
  let service=new DemoService(repo,{model:'qa',decide});const offer=await service.send(chat.id,{messageId:randomUUID(),text:'Quiero cambiar el turno para la tarde'});
  expect(offer.choices.filter(c=>c.action==='select').length).toBeGreaterThan(0);
  expect((await local.db.query('select slot_id from public.appointments where id=$1',[appointment.id])).rows[0]!.slot_id).toBe(appointment.slot_id);
  const choice=offer.choices.find(c=>c.action==='select')!;
  service=new DemoService(repo,{model:'qa',decide});const chosen=await service.send(chat.id,{messageId:randomUUID(),text:'El primero'});
  expect(chosen.messages.at(-1)!.text).toContain('se mantiene');expect(decide).toHaveBeenCalledTimes(1);
  const changed=await service.send(chat.id,{messageId:randomUUID(),text:'Sí, confirmo'});
  const rows=(await local.db.query('select * from public.appointments where conversation_id=$1',[chat.id])).rows;
  expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({id:appointment.id,slot_id:choice.slotId,therapist_id:appointment.therapist_id,patient_id:appointment.patient_id,version:1});
  expect(changed.messages.at(-1)!.text).toContain('reprogramado');expect(changed.patient.phone).toBe('2025550198');
  expect(decide.mock.calls[0]![0].appointments?.[0]?.id).toBe(appointment.id);
});
it('keeps the original appointment on a conflicting destination, wrong consent or stale version',async()=>{
  const {appointment}=await booked(),{appointment:occupied}=await booked();
  const id=String(appointment.id);
  await expect(repo.rescheduleAppointment(id,String(occupied.slot_id),randomUUID(),{expectedVersion:0,confirmed:true})).rejects.toMatchObject({code:'SLOT_UNAVAILABLE'});
  await expect(repo.rescheduleAppointment(id,String(occupied.slot_id),randomUUID(),{expectedVersion:0,confirmed:false})).rejects.toMatchObject({code:'CONFIRMATION_REQUIRED'});
  await expect(repo.rescheduleAppointment(id,String(occupied.slot_id),randomUUID(),{expectedVersion:99,confirmed:true})).rejects.toMatchObject({code:'APPOINTMENT_CHANGED'});
  expect((await local.db.query('select slot_id,version,status from public.appointments where id=$1',[id])).rows[0]).toEqual({slot_id:appointment.slot_id,version:0,status:'confirmed'});
  expect((await local.db.query('select * from private.appointment_changes')).rows).toHaveLength(0);
});
it('asks which appointment to change when there are several, instead of choosing silently',async()=>{
  const {chat,appointment}=await booked();const a=await repo.getUpcomingAppointments(chat.id);
  const row=(await local.db.query('select id from public.slots where therapist_id=$1 and id<>$2 and active and starts_at>now() order by starts_at limit 1',[appointment.therapist_id,appointment.slot_id])).rows[0]!;
  await repo.selectSlot(chat.id,String(row.id));await repo.book(chat.id,String(row.id),randomUUID(),true);
  const decide=vi.fn<IntentModel['decide']>().mockResolvedValue({kind:'reschedule',appointmentId:null,filter:{therapist_id:null,date:null,not_before:null,not_after:null,horizon_days:14}});
  const service=new DemoService(repo,{model:'qa',decide}),result=await service.send(chat.id,{messageId:randomUUID(),text:'Quiero cambiar de día mi turno'});
  expect(result.choices.filter(c=>c.action==='reschedule')).toHaveLength(2);expect(result.messages.at(-1)!.text).toContain('Cuál');
  const choice=result.choices.find(c=>c.appointmentId===a[0]!.id)!;const options=await service.send(chat.id,{messageId:randomUUID(),action:'reschedule',appointmentId:choice.appointmentId});
  expect(options.choices.some(c=>c.action==='select')).toBe(true);expect((await repo.getUpcomingAppointments(chat.id)).every(appt=>appt.version===0)).toBe(true);
});
it('can abandon a proposed change while preserving the original booking',async()=>{
  const {chat,appointment}=await booked();const decide=vi.fn<IntentModel['decide']>().mockResolvedValue({kind:'reschedule',appointmentId:null,filter:{therapist_id:null,date:null,not_before:null,not_after:null,horizon_days:14}});
  const service=new DemoService(repo,{model:'qa',decide});await service.send(chat.id,{messageId:randomUUID(),text:'Quiero cambiar el turno'});
  await service.send(chat.id,{messageId:randomUUID(),text:'El primero'});await service.send(chat.id,{messageId:randomUUID(),text:'No quiero cambiar'});
  await service.send(chat.id,{messageId:randomUUID(),text:'Sí, confirmo'});
  expect((await local.db.query('select slot_id,version from public.appointments where id=$1',[appointment.id])).rows[0]).toEqual({slot_id:appointment.slot_id,version:0});
});
it('keeps self-reported notes while reception is in charge, without replying or guessing medical advice',async()=>{
  const {chat,service}=await booked();await service.reply(chat.id,'Estamos revisando tu caso',randomUUID());const before=await service.get(chat.id);
  const after=await service.send(chat.id,{messageId:randomUUID(),text:'Información relevante: necesito acceso por rampa'});
  expect(after.patient.additional_info).toBe('necesito acceso por rampa');expect(after.messages.filter(m=>m.role!=='patient')).toEqual(before.messages.filter(m=>m.role!=='patient'));
});
it('continues to hand off medical advice requests instead of filing them as a diagnosis',async()=>{
  const {chat}=await booked(),decide=vi.fn<IntentModel['decide']>().mockResolvedValue({kind:'handoff',reason:'clinical'});
  const result=await new DemoService(repo,{model:'qa',decide}).send(chat.id,{messageId:randomUUID(),text:'Tengo dolor, ¿qué ejercicios debería hacer?'});
  expect(result.status).toBe('handed_off');expect(result.patient.reported_reason).toBeNull();
});
it('routes natural rescheduling through the dedicated model tool and supplies only owned appointments',async()=>{
  const fetch=vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({choices:[{finish_reason:'tool_calls',message:{tool_calls:[{type:'function',function:{name:'get_reschedule_availability',arguments:JSON.stringify({appointment_id:null,therapist_id:null,date:null,not_before:'13:00',not_after:'17:00',horizon_days:14})}}]}}]}),{status:200}));
  const result=await new OpenRouterModel('qa-key',{fetch}).decide({now:new Date().toISOString(),timeZone:'America/New_York',clinicName:'QA',therapists:[],offered:[],selectedSlotId:null,appointments:[],history:[{role:'patient',text:'Quiero cambiar el turno al viernes por la tarde'}]});
  expect(result.kind).toBe('reschedule');const body=JSON.parse(String(fetch.mock.calls[0]![1]!.body));expect(body.tool_choice.function.name).toBe('get_reschedule_availability');
});
it('notifies a manual change once in the same patient conversation and protects foreign identity and scope',async()=>{
  const {chat,appointment}=await booked(),rows=(await local.db.query('select id,therapist_id from public.slots where active and starts_at>now() and id<>$1 order by starts_at',[appointment.slot_id])).rows;
  const target=rows.find(r=>r.therapist_id===appointment.therapist_id)!,foreign=rows.find(r=>r.therapist_id!==appointment.therapist_id)!;
  await expect(repo.rescheduleAppointment(String(appointment.id),String(target.id),randomUUID(),{expectedVersion:0,confirmed:true,conversationId:randomUUID()})).rejects.toMatchObject({code:'FORBIDDEN'});
  await expect(repo.rescheduleAppointment(String(appointment.id),String(foreign.id),randomUUID(),{expectedVersion:0,confirmed:true,therapistScope:String(appointment.therapist_id)})).rejects.toMatchObject({code:'FORBIDDEN'});
  const key=randomUUID();await repo.rescheduleAppointment(String(appointment.id),String(target.id),key,{expectedVersion:0,confirmed:true,notifyPatient:true});
  await repo.rescheduleAppointment(String(appointment.id),String(target.id),key,{expectedVersion:0,confirmed:true,notifyPatient:true});
  expect((await new DemoService(repo).get(chat.id)).messages.filter(m=>m.role==='staff'&&m.text.includes('reprogramó'))).toHaveLength(1);
  await expect(repo.rescheduleAppointment(String(appointment.id),String(foreign.id),key,{expectedVersion:0,confirmed:true})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
});
it('tracks unread patient messages per reader and cannot mark another conversation using its message ID',async()=>{
  const {chat,service}=await booked(),other=await service.create();
  expect((await repo.getUnreadConversations('reader-a')).some(r=>r.id===chat.id)).toBe(false);
  await service.send(chat.id,{messageId:randomUUID(),action:'human'});
  const total=(await repo.getUnreadConversations('reader-a')).find(r=>r.id===chat.id)!.unread_count;expect(Number(total)).toBe(1);
  const last=(await service.get(chat.id)).messages.at(-1)!;await repo.markConversationRead('reader-a',chat.id,last.id);
  expect((await repo.getUnreadConversations('reader-a')).some(r=>r.id===chat.id)).toBe(false);expect((await repo.getUnreadConversations('reader-b')).some(r=>r.id===chat.id)).toBe(true);
  await service.send(chat.id,{messageId:randomUUID(),text:'Gracias'});await repo.markConversationRead('reader-a',chat.id,last.id);
  expect((await repo.getUnreadConversations('reader-a')).find(r=>r.id===chat.id)!.unread_count).toBe(1);
  await expect(repo.markConversationRead('reader-a',other.id,last.id)).rejects.toMatchObject({code:'MESSAGE_NOT_FOUND'});
  await service.archive(chat.id,true);expect((await repo.getUnreadConversations('reader-a')).some(r=>r.id===chat.id)).toBe(false);
});
it('exposes the reschedule API with explicit consent and rejects anonymous unread access',async()=>{
  const {appointment}=await booked(),token='qa-reschedule-token-0123456789-abcdefgh';const app=buildApp(repo,token,{demo:new DemoService(repo)});
  try{
    expect((await app.inject({url:'/v1/inbox/unread'})).statusCode).toBe(401);
    const target=(await local.db.query('select id from public.slots where therapist_id=$1 and id<>$2 and active and starts_at>now() order by starts_at limit 1',[appointment.therapist_id,appointment.slot_id])).rows[0]!;
    const options={method:'POST' as const,url:`/v1/appointments/${appointment.id}/reschedule`,headers:{authorization:`Bearer ${token}`,'idempotency-key':randomUUID()}};
    expect((await app.inject({...options,payload:{slotId:target.id,expectedVersion:0,confirmed:false}})).statusCode).toBe(400);
    expect((await app.inject({...options,payload:{slotId:target.id,expectedVersion:0,confirmed:true}})).statusCode).toBe(200);
  }finally{await app.close();}
});
it('supports the dedicated backend role while keeping change history and read receipts out of direct staff API access',async()=>{
  const {appointment}=await booked();
  const target=(await local.db.query('select id from public.slots where therapist_id=$1 and id<>$2 and active and starts_at>now() order by starts_at limit 1',[appointment.therapist_id,appointment.slot_id])).rows[0]!;
  await local.db.transaction(async db=>{
    await db.query('set local role nexo_backend');const scoped=new ClinicRepository(withSavepoints(db));
    expect((await scoped.rescheduleAppointment(String(appointment.id),String(target.id),randomUUID(),{expectedVersion:0,confirmed:true,notifyPatient:true})).version).toBe(1);
  });
  for(const table of ['appointment_changes','conversation_reads'])await expect(local.db.transaction(async db=>{await db.query('set local role authenticated');await db.query(`select * from private.${table}`);})).rejects.toThrow(/permission denied/);
});
it('does not let a cosmetic explanation claim a reschedule before the backend executes it',()=>{
  expect(renderNarration('Ya cambié tu turno.',{event:'availability',request:'Cambiar turno',facts:{},variables:{}})).toBeNull();
  expect(renderNarration('Tu turno quedó reprogramado.',{event:'rescheduled',request:'Sí, confirmo',facts:{booking_succeeded:true},variables:{}})).toBe('Tu turno quedó reprogramado.');
});
