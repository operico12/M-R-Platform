// Console rules (plan 11.4, 11.5, 11.7): effective-dated targets, users and
// reason codes; deny by default; nothing deleted.

import { describe, expect, it } from 'vitest';
import { addCode, addUser, changeUser, defaultReasonCodes, editCode, rag, retireCode, retireUser, setTarget, targetFor, targetValue, type ConsoleContext, type SiteUser, type Target } from '../src/console.js';
import { permissionsFor } from '../src/permissions.js';
import { local, twelveHourCalendar } from '../src/time.js';
import type { Role } from '../src/types.js';
import { TZ } from './helpers.js';

let n = 0;
const ctx = (role: Role, userId = `u-${role}`): ConsoleContext => ({
  actor: { userId, role, scope: ['*'] }, now: local(TZ, '2026-10-26 09:00'), newId: () => `id-${++n}`, timeZone: TZ, calendar: twelveHourCalendar(TZ),
});

describe('targets', () => {
  const input = { kpi: 'pa' as const, value: 0.92, amber: 0.02, from: '2026-11-01', reason: 'New fleet plan' };

  it('only the reliability engineer or superintendent can set one', () => {
    for (const r of ['viewer', 'supervisor', 'admin'] as Role[]) expect(setTarget(ctx(r), [], input).ok).toBe(false);
    expect(setTarget(ctx('reliability_engineer'), [], input).ok).toBe(true);
  });

  it('applies from a future date and never rewrites the past', () => {
    expect(setTarget(ctx('reliability_engineer'), [], { ...input, from: '2026-10-01' }).ok).toBe(false);
    const r = setTarget(ctx('reliability_engineer'), [], input);
    if (!r.ok) throw new Error(r.errors.join());
    const t = r.records;
    expect(targetFor(t, 'pa', {}, local(TZ, '2026-10-31 23:59'))).toBeUndefined();
    expect(targetFor(t, 'pa', {}, local(TZ, '2026-11-01 00:00'))?.value).toBe(0.92);
    expect(targetValue(t, 'pa', {}, local(TZ, '2026-10-30 12:00'))).toEqual({ value: 0.9, amber: 0.03, set: false });
  });

  it('"next shift" starts at the next shift change in site time', () => {
    const r = setTarget(ctx('reliability_engineer'), [], { ...input, from: 'next_shift' });
    expect(r.ok && r.records[0]!.effectiveFrom).toBe(local(TZ, '2026-10-26 18:00'));
  });

  it('a model target beats a fleet target, which beats a site target', () => {
    const base = { setBy: 'x', setAt: local(TZ, '2026-01-01 00:00'), reason: 'r', amber: 0.03, effectiveFrom: local(TZ, '2026-01-01 00:00') };
    const t: Target[] = [
      { ...base, id: '1', kpi: 'pa', value: 0.9 },
      { ...base, id: '2', kpi: 'pa', fleet: 'Haul trucks', value: 0.88 },
      { ...base, id: '3', kpi: 'pa', fleet: 'Haul trucks', model: '797F', value: 0.86 },
    ];
    const at = local(TZ, '2026-06-01 00:00');
    expect(targetFor(t, 'pa', { fleet: 'Haul trucks', model: '797F' }, at)?.value).toBe(0.86);
    expect(targetFor(t, 'pa', { fleet: 'Haul trucks', model: '793F' }, at)?.value).toBe(0.88);
    expect(targetFor(t, 'pa', { fleet: 'Loaders' }, at)?.value).toBe(0.9);
  });

  it('colours by direction: higher is better for PA, lower for MTTR', () => {
    expect(rag('pa', 0.89, { value: 0.9, amber: 0.03 })).toBe('amber');
    expect(rag('pa', 0.85, { value: 0.9, amber: 0.03 })).toBe('red');
    expect(rag('mttr', 4, { value: 5, amber: 1 })).toBe('green');
    expect(rag('mttr', 5.5, { value: 5, amber: 1 })).toBe('amber');
  });
});

describe('users', () => {
  const admin = ctx('admin', 'a1');
  const seed: SiteUser[] = [{ id: 'a1', name: 'Admin', email: 'admin@example.com', role: 'admin', scope: ['*'], addedAt: admin.now }];

  it('only the Admin manages users, and only the four phase 1a roles', () => {
    const u = { name: 'Sam', email: 'sam@example.com', role: 'supervisor' as Role, scope: ['Truck shop'] };
    expect(addUser(ctx('reliability_engineer'), seed, u).ok).toBe(false);
    expect(addUser(admin, seed, { ...u, role: 'technician' }).ok).toBe(false);
    expect(addUser(admin, seed, { ...u, email: 'ADMIN@example.com' }).ok).toBe(false);
    const r = addUser(admin, seed, u);
    expect(r.ok && r.audit[0]!.action).toBe('add_user');
  });

  it('keeps at least one Admin, and nobody removes their own access', () => {
    expect(changeUser(admin, seed, 'a1', { name: 'Admin', email: 'admin@example.com', role: 'viewer', scope: ['*'] }, 'demote').ok).toBe(false);
    expect(retireUser(admin, seed, 'a1', 'left').ok).toBe(false);
  });

  it('retiring keeps the user record', () => {
    const r = addUser(admin, seed, { name: 'Sam', email: 'sam@example.com', role: 'viewer', scope: ['*'] });
    if (!r.ok) throw new Error();
    const sam = r.records[1]!;
    const q = retireUser(admin, r.records, sam.id, 'Left the site');
    expect(q.ok && q.records.find((u) => u.id === sam.id)?.retiredAt).toBe(admin.now);
  });

  it('lists what a role can do from the matrix', () => {
    expect(permissionsFor('viewer').map((p) => p.action)).toEqual(['view_status']);
    expect(permissionsFor('admin').some((p) => p.action === 'manage_users')).toBe(true);
  });
});

describe('reason codes', () => {
  const codes = defaultReasonCodes();
  it('Admin edits codes; the reliability engineer is told proposals come later', () => {
    const r = addCode(ctx('reliability_engineer'), codes, { code: 'GET', label: 'Ground engaging tools', appliesTo: 'unscheduled' });
    expect(!r.ok && r.errors[0]).toMatch(/propose/);
    expect(addCode(ctx('admin'), codes, { code: 'GET', label: 'Ground engaging tools', appliesTo: 'unscheduled' }).ok).toBe(true);
  });

  it('retires instead of deleting, and a retired code cannot be reused', () => {
    const id = codes[0]!.id;
    const r = retireCode(ctx('admin'), codes, id, 'Merged into Engine');
    if (!r.ok) throw new Error(r.errors.join());
    expect(r.records).toHaveLength(codes.length);
    expect(addCode(ctx('admin'), r.records, { code: codes[0]!.code, label: 'Other', appliesTo: 'unscheduled' }).ok).toBe(false);
    expect(editCode(ctx('admin'), r.records, id, { label: 'x', appliesTo: 'unscheduled' }, 'why').ok).toBe(false);
  });
});
