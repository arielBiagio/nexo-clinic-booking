import { Temporal } from '@js-temporal/polyfill';
import { requestedLocalDate } from './calendar.js';
import type { AvailabilityInput } from './openrouter.js';

const normalized=(text:string)=>text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
type Therapist={id:string;name:string;specialty:string};
const freshSearch=/\b(quiero|quisiera|necesito|busco|buscar|reservar|sacar|gustaria|turnos?|citas?|fisio|fisioterapia|kinesiologia)\b/;
const refinement=(value:string)=>!freshSearch.test(value)&&/\b(hoy|manana|lunes|martes|miercoles|jueves|viernes|sabado|domingo|semana|la tarde|la noche)\b/.test(value);
const anyTherapist=/\b(cualquier(?:a)?|cualquiera de los|me da igual|sin preferencia|todos los|no importa (?:el|quien))\b/;
export function requestedTimePreference(text:string):'earliest'|'latest'|null {
  const value=normalized(text);
  if(/\b(ultima hora|ultimos? (?:horarios?|turnos?)|(?:al |hacia el |sobre el )?final (?:de (?:la )?|del )(?:tarde|dia|jornada|manana)|(?:lo )?mas tarde(?: posible| que (?:se )?pueda)?|antes de cerrar|late afternoon|end of (?:the )?day)\b/.test(value))return 'latest';
  if(/\b(primera hora|primeros? (?:horarios?|turnos?)|(?:al |hacia el )?(?:comienzo|inicio) (?:de (?:la )?|del )(?:manana|tarde|dia|jornada)|(?:lo )?mas temprano(?: posible)?|early morning)\b/.test(value))return 'earliest';
  return null;
}
export function isCancellationRequest(text:string){
  const value=normalized(text);
  if(/\b(?:no (?:quiero |deseo |necesito |lo |la )?|sin |en vez de |do not |don't )cancel(?:ar|es|a)?\b/.test(value))return false;
  return /\b(cancel(?:ar|o|a|alo|alos|ame|emos|en|acion)?|anul(?:ar|o|a|alo|alos)|dar de baja (?:el|mi) turno)\b/.test(value);
}
export function isCancellationConfirmation(text:string){
  const value=normalized(text).replace(/[¡!¿?,.;:]/g,' ').replace(/\s+/g,' ').trim();
  if(/^(?:si(?: confirmo)? |confirmo )?(?:(?:cancelalos|anulalos)(?: todos)?|(?:cancelar|cancela|anular|anula) todos)(?: los turnos)?(?: de (?:esta|esa|la) semana)?$/.test(value))return true;
  return /^(si(?: confirmo)?(?: la cancelacion| cancelalo| cancelalo por favor| cancelar| cancela el turno| quiero cancelarlo)?|confirmo (?:la cancelacion|cancelar(?: el turno)?)|cancelalo(?: por favor)?|dale|ok|okay|confirmo|yes cancel(?: it)?)$/.test(value);
}
export function requestsWholeCancellationWeek(text:string){
  const value=normalized(text);
  if(/^\s*no\b/.test(value)||/\b(?:no quiero|no deseo|sin|en vez de) cancelar\b/.test(value))return false;
  return /\b(?:toda (?:esta |esa |la |una )?semana|tod[oa]s(?: mis| los| las)? (?:turnos|citas)|cancelalos(?: todos)?|anulalos(?: todos)?|todos juntos|los de (?:esta|esa|la) semana|(?:cancelar|cancela|anular|anula) todos\b|(?:cancelar|cancela|cancelame|anular|anula) (?:esta|esa|la) semana)\b/.test(value)||/^\s*todos[.!]?\s*$/.test(value);
}
export function isRescheduleRequest(text:string){
  const value=normalized(text);
  if(/\bno (?:quiero|necesito|deseo|hay que|lo|me lo)?\s*(?:cambiar|cambies|reprogramar|reprogrames|mover)\b/.test(value))return false;
  return /\b(reprogram\w*|cambiar|cambiamos|cambialo|cambiame|cambio de|mover|movemos|muevas|pasar (?:el|mi) turno)\b/.test(value);
}
/** Resolve only complete, unqualified ordinal choices against the actual offered list. */
export function offeredSelection(text:string,offered:readonly {id:string}[]):string|null {
  const value=normalized(text).replace(/[¿?¡!.,;:]+/g,' ').replace(/\s+/g,' ').trim();
  const choice=value.match(/^(?:(?:prefiero|elijo|quiero|selecciono|me sirve|me quedo con)\s+)?(?:el|la)\s+(primer[oa]?|segund[oa]|tercer[oa]?|ultim[oa])(?:\s+(?:horario|turno|opcion))?(?:\s+(?:me sirve|me queda bien|me va bien|esta bien|por favor))?$/)?.[1];
  if(!choice)return null;
  const index=choice.startsWith('primer')?0:choice.startsWith('segund')?1:choice.startsWith('tercer')?2:offered.length-1;
  return offered[index]?.id??null;
}
/** Reject an appointment choice, not unrelated negative intake such as "no tengo seguro". */
export function rejectsSelectedSlot(text:string):boolean {
  const value=normalized(text).replace(/[¿?¡!.,;:]+/g,' ').replace(/\s+/g,' ').trim();
  if(/^(?:no|no gracias|mejor no|prefiero no|no confirmo|no lo confirmo|no confirmes|no lo confirmes|no me sirve|no me conviene)$/.test(value))return true;
  if(/^(?:no )?(?:otro (?:horario|turno|dia)|otra (?:fecha|hora))\b|^(?:mejor|prefiero|quiero|busquemos|busca|mostrame) (?:otro (?:horario|turno|dia)|otra (?:fecha|hora))\b/.test(value))return true;
  return /\b(?:horario|turno|fecha|hora|dia|primero|primera|segundo|segunda|tercero|tercera|ultimo|ultima)\b.{0,60}\bno (?:me )?(?:sirve|conviene|queda bien|va bien|gusta)\b/.test(value)
    || /^(?:ese|esa|este|esta) no (?:me )?(?:sirve|conviene|gusta)$/.test(value);
}
/** Explicit single clock times, with optional meridiem/daypart; ranges stay with the interpreter. */
export function requestedLocalTime(text:string):string|null {
  const value=normalized(text);
  if(/\b(despues|antes|desde|hasta|a partir|entre|after|before|between|from)\b/.test(value))return null;
  const matches=[...value.matchAll(/(?:\ba las?\s+|\bat\s+)(\d{1,2})(?::([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?|h(?:s|oras?)?)?(?![\w:])|\b(\d{1,2})(?::([0-5]\d)\s*(a\.?m\.?|p\.?m\.?|h(?:s|oras?)?)?|\s*(a\.?m\.?|p\.?m\.?|h(?:s|oras?)?))(?![\w:])/g)];
  if(matches.length!==1)return null;
  const match=matches[0]!;
  let hour=Number(match[1]??match[4]);
  const minute=match[2]??match[5]??'00',suffix=(match[3]??match[6]??match[7]??'').replace(/\./g,'');
  const pm=suffix==='pm'||/\bla (?:tarde|noche)\b/.test(value),am=suffix==='am'||/\bla manana\b/.test(value);
  if(hour>23||(suffix==='am'||suffix==='pm')&&(hour<1||hour>12)||am&&pm)return null;
  if(pm&&hour<12)hour+=12;
  if(am&&hour===12)hour=0;
  return `${String(hour).padStart(2,'0')}:${minute}`;
}
const namesIn=(value:string,therapists:Therapist[])=>therapists.filter(t=>{
  const first=normalized(t.name).split(' ')[0]!;
  return value.split(/[^a-z]+/).includes(first);
});
/** Route clear read-only searches separately from intake, consent and handoffs. */
export function isAvailabilityRequest(text:string,therapists:Therapist[],previous?:AvailabilityInput|null) {
  const value=normalized(text).trim().replace(/^[¿¡]+/,'');
  if(/^(?:no\b)|\b(recepcion|humano|persona|cancelar|cancela|anular|reprogramar|cambiar|mover|confirmar|confirmo|ese|ese horario|primero|segundo|tratamiento|ejercicios?|diagnostico|dolor|urgencia|factura|seguro|obra social|telefono|numero|me llamo|mi nombre|soy)\b/.test(value))return false;
  if(/\bcon\b/.test(value)&&!namesIn(value,therapists).length&&!therapists.some(t=>value.includes(normalized(t.specialty)))&&!anyTherapist.test(value)&&!/\bcon (?:quien sea|disponibilidad)\b/.test(value))return false;
  return /\b(turnos?|citas?|horarios?|disponibilidad|disponibles?|fisio|fisioterapia|kinesiologia|terapia fisica)\b/.test(value)&&/\b(quiero|quisiera|necesito|busco|buscar|ver|tenes|tienen|tendra|hay|disponibles?|disponibilidad|podrias|puedo|gustaria|sacar|reservar)\b/.test(value)
    || /^(?:y|o|mejor|solo)\b.*\b(?:la tarde|la manana|la noche)\b/.test(value)
    || Boolean(previous&&(refinement(value)||requestedTimePreference(value))&&! /\b(el de|la de|primero|segundo|tercero|ultimo|ese|este|sirve|elijo|confirmo)\b/.test(value));
}

/** Unstated preferences cannot silently narrow a real database search. */
export function normalizeAvailabilitySearch(filter:AvailabilityInput,text:string,now:string,timeZone:string,therapists:Therapist[],previous?:AvailabilityInput|null):AvailabilityInput {
  const value=normalized(text),today=Temporal.Instant.from(now).toZonedDateTimeISO(timeZone).toPlainDate();
  const preference=requestedTimePreference(text);
  const followup=(/^(?:y|o|mejor|solo|solamente)\b/.test(value.trim().replace(/^[¿¡]/,''))||refinement(value)||Boolean(preference&&!freshSearch.test(value)))&&previous;
  let result:AvailabilityInput={...filter};
  result.time_preference=preference??(followup?previous.time_preference??null:null);
  if(/\b(cualquier horario|a cualquier hora|sin preferencia de horari[oa])\b/.test(value))result.time_preference=null;
  const names=namesIn(value,therapists);
  if(anyTherapist.test(value))result.therapist_id=null;
  else if(names.length===1)result.therapist_id=names[0]!.id;
  else if(names.length>1)result.therapist_id=null;
  else if(followup)result.therapist_id=previous.therapist_id;
  else result.therapist_id=null;

  const pinned=requestedLocalDate(text,now,timeZone);
  const dateText=value.replace(/\b(?:por|a|en|durante|para) la manana\b|\b(?:por|a|en|durante|para) las mananas\b|\bhorario (?:de manana|matutino)\b/g,'');
  if(pinned)result={...result,date:pinned,horizon_days:1};
  else if(/\b(?:semana que viene|proxima semana|semana proxima)\b/.test(value))result={...result,date:today.add({days:8-today.dayOfWeek}).toString(),horizon_days:7};
  else if(/\besta semana\b/.test(value))result={...result,date:today.toString(),horizon_days:8-today.dayOfWeek};
  else if(!/\b(?:hoy|manana|lunes|martes|miercoles|jueves|viernes|sabado|domingo|semana|mes|fecha|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\b|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}|\b(?:en|dentro de) (?:\d+|un|dos|tres|cuatro|cinco|seis|siete) dias?\b|\bel \d{1,2}\b/.test(dateText)){
    result={...result,date:followup?previous.date:null,horizon_days:followup?previous.horizon_days:14};
  }
  const periods=[/\b(?:la manana|las mananas|horario de manana|matutino|matutina)\b/.test(value),/\b(?:la tarde|las tardes|vespertino|vespertina)\b/.test(value),/\b(?:la noche|las noches|nocturno|nocturna)\b/.test(value)];
  if(requestedLocalTime(text)){
    result.time_preference=null;
    // Exact start times are matched after fetching real slots, not as session end bounds.
    [result.not_before,result.not_after]=periods.filter(Boolean).length===1?(periods[0]?['00:00','12:00']:periods[1]?['13:00','20:00']:['20:00','23:59']):[null,null];
    return result;
  }
  const preciseTime=/\b\d{1,2}:\d{2}\b|\b(?:despues|antes|desde|hasta|a partir|a las|entre).*\b\d{1,2}\b/.test(value);
  if(periods.filter(Boolean).length===1&&!preciseTime){
    [result.not_before,result.not_after]=periods[0]?['00:00','12:00']:periods[1]?['13:00','20:00']:['20:00','23:59'];
  }else if(!periods.some(Boolean)&&!preciseTime){
    result.not_before=followup?previous.not_before:null;result.not_after=followup?previous.not_after:null;
  }
  return result;
}
