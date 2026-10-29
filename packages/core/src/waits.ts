// Wait tags (docs/wait-tags.md, KPI-046). A down flag keeps one stage at a time (A7 section 4);
// wait tags say what the unit is waiting for, can overlap, and are timed on their own.
// Pure functions; durations are always calculated (rule 4), nothing is deleted (rule 5).

import { downSince } from './board.js';
import { can } from './permissions.js';
import { HOUR_MS, ms } from './time.js';
import type { Period } from './kpis.js';
import type { Actor, Asset, AuditEntry, DownFlag, Iso } from './types.js';

export interface WaitKind { code: string; label: string; noteRequired?: boolean }

export const DEFAULT_WAIT_KINDS: WaitKind[] = [
  { code: 'TOW', label: 'Tow or recovery' },
  { code: 'TRANSPORT', label: 'Lowboy or transport' },
  { code: 'PARTS', label: 'Parts or materials' },
  { code: 'LABOUR', label: 'Labour' },
  { code: 'CREW', label: 'Field crew' },
  { code: 'LINE', label: 'Shop line or bay' },
  { code: 'TOOLS', label: 'Tools or equipment' },
  { code: 'SPECIALIST', label: 'Specialist, OEM or contractor' },
  { code: 'ENGINEERING', label: 'Engineering or information' },
  { code: 'APPROVAL', label: 'Approval or permit' },
  { code: 'ACCESS', label: 'Access or safety clearance' },
  { code: 'OTHER', label: 'Other', noteRequired: true },
];

export const WAIT_LIMITS = { maxBackdateDays: 7, noteMax: 300 } as const;

export interface WaitTag {
  id: string;
  tenantId: string;
  siteId: string;
  unitId: string;
  /** The open down flag it was raised under. */
  downFlagId: string;
  kind: string;
  start: Iso;
  end: Iso | null;
  state: 'open' | 'ended' | 'voided';
  note?: string;
  setBy: string;
  enteredAt: Iso;
  endedBy?: string;
  voidedBy?: string;
  voidedAt?: Iso;
  voidReason?: string;
}

export interface WaitContext {
  now: Iso;
  actor: Actor;
  asset: Asset;
  area?: string;
  /** Every wait tag for this unit, any state. */
  unitWaits: WaitTag[];
  /** Every down flag for this unit, any state. */
  unitFlags: DownFlag[];
  kinds: WaitKind[];
  newId: () => string;
}

export type WaitResult = { ok: true; waits: WaitTag[]; audit: AuditEntry[] } | { ok: false; errors: string[] };

const fail = (...errors: string[]): WaitResult => ({ ok: false, errors });
const iso = (t: number) => new Date(t).toISOString();
const replace = (list: WaitTag[], w: WaitTag) => list.map((x) => (x.id === w.id ? w : x));

function audit(ctx: Pick<WaitContext, 'now' | 'actor'>, action: string, before: WaitTag | null, after: WaitTag, reason?: string): AuditEntry {
  return { at: ctx.now, userId: ctx.actor.userId, action, entity: 'wait_tag', entityId: after.id, before, after, reason };
}

const allowed = (ctx: WaitContext) => can(ctx.actor, 'set_waits', ctx.area ?? ctx.asset.fleet);

function timeErrors(ctx: WaitContext, at: Iso, what: string): string[] {
  const t = Date.parse(at);
  if (Number.isNaN(t)) return [`The ${what} is not a time.`];
  const e: string[] = [];
  if (t > ms(ctx.now) + 60_000) e.push(`The ${what} cannot be in the future.`);
  if (ms(ctx.now) - t > WAIT_LIMITS.maxBackdateDays * 24 * HOUR_MS) e.push(`The ${what} can be up to ${WAIT_LIMITS.maxBackdateDays} days back.`);
  return e;
}

export interface StartWaitInput { kind: string; start: Iso; note?: string }

export function startWait(ctx: WaitContext, input: StartWaitInput): WaitResult {
  if (!allowed(ctx)) return fail('Your role cannot raise wait tags for this unit.');
  const flag = ctx.unitFlags.find((f) => f.state === 'open');
  if (!flag) return fail(`${ctx.asset.unitNumber} has no open down flag. Wait tags are for a unit that is down.`);
  const kind = ctx.kinds.find((k) => k.code === input.kind);
  const e: string[] = [];
  if (!kind) e.push('Choose what the unit is waiting for.');
  else if (ctx.unitWaits.some((w) => w.state === 'open' && w.kind === kind.code)) e.push(`${ctx.asset.unitNumber} is already waiting for ${kind.label.toLowerCase()}.`);
  const note = input.note?.trim() ?? '';
  if (kind?.noteRequired && !note) e.push('Say what it is waiting for.');
  if (note.length > WAIT_LIMITS.noteMax) e.push(`The note is up to ${WAIT_LIMITS.noteMax} characters.`);
  e.push(...timeErrors(ctx, input.start, 'start'));
  if (!e.length && ms(input.start) < ms(downSince(flag, ctx.unitFlags))) e.push('A wait cannot start before the unit went down.');
  if (e.length) return fail(...e);
  const w: WaitTag = {
    id: ctx.newId(), tenantId: ctx.asset.tenantId, siteId: ctx.asset.siteId, unitId: ctx.asset.id, downFlagId: flag.id,
    kind: kind!.code, start: iso(ms(input.start)), end: null, state: 'open', ...(note ? { note } : {}), setBy: ctx.actor.userId, enteredAt: ctx.now,
  };
  return { ok: true, waits: [...ctx.unitWaits, w], audit: [audit(ctx, 'start_wait', null, w)] };
}

export function endWait(ctx: WaitContext, id: string, end: Iso): WaitResult {
  if (!allowed(ctx)) return fail('Your role cannot end wait tags for this unit.');
  const before = ctx.unitWaits.find((w) => w.id === id);
  if (!before || before.state !== 'open') return fail('That wait has already ended.');
  const e = timeErrors(ctx, end, 'end');
  if (!e.length && ms(end) <= ms(before.start)) e.push('The end must be after the start.');
  if (e.length) return fail(...e);
  const after: WaitTag = { ...before, end: iso(ms(end)), state: 'ended', endedBy: ctx.actor.userId };
  return { ok: true, waits: replace(ctx.unitWaits, after), audit: [audit(ctx, 'end_wait', before, after)] };
}

/** A wrong tag is voided with a reason, never deleted. */
export function voidWait(ctx: WaitContext, id: string, reason: string): WaitResult {
  if (!allowed(ctx)) return fail('Your role cannot void wait tags for this unit.');
  const before = ctx.unitWaits.find((w) => w.id === id);
  if (!before || before.state === 'voided') return fail('That wait is already voided.');
  if (!reason.trim()) return fail('Give a reason for voiding.');
  const after: WaitTag = { ...before, state: 'voided', voidedBy: ctx.actor.userId, voidedAt: ctx.now, voidReason: reason.trim() };
  return { ok: true, waits: replace(ctx.unitWaits, after), audit: [audit(ctx, 'void_wait', before, after, reason.trim())] };
}

/**
 * After a flag command: once a unit has no open down flag, its open tags end at the release
 * (or are voided when the flag they were raised under was voided). A type switch keeps a flag open.
 */
export function settleWaits(waits: WaitTag[], unitFlags: DownFlag[], ctx: { now: Iso; actor: Actor }): { waits: WaitTag[]; audit: AuditEntry[] } {
  if (unitFlags.some((f) => f.state === 'open')) return { waits, audit: [] };
  const unitIds = new Set(unitFlags.map((f) => f.unitId));
  const byId = new Map(unitFlags.map((f) => [f.id, f]));
  const lastRelease = Math.max(...unitFlags.filter((f) => f.state === 'released' && f.end).map((f) => ms(f.end!)), -Infinity);
  const out: AuditEntry[] = [];
  const next = waits.map((w) => {
    if (w.state !== 'open' || !unitIds.has(w.unitId)) return w;
    const own = byId.get(w.downFlagId);
    let after: WaitTag;
    if (own?.state === 'voided' || !Number.isFinite(lastRelease) || lastRelease <= ms(w.start)) {
      after = { ...w, state: 'voided', voidedBy: ctx.actor.userId, voidedAt: ctx.now, voidReason: own?.state === 'voided' ? 'The down flag was voided.' : 'The unit was released before this wait started.' };
    } else {
      after = { ...w, end: iso(lastRelease), state: 'ended', endedBy: ctx.actor.userId };
    }
    out.push(audit(ctx, after.state === 'voided' ? 'void_wait' : 'end_wait', w, after, 'Unit released or flag voided'));
    return after;
  });
  return { waits: next, audit: out };
}

/** The unit's open wait tags, longest on first. */
export const openWaits = (unitId: string, waits: WaitTag[]) =>
  waits.filter((w) => w.unitId === unitId && w.state === 'open').sort((a, b) => ms(a.start) - ms(b.start));

// ---------- hours (KPI-046) ----------

type Span = [number, number];

function merge(spans: Span[]): Span[] {
  const s = spans.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out: Span[] = [];
  for (const sp of s) {
    const last = out.at(-1);
    if (last && sp[0] <= last[1]) last[1] = Math.max(last[1], sp[1]);
    else out.push([sp[0], sp[1]]);
  }
  return out;
}
const hours = (spans: Span[]) => spans.reduce((t, [a, b]) => t + (b - a), 0) / HOUR_MS;

export interface WaitBreakdown {
  /** Hours per kind. Overlapping kinds each count in full, so these can add up to more than waiting. */
  byKind: Record<string, number>;
  /** Hours in which at least one tag was open, per unit then summed (overlaps counted once). */
  waiting: number;
}

export function waitBreakdown(waits: WaitTag[], p: Period, now: Iso): WaitBreakdown {
  const from = ms(p.from);
  const to = Math.min(ms(p.to), ms(now));
  const out: WaitBreakdown = { byKind: {}, waiting: 0 };
  if (to <= from) return out;
  const perUnit = new Map<string, Span[]>();
  for (const w of waits) {
    if (w.state === 'voided') continue;
    const a = Math.max(ms(w.start), from);
    const b = Math.min(w.end ? ms(w.end) : ms(now), to);
    if (b <= a) continue;
    out.byKind[w.kind] = (out.byKind[w.kind] ?? 0) + (b - a) / HOUR_MS;
    perUnit.set(w.unitId, [...(perUnit.get(w.unitId) ?? []), [a, b]]);
  }
  for (const spans of perUnit.values()) out.waiting += hours(merge(spans));
  return out;
}
