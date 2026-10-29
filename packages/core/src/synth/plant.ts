// Synthetic concentrator (phase 3b, docs/fixed-plant.md). Develop and demo on
// this, never on site data. Deterministic for a seed.
//
// A 5-minute step simulation. Crushing feeds a stockpile; the wet plant
// (reclaim, grinding, flotation, concentrate, tailings) runs as one chain off
// the pile. Equipment fails only while it runs. Redundancy groups keep their
// runners until one fails or the weekly duty change. Circuits that stop
// because another circuit stopped get "Upstream stop" or "Downstream stop"
// delays; a full or empty pile, haulage gaps, reagent shortages and power dips
// are process delays. Planned work: crusher PM every 14 days, a wet plant
// shutdown every 28 days, and standby pump PMs. Stops in the last 8 hours are
// left for a person to classify; older duty changes were classified "Not a stop".

import { DateTime } from 'luxon';
import { DEFAULT_FLAG_RULES } from '../config.js';
import { normaliseWoNumber } from '../imports.js';
import { scoreInspection, type Answer, type FormItem, type Inspection, type InspectionForm } from '../inspections.js';
import { proposeStop, detectStops, DEFAULT_PLANT_SETTINGS, PLANT_SYSTEMS, equipmentUnder, plantTree, type PlantNode, type ProcessDelay, type RunSignal, type TreeNode } from '../plant.js';
import { stopForm, type Round } from '../rounds.js';
import type { Shutdown, ScopeItem } from '../shutdowns.js';
import { HOUR_MS, shiftsBetween, toIso, twelveHourCalendar, type ShiftCalendar } from '../time.js';
import type { Asset, DownFlag, LocationInterval, Stage, StageInterval, WorkOrder } from '../types.js';

export interface PlantDataset {
  nodes: PlantNode[];
  equipment: Asset[];
  flags: DownFlag[];
  delays: ProcessDelay[];
  signals: RunSignal[];
  /** Part 2: shutdowns with their scope, the work orders they name, and operator rounds and lube routes. */
  shutdowns: Shutdown[];
  workOrders: WorkOrder[];
  forms: InspectionForm[];
  rounds: Round[];
  inspections: Inspection[];
}

export interface PlantSynthOptions {
  seed?: number;
  days?: number;
  /** End of the history (ms). */
  end: number;
  timeZone?: string;
  tenantId?: string;
  siteId?: string;
  /** User ids for rounds and shutdowns. */
  people?: { technician: string; supervisor: string };
}

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Model { mtbfH: number; repairH: number; systems: string[]; parts?: Partial<Record<string, string[]>> }

const MODELS: Record<string, Model> = {
  'Gyratory crusher': { mtbfH: 400, repairH: 4, systems: ['Mechanical', 'Wear parts', 'Hydraulics', 'Lubrication', 'Electrical'], parts: { 'Wear parts': ['Liner'] } },
  Conveyor: { mtbfH: 350, repairH: 2, systems: ['Wear parts', 'Mechanical', 'Electrical', 'Instrumentation'], parts: { 'Wear parts': ['Belt', 'Chute liner'] } },
  'Apron feeder': { mtbfH: 600, repairH: 3, systems: ['Mechanical', 'Wear parts', 'Hydraulics', 'Electrical'], parts: { 'Wear parts': ['Chute liner'] } },
  'SAG mill': { mtbfH: 500, repairH: 6, systems: ['Mechanical', 'Lubrication', 'Electrical', 'Wear parts', 'Instrumentation'], parts: { 'Wear parts': ['Liner'] } },
  'Ball mill': { mtbfH: 700, repairH: 5, systems: ['Mechanical', 'Lubrication', 'Electrical', 'Wear parts'], parts: { 'Wear parts': ['Liner'] } },
  'Slurry pump': { mtbfH: 300, repairH: 3, systems: ['Sealing', 'Wear parts', 'Mechanical', 'Electrical'], parts: { 'Wear parts': ['Impeller', 'Liner'] } },
  'Flotation cell': { mtbfH: 900, repairH: 3, systems: ['Mechanical', 'Electrical', 'Instrumentation'] },
  'Regrind mill': { mtbfH: 600, repairH: 4, systems: ['Mechanical', 'Lubrication', 'Electrical', 'Wear parts'], parts: { 'Wear parts': ['Liner'] } },
  Thickener: { mtbfH: 1500, repairH: 6, systems: ['Mechanical', 'Hydraulics', 'Instrumentation'] },
  'Filter press': { mtbfH: 250, repairH: 3, systems: ['Hydraulics', 'Wear parts', 'Mechanical'], parts: { 'Wear parts': ['Screen panel'] } },
};

const SUMMARY: Record<string, string> = {
  Worn: 'Replaced worn part', Overheat: 'Found cause of heat, repaired and tested', Vibration: 'Realigned and replaced bearing', Seized: 'Replaced seized part',
  Torn: 'Repaired tear', Blocked: 'Cleared blockage', Leak: 'Replaced seal and tested', Trip: 'Reset and tested', Short: 'Repaired wiring', 'Open circuit': 'Repaired wiring',
  Failed: 'Replaced instrument', Drift: 'Recalibrated', Intermittent: 'Secured connection', 'Low pressure': 'Restored pressure', Contamination: 'Changed oil and filters', Crack: 'Welded repair', Wear: 'Replaced worn part',
};

export function generatePlant(opts: PlantSynthOptions): PlantDataset {
  const r = rng((opts.seed ?? 42) + 7_919);
  const tz = opts.timeZone ?? 'America/Vancouver';
  const tenantId = opts.tenantId ?? 'tenant-demo';
  const siteId = opts.siteId ?? 'site-demo';
  const end = opts.end;
  const days = opts.days ?? 120;
  const STEP = 5 * 60_000;
  const start = Math.floor((end - days * 24 * HOUR_MS) / STEP) * STEP;
  const cutoff = end - 8 * HOUR_MS;
  const sup = 'user-supervisor';
  const pick = <T,>(xs: T[]): T => xs[Math.floor(r() * xs.length)]!;
  const exp = (mean: number) => -Math.log(1 - r()) * mean;
  const logn = (median: number, sigma = 0.6) => {
    const u = 1 - r();
    const v = r();
    return median * Math.exp(sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v));
  };
  const snap = (t: number) => Math.round(t / STEP) * STEP;

  // ---- structure ----
  const node = (id: string, kind: PlantNode['kind'], name: string, fl: string, order: number, extra: Partial<PlantNode> = {}): PlantNode =>
    ({ id, tenantId, siteId, kind, name, functionalLocation: fl, order, ...extra });
  // Two plants: the stockpile between crushing and the concentrator is a buffer, so a crusher stop
  // does not stop the mill and the two are rolled up separately (docs/fixed-plant.md).
  const nodes: PlantNode[] = [
    node('pn-crp', 'plant', 'Crushing plant', 'CRP', 1, { plannedRateTph: 1300 }),
    node('pn-cru', 'circuit', 'Primary crushing', 'CRP-CRU', 1, { parentId: 'pn-crp', plannedRateTph: 1300 }),
    node('pn-con', 'plant', 'Concentrator', 'CON', 2, { plannedRateTph: 1200 }),
    node('pn-mil', 'area', 'Milling', 'CON-MIL', 1, { parentId: 'pn-con' }),
    node('pn-fld', 'area', 'Flotation and dewatering', 'CON-FLD', 2, { parentId: 'pn-con' }),
    node('pn-rcl', 'circuit', 'Stockpile reclaim', 'CON-MIL-RCL', 1, { parentId: 'pn-mil', plannedRateTph: 1200 }),
    node('pn-rf', 'group', 'Reclaim feeders', 'CON-MIL-RCL-RF', 1, { parentId: 'pn-rcl', needed: 2 }),
    node('pn-grd', 'circuit', 'Grinding', 'CON-MIL-GRD', 2, { parentId: 'pn-mil', plannedRateTph: 1200 }),
    node('pn-cfp', 'group', 'Cyclone feed pumps', 'CON-MIL-GRD-CFP', 1, { parentId: 'pn-grd', needed: 1 }),
    node('pn-flt', 'circuit', 'Flotation', 'CON-FLD-FLT', 1, { parentId: 'pn-fld', plannedRateTph: 1200 }),
    node('pn-rc', 'group', 'Rougher cells', 'CON-FLD-FLT-RC', 1, { parentId: 'pn-flt', needed: 3 }),
    node('pn-cp', 'group', 'Concentrate pumps', 'CON-FLD-FLT-CP', 2, { parentId: 'pn-flt', needed: 1 }),
    node('pn-ctf', 'circuit', 'Concentrate thickening and filtration', 'CON-FLD-CTF', 2, { parentId: 'pn-fld', plannedRateTph: 60 }),
    node('pn-fp', 'group', 'Concentrate filters', 'CON-FLD-CTF-FP', 1, { parentId: 'pn-ctf', needed: 1 }),
    node('pn-tls', 'circuit', 'Tailings', 'CON-FLD-TLS', 3, { parentId: 'pn-fld', plannedRateTph: 1140 }),
    node('pn-tp', 'group', 'Tailings pumps', 'CON-FLD-TLS-TP', 1, { parentId: 'pn-tls', needed: 1 }),
  ];
  const eq = (num: string, model: string, fl: string): Asset => ({
    id: `eq-${num.toLowerCase()}`, tenantId, siteId, unitNumber: num, fleet: 'Concentrator', model, assetClass: 'fixed_plant', functionalLocation: fl, externalAssetId: fl,
    serial: `PL${String(Math.abs(hash(num)) % 100000).padStart(5, '0')}`,
  });
  const equipment: Asset[] = [
    eq('CR01', 'Gyratory crusher', 'CRP-CRU-CR01'), eq('CV01', 'Conveyor', 'CRP-CRU-CV01'),
    eq('RF01', 'Apron feeder', 'CON-MIL-RCL-RF-RF01'), eq('RF02', 'Apron feeder', 'CON-MIL-RCL-RF-RF02'), eq('RF03', 'Apron feeder', 'CON-MIL-RCL-RF-RF03'),
    eq('CV02', 'Conveyor', 'CON-MIL-RCL-CV02'),
    eq('SAG01', 'SAG mill', 'CON-MIL-GRD-SAG01'), eq('BM01', 'Ball mill', 'CON-MIL-GRD-BM01'),
    eq('PP01', 'Slurry pump', 'CON-MIL-GRD-CFP-PP01'), eq('PP02', 'Slurry pump', 'CON-MIL-GRD-CFP-PP02'),
    eq('FC01', 'Flotation cell', 'CON-FLD-FLT-RC-FC01'), eq('FC02', 'Flotation cell', 'CON-FLD-FLT-RC-FC02'),
    eq('FC03', 'Flotation cell', 'CON-FLD-FLT-RC-FC03'), eq('FC04', 'Flotation cell', 'CON-FLD-FLT-RC-FC04'),
    eq('RG01', 'Regrind mill', 'CON-FLD-FLT-RG01'),
    eq('PP03', 'Slurry pump', 'CON-FLD-FLT-CP-PP03'), eq('PP04', 'Slurry pump', 'CON-FLD-FLT-CP-PP04'),
    eq('TH01', 'Thickener', 'CON-FLD-CTF-TH01'), eq('FP01', 'Filter press', 'CON-FLD-CTF-FP-FP01'), eq('FP02', 'Filter press', 'CON-FLD-CTF-FP-FP02'),
    eq('TH02', 'Thickener', 'CON-FLD-TLS-TH02'), eq('PP05', 'Slurry pump', 'CON-FLD-TLS-TP-PP05'), eq('PP06', 'Slurry pump', 'CON-FLD-TLS-TP-PP06'),
  ];
  const tree = plantTree(nodes, equipment);
  const circuits = ['pn-cru', 'pn-rcl', 'pn-grd', 'pn-flt', 'pn-ctf', 'pn-tls'];
  const chain = circuits.slice(1);
  const byNum = new Map(equipment.map((a) => [a.unitNumber, a]));

  // ---- flags ----
  let seq = 0;
  let woSeq = 300000;
  const flags: DownFlag[] = [];
  const downUntil = new Map<string, number>();
  const stage = (s: Stage, a: number, b: number | null): StageInterval => ({ stage: s, start: toIso(a), end: b === null ? null : toIso(b), setBy: sup, enteredAt: toIso(a) });
  const loc = (a: Asset, s: number, e: number | null): LocationInterval => ({ kind: 'in_place', start: toIso(s), end: e === null ? null : toIso(e), functionalLocation: a.functionalLocation, setBy: sup, enteredAt: toIso(s) });

  function addFlag(a: Asset, type: DownFlag['type'], s: number, hours: number, detail?: { system: string; component: string; mode: string }) {
    const e = snap(s + Math.max(STEP, hours * HOUR_MS));
    const wo = `WO-${++woSeq}`;
    const st: StageInterval[] = [];
    if (type === 'unscheduled' && detail?.mode === 'Trip') st.push(stage('in_repair', s, e));
    else {
      const wait = snap(s + Math.min((e - s) * 0.2, (type === 'scheduled' ? 0.25 : 0.25 + r() * 0.5) * HOUR_MS));
      const rfr = Math.max(wait, e - STEP);
      st.push(stage('waiting_crew', s, wait));
      if (type === 'unscheduled' && r() < 0.15 && rfr - wait > 4 * STEP) {
        const wp = snap(wait + (rfr - wait) * 0.3);
        const wpe = snap(wp + (rfr - wait) * 0.4);
        st.push(stage('in_repair', wait, wp), stage('waiting_parts', wp, wpe), stage('in_repair', wpe, rfr));
      } else st.push(stage('in_repair', wait, rfr));
      st.push(stage('ready_for_release', rfr, e));
    }
    const open = e > end;
    const stages = open ? st.filter((x) => Date.parse(x.start) <= end).map((x, i, arr) => (i === arr.length - 1 ? { ...x, end: null } : x)) : st;
    const f: DownFlag = {
      id: `pf-${++seq}`, tenantId, siteId, unitId: a.id, type, state: open ? 'open' : 'released',
      reasonCode: type === 'scheduled' ? 'PM' : detail!.system, system: type === 'unscheduled' ? detail!.system : undefined,
      start: toIso(s), end: open ? null : toIso(e), stages, locations: [loc(a, s, open ? null : e)], etas: [{ eta: toIso(e), setAt: toIso(s), setBy: sup }],
      workOrders: [wo], source: type === 'unscheduled' ? 'historian' : 'app', setBy: sup, enteredAt: toIso(s),
      plannedDurationHours: type === 'scheduled' ? Math.round(hours) : undefined,
      release: open ? undefined : type === 'unscheduled'
        ? { system: detail!.system, component: detail!.component, failureModes: [detail!.mode], repairSummary: SUMMARY[detail!.mode] ?? 'Repaired', workOrder: wo, findings: `${detail!.component} ${detail!.mode.toLowerCase()}` }
        : { pmOrWorkOrder: wo, repairSummary: 'PM completed', findings: '' },
      releasedBy: open ? undefined : sup,
    };
    flags.push(f);
    downUntil.set(a.id, e);
  }

  // Planned work, as start times per equipment.
  const planned: Array<{ a: Asset; s: number; h: number }> = [];
  const localAt = (t: number, hour: number) => DateTime.fromMillis(t, { zone: tz }).startOf('day').set({ hour }).toMillis();
  for (let d = 3; d < days; d += 14) planned.push({ a: byNum.get('CR01')!, s: localAt(start + d * 24 * HOUR_MS, 7), h: 8 });
  for (let d = 10; d < days; d += 28) {
    const s = localAt(start + d * 24 * HOUR_MS, 6);
    for (const n of ['CV02', 'SAG01', 'BM01', 'RG01', 'TH01', 'TH02']) planned.push({ a: byNum.get(n)!, s, h: n === 'SAG01' ? 14 : 12 });
  }

  // ---- delays and signals ----
  const delays: ProcessDelay[] = [];
  const signals: RunSignal[] = [];
  const running = new Map<string, boolean>();
  const curDelay = new Map<string, { code: string; s: number }>();
  function setDelay(nodeId: string, code: string | null, t: number) {
    const cur = curDelay.get(nodeId);
    if (cur && cur.code === code) return;
    if (cur) {
      if (t > cur.s) delays.push({ id: `pd-${++seq}`, tenantId, siteId, nodeId, code: cur.code, start: toIso(cur.s), end: toIso(t), setBy: sup, enteredAt: toIso(t) });
      curDelay.delete(nodeId);
    }
    if (code) curDelay.set(nodeId, { code, s: t });
  }
  function setRun(a: Asset, on: boolean, t: number) {
    if (running.get(a.id) === on) return;
    running.set(a.id, on);
    signals.push({ assetId: a.id, at: toIso(t), running: on });
  }

  // Exogenous events, as [start, end] windows.
  const windows = (meanGapH: number, medianH: number) => {
    const out: Array<[number, number]> = [];
    let t = start + exp(meanGapH) * HOUR_MS;
    while (t < end) {
      const s = snap(t);
      const e = snap(s + Math.max(STEP, logn(medianH, 0.5) * HOUR_MS));
      out.push([s, e]);
      t = e + exp(meanGapH) * HOUR_MS;
    }
    return out;
  };
  const noFeed = windows(18, 1);
  // A haulage gap near the end, left for a person to classify.
  noFeed.push([snap(end - 2 * HOUR_MS), snap(end - 75 * 60_000)]);
  const reagent = windows(240, 2);
  const power = windows(480, 1.5);
  const inWin = (w: Array<[number, number]>, t: number) => w.some(([s, e]) => t >= s && t < e);

  const groupOf = new Map<string, string>();
  for (const t of tree.byId.values()) if (t.node.kind === 'group') for (const a of t.equipment) groupOf.set(a.id, t.node.id);
  const under = new Map(circuits.map((c) => [c, equipmentUnder(tree, c)]));
  const circuitOfEq = new Map<string, string>();
  for (const [c, ids] of under) for (const id of ids) circuitOfEq.set(id, c);
  const runners = new Map<string, string[]>();
  for (const t of tree.byId.values()) if (t.node.kind === 'group') runners.set(t.node.id, t.equipment.slice(0, t.needed).map((a) => a.id));
  const standbyPm = new Map<string, number>([...runners.keys()].map((g, i) => [g, start + (5 + i * 3) * 24 * HOUR_MS]));

  const forced: Array<{ at: number; group: string; unit?: string; hours: number; detail: { system: string; component: string; mode: string } }> = [
    { at: snap(end - 30 * HOUR_MS), group: 'pn-rc', hours: 40, detail: { system: 'Mechanical', component: 'Bearing', mode: 'Vibration' } },
    { at: snap(end - 5 * HOUR_MS), group: 'pn-tp', hours: 9, detail: { system: 'Sealing', component: 'Mechanical seal', mode: 'Leak' } },
    { at: snap(end - 3 * HOUR_MS), group: '', unit: 'SAG01', hours: 0.33, detail: { system: 'Electrical', component: 'Motor', mode: 'Trip' } },
  ];
  let pile = 15000;
  const PILE_MAX = 30000;
  let lastWeek = -1;
  let pileFull = false;
  let pileEmpty = false;
  const isDown = (id: string, t: number) => (downUntil.get(id) ?? 0) > t;

  for (let t = start; t < end; t += STEP) {
    // Planned work starts.
    for (const p of planned) if (p.s === t && !isDown(p.a.id, t)) addFlag(p.a, 'scheduled', t, p.h);
    // Set events near the end, so the demo always shows a standby taking over, a group with one
    // member down, and a recent trip waiting to be classified.
    for (const fx of forced) {
      if (fx.at !== t) continue;
      const g = tree.byId.get(fx.group);
      const id = g ? runners.get(fx.group)!.find((m) => running.get(m)) : `eq-${fx.unit!.toLowerCase()}`;
      const a = equipment.find((x) => x.id === id);
      if (!a || isDown(a.id, t)) continue;
      addFlag(a, 'unscheduled', t, fx.hours, fx.detail);
      setRun(a, false, t);
      if (g) runners.set(fx.group, runners.get(fx.group)!.filter((x) => x !== a.id));
    }
    // Failures while running (running as of the last step), so the rest of the circuit stops in the same step.
    for (const a of equipment) {
      if (!running.get(a.id)) continue;
      const m = MODELS[a.model]!;
      if (r() >= (STEP / HOUR_MS) / m.mtbfH) continue;
      const trip = r() < 0.3;
      const system = trip ? pick(['Electrical', 'Instrumentation']) : pick(m.systems);
      const comps = m.parts?.[system] ?? PLANT_SYSTEMS[system]!.components;
      const mode = trip ? (system === 'Electrical' ? 'Trip' : 'Intermittent') : pick(PLANT_SYSTEMS[system]!.modes.filter((x) => x !== 'Trip'));
      addFlag(a, 'unscheduled', t, trip ? (5 + r() * 15) / 60 : logn(m.repairH), { system, component: pick(comps), mode });
      setRun(a, false, t);
      const g = groupOf.get(a.id);
      if (g) runners.set(g, runners.get(g)!.filter((x) => x !== a.id));
    }
    // Weekly duty change, Monday 07:00 site time.
    const lt = DateTime.fromMillis(t, { zone: tz });
    const wk = lt.weekNumber;
    const dutyChange = lt.weekday === 1 && lt.hour === 7 && lt.minute === 0 && wk !== lastWeek;
    if (dutyChange) lastWeek = wk;
    for (const [g, list] of runners) {
      const t0 = tree.byId.get(g)!;
      const members = t0.equipment.map((a) => a.id);
      // Standby PM every 21 days on a member that is not running.
      if (t >= standbyPm.get(g)!) {
        const idle = members.find((m) => !list.includes(m) && !isDown(m, t));
        if (idle) addFlag(equipment.find((a) => a.id === idle)!, 'scheduled', t, 4);
        standbyPm.set(g, t + 21 * 24 * HOUR_MS);
      }
      let keep = list.filter((m) => !isDown(m, t));
      if (dutyChange && keep.length) {
        const out = keep[0]!;
        const spare = members.find((m) => !keep.includes(m) && !isDown(m, t));
        if (spare) keep = [...keep.slice(1), spare].filter((m) => m !== out);
      }
      for (const m of members) if (keep.length < t0.needed && !keep.includes(m) && !isDown(m, t)) keep.push(m);
      runners.set(g, keep);
    }
    // Circuit availability (maintenance only).
    const up = (x: TreeNode): boolean => [...x.nodes.map(up), ...x.equipment.map((a) => !isDown(a.id, t))].filter(Boolean).length >= x.needed;
    const avail = (cid: string) => up(tree.byId.get(cid)!);
    const scheduledOnly = (cid: string) => {
      const ids = new Set(under.get(cid)!);
      return flags.filter((f) => ids.has(f.unitId) && Date.parse(f.start) <= t && (f.end === null || Date.parse(f.end) > t)).every((f) => f.type === 'scheduled');
    };
    const pw = inWin(power, t);
    setDelay('pn-con', pw ? 'Power supply' : null, t);
    setDelay('pn-crp', pw ? 'Power supply' : null, t);
    // Crushing.
    const cruAvail = avail('pn-cru');
    let cruCode: string | null = null;
    if (!pw && cruAvail) {
      if (pile >= PILE_MAX) pileFull = true;
      if (pile <= PILE_MAX - 3000) pileFull = false;
      if (pileFull) cruCode = 'Bins or stockpile full';
      else if (inWin(noFeed, t)) cruCode = 'No feed';
    }
    const cruRun = !pw && cruAvail && !cruCode;
    setDelay('pn-cru', cruCode, t);
    // Wet chain. After the pile runs empty, reclaim waits for 2,000 t.
    if (pile <= 0) pileEmpty = true;
    if (pile >= 2000) pileEmpty = false;
    let cause = -1;
    let causeCode: string | null = null;
    let planned_ = false;
    chain.forEach((c, i) => {
      if (cause >= 0) return;
      if (!avail(c)) {
        cause = i;
        planned_ = scheduledOnly(c);
      } else if (c === 'pn-rcl' && pileEmpty) {
        cause = i;
        causeCode = 'No feed';
      } else if (c === 'pn-flt' && inWin(reagent, t)) {
        cause = i;
        causeCode = 'Water or reagent shortage';
      }
    });
    const wetRun = !pw && cause < 0;
    chain.forEach((c, i) => {
      let code: string | null = null;
      if (!pw && cause >= 0) {
        if (i === cause) code = causeCode;
        else if (!planned_) code = i < cause ? 'Downstream stop' : 'Upstream stop';
      }
      setDelay(c, code, t);
    });
    pile = Math.min(PILE_MAX, Math.max(0, pile + (cruRun ? 1300 : 0) * (STEP / HOUR_MS) - (wetRun ? 1200 : 0) * (STEP / HOUR_MS)));
    // Who runs.
    for (const a of equipment) {
      const c = circuitOfEq.get(a.id)!;
      const circuitRuns = c === 'pn-cru' ? cruRun : wetRun;
      const g = groupOf.get(a.id);
      const on = circuitRuns && !isDown(a.id, t) && (!g || runners.get(g)!.includes(a.id));
      setRun(a, on, t);
    }
  }
  for (const n of [...curDelay.keys()]) {
    const cur = curDelay.get(n)!;
    delays.push({ id: `pd-${++seq}`, tenantId, siteId, nodeId: n, code: cur.code, start: toIso(cur.s), end: null, setBy: sup, enteredAt: toIso(cur.s) });
  }

  // ---- what a person has classified by now ----
  // Recent trips that are over and recent delays were not classified yet: the historian proposes them below.
  const keptFlags = flags.filter((f) => !(f.type === 'unscheduled' && Date.parse(f.start) >= cutoff && f.end !== null));
  const keptDelays = delays.filter((d) => Date.parse(d.start) < cutoff || d.nodeId !== 'pn-cru');
  const nowIso = toIso(end);
  const stops = detectStops({ nodes, equipment, flags: keptFlags, delays: keptDelays, signals, now: nowIso }, DEFAULT_PLANT_SETTINGS, { tree });
  const calendar = twelveHourCalendar(tz);
  const all = [...keptFlags];
  for (const s of stops) {
    const a = equipment.find((x) => x.id === s.assetId)!;
    const ctx = { now: nowIso, actor: { userId: 'historian', role: 'supervisor' as const, scope: ['*'] }, rules: DEFAULT_FLAG_RULES, calendar, asset: a, unitFlags: all.filter((f) => f.unitId === a.id && Date.parse(f.start) <= Date.parse(s.start)), newId: () => `pf-${++seq}` };
    const p = proposeStop(ctx, s);
    if (!p.ok) continue;
    const f = p.flags[0]!;
    if (Date.parse(s.start) < cutoff) all.push({ ...f, state: 'voided', voidReason: s.covered ? 'Duty and standby changeover' : 'Not a stop', enteredAt: s.start });
    else all.push({ ...f, enteredAt: s.start });
  }
  const work = plantWork({ r, tz, tenantId, siteId, start, end, days, equipment, flags: all, calendar, people: opts.people ?? { technician: 'user-technician', supervisor: sup } });
  return { nodes, equipment, flags: all.sort((x, y) => Date.parse(x.start) - Date.parse(y.start)), delays: keptDelays, signals, ...work };
}

// ---------- part 2: shutdowns, work orders, rounds ----------

const SD_WORK: Record<string, string[]> = {
  CV02: ['Replace head pulley lagging', 'Change belt scraper blades', 'Inspect idlers and replace seized'],
  SAG01: ['Replace feed chute liners', 'Inspect shell liner bolts', 'Change lube oil filters', 'Inspect trunnion bearings'],
  BM01: ['Inspect girth gear and pinion', 'Change lube oil filters', 'Replace discharge trommel panels'],
  RG01: ['Replace mill liners', 'Inspect gearbox'],
  TH01: ['Inspect rake drive gearbox', 'Clear feedwell'],
  TH02: ['Inspect rake drive gearbox', 'Replace underflow valve'],
};

interface WorkIn {
  r: () => number; tz: string; tenantId: string; siteId: string; start: number; end: number; days: number;
  equipment: Asset[]; flags: DownFlag[]; calendar: ShiftCalendar; people: { technician: string; supervisor: string };
}

function plantWork(w: WorkIn): Pick<PlantDataset, 'shutdowns' | 'workOrders' | 'forms' | 'rounds' | 'inspections'> {
  const { r, tz, tenantId, siteId, start, end, equipment, flags, people } = w;
  const byNum = new Map(equipment.map((a) => [a.unitNumber, a]));
  const localAt = (t: number, hour: number) => DateTime.fromMillis(t, { zone: tz }).startOf('day').set({ hour }).toMillis();
  const workOrders: WorkOrder[] = [];
  const shutdowns: Shutdown[] = [];
  let woSeq = 410000;
  let n = 0;
  const wo = (a: Asset, text: string, open: boolean, target: number, done?: number): WorkOrder => {
    const number = `WO-${++woSeq}`;
    const x: WorkOrder = {
      id: `pwo-${woSeq}`, tenantId, siteId, assetId: a.id, sourceSystem: 'maximo', sourceId: String(woSeq), number, numberNormalised: normaliseWoNumber(number),
      externalAssetId: a.externalAssetId, woType: 'PM', workClass: 'pm', status: open ? 'WPCOND' : 'COMP', open, priority: '2', description: `${a.unitNumber} ${text.toLowerCase()}`,
      reportedAt: toIso(target - 20 * 24 * HOUR_MS), targetStart: toIso(target), estimatedHours: Math.round(2 + r() * 10),
      ...(done ? { completedAt: toIso(done), actualLabourHours: Math.round(2 + r() * 12) } : {}),
    };
    workOrders.push(x);
    return x;
  };
  const scope = (x: WorkOrder, at: number, late: boolean, reason?: string): ScopeItem =>
    ({ id: `sds-${++n}`, workOrder: x.numberNormalised, addedAt: toIso(at), addedBy: people.supervisor, late, ...(reason ? { reason } : {}) });
  const parts = ['CV02', 'SAG01', 'BM01', 'RG01', 'TH01', 'TH02'];
  const ids = parts.map((p) => byNum.get(p)!.id);
  // The wet plant shutdowns the simulation ran, every 28 days from day 10, and the next one, planned.
  for (let d = 10; ; d += 28) {
    const s = localAt(start + d * 24 * HOUR_MS, 6);
    const past = s < end;
    const plannedEnd = s + 12 * HOUR_MS;
    const freeze = s - 7 * 24 * HOUR_MS;
    const master = `WO-${++woSeq}`;
    const sdFlags = flags.filter((f) => ids.includes(f.unitId) && f.type === 'scheduled' && Date.parse(f.start) === s);
    const items: ScopeItem[] = [];
    for (const p of parts) {
      for (const text of SD_WORK[p]!) {
        if (r() < 0.25) continue;
        const done = past && r() < 0.9;
        const x = wo(byNum.get(p)!, text, !done, s, done ? s + 10 * HOUR_MS : undefined);
        items.push(scope(x, freeze - (2 + r() * 10) * 24 * HOUR_MS, false));
      }
    }
    // Work found late, and one job deferred.
    const lateN = Math.floor(r() * 3);
    for (let i = 0; i < lateN; i++) {
      const a = byNum.get(parts[Math.floor(r() * parts.length)]!)!;
      const done = past && r() < 0.7;
      const x = wo(a, pick(r, ['Replace leaking hydraulic hose', 'Repair worn chute', 'Change failed limit switch']), !done, s, done ? s + 11 * HOUR_MS : undefined);
      items.push(scope(x, Math.min(end - HOUR_MS, freeze + (1 + r() * 5) * 24 * HOUR_MS), true, 'Found on inspection after the freeze'));
    }
    if (items.length > 4 && r() < 0.6) {
      const k = items[Math.floor(r() * items.length)]!;
      Object.assign(k, { removedAt: toIso(Math.min(end - HOUR_MS, freeze + 24 * HOUR_MS)), removedBy: people.supervisor, removedReason: 'Parts not on site; moved to the next shutdown' });
    }
    const actualEnd = sdFlags.length ? (sdFlags.some((f) => !f.end) ? Infinity : Math.max(...sdFlags.map((f) => Date.parse(f.end!)))) : plannedEnd;
    const sd: Shutdown = {
      id: `sd-${d}`, tenantId, siteId, nodeId: 'pn-con', name: `Wet plant shutdown ${DateTime.fromMillis(s, { zone: tz }).toFormat('d LLL')}`,
      workOrder: master, plannedStart: toIso(s), plannedEnd: toIso(plannedEnd), freezeAt: toIso(freeze), equipmentIds: ids, scope: items,
      flagIds: past ? sdFlags.map((f) => f.id) : [], createdBy: people.supervisor, createdAt: toIso(freeze - 21 * 24 * HOUR_MS),
      ...(past ? { actualStart: toIso(s), ...(actualEnd && actualEnd <= end ? { actualEnd: toIso(actualEnd), findings: 'Liners at 40% remaining; next change in two shutdowns.' } : {}) } : {}),
    };
    // The flags the shutdown raised carry its master work order and reason code.
    for (const f of sdFlags) {
      f.reasonCode = 'SHUTDOWN';
      f.workOrders = [master];
      f.notes = `Shutdown: ${sd.name}`;
      if (f.release) f.release = { ...f.release, pmOrWorkOrder: master, repairSummary: `Shutdown ${sd.name} complete` };
    }
    shutdowns.push(sd);
    if (!past) break;
  }

  // ---- routes ----
  const it = (stop: string, id: string, text: string, kind: FormItem['kind'], over: Partial<FormItem> = {}): FormItem =>
    ({ id: `${stop.toLowerCase()}-${id}`, section: stop, text, kind, critical: false, weight: 1, photoOnFail: false, stopId: byNum.get(stop)!.id, ...over });
  const pump = (p: string) => [
    it(p, 'seal', 'Gland or seal not leaking', 'pass_fail', { photoOnFail: true }),
    it(p, 'brg', 'Bearing temperature', 'reading', { max: 80, unit: '°C' }),
    it(p, 'noise', 'No unusual noise or vibration', 'pass_fail'),
  ];
  const created = toIso(start);
  const base = { version: 1, assetClass: 'fixed_plant' as const, models: [], createdBy: people.supervisor, createdAt: created, reason: 'First version' };
  const grd = ['SAG01', 'BM01', 'PP01', 'PP02'];
  const fld = ['FC01', 'FC02', 'FC03', 'FC04', 'TH02', 'PP05', 'PP06'];
  const lube = ['SAG01', 'BM01', 'PP01', 'PP02', 'PP03', 'PP04', 'PP05', 'PP06'];
  const forms: InspectionForm[] = [
    {
      ...base, id: 'rt-grd', name: 'Grinding operator round', every: { n: 1, unit: 'shifts' },
      route: { kind: 'operator_round', nodeId: 'pn-grd', stops: grd.map((x) => byNum.get(x)!.id) },
      items: [
        it('SAG01', 'oil', 'Lube oil pressure', 'reading', { min: 1.5, max: 3, unit: 'bar', critical: true, weight: 2 }),
        it('SAG01', 'brg', 'Trunnion bearing temperature', 'reading', { max: 65, unit: '°C', weight: 2 }),
        it('SAG01', 'bolts', 'No leaks at liner bolts or feed chute', 'pass_fail', { photoOnFail: true }),
        it('BM01', 'oil', 'Lube oil pressure', 'reading', { min: 1.5, max: 3, unit: 'bar', critical: true, weight: 2 }),
        it('BM01', 'brg', 'Pinion bearing temperature', 'reading', { max: 70, unit: '°C' }),
        ...pump('PP01'), ...pump('PP02'),
      ],
    },
    {
      ...base, id: 'rt-fld', name: 'Flotation and tailings round', every: { n: 1, unit: 'shifts' },
      route: { kind: 'operator_round', nodeId: 'pn-fld', stops: fld.map((x) => byNum.get(x)!.id) },
      items: [
        ...['FC01', 'FC02', 'FC03', 'FC04'].flatMap((c) => [it(c, 'air', 'Air flow steady', 'pass_fail'), it(c, 'froth', 'Froth level in range', 'pass_fail')]),
        it('TH02', 'torque', 'Rake torque', 'reading', { max: 60, unit: '%', critical: true }),
        ...pump('PP05'), ...pump('PP06'),
      ],
    },
    {
      ...base, id: 'rt-lube', name: 'Mill and pump lube route', every: { n: 7, unit: 'days' },
      route: { kind: 'lube_route', nodeId: 'pn-con', stops: lube.map((x) => byNum.get(x)!.id) },
      items: lube.flatMap((x) => x === 'SAG01' || x === 'BM01'
        ? [it(x, 'de', 'Grease drive-end bearing', 'task'), it(x, 'nde', 'Grease non-drive-end bearing', 'task'), it(x, 'gb', 'Gearbox oil level correct', 'pass_fail')]
        : [it(x, 'de', 'Grease drive-end bearing', 'task'), it(x, 'nde', 'Grease non-drive-end bearing', 'task')]),
    },
  ];

  const rounds: Round[] = [];
  const inspections: Inspection[] = [];
  const downAt = (id: string, t: number) => flags.some((f) => f.unitId === id && (f.state === 'open' || f.state === 'released') && Date.parse(f.start) <= t && (f.end === null || Date.parse(f.end) > t));
  const answer = (x: FormItem): Answer => {
    const bad = r() < 0.025;
    if (x.kind === 'pass_fail') return bad ? { value: 'fail', note: 'Seen on round' } : { value: 'pass' };
    if (x.kind === 'task') return bad ? { value: 'missed', note: 'Grease line blocked' } : { value: 'done' };
    if (x.kind === 'reading') {
      const hi = x.max ?? 100;
      const lo = x.min ?? 0;
      const v = bad ? (x.max !== undefined ? hi * 1.08 : lo * 0.8) : lo + (hi - lo) * (0.45 + r() * 0.35);
      return bad ? { value: Math.round(v * 10) / 10, note: x.max !== undefined ? 'Running hot' : 'Low' } : { value: Math.round(v * 10) / 10 };
    }
    return { value: 3 };
  };
  const doRound = (form: InspectionForm, at: number) => {
    const id = `rd-${++n}`;
    const skipped: Round['skipped'] = [];
    for (const stop of form.route!.stops) {
      if (downAt(stop, at)) { skipped.push({ stopId: stop, reason: 'Equipment down' }); continue; }
      const sf = stopForm(form, stop);
      const answers: Record<string, Answer> = {};
      for (const x of sf.items) answers[x.id] = answer(x);
      const { score, result, failed } = scoreInspection(sf, answers);
      const sub = at + 30 * 60_000;
      const old = end - sub > 24 * HOUR_MS;
      const iid = `${id}-${stop}`;
      inspections.push({
        id: iid, formId: form.id, formVersion: 1, unitId: stop, roundId: id, status: old ? 'signed_off' : 'submitted', answers, startedBy: people.technician,
        startedAt: toIso(at), submittedAt: toIso(sub), score, result,
        defects: failed.map((f, k) => ({
          id: `${iid}-d${k}`, itemId: f.id, text: `${f.text}${answers[f.id]?.note ? `: ${answers[f.id]!.note}` : ''}`, severity: f.critical ? 'high' : 'medium',
          ...(end - sub > 3 * 24 * HOUR_MS ? { status: 'closed' as const, closeNote: 'Fixed on the next shift', updatedBy: people.supervisor, updatedAt: toIso(sub + 12 * HOUR_MS) } : { status: 'open' as const }),
        })),
        ...(old ? { signedOffBy: people.supervisor, signedOffAt: toIso(sub + 6 * HOUR_MS) } : {}),
      });
    }
    if (skipped.length === form.route!.stops.length) return;
    rounds.push({ id, formId: form.id, formVersion: 1, nodeId: form.route!.nodeId, status: 'submitted', startedBy: people.technician, startedAt: toIso(at), submittedAt: toIso(at + 30 * 60_000), skipped });
  };
  const shifts = shiftsBetween(w.calendar, toIso(end - 14 * 24 * HOUR_MS), toIso(end)).filter((x) => Date.parse(x.start) >= end - 14 * 24 * HOUR_MS);
  for (const sh of shifts) {
    const at = Date.parse(sh.start) + (1.5 + r()) * HOUR_MS;
    const current = Date.parse(sh.end) > end;
    for (const form of forms.slice(0, 2)) {
      // The grinding round is not done yet this shift, so the due list shows it.
      if (current && (form.id === 'rt-grd' || at > end)) continue;
      if (!current && r() < 0.07) continue;
      doRound(form, at);
    }
  }
  for (let t = localAt(end - 56 * 24 * HOUR_MS, 9); t < end - 24 * HOUR_MS; t += 7 * 24 * HOUR_MS) doRound(forms[2]!, t + (r() < 0.2 ? 24 * HOUR_MS : 0));
  return { shutdowns, workOrders, forms, rounds, inspections };
}

function pick<T>(r: () => number, xs: T[]): T {
  return xs[Math.floor(r() * xs.length)]!;
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}
