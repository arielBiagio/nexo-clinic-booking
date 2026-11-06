import { describe,expect,it } from 'vitest';
import { isAvailabilityRequest,normalizeAvailabilitySearch } from '../packages/agent/src/search.js';
import type { AvailabilityInput } from '../packages/agent/src/openrouter.js';
const zone='America/New_York',now='2026-10-31T01:00:00Z'; // Friday night at the clinic.
const therapists=[{id:'a',name:'Alex Demo',specialty:'Terapia física'},{id:'b',name:'Sam Demo',specialty:'Rehabilitación'}];
const guessed:AvailabilityInput={therapist_id:'a',date:'2026-10-31',not_before:'15:00',not_after:null,horizon_days:1};
describe('availability search semantics',()=>{
  it('recognizes the default physio service and does not assign an arbitrary therapist',()=>{
    const text='Quiero fisio el lunes por la tarde con cualquier terapeuta';
    expect(isAvailabilityRequest(text,therapists)).toBe(true);
    expect(normalizeAvailabilitySearch(guessed,text,now,zone,therapists).therapist_id).toBeNull();
  });
  it('keeps previous preferences when the patient replies with only a day',()=>{
    const previous={...guessed,therapist_id:'b',date:null,horizon_days:14,not_before:'13:00',not_after:'20:00'};
    expect(isAvailabilityRequest('El martes por la tarde',therapists,previous)).toBe(true);
    expect(normalizeAvailabilitySearch(guessed,'El martes',now,zone,therapists,previous)).toEqual({...previous,date:'2026-11-03',horizon_days:1,time_preference:null});
  });
  it.each(['quiero un turno disponible para la tarde','¿Tenés horarios por la tarde?','Me gustaría ver disponibilidad por la tarde'])('routes a read-only request without contact: %s',text=>{
    expect(isAvailabilityRequest(text,therapists)).toBe(true);
    expect(normalizeAvailabilitySearch(guessed,text,now,zone,therapists)).toEqual({therapist_id:null,date:null,horizon_days:14,not_before:'13:00',not_after:'20:00',time_preference:null});
  });
  it.each(['Quiero hablar con una persona para pedir un turno','Quiero cancelar mi turno','Me llamo Martina, quiero un turno','Mi teléfono es 2025550108 y quiero un turno','Quiero un turno con el doctor Pérez','Quiero confirmar ese horario','¿Hay turnos y qué tratamiento necesito?'])('leaves intake, unknown professionals and non-search actions to their existing flow: %s',text=>expect(isAvailabilityRequest(text,therapists)).toBe(false));
  it.each(['Por la mañana','Durante la mañana','En horario de mañana','Para la mañana'])('does not confuse a morning period with tomorrow: %s',text=>{
    expect(normalizeAvailabilitySearch(guessed,`Quiero un turno ${text}`,now,zone,therapists)).toMatchObject({date:null,horizon_days:14,not_before:'00:00',not_after:'12:00'});
  });
  it('respects a specific day and professional, without widening the date silently',()=>{
    expect(normalizeAvailabilitySearch(guessed,'Un turno con Sam mañana por la tarde',now,zone,therapists)).toEqual({therapist_id:'b',date:'2026-10-31',horizon_days:1,not_before:'13:00',not_after:'20:00',time_preference:null});
  });
  it('uses the whole requested week rather than tomorrow only',()=>{
    expect(normalizeAvailabilitySearch(guessed,'Quiero un turno por la tarde esta semana',now,zone,therapists)).toMatchObject({date:'2026-10-30',horizon_days:3});
    expect(normalizeAvailabilitySearch(guessed,'Quiero un turno por la tarde la semana que viene',now,zone,therapists)).toMatchObject({date:'2026-11-02',horizon_days:7});
  });
  it('keeps day/professional on a short time-period followup',()=>{
    const previous={...guessed,date:'2026-11-02',therapist_id:'b'};
    expect(normalizeAvailabilitySearch(guessed,'¿Y para la tarde?',now,zone,therapists,previous)).toEqual({...previous,not_before:'13:00',not_after:'20:00',time_preference:null});
    expect(normalizeAvailabilitySearch(guessed,'¿Y para la mañana?',now,zone,therapists,previous)).toEqual({...previous,not_before:'00:00',not_after:'12:00',time_preference:null});
  });
  it('preserves precise requested times instead of replacing them with a generic afternoon bound',()=>{
    expect(normalizeAvailabilitySearch(guessed,'Busco un turno después de las 15',now,zone,therapists)).toMatchObject({not_before:'15:00',date:null,horizon_days:14});
  });
});
