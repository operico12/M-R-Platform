// Approvals, docs/approvals.md: two people for big changes, nobody approves their own request.

import { describe, expect, it } from 'vitest';
import { addRequestNote, decideRequest, proposeTarget, requestActingRole, requestRole, waitingOn, withdrawRequest, type ApprovalRequest } from '../src/approvals.js';
import { addUser, changeUser, effectiveRole, retireUser, hasSuperintendent, targetValue, type ConsoleContext, type SiteUser, type Target } from '../src/console.js';
import type { Role } from '../src/types.js';
import { L, TZ, cal } from './helpers.js';

const NOW = L('2026-10-26 09:00'); // Monday, day shift 06:00 to 18:00
let n = 0;
const ctx = (role: Role, userId = `u-${role}`, now = NOW): ConsoleContext => ({ actor: { userId, role, scope: ['*'] }, now, newId: () => `id${++n}`, timeZone: TZ, calendar: cal });
const user = (id: string, role: Role, over: Partial<SiteUser> = {}): SiteUser => ({ id, name: id.toUpperCase(), email: `${id}@example.com`, role, scope: ['*'], addedAt: L('2026-01-01 00:00'), ...over });
const USERS = [user('ada', 'admin'), user('sue', 'superintendent', { id: 'u-superintendent' }), user('sam', 'supervisor'), user('rae', 'reliability_engineer', { id: 'u-reliability_engineer' })];
const input = { kpi: 'pa' as const, fleet: 'Haul trucks', value: 0.88, amber: 0.03, from: '2026-11-01', reason: '2027 budget' };

describe('target changes', () => {
  it('a reliability engineer asks; a superintendent who did not ask approves; the target applies', () => {
    expect(proposeTarget(ctx('supervisor'), [], [], input).ok).toBe(false);
    const asked = proposeTarget(ctx('reliability_engineer'), [], [], input);
    if (!asked.ok) throw new Error(asked.errors.join());
    const req = asked.records[0]!;
    expect(req).toMatchObject({ kind: 'target', status: 'pending', title: 'Physical availability target 88.0% for Haul trucks' });
    expect(req.impact[0]).toContain('First Physical availability target');

    const state = { requests: asked.records, targets: [] as Target[], users: USERS };
    expect(decideRequest(ctx('reliability_engineer'), state, req.id, 'approve', '').ok).toBe(false); // not an approver
    expect(decideRequest(ctx('superintendent'), state, req.id, 'reject', ' ').ok).toBe(false); // reject needs a reason
    const ok = decideRequest(ctx('superintendent'), state, req.id, 'approve', 'Agreed at the budget meeting');
    if (!ok.ok) throw new Error(ok.errors.join());
    expect(ok.records[0]).toMatchObject({ status: 'approved', decidedBy: 'u-superintendent' });
    const t = ok.targets!.at(-1)!;
    expect(t).toMatchObject({ value: 0.88, setBy: 'u-reliability_engineer', approvedBy: 'u-superintendent', requestId: req.id, effectiveFrom: L('2026-11-01 00:00') });
    expect(ok.records[0]!.appliedId).toBe(t.id);
    expect(targetValue(ok.targets!, 'pa', { fleet: 'Haul trucks' }, L('2026-11-02 00:00'))).toMatchObject({ value: 0.88, set: true });
    // Decided once only.
    expect(decideRequest(ctx('superintendent'), { ...state, requests: ok.records }, req.id, 'reject', 'x').ok).toBe(false);
  });

  it('nobody approves their own request, superintendents included', () => {
    const asked = proposeTarget(ctx('superintendent'), [], [], input);
    if (!asked.ok) throw new Error();
    const state = { requests: asked.records, targets: [], users: USERS };
    expect(decideRequest(ctx('superintendent'), state, asked.records[0]!.id, 'approve', '')).toMatchObject({ ok: false, errors: ['Nobody approves their own request. Another superintendent needs to decide.'] });
    expect(decideRequest(ctx('superintendent', 'u-other-super'), state, asked.records[0]!.id, 'approve', '').ok).toBe(true);
  });

  it('a start that passed while it waited moves to the next shift', () => {
    const asked = proposeTarget(ctx('reliability_engineer'), [], [], { ...input, from: '2026-10-27' });
    if (!asked.ok) throw new Error();
    const later = ctx('superintendent', 'u-superintendent', L('2026-10-29 10:00'));
    const ok = decideRequest(later, { requests: asked.records, targets: [], users: USERS }, asked.records[0]!.id, 'approve', '');
    if (!ok.ok) throw new Error(ok.errors.join());
    expect(ok.targets![0]!.effectiveFrom).toBe(L('2026-10-29 18:00'));
    expect(ok.warnings[0]).toContain('has passed');
  });

  it('questions and answers stay on the request; only the asker withdraws', () => {
    const asked = proposeTarget(ctx('reliability_engineer'), [], [], input);
    if (!asked.ok) throw new Error();
    const id = asked.records[0]!.id;
    expect(waitingOn(asked.records, 'u-superintendent', 'superintendent').map((r) => r.id)).toEqual([id]);
    expect(addRequestNote(ctx('supervisor'), asked.records, id, 'hi').ok).toBe(false);
    const q = addRequestNote(ctx('superintendent'), asked.records, id, 'What does the plan assume for tyres?');
    if (!q.ok) throw new Error();
    // The question is now waiting on the person who asked.
    expect(waitingOn(q.records, 'u-reliability_engineer', 'reliability_engineer').map((r) => r.id)).toEqual([id]);
    expect(withdrawRequest(ctx('superintendent'), q.records, id, '').ok).toBe(false);
    const w = withdrawRequest(ctx('reliability_engineer'), q.records, id, 'Budget moved');
    expect(w.ok && w.records[0]).toMatchObject({ status: 'withdrawn', notes: [{ text: 'What does the plan assume for tyres?' }] });
  });
});

describe('roles', () => {
  it('once there is a superintendent, Admin and Superintendent grants need approval', () => {
    const admin = ctx('admin', 'ada');
    expect(changeUser(admin, USERS, 'sam', { name: 'SAM', email: 'sam@example.com', role: 'admin', scope: ['*'] }, 'cover').ok).toBe(false);
    expect(addUser(admin, USERS, { name: 'New', email: 'new@example.com', role: 'superintendent', scope: ['*'] }).ok).toBe(false);
    // Other role changes stay direct.
    expect(changeUser(admin, USERS, 'sam', { name: 'SAM', email: 'sam@example.com', role: 'reliability_engineer', scope: ['*'] }, 'moved').ok).toBe(true);

    const asked = requestRole(admin, USERS, [], 'sam', 'admin', 'Second data owner for nights');
    if (!asked.ok) throw new Error(asked.errors.join());
    expect(requestRole(admin, USERS, asked.records, 'sam', 'superintendent', 'x').ok).toBe(false); // one at a time
    const ok = decideRequest(ctx('superintendent'), { requests: asked.records, targets: [], users: USERS }, asked.records[0]!.id, 'approve', '');
    expect(ok.ok && ok.users!.find((u) => u.id === 'sam')!.role).toBe('admin');
  });

  it('the site keeps a superintendent once it has one', () => {
    const admin = ctx('admin', 'ada');
    expect(changeUser(admin, USERS, 'u-superintendent', { name: 'SUE', email: 'sue@example.com', role: 'viewer', scope: ['*'] }, 'x')).toMatchObject({ ok: false, errors: ['The site must keep a superintendent. Give the role to someone else first.'] });
    expect(retireUser(admin, USERS, 'u-superintendent', 'left').ok).toBe(false);
    const two = [...USERS, user('sol', 'superintendent')];
    expect(retireUser(admin, two, 'u-superintendent', 'left').ok).toBe(true);
  });

  it('a new site with no superintendent can give the role directly, with a warning', () => {
    const start = [user('ada', 'admin'), user('sam', 'supervisor')];
    expect(hasSuperintendent(start, NOW)).toBe(false);
    const r = changeUser(ctx('admin', 'ada'), start, 'sam', { name: 'SAM', email: 'sam@example.com', role: 'superintendent', scope: ['*'] }, 'First superintendent');
    expect(r.ok && r.warnings[0]).toContain('No superintendent at this site yet');
    expect(r.ok && r.audit[0]!.reason).toContain('without approval');
  });

  it('an acting role lasts to the end of its last day, site time, then goes back', () => {
    const asked = requestActingRole(ctx('admin', 'ada'), USERS, [], 'u-reliability_engineer', 'superintendent', '2026-11-06', 'Covers Sue on leave');
    if (!asked.ok) throw new Error(asked.errors.join());
    expect(requestActingRole(ctx('admin', 'ada'), USERS, [], 'u-reliability_engineer', 'superintendent', '2027-03-01', 'x').ok).toBe(false); // over three months
    expect(requestActingRole(ctx('admin', 'ada'), USERS, [], 'u-reliability_engineer', 'superintendent', '2026-10-20', 'x').ok).toBe(false); // in the past
    const ok = decideRequest(ctx('superintendent'), { requests: asked.records, targets: [], users: USERS }, asked.records[0]!.id, 'approve', '');
    if (!ok.ok) throw new Error(ok.errors.join());
    const rae = ok.users!.find((u) => u.id === 'u-reliability_engineer')!;
    expect(rae.actingUntil).toBe(L('2026-11-07 00:00'));
    expect(effectiveRole(rae, L('2026-11-06 23:59'))).toBe('superintendent');
    expect(effectiveRole(rae, L('2026-11-07 00:00'))).toBe('reliability_engineer');
  });
});

it('every step is in the audit log', () => {
  const a = proposeTarget(ctx('reliability_engineer'), [], [] as ApprovalRequest[], input);
  if (!a.ok) throw new Error();
  const d = decideRequest(ctx('superintendent'), { requests: a.records, targets: [], users: USERS }, a.records[0]!.id, 'approve', '');
  expect([...a.audit, ...(d.ok ? d.audit : [])].map((x) => `${x.entity}:${x.action}`)).toEqual(['approval:request_target', 'approval:approve', 'target:set_target']);
});
