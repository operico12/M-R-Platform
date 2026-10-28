// Inspections, docs/inspections.md. Hand-worked.

import { describe, expect, it } from 'vitest';
import type { ConsoleContext } from '../src/console.js';
import {
  dueList, retireForm, saveForm, scoreInspection, signOff, startInspection, submitInspection, submitProblems, updateDefect, voidInspection,
  type FormInput, type Inspection, type InspectionForm,
} from '../src/inspections.js';
import type { Role } from '../src/types.js';
import { L, TZ, cal, truck } from './helpers.js';

let n = 0;
const ctx = (role: Role, userId = `u-${role}`, now = L('2026-10-26 09:00')): ConsoleContext => ({ actor: { userId, role, scope: ['*'] }, now, newId: () => `id${++n}`, timeZone: TZ, calendar: cal });
const item = (id: string, kind: FormInput['items'][number]['kind'], over: Partial<FormInput['items'][number]> = {}) =>
  ({ id, section: 'Walk-around', text: id, kind, critical: false, weight: 1, photoOnFail: false, ...over });
const input: FormInput = {
  name: 'Pre-start', assetClass: 'mobile', models: ['793F'], every: { n: 1, unit: 'days' },
  items: [
    item('brakes', 'pass_fail', { critical: true, weight: 3 }),
    item('lights', 'pass_fail'),
    item('cab', 'rating'),
    item('oil', 'reading', { min: 40, max: 80, unit: '%' }),
    item('notes', 'note'),
  ],
};
const made = saveForm(ctx('reliability_engineer'), [], null, input, 'First version');
if (!made.ok) throw new Error(made.errors.join());
const form = made.records[0]!;
const t1 = truck('t1');

describe('forms', () => {
  it('reliability engineers, superintendents and admins change forms; a change is a new version', () => {
    expect(saveForm(ctx('supervisor'), [], null, input, 'x').ok).toBe(false);
    expect(saveForm(ctx('admin'), [], null, { ...input, items: [item('r', 'reading')] }, 'x')).toMatchObject({ ok: false, errors: ['Item 1: a reading needs a lower or upper limit.'] });
    const v2 = saveForm(ctx('admin'), [form], form.id, { ...input, name: 'Pre-start (2027)' }, 'Added a step');
    expect(v2.ok && v2.records.map((f) => `${f.id}@${f.version}`)).toEqual([`${form.id}@1`, `${form.id}@2`]);
    const r = retireForm(ctx('admin'), v2.ok ? v2.records : [], form.id, 'Replaced');
    expect(r.ok && r.records.find((f) => f.version === 2)!.retiredAt).toBeTruthy();
  });
});

describe('score and result', () => {
  // Weights: brakes 3, lights 1, cab 1, oil 1. Notes not scored.
  it('weights item scores; N/A is left out', () => {
    // Pass, pass, rating 4 = 0.75, oil 60 within limits: (3 + 1 + 0.75 + 1) / 6 = 0.958
    const a = scoreInspection(form, { brakes: { value: 'pass' }, lights: { value: 'pass' }, cab: { value: 4 }, oil: { value: 60 }, notes: { value: 'ok' } });
    expect(a.score).toBeCloseTo(5.75 / 6, 9);
    expect(a.result).toBe('pass');
    // Lights N/A: (3 + 0.75 + 1) / 5
    expect(scoreInspection(form, { brakes: { value: 'pass' }, lights: { value: null }, cab: { value: 4 }, oil: { value: 60 } }).score).toBeCloseTo(4.75 / 5, 9);
  });

  it('any failed item gives defects; a failed critical item fails it, whatever the score', () => {
    // Oil 35 is under the limit: (3 + 1 + 0.75 + 0) / 6 = 0.79, defects found.
    expect(scoreInspection(form, { brakes: { value: 'pass' }, lights: { value: 'pass' }, cab: { value: 4 }, oil: { value: 35 } })).toMatchObject({ result: 'defects' });
    // Cab rated 2 counts as a fail.
    expect(scoreInspection(form, { brakes: { value: 'pass' }, lights: { value: 'pass' }, cab: { value: 2 }, oil: { value: 50 } }).result).toBe('defects');
    // Brakes fail, everything else good: score 0.5 but the result is fail.
    const f = scoreInspection(form, { brakes: { value: 'fail' }, lights: { value: 'pass' }, cab: { value: 5 }, oil: { value: 50 } });
    expect(f.score).toBeCloseTo(3 / 6, 9);
    expect(f.result).toBe('fail');
  });
});

describe('doing one', () => {
  const start = () => {
    const s = startInspection(ctx('technician', 'tia'), [], form, t1, 12000);
    if (!s.ok) throw new Error(s.errors.join());
    return s.records[0]!;
  };

  it('needs every item answered, a note on each fail, and no N/A on critical items', () => {
    expect(startInspection(ctx('viewer'), [], form, t1).ok).toBe(false);
    expect(startInspection(ctx('technician'), [], form, truck('d1', { model: '994K' })).ok).toBe(false);
    expect(submitProblems(form, { brakes: { value: null }, lights: { value: 'fail' }, cab: { value: 7 } })).toEqual([
      '1. brakes: critical, so it cannot be N/A.', '2. lights: failed, so add a note.', '3. cab: rate 1 to 5.', '4. oil: not answered.',
    ]);
    expect(submitProblems({ ...form, items: [item('x', 'pass_fail', { photoOnFail: true })] }, { x: { value: 'fail', note: 'cracked' } })).toEqual(['1. x: failed, so add a photo.']);
  });

  it('submitting scores it and turns each failed item into a defect', () => {
    const i: Inspection = { ...start(), answers: { brakes: { value: 'fail', note: 'Soft pedal' }, lights: { value: 'fail', note: 'Left beam out' }, cab: { value: 4 }, oil: { value: 60 } } };
    expect(submitInspection(ctx('supervisor'), [i], form, i).ok).toBe(false); // only the inspector submits
    const r = submitInspection(ctx('technician', 'tia'), [i], form, i);
    if (!r.ok) throw new Error(r.errors.join());
    const s = r.records[0]!;
    expect(s).toMatchObject({ status: 'submitted', result: 'fail' });
    expect(s.defects.map((d) => [d.itemId, d.severity, d.text])).toEqual([['brakes', 'high', 'brakes: Soft pedal'], ['lights', 'medium', 'lights: Left beam out']]);
    expect(r.warnings[0]).toContain('flagged down');
  });

  it('someone other than the inspector signs off; voiding needs a reason', () => {
    const i: Inspection = { ...start(), answers: { brakes: { value: 'pass' }, lights: { value: 'pass' }, cab: { value: 5 }, oil: { value: 50 } } };
    const r = submitInspection(ctx('technician', 'tia'), [i], form, i);
    if (!r.ok) throw new Error();
    const id = r.records[0]!.id;
    expect(signOff(ctx('reliability_engineer'), r.records, id, '').ok).toBe(false);
    expect(signOff(ctx('supervisor', 'tia'), r.records, id, '').ok).toBe(false);
    const ok = signOff(ctx('supervisor', 'sam'), r.records, id, 'Checked the brakes myself');
    expect(ok.ok && ok.records[0]).toMatchObject({ status: 'signed_off', signedOffBy: 'sam' });
    expect(voidInspection(ctx('supervisor', 'sam'), r.records, id, ' ').ok).toBe(false);
    expect(voidInspection(ctx('technician', 'tia'), r.records, id, 'wrong unit').ok).toBe(false); // submitted: supervisor voids
    expect(voidInspection(ctx('supervisor', 'sam'), r.records, id, 'Wrong unit').ok).toBe(true);
  });

  it('defects are followed up by an action, a work order, a down flag or a note', () => {
    const i: Inspection = { ...start(), answers: { brakes: { value: 'pass' }, lights: { value: 'fail', note: 'Out' }, cab: { value: 5 }, oil: { value: 50 } } };
    const r = submitInspection(ctx('technician', 'tia'), [i], form, i);
    if (!r.ok) throw new Error();
    const s = r.records[0]!;
    const d = s.defects[0]!.id;
    expect(updateDefect(ctx('technician', 'tia'), r.records, s.id, d, { status: 'work_order', workOrder: ' ' }).ok).toBe(false);
    const w = updateDefect(ctx('technician', 'tia'), r.records, s.id, d, { status: 'work_order', workOrder: '4242' });
    expect(w.ok && w.records[0]!.defects[0]).toMatchObject({ status: 'work_order', workOrder: '4242', updatedBy: 'tia' });
    expect(updateDefect(ctx('technician', 'tia'), r.records, s.id, d, { status: 'closed' }).ok).toBe(false);
  });
});

describe('due list', () => {
  const done = (unitId: string, at: string, smu?: number, f: InspectionForm = form): Inspection =>
    ({ id: `${unitId}-${at}`, formId: f.id, formVersion: f.version, unitId, smu, status: 'submitted', answers: {}, defects: [], startedBy: 'x', startedAt: L(at), submittedAt: L(at) });

  it('by site days: overdue, due soon (2 days) and never done', () => {
    const weekly = { ...form, every: { n: 7, unit: 'days' as const } };
    const now = L('2026-10-26 09:00');
    const rows = dueList([weekly], [truck('t1'), truck('t2'), truck('t3'), truck('t4')], [
      done('t1', '2026-10-18 23:30', undefined, weekly), // due 25 Oct: overdue
      done('t2', '2026-10-21 07:00', undefined, weekly), // due 28 Oct: within 2 days
      done('t3', '2026-10-24 07:00', undefined, weekly), // due 31 Oct: ok
    ], [], now, TZ);
    expect(rows.map((r) => [r.unit.id, r.state, r.dueDate])).toEqual([
      ['t1', 'overdue', '2026-10-25'], ['t2', 'due_soon', '2026-10-28'], ['t4', 'never', undefined], ['t3', 'ok', '2026-10-31'],
    ]);
  });

  it('a daily form is due soon only on the day it is due', () => {
    const now = L('2026-10-26 09:00');
    const rows = dueList([form], [truck('t1'), truck('t2'), truck('t3')], [
      done('t1', '2026-10-26 06:00'), // due 27 Oct: ok
      done('t2', '2026-10-25 06:00'), // due today: due soon
      done('t3', '2026-10-24 06:00'), // due yesterday: overdue
    ], [], now, TZ);
    expect(rows.map((r) => [r.unit.id, r.state])).toEqual([['t3', 'overdue'], ['t2', 'due_soon'], ['t1', 'ok']]);
  });

  it('by SMU hours from the reading at the last inspection; due soon within 10%', () => {
    const service = { ...form, every: { n: 250, unit: 'smu_hours' as const } };
    const now = L('2026-10-26 09:00');
    const smu = [
      { unitId: 't1', at: L('2026-10-26 06:00'), hours: 12300 }, // 300 since: overdue
      { unitId: 't2', at: L('2026-10-26 06:00'), hours: 12230 }, // 230 since: within 25 h
      { unitId: 't3', at: L('2026-10-26 06:00'), hours: 12100 },
    ];
    const rows = dueList([service], [truck('t1'), truck('t2'), truck('t3')], [done('t1', '2026-10-01 08:00', 12000, service), done('t2', '2026-10-01 08:00', 12000, service), done('t3', '2026-10-01 08:00', 12000, service)], smu, now, TZ);
    expect(rows.map((r) => [r.unit.id, r.state, r.dueSmu])).toEqual([['t1', 'overdue', 12250], ['t2', 'due_soon', 12250], ['t3', 'ok', 12250]]);
  });
});
