// Management console rules for phase 1a (plan 11.4, 11.5, 11.7): Users,
// Targets (no approval step yet) and Flags and codes. Same shape as the flag
// commands: pure functions that return the new records and audit entries, or
// the reasons the change is refused. Nothing is deleted; records are retired.

import { DateTime } from 'luxon';
import { SYSTEMS } from './synth/generate.js';
import { can, permission } from './permissions.js';
import { ms, shiftAt, type ShiftCalendar } from './time.js';
import type { Actor, AuditEntry, FlagType, Iso, Role } from './types.js';

export interface ConsoleContext {
  actor: Actor;
  now: Iso;
  newId: () => string;
  timeZone: string;
  calendar: ShiftCalendar;
}

export type ConsoleResult<T> =
  | { ok: true; records: T[]; audit: AuditEntry[]; warnings: string[] }
  | { ok: false; errors: string[] };

const refuse = <T>(...errors: string[]): ConsoleResult<T> => ({ ok: false, errors });

function entry(ctx: ConsoleContext, entity: AuditEntry['entity'], action: string, id: string, before: unknown, after: unknown, reason?: string): AuditEntry {
  return { at: ctx.now, userId: ctx.actor.userId, action, entity, entityId: id, before, after, reason };
}

// ---------- targets ----------

export type TargetKpi = 'pa' | 'utilisation' | 'mtbf' | 'mttr' | 'mean_downtime';

export const TARGET_KPIS: Record<TargetKpi, { label: string; unit: '%' | 'h'; higherIsBetter: boolean }> = {
  pa: { label: 'Physical availability', unit: '%', higherIsBetter: true },
  utilisation: { label: 'Utilisation', unit: '%', higherIsBetter: true },
  mtbf: { label: 'MTBF', unit: 'h', higherIsBetter: true },
  mttr: { label: 'MTTR', unit: 'h', higherIsBetter: false },
  mean_downtime: { label: 'Mean downtime', unit: 'h', higherIsBetter: false },
};

/**
 * A KPI target from a date. Targets are never edited: a new one with a later
 * date replaces it from then on, so past results keep the target that applied
 * at the time (plan 11.5).
 */
export interface Target {
  id: string;
  kpi: TargetKpi;
  /** Empty means every fleet. */
  fleet?: string;
  /** Empty means every model in the fleet. */
  model?: string;
  /** Ratio (0.9 = 90%) for % KPIs, hours for the others. */
  value: number;
  /** Amber band, in the KPI's own units, on the bad side of the target. */
  amber: number;
  effectiveFrom: Iso;
  setBy: string;
  setAt: Iso;
  reason: string;
}

/** Used until a target is set. Placeholders, not site figures. */
export const DEFAULT_TARGETS: Array<Pick<Target, 'kpi' | 'value' | 'amber'>> = [
  { kpi: 'pa', value: 0.9, amber: 0.03 },
  { kpi: 'utilisation', value: 0.85, amber: 0.03 },
];

export interface TargetInput {
  kpi: TargetKpi;
  fleet?: string;
  model?: string;
  value: number;
  amber: number;
  /** "next_shift", or a local date (YYYY-MM-DD) from which it applies at 00:00 site time. */
  from: 'next_shift' | string;
  reason: string;
}

/**
 * Phase 1a: the reliability engineer sets targets directly; the
 * superintendent approval step arrives in phase 2 (plan 11.7).
 */
export function setTarget(ctx: ConsoleContext, targets: Target[], input: TargetInput): ConsoleResult<Target> {
  const p = permission(ctx.actor.role, 'change_targets');
  if (p !== 'propose' && p !== 'approve') return refuse('Your role cannot change targets.');
  const errors: string[] = [];
  const def = TARGET_KPIS[input.kpi];
  if (!def) return refuse('Unknown KPI.');
  if (!input.reason.trim()) errors.push('Give a reason for the change.');
  if (!Number.isFinite(input.value) || input.value <= 0) errors.push('The target must be above zero.');
  if (def.unit === '%' && input.value > 1) errors.push('A percentage target must be 100% or less.');
  if (!Number.isFinite(input.amber) || input.amber < 0) errors.push('The amber band cannot be negative.');
  let from: Iso;
  const shiftNow = shiftAt(ctx.calendar, ctx.now);
  if (input.from === 'next_shift') from = shiftNow.end;
  else {
    const d = DateTime.fromISO(input.from, { zone: ctx.timeZone });
    if (!d.isValid || !/^\d{4}-\d{2}-\d{2}$/.test(input.from)) return refuse('Choose a date.');
    from = d.startOf('day').toUTC().toISO()!;
    if (ms(from) < ms(shiftNow.start)) errors.push('A target cannot start in the past. Past results keep the target that applied at the time.');
  }
  if (errors.length) return refuse(...errors);
  const t: Target = {
    id: ctx.newId(), kpi: input.kpi, fleet: input.fleet || undefined, model: input.model || undefined,
    value: input.value, amber: input.amber, effectiveFrom: from, setBy: ctx.actor.userId, setAt: ctx.now, reason: input.reason.trim(),
  };
  const replaced = targetFor(targets, input.kpi, { fleet: input.fleet, model: input.model }, from, true);
  return { ok: true, records: [...targets, t], audit: [entry(ctx, 'target', 'set_target', t.id, replaced ?? null, t, t.reason)], warnings: [] };
}

/**
 * The target in force for a KPI at a time: the most specific match (model, then
 * fleet, then all), and of those the latest one already in effect.
 */
export function targetFor(
  targets: Target[],
  kpi: TargetKpi,
  scope: { fleet?: string; model?: string },
  at: Iso,
  exact = false,
): Target | undefined {
  const t = ms(at);
  const live = targets.filter((x) => x.kpi === kpi && ms(x.effectiveFrom) <= t);
  const rank = (x: Target) =>
    x.model ? (x.model === scope.model && (!x.fleet || x.fleet === scope.fleet) ? 3 : -1)
      : x.fleet ? (x.fleet === scope.fleet ? 2 : -1)
        : 1;
  const ok = live.filter((x) => (exact ? (x.fleet ?? '') === (scope.fleet ?? '') && (x.model ?? '') === (scope.model ?? '') : rank(x) > 0));
  return ok.sort((a, b) => rank(b) - rank(a) || ms(b.effectiveFrom) - ms(a.effectiveFrom) || ms(b.setAt) - ms(a.setAt))[0];
}

/** Value and amber band in force, falling back to the placeholder defaults. */
export function targetValue(targets: Target[], kpi: TargetKpi, scope: { fleet?: string; model?: string }, at: Iso): { value: number; amber: number; set: boolean } | undefined {
  const t = targetFor(targets, kpi, scope, at);
  if (t) return { value: t.value, amber: t.amber, set: true };
  const d = DEFAULT_TARGETS.find((x) => x.kpi === kpi);
  return d ? { value: d.value, amber: d.amber, set: false } : undefined;
}

export function rag(kpi: TargetKpi, value: number | null, target: { value: number; amber: number } | undefined): 'green' | 'amber' | 'red' | undefined {
  if (value === null || !target) return undefined;
  const higher = TARGET_KPIS[kpi].higherIsBetter;
  const gap = higher ? value - target.value : target.value - value;
  if (gap >= 0) return 'green';
  if (gap >= -target.amber) return 'amber';
  return 'red';
}

// ---------- users ----------

/** The four first-release roles (plan 11.7). Technician and superintendent come later. */
export const PHASE_1A_ROLES: Role[] = ['viewer', 'supervisor', 'reliability_engineer', 'admin'];

export const ROLE_LABELS: Record<Role, string> = {
  viewer: 'Viewer',
  technician: 'Technician',
  supervisor: 'Supervisor',
  reliability_engineer: 'Reliability engineer',
  superintendent: 'Superintendent',
  admin: 'Admin (data owner)',
};

export interface SiteUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  /** Areas or fleets; ['*'] is the whole site. */
  scope: string[];
  addedAt: Iso;
  retiredAt?: Iso;
  retiredReason?: string;
}

export interface UserInput {
  name: string;
  email: string;
  role: Role;
  scope: string[];
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function checkUser(users: SiteUser[], input: UserInput, selfId?: string): string[] {
  const e: string[] = [];
  if (!input.name.trim()) e.push('Enter a name.');
  if (!EMAIL.test(input.email.trim())) e.push('Enter a valid email address.');
  else if (users.some((u) => u.id !== selfId && !u.retiredAt && u.email.toLowerCase() === input.email.trim().toLowerCase())) e.push('Someone at this site already has that email address.');
  if (!PHASE_1A_ROLES.includes(input.role)) e.push(`${ROLE_LABELS[input.role] ?? input.role} accounts arrive in a later phase.`);
  if (!input.scope.length) e.push('Choose at least one area, or the whole site.');
  return e;
}

const activeAdmins = (users: SiteUser[]) => users.filter((u) => !u.retiredAt && u.role === 'admin');

export function addUser(ctx: ConsoleContext, users: SiteUser[], input: UserInput): ConsoleResult<SiteUser> {
  if (!can(ctx.actor, 'manage_users')) return refuse('Only the Admin can add users.');
  const errors = checkUser(users, input);
  if (errors.length) return refuse(...errors);
  const u: SiteUser = { id: ctx.newId(), name: input.name.trim(), email: input.email.trim().toLowerCase(), role: input.role, scope: input.scope, addedAt: ctx.now };
  return { ok: true, records: [...users, u], audit: [entry(ctx, 'user', 'add_user', u.id, null, u)], warnings: [] };
}

export function changeUser(ctx: ConsoleContext, users: SiteUser[], id: string, input: UserInput, reason: string): ConsoleResult<SiteUser> {
  if (!can(ctx.actor, 'manage_users')) return refuse('Only the Admin can change users.');
  const before = users.find((u) => u.id === id);
  if (!before || before.retiredAt) return refuse('That user is not active.');
  const errors = checkUser(users, input, id);
  if (!reason.trim()) errors.push('Give a reason for the change.');
  const after: SiteUser = { ...before, name: input.name.trim(), email: input.email.trim().toLowerCase(), role: input.role, scope: input.scope };
  const next = users.map((u) => (u.id === id ? after : u));
  if (activeAdmins(next).length === 0) errors.push('The site must keep at least one Admin.');
  if (errors.length) return refuse(...errors);
  return { ok: true, records: next, audit: [entry(ctx, 'user', 'change_user', id, before, after, reason.trim())], warnings: [] };
}

/** Takes away access. The user and their history stay; nothing is deleted. */
export function retireUser(ctx: ConsoleContext, users: SiteUser[], id: string, reason: string): ConsoleResult<SiteUser> {
  if (!can(ctx.actor, 'manage_users')) return refuse('Only the Admin can remove access.');
  const before = users.find((u) => u.id === id);
  if (!before || before.retiredAt) return refuse('That user is not active.');
  if (!reason.trim()) return refuse('Give a reason.');
  if (before.id === ctx.actor.userId) return refuse('You cannot remove your own access.');
  const after: SiteUser = { ...before, retiredAt: ctx.now, retiredReason: reason.trim() };
  const next = users.map((u) => (u.id === id ? after : u));
  if (activeAdmins(next).length === 0) return refuse('The site must keep at least one Admin.');
  return { ok: true, records: next, audit: [entry(ctx, 'user', 'retire_user', id, before, after, reason.trim())], warnings: [] };
}

// ---------- reason codes ----------

export interface ReasonCode {
  id: string;
  code: string;
  label: string;
  appliesTo: FlagType;
  /** The ERP's own code, e.g. a Maximo failure class or problem code (A3). */
  externalCode?: string;
  retiredAt?: Iso;
  retiredReason?: string;
}

/** Starter codes until the site's own list is loaded. Maximo codes are placeholders. */
export function defaultReasonCodes(): ReasonCode[] {
  const unsched = Object.keys(SYSTEMS).map((s) => ({ id: `rc-${s.toLowerCase().replace(/\W+/g, '-')}`, code: s.toUpperCase().replace(/\W+/g, '_').slice(0, 12), label: s, appliesTo: 'unscheduled' as const }));
  const sched = ['PM 250', 'PM 500', 'PM 1000', 'Planned component change', 'Planned inspection', 'Shutdown'].map((s) => ({ id: `rc-${s.toLowerCase().replace(/\W+/g, '-')}`, code: s.toUpperCase().replace(/\W+/g, '_').slice(0, 12), label: s, appliesTo: 'scheduled' as const }));
  return [...unsched, ...sched];
}

export interface CodeInput {
  code: string;
  label: string;
  appliesTo: FlagType;
  externalCode?: string;
}

function checkCode(codes: ReasonCode[], input: CodeInput, selfId?: string): string[] {
  const e: string[] = [];
  const code = input.code.trim().toUpperCase();
  if (!/^[A-Z0-9_]{1,16}$/.test(code)) e.push('Code: 1 to 16 letters, numbers or underscores.');
  if (!input.label.trim()) e.push('Enter a label.');
  // Retired codes keep their code, so it cannot be reused for something else.
  if (codes.some((c) => c.id !== selfId && c.code === code)) e.push(`Code ${code} is already used${codes.find((c) => c.code === code)?.retiredAt ? ' by a retired code' : ''}.`);
  return e;
}

export function addCode(ctx: ConsoleContext, codes: ReasonCode[], input: CodeInput): ConsoleResult<ReasonCode> {
  if (!can(ctx.actor, 'edit_codes')) return refuse(permission(ctx.actor.role, 'edit_codes') === 'propose' ? 'Your role can propose code changes; the approval step arrives in phase 1b.' : 'Your role cannot edit codes.');
  const errors = checkCode(codes, input);
  if (errors.length) return refuse(...errors);
  const c: ReasonCode = { id: ctx.newId(), code: input.code.trim().toUpperCase(), label: input.label.trim(), appliesTo: input.appliesTo, externalCode: input.externalCode?.trim() || undefined };
  return { ok: true, records: [...codes, c], audit: [entry(ctx, 'code', 'add_code', c.id, null, c)], warnings: [] };
}

/** Change a label or ERP mapping. The code itself never changes; flags already set keep the reason as entered. */
export function editCode(ctx: ConsoleContext, codes: ReasonCode[], id: string, input: Omit<CodeInput, 'code'>, reason: string): ConsoleResult<ReasonCode> {
  if (!can(ctx.actor, 'edit_codes')) return refuse('Your role cannot edit codes.');
  const before = codes.find((c) => c.id === id);
  if (!before || before.retiredAt) return refuse('That code is retired.');
  const errors = checkCode(codes, { ...input, code: before.code }, id);
  if (!reason.trim()) errors.push('Give a reason for the change.');
  if (errors.length) return refuse(...errors);
  const after: ReasonCode = { ...before, label: input.label.trim(), appliesTo: input.appliesTo, externalCode: input.externalCode?.trim() || undefined };
  const warnings = before.appliesTo !== after.appliesTo ? ['Flags already using this code keep their type; only new flags see the change.'] : [];
  return { ok: true, records: codes.map((c) => (c.id === id ? after : c)), audit: [entry(ctx, 'code', 'edit_code', id, before, after, reason.trim())], warnings };
}

/** Retire, never delete (plan 11.3). Old flags keep the code; new flags cannot pick it. */
export function retireCode(ctx: ConsoleContext, codes: ReasonCode[], id: string, reason: string): ConsoleResult<ReasonCode> {
  if (!can(ctx.actor, 'edit_codes')) return refuse('Your role cannot edit codes.');
  const before = codes.find((c) => c.id === id);
  if (!before || before.retiredAt) return refuse('That code is already retired.');
  if (!reason.trim()) return refuse('Give a reason.');
  const live = codes.filter((c) => !c.retiredAt && c.appliesTo === before.appliesTo);
  if (live.length <= 1) return refuse(`At least one ${before.appliesTo} reason code must stay active.`);
  const after: ReasonCode = { ...before, retiredAt: ctx.now, retiredReason: reason.trim() };
  return { ok: true, records: codes.map((c) => (c.id === id ? after : c)), audit: [entry(ctx, 'code', 'retire_code', id, before, after, reason.trim())], warnings: [] };
}

export function activeCodes(codes: ReasonCode[], type: FlagType): ReasonCode[] {
  return codes.filter((c) => !c.retiredAt && c.appliesTo === type);
}
