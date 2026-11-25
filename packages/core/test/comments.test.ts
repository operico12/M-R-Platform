// Flag comments (docs/flag-comments.md): open or released flags only, never edited or deleted,
// voided with a reason by the author or a supervisor, audited.

import { describe, expect, it } from 'vitest';
import { addComment, canVoidComment, commentCounts, commentsOf, voidComment, type CommentContext, type FlagComment } from '../src/comments.js';
import type { WaitTag } from '../src/waits.js';
import type { DownFlag, Role } from '../src/types.js';
import { L, actor, fixtureFlag, truck } from './helpers.js';

let n = 0;
const NOW = L('2026-10-26 12:00');
const open = fixtureFlag({ id: 'd', unitId: 'ht1', type: 'unscheduled', start: L('2026-10-26 08:00'), end: null, state: 'open' });
const released = fixtureFlag({ id: 'r', unitId: 'ht1', type: 'unscheduled', start: L('2026-10-20 08:00'), end: L('2026-10-20 12:00'), state: 'released' });
const voidedFlag: DownFlag = { ...open, id: 'v', state: 'voided' };
const tag = (over: Partial<WaitTag> = {}): WaitTag => ({
  id: 'w1', tenantId: 't1', siteId: 's1', unitId: 'ht1', downFlagId: 'd', kind: 'PARTS', start: L('2026-10-26 09:00'), end: null, state: 'open', setBy: 'x', enteredAt: L('2026-10-26 09:00'), ...over,
});
const ctx = (role: Role, over: Partial<CommentContext> = {}): CommentContext => ({
  now: NOW, actor: actor(role), asset: truck('ht1'), unitFlags: [open, released, voidedFlag], unitWaits: [tag()], unitComments: [], newId: () => `c${++n}`, ...over,
});

describe('adding comments', () => {
  it('follows add_notes: technician to superintendent, not viewer or admin', () => {
    const i = { downFlagId: 'd', text: 'Part 1234 on the 14:00 truck' };
    for (const r of ['technician', 'supervisor', 'reliability_engineer', 'superintendent'] as Role[]) expect(addComment(ctx(r), i).ok).toBe(true);
    expect(addComment(ctx('viewer'), i).ok).toBe(false);
    expect(addComment(ctx('admin'), i).ok).toBe(false);
  });

  it('stamps the author and the entry time itself, and audits it', () => {
    const r = addComment(ctx('technician'), { downFlagId: 'd', text: '  Waiting on the lowboy  ' });
    if (!r.ok) throw new Error(r.errors.join());
    const c = r.comments[0]!;
    expect(c).toMatchObject({ text: 'Waiting on the lowboy', setBy: 'technician-1', enteredAt: NOW, state: 'active', downFlagId: 'd', unitId: 'ht1' });
    expect(r.audit[0]).toMatchObject({ action: 'add_comment', entity: 'flag_comment', entityId: c.id, before: null, userId: 'technician-1' });
  });

  it('takes comments on released flags too, so findings after the repair stay with the event', () => {
    expect(addComment(ctx('supervisor'), { downFlagId: 'r', text: 'Root cause confirmed by the lab' }).ok).toBe(true);
  });

  it('refuses voided flags, flags of another unit, empty and over-long text', () => {
    expect(addComment(ctx('supervisor'), { downFlagId: 'v', text: 'x' }).ok).toBe(false);
    expect(addComment(ctx('supervisor'), { downFlagId: 'nope', text: 'x' }).ok).toBe(false);
    expect(addComment(ctx('supervisor'), { downFlagId: 'd', text: '   ' }).ok).toBe(false);
    expect(addComment(ctx('supervisor'), { downFlagId: 'd', text: 'x'.repeat(1001) }).ok).toBe(false);
    expect(addComment(ctx('supervisor'), { downFlagId: 'd', text: 'x'.repeat(1000) }).ok).toBe(true);
  });

  it('can be about a wait tag, but only one on the same flag and not a voided one', () => {
    const ok = addComment(ctx('supervisor'), { downFlagId: 'd', waitTagId: 'w1', text: 'Chasing stores' });
    expect(ok.ok && ok.comments[0]!.waitTagId).toBe('w1');
    expect(addComment(ctx('supervisor'), { downFlagId: 'r', waitTagId: 'w1', text: 'x' }).ok).toBe(false);
    expect(addComment(ctx('supervisor'), { downFlagId: 'd', waitTagId: 'zz', text: 'x' }).ok).toBe(false);
    expect(addComment(ctx('supervisor', { unitWaits: [tag({ state: 'voided' })] }), { downFlagId: 'd', waitTagId: 'w1', text: 'x' }).ok).toBe(false);
  });
});

describe('voiding comments', () => {
  const mine: FlagComment = { id: 'c-mine', tenantId: 't1', siteId: 's1', unitId: 'ht1', downFlagId: 'd', text: 'wrong truck', setBy: 'technician-1', enteredAt: L('2026-10-26 10:00'), state: 'active' };

  it('lets the author or a supervisor void it with a reason, and keeps the text', () => {
    const r = voidComment(ctx('technician', { unitComments: [mine] }), 'c-mine', 'Wrong truck');
    if (!r.ok) throw new Error(r.errors.join());
    expect(r.comments[0]).toMatchObject({ state: 'voided', text: 'wrong truck', voidReason: 'Wrong truck', voidedBy: 'technician-1', voidedAt: NOW });
    expect(r.audit[0]).toMatchObject({ action: 'void_comment', reason: 'Wrong truck' });
    expect(voidComment(ctx('supervisor', { unitComments: [mine] }), 'c-mine', 'Off topic').ok).toBe(true);
  });

  it('refuses a stranger who is not a supervisor, a missing reason, a second void and a missing comment', () => {
    const other = { ...mine, setBy: 'someone-else' };
    expect(voidComment(ctx('technician', { unitComments: [other] }), 'c-mine', 'x').ok).toBe(false);
    expect(voidComment(ctx('technician', { unitComments: [mine] }), 'c-mine', '  ').ok).toBe(false);
    expect(voidComment(ctx('technician', { unitComments: [{ ...mine, state: 'voided' }] }), 'c-mine', 'x').ok).toBe(false);
    expect(voidComment(ctx('technician', { unitComments: [mine] }), 'zzz', 'x').ok).toBe(false);
    expect(voidComment(ctx('viewer', { unitComments: [{ ...mine, setBy: 'viewer-1' }] }), 'c-mine', 'x').ok).toBe(false);
  });
});

describe('reading threads', () => {
  const mk = (id: string, flag: string, at: string, over: Partial<FlagComment> = {}): FlagComment => ({
    id, tenantId: 't1', siteId: 's1', unitId: 'ht1', downFlagId: flag, text: id, setBy: 'x', enteredAt: L(at), state: 'active', ...over,
  });
  const all = [mk('b', 'd', '2026-10-26 11:00'), mk('a', 'd', '2026-10-26 10:00', { waitTagId: 'w1' }), mk('v', 'd', '2026-10-26 10:30', { state: 'voided' }), mk('z', 'r', '2026-10-20 10:00')];

  it('orders oldest first, keeps voided unless hidden, and filters by wait tag', () => {
    expect(commentsOf('d', all).map((c) => c.id)).toEqual(['a', 'v', 'b']);
    expect(commentsOf('d', all, { hideVoided: true }).map((c) => c.id)).toEqual(['a', 'b']);
    expect(commentsOf('d', all, { waitTagId: 'w1' }).map((c) => c.id)).toEqual(['a']);
  });

  it('counts active comments per flag', () => {
    expect(commentCounts(all)).toEqual(new Map([['d', 2], ['r', 1]]));
  });
});

describe('canVoidComment', () => {
  const c = { setBy: 'technician-1', state: 'active' as const };
  it('is the author or a moderator, never on a voided comment', () => {
    expect(canVoidComment(actor('technician'), c)).toBe(true);
    expect(canVoidComment({ ...actor('technician'), userId: 'other' }, c)).toBe(false);
    expect(canVoidComment({ ...actor('supervisor'), userId: 'other' }, c)).toBe(true);
    expect(canVoidComment({ ...actor('viewer'), userId: 'technician-1' }, c)).toBe(false);
    expect(canVoidComment(actor('technician'), { ...c, state: 'voided' })).toBe(false);
  });
});
