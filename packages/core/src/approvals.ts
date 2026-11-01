// Approvals (phase 2, plan 11.3 to 11.5; docs/approvals.md). Governed
// changes are asked for, approved or rejected by a superintendent who did not
// ask, then applied. Requests are never deleted; every step is audited.

import { DateTime } from 'luxon';
import {
  GOVERNED_ROLES, ROLE_LABELS, TARGET_KPIS, setTarget, targetFor,
  type ConsoleContext, type SiteUser, type Target, type TargetInput,
} from './console.js';
import { KIND_LABELS, lifeTargetFor, setLifeTarget, type LifeTarget, type LifeTargetInput } from './components.js';
import { permission, type Who } from './permissions.js';
import { ms, shiftAt } from './time.js';
import type { AuditEntry, Iso, Role } from './types.js';

export type RequestKind = 'target' | 'life_target' | 'role_grant' | 'acting_role';
export type RequestStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn';

export interface TargetRequest { kind: 'target'; input: Omit<TargetInput, 'reason'> }
export interface RoleGrantRequest { kind: 'role_grant'; userId: string; role: Role; from: Role }
export interface ActingRoleRequest { kind: 'acting_role'; userId: string; role: Role; until: Iso }
export interface LifeTargetRequest { kind: 'life_target'; input: Omit<LifeTargetInput, 'reason'> }
export type RequestPayload = TargetRequest | LifeTargetRequest | RoleGrantRequest | ActingRoleRequest;

export interface RequestNote { by: string; at: Iso; text: string }

export interface ApprovalRequest {
  id: string;
  kind: RequestKind;
  /** One line, for the inbox. */
  title: string;
  reason: string;
  payload: RequestPayload;
  /** What the change affects, in words (plan 11.5 "impact preview"). */
  impact: string[];
  status: RequestStatus;
  requestedBy: string;
  requestedAt: Iso;
  /** Questions and answers while it is pending. Added to, never changed. */
  notes: RequestNote[];
  decidedBy?: string;
  decidedAt?: Iso;
  decisionNote?: string;
  /** The record the approved change made, for example the new target's id. */
  appliedId?: string;
}

export const REQUEST_STATUS_LABELS: Record<RequestStatus, string> = { pending: 'Waiting for approval', approved: 'Approved', rejected: 'Rejected', withdrawn: 'Withdrawn' };

type Ok<T> = { ok: true; records: T[]; audit: AuditEntry[]; warnings: string[] };
type No = { ok: false; errors: string[] };
/** A decision also hands back the targets or users it changed. */
export type DecideResult = No | (Ok<ApprovalRequest> & { targets?: Target[]; lifeTargets?: LifeTarget[]; users?: SiteUser[] });

const no = (...errors: string[]): No => ({ ok: false, errors });
const audit = (ctx: ConsoleContext, action: string, id: string, before: unknown, after: unknown, reason?: string): AuditEntry =>
  ({ at: ctx.now, userId: ctx.actor.userId, action, entity: 'approval', entityId: id, before, after, reason });

const fmt = (kpi: TargetInput['kpi'], v: number) => (TARGET_KPIS[kpi].unit === '%' ? `${(v * 100).toFixed(1)}%` : `${v.toFixed(1)} h`);
const pendingFor = (requests: ApprovalRequest[], kind: RequestKind, userId: string) =>
  requests.some((r) => r.status === 'pending' && r.kind === kind && (r.payload as { userId?: string }).userId === userId);

// ---------- asking ----------

export function proposeTarget(ctx: ConsoleContext, targets: Target[], requests: ApprovalRequest[], input: TargetInput): Ok<ApprovalRequest> | No {
  const p = permission(ctx.actor, 'change_targets');
  if (p !== 'propose' && p !== 'approve') return no('Your role cannot ask for target changes.');
  // Check it the same way it will be applied.
  const check = setTarget(ctx, targets, input);
  if (!check.ok) return check;
  const t = check.records.at(-1)!;
  const def = TARGET_KPIS[input.kpi];
  const scope = input.model ? `model ${input.model}` : input.fleet ? input.fleet : 'every fleet';
  const replaced = targetFor(targets, input.kpi, { fleet: input.fleet, model: input.model }, t.effectiveFrom, true);
  const r: ApprovalRequest = {
    id: ctx.newId(), kind: 'target',
    title: `${def.label} target ${fmt(input.kpi, input.value)} for ${scope}`,
    reason: input.reason.trim(),
    payload: { kind: 'target', input: { kpi: input.kpi, fleet: input.fleet, model: input.model, value: input.value, amber: input.amber, from: input.from } },
    impact: [
      replaced ? `Replaces ${fmt(input.kpi, replaced.value)} (amber ${fmt(input.kpi, replaced.amber)}) from the start date.` : `First ${def.label} target set for ${scope}; until now the placeholder applied.`,
      `Red, amber and green on ${def.label} change on the Performance page, the weekly pack and the alerts from ${input.from === 'next_shift' ? 'the next shift after approval' : input.from}. Past results keep the target that applied then.`,
    ],
    status: 'pending', requestedBy: ctx.actor.userId, requestedAt: ctx.now, notes: [],
  };
  return { ok: true, records: [...requests, r], audit: [audit(ctx, 'request_target', r.id, null, r, r.reason)], warnings: [] };
}

/** Target life for a model and component kind (docs/component-life.md): asked for by a reliability engineer, approved by a superintendent. */
export function proposeLifeTarget(ctx: ConsoleContext, lifeTargets: LifeTarget[], requests: ApprovalRequest[], input: LifeTargetInput): Ok<ApprovalRequest> | No {
  const p = permission(ctx.actor, 'edit_life_targets');
  if (p !== 'propose' && p !== 'approve') return no('Your role cannot ask for target life changes.');
  const check = setLifeTarget(ctx, lifeTargets, input);
  if (!check.ok) return check;
  const t = check.records.at(-1)!;
  if (requests.some((r) => r.status === 'pending' && r.payload.kind === 'life_target' && r.payload.input.model === t.model && r.payload.input.kind === t.kind && r.payload.input.effectiveFrom === t.effectiveFrom)) {
    return no(`There is already a request waiting for ${t.model} ${KIND_LABELS[t.kind].toLowerCase()} target life from ${t.effectiveFrom}.`);
  }
  const replaced = lifeTargetFor(lifeTargets, t.model, t.kind, t.effectiveFrom);
  const label = `${t.model} ${KIND_LABELS[t.kind].toLowerCase()}`;
  const r: ApprovalRequest = {
    id: ctx.newId(), kind: 'life_target',
    title: `Target life ${t.hours.toLocaleString('en-CA')} h for ${label}`,
    reason: t.reason,
    payload: { kind: 'life_target', input: { model: t.model, kind: t.kind, hours: t.hours, effectiveFrom: t.effectiveFrom } },
    impact: [
      replaced ? `Replaces ${replaced.hours.toLocaleString('en-CA')} h from ${t.effectiveFrom}.` : `First target life for ${label}.`,
      `The life board colours, change-out forecast, life ratio (KPI-030), vendor comparison and risk before target use it for lives that end from ${t.effectiveFrom}. Earlier lives keep the target that applied then.`,
    ],
    status: 'pending', requestedBy: ctx.actor.userId, requestedAt: ctx.now, notes: [],
  };
  return { ok: true, records: [...requests, r], audit: [audit(ctx, 'request_life_target', r.id, null, r, r.reason)], warnings: [] };
}

export function requestRole(ctx: ConsoleContext, users: SiteUser[], requests: ApprovalRequest[], userId: string, role: Role, reason: string): Ok<ApprovalRequest> | No {
  if (permission(ctx.actor, 'manage_users') !== 'yes') return no('Only the Admin asks for role changes.');
  const u = users.find((x) => x.id === userId);
  if (!u || u.retiredAt) return no('That user is not active.');
  if (u.invited) return no('They have not signed in yet. Ask once they have.');
  if (!GOVERNED_ROLES.includes(role)) return no('Only the Admin and Superintendent roles need approval. Change other roles directly.');
  if (u.role === role) return no(`${u.name} already has that role.`);
  if (pendingFor(requests, 'role_grant', userId)) return no(`There is already a role request waiting for ${u.name}.`);
  if (!reason.trim()) return no('Give a reason.');
  const r: ApprovalRequest = {
    id: ctx.newId(), kind: 'role_grant', title: `${u.name}: ${ROLE_LABELS[u.role]} to ${ROLE_LABELS[role]}`, reason: reason.trim(),
    payload: { kind: 'role_grant', userId, role, from: u.role },
    impact: [`${u.name} gets everything the ${ROLE_LABELS[role]} role can do (plan 11.2), across their scope: ${u.scope.includes('*') ? 'the whole site' : u.scope.join(', ')}.`],
    status: 'pending', requestedBy: ctx.actor.userId, requestedAt: ctx.now, notes: [],
  };
  return { ok: true, records: [...requests, r], audit: [audit(ctx, 'request_role', r.id, null, r, r.reason)], warnings: [] };
}

/** `until` is a site-local date; the acting role ends at 00:00 site time after it. */
export function requestActingRole(ctx: ConsoleContext, users: SiteUser[], requests: ApprovalRequest[], userId: string, role: Role, until: string, reason: string): Ok<ApprovalRequest> | No {
  if (permission(ctx.actor, 'manage_users') !== 'yes') return no('Only the Admin asks for acting roles.');
  const u = users.find((x) => x.id === userId);
  if (!u || u.retiredAt) return no('That user is not active.');
  if (u.invited) return no('They have not signed in yet.');
  const e: string[] = [];
  if (!['supervisor', 'reliability_engineer', 'superintendent'].includes(role)) e.push('Acting roles are supervisor, reliability engineer or superintendent.');
  if (u.role === role) e.push(`${u.name} already has that role.`);
  const d = DateTime.fromISO(until, { zone: ctx.timeZone });
  const end = d.isValid && /^\d{4}-\d{2}-\d{2}$/.test(until) ? d.plus({ days: 1 }).startOf('day').toUTC().toISO()! : null;
  if (!end) e.push('Choose the last day of the acting role.');
  else if (ms(end) <= ms(ctx.now)) e.push('The last day must be today or later.');
  else if (ms(end) - ms(ctx.now) > 92 * 864e5) e.push('An acting role can last up to three months. Change the person\'s role instead.');
  if (pendingFor(requests, 'acting_role', userId)) e.push(`There is already an acting role request waiting for ${u.name}.`);
  if (!reason.trim()) e.push('Give a reason, for example who they cover and why.');
  if (e.length) return no(...e);
  const r: ApprovalRequest = {
    id: ctx.newId(), kind: 'acting_role', title: `${u.name}: acting ${ROLE_LABELS[role]} to ${until}`, reason: reason.trim(),
    payload: { kind: 'acting_role', userId, role, until: end! },
    impact: [`${u.name} can do everything the ${ROLE_LABELS[role]} role can do until the end of ${until} (site time), then goes back to ${ROLE_LABELS[u.role]} automatically.`],
    status: 'pending', requestedBy: ctx.actor.userId, requestedAt: ctx.now, notes: [],
  };
  return { ok: true, records: [...requests, r], audit: [audit(ctx, 'request_acting_role', r.id, null, r, r.reason)], warnings: [] };
}

// ---------- deciding ----------

/** Who can decide this kind of request: a superintendent (or acting one) for all of them today. */
export function canDecide(who: Who, kind: RequestKind): boolean {
  if (typeof who === 'object' && who.fullAccess) return true;
  return permission(who, kind === 'target' ? 'change_targets' : kind === 'life_target' ? 'edit_life_targets' : 'manage_users') === 'approve';
}

export function decideRequest(
  ctx: ConsoleContext,
  state: { requests: ApprovalRequest[]; targets: Target[]; users: SiteUser[]; lifeTargets?: LifeTarget[] },
  id: string,
  decision: 'approve' | 'reject',
  note: string,
): DecideResult {
  const r = state.requests.find((x) => x.id === id);
  if (!r) return no('Request not found.');
  if (r.status !== 'pending') return no(`This request is already ${REQUEST_STATUS_LABELS[r.status].toLowerCase()}.`);
  if (!canDecide(ctx.actor, r.kind)) return no('Only a superintendent can approve or reject this.');
  if (r.requestedBy === ctx.actor.userId && !ctx.actor.fullAccess) return no('Nobody approves their own request. Another superintendent needs to decide.');
  if (decision === 'reject' && !note.trim()) return no('Say why it is rejected.');

  const done: ApprovalRequest = { ...r, status: decision === 'approve' ? 'approved' : 'rejected', decidedBy: ctx.actor.userId, decidedAt: ctx.now, decisionNote: note.trim() || undefined };
  const records = () => state.requests.map((x) => (x.id === id ? done : x));
  if (decision === 'reject') return { ok: true, records: records(), audit: [audit(ctx, 'reject', id, r, done, note.trim())], warnings: [] };

  const p = r.payload;
  if (p.kind === 'target') {
    // A start that has passed while it waited moves to the next shift.
    let from = p.input.from;
    const warnings: string[] = [];
    if (from !== 'next_shift') {
      const start = DateTime.fromISO(from, { zone: ctx.timeZone }).startOf('day').toUTC().toISO()!;
      if (ms(start) < ms(shiftAt(ctx.calendar, ctx.now).start)) { from = 'next_shift'; warnings.push(`The requested start ${p.input.from} has passed, so the target applies from the next shift.`); }
    }
    const made = setTarget(ctx, state.targets, { ...p.input, from, reason: r.reason });
    if (!made.ok) return made;
    const t: Target = { ...made.records.at(-1)!, setBy: r.requestedBy, approvedBy: ctx.actor.userId, requestId: r.id };
    done.appliedId = t.id;
    const targets = [...state.targets, t];
    return { ok: true, records: records(), targets, audit: [audit(ctx, 'approve', id, r, done, note.trim() || undefined), { ...made.audit[0]!, after: t }], warnings };
  }

  if (p.kind === 'life_target') {
    const lifeTargets = state.lifeTargets ?? [];
    const made = setLifeTarget(ctx, lifeTargets, { ...p.input, reason: r.reason });
    if (!made.ok) return made;
    const t: LifeTarget = { ...made.records.at(-1)!, setBy: r.requestedBy, approvedBy: ctx.actor.userId, requestId: r.id };
    done.appliedId = t.id;
    return { ok: true, records: records(), lifeTargets: [...lifeTargets, t], audit: [audit(ctx, 'approve', id, r, done, note.trim() || undefined), { ...made.audit[0]!, after: t }], warnings: [] };
  }

  const u = state.users.find((x) => x.id === p.userId);
  if (!u || u.retiredAt) return no('That user is no longer active, so the request cannot be applied. Reject it instead.');
  const after: SiteUser = p.kind === 'role_grant' ? { ...u, role: p.role } : { ...u, actingRole: p.role, actingUntil: p.until };
  done.appliedId = u.id;
  const users = state.users.map((x) => (x.id === u.id ? after : x));
  return {
    ok: true, records: records(), users,
    audit: [audit(ctx, 'approve', id, r, done, note.trim() || undefined), { at: ctx.now, userId: ctx.actor.userId, action: p.kind === 'role_grant' ? 'change_user' : 'set_acting_role', entity: 'user', entityId: u.id, before: u, after, reason: r.reason }],
    warnings: [],
  };
}

/** The person who asked can withdraw a request while it is waiting. */
export function withdrawRequest(ctx: ConsoleContext, requests: ApprovalRequest[], id: string, note: string): Ok<ApprovalRequest> | No {
  const r = requests.find((x) => x.id === id);
  if (!r) return no('Request not found.');
  if (r.status !== 'pending') return no('Only a waiting request can be withdrawn.');
  if (r.requestedBy !== ctx.actor.userId) return no('Only the person who asked can withdraw it.');
  const done: ApprovalRequest = { ...r, status: 'withdrawn', decidedBy: ctx.actor.userId, decidedAt: ctx.now, decisionNote: note.trim() || undefined };
  return { ok: true, records: requests.map((x) => (x.id === id ? done : x)), audit: [audit(ctx, 'withdraw', id, r, done, note.trim() || undefined)], warnings: [] };
}

/** A question from an approver, or an answer from the person who asked. */
export function addRequestNote(ctx: ConsoleContext, requests: ApprovalRequest[], id: string, text: string): Ok<ApprovalRequest> | No {
  const r = requests.find((x) => x.id === id);
  if (!r) return no('Request not found.');
  if (r.status !== 'pending') return no('The request is closed.');
  if (r.requestedBy !== ctx.actor.userId && !canDecide(ctx.actor, r.kind)) return no('Only the person who asked and the approvers can add notes.');
  if (!text.trim()) return no('Write the question or answer.');
  const next: ApprovalRequest = { ...r, notes: [...r.notes, { by: ctx.actor.userId, at: ctx.now, text: text.trim() }] };
  return { ok: true, records: requests.map((x) => (x.id === id ? next : x)), audit: [audit(ctx, 'note', id, r, next, text.trim())], warnings: [] };
}

/** Requests waiting for this person: to decide, or to answer a question on their own. */
export function waitingOn(requests: ApprovalRequest[], userId: string, role: Who): ApprovalRequest[] {
  return requests.filter((r) => r.status === 'pending' && (
    (canDecide(role, r.kind) && r.requestedBy !== userId) ||
    (r.requestedBy === userId && r.notes.length > 0 && r.notes.at(-1)!.by !== userId)
  ));
}

/** Acting roles that have ended, for the users list ("went back to ..."). */
export const actingEnded = (u: SiteUser, now: Iso) => !!u.actingRole && !!u.actingUntil && ms(u.actingUntil) <= ms(now);
