// Synthetic component history for the demo fleet (docs/component-life.md).
// Each haul truck position runs a chain of component lives from the truck's
// first hour: lives are drawn from a Weibull, planned change-outs happen near
// target life, removed components go to one of two rebuild vendors (one is
// worse) and come back into a shared pool. Own random stream, so the fleet,
// flags and SMU stay exactly as before for a given seed.

import type { Component, ComponentEvent, ComponentKind, LifeTarget } from '../components.js';
import { POSITIONS } from '../components.js';
import { HOUR_MS, ms, toIso } from '../time.js';
import type { Asset, DownFlag, SmuReading } from '../types.js';

const DAY = 24 * HOUR_MS;

/** Illustrative targets, not OEM figures (docs/component-life.md). */
export const DEMO_LIFE_TARGETS: Record<string, Record<ComponentKind, number>> = {
  '793F': { engine: 20000, transmission: 16000, torque_converter: 16000, differential: 24000, final_drive: 18000, front_strut: 12000, rear_strut: 12000 },
  '797F': { engine: 22000, transmission: 16000, torque_converter: 16000, differential: 24000, final_drive: 18000, front_strut: 12000, rear_strut: 12000 },
};

const PRICES: Record<ComponentKind, { fresh: number; rebuild: number; changeoutH: number; beta: number; prefix: string }> = {
  engine: { fresh: 600000, rebuild: 280000, changeoutH: 30, beta: 2.6, prefix: 'EN' },
  transmission: { fresh: 250000, rebuild: 110000, changeoutH: 20, beta: 2.4, prefix: 'TR' },
  torque_converter: { fresh: 90000, rebuild: 35000, changeoutH: 14, beta: 2.2, prefix: 'TC' },
  differential: { fresh: 180000, rebuild: 70000, changeoutH: 24, beta: 2.5, prefix: 'DF' },
  final_drive: { fresh: 150000, rebuild: 60000, changeoutH: 18, beta: 2.3, prefix: 'FD' },
  front_strut: { fresh: 45000, rebuild: 15000, changeoutH: 8, beta: 1.8, prefix: 'FS' },
  rear_strut: { fresh: 45000, rebuild: 15000, changeoutH: 8, beta: 1.8, prefix: 'RS' },
};

const SYSTEM_OF: Record<ComponentKind, string> = {
  engine: 'Engine', transmission: 'Transmission', torque_converter: 'Transmission', differential: 'Final drives', final_drive: 'Final drives', front_strut: 'Suspension', rear_strut: 'Suspension',
};

export const DEMO_VENDORS = ['Northern Rebuild Centre', 'Valley Component Services'];

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

interface Job { t: number; seq: number; run: () => void }

export function generateComponents(input: { seed: number; assets: Asset[]; smu: SmuReading[]; flags: DownFlag[]; end: number }): { components: Component[]; events: ComponentEvent[]; targets: LifeTarget[] } {
  const r = rng(input.seed + 15485863);
  const between = (a: number, b: number) => a + r() * (b - a);
  const end = input.end;
  const by = 'user-supervisor';
  const components: Component[] = [];
  const events: ComponentEvent[] = [];
  let cid = 0;
  let eid = 0;
  const ev = (e: Omit<ComponentEvent, 'id' | 'enteredBy' | 'enteredAt'>) => {
    events.push({ ...e, id: `cev-${String(++eid).padStart(6, '0')}`, enteredBy: by, enteredAt: e.at });
  };

  // Unit SMU against time: readings inside the history, a straight line before it.
  const curves = new Map<string, { reads: SmuReading[]; rate: number }>();
  for (const a of input.assets) {
    const reads = input.smu.filter((x) => x.unitId === a.id).sort((x, y) => ms(x.at) - ms(y.at));
    if (reads.length < 2) continue;
    const first = reads[0]!;
    const last = reads[reads.length - 1]!;
    const rate = Math.max(8 / DAY, (last.hours - first.hours) / (ms(last.at) - ms(first.at)));
    curves.set(a.id, { reads, rate });
  }
  /** Time the unit reached `h` SMU hours, or null if it has not yet. */
  const timeAt = (unitId: string, h: number): number | null => {
    const c = curves.get(unitId)!;
    const first = c.reads[0]!;
    if (h <= first.hours) return ms(first.at) - (first.hours - h) / c.rate;
    for (let i = 1; i < c.reads.length; i++) {
      const a = c.reads[i - 1]!;
      const b = c.reads[i]!;
      if (b.hours >= h) return b.hours === a.hours ? ms(b.at) : ms(a.at) + ((h - a.hours) / (b.hours - a.hours)) * (ms(b.at) - ms(a.at));
    }
    return null;
  };
  const smuAt = (unitId: string, t: number): number => {
    const c = curves.get(unitId)!;
    const first = c.reads[0]!;
    if (t <= ms(first.at)) return first.hours - (ms(first.at) - t) * c.rate;
    let best = first;
    for (const x of c.reads) if (ms(x.at) <= t) best = x; else break;
    return best.hours;
  };

  // A simple time-ordered queue.
  const jobs: Job[] = [];
  let seq = 0;
  const at = (t: number, run: () => void) => {
    const j = { t, seq: ++seq, run };
    let lo = 0;
    let hi = jobs.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (jobs[m]!.t < t || (jobs[m]!.t === t && jobs[m]!.seq < j.seq)) lo = m + 1; else hi = m; }
    jobs.splice(lo, 0, j);
  };

  interface Pooled { c: Component; readyAt: number; quality: number; infant: number; warranty?: { hours: number; months: number }; hours: number; rebuilds: number; cost?: number }
  const pool = new Map<string, Pooled[]>();
  const poolKey = (kind: ComponentKind, model: string) => `${kind}|${model}`;

  const newComponent = (kind: ComponentKind, model: string, t: number, how: 'factory' | 'new' | 'exchange'): Pooled => {
    const p = PRICES[kind];
    const c: Component = { id: `cmp-${String(++cid).padStart(5, '0')}`, serial: `${p.prefix}${model.slice(0, 3)}-${String(10000 + cid)}`, kind, models: [model], hoursAtEntry: 0, rebuildsAtEntry: 0, createdBy: by, createdAt: toIso(t) };
    components.push(c);
    const cost = how === 'factory' ? undefined : Math.round(p.fresh * (how === 'exchange' ? 0.7 : 1));
    const coreDueBy = how === 'exchange' ? new Date(t + 30 * DAY).toISOString().slice(0, 10) : undefined;
    ev({ componentId: c.id, kind: 'received', at: toIso(t), receivedAs: how === 'exchange' ? 'exchange' : 'new', cost, warrantyHours: 10000, warrantyMonths: how === 'factory' ? 24 : 12, coreDueBy, note: how === 'factory' ? 'Fitted at the factory' : undefined });
    if (coreDueBy) {
      const back = t + (r() < 0.8 ? between(5, 28) : between(35, 90)) * DAY;
      if (back <= end) ev({ componentId: c.id, kind: 'core_returned', at: toIso(back), cost: Math.round(p.rebuild * 0.25) });
    }
    return { c, readyAt: t, quality: 1.1, infant: 0.02, warranty: { hours: 10000, months: how === 'factory' ? 24 : 12 }, hours: 0, rebuilds: 0, cost };
  };

  const unitOf = new Map(input.assets.map((a) => [a.id, a]));
  const flagsBy = new Map<string, DownFlag[]>();
  for (const f of input.flags) if (f.type === 'unscheduled') flagsBy.set(f.unitId, [...(flagsBy.get(f.unitId) ?? []), f]);

  const install = (unitId: string, posId: string, t: number, h: number, first: boolean) => {
    const unit = unitOf.get(unitId)!;
    const pos = POSITIONS.find((p) => p.id === posId)!;
    const kind = pos.kind;
    const key = poolKey(kind, unit.model);
    const list = pool.get(key) ?? [];
    let p: Pooled;
    const i = first ? -1 : list.findIndex((x) => x.readyAt <= t);
    if (i >= 0) p = list.splice(i, 1)[0]!;
    else p = newComponent(kind, unit.model, first ? t - 2 * DAY : t - DAY, first ? 'factory' : r() < 0.4 ? 'exchange' : 'new');
    pool.set(key, list);
    ev({ componentId: p.c.id, kind: 'installed', at: toIso(t), unitId, position: posId, smu: Math.round(h) });
    // How long this one will run.
    const target = DEMO_LIFE_TARGETS[unit.model]?.[kind] ?? 15000;
    const beta = PRICES[kind].beta;
    const eta = target * 1.05 * p.quality;
    const life = r() < p.infant ? between(0.02, 0.2) * target : eta * (-Math.log(1 - r())) ** (1 / beta);
    const plannedAt = target * between(0.92, 1.03);
    const failure = life < plannedAt;
    const hOut = h + (failure ? life : plannedAt);
    let tOut = timeAt(unitId, hOut);
    if (tOut === null || tOut > end) return; // still running now
    let flagId: string | undefined;
    if (failure && tOut >= end - 130 * DAY) {
      // Link to a down flag of the same system around that time, when there is one.
      const f = (flagsBy.get(unitId) ?? []).find((x) => (x.release?.system ?? x.system) === SYSTEM_OF[kind] && Math.abs(ms(x.start) - tOut!) < 10 * DAY && ms(x.start) > t);
      if (f) { flagId = f.id; tOut = ms(f.start); }
    }
    const smuOut = Math.max(Math.round(h), Math.round(flagId ? smuAt(unitId, tOut) : hOut));
    at(tOut, () => remove(p, unitId, posId, tOut!, smuOut, failure ? 'failure' : 'planned', flagId, Math.round(h)));
  };

  const remove = (p: Pooled, unitId: string, posId: string, t: number, h: number, reason: 'failure' | 'planned', flagId: string | undefined, hIn: number) => {
    const kind = p.c.kind;
    ev({ componentId: p.c.id, kind: 'removed', at: toIso(t), unitId, position: posId, smu: h, reason, flagId, workOrder: flagId ? undefined : `WO-${Math.floor(100000 + r() * 899999)}` });
    p.hours += h - hIn;
    const sinceStart = t - p.readyAt;
    const warranted = reason === 'failure' && p.warranty && p.hours < p.warranty.hours && sinceStart < p.warranty.months * 30.4 * DAY;
    // The truck gets its next component after the change-out.
    const back = t + PRICES[kind].changeoutH * HOUR_MS * between(0.8, 1.4);
    if (back <= end) at(back, () => install(unitId, posId, back, h, false));
    // This one goes to rebuild, or is scrapped after many rebuilds.
    const sent = t + between(2, 7) * DAY;
    const claim = warranted ? t + between(2, 6) * DAY : null;
    if (claim !== null && claim <= end) {
      ev({ componentId: p.c.id, kind: 'warranty_claim', at: toIso(claim), claim: 'opened' });
    }
    if (sent > end) return;
    if (reason === 'failure' && p.rebuilds >= 3 && r() < 0.3) {
      ev({ componentId: p.c.id, kind: 'scrapped', at: toIso(sent), note: 'Beyond economic repair' });
      return;
    }
    const vendor = r() < 0.65 ? DEMO_VENDORS[0]! : DEMO_VENDORS[1]!;
    ev({ componentId: p.c.id, kind: 'sent_rebuild', at: toIso(sent), vendor, reference: `PO-${Math.floor(400000 + r() * 99999)}` });
    if (claim !== null) {
      const decided = claim + between(20, 45) * DAY;
      if (decided <= end - 30 * DAY) {
        const ok = r() < 0.7;
        ev({ componentId: p.c.id, kind: 'warranty_claim', at: toIso(decided), claim: ok ? 'accepted' : 'rejected', cost: ok ? Math.round((p.cost ?? PRICES[kind].rebuild) * 0.4) : undefined });
      }
    }
    const done = sent + between(vendor === DEMO_VENDORS[0] ? 25 : 35, vendor === DEMO_VENDORS[0] ? 50 : 70) * DAY;
    if (done > end) return;
    const good = vendor === DEMO_VENDORS[0];
    const cost = Math.round(PRICES[kind].rebuild * between(0.9, 1.15));
    const warranty = { hours: good ? 6000 : 4000, months: 12 };
    ev({ componentId: p.c.id, kind: 'returned_rebuild', at: toIso(done), cost, warrantyHours: warranty.hours, warrantyMonths: warranty.months });
    const next: Pooled = { c: p.c, readyAt: done, quality: good ? 1.0 : 0.82, infant: good ? 0.03 : 0.1, warranty, hours: 0, rebuilds: p.rebuilds + 1, cost };
    const key = poolKey(kind, p.c.models[0]!);
    pool.set(key, [...(pool.get(key) ?? []), next]);
  };

  for (const a of input.assets) {
    if (a.assetClass !== 'mobile' || !curves.has(a.id)) continue;
    const t0 = timeAt(a.id, 0)!;
    for (const pos of POSITIONS) at(t0, () => install(a.id, pos.id, t0, 0, true));
  }
  while (jobs.length) jobs.shift()!.run();

  const targets: LifeTarget[] = Object.entries(DEMO_LIFE_TARGETS).flatMap(([model, kinds]) => (Object.entries(kinds) as Array<[ComponentKind, number]>).map(([kind, hours]) => ({
    id: `lt-${model}-${kind}`, model, kind, hours, effectiveFrom: '2015-01-01', reason: 'Demo default (illustrative)', setBy: 'user-admin', setAt: '2015-01-01T00:00:00.000Z',
  })));
  events.sort((x, y) => ms(x.at) - ms(y.at) || (x.id < y.id ? -1 : 1));
  return { components, events, targets };
}
