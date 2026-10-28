// Analytics explorer (plan 7.5 to 7.7; docs/analytics-explorer.md). Rows are the
// downtime events of a slice; measures, breakdowns, compare tests, spread,
// control charts and suggested findings all work on rows.

import { DateTime } from 'luxon';
import { percentile } from './calculators.js';
import type { ConsoleContext } from './console.js';
import { flagSystem, flagWhere, type FilteredAnalysis } from './filters.js';
import { computeKpis, timeToFirstWrench, stageHours, type KpiInput } from './kpis.js';
import { can } from './permissions.js';
import { shiftAt, type ShiftCalendar } from './time.js';
import type { Asset, AuditEntry, Iso, ShopLine, Stage } from './types.js';

export type Dimension = 'system' | 'component' | 'failure_mode' | 'unit' | 'model' | 'fleet' | 'shift' | 'crew' | 'where' | 'line' | 'detection' | 'type' | 'weekday' | 'hour';

export const DIMENSION_LABELS: Record<Dimension, string> = {
  system: 'System', component: 'Component', failure_mode: 'Failure mode', unit: 'Unit', model: 'Model', fleet: 'Fleet',
  shift: 'Shift', crew: 'Crew', where: 'Field or shop', line: 'Shop line', detection: 'Detected by', type: 'Type', weekday: 'Day of week', hour: 'Hour of day',
};

/** Dimensions that belong to the unit; MTBF for these uses the group's own operating hours. */
const UNIT_DIMENSIONS: Dimension[] = ['unit', 'model', 'fleet'];

const WAIT: Stage[] = ['waiting_crew', 'waiting_line', 'waiting_parts', 'waiting_labour', 'waiting_other'];
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export interface EventRow {
  id: string;
  unitId: string;
  start: Iso;
  failure: boolean;
  downH: number;
  repairH: number;
  waitH: number;
  firstWrenchH: number | null;
  dims: Record<Dimension, string>;
}

/** One row per downtime event in the slice, with its dimensions from the first matching flag. */
export function eventRows(a: FilteredAnalysis, assets: Asset[], calendar: ShiftCalendar, shopLines: ShopLine[]): EventRow[] {
  const byId = new Map(assets.map((x) => [x.id, x]));
  const lineName = new Map(shopLines.map((l) => [l.id, l.name ?? `Line ${l.number}`]));
  return a.events.map(({ event, flags, hours }) => {
    const fl = flags[0]!;
    const asset = byId.get(event.unitId);
    const sh = shiftAt(calendar, event.start);
    const local = DateTime.fromISO(event.start, { zone: calendar.timeZone });
    let repairH = 0;
    let waitH = 0;
    for (const f of flags) {
      const s = stageHours(f, a.period, a.now);
      repairH += s.in_repair;
      for (const w of WAIT) waitH += s[w];
    }
    const line = flags.flatMap((f) => f.locations).find((l) => l.shopLineId)?.shopLineId;
    return {
      id: event.id, unitId: event.unitId, start: event.start, failure: event.isFailure, downH: hours, repairH, waitH,
      firstWrenchH: timeToFirstWrench(event),
      dims: {
        system: flagSystem(fl), component: fl.release?.component ?? 'Not recorded', failure_mode: fl.release?.failureModes?.[0] ?? 'Not recorded',
        unit: asset?.unitNumber ?? event.unitId, model: asset?.model ?? '?', fleet: asset?.fleet ?? '?',
        shift: sh.name, crew: sh.crew ? `Crew ${sh.crew}` : 'No crew', where: flagWhere(fl) === 'shop' ? 'Shop' : 'Field',
        line: line ? lineName.get(line) ?? line : 'No line', detection: fl.release?.detectionMethod ?? 'Not recorded', type: fl.type,
        weekday: WEEKDAYS[local.weekday - 1]!, hour: String(local.hour).padStart(2, '0'),
      },
    };
  });
}

// ---------- measures ----------

export type Measure = 'events' | 'failures' | 'down_h' | 'mean_down_h' | 'median_down_h' | 'p90_down_h' | 'mttr' | 'wait_h' | 'mean_wait_h' | 'first_wrench_h' | 'mtbf';

export const MEASURE_LABELS: Record<Measure, string> = {
  events: 'Events', failures: 'Failures', down_h: 'Down h', mean_down_h: 'Mean down h', median_down_h: 'Median down h', p90_down_h: 'P90 down h',
  mttr: 'MTTR (h)', wait_h: 'Wait h', mean_wait_h: 'Mean wait h', first_wrench_h: 'Mean time to first wrench (h)', mtbf: 'MTBF (op. h)',
};

/** Measures that need at least 5 rows to show (docs/analytics-explorer.md). */
const NEEDS_FIVE: Measure[] = ['mean_down_h', 'median_down_h', 'p90_down_h', 'mttr', 'mean_wait_h', 'first_wrench_h'];

export type Summary = Record<Measure, number | null>;

const sum = (xs: number[]) => xs.reduce((t, x) => t + x, 0);
const mean = (xs: number[]) => (xs.length ? sum(xs) / xs.length : null);

export function summarise(rows: EventRow[], operatingHours: number | null): Summary {
  const down = rows.map((r) => r.downH).sort((x, y) => x - y);
  const repairs = rows.filter((r) => r.repairH > 0);
  const fw = rows.map((r) => r.firstWrenchH).filter((x): x is number => x !== null);
  const failures = rows.filter((r) => r.failure).length;
  return {
    events: rows.length, failures, down_h: sum(down), mean_down_h: mean(down),
    median_down_h: down.length ? percentile(down, 0.5) : null, p90_down_h: down.length ? percentile(down, 0.9) : null,
    mttr: repairs.length ? sum(repairs.map((r) => r.repairH)) / repairs.length : null,
    wait_h: sum(rows.map((r) => r.waitH)), mean_wait_h: mean(rows.map((r) => r.waitH)),
    first_wrench_h: mean(fw), mtbf: operatingHours !== null && failures ? operatingHours / failures : null,
  };
}

/** Operating hours of a set of units in the slice's period. */
export function sliceOperatingHours(input: KpiInput, assets: Asset[], a: FilteredAnalysis): number {
  return computeKpis({ ...input, assets }, a.period).operatingHours;
}

export interface Group { key: string; rows: EventRow[]; summary: Summary; small: boolean }

/**
 * Rows grouped by one dimension, largest down h first. MTBF uses the group's own units' hours for
 * unit dimensions, else the whole slice's hours (`sliceHours`).
 */
export function breakdown(rows: EventRow[], dim: Dimension, sliceHours: number, unitHours?: (dim: Dimension, key: string) => number): Group[] {
  const by = new Map<string, EventRow[]>();
  for (const r of rows) by.set(r.dims[dim], [...(by.get(r.dims[dim]) ?? []), r]);
  return [...by].map(([key, rs]) => {
    const hours = UNIT_DIMENSIONS.includes(dim) && unitHours ? unitHours(dim, key) : sliceHours;
    return { key, rows: rs, summary: hideSmall(summarise(rs, hours), rs.length), small: rs.length < 5 };
  }).sort((x, y) => (y.summary.down_h ?? 0) - (x.summary.down_h ?? 0));
}

function hideSmall(s: Summary, n: number): Summary {
  if (n >= 5) return s;
  const out = { ...s };
  for (const m of NEEDS_FIVE) out[m] = null;
  return out;
}

export interface HeatMap { rows: string[]; cols: string[]; cells: Map<string, { n: number; value: number | null; rows: EventRow[] }> }

/** Two dimensions; cell key is `${row}\u0000${col}`. Rows and columns sorted by down h. */
export function heatMap(rows: EventRow[], rowDim: Dimension, colDim: Dimension, measure: Measure, sliceHours: number, top = 12): HeatMap {
  const rank = (d: Dimension) => {
    const t = new Map<string, number>();
    for (const r of rows) t.set(r.dims[d], (t.get(r.dims[d]) ?? 0) + r.downH);
    return [...t].sort((x, y) => y[1] - x[1]).slice(0, top).map(([k]) => k);
  };
  const rs = rank(rowDim);
  const cs = rank(colDim);
  const cells = new Map<string, { n: number; value: number | null; rows: EventRow[] }>();
  for (const r of rs) for (const c of cs) {
    const these = rows.filter((x) => x.dims[rowDim] === r && x.dims[colDim] === c);
    if (!these.length) continue;
    cells.set(`${r}\u0000${c}`, { n: these.length, value: hideSmall(summarise(these, sliceHours), these.length)[measure], rows: these });
  }
  return { rows: rs, cols: cs, cells };
}

// ---------- spread ----------

export type Duration = 'down' | 'repair' | 'wait' | 'first_wrench';
export const DURATION_LABELS: Record<Duration, string> = { down: 'Down h', repair: 'Repair h', wait: 'Wait h', first_wrench: 'Time to first wrench (h)' };

export function durationOf(r: EventRow, d: Duration): number | null {
  switch (d) {
    case 'down': return r.downH;
    case 'repair': return r.repairH > 0 ? r.repairH : null;
    case 'wait': return r.waitH;
    case 'first_wrench': return r.firstWrenchH;
  }
}

export interface Box { key: string; n: number; min: number; q1: number; median: number; q3: number; max: number; lo: number; hi: number; outliers: number[] }

export function boxStats(values: number[]): Omit<Box, 'key'> {
  const s = [...values].sort((x, y) => x - y);
  const q1 = percentile(s, 0.25);
  const q3 = percentile(s, 0.75);
  const iqr = q3 - q1;
  const inside = s.filter((x) => x >= q1 - 1.5 * iqr && x <= q3 + 1.5 * iqr);
  return {
    n: s.length, min: s[0]!, q1, median: percentile(s, 0.5), q3, max: s[s.length - 1]!,
    lo: inside[0] ?? q1, hi: inside[inside.length - 1] ?? q3, outliers: s.filter((x) => x < q1 - 1.5 * iqr || x > q3 + 1.5 * iqr),
  };
}

/** Box plot per group; groups with fewer than 5 values are hidden. Widest P75 first. */
export function spread(rows: EventRow[], dim: Dimension, d: Duration, min = 5): Box[] {
  const by = new Map<string, number[]>();
  for (const r of rows) { const v = durationOf(r, d); if (v !== null) by.set(r.dims[dim], [...(by.get(r.dims[dim]) ?? []), v]); }
  return [...by].filter(([, v]) => v.length >= min).map(([key, v]) => ({ key, ...boxStats(v) })).sort((x, y) => y.q3 - x.q3);
}

// ---------- statistics ----------

/** Standard normal upper tail. */
function normalSf(z: number): number {
  // Abramowitz and Stegun 7.1.26 via erfc; accurate to about 1e-7.
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erfc = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) * Math.exp(-x * x);
  return z >= 0 ? erfc / 2 : 1 - erfc / 2;
}

/** Mann-Whitney U, two-sided, normal approximation with tie correction. */
export function mannWhitney(x: number[], y: number[]): { u: number; z: number; p: number } {
  const n1 = x.length;
  const n2 = y.length;
  const all = [...x.map((v) => ({ v, g: 0 })), ...y.map((v) => ({ v, g: 1 }))].sort((a, b) => a.v - b.v);
  const ranks = new Array<number>(all.length);
  let tie = 0;
  for (let i = 0; i < all.length;) {
    let j = i;
    while (j + 1 < all.length && all[j + 1]!.v === all[i]!.v) j++;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[k] = r;
    const t = j - i + 1;
    tie += t ** 3 - t;
    i = j + 1;
  }
  const r1 = all.reduce((s, a, i) => s + (a.g === 0 ? ranks[i]! : 0), 0);
  const u = r1 - (n1 * (n1 + 1)) / 2;
  const n = n1 + n2;
  const sd = Math.sqrt(((n1 * n2) / 12) * (n + 1 - tie / (n * (n - 1))));
  if (!sd) return { u, z: 0, p: 1 };
  const d = u - (n1 * n2) / 2;
  const z = (d - Math.sign(d) * 0.5) / sd;
  return { u, z, p: Math.min(1, 2 * normalSf(Math.abs(z))) };
}

/** Two failure rates: conditional binomial test with a normal approximation. */
export function rateTest(failuresA: number, hoursA: number, failuresB: number, hoursB: number): { z: number; p: number } {
  const n = failuresA + failuresB;
  if (!n || !(hoursA > 0) || !(hoursB > 0)) return { z: 0, p: 1 };
  const pi = hoursA / (hoursA + hoursB);
  const sd = Math.sqrt(n * pi * (1 - pi));
  const d = failuresA - n * pi;
  const z = (d - Math.sign(d) * 0.5) / sd;
  return { z, p: Math.min(1, 2 * normalSf(Math.abs(z))) };
}

// ---------- compare (KPI-028) ----------

export interface CompareLine { measure: Measure; a: number | null; b: number | null; diff: number | null; pct: number | null; p: number | null; outside: boolean }

const TESTED: Partial<Record<Measure, Duration>> = { mean_down_h: 'down', median_down_h: 'down', mttr: 'repair', mean_wait_h: 'wait', first_wrench_h: 'first_wrench' };

export function compareSlices(a: EventRow[], hoursA: number, b: EventRow[], hoursB: number, alpha = 0.05): CompareLine[] {
  const sa = summarise(a, hoursA);
  const sb = summarise(b, hoursB);
  const enough = a.length >= 5 && b.length >= 5;
  const measures: Measure[] = ['events', 'failures', 'down_h', 'mtbf', 'mean_down_h', 'median_down_h', 'mttr', 'mean_wait_h', 'first_wrench_h'];
  return measures.map((m) => {
    const x = sa[m];
    const y = sb[m];
    let p: number | null = null;
    if (enough && m === 'mtbf') p = rateTest(sa.failures!, hoursA, sb.failures!, hoursB).p;
    const d = TESTED[m];
    if (enough && d) {
      const xs = a.map((r) => durationOf(r, d)).filter((v): v is number => v !== null);
      const ys = b.map((r) => durationOf(r, d)).filter((v): v is number => v !== null);
      if (xs.length >= 5 && ys.length >= 5) p = mannWhitney(xs, ys).p;
    }
    const diff = x !== null && y !== null ? y - x : null;
    return { measure: m, a: x, b: y, diff, pct: diff !== null && x ? diff / x : null, p, outside: p !== null && p < alpha };
  });
}

// ---------- control chart (KPI-029) ----------

export interface ControlChart { centre: number; ucl: number; lcl: number; points: Array<{ label: string; value: number; out: boolean }> }

/** XmR chart. Null with fewer than 6 points. */
export function controlChart(points: Array<{ label: string; value: number }>): ControlChart | null {
  if (points.length < 6) return null;
  const centre = sum(points.map((p) => p.value)) / points.length;
  const mr = points.slice(1).map((p, i) => Math.abs(p.value - points[i]!.value));
  const mrBar = sum(mr) / mr.length;
  const ucl = centre + 2.66 * mrBar;
  const lcl = Math.max(0, centre - 2.66 * mrBar);
  return { centre, ucl, lcl, points: points.map((p) => ({ ...p, out: p.value > ucl || p.value < lcl })) };
}

// ---------- suggested findings (plan 7.7) ----------

export interface Finding { system: string; dim: Dimension; value: string; inside: number[]; rest: number[]; medianIn: number; medianRest: number; p: number; sentence: string }

const FINDING_DIMS: Dimension[] = ['shift', 'crew', 'where', 'line', 'detection'];

export function findings(rows: EventRow[], d: Duration, top = 8, alpha = 0.01, minDiffH = 0.5): Finding[] {
  const out: Finding[] = [];
  const systems = [...new Set(rows.map((r) => r.dims.system))];
  for (const system of systems) {
    const sys = rows.filter((r) => r.dims.system === system);
    for (const dim of FINDING_DIMS) {
      for (const value of [...new Set(sys.map((r) => r.dims[dim]))]) {
        const inside = sys.filter((r) => r.dims[dim] === value).map((r) => durationOf(r, d)).filter((v): v is number => v !== null);
        const rest = sys.filter((r) => r.dims[dim] !== value).map((r) => durationOf(r, d)).filter((v): v is number => v !== null);
        if (inside.length < 5 || rest.length < 5) continue;
        const mi = percentile([...inside].sort((x, y) => x - y), 0.5);
        const mr = percentile([...rest].sort((x, y) => x - y), 0.5);
        if (Math.abs(mi - mr) < minDiffH) continue;
        const { p } = mannWhitney(inside, rest);
        if (p >= alpha) continue;
        const what = DURATION_LABELS[d].replace(' (h)', '').replace(' h', '').toLowerCase();
        out.push({
          system, dim, value, inside, rest, medianIn: mi, medianRest: mr, p,
          sentence: `${system}, ${DIMENSION_LABELS[dim].toLowerCase()} ${value}: median ${what} ${mi.toFixed(1)} h vs ${mr.toFixed(1)} h for the rest of ${system} (${inside.length} vs ${rest.length} events).`,
        });
      }
    }
  }
  return out.sort((x, y) => Math.abs(y.medianIn - y.medianRest) - Math.abs(x.medianIn - x.medianRest)).slice(0, top);
}

// ---------- saved views ----------

export interface SavedView {
  id: string;
  name: string;
  /** The explorer link's query string. */
  query: string;
  shared: boolean;
  createdBy: string;
  createdAt: Iso;
  retiredBy?: string;
  retiredAt?: Iso;
  retiredReason?: string;
}

type Ok = { ok: true; records: SavedView[]; audit: AuditEntry[]; warnings: string[] };
type No = { ok: false; errors: string[] };

export function saveView(ctx: ConsoleContext, list: SavedView[], v: { name: string; query: string; shared: boolean }): Ok | No {
  if (!can(ctx.actor, 'run_analyses')) return { ok: false, errors: ['Your role cannot save views.'] };
  const name = v.name.trim();
  if (!name) return { ok: false, errors: ['Give the view a name.'] };
  if (v.query.length > 4000) return { ok: false, errors: ['This view is too long to save.'] };
  const rec: SavedView = { id: ctx.newId(), name, query: v.query, shared: v.shared, createdBy: ctx.actor.userId, createdAt: ctx.now };
  return { ok: true, records: [...list, rec], audit: [{ at: ctx.now, userId: ctx.actor.userId, action: 'save_view', entity: 'view', entityId: rec.id, before: null, after: rec }], warnings: [] };
}

/** Only its author, or a superintendent for a shared view, retires a view. */
export function retireView(ctx: ConsoleContext, list: SavedView[], id: string, reason: string): Ok | No {
  const v = list.find((x) => x.id === id);
  if (!v || v.retiredAt) return { ok: false, errors: ['Not found.'] };
  const mine = v.createdBy === ctx.actor.userId;
  if (!(mine && can(ctx.actor, 'run_analyses')) && !(v.shared && ctx.actor.role === 'superintendent')) return { ok: false, errors: ['Only the author retires a view (or a superintendent, for a shared one).'] };
  if (!reason.trim()) return { ok: false, errors: ['Give a reason.'] };
  const after = { ...v, retiredBy: ctx.actor.userId, retiredAt: ctx.now, retiredReason: reason.trim() };
  return { ok: true, records: list.map((x) => (x.id === id ? after : x)), audit: [{ at: ctx.now, userId: ctx.actor.userId, action: 'retire_view', entity: 'view', entityId: id, before: v, after, reason: reason.trim() }], warnings: [] };
}

/** Views a person sees: their own and the shared ones, not retired. */
export const visibleViews = (list: SavedView[], userId: string) => list.filter((v) => !v.retiredAt && (v.shared || v.createdBy === userId));
