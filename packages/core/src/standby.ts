// Standby flags (docs/standby.md, KPI-044 and KPI-045). A unit is in use unless a flag says
// otherwise: down flags take it out of available time, standby flags say it was available
// but not in use. Pure functions; durations are always calculated (rule 4), nothing is
// deleted (rule 5), and down wins over standby so PA never moves.

import { can } from './permissions.js';
import { HOUR_MS, ms, toIso } from './time.js';
import { countingFlags, downIntervals, type Period } from './kpis.js';
import type { Actor, Asset, AssetLifecycle, AssetLifecycleInterval, AuditEntry, DownFlag, Iso } from './types.js';

/** Operating delay: part of the shift's routine. Standby: could work but is not asked to. */
export type StandbyKind = 'operating_delay' | 'standby';

export interface StandbyReason { code: string; label: string; kind: StandbyKind }

export const DEFAULT_STANDBY_REASONS: StandbyReason[] = [
  { code: 'SHIFT_CHANGE', label: 'Shift change', kind: 'operating_delay' },
  { code: 'CRIB', label: 'Crib or meal break', kind: 'operating_delay' },
  { code: 'REFUEL', label: 'Refuelling', kind: 'operating_delay' },
  { code: 'DISPATCH_HOLD', label: 'Dispatch hold', kind: 'operating_delay' },
  { code: 'PRESTART', label: 'Pre-start check', kind: 'operating_delay' },
  { code: 'NO_OPERATOR', label: 'Waiting for an operator', kind: 'standby' },
  { code: 'NO_WORK', label: 'No work or no ore', kind: 'standby' },
  { code: 'WEATHER', label: 'Weather', kind: 'standby' },
  { code: 'BLASTING', label: 'Blasting', kind: 'standby' },
  { code: 'ROAD_DUMP', label: 'Road or dump closed', kind: 'standby' },
  { code: 'OTHER', label: 'Other', kind: 'standby' },
];

export const STANDBY_LIMITS = { maxBackdateDays: 7, noteMax: 300 } as const;

export interface StandbyFlag {
  id: string;
  tenantId: string;
  siteId: string;
  unitId: string;
  reasonCode: string;
  /** Kept on the flag so a later change to the reason list does not rewrite history. */
  kind: StandbyKind;
  start: Iso;
  end: Iso | null;
  state: 'open' | 'ended' | 'voided';
  note?: string;
  setBy: string;
  enteredAt: Iso;
  endedBy?: string;
  /** Set when the standby was ended because the unit went down. */
  endedByDownFlagId?: string;
  voidedBy?: string;
  voidedAt?: Iso;
  voidReason?: string;
}

export interface StandbyContext {
  now: Iso;
  actor: Actor;
  asset: Asset;
  area?: string;
  lifecycle?: AssetLifecycle;
  /** Every standby flag for this unit, any state. */
  unitStandby: StandbyFlag[];
  /** Every down flag for this unit, any state. */
  unitFlags: DownFlag[];
  reasons: StandbyReason[];
  newId: () => string;
}

export type StandbyResult =
  | { ok: true; standby: StandbyFlag[]; audit: AuditEntry[] }
  | { ok: false; errors: string[] };

const fail = (...errors: string[]): StandbyResult => ({ ok: false, errors });

function audit(ctx: Pick<StandbyContext, 'now' | 'actor'>, action: string, before: StandbyFlag | null, after: StandbyFlag, reason?: string): AuditEntry {
  return { at: ctx.now, userId: ctx.actor.userId, action, entity: 'standby_flag', entityId: after.id, before, after, reason };
}

const replace = (list: StandbyFlag[], f: StandbyFlag) => list.map((x) => (x.id === f.id ? f : x));
const openStandby = (list: StandbyFlag[]) => list.find((s) => s.state === 'open');

function timeErrors(ctx: StandbyContext, at: Iso, what: string): string[] {
  const t = Date.parse(at);
  if (Number.isNaN(t)) return [`The ${what} is not a time.`];
  const e: string[] = [];
  if (t > ms(ctx.now) + 60_000) e.push(`The ${what} cannot be in the future.`);
  if (ms(ctx.now) - t > STANDBY_LIMITS.maxBackdateDays * 24 * HOUR_MS) e.push(`The ${what} can be up to ${STANDBY_LIMITS.maxBackdateDays} days back.`);
  return e;
}

export interface StartStandbyInput { reasonCode: string; start: Iso; note?: string }

export function startStandby(ctx: StandbyContext, input: StartStandbyInput): StandbyResult {
  if (!can(ctx.actor, 'set_standby', ctx.area ?? ctx.asset.fleet)) return fail('Your role cannot raise standby flags.');
  if (ctx.lifecycle && ctx.lifecycle !== 'active') return fail(`${ctx.asset.unitNumber} is ${ctx.lifecycle}, so it cannot be on standby.`);
  if (openStandby(ctx.unitStandby)) return fail(`${ctx.asset.unitNumber} is already on standby. End that first.`);
  if (ctx.unitFlags.some((f) => f.state === 'open' || f.state === 'proposed')) return fail(`${ctx.asset.unitNumber} has an open down flag. A unit that is down is not on standby.`);
  const reason = ctx.reasons.find((r) => r.code === input.reasonCode);
  const e: string[] = [];
  if (!reason) e.push('Choose a standby reason.');
  e.push(...timeErrors(ctx, input.start, 'start'));
  const note = input.note?.trim() ?? '';
  if (note.length > STANDBY_LIMITS.noteMax) e.push(`The note is up to ${STANDBY_LIMITS.noteMax} characters.`);
  if (e.length) return fail(...e);
  const f: StandbyFlag = {
    id: ctx.newId(), tenantId: ctx.asset.tenantId, siteId: ctx.asset.siteId, unitId: ctx.asset.id,
    reasonCode: reason!.code, kind: reason!.kind, start: new Date(ms(input.start)).toISOString(), end: null, state: 'open',
    ...(note ? { note } : {}), setBy: ctx.actor.userId, enteredAt: ctx.now,
  };
  return { ok: true, standby: [...ctx.unitStandby, f], audit: [audit(ctx, 'start_standby', null, f)] };
}

export function endStandby(ctx: StandbyContext, id: string, end: Iso): StandbyResult {
  if (!can(ctx.actor, 'set_standby', ctx.area ?? ctx.asset.fleet)) return fail('Your role cannot end standby flags.');
  const before = ctx.unitStandby.find((s) => s.id === id);
  if (!before || before.state !== 'open') return fail('That standby has already ended.');
  const e = timeErrors(ctx, end, 'end');
  if (!e.length && ms(end) <= ms(before.start)) e.push('The end must be after the start.');
  if (e.length) return fail(...e);
  const after: StandbyFlag = { ...before, end: new Date(ms(end)).toISOString(), state: 'ended', endedBy: ctx.actor.userId };
  return { ok: true, standby: replace(ctx.unitStandby, after), audit: [audit(ctx, 'end_standby', before, after)] };
}

/** A wrong standby flag is voided with a reason, never deleted. */
export function voidStandby(ctx: StandbyContext, id: string, reason: string): StandbyResult {
  if (!can(ctx.actor, 'set_standby', ctx.area ?? ctx.asset.fleet)) return fail('Your role cannot void standby flags.');
  const before = ctx.unitStandby.find((s) => s.id === id);
  if (!before || before.state === 'voided') return fail('That standby is already voided.');
  if (!reason.trim()) return fail('Give a reason for voiding.');
  const after: StandbyFlag = { ...before, state: 'voided', voidedBy: ctx.actor.userId, voidedAt: ctx.now, voidReason: reason.trim() };
  return { ok: true, standby: replace(ctx.unitStandby, after), audit: [audit(ctx, 'void_standby', before, after, reason.trim())] };
}

/**
 * Flagging a unit down ends its open standby at the down start. Called with the new down flag,
 * after the flag command has passed its own checks.
 */
export function endStandbyForDown(standby: StandbyFlag[], down: DownFlag, ctx: { now: Iso; actor: Actor }): { standby: StandbyFlag[]; audit: AuditEntry[] } {
  const open = standby.find((s) => s.unitId === down.unitId && s.state === 'open');
  if (!open) return { standby, audit: [] };
  // A down start before the standby start means the standby never happened.
  const after: StandbyFlag = ms(down.start) <= ms(open.start)
    ? { ...open, state: 'voided', voidedBy: ctx.actor.userId, voidedAt: ctx.now, voidReason: 'The unit was down from before this standby started.', endedByDownFlagId: down.id }
    : { ...open, end: down.start, state: 'ended', endedBy: ctx.actor.userId, endedByDownFlagId: down.id };
  return { standby: replace(standby, after), audit: [audit(ctx, after.state === 'voided' ? 'void_standby' : 'end_standby', open, after, 'Unit flagged down')] };
}

// ---------- hours (KPI-044, KPI-045) ----------

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

function subtract(spans: Span[], cut: Span[]): Span[] {
  let out = spans;
  for (const [cs, ce] of merge(cut)) {
    out = out.flatMap(([a, b]): Span[] => {
      if (ce <= a || cs >= b) return [[a, b]];
      const r: Span[] = [];
      if (cs > a) r.push([a, cs]);
      if (ce < b) r.push([ce, b]);
      return r;
    });
  }
  return out;
}

const hours = (spans: Span[]) => spans.reduce((s, [a, b]) => s + (b - a), 0) / HOUR_MS;

/** Counted standby time for one unit in a period: clipped to the period and now, minus down and parked time. */
export function standbySpans(unitId: string, standby: StandbyFlag[], flags: DownFlag[], lifecycle: AssetLifecycleInterval[], p: Period, now: Iso, filter?: (s: StandbyFlag) => boolean): Array<{ start: Iso; end: Iso }> {
  const from = ms(p.from);
  const to = Math.min(ms(p.to), ms(now));
  if (to <= from) return [];
  const clip = (a: number, b: number): Span => [Math.max(a, from), Math.min(b, to)];
  const mine = standby.filter((s) => s.unitId === unitId && s.state !== 'voided' && (!filter || filter(s)));
  const sb = merge(mine.map((s) => clip(ms(s.start), s.end ? ms(s.end) : ms(now))));
  const down = countingFlags(flags).filter((f) => f.unitId === unitId).flatMap((f) => downIntervals(f, now)).map((i) => clip(ms(i.start), ms(i.end)));
  const parked = lifecycle.filter((l) => l.assetId === unitId && l.status !== 'active').map((l) => clip(ms(l.start), l.end ? ms(l.end) : to));
  return subtract(sb, [...down, ...parked]).map(([a, b]) => ({ start: toIso(a), end: toIso(b) }));
}

export function standbyHoursFor(unitId: string, standby: StandbyFlag[], flags: DownFlag[], lifecycle: AssetLifecycleInterval[], p: Period, now: Iso, filter?: (s: StandbyFlag) => boolean): number {
  return hours(standbySpans(unitId, standby, flags, lifecycle, p, now, filter).map((i): Span => [ms(i.start), ms(i.end)]));
}

export interface StandbyBreakdown {
  total: number;
  byKind: Record<StandbyKind, number>;
  /** Hours per reason code. Overlaps between reasons on one unit are counted under each, so these can sum to more than total. */
  byReason: Record<string, number>;
}

export function standbyBreakdown(unitIds: string[], standby: StandbyFlag[], flags: DownFlag[], lifecycle: AssetLifecycleInterval[], p: Period, now: Iso): StandbyBreakdown {
  const out: StandbyBreakdown = { total: 0, byKind: { operating_delay: 0, standby: 0 }, byReason: {} };
  const inP = standby.filter((s) => s.state !== 'voided' && ms(s.start) < ms(p.to) && (!s.end || ms(s.end) > ms(p.from)));
  for (const id of unitIds) {
    const sb = inP.filter((s) => s.unitId === id);
    if (!sb.length) continue;
    const fl = flags.filter((f) => f.unitId === id);
    out.total += standbyHoursFor(id, sb, fl, lifecycle, p, now);
    for (const k of ['operating_delay', 'standby'] as StandbyKind[]) out.byKind[k] += standbyHoursFor(id, sb, fl, lifecycle, p, now, (s) => s.kind === k);
    for (const c of new Set(sb.map((s) => s.reasonCode))) {
      const h = standbyHoursFor(id, sb, fl, lifecycle, p, now, (s) => s.reasonCode === c);
      if (h > 0) out.byReason[c] = (out.byReason[c] ?? 0) + h;
    }
  }
  return out;
}

/** The unit's open standby flag now, if any. */
export const currentStandby = (unitId: string, standby: StandbyFlag[]) => standby.find((s) => s.unitId === unitId && s.state === 'open');
