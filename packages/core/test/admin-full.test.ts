// Admin full control in test mode (docs/access.md section 4): passes every role check, keeps the data rules.

import { describe, expect, it } from 'vitest';
import { DEFAULT_ACCESS, adminFull } from '../src/access.js';
import { canDecide, decideRequest, proposeTarget, waitingOn } from '../src/approvals.js';
import { L, TZ, cal } from './helpers.js';
import { ACTION_LABELS, can, canPropose, hasRole, permission, type Action } from '../src/permissions.js';
import type { Actor, Role } from '../src/types.js';
import type { ConsoleContext, SiteUser } from '../src/console.js';

const ROLES: Role[] = ['viewer', 'technician', 'supervisor', 'reliability_engineer', 'superintendent', 'admin'];
const ACTIONS = Object.keys(ACTION_LABELS) as Action[];
const full: Actor = { userId: 'ada', role: 'admin', scope: [], fullAccess: true };
const plain: Actor = { userId: 'ada', role: 'admin', scope: [] };

describe('who has full control', () => {
  const on = { ...DEFAULT_ACCESS, testMode: true };
  it('only an Admin, only in test mode, only with no other role picked, only past two-step sign-in', () => {
    expect(adminFull('admin', null, on, true)).toBe(true);
    expect(adminFull('admin', 'admin', on, true)).toBe(true);
    expect(adminFull('admin', null, DEFAULT_ACCESS, true)).toBe(false); // test mode off
    expect(adminFull('admin', 'supervisor', on, true)).toBe(false); // testing as another role
    expect(adminFull('admin', null, { ...on, adminMfa: true }, false)).toBe(false); // code check not passed
    for (const r of ROLES.filter((x) => x !== 'admin')) expect(adminFull(r, null, on, true)).toBe(false);
  });
});

describe('full control passes every role check', () => {
  it('gets the strongest permission any role has for each action, never more', () => {
    for (const a of ACTIONS) {
      const best = ROLES.map((r) => permission(r, a));
      const p = permission(full, a);
      if (best.includes('yes') || best.includes('area')) expect(p, a).toBe('yes');
      else if (best.includes('approve')) expect(p, a).toBe('approve');
      else if (best.every((x) => x === 'no')) expect(p, a).toBe('no');
      if (p === 'yes') expect(can(full, a, 'any-area'), a).toBe(true);
      if (p === 'yes') expect(canPropose(full, a, 'any-area'), a).toBe(true);
    }
  });
  it('is in scope everywhere and counts as every role', () => {
    expect(can(full, 'set_clear_flag', 'Pit 9')).toBe(true);
    expect(can(plain, 'set_clear_flag', 'Pit 9')).toBe(false);
    expect(hasRole(full, 'superintendent')).toBe(true);
    expect(hasRole(plain, 'superintendent')).toBe(false);
  });
  it('without full control the Admin keeps the matrix', () => {
    for (const a of ACTIONS) expect(permission(plain, a)).toBe(permission('admin', a));
  });
});

describe('approvals still run, by one account', () => {
  const NOW = L('2026-10-26 09:00');
  let n = 0;
  const ctx: ConsoleContext = { actor: full, now: NOW, newId: () => `id${++n}`, timeZone: TZ, calendar: cal };
  const users: SiteUser[] = [{ id: 'ada', name: 'Ada', email: 'ada@example.com', role: 'admin', scope: ['*'], addedAt: L('2026-01-01 00:00') }];
  const input = { kpi: 'pa' as const, fleet: 'Haul trucks', value: 0.88, amber: 0.03, from: '2026-11-01', reason: 'Test' };

  it('asks for a target change and approves it, which nobody else may do with their own request', () => {
    const asked = proposeTarget(ctx, [], [], input);
    if (!asked.ok) throw new Error(asked.errors.join());
    const req = asked.records[0]!;
    expect(canDecide(full, 'target')).toBe(true);
    expect(waitingOn(asked.records, 'ada', full)).toEqual([]); // not shown as waiting on themselves
    const ok = decideRequest(ctx, { requests: asked.records, targets: [], users }, req.id, 'approve', 'Testing');
    if (!ok.ok) throw new Error(ok.errors.join());
    expect(ok.records[0]).toMatchObject({ status: 'approved', decidedBy: 'ada' });
    expect(ok.audit.length).toBeGreaterThan(0);

    const asPlain = { ...ctx, actor: { ...full, fullAccess: false, role: 'superintendent' as Role } };
    expect(decideRequest(asPlain, { requests: asked.records, targets: [], users }, req.id, 'approve', '').ok).toBe(false);
  });
});
