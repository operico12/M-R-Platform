// Public API version 1 (phase 4 part 3, docs/public-api.md). Read-only keys for
// other systems: one site per key, scopes, expiry, revoke with a reason, and the
// per-minute limit. Pure functions; the database checks the same rules.

import type { ConsoleContext, ConsoleResult } from './console.js';
import { can } from './permissions.js';
import type { AuditEntry, Iso } from './types.js';

export type ApiScope = 'units' | 'flags' | 'work_orders' | 'smu';

export const API_SCOPES: Record<ApiScope, string> = {
  units: 'Units and their status now',
  flags: 'Down flags with stage and location intervals',
  work_orders: 'Work orders changed since a time',
  smu: 'SMU readings',
};

export const API_LIMITS = { callsPerMinute: 60, defaultDays: 365, maxDays: 730, windowDays: 92, pageMax: 500, prefixLength: 12 } as const;

export interface ApiKeyRecord {
  id: string;
  siteId: string;
  name: string;
  /** The first characters of the key, to tell keys apart. The key itself is never kept. */
  prefix: string;
  scopes: ApiScope[];
  createdAt: Iso;
  createdBy: string;
  expiresAt: Iso;
  revokedAt?: Iso;
  revokedBy?: string;
  revokeReason?: string;
  lastUsedAt?: Iso;
  calls24h?: number;
}

export interface ApiKeyInput {
  name: string;
  scopes: ApiScope[];
  /** Days until it expires. Default 365, at most 730. */
  days?: number;
}

export type ApiKeyStatus = 'active' | 'expired' | 'revoked';

export function apiKeyStatus(k: ApiKeyRecord, now: Iso): ApiKeyStatus {
  if (k.revokedAt) return 'revoked';
  return Date.parse(k.expiresAt) <= Date.parse(now) ? 'expired' : 'active';
}

/** A key is "mrk_" and 64 hex characters, made from random bytes by the caller. */
export const isApiKey = (key: string) => /^mrk_[0-9a-f]{64}$/.test(key);
export const apiKeyFromHex = (hex: string) => `mrk_${hex.toLowerCase()}`;

export function apiKeyProblems(input: ApiKeyInput): string[] {
  const e: string[] = [];
  const name = input.name.trim();
  if (!name || name.length > 80) e.push('Name the system that uses the key (1 to 80 characters).');
  const known = Object.keys(API_SCOPES);
  if (!input.scopes.length) e.push('Choose at least one thing the key can read.');
  if (input.scopes.some((s) => !known.includes(s))) e.push('Unknown scope.');
  const d = input.days ?? API_LIMITS.defaultDays;
  if (!Number.isInteger(d) || d < 1 || d > API_LIMITS.maxDays) e.push(`A key lasts 1 to ${API_LIMITS.maxDays} days.`);
  return e;
}

const refuse = (...errors: string[]): ConsoleResult<ApiKeyRecord> => ({ ok: false, errors });
const log = (ctx: ConsoleContext, action: string, k: ApiKeyRecord, before: unknown, reason?: string): AuditEntry =>
  ({ at: ctx.now, userId: ctx.actor.userId, action, entity: 'api_key', entityId: k.id, before, after: k, reason });

/** A new key for the site. `key` is the full key, shown to the Admin once; only its prefix is kept in the record. */
export function createApiKey(ctx: ConsoleContext, siteId: string, input: ApiKeyInput, key: string): ConsoleResult<ApiKeyRecord> {
  if (!can(ctx.actor, 'manage_api_keys')) return refuse("The site's Admin makes API keys.");
  const e = apiKeyProblems(input);
  if (!isApiKey(key)) e.push('The key was not made correctly.');
  if (e.length) return { ok: false, errors: e };
  const days = input.days ?? API_LIMITS.defaultDays;
  const k: ApiKeyRecord = {
    id: ctx.newId(), siteId, name: input.name.trim(), prefix: key.slice(0, API_LIMITS.prefixLength),
    scopes: [...new Set(input.scopes)].sort() as ApiScope[], createdAt: ctx.now, createdBy: ctx.actor.userId,
    expiresAt: new Date(Date.parse(ctx.now) + days * 86_400_000).toISOString(),
  };
  return { ok: true, records: [k], audit: [log(ctx, 'create_api_key', k, null)], warnings: [] };
}

/** Revoke a key. It stays listed; calls with it are refused from now on. */
export function revokeApiKey(ctx: ConsoleContext, keys: ApiKeyRecord[], id: string, reason: string): ConsoleResult<ApiKeyRecord> {
  if (!can(ctx.actor, 'manage_api_keys')) return refuse("The site's Admin revokes API keys.");
  const k = keys.find((x) => x.id === id);
  if (!k) return refuse('No such key.');
  if (k.revokedAt) return refuse('That key is already revoked.');
  if (!reason.trim()) return refuse('Give a reason.');
  const after: ApiKeyRecord = { ...k, revokedAt: ctx.now, revokedBy: ctx.actor.userId, revokeReason: reason.trim() };
  return { ok: true, records: [after], audit: [log(ctx, 'revoke_api_key', after, k, reason.trim())], warnings: [] };
}

/** Whether one more call fits: fewer than the limit in the minute before `now`. */
export function withinRateLimit(callTimes: Iso[], now: Iso, perMinute: number = API_LIMITS.callsPerMinute): boolean {
  const t = Date.parse(now);
  return callTimes.filter((c) => { const x = Date.parse(c); return x > t - 60_000 && x <= t; }).length < perMinute;
}

/** Problems with a time window for `flags` and `smu`: both times with an offset, to after from, at most 92 days. */
export function apiWindowProblems(from: string | undefined, to: string | undefined): string[] {
  const withOffset = (s?: string) => !!s && /T.*(Z|[+-]\d{2}:?\d{2})$/.test(s) && !Number.isNaN(Date.parse(s));
  if (!withOffset(from) || !withOffset(to)) return ['Give from and to as ISO 8601 times with an offset.'];
  const span = Date.parse(to!) - Date.parse(from!);
  if (span <= 0) return ['to must be after from.'];
  if (span > API_LIMITS.windowDays * 86_400_000) return [`At most ${API_LIMITS.windowDays} days per call.`];
  return [];
}
