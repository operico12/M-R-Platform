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

// ---------- C-11 rebuild or replace ----------

export function rebuildOrReplace(i: { rebuildPrice: number; rebuildLife: number; newPrice: number; newLife: number; changeoutHours: number; costPerDownHour: number; coreCredit: number; hoursPerYear: number }): CalcOutput {
  positive(i.rebuildLife, 'Expected life after rebuild'); positive(i.newLife, 'Expected new life'); positive(i.hoursPerYear, 'Operating hours a year');
  if (![i.rebuildPrice, i.newPrice, i.changeoutHours, i.costPerDownHour, i.coreCredit].every((x) => Number.isFinite(x) && x >= 0)) bad('Prices, hours and credits must be 0 or more.');
  const changeout = i.changeoutHours * i.costPerDownHour;
  const rebuildCost = i.rebuildPrice + changeout;
  const replaceCost = i.newPrice + changeout - i.coreCredit;
  if (!(replaceCost > 0)) bad('The core credit is more than the new price and change-out together.');
  const rebuildPerHour = rebuildCost / i.rebuildLife;
  const replacePerHour = replaceCost / i.newLife;
  const breakEvenLife = rebuildCost / replacePerHour;
  const annualDifference = Math.abs(rebuildPerHour - replacePerHour) * i.hoursPerYear;
  const winner = rebuildPerHour < replacePerHour ? 'Rebuild' : rebuildPerHour > replacePerHour ? 'Replace' : 'Either';
  const sentence = winner === 'Either'
    ? `Both cost ${money(rebuildPerHour)} per hour of life.`
    : `${winner} is cheaper: ${money(rebuildPerHour)} per hour rebuilt vs ${money(replacePerHour)} new, about ${money(annualDifference)} a year at ${n0(i.hoursPerYear)} h. A rebuild has to last ${n0(breakEvenLife)} h to match a new one.`;
  return { values: { rebuildPerHour, replacePerHour, breakEvenLife, annualDifference }, sentence, warnings: i.changeoutHours === 0 ? ['Change-out hours are 0: the downtime cost of each change is left out.'] : [] };
}

// ---------- C-12 to C-15 maintenance strategy (RCM, docs/rcm.md) ----------

export function pfInterval(i: { pf: number; checks: number; leadTime: number }): CalcOutput {
  positive(i.pf, 'P-F interval');
  if (!(Number.isFinite(i.checks) && i.checks >= 1)) bad('Checks inside the P-F interval must be 1 or more.');
  if (!(Number.isFinite(i.leadTime) && i.leadTime >= 0)) bad('Lead time must be 0 or more.');
  if (i.leadTime >= i.pf) bad('The lead time is as long as the P-F interval or longer: the warning comes too late to act on, whatever the interval.');
  const byChecks = i.pf / i.checks;
  const byLead = i.pf - i.leadTime;
  const interval = Math.min(byChecks, byLead);
  const why = byLead < byChecks ? `to leave the ${n0(i.leadTime)} h lead time` : `${i.checks} check${i.checks === 1 ? '' : 's'} inside the P-F interval`;
  return { values: { interval, byChecks, byLead }, sentence: `Check every ${n0(interval)} h (${why}). A warning is then found with at least ${n0(i.pf - interval)} h left before the failure.`, warnings: i.checks < 2 ? ['One check per P-F interval can find the warning too late. Two or more is usual.'] : [] };
}

const weibullR = (t: number, b: number, e: number) => Math.exp(-((t / e) ** b));

/** ∫₀ᵀ R(t) dt by Simpson's rule. */
function meanCycle(T: number, b: number, e: number, steps = 400): number {
  const h = T / steps;
  let s = weibullR(0, b, e) + weibullR(T, b, e);
  for (let k = 1; k < steps; k++) s += (k % 2 ? 4 : 2) * weibullR(k * h, b, e);
  return (s * h) / 3;
}

const replacementCost = (T: number, b: number, e: number, cp: number, cu: number) => {
  const R = weibullR(T, b, e);
  return (cp * R + cu * (1 - R)) / meanCycle(T, b, e);
};

export const weibullMean = (beta: number, eta: number) => eta * Math.exp(logGamma(1 + 1 / beta));

/** The age with the lowest cost per hour, by a coarse search then golden-section search. */
export function optimalAge(beta: number, eta: number, cp: number, cu: number): { age: number; cost: number } {
  const f = (T: number) => replacementCost(T, beta, eta, cp, cu);
  const lo0 = eta / 200;
  const hi0 = eta * 4;
  let best = lo0;
  let bestC = Infinity;
  const n = 200;
  for (let k = 0; k <= n; k++) {
    const T = lo0 * (hi0 / lo0) ** (k / n);
    const c = f(T);
    if (c < bestC) { bestC = c; best = T; }
  }
  let a = best / (hi0 / lo0) ** (1 / n);
  let d = best * (hi0 / lo0) ** (1 / n);
  const g = (Math.sqrt(5) - 1) / 2;
  let x1 = d - g * (d - a);
  let x2 = a + g * (d - a);
  let f1 = f(x1);
  let f2 = f(x2);
  for (let k = 0; k < 80 && d - a > 1e-6 * eta; k++) {
    if (f1 < f2) { d = x2; x2 = x1; f2 = f1; x1 = d - g * (d - a); f1 = f(x1); } else { a = x1; x1 = x2; f1 = f2; x2 = a + g * (d - a); f2 = f(x2); }
  }
  const age = (a + d) / 2;
  return { age, cost: f(age) };
}

export function optimalReplacement(i: { beta: number; eta: number; plannedCost: number; failureCost: number }): CalcOutput {
  positive(i.beta, 'β'); positive(i.eta, 'η'); positive(i.plannedCost, 'Cost of a planned replacement'); positive(i.failureCost, 'Cost of a failure');
  const mtbf = weibullMean(i.beta, i.eta);
  const rtf = i.failureCost / mtbf;
  if (i.beta <= 1) return { values: { age: null, costPerHour: null, survive: null, runToFailure: rtf, mtbf }, sentence: `β is ${i.beta.toFixed(2)}: the failure rate does not rise with age, so replacing on age does not help. Run to failure costs ${money(rtf)} an hour.`, warnings: ['β of 1 or less: no optimal replacement age.'] };
  if (i.failureCost <= i.plannedCost) return { values: { age: null, costPerHour: null, survive: null, runToFailure: rtf, mtbf }, sentence: `A failure costs no more than a planned change, so replacing early cannot save money. Run to failure costs ${money(rtf)} an hour.`, warnings: ['The cost of a failure must be more than the cost of a planned replacement.'] };
  const { age, cost } = optimalAge(i.beta, i.eta, i.plannedCost, i.failureCost);
  const survive = weibullR(age, i.beta, i.eta);
  const warnings = age > 3 * i.eta ? ['The best age is far past η: replacing on age saves very little.'] : [];
  return { values: { age, costPerHour: cost, survive, runToFailure: rtf, mtbf }, sentence: `Replace at ${n0(age)} h for the lowest cost, ${money(cost)} an hour, against ${money(rtf)} an hour run to failure. ${pct(survive)} of items reach that age without failing.`, warnings };
}

export function failureFindingInterval(i: { mtbf: number; unavailability: number }): CalcOutput {
  positive(i.mtbf, 'MTBF of the protective device');
  if (!(i.unavailability > 0 && i.unavailability < 1)) bad('Tolerated unavailability must be between 0% and 100%.');
  const ffi = 2 * i.unavailability * i.mtbf;
  const x = ffi / i.mtbf;
  const exact = 1 - (1 - Math.exp(-x)) / x;
  return { values: { ffi, exact }, sentence: `Check the device every ${n0(ffi)} h. It is then failed without anyone knowing about ${pct(exact, 2)} of the time.`, warnings: x > 0.2 ? ['The interval is long compared with the MTBF, so the simple formula is less accurate; use the exact unavailability shown.'] : [] };
}

export function strategyCost(i: { beta: number; eta: number; failureCost: number; plannedCost: number; inspectionCost: number; inspectionInterval: number; detection: number; repairCost: number }): CalcOutput {
  positive(i.beta, 'β'); positive(i.eta, 'η'); positive(i.failureCost, 'Cost of a failure'); positive(i.inspectionInterval, 'Inspection interval');
  if (![i.plannedCost, i.inspectionCost, i.repairCost].every((x) => Number.isFinite(x) && x >= 0)) bad('Costs must be 0 or more.');
  if (!(i.detection >= 0 && i.detection <= 1)) bad('The chance of finding the warning must be between 0% and 100%.');
  const mtbf = weibullMean(i.beta, i.eta);
  const rtf = i.failureCost / mtbf;
  const tb = i.beta > 1 && i.failureCost > i.plannedCost && i.plannedCost > 0 ? optimalAge(i.beta, i.eta, i.plannedCost, i.failureCost) : null;
  const cbm = i.inspectionCost / i.inspectionInterval + (i.detection * i.repairCost + (1 - i.detection) * i.failureCost) / mtbf;
  const options: Array<[string, number]> = [['Run to failure', rtf], ['Condition-based', cbm]];
  if (tb) options.push(['Time-based', tb.cost]);
  options.sort((a, b) => a[1] - b[1]);
  const [best, second] = options;
  const warnings = tb ? [] : ['Time-based replacement is left out: it needs β above 1 and a failure that costs more than a planned change.'];
  return {
    values: { runToFailure: rtf, timeBased: tb?.cost ?? null, timeBasedAge: tb?.age ?? null, conditionBased: cbm, mtbf },
    sentence: `${best![0]} is cheapest at ${money(best![1])} an hour, against ${money(second![1])} for ${second![0].toLowerCase()}.${tb ? ` Time-based replaces at ${n0(tb.age)} h.` : ''}`,
    warnings,
  };
}

// ---------- C-16 to C-19 spares (docs/spares.md) ----------

/** Poisson probabilities for a mean m, summed in log form so large means work. */
export interface PoissonTable { mean: number; pmf: number[]; cdf: (k: number) => number; fill: (s: number) => number; ebo: (s: number) => number; leftover: (q: number) => number; quantile: (p: number) => number }

export function poisson(mean: number): PoissonTable {
  if (!(Number.isFinite(mean) && mean >= 0)) bad('The mean demand must be 0 or more.');
  if (mean > 100_000) bad('The mean demand is above 100,000: too large to size one part at a time.');
  const top = Math.ceil(mean + 12 * Math.sqrt(mean) + 30);
  const pmf: number[] = [];
  for (let n = 0; n <= top; n++) pmf.push(mean === 0 ? (n === 0 ? 1 : 0) : Math.exp(n * Math.log(mean) - mean - logGamma(n + 1)));
  const cum: number[] = [];
  pmf.reduce((a, p, n) => (cum[n] = a + p), 0);
  const cdf = (k: number) => (k < 0 ? 0 : k >= top ? 1 : Math.min(1, cum[Math.floor(k)]!));
  const ebo = (s: number) => { let e = 0; for (let n = Math.max(0, Math.floor(s) + 1); n <= top; n++) e += (n - s) * pmf[n]!; return e; };
  const leftover = (q: number) => { let e = 0; for (let n = 0; n <= Math.min(q, top); n++) e += (q - n) * pmf[n]!; return e; };
  const quantile = (p: number) => { let k = 0; while (cdf(k) < p && k <= top) k++; return k; };
  return { mean, pmf, cdf, fill: (s: number) => (s <= 0 ? 0 : cdf(s - 1)), ebo, leftover, quantile };
}

/** The smallest stock s with a fill rate P(N ≤ s − 1) at or above the target. */
export const stockForFill = (t: PoissonTable, target: number) => t.quantile(target) + 1;

const fillTarget = (x: number, name = 'Target fill rate') => { if (!(x > 0 && x < 1)) bad(`${name} must be between 0% and 100%.`); };

export interface StockCurveRow { s: number; fill: number; noStockout: number; ebo: number }
const stockCurve = (t: PoissonTable, upto: number): StockCurveRow[] => Array.from({ length: upto + 1 }, (_, s) => ({ s, fill: t.fill(s), noStockout: t.cdf(s), ebo: t.ebo(s) }));

export function poissonSpares(i: { perYear: number; leadDays: number; target: number; unitCost?: number }): CalcOutput & { curve: StockCurveRow[] } {
  if (!(Number.isFinite(i.perYear) && i.perYear >= 0)) bad('Uses a year must be 0 or more.');
  positive(i.leadDays, 'Lead time');
  fillTarget(i.target);
  if (i.unitCost !== undefined && !(Number.isFinite(i.unitCost) && i.unitCost >= 0)) bad('Unit cost must be 0 or more.');
  const t = poisson((i.perYear * i.leadDays) / 365);
  const s = i.perYear === 0 ? 0 : stockForFill(t, i.target);
  const value = i.unitCost === undefined ? null : s * i.unitCost;
  const warnings: string[] = [];
  if (i.perYear === 0) warnings.push('No uses expected: stock nothing unless it is an insurance spare.');
  else if (t.mean < 0.05) warnings.push('Fewer than 0.05 uses in a lead time: a slow mover. Keeping one is an insurance decision, from the consequence of not having it.');
  return {
    values: { onOrderMean: t.mean, stock: s, fill: s ? t.fill(s) : null, noStockout: t.cdf(s), ebo: t.ebo(s), stockValue: value },
    sentence: i.perYear === 0 ? 'No uses expected, so no stock is needed for demand.' : `Keep ${s} on the shelf and on order, and order one each time one is used. A part is then on the shelf ${pct(t.fill(s), 1)} of the times one is needed${value !== null ? `, for ${money(value)} of stock` : ''}.`,
    warnings,
    curve: stockCurve(t, Math.max(s + 3, Math.ceil(t.mean + 3 * Math.sqrt(t.mean)) + 1)),
  };
}

export function rebuildPool(i: { perYear: number; cycleDays: number; target: number; carryingCost?: number; costPerDownHour?: number }): CalcOutput & { curve: Array<StockCurveRow & { downHours: number; total: number | null }> } {
  positive(i.perYear, 'Change-outs a year');
  positive(i.cycleDays, 'Repair cycle');
  fillTarget(i.target);
  const costs = i.carryingCost !== undefined && i.costPerDownHour !== undefined;
  if (costs && !([i.carryingCost!, i.costPerDownHour!].every((x) => Number.isFinite(x) && x >= 0))) bad('Costs must be 0 or more.');
  const t = poisson((i.perYear * i.cycleDays) / 365);
  const s = stockForFill(t, i.target);
  const upto = Math.max(s + 3, Math.ceil(t.mean + 4 * Math.sqrt(t.mean)) + 2);
  const curve = stockCurve(t, upto).map((r) => ({ ...r, downHours: r.ebo * 8760, total: costs ? r.s * i.carryingCost! + r.ebo * 8760 * i.costPerDownHour! : null }));
  let best: (typeof curve)[number] | null = null;
  if (costs) {
    // Total cost is convex in s (EBO is convex), so walk up until it rises.
    let k = 0;
    const total = (x: number) => x * i.carryingCost! + t.ebo(x) * 8760 * i.costPerDownHour!;
    while (total(k + 1) < total(k)) k++;
    best = { s: k, fill: t.fill(k), noStockout: t.cdf(k), ebo: t.ebo(k), downHours: t.ebo(k) * 8760, total: total(k) };
    if (!curve.some((r) => r.s === k)) curve.push(best);
  }
  const at = curve.find((r) => r.s === s)!;
  return {
    values: { onOrderMean: t.mean, pool: s, fill: t.fill(s), ebo: t.ebo(s), waitDays: t.ebo(s) * 365, downHours: t.ebo(s) * 8760, totalAtTarget: at.total, bestPool: best?.s ?? null, bestTotal: best?.total ?? null },
    sentence: `A pool of ${s} has a spare ready for ${pct(t.fill(s))} of change-outs, with about ${n1(t.ebo(s) * 365)} unit-days a year waiting.${best ? ` The lowest total cost is a pool of ${best.s}, at ${money(best.total!)} a year.` : ''}`,
    warnings: t.mean > 0 && i.cycleDays > 365 ? ['The repair cycle is over a year: check the dates in the component history.'] : [],
    curve,
  };
}

export interface KitPart { item: string; qty: number; leadDays: number; unitCost?: number; description?: string }
export interface KitPartResult extends KitPart { mean: number; kits: number; stock: number; fill: number; value: number | null }

export function kitStocking(i: { perYear: number; target: number; parts: KitPart[] }): CalcOutput & { parts: KitPartResult[] } {
  positive(i.perYear, 'Kit uses a year');
  fillTarget(i.target, 'Target kit fill rate');
  if (!i.parts.length) bad('Add at least one part.');
  if (i.parts.length > 60) bad('A kit can have up to 60 parts.');
  const seen = new Set<string>();
  i.parts.forEach((p, n) => {
    const name = p.item.trim() || `Part ${n + 1}`;
    if (!p.item.trim()) bad(`Part ${n + 1} needs an item number.`);
    if (seen.has(p.item.trim().toUpperCase())) bad(`${name} is listed twice: add the quantities into one line.`);
    seen.add(p.item.trim().toUpperCase());
    if (!(Number.isFinite(p.qty) && p.qty > 0)) bad(`${name}: quantity per kit must be above 0.`);
    if (!(Number.isFinite(p.leadDays) && p.leadDays > 0)) bad(`${name}: lead time must be above 0 days.`);
    if (p.unitCost !== undefined && !(Number.isFinite(p.unitCost) && p.unitCost >= 0)) bad(`${name}: unit cost must be 0 or more.`);
  });
  const tabs = i.parts.map((p) => poisson((i.perYear * p.leadDays) / 365));
  const price = i.parts.map((p) => p.qty * (p.unitCost === undefined || p.unitCost === 0 ? 1 : p.unitCost));
  const k = i.parts.map(() => 1);
  const logF = (j: number, x: number) => Math.log(Math.max(tabs[j]!.fill(x), 1e-300));
  let logProd = k.reduce((a, x, j) => a + logF(j, x), 0);
  const goal = Math.log(i.target);
  for (let step = 0; logProd < goal - 1e-12; step++) {
    if (step > 100_000) bad('Could not reach the target: check the inputs.');
    let best = 0;
    let bestGain = -Infinity;
    k.forEach((x, j) => {
      const g = (logF(j, x + 1) - logF(j, x)) / price[j]!;
      if (g > bestGain) { bestGain = g; best = j; }
    });
    logProd += logF(best, k[best]! + 1) - logF(best, k[best]!);
    k[best]! += 1;
  }
  const parts: KitPartResult[] = i.parts.map((p, j) => ({ ...p, mean: tabs[j]!.mean, kits: k[j]!, stock: k[j]! * p.qty, fill: tabs[j]!.fill(k[j]!), value: p.unitCost === undefined ? null : k[j]! * p.qty * p.unitCost }));
  const lower = parts.reduce((a, p) => a * p.fill, 1);
  const upper = Math.min(...parts.map((p) => p.fill));
  const costed = parts.every((p) => p.value !== null);
  const value = costed ? parts.reduce((a, p) => a + p.value!, 0) : null;
  const warnings = costed ? [] : ['Some parts have no unit cost: they are sized as if every part cost the same, and the stock value is left out.'];
  return {
    values: { kitFillLower: lower, kitFillUpper: upper, stockValue: value, partsCount: parts.length },
    sentence: `With this stock a whole kit is on the shelf for at least ${pct(lower)} of uses (at most ${pct(upper)})${value !== null ? `, for ${money(value)} of stock` : ''}.`,
    warnings,
    parts,
  };
}

/** Expected total uses over the years left, with a steady yearly change g. */
export const lifetimeDemand = (perYear: number, years: number, change: number) => (Math.abs(change) < 1e-12 ? perYear * years : (perYear * ((1 + change) ** years - 1)) / Math.log(1 + change));

export function lifetimeBuy(i: { perYear: number; years: number; change: number; confidence: number; onHand: number; unitCost: number; salvage?: number; shortageCost?: number }): CalcOutput & { curve: Array<{ q: number; cdf: number }> } {
  positive(i.perYear, 'Uses a year now');
  positive(i.years, 'Years left');
  if (!(Number.isFinite(i.change) && i.change > -1 && i.change <= 1)) bad('The yearly change must be between −100% and +100%.');
  fillTarget(i.confidence, 'Confidence');
  if (!(Number.isFinite(i.onHand) && i.onHand >= 0)) bad('On hand must be 0 or more.');
  if (!(Number.isFinite(i.unitCost) && i.unitCost >= 0)) bad('Unit cost must be 0 or more.');
  const mean = lifetimeDemand(i.perYear, i.years, i.change);
  const t = poisson(mean);
  const q = t.quantile(i.confidence);
  const buy = Math.max(0, q - Math.floor(i.onHand));
  let costQ: number | null = null;
  let ratio: number | null = null;
  const warnings: string[] = [];
  if (i.shortageCost !== undefined) {
    const salvage = i.salvage ?? 0;
    if (!(Number.isFinite(i.shortageCost) && i.shortageCost > i.unitCost)) bad('The cost of being short of one must be more than the unit cost.');
    if (!(Number.isFinite(salvage) && salvage >= 0 && salvage < i.unitCost)) bad('Salvage must be 0 or more and below the unit cost.');
    const under = i.shortageCost - i.unitCost;
    const over = i.unitCost - salvage;
    ratio = under / (under + over);
    costQ = t.quantile(ratio);
  }
  if (i.onHand > q) warnings.push(`On hand (${n0(i.onHand)}) is already more than the ${n0(q)} needed.`);
  const top = Math.max(q, costQ ?? 0) + Math.ceil(3 * Math.sqrt(mean)) + 2;
  return {
    values: { demandMean: mean, needTotal: q, buy, buyCost: buy * i.unitCost, leftover: t.leftover(q), short: t.ebo(q), ratio, costTotal: costQ, costBuy: costQ === null ? null : Math.max(0, costQ - Math.floor(i.onHand)) },
    sentence: `Expect ${n1(mean)} uses to the end. Buy ${n0(buy)} (${money(buy * i.unitCost)}) for ${n0(q)} in all, enough ${pct(t.cdf(q))} of the time.${costQ !== null ? ` Balancing the costs of too many and too few gives ${n0(costQ)} in all.` : ''}`,
    warnings,
    curve: Array.from({ length: Math.max(0, top - Math.max(0, Math.floor(mean - 3 * Math.sqrt(mean)) - 2)) + 1 }, (_, j) => { const x = Math.max(0, Math.floor(mean - 3 * Math.sqrt(mean)) - 2) + j; return { q: x, cdf: t.cdf(x) }; }),
  };
}

// ---------- C-20 to C-22 repairable systems ----------

export const chiSquareCdf = (x: number, nu: number) => gammaP(nu / 2, x / 2);
export const normalCdf = (z: number) => 0.5 * erfc(-z / Math.SQRT2);

export type DataEnd = 'time' | 'failure';

function checkTimes(times: number[], end: number | undefined, endsAt: DataEnd, min: number): { t: number[]; T: number; used: number[] } {
  if (times.some((x) => !(Number.isFinite(x) && x > 0))) bad('Failure times must be numbers above 0.');
  const t = [...times].sort((a, b) => a - b);
  if (t.length < min) bad(`Needs at least ${min} failures.`);
  if (endsAt === 'time') {
    if (end === undefined || !(Number.isFinite(end) && end > 0)) bad('Enter the time the data ends.');
    if (end! < t[t.length - 1]!) bad('The data must end at or after the last failure.');
    return { t, T: end!, used: t };
  }
  return { t, T: t[t.length - 1]!, used: t.slice(0, -1) };
}

export function crowAmsaa(i: { times: number[]; end?: number; endsAt: DataEnd; confidence: number; ahead?: number }): CalcOutput & { points: Array<{ t: number; n: number }>; line: Array<{ t: number; n: number }> } {
  if (!(i.confidence > 0 && i.confidence < 1)) bad('Confidence must be between 0% and 100%.');
  const { t, T, used } = checkTimes(i.times, i.end, i.endsAt, i.endsAt === 'time' ? 2 : 3);
  const n = t.length;
  const sumLog = used.reduce((a, x) => a + Math.log(T / x), 0);
  if (!(sumLog > 0)) bad('The failures cannot all be at the end time.');
  const beta = n / sumLog;
  const lambda = n / T ** beta;
  const unbiased = ((i.endsAt === 'time' ? n - 1 : n - 2) / n) * beta;
  const nu = i.endsAt === 'time' ? 2 * n : 2 * (n - 1);
  const lower = (beta * chiSquareQuantile((1 - i.confidence) / 2, nu)) / (2 * n);
  const upper = (beta * chiSquareQuantile((1 + i.confidence) / 2, nu)) / (2 * n);
  const rocof = lambda * beta * T ** (beta - 1);
  const ahead = i.ahead !== undefined && i.ahead > 0 ? lambda * ((T + i.ahead) ** beta - T ** beta) : null;
  const trend = upper < 1 ? 'improving: failures are coming further apart' : lower > 1 ? 'getting worse: failures are coming closer together' : 'not clearly changing: the bounds on β include 1';
  const warnings = n < 5 ? ['Fewer than 5 failures: the bounds are wide.'] : [];
  const lo = Math.min(t[0]!, T) / 2;
  const line = Array.from({ length: 41 }, (_, k) => { const x = lo * (T / lo) ** (k / 40); return { t: x, n: lambda * x ** beta }; });
  return {
    values: { beta, lambdaScale: lambda, betaUnbiased: unbiased, betaLower: lower, betaUpper: upper, mtbfNow: 1 / rocof, cumulativeMtbf: T / n, rocof, expectedAhead: ahead, failures: n },
    sentence: `β is ${beta.toFixed(3)} (${pct(i.confidence, 0)} bounds ${lower.toFixed(3)} to ${upper.toFixed(3)}), so the rate is ${trend}. MTBF now is ${n0(1 / rocof)} h against ${n0(T / n)} h on average so far.${ahead !== null ? ` Expect ${ahead.toFixed(2)} failures in the next ${n0(i.ahead!)} h.` : ''}`,
    warnings,
    points: t.map((x, k) => ({ t: x, n: k + 1 })),
    line,
  };
}

export function trendTest(i: { times: number[]; end?: number; endsAt: DataEnd; significance: number }): CalcOutput & { verdict: 'improving' | 'worse' | 'none' } {
  if (!(i.significance > 0 && i.significance < 0.5)) bad('Significance must be between 0% and 50%.');
  const { t, T, used } = checkTimes(i.times, i.end, i.endsAt, i.endsAt === 'time' ? 2 : 3);
  const m = used.length;
  const u = (used.reduce((a, x) => a + x, 0) / m - T / 2) / (T * Math.sqrt(1 / (12 * m)));
  const pLaplace = 2 * (1 - normalCdf(Math.abs(u)));
  const chi = 2 * used.reduce((a, x) => a + Math.log(T / x), 0);
  const nu = 2 * m;
  const cdf = chiSquareCdf(chi, nu);
  const pMil = Math.min(1, 2 * Math.min(cdf, 1 - cdf));
  const sigL = pLaplace < i.significance;
  const sigM = pMil < i.significance;
  // MIL: a small χ² means late failures, getting worse; a large one, improving.
  const milDir = cdf < 0.5 ? 'worse' : 'improving';
  const lapDir = u > 0 ? 'worse' : 'improving';
  const word = (d: string) => (d === 'worse' ? 'getting worse' : 'improving');
  const verdict: 'improving' | 'worse' | 'none' = sigL ? lapDir : sigM ? milDir : 'none';
  let sentence: string;
  if (sigL && sigM && lapDir === milDir) sentence = `Both tests say the failure rate is ${word(lapDir)} (Laplace p = ${pLaplace.toFixed(3)}, MIL-HDBK-189 p = ${pMil.toFixed(3)}).`;
  else if (!sigL && !sigM) sentence = `No clear trend: neither test is below ${pct(i.significance, 0)} (Laplace p = ${pLaplace.toFixed(3)}, MIL-HDBK-189 p = ${pMil.toFixed(3)}).`;
  else sentence = `The tests disagree: ${sigL ? `Laplace says ${word(lapDir)} (p = ${pLaplace.toFixed(3)})` : `Laplace finds no clear trend (p = ${pLaplace.toFixed(3)})`}, ${sigM ? `MIL-HDBK-189 says ${word(milDir)} (p = ${pMil.toFixed(3)})` : `MIL-HDBK-189 finds no clear trend (p = ${pMil.toFixed(3)})`}. The evidence is borderline.`;
  return { values: { laplaceU: u, pLaplace, milChiSquare: chi, milDof: nu, pMil, failures: t.length }, sentence, warnings: t.length < 4 ? ['Fewer than 4 failures: the tests have little power.'] : [], verdict };
}

export interface UnitHistory { unit: string; ages: number[]; end: number }
export interface McfPoint { t: number; mcf: number; se: number; lower: number; upper: number; atRisk: number }
export interface RocofBand { from: number; to: number; rate: number; atRisk: number }

export function meanCumulativeFunction(i: { units: UnitHistory[]; confidence: number; bands?: number }): CalcOutput & { points: McfPoint[]; bands: RocofBand[] } {
  if (!(i.confidence > 0 && i.confidence < 1)) bad('Confidence must be between 0% and 100%.');
  if (!i.units.length) bad('Add at least one unit.');
  for (const u of i.units) {
    if (!(Number.isFinite(u.end) && u.end > 0)) bad(`${u.unit}: the end age must be above 0.`);
    if (u.ages.some((a) => !(Number.isFinite(a) && a >= 0))) bad(`${u.unit}: failure ages must be 0 or more.`);
    if (u.ages.some((a) => a > u.end)) bad(`${u.unit}: a failure is after the end age.`);
  }
  const ages = [...new Set(i.units.flatMap((u) => u.ages))].sort((a, b) => a - b);
  if (!ages.length) bad('There are no failures.');
  const z = normalQuantile((1 + i.confidence) / 2);
  const count = (u: UnitHistory, t: number) => u.ages.filter((a) => a === t).length;
  const r = ages.map((t) => i.units.filter((u) => u.end >= t).length);
  const d = ages.map((t) => i.units.reduce((a, u) => a + count(u, t), 0));
  // Running sum per unit for the Lawless–Nadeau variance.
  const part = i.units.map(() => 0);
  let mcf = 0;
  const points: McfPoint[] = ages.map((t, j) => {
    mcf += d[j]! / r[j]!;
    i.units.forEach((u, k) => { if (u.end >= t) part[k]! += (count(u, t) - d[j]! / r[j]!) / r[j]!; });
    const se = Math.sqrt(part.reduce((a, x) => a + x * x, 0));
    const f = se > 1e-9 * mcf ? Math.exp((z * se) / mcf) : 1;
    return { t, mcf, se, lower: mcf / f, upper: mcf * f, atRisk: r[j]! };
  });
  const top = Math.max(...i.units.map((u) => u.end));
  const nb = i.bands ?? 5;
  const at = (x: number) => { let m = 0; for (const p of points) { if (p.t <= x) m = p.mcf; else break; } return m; };
  const bands: RocofBand[] = Array.from({ length: nb }, (_, k) => {
    const from = (top * k) / nb;
    const to = (top * (k + 1)) / nb;
    return { from, to, rate: (at(to) - at(from)) / (to - from), atRisk: i.units.filter((u) => u.end >= to).length };
  });
  const last = points[points.length - 1]!;
  // Compare the first and last bands that still have 3 or more units watched.
  const solid = bands.filter((b) => b.atRisk >= 3);
  const first = solid[0];
  const lastBand = solid[solid.length - 1];
  const rising = solid.length >= 2 && lastBand!.rate > first!.rate * 1.5;
  const falling = solid.length >= 2 && lastBand!.rate < first!.rate / 1.5;
  const thin = bands.filter((b) => b.atRisk < 3).length;
  return {
    values: { mcfEnd: last.mcf, mcfEndAge: last.t, seEnd: last.se, units: i.units.length, failures: d.reduce((a, x) => a + x, 0) },
    sentence: `By ${n0(last.t)} h a unit has had ${last.mcf.toFixed(2)} failures on average (${last.se > 1e-9 * last.mcf ? `${pct(i.confidence, 0)} bounds ${last.lower.toFixed(2)} to ${last.upper.toFixed(2)}` : `${last.atRisk} unit${last.atRisk === 1 ? '' : 's'} watched there, too few for bounds`}).${rising ? ' Failures come more often as units age.' : falling ? ' Failures come less often as units age.' : ''}`,
    warnings: thin ? [`${thin} of the ${nb} age bands have fewer than 3 units watched at their end: read the right of the curve with care.`] : [],
    points,
    bands,
  };
}

/**
 * "Use my data" for C-20 and C-21: the fleet clock. Each failure is placed at the operating hours of all
 * the units added up from the start of the period; T is the fleet hours at the end.
 */
export function fleetClock(failures: DowntimeEvent[], unitIds: string[], smu: SmuReading[], from: Iso, to: Iso): { times: number[]; end: number } {
  const units = unitIds.map((id) => { const rs = smu.filter((r) => r.unitId === id); return { id, rs, start: smuAt(rs, from) }; }).filter((u) => u.start !== undefined);
  const hoursAt = (at: Iso) => units.reduce((a, u) => a + Math.max(0, (smuAt(u.rs, at) ?? u.start!) - u.start!), 0);
  const ids = new Set(units.map((u) => u.id));
  const fs = failures.filter((e) => e.isFailure && ids.has(e.unitId) && Date.parse(e.start) >= Date.parse(from) && Date.parse(e.start) <= Date.parse(to));
  const times = fs.map((e) => hoursAt(e.start)).filter((x) => x > 0).sort((a, b) => a - b);
  return { times, end: hoursAt(to) };
}

/** "Use my data" for C-22: each unit's operating hours from the start of the period to its failures and to the end. */
export function unitHistories(failures: DowntimeEvent[], units: Array<{ id: string; name: string }>, smu: SmuReading[], from: Iso, to: Iso): UnitHistory[] {
  const out: UnitHistory[] = [];
  for (const u of units) {
    const rs = smu.filter((r) => r.unitId === u.id);
    const start = smuAt(rs, from);
    const stop = smuAt(rs, to);
    if (start === undefined || stop === undefined || stop <= start) continue;
    const ages = failures.filter((e) => e.isFailure && e.unitId === u.id && Date.parse(e.start) >= Date.parse(from) && Date.parse(e.start) <= Date.parse(to))
      .map((e) => (smuAt(rs, e.start) ?? start) - start).filter((a) => a >= 0 && a <= stop - start).sort((a, b) => a - b);
    out.push({ unit: u.name, ages, end: stop - start });
  }
  return out;
}

// ---------- C-23, C-24 system models ----------

export interface BlockGroup { name: string; n: number; k: number; mtbf: number; mttr: number }

const choose = (n: number, k: number) => { let c = 1; for (let j = 1; j <= k; j++) c = (c * (n - k + j)) / j; return c; };
/** P(at least k of n work), each working with probability p. */
export const kOfN = (n: number, k: number, p: number) => { let s = 0; for (let j = k; j <= n; j++) s += choose(n, j) * p ** j * (1 - p) ** (n - j); return s; };

function checkGroup(g: { name: string; n: number; k: number }) {
  if (!g.name.trim()) bad('Each group needs a name.');
  if (!(Number.isInteger(g.n) && g.n >= 1 && g.n <= 50)) bad(`${g.name}: the number of items must be a whole number from 1 to 50.`);
  if (!(Number.isInteger(g.k) && g.k >= 1 && g.k <= g.n)) bad(`${g.name}: items needed must be a whole number from 1 to ${g.n}.`);
}

export interface BlockResult extends BlockGroup { itemA: number; groupA: number; groupR: number; ifPerfect: number }

export function blockDiagram(i: { groups: BlockGroup[]; mission: number }): CalcOutput & { groups: BlockResult[] } {
  if (!i.groups.length) bad('Add at least one group.');
  if (i.groups.length > 40) bad('Up to 40 groups.');
  positive(i.mission, 'Mission');
  for (const g of i.groups) { checkGroup(g); positive(g.mtbf, `${g.name}: MTBF`); if (!(Number.isFinite(g.mttr) && g.mttr >= 0)) bad(`${g.name}: MTTR must be 0 or more.`); }
  const rows = i.groups.map((g) => { const itemA = g.mtbf / (g.mtbf + g.mttr); return { ...g, itemA, groupA: kOfN(g.n, g.k, itemA), groupR: kOfN(g.n, g.k, Math.exp(-i.mission / g.mtbf)), ifPerfect: 0 }; });
  const A = rows.reduce((a, g) => a * g.groupA, 1);
  const R = rows.reduce((a, g) => a * g.groupR, 1);
  for (const g of rows) g.ifPerfect = g.groupA > 0 ? A / g.groupA : 1;
  const weak = [...rows].sort((a, b) => b.ifPerfect - a.ifPerfect)[0]!;
  return {
    values: { systemAvailability: A, missionReliability: R, weakLinkGain: weak.ifPerfect - A, groups: rows.length },
    sentence: `The system is available ${pct(A, 2)} of the time and gets through ${n0(i.mission)} h without a failure ${pct(R, 1)} of the time. ${weak.name} is the weak link: if it never failed, availability would be ${pct(weak.ifPerfect, 2)}.`,
    warnings: [],
    groups: rows,
  };
}

export interface SimGroup { name: string; n: number; k: number; beta: number; eta: number; repair: number }

/** Seeded random numbers (mulberry32), so a simulation can be repeated exactly. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) + 0.5) / 4294967296;
  };
}

export function availabilitySimulation(i: { groups: SimGroup[]; period: number; runs: number; seed: number }): CalcOutput & { histogram: Array<{ from: number; to: number; n: number }> } {
  if (!i.groups.length) bad('Add at least one group.');
  if (i.groups.length > 40) bad('Up to 40 groups.');
  positive(i.period, 'Period');
  if (!(Number.isInteger(i.runs) && i.runs >= 100 && i.runs <= 5000)) bad('Runs must be a whole number from 100 to 5,000.');
  if (!Number.isInteger(i.seed)) bad('The seed must be a whole number.');
  for (const g of i.groups) { checkGroup(g); positive(g.beta, `${g.name}: β`); positive(g.eta, `${g.name}: η`); if (!(Number.isFinite(g.repair) && g.repair >= 0)) bad(`${g.name}: mean repair must be 0 or more.`); }
  const cycles = i.groups.reduce((a, g) => a + (g.n * i.period) / (g.eta * 0.5), 0) * i.runs;
  if (cycles > 5e7) bad('Too many failures to simulate: use fewer runs or a shorter period.');
  const rnd = seededRandom(i.seed);
  const M = i.period;
  const avail: number[] = [];
  let outages = 0;
  let down = 0;
  for (let run = 0; run < i.runs; run++) {
    const gd: Array<[number, number]> = [];
    for (const g of i.groups) {
      const ev: Array<[number, number]> = [];
      for (let k = 0; k < g.n; k++) {
        let t = 0;
        for (;;) {
          t += g.eta * (-Math.log(rnd())) ** (1 / g.beta);
          if (t >= M) break;
          const r = g.repair > 0 ? -Math.log(rnd()) * g.repair : 0;
          ev.push([t, -1], [Math.min(t + r, M), 1]);
          t += r;
        }
      }
      ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      let up = g.n;
      let start: number | null = null;
      for (const [t, dlt] of ev) {
        up += dlt;
        if (up < g.k && start === null) start = t;
        else if (up >= g.k && start !== null) { if (t > start) gd.push([start, t]); start = null; }
      }
      if (start !== null && M > start) gd.push([start, M]);
    }
    gd.sort((a, b) => a[0] - b[0]);
    let d = 0;
    let n = 0;
    let cur: [number, number] | null = null;
    for (const x of gd) {
      if (cur && x[0] <= cur[1]) cur[1] = Math.max(cur[1], x[1]);
      else { if (cur) { d += cur[1] - cur[0]; n++; } cur = [x[0], x[1]]; }
    }
    if (cur) { d += cur[1] - cur[0]; n++; }
    avail.push(1 - d / M);
    outages += n;
    down += d;
  }
  const sorted = [...avail].sort((a, b) => a - b);
  const mean = avail.reduce((a, x) => a + x, 0) / avail.length;
  const p5 = percentile(sorted, 0.05);
  const p95 = percentile(sorted, 0.95);
  const lo = sorted[0]!;
  const hi = sorted[sorted.length - 1]!;
  const nb = 20;
  const w = (hi - lo) / nb || 1e-9;
  const histogram = Array.from({ length: nb }, (_, k) => ({ from: lo + k * w, to: lo + (k + 1) * w, n: 0 }));
  for (const a of avail) histogram[Math.min(nb - 1, Math.floor((a - lo) / w))]!.n++;
  return {
    values: { meanAvailability: mean, p5Availability: p5, p95Availability: p95, meanOutages: outages / i.runs, meanDownHours: down / i.runs, runs: i.runs },
    sentence: `Over ${n0(M)} h the system is available ${pct(mean, 2)} of the time on average. In 9 runs out of 10 it is between ${pct(p5, 2)} and ${pct(p95, 2)}, with about ${n1(outages / i.runs)} outages and ${n0(down / i.runs)} down hours.`,
    warnings: i.runs < 500 ? ['Fewer than 500 runs: the percentiles are rough.'] : [],
    histogram,
  };
}

// ---------- catalogue ----------

export type CalculatorId = 'inherent_availability' | 'availability_target' | 'downtime_cost' | 'mtbf_confidence' | 'weibull' | 'conditional_weibull' | 'repair_times' | 'risk_matrix' | 'cost_per_hour' | 'mtbf_rate' | 'rebuild_or_replace' | 'pf_interval' | 'optimal_replacement' | 'failure_finding' | 'strategy_cost' | 'poisson_spares' | 'rebuild_pool' | 'kit_stocking' | 'lifetime_buy' | 'crow_amsaa' | 'trend_test' | 'mcf' | 'block_diagram' | 'availability_sim';

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
  { id: 'rebuild_or_replace', code: 'C-11', group: 'Cost', name: 'Rebuild or replace', question: 'Is it cheaper to rebuild this component or buy a new one?', usesData: true, formula: '(price + change-out h × cost per down h − core credit) ÷ expected life, for each option', version: 1 },
  { id: 'pf_interval', code: 'C-12', group: 'Maintenance strategy', name: 'P-F inspection interval', question: 'How often should we check for a warning sign?', usesData: false, formula: 'interval = min(P-F ÷ n, P-F − lead time)', version: 1 },
  { id: 'optimal_replacement', code: 'C-13', group: 'Maintenance strategy', name: 'Optimal replacement interval', question: 'At what age is it cheapest to replace before it fails?', usesData: true, formula: 'C(T) = (Cp R(T) + Cu (1 − R(T))) ÷ ∫₀ᵀ R(t) dt, lowest C(T)', version: 1 },
  { id: 'failure_finding', code: 'C-14', group: 'Maintenance strategy', name: 'Failure-finding interval', question: 'How often should we test a protective device?', usesData: false, formula: 'FFI = 2 × U × MTBF', version: 1 },
  { id: 'strategy_cost', code: 'C-15', group: 'Maintenance strategy', name: 'Strategy cost comparison', question: 'Is run to failure, time-based or condition-based maintenance cheapest?', usesData: true, formula: 'RTF = Cu ÷ MTBF;  TBM = C(T*);  CBM = Ci ÷ I + (p Cc + (1 − p) Cu) ÷ MTBF', version: 1 },
  { id: 'poisson_spares', code: 'C-16', group: 'Spares', name: 'Spares for a fill rate (Poisson)', question: 'How many of a part should we keep on the shelf?', usesData: false, formula: 'smallest s with P(N ≤ s − 1) ≥ target, N ~ Poisson(uses a year × lead days ÷ 365)', version: 1 },
  { id: 'rebuild_pool', code: 'C-17', group: 'Spares', name: 'Rebuild pool', question: 'How many spare components do we need in the rebuild pool?', usesData: true, formula: 'N ~ Poisson(change-outs a year × repair cycle days ÷ 365); total = s × carrying + EBO(s) × 8,760 × cost per down h', version: 1 },
  { id: 'kit_stocking', code: 'C-18', group: 'Spares', name: 'Kit stocking', question: 'How much of each part do we keep so a whole kit is there when needed?', usesData: true, formula: 'kit fill ≥ Π P(Nᵢ ≤ kᵢ − 1); stock qᵢ × kᵢ by greedy marginal analysis', version: 1 },
  { id: 'lifetime_buy', code: 'C-19', group: 'Spares', name: 'Lifetime buy', question: 'How many should we buy before a part is discontinued?', usesData: false, formula: 'D ~ Poisson(d × ((1 + g)^Y − 1) ÷ ln(1 + g)); smallest Q with P(D ≤ Q) ≥ confidence', version: 1 },

  { id: 'crow_amsaa', code: 'C-20', group: 'Repairable systems', name: 'Crow-AMSAA reliability growth', question: 'Is the fleet getting more or less reliable over time, and what is the MTBF now?', usesData: true, formula: 'N(t) = λ t^β;  β = n ÷ Σ ln(T ÷ tᵢ);  MTBF now = 1 ÷ (λ β T^(β−1))', version: 1 },
  { id: 'trend_test', code: 'C-21', group: 'Repairable systems', name: 'Trend test (Laplace and MIL-HDBK-189)', question: 'Are failures coming closer together or further apart?', usesData: true, formula: 'U = (Σtᵢ ÷ n − T ÷ 2) ÷ (T √(1 ÷ 12n));  χ² = 2 Σ ln(T ÷ tᵢ)', version: 1 },
  { id: 'mcf', code: 'C-22', group: 'Repairable systems', name: 'Mean cumulative function and ROCOF', question: 'How many failures does a unit have by a given age, and do they come faster as it ages?', usesData: true, formula: 'MCF(t) = Σ d(s) ÷ r(s) over failure ages s ≤ t; ROCOF = slope of the MCF', version: 1 },
  { id: 'block_diagram', code: 'C-23', group: 'System models', name: 'Reliability block diagram', question: 'What availability does this system of parts in series and in parallel give, and where is the weak link?', usesData: false, formula: 'A = Π P(at least k of n work);  A item = MTBF ÷ (MTBF + MTTR)', version: 1 },
  { id: 'availability_sim', code: 'C-24', group: 'System models', name: 'Availability simulation', question: 'What range of availability should we expect over a year, with wear-out and luck?', usesData: false, formula: 'Monte Carlo: Weibull run times, exponential repairs, k-of-n groups in series', version: 1 },
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
