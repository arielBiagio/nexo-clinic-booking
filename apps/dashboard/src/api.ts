import { Temporal } from '@js-temporal/polyfill';

const errors:Record<string,string> = {
  GOOGLE_NOT_CONFIGURED:'La conexión con Google todavía no está configurada en el servidor.',
  GOOGLE_RECONNECT:'Volvé a conectar tu cuenta de Google para reanudar la sincronización.',
  PATIENT_DETAILS_CHANGED:'La ficha cambió o le falta contacto. Volvé a buscarla y revisá nombre y teléfono en Conversaciones.',
  APPOINTMENT_CHANGED:'El turno cambió mientras lo editabas. Cerrá esta ventana y volvé a abrirlo desde la agenda actualizada.',
  APPOINTMENT_NOT_EDITABLE:'Solo se pueden reprogramar reservas confirmadas que todavía no comenzaron.',
  MESSAGE_NOT_FOUND:'El mensaje ya no está disponible en esta conversación.',
  IDEMPOTENCY_CONFLICT:'La solicitud ya fue procesada con otros datos. Cerrá el formulario y revisá la agenda antes de volver a reservar.',
  TIME_OFF_NOT_FOUND:'La ausencia ya no existe o no pertenece a este profesional.',
  INVALID_CREDENTIALS:'Correo o contraseña incorrectos.',
  STAFF_ACCESS_REQUIRED:'Tu cuenta no tiene un acceso activo a esta clínica.',
  FORBIDDEN:'Tu rol no tiene permiso para realizar esta acción.',
  LOGIN_RATE_LIMIT:'Hubo demasiados intentos. Esperá unos minutos antes de volver a ingresar.',
  SETUP_NOT_ALLOWED:'Usá el correo configurado para la administración inicial.',
  SETUP_ALREADY_COMPLETE:'La cuenta inicial ya fue creada. Ingresá con tu contraseña.',
  STAFF_CREATION_FAILED:'No pudimos crear el acceso. Revisá el correo y los requisitos de contraseña; puede que esa cuenta ya exista.',
  LAST_ADMIN_REQUIRED:'La clínica necesita al menos un administrador activo.',
  THERAPIST_REQUIRED:'Elegí el profesional que corresponde a esta cuenta.',
  THERAPIST_ALREADY_LINKED:'Ese profesional ya está asociado a otra cuenta.',
  SLOT_UNAVAILABLE:'Ese turno acaba de ocuparse. Elegí otro horario.',
  CONFIRMATION_REQUIRED:'La selección venció. Elegí el horario nuevamente.',
  AGENT_PAUSED:'Recepción está atendiendo esta conversación.',
  PATIENT_DETAILS_REQUIRED:'Completá nombre y teléfono en la ficha del paciente antes de reservar.',
  INVALID_SCHEDULE:'Revisá los horarios: los descansos deben estar dentro de la jornada y los períodos no pueden superponerse.',
  INVALID_INPUT:'Revisá los campos y volvé a intentar.',
  DATE_HAS_APPOINTMENTS:'Hay turnos reservados ese día. Coordiná esos cambios antes de bloquear la fecha.',
  INVALID_BLOCK_DATE:'Elegí una fecha entre hoy y las próximas seis semanas.',
  UNAUTHORIZED:'La sesión de prueba venció. Recargá la página.',
  CONVERSATION_NOT_FOUND:'Esta conversación fue eliminada o ya no está disponible.',
  APPOINTMENT_NOT_FOUND:'Ese turno ya no está disponible.',
  DELIVERY_IN_PROGRESS:'Hay una entrega en curso. Volvé a intentar en unos instantes.',
};
export async function api<T>(path:string, body?:unknown, method?:string, headers:Record<string,string>={}) : Promise<T> {
  let response:Response;
  try {
    response = await fetch(`/v1${path}`,{method:method ?? (body !== undefined ? 'POST':'GET'),credentials:'same-origin',
      headers:{...(body !== undefined ? {'Content-Type':'application/json'} : {}),...headers},...(body !== undefined ? {body:JSON.stringify(body)} : {}),signal:AbortSignal.timeout(20_000)});
  } catch { throw new Error('No pudimos conectar con la demo. Comprobá que el servidor esté encendido.'); }
  const value = await response.json();
  if (!response.ok) {
    if(!path.startsWith('/auth/')&&(response.status===401||value.error==='STAFF_ACCESS_REQUIRED'))window.dispatchEvent(new Event('nexo-auth-required'));
    throw new Error(errors[value.error] ?? 'No pudimos completar la acción. Volvé a intentar.');
  }
  return value as T;
}
export const dateAt = (instant:string,zone:string) => Temporal.Instant.from(instant).toZonedDateTimeISO(zone).toPlainDate().toString();
export const addDays = (date:string,days:number) => Temporal.PlainDate.from(date).add({days}).toString();
export const weekAt = (instant:string,zone:string) => {const date=Temporal.Instant.from(instant).toZonedDateTimeISO(zone).toPlainDate();return date.subtract({days:date.dayOfWeek-1}).toString();};
export const dayInstant = (date:string,zone:string) => Temporal.PlainDate.from(date).toZonedDateTime(zone).toInstant().toString();
export const minutesAt = (instant:string,zone:string) => { const value=Temporal.Instant.from(instant).toZonedDateTimeISO(zone);return value.hour*60+value.minute; };
export const fmtTime = (instant:string,zone:string) => new Intl.DateTimeFormat('es-AR',{hour:'2-digit',minute:'2-digit',timeZone:zone,hourCycle:'h23'}).format(new Date(instant));
export const fmtDate = (date:string,options:Intl.DateTimeFormatOptions={day:'numeric',month:'long'}) => new Intl.DateTimeFormat('es-AR',{...options,timeZone:'UTC'}).format(new Date(`${date}T12:00:00Z`));
export const initials = (name:string) => name.split(' ').slice(0,2).map(item=>item[0]).join('').toUpperCase();
export const minuteTime = (minute:number) => `${String(Math.floor(minute/60)).padStart(2,'0')}:${String(minute%60).padStart(2,'0')}`;
export const timeMinute = (time:string) => Number(time.split(':')[0])*60+Number(time.split(':')[1]);
