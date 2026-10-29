// Repairable systems and system models, C-20 to C-24 (docs/calculators.md).
// Worked examples checked with SciPy 1.18 and a separate Python simulation.

import { describe, expect, it } from 'vitest';
import { availabilitySimulation, blockDiagram, crowAmsaa, fleetClock, kOfN, meanCumulativeFunction, trendTest, unitHistories } from '../src/calculators.js';
import type { DowntimeEvent } from '../src/kpis.js';
import type { SmuReading } from '../src/types.js';

const times = [120, 410, 750, 1300, 1900, 2700, 3600, 4800, 6100, 7600, 9300, 11200];

describe('C-20 Crow-AMSAA', () => {
  it('worked example, ends at a time', () => {
    const r = crowAmsaa({ times, end: 12000, endsAt: 'time', confidence: 0.9, ahead: 2000 });
    expect(r.values.beta).toBeCloseTo(0.6033474124285244, 10);
    expect(r.values.betaUnbiased).toBeCloseTo(0.5530684613928141, 10);
    expect(r.values.lambdaScale).toBeCloseTo(0.04149710468725825, 10);
    expect(r.values.betaLower).toBeCloseTo(0.34814214193139886, 6);
    expect(r.values.betaUpper).toBeCloseTo(0.9154547175031836, 6);
    expect(r.values.mtbfNow).toBeCloseTo(1657.4198867861478, 6);
    expect(r.values.cumulativeMtbf).toBe(1000);
    expect(r.values.expectedAhead).toBeCloseTo(1.1696252902607984, 9);
    expect(r.sentence).toMatch(/improving/);
    expect(r.points).toHaveLength(12);
  });
  it('worked example, ends at a failure', () => {
    const r = crowAmsaa({ times, endsAt: 'failure', confidence: 0.9 });
    expect(r.values.beta).toBeCloseTo(0.6295536341099311, 10);
    expect(r.values.betaLower).toBeCloseTo(0.3236434131574567, 6);
    expect(r.values.betaUpper).toBeCloseTo(0.8898855635348419, 6);
  });
  it('refuses data that ends before the last failure', () => {
    expect(() => crowAmsaa({ times, end: 11000, endsAt: 'time', confidence: 0.9 })).toThrow(/at or after the last failure/);
    expect(crowAmsaa({ times: [100, 900, 1500], end: 2000, endsAt: 'time', confidence: 0.9 }).warnings.join(' ')).toMatch(/Fewer than 5/);
  });
});

describe('C-21 trend test', () => {
  it('worked example: the tests disagree', () => {
    const r = trendTest({ times, end: 12000, endsAt: 'time', significance: 0.05 });
    expect(r.values.laplaceU).toBeCloseTo(-1.851666666666667, 10);
    expect(r.values.pLaplace).toBeCloseTo(0.0640737034074491, 6);
    expect(r.values.milChiSquare).toBeCloseTo(39.77807728286754, 9);
    expect(r.values.milDof).toBe(24);
    expect(r.values.pMil).toBeCloseTo(0.04517994067037713, 6);
    expect(r.verdict).toBe('improving');
    expect(r.sentence).toMatch(/disagree/);
  });
  it('a steady rate shows no trend; late failures show getting worse', () => {
    const even = Array.from({ length: 20 }, (_, k) => (k + 0.5) * 100);
    expect(trendTest({ times: even, end: 2000, endsAt: 'time', significance: 0.05 }).verdict).toBe('none');
    // Expected failures growing as t² (β = 2): the k-th at 2,000 × √((k + 0.5) ÷ 20).
    const late = Array.from({ length: 20 }, (_, k) => 2000 * Math.sqrt((k + 0.5) / 20));
    const r = trendTest({ times: late, end: 2000, endsAt: 'time', significance: 0.05 });
    expect(r.verdict).toBe('worse');
    expect(r.sentence).toMatch(/Both tests say the failure rate is getting worse/);
  });
});

describe('C-22 MCF', () => {
  const units = [
    { unit: 'U1', ages: [1000, 2500, 4000], end: 5000 },
    { unit: 'U2', ages: [1500, 3000], end: 3500 },
    { unit: 'U3', ages: [500, 2000, 4500, 5500], end: 6000 },
  ];
  it('worked example (Nelson, Lawless–Nadeau)', () => {
    const r = meanCumulativeFunction({ units, confidence: 0.9 });
    const at = (t: number) => r.points.find((p) => p.t === t)!;
    expect(at(500).mcf).toBeCloseTo(1 / 3, 12);
    expect(at(3000).mcf).toBeCloseTo(2, 12);
    expect(at(4000)).toMatchObject({ atRisk: 2 });
    expect(at(4000).mcf).toBeCloseTo(2.5, 12);
    expect(at(5500).mcf).toBeCloseTo(4, 12);
    expect(at(2500).se).toBeCloseTo(0.272166, 6);
    expect(at(4000).se).toBeCloseTo(0.353553, 6);
    expect(at(4000).lower).toBeLessThan(2.5);
    expect(r.values.failures).toBe(9);
    expect(r.sentence).toMatch(/1 unit watched there, too few for bounds/);
    // ROCOF bands of 1,200 h: 0 to 1,200 h has 2 failures on 3 units.
    expect(r.bands[0]!.rate).toBeCloseTo(2 / 3 / 1200, 12);
    expect(r.warnings.join(' ')).toMatch(/fewer than 3 units/);
  });
  it('refuses a failure after the end', () => {
    expect(() => meanCumulativeFunction({ units: [{ unit: 'X', ages: [10], end: 5 }], confidence: 0.9 })).toThrow(/after the end/);
  });
});

describe('C-23 block diagram', () => {
  const groups = [
    { name: 'Primary crusher', n: 1, k: 1, mtbf: 400, mttr: 8 },
    { name: 'Feed pumps', n: 3, k: 2, mtbf: 1000, mttr: 24 },
    { name: 'Conveyor CV-01', n: 1, k: 1, mtbf: 800, mttr: 4 },
  ];
  it('worked example', () => {
    const r = blockDiagram({ groups, mission: 24 });
    expect(r.values.systemAvailability).toBeCloseTo(0.9739321041730494, 12);
    expect(r.values.missionReliability).toBeCloseTo(0.9124136661569291, 12);
    expect(r.groups[1]!.groupA).toBeCloseTo(0.998377799987793, 12);
    expect(r.groups[0]!.ifPerfect).toBeCloseTo(0.9934107462565105, 12);
    expect(r.sentence).toMatch(/Primary crusher is the weak link/);
  });
  it('k-of-n', () => {
    expect(kOfN(2, 1, 0.9)).toBeCloseTo(0.99, 12);
    expect(kOfN(3, 3, 0.9)).toBeCloseTo(0.729, 12);
    expect(() => blockDiagram({ groups: [{ name: 'X', n: 2, k: 3, mtbf: 1, mttr: 1 }], mission: 1 })).toThrow(/from 1 to 2/);
  });
});

describe('C-24 availability simulation', () => {
  it('matches C-23 when failures are random (β = 1)', () => {
    const r = availabilitySimulation({ groups: [
      { name: 'Primary crusher', n: 1, k: 1, beta: 1, eta: 400, repair: 8 },
      { name: 'Feed pumps', n: 3, k: 2, beta: 1, eta: 1000, repair: 24 },
      { name: 'Conveyor CV-01', n: 1, k: 1, beta: 1, eta: 800, repair: 4 },
    ], period: 8760, runs: 2000, seed: 1 });
    expect(Math.abs(r.values.meanAvailability! - 0.9739321041730494)).toBeLessThan(0.0015);
    // Python reference, 20,000 runs: 33.1 outages a year.
    expect(Math.abs(r.values.meanOutages! - 33.1)).toBeLessThan(1);
  });
  it('matches the Python reference with wear-out', () => {
    const r = availabilitySimulation({ groups: [
      { name: 'Primary crusher', n: 1, k: 1, beta: 2, eta: 450, repair: 8 },
      { name: 'Feed pumps', n: 3, k: 2, beta: 1.5, eta: 1100, repair: 24 },
      { name: 'Conveyor CV-01', n: 1, k: 1, beta: 1, eta: 800, repair: 4 },
    ], period: 8760, runs: 2000, seed: 7 });
    expect(Math.abs(r.values.meanAvailability! - 0.97423)).toBeLessThan(0.0015);
    expect(Math.abs(r.values.p5Availability! - 0.96473)).toBeLessThan(0.002);
    expect(Math.abs(r.values.p95Availability! - 0.98261)).toBeLessThan(0.002);
    expect(Math.abs(r.values.meanOutages! - 32.85)).toBeLessThan(1);
    expect(r.histogram.reduce((a, b) => a + b.n, 0)).toBe(2000);
  });
  it('the same seed gives the same answer', () => {
    const g = [{ name: 'A', n: 1, k: 1, beta: 1.5, eta: 500, repair: 10 }];
    expect(availabilitySimulation({ groups: g, period: 2000, runs: 200, seed: 3 }).values).toEqual(availabilitySimulation({ groups: g, period: 2000, runs: 200, seed: 3 }).values);
    expect(() => availabilitySimulation({ groups: g, period: 2000, runs: 50, seed: 3 })).toThrow(/100 to 5,000/);
  });
});

describe('use my data', () => {
  const smu: SmuReading[] = [
    { unitId: 'a', at: '2026-10-01T00:00:00.000Z', hours: 1000 }, { unitId: 'a', at: '2026-10-11T00:00:00.000Z', hours: 1200 }, { unitId: 'a', at: '2026-10-21T00:00:00.000Z', hours: 1400 },
    { unitId: 'b', at: '2026-10-01T00:00:00.000Z', hours: 5000 }, { unitId: 'b', at: '2026-10-11T00:00:00.000Z', hours: 5100 }, { unitId: 'b', at: '2026-10-21T00:00:00.000Z', hours: 5200 },
  ];
  const ev = (unitId: string, start: string, isFailure = true) => ({ unitId, start, isFailure } as unknown as DowntimeEvent);
  const failures = [ev('a', '2026-10-11T00:00:00.000Z'), ev('b', '2026-10-21T00:00:00.000Z'), ev('b', '2026-10-15T00:00:00.000Z', false)];
  it('fleet clock adds up the units’ hours', () => {
    const c = fleetClock(failures, ['a', 'b'], smu, '2026-10-01T00:00:00.000Z', '2026-10-21T00:00:00.000Z');
    expect(c).toEqual({ times: [300, 600], end: 600 });
  });
  it('unit histories use each unit’s own hours', () => {
    const h = unitHistories(failures, [{ id: 'a', name: 'HT1' }, { id: 'b', name: 'HT2' }], smu, '2026-10-01T00:00:00.000Z', '2026-10-21T00:00:00.000Z');
    expect(h).toEqual([{ unit: 'HT1', ages: [200], end: 400 }, { unit: 'HT2', ages: [200], end: 200 }]);
  });
});
