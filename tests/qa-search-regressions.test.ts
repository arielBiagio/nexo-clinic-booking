import {describe,it,expect} from 'vitest';
import {numberedWeekdayDate,requestedLocalDate} from '../packages/agent/src/calendar.js';
import {simpleAvailabilitySearch,normalizeAvailabilitySearch,requestedLocalTime} from '../packages/agent/src/search.js';
import {renderNarration} from '../packages/agent/src/narration.js';
const now='2026-11-05T01:00:00Z',zone='America/New_York';
const people=[{id:'qa-a',name:'Vega Prueba',specialty:'Fisioterapia'},{id:'qa-b',name:'Luna Prueba',specialty:'Fisioterapia'}];
const base={therapist_id:null,date:null,not_before:null,not_after:null,horizon_days:14};
describe('QA: scheduling language regressions',()=>{
  it.each(['Hola quiero un turno para el miércoles 11 a las 10h','un turno para el miercoles 11 a las 10 h','Quisiera fisio el miércoles, 11 a las 10:00','Busco un turno el miércoles 11 de noviembre a las 10h'])('keeps the numbered date and queries every professional: %s',text=>{
    expect(requestedLocalDate(text,now,zone)).toBe('2026-11-11');
    expect(normalizeAvailabilitySearch(base,text,now,zone,people)).toMatchObject({date:'2026-11-11',therapist_id:null,horizon_days:1});
    expect(requestedLocalTime(text)).toBe('10:00');
  });
  it('routes the reported generic request directly, with no selected therapist',()=>{
    expect(simpleAvailabilitySearch('Hola quiero un turno para el miercoles 11 a las 10h',now,zone,people)).toMatchObject({date:'2026-11-11',therapist_id:null});
  });
  it('preserves an explicit professional and resolves next Wednesday in the clinic timezone',()=>{
    expect(simpleAvailabilitySearch('quiero un turno con Vega para el miercoles proximo a las 10h',now,zone,people)).toMatchObject({date:'2026-11-11',therapist_id:'qa-a'});
  });
  it.each(['miércoles 12 a las 10h','miércoles 32 a las 10h'])('asks instead of dropping an inconsistent numbered date: %s',text=>expect(numberedWeekdayDate(text,now,zone).needsClarification).toBe(true));
  it('asks for a month when two numbered Wednesdays fit the supported horizon',()=>expect(numberedWeekdayDate('miércoles 11','2026-02-05T15:00:00Z',zone).needsClarification).toBe(true));
  it.each(['miércoles 10 h','miércoles 10 am','miércoles 10:00'])('does not mistake a clock suffix for a calendar day: %s',text=>expect(numberedWeekdayDate(text,now,zone).needsClarification).toBe(false));
  it('resolves a numbered weekday across the year boundary',()=>expect(requestedLocalDate('lunes 4 de enero de 2027','2026-12-28T15:00:00Z',zone)).toBe('2027-01-04'));
  it('does not confuse a morning window with tomorrow',()=>expect(simpleAvailabilitySearch('Quiero un turno por la mañana',now,zone,people)).toMatchObject({date:null,not_before:'00:00',not_after:'12:00'}));
  it('does not inherit a former therapist on a fresh generic request',()=>expect(normalizeAvailabilitySearch(base,'Quiero un turno el viernes por la tarde',now,zone,people,{...base,therapist_id:'qa-a'}).therapist_id).toBeNull());
  it('does not choose a different person who shares the requested surname',()=>expect(simpleAvailabilitySearch('Quiero un turno con Vega Prueba',now,zone,people)?.therapist_id).toBe('qa-a'));
  it('keeps previous date and period when changing only the professional',()=>expect(simpleAvailabilitySearch('con Luna',now,zone,people,{...base,date:'2026-11-11',horizon_days:1,therapist_id:'qa-a',not_before:'13:00',not_after:'20:00'})).toMatchObject({date:'2026-11-11',therapist_id:'qa-b',not_before:'13:00',not_after:'20:00'}));
  it.each(['Quiero un turno entre las 10 y las 12','Quiero todos los lunes a las 10','Quiero un turno con una profesional desconocida','Quiero un turno el lunes o el martes'])('does not silently discard unsupported restrictions in the local fallback: %s',text=>expect(simpleAvailabilitySearch(text,now,zone,people)).toBeNull());
  it('does not turn an excluded professional into a preferred professional',()=>expect(normalizeAvailabilitySearch(base,'Quiero un turno, pero no con Vega',now,zone,people).therapist_id).not.toBe('qa-a'));
  it.each(['Quiero un turno, pero no con Vega','Quiero un turno con cualquiera menos Vega','Un turno excepto con Vega'])('keeps an explicit exclusion in the backend search: %s',text=>{
    expect(simpleAvailabilitySearch(text,now,zone,people)).toMatchObject({therapist_id:null,excluded_therapist_ids:['qa-a']});
  });
  it('keeps exclusions on day refinements but clears them for a fresh request or explicit replacement',()=>{
    const previous={...base,excluded_therapist_ids:['qa-a']};
    expect(simpleAvailabilitySearch('El martes',now,zone,people,previous)).toMatchObject({excluded_therapist_ids:['qa-a'],date:'2026-11-10'});
    expect(simpleAvailabilitySearch('Quiero un turno',now,zone,people,previous)?.excluded_therapist_ids).toBeUndefined();
    expect(simpleAvailabilitySearch('con Vega',now,zone,people,previous)).toMatchObject({therapist_id:'qa-a'});
    expect(simpleAvailabilitySearch('con Vega',now,zone,people,previous)?.excluded_therapist_ids).toBeUndefined();
  });
  it('does not exclude the positively requested therapist in a mixed request',()=>{
    expect(simpleAvailabilitySearch('Quiero un turno, no con Vega, con Luna',now,zone,people)).toMatchObject({therapist_id:'qa-b',excluded_therapist_ids:['qa-a']});
  });
  it('accepts a short negative professional refinement without changing the day',()=>{
    expect(simpleAvailabilitySearch('No con Vega',now,zone,people,{...base,date:'2026-11-11',horizon_days:1})).toMatchObject({date:'2026-11-11',excluded_therapist_ids:['qa-a']});
  });
  it('rejects an explanation that just echoes the request',()=>expect(renderNarration('Quiero un turno por la tarde.',{event:'availability',request:'quiero un turno por la tarde',facts:{},variables:{}})).toBeNull());
});
