// KPI-024 to KPI-027, hand-worked.

import { describe, expect, it } from 'vitest';
import { DEFAULT_FLAG_RULES } from '../src/config.js';
import { EMPTY_FILTER, analyse, paretoOf } from '../src/filters.js';
import { buildEvents } from '../src/kpis.js';
import { badActors, codingIssues, failuresOnly, codingQuality, jackKnife, repeatFailures } from '../src/reliability.js';
import { generateFleet } from '../src/synth/generate.js';
import { twelveHourCalendar } from '../src/time.js';
import type { DownFlag, ReleaseDetails } from '../src/types.js';
import { L, TZ, truck } from './helpers.js';

const cal = twelveHourCalendar(TZ);
let n = 0;
function failure(unit: string, start: string, hours: number, system: string, rel: Partial<ReleaseDetails> = {}): DownFlag {
  const s = L(start);
  const e = new Date(Date.parse(s) + hours * 36e5).toISOString();
  return {
    id: `f${++n}`, tenantId: 't', siteId: 's', unitId: unit, type: 'unscheduled', state: 'released', reasonCode: system, system, start: s, end: e,
    stages: [{ stage: 'in_repair', start: s, end: e, setBy: 'x', enteredAt: s }], locations: [{ kind: 'field', start: s, end: e, fieldLocation: 'P', setBy: 'x', enteredAt: s }],
    etas: [], workOrders: ['1'], source: 'app', setBy: 'x', enteredAt: s,
    release: { system, component: 'Hose', failureModes: ['Burst'], causeCode: 'Wear', repairSummary: 'r', workOrder: '1', ...rel },
  };
}

describe('KPI-024 jack-knife', () => {
  it('splits groups by the event limit and the mean duration limit', () => {
    // 4 groups, 20 events, 100 h: event limit 5, duration limit 5 h.
    const j = jackKnife([
      { key: 'Hydraulics', events: 10, hours: 30 }, // frequent, short: chronic
      { key: 'Engine', events: 2, hours: 40 }, // rare, long: acute
      { key: 'Tyres', events: 6, hours: 36 }, // frequent and long: both
      { key: 'Brakes', events: 2, hours: 6 }, // within
      { key: 'Nothing', events: 0, hours: 0 },
    ]);
    expect(j.eventLimit).toBe(5);
    expect(j.meanLimit).toBeCloseTo(5.6, 9); // 112 h / 20 events
    expect(Object.fromEntries(j.points.map((p) => [p.key, p.zone]))).toEqual({ Hydraulics: 'chronic', Engine: 'acute', Tyres: 'acute_chronic', Brakes: 'within' });
  });
});

describe('KPI-025 and 027 repeat failures and bad actors', () => {
  const t1 = truck('t1');
  const t2 = truck('t2');
  // t1 hydraulics: 1 Sep (before the period), 20 Sep (19 days later: repeat), 30 Oct (40 days later: not a repeat).
  // t1 engine 22 Sep: different system, not a repeat. t2 hydraulics 25 Sep: different unit.
  const flags = [
    failure('t1', '2026-09-01 08:00', 10, 'Hydraulics'), failure('t1', '2026-09-20 08:00', 5, 'Hydraulics'),
    failure('t1', '2026-09-22 08:00', 20, 'Engine'), failure('t2', '2026-09-25 08:00', 4, 'Hydraulics'), failure('t1', '2026-10-30 08:00', 3, 'Hydraulics'),
  ];
  const now = L('2026-11-01 00:00');
  const input = { assets: [t1, t2], flags, smu: [], rules: DEFAULT_FLAG_RULES, now, calendar: cal, timeZone: TZ };
  const a = analyse(input, { ...EMPTY_FILTER, range: { from: '2026-09-15', to: '2026-10-31' } });
  const history = buildEvents(flags, DEFAULT_FLAG_RULES, now);

  it('counts a failure on the same unit and system within the window of the last release', () => {
    const r = repeatFailures(a, history, 30);
    expect(r.failures).toBe(4);
    expect(r.repeats).toHaveLength(1);
    // 1 Sep 18:00 release to 20 Sep 08:00 = 18.58 days.
    expect(r.repeats[0]!.days).toBeCloseTo(18 + 14 / 24, 6);
    expect(r.share).toBe(0.25);
    expect(repeatFailures(a, history, 60).repeats).toHaveLength(2);
  });

  it('ranks units by down hours with their top system', () => {
    const r = repeatFailures(a, history, 30);
    const b = badActors(a, r.repeats);
    expect(b.map((x) => [x.unitId, x.hours, x.failures, x.repeats, x.topSystem])).toEqual([['t1', 28, 3, 1, 'Engine'], ['t2', 4, 1, 0, 'Hydraulics']]);
  });
});

describe('KPI-026 failure coding quality', () => {
  it('checks each release against the reference list', () => {
    expect(codingIssues(failure('t1', '2026-10-01 08:00', 1, 'Hydraulics'))).toEqual([]);
    expect(codingIssues(failure('t1', '2026-10-01 08:00', 1, 'Engine'))).toEqual(['component_mismatch']); // "Hose" is not an engine component
    expect(codingIssues(failure('t1', '2026-10-01 08:00', 1, 'Hydraulics', { component: 'Hoist cylinder' }))).toEqual([]);
    expect(codingIssues(failure('t1', '2026-10-01 08:00', 1, 'Hydraulics', { component: 'Other', failureModes: ['Unknown'], causeCode: undefined })))
      .toEqual(['component_other', 'mode_unknown', 'no_cause']);
    expect(codingIssues(failure('t1', '2026-10-01 08:00', 1, 'Hydraulics', { component: 'Turbocharger' }))).toEqual(['component_mismatch']);
  });

  it('scores by crew and shift at release, in site time', () => {
    const flags = [
      // Released 10:00 on 1 Oct (day shift) and 20:00 (night shift); the first is clean.
      failure('t1', '2026-10-01 08:00', 2, 'Hydraulics', { component: 'Hoist cylinder' }),
      failure('t1', '2026-10-01 16:00', 4, 'Hydraulics', { component: 'Other' }),
    ];
    const input = { assets: [truck('t1')], flags, smu: [], rules: DEFAULT_FLAG_RULES, now: L('2026-10-05 00:00'), calendar: cal, timeZone: TZ };
    const q = codingQuality(analyse(input, { ...EMPTY_FILTER, range: { from: '2026-10-01', to: '2026-10-04' } }), cal);
    expect([q.released, q.clean, q.score]).toEqual([2, 1, 0.5]);
    expect(q.byCheck.component_other).toBe(1);
    expect(q.byCrew.map((c) => [c.crew.endsWith('day'), c.crew.endsWith('night'), c.clean, c.released])).toEqual(
      q.byCrew[0]!.crew.endsWith('day') ? [[true, false, 1, 1], [false, true, 0, 1]] : [[false, true, 0, 1], [true, false, 1, 1]],
    );
  });

  it('the synthetic fleet has realistic coding gaps, and every number adds up to the Pareto', () => {
    const ds = generateFleet({ seed: 7, units: 40, days: 120, end: '2026-10-26T20:00:00.000Z' });
    const input = { assets: ds.assets, flags: ds.flags, smu: ds.smu, lifecycle: ds.lifecycle, rules: DEFAULT_FLAG_RULES, now: '2026-10-26T20:00:00.000Z', calendar: ds.calendar, timeZone: ds.site.timeZone };
    const a = analyse(input, { ...EMPTY_FILTER, range: { preset: '90d' } });
    const q = codingQuality(a, ds.calendar);
    expect(q.score).toBeGreaterThan(0.1);
    expect(q.score).toBeLessThan(0.9);
    const j = jackKnife(paretoOf(a, 'system', (x) => x));
    expect(j.points.reduce((s, p) => s + p.hours, 0)).toBeCloseTo(a.downHours, 6);
    // The jack-knife itself uses failures only: no PM group, and its hours add up to the failure events.
    const f = failuresOnly(a);
    const jf = jackKnife(paretoOf(f, 'system', (x) => x));
    expect(jf.points.some((p) => p.key === 'PM')).toBe(false);
    expect(jf.points.reduce((s, p) => s + p.hours, 0)).toBeCloseTo(f.downHours, 6);
    expect(f.downHours).toBeLessThan(a.downHours);
  });
});
