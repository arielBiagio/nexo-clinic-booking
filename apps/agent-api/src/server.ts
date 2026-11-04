import { Temporal } from '@js-temporal/polyfill';
import { connectPostgres, createLocalDatabase, seedLocal } from '../../../packages/db/src/client.js';
import { ClinicRepository } from '../../../packages/db/src/repository.js';
import { buildApp } from './app.js';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { DemoService, populateDashboard } from './demo-service.js';
import { OpenRouterModel } from '../../../packages/agent/src/openrouter.js';
import { StaffAuth } from './staff-auth.js';
import { GoogleCalendar } from './google-calendar.js';

const staffMode=process.env.AUTH_MODE==='staff';
if (process.env.NODE_ENV === 'production'&&!staffMode) throw new Error('Public servers require staff authentication');
const host = process.env.HOST ?? '127.0.0.1';
if (!staffMode&&host !== '127.0.0.1' && host !== '::1') throw new Error('Local demo must bind to a loopback address');
const token = process.env.DEMO_API_TOKEN ?? '';
if (!staffMode&&token.length < 32) throw new Error('Set DEMO_API_TOKEN to a random value of at least 32 characters in .env');
const port = Number(process.env.PORT ?? 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');

if(staffMode&&!process.env.DATABASE_URL)throw new Error('Staff mode requires DATABASE_URL');
if(!process.env.DATABASE_URL)await mkdir(resolve('.local'),{recursive:true});
const local = process.env.DATABASE_URL ? null : await createLocalDatabase({dataDir:resolve('.local/clinic-db')});
const db = local?.db ?? connectPostgres(process.env.DATABASE_URL!);
const fresh=local?!(await db.query('select singleton from public.clinics')).rows.length:false;
if (local&&fresh) await seedLocal(local.engine);
const repository = new ClinicRepository(db);
const openRouterKey=process.env.OPENROUTER_API_KEY?.trim();
const intentModel=openRouterKey&&process.env.OPENROUTER_ENABLED!=='false'
  ?new OpenRouterModel(openRouterKey,{model:process.env.OPENROUTER_MODEL?.trim()||'openai/gpt-4o-mini'}):undefined;
const demo = new DemoService(repository,intentModel);
if (local||staffMode) {
  const clinic=(await db.query<{time_zone:string}>('select time_zone from public.clinics')).rows[0];
  if(!clinic)throw new Error('Clinic configuration is missing');
  const today = Temporal.Now.plainDateISO(clinic.time_zone).toString();
  for (const therapist of await repository.getTherapists()) await repository.regenerate(String(therapist.id), today, 21);
  if(fresh)await populateDashboard(demo);
}
const required=(key:string)=>{const value=process.env[key]?.trim();if(!value)throw new Error(`${key} is required in staff mode`);return value;};
const auth=staffMode?new StaffAuth(db,{url:required('SUPABASE_URL'),publishableKey:required('SUPABASE_PUBLISHABLE_KEY'),secretKey:required('SUPABASE_SECRET_KEY'),encryptionKey:required('SESSION_ENCRYPTION_KEY'),origin:required('PUBLIC_ORIGIN'),bootstrapEmail:process.env.BOOTSTRAP_ADMIN_EMAIL??''}):undefined;
if(auth?.isLocal&&host!=='127.0.0.1'&&host!=='::1')throw new Error('Local staff setup requires a loopback listener');
if(process.env.NODE_ENV==='production'&&auth?.isLocal)throw new Error('Production requires a public HTTPS origin');
const dashboardDirectory = resolve('dist/dashboard');
const calendar=auth?new GoogleCalendar(db,{origin:auth.origin.origin,encryptionKey:required('SESSION_ENCRYPTION_KEY'),clientId:process.env.GOOGLE_CLIENT_ID?.trim()??'',clientSecret:process.env.GOOGLE_CLIENT_SECRET?.trim()??''}):undefined;
const app = buildApp(repository, token, {demo,...(existsSync(dashboardDirectory)?{dashboardDirectory}:{}),...(auth?{auth}:{}),...(calendar?{calendar}:{})});
app.addHook('onClose', async() => {await calendar?.stop();await db.close();});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void app.close(); });
}
await app.listen({ host, port });
calendar?.start();
console.log(`Nexo listening at http://${host}:${port}; data ${local ? 'persists locally' : 'uses Supabase PostgreSQL'}.`);
console.log(`Access mode: ${staffMode?'staff authentication':'local demo'}. Chat: ${intentModel?`OpenRouter / ${intentModel.model}`:'guided'}.`);
if(calendar)console.log(`Google Calendar: ${calendar.configured?'sincronización habilitada para cuentas autorizadas':'pendiente configurar credenciales OAuth'}.`);
