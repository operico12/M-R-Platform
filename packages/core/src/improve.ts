// Phase 2 improvement loop: actions and root cause analyses (RCA).
// Same shape as the console commands: pure functions that return the new
// records and audit entries, or the reasons a change is refused. Nothing is
// deleted. An action is closed with a note or cancelled with a reason; an RCA
// is closed with a root cause or cancelled with a reason. Both can be reopened.

import { DateTime } from 'luxon';
import { analyse, filterFromQuery, type FilteredAnalysis } from './filters.js';
import type { KpiInput } from './kpis.js';
import { can } from './permissions.js';
import { ms, type ShiftCalendar } from './time.js';
import type { ConsoleContext, ConsoleResult } from './console.js';
import type { AuditEntry, Iso } from './types.js';

const refuse = <T>(...errors: string[]): ConsoleResult<T> => ({ ok: false, errors });

function entry(ctx: ConsoleContext, entity: 'action' | 'rca', action: string, id: string, before: unknown, after: unknown, reason?: string): AuditEntry {
  return { at: ctx.now, userId: ctx.actor.userId, action, entity, entityId: id, before, after, reason };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (d: string, tz: string) => DATE.test(d) && DateTime.fromISO(d, { zone: tz }).isValid;
/** Today's date at the site, never the viewer's browser (CLAUDE.md rule 7). */
export const siteToday = (now: Iso, tz: string, plusDays = 0) => DateTime.fromISO(now, { zone: tz }).plus({ days: plusDays }).toISODate()!;

function replace<T extends { id: string }>(list: T[], next: T): T[] {
  return list.map((x) => (x.id === next.id ? next : x));
}

// ---------- actions ----------

export type ActionStatus = 'open' | 'in_progress' | 'done' | 'cancelled';

export const ACTION_STATUS_LABELS: Record<ActionStatus, string> = {
  open: 'Open',
  in_progress: 'In progress',
  done: 'Done',
  cancelled: 'Cancelled',
};

/** Where an action came from. The query is an analysis filter link, so the effect can be measured on the same slice. */
export interface ActionSource {
  kind: 'analysis' | 'unit' | 'flag' | 'rca' | 'manual';
  /** Analysis filter (filterToQuery). For a unit or flag, the unit's own slice. */
  query?: string;
  unitId?: string;
  flagId?: string;
  rcaId?: string;
  /** What the person saw when they raised it, for example "Hydraulics, Haul trucks, last 28 days". */
  label: string;
}

export interface ImprovementAction {
  id: string;
  title: string;
  detail?: string;
  /** Site user id. */
  owner: string;
  /** Local date at the site (YYYY-MM-DD). */
  due: string;
  status: ActionStatus;
  source: ActionSource;
  createdBy: string;
  createdAt: Iso;
  updatedAt: Iso;
  startedAt?: Iso;
  doneAt?: Iso;
  doneNote?: string;
  cancelledAt?: Iso;
  cancelReason?: string;
}

export interface ActionInput {
  title: string;
  detail?: string;
  owner: string;
  due: string;
  source: ActionSource;
}

function checkAction(ctx: ConsoleContext, input: Pick<ActionInput, 'title' | 'owner' | 'due'>, owners: string[]): string[] {
  const e: string[] = [];
  if (!input.title.trim()) e.push('Give the action a title.');
  if (!input.owner || !owners.includes(input.owner)) e.push('Choose an owner from the site users.');
  if (!validDate(input.due, ctx.timeZone)) e.push('Choose a due date.');
  return e;
}

/** `owners`: ids of active site users who can own an action. */
export function createAction(ctx: ConsoleContext, actions: ImprovementAction[], input: ActionInput, owners: string[]): ConsoleResult<ImprovementAction> {
  if (!can(ctx.actor, 'create_actions')) return refuse('Your role cannot raise actions.');
  const errors = checkAction(ctx, input, owners);
  if (!input.source.label.trim()) errors.push('Say what the action is for.');
  if (errors.length) return refuse(...errors);
  const warnings: string[] = [];
  if (input.due < siteToday(ctx.now, ctx.timeZone)) warnings.push('The due date is already past, so the action shows as overdue.');
  const a: ImprovementAction = {
    id: ctx.newId(), title: input.title.trim(), detail: input.detail?.trim() || undefined, owner: input.owner, due: input.due,
    status: 'open', source: input.source, createdBy: ctx.actor.userId, createdAt: ctx.now, updatedAt: ctx.now,
  };
  return { ok: true, records: [...actions, a], audit: [entry(ctx, 'action', 'create_action', a.id, null, a)], warnings };
}

const isClosed = (a: ImprovementAction) => a.status === 'done' || a.status === 'cancelled';
const canManage = (ctx: ConsoleContext) => can(ctx.actor, 'create_actions');
const isOwner = (ctx: ConsoleContext, a: ImprovementAction) => a.owner === ctx.actor.userId;

function findAction(actions: ImprovementAction[], id: string) {
  return actions.find((x) => x.id === id);
}

export interface ActionChange {
  title?: string;
  detail?: string;
  owner?: string;
  due?: string;
  reason: string;
}

/** Change the title, owner or due date. A changed due date or owner needs a reason, so slipping dates stay visible. */
export function changeAction(ctx: ConsoleContext, actions: ImprovementAction[], id: string, change: ActionChange, owners: string[]): ConsoleResult<ImprovementAction> {
  const a = findAction(actions, id);
  if (!a) return refuse('Action not found.');
  if (!canManage(ctx)) return refuse('Your role cannot change actions.');
  if (isClosed(a)) return refuse('Reopen the action before changing it.');
  const next: ImprovementAction = {
    ...a,
    title: change.title?.trim() ?? a.title,
    detail: change.detail !== undefined ? change.detail.trim() || undefined : a.detail,
    owner: change.owner ?? a.owner,
    due: change.due ?? a.due,
    updatedAt: ctx.now,
  };
  const errors = checkAction(ctx, next, owners);
  if ((next.due !== a.due || next.owner !== a.owner) && !change.reason.trim()) errors.push('Give a reason for moving the due date or the owner.');
  if (errors.length) return refuse(...errors);
  if (next.title === a.title && next.detail === a.detail && next.owner === a.owner && next.due === a.due) return refuse('Nothing has changed.');
  return { ok: true, records: replace(actions, next), audit: [entry(ctx, 'action', 'change_action', a.id, a, next, change.reason.trim() || undefined)], warnings: [] };
}

export function startAction(ctx: ConsoleContext, actions: ImprovementAction[], id: string): ConsoleResult<ImprovementAction> {
  const a = findAction(actions, id);
  if (!a) return refuse('Action not found.');
  if (!canManage(ctx) && !isOwner(ctx, a)) return refuse('Only the owner, or someone who can raise actions, can start it.');
  if (a.status !== 'open') return refuse('Only an open action can be started.');
  const next: ImprovementAction = { ...a, status: 'in_progress', startedAt: ctx.now, updatedAt: ctx.now };
  return { ok: true, records: replace(actions, next), audit: [entry(ctx, 'action', 'start_action', a.id, a, next)], warnings: [] };
}

/** Done needs a note saying what was done; the effect is then measured from this time. */
export function completeAction(ctx: ConsoleContext, actions: ImprovementAction[], id: string, note: string): ConsoleResult<ImprovementAction> {
  const a = findAction(actions, id);
  if (!a) return refuse('Action not found.');
  if (!canManage(ctx) && !isOwner(ctx, a)) return refuse('Only the owner, or someone who can raise actions, can close it.');
  if (isClosed(a)) return refuse('The action is already closed.');
  if (!note.trim()) return refuse('Say what was done.');
  const next: ImprovementAction = { ...a, status: 'done', doneAt: ctx.now, doneNote: note.trim(), updatedAt: ctx.now };
  return { ok: true, records: replace(actions, next), audit: [entry(ctx, 'action', 'complete_action', a.id, a, next, note.trim())], warnings: [] };
}

export function cancelAction(ctx: ConsoleContext, actions: ImprovementAction[], id: string, reason: string): ConsoleResult<ImprovementAction> {
  const a = findAction(actions, id);
  if (!a) return refuse('Action not found.');
  if (!canManage(ctx)) return refuse('Your role cannot cancel actions.');
  if (isClosed(a)) return refuse('The action is already closed.');
  if (!reason.trim()) return refuse('Give a reason for cancelling.');
  const next: ImprovementAction = { ...a, status: 'cancelled', cancelledAt: ctx.now, cancelReason: reason.trim(), updatedAt: ctx.now };
  return { ok: true, records: replace(actions, next), audit: [entry(ctx, 'action', 'cancel_action', a.id, a, next, reason.trim())], warnings: [] };
}

/** Back to open. The earlier close stays in the audit log. */
export function reopenAction(ctx: ConsoleContext, actions: ImprovementAction[], id: string, reason: string): ConsoleResult<ImprovementAction> {
  const a = findAction(actions, id);
  if (!a) return refuse('Action not found.');
  if (!canManage(ctx)) return refuse('Your role cannot reopen actions.');
  if (!isClosed(a)) return refuse('The action is not closed.');
  if (!reason.trim()) return refuse('Give a reason for reopening.');
  const next: ImprovementAction = { ...a, status: a.startedAt ? 'in_progress' : 'open', doneAt: undefined, doneNote: undefined, cancelledAt: undefined, cancelReason: undefined, updatedAt: ctx.now };
  return { ok: true, records: replace(actions, next), audit: [entry(ctx, 'action', 'reopen_action', a.id, a, next, reason.trim())], warnings: [] };
}

/** Past its due date at the site and not closed. Due on a date means due by the end of that day. */
export function isOverdue(a: ImprovementAction, now: Iso, timeZone: string): boolean {
  return !isClosed(a) && a.due < siteToday(now, timeZone);
}

export function actionCounts(actions: ImprovementAction[], now: Iso, timeZone: string) {
  const live = actions.filter((a) => !isClosed(a));
  return {
    open: live.length,
    overdue: live.filter((a) => isOverdue(a, now, timeZone)).length,
    done: actions.filter((a) => a.status === 'done').length,
    cancelled: actions.filter((a) => a.status === 'cancelled').length,
  };
}

// ---------- effect: before and after ----------

export interface EffectWindow {
  from: Iso;
  to: Iso;
  downHours: number;
  failures: number;
  events: number;
  /** Fleet PA for the units in the slice, unit filters only. */
  pa: number | null;
  /** Matching down hours per 1000 calendar hours, so windows of different lengths compare. */
  downPer1000: number | null;
}

export interface Effect {
  /** Days in each window. */
  days: number;
  before: EffectWindow;
  after: EffectWindow;
  /** False while the after window is shorter than `minDays`: too early to judge. */
  enough: boolean;
  /** After minus before, as a share of before (negative is less downtime). Null when before is zero. */
  downChange: number | null;
  failureChange: number;
}

function windowOf(a: FilteredAnalysis): EffectWindow {
  const cal = a.kpis.calendarHours;
  return {
    from: a.period.from, to: a.period.to, downHours: a.downHours, failures: a.failures, events: a.events.length,
    pa: a.kpis.pa, downPer1000: cal > 0 ? (a.downHours / cal) * 1000 : null,
  };
}

/**
 * Downtime on the action's slice in equal windows before and after it was
 * done: up to `days` each side, cut short if less time has passed since. The
 * filter's own date range is ignored; units, systems and the rest still apply.
 */
export function actionEffect(
  input: KpiInput & { calendar: ShiftCalendar; timeZone: string },
  a: ImprovementAction,
  opts: { days?: number; minDays?: number } = {},
): Effect | undefined {
  if (a.status !== 'done' || !a.doneAt || a.source.query === undefined) return undefined;
  const max = opts.days ?? 28;
  const minDays = opts.minDays ?? 7;
  const done = ms(a.doneAt);
  const since = Math.max(0, (ms(input.now) - done) / 864e5);
  const days = Math.min(max, since);
  const f = filterFromQuery(a.source.query);
  const span = days * 864e5;
  const before = analyse(input, f, { from: new Date(done - span).toISOString(), to: a.doneAt });
  const after = analyse(input, f, { from: a.doneAt, to: new Date(done + days * 864e5).toISOString() });
  const b = windowOf(before);
  const af = windowOf(after);
  // Compare rates, since the after window can be shorter while it fills up.
  const rate = (w: EffectWindow) => w.downPer1000 ?? 0;
  return {
    days: Math.round(days * 10) / 10,
    before: b,
    after: af,
    enough: since >= minDays,
    downChange: rate(b) > 0 ? (rate(af) - rate(b)) / rate(b) : null,
    failureChange: af.failures - b.failures,
  };
}

export type EffectVerdict = 'too_early' | 'no_baseline' | 'better' | 'worse' | 'no_clear_change';

/**
 * Plain reading of an effect. A change in the downtime rate smaller than
 * `band` (default 10%) either way is "no clear change", so noise is not
 * reported as a win.
 */
export function effectVerdict(e: Effect, band = 0.1): EffectVerdict {
  if (!e.enough) return 'too_early';
  if (e.downChange === null) return 'no_baseline';
  if (e.downChange <= -band) return 'better';
  if (e.downChange >= band) return 'worse';
  return 'no_clear_change';
}

// ---------- root cause analysis ----------

/** Fishbone (Ishikawa) categories, the 6M set in plain words. */
export type FishboneCategory = 'people' | 'machine' | 'method' | 'material' | 'measurement' | 'environment';

export const FISHBONE: Array<[FishboneCategory, string]> = [
  ['people', 'People'],
  ['machine', 'Machine'],
  ['method', 'Method'],
  ['material', 'Material and parts'],
  ['measurement', 'Measurement'],
  ['environment', 'Environment'],
];

export type RcaStatus = 'open' | 'closed' | 'cancelled';

export interface Rca {
  id: string;
  title: string;
  /** The problem statement: what, where, when, how big. */
  problem: string;
  source: ActionSource;
  /** Flags under study. */
  flagIds: string[];
  /** 5-Why chain, first answer first. */
  whys: string[];
  fishbone: Record<FishboneCategory, string[]>;
  rootCause?: string;
  status: RcaStatus;
  /** Site user id of the person leading it. */
  lead: string;
  createdBy: string;
  createdAt: Iso;
  updatedAt: Iso;
  closedAt?: Iso;
  closeNote?: string;
  cancelReason?: string;
}

export const emptyFishbone = (): Record<FishboneCategory, string[]> => ({ people: [], machine: [], method: [], material: [], measurement: [], environment: [] });

export interface RcaInput {
  title: string;
  problem: string;
  source: ActionSource;
  flagIds?: string[];
  lead: string;
}

export function startRca(ctx: ConsoleContext, rcas: Rca[], input: RcaInput, leads: string[]): ConsoleResult<Rca> {
  if (!can(ctx.actor, 'run_rcas')) return refuse('Your role cannot start a root cause analysis.');
  const e: string[] = [];
  if (!input.title.trim()) e.push('Give the analysis a title.');
  if (!input.problem.trim()) e.push('Write the problem statement.');
  if (!leads.includes(input.lead)) e.push('Choose who leads it.');
  if (e.length) return refuse(...e);
  const r: Rca = {
    id: ctx.newId(), title: input.title.trim(), problem: input.problem.trim(), source: input.source, flagIds: input.flagIds ?? [],
    whys: [], fishbone: emptyFishbone(), status: 'open', lead: input.lead, createdBy: ctx.actor.userId, createdAt: ctx.now, updatedAt: ctx.now,
  };
  return { ok: true, records: [...rcas, r], audit: [entry(ctx, 'rca', 'start_rca', r.id, null, r)], warnings: [] };
}

export interface RcaChange {
  title?: string;
  problem?: string;
  whys?: string[];
  fishbone?: Partial<Record<FishboneCategory, string[]>>;
  rootCause?: string;
  lead?: string;
}

const clean = (xs: string[]) => xs.map((x) => x.trim()).filter(Boolean);

/** Edit the working parts of an open RCA. Blank lines are dropped. */
export function editRca(ctx: ConsoleContext, rcas: Rca[], id: string, change: RcaChange, leads: string[]): ConsoleResult<Rca> {
  const r = rcas.find((x) => x.id === id);
  if (!r) return refuse('Analysis not found.');
  if (!can(ctx.actor, 'run_rcas')) return refuse('Your role cannot edit a root cause analysis.');
  if (r.status !== 'open') return refuse('Reopen the analysis before changing it.');
  const fishbone = { ...r.fishbone };
  for (const [k, v] of Object.entries(change.fishbone ?? {}) as Array<[FishboneCategory, string[]]>) {
    if (!(k in fishbone)) return refuse('Unknown fishbone category.');
    fishbone[k] = clean(v);
  }
  const next: Rca = {
    ...r,
    title: change.title?.trim() ?? r.title,
    problem: change.problem?.trim() ?? r.problem,
    whys: change.whys ? clean(change.whys) : r.whys,
    fishbone,
    rootCause: change.rootCause !== undefined ? change.rootCause.trim() || undefined : r.rootCause,
    lead: change.lead ?? r.lead,
    updatedAt: ctx.now,
  };
  const e: string[] = [];
  if (!next.title) e.push('Give the analysis a title.');
  if (!next.problem) e.push('Write the problem statement.');
  if (!leads.includes(next.lead)) e.push('Choose who leads it.');
  if (next.whys.length > 7) e.push('Keep the why chain to seven steps or fewer; split it if there are two causes.');
  if (e.length) return refuse(...e);
  return { ok: true, records: replace(rcas, next), audit: [entry(ctx, 'rca', 'edit_rca', r.id, r, next)], warnings: [] };
}

/** Close with a root cause and a note. Without at least one action the RCA closes with a warning. */
export function closeRca(ctx: ConsoleContext, rcas: Rca[], id: string, note: string, actions: ImprovementAction[]): ConsoleResult<Rca> {
  const r = rcas.find((x) => x.id === id);
  if (!r) return refuse('Analysis not found.');
  if (!can(ctx.actor, 'run_rcas')) return refuse('Your role cannot close a root cause analysis.');
  if (r.status !== 'open') return refuse('The analysis is already closed.');
  const e: string[] = [];
  if (!r.rootCause) e.push('Record the root cause before closing.');
  if (!r.whys.length) e.push('Work through at least one why before closing.');
  if (!note.trim()) e.push('Add a closing note.');
  if (e.length) return refuse(...e);
  const linked = rcaActions(r, actions).filter((a) => a.status !== 'cancelled');
  const warnings = linked.length ? [] : ['No actions are linked, so nothing is tracked to stop it happening again.'];
  const next: Rca = { ...r, status: 'closed', closedAt: ctx.now, closeNote: note.trim(), updatedAt: ctx.now };
  return { ok: true, records: replace(rcas, next), audit: [entry(ctx, 'rca', 'close_rca', r.id, r, next, note.trim())], warnings };
}

export function cancelRca(ctx: ConsoleContext, rcas: Rca[], id: string, reason: string): ConsoleResult<Rca> {
  const r = rcas.find((x) => x.id === id);
  if (!r) return refuse('Analysis not found.');
  if (!can(ctx.actor, 'run_rcas')) return refuse('Your role cannot cancel a root cause analysis.');
  if (r.status !== 'open') return refuse('The analysis is already closed.');
  if (!reason.trim()) return refuse('Give a reason for cancelling.');
  const next: Rca = { ...r, status: 'cancelled', cancelReason: reason.trim(), updatedAt: ctx.now };
  return { ok: true, records: replace(rcas, next), audit: [entry(ctx, 'rca', 'cancel_rca', r.id, r, next, reason.trim())], warnings: [] };
}

export function reopenRca(ctx: ConsoleContext, rcas: Rca[], id: string, reason: string): ConsoleResult<Rca> {
  const r = rcas.find((x) => x.id === id);
  if (!r) return refuse('Analysis not found.');
  if (!can(ctx.actor, 'run_rcas')) return refuse('Your role cannot reopen a root cause analysis.');
  if (r.status === 'open') return refuse('The analysis is already open.');
  if (!reason.trim()) return refuse('Give a reason for reopening.');
  const next: Rca = { ...r, status: 'open', closedAt: undefined, closeNote: undefined, cancelReason: undefined, updatedAt: ctx.now };
  return { ok: true, records: replace(rcas, next), audit: [entry(ctx, 'rca', 'reopen_rca', r.id, r, next, reason.trim())], warnings: [] };
}

/** Actions raised from this RCA. */
export function rcaActions(r: Rca, actions: ImprovementAction[]): ImprovementAction[] {
  return actions.filter((a) => a.source.kind === 'rca' && a.source.rcaId === r.id);
}
