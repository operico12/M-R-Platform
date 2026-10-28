// Weekly fleet performance pack (plan 1.2, 4.2 "Weekly reliability review", MVP
// screen 5). The numbers come from the same KPI engine as the screens, so the
// pack and the dashboard can never disagree. This builds the content only; the
// web app turns it into PowerPoint, Excel and a printable PDF page.

import { DateTime } from 'luxon';
import {
  DOWNLINE_STAGES,
  buildEvents,
  computeKpis,
  downlineQueue,
  downtimePareto,
  fieldRepairShare,
  lineOccupancy,
  shopReleaseVsPlan,
  type KpiInput,
  type KpiResult,
  type Period,
} from './kpis.js';
import { ms } from './time.js';
import type { Iso, ShopLine, ShopLineClosure, Stage } from './types.js';

export interface PackTargets {
  pa: number;
  utilisation: number;
}

export interface PackInput extends KpiInput {
  timeZone: string;
  siteName: string;
  fleetName: string;
  shopLines: ShopLine[];
  closures: ShopLineClosure[];
  targets: PackTargets;
  /** Any time inside the week to report. The week runs Monday 00:00 to Monday 00:00 site time. */
  weekOf: Iso;
  /** Weeks of trend, ending with the reported week. */
  trendWeeks?: number;
}

export interface WeeklyPack {
  title: string;
  siteName: string;
  fleetName: string;
  timeZone: string;
  week: Period & { label: string };
  /** True if the week has not ended yet. */
  partial: boolean;
  generatedAt: Iso;
  targets: PackTargets;
  kpis: KpiResult;
  prior: KpiResult;
  trend: Array<{ label: string; pa: number | null; utilisation: number | null; mtbf: number | null; failures: number }>;
  pareto: Array<{ system: string; hours: number; events: number; cumulative: number }>;
  /** Downline (waiting for crew, in transit, waiting for a line), repair and other waiting, in hours. */
  timeSplit: { downline: number; repair: number; waitingParts: number; waitingOther: number; ready: number };
  stageHours: Record<Stage, number>;
  shop: {
    releaseVsPlan: { due: number; onTime: number; rate: number | null };
    fieldRepair: { events: number; field: number; share: number | null };
    lines: Array<{ name: string; occupancy: number | null; occupiedHours: number; openHours: number }>;
  };
  badActors: Array<{ unit: string; model: string; unscheduledDownHours: number; failures: number; pa: number | null; topSystem: string }>;
  downNow: Array<{ unit: string; since: Iso; hours: number; reason: string; stage: Stage | undefined; downline: boolean }>;
  notes: string[];
}

export function weeklyPack(input: PackInput): WeeklyPack {
  const tz = input.timeZone;
  const start = DateTime.fromISO(input.weekOf, { zone: tz }).startOf('week');
  const weekEnd = start.plus({ weeks: 1 });
  const nowMs = ms(input.now);
  const to = Math.min(ms(weekEnd.toUTC().toISO()!), nowMs);
  const week = { from: start.toUTC().toISO()!, to: new Date(to).toISOString(), label: start.toFormat('d LLL yyyy') };
  const prevP: Period = { from: start.minus({ weeks: 1 }).toUTC().toISO()!, to: week.from };
  const kpis = computeKpis(input, week);
  const prior = computeKpis(input, prevP);

  const n = input.trendWeeks ?? 12;
  const trend = Array.from({ length: n }, (_, i) => {
    const s = start.minus({ weeks: n - 1 - i });
    const e = Math.min(ms(s.plus({ weeks: 1 }).toUTC().toISO()!), nowMs);
    const k = computeKpis(input, { from: s.toUTC().toISO()!, to: new Date(e).toISOString() });
    return { label: s.toFormat('dd LLL'), pa: k.pa, utilisation: k.utilisation, mtbf: k.mtbf, failures: k.failures };
  });

  const pareto = downtimePareto(input, week).map((r) => ({ system: r.key, hours: r.hours, events: r.events, cumulative: r.cumulative }));
  const sh = kpis.stageHours;
  const timeSplit = {
    downline: DOWNLINE_STAGES.reduce((s, k) => s + sh[k], 0),
    repair: sh.in_repair,
    waitingParts: sh.waiting_parts,
    waitingOther: sh.waiting_labour + sh.waiting_other,
    ready: sh.ready_for_release,
  };

  const unitFlags = input.flags.filter((f) => input.assets.some((a) => a.id === f.unitId));
  const events = buildEvents(unitFlags, input.rules, input.now);
  const lines = input.shopLines.map((l) => {
    const o = lineOccupancy(l, unitFlags, input.closures, week, input.now);
    return { name: l.name ?? `Line ${l.number}`, ...o };
  });

  const bad = input.assets
    .map((a) => {
      const k = computeKpis({ ...input, assets: [a] }, week);
      const top = downtimePareto({ ...input, assets: [a] }, week)[0];
      return { unit: a.unitNumber, model: a.model, unscheduledDownHours: k.unscheduledDownHours, failures: k.failures, pa: k.pa, topSystem: top?.key ?? '' };
    })
    .filter((x) => x.unscheduledDownHours > 0)
    .sort((x, y) => y.unscheduledDownHours - x.unscheduledDownHours)
    .slice(0, 10);

  const name = new Map(input.assets.map((a) => [a.id, a.unitNumber]));
  const queue = new Set(downlineQueue(unitFlags, input.now).map((q) => q.flag.id));
  const downNow = unitFlags
    .filter((f) => f.state === 'open')
    .map((f) => ({
      unit: name.get(f.unitId) ?? f.unitId,
      since: f.start,
      hours: (nowMs - ms(f.start)) / 3_600_000,
      reason: f.release?.system ?? f.system ?? f.reasonCode,
      stage: f.stages.at(-1)?.stage,
      downline: queue.has(f.id),
    }))
    .sort((a, b) => b.hours - a.hours);

  const notes: string[] = [];
  const partial = ms(weekEnd.toUTC().toISO()!) > nowMs;
  if (partial) notes.push(`Week in progress: figures run to ${DateTime.fromMillis(nowMs, { zone: tz }).toFormat('ccc d LLL HH:mm')} site time.`);
  if (kpis.utilisation === null) notes.push('No SMU readings cover this week, so utilisation and MTBF are blank.');

  return {
    title: `${input.fleetName} weekly performance`,
    siteName: input.siteName,
    fleetName: input.fleetName,
    timeZone: tz,
    week,
    partial,
    generatedAt: input.now,
    targets: input.targets,
    kpis,
    prior,
    trend,
    pareto,
    timeSplit,
    stageHours: sh,
    shop: { releaseVsPlan: shopReleaseVsPlan(unitFlags, week, input.rules), fieldRepair: fieldRepairShare(events, week), lines },
    badActors: bad,
    downNow,
    notes,
  };
}
