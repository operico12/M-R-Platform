// Reliability and threshold alerts (phase 2, plan section 4 "Alerts and
// notifications" and 11.4). Plain rules, each explained in words with the
// numbers and sample size behind it. Definitions and defaults:
// docs/alert-rules.md (RA-1 to RA-6, TA-1 and TA-2). The A7 flag checks stay
// in alerts.ts. Pure: given the records and the time, return the alerts.

import { DateTime } from 'luxon';
import type { ConsoleContext, ConsoleResult, Target, TargetKpi } from './console.js';
import { TARGET_KPIS, rag, targetValue } from './console.js';
import { EMPTY_FILTER, filterToQuery, flagSystem, type AnalyticsFilter } from './filters.js';
import { buildEvents, computeKpis, type DowntimeEvent, type KpiInput, type KpiResult, type Period } from './kpis.js';
import { can, permission } from './permissions.js';
import { HOUR_MS, ms } from './time.js';
import type { Iso, Role, WorkOrder } from './types.js';
import { DEFAULT_WORK_SETTINGS, pmCompliance, type WorkSettings } from './work.js';

// ---------- settings ----------

export interface AlertSettings {
  repeatOffender: { enabled: boolean; failures: number; days: number };
  mtbfDrop: { enabled: boolean; windowDays: number; baselineDays: number; dropPct: number; minFailures: number };
  repairSpike: { enabled: boolean; multiple: number; baselineDays: number; minEvents: number; lookbackDays: number };
  cluster: { enabled: boolean; units: number; days: number };
  chronic: { enabled: boolean; windowDays: number; multiple: number; minSharePct: number };
  silent: { enabled: boolean; hours: number; minRise: number };
  pmOverdue: { enabled: boolean };
  kpiBelow: { enabled: boolean };
  /** Days a "noted" alert stays hidden before it shows again if still true. */
  snoozeDays: number;
}

/** Starting points for the site to agree (docs/alert-rules.md), not plan decisions. */
export const DEFAULT_ALERT_SETTINGS: AlertSettings = {
  repeatOffender: { enabled: true, failures: 3, days: 30 },
  mtbfDrop: { enabled: true, windowDays: 28, baselineDays: 90, dropPct: 25, minFailures: 5 },
  repairSpike: { enabled: true, multiple: 3, baselineDays: 90, minEvents: 5, lookbackDays: 7 },
  cluster: { enabled: true, units: 3, days: 7 },
  chronic: { enabled: true, windowDays: 28, multiple: 2, minSharePct: 10 },
  silent: { enabled: true, hours: 24, minRise: 0.5 },
  pmOverdue: { enabled: true },
  kpiBelow: { enabled: true },
  snoozeDays: 7,
};

/** A stored value merged over the defaults, so a rule added later gets its default. */
export function withAlertDefaults(v: Partial<AlertSettings> | undefined): AlertSettings {
  const d = DEFAULT_ALERT_SETTINGS;
  const o = (v ?? {}) as Record<string, unknown>;
  const out = { ...d } as Record<string, unknown>;
  for (const k of Object.keys(d) as Array<keyof AlertSettings>) {
    const dv = d[k];
    out[k] = typeof dv === 'object' ? { ...dv, ...((o[k] as object | undefined) ?? {}) } : typeof o[k] === 'number' ? o[k] : dv;
  }
  return out as unknown as AlertSettings;
}

export type RuleAlertKind = 'repeat_offender' | 'mtbf_drop' | 'repair_spike' | 'cluster' | 'chronic' | 'silent' | 'pm_overdue' | 'kpi_below';

export const RULE_ALERTS: Record<RuleAlertKind, { id: string; label: string; group: 'reliability' | 'threshold'; goesTo: Role[] | string[] }> = {
  repeat_offender: { id: 'RA-1', label: 'Repeat offender', group: 'reliability', goesTo: ['reliability_engineer', 'supervisor'] },
  mtbf_drop: { id: 'RA-2', label: 'MTBF drop', group: 'reliability', goesTo: ['reliability_engineer', 'superintendent'] },
  repair_spike: { id: 'RA-3', label: 'Repair time spike', group: 'reliability', goesTo: ['reliability_engineer', 'supervisor'] },
  cluster: { id: 'RA-4', label: 'Failure cluster', group: 'reliability', goesTo: ['reliability_engineer'] },
  chronic: { id: 'RA-5', label: 'Chronic unscheduled', group: 'reliability', goesTo: ['reliability_engineer', 'superintendent'] },
  silent: { id: 'RA-6', label: 'Silent unit', group: 'reliability', goesTo: ['supervisor'] },
  pm_overdue: { id: 'TA-1', label: 'PM overdue', group: 'threshold', goesTo: ['planner', 'supervisor'] },
  kpi_below: { id: 'TA-2', label: 'KPI below target', group: 'threshold', goesTo: ['superintendent', 'reliability_engineer'] },
};

const between = (n: number, lo: number, hi: number) => Number.isFinite(n) && n >= lo && n <= hi;

export function setAlertSettings(ctx: ConsoleContext, current: AlertSettings, next: AlertSettings, reason: string): ConsoleResult<AlertSettings> {
  if (!can(ctx.actor, 'edit_alert_rules')) return { ok: false, errors: ['Your role cannot change alert rules.'] };
  const e: string[] = [];
  const whole = (n: number, lo: number, hi: number, what: string) => { if (!Number.isInteger(n) || !between(n, lo, hi)) e.push(`${what} must be a whole number from ${lo} to ${hi}.`); };
  const num = (n: number, lo: number, hi: number, what: string) => { if (!between(n, lo, hi)) e.push(`${what} must be from ${lo} to ${hi}.`); };
  whole(next.repeatOffender.failures, 2, 50, 'Repeat offender failures');
  whole(next.repeatOffender.days, 1, 365, 'Repeat offender days');
  whole(next.mtbfDrop.windowDays, 7, 180, 'MTBF window');
  whole(next.mtbfDrop.baselineDays, 14, 730, 'MTBF baseline');
  num(next.mtbfDrop.dropPct, 1, 95, 'MTBF drop %');
  whole(next.mtbfDrop.minFailures, 1, 100, 'MTBF minimum failures');
  num(next.repairSpike.multiple, 1.5, 20, 'Repair spike multiple');
  whole(next.repairSpike.baselineDays, 14, 730, 'Repair spike baseline');
  whole(next.repairSpike.minEvents, 3, 100, 'Repair spike minimum events');
  whole(next.repairSpike.lookbackDays, 1, 60, 'Repair spike look-back');
  whole(next.cluster.units, 2, 50, 'Cluster units');
  whole(next.cluster.days, 1, 60, 'Cluster days');
  whole(next.chronic.windowDays, 7, 180, 'Chronic window');
  num(next.chronic.multiple, 1, 20, 'Chronic multiple');
  num(next.chronic.minSharePct, 0, 100, 'Chronic minimum share');
  num(next.silent.hours, 12, 168, 'Silent unit hours');
  num(next.silent.minRise, 0, 24, 'Silent unit SMU rise');
  whole(next.snoozeDays, 1, 90, 'Snooze days');
  if (!reason.trim()) e.push('Give a reason for the change.');
  if (e.length) return { ok: false, errors: e };
  const clean = withAlertDefaults(next);
  return { ok: true, records: [clean], audit: [{ at: ctx.now, userId: ctx.actor.userId, action: 'set_alert_rules', entity: 'settings', entityId: 'alerts', before: current, after: clean, reason: reason.trim() }], warnings: [] };
}

// ---------- the alerts ----------

export interface RuleAlert {
  /** Answers apply to this key only (docs/alert-rules.md "Alert identity"). */
  key: string;
  kind: RuleAlertKind;
  title: string;
  /** What was found, in words, with the numbers. */
  detail: string;
  /** The sample behind it, for example "4 failures". */
  basedOn: string;
  since: Iso;
  unitId?: string;
  fleet?: string;
  model?: string;
  system?: string;
  workOrderId?: string;
  /** Analysis filter (filterToQuery) showing the events behind the alert. */
  query?: string;
  eventIds: string[];
  goesTo: string[];
}

export interface AlertingInput extends KpiInput {
  timeZone: string;
  workOrders: WorkOrder[];
  targets: Target[];
  workSettings?: WorkSettings;
}

const DAY = 24 * HOUR_MS;
const iso = (t: number) => new Date(t).toISOString();
const hoursOf = (e: DowntimeEvent, now: Iso) => (ms(e.end ?? now) - ms(e.start)) / HOUR_MS;
const sysOf = (e: DowntimeEvent) => e.system ?? (e.flags[0] ? flagSystem(e.flags[0]) : '');
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const h1 = (h: number) => (h >= 100 ? h.toFixed(0) : h.toFixed(1));
const pct = (x: number) => `${Math.round(x * 100)}%`;
/** Site-local date of an instant, for filter ranges and keys. */
const localDate = (t: Iso | number, tz: string) => DateTime.fromMillis(typeof t === 'number' ? t : ms(t), { zone: tz }).toISODate()!;
const weekKey = (now: Iso, tz: string) => DateTime.fromISO(now, { zone: tz }).startOf('week').toISODate()!;
const query = (tz: string, from: number, to: Iso, f: Partial<AnalyticsFilter>) =>
  filterToQuery({ ...EMPTY_FILTER, ...f, range: { from: localDate(from, tz), to: localDate(to, tz) } });

/** Every rule alert that is true now. Answered ones are filtered by openAlerts. */
export function ruleAlerts(input: AlertingInput, s: AlertSettings = DEFAULT_ALERT_SETTINGS): RuleAlert[] {
  const now = ms(input.now);
  const tz = input.timeZone;
  const unit = new Map(input.assets.map((a) => [a.id, a]));
  const name = (id: string) => unit.get(id)?.unitNumber ?? id;
  const events = buildEvents(input.flags, input.rules, input.now).filter((e) => unit.has(e.unitId));
  const failures = events.filter((e) => e.isFailure).sort((a, b) => ms(a.start) - ms(b.start));
  const out: RuleAlert[] = [];
  const meta = (k: RuleAlertKind) => ({ kind: k, goesTo: [...RULE_ALERTS[k].goesTo] });

  // RA-1 repeat offender
  if (s.repeatOffender.enabled) {
    const from = now - s.repeatOffender.days * DAY;
    const groups = new Map<string, DowntimeEvent[]>();
    for (const e of failures) {
      if (ms(e.start) < from) continue;
      const k = `${e.unitId}|${sysOf(e)}`;
      groups.set(k, [...(groups.get(k) ?? []), e]);
    }
    for (const list of groups.values()) {
      if (list.length < s.repeatOffender.failures) continue;
      const last = list.at(-1)!;
      const sys = sysOf(last);
      const hrs = list.reduce((t, e) => t + hoursOf(e, input.now), 0);
      out.push({
        ...meta('repeat_offender'), key: `repeat_offender:${last.unitId}:${sys}:${last.id}`,
        title: `${name(last.unitId)}: ${list.length} failures on ${sys} in ${s.repeatOffender.days} days`,
        detail: `${name(last.unitId)} has had ${list.length} failures on ${sys} that started in the last ${s.repeatOffender.days} days, ${h1(hrs)} h down in total. The rule is ${s.repeatOffender.failures} or more.`,
        basedOn: `${list.length} failures`, since: list[0]!.start, unitId: last.unitId, system: sys,
        query: query(tz, from, input.now, { units: [last.unitId], systems: [sys], failuresOnly: true }), eventIds: list.map((e) => e.id),
      });
    }
  }

  // RA-2 MTBF drop, by model
  const models = [...new Set(input.assets.map((a) => a.model))].sort();
  const kpisFor = (assets: typeof input.assets, p: Period): KpiResult => {
    const ids = new Set(assets.map((a) => a.id));
    return computeKpis({ ...input, assets, flags: input.flags.filter((f) => ids.has(f.unitId)), smu: input.smu.filter((r) => ids.has(r.unitId)) }, p);
  };
  if (s.mtbfDrop.enabled) {
    const w = s.mtbfDrop.windowDays * DAY;
    const recentP = { from: iso(now - w), to: input.now };
    const baseP = { from: iso(now - w - s.mtbfDrop.baselineDays * DAY), to: iso(now - w) };
    for (const m of models) {
      const assets = input.assets.filter((a) => a.model === m);
      const r = kpisFor(assets, recentP);
      const b = kpisFor(assets, baseP);
      if (r.failures < s.mtbfDrop.minFailures || r.mtbf === null || b.mtbf === null || b.mtbf <= 0) continue;
      const drop = 1 - r.mtbf / b.mtbf;
      if (drop * 100 < s.mtbfDrop.dropPct) continue;
      out.push({
        ...meta('mtbf_drop'), key: `mtbf_drop:${m}:${weekKey(input.now, tz)}`,
        title: `${m}: MTBF down ${pct(drop)}`,
        detail: `${m} MTBF was ${h1(r.mtbf)} h over the last ${s.mtbfDrop.windowDays} days (${r.failures} failures in ${h1(r.operatingHours)} operating h), against ${h1(b.mtbf)} h over the ${s.mtbfDrop.baselineDays} days before (${b.failures} failures). The rule is a drop of ${s.mtbfDrop.dropPct}% or more.`,
        basedOn: `${r.failures} failures, ${b.failures} in the baseline`, since: recentP.from, model: m,
        query: query(tz, now - w, input.now, { models: [m], failuresOnly: true }), eventIds: [],
      });
    }
  }

  // RA-3 repair time spike
  if (s.repairSpike.enabled) {
    const from = now - s.repairSpike.lookbackDays * DAY;
    for (const e of failures) {
      if (e.end && ms(e.end) < from) continue;
      const sys = sysOf(e);
      const start = ms(e.start);
      const base = failures.filter((x) => x.id !== e.id && x.end && sysOf(x) === sys && ms(x.start) < start && ms(x.start) >= start - s.repairSpike.baselineDays * DAY);
      if (base.length < s.repairSpike.minEvents) continue;
      const med = median(base.map((x) => hoursOf(x, input.now)));
      const hrs = hoursOf(e, input.now);
      if (med <= 0 || hrs < s.repairSpike.multiple * med) continue;
      out.push({
        ...meta('repair_spike'), key: `repair_spike:${e.id}`,
        title: `${name(e.unitId)}: ${sys} repair ${(hrs / med).toFixed(1)} times the usual`,
        detail: `${name(e.unitId)} ${e.end ? 'was' : 'has been'} down ${h1(hrs)} h for a failure on ${sys}${e.end ? '' : ' and is still down'}. The median for ${sys} failures in the ${s.repairSpike.baselineDays} days before was ${h1(med)} h. The rule is ${s.repairSpike.multiple} times the median or more.`,
        basedOn: `${base.length} earlier ${sys} failures`, since: e.start, unitId: e.unitId, system: sys,
        query: query(tz, start, e.end ?? input.now, { units: [e.unitId], systems: [sys] }), eventIds: [e.id],
      });
    }
  }

  // RA-4 failure cluster: same system and component on several units
  if (s.cluster.enabled) {
    const from = now - s.cluster.days * DAY;
    const groups = new Map<string, DowntimeEvent[]>();
    for (const e of failures) {
      if (ms(e.start) < from) continue;
      const comp = e.flags.map((f) => f.release?.component?.trim()).find((c) => c && c.toLowerCase() !== 'other');
      if (!comp) continue;
      const k = `${sysOf(e)}|${comp}`;
      groups.set(k, [...(groups.get(k) ?? []), e]);
    }
    for (const [k, list] of groups) {
      const units = new Set(list.map((e) => e.unitId));
      if (units.size < s.cluster.units) continue;
      const [sys, comp] = k.split('|') as [string, string];
      const last = list.at(-1)!;
      out.push({
        ...meta('cluster'), key: `cluster:${sys}:${comp}:${last.id}`,
        title: `${comp} failures on ${units.size} units in ${s.cluster.days} days`,
        detail: `${units.size} units had a failure on the ${comp} (${sys}) in the last ${s.cluster.days} days: ${[...units].map(name).sort().join(', ')}. A cluster can point at a parts batch, a procedure or conditions. The rule is ${s.cluster.units} units or more.`,
        basedOn: `${list.length} failures`, since: list[0]!.start, system: sys,
        query: query(tz, from, input.now, { systems: [sys], components: [comp], failuresOnly: true }), eventIds: list.map((e) => e.id),
      });
    }
  }

  // RA-5 chronic unscheduled, by unit against its model
  if (s.chronic.enabled) {
    const p = { from: iso(now - s.chronic.windowDays * DAY), to: input.now };
    for (const m of models) {
      const assets = input.assets.filter((a) => a.model === m);
      const rows = assets.map((a) => ({ a, k: kpisFor([a], p) })).filter((x) => x.k.calendarHours > 0);
      if (rows.length < 2) continue;
      const med = median(rows.map((x) => x.k.unscheduledDownHours));
      for (const { a, k } of rows) {
        const share = k.unscheduledDownHours / k.calendarHours;
        if (k.unscheduledDownHours < s.chronic.multiple * med || share * 100 < s.chronic.minSharePct || k.unscheduledDownHours <= 0) continue;
        out.push({
          ...meta('chronic'), key: `chronic:${a.id}:${weekKey(input.now, tz)}`,
          title: `${a.unitNumber}: unscheduled down ${pct(share)} of the time`,
          detail: `${a.unitNumber} was down unscheduled ${h1(k.unscheduledDownHours)} h in the last ${s.chronic.windowDays} days (${pct(share)} of its calendar hours). The median ${m} unit was ${h1(med)} h. The rule is ${s.chronic.multiple} times the median and at least ${s.chronic.minSharePct}%.`,
          basedOn: `${rows.length} ${m} units`, since: p.from, unitId: a.id, model: m,
          query: query(tz, now - s.chronic.windowDays * DAY, input.now, { units: [a.id], types: ['unscheduled'] }), eventIds: [],
        });
      }
    }
  }

  // RA-6 silent unit: not flagged down, SMU barely moved
  if (s.silent.enabled) {
    const parked = (id: string) => (input.lifecycle ?? []).some((l) => l.assetId === id && l.status !== 'active' && ms(l.start) <= now && (!l.end || ms(l.end) > now));
    for (const a of input.assets) {
      if (a.assetClass !== 'mobile' || parked(a.id)) continue;
      const rs = input.smu.filter((r) => r.unitId === a.id && ms(r.at) <= now).sort((x, y) => ms(x.at) - ms(y.at));
      const r1 = rs.at(-1);
      const r0 = [...rs].reverse().find((r) => ms(r.at) <= now - s.silent.hours * HOUR_MS);
      if (!r0 || !r1 || r0 === r1 || ms(r1.at) - ms(r0.at) < (s.silent.hours - 1) * HOUR_MS) continue;
      const down = input.flags.some((f) => f.unitId === a.id && (f.state === 'open' || f.state === 'released') && ms(f.start) < ms(r1.at) && (!f.end || ms(f.end) > ms(r0.at)));
      if (down) continue;
      const rise = r1.hours - r0.hours;
      if (rise >= s.silent.minRise) continue;
      const span = (ms(r1.at) - ms(r0.at)) / HOUR_MS;
      out.push({
        ...meta('silent'), key: `silent:${a.id}:${localDate(input.now, tz)}`,
        title: `${a.unitNumber}: SMU rose ${h1(rise)} h in ${h1(span)} h, not flagged down`,
        detail: `${a.unitNumber} is not flagged down, but its SMU rose only ${h1(rise)} h over the last ${h1(span)} h. Either it is on standby, or it should be flagged down. The rule is less than ${s.silent.minRise} h.`,
        basedOn: `SMU readings ${h1(span)} h apart`, since: r0.at, unitId: a.id, eventIds: [],
      });
    }
  }

  // TA-1 PM overdue
  if (s.pmOverdue.enabled) {
    const ws = input.workSettings ?? DEFAULT_WORK_SETTINGS;
    const pc = pmCompliance(input.workOrders, { from: iso(now - 366 * DAY), to: input.now }, input.now, tz, ws);
    for (const { wo } of pc.rows.filter((r) => r.result === 'missed')) {
      const days = Math.floor((now - ms(wo.targetFinish!)) / DAY);
      const u = wo.assetId ? name(wo.assetId) : wo.externalAssetId ?? 'No unit';
      out.push({
        ...meta('pm_overdue'), key: `pm_overdue:${wo.id}`,
        title: `${u}: PM ${wo.number} overdue`,
        detail: `PM work order ${wo.number}${wo.description ? ` (${wo.description})` : ''} on ${u} was due ${localDate(wo.targetFinish!, tz)}, ${days} days ago, and is still open past the ${ws.pmToleranceDays}-day tolerance.`,
        basedOn: '1 work order', since: wo.targetFinish!, unitId: wo.assetId, workOrderId: wo.id, eventIds: [],
      });
    }
  }

  // TA-2 KPI below target, by fleet, from midnight 7 days ago (site time)
  if (s.kpiBelow.enabled) {
    const from = DateTime.fromISO(input.now, { zone: tz }).minus({ days: 7 }).startOf('day');
    const p = { from: from.toUTC().toISO()!, to: input.now };
    const val: Record<TargetKpi, (k: KpiResult) => number | null> = { pa: (k) => k.pa, utilisation: (k) => k.utilisation, mtbf: (k) => k.mtbf, mttr: (k) => k.mttr, mean_downtime: (k) => k.meanDowntime };
    for (const fleet of [...new Set(input.assets.map((a) => a.fleet))].sort()) {
      const k = kpisFor(input.assets.filter((a) => a.fleet === fleet), p);
      for (const kpi of Object.keys(TARGET_KPIS) as TargetKpi[]) {
        const t = targetValue(input.targets, kpi, { fleet }, input.now);
        if (!t?.set) continue;
        const v = val[kpi](k);
        if (rag(kpi, v, t) !== 'red') continue;
        const meta2 = TARGET_KPIS[kpi];
        const show = (x: number) => (meta2.unit === '%' ? pct(x) : `${h1(x)} h`);
        out.push({
          ...meta('kpi_below'), key: `kpi_below:${fleet}:${kpi}:${weekKey(input.now, tz)}`,
          title: `${fleet}: ${meta2.label} ${show(v!)} against ${show(t.value)}`,
          detail: `${fleet} ${meta2.label} was ${show(v!)} over the last 7 days, against a target of ${show(t.value)}. That is past the amber band of ${show(t.amber)}, so it is red.`,
          basedOn: `${k.events} events, ${h1(k.calendarHours)} calendar h`, since: p.from, fleet,
          query: query(tz, ms(p.from), input.now, { fleets: [fleet] }), eventIds: [],
        });
      }
    }
  }

  return out;
}

// ---------- answering ----------

export type AlertDecision = 'noted' | 'not_a_problem' | 'action_raised';

export const DECISION_LABELS: Record<AlertDecision, string> = { noted: 'Noted', not_a_problem: 'Not a problem', action_raised: 'Action raised' };

export interface AlertAnswer {
  id: string;
  alertKey: string;
  kind: RuleAlertKind;
  unitId?: string;
  /** The alert's title when it was answered, so the record reads on its own. */
  title: string;
  decision: AlertDecision;
  note: string;
  actionId?: string;
  answeredBy: string;
  answeredAt: Iso;
}

export function answerAlert(ctx: ConsoleContext, alert: RuleAlert, decision: AlertDecision, note: string, actionId?: string): ConsoleResult<AlertAnswer> {
  if (!can(ctx.actor, 'create_actions')) return { ok: false, errors: ['Your role cannot answer alerts.'] };
  const e: string[] = [];
  if (decision === 'not_a_problem' && !note.trim()) e.push('Say why it is not a problem.');
  if (decision === 'action_raised' && !actionId) e.push('Pick the action that was raised.');
  if (e.length) return { ok: false, errors: e };
  const a: AlertAnswer = {
    id: ctx.newId(), alertKey: alert.key, kind: alert.kind, unitId: alert.unitId, title: alert.title, decision, note: note.trim(),
    actionId: decision === 'action_raised' ? actionId : undefined, answeredBy: ctx.actor.userId, answeredAt: ctx.now,
  };
  return { ok: true, records: [a], audit: [{ at: ctx.now, userId: ctx.actor.userId, action: `alert_${decision}`, entity: 'alert', entityId: a.id, before: null, after: a, reason: a.note || undefined }], warnings: [] };
}

/**
 * Splits alerts into open and answered. The newest answer for a key counts.
 * "Noted" hides an alert until midnight site time on the day snoozeDays after the answer; the other answers hide it for good.
 */
export function openAlerts(alerts: RuleAlert[], answers: AlertAnswer[], now: Iso, snoozeDays: number, timeZone: string): { open: RuleAlert[]; answered: Array<{ alert: RuleAlert; answer: AlertAnswer; until?: Iso }> } {
  const latest = new Map<string, AlertAnswer>();
  for (const a of answers) {
    const prev = latest.get(a.alertKey);
    if (!prev || ms(a.answeredAt) >= ms(prev.answeredAt)) latest.set(a.alertKey, a);
  }
  const open: RuleAlert[] = [];
  const answered: Array<{ alert: RuleAlert; answer: AlertAnswer; until?: Iso }> = [];
  for (const al of alerts) {
    const a = latest.get(al.key);
    if (!a) { open.push(al); continue; }
    if (a.decision === 'noted') {
      // Site days: shown again from midnight site time on the day snoozeDays after the answer.
      const until = ms(DateTime.fromISO(a.answeredAt, { zone: timeZone }).plus({ days: snoozeDays }).startOf('day').toUTC().toISO()!);
      if (ms(now) >= until) { open.push(al); continue; }
      answered.push({ alert: al, answer: a, until: iso(until) });
    } else answered.push({ alert: al, answer: a });
  }
  return { open, answered };
}

/** Whether a role can change alert rules (for showing the console tab). */
export const canEditAlertRules = (role: Role) => permission(role, 'edit_alert_rules') === 'yes';
