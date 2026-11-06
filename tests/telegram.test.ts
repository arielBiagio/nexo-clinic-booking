import { randomUUID } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { beforeAll,beforeEach,afterAll,it,expect,vi } from 'vitest';
import { createLocalDatabase,seedLocal } from '../packages/db/src/client.js';
import { ClinicRepository } from '../packages/db/src/repository.js';
import { DemoService } from '../apps/agent-api/src/demo-service.js';
import { TelegramService } from '../apps/agent-api/src/telegram-service.js';
import { TelegramApi,TelegramError } from '../packages/channels/src/telegram.js';
import type { IntentModel } from '../packages/agent/src/openrouter.js';

const code='test-invitation-0123456789',bot=12345,user=987654;
let local:Awaited<ReturnType<typeof createLocalDatabase>>,repo:ClinicRepository,bridge:TelegramService,api:TelegramApi;
let fetcher:ReturnType<typeof vi.fn<typeof fetch>>,decide:ReturnType<typeof vi.fn<IntentModel['decide']>>;
let calls:{method:string;body:Record<string,any>}[],serial:number,next:number;
beforeAll(async()=>{local=await createLocalDatabase();repo=new ClinicRepository(local.db);});
afterAll(async()=>{await local.db.close();});
beforeEach(async()=>{
  await local.engine.exec('truncate auth.users, public.clinics, public.therapists, public.patients restart identity cascade; truncate private.telegram_bots cascade;');
  await seedLocal(local.engine);for(const t of await repo.getTherapists())await repo.regenerate(String(t.id),Temporal.Now.plainDateISO('America/New_York').toString(),14);
  calls=[];serial=100;next=1;
  fetcher=vi.fn<typeof fetch>().mockImplementation(async(url,options)=>{
    const method=String(url).split('/').at(-1)!,body=JSON.parse(String(options?.body));calls.push({method,body});
    return new Response(JSON.stringify({ok:true,result:method==='sendMessage'?{message_id:++serial}:true}),{status:200});
  });
  api=new TelegramApi('12345:fake-test-token-0123456789',fetcher);
  decide=vi.fn<IntentModel['decide']>().mockResolvedValue({kind:'availability',filter:{therapist_id:null,date:null,not_before:'13:00',not_after:'17:00',horizon_days:14}});
  bridge=new TelegramService(local.db,api,bot,code,{model:'qa',decide});await bridge.acquire();
});
const message=(text:string,userId=user)=>({update_id:next++,message:{message_id:next,from:{id:userId,is_bot:false},chat:{id:userId,type:'private'},text}});
async function pair(userId=user){await bridge.handle(message(`/start ${code}`,userId));return (await local.db.query<{conversation_id:string}>('select conversation_id from private.telegram_peers where bot_id=$1 and user_id=$2',[bot,userId])).rows[0]!.conversation_id;}
function latest(){return calls.filter(c=>c.method==='sendMessage').at(-1)!;}
async function click(data:string,telegramId=serial,userId=user){await bridge.handle({update_id:next++,callback_query:{id:`callback-${next}`,from:{id:userId},message:{message_id:telegramId,chat:{id:userId,type:'private'}},data}});}

it('keeps an uninvited user out of the database, model and other patient context',async()=>{
  await bridge.handle(message('/start wrong-code'));await bridge.handle(message('Quiero un turno'));
  expect((await local.db.query('select * from private.telegram_peers')).rows).toHaveLength(0);expect(decide).not.toHaveBeenCalled();
  expect(latest().body.text).toContain('prueba privada');expect(JSON.stringify(calls)).not.toContain(code);
});
it('pairs only a private sender and leaves the Telegram display name and number unconfirmed',async()=>{
  const group=message(`/start ${code}`);group.message.chat.type='group';group.message.chat.id=-100;
  await bridge.handle(group);expect((await local.db.query('select * from private.telegram_peers')).rows).toHaveLength(0);
  const id=await pair(),patient=await repo.getPatientDetails(id);expect(patient.name_collected).toBe(false);expect(patient.phone).toBeNull();
  await bridge.flush();expect(calls.filter(c=>c.method==='sendMessage')).toHaveLength(2);
  expect(latest().body.reply_markup.inline_keyboard[0][0].text).toContain('Quiero reservar');
  expect(JSON.stringify(calls)).not.toContain(code);
});
it('books from natural language and Telegram buttons, persists patient information and deduplicates the update',async()=>{
  const id=await pair();await bridge.flush();await bridge.handle(message('Quiero fisio por la tarde'));await bridge.flush();
  const offered=latest().body.reply_markup.inline_keyboard;expect(offered.length).toBeGreaterThan(1);
  expect(Buffer.byteLength(offered[0][0].callback_data)).toBeLessThanOrEqual(64);
  await click(offered[0][0].callback_data);await bridge.flush();
  expect(latest().body.text).toContain('nombre y teléfono');expect((await repo.getPatientDetails(id)).phone).toBeNull();
  decide.mockResolvedValueOnce({kind:'patient',details:{name:'Paciente Telegram QA',phone:'2025550198',insurance:'Seguro QA',reported_reason:'molestia lumbar',additional_info:null}});
  await bridge.handle(message('Soy Paciente Telegram QA, 2025550198, Seguro QA, molestia lumbar'));await bridge.flush();
  expect(latest().body.text).toContain('¿Lo confirmás?');
  const confirmation=message('Sí, confirmo');await bridge.handle(confirmation);await bridge.handle(confirmation);await bridge.flush();
  expect((await local.db.query('select * from public.appointments where conversation_id=$1',[id])).rows).toHaveLength(1);
  const patient=await repo.getPatientDetails(id);expect(patient).toMatchObject({name:'Paciente Telegram QA',phone:'2025550198',insurance:'Seguro QA',reported_reason:'molestia lumbar'});
  expect(patient.intake_summary).toContain('no verificado');expect(latest().body.text).toContain('confirmado');
  const original=(await repo.getUpcomingAppointments(id))[0]!;
  decide.mockResolvedValueOnce({kind:'reschedule',appointmentId:null,filter:{therapist_id:null,date:null,not_before:'13:00',not_after:'17:00',horizon_days:14}});
  await bridge.handle(message('Quiero cambiar el turno para otro día por la tarde'));await bridge.flush();
  await click(latest().body.reply_markup.inline_keyboard[0][0].callback_data);await bridge.flush();
  expect(latest().body.text).toContain('se mantiene');
  const confirmButton=latest().body.reply_markup.inline_keyboard.find((row:any)=>row[0].text==='Confirmar turno')[0];
  await click(confirmButton.callback_data);await bridge.flush();
  expect((await repo.getUpcomingAppointments(id))[0]).toMatchObject({id:original.id,version:1});expect(latest().body.text).toContain('reprogramado');
  await bridge.handle(message('Mi diagnóstico es tendinitis'));await bridge.flush();
  expect((await repo.getPatientDetails(id)).reported_reason).toBe('tendinitis');
});
it('rejects a button from another user, a malformed UUID and an older keyboard without reserving',async()=>{
  const id=await pair();await bridge.handle(message('Quiero fisio por la tarde'));await bridge.flush();
  const button=latest().body.reply_markup.inline_keyboard[0][0].callback_data,old=serial;
  await pair(user+1);await click(button,old,user+1);expect(calls.at(-1)!.body.text).toContain('venció');
  await click('------------------------------------:0',old);expect(calls.at(-1)!.body.text).toContain('no es válido');
  await bridge.handle(message('Otro día por favor'));await bridge.flush();await click(button,old);
  expect(calls.at(-1)!.body.text).toContain('venció');expect((await local.db.query('select pending_slot_id from public.conversations where id=$1',[id])).rows[0]!.pending_slot_id).toBeNull();
});
it('delivers a staff reply after restart while the assistant remains paused',async()=>{
  const id=await pair();await bridge.flush();const s=new DemoService(repo);await s.reply(id,'Hola, soy recepción Telegram QA',randomUUID());
  await bridge.release();bridge=new TelegramService(local.db,api,bot,code,{model:'qa',decide});await bridge.flush();
  expect(latest().body.text).toBe('Hola, soy recepción Telegram QA');expect(latest().body.reply_markup).toBeUndefined();
  await bridge.handle(message('Gracias'));expect(decide).not.toHaveBeenCalled();
  expect((await s.get(id)).messages.at(-1)!.text).toBe('Gracias');
});
it('retains the cursor and delivered messages across worker restarts without repeating replies',async()=>{
  await pair();await bridge.flush();const sent=calls.filter(c=>c.method==='sendMessage').length;
  const offset=await bridge.acquire();await bridge.release();bridge=new TelegramService(local.db,api,bot,code);expect(await bridge.acquire()).toBe(offset);
  await bridge.handle({update_id:offset-1});await bridge.flush();expect(calls.filter(c=>c.method==='sendMessage')).toHaveLength(sent);
});
it('keeps a failed delivery queued and retries it without repeating a booking',async()=>{
  const id=await pair();await bridge.syncOutbox();fetcher.mockImplementationOnce(async()=>new Response(JSON.stringify({ok:false,error_code:429,parameters:{retry_after:2}}),{status:429}));
  await bridge.flush();expect((await local.db.query("select status from private.telegram_outbox where bot_id=$1 order by attempts desc",[bot])).rows[0]!.status).toBe('pending');
  await local.db.query("update private.telegram_outbox set next_attempt_at=now()-interval '1 second'");await bridge.flush();
  expect((await local.db.query("select id from private.telegram_outbox where status<>'sent'")).rows).toHaveLength(0);
  expect((await local.db.query('select id from public.appointments where conversation_id=$1',[id])).rows).toHaveLength(0);
});
it('keeps the same Telegram patient usable beyond the former lifetime message limit',async()=>{
  const id=await pair();await bridge.flush();
  await local.db.query("insert into public.messages(conversation_id,external_message_id,direction,role,body) select $1,'qa-old-'||n,'inbound','patient','Historia ficticia QA' from generate_series(1,121) n",[id]);
  const update=message('Quiero un turno por la tarde');await bridge.handle(update);await bridge.flush();
  expect(latest().body.reply_markup.inline_keyboard.some((row:any)=>row[0].text.includes('·'))).toBe(true);
  expect(latest().body.text).not.toContain('alcanzó su límite');
  expect(Number((await local.db.query('select next_update_id from private.telegram_bots where bot_id=$1',[bot])).rows[0]!.next_update_id)).toBe(update.update_id+1);
  expect((await local.db.query('select conversation_id from private.telegram_peers where bot_id=$1 and user_id=$2',[bot,user])).rows[0]!.conversation_id).toBe(id);
});
it('records permanent delivery failure when the patient blocks the bot',async()=>{
  await pair();fetcher.mockImplementation(async()=>new Response(JSON.stringify({ok:false,error_code:403}),{status:403}));await bridge.flush();
  expect((await local.db.query('select status,last_error from private.telegram_outbox')).rows.every(row=>row.status==='failed'&&row.last_error==='TELEGRAM_403')).toBe(true);
});
it('prevents simultaneous consumers and permits another worker after release',async()=>{
  const second=new TelegramService(local.db,api,bot,code);await expect(second.acquire()).rejects.toThrow('ALREADY_RUNNING');
  await bridge.release();await expect(second.acquire()).resolves.toBe(0);await second.release();
});
it('does not resurrect an archived conversation or deliver its queued messages',async()=>{
  const id=await pair();await bridge.syncOutbox();await new DemoService(repo).archive(id,true);await bridge.flush();
  expect(calls.filter(c=>c.method==='sendMessage')).toHaveLength(0);await bridge.handle(message('Quiero un turno'));
  expect(latest().body.text).toContain('archivada');expect((await local.db.query('select archived_at from public.conversations where id=$1',[id])).rows[0]!.archived_at).toBeTruthy();
  expect(decide).not.toHaveBeenCalled();
});
it('advances unsupported updates and explains unsupported media without calling the model',async()=>{
  const id=await pair();await bridge.handle({update_id:next++,edited_message:{}});const photo=message('');delete (photo.message as {text?:string}).text;await bridge.handle(photo);await bridge.flush();
  expect(latest().body.text).toContain('mensajes de texto');expect(decide).not.toHaveBeenCalled();expect((await new DemoService(repo).get(id)).messages.at(-1)!.role).toBe('assistant');
});
it('does not disclose the token or full URL when the Telegram request fails',async()=>{
  fetcher.mockRejectedValue(new Error('https://api.telegram.org/botSECRET/getUpdates'));
  await expect(api.me()).rejects.toMatchObject({message:'TELEGRAM_0'});
  await expect(api.me()).rejects.toBeInstanceOf(TelegramError);
});
it('keeps Telegram identities and outbox private while allowing the backend login',async()=>{
  await pair();await bridge.syncOutbox();
  for(const role of ['anon','authenticated'])await expect(local.db.transaction(async db=>{
    await db.query(`set local role ${role}`);await db.query('select user_id from private.telegram_peers');
  })).rejects.toThrow(/permission denied/);
  await local.db.transaction(async db=>{
    await db.query('set local role nexo_backend');
    expect((await db.query('select user_id from private.telegram_peers')).rows).toHaveLength(1);
    expect((await db.query('select id from private.telegram_outbox')).rows).toHaveLength(2);
  });
});
