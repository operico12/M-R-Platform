import { describe, expect, it } from 'vitest';
import { DEFAULT_FLAG_RULES } from '../src/config.js';
import type { FlagContext } from '../src/flags.js';
import { computeKpis, countingFlags } from '../src/kpis.js';
import { releaseChecklist } from '../src/flags.js';
import { generatePlant } from '../src/synth/plant.js';
import {
  DEFAULT_PLANT_SETTINGS, classifyAsDelay, classifyAsMaintenance, classifyNotAStop, detectStops, endDelay, flSegments, groupStops, parseHistorianCsv,
  plantNow, plantReport, plantTree, proposeStop, recordDelay, resumeAfter, runReadings, runningWhileDown, setPlantSettings, tripsPerWeek, voidDelay,
  withPlantDefaults, wordsFor, type DelayContext, type PlantInput, type PlantNode, type ProcessDelay, type RunSignal,
} from '../src/plant.js';
import type { Actor, Asset, DownFlag, Role } from '../src/types.js';
import { L, TZ, actor, cal } from './helpers.js';

const node = (id: string, kind: PlantNode['kind'], fl: string, extra: Partial<PlantNode> = {}): PlantNode => ({ id, tenantId: 't1', siteId: 's1', kind, name: id, order: 0, functionalLocation: fl, ...extra });
const equip = (id: string, fl: string): Asset => ({ id, tenantId: 't1', siteId: 's1', unitNumber: id.toUpperCase(), fleet: 'Concentrator', model: 'Pump', assetClass: 'fixed_plant', functionalLocation: fl, externalAssetId: fl });

const W0 = L('2026-11-02 00:00');
const W1 = L('2026-11-09 00:00');
const week = { from: W0, to: W1 };

function flag(id: string, unitId: string, start: string, end: string | null, type: DownFlag['type'] = 'unscheduled', system = 'Mechanical'): DownFlag {
  return {
    id, tenantId: 't1', siteId: 's1', unitId, type, state: end ? 'released' : 'open', reasonCode: system, system, start, end,
    stages: [{ stage: 'in_repair', start, end, setBy: 'u', enteredAt: start }],
    locations: [{ kind: 'in_place', start, end, functionalLocation: 'x', setBy: 'u', enteredAt: start }],
    etas: [], workOrders: [], source: 'app', setBy: 'u', enteredAt: start, release: end ? { system } : undefined,
  };
}

// Plant: one circuit with a duty and standby pump pair (1 of 2) and a conveyor in series.
const nodes: PlantNode[] = [
  node('con', 'plant', 'CON', { plannedRateTph: 1000 }),
  node('grd', 'circuit', 'CON-GRD', { parentId: 'con', plannedRateTph: 1000 }),
  node('cfp', 'group', 'CON-GRD-CFP', { parentId: 'grd', needed: 1 }),
];
const p1 = equip('pp01', 'CON-GRD-CFP-PP01');
const p2 = equip('pp02', 'CON-GRD-CFP-PP02');
const cv = equip('cv01', 'CON-GRD-CV01');
const equipment = [p1, p2, cv];
const input = (x: Partial<PlantInput> = {}): PlantInput => ({ nodes, equipment, flags: [], delays: [], signals: [], now: W1, ...x });
const countingFlagsOf = (fs: DownFlag[], id: string) => countingFlags(fs).filter((f) => f.unitId === id).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
const pct = (v: number | null | undefined) => (v === null || v === undefined ? null : Math.round(v * 1000) / 10);

describe('words and structure', () => {
  it('uses plant words for fixed plant', () => {
    expect(wordsFor('fixed_plant')).toMatchObject({ unit: 'Equipment', fleet: 'Circuit', meter: 'Run hours', workLocation: 'Work location' });
    expect(wordsFor('mobile').meter).toBe('SMU');
  });

  it('places equipment by the longest functional location prefix, segment by segment', () => {
    expect(flSegments('con-grd/cfp.PP01')).toEqual(['CON', 'GRD', 'CFP', 'PP01']);
    const other = equip('pp9', 'CON-GRD-CFP2-PP09');
    const lost = equip('x1', 'MILL-01');
    const t = plantTree(nodes, [...equipment, other, lost, { ...equip('ht1', 'CON-GRD'), assetClass: 'mobile' }]);
    expect(t.byId.get('cfp')!.equipment.map((a) => a.id)).toEqual(['pp01', 'pp02']);
    expect(t.byId.get('grd')!.equipment.map((a) => a.id)).toEqual(['cv01', 'pp9']);
    expect(t.unplaced.map((a) => a.id)).toEqual(['x1']);
    expect(t.byId.get('cfp')!.needed).toBe(1);
    expect(t.byId.get('grd')!.needed).toBe(3); // series: group + conveyor + pp9
  });

  it('leaves retired nodes out', () => {
    const t = plantTree([...nodes.slice(0, 2), { ...nodes[2]!, retiredAt: W0, retireReason: 'Replaced' }], equipment);
    expect(t.byId.has('cfp')).toBe(false);
    expect(t.byId.get('grd')!.equipment.map((a) => a.id)).toEqual(['cv01', 'pp01', 'pp02']);
  });
});

describe('golden: duty and standby pump pair (plan Appendix E)', () => {
  it('duty pump down 6 h while the standby runs: circuit stays available', () => {
    const f = flag('f1', 'pp01', L('2026-11-03 10:00'), L('2026-11-03 16:00'));
    const r = plantReport(input({ flags: [f] }), week);
    expect(pct(r.summary.get('pp01')!.availability)).toBe(96.4);
    expect(pct(r.summary.get('pp02')!.availability)).toBe(100);
    expect(pct(r.summary.get('grd')!.availability)).toBe(100);
    expect(r.summary.get('grd')!.lost).toEqual([]);
    expect(r.summary.get('con')!.lostTonnes).toEqual({ maintenance: 0, process: 0 });
    // Same as the tier 1 engine (KPI-033 = KPI-001).
    expect(pct(computeKpis({ assets: [p1], flags: [f], smu: [], rules: DEFAULT_FLAG_RULES, now: W1 }, week).pa)).toBe(96.4);
  });

  it('both pumps down for 2 h: circuit down 2 h, lost tonnes shared between both causes', () => {
    const f1 = flag('f1', 'pp01', L('2026-11-03 10:00'), L('2026-11-03 16:00'), 'unscheduled', 'Mechanical');
    const f2 = flag('f2', 'pp02', L('2026-11-03 12:00'), L('2026-11-03 14:00'), 'unscheduled', 'Sealing');
    const r = plantReport(input({ flags: [f1, f2] }), week);
    const g = r.summary.get('grd')!;
    expect(g.downHours).toBeCloseTo(2, 6);
    expect(pct(g.availability)).toBe(98.8);
    expect(g.lostTonnes!.maintenance).toBeCloseTo(2000, 6);
    expect(g.lost.map((x) => [x.cause, x.kind, x.tonnes])).toEqual([['Mechanical', 'maintenance', 1000], ['Sealing', 'maintenance', 1000]]);
    expect(r.summary.get('con')!.downHours).toBeCloseTo(2, 6);
  });
});

describe('golden: conveyor stopped by a full stockpile (plan Appendix E)', () => {
  it('is a process delay, not maintenance downtime', () => {
    const d: ProcessDelay = { id: 'd1', tenantId: 't1', siteId: 's1', nodeId: 'grd', assetId: 'cv01', code: 'Bins or stockpile full', start: L('2026-11-04 08:00'), end: L('2026-11-04 11:00'), setBy: 'u', enteredAt: W0 };
    const r = plantReport(input({ delays: [d] }), week);
    const g = r.summary.get('grd')!;
    expect(pct(r.summary.get('cv01')!.availability)).toBe(100);
    expect(pct(g.availability)).toBe(100);
    expect(g.delayHours).toBeCloseTo(3, 6);
    expect(g.lostTonnes).toEqual({ maintenance: 0, process: 3000 });
    expect(g.lost).toEqual([{ cause: 'Bins or stockpile full', kind: 'process', hours: 3, tonnes: 3000 }]);
  });

  it('maintenance wins where it alone takes the node below needed', () => {
    const d: ProcessDelay = { id: 'd1', tenantId: 't1', siteId: 's1', nodeId: 'grd', assetId: 'cv01', code: 'No feed', start: L('2026-11-04 08:00'), end: L('2026-11-04 11:00'), setBy: 'u', enteredAt: W0 };
    const f1 = flag('f1', 'pp01', L('2026-11-04 09:00'), L('2026-11-04 10:00'));
    const f2 = flag('f2', 'pp02', L('2026-11-04 09:00'), L('2026-11-04 10:00'));
    const g = plantReport(input({ delays: [d], flags: [f1, f2] }), week).summary.get('grd')!;
    expect(g.downHours).toBeCloseTo(1, 6);
    expect(g.delayHours).toBeCloseTo(2, 6);
  });

  it('a delay on the node itself turns available into process delay, never hides down, never overrides running', () => {
    const d: ProcessDelay = { id: 'd1', tenantId: 't1', siteId: 's1', nodeId: 'grd', code: 'Power supply', start: L('2026-11-04 08:00'), end: L('2026-11-04 12:00'), setBy: 'u', enteredAt: W0 };
    const f = flag('f1', 'cv01', L('2026-11-04 08:00'), L('2026-11-04 09:00'));
    const sig: RunSignal[] = [p1, cv].flatMap((a) => [{ assetId: a.id, at: L('2026-11-04 11:00'), running: true }, { assetId: a.id, at: L('2026-11-04 13:00'), running: false }]);
    const g = plantReport(input({ delays: [d], flags: [f], signals: sig }), week).summary.get('grd')!;
    expect(g.downHours).toBeCloseTo(1, 6); // 08-09 conveyor down
    expect(g.delayHours).toBeCloseTo(2, 6); // 09-11 power; 11-12 running wins
    expect(g.runHours).toBeCloseTo(2, 6);
    expect(g.lost.find((x) => x.cause === 'Power supply')!.hours).toBeCloseTo(2, 6);
  });
});

describe('run hours and utilisation', () => {
  const sig: RunSignal[] = [
    { assetId: 'pp01', at: L('2026-11-02 00:00'), running: true },
    { assetId: 'pp01', at: L('2026-11-05 00:00'), running: false },
    { assetId: 'pp02', at: L('2026-11-05 00:00'), running: true },
    { assetId: 'cv01', at: L('2026-11-02 00:00'), running: true },
  ];

  it('turns signals into meter readings the KPI engine uses unchanged', () => {
    const rs = runReadings(sig, W1);
    expect(rs.filter((r) => r.unitId === 'pp01').map((r) => r.hours)).toEqual([0, 72, 72]);
    expect(rs.filter((r) => r.unitId === 'pp02').at(-1)!.hours).toBe(96);
    const k = computeKpis({ assets: [p1], flags: [], smu: rs, rules: DEFAULT_FLAG_RULES, now: W1 }, week);
    expect(k.operatingHours).toBeCloseTo(72, 6);
    expect(pct(k.utilisation)).toBe(42.9);
  });

  it('circuit runs when at least the needed children run', () => {
    const r = plantReport(input({ signals: sig }), week);
    expect(r.summary.get('grd')!.runHours).toBeCloseTo(168, 6);
    expect(pct(r.summary.get('grd')!.utilisation)).toBe(100);
    expect(pct(r.summary.get('pp01')!.utilisation)).toBe(42.9);
    // No signals at all: utilisation is left empty, availability still works.
    expect(plantReport(input(), week).summary.get('grd')!.utilisation).toBeNull();
    expect(plantNow(input({ signals: sig })).get('pp01')!.state).toBe('idle');
    expect(plantNow(input({ signals: sig })).get('grd')!.state).toBe('run');
  });

  it('R14 for plant: running while flagged down', () => {
    const f = flag('f1', 'cv01', L('2026-11-03 10:00'), L('2026-11-03 16:00'));
    const a = runningWhileDown(input({ signals: sig, flags: [f] }), 0.5);
    expect(a).toHaveLength(1);
    expect(a[0]!.hours).toBeCloseTo(6, 6);
    expect(a[0]!.message).toContain('R14');
  });

  it('trips per week counts unscheduled events', () => {
    const fl = [flag('a', 'pp01', L('2026-11-03 10:00'), L('2026-11-03 11:00')), flag('b', 'pp01', L('2026-11-04 10:00'), L('2026-11-04 10:05')), flag('c', 'pp01', L('2026-11-05 10:00'), L('2026-11-05 18:00'), 'scheduled')];
    expect(tripsPerWeek(fl, ['pp01'], DEFAULT_FLAG_RULES, week, W1)).toEqual({ trips: 2, perWeek: 2 });
  });
});

describe('historian file', () => {
  it('reads tags, local site time and states; lists bad rows', () => {
    const text = 'tag,timestamp,value\nPP01.RUN,2026-11-02 06:00,1\nCON-GRD-CV01,2026-11-02T14:00:00Z,STOP\nPP99,2026-11-02 06:00,1\nPP01,02/11/2026,1\nPP01,2026-11-02 07:00,maybe\nPP01,2026-11-02 06:00,0\nPP02,2027-01-01 00:00,1\n';
    const r = parseHistorianCsv(text, equipment, TZ, [], W1);
    expect(r.signals).toEqual([
      { assetId: 'pp01', at: L('2026-11-02 06:00'), running: true },
      { assetId: 'cv01', at: '2026-11-02T14:00:00.000Z', running: false },
    ]);
    expect(r.issues.map((i) => i.row)).toEqual([4, 5, 6, 7, 8]);
    expect(r.stats).toEqual({ rows: 7, added: 2, skipped: 5 });
    expect(parseHistorianCsv('a,b\n1,2', equipment, TZ, [], W1).issues[0]!.message).toContain('tag, timestamp and value');
    // Loading the same file again adds nothing.
    expect(parseHistorianCsv(text, equipment, TZ, r.signals, W1).stats.added).toBe(0);
  });
});

describe('stop detection and classification', () => {
  const sup = actor('supervisor', ['Concentrator']);
  const ctxFor = (who: Actor, flags: DownFlag[], rules = DEFAULT_FLAG_RULES) => (assetId: string): FlagContext => ({
    now: W1, actor: who, rules, calendar: cal, asset: equipment.find((a) => a.id === assetId)!, unitFlags: flags.filter((f) => f.unitId === assetId), newId: () => `n${Math.random()}`,
  });
  const dctx = (who: Actor): DelayContext => ({ actor: who, now: W1, newId: () => 'd-new', timeZone: TZ, calendar: cal, area: 'Concentrator' });
  const sig: RunSignal[] = [
    { assetId: 'pp01', at: L('2026-11-02 00:00'), running: true },
    { assetId: 'cv01', at: L('2026-11-02 00:00'), running: true },
    // Duty changeover: PP02 starts a minute before PP01 stops.
    { assetId: 'pp02', at: L('2026-11-03 06:59'), running: true },
    { assetId: 'pp01', at: L('2026-11-03 07:00'), running: false },
    // Conveyor trip 10:42 to 11:30, and a 30 s blip.
    { assetId: 'cv01', at: L('2026-11-04 10:42'), running: false },
    { assetId: 'cv01', at: L('2026-11-04 11:30'), running: true },
    { assetId: 'cv01', at: '2026-11-05T12:00:00.000Z', running: false },
    { assetId: 'cv01', at: '2026-11-05T12:00:30.000Z', running: true },
    // Still stopped now.
    { assetId: 'cv01', at: L('2026-11-08 20:00'), running: false },
  ];

  it('finds stops, ignores chatter, marks covered changeovers', () => {
    const s = detectStops(input({ signals: sig }), DEFAULT_PLANT_SETTINGS);
    expect(s.map((x) => [x.assetId, x.start, x.end, x.covered])).toEqual([
      ['pp01', L('2026-11-03 07:00'), null, true],
      ['cv01', L('2026-11-04 10:42'), L('2026-11-04 11:30'), false],
      ['cv01', L('2026-11-08 20:00'), null, false],
    ]);
    expect(detectStops(input({ signals: sig }), { ...DEFAULT_PLANT_SETTINGS, coveredStops: 'skip' }).map((x) => x.assetId)).toEqual(['cv01', 'cv01']);
    expect(detectStops(input({ signals: sig }), DEFAULT_PLANT_SETTINGS, { since: L('2026-11-05 00:00') })).toHaveLength(1);
  });

  it('skips stops already covered by a flag, a proposal, a rejected proposal or a delay', () => {
    const f = flag('f1', 'cv01', L('2026-11-04 10:45'), L('2026-11-04 11:30'));
    expect(detectStops(input({ signals: sig, flags: [f] }), DEFAULT_PLANT_SETTINGS).map((x) => x.start)).not.toContain(L('2026-11-04 10:42'));
    const rejected: DownFlag = { ...flag('f2', 'pp01', L('2026-11-03 07:00'), null), state: 'voided', end: null, source: 'historian' };
    expect(detectStops(input({ signals: sig, flags: [rejected] }), DEFAULT_PLANT_SETTINGS).map((x) => x.assetId)).toEqual(['cv01', 'cv01']);
    const d: ProcessDelay = { id: 'd', tenantId: 't1', siteId: 's1', nodeId: 'grd', code: 'No feed', start: L('2026-11-08 20:05'), end: null, setBy: 'u', enteredAt: W0 };
    expect(detectStops(input({ signals: sig, delays: [d] }), DEFAULT_PLANT_SETTINGS).map((x) => x.start)).toEqual([L('2026-11-03 07:00'), L('2026-11-04 10:42')]);
    // A flag that starts long after the stop does not account for it.
    const late = flag('f3', 'cv01', L('2026-11-04 11:00'), L('2026-11-04 11:20'));
    expect(detectStops(input({ signals: sig, flags: [late] }), DEFAULT_PLANT_SETTINGS)).toHaveLength(3);
  });

  it('skips knock-on stops of a circuit mate that was flagged down at that moment', () => {
    const trip = flag('t1', 'pp01', L('2026-11-04 10:41'), L('2026-11-04 11:00'));
    expect(detectStops(input({ signals: sig, flags: [trip] }), DEFAULT_PLANT_SETTINGS).map((x) => x.start)).toEqual([L('2026-11-03 07:00'), L('2026-11-08 20:00')]);
    const longAgo = flag('t2', 'pp01', L('2026-11-04 09:00'), L('2026-11-04 12:00'));
    expect(detectStops(input({ signals: sig, flags: [longAgo] }), DEFAULT_PLANT_SETTINGS)).toHaveLength(3);
  });

  it('proposes a flag from the historian, then classifies it', () => {
    const stop = detectStops(input({ signals: sig }), DEFAULT_PLANT_SETTINGS)[1]!;
    const pr = proposeStop(ctxFor(sup, [])('cv01'), stop);
    expect(pr.ok).toBe(true);
    if (!pr.ok) return;
    const p = pr.flags[0]!;
    expect(p).toMatchObject({ state: 'proposed', source: 'historian', reasonCode: 'Historian stop', start: L('2026-11-04 10:42') });
    expect(p.locations[0]).toMatchObject({ kind: 'in_place', functionalLocation: 'CON-GRD-CV01' });
    expect(p.notes).toBe('Historian: stopped at 10:42, running again at 11:30.');
    expect(resumeAfter(sig, 'cv01', p.start)).toBe(L('2026-11-04 11:30'));

    // Maintenance: open, unscheduled, In place.
    const m = classifyAsMaintenance(ctxFor(sup, [p])('cv01'), p, 'Electrical');
    expect(m.ok && m.flags[0]).toMatchObject({ state: 'open', type: 'unscheduled', reasonCode: 'Electrical', stages: [{ stage: 'waiting_crew' }] });

    // Process delay: one delay record, the proposal rejected into the C2 state.
    const t = plantTree(nodes, equipment);
    const [g] = groupStops([p], t, sig);
    expect(g).toMatchObject({ nodeId: 'grd', end: L('2026-11-04 11:30') });
    const c = classifyAsDelay(ctxFor(sup, [p]), dctx(sup), { flags: g!.flags, nodeId: g!.nodeId! }, [], DEFAULT_PLANT_SETTINGS.delayCodes, { code: 'Bins or stockpile full', end: g!.end });
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.flags[0]!.state).toBe('voided');
    expect(c.delays[0]).toMatchObject({ nodeId: 'grd', assetId: 'cv01', start: L('2026-11-04 10:42'), end: L('2026-11-04 11:30'), fromFlagIds: [p.id] });
    expect(c.audit.map((a) => a.action)).toEqual(['record_delay', 'reject']);
    const c2 = classifyAsDelay(ctxFor(sup, [p], { ...DEFAULT_FLAG_RULES, rejectedFixedPlantProposal: 'process_delay' }), dctx(sup), { flags: [p], nodeId: 'grd' }, [], DEFAULT_PLANT_SETTINGS.delayCodes, { code: 'No feed', end: null });
    expect(c2.ok && c2.flags[0]!.state).toBe('process_delay');

    // Not a stop is always voided, whatever C2 says.
    const n = classifyNotAStop(ctxFor(sup, [p], { ...DEFAULT_FLAG_RULES, rejectedFixedPlantProposal: 'process_delay' })('cv01'), p, 'Duty changeover');
    expect(n.ok && n.flags[0]).toMatchObject({ state: 'voided', voidReason: 'Duty changeover' });
  });

  it('groups stops in one circuit that start together', () => {
    const t = plantTree(nodes, equipment);
    const a = { ...flag('a', 'pp01', L('2026-11-04 10:42'), null), state: 'proposed' as const };
    const b = { ...flag('b', 'cv01', L('2026-11-04 10:43'), null), state: 'proposed' as const };
    const c = { ...flag('c', 'cv01', L('2026-11-04 12:00'), null), state: 'proposed' as const };
    expect(groupStops([a, b, c], t, []).map((g) => g.flags.map((f) => f.id))).toEqual([['a', 'b'], ['c']]);
  });

  it('only flag roles in scope can classify or record delays', () => {
    const truckSup = actor('supervisor', ['Haul trucks']);
    const d = recordDelay(dctx(truckSup), [], DEFAULT_PLANT_SETTINGS.delayCodes, { tenantId: 't1', siteId: 's1', nodeId: 'grd', code: 'No feed', start: W0 });
    expect(d.ok).toBe(false);
    for (const role of ['viewer', 'technician', 'admin'] as Role[]) expect(recordDelay(dctx(actor(role)), [], DEFAULT_PLANT_SETTINGS.delayCodes, { tenantId: 't1', siteId: 's1', nodeId: 'grd', code: 'No feed', start: W0 }).ok).toBe(false);
    for (const role of ['reliability_engineer', 'superintendent'] as Role[]) expect(recordDelay(dctx(actor(role)), [], DEFAULT_PLANT_SETTINGS.delayCodes, { tenantId: 't1', siteId: 's1', nodeId: 'grd', code: 'No feed', start: W0 }).ok).toBe(true);
  });
});

describe('process delay records', () => {
  const ctx: DelayContext = { actor: actor('supervisor', ['Concentrator']), now: W1, newId: () => 'd2', timeZone: TZ, calendar: cal, area: 'Concentrator' };
  const codes = DEFAULT_PLANT_SETTINGS.delayCodes;
  const base = { tenantId: 't1', siteId: 's1', nodeId: 'grd', code: 'No feed', start: L('2026-11-04 08:00') };

  it('checks codes, times and overlaps', () => {
    expect(recordDelay(ctx, [], codes, { ...base, code: 'Nope' })).toMatchObject({ ok: false, errors: ['Choose a delay code.'] });
    expect(recordDelay(ctx, [], [{ code: 'No feed', category: 'process', retired: true }], base)).toMatchObject({ ok: false });
    expect(recordDelay(ctx, [], codes, { ...base, start: '2027-01-01T00:00:00Z' }).ok).toBe(false);
    expect(recordDelay(ctx, [], codes, { ...base, end: L('2026-11-04 07:00') }).ok).toBe(false);
    const r = recordDelay(ctx, [], codes, { ...base, notes: '  ' });
    expect(r.ok && r.records[0]).toMatchObject({ end: null, notes: undefined, setBy: 'supervisor-1' });
    if (!r.ok) return;
    expect(r.audit[0]).toMatchObject({ entity: 'process_delay', action: 'record_delay', effectiveAt: base.start });
    expect(recordDelay(ctx, r.records, codes, { ...base, start: L('2026-11-05 08:00') }).ok).toBe(false); // the first is still open
    expect(recordDelay(ctx, r.records, codes, { ...base, assetId: 'cv01', start: L('2026-11-05 08:00') }).ok).toBe(true); // different equipment
  });

  it('ends once and voids with a reason; never deletes', () => {
    const r = recordDelay(ctx, [], codes, base);
    if (!r.ok) throw new Error();
    const d = r.records[0]!;
    expect(endDelay(ctx, d, L('2026-11-04 07:00')).ok).toBe(false);
    const e = endDelay(ctx, d, L('2026-11-04 09:30'));
    expect(e.ok && e.records[0]!.end).toBe(L('2026-11-04 09:30'));
    if (!e.ok) return;
    expect(endDelay(ctx, e.records[0]!, L('2026-11-04 10:00')).ok).toBe(false);
    expect(voidDelay(ctx, d, ' ').ok).toBe(false);
    const v = voidDelay(ctx, d, 'Wrong circuit');
    expect(v.ok && v.records[0]).toMatchObject({ voidedBy: 'supervisor-1', voidReason: 'Wrong circuit' });
    if (!v.ok) return;
    expect(plantReport(input({ delays: v.records }), week).summary.get('grd')!.delayHours).toBe(0);
  });
});

describe('plant settings', () => {
  const ctx = (role: Role) => ({ actor: actor(role), now: W1, newId: () => 'x', timeZone: TZ, calendar: cal });
  it('fills defaults and checks changes', () => {
    expect(withPlantDefaults({ minStopMinutes: 3, coveredStops: 'bad' as never, delayCodes: [] })).toMatchObject({ minStopMinutes: 3, coveredStops: 'propose', delayCodes: DEFAULT_PLANT_SETTINGS.delayCodes });
    const d = DEFAULT_PLANT_SETTINGS;
    expect(setPlantSettings(ctx('supervisor'), d, d, 'x').ok).toBe(false);
    expect(setPlantSettings(ctx('reliability_engineer'), d, { ...d, delayCodes: d.delayCodes.slice(1) }, 'x')).toMatchObject({ ok: false, errors: ['No feed cannot be removed. Retire it instead.'] });
    const r = setPlantSettings(ctx('admin'), d, { ...d, coveredStops: 'skip', delayCodes: [...d.delayCodes.map((c, i) => (i === 0 ? { ...c, retired: true } : c)), { code: ' Crusher choke ', category: 'process' }] }, 'Site review');
    expect(r.ok && r.records[0]!.delayCodes.at(-1)).toEqual({ code: 'Crusher choke', category: 'process' });
    expect(r.ok && r.records[0]!.delayCodes[0]!.retired).toBe(true);
    expect(r.ok && r.audit[0]).toMatchObject({ entity: 'settings', entityId: 'plant', action: 'set_plant_settings' });
  });
});

describe('synthetic concentrator', () => {
  const end = Date.parse('2026-10-29T16:00:00.000Z');
  const d = generatePlant({ end, days: 60 });
  const now = new Date(end).toISOString();

  it('is deterministic and places every equipment', () => {
    expect(generatePlant({ end, days: 60 }).flags).toEqual(d.flags);
    const t = plantTree(d.nodes, d.equipment);
    expect(t.unplaced).toEqual([]);
    expect(t.roots.map((r) => r.node.name)).toEqual(['Crushing plant', 'Concentrator']);
    expect(d.equipment.every((a) => a.assetClass === 'fixed_plant' && a.fleet === 'Concentrator')).toBe(true);
  });

  it('obeys the flag rules: no overlaps, one open flag, complete releases, In place', () => {
    for (const a of d.equipment) {
      const fs = countingFlagsOf(d.flags, a.id);
      expect(fs.filter((f) => f.state === 'open').length).toBeLessThanOrEqual(1);
      for (let i = 1; i < fs.length; i++) expect(Date.parse(fs[i]!.start)).toBeGreaterThanOrEqual(Date.parse(fs[i - 1]!.end!));
    }
    for (const f of d.flags.filter((x) => x.state === 'released')) {
      expect(releaseChecklist(f, f.release!)).toEqual([]);
      expect(f.stages[0]!.start).toBe(f.start);
      expect(f.stages.at(-1)!.end).toBe(f.end);
      for (let i = 1; i < f.stages.length; i++) expect(f.stages[i]!.start).toBe(f.stages[i - 1]!.end);
      expect(f.locations.every((l) => l.kind === 'in_place' && l.functionalLocation)).toBe(true);
    }
  });

  it('never runs equipment while it is flagged down, and every stop is accounted for or proposed', () => {
    expect(runningWhileDown({ ...d, now }, 0)).toEqual([]);
    expect(detectStops({ ...d, now }, DEFAULT_PLANT_SETTINGS)).toEqual([]);
    const proposed = d.flags.filter((f) => f.state === 'proposed');
    expect(proposed.length).toBeGreaterThan(0);
    expect(proposed.every((f) => f.source === 'historian' && Date.parse(f.start) > end - 8 * 3_600_000)).toBe(true);
    expect(d.flags.filter((f) => f.state === 'open').length).toBeGreaterThanOrEqual(2);
  });

  it('a standby is running in place of an equipment that is down now', () => {
    const st = plantNow({ ...d, now });
    expect(st.get('pn-tp')!.state).toBe('run');
    expect(st.get('pn-rc')!.state).toBe('run');
    const down = d.flags.filter((f) => f.state === 'open').map((f) => f.unitId);
    for (const id of down) expect(st.get(id)!.state).toBe('down');
  });
});
