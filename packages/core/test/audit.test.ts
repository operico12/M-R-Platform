// Audit log page helpers (plan 11.4).

import { describe, expect, it } from 'vitest';
import { EMPTY_AUDIT_FILTER, auditCsv, auditDiff, filterAudit, type AuditRecord } from '../src/audit.js';
import { permission } from '../src/permissions.js';
import { L, TZ } from './helpers.js';

const rows: AuditRecord[] = [
  { at: L('2026-10-26 07:00'), userId: 'u1', action: 'set_target', entity: 'target', entityId: 't1', before: null, after: { value: 0.9 }, reason: 'New plan' },
  { at: L('2026-10-26 07:00'), userId: 'u1', action: 'insert', entity: 'targets', entityId: 't1', before: null, after: { target: 0.9, updated_at: 'x' } },
  { at: L('2026-10-27 23:30'), userId: 'u2', action: 'release', entity: 'down_flag', entityId: 'f9', before: { state: 'open', end: null }, after: { state: 'released', end: L('2026-10-27 23:00') }, effectiveAt: L('2026-10-27 23:00') },
  { at: L('2026-10-28 00:30'), userId: 'u2', action: 'update', entity: 'down_flags', entityId: 'f9', before: { state: 'open', updated_at: 'a' }, after: { state: 'released', updated_at: 'b' } },
];

describe('audit log page', () => {
  it('only superintendents and admins read the full log', () => {
    expect(['viewer', 'technician', 'supervisor', 'reliability_engineer'].map((r) => permission(r as never, 'view_audit_log'))).toEqual(['no', 'no', 'no', 'no']);
    expect(permission('superintendent', 'view_audit_log')).toBe('yes');
    expect(permission('admin', 'view_audit_log')).toBe('yes');
  });

  it('filters by site-local day, record type, person, text, and app entries only', () => {
    const f = (x: Partial<typeof EMPTY_AUDIT_FILTER>) => filterAudit(rows, { ...EMPTY_AUDIT_FILTER, ...x }, TZ).map((r) => `${r.entity}:${r.action}`);
    // 27 Oct site time: 23:30 is in; 00:30 on the 28th is not, though it is the 28th in UTC either way.
    expect(f({ from: '2026-10-27', to: '2026-10-27' })).toEqual(['down_flag:release']);
    // An app entry and its database row share a label, so they filter together. Newest first.
    expect(f({ entities: ['Down flag'] })).toEqual(['down_flags:update', 'down_flag:release']);
    expect(f({ users: ['u1'], appOnly: true })).toEqual(['target:set_target']);
    expect(f({ text: 'new plan' })).toEqual(['target:set_target']);
  });

  it('lists the fields that changed, without bookkeeping columns', () => {
    expect(auditDiff(rows[3]!.before, rows[3]!.after)).toEqual([{ field: 'state', before: 'open', after: 'released' }]);
    expect(auditDiff(null, { a: 1, b: [1] })).toEqual([{ field: 'a', before: undefined, after: 1 }, { field: 'b', before: undefined, after: [1] }]);
    expect(auditDiff('x', 'y')).toEqual([{ field: 'value', before: 'x', after: 'y' }]);
  });

  it('exports CSV in site time, with names and the changes spelled out', () => {
    const csv = auditCsv([rows[2]!], TZ, (id) => (id === 'u2' ? 'Sam, Supervisor' : id)).split('\n');
    expect(csv[0]).toBe('entered_at_site_time,effective_at_site_time,user,action,record_type,record_id,reason,changes');
    expect(csv[1]).toBe(`2026-10-27 23:30:00,2026-10-27 23:00:00,"Sam, Supervisor",release,Down flag,f9,,state: open → released; end:  → ${L('2026-10-27 23:00')}`);
  });
});
