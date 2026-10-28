// Condition monitoring (phase 3; docs/condition-monitoring.md). Oil samples
// per unit and compartment, judged against the lab's rating and the fleet
// baseline for the same model and compartment, overdue samples, responses and
// KPI-032. Pure functions; the app and the database store what they return.

import { DateTime } from 'luxon';
import type { ConsoleContext } from './console.js';
import { unitSmuAt, type SmuIndex } from './components.js';
import { assetMatcher, normaliseWoNumber, parseSourceDate, parseSourceNumber, type Table } from './imports.js';
import { can } from './permissions.js';
import { HOUR_MS, ms } from './time.js';
import type { Asset, AssetLifecycleInterval, AuditEntry, Iso, WorkOrder } from './types.js';

const DAY = 24 * HOUR_MS;

// ---------- reference ----------

export type Compartment = 'engine' | 'transmission' | 'torque_converter' | 'differential' | 'final_drive_lh' | 'final_drive_rh' | 'hydraulic';
export const COMPARTMENTS: Compartment[] = ['engine', 'transmission', 'torque_converter', 'differential', 'final_drive_lh', 'final_drive_rh', 'hydraulic'];
export const COMPARTMENT_LABELS: Record<Compartment, string> = {
  engine: 'Engine', transmission: 'Transmission', torque_converter: 'Torque converter', differential: 'Differential',
  final_drive_lh: 'Final drive LH', final_drive_rh: 'Final drive RH', hydraulic: 'Hydraulic',
};
export const COMPARTMENT_SHORT: Record<Compartment, string> = {
  engine: 'Eng', transmission: 'Trans', torque_converter: 'TC', differential: 'Diff', final_drive_lh: 'FD L', final_drive_rh: 'FD R', hydraulic: 'Hyd',
};
/** For use mid-sentence: "final drive LH", "engine". */
export const compartmentLower = (c: Compartment) => COMPARTMENT_LABELS[c].toLowerCase().replace(/\b(lh|rh)\b/, (m) => m.toUpperCase());
/** The component life board position that holds each compartment's component (docs/component-life.md). */
export const COMPARTMENT_POSITION: Partial<Record<Compartment, string>> = {
  engine: 'engine', transmission: 'transmission', torque_converter: 'torque_converter', differential: 'differential', final_drive_lh: 'final_drive_lh', final_drive_rh: 'final_drive_rh',
};

export type Element = 'fe' | 'cu' | 'al' | 'cr' | 'pb' | 'si' | 'na' | 'k' | 'water' | 'soot' | 'visc100';
export interface ElementDef { id: Element; label: string; short: string; unit: string; group: 'wear' | 'dirt' | 'coolant' | 'water' | 'soot' | 'viscosity'; step: number; twoSided?: boolean; decimals: number }
export const ELEMENTS: ElementDef[] = [
  { id: 'fe', label: 'Iron', short: 'Fe', unit: 'ppm', group: 'wear', step: 5, decimals: 0 },
  { id: 'cu', label: 'Copper', short: 'Cu', unit: 'ppm', group: 'wear', step: 5, decimals: 0 },
  { id: 'al', label: 'Aluminium', short: 'Al', unit: 'ppm', group: 'wear', step: 5, decimals: 0 },
  { id: 'cr', label: 'Chromium', short: 'Cr', unit: 'ppm', group: 'wear', step: 5, decimals: 0 },
  { id: 'pb', label: 'Lead', short: 'Pb', unit: 'ppm', group: 'wear', step: 5, decimals: 0 },
  { id: 'si', label: 'Silicon', short: 'Si', unit: 'ppm', group: 'dirt', step: 5, decimals: 0 },
  { id: 'na', label: 'Sodium', short: 'Na', unit: 'ppm', group: 'coolant', step: 5, decimals: 0 },
  { id: 'k', label: 'Potassium', short: 'K', unit: 'ppm', group: 'coolant', step: 5, decimals: 0 },
  { id: 'water', label: 'Water', short: 'Water', unit: '%', group: 'water', step: 0.05, decimals: 2 },
  { id: 'soot', label: 'Soot', short: 'Soot', unit: '%', group: 'soot', step: 0.3, decimals: 1 },
  { id: 'visc100', label: 'Viscosity at 100 °C', short: 'V100', unit: 'cSt', group: 'viscosity', step: 1, twoSided: true, decimals: 1 },
];
export const elementById = (id: Element) => ELEMENTS.find((e) => e.id === id)!;
export const fmtReading = (el: Element, v: number) => { const d = elementById(el); return `${v.toFixed(d.decimals)}${d.unit === '%' ? '%' : ` ${d.unit}`}`; };

export type Severity = 'normal' | 'monitor' | 'action' | 'critical';
export const SEVERITIES: Severity[] = ['normal', 'monitor', 'action', 'critical'];
export const SEVERITY_LABELS: Record<Severity, string> = { normal: 'Normal', monitor: 'Monitor', action: 'Action', critical: 'Critical' };
export const rank = (s: Severity | undefined) => (s ? SEVERITIES.indexOf(s) : -1);
export const worse = (a: Severity | undefined, b: Severity | undefined): Severity => (rank(a) >= rank(b) ? a ?? 'normal' : b!);

/** The lab's own rating in one of the four levels, or undefined if it cannot be read. */
export function labSeverityOf(text: string | undefined): Severity | undefined {
  const t = (text ?? '').trim().toLowerCase();
  if (!t) return undefined;
  if (['a', '1', 'normal', 'ok', 'n', 'good', 'satisfactory'].includes(t)) return 'normal';
  if (['b', '2', 'monitor', 'caution', 'marginal', 'attention'].includes(t)) return 'monitor';
  if (['c', '3', 'action', 'abnormal', 'warning', 'serious'].includes(t)) return 'action';
  if (['d', 'x', '4', '5', 'critical', 'severe', 'urgent', 'extreme'].includes(t)) return 'critical';
  return undefined;
}

// ---------- records ----------

export type Readings = Partial<Record<Element, number>>;

export interface OilSample {
  id: string;
  unitId: string;
  compartment: Compartment;
  takenAt: Iso;
  /** When the lab reported it. The response clock starts here (or at entry if blank). */
  reportedAt?: Iso;
  smu?: number;
  oilHours?: number;
  labRef?: string;
  labSeverity?: Severity;
  readings: Readings;
  comment?: string;
  /** Worked out once, when entered (docs/condition-monitoring.md "Worked out once"). */
  severity: Severity;
  reasons: string[];
  enteredBy: string;
  enteredAt: Iso;
  voidedBy?: string;
  voidedAt?: Iso;
  voidReason?: string;
}

export type ResponseAction = 'resample' | 'inspect' | 'work_order' | 'component_change' | 'no_action';
export const RESPONSE_LABELS: Record<ResponseAction, string> = {
  resample: 'Resample', inspect: 'Inspect', work_order: 'Work order raised', component_change: 'Component change planned', no_action: 'No action',
};

export interface CmResponse {
  id: string;
  sampleId: string;
  action: ResponseAction;
  workOrder?: string;
  note: string;
  by: string;
  at: Iso;
}

// ---------- settings ----------

export interface ConditionSettings {
  /** Sample interval in unit SMU hours, per compartment. */
  intervals: Record<Compartment, number>;
  /** Overdue when SMU is past due by more than this share of the interval; due soon within it before. */
  tolerancePct: number;
  baselineDays: number;
  minSamples: number;
  /** Monitor, action and critical limits, in standard deviations above the fleet mean. */
  sigmas: [number, number, number];
  /** Response target time in hours, from the lab report. */
  responseHours: { action: number; critical: number };
}

export const DEFAULT_CONDITION_SETTINGS: ConditionSettings = {
  intervals: { engine: 250, transmission: 500, torque_converter: 500, differential: 500, final_drive_lh: 500, final_drive_rh: 500, hydraulic: 500 },
  tolerancePct: 10,
  baselineDays: 365,
  minSamples: 20,
  sigmas: [2, 3, 4],
  responseHours: { action: 72, critical: 24 },
};

/** A stored value merged over the defaults, so a setting added later gets its default. */
export function withConditionDefaults(v: Partial<ConditionSettings> | undefined): ConditionSettings {
  const d = DEFAULT_CONDITION_SETTINGS;
  const o = (v ?? {}) as Partial<ConditionSettings>;
  const n = (x: unknown, dv: number) => (typeof x === 'number' && Number.isFinite(x) ? x : dv);
  return {
    intervals: Object.fromEntries(COMPARTMENTS.map((c) => [c, n(o.intervals?.[c], d.intervals[c])])) as Record<Compartment, number>,
    tolerancePct: n(o.tolerancePct, d.tolerancePct),
    baselineDays: n(o.baselineDays, d.baselineDays),
    minSamples: n(o.minSamples, d.minSamples),
    sigmas: Array.isArray(o.sigmas) && o.sigmas.length === 3 ? [n(o.sigmas[0], 2), n(o.sigmas[1], 3), n(o.sigmas[2], 4)] : d.sigmas,
    responseHours: { action: n(o.responseHours?.action, d.responseHours.action), critical: n(o.responseHours?.critical, d.responseHours.critical) },
  };
}

type Ok<T> = { ok: true; records: T[]; audit: AuditEntry[]; warnings: string[] };
type No = { ok: false; errors: string[] };
const no = (...errors: string[]): No => ({ ok: false, errors });
const log = (ctx: ConsoleContext, action: string, entity: 'oil_sample' | 'settings', id: string, before: unknown, after: unknown, reason?: string): AuditEntry =>
  ({ at: ctx.now, userId: ctx.actor.userId, action, entity, entityId: id, before, after, reason });

export function setConditionSettings(ctx: ConsoleContext, current: ConditionSettings, next: ConditionSettings, reason: string): Ok<ConditionSettings> | No {
  if (!can(ctx.actor, 'edit_condition_settings')) return no('Your role cannot change condition monitoring settings.');
  const e: string[] = [];
  for (const c of COMPARTMENTS) {
    const v = next.intervals[c];
    if (!(Number.isInteger(v) && v >= 50 && v <= 5000)) e.push(`${COMPARTMENT_LABELS[c]} interval must be a whole number of hours from 50 to 5,000.`);
  }
  if (!(next.tolerancePct >= 0 && next.tolerancePct <= 50)) e.push('Tolerance must be from 0 to 50%.');
  if (!(Number.isInteger(next.baselineDays) && next.baselineDays >= 30 && next.baselineDays <= 1095)) e.push('Baseline window must be from 30 to 1,095 days.');
  if (!(Number.isInteger(next.minSamples) && next.minSamples >= 5 && next.minSamples <= 500)) e.push('Minimum samples must be from 5 to 500.');
  const [a, b, c] = next.sigmas;
  if (!(a >= 1 && a < b && b < c && c <= 10)) e.push('Limits must rise: monitor below action below critical, from 1σ to 10σ.');
  if (!(next.responseHours.critical >= 1 && next.responseHours.critical <= next.responseHours.action && next.responseHours.action <= 720)) e.push('Response times must be from 1 to 720 hours, critical no longer than action.');
  if (!reason.trim()) e.push('Give a reason for the change.');
  if (e.length) return no(...e);
  const clean = withConditionDefaults(next);
  return { ok: true, records: [clean], audit: [log(ctx, 'set_condition_settings', 'settings', 'condition', current, clean, reason.trim())], warnings: [] };
}

// ---------- fleet baseline ----------

export interface Baseline {
  model: string;
  compartment: Compartment;
  element: Element;
  n: number;
  mean: number;
  sd: number;
  /** Monitor, action and critical limits above the mean. */
  high: [number, number, number];
  /** The same below the mean, for two-sided elements (viscosity). */
  low?: [number, number, number];
}

export type Baselines = Map<string, Baseline>;
const bKey = (model: string, c: Compartment, el: Element) => `${model}|${c}|${el}`;
export const reportTime = (s: OilSample) => s.reportedAt ?? s.enteredAt;
export const live = (s: OilSample) => !s.voidedAt;

/** Mean, σ and limits from a list of values (at least `minSamples` of them). */
export function baselineOf(values: number[], el: Element, s: ConditionSettings): Omit<Baseline, 'model' | 'compartment' | 'element'> | null {
  if (values.length < s.minSamples) return null;
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  const step = elementById(el).step;
  const up: number[] = [];
  const down: number[] = [];
  let prevUp = mean;
  let prevDown = mean;
  for (const k of s.sigmas) {
    prevUp = Math.max(mean + k * sd, prevUp + step);
    up.push(prevUp);
    prevDown = Math.min(mean - k * sd, prevDown - step);
    down.push(prevDown);
  }
  return { n, mean, sd, high: up as [number, number, number], low: elementById(el).twoSided ? (down as [number, number, number]) : undefined };
}

/**
 * The fleet baseline at a moment: samples reported in the window before `at`, not voided and not
 * themselves at Action or Critical, grouped by model, compartment and element.
 */
export function buildBaselines(samples: OilSample[], modelOf: (unitId: string) => string | undefined, at: Iso, s: ConditionSettings = DEFAULT_CONDITION_SETTINGS): Baselines {
  const t = ms(at);
  const from = t - s.baselineDays * DAY;
  const groups = new Map<string, number[]>();
  for (const x of samples) {
    if (!live(x) || rank(x.severity) >= rank('action')) continue;
    const rt = ms(reportTime(x));
    if (rt >= t || rt < from) continue;
    const model = modelOf(x.unitId);
    if (!model) continue;
    for (const [el, v] of Object.entries(x.readings) as Array<[Element, number]>) {
      if (!Number.isFinite(v)) continue;
      const k = bKey(model, x.compartment, el);
      const l = groups.get(k);
      if (l) l.push(v); else groups.set(k, [v]);
    }
  }
  const out: Baselines = new Map();
  for (const [k, values] of groups) {
    const [model, compartment, element] = k.split('|') as [string, Compartment, Element];
    const b = baselineOf(values, element, s);
    if (b) out.set(k, { model, compartment, element, ...b });
  }
  return out;
}

export const baselineFor = (b: Baselines, model: string | undefined, c: Compartment, el: Element) => (model ? b.get(bKey(model, c, el)) : undefined);

/** Severity of one sample: the worse of the lab rating and each element against the fleet baseline. */
export function judge(input: { compartment: Compartment; readings: Readings; labSeverity?: Severity }, model: string | undefined, baselines: Baselines): { severity: Severity; reasons: string[] } {
  let sev: Severity = input.labSeverity ?? 'normal';
  const reasons: string[] = [];
  if (input.labSeverity && input.labSeverity !== 'normal') reasons.push(`Lab rated it ${SEVERITY_LABELS[input.labSeverity]}.`);
  const fleet = `${model ?? ''} ${compartmentLower(input.compartment)}`.trim();
  let missing = 0;
  for (const def of ELEMENTS) {
    const v = input.readings[def.id];
    if (v === undefined || !Number.isFinite(v)) continue;
    const b = baselineFor(baselines, model, input.compartment, def.id);
    if (!b) { missing++; continue; }
    let level = -1;
    let limit = 0;
    let dir = 'above';
    for (let i = 2; i >= 0; i--) {
      if (v > b.high[i]!) { level = i; limit = b.high[i]!; break; }
      if (b.low && v < b.low[i]!) { level = i; limit = b.low[i]!; dir = 'below'; break; }
    }
    if (level < 0) continue;
    const s = SEVERITIES[level + 1]!;
    sev = worse(sev, s);
    reasons.push(`${def.short} ${fmtReading(def.id, v)}: ${dir} the ${SEVERITY_LABELS[s].toLowerCase()} limit of ${fmtReading(def.id, limit)} (${fleet} fleet mean ${b.mean.toFixed(def.decimals)}, ${b.n} samples).`);
  }
  if (missing > 0 && missing === Object.keys(input.readings).length) reasons.push(`Not enough samples for a fleet baseline for ${fleet}; only the lab rating counts.`);
  return { severity: sev, reasons };
}

// ---------- recording ----------

export interface SampleInput {
  unitId: string;
  compartment: Compartment;
  takenAt: Iso;
  reportedAt?: Iso;
  smu?: number;
  oilHours?: number;
  labRef?: string;
  labSeverity?: Severity;
  readings: Readings;
  comment?: string;
}

export interface ConditionData { samples: OilSample[]; responses: CmResponse[]; assets: Asset[] }

function checkSample(ctx: ConsoleContext, data: ConditionData, input: SampleInput, extraRefs: Set<string> = new Set()): string[] {
  const e: string[] = [];
  if (!data.assets.some((a) => a.id === input.unitId)) e.push('Pick the unit.');
  if (!COMPARTMENTS.includes(input.compartment)) e.push('Pick the compartment.');
  if (!input.takenAt || Number.isNaN(ms(input.takenAt))) e.push('Give the date the sample was taken.');
  else if (ms(input.takenAt) > ms(ctx.now) + 10 * 60_000) e.push('The sample date is in the future.');
  if (input.reportedAt && (Number.isNaN(ms(input.reportedAt)) || ms(input.reportedAt) < ms(input.takenAt) || ms(input.reportedAt) > ms(ctx.now) + 10 * 60_000)) e.push('The report date must be between the sample date and now.');
  if (input.smu !== undefined && !(Number.isFinite(input.smu) && input.smu >= 0 && input.smu < 1_000_000)) e.push('Unit SMU must be a number of hours.');
  if (input.oilHours !== undefined && !(Number.isFinite(input.oilHours) && input.oilHours >= 0 && input.oilHours < 100_000)) e.push('Oil hours must be a number of hours.');
  const vals = Object.entries(input.readings).filter(([, v]) => v !== undefined);
  if (!vals.length && !input.labSeverity) e.push('Give at least one reading or the lab severity.');
  for (const [k, v] of vals) if (!ELEMENTS.some((d) => d.id === k) || !(Number.isFinite(v) && (v as number) >= 0 && (v as number) < 100_000)) e.push(`${k} is not a valid reading.`);
  const ref = input.labRef?.trim();
  if (ref && (data.samples.some((s) => s.labRef === ref) || extraRefs.has(ref))) e.push(`Lab reference ${ref} is already held.`);
  return e;
}

function makeSample(ctx: ConsoleContext, input: SampleInput, model: string | undefined, baselines: Baselines): OilSample {
  const readings: Readings = {};
  for (const d of ELEMENTS) { const v = input.readings[d.id]; if (v !== undefined && Number.isFinite(v)) readings[d.id] = v; }
  const j = judge({ compartment: input.compartment, readings, labSeverity: input.labSeverity }, model, baselines);
  return {
    id: ctx.newId(), unitId: input.unitId, compartment: input.compartment, takenAt: input.takenAt, reportedAt: input.reportedAt,
    smu: input.smu, oilHours: input.oilHours, labRef: input.labRef?.trim() || undefined, labSeverity: input.labSeverity, readings,
    comment: input.comment?.trim() || undefined, severity: j.severity, reasons: j.reasons, enteredBy: ctx.actor.userId, enteredAt: ctx.now,
  };
}

const modelLookup = (assets: Asset[]) => { const m = new Map(assets.map((a) => [a.id, a.model])); return (id: string) => m.get(id); };

/** One sample typed in. Judged against the baseline as it is now. */
export function recordSample(ctx: ConsoleContext, data: ConditionData, input: SampleInput, s: ConditionSettings = DEFAULT_CONDITION_SETTINGS): Ok<OilSample> | No {
  if (!can(ctx.actor, 'record_condition')) return no('Your role cannot record condition results.');
  const e = checkSample(ctx, data, input);
  if (e.length) return no(...e);
  const modelOf = modelLookup(data.assets);
  const x = makeSample(ctx, input, modelOf(input.unitId), buildBaselines(data.samples, modelOf, ctx.now, s));
  return { ok: true, records: [...data.samples, x], audit: [log(ctx, 'record_oil_sample', 'oil_sample', x.id, null, x)], warnings: [] };
}

export function voidSample(ctx: ConsoleContext, samples: OilSample[], id: string, reason: string): Ok<OilSample> | No {
  const x = samples.find((s) => s.id === id);
  if (!x) return no('Sample not found.');
  if (x.voidedAt) return no('It is already voided.');
  if (!((x.enteredBy === ctx.actor.userId && can(ctx.actor, 'record_condition')) || ctx.actor.role === 'superintendent')) return no('Only the person who entered it, or a superintendent, voids a sample.');
  if (!reason.trim()) return no('Give a reason.');
  const v: OilSample = { ...x, voidedBy: ctx.actor.userId, voidedAt: ctx.now, voidReason: reason.trim() };
  return { ok: true, records: samples.map((s) => (s.id === id ? v : s)), audit: [log(ctx, 'void_oil_sample', 'oil_sample', id, x, v, reason.trim())], warnings: [] };
}

export interface ResponseInput { action: ResponseAction; workOrder?: string; note: string }

export const needsResponse = (x: OilSample) => live(x) && rank(x.severity) >= rank('action');
export const responseDue = (x: OilSample, s: ConditionSettings): Iso =>
  new Date(ms(reportTime(x)) + (x.severity === 'critical' ? s.responseHours.critical : s.responseHours.action) * HOUR_MS).toISOString();

export function respondToSample(ctx: ConsoleContext, data: { samples: OilSample[]; responses: CmResponse[] }, sampleId: string, input: ResponseInput): Ok<CmResponse> | No {
  if (!can(ctx.actor, 'record_condition')) return no('Your role cannot respond to condition results.');
  const x = data.samples.find((s) => s.id === sampleId);
  if (!x) return no('Sample not found.');
  if (!needsResponse(x)) return no('Only samples at Action or Critical need a response.');
  if (data.responses.some((r) => r.sampleId === sampleId)) return no('This sample already has a response.');
  const e: string[] = [];
  if (!RESPONSE_LABELS[input.action]) e.push('Pick a response.');
  if (input.action === 'work_order' && !input.workOrder?.trim()) e.push('Give the work order number.');
  if (!input.note.trim()) e.push(input.action === 'no_action' ? 'Say why no action is needed.' : 'Add a note.');
  if (e.length) return no(...e);
  const r: CmResponse = { id: ctx.newId(), sampleId, action: input.action, workOrder: input.action === 'work_order' ? input.workOrder!.trim() : undefined, note: input.note.trim(), by: ctx.actor.userId, at: ctx.now };
  return { ok: true, records: [...data.responses, r], audit: [log(ctx, 'respond_oil_sample', 'oil_sample', sampleId, null, r, r.note)], warnings: [] };
}

// ---------- lab file import ----------

const HEADERS: Record<string, string[]> = {
  unit: ['unit', 'unit id', 'unit no', 'unit number', 'equipment', 'asset', 'asset id'],
  compartment: ['compartment', 'component', 'comp'],
  takenAt: ['sample date', 'date sampled', 'sampled', 'date taken'],
  reportedAt: ['report date', 'date reported', 'reported', 'completed'],
  labRef: ['lab no', 'lab number', 'sample no', 'sample id', 'lab ref'],
  smu: ['unit hours', 'equipment hours', 'meter', 'smu', 'machine hours'],
  oilHours: ['oil hours', 'hours on oil', 'fluid hours', 'oil age'],
  severity: ['severity', 'status', 'evaluation', 'rating'],
  comment: ['comment', 'comments', 'recommendation'],
  fe: ['fe', 'iron'], cu: ['cu', 'copper'], al: ['al', 'aluminium', 'aluminum'], cr: ['cr', 'chromium'], pb: ['pb', 'lead'],
  si: ['si', 'silicon'], na: ['na', 'sodium'], k: ['k', 'potassium'], water: ['water', 'h2o'], soot: ['soot'], visc100: ['v100', 'visc 100', 'viscosity', 'visc100', 'viscosity 100'],
};

const clean = (h: string) => h.toLowerCase().replace(/\(.*?\)/g, ' ').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

/** Column index for each field; the first matching header wins. */
export function labColumns(header: string[]): Partial<Record<keyof typeof HEADERS, number>> & { waterPpm?: boolean } {
  const out: Partial<Record<string, number>> & { waterPpm?: boolean } = {};
  const cleaned = header.map(clean);
  for (const [field, names] of Object.entries(HEADERS)) {
    const i = cleaned.findIndex((h) => names.includes(h) || (field === 'visc100' && h.startsWith('visc')) || (field === 'water' && h.startsWith('water')));
    if (i >= 0) out[field] = i;
  }
  if (out.water !== undefined && /ppm/i.test(header[out.water]!)) out.waterPpm = true;
  return out;
}

/** Loose compartment names from lab files. */
export function compartmentOf(text: string): Compartment | undefined {
  const t = text.toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
  const left = /\b(lh|left|l)\b/.test(t);
  const right = /\b(rh|right|r)\b/.test(t);
  if (/final|fd|wheel/.test(t)) return left ? 'final_drive_lh' : right ? 'final_drive_rh' : undefined;
  if (/torque|^tc\b|converter/.test(t)) return 'torque_converter';
  if (/diff|rear axle|axle/.test(t)) return 'differential';
  if (/trans/.test(t)) return 'transmission';
  if (/hyd|hoist|steer/.test(t)) return 'hydraulic';
  if (/eng|diesel/.test(t)) return 'engine';
  return undefined;
}

export interface LabImportIssue { row: number; message: string }
export interface LabImportResult { ok: true; records: OilSample[]; added: OilSample[]; issues: LabImportIssue[]; duplicates: number; audit: AuditEntry[]; warnings: string[] }

const DATE_FORMATS = ['yyyy-MM-dd HH:mm', 'yyyy-MM-dd H:mm', 'yyyy-MM-dd', 'dd/MM/yyyy', 'd/M/yyyy', 'MM/dd/yyyy HH:mm', 'dd-MMM-yyyy', 'dd-MMM-yy'];

/** Read a lab CSV and add its new samples, judged against the baseline as it is now. */
export function importLabFile(ctx: ConsoleContext, data: ConditionData, table: Table, fileName: string, s: ConditionSettings = DEFAULT_CONDITION_SETTINGS): LabImportResult | No {
  if (!can(ctx.actor, 'record_condition')) return no('Your role cannot record condition results.');
  const col = labColumns(table.header);
  const missing = (['unit', 'compartment', 'takenAt'] as const).filter((f) => col[f] === undefined);
  if (missing.length) return no(`The file needs columns for ${missing.map((f) => ({ unit: 'unit', compartment: 'compartment', takenAt: 'sample date' })[f]).join(', ')}. See docs/condition-monitoring.md for the headers read.`);
  if (!ELEMENTS.some((d) => col[d.id] !== undefined) && col.severity === undefined) return no('The file has no element columns and no severity column.');
  const match = assetMatcher(data.assets);
  const modelOf = modelLookup(data.assets);
  const baselines = buildBaselines(data.samples, modelOf, ctx.now, s);
  const issues: LabImportIssue[] = [];
  const added: OilSample[] = [];
  const refs = new Set<string>();
  let duplicates = 0;
  table.rows.forEach((row, i) => {
    const n = i + 2;
    const cell = (f: string) => { const c = (col as Record<string, number | undefined>)[f]; return c === undefined ? '' : (row[c] ?? '').trim(); };
    const unit = match(cell('unit'));
    if (!unit) { issues.push({ row: n, message: `Unknown unit "${cell('unit')}".` }); return; }
    const compartment = compartmentOf(cell('compartment'));
    if (!compartment) { issues.push({ row: n, message: `Unknown compartment "${cell('compartment')}".` }); return; }
    const takenAt = parseSourceDate(cell('takenAt'), DATE_FORMATS, ctx.timeZone);
    if (!takenAt) { issues.push({ row: n, message: `No readable sample date "${cell('takenAt')}".` }); return; }
    const reportedRaw = cell('reportedAt');
    const reportedAt = reportedRaw ? parseSourceDate(reportedRaw, DATE_FORMATS, ctx.timeZone) ?? undefined : undefined;
    if (reportedRaw && !reportedAt) issues.push({ row: n, message: `Report date "${reportedRaw}" not read; the response clock starts at import.` });
    const sevRaw = cell('severity');
    const labSeverity = labSeverityOf(sevRaw);
    if (sevRaw && !labSeverity) issues.push({ row: n, message: `Lab severity "${sevRaw}" not recognised; left blank.` });
    const readings: Readings = {};
    for (const d of ELEMENTS) {
      const raw = cell(d.id);
      if (!raw) continue;
      const v = parseSourceNumber(raw.replace(/^<\s*/, ''));
      if (v === null) { issues.push({ row: n, message: `${d.short} "${raw}" is not a number; left out.` }); continue; }
      readings[d.id] = d.id === 'water' && col.waterPpm ? v / 10000 : v;
    }
    const num = (f: string) => { const raw = cell(f); return raw ? parseSourceNumber(raw) ?? undefined : undefined; };
    const input: SampleInput = { unitId: unit.id, compartment, takenAt, reportedAt: reportedAt && ms(reportedAt) >= ms(takenAt) ? reportedAt : undefined, smu: num('smu'), oilHours: num('oilHours'), labRef: cell('labRef') || undefined, labSeverity, readings, comment: cell('comment') || undefined };
    if (input.labRef && (data.samples.some((x) => x.labRef === input.labRef) || refs.has(input.labRef))) { duplicates++; return; }
    const e = checkSample(ctx, data, input, refs);
    if (e.length) { issues.push({ row: n, message: e.join(' ') }); return; }
    if (input.labRef) refs.add(input.labRef);
    added.push(makeSample(ctx, input, unit.model, baselines));
  });
  const audit: AuditEntry[] = added.length
    ? [log(ctx, 'import_oil_samples', 'oil_sample', added[0]!.id, null, { fileName, added: added.length, duplicates, skipped: issues.length, ids: added.map((x) => x.id) }, `Lab file import: ${fileName}`)]
    : [];
  return { ok: true, records: [...data.samples, ...added], added, issues, duplicates, audit, warnings: [] };
}

// ---------- views ----------

const byTaken = (a: OilSample, b: OilSample) => ms(a.takenAt) - ms(b.takenAt) || ms(a.enteredAt) - ms(b.enteredAt);

/** Live samples per unit and compartment, oldest first. */
export function sampleHistory(samples: OilSample[]): Map<string, OilSample[]> {
  const m = new Map<string, OilSample[]>();
  for (const x of samples) {
    if (!live(x)) continue;
    const k = `${x.unitId}|${x.compartment}`;
    const l = m.get(k);
    if (l) l.push(x); else m.set(k, [x]);
  }
  for (const l of m.values()) l.sort(byTaken);
  return m;
}
export const historyKey = (unitId: string, c: Compartment) => `${unitId}|${c}`;

/** Elements that went up on each of the last four samples (three rises in a row) and are now more than 1σ above the fleet mean. */
export function risingElements(history: OilSample[], model: string | undefined, baselines: Baselines): Element[] {
  if (history.length < 4) return [];
  const last = history.slice(-4);
  const c = last[3]!;
  return ELEMENTS.filter((d) => {
    const v = last.map((x) => x.readings[d.id]);
    if (v.some((x) => x === undefined)) return false;
    for (let i = 1; i < 4; i++) if (!(v[i]! > v[i - 1]!)) return false;
    const bl = baselineFor(baselines, model, c.compartment, d.id);
    return !!bl && v[3]! > bl.mean + bl.sd;
  }).map((d) => d.id);
}

export interface ConditionCell { compartment: Compartment; latest?: OilSample; rising: Element[]; due?: SampleDueRow }
export interface ConditionBoardRow { unit: Asset; cells: ConditionCell[]; worst?: Severity }

export function conditionBoard(assets: Asset[], samples: OilSample[], baselines: Baselines, due: SampleDueRow[]): ConditionBoardRow[] {
  const hist = sampleHistory(samples);
  const dueBy = new Map(due.map((d) => [historyKey(d.unit.id, d.compartment), d]));
  return assets.map((unit) => {
    const cells = COMPARTMENTS.map((c) => {
      const h = hist.get(historyKey(unit.id, c)) ?? [];
      return { compartment: c, latest: h.at(-1), rising: risingElements(h, unit.model, baselines), due: dueBy.get(historyKey(unit.id, c)) };
    });
    const worst = cells.reduce<Severity | undefined>((w, c) => (c.latest ? worse(w, c.latest.severity) : w), undefined);
    return { unit, cells, worst };
  });
}

/** Lifecycle status at a moment; units with no record are active. */
export function lifecycleAt(lifecycle: AssetLifecycleInterval[], unitId: string, at: Iso): AssetLifecycleInterval['status'] {
  const t = ms(at);
  const i = lifecycle.find((x) => x.assetId === unitId && ms(x.start) <= t && (x.end === null || ms(x.end) > t));
  return i?.status ?? 'active';
}

export interface SampleDueRow {
  unit: Asset;
  compartment: Compartment;
  status: 'overdue' | 'due_soon' | 'ok' | 'none';
  lastAt?: Iso;
  lastSmu?: number;
  dueSmu?: number;
  smuNow?: number;
  /** Hours past due (negative while not yet due). */
  hoursOver?: number;
}

export function samplesDue(assets: Asset[], lifecycle: AssetLifecycleInterval[], samples: OilSample[], smu: SmuIndex, now: Iso, s: ConditionSettings = DEFAULT_CONDITION_SETTINGS): SampleDueRow[] {
  const hist = sampleHistory(samples);
  const out: SampleDueRow[] = [];
  for (const unit of assets) {
    if (lifecycleAt(lifecycle, unit.id, now) !== 'active') continue;
    const smuNow = unitSmuAt(smu, unit.id, now);
    for (const c of COMPARTMENTS) {
      const last = hist.get(historyKey(unit.id, c))?.at(-1);
      if (!last) { out.push({ unit, compartment: c, status: 'none', smuNow }); continue; }
      // The unit's own meter when the sample was taken; the lab's figure only when there is no reading.
      const lastSmu = unitSmuAt(smu, unit.id, last.takenAt) ?? last.smu;
      if (lastSmu === undefined || smuNow === undefined) { out.push({ unit, compartment: c, status: 'ok', lastAt: last.takenAt }); continue; }
      const interval = s.intervals[c];
      const tol = (interval * s.tolerancePct) / 100;
      const dueSmu = lastSmu + interval;
      const hoursOver = smuNow - dueSmu;
      const status = hoursOver > tol ? 'overdue' : hoursOver >= -tol ? 'due_soon' : 'ok';
      out.push({ unit, compartment: c, status, lastAt: last.takenAt, lastSmu, dueSmu, smuNow, hoursOver });
    }
  }
  return out;
}

export interface AlertRow {
  sample: OilSample;
  dueAt: Iso;
  response?: CmResponse;
  status: 'waiting' | 'overdue' | 'in_time' | 'late';
}

export function conditionAlerts(samples: OilSample[], responses: CmResponse[], now: Iso, s: ConditionSettings = DEFAULT_CONDITION_SETTINGS): AlertRow[] {
  const resp = new Map(responses.map((r) => [r.sampleId, r]));
  return samples.filter(needsResponse).map((sample) => {
    const dueAt = responseDue(sample, s);
    const response = resp.get(sample.id);
    const status: AlertRow['status'] = response ? (ms(response.at) <= ms(dueAt) ? 'in_time' : 'late') : ms(now) > ms(dueAt) ? 'overdue' : 'waiting';
    return { sample, dueAt, response, status };
  }).sort((a, b) => ms(a.dueAt) - ms(b.dueAt));
}

export interface CmResponseResult { value: number | null; inTime: number; late: number; missing: number; total: number }

/** KPI-032: alerts answered within target ÷ alerts whose target time ended in [from, to), and not after `now`. */
export function cmResponse(samples: OilSample[], responses: CmResponse[], from: Iso, to: Iso, now: Iso, s: ConditionSettings = DEFAULT_CONDITION_SETTINGS): CmResponseResult {
  const end = Math.min(ms(to), ms(now));
  let inTime = 0; let late = 0; let missing = 0;
  for (const a of conditionAlerts(samples, responses, now, s)) {
    const d = ms(a.dueAt);
    if (d < ms(from) || d >= end) continue;
    if (a.status === 'in_time') inTime++;
    else if (a.status === 'late' || (a.response && ms(a.response.at) > d)) late++;
    else missing++;
  }
  const total = inTime + late + missing;
  return { value: total ? inTime / total : null, inTime, late, missing, total };
}

/** Responses with a work order: raised, and closed once the ERP work order is closed (matched by number). */
export function conditionActions(responses: CmResponse[], samples: OilSample[], workOrders: WorkOrder[]): { raised: number; closed: number; open: Array<{ response: CmResponse; sample?: OilSample; workOrder?: WorkOrder }> } {
  const byNumber = new Map(workOrders.map((w) => [w.numberNormalised, w]));
  const live = new Map(samples.filter((x) => !x.voidedAt).map((x) => [x.id, x]));
  let raised = 0; let closed = 0;
  const open: Array<{ response: CmResponse; sample?: OilSample; workOrder?: WorkOrder }> = [];
  for (const r of responses) {
    if (r.action !== 'work_order' || !r.workOrder || !live.has(r.sampleId)) continue;
    raised++;
    const w = byNumber.get(normaliseWoNumber(r.workOrder));
    if (w && !w.open) closed++;
    else open.push({ response: r, sample: live.get(r.sampleId), workOrder: w });
  }
  return { raised, closed, open };
}

export interface ChartPoint { at: Iso; value: number; unitId: string; severity: Severity; sampleId: string }

/** Every fleet sample for one model, compartment and element, and the baseline as at `now`. */
export function oilControlChart(samples: OilSample[], modelOf: (unitId: string) => string | undefined, model: string, c: Compartment, el: Element, now: Iso, baselines: Baselines, days = 365): { points: ChartPoint[]; baseline?: Baseline } {
  const from = ms(now) - days * DAY;
  const points = samples
    .filter((x) => live(x) && x.compartment === c && modelOf(x.unitId) === model && x.readings[el] !== undefined && ms(x.takenAt) >= from)
    .sort(byTaken)
    .map((x) => ({ at: x.takenAt, value: x.readings[el]!, unitId: x.unitId, severity: x.severity, sampleId: x.id }));
  return { points, baseline: baselineFor(baselines, model, c, el) };
}

/** Histogram bins for the control chart. */
export function histogram(values: number[], bins = 12): Array<{ from: number; to: number; count: number }> {
  if (!values.length) return [];
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const w = hi > lo ? (hi - lo) / bins : 1;
  const out = Array.from({ length: bins }, (_, i) => ({ from: lo + i * w, to: lo + (i + 1) * w, count: 0 }));
  for (const v of values) out[Math.min(bins - 1, Math.floor((v - lo) / w))]!.count++;
  return out;
}

/** Site date of a sample, for tables. */
export const sampleDate = (x: OilSample, tz: string) => DateTime.fromISO(x.takenAt, { zone: tz }).toISODate()!;
