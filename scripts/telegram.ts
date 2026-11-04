import { connectPostgres } from '../packages/db/src/client.js';
import { OpenRouterModel } from '../packages/agent/src/openrouter.js';
import { TelegramApi } from '../packages/channels/src/telegram.js';
import { TelegramService } from '../apps/agent-api/src/telegram-service.js';

const required=(key:string)=>{const value=process.env[key]?.trim();if(!value)throw new Error(`${key} is required`);return value;};
const api=new TelegramApi(required('TELEGRAM_BOT_TOKEN'));
const code=required('TELEGRAM_TEST_CODE');
if(code.length<12)throw new Error('TELEGRAM_TEST_CODE must contain at least 12 characters');
const testMode=process.env.TELEGRAM_TEST_MODE==='true';
if(testMode&&process.env.NODE_ENV==='production')throw new Error('TELEGRAM_TEST_MODE_NOT_ALLOWED_IN_PRODUCTION');
const testUserId=testMode?Number(required('TELEGRAM_TEST_USER_ID')):null;
if(testUserId!==null&&(!Number.isSafeInteger(testUserId)||testUserId<=0))throw new Error('TELEGRAM_TEST_USER_ID_INVALID');
let close:(()=>Promise<void>)|undefined;
try{
  const bot=await api.me(),webhook=await api.webhook();
  const expected=process.env.TELEGRAM_BOT_USERNAME?.replace(/^@/,'').trim();
  if(expected&&bot.username.toLowerCase()!==expected.toLowerCase())throw new Error('TELEGRAM_BOT_USERNAME_MISMATCH');
  if(webhook.url)throw new Error('TELEGRAM_WEBHOOK_ALREADY_CONFIGURED: use a new test bot or remove its webhook explicitly');
  // Separate processes must never open the same embedded PGlite data directory.
  const db=connectPostgres(required('DATABASE_URL'));close=()=>db.close();
  const key=process.env.OPENROUTER_API_KEY?.trim();
  const model=key&&process.env.OPENROUTER_ENABLED!=='false'?new OpenRouterModel(key,{model:process.env.OPENROUTER_MODEL?.trim()||'openai/gpt-6-luna'}):undefined;
  const service=new TelegramService(db,api,bot.id,code,model,testUserId);
  const controller=new AbortController();for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>controller.abort());
  await service.acquire();
  console.log(`Telegram @${bot.username}: prueba privada activa mediante long polling. Usá tu enlace de invitación para iniciar.`);
  await service.run(controller.signal);
}catch(error){
  // Never log fetch exceptions, response bodies, tokens, invitation codes or patient messages.
  console.error(error instanceof Error&&/^(TELEGRAM_|Invalid TELEGRAM_|TELEGRAM_TEST_CODE)/.test(error.message)?error.message:'Telegram no pudo iniciarse. Revisá la configuración y la conexión.');process.exitCode=1;
}finally{await close?.();}
