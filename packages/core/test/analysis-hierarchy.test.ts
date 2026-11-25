// System and component panel (docs/analysis-hierarchy.md): hierarchy, hide, minimum downtime. Hand-worked.

import { describe, expect, it } from 'vitest';
import { DEFAULT_FLAG_RULES } from '../src/config.js';
import { EMPTY_FILTER, analyse, paretoOf } from '../src/filters.js';
import { failureHierarchy, hideComponentKey, hideSystemKey, minHoursRows, withoutHidden } from '../src/analysis-hierarchy.js';
import { jackKnife, failuresOnly } from '../src/reliability.js';
import { twelveHourCalendar } from '../src/time.js';
import type { DownFlag } from '../src/types.js';
import { L, TZ, truck } from './helpers.js';

const cal = twelveHourCalendar(TZ);
let n = 0;
function flag(unit: string, start: string, hours: number, system: string, component?: string): DownFlag {
  const s = L(start);
  const e = new Date(Date.parse(s) + hours * 36e5).toISOString();
  return {
    id: `f${++n}`, tenantId: 't', siteId: 's', unitId: unit, type: 'unscheduled', state: 'released', reasonCode: system, system, start: s, end: e,
    stages: [{ stage: 'in_repair', start: s, end: e, setBy: 'x', enteredAt: s }], locations: [{ kind: 'field', start: s, end: e, fieldLocation: 'P', setBy: 'x', enteredAt: s }],
    etas: [], workOrders: ['1'], source: 'app', setBy: 'x', enteredAt: s,
    release: { system, ...(component ? { component } : {}), failureModes: ['Leak'], causeCode: 'Wear', repairSummary: 'r', workOrder: '1' },
  };
}

const NOW = L('2026-10-30 12:00');
// Hydraulics: Hose 10 h + 6 h, Cylinder 4 h, blank 2 h = 22 h, 4 events. Engine: Turbo 30 h, 1 event. Brakes: Valve 1 h, 1 event.
const flags = [
  flag('u1', '2026-10-05 08:00', 10, 'Hydraulics', 'Hose'), flag('u1', '2026-10-08 08:00', 6, 'Hydraulics', 'Hose'),
  flag('u2', '2026-10-09 08:00', 4, 'Hydraulics', 'Cylinder'), flag('u3', '2026-10-10 08:00', 2, 'Hydraulics'),
  flag('u2', '2026-10-12 08:00', 30, 'Engine', 'Turbo'), flag('u3', '2026-10-14 08:00', 1, 'Brakes', 'Valve'),
];
const a = analyse({ assets: ['u1', 'u2', 'u3'].map((id) => truck(id)), flags, smu: [], lifecycle: [], rules: DEFAULT_FLAG_RULES, now: NOW, calendar: cal, timeZone: TZ }, { ...EMPTY_FILTER, range: { from: '2026-10-01', to: '2026-10-29' } });

describe('failureHierarchy', () => {
  it('lists systems and components with events and hours, largest first', () => {
    const h = failureHierarchy(a);
    expect(h.map((s) => [s.key, s.events, Math.round(s.hours)])).toEqual([['Engine', 1, 30], ['Hydraulics', 4, 22], ['Brakes', 1, 1]]);
    expect(h[1]!.components.map((c) => [c.key, c.events, Math.round(c.hours)])).toEqual([['Hose', 2, 16], ['Cylinder', 1, 4], ['Not recorded', 1, 2]]);
  });

  it('leaves out groups under the minimum, at both levels', () => {
    const h = failureHierarchy(a, 3);
    expect(h.map((s) => s.key)).toEqual(['Engine', 'Hydraulics']);
    expect(h[1]!.components.map((c) => c.key)).toEqual(['Hose', 'Cylinder']);
  });
});

describe('withoutHidden', () => {
  it('hides a whole system, or just one component, and recalculates hours and failures', () => {
    const noEngine = withoutHidden(a, new Set([hideSystemKey('Engine')]));
    expect(Math.round(noEngine.downHours)).toBe(Math.round(a.downHours - 30));
    expect(noEngine.events.some((e) => e.flags.some((f) => f.system === 'Engine'))).toBe(false);
    const noHose = withoutHidden(a, new Set([hideComponentKey('Hydraulics', 'Hose')]));
    expect(Math.round(noHose.downHours)).toBe(Math.round(a.downHours - 16));
    expect(failureHierarchy(noHose).find((s) => s.key === 'Hydraulics')!.components.map((c) => c.key)).toEqual(['Cylinder', 'Not recorded']);
  });

  it('is the same object when nothing is hidden, and leaves the records alone', () => {
    expect(withoutHidden(a, new Set())).toBe(a);
    const before = a.events.length;
    withoutHidden(a, new Set([hideSystemKey('Engine')]));
    expect(a.events.length).toBe(before);
  });

  it('changes the jack-knife limits, which are over the groups that remain', () => {
    const rows = (x: typeof a) => paretoOf(failuresOnly(x), 'system', (id) => id);
    const all = jackKnife(rows(a));
    const hidden = jackKnife(rows(withoutHidden(a, new Set([hideSystemKey('Engine')]))));
    expect(all.eventLimit).toBe(2); // 6 events over 3 groups
    expect(hidden.eventLimit).toBe(2.5); // 5 events over 2 groups
    expect(hidden.points.map((p) => p.key)).toEqual(['Hydraulics', 'Brakes']);
  });
});

describe('minHoursRows', () => {
  const rows = paretoOf(a, 'system', (id) => id);
  it('drops small groups and recomputes the shares and the cumulative line', () => {
    const r = minHoursRows(rows, 5);
    expect(r.map((x) => x.key)).toEqual(['Engine', 'Hydraulics']);
    expect(r[0]!.share).toBeCloseTo(30 / 52, 6);
    expect(r[1]!.cumulative).toBeCloseTo(1, 9);
  });
  it('keeps everything with no minimum and copes with nothing left', () => {
    expect(minHoursRows(rows, 0).map((x) => x.key)).toEqual(rows.map((x) => x.key));
    expect(minHoursRows(rows, 1000)).toEqual([]);
  });
});
