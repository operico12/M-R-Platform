// Fixed plant part 2 (docs/fixed-plant.md): structure editor, shutdowns
// (KPI-039 to KPI-041), operator rounds and lube routes (KPI-042).

import { describe, expect, it } from 'vitest';
import { DEFAULT_FLAG_RULES } from '../src/config.js';
import type { ConsoleContext } from '../src/console.js';
import { changeStage, type FlagContext } from '../src/flags.js';
import { normaliseWoNumber } from '../src/imports.js';
import { dueList, saveForm, startInspection, type FormItem, type InspectionForm } from '../src/inspections.js';
import { plantTree, type PlantNode } from '../src/plant.js';
import { placementChanges, retireNode, saveNode, type NodeInput } from '../src/plant-structure.js';
import { routeCompliance, routeDue, signOffRound, startRound, submitRound, voidRound, type Round } from '../src/rounds.js';
import {
  addScope, cancelShutdown, changePlan, endShutdown, planShutdown, removeScope, scopeCandidates, shutdownReport, shutdownStatus, startShutdown, type PlanInput, type Shutdown,
} from '../src/shutdowns.js';
import { generatePlant } from '../src/synth/plant.js';
import { shiftsBetween } from '../src/time.js';
import type { Asset, DownFlag, Role, WorkOrder } from '../src/types.js';
import { L, TZ, actor, cal } from './helpers.js';

let seq = 0;
const newId = () => `id${++seq}`;
const cctx = (role: Role, now: string, userId?: string): ConsoleContext => ({ actor: { ...actor(role), ...(userId ? { userId } : {}) }, now, newId, timeZone: TZ, calendar: cal });
const node = (id: string, kind: PlantNode['kind'], fl: string | undefined, extra: Partial<PlantNode> = {}): PlantNode =>
  ({ id, tenantId: 't1', siteId: 's1', kind, name: id, order: 0, ...(fl ? { functionalLocation: fl } : {}), ...extra });
const equip = (id: string, fl: string): Asset => ({ id, tenantId: 't1', siteId: 's1', unitNumber: id.toUpperCase(), fleet: 'Concentrator', model: 'Pump', assetClass: 'fixed_plant', functionalLocation: fl, externalAssetId: fl });
const site = { tenantId: 't1', siteId: 's1' };
const pct = (v: number | null | undefined) => (v === null || v === undefined ? null : Math.round(v * 1000) / 10);

const nodes: PlantNode[] = [
  node('con', 'plant', 'CON'),
  node('grd', 'circuit', 'CON-GRD', { parentId: 'con' }),
  node('cfp', 'group', 'CON-GRD-CFP', { parentId: 'grd', needed: 1 }),
];
const p1 = equip('pp01', 'CON-GRD-CFP-PP01');
const p2 = equip('pp02', 'CON-GRD-CFP-PP02');
const sag = equip('sag01', 'CON-GRD-SAG01');
const equipment = [p1, p2, sag];
const tree = plantTree(nodes, equipment);
const NOW = L('2026-11-10 12:00');
const nin = (x: Partial<NodeInput>): NodeInput => ({ kind: 'circuit', name: 'New', order: 0, ...x });

describe('structure editor', () => {
  it('is the admin\'s: a reliability engineer can only propose, a supervisor cannot', () => {
    const add = (role: Role) => saveNode(cctx(role, NOW), nodes, equipment, site, null, nin({ name: 'Flotation', parentId: 'con', functionalLocation: 'CON-FLT' }), 'New circuit');
    expect(add('admin').ok).toBe(true);
    expect(add('reliability_engineer').ok).toBe(false);
    expect(add('supervisor').ok).toBe(false);
  });

  it('keeps kinds in their places and refuses loops', () => {
    const a = cctx('admin', NOW);
    const bad = (id: string | null, x: Partial<NodeInput>) => {
      const r = saveNode(a, nodes, equipment, site, id, nin(x), 'r');
      return r.ok ? [] : r.errors;
    };
    expect(bad(null, { kind: 'plant', parentId: 'con' }).join()).toContain('A plant has no parent');
    expect(bad(null, { kind: 'circuit' }).join()).toContain('A circuit sits under a plant or an area');
    expect(bad(null, { kind: 'group', parentId: 'con' }).join()).toContain('A redundancy group sits under a circuit or a redundancy group');
    expect(bad('grd', { kind: 'circuit', name: 'grd', parentId: 'cfp' }).join()).toContain('under itself');
    expect(bad('grd', { kind: 'area', name: 'grd', parentId: 'con' }).join()).toContain('cannot sit under');
    expect(bad(null, { kind: 'circuit', parentId: 'con', functionalLocation: 'con/grd' }).join()).toContain('already uses that functional location');
    expect(bad(null, { kind: 'circuit', parentId: 'con', needed: 0 }).join()).toContain('Needed');
    expect(saveNode(a, nodes, equipment, site, null, nin({ parentId: 'con' }), ' ').ok).toBe(false);
  });

  it('warns when needed is above what is under it, and lists equipment that changes node', () => {
    const a = cctx('admin', NOW);
    const r = saveNode(a, nodes, equipment, site, 'cfp', nin({ kind: 'group', name: 'cfp', parentId: 'grd', functionalLocation: 'CON-GRD-CFP', needed: 3 }), 'Try 3');
    expect(r.ok && r.warnings[0]).toContain('Needed (3) is more than what is under it (2)');
    const mill = saveNode(a, nodes, equipment, site, null, nin({ kind: 'group', name: 'Mills', parentId: 'grd', functionalLocation: 'CON-GRD-SAG01' }), 'Mills');
    expect(mill.ok && mill.warnings).toEqual(['SAG01 moves from grd to Mills.']);
    expect(mill.ok && mill.audit[0]).toMatchObject({ entity: 'plant_node', action: 'add_plant_node', reason: 'Mills' });
  });

  it('retires a node only once nothing active is under it, and shows where its equipment goes', () => {
    const a = cctx('admin', NOW);
    expect(retireNode(a, nodes, equipment, 'grd', 'Gone').ok).toBe(false);
    const r = retireNode(a, nodes, equipment, 'cfp', 'Pumps moved');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.records[0]).toMatchObject({ retiredAt: NOW, retireReason: 'Pumps moved' });
    expect(r.warnings).toEqual(['PP01 moves from cfp to grd.', 'PP02 moves from cfp to grd.']);
    expect(retireNode(a, nodes.map((n) => (n.id === 'cfp' ? r.records[0]! : n)), equipment, 'cfp', 'again').ok).toBe(false);
    expect(placementChanges(nodes, nodes, equipment)).toEqual([]);
  });
});

// ---------- shutdowns ----------

const S0 = L('2026-11-12 06:00');
const S1 = L('2026-11-12 18:00');
const plan = (x: Partial<PlanInput> = {}): PlanInput => ({ nodeId: 'grd', name: 'Mill reline', workOrder: 'WO-900001', plannedStart: S0, plannedEnd: S1, equipmentIds: ['sag01', 'pp01', 'pp02'], ...x });
const wo = (num: number, open: boolean, extra: Partial<WorkOrder> = {}): WorkOrder => ({
  id: `w${num}`, tenantId: 't1', siteId: 's1', assetId: 'sag01', sourceSystem: 'maximo', sourceId: String(num), number: String(num), numberNormalised: normaliseWoNumber(String(num)),
  workClass: 'pm', open, estimatedHours: 2, ...extra,
});

class FlagStore {
  flags: DownFlag[] = [];
  ctxFor(now: string, role: Role = 'supervisor') {
    return (a: Asset): FlagContext => ({ now, actor: actor(role), rules: DEFAULT_FLAG_RULES, calendar: cal, asset: a, unitFlags: this.flags.filter((f) => f.unitId === a.id), newId });
  }
  apply(fs: DownFlag[]) {
    for (const f of fs) this.flags = [...this.flags.filter((x) => x.id !== f.id), f];
  }
}

describe('shutdowns', () => {
  it('golden KPI-039 to KPI-041: 12 h planned, 14 h actual, two added after the freeze, one taken out', () => {
    const base = planShutdown(cctx('supervisor', L('2026-11-01 08:00')), tree, site, plan());
    expect(base.ok).toBe(true);
    if (!base.ok) return;
    let s = base.records[0]!;
    expect(s.freezeAt).toBe(L('2026-11-05 06:00'));
    const ten = Array.from({ length: 10 }, (_, i) => String(1000 + i));
    const a = addScope(cctx('supervisor', L('2026-11-02 08:00')), s, ten);
    s = a.ok ? a.records[0]! : s;
    expect(addScope(cctx('supervisor', L('2026-11-07 08:00')), s, ['2000']).ok).toBe(false); // after the freeze: needs a reason
    const late = addScope(cctx('supervisor', L('2026-11-07 08:00')), s, ['2000', '2001', '1000'], 'Found on inspection');
    expect(late.ok && late.warnings).toEqual(['1000 is already in scope.']);
    s = late.ok ? late.records[0]! : s;
    const out = removeScope(cctx('supervisor', L('2026-11-08 08:00')), s, s.scope[0]!.id, 'Parts not on site');
    s = out.ok ? out.records[0]! : s;
    s = { ...s, actualStart: L('2026-11-12 06:30'), actualEnd: L('2026-11-12 20:30') };
    const closed = ['1001', '1002', '1003', '1004', '1005', '1006', '1007', '2000', '2001'];
    const wos = [...ten.slice(1), '2000', '2001'].map((n) => wo(Number(n), !closed.includes(n)));
    const r = shutdownReport(s, wos, NOW);
    expect(r).toMatchObject({ status: 'completed', plannedHours: 12, actualHours: 14, overrunHours: 2, lateStartHours: 0.5, inScope: 11, atFreeze: 9, added: 2, removed: 1, done: 9 });
    expect(pct(r.ofPlan)).toBe(116.7);
    expect(pct(r.addedShare)).toBe(22.2);
    expect(pct(r.completion)).toBe(81.8);
    expect(r.estimatedHours).toBe(22);
    expect(r.estimatedHoursDone).toBe(18);
    expect(r.rows.filter((x) => !x.item.removedAt && x.state === 'open').map((x) => x.item.workOrder)).toEqual(['1008', '1009']);
  });

  it('lists work orders not in the import yet, and suggests shutdown work on its equipment', () => {
    const p = planShutdown(cctx('supervisor', NOW), tree, site, plan());
    if (!p.ok) throw new Error();
    const s = addScope(cctx('supervisor', NOW), p.records[0]!, ['WO-1'], 'Late find')!;
    if (!s.ok) throw new Error();
    const r = shutdownReport(s.records[0]!, [], NOW);
    expect(r).toMatchObject({ notImported: 1, done: 0, completion: 0, actualHours: null, status: 'planned' });
    const wos = [
      wo(1, true), wo(2, true, { status: 'WPCOND' }), wo(3, true, { targetStart: L('2026-11-12 08:00') }), wo(4, true, { targetStart: L('2026-12-01 08:00') }),
      wo(5, false, { targetStart: S0 }), wo(6, true, { assetId: 'other', status: 'WPCOND' }), wo(7, true, { scheduledStart: L('2026-11-11 07:00') }),
    ];
    expect(scopeCandidates(s.records[0]!, wos).map((w) => w.number)).toEqual(['2', '3', '7']);
  });

  it('checks the plan and who can do it', () => {
    const errs = (x: Partial<PlanInput>) => { const r = planShutdown(cctx('supervisor', NOW), tree, site, plan(x)); return r.ok ? [] : r.errors; };
    expect(errs({ plannedEnd: S0 }).join()).toContain('after the planned start');
    expect(errs({ nodeId: 'cfp' }).join()).toContain('not a redundancy group');
    expect(errs({ workOrder: ' ' }).join()).toContain('master work order');
    expect(errs({ equipmentIds: ['zz'] }).join()).toContain('Only equipment under the node');
    expect(errs({ freezeAt: S1 }).join()).toContain('scope freeze');
    expect(planShutdown(cctx('technician', NOW), tree, site, plan()).ok).toBe(false);
    expect(planShutdown(cctx('viewer', NOW), tree, site, plan()).ok).toBe(false);
    const p = planShutdown(cctx('reliability_engineer', NOW), tree, site, plan());
    if (!p.ok) throw new Error();
    const s = p.records[0]!;
    expect(changePlan(cctx('supervisor', NOW), tree, s, plan({ plannedEnd: L('2026-11-12 20:00') }), '').ok).toBe(false);
    const c = changePlan(cctx('supervisor', NOW), tree, s, plan({ plannedEnd: L('2026-11-12 20:00') }), 'Liner delivery late');
    expect(c.ok && c.records[0]!.plannedEnd).toBe(L('2026-11-12 20:00'));
    const x = cancelShutdown(cctx('supervisor', NOW), s, 'Moved to December');
    expect(x.ok && shutdownStatus(x.records[0]!)).toBe('cancelled');
    expect(cancelShutdown(cctx('supervisor', NOW), { ...s, actualStart: S0 }, 'No').ok).toBe(false);
    expect(addScope(cctx('supervisor', NOW), { ...s, actualEnd: S1, actualStart: S0 }, ['1'], 'r').ok).toBe(false);
  });

  it('starting raises scheduled flags in repair; ending releases them; a flag already open carries on', () => {
    const fs = new FlagStore();
    const now0 = L('2026-11-12 06:10');
    // PP02 is already down for a seal.
    const p2flag: DownFlag = {
      id: 'old', tenantId: 't1', siteId: 's1', unitId: 'pp02', type: 'unscheduled', state: 'open', reasonCode: 'Sealing', start: L('2026-11-12 02:00'), end: null,
      stages: [{ stage: 'in_repair', start: L('2026-11-12 02:00'), end: null, setBy: 'u', enteredAt: L('2026-11-12 02:00') }],
      locations: [{ kind: 'in_place', start: L('2026-11-12 02:00'), end: null, setBy: 'u', enteredAt: L('2026-11-12 02:00') }], etas: [], workOrders: [], source: 'app', setBy: 'u', enteredAt: L('2026-11-12 02:00'),
    };
    fs.apply([p2flag]);
    const p = planShutdown(cctx('supervisor', L('2026-11-01 08:00')), tree, site, plan());
    if (!p.ok) throw new Error();
    const st = startShutdown(cctx('supervisor', now0), p.records[0]!, equipment, fs.ctxFor(now0), { at: S0, reasonCode: 'SHUTDOWN' });
    expect(st.ok).toBe(true);
    if (!st.ok) return;
    expect(st.warnings).toEqual(['PP02 already has an open flag; it carries on.']);
    expect(st.flags.map((f) => f.unitId)).toEqual(['sag01', 'pp01']);
    for (const f of st.flags) {
      expect(f).toMatchObject({ type: 'scheduled', state: 'open', start: S0, reasonCode: 'SHUTDOWN', workOrders: ['WO-900001'], plannedDurationHours: 12 });
      expect(f.locations[0]!.kind).toBe('in_place');
      expect(f.stages.at(-1)).toMatchObject({ stage: 'in_repair', end: null });
    }
    expect(st.shutdown).toMatchObject({ actualStart: S0, flagIds: st.flags.map((f) => f.id) });
    expect(st.audit.map((x) => x.action)).toContain('start_shutdown');
    fs.apply(st.flags);
    expect(startShutdown(cctx('supervisor', now0), st.shutdown, equipment, fs.ctxFor(now0), { at: S0, reasonCode: 'SHUTDOWN' }).ok).toBe(false);
    // PP01 waits for parts, so it cannot be released with the rest.
    const pp01 = fs.flags.find((f) => f.unitId === 'pp01' && f.type === 'scheduled')!;
    const wp = changeStage(fs.ctxFor(L('2026-11-12 10:00'))(p1), pp01, { stage: 'waiting_parts', at: L('2026-11-12 10:00') });
    if (!wp.ok) throw new Error(wp.errors.join());
    fs.apply(wp.flags);
    const now1 = L('2026-11-12 20:40');
    expect(endShutdown(cctx('supervisor', now1), st.shutdown, equipment, fs.flags, fs.ctxFor(now1), { at: L('2026-11-13 20:30'), findings: '' }).ok).toBe(false);
    const en = endShutdown(cctx('supervisor', now1), st.shutdown, equipment, fs.flags, fs.ctxFor(now1), { at: L('2026-11-12 20:30'), findings: 'Liners 40% left' });
    expect(en.ok).toBe(true);
    if (!en.ok) return;
    expect(en.flags.map((f) => [f.unitId, f.state, f.end])).toEqual([['sag01', 'released', L('2026-11-12 20:30')]]);
    expect(en.flags[0]!.release).toMatchObject({ pmOrWorkOrder: 'WO-900001', repairSummary: 'Shutdown Mill reline complete', findings: 'Liners 40% left' });
    expect(en.warnings[0]).toContain('PP01 is still down');
    expect(en.shutdown).toMatchObject({ actualEnd: L('2026-11-12 20:30'), findings: 'Liners 40% left' });
    expect(shutdownStatus(en.shutdown)).toBe('completed');
  });

  it('starting needs the flag permission on the equipment too', () => {
    const fs = new FlagStore();
    const p = planShutdown(cctx('supervisor', L('2026-11-01 08:00')), tree, site, plan());
    if (!p.ok) throw new Error();
    const supOther = (a: Asset): FlagContext => ({ ...fs.ctxFor(L('2026-11-12 06:10'))(a), actor: actor('supervisor', ['Haul trucks']) });
    const st = startShutdown(cctx('supervisor', L('2026-11-12 06:10')), p.records[0]!, equipment, supOther, { at: S0, reasonCode: 'SHUTDOWN' });
    expect(st.ok).toBe(false);
    expect(st.ok || st.errors[0]).toContain('cannot flag');
    expect(startShutdown(cctx('supervisor', L('2026-11-12 05:00')), p.records[0]!, equipment, fs.ctxFor(L('2026-11-12 05:00')), { at: S0, reasonCode: 'SHUTDOWN' }).ok).toBe(false);
  });
});

// ---------- rounds ----------

const item = (stop: string, id: string, kind: FormItem['kind'], over: Partial<FormItem> = {}): FormItem =>
  ({ id: `${stop}-${id}`, section: stop, text: `${stop} ${id}`, kind, critical: false, weight: 1, photoOnFail: false, stopId: stop, ...over });
const routeItems = [item('sag01', 'oil', 'reading', { min: 1.5, max: 3, critical: true }), item('pp01', 'seal', 'pass_fail'), item('pp01', 'grease', 'task'), item('pp02', 'seal', 'pass_fail')];
const routeInput = { name: 'Grinding round', assetClass: 'fixed_plant' as const, models: [], every: { n: 1, unit: 'shifts' as const }, items: routeItems, route: { kind: 'operator_round' as const, nodeId: 'grd', stops: ['sag01', 'pp01', 'pp02'] } };

function makeRoute(): InspectionForm {
  const r = saveForm(cctx('reliability_engineer', L('2026-11-01 08:00')), [], null, routeInput, 'First');
  if (!r.ok) throw new Error(r.errors.join());
  return r.records[0]!;
}

describe('operator rounds and lube routes', () => {
  it('checks the route form', () => {
    const errs = (x: object) => { const r = saveForm(cctx('reliability_engineer', NOW), [], null, { ...routeInput, ...x }, 'r'); return r.ok ? [] : r.errors; };
    expect(errs({ assetClass: 'mobile' }).join()).toContain('A route is for fixed plant');
    expect(errs({ every: { n: 100, unit: 'smu_hours' } }).join()).toContain('every so many shifts or days');
    expect(errs({ route: { ...routeInput.route, stops: ['sag01', 'pp01', 'pp02', 'cv01'] } }).join()).toContain('Every stop needs at least one item');
    expect(errs({ items: [...routeItems, item('zz', 'x', 'pass_fail')] }).join()).toContain('pick its stop');
    expect(errs({ route: undefined }).join()).toContain('Only plant routes are due by shift');
    expect(errs({ route: undefined, every: { n: 1, unit: 'days' } }).join()).toContain('only route items have a stop');
    const f = makeRoute();
    expect(f.route).toEqual(routeInput.route);
    // Route forms are not done as unit inspections, and are not in the unit due list.
    expect(startInspection(cctx('technician', NOW), [], f, sag).ok).toBe(false);
    expect(dueList([f], equipment, [], [], NOW, TZ)).toEqual([]);
  });

  it('a round makes one inspection per stop done; a skipped stop needs a reason; missed lube is a defect', () => {
    const f = makeRoute();
    const tech = cctx('technician', NOW);
    const s = startRound(tech, f);
    if (!s.ok) throw new Error();
    expect(s.drafts.map((d) => d.unitId)).toEqual(['sag01', 'pp01', 'pp02']);
    const fill = (unit: string, answers: Record<string, { value: string | number; note?: string }>) => s.drafts.map((d) => (d.unitId === unit ? { ...d, answers: { ...d.answers, ...answers } } : d));
    let drafts = fill('sag01', { 'sag01-oil': { value: 2.2 } });
    drafts = drafts.map((d) => (d.unitId === 'pp01' ? { ...d, answers: { 'pp01-seal': { value: 'pass' }, 'pp01-grease': { value: 'missed' } } } : d));
    const first = submitRound(tech, f, s.round, drafts, [], equipment);
    expect(first.ok).toBe(false);
    expect(!first.ok && first.errors).toEqual(expect.arrayContaining(['PP01: 2. pp01 grease: failed, so add a note.', 'PP02: 1. pp02 seal: not answered.']));
    expect(submitRound(tech, f, s.round, drafts, [{ stopId: 'pp02', reason: ' ' }], equipment).ok).toBe(false);
    drafts = drafts.map((d) => (d.unitId === 'pp01' ? { ...d, answers: { ...d.answers, 'pp01-grease': { value: 'missed', note: 'Line blocked' } } } : d));
    const ok = submitRound(tech, f, s.round, drafts, [{ stopId: 'pp02', reason: 'Equipment down' }], equipment);
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.round).toMatchObject({ status: 'submitted', skipped: [{ stopId: 'pp02', reason: 'Equipment down' }] });
    expect(ok.inspections.map((i) => [i.unitId, i.roundId, i.status, i.result])).toEqual([['sag01', s.round.id, 'submitted', 'pass'], ['pp01', s.round.id, 'submitted', 'defects']]);
    expect(ok.inspections[1]!.defects).toMatchObject([{ itemId: 'pp01-grease', text: 'pp01 grease: Line blocked', severity: 'medium', status: 'open' }]);
    expect(ok.inspections[1]!.score).toBe(0.5);
    expect(ok.audit.map((a) => a.action)).toEqual(['submit_inspection', 'submit_inspection', 'submit_round']);
    // Sign-off and void as inspections.
    expect(signOffRound(cctx('supervisor', NOW, 'technician-1'), ok.round, ok.inspections, '').ok).toBe(false);
    const so = signOffRound(cctx('supervisor', NOW), ok.round, ok.inspections, 'Seen');
    expect(so.ok && so.inspections.map((i) => i.status)).toEqual(['signed_off', 'signed_off']);
    expect(voidRound(cctx('technician', NOW), ok.round, ok.inspections, 'Wrong route').ok).toBe(false);
    const v = voidRound(cctx('superintendent', NOW), ok.round, ok.inspections, 'Wrong route');
    expect(v.ok && [v.round.status, ...v.inspections.map((i) => i.status)]).toEqual(['voided', 'voided', 'voided']);
    expect(submitRound(tech, f, s.round, drafts, [{ stopId: 'sag01', reason: 'x' }, { stopId: 'pp01', reason: 'x' }, { stopId: 'pp02', reason: 'x' }], equipment).ok).toBe(false);
  });

  it('due: done this shift is ok, next shift it is due now, the shift after overdue', () => {
    const f = makeRoute();
    const round = (at: string): Round => ({ id: `r${at}`, formId: f.id, formVersion: 1, nodeId: 'grd', status: 'submitted', startedBy: 'x', startedAt: at, submittedAt: at, skipped: [] });
    const done = [round(L('2026-11-10 08:00'))];
    expect(routeDue([f], [], cal, NOW)[0]!.state).toBe('never');
    expect(routeDue([f], done, cal, L('2026-11-10 12:00'))[0]!.state).toBe('ok');
    const next = routeDue([f], done, cal, L('2026-11-10 20:00'))[0]!;
    expect(next.state).toBe('due_soon');
    expect(next.dueBy).toBe(L('2026-11-11 06:00'));
    expect(routeDue([f], done, cal, L('2026-11-11 07:00'))[0]!.state).toBe('overdue');
    const weekly = { ...f, id: 'w', every: { n: 7, unit: 'days' as const } };
    const wr = [{ ...round(L('2026-11-03 09:00')), formId: 'w' }];
    expect(routeDue([weekly], wr, cal, L('2026-11-08 09:00'))[0]!.state).toBe('due_soon');
    expect(routeDue([weekly], wr, cal, L('2026-11-11 09:00'))[0]!.state).toBe('overdue');
  });

  it('golden KPI-042: 13 of 14 shifts done is 92.9%; every 2 shifts gives 7 periods', () => {
    const f = makeRoute();
    const from = L('2026-11-02 06:00');
    const to = L('2026-11-09 06:00');
    const shifts = shiftsBetween(cal, from, to).filter((s) => Date.parse(s.start) >= Date.parse(from));
    expect(shifts).toHaveLength(14);
    const at = (i: number, h = 1) => new Date(Date.parse(shifts[i]!.start) + h * 3_600_000).toISOString();
    const rounds: Round[] = shifts.flatMap((_, i) => (i === 5 ? [] : [i])).map((i) => ({ id: `r${i}`, formId: f.id, formVersion: 1, nodeId: 'grd', status: 'submitted', startedBy: 'x', startedAt: at(i), skipped: [] }));
    rounds.push({ ...rounds[0]!, id: 'twice', startedAt: at(0, 5) });
    rounds.push({ ...rounds[0]!, id: 'void', status: 'voided', startedAt: at(5) });
    const c = routeCompliance([f], rounds, { from, to }, cal, L('2026-11-20 00:00'))[0]!;
    expect([c.due, c.done, pct(c.value)]).toEqual([14, 13, 92.9]);
    const two = routeCompliance([{ ...f, every: { n: 2, unit: 'shifts' } }], rounds, { from, to }, cal, L('2026-11-20 00:00'))[0]!;
    expect([two.due, two.done]).toEqual([7, 7]);
    // While the week runs, the current shift counts only once done.
    const mid = routeCompliance([f], rounds.filter((r) => r.id !== 'r6'), { from, to }, cal, at(6, 2))[0]!;
    expect([mid.due, mid.done]).toEqual([6, 5]);
  });
});

describe('synthetic concentrator, part 2', () => {
  const end = Date.parse('2026-10-29T16:00:00.000Z');
  const d = generatePlant({ seed: 42, days: 120, end, timeZone: TZ });

  it('has past shutdowns with released flags, and the next one planned', () => {
    expect(d.shutdowns.length).toBeGreaterThanOrEqual(4);
    const next = d.shutdowns.at(-1)!;
    expect(shutdownStatus(next)).toBe('planned');
    expect(Date.parse(next.plannedStart)).toBeGreaterThan(end);
    expect(next.scope.some((s) => s.late)).toBe(true);
    for (const s of d.shutdowns.slice(0, -1)) {
      expect(shutdownStatus(s)).toBe('completed');
      expect(s.flagIds.length).toBeGreaterThan(0);
      for (const id of s.flagIds) expect(d.flags.find((f) => f.id === id)).toMatchObject({ type: 'scheduled', state: 'released', reasonCode: 'SHUTDOWN', workOrders: [s.workOrder] });
      const r = shutdownReport(s, d.workOrders, new Date(end).toISOString());
      expect(r.ofPlan!).toBeGreaterThanOrEqual(1);
      expect(r.completion!).toBeGreaterThan(0.5);
      expect(r.notImported).toBe(0);
    }
  });

  it('has rounds on every shift but a few, with defects, and the grinding round due now', () => {
    const now = new Date(end).toISOString();
    const due = routeDue(d.forms, d.rounds, cal, now);
    expect(due.find((x) => x.form.id === 'rt-grd')!.state).toBe('due_soon');
    const c = routeCompliance(d.forms, d.rounds, { from: new Date(end - 14 * 864e5).toISOString(), to: now }, cal, now);
    for (const x of c) expect(x.value!).toBeGreaterThan(0.8);
    expect(d.inspections.every((i) => d.rounds.some((r) => r.id === i.roundId) && d.equipment.some((a) => a.id === i.unitId))).toBe(true);
    expect(d.inspections.some((i) => i.defects.some((x) => x.status === 'open'))).toBe(true);
    for (const f of d.forms) expect(saveForm(cctx('reliability_engineer', now), [], null, f, 'check').ok).toBe(true);
  });

  it('is deterministic', () => {
    const again = generatePlant({ seed: 42, days: 120, end, timeZone: TZ });
    expect(again.rounds).toEqual(d.rounds);
    expect(again.shutdowns).toEqual(d.shutdowns);
  });
});
