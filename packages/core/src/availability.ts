import { Temporal } from '@js-temporal/polyfill';

export interface Interval { start: string; end: string }
export interface WorkingRule {
  weekday: number; // ISO: Monday 1 ... Sunday 7
  startMinute: number;
  endMinute: number;
  sessionMinutes: number;
  bufferMinutes: number;
  breaks: { startMinute: number; endMinute: number }[];
}
export interface Slot {
  start: string;
  end: string;
  busyEnd: string;
}

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number) {
  return aStart < bEnd && bStart < aEnd;
}

export function generateSlots(input: {
  fromDate: string;
  days: number;
  timeZone: string;
  rules: WorkingRule[];
  blocked?: Interval[];
  now: string;
}): Slot[] {
  if (!Number.isInteger(input.days) || input.days < 1 || input.days > 60) {
    throw new Error('Generation horizon must be between 1 and 60 days');
  }
  const first = Temporal.PlainDate.from(input.fromDate);
  const now = Temporal.Instant.from(input.now).epochMilliseconds;
  // Validate the zone even when there are no matching working days.
  Temporal.Instant.from(input.now).toZonedDateTimeISO(input.timeZone);
  const blocked = (input.blocked ?? []).map(interval => {
    const start = Temporal.Instant.from(interval.start).epochMilliseconds;
    const end = Temporal.Instant.from(interval.end).epochMilliseconds;
    if (end <= start) throw new Error('Invalid blocked interval');
    return { start, end };
  });
  for (const rule of input.rules) {
    const values = [rule.weekday, rule.startMinute, rule.endMinute, rule.sessionMinutes, rule.bufferMinutes];
    if (values.some(value => !Number.isInteger(value)) || rule.weekday < 1 || rule.weekday > 7 ||
      rule.startMinute < 0 || rule.endMinute > 1440 || rule.endMinute <= rule.startMinute ||
      rule.sessionMinutes < 5 || rule.sessionMinutes > 240 || rule.bufferMinutes < 0 || rule.bufferMinutes > 120) {
      throw new Error('Invalid working rule');
    }
    for (const rest of rule.breaks) {
      if (!Number.isInteger(rest.startMinute) || !Number.isInteger(rest.endMinute) ||
        rest.startMinute < rule.startMinute || rest.endMinute > rule.endMinute || rest.endMinute <= rest.startMinute) {
        throw new Error('Invalid break');
      }
    }
  }
  const slots = new Map<string, Slot>();
  for (let day = 0; day < input.days; day++) {
    const date = first.add({ days: day });
    for (const rule of input.rules.filter(rule => rule.weekday === date.dayOfWeek)) {
      const step = rule.sessionMinutes + rule.bufferMinutes;
      for (let minute = rule.startMinute; minute + step <= rule.endMinute; minute += step) {
        if (rule.breaks.some(rest => overlaps(minute, minute + step, rest.startMinute, rest.endMinute))) continue;
        const local = (offset: number) => date.toPlainDateTime('00:00').add({ minutes: offset });
        let start: Temporal.ZonedDateTime;
        let end: Temporal.ZonedDateTime;
        let busyEnd: Temporal.ZonedDateTime;
        try {
          // Do not silently choose an occurrence of a repeated time or shift a nonexistent time.
          start = local(minute).toZonedDateTime(input.timeZone, { disambiguation: 'reject' });
          end = local(minute + rule.sessionMinutes).toZonedDateTime(input.timeZone, { disambiguation: 'reject' });
          busyEnd = local(minute + step).toZonedDateTime(input.timeZone, { disambiguation: 'reject' });
        } catch (error) {
          if (error instanceof RangeError) continue;
          throw error;
        }
        if (end.epochMilliseconds - start.epochMilliseconds !== rule.sessionMinutes * 60_000 ||
          busyEnd.epochMilliseconds - start.epochMilliseconds !== step * 60_000) continue;
        if (start.epochMilliseconds <= now || blocked.some(interval =>
          overlaps(start.epochMilliseconds, busyEnd.epochMilliseconds, interval.start, interval.end))) continue;
        const slot = { start: start.toInstant().toString(), end: end.toInstant().toString(), busyEnd: busyEnd.toInstant().toString() };
        const existing = slots.get(slot.start);
        if (existing && (existing.end !== slot.end || existing.busyEnd !== slot.busyEnd)) {
          throw new Error('Conflicting working rules');
        }
        slots.set(slot.start, slot);
      }
    }
  }
  const result = [...slots.values()].sort((a, b) => a.start.localeCompare(b.start));
  for (let i = 1; i < result.length; i++) {
    if (Temporal.Instant.compare(result[i - 1]!.busyEnd, result[i]!.start) > 0) {
      throw new Error('Overlapping working rules');
    }
  }
  return result;
}
