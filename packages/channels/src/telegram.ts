import { z } from 'zod';

const integer=z.number().int().safe();
const user=z.object({id:integer.positive(),is_bot:z.boolean().optional()});
const message=z.object({message_id:integer.positive(),chat:z.object({id:integer,type:z.string()}),from:user.optional(),text:z.string().optional()});
export const telegramUpdate=z.object({update_id:integer.nonnegative(),message:message.optional(),
  callback_query:z.object({id:z.string(),from:user,message:message.optional(),data:z.string().optional()}).optional()});
export type TelegramUpdate=z.infer<typeof telegramUpdate>;
export interface TelegramButton {text:string;callback_data:string}

export class TelegramError extends Error {
  constructor(readonly code:number,readonly retryAfter=5){super(`TELEGRAM_${code}`);}
}

/** Errors deliberately exclude request URLs: Telegram embeds the credential in the URL. */
export class TelegramApi {
  constructor(private readonly token:string,private readonly fetcher:typeof fetch=fetch){
    if(!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token))throw new Error('Invalid TELEGRAM_BOT_TOKEN format');
  }
  async call<T>(method:string,body:Record<string,unknown>,signal?:AbortSignal):Promise<T>{
    try{
      const timeout=AbortSignal.timeout(method==='getUpdates'?15_000:10_000);
      const response=await this.fetcher(`https://api.telegram.org/bot${this.token}/${method}`,{
        method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:signal?AbortSignal.any([signal,timeout]):timeout});
      const envelope=await response.json() as {ok:boolean;result:T;error_code?:number;parameters?:{retry_after?:number}};
      if(!response.ok||!envelope.ok)throw new TelegramError(envelope.error_code??response.status,envelope.parameters?.retry_after??5);
      return envelope.result;
    }catch(error){if(error instanceof TelegramError)throw error;throw new TelegramError(0);}
  }
  me(){return this.call<{id:number;username:string;is_bot:boolean}>('getMe',{});}
  webhook(){return this.call<{url:string}>('getWebhookInfo',{});}
  updates(offset:number,signal?:AbortSignal){return this.call<unknown[]>('getUpdates',{offset,limit:20,timeout:5,allowed_updates:['message','callback_query']},signal);}
  send(chatId:number,text:string,buttons:TelegramButton[][]=[]){
    return this.call<{message_id:number}>('sendMessage',{chat_id:chatId,text,
      ...(buttons.length?{reply_markup:{inline_keyboard:buttons}}:{})});
  }
  answer(id:string,text?:string){return this.call<boolean>('answerCallbackQuery',{callback_query_id:id,...(text?{text}:{})});}
}
