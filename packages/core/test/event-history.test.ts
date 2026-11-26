// History (docs/history.md): one row per downtime event. Worked by hand.

import { describe, expect, it } from 'vitest';
import { DEFAULT_FLAG_RULES } from '../src/config.js';
import { EMPTY_HISTORY_FILTER, filterHistory, historyCsv, historyRows, sortHistory } from '../src/event-history.js';
import type { DownFlag } from '../src/types.js';
import { L, LINES, TZ, fixtureFlag, truck } from './helpers.js';

const NOW = L('2026-10-30 12:00');
const st = (stage: DownFlag['stages'][number]['stage'], a: string, b: string | null = null) => ({ stage, start: L(a), end: b ? L(b) : null, setBy: 'x', enteredAt: L(a) });
const lo = (kind: DownFlag['locations'][number]['kind'], a: string, b: string | null, extra: Partial<DownFlag['locations'][number]> = {}) => ({ kind, start: L(a), end: b ? L(b) : null, setBy: 'x', enteredAt: L(a), ...extra });
const assets = [truck('ht1'), truck('ht2', { model: '797F' }), truck('ht3')];

// HT1: PM from 08:00 to 10:00 switched to a breakdown, ending 14:00 (one event of 6 h).
const pm = fixtureFlag({ id: 'pm', unitId: 'ht1', type: 'scheduled', start: L('2026-10-26 08:00'), end: L('2026-10-26 10:00'), reasonCode: 'PM',
  stages: [st('in_repair', '2026-10-26 08:00', '2026-10-26 10:00')], locations: [lo('shop_line', '2026-10-26 08:00', '2026-10-26 10:00', { shopLineId: 'L1' })] });
const bd = fixtureFlag({ id: 'bd', unitId: 'ht1', type: 'unscheduled', start: L('2026-10-26 10:00'), end: L('2026-10-26 14:00'), reasonCode: 'ENG', linkedFromFlagId: 'pm', linkKind: 'type_switch',
  stages: [st('waiting_parts', '2026-10-26 10:00', '2026-10-26 12:00'), st('in_repair', '2026-10-26 12:00', '2026-10-26 14:00')], locations: [lo('shop_line', '2026-10-26 10:00', '2026-10-26 14:00', { shopLineId: 'L6' })],
  release: { system: 'Engine', component: 'Turbo', failureModes: ['Leak', 'Worn'], workOrder: 'WO-1' }, workOrders: ['WO-1'] });
// HT2: a 10-minute minor stop (under the 15-minute failure minimum), in the field, 1 Oct.
const minor = fixtureFlag({ id: 'm', unitId: 'ht2', type: 'unscheduled', start: L('2026-10-01 07:00'), end: L('2026-10-01 07:10'), reasonCode: 'TYRE',
  stages: [st('in_repair', '2026-10-01 07:00', '2026-10-01 07:10')], locations: [lo('field', '2026-10-01 07:00', '2026-10-01 07:10', { fieldLocation: 'Pit North' })], release: { system: 'Tyres' } });
// HT3: still open, 12 h to now: 4 h in repair, then waiting for parts.
const open = fixtureFlag({ id: 'o', unitId: 'ht3', type: 'unscheduled', start: L('2026-10-30 00:00'), end: null, state: 'open', reasonCode: 'ENG', system: 'Hydraulics',
  stages: [st('in_repair', '2026-10-30 00:00', '2026-10-30 04:00'), st('waiting_parts', '2026-10-30 04:00')], locations: [lo('shop_line', '2026-10-30 00:00', null, { shopLineId: 'L1' })] });
const voided: DownFlag = { ...minor, id: 'v', unitId: 'ht3', state: 'voided' };
const rows = historyRows({ assets, flags: [pm, bd, minor, open, voided], lines: LINES, rules: DEFAULT_FLAG_RULES, now: NOW });
const row = (u: string) => rows.find((r) => r.unitId === u)!;

describe('historyRows', () => {
  it('has one row per event, newest first, with a type switch as one event and no voided flags', () => {
    expect(rows.map((r) => r.unitNumber)).toEqual(['HT3', 'HT1', 'HT2']);
    expect(row('ht1').flags.map((f) => f.id)).toEqual(['pm', 'bd']);
    expect(row('ht1').types).toEqual(['scheduled', 'unscheduled']);
  });

  it('calculates down, in-repair, waiting and first-wrench hours from the stage intervals', () => {
    expect(row('ht1')).toMatchObject({ downHours: 6, inRepairHours: 4, waitingHours: 2, firstWrenchHours: 0 });
    expect(row('ht3')).toMatchObject({ downHours: 12, inRepairHours: 4, waitingHours: 8, firstWrenchHours: 0, state: 'open', end: null });
  });

  it('takes system, component and failure modes from the release, and where it ended up', () => {
    expect(row('ht1')).toMatchObject({ reason: 'PM', system: 'Engine', component: 'Turbo', failureModes: ['Leak', 'Worn'], where: 'Line 6', workOrders: ['WO-1'] });
    expect(row('ht2').where).toBe('Down in field: Pit North');
    expect(row('ht3')).toMatchObject({ system: 'Hydraulics', where: 'Line 1' });
  });

  it('marks failures and minor stops by the flag rules', () => {
    expect(row('ht2')).toMatchObject({ isFailure: false, isMinorStop: true });
    expect(row('ht3').isFailure).toBe(true);
  });
});

describe('filterHistory', () => {
  const n = (f: Partial<typeof EMPTY_HISTORY_FILTER>) => filterHistory(rows, { ...EMPTY_HISTORY_FILTER, ...f }, TZ).map((r) => r.unitNumber);

  it('uses site dates, inclusive at both ends, on the event start', () => {
    expect(n({ from: '2026-10-26', to: '2026-10-26' })).toEqual(['HT1']);
    expect(n({ from: '2026-10-27' })).toEqual(['HT3']);
    expect(n({ to: '2026-10-25' })).toEqual(['HT2']);
    expect(n({ from: '2026-10-30', to: '2026-10-30' })).toEqual(['HT3']);
  });

  it('filters by text, type, state, system, model, failures and duration', () => {
    expect(n({ q: 'turbo' })).toEqual(['HT1']);
    expect(n({ q: 'wo-1' })).toEqual(['HT1']);
    expect(n({ type: 'scheduled' })).toEqual(['HT1']); // started as a PM
    expect(n({ state: 'open' })).toEqual(['HT3']);
    expect(n({ system: 'Tyres' })).toEqual(['HT2']);
    expect(n({ model: '797F' })).toEqual(['HT2']);
    expect(n({ failuresOnly: true })).toEqual(['HT3']); // the PM that became a breakdown is not a failure by default (D5)
    expect(n({ minHours: 6 })).toEqual(['HT3', 'HT1']);
    expect(n({ maxHours: 1 })).toEqual(['HT2']); // 10 minutes
  });

  it('puts an event that starts just after local midnight on that day, not the UTC day', () => {
    const late = fixtureFlag({ id: 'l', unitId: 'ht2', type: 'unscheduled', start: L('2026-10-20 23:30'), end: L('2026-10-21 01:00'), stages: [st('in_repair', '2026-10-20 23:30', '2026-10-21 01:00')] });
    const r = historyRows({ assets, flags: [late], lines: LINES, rules: DEFAULT_FLAG_RULES, now: NOW });
    expect(filterHistory(r, { ...EMPTY_HISTORY_FILTER, from: '2026-10-20', to: '2026-10-20' }, TZ)).toHaveLength(1);
    expect(filterHistory(r, { ...EMPTY_HISTORY_FILTER, from: '2026-10-21', to: '2026-10-21' }, TZ)).toHaveLength(0);
  });
});

describe('sortHistory and historyCsv', () => {
  it('sorts, with an open event as the latest end', () => {
    expect(sortHistory(rows, 'down', 'desc').map((r) => r.unitNumber)).toEqual(['HT3', 'HT1', 'HT2']);
    expect(sortHistory(rows, 'end', 'desc').map((r) => r.unitNumber)[0]).toBe('HT3');
    expect(sortHistory(rows, 'unit', 'asc').map((r) => r.unitNumber)).toEqual(['HT1', 'HT2', 'HT3']);
    expect(sortHistory(rows, 'model', 'desc').map((r) => r.unitNumber)[0]).toBe('HT2');
  });

  it('writes one CSV line per row with open events marked', () => {
    const csv = historyCsv(rows, (iso) => iso.slice(0, 10)).split('\r\n');
    expect(csv).toHaveLength(5);
    expect(csv[1]).toContain('HT3,793F,Haul trucks');
    expect(csv[1]).toContain(',open,');
    expect(csv[2]).toContain('scheduled → unscheduled');
  });
});
