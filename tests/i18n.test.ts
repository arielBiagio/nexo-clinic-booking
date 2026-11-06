import { afterEach, describe, expect, it, vi } from 'vitest';
import { english } from '../apps/dashboard/src/english.js';
import { choiceLabel } from '../apps/dashboard/src/choiceLabel.js';
import { fmtDate, fmtTime } from '../apps/dashboard/src/api.js';
import { getLanguage, getLocale, setLanguage, t } from '../apps/dashboard/src/i18n.js';

afterEach(()=>{setLanguage('es');vi.unstubAllGlobals();});

describe('dashboard language preference',()=>{
 it('switches interface copy and localized dates without changing instants or patient content',()=>{
  setLanguage('en');expect(getLocale()).toBe('en-US');expect(t('Agenda')).toBe('Calendar');
  expect(fmtDate('2026-11-11',{weekday:'long',month:'long',day:'numeric'})).toBe('Wednesday, November 11');
  expect(fmtTime('2026-11-11T15:00:00Z','America/New_York')).toBe('10:00');
  const note='Paciente: José. Me duele el hombro.';expect(t(note)).toBe(note);
  setLanguage('es');expect(t('Agenda')).toBe('Agenda');expect(fmtDate('2026-11-11',{weekday:'long'})).toBe('miércoles');
 });
 it('persists the chosen language and updates the page language for assistive technology',()=>{
  const storage=new Map<string,string>();const root={lang:'es'};
  vi.stubGlobal('localStorage',{getItem:(key:string)=>storage.get(key)??null,setItem:(key:string,value:string)=>storage.set(key,value)});
  vi.stubGlobal('document',{documentElement:root});
  setLanguage('en');expect(storage.get('nexo-language')).toBe('en');expect(root.lang).toBe('en');
  setLanguage('es');expect(root.lang).toBe('es');expect(getLanguage()).toBe('es');
 });
 it('keeps switching usable when browser storage is blocked',()=>{
  vi.stubGlobal('localStorage',{setItem:()=>{throw new Error('blocked');}});
  expect(()=>setLanguage('en')).not.toThrow();expect(t('Confirmar reserva')).toBe('Confirm booking');
 });
 it('interpolates values without interpreting braces contained in patient names',()=>{
  setLanguage('en');expect(t('Reservar {0} a las {1} con {2}',['November 11','10:00','Alex {0}'])).toBe('Book November 11 at 10:00 with Alex {0}');
  expect(t('Inicio descanso {0} {1}',[2,t('Miércoles')])).toBe('Wednesday break 2 start');
 });
 it('keeps the same interpolation placeholders in every translation',()=>{
  for(const [source,translation]of Object.entries(english)){
   expect([...translation.matchAll(/\{\d+\}/g)].map(m=>m[0]).sort(),source).toEqual([...source.matchAll(/\{\d+\}/g)].map(m=>m[0]).sort());
   expect(translation.trim().length,source).toBeGreaterThan(0);
  }
 });
 it('localizes backend controls without modifying the therapist name',()=>{
  setLanguage('en');
  expect(choiceLabel('Hablar con recepción')).toBe('Talk to reception');
  expect(choiceLabel('mié, 11 nov, 10:00 · Ana del Mar')).toBe('Wed, Nov 11, 10:00 · Ana del Mar');
  expect(choiceLabel('Cancelar los 5 turnos de esa semana')).toBe('Cancel all 5 appointments that week');
  expect(choiceLabel('Sí, cancelar 3 turnos')).toBe('Yes, cancel 3 appointments');
  setLanguage('es');expect(choiceLabel('mié, 11 nov, 10:00 · Ana del Mar')).toBe('mié, 11 nov, 10:00 · Ana del Mar');
 });
});
