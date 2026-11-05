import { createCipheriv,createDecipheriv,createHash,randomBytes,randomUUID } from 'node:crypto';
import type { FastifyInstance,FastifyReply,FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Sql } from '../../../packages/db/src/client.js';
import { DomainError } from '../../../packages/db/src/repository.js';
import { GoogleApi,GoogleError,type GoogleTokens } from './google-api.js';

const base='/v1/integrations/google-calendar',scope='https://www.googleapis.com/auth/calendar.app.created';
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const cookie=(request:FastifyRequest,name:string)=>request.headers.cookie?.split(';').map(s=>s.trim()).find(s=>s.startsWith(`${name}=`))?.slice(name.length+1)??'';
const time=(value:unknown)=>value instanceof Date?value.toISOString():new Date(String(value)).toISOString();
const html=(value:string)=>value.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));
type Connection={id:string;therapist_id:string;staff_user_id:string;google_sub:string;email:string;calendar_id:string|null;encrypted_tokens:string|null;generation:string;status:string};
type Job={connection_id:string;appointment_id:string;revision:string|number;epoch:number;remote_event_id:string|null;lease_id:string;attempts:number;generation:string;calendar_id:string;therapist_id:string};
type Options={origin:string;encryptionKey:string;clientId:string;clientSecret:string};

/** Each therapist grants access only to secondary calendars created by Nexo. */
export class GoogleCalendar {
  readonly callbackUrl:string;
  readonly configured:boolean;
  private readonly key:Buffer;
  private readonly api:GoogleApi;
  private timer:ReturnType<typeof setTimeout>|undefined;
  private running:Promise<void>|undefined;
  private stopping=false;
  private reconciledAt=0;
  private readonly notificationPolicies=new Map<string,string>();
  constructor(private readonly db:Sql,private readonly options:Options){
    this.callbackUrl=new URL(`${base}/callback`,options.origin).toString();
    this.key=createHash('sha256').update('nexo-google-calendar-v1').update(Buffer.from(options.encryptionKey,'base64url')).digest();
    this.configured=Boolean(options.clientId&&options.clientSecret);
    this.api=new GoogleApi(options.clientId,options.clientSecret);
  }
  private seal(value:unknown){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key,iv);cipher.setAAD(Buffer.from('nexo-calendar'));const body=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),body]).toString('base64url');}
  private open<T>(value:string):T{const bytes=Buffer.from(value,'base64url'),cipher=createDecipheriv('aes-256-gcm',this.key,bytes.subarray(0,12));cipher.setAAD(Buffer.from('nexo-calendar'));cipher.setAuthTag(bytes.subarray(12,28));return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)),cipher.final()]).toString('utf8')) as T;}
  private owner(request:FastifyRequest){const user=request.staff;if(!user||user.role!=='therapist'||!user.therapistId)throw new DomainError('FORBIDDEN',403);return {...user,therapistId:user.therapistId};}
  private browserCookie(reply:FastifyReply,value:string){reply.header('Set-Cookie',`nexo_google_oauth=${value}; Path=${base}/callback; HttpOnly; SameSite=Lax; Max-Age=${value?600:0}${this.options.origin.startsWith('https:')?'; Secure':''}`);}
  private async current(request:FastifyRequest){const user=this.owner(request);return (await this.db.query<Connection>(`select * from private.google_calendar_connections where therapist_id=$1 and staff_user_id=$2 and status<>'disconnected'`,[user.therapistId,user.id])).rows[0];}
  register(app:FastifyInstance){
    app.get(`${base}/status`,async request=>{
      if(request.staff?.role!=='therapist')return {eligible:false,configured:this.configured};
      const connection=await this.current(request);
      if(!connection)return {eligible:true,configured:this.configured,status:'disconnected'};
      const counts=(await this.db.query(`select count(*) filter(where status in ('pending','processing'))::int as pending,count(*) filter(where status='failed')::int as failed from private.google_calendar_jobs where connection_id=$1`,[connection.id])).rows[0];
      const extra=(await this.db.query('select last_synced_at,error_code from private.google_calendar_connections where id=$1',[connection.id])).rows[0];
      return {eligible:true,configured:this.configured,status:connection.status,email:connection.email,calendarName:'Nexo · Turnos',lastSyncedAt:extra?.last_synced_at,error:extra?.error_code,pending:counts?.pending??0,failed:counts?.failed??0};
    });
    app.post(`${base}/connect`,async(request,reply)=>{
      const user=this.owner(request);if(!this.configured)throw new DomainError('GOOGLE_NOT_CONFIGURED',409);
      const session=hash(cookie(request,'nexo_staff')),state=randomBytes(32).toString('base64url'),browser=randomBytes(32).toString('base64url'),verifier=randomBytes(32).toString('base64url');
      await this.db.transaction(async db=>{
        const row=(await db.query('select id_hash from private.staff_sessions where id_hash=$1 and user_id=$2 and expires_at>now()',[session,user.id])).rows[0];
        if(!row)throw new DomainError('UNAUTHORIZED',401);
        await db.query('delete from private.google_calendar_oauth where staff_user_id=$1 or expires_at<=now()',[user.id]);
        await db.query('insert into private.google_calendar_oauth(state_hash,browser_hash,session_hash,staff_user_id,therapist_id,encrypted_verifier) values ($1,$2,$3,$4,$5,$6)',[hash(state),hash(browser),session,user.id,user.therapistId,this.seal(verifier)]);
      });
      this.browserCookie(reply,browser);
      const url=new URL('https://accounts.google.com/o/oauth2/v2/auth');
      url.search=new URLSearchParams({client_id:this.options.clientId,redirect_uri:this.callbackUrl,response_type:'code',scope:`openid email ${scope}`,access_type:'offline',prompt:'consent select_account',state,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'}).toString();
      return {url:url.toString()};
    });
    app.get(`${base}/callback`,async(request,reply)=>{
      reply.header('Referrer-Policy','no-referrer');this.browserCookie(reply,'');
      let result='failed';
      try{
        if(!this.configured)throw new GoogleError('GOOGLE_NOT_CONFIGURED');
        const query=z.object({state:z.string().length(43),code:z.string().min(1).max(4096).optional(),error:z.string().max(150).optional()}).parse(request.query);
        const browser=cookie(request,'nexo_google_oauth');
        if(!/^[A-Za-z0-9_-]{43}$/.test(browser))throw new GoogleError('GOOGLE_STATE_EXPIRED');
        // Callback cookies use SameSite=Lax; the original staff session is rechecked in the database.
        const attempt=(await this.db.query<{staff_user_id:string;therapist_id:string;encrypted_verifier:string}>(`delete from private.google_calendar_oauth o where state_hash=$1 and browser_hash=$2 and expires_at>now()
          and exists(select 1 from private.staff_sessions s join public.staff_members m on m.user_id=s.user_id join public.therapists t on t.staff_user_id=m.user_id
            where s.id_hash=o.session_hash and s.expires_at>now() and m.user_id=o.staff_user_id and m.active and m.role='therapist' and t.id=o.therapist_id)
          returning staff_user_id,therapist_id,encrypted_verifier`,[hash(query.state),hash(browser)])).rows[0];
        if(!attempt)throw new GoogleError('GOOGLE_STATE_EXPIRED');
        if(query.error){result='denied';}else{
          if(!query.code)throw new GoogleError('GOOGLE_AUTH_FAILED');
          const tokens=await this.api.tokens({grant_type:'authorization_code',code:query.code,redirect_uri:this.callbackUrl,code_verifier:this.open<string>(attempt.encrypted_verifier)});
          if(!tokens.scope.split(' ').includes(scope))throw new GoogleError('GOOGLE_PERMISSION');
          const identity=await this.api.identity(tokens.access_token);
          await this.link(attempt,identity,tokens);result='connected';
        }
      }catch(error){if(error instanceof GoogleError)result=error.code==='GOOGLE_STATE_EXPIRED'?'expired':error.code==='GOOGLE_ACCOUNT_CHANGED'?'account_changed':error.code==='GOOGLE_ACCOUNT_IN_USE'?'account_in_use':'failed';}
      return reply.redirect(`/?googleCalendar=${result}#profile`);
    });
    app.post(`${base}/sync`,async request=>{
      const connection=await this.current(request);if(!connection||connection.status!=='connected')throw new DomainError('GOOGLE_RECONNECT',409);
      await this.enqueue(connection.id);
      return {ok:true};
    });
    app.post(`${base}/disconnect`,async request=>{
      const connection=await this.current(request);if(!connection)return {ok:true};
      await this.db.transaction(async db=>{
        await db.query("update private.google_calendar_connections set status='disconnected',encrypted_tokens=null,generation=gen_random_uuid(),error_code=null where id=$1",[connection.id]);
        await db.query('delete from private.google_calendar_oauth where therapist_id=$1',[connection.therapist_id]);
      });
      if(connection.encrypted_tokens){try{await this.api.revoke(this.open<GoogleTokens>(connection.encrypted_tokens).refresh_token);}catch{/* Do not expose cryptographic or provider details. */}}
      return {ok:true};
    });
  }
  private async link(owner:{staff_user_id:string;therapist_id:string},identity:{sub:string;email:string},tokens:{access_token:string;refresh_token:string|undefined;expires_at:number}){
    const generation=randomUUID();
    const connection=await this.db.transaction(async db=>{
      const therapist=(await db.query(`select t.id from public.therapists t join public.staff_members m on m.user_id=t.staff_user_id where t.id=$1 and m.user_id=$2 and m.active and m.role='therapist' for update of t`,[owner.therapist_id,owner.staff_user_id])).rows[0];
      if(!therapist)throw new GoogleError('GOOGLE_AUTH_FAILED');
      const active=(await db.query<Connection>("select * from private.google_calendar_connections where therapist_id=$1 and status<>'disconnected' for update",[owner.therapist_id])).rows[0];
      if(active&&active.google_sub!==identity.sub)throw new GoogleError('GOOGLE_ACCOUNT_CHANGED');
      if((await db.query("select id from private.google_calendar_connections where google_sub=$1 and therapist_id<>$2 and status<>'disconnected'",[identity.sub,owner.therapist_id])).rows.length)throw new GoogleError('GOOGLE_ACCOUNT_IN_USE');
      const previous=(await db.query<Connection>('select * from private.google_calendar_connections where therapist_id=$1 and google_sub=$2 for update',[owner.therapist_id,identity.sub])).rows[0];
      if(previous&&previous.staff_user_id!==owner.staff_user_id)throw new GoogleError('GOOGLE_ACCOUNT_CHANGED');
      let refresh=tokens.refresh_token;
      if(!refresh&&previous?.encrypted_tokens)refresh=this.open<GoogleTokens>(previous.encrypted_tokens).refresh_token;
      if(!refresh)throw new GoogleError('GOOGLE_RECONNECT');
      return (await db.query<Connection>(`insert into private.google_calendar_connections(therapist_id,staff_user_id,google_sub,email,encrypted_tokens,status,generation)
        values ($1,$2,$3,$4,$5,'reauth_required',$6) on conflict(therapist_id,google_sub) do update set email=excluded.email,encrypted_tokens=excluded.encrypted_tokens,status='reauth_required',generation=excluded.generation,error_code=null returning *`,
      [owner.therapist_id,owner.staff_user_id,identity.sub,identity.email,this.seal({...tokens,refresh_token:refresh}),generation])).rows[0]!;
    });
    try{
      let calendarId=connection.calendar_id;
      if(calendarId){try{await this.api.request(tokens.access_token,`/calendars/${encodeURIComponent(calendarId)}`);}catch(error){if(error instanceof GoogleError&&error.status===404)calendarId=null;else throw error;}}
      if(!calendarId){
        const clinic=(await this.db.query<{time_zone:string}>('select time_zone from public.clinics')).rows[0]!;
        const calendar=await this.api.request<{id:string}>(tokens.access_token,'/calendars','POST',{summary:'Nexo · Turnos',description:'Turnos gestionados desde Nexo. Los cambios se realizan en Nexo.',timeZone:clinic.time_zone});
        if(!calendar.id)throw new GoogleError('GOOGLE_TEMPORARY');calendarId=calendar.id;
      }
      await this.configureNotifications(<T>(path:string,method='GET',body?:unknown)=>this.api.request<T>(tokens.access_token,path,method,body),calendarId);
      await this.db.transaction(async db=>{
        const updated=await db.query(`update private.google_calendar_connections c set calendar_id=$2,status='connected',error_code=null where id=$1 and generation=$3
          and exists(select 1 from public.therapists t join public.staff_members s on s.user_id=t.staff_user_id where t.id=c.therapist_id and s.user_id=c.staff_user_id and s.active and s.role='therapist') returning id`,[connection.id,calendarId,generation]);
        if(!updated.rows.length)throw new GoogleError('GOOGLE_AUTH_FAILED');
        if(calendarId!==connection.calendar_id)await db.query('update private.google_calendar_jobs set remote_event_id=null,epoch=epoch+1 where connection_id=$1',[connection.id]);
      });
      this.notificationPolicies.set(connection.id,`${generation}:${calendarId}`);
      await this.enqueue(connection.id);
    }catch(error){await this.db.query("update private.google_calendar_connections set error_code='GOOGLE_RECONNECT' where id=$1 and generation=$2",[connection.id,generation]);throw error;}
  }
  private async configureNotifications(call:<T>(path:string,method?:string,body?:unknown)=>Promise<T>,calendarId:string){
    const path=`/users/me/calendarList/${encodeURIComponent(calendarId)}`;
    const calendar=await call<{notificationSettings?:{notifications?:{type:string;method:string}[]}}>(path);
    const notifications=calendar.notificationSettings?.notifications??[];
    // Keep the therapist's other calendar notifications and reminder preferences.
    if(!notifications.some(item=>item.type==='eventCreation'&&item.method==='email')){
      await call(path,'PATCH',{notificationSettings:{notifications:[...notifications,{type:'eventCreation',method:'email'}]}});
    }
  }
  private async enqueue(connectionId:string,manual=true){
    await this.db.query(`insert into private.google_calendar_jobs(connection_id,appointment_id)
      select c.id,a.id from private.google_calendar_connections c join public.appointments a on a.therapist_id=c.therapist_id
      where c.id=$1 and c.status='connected' and a.status='confirmed' and a.starts_at>now()
      on conflict(connection_id,appointment_id) do update set revision=private.google_calendar_jobs.revision+1,status=case when private.google_calendar_jobs.lease_until>clock_timestamp() then 'processing' else 'pending' end,attempts=0,available_at=clock_timestamp(),error_code=null
      where $2::boolean or private.google_calendar_jobs.status='sent'`,[connectionId,manual]);
    await this.db.query(`update private.google_calendar_jobs j set revision=j.revision+1,status=case when j.lease_until>clock_timestamp() then 'processing' else 'pending' end,attempts=0,available_at=clock_timestamp(),error_code=null
      from public.appointments a,private.google_calendar_connections c
      where j.connection_id=$1 and c.id=j.connection_id and a.id=j.appointment_id and j.remote_event_id is not null and ($2::boolean or j.status='sent')
        and (a.status<>'confirmed' or a.therapist_id<>c.therapist_id or a.starts_at>now())`,[connectionId,manual]);
  }
  private async live(job:Job){
    const connection=(await this.db.query<Connection>(`select c.* from private.google_calendar_connections c join public.therapists t on t.id=c.therapist_id and t.staff_user_id=c.staff_user_id
      join public.staff_members s on s.user_id=c.staff_user_id and s.active and s.role='therapist'
      where c.id=$1 and c.generation=$2 and c.status='connected' and exists(select 1 from private.google_calendar_jobs j where j.connection_id=c.id and j.appointment_id=$3 and j.lease_id=$4 and j.lease_until>clock_timestamp())`,[job.connection_id,job.generation,job.appointment_id,job.lease_id])).rows[0];
    if(!connection?.encrypted_tokens)throw new GoogleError('GOOGLE_CONNECTION_STOPPED');return connection;
  }
  private async access(job:Job){
    const connection=await this.live(job);let tokens=this.open<GoogleTokens>(connection.encrypted_tokens!);
    if(tokens.expires_at*1000<Date.now()+60_000){
      const next=await this.api.tokens({grant_type:'refresh_token',refresh_token:tokens.refresh_token});
      tokens={access_token:next.access_token,refresh_token:next.refresh_token??tokens.refresh_token,expires_at:next.expires_at};
      await this.db.query("update private.google_calendar_connections set encrypted_tokens=$3 where id=$1 and generation=$2 and status='connected'",[connection.id,connection.generation,this.seal(tokens)]);
    }
    return tokens.access_token;
  }
  private async synchronize(job:Job){
    const token=await this.access(job);
    const call=async<T>(path:string,method='GET',body?:unknown)=>{await this.live(job);return this.api.request<T>(token,path,method,body);};
    const policy=`${job.generation}:${job.calendar_id}`;
    if(this.notificationPolicies.get(job.connection_id)!==policy){
      await this.configureNotifications(call,job.calendar_id);
      this.notificationPolicies.set(job.connection_id,policy);
    }
    const appointment=(await this.db.query<{status:string;therapist_id:string;starts_at:Date|string;ends_at:Date|string;patient_name:string;phone:string|null;insurance:string|null;reported_reason:string|null;additional_info:string|null;therapist_name:string;time_zone:string}>(`select a.status,a.therapist_id,a.starts_at,a.ends_at,p.name as patient_name,p.phone,p.insurance,p.reported_reason,p.additional_info,t.name as therapist_name,c.time_zone
      from public.appointments a join public.patients p on p.id=a.patient_id join public.therapists t on t.id=a.therapist_id cross join public.clinics c where a.id=$1`,[job.appointment_id])).rows[0];
    const confirmed=appointment?.status==='confirmed'&&appointment.therapist_id===job.therapist_id;
    const root=`/calendars/${encodeURIComponent(job.calendar_id)}/events`;
    const target=confirmed?'n'+hash(`${job.connection_id}:${job.appointment_id}:${job.epoch}`):null;
    if(job.remote_event_id&&job.remote_event_id!==target){
      try{await call(`${root}/${encodeURIComponent(job.remote_event_id)}?sendUpdates=none`,'DELETE');}
      catch(error){if(!(error instanceof GoogleError)||![404,410].includes(error.status))throw error;}
      await this.db.query(`update private.google_calendar_jobs j set remote_event_id=null where connection_id=$1 and appointment_id=$2 and lease_id=$3
        and exists(select 1 from private.google_calendar_connections c where c.id=j.connection_id and c.generation=$4 and c.status='connected')`,[job.connection_id,job.appointment_id,job.lease_id,job.generation]);
    }
    if(target&&appointment){
      // Record the deterministic target before I/O so an uncertain insert can be retried safely.
      await this.live(job);
      const mapped=await this.db.query(`update private.google_calendar_jobs j set remote_event_id=$4 where connection_id=$1 and appointment_id=$2 and lease_id=$3
        and exists(select 1 from private.google_calendar_connections c where c.id=j.connection_id and c.generation=$5 and c.status='connected') returning appointment_id`,[job.connection_id,job.appointment_id,job.lease_id,target,job.generation]);
      if(!mapped.rows.length)throw new GoogleError('GOOGLE_CONNECTION_STOPPED');
      const when=new Intl.DateTimeFormat('es-AR',{timeZone:appointment.time_zone,weekday:'long',day:'numeric',month:'long',year:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(time(appointment.starts_at)));
      const description=[`Paciente: ${appointment.patient_name}`,`Turno: ${when} (${appointment.time_zone})`,`Profesional: ${appointment.therapist_name}`,
        appointment.phone?`Teléfono: ${appointment.phone}`:null,appointment.insurance?`Seguro de salud: ${appointment.insurance}`:null,
        appointment.reported_reason?`Diagnóstico o motivo referido por el paciente (no verificado): ${appointment.reported_reason}`:null,
        appointment.additional_info?`Información adicional: ${appointment.additional_info}`:null,
        'Los cambios y cancelaciones se realizan en Nexo.'].filter((line):line is string=>line!==null).map(line=>html(line).replace(/\r?\n/g,'<br>')).join('<br>');
      const body={summary:`Fisio · ${appointment.patient_name}`,description,start:{dateTime:time(appointment.starts_at),timeZone:appointment.time_zone},end:{dateTime:time(appointment.ends_at),timeZone:appointment.time_zone},visibility:'private',transparency:'opaque',reminders:{useDefault:false,overrides:[{method:'popup',minutes:30}]},extendedProperties:{private:{nexoAppointmentId:job.appointment_id}}};
      try{await call(`${root}/${target}?sendUpdates=none`,'PUT',body);}
      catch(error){
        if(!(error instanceof GoogleError)||![404,410].includes(error.status))throw error;
        try{await call(root+'?sendUpdates=none','POST',{id:target,...body});}
        catch(insertError){
          if(!(insertError instanceof GoogleError)||![409,410].includes(insertError.status))throw insertError;
          let deleted=false;
          try{deleted=(await call<{status:string}>(`${root}/${target}`)).status==='cancelled';}
          catch(readError){if(readError instanceof GoogleError&&[404,410].includes(readError.status))deleted=true;else throw readError;}
          if(!deleted)await call(`${root}/${target}?sendUpdates=none`,'PUT',body);
          else{
            await this.db.query(`update private.google_calendar_jobs j set epoch=epoch+1,revision=revision+1,remote_event_id=null where connection_id=$1 and appointment_id=$2 and lease_id=$3
              and exists(select 1 from private.google_calendar_connections c where c.id=j.connection_id and c.generation=$4 and c.status='connected')`,[job.connection_id,job.appointment_id,job.lease_id,job.generation]);
            throw new GoogleError('GOOGLE_TEMPORARY');
          }
        }
      }
    }
  }
  private async work(){
    for(let count=0;count<5&&!this.stopping;count++){
      const job=await this.db.transaction(async db=>{
        const row=(await db.query<Job>(`select j.*,c.generation,c.calendar_id,c.therapist_id from private.google_calendar_jobs j
          join private.google_calendar_connections c on c.id=j.connection_id and c.status='connected' and c.calendar_id is not null
          join public.therapists t on t.id=c.therapist_id and t.staff_user_id=c.staff_user_id join public.staff_members s on s.user_id=c.staff_user_id and s.active and s.role='therapist'
          where j.status in ('pending','processing') and j.available_at<=clock_timestamp() and (j.lease_until is null or j.lease_until<=clock_timestamp()) order by j.available_at limit 1 for update of j skip locked`)).rows[0];
        if(!row)return null;
        row.lease_id=randomUUID();await db.query("update private.google_calendar_jobs set status='processing',lease_id=$3,lease_until=clock_timestamp()+interval '5 minutes' where connection_id=$1 and appointment_id=$2",[row.connection_id,row.appointment_id,row.lease_id]);return row;
      });
      if(!job)break;
      try{
        await this.synchronize(job);
        await this.db.query(`update private.google_calendar_jobs j set synced_revision=$4,status=case when revision=$4 then 'sent' else 'pending' end,attempts=0,error_code=null,lease_id=null,lease_until=null,available_at=clock_timestamp()
          where connection_id=$1 and appointment_id=$2 and lease_id=$3 and exists(select 1 from private.google_calendar_connections c where c.id=j.connection_id and c.generation=$5 and c.status='connected')`,[job.connection_id,job.appointment_id,job.lease_id,job.revision,job.generation]);
        await this.db.query("update private.google_calendar_connections set last_synced_at=clock_timestamp(),error_code=null where id=$1 and generation=$2 and status='connected'",[job.connection_id,job.generation]);
      }catch(error){
        const failure=error instanceof GoogleError?error:new GoogleError('GOOGLE_TEMPORARY');
        const reconnect=['GOOGLE_RECONNECT','GOOGLE_PERMISSION'].includes(failure.code);
        if(reconnect)await this.db.query("update private.google_calendar_connections set status='reauth_required',error_code=$3 where id=$1 and generation=$2 and status='connected'",[job.connection_id,job.generation,failure.code]);
        await this.db.query(`update private.google_calendar_jobs set status=case when revision<>$4 then 'pending' when attempts>=7 then 'failed' else 'pending' end,
          attempts=case when revision<>$4 then 0 else attempts+1 end,error_code=$5,available_at=clock_timestamp()+($6::int*interval '1 second'),lease_id=null,lease_until=null
          where connection_id=$1 and appointment_id=$2 and lease_id=$3`,[job.connection_id,job.appointment_id,job.lease_id,job.revision,failure.code,Math.max(failure.retryAfter,Math.min(900,2**(job.attempts+1)*5))]);
      }finally{
        // A reconnection may supersede the generation while a request was in flight.
        await this.db.query("update private.google_calendar_jobs set status='pending',lease_id=null,lease_until=null where connection_id=$1 and appointment_id=$2 and lease_id=$3",[job.connection_id,job.appointment_id,job.lease_id]);
      }
    }
  }
  start(){
    if(!this.configured)return;
    const tick=async()=>{
      if(this.stopping)return;
      this.running=(async()=>{
        if(Date.now()-this.reconciledAt>15*60_000){
          const connections=(await this.db.query<{id:string}>("select id from private.google_calendar_connections where status='connected'")).rows;
          for(const connection of connections)await this.enqueue(connection.id,false);
          this.reconciledAt=Date.now();
        }
        await this.work();
      })();
      try{await this.running;}catch{console.error('Google Calendar: no se pudo completar el ciclo; se reintentará.');}
      finally{this.running=undefined;if(!this.stopping){this.timer=setTimeout(()=>void tick(),5000);this.timer.unref();}}
    };
    this.timer=setTimeout(()=>void tick(),1000);this.timer.unref();
  }
  async stop(){this.stopping=true;clearTimeout(this.timer);await this.running?.catch(()=>{});}
}
