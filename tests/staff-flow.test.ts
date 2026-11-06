import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { Temporal } from '@js-temporal/polyfill';
import { createLocalDatabase, seedLocal } from '../packages/db/src/client.js';
import { ClinicRepository } from '../packages/db/src/repository.js';
import { DemoService } from '../apps/agent-api/src/demo-service.js';
import { buildApp } from '../apps/agent-api/src/app.js';
import { StaffAuth } from '../apps/agent-api/src/staff-auth.js';
import { FakeAuth } from './helpers/fake-auth.js';

const origin='http://127.0.0.1:3002',host='127.0.0.1:3002',password='QA-only-password-2026!';
const own='10000000-0000-4000-8000-000000000001',other='10000000-0000-4000-8000-000000000002';
let local:Awaited<ReturnType<typeof createLocalDatabase>>,repo:ClinicRepository,demo:DemoService,app:ReturnType<typeof buildApp>,fake:FakeAuth;
let adminCookie:string,therapistCookie:string,receptionCookie:string,monday:string;
const headers=(cookie:string)=>({host,origin,cookie});
const rules=[1,2,3,4,5].map(weekday=>({weekday,startMinute:540,endMinute:1020,sessionMinutes:45,bufferMinutes:15,breaks:[{startMinute:720,endMinute:780}]}));
async function login(email:string){const res=await app.inject({method:'POST',url:'/v1/auth/login',headers:{host,origin},payload:{email,password}});expect(res.statusCode,res.body).toBe(200);return String(res.headers['set-cookie']).split(';')[0]!;}
async function appointment(therapistId=own){
  const chat=await demo.create('Paciente QA'),patient=await repo.updatePatientDetails(chat.id,{phone:'2025550198'});
  const day=Temporal.PlainDate.from(monday),from=day.toZonedDateTime('America/New_York').toInstant().toString(),to=day.add({days:1}).toZonedDateTime('America/New_York').toInstant().toString();
  const slot=(await repo.getAvailability(therapistId,from,to))[0]!;
  await repo.selectSlot(chat.id,String(slot.id));const booked=await repo.book(chat.id,String(slot.id),`qa-${randomUUID()}`,true);
  return {chat,patient,slot,booked};
}
beforeAll(async()=>{local=await createLocalDatabase();});
beforeEach(async()=>{
  vi.restoreAllMocks();await local.engine.exec('truncate auth.users,public.clinics,public.therapists,public.patients restart identity cascade');await seedLocal(local.engine);
  fake=new FakeAuth();await fake.initialize(local.db);vi.stubGlobal('fetch',fake.fetch);
  const admin=fake.add('admin@example.invalid'),therapist=fake.add('therapist@example.invalid'),reception=fake.add('reception@example.invalid');
  for(const [id,role,name,email] of [[admin,'admin','QA Admin','admin@example.invalid'],[therapist,'therapist','QA Alex','therapist@example.invalid'],[reception,'reception','QA Reception','reception@example.invalid']])await local.db.query('insert into public.staff_members(user_id,role,display_name,email) values ($1,$2,$3,$4)',[id,role,name,email]);
  await local.db.query('update public.therapists set staff_user_id=$1 where id=$2',[therapist,own]);
  repo=new ClinicRepository(local.db);demo=new DemoService(repo);
  const today=Temporal.Now.plainDateISO('America/New_York');monday=today.add({days:(8-today.dayOfWeek)%7||7}).toString();
  for(const id of [own,other])await repo.regenerate(id,today.toString(),21);
  const auth=new StaffAuth(local.db,{url:fake.url,publishableKey:'qa-public-key',secretKey:'qa-server-key',encryptionKey:randomBytes(32).toString('base64url'),origin,bootstrapEmail:'owner@example.invalid'});
  app=buildApp(repo,'',{auth,demo});await app.ready();adminCookie=await login('admin@example.invalid');therapistCookie=await login('therapist@example.invalid');receptionCookie=await login('reception@example.invalid');
});
afterEach(async()=>{await app?.close();vi.unstubAllGlobals();});
afterAll(async()=>{await local.db.close();});

it('creates a therapist account and a new professional together, without selecting an existing professional',async()=>{
  const response=await app.inject({method:'POST',url:'/v1/staff',headers:headers(adminCookie),payload:{name:'Vega QA',email:'vega@example.invalid',password,role:'therapist',specialty:'Fisioterapia'}});
  expect(response.statusCode,response.body).toBe(200);const created=response.json();
  const row=(await local.db.query('select name,specialty,staff_user_id from public.therapists where id=$1',[created.therapistId])).rows[0];
  expect(row).toMatchObject({name:'Vega QA',specialty:'Fisioterapia',staff_user_id:created.id});
  expect((await repo.getSchedule(created.therapistId)).rules).toHaveLength(0);
  const cookie=await login('vega@example.invalid');expect((await app.inject({url:'/v1/dashboard',headers:headers(cookie)})).json().therapists.map((t:{id:string})=>t.id)).toEqual([created.therapistId]);
});
it('allows a therapist to edit their own name and specialty without changing access roles',async()=>{
  const res=await app.inject({method:'PATCH',url:`/v1/therapists/${own}/profile`,headers:headers(therapistCookie),payload:{name:'Vega QA',specialty:'Fisioterapia deportiva'}});
  expect(res.statusCode,res.body).toBe(200);
  expect((await app.inject({url:'/v1/auth/me',headers:headers(therapistCookie)})).json().user).toMatchObject({name:'Vega QA',role:'therapist'});
  expect((await app.inject({url:`/v1/therapists/${own}/profile`,headers:headers(therapistCookie)})).json()).toMatchObject({name:'Vega QA',specialty:'Fisioterapia deportiva'});
  expect((await app.inject({method:'PATCH',url:`/v1/therapists/${own}/profile`,headers:headers(therapistCookie),payload:{name:'Escalation',specialty:'Fisio',role:'admin'}})).statusCode).toBe(400);
});
it('allows own-agenda rescheduling, rejects another agenda and keeps unread messages private to operators',async()=>{
  const {booked,chat}=await appointment(),day=Temporal.PlainDate.from(monday);
  const from=day.toZonedDateTime('America/New_York').toInstant().toString(),to=day.add({days:1}).toZonedDateTime('America/New_York').toInstant().toString();
  const ownTarget=(await repo.getAvailability(own,from,to))[0]!,foreignTarget=(await repo.getAvailability(other,from,to))[0]!;
  const request=(slotId:unknown)=>app.inject({method:'POST',url:`/v1/appointments/${booked.id}/reschedule`,headers:{...headers(therapistCookie),'idempotency-key':randomUUID()},payload:{slotId,confirmed:true,expectedVersion:0}});
  expect((await request(foreignTarget.id)).statusCode).toBe(403);
  expect((await request(ownTarget.id)).statusCode).toBe(200);
  const foreign=await appointment(other);
  expect((await app.inject({method:'POST',url:`/v1/appointments/${foreign.booked.id}/reschedule`,headers:{...headers(therapistCookie),'idempotency-key':randomUUID()},payload:{slotId:ownTarget.id,confirmed:true,expectedVersion:0}})).statusCode).toBe(403);
  expect((await app.inject({url:'/v1/inbox/unread',headers:headers(therapistCookie)})).statusCode).toBe(403);
  const last=(await demo.get(chat.id)).messages.at(-1)!;
  expect((await app.inject({method:'POST',url:`/v1/conversations/${chat.id}/read`,headers:headers(therapistCookie),payload:{lastMessageId:last.id}})).statusCode).toBe(403);
  expect((await app.inject({url:'/v1/inbox/unread',headers:headers(receptionCookie)})).statusCode).toBe(200);
});
it('lets a therapist publish their availability, block and reopen a date',async()=>{
  const save=await app.inject({method:'PUT',url:`/v1/therapists/${own}/schedule`,headers:headers(therapistCookie),payload:{rules}});expect(save.statusCode,save.body).toBe(200);
  const blocked=await app.inject({method:'POST',url:`/v1/therapists/${own}/time-off`,headers:headers(therapistCookie),payload:{date:monday}});expect(blocked.statusCode,blocked.body).toBe(200);
  const block=(await repo.getSchedule(own)).timeOff[0]!;
  expect((await app.inject({method:'DELETE',url:`/v1/therapists/${own}/time-off/${block.id}`,headers:headers(therapistCookie)})).statusCode).toBe(200);
  expect((await repo.getSchedule(own)).timeOff).toHaveLength(0);
});
it('creates and cancels an own-agenda appointment, without duplicating retries or losing patient contact',async()=>{
  const day=Temporal.PlainDate.from(monday),from=day.toZonedDateTime('America/New_York').toInstant().toString(),to=day.add({days:1}).toZonedDateTime('America/New_York').toInstant().toString();
  const slot=(await repo.getAvailability(own,from,to))[0]!;
  const request={method:'POST' as const,url:`/v1/therapists/${own}/appointments`,headers:{...headers(therapistCookie),'idempotency-key':randomUUID()},payload:{slotId:slot.id,confirmed:true,name:'Paciente Manual QA',phone:'202 555 0198'}};
  const first=await app.inject(request);expect(first.statusCode,first.body).toBe(200);const booked=first.json();
  expect((await app.inject(request)).json().id).toBe(booked.id);
  expect((await local.db.query('select id from public.appointments where patient_id=$1',[booked.patient_id])).rows).toHaveLength(1);
  const details=await app.inject({url:`/v1/conversations/${booked.conversation_id}/patient`,headers:headers(therapistCookie)});expect(details.statusCode).toBe(200);expect(details.json()).toMatchObject({name:'Paciente Manual QA',phone:'2025550198'});
  expect((await app.inject({method:'DELETE',url:`/v1/appointments/${booked.id}`,headers:headers(therapistCookie)})).statusCode).toBe(200);
  expect((await local.db.query('select status from public.appointments where id=$1',[booked.id])).rows[0]!.status).toBe('cancelled');
  expect((await repo.getAvailability(own,from,to)).some(s=>s.id===slot.id)).toBe(true);
});
it('rejects creating a reservation without contact or explicit confirmation',async()=>{
  for(const payload of [{slotId:randomUUID(),confirmed:true,name:'Paciente QA'},{slotId:randomUUID(),confirmed:false,name:'Paciente QA',phone:'2025550198'}]){
    expect((await app.inject({method:'POST',url:`/v1/therapists/${own}/appointments`,headers:{...headers(therapistCookie),'idempotency-key':randomUUID()},payload})).statusCode).toBe(400);
  }
  expect((await local.db.query('select id from public.appointments')).rows).toHaveLength(0);
});
it('blocks another professional’s profile, availability and appointments',async()=>{
  const foreign=await appointment(other);
  for(const request of [
    {method:'PATCH' as const,url:`/v1/therapists/${other}/profile`,payload:{name:'Stolen QA',specialty:'Fisio'}},
    {method:'PUT' as const,url:`/v1/therapists/${other}/schedule`,payload:{rules:[]}},
    {method:'POST' as const,url:`/v1/therapists/${other}/appointments`,payload:{slotId:foreign.slot.id,confirmed:true,name:'QA',phone:'2025550198'}},
    {method:'DELETE' as const,url:`/v1/appointments/${foreign.booked.id}`},
    {method:'GET' as const,url:`/v1/conversations/${foreign.chat.id}/patient`},
  ])expect((await app.inject({...request,headers:headers(therapistCookie)})).statusCode).toBe(403);
  expect((await local.db.query('select status from public.appointments where id=$1',[foreign.booked.id])).rows[0]!.status).toBe('confirmed');
});
it('does not expose the inbox, staff administration or another therapist in a therapist dashboard',async()=>{
  for(const url of ['/v1/staff','/v1/conversations','/v1/demo/removed/conversations'])expect((await app.inject({url,headers:headers(therapistCookie)})).statusCode).toBe(403);
  expect((await app.inject({url:'/v1/staff',headers:headers(receptionCookie)})).statusCode).toBe(403);
  const dashboard=(await app.inject({url:'/v1/dashboard',headers:headers(therapistCookie)})).json();expect(dashboard.conversations).toEqual([]);expect(dashboard.therapists.map((t:{id:string})=>t.id)).toEqual([own]);
});
it('protects sessions and immediately rejects a deactivated account',async()=>{
  const me=await app.inject({url:'/v1/auth/me',headers:headers(therapistCookie)});const user=me.json().user;
  const stored=(await local.db.query<{encrypted_tokens:string}>('select encrypted_tokens from private.staff_sessions where user_id=$1',[user.id])).rows[0]!;expect(stored.encrypted_tokens).not.toContain('qa-access');
  const changed=await app.inject({method:'PATCH',url:`/v1/staff/${user.id}`,headers:headers(adminCookie),payload:{role:'therapist',active:false,therapistId:own}});expect(changed.statusCode).toBe(200);
  expect((await app.inject({url:'/v1/dashboard',headers:headers(therapistCookie)})).statusCode).toBe(401);
  expect((await app.inject({method:'PUT',url:`/v1/therapists/${own}/schedule`,headers:{...headers(therapistCookie),origin:'https://foreign.invalid'},payload:{rules:[]}})).statusCode).toBe(403);
});

it('rejects a foreign slot posted through the own therapist URL without creating orphan records',async()=>{
  const foreign=await appointment(other);
  const before=(await local.db.query('select count(*)::int as count from public.patients')).rows[0]!.count;
  const response=await app.inject({method:'POST',url:`/v1/therapists/${own}/appointments`,headers:{...headers(therapistCookie),'idempotency-key':randomUUID()},payload:{slotId:foreign.slot.id,confirmed:true,name:'Paciente Invasor QA',phone:'2025550199'}});
  expect(response.statusCode).toBe(409);
  expect((await local.db.query('select count(*)::int as count from public.patients')).rows[0]!.count).toBe(before);
});
it('reserves a slot once under simultaneous manual requests and rolls back the losing patient',async()=>{
  const day=Temporal.PlainDate.from(monday),from=day.toZonedDateTime('America/New_York').toInstant().toString(),to=day.add({days:1}).toZonedDateTime('America/New_York').toInstant().toString();
  const slot=(await repo.getAvailability(own,from,to))[0]!;
  const before=Number((await local.db.query('select count(*) as count from public.patients')).rows[0]!.count);
  const responses=await Promise.all(['Uno','Dos'].map(name=>app.inject({method:'POST',url:`/v1/therapists/${own}/appointments`,headers:{...headers(therapistCookie),'idempotency-key':randomUUID()},payload:{slotId:slot.id,confirmed:true,name:`Paciente ${name} QA`,phone:'2025550198'}})));
  expect(responses.map(r=>r.statusCode).sort()).toEqual([200,409]);
  expect((await local.db.query('select id from public.appointments where slot_id=$1',[slot.id])).rows).toHaveLength(1);
  expect(Number((await local.db.query('select count(*) as count from public.patients')).rows[0]!.count)).toBe(before+1);
});
it('never mixes cancelled appointments from another agenda into the therapist recycle list',async()=>{
  const a=await appointment(own),b=await appointment(other);
  await repo.setAppointmentRemoved(String(a.booked.id),true);await repo.setAppointmentRemoved(String(b.booked.id),true);
  const response=await app.inject({url:'/v1/demo/removed/appointments',headers:headers(therapistCookie)});
  expect(response.statusCode).toBe(200);expect(response.json().map((row:{id:string})=>row.id)).toEqual([a.booked.id]);
  expect((await app.inject({method:'POST',url:`/v1/appointments/${b.booked.id}/restore`,headers:headers(therapistCookie),payload:{}})).statusCode).toBe(403);
});
it('does not delete another therapist’s absence using the own therapist URL',async()=>{
  await repo.blockDate(other,monday);const block=(await repo.getSchedule(other)).timeOff[0]!;
  const res=await app.inject({method:'DELETE',url:`/v1/therapists/${own}/time-off/${block.id}`,headers:headers(therapistCookie)});
  expect(res.statusCode).toBe(404);expect((await repo.getSchedule(other)).timeOff).toHaveLength(1);
});
it('rejects reuse of a manual request identity with changed contact instead of duplicating a booking',async()=>{
  const day=Temporal.PlainDate.from(monday),from=day.toZonedDateTime('America/New_York').toInstant().toString(),to=day.add({days:1}).toZonedDateTime('America/New_York').toInstant().toString();
  const slot=(await repo.getAvailability(own,from,to))[0]!,requestHeaders={...headers(therapistCookie),'idempotency-key':randomUUID()};
  const payload={slotId:slot.id,confirmed:true,name:'Paciente QA',phone:'2025550198'};
  expect((await app.inject({method:'POST',url:`/v1/therapists/${own}/appointments`,headers:requestHeaders,payload})).statusCode).toBe(200);
  expect((await app.inject({method:'POST',url:`/v1/therapists/${own}/appointments`,headers:requestHeaders,payload:{...payload,phone:'2025550199'}})).statusCode).toBe(409);
  expect((await local.db.query('select id from public.appointments')).rows).toHaveLength(1);
});
it('rejects invalid credentials without issuing a session cookie',async()=>{
  const response=await app.inject({method:'POST',url:'/v1/auth/login',headers:{host,origin},payload:{email:'therapist@example.invalid',password:'incorrect-password'}});
  expect(response.statusCode).toBe(401);expect(response.json()).toEqual({error:'INVALID_CREDENTIALS'});expect(response.headers['set-cookie']).toBeUndefined();
  expect((await local.db.query('select id_hash from private.staff_sessions')).rows).toHaveLength(3);
});
it('rejects tampered and expired sessions without trusting a bearer token in staff mode',async()=>{
  expect((await app.inject({url:'/v1/dashboard',headers:{host,authorization:'Bearer qa-server-key'}})).statusCode).toBe(401);
  expect((await app.inject({url:'/v1/dashboard',headers:headers(`nexo_staff=${'x'.repeat(43)}`)})).statusCode).toBe(401);
  const user=(await app.inject({url:'/v1/auth/me',headers:headers(therapistCookie)})).json().user;
  await local.db.query("update private.staff_sessions set expires_at=now()-interval '1 second' where user_id=$1",[user.id]);
  expect((await app.inject({url:'/v1/dashboard',headers:headers(therapistCookie)})).statusCode).toBe(401);
});
it('keeps the last administrator active and rejects self-escalation by a therapist',async()=>{
  const admin=(await app.inject({url:'/v1/auth/me',headers:headers(adminCookie)})).json().user;
  const res=await app.inject({method:'PATCH',url:`/v1/staff/${admin.id}`,headers:headers(adminCookie),payload:{role:'reception',active:true,therapistId:null}});
  expect(res.statusCode).toBe(409);expect(res.json()).toEqual({error:'LAST_ADMIN_REQUIRED'});
  const therapist=(await app.inject({url:'/v1/auth/me',headers:headers(therapistCookie)})).json().user;
  expect((await app.inject({method:'PATCH',url:`/v1/staff/${therapist.id}`,headers:headers(therapistCookie),payload:{role:'admin',active:true,therapistId:null}})).statusCode).toBe(403);
});
it('rolls back a failed therapist creation and removes its simulated Auth account',async()=>{
  const original=local.db.transaction.bind(local.db);
  vi.spyOn(local.db,'transaction').mockImplementation(callback=>original(db=>callback({...db,query:async(text,values)=>{if(text.startsWith('insert into public.therapists'))throw new Error('Simulated SQL failure');return db.query(text,values);}})));
  const before=(await repo.getTherapists()).length;
  const res=await app.inject({method:'POST',url:'/v1/staff',headers:headers(adminCookie),payload:{name:'Rollback QA',email:'rollback@example.invalid',password,role:'therapist'}});
  expect(res.statusCode).toBe(500);expect(res.body).not.toContain('SQL');
  expect((await repo.getTherapists()).length).toBe(before);expect((await local.db.query("select user_id from public.staff_members where email='rollback@example.invalid'")).rows).toHaveLength(0);
  expect([...fake.users.values()].some(u=>u.email==='rollback@example.invalid')).toBe(false);
});
