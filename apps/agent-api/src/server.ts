import { Temporal } from '@js-temporal/polyfill';
import { connectPostgres, createLocalDatabase, seedLocal } from '../../../packages/db/src/client.js';
import { ClinicRepository } from '../../../packages/db/src/repository.js';
import { buildApp } from './app.js';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { DemoService, populateDashboard } from './demo-service.js';
import { OpenRouterModel } from '../../../packages/agent/src/openrouter.js';

if (process.env.NODE_ENV === 'production') throw new Error('This local demo must not run in production');
const host = process.env.HOST ?? '127.0.0.1';
if (host !== '127.0.0.1' && host !== '::1') throw new Error('Local demo must bind to a loopback address');
const token = process.env.DEMO_API_TOKEN ?? '';
if (token.length < 32) throw new Error('Set DEMO_API_TOKEN to a random value of at least 32 characters in .env');
const port = Number(process.env.PORT ?? 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');

if(!process.env.DATABASE_URL)await mkdir(resolve('.local'),{recursive:true});
const local = process.env.DATABASE_URL ? null : await createLocalDatabase({dataDir:resolve('.local/clinic-db')});
const db = local?.db ?? connectPostgres(process.env.DATABASE_URL!);
const fresh=local?!(await db.query('select singleton from public.clinics')).rows.length:false;
if (local&&fresh) await seedLocal(local.engine);
const repository = new ClinicRepository(db);
const openRouterKey=process.env.OPENROUTER_API_KEY?.trim();
const intentModel=openRouterKey&&process.env.OPENROUTER_ENABLED!=='false'
  ?new OpenRouterModel(openRouterKey,{model:process.env.OPENROUTER_MODEL?.trim()||'openai/gpt-4o-mini'}):undefined;
const demo = local ? new DemoService(repository,intentModel) : undefined;
if (local) {
  const today = Temporal.Now.plainDateISO('America/New_York').toString();
  for (const therapist of await repository.getTherapists()) await repository.regenerate(String(therapist.id), today, 21);
  if(fresh)await populateDashboard(demo!);
}
const dashboardDirectory = resolve('dist/dashboard');
const app = buildApp(repository, token, local && existsSync(dashboardDirectory) ? { dashboardDirectory, demo: demo! } : {});
app.addHook('onClose', () => db.close());
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void app.close(); });
}
await app.listen({ host, port });
console.log(`Synthetic local API listening at http://${host}:${port}; data ${local ? 'persists in .local/clinic-db' : 'uses the configured development database'}.`);
if (local) console.log(`Nexo dashboard: http://${host}:${port}`);
if (local) console.log(`Chat mode: ${intentModel?`OpenRouter / ${intentModel.model}`:'guided (no LLM configured)'}.`);
