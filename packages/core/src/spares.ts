// Spares and rebuild pool sizing (phase 3; docs/spares.md, plan 7.2 "Spares",
// plan 4 "Critical spares"). The rebuild pool per model and component kind
// from the component history, PM part uses and kits from the RCM library, and
// the site settings. Pure functions; the numbers use C-16 to C-18.

import type { BurnRate, Component, ComponentEvent, ComponentKind, ComponentState, ForecastRow } from './components.js';
import { COMPONENT_KINDS } from './components.js';
import { poisson, stockForFill } from './calculators.js';
import type { ConsoleContext } from './console.js';
import { can } from './permissions.js';
import type { PartLine, RcmMode, RcmSettings } from './rcm.js';
import { currentModes, isScheduled, packageFor, packageModel } from './rcm.js';
import { ms } from './time.js';
import type { Asset, AuditEntry, Iso } from './types.js';

const DAY = 86_400_000;

// ---------- settings ----------

export type DemandBasis = 'larger' | 'history' | 'forecast';
export const DEMAND_BASIS_LABELS: Record<DemandBasis, string> = { larger: 'The larger of history and forecast', history: 'History (last 365 days)', forecast: 'Forecast (next 365 days)' };

export interface SparesSettings {
  /** Target fill rate: the chance a spare is on the shelf when one is needed. */
  fillTarget: number;
  demandBasis: DemandBasis;
  cycleWindowDays: number;
  minCycles: number;
  defaultCycleDays: number;
  /** Lead time filled into C-16 and C-18 from the PM parts list. */
  leadDays: number;
}

export const DEFAULT_SPARES_SETTINGS: SparesSettings = { fillTarget: 0.95, demandBasis: 'larger', cycleWindowDays: 730, minCycles: 3, defaultCycleDays: 90, leadDays: 30 };

export function withSparesDefaults(v: Partial<SparesSettings> | undefined): SparesSettings {
  const d = DEFAULT_SPARES_SETTINGS;
  const o = (v ?? {}) as Partial<SparesSettings>;
  const n = (x: unknown, dv: number) => (typeof x === 'number' && Number.isFinite(x) ? x : dv);
  return {
    fillTarget: n(o.fillTarget, d.fillTarget),
    demandBasis: o.demandBasis === 'history' || o.demandBasis === 'forecast' || o.demandBasis === 'larger' ? o.demandBasis : d.demandBasis,
    cycleWindowDays: n(o.cycleWindowDays, d.cycleWindowDays), minCycles: n(o.minCycles, d.minCycles),
    defaultCycleDays: n(o.defaultCycleDays, d.defaultCycleDays), leadDays: n(o.leadDays, d.leadDays),
  };
}

type Ok<T> = { ok: true; records: T[]; audit: AuditEntry[]; warnings: string[] };
type No = { ok: false; errors: string[] };

export function setSparesSettings(ctx: ConsoleContext, current: SparesSettings, next: SparesSettings, reason: string): Ok<SparesSettings> | No {
  if (!can(ctx.actor, 'edit_spares')) return { ok: false, errors: ['Your role cannot change spares settings.'] };
  const e: string[] = [];
  const int = (x: number, lo: number, hi: number) => Number.isInteger(x) && x >= lo && x <= hi;
  if (!(next.fillTarget >= 0.5 && next.fillTarget <= 0.999)) e.push('Target fill rate must be from 50% to 99.9%.');
  if (!int(next.cycleWindowDays, 90, 3650)) e.push('Repair cycle window must be from 90 to 3,650 days.');
  if (!int(next.minCycles, 1, 50)) e.push('Fewest repair cycles must be from 1 to 50.');
  if (!int(next.defaultCycleDays, 1, 730)) e.push('Default repair cycle must be from 1 to 730 days.');
  if (!int(next.leadDays, 1, 730)) e.push('Default lead time must be from 1 to 730 days.');
  if (!reason.trim()) e.push('Give a reason for the change.');
  if (e.length) return { ok: false, errors: e };
  const clean = withSparesDefaults({ ...next, fillTarget: Math.round(next.fillTarget * 10000) / 10000 });
  const audit: AuditEntry = { at: ctx.now, userId: ctx.actor.userId, action: 'set_spares_settings', entity: 'settings', entityId: 'spares', before: current, after: clean, reason: reason.trim() };
  return { ok: true, records: [clean], audit: [audit], warnings: [] };
}

// ---------- repair cycles ----------

export interface RepairCycle { componentId: string; kind: ComponentKind; model: string | undefined; removedAt: Iso; returnedAt: Iso; days: number }

/** Removed → Back from rebuild, per component. An install or a scrap in between ends the cycle without counting it. */
export function repairCycles(components: Component[], events: ComponentEvent[], assets: Asset[]): RepairCycle[] {
  const modelOf = new Map(assets.map((a) => [a.id, a.model]));
  const byComp = new Map<string, ComponentEvent[]>();
  for (const e of events) {
    if (e.voidedAt) continue;
    const l = byComp.get(e.componentId);
    if (l) l.push(e); else byComp.set(e.componentId, [e]);
  }
  const out: RepairCycle[] = [];
  for (const c of components) {
    const evs = (byComp.get(c.id) ?? []).sort((a, b) => ms(a.at) - ms(b.at) || ms(a.enteredAt) - ms(b.enteredAt) || (a.id < b.id ? -1 : 1));
    let removed: ComponentEvent | null = null;
    for (const e of evs) {
      if (e.kind === 'removed') removed = e;
      else if (e.kind === 'installed' || e.kind === 'scrapped') removed = null;
      else if (e.kind === 'returned_rebuild' && removed) {
        const model = (removed.unitId && modelOf.get(removed.unitId)) || (c.models.length === 1 ? c.models[0] : undefined);
        out.push({ componentId: c.id, kind: c.kind, model, removedAt: removed.at, returnedAt: e.at, days: (ms(e.at) - ms(removed.at)) / DAY });
        removed = null;
      }
    }
  }
  return out;
}

// ---------- rebuild pool ----------

export type PoolVerdict = 'short' | 'enough' | 'more' | 'none';
export const POOL_VERDICT_LABELS: Record<PoolVerdict, string> = { short: 'Short', enough: 'Enough', more: 'More than needed', none: 'No change-outs' };

export interface PoolRow {
  model: string;
  kind: ComponentKind;
  installed: number;
  inStores: number;
  atRebuild: number;
  pool: number;
  /** Pool components that fit more than one model (counted for each). */
  shared: number;
  history: number;
  forecast: number;
  perYear: number;
  cycleDays: number;
  cycles: number;
  /** The repair cycle was measured, not the default. */
  measured: boolean;
  mean: number;
  needed: number;
  fillNow: number | null;
  fillNeeded: number | null;
  waitNow: number;
  waitNeeded: number;
  verdict: PoolVerdict;
  /** How many short, or how many more than needed. */
  gap: number;
}

export interface PoolInput {
  states: ComponentState[];
  events: ComponentEvent[];
  assets: Asset[];
  forecast: ForecastRow[];
  now: Iso;
  settings: SparesSettings;
}

export function rebuildPoolRows(i: PoolInput): PoolRow[] {
  const s = i.settings;
  const t = ms(i.now);
  const unit = new Map(i.assets.map((a) => [a.id, a]));
  const live = i.states.filter((x) => x.status !== 'void');
  const installedModel = (x: ComponentState) => (x.status === 'installed' && x.unitId ? unit.get(x.unitId)?.model : undefined);
  const models = [...new Set(live.map(installedModel).filter((m): m is string => !!m))].sort();
  const fits = (c: Component, model: string) => c.models.length === 0 || c.models.includes(model);
  const cycles = repairCycles(live.map((x) => x.component), i.events, i.assets).filter((c) => ms(c.returnedAt) <= t && ms(c.returnedAt) > t - s.cycleWindowDays * DAY);
  const compKind = new Map(live.map((x) => [x.component.id, x.component.kind]));
  const removals = i.events.filter((e) => !e.voidedAt && e.kind === 'removed' && e.reason !== 'other' && ms(e.at) <= t && ms(e.at) > t - 365 * DAY);
  const rows: PoolRow[] = [];
  for (const model of models) {
    for (const kind of COMPONENT_KINDS) {
      const installed = live.filter((x) => x.component.kind === kind && installedModel(x) === model).length;
      const spare = live.filter((x) => x.component.kind === kind && (x.status === 'in_store' || x.status === 'at_rebuild') && fits(x.component, model));
      if (!installed && !spare.length) continue;
      const inStores = spare.filter((x) => x.status === 'in_store').length;
      const atRebuild = spare.length - inStores;
      const shared = spare.filter((x) => x.component.models.length !== 1).length;
      const history = removals.filter((e) => compKind.get(e.componentId) === kind && e.unitId && unit.get(e.unitId)?.model === model).length;
      const forecast = i.forecast.filter((f) => f.unit.model === model && f.position.kind === kind && f.due !== null && ms(f.due) <= t + 365 * DAY).length;
      const perYear = s.demandBasis === 'history' ? history : s.demandBasis === 'forecast' ? forecast : Math.max(history, forecast);
      const cs = cycles.filter((c) => c.kind === kind && c.model === model);
      const measured = cs.length >= s.minCycles;
      const cycleDays = measured ? cs.reduce((a, c) => a + c.days, 0) / cs.length : s.defaultCycleDays;
      const pool = spare.length;
      if (perYear === 0) {
        rows.push({ model, kind, installed, inStores, atRebuild, pool, shared, history, forecast, perYear, cycleDays, cycles: cs.length, measured, mean: 0, needed: 0, fillNow: null, fillNeeded: null, waitNow: 0, waitNeeded: 0, verdict: 'none', gap: pool });
        continue;
      }
      const tab = poisson((perYear * cycleDays) / 365);
      const needed = stockForFill(tab, s.fillTarget);
      const verdict: PoolVerdict = pool < needed ? 'short' : pool - needed >= 2 ? 'more' : 'enough';
      rows.push({
        model, kind, installed, inStores, atRebuild, pool, shared, history, forecast, perYear, cycleDays, cycles: cs.length, measured, mean: tab.mean, needed,
        fillNow: tab.fill(pool), fillNeeded: tab.fill(needed), waitNow: tab.ebo(pool) * 365, waitNeeded: tab.ebo(needed) * 365, verdict, gap: Math.abs(pool - needed),
      });
    }
  }
  return rows;
}

// ---------- PM parts and kits from RCM ----------

/** SMU hours a year for the units of a model: each burn rate × 365. Parked units and units with no rate count 0. */
export function fleetHoursPerYear(assets: Asset[], rates: Map<string, BurnRate>, model: string): number {
  return assets.filter((a) => a.model === model).reduce((s, a) => s + (rates.get(a.id)?.perDay ?? 0) * 365, 0);
}

export interface PartDemand { itemNum: string; description: string; perYear: number; models: string[]; tasks: number }

export function pmPartDemand(modes: RcmMode[], assets: Asset[], rates: Map<string, BurnRate>, rcm: RcmSettings): PartDemand[] {
  const models = [...new Set(currentModes(modes).map((m) => m.model))].sort();
  const by = new Map<string, PartDemand>();
  for (const model of models) {
    const hours = fleetHoursPerYear(assets, rates, model);
    for (const m of currentModes(modes, model)) {
      if (!isScheduled(m.taskType) || !m.intervalHours) continue;
      const level = packageFor(m.intervalHours, rcm.packages);
      if (level === null) continue;
      for (const p of m.parts) {
        const key = p.itemNum.trim().toUpperCase();
        if (!key) continue;
        const d = by.get(key) ?? { itemNum: p.itemNum.trim(), description: p.description, perYear: 0, models: [], tasks: 0 };
        d.perYear += (p.qty * hours) / level;
        d.tasks += 1;
        if (!d.models.includes(model)) d.models.push(model);
        if (!d.description && p.description) d.description = p.description;
        by.set(key, d);
      }
    }
  }
  return [...by.values()].sort((a, b) => b.perYear - a.perYear || a.itemNum.localeCompare(b.itemNum));
}

/**
 * The share of PMs at multiples of `level` that are done as this level's PM.
 * Nested: at hour x the PM is the largest level dividing x among the levels that are multiples of
 * this one, so a larger such level takes those PMs over. Not nested: every one.
 */
export function kitShare(level: number, levels: number[], nested: boolean): number {
  if (!nested) return 1;
  const bigger = levels.filter((m) => m > level && m % level === 0);
  if (!bigger.length) return 1;
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  const cycle = bigger.reduce((l, m) => (l / gcd(l, m)) * m, level);
  const n = cycle / level;
  if (n > 1_000_000) return 1;
  let own = 0;
  for (let k = 1; k <= n; k++) if (!bigger.some((m) => (k * level) % m === 0)) own++;
  return own / n;
}

export interface PmKit { jpnum: string; model: string; hours: number; perYear: number; share: number; parts: PartLine[] }

export function pmKits(modes: RcmMode[], assets: Asset[], rates: Map<string, BurnRate>, rcm: RcmSettings): PmKit[] {
  const models = [...new Set(currentModes(modes).map((m) => m.model))].sort();
  const out: PmKit[] = [];
  for (const model of models) {
    const hours = fleetHoursPerYear(assets, rates, model);
    const plans = packageModel(modes, model, rcm).plans;
    const levels = plans.map((p) => p.hours);
    for (const p of plans) {
      const parts = new Map<string, PartLine>();
      for (const t of p.tasks) for (const x of t.parts) {
        const key = x.itemNum.trim().toUpperCase();
        if (!key) continue;
        const was = parts.get(key);
        parts.set(key, was ? { ...was, qty: was.qty + x.qty, description: was.description || x.description } : { itemNum: x.itemNum.trim(), description: x.description, qty: x.qty });
      }
      if (!parts.size) continue;
      const share = kitShare(p.hours, levels, rcm.nested);
      out.push({ jpnum: p.jpnum, model, hours: p.hours, perYear: (hours * share) / p.hours, share, parts: [...parts.values()].sort((a, b) => a.itemNum.localeCompare(b.itemNum)) });
    }
  }
  return out;
}
