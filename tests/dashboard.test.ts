import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Temporal } from '@js-temporal/polyfill';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLocalDatabase, seedLocal } from '../packages/db/src/client.js';
import { ClinicRepository } from '../packages/db/src/repository.js';
import { DemoService } from '../apps/agent-api/src/demo-service.js';
import { buildApp } from '../apps/agent-api/src/app.js';
import { api as browserApi } from '../apps/dashboard/src/api.js';

const token='test-dashboard-token-0123456789-abcdefghijkl';
const headers={authorization:`Bearer ${token}`};
const therapist='10000000-0000-4000-8000-000000000001';
let local:Awaited<ReturnType<typeof createLocalDatabase>>;
let repo:ClinicRepository,service:DemoService,app:ReturnType<typeof buildApp>;
let monday:string;
const rules=[1,2,3,4,5].map(weekday=>({weekday,startMinute:540,endMinute:1020,sessionMinutes:45,bufferMinutes:15,breaks:[{startMinute:720,endMinute:780}]}));

beforeAll(async()=>{
  local=await createLocalDatabase();repo=new ClinicRepository(local.db);service=new DemoService(repo);
  const directory=resolve('.local/test-static');await mkdir(directory,{recursive:true});await writeFile(resolve(directory,'index.html'),'<html><body>Nexo demo</body></html>');
  app=buildApp(repo,token,{demo:service,dashboardDirectory:directory});await app.ready();
});
beforeEach(async()=>{
  service.sessions.clear();
  await local.engine.exec('truncate auth.users, public.clinics, public.therapists, public.patients restart identity cascade;');
  await seedLocal(local.engine);
  const today=Temporal.Now.plainDateISO('America/New_York');
  monday=today.add({days:(8-today.dayOfWeek)%7||7}).toString();
  for(const t of await repo.getTherapists())await repo.regenerate(String(t.id),today.toString(),21);
});
afterAll(async()=>{await app.close();await local.db.close();});

describe('local dashboard session',()=>{
  it('serves the interface with an HttpOnly same-site session without exposing the API token',async()=>{
    const page=await app.inject({url:'/',headers:{host:'localhost:3001'}});
    expect(page.statusCode).toBe(200);expect(page.body).not.toContain(token);
    expect(String(page.headers['set-cookie'])).toContain('HttpOnly; SameSite=Strict');
    expect(page.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    const cookie=String(page.headers['set-cookie']).split(';')[0]!;
    const data=await app.inject({url:'/v1/dashboard',headers:{host:'localhost:3001',cookie}});
    expect(data.statusCode).toBe(200);expect(data.json().therapists).toHaveLength(2);
  });
  it('rejects unauthenticated data access and cross-origin cookie writes',async()=>{
    expect((await app.inject({url:'/v1/dashboard'})).statusCode).toBe(401);
    const page=await app.inject({url:'/',headers:{host:'localhost:3001'}});
    const cookie=String(page.headers['set-cookie']).split(';')[0]!;
    const result=await app.inject({method:'POST',url:'/v1/demo/conversations',headers:{host:'localhost:3001',cookie,origin:'https://foreign.example'},payload:{}});
    expect(result.statusCode).toBe(403);
  });
  it('does not bootstrap demo sessions for foreign hostnames or expose source files',async()=>{
    expect((await app.inject({url:'/',headers:{host:'foreign.example'}})).statusCode).toBe(403);
    const hidden=await app.inject({url:'/.env',headers});expect(hidden.statusCode).toBe(404);expect(hidden.body).not.toContain(token);
  });
});

describe('schedule editor and time off',()=>{
  it('saves new rules and retires old open slots in the same transaction',async()=>{
    const changed=rules.map(r=>r.weekday===1?{...r,startMinute:600}:r);
    const response=await app.inject({method:'PUT',url:`/v1/therapists/${therapist}/schedule`,headers,payload:{rules:changed}});
    expect(response.statusCode).toBe(200);
    const start=Temporal.PlainDate.from(monday).toZonedDateTime('America/New_York').toInstant();
    const slots=await repo.getAvailability(therapist,start.toString(),start.add({hours:24}).toString());
    expect(slots).toHaveLength(6);
    expect(Temporal.Instant.from((slots[0]!.starts_at as Date).toISOString()).toZonedDateTimeISO('America/New_York').hour).toBe(10);
  });
  it('rejects an invalid break without modifying existing rules',async()=>{
    const before=await repo.getSchedule(therapist);
    const bad=await app.inject({method:'PUT',url:`/v1/therapists/${therapist}/schedule`,headers,payload:{rules:[{...rules[0],breaks:[{startMinute:0,endMinute:60}]}]}});
    expect(bad.statusCode).toBe(400);expect(await repo.getSchedule(therapist)).toEqual(before);
  });
  it('preserves confirmed appointments when replacing the working week',async()=>{
    const chat=await service.create();
    await repo.updatePatientDetails(chat.id,{name:'Paciente QA',phone:'2025550108'});
    const from=Temporal.PlainDate.from(monday).toZonedDateTime('America/New_York').toInstant();
    const slot=(await repo.getAvailability(therapist,from.toString(),from.add({hours:24}).toString()))[0]!;
    await repo.selectSlot(chat.id,String(slot.id));const appointment=await repo.book(chat.id,String(slot.id),'preserve-booking-001',true);
    await repo.saveSchedule(therapist,rules.map(r=>({...r,startMinute:600})));
    expect((await local.db.query('select id from public.appointments')).rows).toEqual([{id:appointment.id}]);
  });
  it('blocks a full date without duplicating the absence, and allows restoring it',async()=>{
    await repo.blockDate(therapist,monday);await repo.blockDate(therapist,monday);
    const schedule=await repo.getSchedule(therapist);expect(schedule.timeOff).toHaveLength(1);
    const from=Temporal.PlainDate.from(monday).toZonedDateTime('America/New_York').toInstant();
    expect(await repo.getAvailability(therapist,from.toString(),from.add({hours:24}).toString())).toEqual([]);
    const removed=await app.inject({method:'DELETE',url:`/v1/therapists/${therapist}/time-off/${schedule.timeOff[0]!.id}`,headers});
    expect(removed.statusCode).toBe(200);
    expect(await repo.getAvailability(therapist,from.toString(),from.add({hours:24}).toString())).toHaveLength(7);
  });
  it('rejects blocking a date that already has confirmed appointments',async()=>{
    const chat=await service.create();
    await repo.updatePatientDetails(chat.id,{name:'Paciente QA',phone:'2025550108'});
    const from=Temporal.PlainDate.from(monday).toZonedDateTime('America/New_York').toInstant();
    const slot=(await repo.getAvailability(therapist,from.toString(),from.add({hours:24}).toString()))[0]!;
    await repo.selectSlot(chat.id,String(slot.id));await repo.book(chat.id,String(slot.id),'blocking-request-001',true);
    const result=await app.inject({method:'POST',url:`/v1/therapists/${therapist}/time-off`,headers,payload:{date:monday}});
    expect(result.statusCode).toBe(409);expect(result.json().error).toBe('DATE_HAS_APPOINTMENTS');
    expect((await repo.getSchedule(therapist)).timeOff).toEqual([]);
  });
  it('restores an absence through the actual browser client without an empty JSON body error',async()=>{
    await repo.blockDate(therapist,monday);
    const block=(await repo.getSchedule(therapist)).timeOff[0]!;
    const bridge=vi.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=>{
      const response=await app.inject({url:String(input),method:'DELETE',
        headers:{...Object.fromEntries(new Headers(init?.headers).entries()),...headers},
        ...(init?.body?{payload:String(init.body)}:{})});
      return new Response(response.body,{status:response.statusCode,headers:{'content-type':'application/json'}});
    });
    try{
      await browserApi(`/therapists/${therapist}/time-off/${block.id}`,undefined,'DELETE');
      expect((await repo.getSchedule(therapist)).timeOff).toEqual([]);
    }finally{bridge.mockRestore();}
  });
});

describe('guided patient simulator and reception',()=>{
  it('completes booking through guided choices with one booking per repeated confirmation',async()=>{
    const created=await app.inject({method:'POST',url:'/v1/demo/conversations',headers,payload:{name:'Paciente QA ficticio'}});
    const id=created.json().id as string;
    await repo.updatePatientDetails(id,{phone:'2025550108'});
    const start=await service.send(id,{messageId:randomUUID(),action:'start'});
    const choice=start.choices.find(c=>c.action==='select')!;
    await service.send(id,{messageId:randomUUID(),action:'select',slotId:choice.slotId});
    const confirmation={messageId:randomUUID(),action:'confirm' as const};
    const first=await service.send(id,confirmation);const second=await service.send(id,confirmation);
    expect(first.messages.length).toBe(second.messages.length);
    expect((await local.db.query('select id from public.appointments')).rows).toHaveLength(1);
    expect((await local.db.query('select id from private.delivery_jobs')).rows).toHaveLength(2);
  });
  it('pauses automated replies while reception handles the conversation and audits resolution',async()=>{
    const chat=await service.create();
    await service.send(chat.id,{messageId:randomUUID(),action:'human'});
    const before=await service.get(chat.id);
    const waiting=await service.send(chat.id,{messageId:randomUUID(),text:'¿Me ayudan con el horario?'});
    expect(waiting.messages.filter(m=>m.role==='assistant')).toHaveLength(before.messages.filter(m=>m.role==='assistant').length);
    const message=randomUUID();await service.reply(chat.id,'Hola, te ayudamos a coordinar.',message);await service.reply(chat.id,'Hola, te ayudamos a coordinar.',message);
    expect((await service.get(chat.id)).messages.filter(m=>m.role==='staff')).toHaveLength(1);
    expect((await service.get(chat.id)).status).toBe('human_led');
    await repo.resolveHandoff(chat.id,'active');
    expect((await service.get(chat.id)).status).toBe('active');
    expect((await local.db.query('select resolved_at from public.handoffs')).rows[0]!.resolved_at).not.toBeNull();
    expect((await local.db.query('select action from private.audit_events order by id')).rows.map(r=>r.action)).toEqual(['handoff_opened','staff_replied','conversation_control_changed']);
  });
});
