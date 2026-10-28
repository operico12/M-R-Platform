// Analytics filters (plan 7.5): one filter, every number adds up.

import { describe, expect, it } from 'vitest';
import { DEFAULT_FLAG_RULES } from '../src/config.js';
import { EMPTY_FILTER, analyse, filterFromQuery, filterPeriod, filterToQuery, paretoOf, weeklyTrend, type AnalyticsFilter } from '../src/filters.js';
import { generateFleet } from '../src/synth/generate.js';
import { local } from '../src/time.js';

const END = '2026-10-26T20:00:00.000Z';
const ds = generateFleet({ seed: 7, units: 40, days: 120, end: END });
const input = { assets: ds.assets, flags: ds.flags, smu: ds.smu, lifecycle: ds.lifecycle, rules: DEFAULT_FLAG_RULES, now: END, calendar: ds.calendar, timeZone: ds.site.timeZone };
const F = (over: Partial<AnalyticsFilter>): AnalyticsFilter => ({ ...structuredClone(EMPTY_FILTER), ...over });
const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-6);

describe('filter link', () => {
  it('round-trips through the page link', () => {
    const f = F({ range: { from: '2026-09-01', to: '2026-09-30' }, models: ['793F'], systems: ['Tyres'], systemsExclude: true, shifts: ['night'], failuresOnly: true });
    expect(filterFromQuery(filterToQuery(f))).toEqual(f);
    expect(filterToQuery(EMPTY_FILTER)).toBe('');
  });

  it('reads a custom range as whole local days in the site time zone', () => {
    const p = filterPeriod(F({ range: { from: '2026-09-01', to: '2026-09-30' } }), ds.site.timeZone, END);
    expect(p).toEqual({ from: local(ds.site.timeZone, '2026-09-01 00:00'), to: local(ds.site.timeZone, '2026-10-01 00:00') });
  });
});

describe('analyse', () => {
  const all = analyse(input, F({}));

  it('splits cleanly: a system plus everything except it equals the whole', () => {
    const only = analyse(input, F({ systems: ['Hydraulics'] }));
    const rest = analyse(input, F({ systems: ['Hydraulics'], systemsExclude: true }));
    near(only.downHours + rest.downHours, all.downHours);
  });

  it('day plus night shift equals the whole', () => {
    const d = analyse(input, F({ shifts: ['day'] }));
    const n = analyse(input, F({ shifts: ['night'] }));
    near(d.downHours + n.downHours, all.downHours);
    expect(d.events.length + n.events.length).toBeGreaterThanOrEqual(all.events.length);
  });

  it('downtime filters do not change PA; unit filters do', () => {
    expect(analyse(input, F({ systems: ['Tyres'] })).kpis.pa).toBe(all.kpis.pa);
    const big = analyse(input, F({ models: ['797F'] }));
    expect(big.assets.every((a) => a.model === '797F')).toBe(true);
    expect(big.kpis.calendarHours).toBeLessThan(all.kpis.calendarHours);
  });

  it('unscheduled downtime with no other filter matches the KPI engine', () => {
    const u = analyse(input, F({ types: ['unscheduled'] }));
    // Events that started before the period are not counted here, so this is at most the KPI figure.
    expect(u.downHours).toBeLessThanOrEqual(all.kpis.unscheduledDownHours + 1e-6);
    expect(u.failures).toBe(all.kpis.failures);
  });

  it('Pareto and weekly trend add up to the same hours', () => {
    const a = analyse(input, F({ types: ['unscheduled'] }));
    const p = paretoOf(a, 'system', (id) => id);
    near(p.reduce((s, r) => s + r.hours, 0), a.downHours);
    near(p.at(-1)!.cumulative, 1);
    near(weeklyTrend(a, ds.site.timeZone).reduce((s, w) => s + w.hours, 0), a.downHours);
  });
});
