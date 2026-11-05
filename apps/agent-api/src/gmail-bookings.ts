import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {Sql} from '../../../packages/db/src/client.js';
import {GoogleApi,GoogleError,type GoogleTokens} from './google-api.js';

type Job={id:string;connection_id:string;appointment_id:string;generation:string;lease_id:string;attempts:number};
type Connection={id:string;generation:string;email:string;encrypted_tokens:string};
type Appointment={version:number;starts_at:Date|string;ends_at:Date|string;patient_name:string;phone:string|null;insurance:string|null;reported_reason:string|null;additional_info:string|null;therapist_name:string;time_zone:string};
type Vault={open:(value:string)=>GoogleTokens;seal:(value:GoogleTokens)=>string};
const date=(value:Date|string)=>value instanceof Date?value:new Date(value);
const encodedHeader=(value:string)=>{
  const chunks:string[]=[];let part='';
  for(const char of value){if(Buffer.byteLength(part+char,'utf8')>42){chunks.push(part);part='';}part+=char;}
  if(part)chunks.push(part);
  return chunks.map(chunk=>`=?UTF-8?B?${Buffer.from(chunk,'utf8').toString('base64')}?=`).join('\r\n ');
};

/** Durable new-booking mail, independent of Calendar delivery. Only sends to the authenticated owner's address. */
export class GmailBookings {
  private stopping=false;
  private timer:ReturnType<typeof setTimeout>|undefined;
  private running:Promise<void>|undefined;
  constructor(private readonly db:Sql,private readonly api:GoogleApi,private readonly vault:Vault){}
  async retry(connectionId:string){
    await this.db.transaction(async tx=>{
      await tx.query('update private.google_calendar_connections set gmail_error_code=null where id=$1 and gmail_send_enabled',[connectionId]);
      // Unknown deliveries are deliberately excluded: Gmail send has no idempotency key.
      await tx.query("update private.gmail_booking_notifications set status='pending',attempts=0,available_at=clock_timestamp(),error_code=null where connection_id=$1 and status='failed'",[connectionId]);
    });
  }
  private async live(job:Job){
    const connection=(await this.db.query<Connection>(`select c.id,c.generation,c.email,c.encrypted_tokens from private.google_calendar_connections c
      join public.therapists t on t.id=c.therapist_id and t.staff_user_id=c.staff_user_id
      join public.staff_members s on s.user_id=c.staff_user_id and s.active and s.role='therapist'
      join private.gmail_booking_notifications n on n.connection_id=c.id
      where c.id=$1 and c.generation=$2 and c.status='connected' and c.gmail_send_enabled and c.encrypted_tokens is not null
        and n.id=$3 and n.lease_id=$4 and n.lease_until>clock_timestamp() and n.status in ('processing','sending')`,[job.connection_id,job.generation,job.id,job.lease_id])).rows[0];
    if(!connection)throw new GoogleError('GOOGLE_CONNECTION_STOPPED');
    return connection;
  }
  private async access(job:Job,force=false){
    const connection=await this.live(job);let tokens=this.vault.open(connection.encrypted_tokens);
    if(force||tokens.expires_at*1000<Date.now()+60_000){
      const next=await this.api.tokens({grant_type:'refresh_token',refresh_token:tokens.refresh_token});
      tokens={access_token:next.access_token,refresh_token:next.refresh_token??tokens.refresh_token,expires_at:next.expires_at};
      await this.live(job);
      await this.db.query("update private.google_calendar_connections set encrypted_tokens=$3 where id=$1 and generation=$2 and status='connected'",[connection.id,connection.generation,this.vault.seal(tokens)]);
    }
    return tokens.access_token;
  }
  private raw(job:Job,email:string,appointment:Appointment){
    const address=z.email().parse(email);if(/[\r\n]/.test(address))throw new GoogleError('GMAIL_INVALID_SENDER');
    const when=new Intl.DateTimeFormat('es-AR',{timeZone:appointment.time_zone,weekday:'long',day:'numeric',month:'long',year:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(date(appointment.starts_at));
    const end=new Intl.DateTimeFormat('es-AR',{timeZone:appointment.time_zone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(date(appointment.ends_at));
    const text=['Tenés un nuevo turno confirmado en Nexo.',`Día y hora: ${when}, hasta las ${end}.`,`Zona horaria: ${appointment.time_zone}`,`Profesional: ${appointment.therapist_name}`,`Paciente: ${appointment.patient_name}`,
      appointment.phone?`Teléfono: ${appointment.phone}`:null,appointment.insurance?`Seguro de salud: ${appointment.insurance}`:null,
      appointment.reported_reason?`Diagnóstico o motivo referido por el paciente (no verificado): ${appointment.reported_reason}`:null,
      appointment.additional_info?`Información adicional: ${appointment.additional_info}`:null,
      'Consultá la agenda de Nexo para ver los datos actuales, reprogramar o cancelar.'].filter((line):line is string=>line!==null).join('\n\n');
    const subject=`Nuevo turno en Nexo - ${when}`;
    const body=Buffer.from(text,'utf8').toString('base64').match(/.{1,76}/g)!.join('\r\n');
    return Buffer.from([`From: Nexo <${address}>`,`To: <${address}>`,`Subject: ${encodedHeader(subject)}`,
      `Message-ID: <nexo-booking-${job.id}@notifications.nexo.invalid>`,`Date: ${new Date().toUTCString()}`,'MIME-Version: 1.0','Content-Type: text/plain; charset=UTF-8','Content-Transfer-Encoding: base64','',body].join('\r\n'),'utf8').toString('base64url');
  }
  private async send(job:Job){
    let token=await this.access(job);
    const connection=await this.live(job);
    const appointment=(await this.db.query<Appointment>(`select a.version,a.starts_at,a.ends_at,p.name as patient_name,p.phone,p.insurance,p.reported_reason,p.additional_info,t.name as therapist_name,c.time_zone
      from public.appointments a join public.patients p on p.id=a.patient_id join public.therapists t on t.id=a.therapist_id cross join public.clinics c
      join private.google_calendar_connections g on g.therapist_id=a.therapist_id where a.id=$1 and g.id=$2 and a.status='confirmed' and a.starts_at>now()`,[job.appointment_id,job.connection_id])).rows[0];
    if(!appointment){await this.db.query("update private.gmail_booking_notifications set status='cancelled',lease_id=null,lease_until=null where id=$1 and lease_id=$2",[job.id,job.lease_id]);return;}
    const raw=this.raw(job,connection.email,appointment);
    await this.live(job);
    // Persist intent before external I/O. A crash after this point must not resend blindly.
    const sending=await this.db.query(`update private.gmail_booking_notifications n set status='sending' where id=$1 and lease_id=$2 and status='processing'
      and exists(select 1 from public.appointments a,private.google_calendar_connections c where a.id=n.appointment_id and c.id=n.connection_id
        and a.status='confirmed' and a.starts_at>now() and a.therapist_id=c.therapist_id and a.version=$3 and c.generation=$4 and c.status='connected' and c.gmail_send_enabled) returning id`,[job.id,job.lease_id,appointment.version,job.generation]);
    if(!sending.rows.length)throw new GoogleError('GOOGLE_CONNECTION_STOPPED');
    let remote:{id:string};
    try{remote=await this.api.sendMail(token,raw);}
    catch(error){
      if(!(error instanceof GoogleError)||error.status!==401)throw error;
      token=await this.access(job,true);await this.live(job);remote=await this.api.sendMail(token,raw);
    }
    await this.db.transaction(async tx=>{
      await tx.query("update private.gmail_booking_notifications set status='sent',remote_message_id=$3,sent_at=clock_timestamp(),error_code=null,lease_id=null,lease_until=null where id=$1 and lease_id=$2",[job.id,job.lease_id,remote.id]);
      await tx.query("update private.google_calendar_connections set gmail_last_sent_at=clock_timestamp(),gmail_error_code=null where id=$1 and generation=$2",[job.connection_id,job.generation]);
    });
  }
  private async work(){
    // A server restart can leave an accepted send without a local acknowledgement.
    await this.db.query("update private.gmail_booking_notifications set status='unknown',error_code='GMAIL_DELIVERY_UNKNOWN',lease_id=null,lease_until=null where status='sending' and lease_until<=clock_timestamp()");
    await this.db.query("update private.gmail_booking_notifications set status='pending',lease_id=null,lease_until=null where status='processing' and lease_until<=clock_timestamp()");
    for(let count=0;count<3&&!this.stopping;count++){
      const job=await this.db.transaction(async tx=>{
        const next=(await tx.query<Job>(`select n.id,n.connection_id,n.appointment_id,n.attempts,c.generation from private.gmail_booking_notifications n
          join private.google_calendar_connections c on c.id=n.connection_id and c.status='connected' and c.gmail_send_enabled and c.gmail_error_code is null
          join public.therapists t on t.id=c.therapist_id and t.staff_user_id=c.staff_user_id
          join public.staff_members s on s.user_id=c.staff_user_id and s.active and s.role='therapist'
          where n.status='pending' and n.available_at<=clock_timestamp() order by n.available_at,n.id limit 1 for update of n skip locked`)).rows[0];
        if(!next)return null;next.lease_id=randomUUID();
        await tx.query("update private.gmail_booking_notifications set status='processing',lease_id=$2,lease_until=clock_timestamp()+interval '2 minutes' where id=$1",[next.id,next.lease_id]);return next;
      });
      if(!job)break;
      try{await this.send(job);}
      catch(error){
        const failure=error instanceof GoogleError?error:new GoogleError('GMAIL_LOCAL_ERROR');
        const state=(await this.db.query<{status:string}>('select status from private.gmail_booking_notifications where id=$1 and lease_id=$2',[job.id,job.lease_id])).rows[0];
        if(!state)continue;
        const blocked=['GMAIL_PERMISSION','GMAIL_API_DISABLED','GOOGLE_RECONNECT','GOOGLE_AUTH_FAILED'].includes(failure.code);
        // Only definitive non-delivery responses can be retried; timeout/5xx remain uncertain.
        const unknown=state.status==='sending'&&(failure.status===0||failure.status>=500)&&!['GOOGLE_CONNECTION_STOPPED','GOOGLE_AUTH_FAILED','GOOGLE_RECONNECT'].includes(failure.code);
        const transient=failure.code==='GMAIL_RATE_LIMIT'||failure.code==='GOOGLE_TEMPORARY'||failure.code==='GOOGLE_CONNECTION_STOPPED';
        await this.db.transaction(async tx=>{
          await tx.query(`update private.gmail_booking_notifications set status=$3,error_code=$4,attempts=attempts+1,available_at=clock_timestamp()+($5::int*interval '1 second'),lease_id=null,lease_until=null where id=$1 and lease_id=$2`,
            [job.id,job.lease_id,unknown?'unknown':blocked||transient&&job.attempts<7?'pending':'failed',unknown?'GMAIL_DELIVERY_UNKNOWN':failure.code,Math.max(failure.retryAfter,Math.min(900,2**(job.attempts+1)*5))]);
          if(blocked)await tx.query(`update private.google_calendar_connections set gmail_error_code=$3,gmail_send_enabled=case when $3 in ('GMAIL_PERMISSION','GOOGLE_RECONNECT') then false else gmail_send_enabled end where id=$1 and generation=$2`,[job.connection_id,job.generation,failure.code]);
        });
      }
    }
  }
  start(){
    const tick=async()=>{if(this.stopping)return;this.running=this.work();try{await this.running;}catch{console.error('Gmail: no se pudo completar el ciclo de avisos; se reintentará.');}finally{this.running=undefined;if(!this.stopping){this.timer=setTimeout(()=>void tick(),3000);this.timer.unref();}}};
    this.timer=setTimeout(()=>void tick(),1000);this.timer.unref();
  }
  async stop(){this.stopping=true;clearTimeout(this.timer);await this.running?.catch(()=>{});}
}
