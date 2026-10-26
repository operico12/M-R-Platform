// Tier 1 KPI engine (build plan 3.3, A7 section 9).
//
// Everything is calculated from timed flag intervals and SMU readings. No
// duration is ever typed in. Ratios at fleet level are ratios of sums, never
// averages of unit ratios.

import type { FlagRulesConfig } from './config.js';
import { HOUR_MS, ms, overlapHours, splitForReporting, toIso, type ShiftCalendar } from './time.js';
import type { Asset, AssetLifecycleInterval, DownFlag, Iso, LocationKind, ShopLine, ShopLineClosure, SmuReading, Stage } from './types.js';

export interface Period {
  from: Iso;
  to: Iso;
}

/** Flags that count toward KPIs. Proposed, voided and process-delay records never do (A7 3.1, R11). */
export function countingFlags(flags: DownFlag[]): DownFlag[] {
  return flags.filter((f) => f.state === 'open' || f.state === 'released');
}

/** The flag's down intervals: start to end, minus reopen gaps that count as available (D6). */
export function downIntervals(flag: DownFlag, now: Iso): Array<{ start: Iso; end: Iso }> {
  const end = flag.end ?? now;
  const gaps = (flag.reopenGaps ?? []).filter((g) => g.countsAs === 'available').sort((a, b) => ms(a.start) - ms(b.start));
  const out: Array<{ start: Iso; end: Iso }> = [];
  let cursor = flag.start;
  for (const g of gaps) {
    if (ms(g.start) > ms(cursor)) out.push({ start: cursor, end: g.start });
    cursor = g.end;
  }
  if (ms(end) > ms(cursor)) out.push({ start: cursor, end });
  return out;
}

export function flagDownHours(flag: DownFlag, p: Period, now: Iso): number {
  return downIntervals(flag, now).reduce((s, iv) => s + overlapHours(iv.start, iv.end, p.from, p.to), 0);
}

// ---------- downtime events (R7) ----------

export interface DowntimeEvent {
  id: string;
  unitId: string;
  flags: DownFlag[];
  start: Iso;
  end: Iso | null;
  startType: DownFlag['type'];
  /** Counts as a failure for MTBF (R9, D1, D5). */
  isFailure: boolean;
  isMinorStop: boolean;
  system?: string;
}

/** Group linked flags with no gap between them into downtime events (R7). */
export function buildEvents(flags: DownFlag[], rules: FlagRulesConfig, now: Iso): DowntimeEvent[] {
  const counting = countingFlags(flags);
  const byId = new Map(counting.map((f) => [f.id, f]));
  const next = new Map<string, DownFlag>();
  for (const f of counting) {
    if (!f.linkedFromFlagId) continue;
    const prev = byId.get(f.linkedFromFlagId);
    if (prev && prev.end && ms(prev.end) === ms(f.start)) next.set(prev.id, f);
  }
  const hasContiguousPrev = new Set([...next.values()].map((f) => f.id));
  const events: DowntimeEvent[] = [];
  for (const head of counting) {
    if (hasContiguousPrev.has(head.id)) continue;
    const chain: DownFlag[] = [head];
    let cur = head;
    while (next.has(cur.id)) {
      cur = next.get(cur.id)!;
      chain.push(cur);
    }
    const last = chain[chain.length - 1]!;
    const end = last.end;
    const totalH = chain.reduce((s, f) => s + downIntervals(f, now).reduce((a, iv) => a + (ms(iv.end) - ms(iv.start)) / HOUR_MS, 0), 0);
    const minH = rules.minFailureMinutes / 60;
    let isFailure = false;
    let isMinorStop = false;
    if (head.type === 'unscheduled') {
      isFailure = totalH >= minH;
      isMinorStop = !isFailure;
    } else if (rules.pmFoundDefectCountsAsFailure) {
      // D5 = yes: a defect found at a PM counts if its unscheduled part reaches the minimum.
      const unschedH = chain
        .filter((f) => f.type === 'unscheduled')
        .reduce((s, f) => s + downIntervals(f, now).reduce((a, iv) => a + (ms(iv.end) - ms(iv.start)) / HOUR_MS, 0), 0);
      isFailure = unschedH >= minH;
    }
    const sys = chain.map((f) => f.release?.system ?? f.system).find(Boolean);
    events.push({ id: head.id, unitId: head.unitId, flags: chain, start: head.start, end, startType: head.type, isFailure, isMinorStop, system: sys });
  }
  return events.sort((a, b) => ms(a.start) - ms(b.start));
}

// ---------- stage and location time ----------

export function stageHours(flag: DownFlag, p: Period, now: Iso): Record<Stage, number> {
  const out = { waiting_crew: 0, in_transit: 0, waiting_line: 0, in_repair: 0, waiting_parts: 0, waiting_labour: 0, waiting_other: 0, ready_for_release: 0 } as Record<Stage, number>;
  for (const s of flag.stages) out[s.stage] += overlapHours(s.start, s.end ?? flag.end ?? now, p.from, p.to);
  return out;
}

export function locationHours(flag: DownFlag, p: Period, now: Iso): Record<LocationKind, number> {
  const out = { field: 0, towing: 0, shop_yard: 0, shop_line: 0, in_place: 0 } as Record<LocationKind, number>;
  for (const l of flag.locations) out[l.kind] += overlapHours(l.start, l.end ?? flag.end ?? now, p.from, p.to);
  return out;
}

/** In-repair hours, honouring D11 (field diagnosis counts as repair or not). */
export function repairHours(flag: DownFlag, p: Period, now: Iso, rules: FlagRulesConfig): number {
  let h = 0;
  for (const s of flag.stages) {
    if (s.stage !== 'in_repair') continue;
    const sEnd = s.end ?? flag.end ?? now;
    h += overlapHours(s.start, sEnd, p.from, p.to);
    if (!rules.fieldDiagnosisIsRepair) {
      for (const l of flag.locations) {
        if (l.kind !== 'field') continue;
        const lEnd = l.end ?? flag.end ?? now;
        const st = Math.max(ms(s.start), ms(l.start), ms(p.from));
        const en = Math.min(ms(sEnd), ms(lEnd), ms(p.to));
        if (en > st) h -= (en - st) / HOUR_MS;
      }
    }
  }
  return h;
}

/** Time to first wrench: event start to the first In repair (A7 section 9). */
export function timeToFirstWrench(ev: DowntimeEvent): number | null {
  for (const f of ev.flags) {
    const r = f.stages.find((s) => s.stage === 'in_repair');
    if (r) return (ms(r.start) - ms(ev.start)) / HOUR_MS;
  }
  return null;
}

// ---------- calendar and operating hours ----------

/** Calendar hours in the period while the unit was active (R2: parked and decommissioned time excluded). */
export function calendarHours(unitId: string, p: Period, lifecycle: AssetLifecycleInterval[]): number {
  const total = (ms(p.to) - ms(p.from)) / HOUR_MS;
  const inactive = lifecycle
    .filter((l) => l.assetId === unitId && l.status !== 'active')
    .reduce((s, l) => s + overlapHours(l.start, l.end, p.from, p.to, p.to), 0);
  return Math.max(0, total - inactive);
}

/**
 * Operating hours from SMU (plan 3.2). Each pair of consecutive readings gives
 * a delta; a delta that spans the period boundary is split pro rata.
 */
export function operatingHours(unitId: string, p: Period, readings: SmuReading[]): number {
  const rs = readings.filter((r) => r.unitId === unitId).sort((a, b) => ms(a.at) - ms(b.at));
  let h = 0;
  for (let i = 1; i < rs.length; i++) {
    const a = rs[i - 1]!;
    const b = rs[i]!;
    const delta = b.hours - a.hours;
    if (delta <= 0) continue;
    const span = ms(b.at) - ms(a.at);
    if (span <= 0) continue;
    const ov = overlapHours(a.at, b.at, p.from, p.to) * HOUR_MS;
    h += delta * (ov / span);
  }
  return h;
}

// ---------- per-unit and fleet KPIs ----------

export interface KpiResult {
  calendarHours: number;
  downHours: number;
  scheduledDownHours: number;
  unscheduledDownHours: number;
  availableHours: number;
  operatingHours: number;
  standbyHours: number;
  /** Physical availability, 0–1. */
  pa: number | null;
  utilisation: number | null;
  effectiveUtilisation: number | null;
  mechanicalAvailability: number | null;
  failures: number;
  minorStops: number;
  events: number;
  repairHours: number;
  repairs: number;
  mtbf: number | null;
  mttr: number | null;
  meanDowntime: number | null;
  stageHours: Record<Stage, number>;
  locationHours: Record<LocationKind, number>;
}

export interface KpiInput {
  assets: Asset[];
  flags: DownFlag[];
  smu: SmuReading[];
  lifecycle?: AssetLifecycleInterval[];
  rules: FlagRulesConfig;
  now: Iso;
}

function emptyStages(): Record<Stage, number> {
  return { waiting_crew: 0, in_transit: 0, waiting_line: 0, in_repair: 0, waiting_parts: 0, waiting_labour: 0, waiting_other: 0, ready_for_release: 0 };
}
function emptyLocations(): Record<LocationKind, number> {
  return { field: 0, towing: 0, shop_yard: 0, shop_line: 0, in_place: 0 };
}
const ratio = (a: number, b: number): number | null => (b > 0 ? a / b : null);

/** KPIs for a set of units over one period. Pass one asset for unit KPIs, a fleet for fleet KPIs. */
export function computeKpis(input: KpiInput, p: Period): KpiResult {
  const { rules, now } = input;
  const unitIds = new Set(input.assets.map((a) => a.id));
  const flags = countingFlags(input.flags).filter((f) => unitIds.has(f.unitId));
  const lifecycle = input.lifecycle ?? [];
  const pEnd = ms(p.to) > ms(now) ? now : p.to;
  const effP: Period = { from: p.from, to: pEnd };

  let cal = 0;
  let op = 0;
  // Utilisation can only use time that SMU readings cover. Hours after a
  // unit's last reading (e.g. the shift in progress) are left out of the
  // utilisation denominator rather than counted as standby.
  let smuCal = 0;
  let smuDown = 0;
  const lastReading = new Map<string, number>();
  for (const r of input.smu) if (unitIds.has(r.unitId)) lastReading.set(r.unitId, Math.max(lastReading.get(r.unitId) ?? 0, ms(r.at)));
  for (const id of unitIds) {
    cal += calendarHours(id, effP, lifecycle);
    op += operatingHours(id, effP, input.smu);
    const lr = lastReading.get(id);
    if (lr === undefined || lr <= ms(effP.from)) continue;
    const cov: Period = { from: effP.from, to: toIso(Math.min(lr, ms(effP.to))) };
    smuCal += calendarHours(id, cov, lifecycle);
    for (const f of flags) if (f.unitId === id) smuDown += flagDownHours(f, cov, now);
  }
  const smuAvail = Math.max(0, smuCal - smuDown);
  let sched = 0;
  let unsched = 0;
  const stages = emptyStages();
  const locs = emptyLocations();
  for (const f of flags) {
    const h = flagDownHours(f, effP, now);
    if (f.type === 'scheduled') sched += h;
    else unsched += h;
    const sh = stageHours(f, effP, now);
    const lh = locationHours(f, effP, now);
    for (const k of Object.keys(sh) as Stage[]) stages[k] += sh[k];
    for (const k of Object.keys(lh) as LocationKind[]) locs[k] += lh[k];
  }
  const down = sched + unsched;
  const avail = Math.max(0, cal - down);

  // Events and failures are counted in the period where the event starts.
  const events = buildEvents(input.flags.filter((f) => unitIds.has(f.unitId)), rules, now).filter(
    (e) => ms(e.start) >= ms(p.from) && ms(e.start) < ms(p.to),
  );
  const failures = events.filter((e) => e.isFailure);
  const minor = events.filter((e) => e.isMinorStop).length;

  // MTTR (review #8 open: what is "a repair").
  let repairScope: DownFlag[];
  let repairs: number;
  if (rules.mttrDenominator === 'failures') {
    repairScope = failures.flatMap((e) => e.flags);
    repairs = failures.length;
  } else {
    const scopeFlags = rules.mttrDenominator === 'unscheduled_events_with_repair'
      ? events.filter((e) => e.flags.some((f) => f.type === 'unscheduled'))
      : events;
    const withRepair = scopeFlags.filter((e) => e.flags.some((f) => f.stages.some((s) => s.stage === 'in_repair')));
    repairScope = withRepair.flatMap((e) => e.flags);
    repairs = withRepair.length;
  }
  const evWindow: Period = { from: p.from, to: toIso(Math.max(ms(now), ms(p.to))) };
  const repH = repairScope.reduce((s, f) => s + repairHours(f, evWindow, now, rules), 0);

  // Mean downtime (C7 open).
  const evDown = (e: DowntimeEvent) => e.flags.reduce((s, f) => s + flagDownHours(f, evWindow, now), 0);
  let mdt: number | null;
  if (rules.meanDowntime === 'all_downtime_per_failure') {
    // Plan 3.3: total unscheduled downtime (minor stops and PM-found defects included) ÷ failures.
    const unschedDown = events.reduce((s, e) => s + e.flags.filter((f) => f.type === 'unscheduled').reduce((a, f) => a + flagDownHours(f, evWindow, now), 0), 0);
    mdt = ratio(unschedDown, failures.length);
  } else if (rules.meanDowntime === 'failure_events_per_failure') {
    mdt = ratio(failures.reduce((s, e) => s + evDown(e), 0), failures.length);
  } else {
    mdt = ratio(events.reduce((s, e) => s + evDown(e), 0), events.length);
  }

  return {
    calendarHours: cal,
    downHours: down,
    scheduledDownHours: sched,
    unscheduledDownHours: unsched,
    availableHours: avail,
    operatingHours: op,
    standbyHours: Math.max(0, smuAvail - op),
    pa: ratio(avail, cal),
    utilisation: ratio(op, smuAvail),
    effectiveUtilisation: ratio(op, smuCal),
    mechanicalAvailability: ratio(op, op + down),
    failures: failures.length,
    minorStops: minor,
    events: events.length,
    repairHours: repH,
    repairs,
    mtbf: ratio(op, failures.length),
    mttr: ratio(repH, repairs),
    meanDowntime: mdt,
    stageHours: stages,
    locationHours: locs,
  };
}

// ---------- downtime by category (Pareto) ----------

export interface ParetoRow {
  key: string;
  hours: number;
  events: number;
  share: number;
  cumulative: number;
}

export function downtimePareto(
  input: KpiInput,
  p: Period,
  keyOf: (f: DownFlag) => string = (f) => f.release?.system ?? f.system ?? f.reasonCode,
  filter: (f: DownFlag) => boolean = (f) => f.type === 'unscheduled',
): ParetoRow[] {
  const unitIds = new Set(input.assets.map((a) => a.id));
  const map = new Map<string, { hours: number; events: Set<string> }>();
  for (const f of countingFlags(input.flags)) {
    if (!unitIds.has(f.unitId) || !filter(f)) continue;
    const h = flagDownHours(f, p, input.now);
    if (h <= 0) continue;
    const k = keyOf(f) || 'Uncoded';
    const row = map.get(k) ?? { hours: 0, events: new Set<string>() };
    row.hours += h;
    row.events.add(f.id);
    map.set(k, row);
  }
  const total = [...map.values()].reduce((s, r) => s + r.hours, 0);
  const rows = [...map.entries()].map(([key, r]) => ({ key, hours: r.hours, events: r.events.size })).sort((a, b) => b.hours - a.hours);
  let cum = 0;
  return rows.map((r) => {
    cum += r.hours;
    return { ...r, share: total ? r.hours / total : 0, cumulative: total ? cum / total : 0 };
  });
}

// ---------- shop and queue KPIs ----------

export const DOWNLINE_STAGES: Stage[] = ['waiting_crew', 'in_transit', 'waiting_line'];

/** Units now waiting for crew, in transit, or waiting for a line (A7 section 9). */
export function downlineQueue(flags: DownFlag[], now: Iso): Array<{ flag: DownFlag; stage: Stage; waitingHours: number }> {
  return flags
    .filter((f) => f.state === 'open')
    .map((f) => ({ flag: f, cur: f.stages[f.stages.length - 1] }))
    .filter((x) => x.cur && DOWNLINE_STAGES.includes(x.cur.stage))
    .map((x) => ({ flag: x.flag, stage: x.cur!.stage, waitingHours: (ms(now) - ms(x.cur!.start)) / HOUR_MS }))
    .sort((a, b) => b.waitingHours - a.waitingHours);
}

/** Shop line occupancy: occupied hours ÷ open hours; closed time is excluded (plan 3.3). */
export function lineOccupancy(line: ShopLine, flags: DownFlag[], closures: ShopLineClosure[], p: Period, now: Iso) {
  const total = (ms(p.to) - ms(p.from)) / HOUR_MS;
  const closed = closures.filter((c) => c.lineId === line.id).reduce((s, c) => s + overlapHours(c.start, c.end, p.from, p.to, now), 0);
  const openH = Math.max(0, total - closed);
  let occ = 0;
  for (const f of countingFlags(flags)) {
    for (const l of f.locations) {
      if (l.kind === 'shop_line' && l.shopLineId === line.id) occ += overlapHours(l.start, l.end ?? f.end ?? now, p.from, p.to);
    }
  }
  return { openHours: openH, occupiedHours: occ, occupancy: ratio(occ, openH * line.capacity) };
}

/** Shop release vs plan (D10): releases on or before the counted ETA ÷ releases that had an ETA. */
export function shopReleaseVsPlan(flags: DownFlag[], p: Period, rules: FlagRulesConfig) {
  const released = countingFlags(flags).filter((f) => f.state === 'released' && f.end && ms(f.end) >= ms(p.from) && ms(f.end) < ms(p.to) && f.etas.length > 0);
  const onTime = released.filter((f) => {
    const eta = rules.shopReleaseEta === 'first' ? f.etas[0]!.eta : [...f.etas].filter((e) => ms(e.setAt) <= ms(f.end!)).at(-1)!.eta;
    return ms(f.end!) <= ms(eta);
  });
  return { due: released.length, onTime: onTime.length, rate: ratio(onTime.length, released.length) };
}

/** Field repair share: unscheduled events released from Down in field ÷ unscheduled events released. */
export function fieldRepairShare(events: DowntimeEvent[], p: Period) {
  const done = events.filter((e) => e.startType === 'unscheduled' && e.end && ms(e.end) >= ms(p.from) && ms(e.end) < ms(p.to));
  const field = done.filter((e) => {
    const last = e.flags[e.flags.length - 1]!;
    return last.locations[last.locations.length - 1]?.kind === 'field';
  });
  return { events: done.length, field: field.length, share: ratio(field.length, done.length) };
}

// ---------- reporting split ----------

/** Down hours for one flag split by shift, day and month (R6). */
export function splitFlag(flag: DownFlag, cal: ShiftCalendar, now: Iso) {
  return downIntervals(flag, now).flatMap((iv) => splitForReporting(cal, iv.start, iv.end));
}
