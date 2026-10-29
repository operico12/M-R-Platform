// Standby flag commands (docs/standby.md): who can raise them, one open at a time, never while
// down, ended by a down flag, voided not deleted, and counted only while the unit is available.

import { describe, expect, it } from 'vitest';
import { DEFAULT_STANDBY_REASONS, endStandby, endStandbyForDown, standbyHoursFor, startStandby, voidStandby, type StandbyContext, type StandbyFlag } from '../src/standby.js';
import type { Role } from '../src/types.js';
import { L, actor, fixtureFlag, minutes, truck } from './helpers.js';

let n = 0;
const NOW = L('2026-10-26 10:00');
const ctx = (role: Role, over: Partial<StandbyContext> = {}): StandbyContext => ({
  now: NOW, actor: actor(role), asset: truck('ht1'), unitStandby: [], unitFlags: [], reasons: DEFAULT_STANDBY_REASONS, newId: () => `sb${++n}`, ...over,
});

describe('raising and ending standby', () => {
  it('technicians and supervisors can; viewers and admins cannot', () => {
    const input = { reasonCode: 'NO_OPERATOR', start: L('2026-10-26 09:30') };
    expect(startStandby(ctx('technician'), input).ok).toBe(true);
    expect(startStandby(ctx('supervisor'), input).ok).toBe(true);
    expect(startStandby(ctx('viewer'), input).ok).toBe(false);
    expect(startStandby(ctx('admin'), input).ok).toBe(false);
  });

  it('records the kind from the reason, and is audited', () => {
    const r = startStandby(ctx('technician'), { reasonCode: 'CRIB', start: L('2026-10-26 09:30'), note: ' lunch ' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.standby[0]).toMatchObject({ reasonCode: 'CRIB', kind: 'operating_delay', state: 'open', end: null, note: 'lunch' });
    expect(r.audit[0]!.action).toBe('start_standby');
  });

  it('refuses a second open standby, a unit that is down, an unknown reason, the future and more than 7 days back', () => {
    const open: StandbyFlag = { id: 'x', tenantId: 't1', siteId: 's1', unitId: 'ht1', reasonCode: 'CRIB', kind: 'operating_delay', start: L('2026-10-26 09:00'), end: null, state: 'open', setBy: 'u', enteredAt: NOW };
    const s = { reasonCode: 'NO_WORK', start: L('2026-10-26 09:30') };
    expect(startStandby(ctx('technician', { unitStandby: [open] }), s).ok).toBe(false);
    const down = fixtureFlag({ id: 'd', unitId: 'ht1', type: 'unscheduled', start: L('2026-10-26 08:00'), end: null, state: 'open' });
    expect(startStandby(ctx('technician', { unitFlags: [down] }), s).ok).toBe(false);
    expect(startStandby(ctx('technician'), { ...s, reasonCode: 'NAP' }).ok).toBe(false);
    expect(startStandby(ctx('technician'), { ...s, start: L('2026-10-26 11:00') }).ok).toBe(false);
    expect(startStandby(ctx('technician'), { ...s, start: L('2026-10-18 09:00') }).ok).toBe(false);
  });

  it('ends after the start only, and voids with a reason', () => {
    const r = startStandby(ctx('technician'), { reasonCode: 'WEATHER', start: L('2026-10-26 09:00') });
    if (!r.ok) throw new Error('start');
    const id = r.standby[0]!.id;
    expect(endStandby(ctx('technician', { unitStandby: r.standby }), id, L('2026-10-26 08:00')).ok).toBe(false);
    const e = endStandby(ctx('technician', { unitStandby: r.standby }), id, L('2026-10-26 09:45'));
    expect(e.ok && e.standby[0]!.state).toBe('ended');
    expect(voidStandby(ctx('technician', { unitStandby: r.standby }), id, ' ').ok).toBe(false);
    const v = voidStandby(ctx('technician', { unitStandby: r.standby }), id, 'Wrong truck');
    expect(v.ok && v.standby).toHaveLength(1);
    expect(v.ok && v.standby[0]!.state).toBe('voided');
  });
});

describe('standby and down flags', () => {
  const open: StandbyFlag = { id: 's', tenantId: 't1', siteId: 's1', unitId: 'ht1', reasonCode: 'NO_OPERATOR', kind: 'standby', start: L('2026-10-26 08:00'), end: null, state: 'open', setBy: 'u', enteredAt: L('2026-10-26 08:00') };

  it('a down flag ends the open standby at the down start', () => {
    const down = fixtureFlag({ id: 'd', unitId: 'ht1', type: 'unscheduled', start: L('2026-10-26 09:00'), end: null, state: 'open' });
    const r = endStandbyForDown([open], down, { now: NOW, actor: actor('supervisor') });
    expect(r.standby[0]).toMatchObject({ state: 'ended', end: L('2026-10-26 09:00'), endedByDownFlagId: 'd' });
    expect(r.audit).toHaveLength(1);
  });

  it('a down flag starting before the standby voids it', () => {
    const down = fixtureFlag({ id: 'd', unitId: 'ht1', type: 'unscheduled', start: L('2026-10-26 07:00'), end: null, state: 'open' });
    expect(endStandbyForDown([open], down, { now: NOW, actor: actor('supervisor') }).standby[0]!.state).toBe('voided');
  });

  it('an open standby counts up to now, minus parked time', () => {
    const p = { from: L('2026-10-26 06:00'), to: L('2026-10-26 18:00') };
    expect(minutes(standbyHoursFor('ht1', [open], [], [], p, NOW))).toBe(120);
    const parked = [{ assetId: 'ht1', status: 'parked' as const, start: L('2026-10-26 09:30'), end: null }];
    expect(minutes(standbyHoursFor('ht1', [open], [], parked, p, NOW))).toBe(90);
  });
});
