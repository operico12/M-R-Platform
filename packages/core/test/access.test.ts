// Access (docs/access.md): who may request an account, the Admin's answer,
// session limits (30 days, a week idle) and turning on two-step sign-in safely.

import { describe, expect, it } from 'vitest';
import { DEFAULT_ACCESS, TEST_ROLES, decideAccessRequest, testedRole, mayTestAs, emailDomain, mayRequest, requestProblems, sessionCheck, setAccessSettings, withAccessDefaults, type AccessRequest } from '../src/access.js';
import type { ConsoleContext } from '../src/console.js';
import type { Role } from '../src/types.js';
import { TZ, actor, cal } from './helpers.js';

const ctx = (role: Role): ConsoleContext => ({ actor: actor(role), now: '2026-10-29T12:00:00.000Z', newId: () => 'x', timeZone: TZ, calendar: cal });

describe('access settings', () => {
  it('defaults to no requests, no forced two-step, 30 days and a week idle', () => {
    expect(withAccessDefaults(undefined)).toEqual({ requestDomains: [], adminMfa: false, sessionDays: 30, idleDays: 7, testMode: false });
  });

  it('is the Admin\'s, cleans domains, and checks the limits', () => {
    expect(setAccessSettings(ctx('superintendent'), DEFAULT_ACCESS, DEFAULT_ACCESS, 'x', true).ok).toBe(false);
    const r = setAccessSettings(ctx('admin'), DEFAULT_ACCESS, { ...DEFAULT_ACCESS, requestDomains: [' @Example-Mining.com ', 'example-mining.com', ''] }, 'Let staff ask', false);
    expect(r.ok && r.records[0]!.requestDomains).toEqual(['example-mining.com']);
    const bad = setAccessSettings(ctx('admin'), DEFAULT_ACCESS, { requestDomains: ['gmail'], adminMfa: false, sessionDays: 31, idleDays: 0, testMode: false }, ' ', false);
    expect(bad.ok || bad.errors).toEqual([
      'Not an email domain: gmail. Use the part after the @, like example-mining.com.',
      'Sign in again after 1 to 30 days.', 'Sign out after 1 to 30 days with no use.', 'Give a reason for the change.',
    ]);
  });

  it('only turns on two-step for Admins when the Admin has passed the code check', () => {
    const on = { ...DEFAULT_ACCESS, adminMfa: true };
    expect(setAccessSettings(ctx('admin'), DEFAULT_ACCESS, on, 'Policy', false).ok).toBe(false);
    expect(setAccessSettings(ctx('admin'), DEFAULT_ACCESS, on, 'Policy', true).ok).toBe(true);
  });
});

describe('test mode (Admin acts as any role)', () => {
  const on = { ...DEFAULT_ACCESS, testMode: true };
  it('is off by default and only the Admin turns it on', () => {
    expect(DEFAULT_ACCESS.testMode).toBe(false);
    expect(setAccessSettings(ctx('superintendent'), DEFAULT_ACCESS, on, 'Testing', false).ok).toBe(false);
    const r = setAccessSettings(ctx('admin'), DEFAULT_ACCESS, on, 'Testing', false);
    expect(r.ok && r.records[0]!.testMode).toBe(true);
    expect(r.ok && r.audit[0]!.after).toMatchObject({ testMode: true });
  });

  it('lets only an Admin pick a role, and only while test mode is on', () => {
    expect(mayTestAs('admin', on)).toBe(true);
    expect(mayTestAs('admin', DEFAULT_ACCESS)).toBe(false);
    for (const r of TEST_ROLES.filter((x) => x !== 'admin')) expect(mayTestAs(r, on)).toBe(false);
    expect(testedRole('admin', 'technician', on, true)).toBe('technician');
    expect(testedRole('admin', 'superintendent', on, true)).toBe('superintendent');
    expect(testedRole('admin', null, on, true)).toBe('admin');
    // Off: the pick is ignored. Not an Admin: the pick is ignored.
    expect(testedRole('admin', 'technician', DEFAULT_ACCESS, true)).toBe('admin');
    expect(testedRole('supervisor', 'superintendent', on, true)).toBe('supervisor');
  });

  it('keeps two-step sign-in first: an Admin who has not passed it stays a Viewer', () => {
    const both = { ...on, adminMfa: true };
    expect(testedRole('admin', 'superintendent', both, false)).toBe('viewer');
    expect(testedRole('admin', 'superintendent', both, true)).toBe('superintendent');
  });
});

describe('requests', () => {
  const s = { ...DEFAULT_ACCESS, requestDomains: ['example-mining.com'] };
  it('lets only listed email domains ask', () => {
    expect(emailDomain(' Ana@Example-Mining.com ')).toBe('example-mining.com');
    expect(mayRequest('ana@example-mining.com', s)).toBe(true);
    expect(mayRequest('ana@mail.example-mining.com', s)).toBe(false);
    expect(mayRequest('ana@gmail.com', s)).toBe(false);
    expect(mayRequest('ana@example-mining.com', DEFAULT_ACCESS)).toBe(false);
    expect(requestProblems({ name: ' ' })).toEqual(['Give your name (1 to 80 characters).']);
  });

  const req: AccessRequest = { id: 'r', siteId: 's', userId: 'u', email: 'ana@example-mining.com', name: 'Ana', status: 'pending', createdAt: '2026-10-29T10:00:00.000Z' };
  it('approves with a requestable role only, and declines with a reason', () => {
    expect(decideAccessRequest(ctx('supervisor'), req, true, 'viewer', '').ok).toBe(false);
    expect(decideAccessRequest(ctx('admin'), req, true, 'admin', '').ok).toBe(false);
    expect(decideAccessRequest(ctx('admin'), req, true, 'superintendent', '').ok).toBe(false);
    const ok = decideAccessRequest(ctx('admin'), req, true, 'technician', '');
    expect(ok.ok && ok.records[0]).toMatchObject({ status: 'approved', role: 'technician' });
    expect(decideAccessRequest(ctx('admin'), req, false, undefined, ' ').ok).toBe(false);
    const no = decideAccessRequest(ctx('admin'), req, false, undefined, 'Not at this site');
    expect(no.ok && no.records[0]).toMatchObject({ status: 'declined', reason: 'Not at this site' });
    expect(decideAccessRequest(ctx('admin'), { ...req, status: 'declined' }, true, 'viewer', '').ok).toBe(false);
  });
});

describe('sessions', () => {
  const now = '2026-10-29T12:00:00.000Z';
  const ago = (days: number) => new Date(Date.parse(now) - days * 86_400_000).toISOString();
  it('asks for a new sign-in after 30 days, or after a week with no use', () => {
    expect(sessionCheck(ago(29), ago(6), now, DEFAULT_ACCESS)).toBe('ok');
    // A 12-hour shift and four days off keep the person signed in.
    expect(sessionCheck(ago(10), ago(4.5), now, DEFAULT_ACCESS)).toBe('ok');
    expect(sessionCheck(ago(31), ago(0), now, DEFAULT_ACCESS)).toBe('too_old');
    expect(sessionCheck(ago(10), ago(8), now, DEFAULT_ACCESS)).toBe('idle');
    expect(sessionCheck(ago(3), ago(1), now, { ...DEFAULT_ACCESS, sessionDays: 2 })).toBe('too_old');
    expect(sessionCheck(undefined, undefined, now, DEFAULT_ACCESS)).toBe('ok');
  });
});
