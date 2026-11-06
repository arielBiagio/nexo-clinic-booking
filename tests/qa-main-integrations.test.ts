import {randomBytes,randomUUID} from 'node:crypto';
import {Temporal} from '@js-temporal/polyfill';
import {beforeAll,beforeEach,afterAll,afterEach,describe,it,expect,vi} from 'vitest';
import {createLocalDatabase,seedLocal} from '../packages/db/src/client.js';
import {ClinicRepository} from '../packages/db/src/repository.js';
import {DemoService} from '../apps/agent-api/src/demo-service.js';
import {GoogleCalendar} from '../apps/agent-api/src/google-calendar.js';
import {proposeWeekly,bookWeekly} from '../apps/agent-api/src/weekly-booking.js';
import {getCancellationWeek,cancelAppointmentWeek} from '../packages/db/src/weekly-cancellation.js';
import type {IntentModel} from '../packages/agent/src/openrouter.js';
const own='10000000-0000-4000-8000-000000000001',other='10000000-0000-4000-8000-000000000002',zone='America/New_York',email='therapist.qa@example.invalid';
let local:Awaited<ReturnType<typeof createLocalDatabase>>,repo:ClinicRepository,calendar:GoogleCalendar,connectionId:string,monday:string;
let traffic:{url:string;method:string;body:any}[],mode:'ok'|'calendar503'|'gmail403'|'gmailTimeout';
let events:Map<string,any>;
type Internals={seal(value:unknown):string;work():Promise<void>;enqueue(id:string):Promise<void>;mail:{work():Promise<void>;retry(id:string):Promise<void>}};
const internal=()=>calendar as unknown as Internals;
beforeAll(async()=>{local=await createLocalDatabase();});
beforeEach(async()=>{
  await local.engine.exec('truncate auth.users,public.clinics,public.therapists,public.patients restart identity cascade');await seedLocal(local.engine);
  repo=new ClinicRepository(local.db);const today=Temporal.Now.plainDateISO(zone);monday=today.add({days:(8-today.dayOfWeek)%7||7}).toString();
  for(const id of [own,other])await repo.regenerate(id,today.toString(),21);
  const staff=randomUUID();await local.db.query('insert into auth.users(id) values ($1)',[staff]);
  await local.db.query("insert into public.staff_members(user_id,role,display_name,email) values ($1,'therapist','Terapeuta QA',$2)",[staff,email]);
  await local.db.query('update public.therapists set staff_user_id=$1 where id=$2',[staff,own]);
  calendar=new GoogleCalendar(local.db,{origin:'http://localhost:3109',encryptionKey:randomBytes(32).toString('base64url'),clientId:'qa-client',clientSecret:'qa-secret'});
  const encrypted=internal().seal({access_token:'qa-access',refresh_token:'qa-refresh',expires_at:Math.floor(Date.now()/1000)+3600});
  expect(encrypted).not.toContain('qa-refresh');
  connectionId=String((await local.db.query("insert into private.google_calendar_connections(therapist_id,staff_user_id,google_sub,email,calendar_id,encrypted_tokens,status,gmail_send_enabled) values ($1,$2,'qa-google-sub',$3,'qa-calendar',$4,'connected',true) returning id",[own,staff,email,encrypted])).rows[0]!.id);
  traffic=[];mode='ok';events=new Map();
  vi.stubGlobal('fetch',vi.fn<typeof fetch>(async(input,init)=>{
    const url=String(input),method=init?.method??'GET',body=init?.body?JSON.parse(String(init.body)):null;traffic.push({url,method,body});
    const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status});
    if(url==='https://gmail.googleapis.com/gmail/v1/users/me/messages/send'){
      if(mode==='gmail403')return json({error:{errors:[{reason:'accessNotConfigured'}]}},403);
      if(mode==='gmailTimeout')throw new Error('Simulated timeout, no external request');
      return json({id:`qa-mail-${traffic.length}`});
    }
    if(url.startsWith('https://www.googleapis.com/calendar/v3/calendars/qa-calendar/events')){
      if(mode==='calendar503')return json({error:{}},503);
      const id=new URL(url).pathname.split('/').at(-1)!;
      if(method==='POST'){events.set(body.id,body);return json({id:body.id});}
      if(method==='PUT'){if(!events.has(id))return json({error:{}},404);events.set(id,body);return json({id});}
      if(method==='DELETE'){events.delete(id);return new Response(null,{status:204});}
      if(method==='GET')return events.has(id)?json(events.get(id)):json({error:{}},404);
    }
    throw new Error('Unexpected external request blocked by QA');
  }));
});
afterEach(()=>vi.unstubAllGlobals());afterAll(async()=>local.db.close());
async function manual(day=monday,therapist=own,name='Paciente QA'){
  const date=Temporal.PlainDate.from(day),from=date.toZonedDateTime(zone).toInstant().toString(),to=date.add({days:1}).toZonedDateTime(zone).toInstant().toString();
  const slot=(await repo.getAvailability(therapist,from,to)).find(s=>Temporal.Instant.from(new Date(String(s.starts_at)).toISOString()).toZonedDateTimeISO(zone).hour===10)!;
  return repo.createManualAppointment(therapist,{slotId:String(slot.id),name,phone:'2025550198'},randomUUID());
}
describe('QA: patient, weekly and provider workflows on an isolated database',()=>{
  it('books from free text, requires contact and fresh consent, then keeps post-booking patient facts',async()=>{
    const decide=vi.fn<IntentModel['decide']>().mockResolvedValue({kind:'patient',details:{name:'Paciente Conversación QA',phone:'2025550198',insurance:'Seguro QA',reported_reason:null,additional_info:null}});
    const service=new DemoService(repo,{model:'qa-mocked',decide}),chat=await service.create();
    const day=Temporal.PlainDate.from(monday).add({days:2});
    const found=await service.send(chat.id,{messageId:randomUUID(),text:`Hola quiero un turno para el miércoles ${day.day} a las 10h`});
    expect(decide).not.toHaveBeenCalled();const offered=service.sessions.get(chat.id)!.offered;
    expect(new Set(offered.map(s=>s.therapistId))).toEqual(new Set([own,other]));
    expect(offered.every(s=>Temporal.Instant.from(s.start).toZonedDateTimeISO(zone).toPlainDate().equals(day))).toBe(true);
    await service.send(chat.id,{messageId:randomUUID(),action:'select',slotId:found.choices.find(c=>c.action==='select')!.slotId});
    await service.send(chat.id,{messageId:randomUUID(),action:'confirm'});
    expect((await local.db.query('select id from public.appointments where conversation_id=$1',[chat.id])).rows).toHaveLength(0);
    const intake=await service.send(chat.id,{messageId:randomUUID(),text:'Soy Paciente Conversación QA, mi teléfono es 2025550198, tengo Seguro QA'});
    expect(intake.patient).toMatchObject({name:'Paciente Conversación QA',phone:'2025550198',insurance:'Seguro QA'});
    expect((await local.db.query('select id from public.appointments where conversation_id=$1',[chat.id])).rows).toHaveLength(0);
    const confirmation={messageId:randomUUID(),text:'Sí, confirmo'};await service.send(chat.id,confirmation);await service.send(chat.id,confirmation);
    expect((await local.db.query('select id from public.appointments where conversation_id=$1',[chat.id])).rows).toHaveLength(1);
    expect((await service.get(chat.id)).messages.at(-1)!.text).not.toMatch(/no enviamos correos|no se enviarán emails/i);
    const details=await service.send(chat.id,{messageId:randomUUID(),text:'Mi diagnóstico es tendinitis'});
    expect(details.patient.reported_reason).toBe('tendinitis');
  });
  it('respects an explicit professional in the same numbered-date search',async()=>{
    const service=new DemoService(repo,{model:'qa',decide:vi.fn()}),chat=await service.create(),day=Temporal.PlainDate.from(monday).add({days:2});
    await service.send(chat.id,{messageId:randomUUID(),text:`Un turno con Alex para el miércoles ${day.day} a las 10h`});
    expect(service.sessions.get(chat.id)!.offered.length).toBeGreaterThan(0);expect(service.sessions.get(chat.id)!.offered.every(s=>s.therapistId===own)).toBe(true);
  });
  it('keeps an excluded therapist out of the offered choices',async()=>{
    const service=new DemoService(repo,{model:'qa',decide:vi.fn()}),chat=await service.create();
    await service.send(chat.id,{messageId:randomUUID(),text:'Quiero un turno, pero no con Alex'});
    const offered=service.sessions.get(chat.id)!.offered;expect(offered.length).toBeGreaterThan(0);expect(offered.every(s=>s.therapistId!==own)).toBe(true);
    const restarted=new DemoService(repo,{model:'qa',decide:vi.fn()});
    await restarted.send(chat.id,{messageId:randomUUID(),action:'more'});
    expect(restarted.sessions.get(chat.id)!.offered.length).toBeGreaterThan(0);
    expect(restarted.sessions.get(chat.id)!.offered.every(s=>s.therapistId!==own)).toBe(true);
  });
  it('keeps a long-lived conversation usable after more than 120 persisted messages',async()=>{
    const service=new DemoService(repo),chat=await service.create('Historia QA');
    await local.db.query("insert into public.messages(conversation_id,external_message_id,direction,role,body) select $1,'qa-history-'||n,'inbound','patient','Mensaje ficticio QA' from generate_series(1,121) n",[chat.id]);
    const result=await service.send(chat.id,{messageId:randomUUID(),action:'start'});expect(result.choices.some(c=>c.action==='select')).toBe(true);
    expect(result.messages.filter(m=>m.text==='Mensaje ficticio QA')).toHaveLength(121);
    const decide=vi.fn<IntentModel['decide']>().mockResolvedValue({kind:'reply',text:'¡Hola! ¿Qué día preferís?'});
    await new DemoService(repo,{model:'qa',decide}).send(chat.id,{messageId:randomUUID(),text:'Hola'});
    expect(decide.mock.calls[0]![0].history).toHaveLength(24);
    expect((await service.get(chat.id)).messages.length).toBeGreaterThan(121);
  });
  it('shows the week of a Friday appointment by default instead of skipping to next Monday',async()=>{
    const friday=Temporal.PlainDate.from(monday).add({days:4}),booked=await manual(friday.toString());
    const clock=vi.spyOn(Temporal.Now,'plainDateISO').mockReturnValue(friday);
    try{expect((await new DemoService(repo).dashboard()).appointments.some(a=>a.id===booked.id)).toBe(true);}finally{clock.mockRestore();}
  });
  it('books a whole week and cancels only the confirmed reviewed group',async()=>{
    const service=new DemoService(repo),chat=await service.create('Paciente Semana QA');await repo.updatePatientDetails(chat.id,{phone:'2025550198'});
    const proposal=await proposeWeekly(repo,{id:chat.id,appointments:[]},{week_start:monday,local_time:'10:00',therapist_id:own,weekdays:[1,2,3,4,5],reference_appointment_id:null},'lunes a viernes a las 10h');
    expect(proposal.state.ready).toBe(true);await bookWeekly(repo,chat.id,proposal.state.plan!,randomUUID());
    const booked=(await local.db.query('select id from public.appointments where conversation_id=$1 and status=\'confirmed\' order by starts_at',[chat.id])).rows;
    expect(booked).toHaveLength(5);const review=await getCancellationWeek(repo,String(booked[0]!.id),{conversationId:chat.id});
    expect(review.appointments).toHaveLength(5);
    await cancelAppointmentWeek(repo,String(booked[0]!.id),review.appointments.map(a=>({id:a.id,version:a.version})),{conversationId:chat.id});
    expect((await local.db.query("select id from public.appointments where conversation_id=$1 and status='confirmed'",[chat.id])).rows).toHaveLength(0);
  });
  it('rolls back every new weekly reservation when one reviewed slot is taken',async()=>{
    const service=new DemoService(repo),chat=await service.create('Semana QA');await repo.updatePatientDetails(chat.id,{phone:'2025550198'});
    const proposal=await proposeWeekly(repo,{id:chat.id,appointments:[]},{week_start:monday,local_time:'10:00',therapist_id:own,weekdays:[1,2,3,4,5],reference_appointment_id:null},'lunes a viernes a las 10h');
    await manual(Temporal.PlainDate.from(monday).add({days:2}).toString());
    await expect(bookWeekly(repo,chat.id,proposal.state.plan!,randomUUID())).rejects.toBeDefined();
    expect((await local.db.query('select id from public.appointments where conversation_id=$1',[chat.id])).rows).toHaveLength(0);
  });
  it('syncs Calendar create/change/cancel and sets a 30-minute reminder with escaped patient details',async()=>{
    const booked=await manual();await repo.updatePatientDetails(String(booked.conversation_id),{insurance:'Seguro QA',reported_reason:'motivo <QA>',additional_info:'detalle & QA'});
    await internal().work();expect(events.size).toBe(1);const event=[...events.values()][0];
    expect(event.reminders).toEqual({useDefault:false,overrides:[{method:'popup',minutes:30}]});expect(event.description).toContain('motivo &lt;QA&gt;');expect(event.description).toContain('detalle &amp; QA');expect(event.attendees).toBeUndefined();
    const target=(await repo.getAvailability(own,new Date(String(booked.starts_at)).toISOString(),Temporal.PlainDate.from(monday).add({days:1}).toZonedDateTime(zone).toInstant().toString()))[0]!;
    await repo.rescheduleAppointment(String(booked.id),String(target.id),randomUUID(),{expectedVersion:0,confirmed:true});await internal().work();expect(events.size).toBe(1);
    expect([...events.values()][0].start.dateTime).toBe(new Date(String(target.starts_at)).toISOString());
    await repo.setAppointmentRemoved(String(booked.id),true);await internal().work();expect(events.size).toBe(0);
  });
  it('sends one Gmail notice from/to the owner with contact and optional fields, without repeats on sync',async()=>{
    const booked=await manual();await repo.updatePatientDetails(String(booked.conversation_id),{insurance:'Seguro QA',reported_reason:'motivo QA',additional_info:'extra QA'});
    await internal().mail.work();const sent=traffic.filter(c=>c.url.includes('gmail.googleapis.com'));expect(sent).toHaveLength(1);
    const raw=Buffer.from(sent[0]!.body.raw,'base64url').toString('utf8'),body=Buffer.from(raw.split('\r\n\r\n')[1]!.replace(/\s/g,''),'base64').toString('utf8');
    expect(raw).toContain(`From: Nexo <${email}>`);expect(raw).toContain(`To: <${email}>`);for(const fact of ['Paciente QA','2025550198','Seguro QA','motivo QA','extra QA','10:00'])expect(body).toContain(fact);
    await internal().enqueue(connectionId);await internal().mail.work();expect(traffic.filter(c=>c.url.includes('gmail.googleapis.com'))).toHaveLength(1);
  });
  it('does not let Calendar failures block booking or Gmail',async()=>{
    const booked=await manual();mode='calendar503';await internal().work();await internal().mail.work();
    expect((await local.db.query('select status from public.appointments where id=$1',[booked.id])).rows[0]!.status).toBe('confirmed');
    expect((await local.db.query('select status from private.gmail_booking_notifications')).rows[0]!.status).toBe('sent');
  });
  it('does not let a Gmail API permission failure disconnect Calendar',async()=>{
    await manual();mode='gmail403';await internal().mail.work();await internal().work();expect(events.size).toBe(1);
    expect((await local.db.query('select status,gmail_error_code from private.google_calendar_connections')).rows[0]).toMatchObject({status:'connected',gmail_error_code:'GMAIL_API_DISABLED'});
  });
  it('does not resend after an uncertain Gmail timeout',async()=>{
    await manual();mode='gmailTimeout';await internal().mail.work();await internal().mail.retry(connectionId);await internal().mail.work();
    expect(traffic.filter(c=>c.url.includes('gmail.googleapis.com'))).toHaveLength(1);expect((await local.db.query('select status from private.gmail_booking_notifications')).rows[0]!.status).toBe('unknown');
  });
  it('suppresses a queued Gmail notice if the appointment is cancelled before sending',async()=>{
    const booked=await manual();await repo.setAppointmentRemoved(String(booked.id),true);await internal().mail.work();expect(traffic.filter(c=>c.url.includes('gmail.googleapis.com'))).toHaveLength(0);
  });
});
