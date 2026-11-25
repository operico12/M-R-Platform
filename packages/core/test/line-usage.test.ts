// Shop line usage over time (docs/shop-lines.md section 4, KPI-047), worked by hand.

import { describe, expect, it } from 'vitest';
import { defaultGrouping, lineUsage, usageCsvRows, usageGroups, usagePresets } from '../src/line-usage.js';
import type { DownFlag, ShopLine, ShopLineClosure } from '../src/types.js';
import { L, LINES, TZ, fixtureFlag } from './helpers.js';

const line = (id: string, over: Partial<ShopLine> = {}): ShopLine => ({ ...LINES.find((l) => l.id === id)!, ...over });
const on = (id: string, lineId: string, start: string, end: string | null, stages: DownFlag['stages']): DownFlag =>
  fixtureFlag({
    id, unitId: id, type: 'unscheduled', start: L(start), end: end ? L(end) : null, state: end ? 'released' : 'open',
    stages,
    locations: [{ kind: 'shop_line', shopLineId: lineId, start: L(start), end: end ? L(end) : null, setBy: 'x', enteredAt: L(start) }],
  });
const stage = (s: DownFlag['stages'][number]['stage'], start: string, end: string | null): DownFlag['stages'][number] =>
  ({ stage: s, start: L(start), end: end ? L(end) : null, setBy: 'x', enteredAt: L(start) });

describe('usageGroups', () => {
  it('cuts in site time and trims the first and last group to the period', () => {
    const g = usageGroups({ from: L('2026-01-15 00:00'), to: L('2026-03-10 00:00') }, 'month', TZ);
    expect(g.map((x) => x.label)).toEqual(['Jan 2026', 'Feb 2026', 'Mar 2026']);
    expect(g[0]!.from).toBe(L('2026-01-15 00:00'));
    expect(g[0]!.to).toBe(L('2026-02-01 00:00'));
    expect(g[2]!.to).toBe(L('2026-03-10 00:00'));
  });

  it('starts weeks on Monday and years on 1 January', () => {
    const w = usageGroups({ from: L('2026-01-01 00:00'), to: L('2026-01-20 00:00') }, 'week', TZ);
    expect(w.map((x) => x.label)).toEqual(['Wk of Dec 29', 'Wk of Jan 5', 'Wk of Jan 12', 'Wk of Jan 19']);
    const y = usageGroups({ from: L('2025-06-01 00:00'), to: L('2027-02-01 00:00') }, 'year', TZ);
    expect(y.map((x) => x.label)).toEqual(['2025', '2026', '2027']);
  });

  it('is empty for an empty period and picks a grouping from the span', () => {
    expect(usageGroups({ from: L('2026-01-01 00:00'), to: L('2026-01-01 00:00') }, 'day', TZ)).toEqual([]);
    expect(defaultGrouping({ from: L('2026-01-01 00:00'), to: L('2026-01-31 00:00') })).toBe('day');
    expect(defaultGrouping({ from: L('2026-01-01 00:00'), to: L('2026-04-01 00:00') })).toBe('week');
    expect(defaultGrouping({ from: L('2026-01-01 00:00'), to: L('2027-01-01 00:00') })).toBe('month');
    expect(defaultGrouping({ from: L('2026-01-01 00:00'), to: L('2030-01-01 00:00') })).toBe('year');
  });
});

describe('lineUsage', () => {
  const NOW = L('2026-03-15 00:00');
  const period = { from: L('2026-01-01 00:00'), to: L('2026-03-01 00:00') }; // 59 days = 1416 h
  const lines = [line('L1'), line('L2')];
  // A: 10 Jan to 20 Jan on L1 = 240 h, in repair the first 100 h, then waiting for parts.
  const a = on('a', 'L1', '2026-01-10 00:00', '2026-01-20 00:00', [stage('in_repair', '2026-01-10 00:00', '2026-01-14 04:00'), stage('waiting_parts', '2026-01-14 04:00', '2026-01-20 00:00')]);
  // B: 25 Jan to 5 Feb on L1 = 264 h (168 in Jan, 96 in Feb), all in repair.
  const b = on('b', 'L1', '2026-01-25 00:00', '2026-02-05 00:00', [stage('in_repair', '2026-01-25 00:00', '2026-02-05 00:00')]);
  const run = (over: Partial<Parameters<typeof lineUsage>[0]> = {}) =>
    lineUsage({ lines, flags: [a, b], closures: [], period, grouping: 'month', timeZone: TZ, now: NOW, ...over });

  it('gives each line its monthly usage, worked and idle hours', () => {
    const r = run();
    const l1 = r.rows.find((x) => x.line.id === 'L1')!;
    expect(r.groups.map((g) => g.label)).toEqual(['Jan 2026', 'Feb 2026']);
    // January: 240 + 168 = 408 occupied of 744 open hours.
    expect(l1.groups[0]!.occupiedHours).toBeCloseTo(408, 6);
    expect(l1.groups[0]!.usage).toBeCloseTo(408 / 744, 6);
    // Worked in January: A 100 h in repair + B 168 h = 268; idle 140 h.
    expect(l1.groups[0]!.workedHours).toBeCloseTo(268, 6);
    expect(l1.groups[0]!.idleHours).toBeCloseTo(140, 6);
    // February: 96 of 672.
    expect(l1.groups[1]!.occupiedHours).toBeCloseTo(96, 6);
    expect(l1.groups[1]!.usage).toBeCloseTo(96 / 672, 6);
    // The whole period: 504 of 1416, matching KPI-009 for the same period.
    expect(l1.total.occupiedHours).toBeCloseTo(504, 6);
    expect(l1.total.usage).toBeCloseTo(504 / 1416, 6);
    expect(l1.total.visits).toBe(2);
    expect(l1.total.units).toBe(2);
  });

  it('weights the fleet row by open hours and capacity, not by averaging lines', () => {
    const big = line('L2', { capacity: 3 });
    const r = run({ lines: [line('L1'), big] });
    // L1 504 occupied over 1416; L2 empty with capacity 3 → 4248 capacity-hours.
    expect(r.fleet.total.usage).toBeCloseTo(504 / (1416 + 3 * 1416), 6);
    expect(r.fleet.total.occupiedHours).toBeCloseTo(504, 6);
  });

  it('leaves closed time out and reports null when closed the whole group', () => {
    const closed: ShopLineClosure[] = [{ lineId: 'L2', start: L('2026-02-01 00:00'), end: null, reason: 'Crane inspection' }];
    const r = run({ closures: closed });
    const l2 = r.rows.find((x) => x.line.id === 'L2')!;
    expect(l2.groups[0]!.usage).toBe(0);
    expect(l2.groups[1]!.usage).toBeNull();
    expect(l2.groups[1]!.openHours).toBe(0);
  });

  it('counts a unit still on the line to now, and trims a period that ends in the future', () => {
    const open = on('c', 'L1', '2026-03-10 00:00', null, [stage('in_repair', '2026-03-10 00:00', null)]);
    const r = lineUsage({
      lines, flags: [open], closures: [], period: { from: L('2026-03-01 00:00'), to: L('2026-04-01 00:00') },
      grouping: 'month', timeZone: TZ, now: NOW,
    });
    const l1 = r.rows.find((x) => x.line.id === 'L1')!;
    // 1 to 15 March is 14 days, but clocks went forward on 8 March: 335 h elapsed. The unit has been there 5 days (120 h).
    expect(l1.total.openHours).toBeCloseTo(335, 6);
    expect(l1.total.occupiedHours).toBeCloseTo(120, 6);
    expect(l1.total.workedHours).toBeCloseTo(120, 6);
  });

  it('shows a retired line only for periods in which it was used', () => {
    const retired = line('L2', { retiredAt: L('2026-02-15 00:00'), retiredReason: 'Rebuilt' });
    const used = on('d', 'L2', '2026-01-02 00:00', '2026-01-03 00:00', [stage('in_repair', '2026-01-02 00:00', '2026-01-03 00:00')]);
    expect(lineUsage({ lines: [line('L1'), retired], flags: [used], closures: [], period, grouping: 'month', timeZone: TZ, now: NOW }).rows.map((x) => x.line.id)).toEqual(['L1', 'L2']);
    expect(lineUsage({ lines: [line('L1'), retired], flags: [], closures: [], period, grouping: 'month', timeZone: TZ, now: NOW }).rows.map((x) => x.line.id)).toEqual(['L1']);
  });

  it('ignores voided and proposed flags (they never count)', () => {
    const voided: DownFlag = { ...a, id: 'v', state: 'voided' };
    const r = run({ flags: [voided] });
    expect(r.fleet.total.occupiedHours).toBe(0);
  });

  it('writes one CSV row per line and group', () => {
    const rows = usageCsvRows(run(), (l) => l.name ?? `Line ${l.number}`);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({ line: 'Line 1', period: 'Jan 2026', occupied_hours: 408, worked_hours: 268, idle_hours: 140 });
  });
});

describe('usagePresets', () => {
  it('cuts periods at site midnights, not the viewer\'s', () => {
    // 1 Jan 2027, 03:00 UTC is still 31 Dec 2026 in Vancouver.
    const p = usagePresets(TZ, '2027-01-01T03:00:00.000Z');
    const by = (k: string) => p.find((x) => x.key === k)!.period;
    expect(by('this_month').from).toBe(L('2026-12-01 00:00'));
    expect(by('last_month').from).toBe(L('2026-11-01 00:00'));
    expect(by('last_month').to).toBe(L('2026-12-01 00:00'));
    expect(by('ytd').from).toBe(L('2026-01-01 00:00'));
    expect(by('last_year').from).toBe(L('2025-01-01 00:00'));
    expect(by('last_year').to).toBe(L('2026-01-01 00:00'));
    expect(by('last_12_months').from).toBe(L('2026-01-01 00:00'));
    expect(by('last_3_months').from).toBe(L('2026-10-01 00:00'));
  });
});
