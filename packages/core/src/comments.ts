// Flag comments (docs/flag-comments.md): a thread on a down flag, and optionally on one of its wait tags,
// that stays readable after the unit is back up. Comments are never edited or deleted (rule 5); a wrong one is
// voided with a reason. Pure functions, audited.

import { can } from './permissions.js';
import type { WaitTag } from './waits.js';
import type { Actor, Asset, AuditEntry, DownFlag, Iso } from './types.js';

export const COMMENT_LIMITS = { textMax: 1000, voidReasonMax: 300 } as const;

export interface FlagComment {
  id: string;
  tenantId: string;
  siteId: string;
  unitId: string;
  downFlagId: string;
  /** Set when the comment is about one wait tag on the flag. */
  waitTagId?: string;
  text: string;
  setBy: string;
  enteredAt: Iso;
  state: 'active' | 'voided';
  voidedBy?: string;
  voidedAt?: Iso;
  voidReason?: string;
}

export interface CommentContext {
  now: Iso;
  actor: Actor;
  asset: Asset;
  area?: string;
  /** Every down flag for this unit, any state. */
  unitFlags: DownFlag[];
  /** Every wait tag for this unit, any state. */
  unitWaits: WaitTag[];
  /** Every comment for this unit. */
  unitComments: FlagComment[];
  newId: () => string;
}

export type CommentResult = { ok: true; comments: FlagComment[]; audit: AuditEntry[] } | { ok: false; errors: string[] };

const fail = (...errors: string[]): CommentResult => ({ ok: false, errors });
const audit = (ctx: Pick<CommentContext, 'now' | 'actor'>, action: string, before: FlagComment | null, after: FlagComment, reason?: string): AuditEntry =>
  ({ at: ctx.now, userId: ctx.actor.userId, action, entity: 'flag_comment', entityId: after.id, before, after, reason });

/** Roles that may void someone else's comment. */
const MODERATORS = new Set(['supervisor', 'reliability_engineer', 'superintendent']);

/** The author, or a supervisor, reliability engineer or superintendent, may void a comment that is still active. */
export function canVoidComment(actor: Actor, c: Pick<FlagComment, 'setBy' | 'state'>, area?: string): boolean {
  if (c.state === 'voided' || !can(actor, 'add_notes', area)) return false;
  return c.setBy === actor.userId || MODERATORS.has(actor.role) || actor.fullAccess === true;
}

export interface AddCommentInput { downFlagId: string; waitTagId?: string; text: string }

export function addComment(ctx: CommentContext, input: AddCommentInput): CommentResult {
  if (!can(ctx.actor, 'add_notes', ctx.area ?? ctx.asset.fleet)) return fail('Your role cannot add comments.');
  const flag = ctx.unitFlags.find((f) => f.id === input.downFlagId);
  const e: string[] = [];
  if (!flag) e.push(`That flag is not on ${ctx.asset.unitNumber}.`);
  else if (flag.state !== 'open' && flag.state !== 'released') e.push('Comments can be added to an open or released flag.');
  const text = input.text.trim();
  if (!text) e.push('Write a comment.');
  if (text.length > COMMENT_LIMITS.textMax) e.push(`A comment is up to ${COMMENT_LIMITS.textMax} characters.`);
  if (input.waitTagId) {
    const w = ctx.unitWaits.find((x) => x.id === input.waitTagId);
    if (!w || w.downFlagId !== input.downFlagId) e.push('That wait is not on this flag.');
    else if (w.state === 'voided') e.push('That wait is voided.');
  }
  if (e.length) return fail(...e);
  const c: FlagComment = {
    id: ctx.newId(), tenantId: ctx.asset.tenantId, siteId: ctx.asset.siteId, unitId: ctx.asset.id, downFlagId: input.downFlagId,
    ...(input.waitTagId ? { waitTagId: input.waitTagId } : {}), text, setBy: ctx.actor.userId, enteredAt: ctx.now, state: 'active',
  };
  return { ok: true, comments: [...ctx.unitComments, c], audit: [audit(ctx, 'add_comment', null, c)] };
}

/** A wrong comment is voided with a reason, never deleted or edited. */
export function voidComment(ctx: CommentContext, id: string, reason: string): CommentResult {
  const before = ctx.unitComments.find((c) => c.id === id);
  if (!before) return fail('That comment is not on this unit.');
  if (before.state === 'voided') return fail('That comment is already voided.');
  if (!canVoidComment(ctx.actor, before, ctx.area ?? ctx.asset.fleet)) return fail('Only the person who wrote it, or a supervisor, can void a comment.');
  const why = reason.trim();
  const e: string[] = [];
  if (!why) e.push('Say why it is being voided.');
  if (why.length > COMMENT_LIMITS.voidReasonMax) e.push(`The reason is up to ${COMMENT_LIMITS.voidReasonMax} characters.`);
  if (e.length) return fail(...e);
  const after: FlagComment = { ...before, state: 'voided', voidedBy: ctx.actor.userId, voidedAt: ctx.now, voidReason: why };
  return { ok: true, comments: ctx.unitComments.map((c) => (c.id === id ? after : c)), audit: [audit(ctx, 'void_comment', before, after, why)] };
}

/** One flag's thread, oldest first. Voided comments are kept unless `hideVoided` is set. */
export function commentsOf(downFlagId: string, all: FlagComment[], opts: { waitTagId?: string; hideVoided?: boolean } = {}): FlagComment[] {
  return all
    .filter((c) => c.downFlagId === downFlagId && (!opts.waitTagId || c.waitTagId === opts.waitTagId) && (!opts.hideVoided || c.state === 'active'))
    .sort((a, b) => Date.parse(a.enteredAt) - Date.parse(b.enteredAt) || a.id.localeCompare(b.id));
}

/** Active comment count per down flag, for the Down flags table. */
export function commentCounts(all: FlagComment[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const c of all) if (c.state === 'active') out.set(c.downFlagId, (out.get(c.downFlagId) ?? 0) + 1);
  return out;
}
