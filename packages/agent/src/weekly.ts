import { z } from 'zod';

export const weeklyInput=z.strictObject({
  week_start:z.iso.date().nullable(),
  local_time:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable(),
  therapist_id:z.uuid().nullable(),
  weekdays:z.array(z.number().int().min(1).max(7)).min(1).max(7).nullable(),
  reference_appointment_id:z.uuid().nullable(),
});
export type WeeklyInput=z.infer<typeof weeklyInput>;
export const normalizeWeeklyText=(text:string)=>text.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
export function isWeeklyBookingRequest(text:string){
  const value=normalizeWeeklyText(text);
  if(/^\s*no\b/.test(value)||/\b(cancel|anul|reprogram|cambiar|mover)/.test(value))return false;
  return /\b(toda (?:la |una |esta |esa |la proxima )?semana|todas? las? semanas?|semana completa|todos los dias|cada dia|lunes a viernes|all week|every day)\b/.test(value);
}
export function isWeeklyConfirmation(text:string){
  const value=normalizeWeeklyText(text).replace(/[¡!¿?,.;:]/g,' ').replace(/\s+/g,' ').trim();
  return /^(si(?: confirmo)?(?: la semana| todos(?: los turnos)?| todos esos turnos| la reserva semanal)?|confirmo(?: la semana| todos(?: los turnos)?| la reserva semanal)|reservalos todos)$/.test(value);
}
