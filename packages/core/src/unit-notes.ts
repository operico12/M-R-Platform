// Unit screen (docs/unit-screen.md): repair notes and comments, and technicians assigned to a down unit.
// Pure functions; assignment durations are calculated (rule 4); nothing is deleted (rule 5).

import { jobTitle } from './people.js';
import { can, hasRole } from './permissions.js';
import { ms } from './time.js';
import type { Actor, Asset, AuditEntry, DownFlag, Iso } from './types.js';

export const NOTE_KINDS = ['repair', 'comment'] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];
export const NOTE_KIND_LABELS: Record<NoteKind, string> = { repair: 'Repair note', comment: 'Comment' };
export const NOTE_MAX = 2000;

export interface UnitNote {
  id: string;
  tenantId: string;
  siteId: string;
  unitId: string;
  /** The stop it belongs to, when the unit was down. */
  downFlagId?: string;
  kind: NoteKind;
  text: string;
  by: string;
  at: Iso;
  voidedBy?: string;
  voidedAt?: Iso;
  voidReason?: string;
}

export interface Assignment {
  id: string;
  tenantId: string;
  siteId: string;
  unitId: string;
  downFlagId: string;
  userId: string;
  start: Iso;
  end: Iso | null;
  state: 'open' | 'ended' | 'voided';
  setBy: string;
  enteredAt: Iso;
  endedBy?: string;
  voidedAt?: Iso;
  voidReason?: string;
}

export interface UnitContext {
  now: Iso;
  actor: Actor;
  asset: Asset;
  area?: string;
  /** Every down flag for this unit, any state. */
  unitFlags: DownFlag[];
  newId: () => string;
}

type Res<T> = { ok: true; records: T[]; audit: AuditEntry[] } | { ok: false; errors: string[] };
const fail = <T>(...errors: string[]): Res<T> => ({ ok: false, errors });
const openFlag = (ctx: UnitContext) => ctx.unitFlags.find((f) => f.state === 'open');
const entry = (ctx: { now: Iso; actor: Actor }, action: string, entity: 'unit_note' | 'assignment', id: string, before: unknown, after: unknown, reason?: string): AuditEntry =>
  ({ at: ctx.now, userId: ctx.actor.userId, action, entity, entityId: id, before, after, reason });

// ---------- notes ----------

export function addNote(ctx: UnitContext, notes: UnitNote[], input: { kind: NoteKind; text: string }): Res<UnitNote> {
  if (!can(ctx.actor, 'add_notes')) return fail('Your role cannot add notes.');
  const text = input.text.trim();
  const e: string[] = [];
  if (!NOTE_KINDS.includes(input.kind)) e.push('Choose repair note or comment.');
  if (!text) e.push('Write the note.');
  if (text.length > NOTE_MAX) e.push(`A note is up to ${NOTE_MAX} characters.`);
  if (e.length) return fail(...e);
  const f = openFlag(ctx);
  const n: UnitNote = {
    id: ctx.newId(), tenantId: ctx.asset.tenantId, siteId: ctx.asset.siteId, unitId: ctx.asset.id,
    ...(f ? { downFlagId: f.id } : {}), kind: input.kind, text, by: ctx.actor.userId, at: ctx.now,
  };
  return { ok: true, records: [...notes, n], audit: [entry(ctx, 'add_note', 'unit_note', n.id, null, n)] };
}

/** The writer, or a superintendent, voids a wrong note with a reason. It stays in the history. */
export function voidNote(ctx: UnitContext, notes: UnitNote[], id: string, reason: string): Res<UnitNote> {
  const before = notes.find((n) => n.id === id);
  if (!before || before.voidedAt) return fail('That note is already voided.');
  if (!(before.by === ctx.actor.userId && can(ctx.actor, 'add_notes')) && !hasRole(ctx.actor, 'superintendent')) return fail('Only the writer, or a superintendent, voids a note.');
  if (!reason.trim()) return fail('Give a reason for voiding.');
  const after: UnitNote = { ...before, voidedBy: ctx.actor.userId, voidedAt: ctx.now, voidReason: reason.trim() };
  return { ok: true, records: notes.map((n) => (n.id === id ? after : n)), audit: [entry(ctx, 'void_note', 'unit_note', id, before, after, reason.trim())] };
}

// ---------- assigned technicians ----------

const mayAssign = (ctx: UnitContext) => can(ctx.actor, 'assign_technicians', ctx.area ?? ctx.asset.fleet);

export function assignTechnician(ctx: UnitContext, list: Assignment[], userId: string): Res<Assignment> {
  if (!mayAssign(ctx)) return fail('Your role cannot assign technicians to this unit.');
  const f = openFlag(ctx);
  if (!f) return fail(`${ctx.asset.unitNumber} is not down. Technicians are assigned to a down unit.`);
  if (!userId) return fail('Choose who to assign.');
  if (list.some((x) => x.state === 'open' && x.userId === userId)) return fail('That person is already assigned.');
  const a: Assignment = {
    id: ctx.newId(), tenantId: ctx.asset.tenantId, siteId: ctx.asset.siteId, unitId: ctx.asset.id, downFlagId: f.id,
    userId, start: ctx.now, end: null, state: 'open', setBy: ctx.actor.userId, enteredAt: ctx.now,
  };
  return { ok: true, records: [...list, a], audit: [entry(ctx, 'assign_technician', 'assignment', a.id, null, a)] };
}

export function unassignTechnician(ctx: UnitContext, list: Assignment[], id: string): Res<Assignment> {
  if (!mayAssign(ctx)) return fail('Your role cannot change who is assigned.');
  const before = list.find((x) => x.id === id);
  if (!before || before.state !== 'open') return fail('That person is no longer assigned.');
  const after: Assignment = { ...before, end: ctx.now, state: 'ended', endedBy: ctx.actor.userId };
  return { ok: true, records: list.map((x) => (x.id === id ? after : x)), audit: [entry(ctx, 'unassign_technician', 'assignment', id, before, after)] };
}

/**
 * After a flag command: once a unit has no open down flag, open assignments end at the release, or are
 * voided when their flag was voided (as wait tags do, docs/wait-tags.md). A type switch keeps a flag open.
 */
export function settleAssignments(list: Assignment[], unitFlags: DownFlag[], ctx: { now: Iso; actor: Actor }): { records: Assignment[]; audit: AuditEntry[] } {
  if (unitFlags.some((f) => f.state === 'open')) return { records: list, audit: [] };
  const byId = new Map(unitFlags.map((f) => [f.id, f]));
  const units = new Set(unitFlags.map((f) => f.unitId));
  const out: AuditEntry[] = [];
  const records = list.map((a) => {
    if (a.state !== 'open' || !units.has(a.unitId)) return a;
    const f = byId.get(a.downFlagId);
    if (f?.state === 'voided') {
      const after: Assignment = { ...a, state: 'voided', voidedAt: ctx.now, voidReason: 'Down flag voided' };
      out.push(entry(ctx, 'void_assignment', 'assignment', a.id, a, after, 'Down flag voided'));
      return after;
    }
    const end = f?.end && ms(f.end) > ms(a.start) ? f.end : a.start;
    const after: Assignment = { ...a, end, state: 'ended', endedBy: ctx.actor.userId };
    out.push(entry(ctx, 'end_assignment', 'assignment', a.id, a, after, 'Unit released'));
    return after;
  });
  return { records, audit: out };
}

/** Hours a person has been on the unit: from assigned to taken off (or now). */
export const assignmentHours = (a: Assignment, now: Iso) => (a.state === 'voided' ? 0 : Math.max(0, (ms(a.end ?? now) - ms(a.start)) / 3.6e6));

/**
 * People who can be assigned (docs/unit-screen.md): access role technician or supervisor, or a job title
 * that suggests technician; not retired and not past their last day of access.
 */
export function assignable<T extends { id: string; role: string; jobTitle?: string; retiredAt?: Iso; accessUntil?: Iso; invited?: boolean }>(people: T[], now: Iso): T[] {
  return people.filter((p) => !p.retiredAt && !p.invited && !(p.accessUntil && ms(p.accessUntil) <= ms(now))
    && (p.role === 'technician' || p.role === 'supervisor' || (!!p.jobTitle && jobTitle(p.jobTitle)?.suggestedRole === 'technician')));
}
