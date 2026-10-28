// Synthetic haul truck fleet (plan 14.1). Develop and demo on this, never on
// site data. Deterministic: the same seed always gives the same fleet.
//
// Each unit runs a timeline: operating and standby time between events,
// unscheduled failures (exponential gaps in operating hours), PMs every
// 250 SMU hours, some PMs that overrun with a defect, and repairs that move
// through realistic stages and locations. SMU is read at each shift change.

import { DateTime } from 'luxon';
import { DEFAULT_FLAG_RULES } from '../config.js';
import { HOUR_MS, ms, shiftsBetween, toIso, twelveHourCalendar, type ShiftCalendar } from '../time.js';
import { normaliseWoNumber } from '../imports.js';
import type { Component, ComponentEvent, LifeTarget } from '../components.js';
import { generateComponents } from './components.js';
import type { Asset, AssetLifecycleInterval, DownFlag, WorkOrder, LocationInterval, ShopLine, ShopLineClosure, SmuReading, Stage, StageInterval } from '../types.js';

export interface SynthOptions {
  seed?: number;
  units?: number;
  days?: number;
  /** End of the generated history; the last few flags are left open here. */
  end?: string;
  timeZone?: string;
}

export interface Dataset {
  tenantId: string;
  site: { id: string; name: string; timeZone: string };
  calendar: ShiftCalendar;
  assets: Asset[];
  lifecycle: AssetLifecycleInterval[];
  shopLines: ShopLine[];
  closures: ShopLineClosure[];
  fieldLocations: string[];
  flags: DownFlag[];
  smu: SmuReading[];
  /** Work orders as the ERP would hold them. */
  workOrders: WorkOrder[];
  /** Major components by serial, their event history and target lives (phase 3). */
  components: Component[];
  componentEvents: ComponentEvent[];
  lifeTargets: LifeTarget[];
  generatedAt: string;
}

export const SYSTEMS: Record<string, { components: string[]; modes: string[]; weight: number; repairH: number }> = {
  Engine: { components: ['Turbocharger', 'Injector', 'Fuel pump', 'Aftercooler'], modes: ['Leak', 'Overheat', 'Low power'], weight: 12, repairH: 7 },
  Transmission: { components: ['Clutch pack', 'Control valve', 'Torque converter'], modes: ['Slipping', 'No shift', 'Contamination'], weight: 6, repairH: 10 },
  Hydraulics: { components: ['Hoist cylinder', 'Hose', 'Hydraulic pump', 'Steering valve'], modes: ['Leak', 'Burst', 'Low pressure'], weight: 18, repairH: 3.5 },
  Brakes: { components: ['Brake pack', 'Brake valve', 'Accumulator'], modes: ['Worn', 'Leak', 'Fade'], weight: 8, repairH: 4 },
  Suspension: { components: ['Front strut', 'Rear strut', 'A-frame'], modes: ['Low charge', 'Leak', 'Crack'], weight: 7, repairH: 5 },
  Electrical: { components: ['Alternator', 'Harness', 'Starter', 'Sensor'], modes: ['Open circuit', 'Short', 'Intermittent'], weight: 15, repairH: 2.5 },
  Tyres: { components: ['Front tyre', 'Rear tyre', 'Rim'], modes: ['Cut', 'Low pressure', 'Separation'], weight: 14, repairH: 3 },
  Cooling: { components: ['Radiator', 'Fan drive', 'Water pump'], modes: ['Leak', 'Overheat', 'Blocked'], weight: 6, repairH: 4 },
  'Frame and body': { components: ['Frame rail', 'Body pad', 'Tray'], modes: ['Crack', 'Wear'], weight: 4, repairH: 9 },
  'Final drives': { components: ['Planetary', 'Wheel bearing', 'Seal'], modes: ['Leak', 'Noise', 'Metal in oil'], weight: 4, repairH: 12 },
  Steering: { components: ['Steering cylinder', 'Pump', 'Tie rod'], modes: ['Leak', 'Play'], weight: 4, repairH: 3 },
};

/** Starter cause codes (A9 reference lists). */
export const CAUSES = ['Wear', 'Contamination', 'Fatigue', 'Installation error', 'Operator damage', 'Design', 'Lubrication'];

export const FIELD_LOCATIONS = ['Pit 1 north', 'Pit 2 north ramp', 'Pit 2 south', 'Bench 1450', 'Bench 1480', 'Main haul road', 'ROM pad', 'Waste dump 3', 'Crusher pad'];

/** Mulberry32: small, fast, deterministic. */
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

export function generateFleet(opts: SynthOptions = {}): Dataset {
  const seed = opts.seed ?? 42;
  const nUnits = opts.units ?? 40;
  const days = opts.days ?? 120;
  const tz = opts.timeZone ?? 'America/Vancouver';
  const end = opts.end ? ms(opts.end) : Math.floor(Date.now() / (15 * 60_000)) * 15 * 60_000;
  const start = end - days * 24 * HOUR_MS;
  const r = rng(seed);
  const pick = <T,>(xs: T[]): T => xs[Math.floor(r() * xs.length)]!;
  const exp = (mean: number) => -Math.log(1 - r()) * mean;
  const logn = (median: number, sigma = 0.6) => median * Math.exp(sigma * gauss());
  function gauss() {
    const u = 1 - r();
    const v = r();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  const round5 = (t: number) => Math.round(t / (5 * 60_000)) * 5 * 60_000;

  const tenantId = 'tenant-demo';
  const siteId = 'site-demo';
  const calendar = twelveHourCalendar(tz);

  const assets: Asset[] = Array.from({ length: nUnits }, (_, i) => {
    const big = i >= nUnits * 0.7;
    const num = (big ? 200 : 100) + (big ? i - Math.floor(nUnits * 0.7) + 1 : i + 1);
    return {
      id: `ht${num}`,
      tenantId,
      siteId,
      unitNumber: `HT${num}`,
      fleet: 'Haul trucks',
      model: big ? '797F' : '793F',
      assetClass: 'mobile',
      serial: `${big ? 'LAJ' : 'SSP'}${String(10000 + i * 37).padStart(5, '0')}`,
      externalAssetId: `HT${num}`, // Maximo ASSETNUM is the unit number here
    };
  });

  const shopLines: ShopLine[] = [
    ...[1, 2, 3, 4, 5, 6].map((n) => ({ id: `line-${n}`, siteId, shop: 'Truck shop', number: n, lineType: (n === 6 ? 'pm' : 'general') as ShopLine['lineType'], capacity: 1, fits: [] as string[] })),
    { id: 'tyre-bay', siteId, shop: 'Truck shop', name: 'Tyre bay', lineType: 'tyre', capacity: 1, fits: [] },
    { id: 'weld-bay', siteId, shop: 'Truck shop', name: 'Weld bay', lineType: 'weld', capacity: 1, fits: [] },
    { id: 'wash-pad', siteId, shop: 'Truck shop', name: 'Wash pad', lineType: 'wash', capacity: 2, fits: [] },
  ];
  const generalLines = shopLines.filter((l) => l.lineType === 'general').map((l) => l.id);

  const closures: ShopLineClosure[] = [
    { lineId: 'line-3', start: toIso(start + 20 * 24 * HOUR_MS), end: toIso(start + 20 * 24 * HOUR_MS + 10 * HOUR_MS), reason: 'Crane inspection' },
  ];

  const flags: DownFlag[] = [];
  const bookings = new Map<string, Array<[number, number]>>();
  const smu: SmuReading[] = [];
  const lifecycle: AssetLifecycleInterval[] = [];
  let fid = 0;
  const id = () => `flag-${String(++fid).padStart(5, '0')}`;
  const sup = 'user-supervisor';

  // Shift change instants for SMU readings.
  const shiftChanges = shiftsBetween(calendar, toIso(start), toIso(end)).map((x) => ms(x.start)).filter((x) => x >= start && x <= end);

  // One unit parked for the last 3 weeks, to exercise R2.
  const parkedUnit = assets[nUnits - 1]!;
  const parkedFrom = end - 21 * 24 * HOUR_MS;
  lifecycle.push({ assetId: parkedUnit.id, status: 'parked', start: toIso(parkedFrom), end: null });

  for (const a of assets) {
    // Per-unit reliability: a few bad actors fail much more often.
    const badActor = r() < 0.12;
    const mtbfOp = (a.model === '797F' ? 110 : 130) / (badActor ? 2.5 : 1);
    const utilisation = 0.78 + r() * 0.14; // share of available time operating
    const smuStart = 8000 + Math.floor(r() * 40000);
    let smuNow = smuStart;
    let nextPmSmu = Math.ceil(smuNow / 250) * 250 + 250;
    let t = start;
    // Down intervals for SMU accrual.
    const downs: Array<[number, number]> = [];

    const unitEnd = a.id === parkedUnit.id ? parkedFrom : end;
    while (t < unitEnd) {
      // Operating until the next failure or PM.
      const opToFailure = exp(mtbfOp);
      const opToPm = nextPmSmu - smuNow;
      const op = Math.min(opToFailure, opToPm);
      const calendarGap = op / utilisation;
      const eventStart = round5(t + calendarGap * HOUR_MS);
      if (eventStart >= unitEnd) break;
      smuNow += op;

      const isPm = opToPm <= opToFailure;
      const flag = isPm ? pmFlag(a, eventStart) : failureFlag(a, eventStart);
      if (flag.length === 0) break;
      for (const f of flag) {
        flags.push(f);
        downs.push([ms(f.start), f.end ? ms(f.end) : end]);
      }
      const last = flag[flag.length - 1]!;
      if (!last.end) break; // still down at the end of the history
      t = ms(last.end);
      if (isPm) nextPmSmu += 250;
    }

    // SMU readings at each shift change: operating time accrues only while not down.
    let reading = smuStart;
    let prev = start;
    for (const sc of shiftChanges) {
      if (a.id === parkedUnit.id && sc > parkedFrom) {
        smu.push({ unitId: a.id, at: toIso(sc), hours: Math.round(reading * 10) / 10 });
        continue;
      }
      const span = (sc - prev) / HOUR_MS;
      const downH = downs.reduce((s, [ds, de]) => s + Math.max(0, Math.min(sc, de) - Math.max(prev, ds)) / HOUR_MS, 0);
      const avail = Math.max(0, span - downH);
      reading += avail * Math.min(1, utilisation + (r() - 0.5) * 0.1);
      // A few missed readings, as in real life.
      if (r() > 0.01) smu.push({ unitId: a.id, at: toIso(sc), hours: Math.round(reading * 10) / 10 });
      prev = sc;
    }
  }

  function stage(s: Stage, a: number, b: number | null, extra: Partial<StageInterval> = {}): StageInterval {
    return { stage: s, start: toIso(a), end: b === null ? null : toIso(b), setBy: sup, enteredAt: toIso(a), ...extra };
  }
  function loc(kind: LocationInterval['kind'], a: number, b: number | null, extra: Partial<LocationInterval> = {}): LocationInterval {
    return { kind, start: toIso(a), end: b === null ? null : toIso(b), setBy: sup, enteredAt: toIso(a), ...extra };
  }
  function base(a: Asset, type: DownFlag['type'], s: number): DownFlag {
    return {
      id: id(), tenantId, siteId, unitId: a.id, type, state: 'open', reasonCode: type === 'scheduled' ? 'PM' : 'Breakdown',
      start: toIso(s), end: null, stages: [], locations: [], etas: [], workOrders: [], source: 'app', setBy: sup, enteredAt: toIso(s),
    };
  }
  function close(f: DownFlag, at: number): DownFlag {
    if (at > end) {
      // Leave it open at "now": trim intervals that would be in the future.
      const keepS = f.stages.filter((x) => ms(x.start) <= end).map((x, i, arr) => (i === arr.length - 1 ? { ...x, end: null } : x));
      const keepL = f.locations.filter((x) => ms(x.start) <= end).map((x, i, arr) => (i === arr.length - 1 ? { ...x, end: null } : x));
      return { ...f, state: 'open', end: null, stages: keepS, locations: keepL, release: undefined, releasedBy: undefined, etas: f.etas.filter((e) => ms(e.setAt) <= end) };
    }
    return { ...f, state: 'released', end: toIso(at), releasedBy: sup };
  }

  // Line bookings, so no line ever holds more units than its capacity (L1) or
  // takes a unit while closed (L2). A unit that finds no free line waits in the yard.
  function lineFreeFor(lineId: string, from: number, dur: number): boolean {
    const to = from + dur;
    const cap = shopLines.find((l) => l.id === lineId)!.capacity;
    const busy = (bookings.get(lineId) ?? []).filter(([a, b]) => a < to && from < b).length;
    const closed = closures.some((c) => c.lineId === lineId && ms(c.start) < to && from < (c.end ? ms(c.end) : Infinity));
    return busy < cap && !closed;
  }
  function reserveLine(candidates: string[], arrival: number, dur: number): { lineId: string; at: number } {
    for (let at = arrival; ; at += 15 * 60_000) {
      const free = candidates.filter((c) => lineFreeFor(c, at, dur));
      if (free.length) {
        const lineId = pick(free);
        const list = bookings.get(lineId) ?? [];
        list.push([at, at + dur]);
        bookings.set(lineId, list);
        return { lineId, at };
      }
    }
  }

  function pmFlag(a: Asset, due: number): DownFlag[] {
    const planned = a.model === '797F' ? 10 : 8;
    const wo = `PM-${Math.floor(100000 + r() * 899999)}`;
    const actual = planned * (0.8 + r() * 0.35);
    const overrun = r() < 0.15;
    const sys = pick(Object.keys(SYSTEMS));
    const extra = logn(SYSTEMS[sys]!.repairH * 0.8);
    const dur = (overrun ? planned + extra : actual) * HOUR_MS + 30 * 60_000;
    // PMs are planned: they start when the PM line (or a general line) is free.
    const booked = reserveLine(['line-6', ...generalLines], due, dur);
    const s = round5(booked.at);
    if (s >= end) return [];
    const line = booked.lineId;
    let f = base(a, 'scheduled', s);
    f = { ...f, reasonCode: 'PM 250', plannedDurationHours: planned, workOrders: [wo], system: 'PM' };
    if (!overrun) {
      const e = round5(s + actual * HOUR_MS);
      f.stages = [stage('in_repair', s, e - 15 * 60_000), stage('ready_for_release', e - 15 * 60_000, e)];
      f.locations = [loc('shop_line', s, e, { shopLineId: line })];
      f.etas = [{ eta: toIso(s + planned * HOUR_MS), setAt: toIso(s), setBy: sup }];
      f.release = { pmOrWorkOrder: wo, repairSummary: '250 h service completed', findings: r() < 0.3 ? 'Minor leaks noted, follow-up raised' : 'None' };
      return [close(f, e)];
    }
    // PM finds a defect; the time past the planned duration is unscheduled (R8, D4).
    const sw = round5(s + planned * HOUR_MS);
    f.stages = [stage('in_repair', s, sw)];
    f.locations = [loc('shop_line', s, sw, { shopLineId: line })];
    f.etas = [{ eta: toIso(sw), setAt: toIso(s), setBy: sup }];
    f.release = { pmOrWorkOrder: wo, repairSummary: '250 h service completed', findings: `Defect found: ${sys}` };
    f.notes = 'Closed by type switch: defect found at PM';
    if (sw > end) return [close(f, sw)];
    f = { ...f, state: 'released', end: toIso(sw), releasedBy: sup };
    const e = round5(sw + extra * HOUR_MS);
    const g = base(a, 'unscheduled', sw);
    g.reasonCode = 'Defect found at PM';
    g.system = sys;
    g.linkedFromFlagId = f.id;
    g.linkKind = 'type_switch';
    g.stages = [stage('in_repair', sw, e)];
    g.locations = [loc('shop_line', sw, e, { shopLineId: line })];
    g.etas = [{ eta: toIso(sw + extra * 0.8 * HOUR_MS), setAt: toIso(sw), setBy: sup }];
    g.workOrders = [`WO-${Math.floor(100000 + r() * 899999)}`];
    g.release = releaseFor(sys, g.workOrders[0]!, 'pm');
    return [f, close(g, e)];
  }

  function releaseFor(sys: string, wo: string, det: 'operator' | 'pm' | 'inspection' | 'alarm') {
    const d = SYSTEMS[sys]!;
    return { system: sys, component: pick(d.components), failureModes: [pick(d.modes)], repairSummary: `Repaired ${sys.toLowerCase()}`, workOrder: wo, detectionMethod: det };
  }

  function failureFlag(a: Asset, s: number): DownFlag[] {
    const systems = Object.entries(SYSTEMS);
    const total = systems.reduce((x, [, v]) => x + v.weight, 0);
    let roll = r() * total;
    let sys = systems[0]![0];
    for (const [k, v] of systems) {
      roll -= v.weight;
      if (roll <= 0) { sys = k; break; }
    }
    const def = SYSTEMS[sys]!;
    const f = base(a, 'unscheduled', s);
    f.system = sys;
    f.reasonCode = sys;
    const wo = `WO-${Math.floor(100000 + r() * 899999)}`;
    f.workOrders = [wo];

    // Minor stop: under 15 minutes, fixed on the spot by the operator or a field crew.
    if (r() < 0.06) {
      const e = s + (5 + Math.floor(r() * 2) * 5) * 60_000;
      const fl = pick(FIELD_LOCATIONS);
      f.stages = [stage('in_repair', s, e)];
      f.locations = [loc('field', s, e, { fieldLocation: fl })];
      f.release = releaseFor(sys, wo, 'operator');
      return [close(f, e)];
    }

    const st: StageInterval[] = [];
    const lc: LocationInterval[] = [];
    let t = s;
    const add = (stg: Stage, hours: number, extra: Partial<StageInterval> = {}) => {
      const e = round5(t + Math.max(0.08, hours) * HOUR_MS);
      st.push(stage(stg, t, e, extra));
      t = e;
    };
    const field = r() < 0.55 || sys === 'Tyres';
    const fieldFix = field && r() < (sys === 'Tyres' || sys === 'Electrical' ? 0.55 : 0.25);
    const repairH = logn(def.repairH);
    if (field) {
      const fl = pick(FIELD_LOCATIONS);
      const fs = t;
      add('waiting_crew', logn(0.6, 0.5));
      add('in_repair', fieldFix ? repairH : logn(0.7, 0.4));
      if (!fieldFix) {
        lc.push(loc('field', fs, t, { fieldLocation: fl }));
        const ts = t;
        add('in_transit', logn(0.8, 0.3));
        lc.push(loc('towing', ts, t));
      } else {
        if (r() < 0.2) add('waiting_parts', logn(2, 0.6), { partOrWorkOrder: wo });
        if (st[st.length - 1]!.stage !== 'in_repair') add('in_repair', repairH * 0.3);
        add('ready_for_release', logn(0.3, 0.4));
        lc.push(loc('field', fs, t, { fieldLocation: fl }));
      }
    }
    if (!fieldFix) {
      // At the shop: maybe wait for a line, then a line.
      // Work out the time in the line first, then book a line for it.
      const parts = r() < 0.35 ? logn(4, 0.9) : 0;
      const labour = !parts && r() < 0.1 ? logn(1.5, 0.6) : 0;
      const other = !parts && !labour && r() < 0.05 ? logn(2, 0.6) : 0;
      const ready = logn(0.4, 0.5);
      const inLineH = repairH + parts + labour + other + ready + 0.5;
      const candidates = sys === 'Tyres' ? ['tyre-bay'] : sys === 'Frame and body' ? ['weld-bay', ...generalLines] : generalLines;
      const booked = reserveLine(candidates, t, inLineH * HOUR_MS);
      const ys = t;
      if (booked.at > t) {
        const e = round5(booked.at);
        st.push(stage('waiting_line', t, e));
        t = e;
        lc.push(loc('shop_yard', ys, t));
      }
      const ls = t;
      add('in_repair', repairH * 0.5);
      if (parts) add('waiting_parts', parts, { partOrWorkOrder: wo });
      if (labour) add('waiting_labour', labour);
      if (other) add('waiting_other', other, { reason: pick(DEFAULT_FLAG_RULES.waitingOtherReasons) });
      add('in_repair', repairH * 0.5);
      add('ready_for_release', ready);
      lc.push(loc('shop_line', ls, t, { shopLineId: booked.lineId }));
    }
    f.stages = st;
    f.locations = lc;
    const etaH = (t - s) / HOUR_MS * (0.7 + r() * 0.6);
    f.etas = [{ eta: toIso(round5(s + etaH * HOUR_MS)), setAt: toIso(s + 45 * 60_000), setBy: sup }];
    f.release = releaseFor(sys, wo, field ? 'operator' : pick(['operator', 'inspection', 'alarm'] as const));
    return [close(f, t)];
  }

  // Work orders as Maximo would hold them: one per flag work order, plus a
  // backlog of open work not yet done (deferred defects, upcoming PMs).
  flags.sort((a, b) => ms(a.start) - ms(b.start));
  // Failure coding as people really enter it (phase 2 code-quality checks): mostly
  // complete, with cause codes on most, and some "Other", "Unknown" and mismatches.
  // Own random stream, so durations, stages and KPIs stay the same for a seed.
  const cq = rng(seed + 104729);
  const sysNames = Object.keys(SYSTEMS);
  for (const f of flags) {
    const rel = f.release;
    if (!rel?.system || !SYSTEMS[rel.system]) continue;
    const x = cq();
    if (x < 0.07) rel.component = 'Other';
    else if (x < 0.1) rel.failureModes = ['Unknown'];
    else if (x < 0.12) {
      const other = SYSTEMS[sysNames[Math.floor(cq() * sysNames.length)]!]!;
      rel.component = other.components[Math.floor(cq() * other.components.length)];
    }
    if (cq() < 0.7) rel.causeCode = CAUSES[Math.floor(cq() * CAUSES.length)];
  }
  const wos = new Map<string, WorkOrder>();
  const woFor = (a: Asset, number: string, w: Omit<WorkOrder, 'id' | 'tenantId' | 'siteId' | 'sourceSystem' | 'sourceId' | 'number' | 'numberNormalised' | 'assetId' | 'externalAssetId'>) => {
    const key = normaliseWoNumber(number);
    if (wos.has(key)) return;
    wos.set(key, { id: `wo-${key}`, tenantId, siteId, assetId: a.id, externalAssetId: a.externalAssetId, sourceSystem: 'maximo', sourceId: key, number: key, numberNormalised: key, ...w });
  };
  const unitOf = new Map(assets.map((a) => [a.id, a]));
  // Planning fields (phase 2 work view) use their own random stream, so the
  // fleet, flags and SMU stay exactly as before for a given seed.
  const q = rng(seed + 7919);
  const DAY = 24 * HOUR_MS;
  const half = (h: number) => Math.max(0.5, Math.round(h * 2) / 2);
  const dayStart = (t: number) => DateTime.fromMillis(t, { zone: tz }).startOf('day').toMillis();
  const pmDone: Array<{ unit: string; number: string; at: number }> = [];
  for (const f of flags) {
    const a = unitOf.get(f.unitId)!;
    for (const n of f.workOrders) {
      const pm = n.startsWith('PM-');
      const done = f.state === 'released';
      const s0 = ms(f.start);
      const durH = ((f.end ? ms(f.end) : end) - s0) / HOUR_MS;
      const em = !pm && q() < 0.35;
      // PMs: most done near their due date, some late. Scheduled on the day they started, sometimes slipped.
      const due = pm ? dayStart(s0 + (q() < 0.85 ? (Math.floor(q() * 4) - 2) * DAY : -(5 + Math.floor(q() * 6)) * DAY)) : undefined;
      const sched = pm ? (q() < 0.8 ? s0 : s0 - 2 * DAY) : !em ? s0 : undefined;
      woFor(a, n, {
        woType: pm ? 'PM' : em ? 'EM' : 'CM', workClass: pm ? 'pm' : 'corrective', status: done ? 'COMP' : 'INPRG', open: !done,
        priority: pm ? '3' : em ? '1' : '2', description: pm ? `${f.reasonCode} service` : `${f.system ?? f.reasonCode}: ${f.release?.failureModes?.[0] ?? 'repair'}`,
        reportedAt: f.start, completedAt: f.end ?? undefined, sourceModifiedAt: f.end ?? f.start,
        targetStart: due !== undefined ? toIso(due) : undefined, targetFinish: due !== undefined ? toIso(due + DAY - 60_000) : undefined,
        scheduledStart: sched !== undefined ? toIso(round5(sched)) : undefined,
        scheduledFinish: sched !== undefined ? toIso(round5(sched + (f.plannedDurationHours ?? Math.min(durH, 12)) * HOUR_MS)) : undefined,
        estimatedHours: half((f.plannedDurationHours ?? Math.min(durH, 24)) * 1.5),
        actualLabourHours: done ? half(durH * (1.2 + q())) : undefined,
        pmNumber: pm ? `PM250-${a.unitNumber}` : undefined,
      });
      if (pm && done) pmDone.push({ unit: a.id, number: normaliseWoNumber(n), at: ms(f.end!) });
    }
  }
  const backlog = ['Weeping hose at hoist cylinder', 'Cracked step', 'Seat belt worn', 'Body liner wear check', 'Replace cab filter', 'Light bar inoperative', 'Oil sample follow-up'];
  for (const a of assets) {
    const n = Math.floor(r() * 4);
    for (let i = 0; i < n; i++) {
      const at = round5(end - r() * 21 * 24 * HOUR_MS);
      const st = pick(['WAPPR', 'APPR', 'WMATL', 'WSCH']);
      const from = pmDone.filter((x) => x.unit === a.id && x.at <= at).at(-1);
      const sched = st === 'WSCH' ? round5(end + (Math.floor(q() * 10) - 3) * DAY) : undefined;
      woFor(a, String(Math.floor(200000 + r() * 799999)), {
        woType: 'CM', workClass: 'corrective', status: st, open: true, priority: pick(['2', '3', '4']),
        description: pick(backlog), reportedAt: toIso(at), sourceModifiedAt: toIso(at),
        estimatedHours: q() < 0.9 ? half(1 + q() * 11) : undefined,
        originWorkOrder: from && q() < 0.5 ? from.number : undefined,
        scheduledStart: sched !== undefined ? toIso(sched) : undefined, scheduledFinish: sched !== undefined ? toIso(sched + 4 * HOUR_MS) : undefined,
      });
    }
  }
  // The next PM for each haul truck: due in the next two weeks, a few already overdue.
  for (const a of assets.filter((x) => x.fleet === 'Haul trucks')) {
    const due = dayStart(end + (Math.floor(q() * 17) - 3) * DAY);
    const number = `PM-${Math.floor(300000 + q() * 699999)}`;
    woFor(a, number, {
      woType: 'PM', workClass: 'pm', status: 'WSCH', open: true, priority: '3', description: 'PM 250 service',
      reportedAt: toIso(round5(Math.min(due - 7 * DAY, end - HOUR_MS))), sourceModifiedAt: toIso(round5(Math.min(due - 7 * DAY, end - HOUR_MS))),
      targetStart: toIso(due), targetFinish: toIso(due + DAY - 60_000), scheduledStart: toIso(due + 7 * HOUR_MS), scheduledFinish: toIso(due + 15 * HOUR_MS),
      estimatedHours: 16, pmNumber: `PM250-${a.unitNumber}`,
    });
  }

  const parts = generateComponents({ seed, assets, smu, flags, end });

  return {
    tenantId,
    site: { id: siteId, name: 'Demo mine (synthetic)', timeZone: tz },
    calendar,
    assets,
    lifecycle,
    shopLines,
    closures,
    fieldLocations: FIELD_LOCATIONS,
    flags,
    workOrders: [...wos.values()].sort((a, b) => ms(a.reportedAt!) - ms(b.reportedAt!)),
    smu: smu.sort((a, b) => ms(a.at) - ms(b.at)),
    components: parts.components,
    componentEvents: parts.events,
    lifeTargets: parts.targets,
    generatedAt: toIso(end),
  };
}
