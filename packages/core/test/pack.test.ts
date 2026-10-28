// Weekly pack (MVP screen 5): same numbers as the KPI engine, weeks in site time.

import { describe, expect, it } from 'vitest';
import { DEFAULT_FLAG_RULES } from '../src/config.js';
import { computeKpis } from '../src/kpis.js';
import { weeklyPack } from '../src/pack.js';
import { generateFleet } from '../src/synth/generate.js';
import { local } from '../src/time.js';

const END = '2026-10-26T20:00:00.000Z'; // Monday 26 Oct, 13:00 in Vancouver
const ds = generateFleet({ seed: 7, units: 40, days: 120, end: END });
const tz = ds.site.timeZone;
const base = {
  assets: ds.assets, flags: ds.flags, smu: ds.smu, lifecycle: ds.lifecycle, rules: DEFAULT_FLAG_RULES, now: END,
  timeZone: tz, siteName: ds.site.name, fleetName: 'Haul trucks', shopLines: ds.shopLines, closures: ds.closures, targets: { pa: 0.9, utilisation: 0.85 },
};

describe('weekly pack', () => {
  const pack = weeklyPack({ ...base, weekOf: local(tz, '2026-10-21 12:00') });

  it('runs Monday 00:00 to Monday 00:00 site time', () => {
    expect(pack.week.from).toBe(local(tz, '2026-10-19 00:00'));
    expect(pack.week.to).toBe(local(tz, '2026-10-26 00:00'));
    expect(pack.partial).toBe(false);
  });

  it('uses the same numbers as the dashboard', () => {
    const k = computeKpis(base, pack.week);
    expect(pack.kpis.pa).toBe(k.pa);
    expect(pack.kpis.mtbf).toBe(k.mtbf);
    expect(pack.trend.at(-1)!.pa).toBe(k.pa);
    expect(pack.trend).toHaveLength(12);
  });

  it('splits all downtime into downline, repair and waiting', () => {
    const t = pack.timeSplit;
    expect(t.downline + t.repair + t.waitingParts + t.waitingOther + t.ready).toBeCloseTo(pack.kpis.downHours, 6);
  });

  it('lists at most ten bad actors, worst first', () => {
    expect(pack.badActors.length).toBeLessThanOrEqual(10);
    for (let i = 1; i < pack.badActors.length; i++) expect(pack.badActors[i - 1]!.unscheduledDownHours).toBeGreaterThanOrEqual(pack.badActors[i]!.unscheduledDownHours);
  });

  it('marks the current week as partial and stops at now', () => {
    const cur = weeklyPack({ ...base, weekOf: END });
    expect(cur.partial).toBe(true);
    expect(cur.week.to).toBe(END);
    expect(cur.notes[0]).toMatch(/Week in progress/);
  });
});
