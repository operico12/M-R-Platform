// Spares and rebuild pool sizing (docs/spares.md) and calculators C-16 to C-19
// (docs/calculators.md). Worked examples were checked with SciPy 1.18
// stats.poisson; the pool and PM part answers are worked by hand below.

import { describe, expect, it } from 'vitest';
import { CalcError, kitStocking, lifetimeBuy, lifetimeDemand, poisson, poissonSpares, rebuildPool } from '../src/calculators.js';
import { componentStates, smuIndex, type BurnRate, type Component, type ComponentEvent, type ForecastRow } from '../src/components.js';
import type { ConsoleContext } from '../src/console.js';
import { addMode, DEFAULT_RCM_SETTINGS, type ModeInput, type RcmMode } from '../src/rcm.js';
import {
  DEFAULT_SPARES_SETTINGS, fleetHoursPerYear, kitShare, pmKits, pmPartDemand, rebuildPoolRows, repairCycles, setSparesSettings, withSparesDefaults,
} from '../src/spares.js';
import { generateFleet } from '../src/synth/generate.js';
import type { Role } from '../src/types.js';
import { L, TZ, cal, truck } from './helpers.js';

let n = 0;
const ctx = (role: Role, now = L('2026-10-28 09:00')): ConsoleContext => ({ actor: { userId: `u-${role}`, role, scope: ['*'] }, now, newId: () => `id${++n}`, timeZone: TZ, calendar: cal });

describe('Poisson table', () => {
  it('matches SciPy for small and large means', () => {
    const t = poisson(0.41095890410958907);
    expect(t.cdf(0)).toBeCloseTo(0.6630141781988701, 12);
    const big = poisson(5000);
    expect(big.cdf(5000)).toBeCloseTo(0.5037611677708467, 9);
    expect(big.quantile(0.95)).toBe(5117);
  });
  it('fill rate is P(N ≤ s − 1) and backorders fall with stock', () => {
    const t = poisson(2);
    expect(t.fill(0)).toBe(0);
    expect(t.fill(1)).toBeCloseTo(Math.exp(-2), 12);
    expect(t.ebo(0)).toBeCloseTo(2, 10);
    expect(t.ebo(3)).toBeLessThan(t.ebo(2));
    expect(poisson(0).cdf(0)).toBe(1);
  });
  it('refuses a negative or huge mean', () => {
    expect(() => poisson(-1)).toThrow(CalcError);
    expect(() => poisson(200_000)).toThrow(/100,000/);
  });
});

describe('C-16 spares for a fill rate', () => {
  it('worked example: 6 a year, 60 days, 95%', () => {
    const r = poissonSpares({ perYear: 6, leadDays: 60, target: 0.95, unitCost: 500 });
    expect(r.values.onOrderMean).toBeCloseTo(0.9863013698630136, 12);
    expect(r.values.stock).toBe(4);
    expect(r.values.fill).toBeCloseTo(0.9818402715714897, 10);
    expect(r.values.noStockout).toBeCloseTo(0.996545848286957, 10);
    expect(r.values.ebo).toBeCloseTo(0.004094358173208103, 10);
    expect(r.values.stockValue).toBe(2000);
    // 3 would miss the target.
    expect(poisson(r.values.onOrderMean!).fill(3)).toBeLessThan(0.95);
    expect(r.curve.find((c) => c.s === 4)!.fill).toBeCloseTo(0.98184, 5);
  });
  it('warns on a slow mover and handles no demand', () => {
    expect(poissonSpares({ perYear: 0.1, leadDays: 30, target: 0.95 }).warnings.join(' ')).toMatch(/slow mover/);
    const z = poissonSpares({ perYear: 0, leadDays: 30, target: 0.95 });
    expect(z.values.stock).toBe(0);
    expect(() => poissonSpares({ perYear: 5, leadDays: 30, target: 1 })).toThrow(/between 0% and 100%/);
  });
});

describe('C-17 rebuild pool', () => {
  it('worked example: 12 a year, 75 day cycle, 95%, with costs', () => {
    const r = rebuildPool({ perYear: 12, cycleDays: 75, target: 0.95, carryingCost: 60000, costPerDownHour: 2500 });
    expect(r.values.onOrderMean).toBeCloseTo(2.4657534246575343, 12);
    expect(r.values.pool).toBe(6);
    expect(r.values.fill).toBeCloseTo(0.9602275846661237, 10);
    expect(r.values.ebo).toBeCloseTo(0.01852837350300986, 9);
    expect(r.values.downHours).toBeCloseTo(162.3085518863664, 5);
    expect(r.values.waitDays).toBeCloseTo(6.763, 3);
    expect(Math.round(r.values.totalAtTarget!)).toBe(765771);
    expect(r.values.bestPool).toBe(8);
    expect(Math.round(r.values.bestTotal!)).toBe(509674);
    expect(r.sentence).toMatch(/lowest total cost is a pool of 8/);
  });
  it('without costs gives only the pool for the target', () => {
    const r = rebuildPool({ perYear: 12, cycleDays: 75, target: 0.95 });
    expect(r.values.bestPool).toBeNull();
    expect(r.curve.every((c) => c.total === null)).toBe(true);
  });
});

describe('C-18 kit stocking', () => {
  const parts = [
    { item: 'FILTER', qty: 2, leadDays: 14, unitCost: 80 },
    { item: 'SEAL-KIT', qty: 1, leadDays: 45, unitCost: 350 },
    { item: 'PUMP', qty: 1, leadDays: 90, unitCost: 4200 },
  ];
  it('worked example: 24 kits a year, 95%', () => {
    const r = kitStocking({ perYear: 24, target: 0.95, parts });
    expect(r.parts.map((p) => p.kits)).toEqual([6, 9, 11]);
    expect(r.parts.map((p) => p.stock)).toEqual([12, 9, 11]);
    expect(r.values.kitFillLower).toBeCloseTo(0.9569670153212949, 9);
    expect(r.values.kitFillUpper).toBeCloseTo(0.9606814936719693, 9);
    expect(r.values.stockValue).toBe(50310);
  });
  it('the product is a safe lower bound: checked by simulation', () => {
    const r = kitStocking({ perYear: 24, target: 0.95, parts });
    // Poisson kit uses over 20,000 years; a kit is ready when, for each part, fewer than k
    // uses happened within its lead time before this one (those orders are still out).
    let a = 7;
    const rnd = () => { // mulberry32
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), a | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return (((t ^ (t >>> 14)) >>> 0) + 0.5) / 4294967296;
    };
    const times: number[] = [];
    let t = 0;
    while (t < 20000 * 365) { t += (-Math.log(rnd()) * 365) / 24; times.push(t); }
    const ptr = parts.map(() => 0);
    let ok = 0;
    times.forEach((x, j) => {
      let all = true;
      parts.forEach((p, i) => {
        while (times[ptr[i]!]! <= x - p.leadDays) ptr[i]!++;
        if (j - ptr[i]! >= r.parts[i]!.kits) all = false;
      });
      if (all) ok++;
    });
    const sim = ok / times.length;
    expect(sim).toBeGreaterThan(r.values.kitFillLower! - 0.003);
    expect(sim).toBeLessThan(r.values.kitFillUpper! + 0.003);
  });
  it('treats missing costs alike and refuses bad parts', () => {
    const r = kitStocking({ perYear: 12, target: 0.9, parts: [{ item: 'A', qty: 1, leadDays: 30 }, { item: 'B', qty: 1, leadDays: 30 }] });
    expect(Math.abs(r.parts[0]!.kits - r.parts[1]!.kits)).toBeLessThanOrEqual(1);
    expect(r.values.stockValue).toBeNull();
    expect(r.warnings.join(' ')).toMatch(/no unit cost/);
    expect(() => kitStocking({ perYear: 12, target: 0.9, parts: [{ item: 'A', qty: 1, leadDays: 30 }, { item: 'a', qty: 1, leadDays: 30 }] })).toThrow(/listed twice/);
    expect(() => kitStocking({ perYear: 12, target: 0.9, parts: [] })).toThrow(/at least one part/);
  });
});

describe('C-19 lifetime buy', () => {
  it('worked example: 10 a year, 6 years, −10% a year, 90%', () => {
    const r = lifetimeBuy({ perYear: 10, years: 6, change: -0.1, confidence: 0.9, onHand: 5, unitCost: 2000, salvage: 200, shortageCost: 15000 });
    expect(r.values.demandMean).toBeCloseTo(44.471972927857905, 9);
    expect(r.values.needTotal).toBe(53);
    expect(r.values.buy).toBe(48);
    expect(r.values.buyCost).toBe(96000);
    expect(r.values.leftover).toBeCloseTo(8.880231647562706, 8);
    expect(r.values.short).toBeCloseTo(0.3522045754206111, 8);
    expect(r.values.ratio).toBeCloseTo(13000 / 14800, 12);
    expect(r.values.costTotal).toBe(52);
    expect(r.values.costBuy).toBe(47);
  });
  it('no change in demand is uses × years', () => {
    expect(lifetimeDemand(10, 6, 0)).toBe(60);
    expect(() => lifetimeBuy({ perYear: 10, years: 6, change: 0, confidence: 0.9, onHand: 0, unitCost: 100, shortageCost: 50 })).toThrow(/more than the unit cost/);
  });
});

// ---------- the pool from the component history ----------

const assets = [truck('ht1'), truck('ht2'), truck('ht3', { model: '797F' })];
const comp = (id: string, kind: Component['kind'], models = ['793F']): Component => ({ id, serial: id.toUpperCase(), kind, models, hoursAtEntry: 0, rebuildsAtEntry: 0, createdBy: 'x', createdAt: L('2025-01-01 08:00') });
let ev = 0;
const e = (componentId: string, kind: ComponentEvent['kind'], at: string, more: Partial<ComponentEvent> = {}): ComponentEvent => ({ id: `e${String(++ev).padStart(3, '0')}`, componentId, kind, at: L(at), enteredBy: 'x', enteredAt: L(at), ...more });

const components = [comp('e1', 'engine'), comp('e2', 'engine'), comp('e3', 'engine'), comp('e4', 'engine'), comp('e5', 'engine'), comp('t1', 'transmission')];
const events: ComponentEvent[] = [
  ...['e1', 'e2', 'e3', 'e4', 'e5', 't1'].map((id) => e(id, 'received', '2025-01-02 08:00', { receivedAs: 'new' })),
  // E1: removed for failure 1 Feb, back 2 Apr: 60 days.
  e('e1', 'installed', '2025-01-03 08:00', { unitId: 'ht1', position: 'engine', smu: 0 }),
  e('e1', 'removed', '2026-02-01 08:00', { unitId: 'ht1', position: 'engine', reason: 'failure' }),
  e('e1', 'sent_rebuild', '2026-02-10 08:00', { vendor: 'V1' }),
  e('e1', 'returned_rebuild', '2026-04-02 08:00'),
  // E3 runs on HT1 from February until 1 July, then a 40 day cycle.
  e('e3', 'installed', '2026-02-02 08:00', { unitId: 'ht1', position: 'engine' }),
  // E2: removed planned from HT2 1 May, back 20 June (50 days), then onto HT1.
  e('e2', 'installed', '2025-01-03 08:00', { unitId: 'ht2', position: 'engine' }),
  e('e2', 'removed', '2026-05-01 08:00', { unitId: 'ht2', position: 'engine', reason: 'planned' }),
  e('e2', 'sent_rebuild', '2026-05-05 08:00', { vendor: 'V1' }),
  e('e2', 'returned_rebuild', '2026-06-20 08:00'),
  e('e3', 'removed', '2026-07-01 08:00', { unitId: 'ht1', position: 'engine', reason: 'planned' }),
  e('e2', 'installed', '2026-07-01 09:00', { unitId: 'ht1', position: 'engine' }),
  e('e3', 'sent_rebuild', '2026-07-03 08:00', { vendor: 'V2' }),
  e('e3', 'returned_rebuild', '2026-08-10 08:00'),
  // E4 onto HT2; a voided removal does not count.
  e('e4', 'installed', '2026-05-01 10:00', { unitId: 'ht2', position: 'engine' }),
  e('e4', 'removed', '2026-09-01 08:00', { unitId: 'ht2', position: 'engine', reason: 'failure', voidedAt: L('2026-09-01 09:00'), voidedBy: 'x', voidReason: 'wrong unit' }),
  // E5 sent straight to rebuild from stores: at rebuild, no cycle.
  e('e5', 'sent_rebuild', '2026-10-01 08:00', { vendor: 'V2' }),
  // T1 taken off for access and put back: not a change-out, not a cycle.
  e('t1', 'installed', '2025-01-03 08:00', { unitId: 'ht1', position: 'transmission' }),
  e('t1', 'removed', '2026-09-01 08:00', { unitId: 'ht1', position: 'transmission', reason: 'other' }),
  e('t1', 'installed', '2026-09-02 08:00', { unitId: 'ht1', position: 'transmission' }),
];
const now = L('2026-10-28 09:00');

describe('repair cycles', () => {
  it('runs from removal to back from rebuild, per model', () => {
    const c = repairCycles(components, events, assets);
    expect(c.map((x) => [x.componentId, Math.round(x.days), x.model])).toEqual([['e1', 60, '793F'], ['e2', 50, '793F'], ['e3', 40, '793F']]);
  });
});

describe('rebuild pool rows', () => {
  const states = componentStates(components, events, assets, smuIndex([]), now);
  it('worked example: 3 change-outs, 50 day cycle, pool of 3 is enough', () => {
    const rows = rebuildPoolRows({ states, events, assets, forecast: [], now, settings: DEFAULT_SPARES_SETTINGS });
    const eng = rows.find((r) => r.kind === 'engine')!;
    expect(eng).toMatchObject({ model: '793F', installed: 2, inStores: 2, atRebuild: 1, pool: 3, shared: 0, history: 3, forecast: 0, perYear: 3, cycles: 3, measured: true, needed: 3, verdict: 'enough' });
    // 60, 50 and 40 days; E1's cycle crosses the March clock change, so it is an hour short.
    const cycle = (60 - 1 / 24 + 50 + 40) / 3;
    expect(eng.cycleDays).toBeCloseTo(cycle, 9);
    const m = (3 * cycle) / 365;
    expect(eng.mean).toBeCloseTo(m, 12);
    // P(N ≤ 2)
    expect(eng.fillNow).toBeCloseTo(Math.exp(-m) * (1 + m + m ** 2 / 2), 10);
    const tr = rows.find((r) => r.kind === 'transmission')!;
    expect(tr).toMatchObject({ installed: 1, pool: 0, history: 0, verdict: 'none' });
    expect(rows.some((r) => r.model === '797F')).toBe(false);
  });
  it('uses the forecast, the default cycle and the target from settings', () => {
    const f = [{ unit: assets[0], position: { id: 'engine', kind: 'engine' }, due: new Date(Date.parse(now) + 100 * 86_400_000).toISOString() }] as unknown as ForecastRow[];
    const rows = rebuildPoolRows({ states, events, assets, forecast: f, now, settings: { ...DEFAULT_SPARES_SETTINGS, demandBasis: 'forecast', minCycles: 4 } });
    const eng = rows.find((r) => r.kind === 'engine')!;
    expect(eng).toMatchObject({ forecast: 1, perYear: 1, measured: false, cycleDays: 90, needed: 2, verdict: 'enough', gap: 1 });
    const strict = rebuildPoolRows({ states, events, assets, forecast: [], now, settings: { ...DEFAULT_SPARES_SETTINGS, fillTarget: 0.999 } }).find((r) => r.kind === 'engine')!;
    expect(strict.needed).toBe(4);
    expect(strict).toMatchObject({ verdict: 'short', gap: 1 });
  });
  it('counts a spare that fits several models for each, as shared', () => {
    const extra = [...components, comp('e9', 'engine', [])];
    const evs = [...events, e('e9', 'received', '2026-10-01 08:00', { receivedAs: 'new' })];
    const st = componentStates(extra, evs, assets, smuIndex([]), now);
    const eng = rebuildPoolRows({ states: st, events: evs, assets, forecast: [], now, settings: DEFAULT_SPARES_SETTINGS }).find((r) => r.kind === 'engine')!;
    expect(eng).toMatchObject({ pool: 4, shared: 1 });
  });
});

// ---------- PM parts and kits from RCM ----------

const re = ctx('reliability_engineer');
const base: ModeInput = {
  model: '793F', system: 'Engine', component: 'Fuel system', func: 'Deliver clean fuel', functionalFailure: 'Fuel starved', mode: 'Blocked',
  effect: 'Engine derates', consequence: 'operational', answers: { warning: true, wearOut: false }, taskType: 'on_condition', task: 'Change filters',
  intervalHours: 500, intervalBasis: 'OEM', craft: 'mech', people: 1, taskHours: 0.5, parts: [],
};
function lib(inputs: Array<Partial<ModeInput>>): RcmMode[] {
  let modes: RcmMode[] = [];
  for (const i of inputs) { const r = addMode(re, modes, { ...base, ...i }); if (!r.ok) throw new Error(r.errors.join(' ')); modes = r.records; }
  return modes;
}
const modes = lib([
  { component: 'Fuel filter', intervalHours: 500, parts: [{ itemNum: '1R-0750', description: 'Fuel filter', qty: 2 }] },
  { component: 'Fuel pump', intervalHours: 1000, parts: [{ itemNum: '1r-0750 ', description: '', qty: 1 }, { itemNum: '9X-1234', description: 'Seal', qty: 1 }] },
  { component: 'Belt', intervalHours: 250, parts: [] },
  { model: '797F', component: 'Fuel filter', intervalHours: 2000, parts: [{ itemNum: '1R-0750', description: 'Fuel filter', qty: 4 }] },
]);
const rate = (unitId: string, perDay: number | null, source: BurnRate['source'] = 'unit'): [string, BurnRate] => [unitId, { unitId, perDay, days: 28, source }];
const rates = new Map([rate('ht1', 20), rate('ht2', 16), rate('ht3', 18)]);

describe('PM parts from RCM', () => {
  it('fleet hours a year from burn rates; parked units count 0', () => {
    expect(fleetHoursPerYear(assets, rates, '793F')).toBeCloseTo(13140, 9);
    expect(fleetHoursPerYear(assets, new Map([rate('ht1', 20), rate('ht2', null, 'parked')]), '793F')).toBeCloseTo(7300, 9);
  });
  it('worked example: uses a year per item across tasks and models', () => {
    const d = pmPartDemand(modes, assets, rates, DEFAULT_RCM_SETTINGS);
    expect(d.map((x) => x.itemNum)).toEqual(['1R-0750', '9X-1234']);
    // 2 × 13,140 ÷ 500 + 1 × 13,140 ÷ 1,000 + 4 × 6,570 ÷ 2,000
    expect(d[0]!.perYear).toBeCloseTo(78.84, 9);
    expect(d[0]).toMatchObject({ models: ['793F', '797F'], tasks: 3, description: 'Fuel filter' });
    expect(d[1]!.perYear).toBeCloseTo(13.14, 9);
  });
  it('kit share: nested PMs take over the multiples of a larger level', () => {
    expect(kitShare(500, [250, 500, 1000], true)).toBe(0.5);
    expect(kitShare(1000, [250, 500, 1000], true)).toBe(1);
    expect(kitShare(250, [250, 500, 1000, 2000], true)).toBe(0.5);
    expect(kitShare(2000, [2000, 4000, 6000], true)).toBeCloseTo(2 / 6, 12);
    expect(kitShare(4000, [2000, 4000, 6000], true)).toBe(1);
    expect(kitShare(500, [250, 500, 1000], false)).toBe(1);
  });
  it('worked example: kits per job plan', () => {
    const k = pmKits(modes, assets, rates, DEFAULT_RCM_SETTINGS);
    expect(k.map((x) => x.jpnum)).toEqual(['793F-500', '793F-1000', '797F-2000']);
    expect(k[0]!.parts).toEqual([{ itemNum: '1R-0750', description: 'Fuel filter', qty: 2 }]);
    expect(k[0]!.perYear).toBeCloseTo(13.14, 9);
    expect(k[1]!.parts).toEqual([{ itemNum: '1R-0750', description: 'Fuel filter', qty: 3 }, { itemNum: '9X-1234', description: 'Seal', qty: 1 }]);
    expect(k[1]!.perYear).toBeCloseTo(13.14, 9);
    expect(k[2]!.perYear).toBeCloseTo(3.285, 9);
  });
});

describe('spares settings', () => {
  it('only edit_spares roles change them, with a reason', () => {
    const next = { ...DEFAULT_SPARES_SETTINGS, fillTarget: 0.9 };
    expect(setSparesSettings(ctx('supervisor'), DEFAULT_SPARES_SETTINGS, next, 'x').ok).toBe(false);
    expect(setSparesSettings(ctx('admin'), DEFAULT_SPARES_SETTINGS, next, 'x').ok).toBe(false);
    const r = setSparesSettings(re, DEFAULT_SPARES_SETTINGS, next, ' Site standard ');
    expect(r.ok && r.records[0]!.fillTarget).toBe(0.9);
    expect(r.ok && r.audit[0]).toMatchObject({ action: 'set_spares_settings', entity: 'settings', entityId: 'spares', reason: 'Site standard' });
    const bad = setSparesSettings(re, DEFAULT_SPARES_SETTINGS, { ...next, fillTarget: 1, minCycles: 0 }, '');
    expect(!bad.ok && bad.errors.length).toBe(3);
  });
  it('fills in defaults for a missing or partial value', () => {
    expect(withSparesDefaults(undefined)).toEqual(DEFAULT_SPARES_SETTINGS);
    expect(withSparesDefaults({ demandBasis: 'nonsense' as never, leadDays: 14 })).toEqual({ ...DEFAULT_SPARES_SETTINGS, leadDays: 14 });
  });
});

describe('demo fleet', () => {
  it('gives a pool row for each kind of both models', () => {
    const ds = generateFleet({ seed: 42, units: 40, days: 30, end: '2026-10-28T09:30:00.000Z' });
    const states = componentStates(ds.components, ds.componentEvents, ds.assets, smuIndex(ds.smu), ds.generatedAt);
    const rows = rebuildPoolRows({ states, events: ds.componentEvents, assets: ds.assets, forecast: [], now: ds.generatedAt, settings: DEFAULT_SPARES_SETTINGS });
    expect(new Set(rows.map((r) => r.model))).toEqual(new Set(['793F', '797F']));
    expect(rows.length).toBe(14);
    expect(rows.every((r) => r.perYear > 0 && r.measured)).toBe(true);
  });
});
