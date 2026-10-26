// Time helpers: site time zone, shift calendar and the reporting split (A7 R6).
// The stored record is never split; these functions split copies for reports.

import { DateTime } from 'luxon';
import type { Iso } from './types.js';

export const HOUR_MS = 3_600_000;

export function ms(iso: Iso): number {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new Error(`Invalid timestamp: ${iso}`);
  return t;
}

export function hoursBetween(a: Iso, b: Iso): number {
  return (ms(b) - ms(a)) / HOUR_MS;
}

export function toIso(t: number): Iso {
  return new Date(t).toISOString();
}

/** Overlap in hours between [aStart, aEnd) and [bStart, bEnd). A null end means "still open" and is capped at `now`. */
export function overlapHours(aStart: Iso, aEnd: Iso | null, bStart: Iso, bEnd: Iso, now?: Iso): number {
  const ae = aEnd ?? now ?? bEnd;
  const s = Math.max(ms(aStart), ms(bStart));
  const e = Math.min(ms(ae), ms(bEnd));
  return e > s ? (e - s) / HOUR_MS : 0;
}

export interface ShiftDefinition {
  name: string;
  /** Local start time, "HH:mm". */
  startLocal: string;
}

export interface CrewRotation {
  /** Local date (YYYY-MM-DD) on which pattern[0] applies. */
  anchorDate: string;
  /** One entry per day of the cycle: shift name → crew. */
  pattern: Array<Record<string, string>>;
}

export interface ShiftCalendar {
  timeZone: string;
  /** Shifts in the order they start each day. Each runs until the next one starts. */
  shifts: ShiftDefinition[];
  rotation?: CrewRotation;
}

export interface ShiftInstance {
  name: string;
  /** Local date the shift started on. A night shift starting 18:00 on the 26th belongs to the 26th. */
  shiftDate: string;
  start: Iso;
  end: Iso;
  crew?: string;
}

/** 12-hour day and night shifts changing at 06:00 and 18:00, with a 4-crew, 8-day rotation (A, B on, C, D off, etc.). */
export function twelveHourCalendar(timeZone: string, rotationAnchor = '2026-01-01'): ShiftCalendar {
  return {
    timeZone,
    shifts: [
      { name: 'day', startLocal: '06:00' },
      { name: 'night', startLocal: '18:00' },
    ],
    rotation: {
      anchorDate: rotationAnchor,
      pattern: [
        { day: 'A', night: 'C' },
        { day: 'A', night: 'C' },
        { day: 'A', night: 'C' },
        { day: 'A', night: 'C' },
        { day: 'B', night: 'D' },
        { day: 'B', night: 'D' },
        { day: 'B', night: 'D' },
        { day: 'B', night: 'D' },
      ],
    },
  };
}

function shiftStartsForDate(cal: ShiftCalendar, localDate: string): Array<{ name: string; start: DateTime }> {
  return cal.shifts.map((s) => ({
    name: s.name,
    start: DateTime.fromISO(`${localDate}T${s.startLocal}`, { zone: cal.timeZone }),
  }));
}

function crewFor(cal: ShiftCalendar, name: string, shiftDate: string): string | undefined {
  const r = cal.rotation;
  if (!r || r.pattern.length === 0) return undefined;
  const days = Math.round(
    DateTime.fromISO(shiftDate, { zone: cal.timeZone }).diff(DateTime.fromISO(r.anchorDate, { zone: cal.timeZone }), 'days').days,
  );
  const n = r.pattern.length;
  const idx = ((days % n) + n) % n;
  return r.pattern[idx]?.[name];
}

/** Every shift instance overlapping [from, to). Handles night shifts across midnight and DST changes. */
export function shiftsBetween(cal: ShiftCalendar, from: Iso, to: Iso): ShiftInstance[] {
  const startLocal = DateTime.fromISO(from, { zone: cal.timeZone }).minus({ days: 1 }).startOf('day');
  const endLocal = DateTime.fromISO(to, { zone: cal.timeZone }).plus({ days: 1 }).startOf('day');
  const starts: Array<{ name: string; start: DateTime; shiftDate: string }> = [];
  for (let d = startLocal; d <= endLocal; d = d.plus({ days: 1 })) {
    const date = d.toISODate()!;
    for (const s of shiftStartsForDate(cal, date)) starts.push({ ...s, shiftDate: date });
  }
  starts.sort((a, b) => a.start.toMillis() - b.start.toMillis());
  const out: ShiftInstance[] = [];
  const fromMs = ms(from);
  const toMs = ms(to);
  for (let i = 0; i < starts.length - 1; i++) {
    const s = starts[i]!;
    const e = starts[i + 1]!;
    if (e.start.toMillis() <= fromMs || s.start.toMillis() >= toMs) continue;
    out.push({
      name: s.name,
      shiftDate: s.shiftDate,
      start: s.start.toUTC().toISO()!,
      end: e.start.toUTC().toISO()!,
      crew: crewFor(cal, s.name, s.shiftDate),
    });
  }
  return out;
}

export function shiftAt(cal: ShiftCalendar, at: Iso): ShiftInstance {
  const t = ms(at);
  const s = shiftsBetween(cal, at, toIso(t + 1)).find((x) => ms(x.start) <= t && t < ms(x.end));
  if (!s) throw new Error(`No shift found at ${at}`);
  return s;
}

export interface ReportPiece {
  start: Iso;
  end: Iso;
  hours: number;
  shift: string;
  shiftDate: string;
  crew?: string;
  /** Local calendar date of this piece. */
  localDate: string;
  /** Local month, YYYY-MM. */
  month: string;
}

/**
 * Split an interval at shift, local-day and local-month boundaries for reporting (A7 R6).
 * An open interval (end = null) is cut at `now`.
 */
export function splitForReporting(cal: ShiftCalendar, start: Iso, end: Iso | null, now?: Iso): ReportPiece[] {
  const endIso = end ?? now;
  if (!endIso) throw new Error('Open interval needs `now` to split');
  if (ms(endIso) <= ms(start)) return [];
  const pieces: ReportPiece[] = [];
  for (const sh of shiftsBetween(cal, start, endIso)) {
    const s = Math.max(ms(start), ms(sh.start));
    const e = Math.min(ms(endIso), ms(sh.end));
    if (e <= s) continue;
    // Split this shift piece again at local midnight (month boundaries are always at a midnight).
    let cursor = s;
    while (cursor < e) {
      const local = DateTime.fromMillis(cursor, { zone: cal.timeZone });
      const nextMidnight = local.plus({ days: 1 }).startOf('day').toMillis();
      const pieceEnd = Math.min(e, nextMidnight);
      pieces.push({
        start: toIso(cursor),
        end: toIso(pieceEnd),
        hours: (pieceEnd - cursor) / HOUR_MS,
        shift: sh.name,
        shiftDate: sh.shiftDate,
        crew: sh.crew,
        localDate: local.toISODate()!,
        month: local.toFormat('yyyy-MM'),
      });
      cursor = pieceEnd;
    }
  }
  return pieces;
}

/** Local-time helper for tests and seed data: "2026-10-26 08:02" in the site zone → UTC ISO. */
export function local(timeZone: string, text: string): Iso {
  const dt = DateTime.fromFormat(text, 'yyyy-MM-dd HH:mm', { zone: timeZone });
  if (!dt.isValid) throw new Error(`Bad local time: ${text}`);
  return dt.toUTC().toISO()!;
}

/** The last `n` reporting weeks (Monday 00:00 site time), oldest first. The last one may be partial. */
export function recentWeeks(timeZone: string, now: Iso, n: number): Array<{ from: Iso; to: Iso; label: string }> {
  const thisMonday = DateTime.fromISO(now, { zone: timeZone }).startOf('week');
  const out: Array<{ from: Iso; to: Iso; label: string }> = [];
  for (let i = n - 1; i >= 0; i--) {
    const s = thisMonday.minus({ weeks: i });
    const e = s.plus({ weeks: 1 });
    out.push({ from: s.toUTC().toISO()!, to: (ms(e.toUTC().toISO()!) > ms(now) ? now : e.toUTC().toISO()!), label: s.toFormat('dd LLL') });
  }
  return out;
}
