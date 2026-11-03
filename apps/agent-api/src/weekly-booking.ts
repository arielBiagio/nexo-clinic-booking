import { createHash } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { ClinicRepository,DomainError } from '../../../packages/db/src/repository.js';
import { withSavepoints } from '../../../packages/db/src/savepoints.js';
import { missingContact,type PatientDetails } from '../../../packages/core/src/patient.js';
import { normalizeWeeklyText,type WeeklyInput } from '../../../packages/agent/src/weekly.js';
import { requestedLocalTime } from '../../../packages/agent/src/search.js';
import type { OfferedSlot } from '../../../packages/agent/src/openrouter.js';

export interface ExistingWeeklyAppointment {id:string;version:number;start:string;end:string;therapistId:string;therapistName:string}
export interface WeeklyPlan {slots:OfferedSlot[];existing:ExistingWeeklyAppointment[];expiresAt:number;contactHash:string;skippedPast:boolean}
export interface WeeklyState {request:WeeklyInput;plan:WeeklyPlan|null;ready:boolean}
export const contactHash=(patient:PatientDetails)=>createHash('sha256').update(JSON.stringify([patient.name,patient.phone])).digest('hex');
const iso=(value:unknown)=>value instanceof Date?value.toISOString():new Date(String(value)).toISOString();
const clock=(value:string,zone:string)=>Temporal.Instant.from(value).toZonedDateTimeISO(zone).toPlainTime().toString({smallestUnit:'minute'});
const day=(value:string,zone:string)=>Temporal.Instant.from(value).toZonedDateTimeISO(zone).toPlainDate();
const sameOrAfter=(left:Temporal.PlainDate,right:Temporal.PlainDate)=>Temporal.PlainDate.compare(left,right)>=0;

export async function proposeWeekly(repo:ClinicRepository,current:{id:string;appointments:ExistingWeeklyAppointment[]},request:WeeklyInput,text:string,previous?:WeeklyInput):Promise<{state:WeeklyState;message:string}>{
  const clinic=(await repo.db.query<{time_zone:string}>('select time_zone from public.clinics')).rows[0]!;
  const zone=clinic.time_zone,now=Temporal.Now.instant(),today=now.toZonedDateTimeISO(zone).toPlainDate(),value=normalizeWeeklyText(text);
  const next={...request};
  if(previous)for(const key of ['week_start','local_time','therapist_id','weekdays','reference_appointment_id'] as const)if(next[key]===null)(next as Record<string,unknown>)[key]=previous[key];
  const anyTherapist=/\b(cualquier(?:a)?|sin preferencia|me da igual|otro (?:terapeuta|profesional))\b/.test(value);
  if(anyTherapist){next.therapist_id=null;next.reference_appointment_id=null;}
  if(/\b(lunes a viernes)\b/.test(value))next.weekdays=[1,2,3,4,5];
  if(/\b(semana que viene|proxima semana|semana proxima)\b/.test(value))next.week_start=today.subtract({days:today.dayOfWeek-1}).add({days:7}).toString();
  else if(/\besta semana\b/.test(value))next.week_start=today.subtract({days:today.dayOfWeek-1}).toString();
  const explicitTime=requestedLocalTime(text);if(explicitTime)next.local_time=explicitTime;
  const needsReference=/\b(mism[oa] (?:horario|hora|semana)|esa (?:hora|semana)|igual horario)\b/.test(value);
  const reference=next.reference_appointment_id?current.appointments.find(a=>a.id===next.reference_appointment_id):needsReference&&current.appointments.length===1?current.appointments[0]:null;
  const state:WeeklyState={request:next,plan:null,ready:false};
  if(/\b(todas las semanas|cada semana|(?:dos|tres|cuatro|cinco|seis|\d+) semanas)\b/.test(value))return {state,message:'Puedo preparar una semana por vez. ¿Qué semana querés reservar primero?'};
  if(next.reference_appointment_id&&!reference)return {state,message:'Ese turno de referencia ya no está disponible. ¿Qué semana y horario querés reservar?'};
  if(reference){
    next.reference_appointment_id=reference.id;
    if(!explicitTime&&/\b(mismo horario|misma hora|esa hora|igual horario)\b/.test(value))next.local_time=clock(reference.start,zone);
    next.local_time??=clock(reference.start,zone);if(!anyTherapist&&(!previous||!previous.reference_appointment_id))next.therapist_id??=reference.therapistId;
    if(!next.week_start){const date=day(reference.start,zone);next.week_start=date.subtract({days:date.dayOfWeek-1}).toString();}
  }
  if(!next.week_start)return {state,message:'¿Para qué semana querés los turnos? Puedo revisar los días de atención al mismo horario.'};
  if(!next.local_time)return {state,message:'¿A qué hora querés los turnos de esa semana?'};
  const startDate=Temporal.PlainDate.from(next.week_start),monday=startDate.subtract({days:startDate.dayOfWeek-1});next.week_start=monday.toString();
  if(Temporal.PlainDate.compare(monday,today.add({days:41}))>0||Temporal.PlainDate.compare(monday.add({days:6}),today)<0)return {state,message:'Elegí una semana con fechas futuras dentro de las próximas seis semanas.'};
  const therapists=(await repo.getTherapists()).filter(t=>!next.therapist_id||t.id===next.therapist_id);
  if(!therapists.length)return {state,message:'Ese profesional ya no está disponible. ¿Con qué profesional querés consultar la semana?'};
  const schedules=await Promise.all(therapists.map(t=>repo.getSchedule(String(t.id))));
  const weekdays=[...new Set(next.weekdays??schedules.flatMap(schedule=>schedule.rules.map(rule=>Number(rule.weekday))))].sort((a,b)=>a-b);
  const dates=weekdays.map(weekday=>monday.add({days:weekday-1}));
  const futureDates=dates.filter(date=>sameOrAfter(date,today)&&Temporal.Instant.compare(date.toPlainDateTime(next.local_time!).toZonedDateTime(zone,{disambiguation:'reject'}).toInstant(),now)>0);
  if(!futureDates.length)return {state,message:'No encontré días futuros de atención en esa semana. ¿Qué otra semana te conviene?'};
  if(futureDates.some(date=>Temporal.PlainDate.compare(date,today.add({days:41}))>0))return {state,message:'La semana supera el período de reservas. Elegí fechas dentro de las próximas seis semanas.'};
  const patient=await repo.getPatientDetails(current.id),missingFields=missingContact(patient);
  const finish=(slots:OfferedSlot[],existing:ExistingWeeklyAppointment[])=>{
    state.plan={slots,existing,expiresAt:Date.now()+600_000,contactHash:contactHash(patient),skippedPast:futureDates.length<dates.length};
    state.ready=slots.length>0&&!missingFields.length;
    const when=(instant:string)=>new Intl.DateTimeFormat('es-AR',{timeZone:zone,weekday:'long',day:'numeric',month:'long',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(instant));
    const lines=[...slots.map(slot=>({start:slot.start,text:`• ${when(slot.start)} · ${slot.therapistName}`})),...existing.map(a=>({start:a.start,text:`• ${when(a.start)} · ${a.therapistName} · ya confirmado, se conserva`}))].sort((a,b)=>Date.parse(a.start)-Date.parse(b.start)).map(line=>line.text);
    const details=`Zona horaria: ${zone}.\n${lines.join('\n')}${state.plan.skippedPast?'\nSe muestran solo las fechas futuras; los días pasados no se incluyen.':''}`;
    if(!slots.length)return {state,message:`Ya tenés todos estos turnos confirmados. No agregué reservas duplicadas.\n${details}`};
    return {state,message:`${slots.length} ${slots.length===1?'turno nuevo propuesto':'turnos nuevos propuestos'} para la semana:\n${details}\n${missingFields.length?`Antes de confirmar, necesito tu ${missingFields[0]}.`:`A nombre de ${patient.name}, teléfono ${patient.phone}. ¿Confirmás los ${slots.length} turnos nuevos?`}`};
  };
  let best:{name:string;missing:Temporal.PlainDate[]}|null=null;
  const coverage:{slots:OfferedSlot[];existing:ExistingWeeklyAppointment[]}[]=[];
  for(const therapist of therapists){
    // Fetch from the requested clock on each day, so a broad search limit cannot hide later dates.
    const available=(await Promise.all(futureDates.map(date=>repo.getAvailability(String(therapist.id),date.toPlainDateTime(next.local_time!).toZonedDateTime(zone,{disambiguation:'reject'}).toInstant().toString(),date.add({days:1}).toZonedDateTime(zone).toInstant().toString())))).flat();
    const slots:OfferedSlot[]=[],existing:ExistingWeeklyAppointment[]=[],missing:Temporal.PlainDate[]=[];
    for(const date of futureDates){
      const prior=current.appointments.find(a=>a.therapistId===therapist.id&&day(a.start,zone).equals(date)&&clock(a.start,zone)===next.local_time);
      if(prior){existing.push(prior);continue;}
      const slot=available.find(s=>day(iso(s.starts_at),zone).equals(date)&&clock(iso(s.starts_at),zone)===next.local_time);
      if(!slot||current.appointments.some(a=>Date.parse(a.start)<Date.parse(iso(slot.ends_at))&&Date.parse(a.end)>Date.parse(iso(slot.starts_at)))){missing.push(date);continue;}
      slots.push({id:String(slot.id),therapistId:String(therapist.id),therapistName:String(therapist.name),start:iso(slot.starts_at),end:iso(slot.ends_at)});
    }
    coverage.push({slots,existing});
    if(missing.length){if(!best||missing.length<best.missing.length)best={name:String(therapist.name),missing};continue;}
    next.therapist_id=String(therapist.id);
    return finish(slots,existing);
  }
  const format=(date:Temporal.PlainDate)=>new Intl.DateTimeFormat('es-AR',{timeZone:'UTC',weekday:'long',day:'numeric',month:'long'}).format(new Date(`${date}T12:00:00Z`));
  if(!next.therapist_id){
    const slots:OfferedSlot[]=[],existing:ExistingWeeklyAppointment[]=[],missing:Temporal.PlainDate[]=[];
    for(const date of futureDates){
      const prior=coverage.flatMap(candidate=>candidate.existing).find(a=>day(a.start,zone).equals(date));
      const slot=coverage.flatMap(candidate=>candidate.slots).find(a=>day(a.start,zone).equals(date));
      if(prior)existing.push(prior);else if(slot)slots.push(slot);else missing.push(date);
    }
    if(!missing.length)return finish(slots,existing);
    return {state,message:`No pude completar toda la semana a las ${next.local_time} para tu ficha. Faltan horarios en: ${missing.map(format).join(', ')}. No agregué reservas. ¿Querés probar otra hora o semana?`};
  }
  return {state,message:best?`No pude completar toda la semana a las ${next.local_time} con ${best.name}. No hay un turno libre para esa ficha en: ${best.missing.map(format).join(', ')}. No agregué reservas. ¿Querés probar otro horario o profesional?`:'No encontré una semana completa en ese horario. ¿Qué otra semana u horario te conviene?'};
}

/** All new appointments and their audit/delivery events succeed together or roll back together. */
export async function bookWeekly(repo:ClinicRepository,conversationId:string,plan:WeeklyPlan,key:string){
  if(plan.expiresAt<=Date.now()||!plan.slots.length||plan.slots.length+plan.existing.length>7||new Set(plan.slots.map(s=>s.id)).size!==plan.slots.length)throw new DomainError('CONFIRMATION_REQUIRED',409);
  return repo.db.transaction(async db=>{
    const scoped=new ClinicRepository(withSavepoints(db)),patientId=await scoped.getConversationPatientId(conversationId);
    await db.query('select id from public.patients where id=$1 for update',[patientId]);
    const conversation=(await db.query('select status,archived_at from public.conversations where id=$1 for update',[conversationId])).rows[0];
    if(!conversation||conversation.status!=='active'||conversation.archived_at)throw new DomainError('AGENT_PAUSED',409);
    const patient=await scoped.getPatientDetails(conversationId);
    if(missingContact(patient).length)throw new DomainError('PATIENT_DETAILS_REQUIRED',409);
    if(contactHash(patient)!==plan.contactHash)throw new DomainError('PATIENT_DETAILS_CHANGED',409);
    const therapistIds=[...new Set([...plan.slots,...plan.existing].map(s=>s.therapistId))];
    if(!therapistIds.length)throw new DomainError('CONFIRMATION_REQUIRED',409);
    await db.query('select id from public.therapists where id=any($1::uuid[]) order by id for update',[therapistIds]);
    for(const prior of plan.existing){
      const row=(await db.query('select patient_id,therapist_id,status,version,starts_at,ends_at from public.appointments where id=$1 for update',[prior.id])).rows[0];
      if(!row||row.patient_id!==patientId||row.status!=='confirmed'||row.version!==prior.version||row.therapist_id!==prior.therapistId||iso(row.starts_at)!==prior.start||iso(row.ends_at)!==prior.end)throw new DomainError('APPOINTMENT_CHANGED',409);
    }
    const slotRows=(await db.query('select id,therapist_id,starts_at,ends_at from public.slots where id=any($1::uuid[]) and active and starts_at>now() order by id for update',[plan.slots.map(s=>s.id)])).rows;
    if(slotRows.length!==plan.slots.length||plan.slots.some(s=>!slotRows.some(row=>row.id===s.id&&row.therapist_id===s.therapistId&&iso(row.starts_at)===s.start&&iso(row.ends_at)===s.end)))throw new DomainError('SLOT_UNAVAILABLE',409);
    const conflicts=await db.query(`select a.id from public.appointments a join public.slots s on s.id=any($2::uuid[])
      where a.patient_id=$1 and a.status='confirmed' and tstzrange(a.starts_at,a.ends_at,'[)') && tstzrange(s.starts_at,s.ends_at,'[)') limit 1`,[patientId,plan.slots.map(s=>s.id)]);
    if(conflicts.rows.length)throw new DomainError('SLOT_UNAVAILABLE',409);
    const results=[];
    for(const slot of [...plan.slots].sort((a,b)=>Date.parse(a.start)-Date.parse(b.start))){
      await scoped.selectSlot(conversationId,slot.id);
      const booked=await scoped.book(conversationId,slot.id,`${key}-${slot.id}`,true);
      if(booked.status!=='confirmed')throw new DomainError('SLOT_UNAVAILABLE',409);
      results.push(booked);
    }
    return results;
  });
}
