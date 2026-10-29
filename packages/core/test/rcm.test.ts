// RCM to PM job plans (docs/rcm.md): task selection, revisions, packaging,
// issuing, the Maximo export and the review. Expected answers are worked from
// the rules in the doc.

import { describe, expect, it } from 'vitest';
import type { ConsoleContext } from '../src/console.js';
import type { DowntimeEvent } from '../src/kpis.js';
import {
  DEFAULT_RCM_SETTINGS, addMode, currentModes, issueJobPlan, maximoSheets, packageFor, packageModel, planChanges, planState, rcmReview, recommendTask,
  retireMode, reviseMode, setRcmSettings, stableJson, withRcmDefaults,
  type JobPlanVersion, type ModeInput, type RcmMode,
} from '../src/rcm.js';
import { generateFleet } from '../src/synth/generate.js';
import type { DetectionMethod, Role } from '../src/types.js';
import { L, TZ, cal, fixtureFlag, truck } from './helpers.js';

let n = 0;
const ctx = (role: Role, now = L('2026-10-28 09:00'), userId = `u-${role}`): ConsoleContext => ({ actor: { userId, role, scope: ['*'] }, now, newId: () => `id${++n}`, timeZone: TZ, calendar: cal });
const re = ctx('reliability_engineer');

const base: ModeInput = {
  model: '793F', system: 'Cooling', component: 'Water pump', func: 'Circulate coolant at rated flow', functionalFailure: 'No coolant flow', mode: 'Leak',
  effect: 'Coolant loss, engine overheats and derates; about 4 h to change', consequence: 'operational', answers: { warning: true, wearOut: false },
  taskType: 'on_condition', task: 'Check weep hole and pump seal for leaks', intervalHours: 500, intervalBasis: 'C-12: P-F 1000 h ÷ 2', craft: 'mech', people: 1, taskHours: 0.25, parts: [],
};
const mode = (over: Partial<ModeInput>): ModeInput => ({ ...base, ...over });

function lib(inputs: ModeInput[]): RcmMode[] {
  let modes: RcmMode[] = [];
  for (const i of inputs) { const r = addMode(re, modes, i); if (!r.ok) throw new Error(r.errors.join(' ')); modes = r.records; }
  return modes;
}

describe('task selection (JA1012 order)', () => {
  it('recommends the first task that fits', () => {
    expect(recommendTask('operational', { warning: true, wearOut: true, restorable: true })).toBe('on_condition');
    expect(recommendTask('operational', { warning: false, wearOut: true, restorable: true })).toBe('restoration');
    expect(recommendTask('operational', { warning: false, wearOut: true, restorable: false })).toBe('replacement');
    expect(recommendTask('hidden', { warning: false, wearOut: false, findable: true, multipleSafety: true })).toBe('failure_finding');
    expect(recommendTask('hidden', { warning: false, wearOut: false, findable: false, multipleSafety: true })).toBe('redesign');
    expect(recommendTask('hidden', { warning: false, wearOut: false, findable: false, multipleSafety: false })).toBe('run_to_failure');
    expect(recommendTask('safety', { warning: false, wearOut: false })).toBe('redesign');
    expect(recommendTask('operational', { warning: false, wearOut: false })).toBe('run_to_failure');
    expect(recommendTask('non_operational', { warning: false, wearOut: false })).toBe('run_to_failure');
  });
});

describe('the library', () => {
  it('adds a mode with its recommendation, upper-casing the craft', () => {
    const [m] = lib([base]);
    expect(m!.revision).toBe(1);
    expect(m!.recommended).toBe('on_condition');
    expect(m!.craft).toBe('MECH');
  });
  it('asks every question that applies, and only those', () => {
    const r = addMode(re, [], mode({ consequence: 'hidden', answers: { warning: false, wearOut: true }, taskType: 'replacement' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/rework.*check find.*second failure/is);
    const ok = addMode(re, [], mode({ consequence: 'operational', answers: { warning: true, wearOut: false, findable: true }, taskType: 'on_condition' }));
    expect(ok.ok && ok.records[0]!.answers).toEqual({ warning: true, wearOut: false });
  });
  it('needs a reason to choose a task other than the one recommended', () => {
    const r = addMode(re, [], mode({ taskType: 'run_to_failure' }));
    expect(r.ok).toBe(false);
    const ok = addMode(re, [], mode({ taskType: 'run_to_failure', overrideReason: 'Cheaper to run to failure (C-15)' }));
    expect(ok.ok && ok.records[0]!.intervalHours).toBeUndefined();
  });
  it('needs an interval, craft, people and hours for a scheduled task', () => {
    const r = addMode(re, [], mode({ intervalHours: 0, craft: '', people: 0, taskHours: undefined }));
    expect(r.ok ? [] : r.errors).toHaveLength(4);
  });
  it('only the reliability engineer and superintendent edit the library', () => {
    expect(addMode(ctx('supervisor'), [], base).ok).toBe(false);
    expect(addMode(ctx('admin'), [], base).ok).toBe(false);
    expect(addMode(ctx('superintendent'), [], base).ok).toBe(true);
  });
  it('a change is a new revision; the old one is kept', () => {
    const modes = lib([base]);
    const id = modes[0]!.modeId;
    expect(reviseMode(re, modes, id, base, 'no change').ok).toBe(false);
    expect(reviseMode(re, modes, id, mode({ intervalHours: 250 }), '').ok).toBe(false);
    const r = reviseMode(re, modes, id, mode({ intervalHours: 250 }), 'Two leaks found late');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.records).toHaveLength(2);
    expect(currentModes(r.records)).toHaveLength(1);
    expect(currentModes(r.records)[0]!.revision).toBe(2);
    expect(currentModes(r.records)[0]!.intervalHours).toBe(250);
    expect(reviseMode(re, r.records, id, mode({ model: '797F' }), 'move').ok).toBe(false);
  });
  it('retires with a reason, and a retired mode cannot be revised', () => {
    const modes = lib([base]);
    const id = modes[0]!.modeId;
    expect(retireMode(re, modes, id, ' ').ok).toBe(false);
    const r = retireMode(re, modes, id, 'Pump replaced by a sealed type');
    expect(r.ok && currentModes(r.records)).toEqual([]);
    if (r.ok) expect(reviseMode(re, r.records, id, mode({ intervalHours: 250 }), 'x').ok).toBe(false);
  });
});

describe('packaging (docs/rcm.md)', () => {
  it('largest level no longer than the interval; multiples of the largest above it', () => {
    const p = DEFAULT_RCM_SETTINGS.packages;
    expect([100, 250, 300, 750, 1000, 1999, 2000, 5000, 6000].map((x) => packageFor(x, p))).toEqual([null, 250, 250, 500, 1000, 1000, 2000, 4000, 6000]);
  });
  const modes = lib([
    mode({ system: 'Engine', component: 'Air filter', mode: 'Blocked', task: 'Check restriction indicator', intervalHours: 250 }),
    mode({ system: 'Cooling', component: 'Water pump', mode: 'Leak', intervalHours: 750 }),
    mode({ system: 'Brakes', component: 'Brake pack', mode: 'Worn', task: 'Measure brake wear', intervalHours: 1000, craft: 'MECH', people: 2, taskHours: 1.5, parts: [{ itemNum: 'syn-1001', description: 'Wear gauge seal', qty: 2 }] }),
    mode({ system: 'Electrical', component: 'Sensor', mode: 'Intermittent', task: 'Daily walkaround', intervalHours: 12 }),
    mode({ system: 'Frame and body', component: 'Tray', mode: 'Wear', answers: { warning: false, wearOut: true, restorable: false }, taskType: 'replacement', task: 'Replace tray liners', intervalHours: 5000, craft: 'WELD', taskHours: 16 }),
    mode({ system: 'Tyres', component: 'Rim', mode: 'Crack', answers: { warning: false, wearOut: false }, taskType: 'run_to_failure', task: '' }),
    mode({ system: 'Steering', component: 'Tie rod', mode: 'Play', consequence: 'safety', answers: { warning: false, wearOut: false }, taskType: 'redesign', task: 'Fit a tie rod with a wear indicator' }),
  ]);
  it('nested PMs hold the smaller levels they are multiples of', () => {
    const p = packageModel(modes, '793F');
    expect(p.plans.map((x) => [x.jpnum, x.tasks.map((t) => t.component)])).toEqual([
      ['793F-250', ['Air filter']],
      ['793F-500', ['Water pump', 'Air filter']],
      ['793F-1000', ['Brake pack', 'Water pump', 'Air filter']],
      ['793F-4000', ['Brake pack', 'Water pump', 'Air filter', 'Tray']],
    ]);
    const pm1000 = p.plans[2]!;
    expect(pm1000.tasks.map((t) => t.seq)).toEqual([10, 20, 30]);
    expect(pm1000.duration).toBe(2);
    expect(pm1000.tasks[0]!.parts).toEqual([{ itemNum: 'SYN-1001', description: 'Wear gauge seal', qty: 2 }]);
    expect(p.tooShort.map((m) => m.component)).toEqual(['Sensor']);
    expect(p.runToFailure.map((m) => m.component)).toEqual(['Rim']);
    expect(p.redesign.map((m) => m.component)).toEqual(['Tie rod']);
  });
  it('without nesting, each PM holds its own level only', () => {
    const p = packageModel(modes, '793F', { ...DEFAULT_RCM_SETTINGS, nested: false });
    expect(p.plans.map((x) => x.tasks.length)).toEqual([1, 1, 1, 1]);
  });
  it('warns when a job plan number is longer than Maximo allows', () => {
    const p = packageModel(modes, '793F', { ...DEFAULT_RCM_SETTINGS, prefix: 'HVC-' });
    expect(p.plans[2]!.jpnum).toBe('HVC-793F-1000');
    expect(p.plans[2]!.warnings[0]).toMatch(/10 characters/);
  });

  it('issues revisions only when the content changed, and lists the changes', () => {
    const plan = packageModel(modes, '793F').plans[1]!;
    expect(planState(plan, []).kind).toBe('not_issued');
    expect(issueJobPlan(ctx('supervisor'), [], plan, 'First issue').ok).toBe(false);
    expect(issueJobPlan(re, [], plan, ' ').ok).toBe(false);
    const r1 = issueJobPlan(re, [], plan, 'First issue');
    if (!r1.ok) throw new Error();
    expect(r1.records[0]!.revision).toBe(1);
    // Read back from the database: jsonb reorders keys. Still the same.
    const fromDb = JSON.parse(JSON.stringify(r1.records[0], (_k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).reverse()) : v))) as JobPlanVersion;
    expect(planState(plan, [fromDb]).kind).toBe('issued');
    expect(issueJobPlan(re, [fromDb], plan, 'again').ok).toBe(false);
    const pump = currentModes(modes).find((m) => m.component === 'Water pump')!;
    const rev = reviseMode(re, modes, pump.modeId, mode({ task: 'Check pump seal and weep hole for leaks and noise' }), 'Add noise check');
    if (!rev.ok) throw new Error(rev.errors.join());
    const plan2 = packageModel(rev.records, '793F').plans[1]!;
    expect(planState(plan2, [fromDb]).kind).toBe('changed');
    expect(planChanges(plan2, fromDb).changed.map((t) => t.component)).toEqual(['Water pump']);
    const r2 = issueJobPlan(re, [fromDb], plan2, 'Noise check added');
    expect(r2.ok && r2.records[1]!.revision).toBe(2);
  });

  it('exports Maximo sheets with attribute names, DRAFT status and long descriptions', () => {
    const long = 'Inspect the brake pack wear pins on all four wheel stations, record the readings, and compare with the limits in the service manual';
    const m2 = lib([mode({ system: 'Brakes', component: 'Brake pack', mode: 'Worn', task: long, intervalHours: 500, people: 2, taskHours: 1.5, parts: [{ itemNum: 'SYN-2', description: 'Pin', qty: 4 }] })]);
    const plan = packageModel(m2, '793F').plans[0]!;
    const v = issueJobPlan(re, [], plan, 'First issue');
    if (!v.ok) throw new Error();
    const sheets = maximoSheets(v.records, withRcmDefaults({ maximoOrgId: 'ORG1', maximoSiteId: 'SITE1' }));
    expect(sheets.map((s) => s.name)).toEqual(['JOBPLAN', 'JOBTASK', 'JPLABOR', 'JPMATERIAL', 'About']);
    expect(sheets[0]!.rows[1]).toEqual(['ORG1', 'SITE1', '793F-500', '793F PM 500 h (RCM)', 1.5, 'DRAFT']);
    const t = sheets[1]!.rows[1]!;
    expect((t[4] as string).length).toBe(100);
    expect(t[5]).toBe(long);
    expect(sheets[2]!.rows[1]).toEqual(['ORG1', 'SITE1', '793F-500', 10, 'MECH', 2, 1.5]);
    expect(sheets[3]!.rows[1]).toEqual(['ORG1', 'SITE1', '793F-500', 10, 'SYN-2', 'Pin', 4]);
    expect(plan.warnings.join(' ')).toMatch(/over 100 characters/);
  });
});

describe('review (docs/rcm.md)', () => {
  const modes = lib([
    mode({ system: 'Cooling', component: 'Water pump', mode: 'Leak' }),
    mode({ system: 'Tyres', component: 'Rim', mode: 'Crack', answers: { warning: false, wearOut: false }, taskType: 'run_to_failure', task: '' }),
    mode({ system: 'Brakes', component: 'Brake pack', mode: 'Worn', task: 'Measure wear' }),
    mode({ model: '797F', system: 'Cooling', component: 'Water pump', mode: 'Leak' }),
  ]);
  const assets = [truck('ht1'), truck('ht2'), truck('ht9', { model: '797F' })];
  let k = 0;
  const ev = (unitId: string, day: string, sys: string, comp: string, modes_: string[], det?: DetectionMethod, isFailure = true): DowntimeEvent => {
    const id = `e${++k}`;
    const start = L(`2026-${day} 08:00`);
    const end = L(`2026-${day} 12:00`);
    return { id, unitId, start, end, startType: 'unscheduled', isFailure, isMinorStop: !isFailure, system: sys, flags: [fixtureFlag({ id, unitId, type: 'unscheduled', start, end, release: { system: sys, component: comp, failureModes: modes_, detectionMethod: det } })] };
  };
  const events = [
    ev('ht1', '03-01', 'Cooling', 'Water pump', ['leak'], 'operator'),
    ev('ht2', '05-01', 'Cooling', 'Water pump', ['Leak'], 'alarm'),
    ev('ht2', '06-01', 'Cooling', 'Water pump', ['Leak'], 'pm'),
    ev('ht1', '07-01', 'Tyres', 'Rim', ['Crack']),
    ev('ht1', '08-01', 'Tyres', 'Rim', ['Crack']),
    ev('ht1', '08-15', 'Hydraulics', 'Hose', ['Burst']),
    ev('ht2', '08-20', 'Hydraulics', 'Hose', ['Burst']),
    ev('ht2', '09-01', 'Electrical', 'Harness', ['Unknown']),
    ev('ht9', '09-02', 'Cooling', 'Water pump', ['Leak']),
    ev('ht1', '09-03', 'Cooling', 'Water pump', ['Leak'], undefined, false),
    ev('ht1', '01-01', 'Cooling', 'Water pump', ['Leak']),
  ];
  // One more more than 365 days back: left out.
  events.push({ ...ev('ht1', '01-01', 'Cooling', 'Water pump', ['Leak']), start: L('2025-10-01 08:00') });
  const r = rcmReview(modes, events, assets, '793F', L('2026-10-28 09:00'));
  it('matches failures to modes, ignoring case, split by how they were found', () => {
    const pump = r.rows.find((x) => x.mode.component === 'Water pump')!;
    expect([pump.failures, pump.inOperation, pump.byMaintenance]).toEqual([4, 3, 1]);
    expect(pump.verdict).toBe('review_task');
    expect(r.rows.find((x) => x.mode.component === 'Rim')!.verdict).toBe('check_rtf');
    expect(r.rows.find((x) => x.mode.component === 'Brake pack')!.verdict).toBe('no_failures');
    expect(r.rows.map((x) => x.verdict)).toEqual(['review_task', 'check_rtf', 'no_failures']);
  });
  it('lists failures not in the library, and the ones that cannot be matched', () => {
    expect(r.uncovered).toEqual([{ system: 'Hydraulics', component: 'Hose', mode: 'Burst', failures: 2, eventIds: expect.any(Array) }]);
    expect(r.uncoded).toBe(1);
    expect(r.failures).toBe(9);
  });
});

describe('settings', () => {
  it('validates and keeps a reason', () => {
    expect(setRcmSettings(ctx('supervisor'), DEFAULT_RCM_SETTINGS, DEFAULT_RCM_SETTINGS, 'x').ok).toBe(false);
    expect(setRcmSettings(re, DEFAULT_RCM_SETTINGS, { ...DEFAULT_RCM_SETTINGS, packages: [250, 250] }, 'x').ok).toBe(false);
    const ok = setRcmSettings(re, DEFAULT_RCM_SETTINGS, { ...DEFAULT_RCM_SETTINGS, packages: [500, 250, 1000], maximoSiteId: ' site1 ' }, 'Site uses 3 levels');
    expect(ok.ok && ok.records[0]).toMatchObject({ packages: [250, 500, 1000], maximoSiteId: 'SITE1' });
  });
  it('stable JSON ignores key order and undefined', () => {
    expect(stableJson({ b: 1, a: [{ y: 2, x: undefined }] })).toBe(stableJson({ a: [{ y: 2 }], b: 1 }));
  });
});

describe('synthetic library', () => {
  const ds = generateFleet({ seed: 7, units: 12, days: 60, end: '2026-10-28T09:30:00.000Z' });
  it('has a library for each truck model, with issued job plans for the 793F', () => {
    const models = [...new Set(currentModes(ds.rcmModes).map((m) => m.model))].sort();
    expect(models).toEqual(['793F', '797F']);
    expect(ds.rcmModes.some((m) => m.revision > 1)).toBe(true);
    expect(ds.jobPlanVersions.length).toBeGreaterThan(0);
    for (const m of ds.rcmModes) expect(m.createdBy).toBe('demo-reliability_engineer');
    const p = packageModel(ds.rcmModes, '793F');
    expect(p.plans.length).toBeGreaterThanOrEqual(4);
    expect(p.plans.some((x) => planState(x, ds.jobPlanVersions).kind === 'issued')).toBe(true);
    expect(p.plans.some((x) => planState(x, ds.jobPlanVersions).kind === 'changed')).toBe(true);
  });
});
