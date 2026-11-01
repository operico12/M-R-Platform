// Access (docs/access.md): account requests by email domain, session limits and
// two-step sign-in for Admins. Pure functions; the database checks the same rules.

import type { ConsoleContext, ConsoleResult } from './console.js';
import { can } from './permissions.js';
import type { AuditEntry, Iso, Role } from './types.js';

export interface AccessSettings {
  /** Email domains that may ask this site for an account, e.g. "example-mining.com". Empty: no requests. */
  requestDomains: string[];
  /** Admins act as Viewers until they pass the authenticator code check. */
  adminMfa: boolean;
  /** Sign in again after this many days (1 to 30). */
  sessionDays: number;
  /** Signed out after this many days with no use on a device (1 to 30). */
  idleDays: number;
  /** Development only: an Admin may act as any role, straight away (docs/access.md section 4). */
  testMode: boolean;
}

export const DEFAULT_ACCESS: AccessSettings = { requestDomains: [], adminMfa: false, sessionDays: 30, idleDays: 7, testMode: false };
export const ACCESS_LIMITS = { maxSessionDays: 30, maxIdleDays: 30, requestsPerDay: 3, nameMax: 80, noteMax: 300 } as const;

/** Roles an Admin can give by approving a request. Superintendent and Admin go through approvals. */
export const REQUESTABLE_ROLES: Role[] = ['viewer', 'technician', 'supervisor', 'reliability_engineer'];

export const withAccessDefaults = (v?: Partial<AccessSettings> | null): AccessSettings => ({ ...DEFAULT_ACCESS, ...(v ?? {}) });

export const emailDomain = (email: string) => {
  const at = email.trim().toLowerCase().lastIndexOf('@');
  return at < 0 ? '' : email.trim().toLowerCase().slice(at + 1);
};

const DOMAIN = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
export const isDomain = (d: string) => DOMAIN.test(d);

/** Whether a person with this email may ask the site for an account. */
export const mayRequest = (email: string, s: AccessSettings) => {
  const d = emailDomain(email);
  return !!d && s.requestDomains.includes(d);
};

export function setAccessSettings(ctx: ConsoleContext, current: AccessSettings, next: AccessSettings, reason: string, mfaPassed: boolean): ConsoleResult<AccessSettings> {
  if (!can(ctx.actor, 'manage_access')) return { ok: false, errors: ["The site's Admin sets who can sign in and how."] };
  const e: string[] = [];
  const domains = [...new Set(next.requestDomains.map((d) => d.trim().toLowerCase().replace(/^@/, '')).filter(Boolean))].sort();
  const bad = domains.filter((d) => !isDomain(d));
  if (bad.length) e.push(`Not an email domain: ${bad.join(', ')}. Use the part after the @, like example-mining.com.`);
  if (domains.length > 10) e.push('At most 10 email domains.');
  if (!Number.isInteger(next.sessionDays) || next.sessionDays < 1 || next.sessionDays > ACCESS_LIMITS.maxSessionDays) e.push(`Sign in again after 1 to ${ACCESS_LIMITS.maxSessionDays} days.`);
  if (!Number.isInteger(next.idleDays) || next.idleDays < 1 || next.idleDays > ACCESS_LIMITS.maxIdleDays) e.push(`Sign out after 1 to ${ACCESS_LIMITS.maxIdleDays} days with no use.`);
  if (next.adminMfa && !current.adminMfa && !mfaPassed) e.push('Turn on two-step sign-in for yourself and pass the code check first, so you are not locked out.');
  if (!reason.trim()) e.push('Give a reason for the change.');
  if (e.length) return { ok: false, errors: e };
  const clean: AccessSettings = { requestDomains: domains, adminMfa: !!next.adminMfa, sessionDays: next.sessionDays, idleDays: next.idleDays, testMode: !!next.testMode };
  const audit: AuditEntry = { at: ctx.now, userId: ctx.actor.userId, action: 'set_access', entity: 'settings', entityId: 'access', before: current, after: clean, reason: reason.trim() };
  return { ok: true, records: [clean], audit: [audit], warnings: [] };
}

// ---------- test mode (docs/access.md section 4) ----------

/** Roles an Admin can test as. Admin itself means "back to my own role". */
export const TEST_ROLES: Role[] = ['viewer', 'technician', 'supervisor', 'reliability_engineer', 'superintendent', 'admin'];

/** Whether this person may use the "Testing as" picker: their own role is Admin and test mode is on. */
export const mayTestAs = (ownRole: Role, s: AccessSettings) => ownRole === 'admin' && s.testMode;

/**
 * The role the app and the database use. Mirrors site_role(): an Admin who must pass two-step
 * sign-in and has not acts as a Viewer first; then, with test mode on, the picked test role.
 */
export function testedRole(ownRole: Role, testRole: Role | null | undefined, s: AccessSettings, mfaPassed: boolean): Role {
  if (ownRole === 'admin' && s.adminMfa && !mfaPassed) return 'viewer';
  if (mayTestAs(ownRole, s) && testRole && TEST_ROLES.includes(testRole)) return testRole;
  return ownRole;
}

/**
 * Admin full control (docs/access.md section 4). Mirrors admin_full(): own role Admin (after the
 * two-step check), test mode on, and no other role picked. The app sets Actor.fullAccess from it.
 */
export function adminFull(ownRole: Role, testRole: Role | null | undefined, s: AccessSettings, mfaPassed: boolean): boolean {
  return testedRole(ownRole, testRole, s, mfaPassed) === 'admin' && mayTestAs(ownRole, s);
}

// ---------- sessions ----------

export type SessionCheck = 'ok' | 'too_old' | 'idle';

/** Whether this device's sign-in still stands. `lastActiveAt` is the last use on this device. */
export function sessionCheck(signedInAt: Iso | undefined, lastActiveAt: Iso | undefined, now: Iso, s: AccessSettings): SessionCheck {
  const t = Date.parse(now);
  const day = 86_400_000;
  if (signedInAt && t - Date.parse(signedInAt) > Math.min(s.sessionDays, ACCESS_LIMITS.maxSessionDays) * day) return 'too_old';
  if (lastActiveAt && t - Date.parse(lastActiveAt) > s.idleDays * day) return 'idle';
  return 'ok';
}

// ---------- requests ----------

export type AccessRequestStatus = 'pending' | 'approved' | 'declined' | 'withdrawn';

export interface AccessRequest {
  id: string;
  siteId: string;
  userId: string;
  email: string;
  name: string;
  note?: string;
  status: AccessRequestStatus;
  createdAt: Iso;
  role?: Role;
  decidedBy?: string;
  decidedAt?: Iso;
  reason?: string;
}

export interface RequestInput { name: string; note?: string }

export function requestProblems(input: RequestInput): string[] {
  const e: string[] = [];
  const name = input.name.trim();
  if (!name || name.length > ACCESS_LIMITS.nameMax) e.push(`Give your name (1 to ${ACCESS_LIMITS.nameMax} characters).`);
  if ((input.note ?? '').trim().length > ACCESS_LIMITS.noteMax) e.push(`The note is up to ${ACCESS_LIMITS.noteMax} characters.`);
  return e;
}

/** The Admin's answer to a request. Approving gives one of the requestable roles; declining needs a reason. */
export function decideAccessRequest(ctx: ConsoleContext, req: AccessRequest, approve: boolean, role: Role | undefined, reason: string): ConsoleResult<AccessRequest> {
  if (!can(ctx.actor, 'manage_access')) return { ok: false, errors: ["The site's Admin answers account requests."] };
  if (req.status !== 'pending') return { ok: false, errors: ['That request has already been answered.'] };
  if (approve && (!role || !REQUESTABLE_ROLES.includes(role))) return { ok: false, errors: ['Approve as Viewer, Technician, Supervisor or Reliability engineer. Higher roles go through a role change with approval.'] };
  if (!approve && !reason.trim()) return { ok: false, errors: ['Give the person a reason for declining.'] };
  const after: AccessRequest = {
    ...req, status: approve ? 'approved' : 'declined', decidedBy: ctx.actor.userId, decidedAt: ctx.now,
    ...(approve ? { role } : {}), ...(reason.trim() ? { reason: reason.trim() } : {}),
  };
  const audit: AuditEntry = { at: ctx.now, userId: ctx.actor.userId, action: approve ? 'approve_access' : 'decline_access', entity: 'user', entityId: req.userId, before: req, after, reason: reason.trim() || undefined };
  return { ok: true, records: [after], audit: [audit], warnings: [] };
}
