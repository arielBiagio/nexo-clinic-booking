import { getLanguage, t } from './i18n.js';

/** Translate server-generated controls, keeping therapist names and chat messages verbatim. */
export function choiceLabel(label: string): string {
  if (getLanguage() === 'es') return label;
  const direct = t(label);
  if (direct !== label) return direct;
  const separator = label.indexOf(' · ');
  let detail = separator < 0 ? label : label.slice(0, separator);
  const therapist = separator < 0 ? '' : label.slice(separator);
  detail = detail.replace(/^Cancelar los (\d+) turnos de esa semana$/, 'Cancel all $1 appointments that week')
    .replace(/^Sí, cancelar (\d+) turnos$/, 'Yes, cancel $1 appointments')
    .replace(/^Cambiar /, 'Reschedule ').replace(/^Cancelar /, 'Cancel ').replace(/^Semana del /, 'Week of ');
  const weekdays: Record<string, string> = {lun:'Mon',mar:'Tue','mié':'Wed',jue:'Thu',vie:'Fri','sáb':'Sat',dom:'Sun'};
  const months: Record<string, string> = {ene:'Jan',feb:'Feb',mar:'Mar',abr:'Apr',may:'May',jun:'Jun',jul:'Jul',ago:'Aug',sep:'Sep',oct:'Oct',nov:'Nov',dic:'Dec'};
  detail = detail.replace(/(lun|mar|mié|jue|vie|sáb|dom)\.?(?=,)/g, day => weekdays[day.replace('.', '')] ?? day)
    .replace(/(\d{1,2})\s+(ene|feb|mar|abr|may|jun|jul|ago|sep|oct|nov|dic)\.?/g, (_, day: string, month: string) => `${months[month]} ${day}`);
  return detail + therapist;
}
