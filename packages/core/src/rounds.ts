// Operator rounds and lube routes (phase 3b part 2, docs/fixed-plant.md
// "Operator rounds and lube routes"; KPI-042). A route is an inspection form
// with stops. A round makes one inspection per stop done, so scoring, defects,
// sign-off and the equipment's history are the inspection rules.

import { DateTime } from 'luxon';
import type { ConsoleContext } from './console.js';
import { siteToday } from './improve.js';
import { latestForms, signOff, submitInspection, voidInspection, type DueState, type Inspection, type InspectionForm } from './inspections.js';
import type { Period } from './kpis.js';
import { can, permission } from './permissions.js';
import { ms, shiftsBetween, toIso, type ShiftCalendar } from './time.js';
import type { Asset, AuditEntry, Iso } from './types.js';

export interface SkippedStop {
  stopId: string;
  reason: string;
}

export interface Round {
  id: string;
  formId: string;
  formVersion: number;
  nodeId: string;
  status: 'draft' | 'submitted' | 'voided';
  startedBy: string;
  startedAt: Iso;
  submittedAt?: Iso;
  skipped: SkippedStop[];
  voidedBy?: string;
  voidedAt?: Iso;
  voidReason?: string;
}

export const ROUND_SKIP_REASONS = ['Equipment down', 'Isolated', 'No access', 'Not running'];

export const routeForms = (forms: InspectionForm[]) => latestForms(forms).filter((f) => f.route && !f.retiredAt);

/** The form as seen at one stop: only that stop's items. Same id and version. */
export function stopForm(form: InspectionForm, stopId: string): InspectionForm {
  return { ...form, items: form.items.filter((it) => it.stopId === stopId) };
}

type Fail = { ok: false; errors: string[] };
const no = (...errors: string[]): Fail => ({ ok: false, errors });
const log = (ctx: ConsoleContext, action: string, id: string, before: unknown, after: unknown, reason?: string): AuditEntry =>
  ({ at: ctx.now, userId: ctx.actor.userId, action, entity: 'round', entityId: id, before, after, reason });

/** A draft round and a draft inspection for each stop. Drafts stay on the device until submitted. */
export function startRound(ctx: ConsoleContext, form: InspectionForm): { ok: true; round: Round; drafts: Inspection[] } | Fail {
  if (!can(ctx.actor, 'add_notes')) return no('Your role cannot do rounds.');
  if (!form.route) return no('That form is not a route.');
  if (form.retiredAt) return no('That route is retired.');
  const round: Round = { id: ctx.newId(), formId: form.id, formVersion: form.version, nodeId: form.route.nodeId, status: 'draft', startedBy: ctx.actor.userId, startedAt: ctx.now, skipped: [] };
  const drafts = form.route.stops.map((stopId): Inspection => ({
    id: ctx.newId(), formId: form.id, formVersion: form.version, unitId: stopId, roundId: round.id, status: 'draft', answers: {}, defects: [], startedBy: ctx.actor.userId, startedAt: ctx.now,
  }));
  return { ok: true, round, drafts };
}

export interface RoundResult {
  ok: true;
  round: Round;
  inspections: Inspection[];
  audit: AuditEntry[];
  warnings: string[];
}

/** Submits the round: every stop is either done (its inspection passes the submit checks) or skipped with a reason. */
export function submitRound(ctx: ConsoleContext, form: InspectionForm, round: Round, drafts: Inspection[], skipped: SkippedStop[], equipment: Asset[]): RoundResult | Fail {
  if (round.startedBy !== ctx.actor.userId) return no('Only the person who started it submits it.');
  if (round.status !== 'draft') return no('It is already submitted.');
  if (!form.route || form.id !== round.formId || form.version !== round.formVersion) return no('Wrong route version.');
  const name = (id: string) => equipment.find((a) => a.id === id)?.unitNumber ?? id;
  const e: string[] = [];
  const skip = new Map<string, string>();
  for (const s of skipped) {
    if (!form.route.stops.includes(s.stopId)) e.push(`${name(s.stopId)} is not a stop on this route.`);
    else if (!s.reason.trim()) e.push(`${name(s.stopId)}: say why it was skipped.`);
    else skip.set(s.stopId, s.reason.trim());
  }
  const done = form.route.stops.filter((st) => !skip.has(st));
  if (!done.length) e.push('Do at least one stop.');
  const inspections: Inspection[] = [];
  const audit: AuditEntry[] = [];
  const warnings: string[] = [];
  for (const st of done) {
    const d = drafts.find((x) => x.unitId === st && x.roundId === round.id);
    if (!d) { e.push(`${name(st)}: not started.`); continue; }
    const r = submitInspection(ctx, [], stopForm(form, st), { ...d, startedAt: round.startedAt });
    if (!r.ok) { e.push(...r.errors.map((x) => `${name(st)}: ${x}`)); continue; }
    const i = r.records[0]!;
    inspections.push(i);
    audit.push(...r.audit);
    if (i.result === 'fail') warnings.push(`${name(st)}: a critical item failed. Check whether it should be flagged down.`);
  }
  if (e.length) return { ok: false, errors: e };
  const after: Round = { ...round, status: 'submitted', submittedAt: ctx.now, skipped: [...skip].map(([stopId, reason]) => ({ stopId, reason })) };
  audit.push(log(ctx, 'submit_round', round.id, null, after));
  return { ok: true, round: after, inspections, audit, warnings };
}

export function voidRound(ctx: ConsoleContext, round: Round, inspections: Inspection[], reason: string): RoundResult | Fail {
  if (round.status !== 'submitted') return no('Only a submitted round can be voided.');
  if (permission(ctx.actor.role, 'sign_off_inspections') !== 'yes') return no('A supervisor or superintendent voids a round.');
  if (!reason.trim()) return no('Give a reason.');
  const mine = inspections.filter((i) => i.roundId === round.id && i.status !== 'voided');
  const out: Inspection[] = [];
  const audit: AuditEntry[] = [];
  for (const i of mine) {
    const r = voidInspection(ctx, mine, i.id, reason);
    if (!r.ok) return r;
    out.push(r.records.find((x) => x.id === i.id)!);
    audit.push(...r.audit);
  }
  const after: Round = { ...round, status: 'voided', voidedBy: ctx.actor.userId, voidedAt: ctx.now, voidReason: reason.trim() };
  audit.push(log(ctx, 'void_round', round.id, round, after, reason.trim()));
  return { ok: true, round: after, inspections: out, audit, warnings: [] };
}

/** Signs off every submitted inspection of the round. */
export function signOffRound(ctx: ConsoleContext, round: Round, inspections: Inspection[], note: string): RoundResult | Fail {
  if (round.status !== 'submitted') return no('Only a submitted round can be signed off.');
  const mine = inspections.filter((i) => i.roundId === round.id && i.status === 'submitted');
  if (!mine.length) return no('Nothing in this round is waiting for sign-off.');
  const out: Inspection[] = [];
  const audit: AuditEntry[] = [];
  for (const i of mine) {
    const r = signOff(ctx, mine, i.id, note);
    if (!r.ok) return r;
    out.push(r.records.find((x) => x.id === i.id)!);
    audit.push(...r.audit);
  }
  return { ok: true, round, inspections: out, audit, warnings: [] };
}

// ---------- due ----------

export interface RouteDueRow {
  form: InspectionForm;
  last?: Round;
  state: DueState;
  /** End of the shift or day it is due in. */
  dueBy?: Iso;
}

const doneRounds = (rounds: Round[], formId: string) =>
  rounds.filter((r) => r.formId === formId && r.status === 'submitted').sort((a, b) => ms(b.startedAt) - ms(a.startedAt));

export function routeDue(forms: InspectionForm[], rounds: Round[], cal: ShiftCalendar, now: Iso): RouteDueRow[] {
  const rows: RouteDueRow[] = [];
  const today = siteToday(now, cal.timeZone);
  for (const form of routeForms(forms)) {
    const last = doneRounds(rounds, form.id)[0];
    if (!last) { rows.push({ form, state: 'never' }); continue; }
    const n = form.every.n;
    if (form.every.unit === 'shifts') {
      // Shift 0 holds the last round; it is due in shift n.
      const span = shiftsBetween(cal, last.startedAt, toIso(Math.max(ms(now), ms(last.startedAt)) + (n + 1) * 24 * 3_600_000)).filter((s) => ms(s.end) > ms(last.startedAt));
      const idx = span.findIndex((s) => ms(s.start) <= ms(now) && ms(now) < ms(s.end));
      const dueBy = span[n]?.end;
      const state: DueState = idx < n ? 'ok' : idx === n ? 'due_soon' : 'overdue';
      rows.push({ form, last, state, dueBy });
    } else {
      const dueDate = siteToday(last.startedAt, cal.timeZone, n);
      const soon = Math.min(2, n - 1);
      const state: DueState = dueDate < today ? 'overdue' : dueDate <= siteToday(now, cal.timeZone, soon) ? 'due_soon' : 'ok';
      const dueBy = DateTime.fromISO(dueDate, { zone: cal.timeZone }).plus({ days: 1 }).toUTC().toISO()!;
      rows.push({ form, last, state, dueBy });
    }
  }
  const order: Record<DueState, number> = { overdue: 0, due_soon: 1, never: 2, ok: 3 };
  return rows.sort((a, b) => order[a.state] - order[b.state] || a.form.name.localeCompare(b.form.name));
}

// ---------- compliance (KPI-042) ----------

export interface DuePeriod {
  start: Iso;
  end: Iso;
  done: boolean;
}

export interface RouteCompliance {
  form: InspectionForm;
  periods: DuePeriod[];
  due: number;
  done: number;
  value: number | null;
}

/** The route's due periods inside the window: N shifts or N site days, counted from the window start. */
export function duePeriods(form: InspectionForm, period: Period, cal: ShiftCalendar): Array<{ start: Iso; end: Iso; partial?: boolean }> {
  const n = form.every.n;
  const out: Array<{ start: Iso; end: Iso; partial?: boolean }> = [];
  if (form.every.unit === 'shifts') {
    const shifts = shiftsBetween(cal, period.from, period.to).filter((s) => ms(s.start) >= ms(period.from));
    for (let i = 0; i < shifts.length; i += n) {
      const chunk = shifts.slice(i, i + n);
      out.push({ start: chunk[0]!.start, end: chunk.at(-1)!.end, ...(chunk.length < n ? { partial: true } : {}) });
    }
  } else {
    let d = DateTime.fromISO(period.from, { zone: cal.timeZone }).startOf('day');
    if (d.toMillis() < ms(period.from)) d = d.plus({ days: 1 });
    while (d.toMillis() < ms(period.to)) {
      const e = d.plus({ days: n });
      out.push({ start: d.toUTC().toISO()!, end: e.toUTC().toISO()! });
      d = e;
    }
  }
  return out;
}

export function routeCompliance(forms: InspectionForm[], rounds: Round[], period: Period, cal: ShiftCalendar, now: Iso): RouteCompliance[] {
  const to = ms(period.to) < ms(now) ? period.to : now;
  return routeForms(forms).map((form) => {
    const done = doneRounds(rounds, form.id);
    const periods: DuePeriod[] = [];
    for (const p of duePeriods(form, { from: period.from, to }, cal)) {
      const hit = done.some((r) => ms(r.startedAt) >= ms(p.start) && ms(r.startedAt) < ms(p.end));
      // The period still running counts only once done.
      if ((p.partial || ms(p.end) > ms(to)) && !hit) continue;
      periods.push({ start: p.start, end: p.end, done: hit });
    }
    const n = periods.filter((p) => p.done).length;
    return { form, periods, due: periods.length, done: n, value: periods.length ? n / periods.length : null };
  });
}
