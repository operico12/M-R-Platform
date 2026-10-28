// Reliability analysis for the downtime analysis page (phase 2, plan 7):
// jack-knife chart, repeat failures, bad actors and failure coding quality.
// Definitions: docs/kpi-dictionary.md KPI-024 to KPI-027. Pure functions over
// the same filtered analysis the Pareto uses, so every view adds up.

import type { FilteredAnalysis } from './filters.js';
import { flagSystem } from './filters.js';
import type { DowntimeEvent } from './kpis.js';
import { ms, shiftAt, type ShiftCalendar } from './time.js';
import { SYSTEMS } from './synth/generate.js';
import type { DownFlag } from './types.js';

// ---------- KPI-024 jack-knife ----------

export type JackKnifeZone = 'acute_chronic' | 'chronic' | 'acute' | 'within';

export const ZONE_LABELS: Record<JackKnifeZone, string> = {
  acute_chronic: 'Acute and chronic',
  chronic: 'Chronic (frequent)',
  acute: 'Acute (long repairs)',
  within: 'Within limits',
};

export interface JackKnifePoint {
  key: string;
  events: number;
  hours: number;
  /** Mean down hours per event. */
  mean: number;
  zone: JackKnifeZone;
}

/**
 * Knights (2001) log scatter: events against mean duration per group, with
 * the event limit at total events ÷ groups and the duration limit at total
 * hours ÷ total events. Takes Pareto rows (paretoOf) so the groups match.
 */
export function jackKnife(rows: Array<{ key: string; hours: number; events: number }>): { points: JackKnifePoint[]; eventLimit: number; meanLimit: number } {
  const used = rows.filter((r) => r.events > 0 && r.hours > 0);
  const events = used.reduce((s, r) => s + r.events, 0);
  const hours = used.reduce((s, r) => s + r.hours, 0);
  const eventLimit = used.length ? events / used.length : 0;
  const meanLimit = events ? hours / events : 0;
  const points = used.map((r) => {
    const mean = r.hours / r.events;
    const often = r.events > eventLimit;
    const long = mean > meanLimit;
    return { key: r.key, events: r.events, hours: r.hours, mean, zone: (often && long ? 'acute_chronic' : often ? 'chronic' : long ? 'acute' : 'within') as JackKnifeZone };
  });
  return { points: points.sort((a, b) => b.hours - a.hours), eventLimit, meanLimit };
}

/** The same analysis with only failure events, for the jack-knife (KPI-024 leaves planned work out). */
export function failuresOnly(a: FilteredAnalysis): FilteredAnalysis {
  const events = a.events.filter((e) => e.event.isFailure);
  return { ...a, events, downHours: events.reduce((s, e) => s + e.hours, 0) };
}

// ---------- KPI-025 repeat failures ----------

const eventSystem = (e: DowntimeEvent) => e.system ?? (e.flags[0] ? flagSystem(e.flags[0]) : '');

export interface RepeatFailure {
  event: DowntimeEvent;
  previous: DowntimeEvent;
  /** Days from the previous release to this failure. */
  days: number;
  system: string;
}

/**
 * Failures in the analysis that follow a failure on the same unit and system
 * within `days` of its release. `history` is every event (buildEvents over all
 * flags), so a previous failure before the period still counts.
 */
export function repeatFailures(a: FilteredAnalysis, history: DowntimeEvent[], days = 30): { repeats: RepeatFailure[]; failures: number; share: number | null } {
  const byUnit = new Map<string, DowntimeEvent[]>();
  for (const e of history) {
    if (!e.isFailure) continue;
    const l = byUnit.get(e.unitId) ?? [];
    l.push(e);
    byUnit.set(e.unitId, l);
  }
  for (const l of byUnit.values()) l.sort((x, y) => ms(x.start) - ms(y.start));
  const repeats: RepeatFailure[] = [];
  const failures = a.events.filter((x) => x.event.isFailure);
  for (const { event } of failures) {
    const sys = eventSystem(event);
    const prev = (byUnit.get(event.unitId) ?? []).filter((p) => p.id !== event.id && ms(p.start) < ms(event.start) && p.end && eventSystem(p) === sys).at(-1);
    if (!prev) continue;
    const gap = (ms(event.start) - ms(prev.end!)) / 864e5;
    if (gap <= days) repeats.push({ event, previous: prev, days: Math.max(0, gap), system: sys });
  }
  return { repeats, failures: failures.length, share: failures.length ? repeats.length / failures.length : null };
}

// ---------- KPI-027 bad actors ----------

export interface BadActor {
  unitId: string;
  hours: number;
  events: number;
  failures: number;
  repeats: number;
  topSystem: string;
  topSystemHours: number;
}

export function badActors(a: FilteredAnalysis, repeats: RepeatFailure[], top = 10): BadActor[] {
  const m = new Map<string, BadActor & { sys: Map<string, number> }>();
  for (const e of a.events) {
    const r = m.get(e.event.unitId) ?? { unitId: e.event.unitId, hours: 0, events: 0, failures: 0, repeats: 0, topSystem: '', topSystemHours: 0, sys: new Map() };
    r.hours += e.hours;
    r.events++;
    if (e.event.isFailure) r.failures++;
    const s = eventSystem(e.event);
    r.sys.set(s, (r.sys.get(s) ?? 0) + e.hours);
    m.set(e.event.unitId, r);
  }
  for (const rp of repeats) { const r = m.get(rp.event.unitId); if (r) r.repeats++; }
  return [...m.values()]
    .map(({ sys, ...r }) => {
      const [k, h] = [...sys.entries()].sort((x, y) => y[1] - x[1])[0] ?? ['', 0];
      return { ...r, topSystem: k, topSystemHours: h };
    })
    .sort((x, y) => y.hours - x.hours)
    .slice(0, top);
}

// ---------- KPI-026 failure coding quality ----------

export type CodingCheck = 'component_other' | 'mode_unknown' | 'component_mismatch' | 'no_cause';

export const CODING_CHECK_LABELS: Record<CodingCheck, string> = {
  component_other: 'Component recorded as "Other"',
  mode_unknown: 'Failure mode "Unknown"',
  component_mismatch: 'Component not in the system',
  no_cause: 'No cause code',
};

/** The reference list of components per system (A9). Starter lists until the site's own are loaded. */
export type ReferenceList = Record<string, { components: string[] }>;

export function codingIssues(f: DownFlag, ref: ReferenceList = SYSTEMS): CodingCheck[] {
  const r = f.release ?? {};
  const out: CodingCheck[] = [];
  const comp = (r.component ?? '').trim().toLowerCase();
  if (comp === 'other' || comp === '') out.push('component_other');
  if ((r.failureModes ?? []).some((m) => /^(unknown|other|n\/?a)$/i.test(m.trim())) || !(r.failureModes ?? []).length) out.push('mode_unknown');
  const sys = r.system ?? f.system;
  if (sys && ref[sys] && comp && comp !== 'other' && !ref[sys]!.components.some((c) => c.toLowerCase() === comp)) out.push('component_mismatch');
  if (!r.causeCode?.trim()) out.push('no_cause');
  return out;
}

export interface CodingQuality {
  released: number;
  clean: number;
  score: number | null;
  byCheck: Record<CodingCheck, number>;
  /** By crew and shift (plan 11.2: results by named person are not shown here). */
  byCrew: Array<{ crew: string; released: number; clean: number; score: number | null }>;
  rows: Array<{ flag: DownFlag; issues: CodingCheck[] }>;
}

/** Released unscheduled flags (failures) in the analysis. */
export function codingQuality(a: FilteredAnalysis, calendar: ShiftCalendar, ref: ReferenceList = SYSTEMS): CodingQuality {
  const byCheck: Record<CodingCheck, number> = { component_other: 0, mode_unknown: 0, component_mismatch: 0, no_cause: 0 };
  const crews = new Map<string, { released: number; clean: number }>();
  const rows: CodingQuality['rows'] = [];
  for (const e of a.events) {
    if (!e.event.isFailure) continue;
    for (const f of e.flags) {
      if (f.type !== 'unscheduled' || f.state !== 'released') continue;
      const issues = codingIssues(f, ref);
      rows.push({ flag: f, issues });
      for (const i of issues) byCheck[i]++;
      const sh = shiftAt(calendar, f.end ?? f.start);
      const crew = sh.crew ? `Crew ${sh.crew}, ${sh.name}` : sh.name;
      const c = crews.get(crew) ?? { released: 0, clean: 0 };
      c.released++;
      if (!issues.length) c.clean++;
      crews.set(crew, c);
    }
  }
  const clean = rows.filter((r) => !r.issues.length).length;
  return {
    released: rows.length, clean, score: rows.length ? clean / rows.length : null, byCheck,
    byCrew: [...crews.entries()].map(([crew, c]) => ({ crew, ...c, score: c.released ? c.clean / c.released : null })).sort((x, y) => x.crew.localeCompare(y.crew)),
    rows,
  };
}
