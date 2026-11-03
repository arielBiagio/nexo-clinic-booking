import { createHash,randomUUID,timingSafeEqual } from 'node:crypto';
import { DomainError,ClinicRepository } from '../../../packages/db/src/repository.js';
import { withSavepoints } from '../../../packages/db/src/savepoints.js';
import type { Sql } from '../../../packages/db/src/client.js';
import { TelegramApi,TelegramError,telegramUpdate,type TelegramUpdate } from '../../../packages/channels/src/telegram.js';
import type { IntentModel } from '../../../packages/agent/src/openrouter.js';
import { DemoService,type DemoChoice,type ChatInput } from './demo-service.js';

const hash=(text:string)=>createHash('sha256').update(text).digest();
interface Delivery extends Record<string,unknown>{id:string;user_id:string|number;message_id:string;body:string;choices:DemoChoice[];attempts:number}

/** One durable consumer per bot. Only private chats invited with the test code are linked. */
export class TelegramService {
  private readonly owner=randomUUID();
  constructor(readonly db:Sql,readonly api:TelegramApi,readonly botId:number,private readonly testCode:string,private readonly model?:IntentModel,private readonly testUserId:number|null=null){
    if(testCode.length<12)throw new Error('TELEGRAM_TEST_CODE must contain at least 12 characters');
    if(testUserId!==null&&(!Number.isSafeInteger(testUserId)||testUserId<=0))throw new Error('TELEGRAM_TEST_USER_ID_INVALID');
  }
  async acquire(){
    await this.db.query('insert into private.telegram_bots(bot_id) values ($1) on conflict do nothing',[this.botId]);
    const row=(await this.db.query(`update private.telegram_bots set lease_owner=$2,lease_expires_at=clock_timestamp()+interval '90 seconds'
      where bot_id=$1 and (lease_owner=$2 or lease_expires_at is null or lease_expires_at<clock_timestamp()) returning next_update_id`,[this.botId,this.owner])).rows[0];
    if(!row)throw new Error('TELEGRAM_WORKER_ALREADY_RUNNING');
    return Number(row.next_update_id);
  }
  async release(){await this.db.query('update private.telegram_bots set lease_owner=null,lease_expires_at=null where bot_id=$1 and lease_owner=$2',[this.botId,this.owner]);}

  private async notice(db:Sql,id:string,text:string){
    await db.query(`insert into public.messages(conversation_id,external_message_id,direction,role,body) values ($1,$2,'outbound','assistant',$3)`,[id,randomUUID(),text]);
  }
  private invited(text:string){
    const code=/^\/start(?:@\w+)?\s+(\S+)\s*$/.exec(text)?.[1]??'';
    return timingSafeEqual(hash(code),hash(this.testCode));
  }
  async handle(raw:unknown){
    const parsed=telegramUpdate.safeParse(raw);
    // Telegram may deliver unsupported update kinds even after allowed_updates changes.
    if(!parsed.success)throw new Error('TELEGRAM_INVALID_UPDATE');
    const update=parsed.data;
    const result=await this.db.transaction(async transaction=>{
      const db=withSavepoints(transaction);
      const cursor=(await db.query(`select next_update_id from private.telegram_bots where bot_id=$1 and lease_owner=$2
        and lease_expires_at>clock_timestamp() for update`,[this.botId,this.owner])).rows[0];
      if(!cursor)throw new Error('TELEGRAM_LEASE_LOST');
      if(Number(cursor.next_update_id)>update.update_id)return {callback:'',notice:null};
      const result=await this.accept(db,update);
      await db.query('update private.telegram_bots set next_update_id=$2 where bot_id=$1',[this.botId,update.update_id+1]);
      return result;
    });
    if(update.callback_query)await this.api.answer(update.callback_query.id,result.callback||undefined).catch(()=>{});
    if(result.notice)await this.api.send(result.notice.userId,result.notice.text).catch(()=>{});
  }

  private async accept(db:Sql,update:TelegramUpdate):Promise<{callback:string;notice:{userId:number;text:string}|null}>{
    const empty={callback:'',notice:null};
    const message=update.message??update.callback_query?.message;
    const from=update.message?.from??update.callback_query?.from;
    if(!message||message.chat.type!=='private'||!from||from.is_bot||message.chat.id!==from.id)return empty;
    const userId=from.id,text=update.message?.text?.trim()??'';
    let peer=(await db.query<{conversation_id:string;archived_at:Date|null}>(`select p.conversation_id,c.archived_at from private.telegram_peers p
      join public.conversations c on c.id=p.conversation_id where p.bot_id=$1 and p.user_id=$2 for update of p`,[this.botId,userId])).rows[0];
    const service=new DemoService(new ClinicRepository(db),this.model);
    if(!peer){
      if(!this.invited(text))return {callback:'Prueba privada: usá el enlace de invitación.',notice:/^\/start(?:@\w+)?(?:\s|$)/.test(text)?{userId,text:'Este bot está en prueba privada. Pedile el enlace de invitación a quien lo está configurando.'}:null};
      const chat=await service.create(undefined,`bot:${this.botId}:user:${userId}`);
      await db.query('insert into private.telegram_peers(bot_id,user_id,conversation_id) values ($1,$2,$3)',[this.botId,userId,chat.id]);
      // The Telegram display name/username is never treated as confirmed patient contact.
      await this.notice(db,chat.id,'Prueba de reservas: usá datos ficticios. Podés escribir qué día y franja horaria te convienen.');
      return empty;
    }
    if(update.message&&/^\/nuevo_paciente(?:@\w+)?(?:\s|$)/i.test(text)){
      if(userId!==this.testUserId)return {callback:'',notice:{userId,text:'Este comando solo está disponible para la cuenta autorizada de pruebas.'}};
      if(!/^\/nuevo_paciente(?:@\w+)?$/i.test(text))return {callback:'',notice:{userId,text:'Para empezar con una ficha vacía, escribí /nuevo_paciente sin agregar datos.'}};
      // The update cursor, archive, fresh identity and channel switch commit together.
      // Prior bookings keep their original patient; never match the new trial by phone.
      if(!peer.archived_at)await service.archive(peer.conversation_id,true);
      await db.query(`update private.telegram_outbox set status='cancelled' where bot_id=$1 and user_id=$2 and status in ('pending','sending')`,[this.botId,userId]);
      const next=await service.create(undefined,`bot:${this.botId}:user:${userId}:trial:${randomUUID()}`);
      await db.query('update private.telegram_peers set conversation_id=$3 where bot_id=$1 and user_id=$2',[this.botId,userId,next.id]);
      await this.notice(db,next.id,'Nueva prueba iniciada con una ficha vacía. La conversación anterior quedó archivada y sus reservas se conservan: podés cancelarlas desde la agenda. Podés pedir un turno indicando día y franja; para reservar te pediré nombre y teléfono.');
      return empty;
    }
    if(peer.archived_at){
      if(update.message&&/^\/start(?:@\w+)?(?:\s|$)/.test(text)){
        const next=await service.continueArchived(peer.conversation_id);
        await db.query('update private.telegram_peers set conversation_id=$3 where bot_id=$1 and user_id=$2',[this.botId,userId,next.id]);
        return empty;
      }
      return {callback:'Esta conversación está archivada. Escribí /start.',notice:{userId,text:'La conversación anterior está archivada. Escribí /start para continuar con tu misma ficha y tus reservas guardadas.'}};
    }
    const key=createHash('sha256').update(`telegram:${this.botId}:${update.update_id}`).digest('hex');
    const messageId=`${key.slice(0,8)}-${key.slice(8,12)}-4${key.slice(13,16)}-8${key.slice(17,20)}-${key.slice(20,32)}`;
    let input:ChatInput|null=null;
    if(update.callback_query){
      const match=/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(\d{1,2})$/.exec(update.callback_query.data??'');
      if(!match)return {callback:'Ese botón no es válido.',notice:null};
      const delivery=(await db.query<{choices:DemoChoice[];body:string}>(`select o.choices,m.body from private.telegram_outbox o join public.messages m on m.id=o.message_id
        where o.id=$1 and o.bot_id=$2 and o.user_id=$3 and m.conversation_id=$4 and o.status='sent' and o.telegram_message_id=$5
        and not exists(select 1 from public.messages newer where newer.conversation_id=m.conversation_id and newer.sequence>m.sequence)`,
        [match[1],this.botId,userId,peer.conversation_id,message.message_id])).rows[0];
      const choice=delivery?.choices[Number(match[2])];
      const current=await service.get(peer.conversation_id);
      if(!choice||!current.choices.some(c=>c.action===choice.action&&c.slotId===choice.slotId&&c.appointmentId===choice.appointmentId))return {callback:'Ese botón venció. Usá las últimas opciones o escribí qué turno buscás.',notice:null};
      input={messageId,action:choice.action,...(choice.slotId?{slotId:choice.slotId}:{}),...(choice.appointmentId?{appointmentId:choice.appointmentId}:{})};
    }else if(/^\/start(?:@\w+)?(?:\s|$)/.test(text)||/^\/help(?:@\w+)?$/.test(text)){
      await db.query('update public.conversations set pending_slot_id=null,pending_expires_at=null where id=$1',[peer.conversation_id]);
      await db.query(`update private.conversation_runtime set state=state||'{"cancellation":null,"rescheduling":null,"offered":[],"choices":[{"label":"Buscar horarios","action":"start"},{"label":"Cambiar un turno","action":"reschedule"},{"label":"Cancelar un turno","action":"cancel"},{"label":"Hablar con recepción","action":"human"}]}'::jsonb where conversation_id=$1`,[peer.conversation_id]);
      await this.notice(db,peer.conversation_id,'Podés reservar indicando día y franja, pedir cambiar un turno o cancelar una reserva. Antes de cancelar te pediré que elijas el turno y confirmes. Para hablar con alguien, escribí «recepción».'+(userId===this.testUserId?' Para empezar una prueba como paciente nuevo, escribí /nuevo_paciente.':''));
      return empty;
    }else if(!text||text.length>500){
      await this.notice(db,peer.conversation_id,'Por ahora puedo leer mensajes de texto de hasta 500 caracteres. Escribí qué día o franja horaria te conviene.');return empty;
    }else input={messageId,text};
    try{await service.send(peer.conversation_id,input);}
    catch(error){
      if(error instanceof DomainError&&error.code==='DEMO_LIMIT_REACHED')await this.notice(db,peer.conversation_id,'Esta conversación de prueba alcanzó su límite. Contactá con recepción para continuar.');
      else throw error;
    }
    return empty;
  }

  async syncOutbox(){
    await this.db.query(`insert into private.telegram_outbox(bot_id,user_id,message_id,choices)
      select p.bot_id,p.user_id,m.id,case when not exists(select 1 from public.messages newer where newer.conversation_id=m.conversation_id and newer.sequence>m.sequence)
        and c.status='active' then coalesce(r.state->'choices','[]'::jsonb) else '[]'::jsonb end
      from private.telegram_peers p join public.conversations c on c.id=p.conversation_id join public.messages m on m.conversation_id=c.id
      left join private.conversation_runtime r on r.conversation_id=c.id
      where p.bot_id=$1 and m.direction='outbound' and m.body is not null and c.archived_at is null
      order by m.sequence on conflict(bot_id,message_id) do nothing`,[this.botId]);
    await this.db.query(`update private.telegram_outbox o set status='cancelled' from public.messages m,public.conversations c
      where o.bot_id=$1 and o.message_id=m.id and m.conversation_id=c.id and c.archived_at is not null and o.status in ('pending','sending')`,[this.botId]);
  }
  async flush(){
    await this.acquire();await this.syncOutbox();
    // A bounded batch keeps polling responsive. Sending happens after database commits.
    for(let i=0;i<20;i++){
      const delivery=await this.db.transaction(async db=>{
        const row=(await db.query<Delivery>(`select o.*,m.body from private.telegram_outbox o join public.messages m on m.id=o.message_id
          where o.bot_id=$1 and o.status in ('pending','sending') and o.next_attempt_at<=clock_timestamp()
          and not exists(select 1 from private.telegram_outbox earlier join public.messages e on e.id=earlier.message_id
            where earlier.bot_id=o.bot_id and earlier.user_id=o.user_id and earlier.status in ('pending','sending') and e.sequence<m.sequence)
          order by m.sequence limit 1 for update of o`,[this.botId])).rows[0];
        if(row)await db.query("update private.telegram_outbox set status='sending',attempts=attempts+1,next_attempt_at=clock_timestamp()+interval '30 seconds' where id=$1",[row.id]);
        return row;
      });
      if(!delivery)return;
      try{
        const buttons=delivery.choices.map((choice,index)=>[{text:choice.label,callback_data:`${delivery.id}:${index}`}]);
        const sent=await this.api.send(Number(delivery.user_id),delivery.body,buttons);
        await this.db.query("update private.telegram_outbox set status='sent',telegram_message_id=$2,last_error=null where id=$1",[delivery.id,sent.message_id]);
      }catch(error){
        const failure=error instanceof TelegramError?error:new TelegramError(0);
        const terminal=failure.code===400||failure.code===403||delivery.attempts>=4;
        await this.db.query(`update private.telegram_outbox set status=$2,last_error=$3,next_attempt_at=clock_timestamp()+($4::int*interval '1 second') where id=$1`,
          [delivery.id,terminal?'failed':'pending',failure.message,Math.max(failure.retryAfter,Math.min(60,2**(delivery.attempts+1)))]);
        if(failure.code===401)throw failure;
      }
      await this.acquire();
    }
  }
  async run(signal:AbortSignal){
    try{
      while(!signal.aborted){
        try{
          await this.flush();const offset=await this.acquire();
          const updates=await this.api.updates(offset,signal);
          for(const update of updates){if(signal.aborted)break;await this.acquire();await this.handle(update);}
          if(!signal.aborted)await this.flush();
        }catch(error){
          if(signal.aborted)break;
          if(error instanceof TelegramError&&[401,409].includes(error.code))throw error;
          if(error instanceof Error&&/LEASE_LOST|ALREADY_RUNNING/.test(error.message))throw error;
          console.warn('Telegram: no se pudo completar una operación; se reintentará sin descartar el update.');
          await new Promise<void>(resolve=>{const timer=setTimeout(done,error instanceof TelegramError?Math.max(1000,error.retryAfter*1000):3000);function done(){clearTimeout(timer);signal.removeEventListener('abort',done);resolve();}signal.addEventListener('abort',done,{once:true});});
        }
      }
    }finally{await this.release();}
  }
}
