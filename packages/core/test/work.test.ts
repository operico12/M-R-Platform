// Work and PM view, KPI-018 to KPI-023, hand-worked.

import { describe, expect, it } from 'vitest';
import type { ConsoleContext } from '../src/console.js';
import { MAXIMO_DEFAULT_MAPPING, importWorkOrders, parseCsv, toSourceCsv } from '../src/imports.js';
import { generateFleet } from '../src/synth/generate.js';
import { twelveHourCalendar } from '../src/time.js';
import type { Role, WorkOrder } from '../src/types.js';
import { DEFAULT_WORK_SETTINGS, aging, backlog, inspectionFinds, pmCompliance, pmsDue, readiness, scheduleCompliance, setWorkSettings, workMix } from '../src/work.js';
import { L, TZ } from './helpers.js';

let n = 0;
const wo = (over: Partial<WorkOrder>): WorkOrder => {
  const id = String(++n);
  return { id, tenantId: 't', siteId: 's', sourceSystem: 'maximo', sourceId: id, number: id, numberNormalised: id, workClass: 'corrective', open: true, ...over };
};
const pm = (due: string, done?: string, over: Partial<WorkOrder> = {}) =>
  wo({ workClass: 'pm', woType: 'PM', targetFinish: L(`${due} 23:59`), completedAt: done ? L(done) : undefined, open: !done, status: done ? 'COMP' : 'WSCH', ...over });

describe('KPI-018 PM compliance', () => {
  // October, tolerance 3 days. Due 5th done 7th (on time), due 10th done 14th 08:00 (late: limit is end of the 13th),
  // due 12th still open on the 20th (missed), due 25th open on the 26th (pending, inside tolerance), due 20th cancelled.
  const list = [
    pm('2026-10-05', '2026-10-07 10:00'), pm('2026-10-10', '2026-10-14 08:00'), pm('2026-10-12'), pm('2026-10-25'),
    pm('2026-10-20', undefined, { status: 'CAN', open: false }), pm('2026-09-30', '2026-10-01 08:00'),
  ];
  const oct = { from: L('2026-10-01 00:00'), to: L('2026-11-01 00:00') };
  it('counts on time, late, missed, and leaves pending PMs out', () => {
    const r = pmCompliance(list, oct, L('2026-10-26 09:00'), TZ);
    expect([r.due, r.onTime, r.late, r.missed, r.pending]).toEqual([3, 1, 1, 1, 1]);
    expect(r.value).toBeCloseTo(1 / 3, 9);
  });
  it('the tolerance is a setting, and ends at midnight site time', () => {
    const r = pmCompliance(list, oct, L('2026-10-26 09:00'), TZ, { ...DEFAULT_WORK_SETTINGS, pmToleranceDays: 4 });
    expect(r.onTime).toBe(2);
    // Done 23:30 site time on the last tolerance day is on time, even though it is the next day in UTC.
    expect(pmCompliance([pm('2026-10-05', '2026-10-08 23:30')], oct, L('2026-10-26 09:00'), TZ).onTime).toBe(1);
    expect(pmCompliance([pm('2026-10-05', '2026-10-09 00:01')], oct, L('2026-10-26 09:00'), TZ).late).toBe(1);
  });
});

describe('KPI-019 schedule compliance', () => {
  it('weekly from Monday 00:00 site time, judged once the week ends', () => {
    // Week of Mon 12 Oct: three scheduled; one done on the day, one done the next day (late), one not done.
    const list = [
      wo({ scheduledStart: L('2026-10-13 07:00'), scheduledFinish: L('2026-10-13 15:00'), completedAt: L('2026-10-13 22:00') }),
      wo({ scheduledStart: L('2026-10-14 07:00'), scheduledFinish: L('2026-10-14 15:00'), completedAt: L('2026-10-15 09:00') }),
      wo({ scheduledStart: L('2026-10-18 23:00') }),
      wo({ scheduledStart: L('2026-10-19 00:00'), completedAt: L('2026-10-19 05:00') }),
    ];
    const weeks = scheduleCompliance(list, { from: L('2026-10-12 00:00'), to: L('2026-10-26 00:00') }, L('2026-10-22 12:00'), TZ);
    expect(weeks).toHaveLength(1);
    expect(weeks[0]).toMatchObject({ week: '12 Oct', scheduled: 3, done: 1 });
  });
});

describe('KPI-020 planned and emergency work', () => {
  it('uses actual labour hours, else the estimate; emergency by type or priority', () => {
    const p = { from: L('2026-10-01 00:00'), to: L('2026-11-01 00:00') };
    const list = [
      wo({ woType: 'PM', workClass: 'pm', completedAt: L('2026-10-02 10:00'), actualLabourHours: 30, estimatedHours: 20 }),
      wo({ woType: 'EM', completedAt: L('2026-10-03 10:00'), actualLabourHours: 6 }),
      wo({ woType: 'CM', priority: '1', completedAt: L('2026-10-04 10:00'), estimatedHours: 4 }),
      wo({ woType: 'CM', completedAt: L('2026-10-05 10:00') }),
      wo({ woType: 'CM', completedAt: L('2026-09-05 10:00'), actualLabourHours: 99 }),
    ];
    const m = workMix(list, p);
    expect(m).toMatchObject({ finished: 4, hours: 40, emergencyHours: 10, noHours: 1 });
    expect(m.plannedShare).toBeCloseTo(0.75, 9);
    expect(workMix(list, p, { ...DEFAULT_WORK_SETTINGS, emergencyPriorities: [] }).emergencyHours).toBe(6);
  });
});

describe('KPI-021 backlog', () => {
  it('splits ready from waiting, and needs craft hours to give weeks', () => {
    const list = [
      wo({ status: 'APPR', estimatedHours: 10 }), wo({ status: 'WSCH', estimatedHours: 30 }), wo({ status: 'WMATL', estimatedHours: 8 }),
      wo({ status: 'WAPPR', estimatedHours: 12 }), wo({ status: 'INPRG', estimatedHours: 20 }), wo({ status: 'APPR' }),
      wo({ status: 'COMP', open: false, estimatedHours: 500 }), wo({ status: 'ODD', estimatedHours: 5 }),
    ];
    const b = backlog(list);
    expect(b).toMatchObject({ open: 7, readyHours: 40, waitingHours: 25, readyWeeks: null });
    expect(b.noEstimate).toHaveLength(1);
    expect(b.count.unknown).toBe(1);
    const w = backlog(list, { ...DEFAULT_WORK_SETTINGS, craftHoursPerWeek: 20 });
    expect(w.readyWeeks).toBe(2);
    expect(w.totalWeeks).toBe(4.25);
    expect(readiness(wo({ status: 'wmatl' }))).toBe('waiting_parts');
  });
});

describe('KPI-022 and 023', () => {
  it('counts corrective work raised from PMs and inspections', () => {
    const p = { from: L('2026-10-01 00:00'), to: L('2026-11-01 00:00') };
    const a = wo({ workClass: 'pm', number: 'PM-0042', numberNormalised: '42' });
    const i = wo({ workClass: 'inspection', number: '77', numberNormalised: '77' });
    const list = [a, i,
      wo({ reportedAt: L('2026-10-03 10:00'), originWorkOrder: 'PM-42' }), wo({ reportedAt: L('2026-10-04 10:00'), originWorkOrder: '0077' }),
      wo({ reportedAt: L('2026-10-05 10:00'), originWorkOrder: '999' }), wo({ reportedAt: L('2026-10-06 10:00') }),
    ];
    expect(inspectionFinds(list, p)).toMatchObject({ corrective: 4, fromInspection: 2, value: 0.5 });
  });

  it('ages open work from when it was reported', () => {
    const now = L('2026-10-26 09:00');
    const ag = aging([
      wo({ reportedAt: L('2026-10-20 09:00'), status: 'APPR' }), wo({ reportedAt: L('2026-10-18 08:00'), status: 'WMATL' }),
      wo({ reportedAt: L('2026-07-01 00:00'), status: 'WMATL' }), wo({ reportedAt: L('2026-07-01 00:00'), open: false }),
    ], now);
    expect(ag.map((x) => x.count)).toEqual([1, 1, 0, 1]);
    expect(ag[3]!.by).toEqual({ waiting_parts: 1 });
  });

  it('lists PMs due in the next 7 site days and those overdue', () => {
    const now = L('2026-10-26 09:00');
    const d = pmsDue([pm('2026-10-24'), pm('2026-10-26'), pm('2026-11-02'), pm('2026-11-03'), pm('2026-10-20', '2026-10-20 10:00')], now, TZ);
    expect(d.map((x) => [x.wo.targetFinish!.slice(0, 10), x.overdue])).toEqual([[L('2026-10-24 23:59').slice(0, 10), true], [L('2026-10-26 23:59').slice(0, 10), false], [L('2026-11-02 23:59').slice(0, 10), false]]);
  });
});

describe('work settings and import', () => {
  const ctx = (role: Role): ConsoleContext => ({ actor: { userId: `u-${role}`, role, scope: ['*'] }, now: L('2026-10-26 09:00'), newId: () => 'x', timeZone: TZ, calendar: twelveHourCalendar(TZ) });
  it('reliability engineers and superintendents set them, with a reason', () => {
    const next = { ...DEFAULT_WORK_SETTINGS, craftHoursPerWeek: 480, emergencyTypes: ['em', ' bd ', 'EM'] };
    expect(setWorkSettings(ctx('supervisor'), DEFAULT_WORK_SETTINGS, next, 'r').ok).toBe(false);
    expect(setWorkSettings(ctx('reliability_engineer'), DEFAULT_WORK_SETTINGS, next, '').ok).toBe(false);
    const r = setWorkSettings(ctx('superintendent'), DEFAULT_WORK_SETTINGS, next, 'Two crews of six, 40 h each');
    expect(r.ok && r.records[0]!.emergencyTypes).toEqual(['EM', 'BD']);
    expect(r.ok && r.audit[0]!.entity).toBe('settings');
  });

  it('the planning columns round-trip through a Maximo-style export, including future due dates', () => {
    const ds = generateFleet({ seed: 3, units: 12, days: 40, end: '2026-10-26T20:00:00.000Z' });
    expect(ds.workOrders.some((w) => w.targetFinish && w.targetFinish > ds.generatedAt)).toBe(true);
    expect(ds.workOrders.some((w) => w.originWorkOrder)).toBe(true);
    const csv = toSourceCsv(ds, ds.site.timeZone);
    const r = importWorkOrders(parseCsv(csv.workOrders), ds.workOrders, ds.assets, { now: ds.generatedAt, timeZone: ds.site.timeZone, tenantId: ds.tenantId, siteId: ds.site.id, mapping: MAXIMO_DEFAULT_MAPPING, newId: () => 'new' });
    expect(r.stats.updated).toBe(0);
    expect(r.stats.unchanged).toBe(ds.workOrders.length);
  });
});
