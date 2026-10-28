// Calculator library, phase 2 core set (build plan 7.2, 7.3; docs/calculators.md).
// Pure functions: each takes plain inputs and returns the numbers, a plain
// sentence and any warnings. Worked examples are in test/calculators.test.ts.

import type { AuditEntry, Iso, SmuReading } from './types.js';
import type { DowntimeEvent } from './kpis.js';
import type { ConsoleContext } from './console.js';
import { can } from './permissions.js';

export interface CalcOutput {
  values: Record<string, number | null>;
  sentence: string;
  warnings: string[];
}

const pct = (x: number, d = 1) => `${(x * 100).toFixed(d)}%`;
const n0 = (x: number) => Math.round(x).toLocaleString('en-CA');
const n1 = (x: number) => x.toLocaleString('en-CA', { maximumFractionDigits: 1, minimumFractionDigits: 0 });
const money = (x: number) => `$${x.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const bad = (...e: string[]) => { throw new CalcError(e); };

/** Inputs that cannot be calculated. The page shows the messages. */
export class CalcError extends Error {
  constructor(readonly problems: string[]) { super(problems.join(' ')); }
}

const positive = (x: number, name: string) => { if (!(Number.isFinite(x) && x > 0)) bad(`${name} must be above 0.`); };

// ---------- special functions ----------

function logGamma(x: number): number {
  // Lanczos approximation (g = 7, n = 9).
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  x -= 1;
  let a = c[0]!;
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += c[i]! / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Regularised lower incomplete gamma P(a, x). */
function gammaP(a: number, x: number): number {
  if (x <= 0) return 0;
  const gln = logGamma(a);
  if (x < a + 1) {
    let sum = 1 / a;
    let del = sum;
    let ap = a;
    for (let i = 0; i < 500; i++) {
      ap += 1; del *= x / ap; sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-15) break;
    }
    return sum * Math.exp(-x + a * Math.log(x) - gln);
  }
  // Continued fraction for Q, then P = 1 − Q.
  let b = x + 1 - a;
  let c = 1 / 1e-300;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return 1 - Math.exp(-x + a * Math.log(x) - gln) * h;
}

/** Chi-square quantile: the x with P(χ²(ν) ≤ x) = p. */
export function chiSquareQuantile(p: number, nu: number): number {
  let lo = 0;
  let hi = Math.max(10, nu * 10);
  while (gammaP(nu / 2, hi / 2) < p) hi *= 2;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (gammaP(nu / 2, mid / 2) < p) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Standard normal quantile (Acklam's rational approximation, refined by one Halley step). */
export function normalQuantile(p: number): number {
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  let x: number;
  if (p < pl) { const q = Math.sqrt(-2 * Math.log(p)); x = (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1); }
  else if (p <= 1 - pl) { const q = p - 0.5; const r = q * q; x = (((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1); }
  else { const q = Math.sqrt(-2 * Math.log(1 - p)); x = -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1); }
  // One Halley refinement using erfc.
  const e = 0.5 * erfc(-x / Math.SQRT2) - p;
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2);
  return x - u / (1 + (x * u) / 2);
}

function erfc(x: number): number {
  // Numerical Recipes erfc, fractional error < 1.2e-7.
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? r : 2 - r;
}

// ---------- C-01, C-02 availability ----------

export function inherentAvailability(i: { mtbf: number; mttr: number }): CalcOutput {
  positive(i.mtbf, 'MTBF');
  if (!(i.mttr >= 0)) bad('MTTR must be 0 or more.');
  const a = i.mtbf / (i.mtbf + i.mttr);
  return { values: { availability: a }, sentence: `With a failure every ${n1(i.mtbf)} operating hours and ${n1(i.mttr)} h to repair, the most the design and repair times allow is ${pct(a)}. Waiting for parts, crews and shop lines comes on top, so PA will be lower.`, warnings: [] };
}

export function availabilityTarget(i: { target: number; mttr?: number; mtbf?: number }): CalcOutput {
  if (!(i.target > 0 && i.target < 1)) bad('The target must be between 0% and 100%.');
  const A = i.target;
  if (i.mttr !== undefined && i.mtbf === undefined) {
    positive(i.mttr, 'MTTR');
    const mtbf = (A * i.mttr) / (1 - A);
    return { values: { requiredMtbf: mtbf, maxMttr: null }, sentence: `To reach ${pct(A)} with repairs of ${n1(i.mttr)} h, failures must be at least ${n1(mtbf)} operating hours apart on average.`, warnings: [] };
  }
  if (i.mtbf !== undefined && i.mttr === undefined) {
    positive(i.mtbf, 'MTBF');
    const mttr = (i.mtbf * (1 - A)) / A;
    return { values: { requiredMtbf: null, maxMttr: mttr }, sentence: `To reach ${pct(A)} with a failure every ${n1(i.mtbf)} operating hours, each repair must take ${mttr.toFixed(2)} h or less on average.`, warnings: [] };
  }
  return bad('Enter either MTTR or MTBF, not both.');
}

// ---------- C-03 cost of downtime ----------

export function downtimeCost(i: { tonnesPerHour: number; marginPerTonne: number; otherPerHour: number }): CalcOutput {
  if (!(i.tonnesPerHour >= 0 && i.marginPerTonne >= 0 && i.otherPerHour >= 0)) bad('Enter 0 or more for each input.');
  const perHour = i.tonnesPerHour * i.marginPerTonne + i.otherPerHour;
  return { values: { perHour }, sentence: `Each down hour costs about ${money(perHour)}: ${n1(i.tonnesPerHour)} t not moved at ${money(i.marginPerTonne)} a tonne, plus ${money(i.otherPerHour)} of other costs.`, warnings: [] };
}

// ---------- C-04 MTBF confidence ----------

export function mtbfConfidence(i: { hours: number; failures: number; confidence: number; endsAt: 'time' | 'failure' }): CalcOutput {
  positive(i.hours, 'Operating hours');
  if (!(Number.isInteger(i.failures) && i.failures >= 0)) bad('Failures must be a whole number, 0 or more.');
  if (!(i.confidence > 0 && i.confidence < 1)) bad('Confidence must be between 0% and 100%.');
  if (i.endsAt === 'failure' && i.failures === 0) bad('An observation that ends at a failure has at least one failure.');
  const nu = i.endsAt === 'time' ? 2 * i.failures + 2 : 2 * i.failures;
  const chi = chiSquareQuantile(i.confidence, nu);
  const lower = (2 * i.hours) / chi;
  const point = i.failures ? i.hours / i.failures : null;
  const warnings = i.failures < 5 ? [`Only ${i.failures} failure${i.failures === 1 ? '' : 's'}: the limit is wide and the point estimate is rough.`] : [];
  const sentence = `We can be ${pct(i.confidence, 0)} sure the true MTBF is at least ${n0(lower)} h` + (point === null ? ', from no failures in this time.' : `; the best single estimate is ${n0(point)} h.`);
  return { values: { point, lower, chiSquare: chi, dof: nu }, sentence, warnings };
}

// ---------- C-05 Weibull ----------

export interface LifeTime { t: number; failed: boolean }

export interface WeibullFit extends CalcOutput {
  beta: number;
  eta: number;
  betaBounds: [number, number];
  etaBounds: [number, number];
  b10: number;
  /** Probability plot points (failures only): time and median rank. */
  plot: Array<{ t: number; f: number }>;
}

function weibullLogLik(beta: number, eta: number, data: LifeTime[]): number {
  let s = 0;
  for (const d of data) {
    if (d.failed) s += Math.log(beta) - beta * Math.log(eta) + (beta - 1) * Math.log(d.t);
    s -= (d.t / eta) ** beta;
  }
  return s;
}

/** Maximum likelihood Weibull with right-censored times; Fisher matrix bounds at a two-sided level. */
export function weibull(data: LifeTime[], level = 0.9): WeibullFit {
  if (data.some((d) => !(Number.isFinite(d.t) && d.t > 0))) bad('Every time must be above 0.');
  const failures = data.filter((d) => d.failed);
  const r = failures.length;
  if (r < 2) bad('At least 2 failures are needed to fit a Weibull.');
  if (!(level > 0 && level < 1)) bad('The confidence level must be between 0% and 100%.');
  // Scale times for numerical safety, then scale η back.
  const scale = Math.max(...data.map((d) => d.t));
  const xs = data.map((d) => ({ t: d.t / scale, failed: d.failed }));
  const meanLnF = xs.filter((d) => d.failed).reduce((s, d) => s + Math.log(d.t), 0) / r;
  const g = (b: number) => {
    let sb = 0;
    let sbl = 0;
    for (const d of xs) { const p = d.t ** b; sb += p; sbl += p * Math.log(d.t); }
    return sbl / sb - 1 / b - meanLnF;
  };
  let lo = 0.01;
  let hi = 100;
  if (g(lo) * g(hi) > 0) bad('The Weibull fit did not converge for these times.');
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (g(lo) * g(mid) <= 0) hi = mid; else lo = mid;
  }
  const beta = (lo + hi) / 2;
  const eta = scale * (xs.reduce((s, d) => s + d.t ** beta, 0) / r) ** (1 / beta);
  // Observed information by central differences of the log-likelihood.
  const p = [beta, eta];
  const h = [beta * 1e-4, eta * 1e-4];
  const f = (b: number, e: number) => weibullLogLik(b, e, data);
  const H = [[0, 0], [0, 0]];
  for (let i = 0; i < 2; i++) {
    for (let j = 0; j < 2; j++) {
      const at = (si: number, sj: number) => { const q = [...p]; q[i]! += si * h[i]!; q[j]! += sj * h[j]!; return f(q[0]!, q[1]!); };
      H[i]![j] = (at(1, 1) - at(1, -1) - at(-1, 1) + at(-1, -1)) / (4 * h[i]! * h[j]!);
    }
  }
  const [a, b2, c, d] = [-H[0]![0]!, -H[0]![1]!, -H[1]![0]!, -H[1]![1]!];
  const det = a * d - b2 * c;
  const varB = d / det;
  const varE = a / det;
  const z = normalQuantile(1 - (1 - level) / 2);
  const kb = Math.exp((z * Math.sqrt(varB)) / beta);
  const ke = Math.exp((z * Math.sqrt(varE)) / eta);
  const b10 = eta * (-Math.log(0.9)) ** (1 / beta);
  const betaBounds: [number, number] = [beta / kb, beta * kb];
  const etaBounds: [number, number] = [eta / ke, eta * ke];
  // Plot positions: Johnson's adjusted ranks with Bernard's median rank.
  const sorted = [...data].sort((x, y) => x.t - y.t || Number(y.failed) - Number(x.failed));
  const N = sorted.length;
  let prev = 0;
  const plot: Array<{ t: number; f: number }> = [];
  sorted.forEach((d, idx) => {
    if (!d.failed) return;
    const inc = (N + 1 - prev) / (1 + (N - idx));
    prev += inc;
    plot.push({ t: d.t, f: (prev - 0.3) / (N + 0.4) });
  });
  const shape = betaBounds[0] <= 1 && betaBounds[1] >= 1
    ? 'β is about 1: failures look random, so replacing on a schedule would not prevent them; look for causes or condition checks instead'
    : beta < 1 ? 'β is below 1: failures come early in life, which points at fitting, quality or rebuild problems'
      : 'β is above 1: the item wears out, so a planned replacement or inspection interval can prevent failures';
  const warnings = [
    ...(r < 5 ? [`Only ${r} failures: the bounds are very wide; treat the result as a first look.`] : []),
    ...(data.length - r > 0 ? [] : ['No suspensions: if some items are still running, add their hours as suspensions or the life will look too short.']),
  ];
  return {
    beta, eta, betaBounds, etaBounds, b10, plot, warnings,
    values: { beta, eta, betaLower: betaBounds[0], betaUpper: betaBounds[1], etaLower: etaBounds[0], etaUpper: etaBounds[1], b10, failures: r, suspensions: data.length - r },
    sentence: `${shape}. Characteristic life η is ${n0(eta)} h (63% have failed by then); 10% fail by ${n0(b10)} h (B10).`,
  };
}

/** SMU hours at a time: the last reading at or before it, else the first after it. */
function smuAt(readings: SmuReading[], at: Iso): number | undefined {
  const t = Date.parse(at);
  let before: SmuReading | undefined;
  let after: SmuReading | undefined;
  for (const r of readings) {
    const rt = Date.parse(r.at);
    if (rt <= t) { if (!before || rt > Date.parse(before.at)) before = r; } else if (!after || rt < Date.parse(after.at)) after = r;
  }
  return (before ?? after)?.hours;
}

/**
 * C-05 "Use my data". For each unit, the operating hours (SMU) between failures are failed lives,
 * and the hours from the last failure (or the start) to the end are a suspension. Assumes each
 * repair makes the item as good as new. `failures` are the failure events in the filter.
 */
export function lifeData(failures: DowntimeEvent[], unitIds: string[], smu: SmuReading[], from: Iso, to: Iso): LifeTime[] {
  const out: LifeTime[] = [];
  for (const unitId of unitIds) {
    const readings = smu.filter((r) => r.unitId === unitId);
    if (!readings.length) continue;
    let prev = smuAt(readings, from);
    if (prev === undefined) continue;
    const mine = failures.filter((e) => e.unitId === unitId && e.isFailure).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    for (const e of mine) {
      const at = smuAt(readings, e.start);
      if (at === undefined) continue;
      if (at > prev) out.push({ t: at - prev, failed: true });
      prev = Math.max(prev, at);
    }
    const end = smuAt(readings, to);
    if (end !== undefined && end > prev) out.push({ t: end - prev, failed: false });
  }
  return out;
}

// ---------- C-06 conditional Weibull ----------

export function conditionalWeibull(i: { beta: number; eta: number; age: number; mission: number }): CalcOutput {
  positive(i.beta, 'β'); positive(i.eta, 'η');
  if (!(i.age >= 0)) bad('Age must be 0 or more.');
  if (!(i.mission > 0)) bad('Hours ahead must be above 0.');
  const { beta: b, eta: e, age: T, mission: t } = i;
  const R = Math.exp(-(((T + t) / e) ** b) + (T / e) ** b);
  const median = e * ((T / e) ** b + Math.LN2) ** (1 / b) - T;
  return { values: { reliability: R, medianRemaining: median }, sentence: `An item already at ${n0(T)} h has a ${pct(R)} chance of running another ${n0(t)} h without failing; half of such items fail within ${n0(median)} more hours.`, warnings: [] };
}

/** Survival curve R(t | age) for a chart, from 0 to `to` hours ahead. */
export function conditionalCurve(beta: number, eta: number, age: number, to: number, steps = 40): Array<{ t: number; r: number }> {
  return Array.from({ length: steps + 1 }, (_, k) => { const t = (to * k) / steps; return { t, r: Math.exp(-(((age + t) / eta) ** beta) + (age / eta) ** beta) }; });
}

// ---------- C-07 repair times ----------

/** Linear interpolation between ranks (Excel PERCENTILE.INC). */
export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  const x = (sorted.length - 1) * p;
  const lo = Math.floor(x);
  const hi = Math.ceil(x);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (x - lo);
}

export function repairTimes(hours: number[]): CalcOutput & { histogram: Array<{ from: number; to: number; n: number }> } {
  const s = hours.filter((h) => Number.isFinite(h) && h >= 0).sort((a, b) => a - b);
  if (!s.length) bad('No repair times.');
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  const median = percentile(s, 0.5);
  const p90 = percentile(s, 0.9);
  const top = s[s.length - 1]!;
  const width = top <= 0 ? 1 : [0.5, 1, 2, 4, 8, 12, 24, 48, 96].find((w) => top / w <= 12) ?? Math.ceil(top / 12);
  const histogram = Array.from({ length: Math.max(1, Math.ceil((top + 1e-9) / width)) }, (_, k) => ({ from: k * width, to: (k + 1) * width, n: 0 }));
  for (const h of s) histogram[Math.min(histogram.length - 1, Math.floor(h / width))]!.n++;
  const warnings = s.length < 10 ? [`Only ${s.length} repairs: the 90th percentile is rough.`] : [];
  const skew = mean > median * 1.5 ? ' The mean is well above the median, so a few long repairs pull the average up; look at those first.' : '';
  return { values: { count: s.length, mean, median, p90 }, histogram, warnings, sentence: `Half of the repairs took ${n1(median)} h or less and 9 in 10 took ${n1(p90)} h or less (mean ${n1(mean)} h).${skew}` };
}

/** C-07 by system: median and 90th percentile for each system with at least `min` repairs. */
export function repairBySystem(rows: Array<{ system: string; hours: number }>, min = 5): Array<{ system: string; count: number; median: number; p90: number }> {
  const by = new Map<string, number[]>();
  for (const r of rows) by.set(r.system, [...(by.get(r.system) ?? []), r.hours]);
  return [...by].filter(([, h]) => h.length >= min)
    .map(([system, h]) => { const s = [...h].sort((a, b) => a - b); return { system, count: s.length, median: percentile(s, 0.5), p90: percentile(s, 0.9) }; })
    .sort((a, b) => b.p90 - a.p90);
}

// ---------- C-08 risk matrix ----------

export const RISK_BANDS = [
  { band: 'Low', max: 4 }, { band: 'Medium', max: 9 }, { band: 'High', max: 16 }, { band: 'Extreme', max: 25 },
] as const;

export function riskMatrix(i: { likelihood: number; consequence: number }): CalcOutput & { band: string } {
  for (const [k, v] of Object.entries(i)) if (!(Number.isInteger(v) && v >= 1 && v <= 5)) bad(`${k[0]!.toUpperCase()}${k.slice(1)} must be 1 to 5.`);
  const score = i.likelihood * i.consequence;
  const band = RISK_BANDS.find((b) => score <= b.max)!.band;
  return { values: { score }, band, sentence: `Likelihood ${i.likelihood} × consequence ${i.consequence} = ${score}: ${band} risk.`, warnings: [] };
}

// ---------- C-09 cost per hour of life ----------

export function costPerHour(i: { purchase: number; fitting: number; rebuilds: number[]; hours: number }): CalcOutput {
  positive(i.hours, 'Hours of life');
  if (![i.purchase, i.fitting, ...i.rebuilds].every((x) => Number.isFinite(x) && x >= 0)) bad('Costs must be 0 or more.');
  const total = i.purchase + i.fitting + i.rebuilds.reduce((a, b) => a + b, 0);
  const perHour = total / i.hours;
  return { values: { total, perHour }, sentence: `Over ${n0(i.hours)} h the component cost ${money(total)} in all, which is ${money(perHour)} per hour of life.`, warnings: [] };
}

// ---------- C-10 MTBF and failure rate ----------

export function mtbfRate(i: { mtbf: number; mission: number }): CalcOutput {
  positive(i.mtbf, 'MTBF');
  if (!(i.mission >= 0)) bad('Mission hours must be 0 or more.');
  const lambda = 1 / i.mtbf;
  const R = Math.exp(-i.mission / i.mtbf);
  return { values: { lambda, perMillion: 1e6 / i.mtbf, reliability: R }, sentence: `An MTBF of ${n1(i.mtbf)} h is ${n1(1e6 / i.mtbf)} failures per million hours; the chance of getting through ${n1(i.mission)} h with no failure is ${pct(R)} if the failure rate is constant.`, warnings: [] };
}

// ---------- catalogue ----------

export type CalculatorId = 'inherent_availability' | 'availability_target' | 'downtime_cost' | 'mtbf_confidence' | 'weibull' | 'conditional_weibull' | 'repair_times' | 'risk_matrix' | 'cost_per_hour' | 'mtbf_rate';

export interface CalculatorInfo { id: CalculatorId; code: string; group: string; name: string; question: string; usesData: boolean; formula: string; version: number }

/** The version goes up when a formula changes, so saved results say which one they used. */
export const CALCULATORS: CalculatorInfo[] = [
  { id: 'inherent_availability', code: 'C-01', group: 'Availability and time', name: 'Inherent availability', question: 'What availability do our failure and repair times allow?', usesData: true, formula: 'Ai = MTBF ÷ (MTBF + MTTR)', version: 1 },
  { id: 'availability_target', code: 'C-02', group: 'Availability and time', name: 'Availability target solver', question: 'What MTBF or repair time do we need to hit a target?', usesData: true, formula: 'MTBF = A × MTTR ÷ (1 − A);  MTTR = MTBF × (1 − A) ÷ A', version: 1 },
  { id: 'downtime_cost', code: 'C-03', group: 'Availability and time', name: 'Cost of downtime per hour', question: 'What does an hour down cost us?', usesData: false, formula: 'cost/h = t/h × margin/t + other costs/h', version: 1 },
  { id: 'mtbf_confidence', code: 'C-04', group: 'Failure and life data', name: 'Field MTBF with lower confidence limit', question: 'How sure can we be about our MTBF?', usesData: true, formula: 'MTBF = T ÷ r;  lower = 2T ÷ χ²(C; 2r + 2)', version: 1 },
  { id: 'weibull', code: 'C-05', group: 'Failure and life data', name: 'Weibull with suspensions', question: 'Is it wearing out, failing early or failing at random?', usesData: true, formula: 'F(t) = 1 − exp(−(t/η)^β), fitted by maximum likelihood with suspensions', version: 1 },
  { id: 'conditional_weibull', code: 'C-06', group: 'Failure and life data', name: 'Conditional Weibull (remaining life)', question: 'How much longer will a component that is already at X hours last?', usesData: true, formula: 'R(t | T) = exp(−((T + t)/η)^β + (T/η)^β)', version: 1 },
  { id: 'repair_times', code: 'C-07', group: 'Maintainability', name: 'Repair time distribution', question: 'How long do repairs usually take, and how long do the long ones take?', usesData: true, formula: 'Mean, median and 90th percentile (linear between ranks)', version: 1 },
  { id: 'risk_matrix', code: 'C-08', group: 'Prioritisation', name: 'Risk matrix', question: 'How serious is this risk?', usesData: false, formula: 'score = likelihood × consequence (1 to 5 each)', version: 1 },
  { id: 'cost_per_hour', code: 'C-09', group: 'Cost', name: 'Cost per hour of component life', question: 'What does a component cost per hour it runs?', usesData: false, formula: '(purchase + fitting + rebuilds) ÷ hours of life', version: 1 },
  { id: 'mtbf_rate', code: 'C-10', group: 'Converters', name: 'MTBF and failure rate', question: 'What failure rate is this MTBF, and what are the odds of getting through a shift?', usesData: false, formula: 'λ = 1 ÷ MTBF;  R(t) = exp(−t ÷ MTBF)', version: 1 },
];

/** Search by name, code, group or question; every word must match. */
export function searchCalculators(q: string): CalculatorInfo[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return CALCULATORS.filter((c) => words.every((w) => `${c.code} ${c.name} ${c.group} ${c.question}`.toLowerCase().includes(w)));
}

// ---------- saved analyses ----------

export interface SavedAnalysis {
  id: string;
  calculator: CalculatorId;
  version: number;
  title: string;
  inputs: unknown;
  result: Record<string, number | null>;
  sentence: string;
  /** What platform data was used: the filter and period, or "typed in". */
  dataNote: string;
  links: { unitId?: string; projectId?: string; rcaId?: string };
  createdBy: string;
  createdAt: Iso;
  voidedBy?: string;
  voidedAt?: Iso;
  voidReason?: string;
}

type Ok = { ok: true; records: SavedAnalysis[]; audit: AuditEntry[]; warnings: string[] };
type No = { ok: false; errors: string[] };

export function saveAnalysis(ctx: ConsoleContext, list: SavedAnalysis[], a: Omit<SavedAnalysis, 'id' | 'createdBy' | 'createdAt' | 'version'>): Ok | No {
  if (!can(ctx.actor, 'run_analyses')) return { ok: false, errors: ['Your role cannot save analyses.'] };
  if (!a.title.trim()) return { ok: false, errors: ['Give it a title.'] };
  const info = CALCULATORS.find((c) => c.id === a.calculator);
  if (!info) return { ok: false, errors: ['Unknown calculator.'] };
  const rec: SavedAnalysis = { ...a, title: a.title.trim(), id: ctx.newId(), version: info.version, createdBy: ctx.actor.userId, createdAt: ctx.now };
  return { ok: true, records: [...list, rec], audit: [{ at: ctx.now, userId: ctx.actor.userId, action: 'save_analysis', entity: 'analysis', entityId: rec.id, before: null, after: rec }], warnings: [] };
}

export function voidAnalysis(ctx: ConsoleContext, list: SavedAnalysis[], id: string, reason: string): Ok | No {
  const a = list.find((x) => x.id === id);
  if (!a || a.voidedAt) return { ok: false, errors: ['Not found.'] };
  if (!can(ctx.actor, 'run_analyses')) return { ok: false, errors: ['Your role cannot void analyses.'] };
  if (!reason.trim()) return { ok: false, errors: ['Give a reason.'] };
  const after = { ...a, voidedBy: ctx.actor.userId, voidedAt: ctx.now, voidReason: reason.trim() };
  return { ok: true, records: list.map((x) => (x.id === id ? after : x)), audit: [{ at: ctx.now, userId: ctx.actor.userId, action: 'void_analysis', entity: 'analysis', entityId: id, before: a, after, reason: reason.trim() }], warnings: [] };
}
