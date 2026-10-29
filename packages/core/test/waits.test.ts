// Wait tags (docs/wait-tags.md): only on a down unit, several at once, one open per kind,
// ended at release, voided with the flag, and never before the stop started.

import { describe, expect, it } from 'vitest';
import { DEFAULT_WAIT_KINDS, endWait, openWaits, settleWaits, startWait, voidWait, type WaitContext, type WaitTag } from '../src/waits.js';
import type { DownFlag, Role } from '../src/types.js';
import { L, actor, fixtureFlag, truck } from './helpers.js';

let n = 0;
const NOW = L('2026-10-26 12:00');
const down = fixtureFlag({ id: 'd', unitId: 'ht1', type: 'unscheduled', start: L('2026-10-26 08:00'), end: null, state: 'open' });
const ctx = (role: Role, over: Partial<WaitContext> = {}): WaitContext => ({
  now: NOW, actor: actor(role), asset: truck('ht1'), unitWaits: [], unitFlags: [down], kinds: DEFAULT_WAIT_KINDS, newId: () => `w${++n}`, ...over,
});

describe('raising and ending wait tags', () => {
  it('follows update_stage: technicians in their area, not viewers or admins', () => {
    const i = { kind: 'TOW', start: L('2026-10-26 08:10') };
    expect(startWait(ctx('technician'), i).ok).toBe(true);
    expect(startWait(ctx('supervisor'), i).ok).toBe(true);
    expect(startWait({ ...ctx('technician'), actor: actor('technician', ['other-fleet']) }, i).ok).toBe(false);
    expect(startWait(ctx('viewer'), i).ok).toBe(false);
    expect(startWait(ctx('admin'), i).ok).toBe(false);
  });

  it('runs several kinds at once, but one open tag per kind', () => {
    const a = startWait(ctx('supervisor'), { kind: 'LABOUR', start: L('2026-10-26 09:00') });
    if (!a.ok) throw new Error(a.errors.join());
    const b = startWait(ctx('supervisor', { unitWaits: a.waits }), { kind: 'PARTS', start: L('2026-10-26 09:30') });
    if (!b.ok) throw new Error(b.errors.join());
    expect(openWaits('ht1', b.waits).map((w) => w.kind)).toEqual(['LABOUR', 'PARTS']);
    expect(startWait(ctx('supervisor', { unitWaits: b.waits }), { kind: 'PARTS', start: L('2026-10-26 10:00') }).ok).toBe(false);
    expect(a.audit[0]!.action).toBe('start_wait');
  });

  it('refuses a unit that is up, before the stop, the future, an unknown kind and Other without a note', () => {
    const s = { kind: 'PARTS', start: L('2026-10-26 09:00') };
    expect(startWait(ctx('supervisor', { unitFlags: [] }), s).ok).toBe(false);
    expect(startWait(ctx('supervisor'), { ...s, start: L('2026-10-26 07:00') }).ok).toBe(false);
    expect(startWait(ctx('supervisor'), { ...s, start: L('2026-10-26 13:00') }).ok).toBe(false);
    expect(startWait(ctx('supervisor'), { ...s, kind: 'NAP' }).ok).toBe(false);
    expect(startWait(ctx('supervisor'), { ...s, kind: 'OTHER' }).ok).toBe(false);
    expect(startWait(ctx('supervisor'), { ...s, kind: 'OTHER', note: 'Waiting on the client' }).ok).toBe(true);
  });

  it('a type switch keeps the stop: a tag can start from the first flag of it', () => {
    const first = fixtureFlag({ id: 'a', unitId: 'ht1', type: 'scheduled', start: L('2026-10-26 06:00'), end: L('2026-10-26 08:00'), state: 'released' });
    const second: DownFlag = { ...down, linkedFromFlagId: 'a', linkKind: 'type_switch' };
    expect(startWait(ctx('supervisor', { unitFlags: [first, second] }), { kind: 'PARTS', start: L('2026-10-26 07:00') }).ok).toBe(true);
  });

  it('ends after the start only, and voids with a reason', () => {
    const r = startWait(ctx('supervisor'), { kind: 'TOW', start: L('2026-10-26 09:00') });
    if (!r.ok) throw new Error('start');
    const id = r.waits[0]!.id;
    expect(endWait(ctx('supervisor', { unitWaits: r.waits }), id, L('2026-10-26 08:30')).ok).toBe(false);
    const e = endWait(ctx('supervisor', { unitWaits: r.waits }), id, L('2026-10-26 10:15'));
    expect(e.ok && e.waits[0]!.state).toBe('ended');
    expect(voidWait(ctx('supervisor', { unitWaits: r.waits }), id, ' ').ok).toBe(false);
    const v = voidWait(ctx('supervisor', { unitWaits: r.waits }), id, 'Wrong unit');
    expect(v.ok && v.waits[0]!.state).toBe('voided');
  });
});

describe('wait tags follow the down flag', () => {
  const open = (id: string, kind: string, start: string): WaitTag =>
    ({ id, tenantId: 't1', siteId: 's1', unitId: 'ht1', downFlagId: 'd', kind, start: L(start), end: null, state: 'open', setBy: 'u', enteredAt: L(start) });
  const ac = { now: NOW, actor: actor('supervisor') };

  it('stay open while a flag is open', () => {
    const w = [open('x', 'PARTS', '2026-10-26 09:00')];
    expect(settleWaits(w, [down], ac).waits).toBe(w);
  });
  it('end at the release when no flag is left open', () => {
    const rel: DownFlag = { ...down, state: 'released', end: L('2026-10-26 11:00') };
    const r = settleWaits([open('x', 'PARTS', '2026-10-26 09:00'), open('y', 'LABOUR', '2026-10-26 10:00')], [rel], ac);
    expect(r.waits.map((w) => [w.state, w.end])).toEqual([['ended', L('2026-10-26 11:00')], ['ended', L('2026-10-26 11:00')]]);
    expect(r.audit).toHaveLength(2);
  });
  it('are voided with their flag', () => {
    const v: DownFlag = { ...down, state: 'voided', voidReason: 'wrong' };
    expect(settleWaits([open('x', 'PARTS', '2026-10-26 09:00')], [v], ac).waits[0]!.state).toBe('voided');
  });
});
