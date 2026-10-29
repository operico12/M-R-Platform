// Public API keys (docs/public-api.md): who makes them, expiry, revoke with a
// reason, the per-minute limit and the time window.

import { describe, expect, it } from 'vitest';
import { apiKeyFromHex, apiKeyStatus, apiWindowProblems, createApiKey, isApiKey, revokeApiKey, withinRateLimit } from '../src/api.js';
import type { ConsoleContext } from '../src/console.js';
import type { Role } from '../src/types.js';
import { TZ, actor, cal } from './helpers.js';

const ctx = (role: Role, now = '2026-10-29T12:00:00.000Z'): ConsoleContext => ({ actor: actor(role), now, newId: () => 'k1', timeZone: TZ, calendar: cal });
const KEY = apiKeyFromHex('ab'.repeat(32));

describe('API keys', () => {
  it('only the Admin makes one; it keeps the prefix, not the key, and expires in 365 days by default', () => {
    expect(createApiKey(ctx('superintendent'), 's', { name: 'Dashboard', scopes: ['units'] }, KEY).ok).toBe(false);
    const r = createApiKey(ctx('admin'), 's', { name: ' Dashboard ', scopes: ['flags', 'units', 'flags'] }, KEY);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const k = r.records[0]!;
    expect(k).toMatchObject({ name: 'Dashboard', prefix: 'mrk_abababab', scopes: ['flags', 'units'], expiresAt: '2027-10-29T12:00:00.000Z' });
    expect(JSON.stringify(k)).not.toContain(KEY);
    expect(JSON.stringify(r.audit)).not.toContain(KEY);
    expect(r.audit[0]).toMatchObject({ action: 'create_api_key', entity: 'api_key' });
    expect(apiKeyStatus(k, '2027-10-29T11:59:59.000Z')).toBe('active');
    expect(apiKeyStatus(k, '2027-10-29T12:00:00.000Z')).toBe('expired');
  });

  it('refuses no name, no scope, a bad length and a badly made key', () => {
    const r = createApiKey(ctx('admin'), 's', { name: ' ', scopes: [], days: 731 }, 'mrk_123');
    expect(r.ok || r.errors).toEqual([
      'Name the system that uses the key (1 to 80 characters).', 'Choose at least one thing the key can read.', 'A key lasts 1 to 730 days.', 'The key was not made correctly.',
    ]);
    expect(isApiKey(KEY)).toBe(true);
    expect(isApiKey(KEY.toUpperCase())).toBe(false);
  });

  it('revokes with a reason, once, and keeps the record', () => {
    const made = createApiKey(ctx('admin'), 's', { name: 'Warehouse', scopes: ['smu'], days: 30 }, KEY);
    if (!made.ok) throw new Error('not made');
    const k = made.records[0]!;
    expect(revokeApiKey(ctx('admin'), [k], 'k1', ' ').ok).toBe(false);
    expect(revokeApiKey(ctx('reliability_engineer'), [k], 'k1', 'Leaked').ok).toBe(false);
    const r = revokeApiKey(ctx('admin', '2026-11-01T00:00:00.000Z'), [k], 'k1', 'Leaked');
    expect(r.ok && r.records[0]).toMatchObject({ revokedAt: '2026-11-01T00:00:00.000Z', revokeReason: 'Leaked' });
    if (!r.ok) return;
    expect(apiKeyStatus(r.records[0]!, '2026-11-01T00:00:00.000Z')).toBe('revoked');
    expect(revokeApiKey(ctx('admin'), r.records, 'k1', 'Again').ok).toBe(false);
  });
});

describe('API limits', () => {
  it('allows 60 calls in a rolling minute', () => {
    const now = '2026-10-29T12:01:00.000Z';
    const calls = Array.from({ length: 60 }, (_, i) => new Date(Date.parse(now) - 59_000 + i * 900).toISOString());
    expect(withinRateLimit(calls.slice(1), now)).toBe(true);
    expect(withinRateLimit(calls, now)).toBe(false);
    // A call exactly a minute ago has dropped out.
    expect(withinRateLimit([...calls.slice(1), '2026-10-29T12:00:00.000Z'], now)).toBe(true);
  });

  it('checks the time window', () => {
    expect(apiWindowProblems('2026-10-01T00:00:00Z', '2026-10-08T00:00:00-07:00')).toEqual([]);
    expect(apiWindowProblems('2026-10-01T00:00:00', '2026-10-08T00:00:00Z')).toEqual(['Give from and to as ISO 8601 times with an offset.']);
    expect(apiWindowProblems('2026-10-08T00:00:00Z', '2026-10-01T00:00:00Z')).toEqual(['to must be after from.']);
    expect(apiWindowProblems('2026-01-01T00:00:00Z', '2026-04-03T00:00:01Z')).toEqual(['At most 92 days per call.']);
  });
});
