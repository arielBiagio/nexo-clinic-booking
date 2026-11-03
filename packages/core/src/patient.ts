import { z } from 'zod';

export const patientDetailsInput = z.strictObject({
  name:z.string().trim().min(2).max(70).optional(),
  phone:z.string().trim().max(40).regex(/^\+?[\d\s().-]+$/).transform(v=>v.replace(/[\s().-]/g,'')).pipe(z.string().regex(/^\+?\d{7,15}$/)).optional(),
  insurance:z.string().trim().max(120).optional(),
  reported_reason:z.string().trim().max(400).optional(),
  additional_info:z.string().trim().max(600).optional(),
}).refine(value=>Object.keys(value).length>0);
export type PatientPatch=z.infer<typeof patientDetailsInput>;
export interface PatientDetails extends Record<string,unknown> {
  name:string;name_collected:boolean;phone:string|null;insurance:string|null;
  reported_reason:string|null;additional_info:string|null;intake_summary:string;details_updated_at:Date|string|null;
}
export const missingContact=(p:PatientDetails)=>[...(!p.name_collected?['nombre']:[]),...(!p.phone?['teléfono']:[])];
export function patientSummary(p:PatientDetails) {
  return [p.name_collected?`Nombre: ${p.name}.`:null,p.phone?`Teléfono: ${p.phone}.`:null,
    p.insurance?`Seguro de salud: ${p.insurance}.`:null,p.reported_reason?`Motivo referido por el paciente (no verificado): ${p.reported_reason}.`:null,
    p.additional_info?`Información adicional: ${p.additional_info}.`:null].filter(Boolean).join('\n');
}
const normalize=(v:string)=>v.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\s+/g,' ').trim();
/** Store only explicit patient statements, without deriving a diagnosis or answering advice. */
export function explicitPatientInfo(message:string):PatientPatch|null {
  const value=normalize(message);
  if(/[?¿]/.test(message)||/\b(que hago|que debo|que recomendas|que me recomendas|como (?:trato|curo)|deberia|es grave|ejercicios|recomiend|tratamiento|urgente|urgencia)\b/.test(value))return null;
  const diagnosis=message.match(/\b(?:mi |el )?diagn[oó]stico\s*(?:es\s+|:\s*)(.+)$/i)
    ??message.match(/\b(?:me diagnosticaron|me dijeron que tengo|tengo diagnosticad[oa])\s+(.+)$/i);
  if(diagnosis?.[1]&&diagnosis[1].length<=400)return {reported_reason:diagnosis[1].trim()};
  const info=message.match(/\b(?:informaci[oó]n (?:relevante|adicional)|dato (?:relevante|adicional))\s*:\s*(.+)$/i)
    ??message.match(/\b(?:anot[aá]|guard[aá]|ten[eé] en cuenta)\s+(?:que\s+)?(.+)$/i);
  if(info?.[1]&&info[1].length<=600&&!/\b(turno|horario|cancel|reserv|reprogram|cambi|confirm|prompt|instruccion)\b/.test(normalize(info[1])))return {additional_info:info[1].trim()};
  if(/^(?:ademas[, ]+|por cierto[, ]+)?(?:tengo|sufro|padezco|presento)\b/.test(value)&&/\b(dolor|molestia|lesion|lumbalgia|tendinitis|esguince|hernia|fractura)\b/.test(value)&&message.length<=400)return {reported_reason:message.trim()};
  return null;
}
/** Extracted facts must occur in the latest patient message, never in instructions/history. */
export function groundedPatientPatch(details:Record<string,string|null>,message:string):PatientPatch {
  const patch:Record<string,string>={};
  for(const [key,value] of Object.entries(details)) {
    if(!value?.trim())continue;
    const grounded=key==='phone'?message.replace(/\D/g,'').includes(value.replace(/\D/g,'')):normalize(message).includes(normalize(value));
    if(grounded)patch[key]=value;
  }
  return patientDetailsInput.parse(patch);
}
