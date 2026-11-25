// Shop line usage over time (docs/shop-lines.md section 4, KPI-047). KPI-009 for every day, week,
// month or year of a period, with the occupied time split into worked (stage In repair) and idle.
// Pure functions. Periods are cut in the site time zone (rule 7), and durations are calculated from
// the timed location and stage intervals, never typed (rule 4).

import { DateTime } from 'luxon';
import { countingFlags, lineOccupancy, type Period } from './kpis.js';
import { HOUR_MS, ms, toIso } from './time.js';
import type { DownFlag, Iso, ShopLine, ShopLineClosure } from './types.js';

export type UsageGrouping = 'day' | 'week' | 'month' | 'year';

export const USAGE_GROUPINGS: ReadonlyArray<{ value: UsageGrouping; label: string }> = [
  { value: 'day', label: 'Daily' },
  { value: 'week', label: 'Weekly' },
  { value: 'month', label: 'Monthly' },
  { value: 'year', label: 'Yearly' },
];

export interface UsageGroup {
  from: Iso;
  to: Iso;
  label: string;
}

const UNIT: Record<UsageGrouping, 'day' | 'week' | 'month' | 'year'> = { day: 'day', week: 'week', month: 'month', year: 'year' };

/**
 * Cut [from, to) into whole site-time days, weeks (Monday), months or years. The first and last
 * groups are cut to the period, so their hours are the hours inside it.
 */
export function usageGroups(p: Period, grouping: UsageGrouping, timeZone: string): UsageGroup[] {
  const end = ms(p.to);
  const out: UsageGroup[] = [];
  if (!(end > ms(p.from))) return out;
  let cur = DateTime.fromMillis(ms(p.from), { zone: timeZone }).startOf(UNIT[grouping]);
  while (cur.toMillis() < end) {
    const next = cur.plus({ [UNIT[grouping]]: 1 });
    const from = Math.max(cur.toMillis(), ms(p.from));
    const to = Math.min(next.toMillis(), end);
    out.push({ from: toIso(from), to: toIso(to), label: groupLabel(cur, grouping) });
    cur = next;
  }
  return out;
}

function groupLabel(d: DateTime, g: UsageGrouping): string {
  if (g === 'year') return d.toFormat('yyyy');
  if (g === 'month') return d.toFormat('LLL yyyy');
  if (g === 'week') return `Wk of ${d.toFormat('LLL d')}`;
  return d.toFormat('LLL d');
}

/** A sensible grouping for a period, so a chart has neither hundreds of bars nor one. */
export function defaultGrouping(p: Period): UsageGrouping {
  const days = (ms(p.to) - ms(p.from)) / (24 * HOUR_MS);
  if (days <= 45) return 'day';
  if (days <= 180) return 'week';
  if (days <= 1100) return 'month';
  return 'year';
}

export interface LineGroupUsage {
  openHours: number;
  occupiedHours: number;
  /** Occupied hours with the unit In repair. */
  workedHours: number;
  /** Occupied minus worked: occupied but not being worked on. */
  idleHours: number;
  /** Null when the line was closed the whole group. */
  usage: number | null;
}

export interface LineUsageRow {
  line: ShopLine;
  total: LineGroupUsage & { visits: number; units: number };
  /** One per group, in order. */
  groups: LineGroupUsage[];
}

export interface LineUsageResult {
  groups: UsageGroup[];
  rows: LineUsageRow[];
  /** Over the lines shown: Σ occupied ÷ Σ (open × capacity). */
  fleet: { total: LineGroupUsage; groups: LineGroupUsage[] };
}

export interface UsagePreset { key: string; label: string; period: Period }

/** Common periods in site time. "To" is the end of the period, or now for one still running. */
export function usagePresets(timeZone: string, now: Iso): UsagePreset[] {
  const n = DateTime.fromMillis(ms(now), { zone: timeZone });
  const startOfMonth = n.startOf('month');
  const iso = (d: DateTime) => toIso(d.toMillis());
  return [
    { key: 'this_month', label: 'This month', period: { from: iso(startOfMonth), to: now } },
    { key: 'last_month', label: 'Last month', period: { from: iso(startOfMonth.minus({ month: 1 })), to: iso(startOfMonth) } },
    { key: 'last_3_months', label: 'Last 3 months', period: { from: iso(startOfMonth.minus({ months: 2 })), to: now } },
    { key: 'ytd', label: 'Year to date', period: { from: iso(n.startOf('year')), to: now } },
    { key: 'last_12_months', label: 'Last 12 months', period: { from: iso(startOfMonth.minus({ months: 11 })), to: now } },
    { key: 'last_year', label: 'Last year', period: { from: iso(n.startOf('year').minus({ year: 1 })), to: iso(n.startOf('year')) } },
  ];
}

const ratio = (n: number, d: number): number | null => (d > 0 ? n / d : null);

/** Hours of [aS, aE) ∩ [bS, bE) ∩ [cS, cE), in ms. */
function triple(a: [number, number], b: [number, number], c: [number, number]): number {
  const s = Math.max(a[0], b[0], c[0]);
  const e = Math.min(a[1], b[1], c[1]);
  return e > s ? e - s : 0;
}

/** Occupied hours on `line` inside [from, to) where the flag's stage was In repair. */
function workedHoursOnLine(line: ShopLine, flags: DownFlag[], from: number, to: number, now: Iso): number {
  let acc = 0;
  for (const f of countingFlags(flags)) {
    const stop = ms(f.end ?? now);
    for (const l of f.locations) {
      if (l.kind !== 'shop_line' || l.shopLineId !== line.id) continue;
      const loc: [number, number] = [ms(l.start), ms(l.end ?? f.end ?? now)];
      for (const s of f.stages) {
        if (s.stage !== 'in_repair') continue;
        acc += triple(loc, [ms(s.start), s.end ? ms(s.end) : stop], [from, to]);
      }
    }
  }
  return acc / HOUR_MS;
}

function visitsAndUnits(line: ShopLine, flags: DownFlag[], p: Period, now: Iso): { visits: number; units: Set<string> } {
  let visits = 0;
  const units = new Set<string>();
  for (const f of countingFlags(flags)) {
    for (const l of f.locations) {
      if (l.kind !== 'shop_line' || l.shopLineId !== line.id) continue;
      const s = ms(l.start);
      const e = ms(l.end ?? f.end ?? now);
      if (e > ms(p.from) && s < ms(p.to)) {
        visits += 1;
        units.add(f.unitId);
      }
    }
  }
  return { visits, units };
}

function usageFor(line: ShopLine, flags: DownFlag[], closures: ShopLineClosure[], p: Period, now: Iso): LineGroupUsage {
  const o = lineOccupancy(line, flags, closures, p, now);
  const worked = Math.min(o.occupiedHours, workedHoursOnLine(line, flags, ms(p.from), ms(p.to), now));
  return {
    openHours: o.openHours,
    occupiedHours: o.occupiedHours,
    workedHours: worked,
    idleHours: Math.max(0, o.occupiedHours - worked),
    usage: o.openHours > 0 ? o.occupancy : null,
  };
}

function sum(parts: Array<{ openHours: number; occupiedHours: number; workedHours: number }>, capacities: number[]): LineGroupUsage {
  let open = 0;
  let occ = 0;
  let worked = 0;
  let cap = 0;
  parts.forEach((x, i) => {
    open += x.openHours;
    occ += x.occupiedHours;
    worked += x.workedHours;
    cap += x.openHours * capacities[i]!;
  });
  return { openHours: open, occupiedHours: occ, workedHours: worked, idleHours: Math.max(0, occ - worked), usage: ratio(occ, cap) };
}

export function lineUsage(input: {
  lines: ShopLine[];
  flags: DownFlag[];
  closures: ShopLineClosure[];
  period: Period;
  grouping: UsageGrouping;
  timeZone: string;
  now: Iso;
}): LineUsageResult {
  const { flags, closures, period, now } = input;
  // A period that has not finished counts to now.
  const p: Period = { from: period.from, to: toIso(Math.min(ms(period.to), ms(now))) };
  const groups = usageGroups(p, input.grouping, input.timeZone);

  const all = input.lines.map((line) => {
    const perGroup = groups.map((g) => usageFor(line, flags, closures, g, now));
    const total = usageFor(line, flags, closures, p, now);
    const { visits, units } = visitsAndUnits(line, flags, p, now);
    return { line, perGroup, total: { ...total, visits, units: units.size } };
  });

  // Retired lines stay for history: show them only for periods in which they were used.
  const rows: LineUsageRow[] = all
    .filter((r) => !r.line.retiredAt || r.total.occupiedHours > 0)
    .map((r) => ({ line: r.line, total: r.total, groups: r.perGroup }));

  const caps = rows.map((r) => r.line.capacity);
  return {
    groups,
    rows,
    fleet: {
      total: sum(rows.map((r) => r.total), caps),
      groups: groups.map((_, gi) => sum(rows.map((r) => r.groups[gi]!), caps)),
    },
  };
}

/** Rows for a CSV download: one per line and group. */
export function usageCsvRows(result: LineUsageResult, lineLabel: (l: ShopLine) => string): Array<Record<string, string | number>> {
  return result.rows.flatMap((r) =>
    result.groups.map((g, i) => {
      const u = r.groups[i]!;
      return {
        line: lineLabel(r.line),
        period: g.label,
        from: g.from,
        to: g.to,
        open_hours: round(u.openHours),
        occupied_hours: round(u.occupiedHours),
        worked_hours: round(u.workedHours),
        idle_hours: round(u.idleHours),
        usage_pct: u.usage === null ? '' : round(u.usage * 100),
      };
    }),
  );
}

const round = (n: number) => Math.round(n * 100) / 100;
