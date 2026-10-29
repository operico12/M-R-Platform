// Fixed plant (phase 3b, docs/fixed-plant.md; plan 4.3; A7 section 11).
//
// Plant-only logic lives here so mobile and plant stay one codebase (plan 4.3
// rule). Plant equipment uses the same down flags, KPI engine, roles and audit
// as the trucks. What this module adds: the plant structure from functional
// locations, k-of-n roll-up to circuit and plant, process delays (their own
// records, never down flags), throughput lost, historian run and stop signals
// from a file, run hours in place of SMU, and stop detection.

import { DateTime } from 'luxon';
import type { FlagRulesConfig } from './config.js';
import type { ConsoleContext, ConsoleResult } from './console.js';
import { confirmProposal, proposeDown, rejectProposal, type CommandResult, type FlagContext } from './flags.js';
import { parseCsv } from './imports.js';
import { buildEvents, countingFlags, downIntervals, type Period } from './kpis.js';
import { can } from './permissions.js';
import { HOUR_MS, ms } from './time.js';
import type { Asset, AssetClass, AuditEntry, DownFlag, Iso, SmuReading } from './types.js';

// ---------- words on screen ----------

export interface Words {
  unit: string;
  units: string;
  fleet: string;
  meter: string;
  workLocation: string;
}

const WORDS: Record<AssetClass, Words> = {
  mobile: { unit: 'Unit', units: 'Units', fleet: 'Fleet', meter: 'SMU', workLocation: 'Shop line' },
  fixed_plant: { unit: 'Equipment', units: 'Equipment', fleet: 'Circuit', meter: 'Run hours', workLocation: 'Work location' },
};

/** Plan 4.3: each asset's class sets the words used on screen. */
export function wordsFor(c: AssetClass): Words {
  return WORDS[c];
}

// ---------- structure ----------

export type PlantNodeKind = 'plant' | 'area' | 'circuit' | 'group';

export const NODE_KIND_LABELS: Record<PlantNodeKind, string> = { plant: 'Plant', area: 'Area', circuit: 'Circuit', group: 'Redundancy group' };

export interface PlantNode {
  id: string;
  tenantId: string;
  siteId: string;
  kind: PlantNodeKind;
  name: string;
  parentId?: string;
  /** Place in process order among its siblings. */
  order: number;
  /** Children that must be available for this node to be available. Empty means all (series). */
  needed?: number;
  /** Maximo location or SAP functional location. Equipment under it belongs here. */
  functionalLocation?: string;
  /** Planned rate in tonnes an hour, for throughput lost. */
  plannedRateTph?: number;
  retiredAt?: Iso;
  retireReason?: string;
}

export function flSegments(fl: string | undefined): string[] {
  return (fl ?? '').toUpperCase().split(/[-./]/).map((s) => s.trim()).filter(Boolean);
}

const isPrefix = (a: string[], b: string[]) => a.length > 0 && a.length <= b.length && a.every((x, i) => x === b[i]);

export interface TreeNode {
  node: PlantNode;
  nodes: TreeNode[];
  equipment: Asset[];
  installed: number;
  needed: number;
}

export interface PlantTree {
  roots: TreeNode[];
  byId: Map<string, TreeNode>;
  /** Parent node of each node id and equipment id. */
  parentOf: Map<string, string>;
  /** Fixed plant equipment whose functional location matches no node. */
  unplaced: Asset[];
}

/**
 * Builds the structure. Equipment belongs to the active node whose functional
 * location is the longest segment prefix of its own. Retired nodes are left out;
 * a node under a retired node becomes a root.
 */
export function plantTree(nodes: PlantNode[], equipment: Asset[]): PlantTree {
  const active = nodes.filter((n) => !n.retiredAt);
  const byId = new Map<string, TreeNode>();
  for (const n of active) byId.set(n.id, { node: n, nodes: [], equipment: [], installed: 0, needed: 0 });
  const parentOf = new Map<string, string>();
  const roots: TreeNode[] = [];
  for (const t of byId.values()) {
    const p = t.node.parentId ? byId.get(t.node.parentId) : undefined;
    if (p && p !== t) {
      p.nodes.push(t);
      parentOf.set(t.node.id, p.node.id);
    } else roots.push(t);
  }
  const withFl = active.map((n) => ({ n, segs: flSegments(n.functionalLocation) })).filter((x) => x.segs.length);
  const unplaced: Asset[] = [];
  for (const a of equipment) {
    if (a.assetClass !== 'fixed_plant') continue;
    const segs = flSegments(a.functionalLocation);
    let best: { n: PlantNode; len: number } | undefined;
    for (const x of withFl) if (isPrefix(x.segs, segs) && (!best || x.segs.length > best.len)) best = { n: x.n, len: x.segs.length };
    if (!best) {
      unplaced.push(a);
      continue;
    }
    byId.get(best.n.id)!.equipment.push(a);
    parentOf.set(a.id, best.n.id);
  }
  const order = (a: TreeNode, b: TreeNode) => a.node.order - b.node.order || a.node.name.localeCompare(b.node.name);
  const fin = (t: TreeNode) => {
    t.nodes.sort(order);
    t.equipment.sort((a, b) => a.unitNumber.localeCompare(b.unitNumber));
    t.installed = t.nodes.length + t.equipment.length;
    const k = t.node.needed ?? t.installed;
    t.needed = Math.max(Math.min(k, t.installed), t.installed ? 1 : 0);
    t.nodes.forEach(fin);
  };
  roots.sort(order).forEach(fin);
  return { roots, byId, parentOf, unplaced };
}

/** Node ids from the equipment's (or node's) parent up to the root. */
export function ancestors(tree: PlantTree, id: string): string[] {
  const out: string[] = [];
  let cur = tree.parentOf.get(id);
  while (cur && !out.includes(cur)) {
    out.push(cur);
    cur = tree.parentOf.get(cur);
  }
  return out;
}

/** Every equipment id at or below a node. */
export function equipmentUnder(tree: PlantTree, nodeId: string): string[] {
  const t = tree.byId.get(nodeId);
  if (!t) return [];
  return [...t.equipment.map((a) => a.id), ...t.nodes.flatMap((c) => equipmentUnder(tree, c.node.id))];
}

/** The nearest circuit above an equipment, else its parent. */
export function circuitOf(tree: PlantTree, assetId: string): string | undefined {
  const up = ancestors(tree, assetId);
  return up.find((id) => tree.byId.get(id)?.node.kind === 'circuit') ?? up[0];
}

/** The plant (root) above a node or equipment: its name is the scope area for flags and delays. */
export function plantOf(tree: PlantTree, id: string): TreeNode | undefined {
  const up = tree.byId.has(id) ? [id, ...ancestors(tree, id)] : ancestors(tree, id);
  const top = up.at(-1);
  return top ? tree.byId.get(top) : undefined;
}

// ---------- process delays ----------

export type DelayCategory = 'process' | 'external';

export interface DelayCode {
  code: string;
  category: DelayCategory;
  retired?: boolean;
}

export const STARTER_DELAY_CODES: DelayCode[] = [
  { code: 'No feed', category: 'process' },
  { code: 'Bins or stockpile full', category: 'process' },
  { code: 'Upstream stop', category: 'process' },
  { code: 'Downstream stop', category: 'process' },
  { code: 'Ore change or hardness', category: 'process' },
  { code: 'Water or reagent shortage', category: 'process' },
  { code: 'Operator or control', category: 'process' },
  { code: 'Power supply', category: 'external' },
  { code: 'Weather', category: 'external' },
];

/** A7 section 11: process delays are their own records, not down flags, and never reduce maintenance availability. */
export interface ProcessDelay {
  id: string;
  tenantId: string;
  siteId: string;
  /** The node it stopped (usually a circuit). */
  nodeId: string;
  /** The equipment that showed the stop, when there was one. */
  assetId?: string;
  code: string;
  start: Iso;
  end: Iso | null;
  /** Historian proposals classified into this delay. */
  fromFlagIds?: string[];
  notes?: string;
  setBy: string;
  enteredAt: Iso;
  voidedAt?: Iso;
  voidedBy?: string;
  voidReason?: string;
}

// ---------- settings ----------

export interface PlantSettings {
  /** Historian stops shorter than this are ignored (chatter). */
  minStopMinutes: number;
  /** A gap up to this long while a group changes duty still counts as covered. */
  changeoverMinutes: number;
  /** Propose or skip stops of a group member while the group still had enough running. */
  coveredStops: 'propose' | 'skip';
  delayCodes: DelayCode[];
  /** Default scope freeze for a new shutdown, in days before its planned start. */
  scopeFreezeDays: number;
}

export const DEFAULT_PLANT_SETTINGS: PlantSettings = { minStopMinutes: 1, changeoverMinutes: 5, coveredStops: 'propose', delayCodes: STARTER_DELAY_CODES, scopeFreezeDays: 7 };

export function withPlantDefaults(v: Partial<PlantSettings> | undefined): PlantSettings {
  const d = DEFAULT_PLANT_SETTINGS;
  const o = (v ?? {}) as Partial<PlantSettings>;
  const n = (x: unknown, dv: number) => (typeof x === 'number' && Number.isFinite(x) ? x : dv);
  const codes = Array.isArray(o.delayCodes)
    ? o.delayCodes.filter((c): c is DelayCode => !!c && typeof c.code === 'string' && (c.category === 'process' || c.category === 'external'))
    : d.delayCodes;
  return {
    minStopMinutes: n(o.minStopMinutes, d.minStopMinutes),
    changeoverMinutes: n(o.changeoverMinutes, d.changeoverMinutes),
    coveredStops: o.coveredStops === 'skip' || o.coveredStops === 'propose' ? o.coveredStops : d.coveredStops,
    delayCodes: codes.length ? codes : d.delayCodes,
    scopeFreezeDays: n(o.scopeFreezeDays, d.scopeFreezeDays),
  };
}

const refuse = <T>(...errors: string[]): ConsoleResult<T> => ({ ok: false, errors });

export function setPlantSettings(ctx: ConsoleContext, current: PlantSettings, next: PlantSettings, reason: string): ConsoleResult<PlantSettings> {
  if (!can(ctx.actor, 'edit_plant_settings')) return refuse('Your role cannot change plant settings.');
  const e: string[] = [];
  const num = (x: number, lo: number, hi: number) => Number.isFinite(x) && x >= lo && x <= hi;
  if (!num(next.minStopMinutes, 0, 60)) e.push('Shortest stop must be from 0 to 60 minutes.');
  if (!num(next.changeoverMinutes, 0, 60)) e.push('Changeover gap must be from 0 to 60 minutes.');
  if (!num(next.scopeFreezeDays, 0, 90) || !Number.isInteger(next.scopeFreezeDays)) e.push('Scope freeze must be a whole number of days from 0 to 90.');
  const names = next.delayCodes.map((c) => c.code.trim().toLowerCase());
  if (names.some((c) => !c)) e.push('A delay code needs a name.');
  if (new Set(names).size !== names.length) e.push('Delay codes must be different.');
  // Codes are retired, never removed, so old delays keep their code (docs/fixed-plant.md).
  for (const c of current.delayCodes) if (!names.includes(c.code.trim().toLowerCase())) e.push(`${c.code} cannot be removed. Retire it instead.`);
  if (!next.delayCodes.some((c) => !c.retired)) e.push('Keep at least one delay code in use.');
  if (!reason.trim()) e.push('Give a reason for the change.');
  if (e.length) return { ok: false, errors: e };
  const clean = withPlantDefaults({ ...next, delayCodes: next.delayCodes.map((c) => ({ code: c.code.trim(), category: c.category, ...(c.retired ? { retired: true } : {}) })) });
  const audit: AuditEntry = { at: ctx.now, userId: ctx.actor.userId, action: 'set_plant_settings', entity: 'settings', entityId: 'plant', before: current, after: clean, reason: reason.trim() };
  return { ok: true, records: [clean], audit: [audit], warnings: [] };
}

// ---------- process delay commands ----------

/** Scope area for the permission check: the plant's name, so a truck shop supervisor cannot record plant delays (plan 11.3). */
export interface DelayContext extends ConsoleContext {
  area: string;
}

export interface DelayInput {
  tenantId: string;
  siteId: string;
  nodeId: string;
  assetId?: string;
  code: string;
  start: Iso;
  end?: Iso | null;
  notes?: string;
  fromFlagIds?: string[];
}

function delayAudit(ctx: ConsoleContext, action: string, before: ProcessDelay | null, after: ProcessDelay, reason?: string): AuditEntry {
  return { at: ctx.now, userId: ctx.actor.userId, action, entity: 'process_delay', entityId: after.id, before, after, reason, effectiveAt: action === 'record_delay' && after.start !== ctx.now ? after.start : undefined };
}

const overlaps = (aS: number, aE: number, bS: number, bE: number) => aS < bE && bS < aE;
const endMs = (e: Iso | null | undefined) => (e ? ms(e) : Infinity);

export function recordDelay(ctx: DelayContext, delays: ProcessDelay[], codes: DelayCode[], input: DelayInput): ConsoleResult<ProcessDelay> {
  if (!can(ctx.actor, 'set_clear_flag', ctx.area)) return refuse('You cannot record process delays here.');
  const e: string[] = [];
  const code = codes.find((c) => c.code === input.code);
  if (!code) e.push('Choose a delay code.');
  else if (code.retired) e.push(`${code.code} is retired.`);
  if (!input.nodeId) e.push('Choose where the delay was.');
  if (ms(input.start) > ms(ctx.now)) e.push('Start cannot be in the future.');
  const end = input.end ?? null;
  if (end && ms(end) <= ms(input.start)) e.push('End must be after start.');
  if (end && ms(end) > ms(ctx.now)) e.push('End cannot be in the future.');
  const clash = delays.find((d) => !d.voidedAt && d.nodeId === input.nodeId && (d.assetId ?? '') === (input.assetId ?? '') && overlaps(ms(d.start), endMs(d.end), ms(input.start), endMs(end)));
  if (clash) e.push(`This overlaps another delay here starting ${clash.start}.`);
  if (e.length) return { ok: false, errors: e };
  const d: ProcessDelay = {
    id: ctx.newId(), tenantId: input.tenantId, siteId: input.siteId, nodeId: input.nodeId, assetId: input.assetId || undefined,
    code: input.code, start: input.start, end, fromFlagIds: input.fromFlagIds?.length ? input.fromFlagIds : undefined,
    notes: input.notes?.trim() || undefined, setBy: ctx.actor.userId, enteredAt: ctx.now,
  };
  return { ok: true, records: [d], audit: [delayAudit(ctx, 'record_delay', null, d)], warnings: [] };
}

export function endDelay(ctx: DelayContext, d: ProcessDelay, end: Iso): ConsoleResult<ProcessDelay> {
  if (!can(ctx.actor, 'set_clear_flag', ctx.area)) return refuse('You cannot end process delays here.');
  if (d.voidedAt) return refuse('This delay is voided.');
  if (d.end) return refuse('This delay has already ended.');
  if (ms(end) <= ms(d.start)) return refuse('End must be after start.');
  if (ms(end) > ms(ctx.now)) return refuse('End cannot be in the future.');
  const after = { ...d, end };
  return { ok: true, records: [after], audit: [delayAudit(ctx, 'end_delay', d, after)], warnings: [] };
}

export function voidDelay(ctx: DelayContext, d: ProcessDelay, reason: string): ConsoleResult<ProcessDelay> {
  if (!can(ctx.actor, 'void_flag', ctx.area)) return refuse('You cannot void process delays here.');
  if (d.voidedAt) return refuse('This delay is already voided.');
  if (!reason.trim()) return refuse('Give a reason.');
  const after = { ...d, voidedAt: ctx.now, voidedBy: ctx.actor.userId, voidReason: reason.trim() };
  return { ok: true, records: [after], audit: [delayAudit(ctx, 'void_delay', d, after, reason.trim())], warnings: [] };
}

// ---------- historian signals ----------

export interface RunSignal {
  assetId: string;
  at: Iso;
  running: boolean;
}

type Iv = { s: number; e: number };

function signalsBy(signals: RunSignal[]): Map<string, RunSignal[]> {
  const m = new Map<string, RunSignal[]>();
  for (const s of signals) {
    const l = m.get(s.assetId);
    if (l) l.push(s);
    else m.set(s.assetId, [s]);
  }
  for (const l of m.values()) l.sort((a, b) => ms(a.at) - ms(b.at));
  return m;
}

/** Running intervals from a sorted signal list, up to `until`. */
function runIvs(sorted: RunSignal[], until: number): Iv[] {
  const out: Iv[] = [];
  let since: number | null = null;
  for (const s of sorted) {
    const t = ms(s.at);
    if (t > until) break;
    if (s.running && since === null) since = t;
    if (!s.running && since !== null) {
      if (t > since) out.push({ s: since, e: t });
      since = null;
    }
  }
  if (since !== null && until > since) out.push({ s: since, e: until });
  return out;
}

/**
 * Run hours as meter readings (A7 section 11: run hours replace SMU). One
 * reading at each signal and one at `now`, so the tier 1 KPI engine works unchanged.
 */
export function runReadings(signals: RunSignal[], now: Iso): SmuReading[] {
  const out: SmuReading[] = [];
  const nowMs = ms(now);
  for (const [assetId, list] of signalsBy(signals)) {
    let hours = 0;
    let since: number | null = null;
    let last = -Infinity;
    for (const s of list) {
      const t = ms(s.at);
      if (t > nowMs || t === last) continue;
      if (since !== null) hours += (t - since) / HOUR_MS;
      since = s.running ? t : null;
      out.push({ unitId: assetId, at: s.at, hours });
      last = t;
    }
    if (last < nowMs && last > -Infinity) out.push({ unitId: assetId, at: now, hours: since !== null ? hours + (nowMs - since) / HOUR_MS : hours });
  }
  return out;
}

/** The first running signal after `at`, or null while it is still stopped. */
export function resumeAfter(signals: RunSignal[], assetId: string, at: Iso): Iso | null {
  let best: number | null = null;
  for (const s of signals) if (s.assetId === assetId && s.running && ms(s.at) > ms(at) && (best === null || ms(s.at) < best)) best = ms(s.at);
  return best === null ? null : new Date(best).toISOString();
}

export interface HistorianIssue {
  row: number;
  message: string;
}

const RUN_WORDS = new Set(['1', 'RUN', 'RUNNING', 'ON', 'TRUE']);
const STOP_WORDS = new Set(['0', 'STOP', 'STOPPED', 'OFF', 'FALSE']);

/**
 * A historian export, one row per state change (docs/fixed-plant.md). Local
 * times are read in the site time zone, never the browser's (CLAUDE.md rule 7).
 */
export function parseHistorianCsv(
  text: string,
  equipment: Asset[],
  timeZone: string,
  existing: RunSignal[],
  now: Iso,
): { signals: RunSignal[]; issues: HistorianIssue[]; stats: { rows: number; added: number; skipped: number } } {
  const t = parseCsv(text);
  const h = t.header.map((x) => x.toLowerCase());
  const col = (...names: string[]) => h.findIndex((x) => names.includes(x));
  const iTag = col('tag', 'tagname', 'name', 'equipment');
  const iTime = col('timestamp', 'time', 'datetime', 'date');
  const iVal = col('value', 'state', 'status');
  const issues: HistorianIssue[] = [];
  if (iTag < 0 || iTime < 0 || iVal < 0) {
    return { signals: [], issues: [{ row: 1, message: 'The file needs tag, timestamp and value columns.' }], stats: { rows: t.rows.length, added: 0, skipped: t.rows.length } };
  }
  const lookup = new Map<string, string>();
  for (const a of equipment) {
    if (a.assetClass !== 'fixed_plant') continue;
    for (const k of [a.unitNumber, a.externalAssetId, a.functionalLocation]) if (k) lookup.set(k.trim().toUpperCase(), a.id);
  }
  const seen = new Set(existing.map((s) => `${s.assetId}|${ms(s.at)}`));
  const signals: RunSignal[] = [];
  t.rows.forEach((r, i) => {
    const row = i + 2;
    const rawTag = (r[iTag] ?? '').trim().toUpperCase();
    const assetId = lookup.get(rawTag) ?? lookup.get(rawTag.replace(/(\.RUN|\.STS|_RUN)$/, ''));
    if (!assetId) return issues.push({ row, message: `Tag ${r[iTag] ?? ''} matches no plant equipment.` });
    const raw = (r[iTime] ?? '').trim();
    const hasZone = /([zZ]|[+-]\d\d:?\d\d)$/.test(raw);
    let dt = hasZone ? DateTime.fromISO(raw, { setZone: true }) : DateTime.invalid('none');
    if (!hasZone) {
      for (const f of ['yyyy-MM-dd HH:mm:ss', 'yyyy-MM-dd HH:mm', "yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd'T'HH:mm"]) {
        dt = DateTime.fromFormat(raw, f, { zone: timeZone });
        if (dt.isValid) break;
      }
    }
    if (!dt.isValid) return issues.push({ row, message: `Bad time: ${raw}` });
    const at = dt.toUTC().toISO()!;
    if (ms(at) > ms(now)) return issues.push({ row, message: `Time is in the future: ${raw}` });
    const v = (r[iVal] ?? '').trim().toUpperCase();
    const running = RUN_WORDS.has(v) ? true : STOP_WORDS.has(v) ? false : null;
    if (running === null) return issues.push({ row, message: `Value ${r[iVal] ?? ''} is not running or stopped.` });
    const key = `${assetId}|${ms(at)}`;
    if (seen.has(key)) return issues.push({ row, message: 'Repeats a time already loaded for this equipment.' });
    seen.add(key);
    signals.push({ assetId, at, running });
  });
  return { signals, issues, stats: { rows: t.rows.length, added: signals.length, skipped: t.rows.length - signals.length } };
}

// ---------- timelines and roll-up ----------

export type PlantState = 'run' | 'idle' | 'delay' | 'down';

export const PLANT_STATE_LABELS: Record<PlantState, string> = { run: 'Running', idle: 'Available', delay: 'Process delay', down: 'Down' };

/** A stretch of time in one state. Causes are "m:<system>" for maintenance and "d:<code>" for delays. */
export interface Seg {
  from: number;
  to: number;
  state: PlantState;
  causes: string[];
}

export interface PlantInput {
  nodes: PlantNode[];
  equipment: Asset[];
  flags: DownFlag[];
  delays: ProcessDelay[];
  signals: RunSignal[];
  now: Iso;
}

const flagCause = (f: DownFlag) => `m:${f.release?.system ?? f.system ?? f.reasonCode}`;

function push(out: Seg[], s: Seg) {
  const last = out[out.length - 1];
  if (last && last.state === s.state && last.to === s.from && last.causes.join('|') === s.causes.join('|')) last.to = s.to;
  else out.push(s);
}

interface Prepared {
  input: PlantInput;
  tree: PlantTree;
  sig: Map<string, RunSignal[]>;
  flagsBy: Map<string, DownFlag[]>;
  delaysByAsset: Map<string, ProcessDelay[]>;
  delaysByNode: Map<string, ProcessDelay[]>;
}

function prepare(input: PlantInput, tree?: PlantTree): Prepared {
  const flagsBy = new Map<string, DownFlag[]>();
  for (const f of countingFlags(input.flags)) {
    const l = flagsBy.get(f.unitId);
    if (l) l.push(f);
    else flagsBy.set(f.unitId, [f]);
  }
  const delaysByAsset = new Map<string, ProcessDelay[]>();
  const delaysByNode = new Map<string, ProcessDelay[]>();
  for (const d of input.delays) {
    if (d.voidedAt) continue;
    const [m, k] = d.assetId ? [delaysByAsset, d.assetId] : [delaysByNode, d.nodeId];
    const l = m.get(k);
    if (l) l.push(d);
    else m.set(k, [d]);
  }
  return { input, tree: tree ?? plantTree(input.nodes, input.equipment), sig: signalsBy(input.signals), flagsBy, delaysByAsset, delaysByNode };
}

type Tagged = Iv & { kind: 'down' | 'delay' | 'run'; cause?: string };

function clip(list: Tagged[], from: number, to: number): Tagged[] {
  return list.filter((x) => x.e > from && x.s < to).map((x) => ({ ...x, s: Math.max(x.s, from), e: Math.min(x.e, to) }));
}

/** Elementary segments from tagged intervals: down beats delay beats run; nothing is idle. */
function sweep(ivs: Tagged[], from: number, to: number): Seg[] {
  const b = new Set<number>([from, to]);
  for (const x of ivs) {
    b.add(x.s);
    b.add(x.e);
  }
  const pts = [...b].sort((x, y) => x - y);
  const sorted = [...ivs].sort((x, y) => x.s - y.s);
  let i = 0;
  let active: Tagged[] = [];
  const out: Seg[] = [];
  for (let j = 0; j + 1 < pts.length; j++) {
    const a = pts[j]!;
    const z = pts[j + 1]!;
    while (i < sorted.length && sorted[i]!.s <= a) active.push(sorted[i++]!);
    active = active.filter((x) => x.e > a);
    const down = active.filter((x) => x.kind === 'down');
    const delay = active.filter((x) => x.kind === 'delay');
    const state: PlantState = down.length ? 'down' : delay.length ? 'delay' : active.some((x) => x.kind === 'run') ? 'run' : 'idle';
    const causes = [...new Set((state === 'down' ? down : state === 'delay' ? delay : []).map((x) => x.cause!))].sort();
    push(out, { from: a, to: z, state, causes });
  }
  return out;
}

function equipmentSegs(p: Prepared, assetId: string, from: number, to: number): Seg[] {
  const nowMs = ms(p.input.now);
  const ivs: Tagged[] = [];
  for (const f of p.flagsBy.get(assetId) ?? []) for (const iv of downIntervals(f, p.input.now)) ivs.push({ s: ms(iv.start), e: ms(iv.end), kind: 'down', cause: flagCause(f) });
  for (const d of p.delaysByAsset.get(assetId) ?? []) ivs.push({ s: ms(d.start), e: Math.min(endMs(d.end), nowMs), kind: 'delay', cause: `d:${d.code}` });
  for (const iv of runIvs(p.sig.get(assetId) ?? [], nowMs)) ivs.push({ ...iv, kind: 'run' });
  return sweep(clip(ivs, from, to), from, to);
}

function nodeSegs(p: Prepared, t: TreeNode, from: number, to: number, memo: Map<string, Seg[]>): Seg[] {
  const hit = memo.get(t.node.id);
  if (hit) return hit;
  const kids: Seg[][] = [
    ...t.nodes.map((c) => nodeSegs(p, c, from, to, memo)),
    ...t.equipment.map((a) => {
      const s = equipmentSegs(p, a.id, from, to);
      memo.set(a.id, s);
      return s;
    }),
  ];
  const nowMs = ms(p.input.now);
  const own = clip((p.delaysByNode.get(t.node.id) ?? []).map((d) => ({ s: ms(d.start), e: Math.min(endMs(d.end), nowMs), kind: 'delay' as const, cause: `d:${d.code}` })), from, to);
  const b = new Set<number>([from, to]);
  for (const k of kids) for (const s of k) b.add(s.from);
  for (const x of own) {
    b.add(x.s);
    b.add(x.e);
  }
  const pts = [...b].filter((x) => x >= from && x <= to).sort((x, y) => x - y);
  const ptr = kids.map(() => 0);
  const out: Seg[] = [];
  const k = t.needed;
  for (let j = 0; j + 1 < pts.length; j++) {
    const a = pts[j]!;
    const z = pts[j + 1]!;
    const states: Seg[] = [];
    kids.forEach((segs, i) => {
      while (ptr[i]! < segs.length - 1 && segs[ptr[i]!]!.to <= a) ptr[i]!++;
      states.push(segs[ptr[i]!]!);
    });
    const n = (st: PlantState) => states.filter((s) => s.state === st).length;
    const run = n('run');
    const idle = n('idle');
    const delay = n('delay');
    let state: PlantState = t.installed === 0 ? 'idle' : run >= k ? 'run' : run + idle >= k ? 'idle' : run + idle + delay >= k ? 'delay' : 'down';
    let causes = state === 'down' || state === 'delay' ? states.filter((s) => s.state === state).flatMap((s) => s.causes) : [];
    const ownNow = own.filter((x) => x.s <= a && x.e > a);
    if (state === 'idle' && ownNow.length) {
      state = 'delay';
      causes = ownNow.map((x) => x.cause!);
    }
    push(out, { from: a, to: z, state, causes: [...new Set(causes)].sort() });
  }
  memo.set(t.node.id, out);
  return out;
}

export interface LostRow {
  cause: string;
  kind: 'maintenance' | 'process';
  hours: number;
  /** Null when the node has no planned rate. */
  tonnes: number | null;
}

export interface PlantSummary {
  calendarHours: number;
  downHours: number;
  delayHours: number;
  runHours: number;
  /** KPI-033 / KPI-034. */
  availability: number | null;
  /** KPI-035: run h ÷ available h; null without historian signals for every equipment below. */
  utilisation: number | null;
  /** KPI-037, by cause, largest first. */
  lost: LostRow[];
  lostHours: { maintenance: number; process: number };
  lostTonnes: { maintenance: number; process: number } | null;
  rateTph?: number;
}

function summarise(segs: Seg[], rate: number | undefined, hasRun: boolean): PlantSummary {
  let cal = 0;
  let down = 0;
  let delay = 0;
  let run = 0;
  const lost = new Map<string, LostRow>();
  for (const s of segs) {
    const h = (s.to - s.from) / HOUR_MS;
    cal += h;
    if (s.state === 'down') down += h;
    if (s.state === 'delay') delay += h;
    if (s.state === 'run') run += h;
    if ((s.state === 'down' || s.state === 'delay') && h > 0) {
      const causes = s.causes.length ? s.causes : [s.state === 'down' ? 'm:Unknown' : 'd:Unknown'];
      for (const c of causes) {
        const row = lost.get(c) ?? { cause: c.slice(2), kind: c.startsWith('m:') ? 'maintenance' : 'process', hours: 0, tonnes: null };
        row.hours += h / causes.length;
        lost.set(c, row);
      }
    }
  }
  const rows = [...lost.values()].map((r) => ({ ...r, tonnes: rate ? r.hours * rate : null })).sort((a, b) => b.hours - a.hours || a.cause.localeCompare(b.cause));
  const avail = cal - down;
  return {
    calendarHours: cal,
    downHours: down,
    delayHours: delay,
    runHours: run,
    availability: cal > 0 ? avail / cal : null,
    utilisation: hasRun && avail > 0 ? run / avail : null,
    lost: rows,
    lostHours: { maintenance: down, process: delay },
    lostTonnes: rate ? { maintenance: down * rate, process: delay * rate } : null,
    rateTph: rate,
  };
}

export interface PlantReport {
  tree: PlantTree;
  /** By node id and by equipment id. */
  summary: Map<string, PlantSummary>;
  segs: Map<string, Seg[]>;
}

/** Availability, utilisation, process delay and throughput lost for every node and equipment over a period. */
export function plantReport(input: PlantInput, p: Period, tree?: PlantTree): PlantReport {
  const pr = prepare(input, tree);
  const from = ms(p.from);
  const to = Math.min(ms(p.to), ms(input.now));
  const memo = new Map<string, Seg[]>();
  const summary = new Map<string, PlantSummary>();
  if (to <= from) return { tree: pr.tree, summary, segs: memo };
  const hasRunFor = new Map<string, boolean>();
  const hasRun = (t: TreeNode): boolean => {
    const v = t.installed > 0 && t.nodes.every(hasRun) && t.equipment.every((a) => (pr.sig.get(a.id)?.length ?? 0) > 0 && ms(pr.sig.get(a.id)![0]!.at) < to);
    hasRunFor.set(t.node.id, v);
    return v;
  };
  for (const r of pr.tree.roots) {
    nodeSegs(pr, r, from, to, memo);
    hasRun(r);
  }
  for (const t of pr.tree.byId.values()) {
    const segs = memo.get(t.node.id);
    if (!segs) continue;
    summary.set(t.node.id, summarise(segs, t.node.plannedRateTph, hasRunFor.get(t.node.id) ?? false));
    for (const a of t.equipment) {
      const s = memo.get(a.id)!;
      const sig = pr.sig.get(a.id);
      summary.set(a.id, summarise(s, undefined, !!sig?.length && ms(sig[0]!.at) < to));
    }
  }
  return { tree: pr.tree, summary, segs: memo };
}

/** State now of every node and equipment. */
export function plantNow(input: PlantInput, tree?: PlantTree): Map<string, { state: PlantState; causes: string[] }> {
  const now = ms(input.now);
  const r = plantReport(input, { from: new Date(now - 60_000).toISOString(), to: input.now }, tree);
  const out = new Map<string, { state: PlantState; causes: string[] }>();
  for (const [id, segs] of r.segs) {
    const last = segs[segs.length - 1];
    if (last) out.set(id, { state: last.state, causes: last.causes });
  }
  return out;
}

/** KPI-036: unscheduled down events that start in the period, per 168 h. */
export function tripsPerWeek(flags: DownFlag[], assetIds: string[], rules: FlagRulesConfig, p: Period, now: Iso): { trips: number; perWeek: number } {
  const ids = new Set(assetIds);
  const trips = buildEvents(flags.filter((f) => ids.has(f.unitId)), rules, now).filter((e) => e.startType === 'unscheduled' && ms(e.start) >= ms(p.from) && ms(e.start) < ms(p.to)).length;
  const weeks = (Math.min(ms(p.to), ms(now)) - ms(p.from)) / (168 * HOUR_MS);
  return { trips, perWeek: weeks > 0 ? trips / weeks : 0 };
}

/** R14 for plant: the historian shows the equipment running inside a down flag for longer than the threshold. */
export function runningWhileDown(input: PlantInput, thresholdHours: number, since?: Iso): Array<{ assetId: string; flagId: string; hours: number; message: string }> {
  const pr = prepare(input);
  const name = new Map(input.equipment.map((a) => [a.id, a.unitNumber]));
  const out: Array<{ assetId: string; flagId: string; hours: number; message: string }> = [];
  for (const [assetId, flags] of pr.flagsBy) {
    const run = runIvs(pr.sig.get(assetId) ?? [], ms(input.now));
    if (!run.length) continue;
    for (const f of flags) {
      if (since && f.end && ms(f.end) < ms(since)) continue;
      let h = 0;
      for (const iv of downIntervals(f, input.now)) for (const r of run) h += Math.max(0, Math.min(r.e, ms(iv.end)) - Math.max(r.s, ms(iv.start))) / HOUR_MS;
      if (h > thresholdHours) out.push({ assetId, flagId: f.id, hours: h, message: `${name.get(assetId) ?? assetId} ran ${h.toFixed(1)} h while flagged down. The flag is probably wrong (R14).` });
    }
  }
  return out;
}

// ---------- stop detection ----------

export interface DetectedStop {
  assetId: string;
  start: Iso;
  /** Null while it is still stopped. */
  end: Iso | null;
  /** The equipment's redundancy group still had enough running through the stop (duty and standby changeover). */
  covered: boolean;
}

/** Minutes after a stop within which a flag or delay still accounts for it. */
export const ACCOUNT_MINUTES = 15;

/** Stops from the historian that nobody has accounted for yet (docs/fixed-plant.md, stop detection). */
export function detectStops(input: PlantInput, settings: PlantSettings, opts: { since?: Iso; tree?: PlantTree } = {}): DetectedStop[] {
  const tree = opts.tree ?? plantTree(input.nodes, input.equipment);
  const sig = signalsBy(input.signals);
  const nowMs = ms(input.now);
  const since = opts.since ? ms(opts.since) : -Infinity;
  const out: DetectedStop[] = [];
  const flagsBy = new Map<string, DownFlag[]>();
  for (const f of input.flags) {
    const l = flagsBy.get(f.unitId);
    if (l) l.push(f);
    else flagsBy.set(f.unitId, [f]);
  }
  const live = input.delays.filter((d) => !d.voidedAt);
  for (const a of input.equipment) {
    if (a.assetClass !== 'fixed_plant') continue;
    const list = sig.get(a.id) ?? [];
    const up = ancestors(tree, a.id);
    const parent = up[0] ? tree.byId.get(up[0]) : undefined;
    for (let i = 1; i < list.length; i++) {
      const s = list[i]!;
      if (s.running || !list[i - 1]!.running) continue;
      const start = ms(s.at);
      if (start < since || start > nowMs) continue;
      const next = list.slice(i + 1).find((x) => x.running);
      const end = next ? ms(next.at) : null;
      const winEnd = end ?? nowMs;
      if ((winEnd - start) / 60_000 < settings.minStopMinutes) continue;
      // A record accounts for the stop when it is running at the stop, or starts within
      // ACCOUNT_MINUTES after it (someone flagged it a little later).
      const near = Math.min(winEnd, start + ACCOUNT_MINUTES * 60_000) + 1;
      const flagged = (flagsBy.get(a.id) ?? []).some((f) => {
        if (f.state === 'open' || f.state === 'released') return overlaps(ms(f.start), endMs(f.end), start, near);
        // Proposals and rejected proposals have no end: they account for a stop that started near them.
        if (f.state === 'voided' && f.source !== 'historian') return false;
        return ms(f.start) >= start - 2 * 60_000 && ms(f.start) < near;
      });
      if (flagged) continue;
      // A knock-on of another equipment in the same circuit that was flagged down at that moment.
      const circuit = circuitOf(tree, a.id);
      const mates = circuit ? equipmentUnder(tree, circuit).filter((x) => x !== a.id) : [];
      const knockOn = mates.some((id) => (flagsBy.get(id) ?? []).some((f) => (f.state === 'open' || f.state === 'released') && Math.abs(ms(f.start) - start) <= 2 * 60_000));
      if (knockOn) continue;
      const delayed = live.some((d) => (d.assetId ? d.assetId === a.id : up.includes(d.nodeId)) && overlaps(ms(d.start), endMs(d.end), start, near));
      if (delayed) continue;
      // Covered: enough other members of its group run within the changeover time (duty and standby change).
      let covered = false;
      if (parent && parent.node.kind === 'group') {
        const others = parent.equipment.filter((x) => x.id !== a.id).map((x) => runIvs(sig.get(x.id) ?? [], nowMs));
        const until = Math.min(winEnd, start + settings.changeoverMinutes * 60_000);
        const pts = [start, until, ...others.flatMap((l) => l.map((iv) => iv.s)).filter((x) => x > start && x <= until)];
        covered = pts.some((m) => others.filter((l) => l.some((iv) => iv.s <= m && iv.e > m)).length >= parent.needed);
      }
      if (covered && settings.coveredStops === 'skip') continue;
      out.push({ assetId: a.id, start: s.at, end: end === null ? null : new Date(end).toISOString(), covered });
    }
  }
  return out.sort((x, y) => ms(x.start) - ms(y.start) || x.assetId.localeCompare(y.assetId));
}

export const HISTORIAN_REASON = 'Historian stop';

/** Turns a detected stop into a proposed down flag (A7 T1, source historian). */
export function proposeStop(ctx: FlagContext, stop: DetectedStop): CommandResult {
  const tz = ctx.calendar.timeZone;
  const hm = (t: Iso) => DateTime.fromISO(t, { zone: tz }).toFormat('HH:mm');
  const notes = `Historian: stopped at ${hm(stop.start)}${stop.end ? `, running again at ${hm(stop.end)}` : ''}.${stop.covered ? ' The standby took over.' : ''}`;
  return proposeDown(ctx, { reasonCode: HISTORIAN_REASON, start: stop.start, location: { kind: 'in_place' }, source: 'historian', notes });
}

// ---------- classifying stops ----------

export interface StopGroup {
  key: string;
  /** The circuit (or parent node) the stops are in. */
  nodeId?: string;
  flags: DownFlag[];
  start: Iso;
  /** When every equipment in the group ran again, or null while any is still stopped. */
  end: Iso | null;
}

/** Proposals in the same circuit that started within `windowMinutes` of each other are one stop to classify. */
export function groupStops(proposals: DownFlag[], tree: PlantTree, signals: RunSignal[], windowMinutes = 2): StopGroup[] {
  const list = proposals.filter((f) => f.state === 'proposed').sort((a, b) => ms(a.start) - ms(b.start));
  const groups: StopGroup[] = [];
  for (const f of list) {
    const nodeId = circuitOf(tree, f.unitId);
    const g = groups.find((x) => x.nodeId === nodeId && nodeId !== undefined && ms(f.start) - ms(x.flags[0]!.start) <= windowMinutes * 60_000);
    if (g) g.flags.push(f);
    else groups.push({ key: f.id, nodeId, flags: [f], start: f.start, end: null });
  }
  for (const g of groups) {
    const ends = g.flags.map((f) => resumeAfter(signals, f.unitId, f.start));
    g.end = ends.some((e) => e === null) ? null : ends.reduce((m, e) => (ms(e!) > ms(m!) ? e : m), ends[0]!) ?? null;
  }
  return groups;
}

export type ClassifyResult = { ok: true; flags: DownFlag[]; delays: ProcessDelay[]; audit: AuditEntry[]; warnings: string[] } | { ok: false; errors: string[] };

/**
 * "Process delay": one delay record for the stop, and each proposal rejected
 * into the state C2 sets (Voided or Process delay). Neither counts as downtime.
 */
export function classifyAsDelay(
  ctxFor: (assetId: string) => FlagContext,
  dctx: DelayContext,
  group: { flags: DownFlag[]; nodeId: string },
  delays: ProcessDelay[],
  codes: DelayCode[],
  input: { code: string; end: Iso | null; notes?: string },
): ClassifyResult {
  if (!group.flags.length) return { ok: false, errors: ['Nothing to classify.'] };
  const first = group.flags.reduce((m, f) => (ms(f.start) < ms(m.start) ? f : m), group.flags[0]!);
  const d = recordDelay(dctx, delays, codes, {
    tenantId: first.tenantId, siteId: first.siteId, nodeId: group.nodeId,
    assetId: group.flags.length === 1 ? first.unitId : undefined,
    code: input.code, start: first.start, end: input.end, notes: input.notes, fromFlagIds: group.flags.map((f) => f.id),
  });
  if (!d.ok) return d;
  const flags: DownFlag[] = [];
  const audit: AuditEntry[] = [...d.audit];
  for (const f of group.flags) {
    const r = rejectProposal(ctxFor(f.unitId), f, `Process delay: ${input.code}`);
    if (!r.ok) return r;
    flags.push(...r.flags);
    audit.push(...r.audit);
  }
  return { ok: true, flags, delays: d.records, audit, warnings: [] };
}

/** "Not a stop" (for example a planned duty and standby changeover): always Voided, whatever C2 says. */
export function classifyNotAStop(ctx: FlagContext, flag: DownFlag, reason: string): CommandResult {
  return rejectProposal({ ...ctx, rules: { ...ctx.rules, rejectedFixedPlantProposal: 'voided' } }, flag, reason);
}

/** "Maintenance": confirm as an unscheduled down flag, In place at the equipment's functional location. */
export function classifyAsMaintenance(ctx: FlagContext, flag: DownFlag, reasonCode?: string): CommandResult {
  return confirmProposal(ctx, flag, { type: 'unscheduled', reasonCode, location: { kind: 'in_place' } });
}

// ---------- plant failure codes (A9 starter list) ----------

/** Systems, components and failure modes for plant equipment, used on the release form for fixed plant. */
export const PLANT_SYSTEMS: Record<string, { components: string[]; modes: string[] }> = {
  Mechanical: { components: ['Bearing', 'Coupling', 'Gearbox', 'Shaft', 'Pinion'], modes: ['Worn', 'Overheat', 'Vibration', 'Seized'] },
  'Wear parts': { components: ['Liner', 'Impeller', 'Belt', 'Chute liner', 'Screen panel'], modes: ['Worn', 'Torn', 'Blocked'] },
  Sealing: { components: ['Mechanical seal', 'Gland packing', 'Gasket'], modes: ['Leak', 'Worn'] },
  Electrical: { components: ['Motor', 'Drive', 'Breaker', 'Cable'], modes: ['Trip', 'Short', 'Open circuit', 'Overheat'] },
  Instrumentation: { components: ['Level sensor', 'Pressure transmitter', 'Speed switch', 'PLC I/O'], modes: ['Failed', 'Drift', 'Intermittent'] },
  Lubrication: { components: ['Lube unit', 'Oil cooler', 'Lube pump'], modes: ['Low pressure', 'Contamination', 'Leak'] },
  Hydraulics: { components: ['Hydraulic unit', 'Cylinder', 'Hose'], modes: ['Leak', 'Low pressure'] },
  Structure: { components: ['Frame', 'Tank', 'Chute'], modes: ['Crack', 'Wear'] },
};
