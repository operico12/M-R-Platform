// Flag history (docs/flag-history.md): where one flag's time went, and what changed on it. Worked by hand.

import { describe, expect, it } from 'vitest';
import type { AuditRecord } from '../src/audit.js';
import { flagAuditRange, flagBreakdown, flagChanges } from '../src/flag-history.js';
import type { DownFlag } from '../src/types.js';
import type { WaitTag } from '../src/waits.js';
import { L, LINES, fixtureFlag } from './helpers.js';

const st = (stage: DownFlag['stages'][number]['stage'], a: string, b: string | null, by = 'tia') => ({ stage, start: L(a), end: b ? L(b) : null, setBy: by, enteredAt: L(a) });
const lo = (kind: DownFlag['locations'][number]['kind'], a: string, b: string | null, extra: Partial<DownFlag['locations'][number]> = {}) => ({ kind, start: L(a), end: b ? L(b) : null, setBy: 'sam', enteredAt: L(a), ...extra });

// 10 h down, 08:00 to 18:00.
const flag = fixtureFlag({
  id: 'f1', unitId: 'ht1', type: 'unscheduled', start: L('2026-10-26 08:00'), end: L('2026-10-26 18:00'),
  stages: [
    st('waiting_crew', '2026-10-26 08:00', '2026-10-26 08:30'), st('in_transit', '2026-10-26 08:30', '2026-10-26 10:00'),
    st('waiting_line', '2026-10-26 10:00', '2026-10-26 11:00'), st('in_repair', '2026-10-26 11:00', '2026-10-26 13:00'),
    st('waiting_parts', '2026-10-26 13:00', '2026-10-26 16:00'), st('in_repair', '2026-10-26 16:00', '2026-10-26 18:00'),
  ],
  locations: [
    lo('field', '2026-10-26 08:00', '2026-10-26 09:00', { fieldLocation: 'Pit North' }), lo('towing', '2026-10-26 09:00', '2026-10-26 10:00'),
    lo('shop_yard', '2026-10-26 10:00', '2026-10-26 11:00'), lo('shop_line', '2026-10-26 11:00', '2026-10-26 14:00', { shopLineId: 'L6' }),
    lo('shop_line', '2026-10-26 14:00', '2026-10-26 18:00', { shopLineId: 'L1' }),
  ],
});
const wait = (id: string, kind: string, a: string, b: string | null, state: WaitTag['state'] = 'ended'): WaitTag => ({
  id, tenantId: 't1', siteId: 's1', unitId: 'ht1', downFlagId: 'f1', kind, start: L(a), end: b ? L(b) : null, state, setBy: 'x', enteredAt: L(a),
});
const waits = [wait('w1', 'PARTS', '2026-10-26 12:30', '2026-10-26 16:00'), wait('w2', 'LABOUR', '2026-10-26 13:00', '2026-10-26 17:00'), wait('w3', 'TOW', '2026-10-26 08:00', '2026-10-26 09:00', 'voided'),
  { ...wait('w4', 'PARTS', '2026-10-25 08:00', '2026-10-25 09:00'), downFlagId: 'other' }];
const NOW = L('2026-10-27 09:00');

describe('flagBreakdown', () => {
  const b = flagBreakdown(flag, waits, LINES, NOW);

  it('splits the down time into In repair and not', () => {
    expect(b.downHours).toBe(10);
    expect(b.inRepairHours).toBe(4);
    expect(b.notInRepairHours).toBe(6);
    expect(b.byStage.find((x) => x.stage === 'waiting_parts')!.hours).toBe(3);
    expect(b.byStage.find((x) => x.stage === 'in_repair')!.label).toBe('In repair');
  });

  it('sums the stay on each line and each kind of location', () => {
    expect(b.byLine.map((x) => [x.label, x.hours])).toEqual([['Line 1', 4], ['Line 6', 3]]);
    expect(Object.fromEntries(b.byLocationKind.map((x) => [x.kind, x.hours]))).toEqual({ shop_line: 7, field: 1, towing: 1, shop_yard: 1 });
  });

  it('times each wait, with overlap counted once, and ignores voided tags and other flags', () => {
    expect(Object.fromEntries(b.byWait.map((x) => [x.kind, x.hours]))).toEqual({ LABOUR: 4, PARTS: 3.5 });
    expect(b.waitingOnSomethingHours).toBe(4.5); // 12:30 to 17:00
  });

  it('measures time to first wrench, and leaves it out for a flag that continues another', () => {
    expect(b.firstWrenchHours).toBe(3);
    expect(flagBreakdown({ ...flag, linkedFromFlagId: 'earlier', linkKind: 'type_switch' }, waits, LINES, NOW).firstWrenchHours).toBeNull();
    expect(flagBreakdown({ ...flag, stages: flag.stages.slice(0, 3) }, waits, LINES, NOW).firstWrenchHours).toBeNull();
  });

  it('lists the moves and stages in order with who made each', () => {
    expect(b.moves.map((m) => [m.label, m.hours])).toEqual([['Down in field: Pit North', 1], ['Towing', 1], ['Shop yard', 1], ['Line 6', 3], ['Line 1', 4]]);
    expect(b.moves[3]!.by).toBe('sam');
    expect(b.stages.map((s) => s.label)).toEqual(['Waiting for crew', 'In transit', 'Waiting for a line', 'In repair', 'Waiting parts', 'In repair']);
  });

  it('runs an open flag to now', () => {
    const open: DownFlag = { ...flag, end: null, state: 'open', stages: [st('in_repair', '2026-10-26 08:00', null)], locations: [lo('shop_line', '2026-10-26 08:00', null, { shopLineId: 'L1' })] };
    const o = flagBreakdown(open, [], LINES, L('2026-10-26 20:00'));
    expect(o.downHours).toBe(12);
    expect(o.inRepairHours).toBe(12);
    expect(o.byLine[0]!.hours).toBe(12);
  });
});

describe('flagChanges', () => {
  const rec = (at: string, action: string, before: Partial<DownFlag> | null, after: Partial<DownFlag>, over: Partial<AuditRecord> = {}): AuditRecord => ({
    at: L(at), userId: 'sam', action, entity: 'down_flag', entityId: 'f1', before, after, ...over,
  });
  const base = { id: 'f1', type: 'unscheduled', state: 'open', reasonCode: 'ENG', workOrders: [], stages: [], locations: [], etas: [] } as unknown as DownFlag;
  const audit: AuditRecord[] = [
    rec('2026-10-26 08:05', 'flag_down', null, base),
    rec('2026-10-26 09:00', 'set_eta', base, { ...base, etas: [{ eta: L('2026-10-26 17:00'), setAt: L('2026-10-26 09:00'), setBy: 'sam' }] }),
    rec('2026-10-26 12:00', 'move_location', base, { ...base, locations: [lo('shop_line', '2026-10-26 12:00', null)] }), // no tracked field changes
    rec('2026-10-26 18:00', 'release', { ...base, etas: [{ eta: L('2026-10-26 17:00'), setAt: L('2026-10-26 09:00'), setBy: 'sam' }] },
      { ...base, state: 'released', release: { system: 'Engine', component: 'Turbo', failureModes: ['Leak', 'Worn'], repairSummary: 'Replaced turbo', workOrder: 'WO-1' }, workOrders: ['WO-1'], etas: [{ eta: L('2026-10-26 17:00'), setAt: L('2026-10-26 09:00'), setBy: 'sam' }] },
      { reason: 'Test run clean', effectiveAt: L('2026-10-26 17:45') }),
    { ...rec('2026-10-26 08:05', 'insert', null, base), entity: 'down_flags' },
    { ...rec('2026-10-26 10:00', 'set_eta', base, { ...base, reasonCode: 'ZZZ' }), entityId: 'other' },
  ];
  const c = flagChanges(audit, 'f1');

  it('lists what the flag was raised with, then each change with who, when and why', () => {
    expect(c.filter((x) => x.action === 'flag_down').map((x) => [x.label, x.before, x.after])).toEqual([['Type', '', 'unscheduled'], ['Reason', '', 'ENG'], ['State', '', 'open']]);
    expect(c.find((x) => x.action === 'set_eta')).toMatchObject({ label: 'ETA', before: '', userId: 'sam' });
  });

  it('shows release details field by field with the reason and the back-dated time', () => {
    const rel = c.filter((x) => x.action === 'release');
    expect(rel.map((x) => x.label)).toEqual(expect.arrayContaining(['State', 'System (release)', 'Component', 'Failure modes', 'Repair summary', 'Work order', 'Work orders']));
    expect(rel.find((x) => x.label === 'Failure modes')).toMatchObject({ before: '', after: 'Leak, Worn', reason: 'Test run clean', effectiveAt: L('2026-10-26 17:45') });
  });

  it('leaves out moves and stage changes, the database row changes, and other flags', () => {
    expect(c.some((x) => x.action === 'move_location')).toBe(false);
    expect(c.some((x) => x.action === 'insert')).toBe(false);
    expect(c.some((x) => x.after === 'ZZZ')).toBe(false);
  });

  it('is in time order', () => {
    expect(c.map((x) => Date.parse(x.at))).toEqual([...c.map((x) => Date.parse(x.at))].sort((a, b) => a - b));
  });
});

describe('flagAuditRange', () => {
  it('covers the flag with a day before and two after', () => {
    const r = flagAuditRange({ start: L('2026-10-26 08:00'), end: L('2026-10-26 18:00') }, NOW);
    expect(Date.parse(r.from)).toBe(Date.parse(L('2026-10-25 08:00')));
    expect(Date.parse(r.to)).toBe(Date.parse(L('2026-10-28 18:00')));
  });
});
