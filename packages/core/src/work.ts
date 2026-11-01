// Work and PM management view (phase 2, plan 3.3 tier 2 and the "Work"
// module): PM compliance, schedule compliance, planned and emergency work,
// backlog in weeks split ready from waiting, work found by inspections, and
// work order aging. Definitions: docs/kpi-dictionary.md KPI-018 to KPI-023.
// Pure functions over imported ERP work orders; the ERP stays the record.

import { DateTime } from 'luxon';
import { MAXIMO_DEFAULT_MAPPING, normaliseWoNumber, statusWords } from './imports.js';
import { permission } from './permissions.js';
import type { Period } from './kpis.js';
import { ms } from './time.js';
import type { ConsoleContext, ConsoleResult } from './console.js';
import type { Iso, WorkOrder, WorkReadiness } from './types.js';

export interface WorkSettings {
  /** Craft hours available a week for backlog work. 0 = not set, so backlog weeks are not shown. */
  craftHoursPerWeek: number;
  /** Days after a PM's due date it still counts as on time (KPI-018). Site to agree. */
  pmToleranceDays: number;
  /** ERP work types that are break-in (emergency) work. */
  emergencyTypes: string[];
  /** ERP priorities that are break-in work. */
  emergencyPriorities: string[];
}

export const DEFAULT_WORK_SETTINGS: WorkSettings = { craftHoursPerWeek: 0, pmToleranceDays: 3, emergencyTypes: ['EM', 'BD'], emergencyPriorities: ['1'] };

export const READINESS_LABELS: Record<WorkReadiness, string> = {
  ready: 'Ready to schedule',
  in_progress: 'In progress',
  waiting_approval: 'Waiting approval',
  waiting_parts: 'Waiting parts',
  waiting_shutdown: 'Waiting shutdown',
  unknown: 'Status not mapped',
};

/** Most limiting first (docs/field-mapping.md): a status with several words takes the first of these it maps to. */
const LIMITING: WorkReadiness[] = ['waiting_approval', 'waiting_parts', 'waiting_shutdown', 'in_progress', 'ready'];

export function readiness(w: WorkOrder, map: Record<string, WorkReadiness> = MAXIMO_DEFAULT_MAPPING.readiness): WorkReadiness {
  const found = new Set(statusWords(w.status).map((x) => map[x]).filter((x): x is WorkReadiness => !!x));
  return LIMITING.find((r) => found.has(r)) ?? 'unknown';
}

/** Cancelled: CAN in Maximo, the deletion flag DLFL in SAP. */
const isCancelled = (w: WorkOrder) => statusWords(w.status).some((x) => x === 'CAN' || x === 'DLFL');
const hoursOf = (w: WorkOrder) => w.actualLabourHours ?? w.estimatedHours;
export const isEmergency = (w: WorkOrder, s: WorkSettings) =>
  s.emergencyTypes.map((x) => x.toUpperCase()).includes((w.woType ?? '').toUpperCase()) || s.emergencyPriorities.includes(w.priority ?? '');

/** End of a site-local day, as an instant: due "on" a date means by the end of it. */
function endOfDay(iso: Iso, tz: string, plusDays = 0): number {
  return ms(DateTime.fromISO(iso, { zone: tz }).plus({ days: plusDays }).endOf('day').toUTC().toISO()!) + 1;
}
const inPeriod = (iso: Iso | undefined, p: Period) => !!iso && ms(iso) >= ms(p.from) && ms(iso) < ms(p.to);

// ---------- KPI-018 PM compliance ----------

export interface PmCompliance {
  due: number;
  onTime: number;
  /** Done, but after the tolerance. */
  late: number;
  /** Still open after the tolerance. */
  missed: number;
  /** Due in the period but still inside the tolerance and not done: not counted yet. */
  pending: number;
  value: number | null;
  /** The PMs behind each number, for drill-down. */
  rows: Array<{ wo: WorkOrder; result: 'on_time' | 'late' | 'missed' | 'pending' }>;
}

export function pmCompliance(wos: WorkOrder[], period: Period, now: Iso, tz: string, s: WorkSettings = DEFAULT_WORK_SETTINGS): PmCompliance {
  const rows: PmCompliance['rows'] = [];
  for (const w of wos) {
    if (w.workClass !== 'pm' || isCancelled(w) || !inPeriod(w.targetFinish, period)) continue;
    const limit = endOfDay(w.targetFinish!, tz, s.pmToleranceDays);
    if (w.completedAt && !w.open) rows.push({ wo: w, result: ms(w.completedAt) < limit ? 'on_time' : 'late' });
    else rows.push({ wo: w, result: ms(now) < limit ? 'pending' : 'missed' });
  }
  const n = (r: string) => rows.filter((x) => x.result === r).length;
  const due = rows.length - n('pending');
  return { due, onTime: n('on_time'), late: n('late'), missed: n('missed'), pending: n('pending'), value: due ? n('on_time') / due : null, rows };
}

// ---------- KPI-019 schedule compliance ----------

export interface WeekCompliance {
  week: string;
  from: Iso;
  scheduled: number;
  done: number;
  value: number | null;
}

/** Weekly, Monday 00:00 site time, across the period. */
export function scheduleCompliance(wos: WorkOrder[], period: Period, now: Iso, tz: string): WeekCompliance[] {
  const out: WeekCompliance[] = [];
  let w = DateTime.fromISO(period.from, { zone: tz }).startOf('week');
  while (ms(w.toUTC().toISO()!) < ms(period.to)) {
    const wk = { from: w.toUTC().toISO()!, to: w.plus({ weeks: 1 }).toUTC().toISO()! };
    // A week is judged once it has ended.
    if (ms(wk.to) <= ms(now)) {
      const sched = wos.filter((x) => !isCancelled(x) && inPeriod(x.scheduledStart, wk));
      const done = sched.filter((x) => x.completedAt && ms(x.completedAt) < endOfDay(x.scheduledFinish ?? x.scheduledStart!, tz)).length;
      out.push({ week: w.toFormat('dd LLL'), from: wk.from, scheduled: sched.length, done, value: sched.length ? done / sched.length : null });
    }
    w = w.plus({ weeks: 1 });
  }
  return out;
}

// ---------- KPI-020 planned and emergency work ----------

export interface WorkMix {
  /** Work orders finished in the period. */
  finished: number;
  hours: number;
  emergencyHours: number;
  plannedShare: number | null;
  emergencyShare: number | null;
  /** Finished with no labour hours or estimate, so not in the hours. */
  noHours: number;
}

export function workMix(wos: WorkOrder[], period: Period, s: WorkSettings = DEFAULT_WORK_SETTINGS): WorkMix {
  const fin = wos.filter((w) => !isCancelled(w) && inPeriod(w.completedAt, period));
  let hours = 0;
  let em = 0;
  let noHours = 0;
  for (const w of fin) {
    const h = hoursOf(w);
    if (h === undefined) { noHours++; continue; }
    hours += h;
    if (isEmergency(w, s)) em += h;
  }
  return { finished: fin.length, hours, emergencyHours: em, plannedShare: hours ? (hours - em) / hours : null, emergencyShare: hours ? em / hours : null, noHours };
}

// ---------- KPI-021 backlog ----------

export interface Backlog {
  open: number;
  hours: Record<WorkReadiness, number>;
  count: Record<WorkReadiness, number>;
  readyHours: number;
  waitingHours: number;
  /** Null until craft hours per week is set. */
  readyWeeks: number | null;
  totalWeeks: number | null;
  noEstimate: WorkOrder[];
}

/** Open work not yet started, plus work in progress, in estimated hours. */
export function backlog(wos: WorkOrder[], s: WorkSettings = DEFAULT_WORK_SETTINGS, map?: Record<string, WorkReadiness>): Backlog {
  const zero = (): Record<WorkReadiness, number> => ({ ready: 0, in_progress: 0, waiting_approval: 0, waiting_parts: 0, waiting_shutdown: 0, unknown: 0 });
  const hours = zero();
  const count = zero();
  const noEstimate: WorkOrder[] = [];
  const open = wos.filter((w) => w.open && !isCancelled(w));
  for (const w of open) {
    const r = readiness(w, map);
    count[r]++;
    if (w.estimatedHours === undefined) noEstimate.push(w);
    else hours[r] += w.estimatedHours;
  }
  const readyHours = hours.ready;
  const waitingHours = hours.waiting_approval + hours.waiting_parts + hours.waiting_shutdown + hours.unknown;
  const total = readyHours + waitingHours + hours.in_progress;
  const per = s.craftHoursPerWeek > 0 ? s.craftHoursPerWeek : null;
  return { open: open.length, hours, count, readyHours, waitingHours, readyWeeks: per ? readyHours / per : null, totalWeeks: per ? total / per : null, noEstimate };
}

// ---------- KPI-022 work from inspections ----------

export function inspectionFinds(wos: WorkOrder[], period: Period): { corrective: number; fromInspection: number; value: number | null; rows: WorkOrder[] } {
  const byNumber = new Map(wos.map((w) => [w.numberNormalised, w]));
  const cm = wos.filter((w) => w.workClass === 'corrective' && !isCancelled(w) && inPeriod(w.reportedAt, period));
  const rows = cm.filter((w) => {
    if (!w.originWorkOrder) return false;
    const o = byNumber.get(normaliseWoNumber(w.originWorkOrder));
    return !!o && (o.workClass === 'pm' || o.workClass === 'inspection');
  });
  return { corrective: cm.length, fromInspection: rows.length, value: cm.length ? rows.length / cm.length : null, rows };
}

// ---------- KPI-023 aging, and PMs due ----------

export const AGE_BUCKETS: Array<[string, number, number]> = [['0–7 days', 0, 8], ['8–30 days', 8, 31], ['31–90 days', 31, 91], ['Over 90 days', 91, Infinity]];

export function aging(wos: WorkOrder[], now: Iso, map?: Record<string, WorkReadiness>) {
  const open = wos.filter((w) => w.open && !isCancelled(w) && w.reportedAt);
  return AGE_BUCKETS.map(([label, lo, hi]) => {
    const inB = open.filter((w) => {
      const d = (ms(now) - ms(w.reportedAt!)) / 864e5;
      return d >= lo && d < hi;
    });
    const by: Partial<Record<WorkReadiness, number>> = {};
    for (const w of inB) { const r = readiness(w, map); by[r] = (by[r] ?? 0) + 1; }
    return { label, count: inB.length, by, rows: inB };
  });
}

/** Open PMs due (target finish) from now to the end of the site day `days` ahead, plus any already overdue. */
export function pmsDue(wos: WorkOrder[], now: Iso, tz: string, days = 7): Array<{ wo: WorkOrder; overdue: boolean }> {
  const until = endOfDay(now, tz, days);
  return wos
    .filter((w) => w.workClass === 'pm' && w.open && !isCancelled(w) && w.targetFinish && ms(w.targetFinish) < until)
    .map((w) => ({ wo: w, overdue: endOfDay(w.targetFinish!, tz) <= ms(now) }))
    .sort((a, b) => ms(a.wo.targetFinish!) - ms(b.wo.targetFinish!));
}

// ---------- settings ----------

/** The reliability engineer or superintendent sets these, like targets (plan 11.2 "KPI targets and thresholds"). */
export function setWorkSettings(ctx: ConsoleContext, current: WorkSettings, next: WorkSettings, reason: string): ConsoleResult<WorkSettings> {
  if (!['yes', 'propose', 'approve'].includes(permission(ctx.actor, 'change_targets'))) return { ok: false, errors: ['Your role cannot change work settings.'] };
  const e: string[] = [];
  if (!Number.isFinite(next.craftHoursPerWeek) || next.craftHoursPerWeek < 0) e.push('Craft hours per week cannot be negative.');
  if (!Number.isInteger(next.pmToleranceDays) || next.pmToleranceDays < 0 || next.pmToleranceDays > 60) e.push('PM tolerance is whole days, 0 to 60.');
  if (!reason.trim()) e.push('Give a reason for the change.');
  if (e.length) return { ok: false, errors: e };
  const clean: WorkSettings = {
    craftHoursPerWeek: next.craftHoursPerWeek, pmToleranceDays: next.pmToleranceDays,
    emergencyTypes: [...new Set(next.emergencyTypes.map((x) => x.trim().toUpperCase()).filter(Boolean))],
    emergencyPriorities: [...new Set(next.emergencyPriorities.map((x) => x.trim()).filter(Boolean))],
  };
  return { ok: true, records: [clean], audit: [{ at: ctx.now, userId: ctx.actor.userId, action: 'set_work_settings', entity: 'settings', entityId: 'work', before: current, after: clean, reason: reason.trim() }], warnings: [] };
}
