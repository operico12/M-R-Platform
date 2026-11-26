// Down list (docs/down-list.md): one row per unit with an open down flag. Worked by hand.

import { describe, expect, it } from 'vitest';
import type { FlagComment } from '../src/comments.js';
import { EMPTY_DOWN_FILTER, downList, downListCsv, filterDownList, sortDownList } from '../src/down-list.js';
import type { DownFlag } from '../src/types.js';
import type { WaitTag } from '../src/waits.js';
import { L, LINES, fixtureFlag, truck } from './helpers.js';

const NOW = L('2026-10-26 12:00');
const st = (stage: DownFlag['stages'][number]['stage'], a: string, b: string | null = null) => ({ stage, start: L(a), end: b ? L(b) : null, setBy: 'x', enteredAt: L(a) });
const open = (id: string, unit: string, start: string, over: Partial<DownFlag> = {}): DownFlag =>
  fixtureFlag({ id, unitId: unit, type: 'unscheduled', start: L(start), end: null, state: 'open', ...over });
const assets = [truck('ht1'), truck('ht2'), truck('ht3'), truck('ht4')];
const cm = (id: string, flag: string, at: string, text: string, over: Partial<FlagComment> = {}): FlagComment => ({
  id, tenantId: 't1', siteId: 's1', unitId: 'x', downFlagId: flag, text, setBy: 'tia', enteredAt: L(at), state: 'active', ...over,
});
const w1: WaitTag = { id: 'w1', tenantId: 't1', siteId: 's1', unitId: 'ht1', downFlagId: 'f1', kind: 'PARTS', start: L('2026-10-26 09:00'), end: null, state: 'open', setBy: 'x', enteredAt: L('2026-10-26 09:00') };

const f1 = open('f1', 'ht1', '2026-10-25 12:00', {
  reasonCode: 'ENG', system: 'Hydraulics', stages: [st('in_repair', '2026-10-25 12:00', '2026-10-26 08:00'), st('waiting_parts', '2026-10-26 08:00')],
  locations: [{ kind: 'shop_line', shopLineId: 'L1', start: L('2026-10-25 14:00'), end: null, setBy: 'x', enteredAt: L('2026-10-25 14:00') }],
  etas: [{ eta: L('2026-10-26 10:00'), setAt: L('2026-10-25 15:00'), setBy: 's' }, { eta: L('2026-10-27 06:00'), setAt: L('2026-10-26 10:00'), setBy: 's' }], workOrders: ['WO-1'],
});
const f2 = open('f2', 'ht2', '2026-10-26 06:00', { type: 'scheduled', plannedDurationHours: 4, reasonCode: 'PM', stages: [st('in_repair', '2026-10-26 06:00')], locations: [{ kind: 'field', fieldLocation: 'Pit North', start: L('2026-10-26 06:00'), end: null, setBy: 'x', enteredAt: L('2026-10-26 06:00') }] });
const f3 = open('f3', 'ht3', '2026-10-26 11:00', { stages: [st('waiting_crew', '2026-10-26 11:00')], locations: [{ kind: 'towing', start: L('2026-10-26 11:00'), end: null, setBy: 'x', enteredAt: L('2026-10-26 11:00') }] });
const released = fixtureFlag({ id: 'r', unitId: 'ht4', type: 'unscheduled', start: L('2026-10-25 08:00'), end: L('2026-10-25 12:00'), state: 'released' });
const comments = [cm('c1', 'f1', '2026-10-26 07:00', 'older'), cm('c2', 'f1', '2026-10-26 11:30', 'Part 1234 on the 14:00 truck'), cm('c3', 'f1', '2026-10-26 11:45', 'voided one', { state: 'voided' }), cm('c4', 'f2', '2026-10-25 10:00', 'yesterday')];
const rows = downList({ assets, flags: [f1, f2, f3, released], waits: [w1], comments, lines: LINES, now: NOW, waitLabel: (k) => (k === 'PARTS' ? 'Parts or materials' : k) });
const row = (u: string) => rows.find((r) => r.unitId === u)!;

describe('downList', () => {
  it('has a row only for units with an open flag, longest down first', () => {
    expect(rows.map((r) => r.unitNumber)).toEqual(['HT1', 'HT2', 'HT3']);
    expect(row('ht1').downHours).toBe(24);
    expect(row('ht3').downHours).toBe(1);
  });

  it('shows stage, time in it, location, reason and what it is waiting for', () => {
    expect(row('ht1')).toMatchObject({ stageLabel: 'Waiting parts', stageHours: 4, location: 'Line 1', reason: 'ENG · Hydraulics', waiting: ['Parts or materials'], workOrders: ['WO-1'] });
    expect(row('ht2').location).toBe('Down in field: Pit North');
    expect(row('ht3').location).toBe('Towing');
  });

  it('uses the latest ETA, or start plus planned hours for a scheduled flag, and marks late ones', () => {
    expect(row('ht1')).toMatchObject({ expectedBack: L('2026-10-27 06:00'), expectedSource: 'eta', late: false });
    expect(row('ht2')).toMatchObject({ expectedBack: L('2026-10-26 10:00'), expectedSource: 'plan', late: true });
    expect(row('ht3').expectedBack).toBeUndefined();
    expect(row('ht3').late).toBe(false);
  });

  it('shows the newest active comment, never a voided one, and counts the active ones', () => {
    expect(row('ht1').lastComment).toEqual({ text: 'Part 1234 on the 14:00 truck', by: 'tia', at: L('2026-10-26 11:30') });
    expect(row('ht1').commentCount).toBe(2);
    expect(row('ht3').lastComment).toBeUndefined();
  });

  it('keeps the first start and the earlier flag\'s comments across a type switch', () => {
    const earlier = fixtureFlag({ id: 'e', unitId: 'ht3', type: 'unscheduled', start: L('2026-10-25 20:00'), end: L('2026-10-26 11:00'), state: 'released' });
    const next = { ...f3, linkedFromFlagId: 'e', linkKind: 'type_switch' as const };
    const r = downList({ assets, flags: [earlier, next], waits: [], comments: [cm('c9', 'e', '2026-10-26 02:00', 'started as a breakdown')], lines: LINES, now: NOW });
    expect(r[0]!.downHours).toBe(16);
    expect(r[0]!.lastComment!.text).toBe('started as a breakdown');
  });
});

describe('sort, filter and export', () => {
  it('sorts, putting units with no expected time last either way', () => {
    expect(sortDownList(rows, 'expected', 'asc').map((r) => r.unitNumber)).toEqual(['HT2', 'HT1', 'HT3']);
    expect(sortDownList(rows, 'expected', 'desc').map((r) => r.unitNumber)).toEqual(['HT1', 'HT2', 'HT3']);
    expect(sortDownList(rows, 'unit', 'desc').map((r) => r.unitNumber)).toEqual(['HT3', 'HT2', 'HT1']);
    expect(sortDownList(rows, 'comment', 'desc').map((r) => r.unitNumber)).toEqual(['HT1', 'HT2', 'HT3']); // newest first, none last
    expect(sortDownList(rows, 'comment', 'asc').map((r) => r.unitNumber)).toEqual(['HT2', 'HT1', 'HT3']); // oldest first, none last
  });

  it('filters by text, type, stage, late, no ETA and quiet', () => {
    const n = (f: Partial<typeof EMPTY_DOWN_FILTER>) => filterDownList(rows, { ...EMPTY_DOWN_FILTER, ...f }, NOW).map((r) => r.unitNumber);
    expect(n({ q: 'hydraulics' })).toEqual(['HT1']);
    expect(n({ q: '1234' })).toEqual(['HT1']);
    expect(n({ type: 'scheduled' })).toEqual(['HT2']);
    expect(n({ stage: 'waiting_crew' })).toEqual(['HT3']);
    expect(n({ late: true })).toEqual(['HT2']);
    expect(n({ noEta: true })).toEqual(['HT3']);
    expect(n({ quiet: true })).toEqual(['HT2', 'HT3']); // HT1 was commented 30 minutes ago; HT2 yesterday; HT3 never
  });

  it('writes a CSV with the rows as given', () => {
    const csv = downListCsv(rows, (iso) => iso.slice(0, 16), (id) => id.toUpperCase()).split('\r\n');
    expect(csv[0]).toContain('Expected back (site time)');
    expect(csv[1]).toContain('HT1,793F,unscheduled,Waiting parts,4.0,Line 1,ENG · Hydraulics,Parts or materials');
    expect(csv[1]).toContain('Part 1234 on the 14:00 truck,TIA');
    expect(csv).toHaveLength(5); // header, 3 rows, trailing newline
  });
});
