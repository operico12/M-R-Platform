// Condition monitoring (docs/condition-monitoring.md). Baseline numbers are
// worked by hand: 20 samples alternating 15 and 25 ppm have mean 20 and
// σ = √(20 × 25 ÷ 19) = 5.130 ppm, so the limits are 30.26, 35.39 and 40.52.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONDITION_SETTINGS, baselineOf, buildBaselines, cmResponse, compartmentOf, conditionActions, conditionAlerts, importLabFile, judge,
  labColumns, labSeverityOf, recordSample, respondToSample, risingElements, samplesDue, setConditionSettings, voidSample,
  type Baselines, type CmResponse, type ConditionData, type OilSample,
} from '../src/condition.js';
import { smuIndex } from '../src/components.js';
import type { ConsoleContext } from '../src/console.js';
import { parseCsv } from '../src/imports.js';
import { generateFleet } from '../src/synth/generate.js';
import type { Role, SmuReading, WorkOrder } from '../src/types.js';
import { L, TZ, cal, truck } from './helpers.js';

let n = 0;
const ctx = (role: Role, now = L('2026-10-28 09:00'), userId = `u-${role}`): ConsoleContext => ({ actor: { userId, role, scope: ['*'] }, now, newId: () => `id${++n}`, timeZone: TZ, calendar: cal });
const assets = [truck('ht1'), truck('ht2'), truck('ht3', { model: '797F' })];
const modelOf = (id: string) => assets.find((a) => a.id === id)?.model;

let sid = 0;
function sample(over: Partial<OilSample> & { unitId?: string }): OilSample {
  const at = over.takenAt ?? L('2026-06-01 08:00');
  return { id: `s${++sid}`, unitId: 'ht1', compartment: 'engine', takenAt: at, reportedAt: at, readings: {}, severity: 'normal', reasons: [], enteredBy: 'x', enteredAt: at, ...over };
}
/** 20 normal 793F engine samples, Fe alternating 15 and 25 ppm, over May 2026. */
const fleet = Array.from({ length: 20 }, (_, i) => sample({ unitId: i % 2 ? 'ht1' : 'ht2', takenAt: L(`2026-05-${String(i + 1).padStart(2, '0')} 08:00`), readings: { fe: i % 2 ? 15 : 25, visc100: 13 + (i % 2 ? -0.5 : 0.5) } }));

describe('severity', () => {
  it('reads lab ratings', () => {
    expect(['A', '1', 'Normal', 'b', 'Caution', 'C', 'abnormal', 'D', 'X', 'severe', 'what'].map(labSeverityOf))
      .toEqual(['normal', 'normal', 'normal', 'monitor', 'monitor', 'action', 'action', 'critical', 'critical', 'critical', undefined]);
  });
  it('fleet baseline: mean, σ and limits (hand-worked)', () => {
    const b = baselineOf(fleet.map((x) => x.readings.fe!), 'fe', DEFAULT_CONDITION_SETTINGS)!;
    expect(b.mean).toBe(20);
    expect(b.sd).toBeCloseTo(Math.sqrt(500 / 19), 10);
    expect(b.high.map((x) => +x.toFixed(2))).toEqual([30.26, 35.39, 40.52]);
    expect(baselineOf(fleet.slice(0, 19).map((x) => x.readings.fe!), 'fe', DEFAULT_CONDITION_SETTINGS)).toBeNull();
  });
  it('limits keep a minimum step, so a near-constant element does not alarm', () => {
    const b = baselineOf(Array(20).fill(1), 'na', DEFAULT_CONDITION_SETTINGS)!;
    expect(b.high).toEqual([6, 11, 16]);
  });
  it('viscosity is two-sided', () => {
    const b = baselineOf(fleet.map((x) => x.readings.visc100!), 'visc100', DEFAULT_CONDITION_SETTINGS)!;
    expect(b.low![0]).toBeLessThanOrEqual(12);
    const bl: Baselines = buildBaselines(fleet, modelOf, L('2026-06-01 00:00'));
    expect(judge({ compartment: 'engine', readings: { visc100: 9.5 } }, '793F', bl).severity).toBe('critical');
    expect(judge({ compartment: 'engine', readings: { visc100: 13.2 } }, '793F', bl).severity).toBe('normal');
  });
  it('judges against the fleet baseline and keeps the worse of lab and baseline', () => {
    const bl = buildBaselines(fleet, modelOf, L('2026-06-01 00:00'));
    const j = judge({ compartment: 'engine', readings: { fe: 36 } }, '793F', bl);
    expect(j.severity).toBe('action');
    expect(j.reasons[0]).toBe('Fe 36 ppm: above the action limit of 35 ppm (793F engine fleet mean 20, 20 samples).');
    expect(judge({ compartment: 'engine', readings: { fe: 36 }, labSeverity: 'critical' }, '793F', bl).severity).toBe('critical');
    expect(judge({ compartment: 'engine', readings: { fe: 20 }, labSeverity: 'monitor' }, '793F', bl).severity).toBe('monitor');
    // Another model has no baseline: only the lab counts, and it says so.
    const other = judge({ compartment: 'engine', readings: { fe: 300 } }, '797F', bl);
    expect(other.severity).toBe('normal');
    expect(other.reasons[0]).toMatch(/Not enough samples for a fleet baseline for 797F engine/);
  });
  it('the baseline leaves out voided, Action and Critical samples, and anything outside the window', () => {
    const extra = [
      sample({ readings: { fe: 500 }, severity: 'action', takenAt: L('2026-05-10 09:00') }),
      sample({ readings: { fe: 500 }, voidedAt: L('2026-05-12 00:00'), takenAt: L('2026-05-10 09:00') }),
      sample({ readings: { fe: 500 }, takenAt: L('2025-04-01 09:00') }),
      sample({ readings: { fe: 500 }, takenAt: L('2026-06-05 09:00') }),
    ];
    const b = buildBaselines([...fleet, ...extra], modelOf, L('2026-06-01 00:00')).get('793F|engine|fe')!;
    expect(b.n).toBe(20);
    expect(b.mean).toBe(20);
  });
  it('rising: three rises in a row, now more than 1σ above the fleet mean', () => {
    const bl = buildBaselines(fleet, modelOf, L('2026-06-01 00:00')); // Fe mean 20, σ 5.13
    const run = (xs: number[]) => xs.map((fe, i) => sample({ readings: { fe }, takenAt: L(`2026-06-0${i + 1} 08:00`) }));
    expect(risingElements(run([16, 19, 22, 26]), '793F', bl)).toEqual(['fe']);
    expect(risingElements(run([19, 22, 26]), '793F', bl)).toEqual([]);
    expect(risingElements(run([16, 19, 22, 24]), '793F', bl)).toEqual([]); // 24 is within 1σ
    expect(risingElements(run([16, 19, 19, 26]), '793F', bl)).toEqual([]);
  });
});

describe('recording', () => {
  const data: ConditionData = { samples: fleet, responses: [], assets };
  it('checks who and what, and judges against the baseline now', () => {
    expect(recordSample(ctx('viewer'), data, { unitId: 'ht1', compartment: 'engine', takenAt: L('2026-10-27 08:00'), readings: { fe: 40 } }).ok).toBe(false);
    const bad = recordSample(ctx('supervisor'), data, { unitId: 'zz', compartment: 'engine', takenAt: L('2026-10-29 08:00'), readings: {} });
    expect(bad.ok ? [] : bad.errors).toEqual(['Pick the unit.', 'The sample date is in the future.', 'Give at least one reading or the lab severity.']);
    // The May fleet is inside the 365-day window, so Fe 41 ppm is past the critical limit of 40.5.
    const r = recordSample(ctx('supervisor'), data, { unitId: 'ht1', compartment: 'engine', takenAt: L('2026-10-27 08:00'), labRef: ' L1 ', readings: { fe: 41 } });
    if (!r.ok) throw new Error(r.errors.join(' '));
    expect(r.records.at(-1)).toMatchObject({ severity: 'critical', labRef: 'L1', enteredBy: 'u-supervisor' });
    expect(recordSample(ctx('supervisor'), { ...data, samples: r.records }, { unitId: 'ht1', compartment: 'engine', takenAt: L('2026-10-27 08:00'), labRef: 'L1', readings: { fe: 1 } }).ok).toBe(false);
  });
  it('voids by the person who entered it or a superintendent, with a reason', () => {
    const r = recordSample(ctx('supervisor', undefined, 'sam'), data, { unitId: 'ht1', compartment: 'engine', takenAt: L('2026-10-27 08:00'), readings: { fe: 20 } });
    if (!r.ok) throw new Error();
    const id = r.records.at(-1)!.id;
    expect(voidSample(ctx('supervisor', undefined, 'sue'), r.records, id, 'x').ok).toBe(false);
    expect(voidSample(ctx('supervisor', undefined, 'sam'), r.records, id, ' ').ok).toBe(false);
    const v = voidSample(ctx('superintendent'), r.records, id, 'Wrong unit');
    expect(v.ok && v.records.at(-1)!.voidReason).toBe('Wrong unit');
  });
  it('responses: only Action or Critical, one each, with a work order number when raised', () => {
    const s1 = sample({ severity: 'action', reportedAt: L('2026-10-20 08:00') });
    const s2 = sample({ severity: 'monitor' });
    const d = { samples: [s1, s2], responses: [] as CmResponse[] };
    expect(respondToSample(ctx('supervisor'), d, s2.id, { action: 'resample', note: 'x' }).ok).toBe(false);
    expect(respondToSample(ctx('viewer'), d, s1.id, { action: 'resample', note: 'x' }).ok).toBe(false);
    expect(respondToSample(ctx('supervisor'), d, s1.id, { action: 'work_order', note: 'x' }).ok).toBe(false);
    const r = respondToSample(ctx('supervisor'), d, s1.id, { action: 'work_order', workOrder: ' 123456 ', note: 'Raised' });
    if (!r.ok) throw new Error();
    expect(r.records[0]).toMatchObject({ workOrder: '123456', at: L('2026-10-28 09:00') });
    expect(respondToSample(ctx('supervisor'), { ...d, responses: r.records }, s1.id, { action: 'resample', note: 'again' }).ok).toBe(false);
  });
  it('settings are checked and audited', () => {
    const s = DEFAULT_CONDITION_SETTINGS;
    expect(setConditionSettings(ctx('supervisor'), s, s, 'x').ok).toBe(false);
    const bad = setConditionSettings(ctx('reliability_engineer'), s, { ...s, sigmas: [3, 2, 4], responseHours: { action: 24, critical: 48 } }, '');
    expect(bad.ok ? 0 : bad.errors.length).toBe(3);
    const ok = setConditionSettings(ctx('admin'), s, { ...s, intervals: { ...s.intervals, engine: 500 } }, 'Longer engine interval');
    expect(ok.ok && ok.records[0]!.intervals.engine).toBe(500);
  });
});

describe('KPI-032 condition monitoring response', () => {
  // Week of 19 to 26 Oct 2026. Action samples reported so their 72 h target ends inside the week.
  const rep = (d: string) => L(d);
  const a = sample({ severity: 'action', reportedAt: rep('2026-10-16 08:00') }); // due 19 Oct 08:00, answered in time
  const b = sample({ severity: 'critical', reportedAt: rep('2026-10-20 08:00') }); // due 21 Oct 08:00, answered in time
  const c = sample({ severity: 'action', reportedAt: rep('2026-10-18 08:00') }); // due 21 Oct 08:00, answered 10 h late
  const d = sample({ severity: 'action', reportedAt: rep('2026-10-19 08:00') }); // due 22 Oct 08:00, never answered
  const e = sample({ severity: 'action', reportedAt: rep('2026-10-25 08:00') }); // due 28 Oct: outside the week
  const f = sample({ severity: 'action', reportedAt: rep('2026-10-17 08:00'), voidedAt: rep('2026-10-18 08:00') }); // voided
  const g = sample({ severity: 'monitor', reportedAt: rep('2026-10-17 08:00') }); // no response needed
  const samples = [a, b, c, d, e, f, g];
  const responses: CmResponse[] = [
    { id: 'r1', sampleId: a.id, action: 'resample', note: 'x', by: 'x', at: rep('2026-10-18 08:00') },
    { id: 'r2', sampleId: b.id, action: 'work_order', workOrder: 'WO-00123', note: 'x', by: 'x', at: rep('2026-10-20 20:00') },
    { id: 'r3', sampleId: c.id, action: 'inspect', note: 'x', by: 'x', at: rep('2026-10-21 18:00') },
  ];
  it('the worked example: 2 ÷ 4 = 50%', () => {
    const k = cmResponse(samples, responses, rep('2026-10-19 00:00'), rep('2026-10-26 00:00'), rep('2026-10-28 09:00'));
    expect(k).toEqual({ value: 0.5, inTime: 2, late: 1, missing: 1, total: 4 });
  });
  it('an alert still inside its time is left out until it ends', () => {
    const k = cmResponse(samples, responses, rep('2026-10-26 00:00'), rep('2026-11-02 00:00'), rep('2026-10-27 09:00'));
    expect(k.total).toBe(0);
    expect(conditionAlerts(samples, responses, rep('2026-10-27 09:00')).find((x) => x.sample.id === e.id)!.status).toBe('waiting');
  });
  it('actions raised and closed by the ERP work order', () => {
    const wo = (number: string, open: boolean) => ({ id: number, number, numberNormalised: number.replace(/^WO-0*/, ''), open } as WorkOrder);
    expect(conditionActions(responses, samples, [wo('123', false)])).toMatchObject({ raised: 1, closed: 1 });
    expect(conditionActions(responses, samples, [wo('123', true)])).toMatchObject({ raised: 1, closed: 0 });
  });
});

describe('overdue samples', () => {
  const smu: SmuReading[] = [{ unitId: 'ht1', at: L('2026-10-28 06:00'), hours: 10300 }, { unitId: 'ht2', at: L('2026-10-28 06:00'), hours: 10240 }, { unitId: 'ht3', at: L('2026-10-28 06:00'), hours: 10200 }];
  it('due at last SMU + interval; overdue past 10% of it', () => {
    const samples = [
      sample({ unitId: 'ht1', smu: 10000 }), // engine due 10,250; now 10,300 is 50 h over > 25 → overdue
      sample({ unitId: 'ht2', smu: 10000 }), // due 10,250; 10 h short → due soon
      sample({ unitId: 'ht3', smu: 10100 }), // due 10,350; 150 h short → ok
      sample({ unitId: 'ht1', compartment: 'hydraulic', smu: 9900 }), // due 10,400 → ok
    ];
    const rows = samplesDue(assets, [{ assetId: 'ht2', status: 'parked', start: L('2026-10-01 00:00'), end: null }], samples, smuIndex(smu), L('2026-10-28 09:00'));
    const of = (u: string, c: string) => rows.find((r) => r.unit.id === u && r.compartment === c)!;
    expect(of('ht1', 'engine')).toMatchObject({ status: 'overdue', dueSmu: 10250, hoursOver: 50 });
    expect(of('ht3', 'engine').status).toBe('ok');
    expect(of('ht1', 'hydraulic').status).toBe('ok');
    expect(of('ht1', 'transmission').status).toBe('none');
    expect(rows.some((r) => r.unit.id === 'ht2')).toBe(false); // parked
    const r2 = samplesDue(assets, [], samples, smuIndex(smu), L('2026-10-28 09:00'));
    expect(r2.find((r) => r.unit.id === 'ht2' && r.compartment === 'engine')!.status).toBe('due_soon');
  });
  it('uses the unit meter at the sample time over a mistyped lab meter', () => {
    const meter: SmuReading[] = [{ unitId: 'ht1', at: L('2026-10-01 06:00'), hours: 10100 }, { unitId: 'ht1', at: L('2026-10-28 06:00'), hours: 10300 }];
    const rows = samplesDue([assets[0]!], [], [sample({ unitId: 'ht1', smu: 1010, takenAt: L('2026-10-02 08:00') })], smuIndex(meter), L('2026-10-28 09:00'));
    expect(rows[0]).toMatchObject({ lastSmu: 10100, dueSmu: 10350, hoursOver: -50, status: 'ok' });
  });
});

describe('lab file import', () => {
  it('maps loose headers and compartments', () => {
    expect(['Engine', 'ENG', 'Trans', 'Torque Converter', 'TC', 'Diff', 'Rear Axle', 'LH Final', 'Final drive - right', 'Hyd tank', 'Final drive'].map(compartmentOf))
      .toEqual(['engine', 'engine', 'transmission', 'torque_converter', 'torque_converter', 'differential', 'differential', 'final_drive_lh', 'final_drive_rh', 'hydraulic', undefined]);
    const c = labColumns(['Unit ID', 'Compartment', 'Sample Date', 'Lab No.', 'Iron (ppm)', 'Water (ppm)', 'Visc @ 100C']);
    expect(c).toMatchObject({ unit: 0, compartment: 1, takenAt: 2, labRef: 3, fe: 4, water: 5, visc100: 6, waterPpm: true });
  });
  it('adds new rows, skips duplicates and bad rows, and says why', () => {
    const csv = [
      'Unit ID,Compartment,Sample Date,Report Date,Lab No.,Meter,Severity,Iron (ppm),Water (ppm),Comments',
      'HT1,Engine,2026-10-20,2026-10-23 14:00,L100,10100,C,22,1000,Check',
      'HT1,Engine,2026-10-20,2026-10-23,L100,10100,A,22,0,dup in file',
      'HT9,Engine,2026-10-20,,L101,,A,22,0,',
      'HT2,Gearbox,2026-10-20,,L102,,A,22,0,',
      'HT2,Trans,2026-10-20,,L103,,Q,22,0,',
      'HT2,Diff,2027-01-01,,L104,,A,22,0,',
    ].join('\n');
    const r = importLabFile(ctx('reliability_engineer'), { samples: [], responses: [], assets }, parseCsv(csv), 'lab.csv');
    if (!r.ok) throw new Error(r.errors.join(' '));
    expect(r.added.map((x) => x.labRef)).toEqual(['L100', 'L103']);
    expect(r.added[0]).toMatchObject({ compartment: 'engine', smu: 10100, labSeverity: 'action', severity: 'action', readings: { fe: 22, water: 0.1 }, reportedAt: L('2026-10-23 14:00'), takenAt: L('2026-10-20 00:00') });
    expect(r.duplicates).toBe(1);
    expect(r.issues.map((i) => i.row)).toEqual([4, 5, 6, 7]);
    expect(r.issues[2]!.message).toMatch(/Lab severity "Q" not recognised/);
    expect(r.audit).toHaveLength(1);
    // Loading the same file again adds nothing.
    const again = importLabFile(ctx('reliability_engineer'), { samples: r.records, responses: [], assets }, parseCsv(csv), 'lab.csv');
    expect(again.ok && again.added.length).toBe(0);
    expect(importLabFile(ctx('viewer'), { samples: [], responses: [], assets }, parseCsv(csv), 'lab.csv').ok).toBe(false);
    const noCols = importLabFile(ctx('supervisor'), { samples: [], responses: [], assets }, parseCsv('A,B\n1,2'), 'x.csv');
    expect(noCols.ok ? '' : noCols.errors[0]).toMatch(/needs columns for unit, compartment, sample date/);
  });
});

describe('synthetic oil history', () => {
  const ds = generateFleet({ units: 12, days: 30, seed: 7, end: '2026-10-28T09:30:00.000Z' });
  it('is deterministic and plausible', () => {
    const again = generateFleet({ units: 12, days: 30, seed: 7, end: '2026-10-28T09:30:00.000Z' });
    expect(again.oilSamples).toEqual(ds.oilSamples);
    expect(ds.oilSamples.length).toBeGreaterThan(500);
    expect(ds.oilSamples.every((x) => ['normal', 'monitor', 'action', 'critical'].indexOf(x.severity) >= ['normal', 'monitor', 'action', 'critical'].indexOf(x.labSeverity!))).toBe(true);
    expect(ds.oilSamples.some((x) => x.severity === 'critical')).toBe(true);
    expect(ds.cmResponses.length).toBeGreaterThan(0);
    const ids = new Set(ds.oilSamples.map((x) => x.id));
    expect(ds.cmResponses.every((r) => ids.has(r.sampleId))).toBe(true);
    expect(ds.oilSamples.every((x) => Date.parse(x.reportedAt!) <= Date.parse(ds.generatedAt) && Date.parse(x.takenAt) < Date.parse(x.reportedAt!))).toBe(true);
  });
});
