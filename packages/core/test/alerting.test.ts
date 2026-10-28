// Reliability and threshold alerts, docs/alert-rules.md RA-1 to RA-6, TA-1 and TA-2. Hand-worked.

import { describe, expect, it } from 'vitest';
import { DEFAULT_ALERT_SETTINGS, answerAlert, openAlerts, ruleAlerts, setAlertSettings, withAlertDefaults, type AlertingInput, type RuleAlert } from '../src/alerting.js';
import { DEFAULT_FLAG_RULES } from '../src/config.js';
import type { ConsoleContext, Target } from '../src/console.js';
import type { DownFlag, ReleaseDetails, Role, SmuReading, WorkOrder } from '../src/types.js';
import { L, TZ, cal, truck } from './helpers.js';

let n = 0;
function failure(unit: string, start: string, hours: number | null, system: string, rel: Partial<ReleaseDetails> = {}, type: DownFlag['type'] = 'unscheduled'): DownFlag {
  const s = L(start);
  const e = hours === null ? null : new Date(Date.parse(s) + hours * 36e5).toISOString();
  return {
    id: `f${++n}`, tenantId: 't', siteId: 's', unitId: unit, type, state: e ? 'released' : 'open', reasonCode: system, system, start: s, end: e,
    stages: [{ stage: 'in_repair', start: s, end: e, setBy: 'x', enteredAt: s }], locations: [{ kind: 'field', start: s, end: e, fieldLocation: 'P', setBy: 'x', enteredAt: s }],
    etas: [], workOrders: [], source: 'app', setBy: 'x', enteredAt: s,
    release: e ? { system, component: 'Hose', failureModes: ['Burst'], causeCode: 'Wear', repairSummary: 'r', workOrder: '1', ...rel } : undefined,
  };
}

/** One reading every 12 h, rising `perShift` h each time (ignores downtime; the rules only compare readings). */
function smu(unit: string, from: string, to: string, perShift: number): SmuReading[] {
  const out: SmuReading[] = [];
  let h = 1000;
  for (let t = Date.parse(L(from)); t <= Date.parse(L(to)); t += 12 * 36e5) { out.push({ unitId: unit, at: new Date(t).toISOString(), hours: h }); h += perShift; }
  return out;
}

const NOW = L('2026-11-01 00:00');
const base = (over: Partial<AlertingInput>): AlertingInput => ({
  assets: [truck('t1'), truck('t2'), truck('t3'), truck('t4')], flags: [], smu: [], rules: DEFAULT_FLAG_RULES, now: NOW, timeZone: TZ, workOrders: [], targets: [], ...over,
});
const only = (k: RuleAlert['kind'], input: AlertingInput, s = DEFAULT_ALERT_SETTINGS) => ruleAlerts(input, s).filter((a) => a.kind === k);

describe('RA-1 repeat offender', () => {
  const flags = [
    failure('t1', '2026-09-20 08:00', 5, 'Hydraulics'), // 42 days before now: outside
    failure('t1', '2026-10-05 08:00', 2, 'Hydraulics'), failure('t1', '2026-10-15 08:00', 3, 'Hydraulics'), failure('t1', '2026-10-25 08:00', 4, 'Hydraulics'),
    failure('t1', '2026-10-10 08:00', 2, 'Engine'), failure('t1', '2026-10-20 08:00', 2, 'Engine'),
    failure('t2', '2026-10-21 08:00', 2, 'Hydraulics'),
  ];
  it('three failures on one unit and system in 30 days', () => {
    const a = only('repeat_offender', base({ flags }));
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ unitId: 't1', system: 'Hydraulics', basedOn: '3 failures', key: `repeat_offender:t1:Hydraulics:${flags[3]!.id}` });
    expect(a[0]!.detail).toContain('9.0 h down in total');
    expect(a[0]!.query).toContain('from=2026-10-02');
  });
  it('the count and days are settings', () => {
    expect(only('repeat_offender', base({ flags }), { ...DEFAULT_ALERT_SETTINGS, repeatOffender: { enabled: true, failures: 4, days: 30 } })).toHaveLength(0);
    expect(only('repeat_offender', base({ flags }), { ...DEFAULT_ALERT_SETTINGS, repeatOffender: { enabled: true, failures: 4, days: 45 } })).toHaveLength(1);
    expect(only('repeat_offender', base({ flags }), { ...DEFAULT_ALERT_SETTINGS, repeatOffender: { enabled: false, failures: 3, days: 30 } })).toHaveLength(0);
  });
});

describe('RA-2 MTBF drop', () => {
  // Two trucks, each 20 operating h a day. Baseline 6 Jul to 4 Oct (90 days): 3,600 h, 4 failures, MTBF 900 h.
  // Last 28 days: readings run to 18:00 on 31 Oct, so 1,110 h, 5 failures, MTBF 222 h: down 75%.
  const readings = [...smu('t1', '2026-07-01 06:00', '2026-10-31 18:00', 10), ...smu('t2', '2026-07-01 06:00', '2026-10-31 18:00', 10)];
  const baseline = ['2026-07-20', '2026-08-10', '2026-09-01', '2026-09-20'].map((d, i) => failure(i % 2 ? 't2' : 't1', `${d} 08:00`, 1, 'Engine'));
  const recent = ['2026-10-06', '2026-10-11', '2026-10-16', '2026-10-21', '2026-10-26'].map((d, i) => failure(i % 2 ? 't2' : 't1', `${d} 08:00`, 1, ['Engine', 'Tyres', 'Brakes', 'Cooling', 'Steering'][i]!));
  const input = base({ assets: [truck('t1'), truck('t2')], smu: readings, flags: [...baseline, ...recent] });
  it('fires when the recent MTBF is 25% or more below the baseline', () => {
    const a = only('mtbf_drop', input);
    expect(a).toHaveLength(1);
    expect(a[0]!.title).toBe('793F: MTBF down 75%');
    expect(a[0]!.detail).toContain('222 h over the last 28 days (5 failures in 1110 operating h), against 900 h');
    expect(a[0]!.key).toBe('mtbf_drop:793F:2026-10-26'); // site week starts Monday 26 Oct
  });
  it('needs the minimum failures in the recent window', () => {
    expect(only('mtbf_drop', { ...input, flags: [...baseline, ...recent.slice(1)] })).toHaveLength(0);
  });
});

describe('RA-3 repair time spike', () => {
  // Hydraulics failures in the 90 days before: 2, 3, 4, 5, 6 h, and 30 h on 10 Oct. Median 4.5 h, so 13.5 h or more is a spike.
  const earlier = [2, 3, 4, 5, 6].map((h, i) => failure(`t${(i % 4) + 1}`, `2026-09-${10 + i} 08:00`, h, 'Hydraulics'));
  it('compares down hours with the median of earlier failures on the same system', () => {
    const old = failure('t4', '2026-10-10 08:00', 30, 'Hydraulics'); // a spike too, but it ended more than 7 days ago
    const spike = failure('t1', '2026-10-28 08:00', 14, 'Hydraulics');
    const normal = failure('t2', '2026-10-28 08:00', 13, 'Hydraulics');
    // Open, 18 h so far. Its baseline also has the 13, 14 and 30 h failures: median 5.5 h, limit 16.5 h.
    const open = failure('t3', '2026-10-31 06:00', null, 'Hydraulics');
    const a = only('repair_spike', base({ flags: [...earlier, spike, normal, open, old] }));
    expect(a.map((x) => x.unitId)).toEqual(['t1', 't3']);
    expect(a[0]!.title).toBe('T1: Hydraulics repair 3.1 times the usual');
    expect(a[0]!.detail).toContain('median for Hydraulics failures in the 90 days before was 4.5 h');
    expect(a[1]!.detail).toContain('has been down 18.0 h for a failure on Hydraulics and is still down');
  });
  it('needs enough earlier failures', () => {
    expect(only('repair_spike', base({ flags: [...earlier.slice(1), failure('t1', '2026-10-28 08:00', 40, 'Hydraulics')] }))).toHaveLength(0);
  });
});

describe('RA-4 failure cluster', () => {
  it('the same system and component on three units in seven days', () => {
    const flags = [failure('t1', '2026-10-26 08:00', 2, 'Hydraulics'), failure('t2', '2026-10-28 08:00', 2, 'Hydraulics'), failure('t3', '2026-10-30 08:00', 2, 'Hydraulics')];
    const a = only('cluster', base({ flags }));
    expect(a).toHaveLength(1);
    expect(a[0]!.detail).toContain('3 units had a failure on the Hose (Hydraulics) in the last 7 days: T1, T2, T3');
    // Two failures on one unit is not a cluster; "Other" is not a component.
    expect(only('cluster', base({ flags: [flags[0]!, flags[1]!, failure('t1', '2026-10-30 08:00', 2, 'Hydraulics')] }))).toHaveLength(0);
    expect(only('cluster', base({ flags: [flags[0]!, flags[1]!, failure('t3', '2026-10-30 08:00', 2, 'Hydraulics', { component: 'Other' })] }))).toHaveLength(0);
  });
});

describe('RA-5 chronic unscheduled', () => {
  it('twice the model median and at least 10% of calendar hours', () => {
    // Last 28 days (672 h): t1 100 h, t2 20 h, t3 20 h, t4 30 h. Median 25 h; the limit is 50 h. t1 is 14.9%.
    const flags = [
      failure('t1', '2026-10-10 00:00', 100, 'Engine'), failure('t2', '2026-10-10 00:00', 20, 'Engine'),
      failure('t3', '2026-10-10 00:00', 20, 'Engine'), failure('t4', '2026-10-10 00:00', 30, 'Engine'),
      failure('t4', '2026-10-20 00:00', 200, 'PM', {}, 'scheduled'), // scheduled down does not count
    ];
    const a = only('chronic', base({ flags }));
    expect(a.map((x) => x.unitId)).toEqual(['t1']);
    expect(a[0]!.detail).toContain('100 h in the last 28 days (15% of its calendar hours). The median 793F unit was 25.0 h');
    expect(only('chronic', base({ flags }), { ...DEFAULT_ALERT_SETTINGS, chronic: { enabled: true, windowDays: 28, multiple: 2, minSharePct: 20 } })).toHaveLength(0);
  });
});

describe('RA-6 silent unit', () => {
  it('SMU barely moved while the unit was not flagged down', () => {
    const readings = [...smu('t1', '2026-10-30 18:00', '2026-10-31 18:00', 0.1), ...smu('t2', '2026-10-30 18:00', '2026-10-31 18:00', 10), ...smu('t3', '2026-10-30 18:00', '2026-10-31 18:00', 0)];
    const a = only('silent', base({ assets: [truck('t1'), truck('t2'), truck('t3'), truck('t4')], smu: readings, flags: [failure('t3', '2026-10-31 02:00', 6, 'Engine')] }));
    expect(a.map((x) => x.unitId)).toEqual(['t1']); // t2 ran, t3 was down, t4 has no readings
    expect(a[0]!.title).toBe('T1: SMU rose 0.2 h in 24.0 h, not flagged down');
    expect(a[0]!.key).toBe('silent:t1:2026-11-01');
  });
});

describe('TA-1 and TA-2 thresholds', () => {
  it('PM open past its due date and tolerance', () => {
    const wo = (id: string, due: string, done?: string): WorkOrder => ({
      id, tenantId: 't', siteId: 's', sourceSystem: 'maximo', sourceId: id, number: id, numberNormalised: id, workClass: 'pm', woType: 'PM', assetId: 't1',
      targetFinish: L(`${due} 23:59`), completedAt: done ? L(done) : undefined, open: !done, status: done ? 'COMP' : 'WSCH',
    });
    const a = only('pm_overdue', base({ workOrders: [wo('100', '2026-10-20'), wo('101', '2026-10-20', '2026-10-21 08:00'), wo('102', '2026-10-30')] }));
    expect(a.map((x) => x.workOrderId)).toEqual(['100']);
    expect(a[0]!.detail).toContain('was due 2026-10-20, 11 days ago');
  });

  it('a fleet KPI over the last 7 site days is red against a target that was set', () => {
    // Midnight 7 days ago, site time, is 25 Oct 00:00. t1 down 84 of the 168 h: fleet PA 50% against 90%, amber band 5%.
    const input = base({ assets: [truck('t1')], flags: [failure('t1', '2026-10-25 00:00', 84, 'Engine')] });
    expect(only('kpi_below', input)).toHaveLength(0); // placeholder targets never alert
    const t: Target = { id: 'x', kpi: 'pa', fleet: 'Haul trucks', value: 0.9, amber: 0.05, effectiveFrom: L('2026-01-01 00:00'), setBy: 'u', setAt: L('2026-01-01 00:00'), reason: 'r' };
    const a = only('kpi_below', { ...input, targets: [t] });
    expect(a).toHaveLength(1);
    expect(a[0]!.title).toContain('Haul trucks');
    expect(a[0]!.title).toContain('50% against 90%');
  });
});

describe('answering alerts and the rules', () => {
  const ctx = (role: Role, now = NOW): ConsoleContext => ({ actor: { userId: `u-${role}`, role, scope: ['*'] }, now, newId: () => `a-${role}-${now}`, timeZone: TZ, calendar: cal });
  const alert: RuleAlert = { key: 'k1', kind: 'repeat_offender', title: 'T1', detail: '', basedOn: '', since: NOW, eventIds: [], goesTo: [] };

  it('supervisors and engineers answer; "not a problem" needs a reason', () => {
    expect(answerAlert(ctx('viewer'), alert, 'noted', '').ok).toBe(false);
    expect(answerAlert(ctx('supervisor'), alert, 'not_a_problem', ' ').ok).toBe(false);
    expect(answerAlert(ctx('supervisor'), alert, 'action_raised', '').ok).toBe(false);
    const r = answerAlert(ctx('supervisor'), alert, 'noted', 'Watching it');
    expect(r.ok && r.audit[0]).toMatchObject({ entity: 'alert', action: 'alert_noted' });
  });

  it('"noted" hides it for the snooze days; the newest answer counts', () => {
    const noted = answerAlert(ctx('supervisor'), alert, 'noted', '');
    if (!noted.ok) throw new Error();
    const a = noted.records[0]!;
    expect(openAlerts([alert], [a], NOW, 7, TZ).open).toHaveLength(0);
    // Seven site days, across the clock change on 1 Nov: hidden until midnight on 8 Nov.
    expect(openAlerts([alert], [a], L('2026-11-07 23:00'), 7, TZ).open).toHaveLength(0);
    expect(openAlerts([alert], [a], L('2026-11-08 01:00'), 7, TZ).open).toHaveLength(1);
    const later = answerAlert(ctx('reliability_engineer', L('2026-11-02 00:00')), alert, 'not_a_problem', 'Known, waiting on the rebuild');
    if (!later.ok) throw new Error();
    expect(openAlerts([alert], [a, later.records[0]!], L('2026-12-01 00:00'), 7, TZ).answered[0]!.answer.decision).toBe('not_a_problem');
    expect(openAlerts([{ ...alert, key: 'k2' }], [a], NOW, 7, TZ).open).toHaveLength(1); // a new key comes back
  });

  it('engineers, superintendents and admins change the rules, with a reason', () => {
    const next = { ...DEFAULT_ALERT_SETTINGS, repeatOffender: { enabled: true, failures: 4, days: 30 } };
    expect(setAlertSettings(ctx('supervisor'), DEFAULT_ALERT_SETTINGS, next, 'r').ok).toBe(false);
    expect(setAlertSettings(ctx('admin'), DEFAULT_ALERT_SETTINGS, next, '').ok).toBe(false);
    expect(setAlertSettings(ctx('admin'), DEFAULT_ALERT_SETTINGS, { ...next, cluster: { enabled: true, units: 1, days: 7 } }, 'r').ok).toBe(false);
    const r = setAlertSettings(ctx('reliability_engineer'), DEFAULT_ALERT_SETTINGS, next, 'Too many alerts at 3');
    expect(r.ok && r.records[0]!.repeatOffender.failures).toBe(4);
    expect(r.ok && r.audit[0]).toMatchObject({ entity: 'settings', entityId: 'alerts' });
    // A stored value from before a rule existed gets that rule's default.
    expect(withAlertDefaults({ snoozeDays: 3, cluster: { units: 5 } } as never)).toMatchObject({ snoozeDays: 3, cluster: { enabled: true, units: 5, days: 7 }, silent: DEFAULT_ALERT_SETTINGS.silent });
  });
});
