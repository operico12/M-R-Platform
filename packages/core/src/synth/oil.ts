// Synthetic oil analysis for the demo fleet (docs/condition-monitoring.md).
// A year of samples per haul truck and compartment at the site's intervals,
// with wear metals climbing in the hours before a component failure, the odd
// dust or coolant problem, a lab rating, and responses to the alerts. Own
// random stream, so the fleet, flags, SMU and components stay as before.

import type { ComponentEvent } from '../components.js';
import {
  COMPARTMENT_POSITION, COMPARTMENTS, DEFAULT_CONDITION_SETTINGS, ELEMENTS, buildBaselines, judge, needsResponse, rank, responseDue, reportTime,
  type CmResponse, type Compartment, type Element, type OilSample, type ResponseAction, type Severity,
} from '../condition.js';
import { HOUR_MS, ms, toIso } from '../time.js';
import type { Asset, SmuReading, WorkOrder } from '../types.js';

const DAY = 24 * HOUR_MS;

/** Typical value and spread (as a share of it) per compartment and element. Illustrative only. */
const NORMS: Record<Compartment, Partial<Record<Element, [number, number]>>> = {
  engine: { fe: [22, 0.3], cu: [4, 0.5], al: [3, 0.5], cr: [1.5, 0.5], pb: [2, 0.6], si: [8, 0.35], na: [3, 0.5], k: [2, 0.6], water: [0.02, 0.6], soot: [0.6, 0.4], visc100: [13.6, 0.04] },
  transmission: { fe: [28, 0.3], cu: [16, 0.35], al: [3, 0.5], cr: [1, 0.6], pb: [3, 0.5], si: [7, 0.35], na: [2, 0.6], k: [1, 0.7], water: [0.03, 0.6], visc100: [10.6, 0.04] },
  torque_converter: { fe: [20, 0.3], cu: [12, 0.35], al: [6, 0.4], cr: [1, 0.6], pb: [2, 0.6], si: [6, 0.35], na: [2, 0.6], k: [1, 0.7], water: [0.03, 0.6], visc100: [10.6, 0.04] },
  differential: { fe: [120, 0.3], cu: [8, 0.4], al: [2, 0.6], cr: [2, 0.5], pb: [2, 0.6], si: [10, 0.35], na: [2, 0.6], k: [1, 0.7], water: [0.04, 0.6], visc100: [18.2, 0.04] },
  final_drive_lh: { fe: [150, 0.3], cu: [6, 0.4], al: [2, 0.6], cr: [3, 0.5], pb: [2, 0.6], si: [12, 0.35], na: [2, 0.6], k: [1, 0.7], water: [0.04, 0.6], visc100: [18.2, 0.04] },
  final_drive_rh: { fe: [150, 0.3], cu: [6, 0.4], al: [2, 0.6], cr: [3, 0.5], pb: [2, 0.6], si: [12, 0.35], na: [2, 0.6], k: [1, 0.7], water: [0.04, 0.6], visc100: [18.2, 0.04] },
  hydraulic: { fe: [6, 0.4], cu: [3, 0.5], al: [1, 0.7], cr: [0.5, 0.8], pb: [1, 0.7], si: [4, 0.4], na: [2, 0.6], k: [1, 0.7], water: [0.03, 0.6], visc100: [7.0, 0.04] },
};

/** Elements that climb before each compartment's component fails. */
const WEAR: Record<Compartment, Element[]> = {
  engine: ['fe', 'cu', 'pb', 'cr'], transmission: ['fe', 'cu'], torque_converter: ['fe', 'cu', 'al'], differential: ['fe'],
  final_drive_lh: ['fe', 'cr'], final_drive_rh: ['fe', 'cr'], hydraulic: ['fe', 'cu'],
};

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

export function generateOil(input: { seed: number; assets: Asset[]; smu: SmuReading[]; componentEvents: ComponentEvent[]; workOrders: WorkOrder[]; end: number; days?: number }): { samples: OilSample[]; responses: CmResponse[] } {
  const r = rng(input.seed + 32452843);
  const between = (a: number, b: number) => a + r() * (b - a);
  const normal = () => { let u = 0; let v = 0; while (u === 0) u = r(); while (v === 0) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const end = input.end;
  const start = end - (input.days ?? 365) * DAY;
  const s = DEFAULT_CONDITION_SETTINGS;
  // The demo app's people (apps/web store), so names show on screen.
  const by = 'demo-reliability_engineer';
  const units = input.assets.filter((a) => a.assetClass === 'mobile' && a.fleet === 'Haul trucks');
  const model = new Map(input.assets.map((a) => [a.id, a.model]));
  const modelOf = (id: string) => model.get(id);

  // Unit SMU against time, as in the component generator: readings inside the history, a line before it.
  const curves = new Map<string, { reads: SmuReading[]; rate: number }>();
  for (const a of units) {
    const reads = input.smu.filter((x) => x.unitId === a.id).sort((x, y) => ms(x.at) - ms(y.at));
    if (reads.length < 2) continue;
    const rate = Math.max(8 / DAY, (reads.at(-1)!.hours - reads[0]!.hours) / (ms(reads.at(-1)!.at) - ms(reads[0]!.at)));
    curves.set(a.id, { reads, rate });
  }
  const smuAt = (unitId: string, t: number) => {
    const c = curves.get(unitId)!;
    const first = c.reads[0]!;
    if (t <= ms(first.at)) return first.hours - (ms(first.at) - t) * c.rate;
    let best = first;
    for (const x of c.reads) if (ms(x.at) <= t) best = x; else break;
    return best.hours + (t - ms(best.at)) * (best === c.reads.at(-1) ? c.rate : 0);
  };
  const timeAt = (unitId: string, h: number): number => {
    const c = curves.get(unitId)!;
    const first = c.reads[0]!;
    if (h <= first.hours) return ms(first.at) - (first.hours - h) / c.rate;
    for (let i = 1; i < c.reads.length; i++) {
      const a = c.reads[i - 1]!;
      const b = c.reads[i]!;
      if (b.hours >= h) return b.hours === a.hours ? ms(b.at) : ms(a.at) + ((h - a.hours) / (b.hours - a.hours)) * (ms(b.at) - ms(a.at));
    }
    return ms(c.reads.at(-1)!.at) + (h - c.reads.at(-1)!.hours) / c.rate;
  };

  // Component failures by unit and position: SMU at removal.
  const failures = new Map<string, number[]>();
  for (const e of input.componentEvents) {
    if (e.kind !== 'removed' || e.reason !== 'failure' || !e.unitId || !e.position || e.smu === undefined) continue;
    const k = `${e.unitId}|${e.position}`;
    failures.set(k, [...(failures.get(k) ?? []), e.smu]);
  }

  interface Raw { unitId: string; compartment: Compartment; taken: number; reported: number; smu: number; oilHours: number; readings: Partial<Record<Element, number>>; lab: Severity; comment?: string }
  const raws: Raw[] = [];
  let labNo = 0;
  for (const u of units) {
    if (!curves.has(u.id)) continue;
    // A few units fall behind on sampling.
    const lazy = r() < 0.15;
    for (const c of COMPARTMENTS) {
      const interval = s.intervals[c];
      const pos = COMPARTMENT_POSITION[c];
      const fails = pos ? failures.get(`${u.id}|${pos}`) ?? [] : [];
      let h = smuAt(u.id, start) + r() * interval;
      let lastChange = h - r() * interval;
      while (true) {
        const t = timeAt(u.id, h);
        if (t > end) break;
        const skip = r() < (lazy ? 0.25 : 0.05);
        if (!skip && t >= start) {
          const readings: Partial<Record<Element, number>> = {};
          const norms = NORMS[c];
          // How close to the next failure: wear metals build up over the last 1,000 hours.
          const next = fails.find((f) => f >= h);
          const ramp = next !== undefined && next - h < 1000 ? 1 + 2.6 * ((1000 - (next - h)) / 1000) ** 2 : 1;
          for (const el of ELEMENTS) {
            const n = norms[el.id];
            if (!n) continue;
            let v = n[0] * (1 + n[1] * normal());
            if (WEAR[c].includes(el.id)) v *= ramp;
            readings[el.id] = Math.max(0, v);
          }
          let comment: string | undefined;
          if (r() < 0.03) { readings.si = readings.si! * between(2.5, 4.5); readings.fe = readings.fe! * between(1.1, 1.5); comment = 'Silicon high: check air intake and breathers.'; }
          if (c === 'engine' && r() < 0.012) { readings.na = between(40, 120); readings.k = between(30, 90); readings.water = between(0.1, 0.35); comment = 'Coolant in oil: check the oil cooler and head gasket.'; }
          if (ramp > 2) comment = 'Wear metals rising: inspect, and plan the component change-out.';
          for (const el of ELEMENTS) if (readings[el.id] !== undefined) readings[el.id] = Number(readings[el.id]!.toFixed(el.decimals));
          // The lab's own rating: how far the worst element sits from normal for that compartment.
          let z = 0;
          for (const el of ELEMENTS) {
            const n = norms[el.id];
            const v = readings[el.id];
            if (!n || v === undefined) continue;
            z = Math.max(z, Math.abs(v - n[0]) / (n[0] * n[1]));
          }
          if ((readings.na ?? 0) > 35 || (readings.water ?? 0) > 0.2) z = Math.max(z, 7);
          const lab: Severity = z > 8 ? 'critical' : z > 5.5 ? 'action' : z > 3.8 ? 'monitor' : 'normal';
          const reported = t + between(2, 6) * DAY;
          if (reported <= end) raws.push({ unitId: u.id, compartment: c, taken: t, reported, smu: Math.round(h), oilHours: Math.round(h - lastChange), readings, lab, comment });
        }
        // Oil changes: every second sample on most compartments, every sample on engines.
        if (c === 'engine' || r() < 0.5) lastChange = h;
        h += interval * (lazy ? between(1.0, 1.5) : between(0.85, 1.15));
      }
    }
  }

  // Judge in report order against the baseline as it stood each week, as the app would have.
  raws.sort((a, b) => a.reported - b.reported);
  const samples: OilSample[] = [];
  let week = -1;
  let baselines = buildBaselines([], modelOf, toIso(start), s);
  for (const x of raws) {
    const w = Math.floor((x.reported - start) / (7 * DAY));
    if (w !== week) { week = w; baselines = buildBaselines(samples, modelOf, toIso(x.reported), s); }
    const j = judge({ compartment: x.compartment, readings: x.readings, labSeverity: x.lab }, modelOf(x.unitId), baselines);
    const enteredAt = toIso(x.reported + between(0.5, 8) * HOUR_MS);
    samples.push({
      id: `oil-${String(samples.length + 1).padStart(6, '0')}`, unitId: x.unitId, compartment: x.compartment, takenAt: toIso(x.taken), reportedAt: toIso(x.reported),
      smu: x.smu, oilHours: x.oilHours, labRef: `L${String(26000000 + ++labNo)}`, labSeverity: x.lab, readings: x.readings, comment: x.comment,
      severity: j.severity, reasons: j.reasons, enteredBy: by, enteredAt: ms(enteredAt) > end ? toIso(x.reported) : enteredAt,
    });
  }

  // Responses: most alerts answered, a few late, the newest still waiting.
  const responses: CmResponse[] = [];
  const wosBy = new Map<string, WorkOrder[]>();
  for (const w of input.workOrders) if (w.assetId) wosBy.set(w.assetId, [...(wosBy.get(w.assetId) ?? []), w]);
  for (const x of samples.filter(needsResponse)) {
    // Older alerts were all answered (some late); a few of the newest are still waiting.
    if (ms(reportTime(x)) > end - 21 * DAY && r() < 0.4) continue;
    const target = ms(responseDue(x, s)) - ms(reportTime(x));
    const at = ms(reportTime(x)) + target * (r() < 0.8 ? between(0.05, 0.9) : between(1.05, 2.5));
    if (at > end) continue;
    const p = r();
    const action: ResponseAction = rank(x.severity) >= rank('critical') && p < 0.7 ? 'work_order' : p < 0.4 ? 'work_order' : p < 0.7 ? 'resample' : p < 0.85 ? 'inspect' : p < 0.95 ? 'component_change' : 'no_action';
    let workOrder: string | undefined;
    if (action === 'work_order') {
      const w = (wosBy.get(x.unitId) ?? []).find((o) => o.reportedAt && ms(o.reportedAt) >= at - DAY && ms(o.reportedAt) <= at + 10 * DAY);
      workOrder = w?.number ?? `${Math.floor(500000 + r() * 99999)}`;
    }
    const note = {
      resample: 'Resample at the next service to confirm.', inspect: 'Inspect at the next shift: magnetic plugs and filters.', work_order: 'Corrective work order raised.',
      component_change: 'Change-out planned on the life board.', no_action: 'Contaminated sample bottle; result not representative.',
    }[action];
    responses.push({ id: `cmr-${String(responses.length + 1).padStart(6, '0')}`, sampleId: x.id, action, workOrder, note, by: r() < 0.5 ? 'demo-supervisor' : by, at: toIso(at) });
  }
  return { samples, responses };
}
