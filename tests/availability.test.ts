import { describe, expect, it } from 'vitest';
import { generateSlots, type WorkingRule } from '../packages/core/src/availability.js';

const rule: WorkingRule = { weekday: 1, startMinute: 540, endMinute: 1020, sessionMinutes: 45, bufferMinutes: 15,
  breaks: [{ startMinute: 720, endMinute: 780 }, { startMinute: 900, endMinute: 930 }] };
const input = { fromDate: '2030-01-07', days: 1, timeZone: 'America/New_York', rules: [rule], now: '2030-01-01T00:00:00Z' };

describe('availability rules', () => {
  it('generates local working hours, excluding multiple breaks and preserving buffer', () => {
    const slots = generateSlots(input);
    expect(slots).toHaveLength(6);
    expect(slots[0]).toEqual({ start: '2030-01-07T14:00:00Z', end: '2030-01-07T14:45:00Z', busyEnd: '2030-01-07T15:00:00Z' });
    expect(slots.map(slot => slot.start)).not.toContain('2030-01-07T17:00:00Z');
    expect(slots.map(slot => slot.start)).not.toContain('2030-01-07T20:00:00Z');
  });
  it('removes time off and booked intervals, including buffer intersections', () => {
    const slots = generateSlots({ ...input, blocked: [{ start: '2030-01-07T14:50:00Z', end: '2030-01-07T15:00:00Z' }] });
    expect(slots[0]!.start).toBe('2030-01-07T15:00:00Z');
  });
  it('never offers past or already-started slots', () => {
    const slots = generateSlots({ ...input, now: '2030-01-07T15:00:00Z' });
    expect(slots[0]!.start).toBe('2030-01-07T16:00:00Z');
  });
  it.each([
    ['spring gap', '2030-03-10'], ['autumn repeated hour', '2030-11-03'],
  ])('does not silently pick a time in the %s', (_label, date) => {
    const slots = generateSlots({ ...input, fromDate: date, rules: [{ ...rule, weekday: 7, startMinute: 60, endMinute: 240, sessionMinutes: 30, bufferMinutes: 0, breaks: [] }] });
    expect(slots.every(slot => Date.parse(slot.end) - Date.parse(slot.start) === 30 * 60_000)).toBe(true);
    expect(slots.length).toBeLessThan(6);
  });
  it('rejects conflicting working periods rather than generating overlapping slots', () => {
    expect(() => generateSlots({ ...input, rules: [rule, { ...rule, startMinute: 570 }] })).toThrow();
  });
  it('rejects malformed rules, break containment, invalid zones and unbounded horizons', () => {
    expect(() => generateSlots({ ...input, days: 61 })).toThrow();
    expect(() => generateSlots({ ...input, timeZone: 'not/a-zone' })).toThrow();
    expect(() => generateSlots({ ...input, rules: [{ ...rule, sessionMinutes: 0 }] })).toThrow();
    expect(() => generateSlots({ ...input, rules: [{ ...rule, breaks: [{ startMinute: 0, endMinute: 1 }] }] })).toThrow();
  });
});
