import { Temporal } from '@js-temporal/polyfill';
import { randomUUID } from 'node:crypto';
import { generateSlots, type WorkingRule } from '../../core/src/availability.js';
import type { Sql } from './client.js';
import { patientDetailsInput, patientSummary, type PatientDetails, type PatientPatch } from '../../core/src/patient.js';

export class DomainError extends Error {
  constructor(public readonly code: string, public readonly status: number) { super(code); }
}
const statuses: Record<string, number> = {
  CONVERSATION_NOT_FOUND: 404, SLOT_NOT_FOUND: 404, THERAPIST_NOT_FOUND: 404,
  AGENT_PAUSED: 409, CONFIRMATION_REQUIRED: 409, SLOT_UNAVAILABLE: 409,
  IDEMPOTENCY_CONFLICT: 409, INVALID_REQUEST_KEY: 400, PATIENT_DETAILS_REQUIRED:409,
};
export function translateDatabaseError(error: unknown): never {
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    if (statuses[error.message]) throw new DomainError(error.message, statuses[error.message]!);
    if ('code' in error && (error.code === '23P01' || error.code === '23505')) throw new DomainError('SLOT_UNAVAILABLE', 409);
  }
  throw error;
}
const iso = (value: unknown) => value instanceof Date ? value.toISOString() : String(value);

export class ClinicRepository {
  constructor(readonly db: Sql) {}

  async getUpcomingAppointments(conversationId:string) {
    return (await this.db.query<{id:string;slot_id:string;therapist_id:string;therapist_name:string;starts_at:Date|string;ends_at:Date|string;version:number}>(`select a.id,a.slot_id,a.therapist_id,t.name as therapist_name,a.starts_at,a.ends_at,a.version
      from public.appointments a join public.therapists t on t.id=a.therapist_id where a.conversation_id=$1 and a.status='confirmed' and a.starts_at>now() order by a.starts_at`,[conversationId])).rows;
  }

  async rescheduleAppointment(appointmentId:string,slotId:string,key:string,options:{expectedVersion:number;confirmed:boolean;therapistScope?:string|undefined;conversationId?:string;notifyPatient?:boolean}) {
    if(!options.confirmed)throw new DomainError('CONFIRMATION_REQUIRED',409);
    if(key.length<8||key.length>128)throw new DomainError('INVALID_REQUEST_KEY',400);
    try{return await this.db.transaction(async db=>{
      const meta=(await db.query('select conversation_id from public.appointments where id=$1',[appointmentId])).rows[0];
      if(!meta)throw new DomainError('APPOINTMENT_NOT_FOUND',404);
      if(options.conversationId&&meta.conversation_id!==options.conversationId)throw new DomainError('FORBIDDEN',403);
      const conversation=(await db.query('select status,archived_at from public.conversations where id=$1 for update',[meta.conversation_id])).rows[0]!;
      if(options.conversationId&&(conversation.status!=='active'||conversation.archived_at))throw new DomainError('AGENT_PAUSED',409);
      const appointment=(await db.query('select * from public.appointments where id=$1',[appointmentId])).rows[0]!;
      if(options.therapistScope&&appointment.therapist_id!==options.therapistScope)throw new DomainError('FORBIDDEN',403);
      const previous=(await db.query('select * from private.appointment_changes where appointment_id=$1 and request_key=$2',[appointmentId,key])).rows[0];
      if(previous){
        if(previous.target_slot_id!==slotId||previous.expected_version!==options.expectedVersion)throw new DomainError('IDEMPOTENCY_CONFLICT',409);
        return previous.result as Record<string,unknown>;
      }
      if(appointment.version!==options.expectedVersion)throw new DomainError('APPOINTMENT_CHANGED',409);
      if(appointment.status!=='confirmed'||Date.parse(iso(appointment.starts_at))<=Date.now())throw new DomainError('APPOINTMENT_NOT_EDITABLE',409);
      const target=(await db.query('select therapist_id from public.slots where id=$1',[slotId])).rows[0];
      if(!target)throw new DomainError('SLOT_UNAVAILABLE',409);
      if(options.therapistScope&&target.therapist_id!==options.therapistScope)throw new DomainError('FORBIDDEN',403);
      // Every change locks both therapists in the same order, after its conversation.
      await db.query('select id from public.therapists where id=any($1::uuid[]) order by id for update',[[appointment.therapist_id,target.therapist_id]]);
      await db.query('select id from public.appointments where id=$1 for update',[appointmentId]);
      const slot=(await db.query(`select s.* from public.slots s where s.id=$1 and s.active and s.starts_at>now()
        and not exists(select 1 from public.appointments a where a.id<>$2 and a.therapist_id=s.therapist_id and a.status='confirmed'
          and tstzrange(a.starts_at,a.busy_ends_at,'[)') && tstzrange(s.starts_at,s.busy_ends_at,'[)')) for update of s`,[slotId,appointmentId])).rows[0];
      if(!slot||slot.id===appointment.slot_id)throw new DomainError('SLOT_UNAVAILABLE',409);
      if((await db.query("select id from private.delivery_jobs where appointment_id=$1 and status='processing'",[appointmentId])).rows.length)throw new DomainError('DELIVERY_IN_PROGRESS',409);
      const updated=(await db.query(`update public.appointments set slot_id=$2,therapist_id=$3,starts_at=$4,ends_at=$5,busy_ends_at=$6,version=version+1 where id=$1 returning *`,
        [appointmentId,slot.id,slot.therapist_id,slot.starts_at,slot.ends_at,slot.busy_ends_at])).rows[0]!;
      await db.query("update private.delivery_jobs set status='pending',attempts=0,available_at=now() where appointment_id=$1",[appointmentId]);
      await db.query('update public.conversations set pending_slot_id=null,pending_expires_at=null where id=$1',[meta.conversation_id]);
      await db.query(`update private.conversation_runtime set state=state||'{"rescheduling":null,"offered":[],"choices":[{"label":"Buscar horarios","action":"start"},{"label":"Hablar con recepción","action":"human"}]}'::jsonb where conversation_id=$1`,[meta.conversation_id]);
      await db.query("insert into private.audit_events(conversation_id,action,entity_id) values ($1,'appointment_rescheduled',$2)",[meta.conversation_id,appointmentId]);
      await db.query('insert into private.appointment_changes(appointment_id,request_key,expected_version,target_slot_id,result) values ($1,$2,$3,$4,$5::jsonb)',
        [appointmentId,key,options.expectedVersion,slotId,JSON.stringify(updated)]);
      if(options.notifyPatient){
        const clinic=(await db.query<{time_zone:string}>('select time_zone from public.clinics')).rows[0]!;
        const therapist=(await db.query<{name:string}>('select name from public.therapists where id=$1',[slot.therapist_id])).rows[0]!;
        const when=new Intl.DateTimeFormat('es-AR',{timeZone:clinic.time_zone,weekday:'long',day:'numeric',month:'long',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(iso(slot.starts_at)));
        await db.query(`insert into public.messages(conversation_id,external_message_id,direction,role,body) values ($1,$2,'outbound','staff',$3)`,
          [meta.conversation_id,randomUUID(),`Recepción reprogramó tu turno para el ${when} con ${therapist.name}. El horario anterior quedó liberado.`]);
      }
      return updated;
    });}catch(error){return translateDatabaseError(error);}
  }

  async getUnreadConversations(readerId:string) {
    return (await this.db.query(`select c.id,count(m.id)::int as unread_count from public.conversations c
      left join private.conversation_reads r on r.conversation_id=c.id and r.reader_id=$1
      join public.messages m on m.conversation_id=c.id and m.direction='inbound' and m.body is not null and m.sequence>coalesce(r.last_sequence,0)
      where c.archived_at is null group by c.id`,[readerId])).rows;
  }
  async markConversationRead(readerId:string,conversationId:string,lastMessageId:string) {
    const message=(await this.db.query(`select m.sequence from public.messages m join public.conversations c on c.id=m.conversation_id
      where m.conversation_id=$1 and m.id=$2 and c.archived_at is null`,[conversationId,lastMessageId])).rows[0];
    if(!message)throw new DomainError('MESSAGE_NOT_FOUND',404);
    await this.db.query(`insert into private.conversation_reads(reader_id,conversation_id,last_sequence) values ($1,$2,$3)
      on conflict(reader_id,conversation_id) do update set last_sequence=greatest(private.conversation_reads.last_sequence,excluded.last_sequence)`,[readerId,conversationId,message.sequence]);
    return {ok:true};
  }

  async getPatientDetails(conversationId:string,db=this.db):Promise<PatientDetails> {
    const row=(await db.query<PatientDetails>(`select p.name,p.name_collected,p.phone,p.insurance,p.reported_reason,p.additional_info,p.intake_summary,p.details_updated_at
      from public.patients p join public.patient_identities i on i.patient_id=p.id
      join public.conversations c on c.identity_id=i.id where c.id=$1`,[conversationId])).rows[0];
    if(!row)throw new DomainError('CONVERSATION_NOT_FOUND',404);
    return row;
  }

  async updatePatientDetails(conversationId:string,input:PatientPatch) {
    const patch=patientDetailsInput.parse(input);
    return this.db.transaction(async db=>{
      const row=(await db.query(`select p.id from public.patients p join public.patient_identities i on i.patient_id=p.id
        join public.conversations c on c.identity_id=i.id where c.id=$1 for update of p`,[conversationId])).rows[0];
      if(!row)throw new DomainError('CONVERSATION_NOT_FOUND',404);
      const current=await this.getPatientDetails(conversationId,db);
      const next:PatientDetails={...current,name_collected:current.name_collected||patch.name!==undefined};
      for(const [key,value] of Object.entries(patch))if(value!==undefined)next[key]=value;
      await db.query(`update public.patients set name=$2,name_collected=$3,phone=$4,insurance=$5,reported_reason=$6,
        additional_info=$7,intake_summary=$8,details_updated_at=now() where id=$1`,[row.id,next.name,next.name_collected,next.phone,
        next.insurance||null,next.reported_reason||null,next.additional_info||null,patientSummary(next)]);
      await db.query("insert into private.audit_events(conversation_id,action,entity_id) values ($1,'patient_details_updated',$2)",[conversationId,row.id]);
      return this.getPatientDetails(conversationId,db);
    });
  }

  async getTherapists() {
    return (await this.db.query('select id, name, specialty from public.therapists order by name')).rows;
  }

  async getTherapistProfile(therapistId:string){
    const row=(await this.db.query('select id,name,specialty from public.therapists where id=$1',[therapistId])).rows[0];
    if(!row)throw new DomainError('THERAPIST_NOT_FOUND',404);return row;
  }

  async updateTherapistProfile(therapistId:string,input:{name:string;specialty:string},actor?:{id:string;role:string}){
    return this.db.transaction(async db=>{
      const row=(await db.query<{staff_user_id:string|null}>('select staff_user_id from public.therapists where id=$1 for update',[therapistId])).rows[0];
      if(!row)throw new DomainError('THERAPIST_NOT_FOUND',404);
      if(actor?.role==='therapist'&&row.staff_user_id!==actor.id)throw new DomainError('FORBIDDEN',403);
      await db.query('update public.therapists set name=$2,specialty=$3 where id=$1',[therapistId,input.name,input.specialty]);
      if(row.staff_user_id){
        await db.query('update public.staff_members set display_name=$2 where user_id=$1',[row.staff_user_id,input.name]);
        await db.query("insert into private.staff_audit(actor_id,subject_id,action) values ($1,$2,'staff_updated')",[actor?.id??row.staff_user_id,row.staff_user_id]);
      }
      return {id:therapistId,...input};
    });
  }

  /** One confirmed manual booking, including contact and retry identity, in one transaction. */
  async createManualAppointment(therapistId:string,input:{slotId:string;name:string;phone:string},requestId:string,actor?:{id:string;role:string}){
    const patient=patientDetailsInput.parse({name:input.name,phone:input.phone});
    const {name,phone}=patient;
    if(!name||!phone)throw new DomainError('PATIENT_DETAILS_REQUIRED',400);
    const key=`staff-${actor?.id??'local'}-${requestId}`;
    try{return await this.db.transaction(async db=>{
      await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[key]);
      const prior=(await db.query(`select a.*,p.name as saved_name,p.phone as saved_phone from public.appointments a
        join public.patients p on p.id=a.patient_id where a.request_key=$1`,[key])).rows[0];
      if(prior){
        if(prior.therapist_id!==therapistId||prior.slot_id!==input.slotId||prior.saved_name!==name||prior.saved_phone!==phone||prior.status!=='confirmed')throw new DomainError('IDEMPOTENCY_CONFLICT',409);
        const {saved_name:_name,saved_phone:_phone,...booked}=prior;return booked;
      }
      const therapist=(await db.query<{staff_user_id:string|null}>('select staff_user_id from public.therapists where id=$1 for update',[therapistId])).rows[0];
      if(!therapist)throw new DomainError('THERAPIST_NOT_FOUND',404);
      if(actor?.role==='therapist'&&therapist.staff_user_id!==actor.id)throw new DomainError('FORBIDDEN',403);
      if(!(await db.query('select id from public.slots where id=$1 and therapist_id=$2 and active and starts_at>now()',[input.slotId,therapistId])).rows.length)throw new DomainError('SLOT_UNAVAILABLE',409);
      const patientId=randomUUID(),identity=randomUUID(),conversation=randomUUID();
      const summary=patientSummary({name,name_collected:true,phone,insurance:null,reported_reason:null,additional_info:null,intake_summary:'',details_updated_at:null});
      await db.query('insert into public.patients(id,name,name_collected,phone,intake_summary,details_updated_at) values ($1,$2,true,$3,$4,now())',[patientId,name,phone,summary]);
      await db.query("insert into public.patient_identities(id,patient_id,channel,external_user_id) values ($1,$2,'telegram',$3)",[identity,patientId,`manual-${identity}`]);
      await db.query("insert into public.conversations(id,identity_id,pending_slot_id,pending_expires_at) values ($1,$2,$3,now()+interval '10 minutes')",[conversation,identity,input.slotId]);
      return (await db.query('select * from private.book_slot($1,$2,$3,true)',[conversation,input.slotId,key])).rows[0]!;
    });}catch(error){return translateDatabaseError(error);}
  }

  async getConversations() {
    return (await this.db.query('select id, status, pending_slot_id from public.conversations where archived_at is null order by created_at')).rows;
  }

  async setAppointmentRemoved(appointmentId:string,removed:boolean,therapistScope?:string) {
    try{return await this.db.transaction(async db=>{
      const meta=(await db.query('select conversation_id,therapist_id from public.appointments where id=$1',[appointmentId])).rows[0];
      if(!meta)throw new DomainError('APPOINTMENT_NOT_FOUND',404);
      if(therapistScope&&meta.therapist_id!==therapistScope)throw new DomainError('FORBIDDEN',403);
      // Match booking lock order: conversation, therapist, then individual record.
      await db.query('select id from public.conversations where id=$1 for update',[meta.conversation_id]);
      await db.query('select id from public.therapists where id=$1 for update',[meta.therapist_id]);
      const row=(await db.query('select * from public.appointments where id=$1 for update',[appointmentId])).rows[0]!;
      const status=removed?'cancelled':'confirmed';
      if(row.status===status)return {id:appointmentId,status};
      if(!removed){
        const valid=(await db.query(`select id from public.slots where id=$1 and active and starts_at>now()
          and starts_at=$2 and ends_at=$3 and busy_ends_at=$4`,[row.slot_id,row.starts_at,row.ends_at,row.busy_ends_at])).rows.length;
        if(!valid)throw new DomainError('SLOT_UNAVAILABLE',409);
      }
      if((await db.query("select id from private.delivery_jobs where appointment_id=$1 and status='processing'",[appointmentId])).rows.length)throw new DomainError('DELIVERY_IN_PROGRESS',409);
      await db.query('update public.appointments set status=$2,version=version+1 where id=$1',[appointmentId,status]);
      await db.query(`update private.delivery_jobs set status=$2 where appointment_id=$1 and status ${removed?"in ('pending','failed')":"= 'cancelled'"}`,[appointmentId,removed?'cancelled':'pending']);
      await db.query('insert into private.audit_events(conversation_id,action,entity_id) values ($1,$2,$3)',[meta.conversation_id,removed?'appointment_cancelled':'appointment_restored',appointmentId]);
      return {id:appointmentId,status};
    });}catch(error){return translateDatabaseError(error);}
  }

  async setConversationArchived(conversationId:string,archived:boolean) {
    return this.db.transaction(async db=>{
      const row=(await db.query('select status,archived_at,status_before_archive from public.conversations where id=$1 for update',[conversationId])).rows[0];
      if(!row)throw new DomainError('CONVERSATION_NOT_FOUND',404);
      if(Boolean(row.archived_at)===archived)return {id:conversationId,archived};
      if((await db.query(`select j.id from private.delivery_jobs j join public.handoffs h on h.id=j.handoff_id
        where h.conversation_id=$1 and j.status='processing'`,[conversationId])).rows.length)throw new DomainError('DELIVERY_IN_PROGRESS',409);
      if(archived)await db.query(`update public.conversations set status_before_archive=status,status='closed',archived_at=now(),pending_slot_id=null,pending_expires_at=null where id=$1`,[conversationId]);
      else await db.query('update public.conversations set status=status_before_archive,status_before_archive=null,archived_at=null where id=$1',[conversationId]);
      await db.query(`update private.delivery_jobs j set status=$2 from public.handoffs h
        where h.id=j.handoff_id and h.conversation_id=$1 and h.resolved_at is null and j.status ${archived?"in ('pending','failed')":"= 'cancelled'"}`,[conversationId,archived?'cancelled':'pending']);
      await db.query('insert into private.audit_events(conversation_id,action,entity_id) values ($1,$2,$1)',[conversationId,archived?'conversation_archived':'conversation_restored']);
      return {id:conversationId,archived};
    });
  }

  async getRemoved(kind:'appointments'|'conversations',therapistScope?:string) {
    if(kind==='appointments')return (await this.db.query(`select a.id,p.name as label,a.starts_at as at from public.appointments a
      join public.patients p on p.id=a.patient_id where a.status='cancelled' and ($1::uuid is null or a.therapist_id=$1) order by a.starts_at desc limit 100`,[therapistScope??null])).rows;
    return (await this.db.query(`select c.id,p.name as label,c.archived_at as at from public.conversations c
      join public.patient_identities i on i.id=c.identity_id join public.patients p on p.id=i.patient_id
      where c.archived_at is not null order by c.archived_at desc limit 100`)).rows;
  }

  async getAvailability(therapistId: string, from: string, to: string) {
    return (await this.db.query(`select s.id, s.therapist_id, s.starts_at, s.ends_at from public.slots s
      where s.therapist_id = $1 and s.active and s.starts_at >= $2 and s.ends_at <= $3 and s.starts_at > now()
      and not exists (select 1 from public.appointments a where a.therapist_id = s.therapist_id and a.status = 'confirmed'
        and tstzrange(a.starts_at, a.busy_ends_at, '[)') && tstzrange(s.starts_at, s.busy_ends_at, '[)'))
      order by s.starts_at limit 500`, [therapistId, from, to])).rows;
  }

  async regenerate(therapistId: string, fromDate: string, days: number, now = new Date().toISOString(), transaction?: Sql) {
    const operation = async (db: Sql) => {
      const therapist = await db.query('select id from public.therapists where id = $1 for update', [therapistId]);
      if (!therapist.rows.length) throw new DomainError('THERAPIST_NOT_FOUND', 404);
      const clinic = (await db.query<{ time_zone: string }>('select time_zone from public.clinics')).rows[0];
      if (!clinic) throw new Error('Clinic configuration missing');
      const rules = (await db.query(`select r.*, coalesce((select jsonb_agg(jsonb_build_object(
          'startMinute', b.start_minute, 'endMinute', b.end_minute)) from public.availability_breaks b where b.rule_id = r.id), '[]') as breaks
        from public.availability_rules r where r.therapist_id = $1`, [therapistId])).rows.map(row => ({
        weekday: Number(row.weekday), startMinute: Number(row.start_minute), endMinute: Number(row.end_minute),
        sessionMinutes: Number(row.session_minutes), bufferMinutes: Number(row.buffer_minutes), breaks: row.breaks,
      })) as WorkingRule[];
      const blocks = (await db.query(`select starts_at, ends_at from public.time_off where therapist_id = $1
        union all select starts_at, busy_ends_at as ends_at from public.appointments where therapist_id = $1 and status = 'confirmed'`, [therapistId])).rows
        .map(row => ({ start: iso(row.starts_at), end: iso(row.ends_at) }));
      const generated = generateSlots({ fromDate, days, timeZone: clinic.time_zone, rules, blocked: blocks, now });
      const start = Temporal.PlainDate.from(fromDate).toZonedDateTime(clinic.time_zone).toInstant().toString();
      const end = Temporal.PlainDate.from(fromDate).add({ days }).toZonedDateTime(clinic.time_zone).toInstant().toString();
      await db.query(`update public.slots s set active = false where therapist_id = $1 and starts_at >= $2 and starts_at < $3
        and not exists (select 1 from public.appointments a where a.slot_id = s.id and a.status = 'confirmed')`, [therapistId, start, end]);
      await db.query(`insert into public.slots(therapist_id, starts_at, ends_at, busy_ends_at)
        select $1::uuid, (x->>'start')::timestamptz, (x->>'end')::timestamptz, (x->>'busyEnd')::timestamptz
        from jsonb_array_elements($2::jsonb) x
        on conflict (therapist_id, starts_at) do update set ends_at = excluded.ends_at,
          busy_ends_at = excluded.busy_ends_at, active = true
        where not exists (select 1 from public.appointments a where a.slot_id = slots.id and a.status = 'confirmed')`,
      [therapistId, JSON.stringify(generated)]);
      return { generated: generated.length, from: start, to: end };
    };
    return transaction ? operation(transaction) : this.db.transaction(operation);
  }

  async getSchedule(therapistId: string) {
    const rules = (await this.db.query(`select r.*, coalesce((select jsonb_agg(jsonb_build_object(
      'startMinute', b.start_minute, 'endMinute', b.end_minute) order by b.start_minute)
      from public.availability_breaks b where b.rule_id = r.id), '[]') as breaks
      from public.availability_rules r where therapist_id = $1 order by weekday, start_minute`, [therapistId])).rows;
    const timeOff = (await this.db.query('select id, starts_at, ends_at from public.time_off where therapist_id = $1 order by starts_at', [therapistId])).rows;
    return { rules, timeOff };
  }

  async saveSchedule(therapistId: string, rules: WorkingRule[]) {
    const clinic = (await this.db.query<{ time_zone: string }>('select time_zone from public.clinics')).rows[0]!;
    const now = new Date().toISOString();
    const today = Temporal.Instant.from(now).toZonedDateTimeISO(clinic.time_zone).toPlainDate().toString();
    try { generateSlots({ fromDate: today, days: 7, timeZone: clinic.time_zone, rules, now }); }
    catch { throw new DomainError('INVALID_SCHEDULE', 400); }
    return this.db.transaction(async db => {
      if (!(await db.query('select id from public.therapists where id = $1 for update', [therapistId])).rows.length) throw new DomainError('THERAPIST_NOT_FOUND', 404);
      await db.query('delete from public.availability_rules where therapist_id = $1', [therapistId]);
      for (const rule of rules) {
        const row = (await db.query(`insert into public.availability_rules(therapist_id, weekday, start_minute, end_minute, session_minutes, buffer_minutes)
          values ($1,$2,$3,$4,$5,$6) returning id`, [therapistId, rule.weekday, rule.startMinute, rule.endMinute, rule.sessionMinutes, rule.bufferMinutes])).rows[0]!;
        for (const rest of rule.breaks) await db.query('insert into public.availability_breaks(rule_id,start_minute,end_minute) values ($1,$2,$3)', [row.id, rest.startMinute, rest.endMinute]);
      }
      return this.regenerate(therapistId, today, 42, now, db);
    });
  }

  async blockDate(therapistId: string, date: string) {
    const clinic = (await this.db.query<{ time_zone: string }>('select time_zone from public.clinics')).rows[0]!;
    const day = Temporal.PlainDate.from(date);
    const today = Temporal.Now.plainDateISO(clinic.time_zone);
    if (Temporal.PlainDate.compare(day, today) < 0 || Temporal.PlainDate.compare(day, today.add({ days: 41 })) > 0) throw new DomainError('INVALID_BLOCK_DATE', 400);
    return this.db.transaction(async db => {
      if (!(await db.query('select id from public.therapists where id = $1 for update', [therapistId])).rows.length) throw new DomainError('THERAPIST_NOT_FOUND', 404);
      const start = day.toZonedDateTime(clinic.time_zone).toInstant().toString();
      const end = day.add({ days: 1 }).toZonedDateTime(clinic.time_zone).toInstant().toString();
      const conflict = (await db.query(`select id from public.appointments where therapist_id = $1 and status = 'confirmed'
        and tstzrange(starts_at,busy_ends_at,'[)') && tstzrange($2::timestamptz,$3::timestamptz,'[)')`, [therapistId,start,end])).rows;
      if (conflict.length) throw new DomainError('DATE_HAS_APPOINTMENTS', 409);
      await db.query(`insert into public.time_off(therapist_id, starts_at, ends_at) select $1,$2,$3
        where not exists (select 1 from public.time_off where therapist_id=$1 and starts_at=$2 and ends_at=$3)`, [therapistId,start,end]);
      return this.regenerate(therapistId, today.toString(), 42, new Date().toISOString(), db);
    });
  }

  async removeTimeOff(therapistId: string, blockId: string) {
    return this.db.transaction(async db => {
      if (!(await db.query('select id from public.therapists where id=$1 for update',[therapistId])).rows.length) throw new DomainError('THERAPIST_NOT_FOUND',404);
      if(!(await db.query('delete from public.time_off where id=$1 and therapist_id=$2 returning id',[blockId,therapistId])).rows.length)throw new DomainError('TIME_OFF_NOT_FOUND',404);
      const clinic=(await db.query<{time_zone:string}>('select time_zone from public.clinics')).rows[0]!;
      return this.regenerate(therapistId,Temporal.Now.plainDateISO(clinic.time_zone).toString(),42,new Date().toISOString(),db);
    });
  }

  async resolveHandoff(conversationId: string, mode: 'active' | 'human_led') {
    return this.db.transaction(async db => {
      const row = (await db.query('select status from public.conversations where id = $1 for update', [conversationId])).rows[0];
      if (!row) throw new DomainError('CONVERSATION_NOT_FOUND', 404);
      if (row.status === 'closed') throw new DomainError('CONVERSATION_CLOSED', 409);
      await db.query('update public.handoffs set resolved_at = now() where conversation_id = $1 and resolved_at is null', [conversationId]);
      await db.query('update public.conversations set status = $2, pending_slot_id = null, pending_expires_at = null where id = $1', [conversationId, mode]);
      await db.query("insert into private.audit_events(conversation_id,action,entity_id) values ($1,'conversation_control_changed',$1)", [conversationId]);
      return { status: mode };
    });
  }

  async selectSlot(conversationId: string, slotId: string) {
    return this.db.transaction(async db => {
      const conversation = (await db.query('select status from public.conversations where id = $1 for update', [conversationId])).rows[0];
      if (!conversation) throw new DomainError('CONVERSATION_NOT_FOUND', 404);
      if (conversation.status !== 'active') throw new DomainError('AGENT_PAUSED', 409);
      const slot = (await db.query(`select s.id, s.starts_at, s.ends_at, t.name as therapist from public.slots s
        join public.therapists t on t.id = s.therapist_id where s.id = $1 and s.active and s.starts_at > now()
        and not exists (select 1 from public.appointments a where a.therapist_id = s.therapist_id and a.status = 'confirmed'
          and tstzrange(a.starts_at, a.busy_ends_at, '[)') && tstzrange(s.starts_at, s.busy_ends_at, '[)'))`, [slotId])).rows[0];
      if (!slot) throw new DomainError('SLOT_UNAVAILABLE', 409);
      await db.query("update public.conversations set pending_slot_id = $2, pending_expires_at = now() + interval '10 minutes' where id = $1", [conversationId, slotId]);
      return { id:slot.id,starts_at:slot.starts_at,ends_at:slot.ends_at,therapist:slot.therapist,confirmationRequired: true };
    });
  }

  async book(conversationId: string, slotId: string, requestKey: string, confirmed: boolean) {
    try {
      return await this.db.transaction(async db=>(await db.query('select * from private.book_slot($1, $2, $3, $4)', [conversationId, slotId, requestKey, confirmed])).rows[0]!);
    } catch (error) { return translateDatabaseError(error); }
  }

  async escalate(conversationId: string, reason: string) {
    try {
      return await this.db.transaction(async db=>(await db.query('select * from private.escalate($1, $2)', [conversationId, reason])).rows[0]!);
    } catch (error) { return translateDatabaseError(error); }
  }
}
