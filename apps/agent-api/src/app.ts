import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { ClinicRepository, DomainError } from '../../../packages/db/src/repository.js';
import type { DemoService } from './demo-service.js';
import { patientDetailsInput } from '../../../packages/core/src/patient.js';
import type { StaffAuth } from './staff-auth.js';

const id = z.uuid();
const selection = z.strictObject({ slotId: id });
const booking = z.strictObject({ slotId: id, confirmed: z.boolean() });
const query = z.strictObject({ therapistId: id, from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }) });
const handoff = z.strictObject({ reason: z.enum(['requested_human', 'not_understood', 'clinical', 'billing', 'exception', 'tool_failure']) });
const digest = (value: string) => createHash('sha256').update(value).digest();

/** Staff sessions are verified before every API request; demo cookies exist only without StaffAuth. */
export function buildApp(repository: ClinicRepository, token: string, options: { dashboardDirectory?: string; demo?: DemoService;auth?:StaffAuth } = {}) {
  if (!options.auth&&token.length < 32) throw new Error('DEMO_API_TOKEN must contain at least 32 characters');
  const app = Fastify({ logger: false, bodyLimit: 16_384, requestTimeout: 10_000 });
  const localSession = randomBytes(32).toString('base64url');
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    const pathname = request.url.split('?')[0];
    if (pathname === '/health') return;
    const host = request.headers.host ?? '';
    const localHost = /^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host);
    if (options.dashboardDirectory && (pathname === '/' || pathname?.startsWith('/assets/'))) {
      if (options.auth?host!==options.auth.origin.host:!localHost) return reply.code(403).send({ error: 'HOST_NOT_ALLOWED' });
      reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'");
      if (pathname === '/'&&!options.auth) reply.header('Set-Cookie', `nexo_demo=${localSession}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800`);
      return;
    }
    if(options.auth){
      if(host!==options.auth.origin.host)throw new DomainError('HOST_NOT_ALLOWED',403);
      options.auth.assertOrigin(request);
      if(['/v1/auth/status','/v1/auth/login','/v1/auth/setup','/v1/auth/logout'].includes(pathname??''))return;
      request.staff=await options.auth.authenticate(request);
      if(pathname?.startsWith('/v1/staff')&&request.staff.role!=='admin')throw new DomainError('FORBIDDEN',403);
      if(request.staff.role==='therapist'){
        const own=request.staff.therapistId;
        const route=pathname??'',method=request.method;
        let allowed=method==='GET'&&(['/v1/auth/me','/v1/dashboard','/v1/therapists','/v1/demo/removed/appointments'].includes(route)||route==='/v1/availability'&&new URL(request.url,'http://local').searchParams.get('therapistId')===own);
        if(route===`/v1/therapists/${own}/profile`&&['GET','PATCH'].includes(method)||route===`/v1/therapists/${own}/schedule`&&['GET','PUT'].includes(method)||route===`/v1/therapists/${own}/time-off`&&method==='POST'||route.startsWith(`/v1/therapists/${own}/time-off/`)&&method==='DELETE'||route===`/v1/therapists/${own}/appointments`&&method==='POST')allowed=true;
        const appointment=route.match(/^\/v1\/appointments\/([^/]+)(\/restore)?$/);
        if(appointment&&(method==='DELETE'&&!appointment[2]||method==='POST'&&appointment[2])){
          const row=(await repository.db.query('select therapist_id from public.appointments where id=$1',[id.parse(appointment[1])])).rows[0];
          if(!row)throw new DomainError('APPOINTMENT_NOT_FOUND',404);
          allowed=row.therapist_id===own;
        }
        const patient=route.match(/^\/v1\/conversations\/([^/]+)\/patient$/);
        if(patient&&method==='GET')allowed=(await repository.db.query("select id from public.appointments where conversation_id=$1 and therapist_id=$2 and status='confirmed' limit 1",[id.parse(patient[1]),own])).rows.length>0;
        if(!allowed)throw new DomainError('FORBIDDEN',403);
      }
      return;
    }
    if(pathname==='/v1/auth/status'||pathname==='/v1/auth/me')return;
    const authorization = request.headers.authorization ?? '';
    if (timingSafeEqual(digest(authorization), digest(`Bearer ${token}`))) return;
    const cookie = request.headers.cookie?.split(';').map(value=>value.trim()).find(value=>value.startsWith('nexo_demo='))?.slice('nexo_demo='.length) ?? '';
    if (options.dashboardDirectory && localHost && timingSafeEqual(digest(cookie),digest(localSession))) {
      if (request.headers.origin && request.headers.origin !== `http://${host}`) return reply.code(403).send({ error: 'ORIGIN_NOT_ALLOWED' });
      return;
    }
    return reply.code(401).send({ error: 'UNAUTHORIZED' });
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ error: 'INVALID_INPUT' });
    if (error instanceof DomainError) return reply.code(error.status).send({ error: error.code });
    const status = typeof error === 'object' && error !== null && 'statusCode' in error ? Number(error.statusCode) : 500;
    if (status >= 400 && status < 500) return reply.code(status).send({ error: 'INVALID_REQUEST' });
    // Do not expose SQL, patient input, credentials, or stack traces.
    return reply.code(500).send({ error: 'INTERNAL_ERROR' });
  });
  app.get('/health', async () => ({ status: 'ok', mode: options.auth?'staff':'synthetic-local-demo' }));
  if(options.auth)options.auth.register(app);
  else{
    app.get('/v1/auth/status',async()=>({mode:'demo',setupRequired:false}));
    app.get('/v1/auth/me',async()=>({mode:'demo',user:{id:'local',name:'Admin',email:'',role:'admin',therapistId:null}}));
  }
  app.get('/v1/therapists', async request => (await repository.getTherapists()).filter(t=>request.staff?.role!=='therapist'||t.id===request.staff.therapistId));
  app.get('/v1/therapists/:id/profile',request=>repository.getTherapistProfile(id.parse((request.params as {id:string}).id)));
  app.patch('/v1/therapists/:id/profile',request=>repository.updateTherapistProfile(id.parse((request.params as {id:string}).id),z.strictObject({name:z.string().trim().min(2).max(70),specialty:z.string().trim().min(2).max(120)}).parse(request.body),request.staff));
  app.post('/v1/therapists/:id/appointments',request=>{
    const input=z.strictObject({slotId:id,confirmed:z.literal(true),name:z.string().trim().min(2).max(70),phone:z.string().min(7).max(40)}).parse(request.body);
    const requestId=z.uuid().parse(request.headers['idempotency-key']);
    return repository.createManualAppointment(id.parse((request.params as {id:string}).id),input,requestId,request.staff);
  });
  app.get('/v1/conversations', () => repository.getConversations());
  app.get('/v1/conversations/:id/patient',request=>repository.getPatientDetails(id.parse((request.params as {id:string}).id)));
  app.patch('/v1/conversations/:id/patient',request=>repository.updatePatientDetails(id.parse((request.params as {id:string}).id),patientDetailsInput.parse(request.body)));
  app.get('/v1/availability', async request => {
    const input = query.parse(request.query);
    const duration = Date.parse(input.to) - Date.parse(input.from);
    if (duration <= 0 || duration > 60 * 86_400_000) throw new DomainError('INVALID_DATE_RANGE', 400);
    return repository.getAvailability(input.therapistId, input.from, input.to);
  });
  app.post('/v1/conversations/:id/selection', async request => {
    const conversationId = id.parse((request.params as { id: string }).id);
    return repository.selectSlot(conversationId, selection.parse(request.body).slotId);
  });
  app.post('/v1/conversations/:id/book', async request => {
    const conversationId = id.parse((request.params as { id: string }).id);
    const input = booking.parse(request.body);
    const key = z.string().min(8).max(128).parse(request.headers['idempotency-key']);
    return repository.book(conversationId, input.slotId, key, input.confirmed);
  });
  app.post('/v1/conversations/:id/handoff', async request => {
    const conversationId = id.parse((request.params as { id: string }).id);
    return repository.escalate(conversationId, handoff.parse(request.body).reason);
  });
  if (options.demo) {
    const demo = options.demo;
    app.delete('/v1/appointments/:id',request=>repository.setAppointmentRemoved(id.parse((request.params as {id:string}).id),true,request.staff?.role==='therapist'?request.staff.therapistId??undefined:undefined));
    app.post('/v1/appointments/:id/restore',request=>repository.setAppointmentRemoved(id.parse((request.params as {id:string}).id),false,request.staff?.role==='therapist'?request.staff.therapistId??undefined:undefined));
    app.delete('/v1/demo/conversations/:id',request=>demo.archive(id.parse((request.params as {id:string}).id),true));
    app.post('/v1/demo/conversations/:id/restore',request=>demo.archive(id.parse((request.params as {id:string}).id),false));
    app.get('/v1/demo/removed/:kind',request=>repository.getRemoved(z.enum(['appointments','conversations']).parse((request.params as {kind:string}).kind),request.staff?.role==='therapist'?request.staff.therapistId??undefined:undefined));
    app.get('/v1/dashboard', async request => {
      const input = z.strictObject({ fromDate: z.iso.date().optional() }).parse(request.query);
      return demo.dashboard(input.fromDate,request.staff?.role==='therapist'?request.staff.therapistId??undefined:undefined);
    });
    app.get('/v1/therapists/:id/schedule', request => repository.getSchedule(id.parse((request.params as {id:string}).id)));
    const rest = z.strictObject({ startMinute:z.number().int().min(0).max(1439),endMinute:z.number().int().min(1).max(1440) });
    const rule = z.strictObject({ weekday:z.number().int().min(1).max(7),startMinute:z.number().int().min(0).max(1439),endMinute:z.number().int().min(1).max(1440),
      sessionMinutes:z.number().int().min(5).max(240),bufferMinutes:z.number().int().min(0).max(120),breaks:z.array(rest).max(6) });
    app.put('/v1/therapists/:id/schedule', request => {
      const input = z.strictObject({ rules:z.array(rule).max(21) }).parse(request.body);
      return repository.saveSchedule(id.parse((request.params as {id:string}).id), input.rules);
    });
    app.post('/v1/therapists/:id/time-off', request => {
      const input = z.strictObject({ date:z.iso.date() }).parse(request.body);
      return repository.blockDate(id.parse((request.params as {id:string}).id),input.date);
    });
    app.delete('/v1/therapists/:id/time-off/:block', request => {
      const params=z.strictObject({id,block:id}).parse(request.params);
      return repository.removeTimeOff(params.id,params.block);
    });
    app.post('/v1/demo/conversations', request => demo.create(z.strictObject({ name:z.string().trim().min(2).max(70).optional() }).parse(request.body ?? {}).name));
    app.get('/v1/demo/conversations/:id', request => demo.get(id.parse((request.params as {id:string}).id)));
    app.post('/v1/demo/conversations/:id/messages', request => {
      const input = z.strictObject({ messageId:id,text:z.string().trim().min(1).max(500).optional(),action:z.enum(['start','more','select','confirm','human']).optional(),slotId:id.optional() })
        .refine(value=>value.text || value.action).refine(value=>!(value.text&&value.action)).parse(request.body);
      return demo.send(id.parse((request.params as {id:string}).id),input);
    });
    app.post('/v1/demo/conversations/:id/reply', request => {
      const input = z.strictObject({ messageId:id,text:z.string().trim().min(1).max(500) }).parse(request.body);
      return demo.reply(id.parse((request.params as {id:string}).id),input.text,input.messageId);
    });
    app.post('/v1/demo/conversations/:id/resolve', request => {
      const input = z.strictObject({ mode:z.enum(['active','human_led']) }).parse(request.body);
      return repository.resolveHandoff(id.parse((request.params as {id:string}).id),input.mode);
    });
  }
  if (options.dashboardDirectory) app.register(fastifyStatic,{root:options.dashboardDirectory,index:'index.html',wildcard:true});
  return app;
}
