// Analytics filters, basic set for phase 1a (plan 7.5). One filter applies to
// every chart and table on a page, lives in the page link so a view can be
// shared, and every number drills down to the flags behind it.
//
// Two kinds of filter:
// - Unit and time filters choose the units and period. They apply to every
//   KPI, PA and utilisation included.
// - Downtime filters (type, system, component, field or shop, line, detection,
//   shift, crew) choose which down flags are analysed. They apply to downtime
//   hours, events, failures and Pareto. They do not change PA, because "PA
//   counting only tyre downtime" is not a PA anyone reports.

import { DateTime } from 'luxon';
import { buildEvents, computeKpis, countingFlags, flagDownHours, stageHours, type DowntimeEvent, type KpiInput, type KpiResult, type Period } from './kpis.js';
import { ms, shiftAt, type ShiftCalendar } from './time.js';
import type { Asset, DetectionMethod, DownFlag, FlagType, Iso, Stage } from './types.js';

export type RangePreset = '7d' | '28d' | '90d';

export interface AnalyticsFilter {
  /** A preset counted back from now, or local dates in the site time zone (to is inclusive). */
  range: { preset: RangePreset } | { from: string; to: string };
  fleets: string[];
  models: string[];
  /** Asset ids. */
  units: string[];
  types: FlagType[];
  systems: string[];
  /** True: everything except the chosen systems. */
  systemsExclude: boolean;
  components: string[];
  where: Array<'field' | 'shop'>;
  lines: string[];
  detection: DetectionMethod[];
  shifts: string[];
  crews: string[];
  /** Only events that count as failures (R9, D1). */
  failuresOnly: boolean;
}

export const EMPTY_FILTER: AnalyticsFilter = {
  range: { preset: '28d' },
  fleets: [], models: [], units: [], types: [], systems: [], systemsExclude: false, components: [],
  where: [], lines: [], detection: [], shifts: [], crews: [], failuresOnly: false,
};

// ---------- the link ----------

const LIST_KEYS: Array<[keyof AnalyticsFilter, string]> = [
  ['fleets', 'fleet'], ['models', 'model'], ['units', 'unit'], ['types', 'type'], ['systems', 'system'], ['components', 'component'],
  ['where', 'where'], ['lines', 'line'], ['detection', 'detection'], ['shifts', 'shift'], ['crews', 'crew'],
];

export function filterToQuery(f: AnalyticsFilter): string {
  const q = new URLSearchParams();
  if ('preset' in f.range) { if (f.range.preset !== '28d') q.set('range', f.range.preset); }
  else { q.set('from', f.range.from); q.set('to', f.range.to); }
  for (const [k, name] of LIST_KEYS) {
    const v = f[k] as string[];
    if (v.length) q.set(name, v.join(','));
  }
  if (f.systemsExclude && f.systems.length) q.set('except', '1');
  if (f.failuresOnly) q.set('failures', '1');
  return q.toString();
}

export function filterFromQuery(query: string): AnalyticsFilter {
  const q = new URLSearchParams(query);
  const f: AnalyticsFilter = structuredClone(EMPTY_FILTER);
  const from = q.get('from');
  const to = q.get('to');
  const date = /^\d{4}-\d{2}-\d{2}$/;
  if (from && to && date.test(from) && date.test(to)) f.range = from <= to ? { from, to } : { from: to, to: from };
  else {
    const r = q.get('range');
    if (r === '7d' || r === '28d' || r === '90d') f.range = { preset: r };
  }
  for (const [k, name] of LIST_KEYS) {
    const v = q.get(name);
    if (v) (f[k] as string[]) = v.split(',').map((x) => x.trim()).filter(Boolean);
  }
  f.systemsExclude = q.get('except') === '1';
  f.failuresOnly = q.get('failures') === '1';
  return f;
}

// ---------- applying it ----------

const DAYS: Record<RangePreset, number> = { '7d': 7, '28d': 28, '90d': 90 };

/** The period, in the site time zone. A custom range runs from 00:00 on the first day to 24:00 on the last. */
export function filterPeriod(f: AnalyticsFilter, timeZone: string, now: Iso): Period {
  if ('preset' in f.range) return { from: new Date(ms(now) - DAYS[f.range.preset] * 864e5).toISOString(), to: now };
  const from = DateTime.fromISO(f.range.from, { zone: timeZone }).startOf('day');
  const to = DateTime.fromISO(f.range.to, { zone: timeZone }).plus({ days: 1 }).startOf('day');
  const end = Math.min(ms(to.toUTC().toISO()!), ms(now));
  return { from: from.toUTC().toISO()!, to: new Date(Math.max(end, ms(from.toUTC().toISO()!))).toISOString() };
}

export function filterAssets(assets: Asset[], f: AnalyticsFilter): Asset[] {
  return assets.filter((a) =>
    (!f.fleets.length || f.fleets.includes(a.fleet)) &&
    (!f.models.length || f.models.includes(a.model)) &&
    (!f.units.length || f.units.includes(a.id)));
}

export const flagSystem = (fl: DownFlag): string => fl.release?.system ?? fl.system ?? fl.reasonCode;

/** Field: never reached a shop. Shop: spent time in the yard or a line. */
export const flagWhere = (fl: DownFlag): 'field' | 'shop' =>
  fl.locations.some((l) => l.kind === 'shop_line' || l.kind === 'shop_yard') ? 'shop' : 'field';

export function flagMatches(fl: DownFlag, f: AnalyticsFilter, calendar: ShiftCalendar): boolean {
  if (f.types.length && !f.types.includes(fl.type)) return false;
  if (f.systems.length && f.systems.includes(flagSystem(fl)) === f.systemsExclude) return false;
  if (f.components.length && !f.components.includes(fl.release?.component ?? '')) return false;
  if (f.where.length && !f.where.includes(flagWhere(fl))) return false;
  if (f.lines.length && !fl.locations.some((l) => l.shopLineId && f.lines.includes(l.shopLineId))) return false;
  if (f.detection.length && !f.detection.includes(fl.release?.detectionMethod as DetectionMethod)) return false;
  if (f.shifts.length || f.crews.length) {
    const sh = shiftAt(calendar, fl.start);
    if (f.shifts.length && !f.shifts.includes(sh.name)) return false;
    if (f.crews.length && !f.crews.includes(sh.crew ?? '')) return false;
  }
  return true;
}

export function hasDowntimeFilters(f: AnalyticsFilter): boolean {
  return !!(f.types.length || f.systems.length || f.components.length || f.where.length || f.lines.length || f.detection.length || f.shifts.length || f.crews.length || f.failuresOnly);
}

export interface FilteredEvent {
  event: DowntimeEvent;
  /** The event's flags that match the downtime filters. */
  flags: DownFlag[];
  /** Down hours of the matching flags inside the period. */
  hours: number;
}

export interface FilteredAnalysis {
  period: Period;
  now: Iso;
  assets: Asset[];
  /** Unit and time filters only. */
  kpis: KpiResult;
  /** Events that start in the period and have at least one matching flag. */
  events: FilteredEvent[];
  downHours: number;
  failures: number;
  stageHours: Record<Stage, number>;
}

/** `period` overrides the filter's own range (used for before-and-after windows). */
export function analyse(input: KpiInput & { calendar: ShiftCalendar; timeZone: string }, f: AnalyticsFilter, period: Period = filterPeriod(f, input.timeZone, input.now)): FilteredAnalysis {
  const assets = filterAssets(input.assets, f);
  const ids = new Set(assets.map((a) => a.id));
  const unitFlags = countingFlags(input.flags).filter((fl) => ids.has(fl.unitId));
  const kpis = computeKpis({ ...input, assets }, period);
  const stages: Record<Stage, number> = { waiting_crew: 0, in_transit: 0, waiting_line: 0, in_repair: 0, waiting_parts: 0, waiting_labour: 0, waiting_other: 0, ready_for_release: 0 };
  const events: FilteredEvent[] = [];
  for (const ev of buildEvents(unitFlags, input.rules, input.now)) {
    if (ms(ev.start) < ms(period.from) || ms(ev.start) >= ms(period.to)) continue;
    if (f.failuresOnly && !ev.isFailure) continue;
    const flags = ev.flags.filter((fl) => flagMatches(fl, f, input.calendar));
    if (!flags.length) continue;
    const hours = flags.reduce((s, fl) => s + flagDownHours(fl, period, input.now), 0);
    for (const fl of flags) {
      const sh = stageHours(fl, period, input.now);
      for (const k of Object.keys(sh) as Stage[]) stages[k] += sh[k];
    }
    events.push({ event: ev, flags, hours });
  }
  return {
    period,
    now: input.now,
    assets,
    kpis,
    events,
    downHours: events.reduce((s, e) => s + e.hours, 0),
    failures: events.filter((e) => e.event.isFailure).length,
    stageHours: stages,
  };
}

export type ParetoKey = 'system' | 'component' | 'failure_mode' | 'unit' | 'reason';

/** Downtime hours of the matching flags, grouped and sorted largest first, with the cumulative share. */
export function paretoOf(a: FilteredAnalysis, by: ParetoKey, unitName: (id: string) => string) {
  const key = (fl: DownFlag): string => {
    switch (by) {
      case 'system': return flagSystem(fl);
      case 'component': return fl.release?.component ?? 'Not recorded';
      case 'failure_mode': return fl.release?.failureModes?.[0] ?? 'Not recorded';
      case 'unit': return unitName(fl.unitId);
      case 'reason': return fl.reasonCode;
    }
  };
  const rows = new Map<string, { hours: number; events: Set<string> }>();
  for (const e of a.events) {
    for (const fl of e.flags) {
      const k = key(fl);
      const r = rows.get(k) ?? { hours: 0, events: new Set() };
      r.hours += flagDownHours(fl, a.period, a.now);
      r.events.add(e.event.id);
      rows.set(k, r);
    }
  }
  const total = [...rows.values()].reduce((s, r) => s + r.hours, 0);
  let cum = 0;
  return [...rows.entries()]
    .map(([k, r]) => ({ key: k, hours: r.hours, events: r.events.size }))
    .sort((x, y) => y.hours - x.hours)
    .map((r) => {
      cum += r.hours;
      return { ...r, share: total ? r.hours / total : 0, cumulative: total ? cum / total : 0 };
    });
}

/** Matching downtime hours and failures by week (Monday 00:00 site time) across the period. */
export function weeklyTrend(a: FilteredAnalysis, timeZone: string) {
  const out: Array<{ week: string; from: Iso; hours: number; failures: number; events: number }> = [];
  let w = DateTime.fromISO(a.period.from, { zone: timeZone }).startOf('week');
  const end = ms(a.period.to);
  while (ms(w.toUTC().toISO()!) < end) {
    const s = ms(w.toUTC().toISO()!);
    const e = ms(w.plus({ weeks: 1 }).toUTC().toISO()!);
    const inWeek = a.events.filter((x) => ms(x.event.start) >= s && ms(x.event.start) < e);
    out.push({ week: w.toFormat('dd LLL'), from: w.toUTC().toISO()!, hours: inWeek.reduce((t, x) => t + x.hours, 0), failures: inWeek.filter((x) => x.event.isFailure).length, events: inWeek.length });
    w = w.plus({ weeks: 1 });
  }
  return out;
}
