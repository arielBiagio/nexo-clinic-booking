import { describe, expect, it } from 'vitest';
import { calendarHints, requestedLocalDate } from '../packages/agent/src/calendar.js';

const now='2026-10-30T23:00:00Z',zone='America/New_York';
describe('clinic calendar constraints',()=>{
  it.each([
    ['El lunes después de las 15','2026-11-02'],
    ['Mañana por la mañana','2026-10-31'],
    ['Pasado mañana','2026-11-01'],
    ['Hoy','2026-10-30'],
    ['El viernes de la semana que viene','2026-11-06'],
    ['El lunes pasado','2026-10-26'],
    ['El 2026-11-09','2026-11-09'],
    ['El lunes 2 de noviembre','2026-11-02'],
  ])('resolves %s from the clinic calendar', (text,date)=>expect(requestedLocalDate(text,now,zone)).toBe(date));
  it.each(['Por la mañana','Lunes o martes','No el lunes','Cada lunes'])('leaves complex preferences for clarification: %s',text=>expect(requestedLocalDate(text,now,zone)).toBeNull());
  it('gives the model correct weekday hints across the DST change',()=>{
    const hints=calendarHints(now,zone);expect(hints.nextWeekdays.lunes).toBe('2026-11-02');expect(hints.followingWeek.viernes).toBe('2026-11-06');
  });
});
