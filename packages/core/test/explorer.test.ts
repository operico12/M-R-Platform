// Analytics explorer, docs/analytics-explorer.md. Statistical tests checked against SciPy 1.18.

import { describe, expect, it } from 'vitest';
import { DEFAULT_FLAG_RULES } from '../src/config.js';
import type { ConsoleContext } from '../src/console.js';
import {
  boxStats, breakdown, compareSlices, controlChart, eventRows, findings, heatMap, mannWhitney, rateTest, retireView, saveView, sliceOperatingHours,
  spread, summarise, visibleViews, type EventRow,
} from '../src/explorer.js';
import { EMPTY_FILTER, analyse, filterFromQuery, filterToQuery, type AnalyticsFilter } from '../src/filters.js';
import { generateFleet } from '../src/synth/generate.js';
import type { Role } from '../src/types.js';
import { L, TZ, cal } from './helpers.js';

const row = (downH: number, over: Partial<Omit<EventRow, 'dims'>> & { dims?: Partial<EventRow['dims']> } = {}): EventRow => ({
  id: `e${Math.random()}`, unitId: 'u1', start: '2026-10-01T00:00:00Z', failure: true, downH, repairH: downH / 2, waitH: downH / 4, firstWrenchH: 0.5,
  ...over,
  dims: { system: 'Hydraulics', component: 'Pump', failure_mode: 'Leak', unit: 'HT1', model: '793F', fleet: 'Haul', shift: 'day', crew: 'Crew A', where: 'Field', line: 'No line', detection: 'operator', type: 'unscheduled', weekday: 'Monday', hour: '08', ...over.dims },
});

describe('statistics against SciPy', () => {
  it('Mann-Whitney U, normal approximation with continuity', () => {
    const r = mannWhitney([1, 2, 3, 4, 5, 6], [4, 5, 6, 7, 8, 9, 10]);
    expect(r.u).toBe(4.5);
    expect(r.p).toBeCloseTo(0.02172, 4);
  });
  it('Mann-Whitney U with ties', () => {
    const r = mannWhitney([1, 1, 2, 2, 3, 8], [2, 3, 3, 4, 4, 9, 9]);
    expect(r.u).toBe(8);
    expect(r.p).toBeCloseTo(0.06978, 4);
  });
  it('conditional binomial rate test', () => {
    const r = rateTest(10, 1000, 25, 1200);
    expect(r.z).toBeCloseTo(-1.8362, 3);
    expect(r.p).toBeCloseTo(0.06633, 4);
    expect(rateTest(0, 100, 0, 100).p).toBe(1);
  });
  it('box statistics', () => {
    const b = boxStats([1, 2, 3, 4, 5, 6, 7, 8, 9, 40]);
    expect(b).toMatchObject({ n: 10, q1: 3.25, median: 5.5, q3: 7.75, lo: 1, hi: 9, outliers: [40] });
  });
});

describe('measures', () => {
  it('summarises a group', () => {
    const s = summarise([row(2), row(4), row(6, { failure: false, firstWrenchH: null })], 100);
    expect(s).toMatchObject({ events: 3, failures: 2, down_h: 12, mean_down_h: 4, median_down_h: 4, mttr: 2, wait_h: 3, first_wrench_h: 0.5, mtbf: 50 });
  });
  it('breakdown hides medians and means below 5 events', () => {
    const rows = [...[1, 2, 3, 4, 5].map((h) => row(h)), row(10, { dims: { system: 'Brakes' } })];
    const g = breakdown(rows, 'system', 1000);
    expect(g.map((x) => x.key)).toEqual(['Hydraulics', 'Brakes']);
    expect(g[0]!.summary.median_down_h).toBe(3);
    expect(g[1]!.summary.median_down_h).toBeNull();
    expect(g[1]!.summary.down_h).toBe(10);
    expect(g[1]!.small).toBe(true);
    // MTBF by system uses the whole slice's hours.
    expect(g[0]!.summary.mtbf).toBe(200);
  });
  it('MTBF by unit uses the unit hours', () => {
    const g = breakdown([row(1), row(1, { dims: { unit: 'HT2' } })], 'unit', 1000, (_d, k) => (k === 'HT1' ? 300 : 700));
    expect(g.find((x) => x.key === 'HT1')!.summary.mtbf).toBe(300);
    expect(g.find((x) => x.key === 'HT2')!.summary.mtbf).toBe(700);
  });
  it('heat map cells', () => {
    const rows = [...[1, 2, 3, 4, 5].map((h) => row(h, { dims: { shift: 'night' } })), row(9, { dims: { shift: 'day' } })];
    const m = heatMap(rows, 'system', 'shift', 'median_down_h', 100);
    expect(m.cols).toEqual(['night', 'day']);
    expect(m.cells.get('Hydraulics\u0000night')).toMatchObject({ n: 5, value: 3 });
    expect(m.cells.get('Hydraulics\u0000day')).toMatchObject({ n: 1, value: null });
  });
  it('spread hides small groups', () => {
    const rows = [...[1, 2, 3, 4, 5].map((h) => row(h)), row(9, { dims: { system: 'Brakes' } })];
    expect(spread(rows, 'system', 'down').map((b) => b.key)).toEqual(['Hydraulics']);
  });
});

describe('compare (KPI-028)', () => {
  it('flags a clear difference in repair time and leaves totals untested', () => {
    const a = [1, 1.5, 2, 2, 2.5, 3, 3].map((h) => row(h));
    const b = [6, 7, 8, 8, 9, 10, 12].map((h) => row(h));
    const c = compareSlices(a, 500, b, 500);
    const mean = c.find((x) => x.measure === 'mean_down_h')!;
    expect(mean.outside).toBe(true);
    expect(mean.diff).toBeCloseTo(60 / 7 - 15 / 7, 9);
    expect(c.find((x) => x.measure === 'down_h')!.p).toBeNull();
    expect(c.find((x) => x.measure === 'mtbf')!.outside).toBe(false);
  });
  it('needs 5 events on each side', () => {
    const c = compareSlices([row(1), row(2)], 100, [row(10), row(11)], 100);
    expect(c.every((x) => x.p === null && !x.outside)).toBe(true);
  });
});

describe('control chart (KPI-029)', () => {
  it('XmR limits from the mean moving range', () => {
    const pts = [10, 12, 11, 13, 12, 30].map((v, i) => ({ label: `w${i}`, value: v }));
    const c = controlChart(pts)!;
    expect(c.centre).toBeCloseTo(88 / 6, 9);
    // moving ranges 2, 1, 2, 1, 18 → mean 4.8
    expect(c.ucl).toBeCloseTo(88 / 6 + 2.66 * 4.8, 9);
    expect(c.lcl).toBe(Math.max(0, 88 / 6 - 2.66 * 4.8));
    expect(c.points.filter((p) => p.out).map((p) => p.label)).toEqual(['w5']);
    expect(controlChart(pts.slice(0, 5))).toBeNull();
  });
});

describe('suggested findings', () => {
  it('finds night shift waiting longer on hydraulics', () => {
    const rows = [
      ...[3, 3.5, 4, 4, 4.5, 5, 5.5].map((h) => row(h, { waitH: h, dims: { shift: 'night' } })),
      ...[0.5, 0.6, 0.7, 0.8, 1, 1, 1.2, 0.9].map((h) => row(h, { waitH: h, dims: { shift: 'day' } })),
    ];
    const f = findings(rows, 'wait');
    expect(f[0]).toMatchObject({ system: 'Hydraulics', dim: 'shift' });
    expect(f[0]!.sentence).toMatch(/median wait 4\.0 h vs 0\.9 h/);
    expect(findings(rows.slice(0, 9), 'wait')).toEqual([]);
  });
});

describe('fleet data', () => {
  const END = '2026-10-26T20:00:00.000Z';
  const ds = generateFleet({ seed: 7, units: 40, days: 120, end: END });
  const input = { assets: ds.assets, flags: ds.flags, smu: ds.smu, lifecycle: ds.lifecycle, rules: DEFAULT_FLAG_RULES, now: END, calendar: ds.calendar, timeZone: ds.site.timeZone };
  const F = (over: Partial<AnalyticsFilter>): AnalyticsFilter => ({ ...structuredClone(EMPTY_FILTER), range: { preset: '90d' }, ...over });
  it('rows add up to the downtime analysis', () => {
    const a = analyse(input, F({}));
    const rows = eventRows(a, ds.assets, ds.calendar, ds.shopLines);
    expect(rows).toHaveLength(a.events.length);
    expect(summarise(rows, null).down_h).toBeCloseTo(a.downHours, 6);
    expect(breakdown(rows, 'shift', 1).reduce((s, g) => s + g.rows.length, 0)).toBe(rows.length);
    expect(sliceOperatingHours(input, a.assets, a)).toBeCloseTo(a.kpis.operatingHours, 6);
  });
  it('new filters: failure mode and day of week split the whole', () => {
    const all = analyse(input, F({}));
    // Each flag matches one day, so the days' matching down hours add up to the whole.
    const days = ['1', '2', '3', '4', '5', '6', '7'].map((d) => analyse(input, F({ weekdays: [d] })).downHours);
    expect(days.reduce((s, n) => s + n, 0)).toBeCloseTo(all.downHours, 6);
    const f = F({ modes: ['Leak'], weekdays: ['1', '3'] });
    expect(filterFromQuery(filterToQuery(f))).toEqual(f);
  });
});

describe('saved views', () => {
  let n = 0;
  const ctx = (role: Role, userId = `u-${role}`): ConsoleContext => ({ actor: { userId, role, scope: ['*'] }, now: L('2026-10-28 09:00'), newId: () => `v${++n}`, timeZone: TZ, calendar: cal });
  it('save, see and retire', () => {
    expect(saveView(ctx('viewer'), [], { name: 'x', query: '', shared: false }).ok).toBe(false);
    const a = saveView(ctx('supervisor', 'sam'), [], { name: ' Night vs day ', query: 'shift=night', shared: true });
    const b = a.ok ? saveView(ctx('reliability_engineer', 'rae'), a.records, { name: 'Mine', query: '', shared: false }) : a;
    if (!b.ok) throw new Error('save');
    expect(b.records[0]!.name).toBe('Night vs day');
    expect(visibleViews(b.records, 'sam').map((v) => v.name)).toEqual(['Night vs day']);
    expect(visibleViews(b.records, 'rae')).toHaveLength(2);
    const shared = b.records[0]!.id;
    expect(retireView(ctx('reliability_engineer', 'rae'), b.records, shared, 'old').ok).toBe(false);
    expect(retireView(ctx('superintendent', 'sid'), b.records, shared, ' ').ok).toBe(false);
    const r = retireView(ctx('superintendent', 'sid'), b.records, shared, 'Replaced');
    expect(r.ok && visibleViews(r.records, 'rae').map((v) => v.name)).toEqual(['Mine']);
    expect(r.ok && r.audit[0]).toMatchObject({ entity: 'view', action: 'retire_view' });
  });
});
