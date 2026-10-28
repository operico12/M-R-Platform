// Calculator library, docs/calculators.md. Each worked example there is checked here;
// the expected numbers came from SciPy 1.18 (see the doc).

import { describe, expect, it } from 'vitest';
import type { ConsoleContext } from '../src/console.js';
import {
  CalcError, availabilityTarget, chiSquareQuantile, conditionalWeibull, costPerHour, downtimeCost, inherentAvailability, mtbfConfidence,
  lifeData, mtbfRate, normalQuantile, percentile, repairBySystem, repairTimes, riskMatrix, saveAnalysis, searchCalculators, voidAnalysis, weibull, CALCULATORS,
} from '../src/calculators.js';
import type { DowntimeEvent } from '../src/kpis.js';
import type { Role, SmuReading } from '../src/types.js';
import { L, TZ, cal } from './helpers.js';

let n = 0;
const ctx = (role: Role, userId = `u-${role}`): ConsoleContext => ({ actor: { userId, role, scope: ['*'] }, now: L('2026-10-28 09:00'), newId: () => `a${++n}`, timeZone: TZ, calendar: cal });

describe('maths helpers against SciPy', () => {
  it('chi-square quantiles', () => {
    expect(chiSquareQuantile(0.9, 6)).toBeCloseTo(10.6446, 3);
    expect(chiSquareQuantile(0.9, 4)).toBeCloseTo(7.7794, 3);
    expect(chiSquareQuantile(0.9, 2)).toBeCloseTo(4.6052, 3);
    expect(chiSquareQuantile(0.95, 20)).toBeCloseTo(31.4104, 3);
    expect(chiSquareQuantile(0.6, 1)).toBeCloseTo(0.7083, 3);
  });
  it('normal quantiles', () => {
    expect(normalQuantile(0.95)).toBeCloseTo(1.644854, 5);
    expect(normalQuantile(0.975)).toBeCloseTo(1.959964, 5);
    expect(normalQuantile(0.01)).toBeCloseTo(-2.326348, 5);
  });
  it('percentile is linear between ranks', () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentile([5], 0.9)).toBe(5);
  });
});

describe('C-01 to C-03', () => {
  it('C-01 inherent availability', () => {
    expect(inherentAvailability({ mtbf: 120, mttr: 6 }).values.availability).toBeCloseTo(0.9524, 4);
    expect(() => inherentAvailability({ mtbf: 0, mttr: 6 })).toThrow(CalcError);
  });
  it('C-02 target solver both ways', () => {
    expect(availabilityTarget({ target: 0.92, mttr: 8 }).values.requiredMtbf).toBeCloseTo(92, 6);
    expect(availabilityTarget({ target: 0.92, mtbf: 60 }).values.maxMttr).toBeCloseTo(5.217, 3);
    expect(() => availabilityTarget({ target: 1, mttr: 8 })).toThrow(CalcError);
    expect(() => availabilityTarget({ target: 0.9, mttr: 8, mtbf: 60 })).toThrow(/either/);
  });
  it('C-03 cost of downtime', () => {
    expect(downtimeCost({ tonnesPerHour: 250, marginPerTonne: 12, otherPerHour: 300 }).values.perHour).toBe(3300);
  });
});

describe('C-04 MTBF confidence', () => {
  it('ends at a time (field data)', () => {
    const r = mtbfConfidence({ hours: 1000, failures: 2, confidence: 0.9, endsAt: 'time' });
    expect(r.values.lower).toBeCloseTo(187.9, 1);
    expect(r.values.point).toBe(500);
    expect(r.values.dof).toBe(6);
    expect(r.warnings).toHaveLength(1);
  });
  it('ends at a failure', () => {
    expect(mtbfConfidence({ hours: 1000, failures: 2, confidence: 0.9, endsAt: 'failure' }).values.lower).toBeCloseTo(257.1, 1);
  });
  it('no failures gives a limit and no point estimate', () => {
    const r = mtbfConfidence({ hours: 1000, failures: 0, confidence: 0.9, endsAt: 'time' });
    expect(r.values.lower).toBeCloseTo(434.3, 1);
    expect(r.values.point).toBeNull();
    expect(() => mtbfConfidence({ hours: 1000, failures: 0, confidence: 0.9, endsAt: 'failure' })).toThrow(CalcError);
  });
  it('no warning from 5 failures', () => {
    expect(mtbfConfidence({ hours: 5000, failures: 5, confidence: 0.9, endsAt: 'time' }).warnings).toEqual([]);
  });
});

describe('C-05 Weibull with suspensions', () => {
  const data = [
    ...[1200, 1850, 2400, 3100, 3900, 4600, 5800].map((t) => ({ t, failed: true })),
    ...[2000, 3500, 5000, 6000].map((t) => ({ t, failed: false })),
  ];
  it('matches the SciPy fit and Fisher bounds', () => {
    const w = weibull(data, 0.9);
    expect(w.beta).toBeCloseTo(2.155, 2);
    expect(w.eta / 4868).toBeCloseTo(1, 3);
    expect(w.betaBounds[0]).toBeCloseTo(1.289, 2);
    expect(w.betaBounds[1]).toBeCloseTo(3.605, 2);
    expect(w.etaBounds[0] / 3643).toBeCloseTo(1, 2);
    expect(w.etaBounds[1] / 6504).toBeCloseTo(1, 2);
    expect(w.b10 / 1714).toBeCloseTo(1, 2);
    expect(w.plot).toHaveLength(7);
    expect(w.plot.every((p, i, a) => i === 0 || p.f > a[i - 1]!.f)).toBe(true);
    expect(w.sentence).toMatch(/wear/i);
  });
  it('the same fit whatever the units of time', () => {
    const w = weibull(data.map((d) => ({ ...d, t: d.t / 1000 })));
    expect(w.beta).toBeCloseTo(2.155, 2);
    expect(w.eta).toBeCloseTo(4.868, 2);
  });
  it('needs 2 failures and warns under 5', () => {
    expect(() => weibull([{ t: 100, failed: true }, { t: 200, failed: false }])).toThrow(/2 failures/);
    expect(weibull([{ t: 100, failed: true }, { t: 300, failed: true }, { t: 200, failed: false }]).warnings.join(' ')).toMatch(/fail/);
  });
});

describe('C-06 to C-10', () => {
  it('C-06 conditional Weibull', () => {
    const r = conditionalWeibull({ beta: 2.1553, eta: 4867.9, age: 3000, mission: 1000 });
    expect(r.values.reliability).toBeCloseTo(0.7389, 3);
    expect(r.values.medianRemaining! / 1969).toBeCloseTo(1, 2);
  });
  it('C-07 repair times', () => {
    const r = repairTimes([1.5, 2, 2.5, 3, 4, 4.5, 6, 8, 12, 30]);
    expect(r.values.mean).toBeCloseTo(7.35, 6);
    expect(r.values.median).toBeCloseTo(4.25, 6);
    expect(r.values.p90).toBeCloseTo(13.8, 6);
    expect(r.warnings).toEqual([]);
    expect(r.histogram.reduce((s, b) => s + b.n, 0)).toBe(10);
    expect(repairTimes([1, 2, 3]).warnings).toHaveLength(1);
  });
  it('C-08 risk matrix bands', () => {
    expect(riskMatrix({ likelihood: 4, consequence: 4 })).toMatchObject({ values: { score: 16 }, band: 'High' });
    expect(riskMatrix({ likelihood: 2, consequence: 2 }).band).toBe('Low');
    expect(riskMatrix({ likelihood: 3, consequence: 3 }).band).toBe('Medium');
    expect(riskMatrix({ likelihood: 5, consequence: 4 }).band).toBe('Extreme');
    expect(() => riskMatrix({ likelihood: 6, consequence: 1 })).toThrow(CalcError);
  });
  it('C-09 cost per hour of life', () => {
    expect(costPerHour({ purchase: 180000, fitting: 6000, rebuilds: [45000, 45000], hours: 24000 }).values.perHour).toBe(11.5);
  });
  it('C-10 MTBF and failure rate', () => {
    const r = mtbfRate({ mtbf: 500, mission: 100 });
    expect(r.values.lambda).toBe(0.002);
    expect(r.values.perMillion).toBe(2000);
    expect(r.values.reliability).toBeCloseTo(0.8187, 4);
  });
});

describe('catalogue and saved analyses', () => {
  it('search matches every word', () => {
    expect(searchCalculators('weibull').map((c) => c.code)).toEqual(['C-05', 'C-06']);
    expect(searchCalculators('C-07')[0]!.id).toBe('repair_times');
    expect(searchCalculators('')).toHaveLength(CALCULATORS.length);
  });
  const input = { calculator: 'inherent_availability' as const, title: ' 793F engine ', inputs: { mtbf: 120, mttr: 6 }, result: { availability: 0.9524 }, sentence: 's', dataNote: 'Typed in', links: {} };
  it('supervisor, RE and superintendent can save; others cannot', () => {
    expect(saveAnalysis(ctx('technician'), [], input).ok).toBe(false);
    expect(saveAnalysis(ctx('viewer'), [], input).ok).toBe(false);
    const r = saveAnalysis(ctx('reliability_engineer'), [], input);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.records[0]).toMatchObject({ title: '793F engine', version: 1, createdBy: 'u-reliability_engineer' });
    expect(r.audit[0]).toMatchObject({ entity: 'analysis', action: 'save_analysis' });
  });
  it('void needs a reason and keeps the record', () => {
    const s = saveAnalysis(ctx('supervisor'), [], input);
    if (!s.ok) throw new Error('save');
    const id = s.records[0]!.id;
    expect(voidAnalysis(ctx('supervisor'), s.records, id, ' ').ok).toBe(false);
    const v = voidAnalysis(ctx('superintendent'), s.records, id, 'Wrong unit');
    expect(v.ok && v.records).toHaveLength(1);
    expect(v.ok && v.records[0]!.voidReason).toBe('Wrong unit');
    expect(voidAnalysis(ctx('superintendent'), v.ok ? v.records : [], id, 'again').ok).toBe(false);
  });
});

describe('use my data', () => {
  const smu: SmuReading[] = [
    { unitId: 'u1', at: '2026-01-01T00:00:00Z', hours: 10000 }, { unitId: 'u1', at: '2026-02-01T00:00:00Z', hours: 10500 },
    { unitId: 'u1', at: '2026-03-01T00:00:00Z', hours: 11100 }, { unitId: 'u1', at: '2026-04-01T00:00:00Z', hours: 11400 },
    { unitId: 'u2', at: '2026-01-01T00:00:00Z', hours: 2000 }, { unitId: 'u2', at: '2026-04-01T00:00:00Z', hours: 2800 },
  ];
  const ev = (unitId: string, start: string, isFailure = true) => ({ id: start, unitId, start, end: start, flags: [], startType: 'unscheduled', isFailure, isMinorStop: false }) as unknown as DowntimeEvent;
  it('lives between failures from SMU, then a suspension to the end', () => {
    const lives = lifeData([ev('u1', '2026-02-01T00:00:00Z'), ev('u1', '2026-03-01T00:00:00Z'), ev('u1', '2026-03-15T00:00:00Z', false)], ['u1', 'u2', 'u3'], smu, '2026-01-01T00:00:00Z', '2026-04-01T00:00:00Z');
    expect(lives).toEqual([{ t: 500, failed: true }, { t: 600, failed: true }, { t: 300, failed: false }, { t: 800, failed: false }]);
  });
  it('repairs by system hide small groups', () => {
    const rows = [...[1, 2, 3, 4, 10].map((hours) => ({ system: 'Engine', hours })), { system: 'Brakes', hours: 5 }];
    const g = repairBySystem(rows);
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ system: 'Engine', count: 5, median: 3 });
    expect(g[0]!.p90).toBeCloseTo(7.6, 9);
  });
});
