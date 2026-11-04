import { Temporal } from '@js-temporal/polyfill';
import { ClinicRepository, DomainError } from './repository.js';
import { withSavepoints } from './savepoints.js';

export interface CancellationTarget {id:string;version:number}
interface WeekAppointment extends CancellationTarget {
  start:string;end:string;therapistId:string;therapistName:string;
}
export interface CancellationWeek {weekStart:string;weekEnd:string;timeZone:string;appointments:WeekAppointment[]}
interface Scope {therapistScope?:string;conversationId?:string}
const iso=(value:Date|string)=>new Date(value).toISOString();

async function loadWeek(repo:ClinicRepository,anchorId:string,scope:Scope){
  const anchor=(await repo.db.query<{patient_id:string;therapist_id:string;starts_at:Date|string;status:string;time_zone:string}>(`
    select a.patient_id,a.therapist_id,a.starts_at,a.status,c.time_zone from public.appointments a
    cross join public.clinics c where a.id=$1`,[anchorId])).rows[0];
  if(!anchor)throw new DomainError('APPOINTMENT_NOT_FOUND',404);
  if(scope.therapistScope&&anchor.therapist_id!==scope.therapistScope)throw new DomainError('FORBIDDEN',403);
  if(scope.conversationId&&await repo.getConversationPatientId(scope.conversationId)!==anchor.patient_id)throw new DomainError('FORBIDDEN',403);
  if(anchor.status!=='confirmed'||Date.parse(iso(anchor.starts_at))<=Date.now())throw new DomainError('APPOINTMENT_NOT_EDITABLE',409);
  const date=Temporal.Instant.from(iso(anchor.starts_at)).toZonedDateTimeISO(anchor.time_zone).toPlainDate();
  const start=date.subtract({days:date.dayOfWeek-1}),end=start.add({days:7});
  const rows=(await repo.db.query<{id:string;version:number;conversation_id:string;therapist_id:string;therapist_name:string;starts_at:Date|string;ends_at:Date|string}>(`
    select a.id,a.version,a.conversation_id,a.therapist_id,t.name as therapist_name,a.starts_at,a.ends_at
    from public.appointments a join public.therapists t on t.id=a.therapist_id
    where a.patient_id=$1 and a.status='confirmed' and a.starts_at>now()
      and a.starts_at >= $2 and a.starts_at < $3 and ($4::uuid is null or a.therapist_id=$4)
    order by a.starts_at,a.id`,[anchor.patient_id,start.toZonedDateTime(anchor.time_zone).toInstant().toString(),end.toZonedDateTime(anchor.time_zone).toInstant().toString(),scope.therapistScope??null])).rows;
  if(!rows.length||rows.length>100)throw new DomainError('APPOINTMENT_CHANGED',409);
  const proposal:CancellationWeek={weekStart:start.toString(),weekEnd:end.subtract({days:1}).toString(),timeZone:anchor.time_zone,
    appointments:rows.map(a=>({id:a.id,version:a.version,start:iso(a.starts_at),end:iso(a.ends_at),therapistId:a.therapist_id,therapistName:a.therapist_name}))};
  return {patientId:anchor.patient_id,rows,proposal};
}

/** Only the patient's future appointments in the anchor's clinic-local Monday–Sunday week. */
export async function getCancellationWeek(repo:ClinicRepository,anchorId:string,scope:Scope={}){
  return (await loadWeek(repo,anchorId,scope)).proposal;
}

/** A changed list requires a new review; appointments, jobs and activity roll back together. */
export async function cancelAppointmentWeek(repo:ClinicRepository,anchorId:string,expected:CancellationTarget[],scope:Scope={}){
  if(!expected.length||expected.length>100||new Set(expected.map(a=>a.id)).size!==expected.length)throw new DomainError('CONFIRMATION_REQUIRED',409);
  return repo.db.transaction(async db=>{
    const scoped=new ClinicRepository(withSavepoints(db));
    const initial=await loadWeek(scoped,anchorId,scope);
    await db.query('select id from public.patients where id=$1 for update',[initial.patientId]);
    const current=await loadWeek(scoped,anchorId,scope);
    if(current.patientId!==initial.patientId)throw new DomainError('APPOINTMENT_CHANGED',409);
    const conversations=[...new Set([...current.rows.map(a=>a.conversation_id),...(scope.conversationId?[scope.conversationId]:[])])];
    await db.query('select id from public.conversations where id=any($1::uuid[]) order by id for update',[conversations]);
    if(scope.conversationId){
      const chat=(await db.query('select status,archived_at from public.conversations where id=$1',[scope.conversationId])).rows[0];
      if(!chat||chat.status!=='active'||chat.archived_at)throw new DomainError('AGENT_PAUSED',409);
    }
    await db.query('select id from public.therapists where id=any($1::uuid[]) order by id for update',[[...new Set(current.rows.map(a=>a.therapist_id))]]);
    await db.query('select id from public.appointments where id=any($1::uuid[]) order by id for update',[current.rows.map(a=>a.id)]);
    const fresh=await loadWeek(scoped,anchorId,scope);
    const versions=new Map(expected.map(a=>[a.id,a.version]));
    if(fresh.patientId!==current.patientId||fresh.rows.length!==expected.length||fresh.rows.some(a=>versions.get(a.id)!==a.version||Date.parse(iso(a.starts_at))<=Date.now()))throw new DomainError('APPOINTMENT_CHANGED',409);
    for(const appointment of fresh.rows)await scoped.setAppointmentRemoved(appointment.id,true,scope.therapistScope);
    await db.query('update public.conversations set pending_slot_id=null,pending_expires_at=null where id=any($1::uuid[])',[conversations]);
    return {cancelled:expected.length};
  });
}
