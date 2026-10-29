// Calculator library (plan 7.2, 7.3; docs/calculators.md). Each calculator shows its
// formula and a worked example, can be filled from the fleet for the filter chosen,
// saved (never deleted, voided with a reason) and exported to Excel.

import {
  CALCULATORS, CalcError, analyse, availabilityTarget, can, conditionalCurve, conditionalWeibull, costPerHour, downtimeCost, filterFromQuery, filterToQuery,
  inherentAvailability, lifeData, mtbfConfidence, mtbfRate, rebuildOrReplace, pfInterval, optimalReplacement, failureFindingInterval, strategyCost, poissonSpares, rebuildPool, kitStocking, lifetimeBuy, type KitPart, type KitPartResult, componentStates, allLives, meanLives, smuIndex, COMPONENT_KINDS, KIND_LABELS, type ComponentKind, repairBySystem, repairTimes, riskMatrix, saveAnalysis, searchCalculators, voidAnalysis, weibull,
  RISK_BANDS, type AnalyticsFilter, type CalcOutput, type CalculatorId, type CalculatorInfo, type LifeTime, type SavedAnalysis,
} from '@mr/core';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, ComposedChart, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Scatter, Tooltip, XAxis, YAxis } from 'recharts';
import { FilterBar } from '../components/FilterBar';
import { siteTime } from '../format';
import { useApp } from '../store';

type Inputs = Record<string, string>;

interface Field { key: string; label: string; unit?: string; kind?: 'number' | 'list' | 'lives' | 'select'; options?: Array<[string, string]>; hint?: string }

/** Inputs for each calculator. Percent inputs are typed as percents. */
const FIELDS: Record<CalculatorId, Field[]> = {
  inherent_availability: [{ key: 'mtbf', label: 'MTBF', unit: 'h' }, { key: 'mttr', label: 'MTTR', unit: 'h' }],
  availability_target: [
    { key: 'target', label: 'Target availability', unit: '%' },
    { key: 'solve', label: 'Work out', kind: 'select', options: [['mtbf', 'the MTBF needed (I know the MTTR)'], ['mttr', 'the longest MTTR allowed (I know the MTBF)']] },
    { key: 'known', label: 'Known value', unit: 'h', hint: 'MTTR or MTBF, whichever you know' },
  ],
  downtime_cost: [{ key: 'tph', label: 'Lost production', unit: 't/h' }, { key: 'margin', label: 'Margin', unit: '$/t' }, { key: 'other', label: 'Other costs', unit: '$/h', hint: 'Standby crew, hired equipment' }],
  mtbf_confidence: [
    { key: 'hours', label: 'Total operating hours', unit: 'h' }, { key: 'failures', label: 'Failures' }, { key: 'confidence', label: 'Confidence', unit: '%' },
    { key: 'endsAt', label: 'The data ends', kind: 'select', options: [['time', 'at a point in time (field data)'], ['failure', 'at a failure']] },
  ],
  weibull: [
    { key: 'lives', label: 'Lives', unit: 'h', kind: 'lives', hint: 'One per line or comma. Add s for a suspension (still running or removed without failing), for example 2000s.' },
    { key: 'level', label: 'Two-sided confidence', kind: 'select', options: [['0.8', '80%'], ['0.9', '90%'], ['0.95', '95%']] },
  ],
  conditional_weibull: [{ key: 'beta', label: 'β (shape)' }, { key: 'eta', label: 'η (characteristic life)', unit: 'h' }, { key: 'age', label: 'Hours already run', unit: 'h' }, { key: 'mission', label: 'Hours ahead', unit: 'h' }],
  repair_times: [{ key: 'hours', label: 'Repair times', unit: 'h', kind: 'list', hint: 'Separated by commas, spaces or new lines.' }],
  risk_matrix: [
    { key: 'likelihood', label: 'Likelihood', kind: 'select', options: [['1', '1 Rare'], ['2', '2 Unlikely'], ['3', '3 Possible'], ['4', '4 Likely'], ['5', '5 Almost certain']] },
    { key: 'consequence', label: 'Consequence', kind: 'select', options: [['1', '1 Minor'], ['2', '2 Moderate'], ['3', '3 Major'], ['4', '4 Severe'], ['5', '5 Catastrophic']] },
  ],
  cost_per_hour: [{ key: 'purchase', label: 'Purchase', unit: '$' }, { key: 'fitting', label: 'Fitting', unit: '$' }, { key: 'rebuilds', label: 'Rebuild costs', unit: '$', kind: 'list', hint: 'One per rebuild, separated by commas.' }, { key: 'hours', label: 'Total hours of life', unit: 'h' }],
  mtbf_rate: [{ key: 'mtbf', label: 'MTBF', unit: 'h' }, { key: 'mission', label: 'Mission (for example a shift)', unit: 'h' }],
  rebuild_or_replace: [
    { key: 'rebuildPrice', label: 'Rebuild price', unit: '$' }, { key: 'rebuildLife', label: 'Expected life after rebuild', unit: 'h' },
    { key: 'newPrice', label: 'New price', unit: '$' }, { key: 'newLife', label: 'Expected new life', unit: 'h' },
    { key: 'changeoutHours', label: 'Change-out downtime', unit: 'h' }, { key: 'costPerDownHour', label: 'Cost per down hour', unit: '$/h', hint: 'C-03 works this out' },
    { key: 'coreCredit', label: 'Core credit when buying new', unit: '$' }, { key: 'hoursPerYear', label: 'Operating hours a year', unit: 'h' },
  ],
  pf_interval: [
    { key: 'pf', label: 'P-F interval', unit: 'h', hint: 'From when the warning can first be found to the failure' },
    { key: 'checks', label: 'Checks inside the P-F interval', hint: '2 is usual; more if the P-F interval varies a lot' },
    { key: 'leadTime', label: 'Lead time to plan and do the repair', unit: 'h' },
  ],
  optimal_replacement: [
    { key: 'beta', label: 'β (shape)' }, { key: 'eta', label: 'η (characteristic life)', unit: 'h' },
    { key: 'plannedCost', label: 'Cost of a planned replacement', unit: '$' }, { key: 'failureCost', label: 'Cost of a failure, with downtime', unit: '$', hint: 'C-03 gives the cost of a down hour' },
  ],
  failure_finding: [
    { key: 'mtbf', label: 'MTBF of the protective device', unit: 'h' },
    { key: 'unavailability', label: 'Tolerated unavailability', unit: '%', hint: 'Share of the time the device may be failed without anyone knowing' },
  ],
  strategy_cost: [
    { key: 'beta', label: 'β (shape)' }, { key: 'eta', label: 'η (characteristic life)', unit: 'h' },
    { key: 'failureCost', label: 'Cost of a failure, with downtime', unit: '$' }, { key: 'plannedCost', label: 'Cost of a planned replacement', unit: '$' },
    { key: 'inspectionCost', label: 'Cost of one inspection', unit: '$' }, { key: 'inspectionInterval', label: 'Inspection interval', unit: 'h' },
    { key: 'detection', label: 'Chance an inspection finds the warning in time', unit: '%' }, { key: 'repairCost', label: 'Cost of a planned repair after a warning', unit: '$' },
  ],
  poisson_spares: [
    { key: 'perYear', label: 'Uses a year' }, { key: 'leadDays', label: 'Lead time', unit: 'days', hint: 'From ordering one to having it on the shelf' },
    { key: 'target', label: 'Target fill rate', unit: '%', hint: 'Share of the times one is needed that it is on the shelf' },
    { key: 'unitCost', label: 'Unit cost (optional)', unit: '$' },
  ],
  rebuild_pool: [
    { key: 'perYear', label: 'Change-outs a year' }, { key: 'cycleDays', label: 'Repair cycle', unit: 'days', hint: 'From removal to back in stores, ready to fit' },
    { key: 'target', label: 'Target fill rate', unit: '%', hint: 'Share of change-outs with a spare ready' },
    { key: 'carryingCost', label: 'Cost to carry one spare a year (optional)', unit: '$', hint: 'Capital and storage; for the lowest-cost pool' },
    { key: 'costPerDownHour', label: 'Cost per down hour (optional)', unit: '$/h', hint: 'C-03 works this out' },
  ],
  kit_stocking: [
    { key: 'perYear', label: 'Kit uses a year' }, { key: 'target', label: 'Target kit fill rate', unit: '%' },
    { key: 'parts', label: 'Parts', kind: 'list', hint: 'One per line: item, quantity per kit, lead time in days, unit cost, description. Cost and description can be left blank.' },
  ],
  lifetime_buy: [
    { key: 'perYear', label: 'Uses a year now' }, { key: 'years', label: 'Years left', hint: 'Until the last unit that uses it is retired' },
    { key: 'change', label: 'Yearly change in uses', unit: '%', hint: 'Negative as units retire, for example −10' },
    { key: 'confidence', label: 'Confidence', unit: '%', hint: 'Chance the buy lasts to the end' },
    { key: 'onHand', label: 'On hand now' }, { key: 'unitCost', label: 'Unit cost', unit: '$' },
    { key: 'salvage', label: 'Salvage value of one left over (optional)', unit: '$' },
    { key: 'shortageCost', label: 'Cost of being short of one (optional)', unit: '$', hint: 'Getting one another way, plus the downtime' },
  ],
};

/** The worked examples from docs/calculators.md; also the starting inputs. */
const EXAMPLE: Record<CalculatorId, { inputs: Inputs; text: string; assumptions: string }> = {
  inherent_availability: { inputs: { mtbf: '120', mttr: '6' }, text: 'MTBF 120 h and MTTR 6 h give 120 ÷ 126 = 95.2%.', assumptions: 'MTBF in operating hours, MTTR in repair hours. Ignores waiting for parts and shop lines, so it is not PA.' },
  availability_target: { inputs: { target: '92', solve: 'mtbf', known: '8' }, text: '92% with MTTR 8 h needs MTBF ≥ 92 h. 92% with MTBF 60 h allows MTTR ≤ 5.217 h.', assumptions: 'Inherent availability: repair time only, no waiting.' },
  downtime_cost: { inputs: { tph: '250', margin: '12', other: '300' }, text: '250 t/h × $12/t + $300/h = $3,300 per down hour.', assumptions: 'Lost production is not made up later.' },
  mtbf_confidence: { inputs: { hours: '1000', failures: '2', confidence: '90', endsAt: 'time' }, text: 'T = 1,000 h, r = 2, 90%: χ²(0.90; 6) = 10.6446, lower limit 187.9 h; point estimate 500 h.', assumptions: 'Constant failure rate (exponential) and units alike. ν = 2r + 2 for field data, 2r when it ends at a failure.' },
  weibull: { inputs: { lives: '1200\n1850\n2400\n3100\n3900\n4600\n5800\n2000s\n3500s\n5000s\n6000s', level: '0.9' }, text: '7 failures and 4 suspensions: β = 2.155 (1.289–3.605), η = 4,868 h (3,643–6,504), B10 = 1,714 h.', assumptions: 'Maximum likelihood with suspensions, Fisher matrix bounds. From fleet data, each repair is taken as making the item as good as new.' },
  conditional_weibull: { inputs: { beta: '2.1553', eta: '4867.9', age: '3000', mission: '1000' }, text: 'At 3,000 h: R(1,000 | 3,000) = 0.7389; median remaining life 1,969 h.', assumptions: 'The Weibull fit describes this item.' },
  repair_times: { inputs: { hours: '1.5, 2, 2.5, 3, 4, 4.5, 6, 8, 12, 30' }, text: 'Mean 7.35 h, median 4.25 h, 90th percentile 13.8 h.', assumptions: 'Percentiles are linear between ranks (Excel PERCENTILE.INC). From fleet data: down hours of each closed downtime event.' },
  risk_matrix: { inputs: { likelihood: '4', consequence: '4' }, text: '4 × 4 = 16, High.', assumptions: 'Default bands Low 1–4, Medium 5–9, High 10–16, Extreme 20–25. A site with its own corporate matrix should use that.' },
  cost_per_hour: { inputs: { purchase: '180000', fitting: '6000', rebuilds: '45000, 45000', hours: '24000' }, text: '$180,000 + $6,000 + 2 × $45,000 over 24,000 h = $11.50 per hour.', assumptions: 'All costs over the whole life, including rebuilds.' },
  mtbf_rate: { inputs: { mtbf: '500', mission: '100' }, text: 'MTBF 500 h: λ = 0.002 per hour, 2,000 per million hours; R(100 h) = 0.8187.', assumptions: 'Constant failure rate.' },
  rebuild_or_replace: {
    inputs: { rebuildPrice: '280000', rebuildLife: '16000', newPrice: '600000', newLife: '22000', changeoutHours: '24', costPerDownHour: '2500', coreCredit: '60000', hoursPerYear: '6000' },
    text: 'Rebuild $280,000 for 16,000 h vs new $600,000 for 22,000 h, 24 h change-out at $2,500/h, $60,000 core credit: rebuild $21.25/h, new $27.27/h; break-even life 12,467 h; rebuilding saves $36,136 a year at 6,000 h.',
    assumptions: 'Each option is judged on its cost per hour of life. Expected lives are averages; check the Weibull spread on the Components page before relying on them.',
  },
  pf_interval: { inputs: { pf: '1000', checks: '2', leadTime: '200' }, text: 'P-F 1,000 h, 2 checks, 200 h lead time: min(500, 800) = 500 h. With a 600 h lead time: min(500, 400) = 400 h.', assumptions: 'The P-F interval is fairly steady. Moubray, RCM II chapter 7; SAE JA1012 section 9.' },
  optimal_replacement: { inputs: { beta: '3', eta: '10000', plannedCost: '40000', failureCost: '160000' }, text: 'β 3, η 10,000 h, planned $40,000, failure $160,000: replace at 5,542 h for $11.06 an hour, against $17.92 an hour run to failure (checked with SciPy).', assumptions: 'The Weibull fit describes the item, a replacement makes it as good as new, and costs do not depend on age.' },
  failure_finding: { inputs: { mtbf: '20000', unavailability: '1' }, text: 'MTBF 20,000 h and 1% tolerated unavailability: FFI = 2 × 0.01 × 20,000 = 400 h; exact unavailability 0.993%.', assumptions: 'One protective device, random failures, and every check finds a failure that is then fixed. Moubray, RCM II chapter 8.' },
  strategy_cost: { inputs: { beta: '3', eta: '10000', failureCost: '160000', plannedCost: '40000', inspectionCost: '500', inspectionInterval: '500', detection: '90', repairCost: '40000' }, text: 'Run to failure $17.92/h, time-based $11.06/h at 5,542 h, condition-based $1.00 + (0.9 × $40,000 + 0.1 × $160,000) ÷ 8,930 h = $6.82/h: condition-based is cheapest.', assumptions: 'Failures start at the same rate under each strategy; a found warning becomes a planned repair and a missed one a failure.' },
  poisson_spares: { inputs: { perYear: '6', leadDays: '60', target: '95', unitCost: '' }, text: '6 a year with a 60 day lead time (mean 0.986 on order): keep 4 for a 95% target; fill rate 98.18%, no stock-out in a lead time 99.65%. 3 would give 92.2% (checked with SciPy).', assumptions: 'One-for-one reorder and steady random (Poisson) demand. Fill rate = P(N ≤ s − 1), N the number on order (Palm). Sherbrooke, Optimal Inventory Modeling of Systems, chapter 2.' },
  rebuild_pool: { inputs: { perYear: '12', cycleDays: '75', target: '95', carryingCost: '60000', costPerDownHour: '2500' }, text: '12 change-outs a year and a 75 day cycle: a pool of 6 gives 96.02% with 6.8 unit-days a year waiting. At $60,000 a year to carry a spare and $2,500 a down hour, the lowest-cost pool is 8, at $509,674 a year (checked with SciPy).', assumptions: 'Each removed component goes to rebuild and comes back to the pool (Palm\'s theorem). A unit waiting for a component is down all day. A scrapped component is replaced within the cycle.' },
  kit_stocking: { inputs: { perYear: '24', target: '95', parts: 'FILTER, 2, 14, 80, Filter\nSEAL-KIT, 1, 45, 350, Seal kit\nPUMP, 1, 90, 4200, Pump' }, text: '24 kits a year, 95%: 12 filters, 9 seal kits and 11 pumps; a whole kit at least 95.70% of the time (at most 96.07%), $50,310 of stock (checked with SciPy and a simulation).', assumptions: 'Each part is stocked in whole kits with one-for-one reorder. The product of the part fill rates is a safe lower bound; the parts are short at the same times, so the true rate is a little higher. Parts used outside the kit need their own demand added.' },
  lifetime_buy: { inputs: { perYear: '10', years: '6', change: '-10', confidence: '90', onHand: '5', unitCost: '2000', salvage: '200', shortageCost: '15000' }, text: '10 a year now, 6 years, −10% a year: expect 44.5 uses. 90% confidence needs 53, so buy 48 ($96,000). Balancing $1,800 per part left over against $13,000 per part short gives 52 (checked with SciPy).', assumptions: 'Demand is random around the trend and parts do not wear out on the shelf. Newsvendor critical ratio for the cost-balanced figure.' },
};

const VALUE_LABELS: Record<string, [string, (x: number) => string]> = {
  availability: ['Inherent availability', (x) => `${(x * 100).toFixed(1)}%`],
  requiredMtbf: ['MTBF needed', (x) => `${x.toFixed(1)} h`],
  maxMttr: ['Longest MTTR', (x) => `${x.toFixed(2)} h`],
  perHour: ['Per hour', (x) => `$${x.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`],
  total: ['Total cost', (x) => `$${Math.round(x).toLocaleString('en-CA')}`],
  point: ['MTBF (best estimate)', (x) => `${Math.round(x).toLocaleString('en-CA')} h`],
  lower: ['MTBF lower limit', (x) => `${Math.round(x).toLocaleString('en-CA')} h`],
  chiSquare: ['χ²', (x) => x.toFixed(4)],
  dof: ['Degrees of freedom', (x) => String(x)],
  beta: ['β (shape)', (x) => x.toFixed(3)],
  betaLower: ['β lower', (x) => x.toFixed(3)],
  betaUpper: ['β upper', (x) => x.toFixed(3)],
  eta: ['η (characteristic life)', (x) => `${Math.round(x).toLocaleString('en-CA')} h`],
  etaLower: ['η lower', (x) => `${Math.round(x).toLocaleString('en-CA')} h`],
  etaUpper: ['η upper', (x) => `${Math.round(x).toLocaleString('en-CA')} h`],
  b10: ['B10 life', (x) => `${Math.round(x).toLocaleString('en-CA')} h`],
  failures: ['Failures', (x) => String(x)],
  suspensions: ['Suspensions', (x) => String(x)],
  reliability: ['Chance of no failure', (x) => `${(x * 100).toFixed(1)}%`],
  medianRemaining: ['Median remaining life', (x) => `${Math.round(x).toLocaleString('en-CA')} h`],
  count: ['Repairs', (x) => String(x)],
  mean: ['Mean', (x) => `${x.toFixed(2)} h`],
  median: ['Median', (x) => `${x.toFixed(2)} h`],
  p90: ['90th percentile', (x) => `${x.toFixed(2)} h`],
  score: ['Score', (x) => String(x)],
  lambda: ['Failure rate λ', (x) => `${x.toPrecision(3)} per h`],
  perMillion: ['Per million hours', (x) => Math.round(x).toLocaleString('en-CA')],
  rebuildPerHour: ['Rebuild, per hour of life', (x) => `$${x.toFixed(2)}`],
  replacePerHour: ['New, per hour of life', (x) => `$${x.toFixed(2)}`],
  breakEvenLife: ['Break-even life for a rebuild', (x) => `${Math.round(x).toLocaleString('en-CA')} h`],
  annualDifference: ['Difference a year', (x) => `$${Math.round(x).toLocaleString('en-CA')}`],
  interval: ['Inspection interval', (x) => `${Math.round(x).toLocaleString('en-CA')} h`],
  byChecks: ['P-F ÷ checks', (x) => `${Math.round(x).toLocaleString('en-CA')} h`],
  byLead: ['P-F − lead time', (x) => `${Math.round(x).toLocaleString('en-CA')} h`],
  age: ['Replace at', (x) => `${Math.round(x).toLocaleString('en-CA')} h`],
  costPerHour: ['Cost per hour at that age', (x) => `$${x.toFixed(2)}`],
  survive: ['Items reaching that age', (x) => `${(x * 100).toFixed(1)}%`],
  runToFailure: ['Run to failure, per hour', (x) => `$${x.toFixed(2)}`],
  mtbf: ['MTBF (Weibull mean)', (x) => `${Math.round(x).toLocaleString('en-CA')} h`],
  ffi: ['Failure-finding interval', (x) => `${Math.round(x).toLocaleString('en-CA')} h`],
  exact: ['Unavailability at that interval', (x) => `${(x * 100).toFixed(3)}%`],
  timeBased: ['Time-based, per hour', (x) => `$${x.toFixed(2)}`],
  timeBasedAge: ['Time-based replaces at', (x) => `${Math.round(x).toLocaleString('en-CA')} h`],
  conditionBased: ['Condition-based, per hour', (x) => `$${x.toFixed(2)}`],
  onOrderMean: ['Mean number on order', (x) => x.toFixed(3)],
  demandMean: ['Expected uses to the end', (x) => x.toFixed(1)],
  stock: ['Keep (on the shelf and on order)', (x) => String(x)],
  fill: ['Fill rate', (x) => `${(x * 100).toFixed(2)}%`],
  noStockout: ['No stock-out in a lead time', (x) => `${(x * 100).toFixed(2)}%`],
  ebo: ['Expected backorders', (x) => x.toFixed(4)],
  stockValue: ['Stock value', (x) => `$${Math.round(x).toLocaleString('en-CA')}`],
  pool: ['Pool for the target', (x) => String(x)],
  waitDays: ['Unit-days waiting a year', (x) => x.toFixed(1)],
  downHours: ['Down hours waiting a year', (x) => Math.round(x).toLocaleString('en-CA')],
  totalAtTarget: ['Total cost a year at that pool', (x) => `$${Math.round(x).toLocaleString('en-CA')}`],
  bestPool: ['Lowest-cost pool', (x) => String(x)],
  bestTotal: ['Lowest total cost a year', (x) => `$${Math.round(x).toLocaleString('en-CA')}`],
  kitFillLower: ['Kit fill rate, at least', (x) => `${(x * 100).toFixed(2)}%`],
  kitFillUpper: ['Kit fill rate, at most', (x) => `${(x * 100).toFixed(2)}%`],
  partsCount: ['Parts', (x) => String(x)],
  needTotal: ['Needed in all', (x) => Math.round(x).toLocaleString('en-CA')],
  buy: ['Buy', (x) => Math.round(x).toLocaleString('en-CA')],
  buyCost: ['Cost of the buy', (x) => `$${Math.round(x).toLocaleString('en-CA')}`],
  leftover: ['Expected left over', (x) => x.toFixed(2)],
  short: ['Expected short', (x) => x.toFixed(2)],
  ratio: ['Critical ratio', (x) => x.toFixed(3)],
  costTotal: ['Cost-balanced total', (x) => Math.round(x).toLocaleString('en-CA')],
  costBuy: ['Cost-balanced buy', (x) => Math.round(x).toLocaleString('en-CA')],
};

const nums = (s: string | undefined) => (s ?? '').split(/[\s,;]+/).filter(Boolean).map(Number);
function lives(s: string | undefined): LifeTime[] {
  return (s ?? '').split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean).map((x) => {
    const sus = /s$|\+$/i.test(x);
    return { t: Number(x.replace(/[s+]$/i, '').trim()), failed: !sus };
  });
}

interface Run { out: CalcOutput; parsed: unknown }

function compute(id: CalculatorId, i: Inputs): Run {
  const n = (k: string) => (i[k] === undefined || i[k]!.trim() === '' ? NaN : Number(i[k]));
  const opt = (k: string) => (i[k] === undefined || i[k]!.trim() === '' ? undefined : Number(i[k]));
  switch (id) {
    case 'inherent_availability': { const p = { mtbf: n('mtbf'), mttr: n('mttr') }; return { out: inherentAvailability(p), parsed: p }; }
    case 'availability_target': {
      const p = i.solve === 'mttr' ? { target: n('target') / 100, mtbf: n('known') } : { target: n('target') / 100, mttr: n('known') };
      return { out: availabilityTarget(p), parsed: p };
    }
    case 'downtime_cost': { const p = { tonnesPerHour: n('tph'), marginPerTonne: n('margin'), otherPerHour: n('other') }; return { out: downtimeCost(p), parsed: p }; }
    case 'mtbf_confidence': { const p = { hours: n('hours'), failures: n('failures'), confidence: n('confidence') / 100, endsAt: (i.endsAt === 'failure' ? 'failure' : 'time') as 'time' | 'failure' }; return { out: mtbfConfidence(p), parsed: p }; }
    case 'weibull': { const data = lives(i.lives); const level = Number(i.level ?? 0.9); return { out: weibull(data, level), parsed: { data, level } }; }
    case 'conditional_weibull': { const p = { beta: n('beta'), eta: n('eta'), age: n('age'), mission: n('mission') }; return { out: conditionalWeibull(p), parsed: p }; }
    case 'repair_times': { const h = nums(i.hours); if (h.some((x) => !Number.isFinite(x) || x < 0)) throw new CalcError(['Repair times must be numbers, 0 or more.']); return { out: repairTimes(h), parsed: { hours: h } }; }
    case 'risk_matrix': { const p = { likelihood: n('likelihood'), consequence: n('consequence') }; return { out: riskMatrix(p), parsed: p }; }
    case 'cost_per_hour': { const p = { purchase: n('purchase'), fitting: n('fitting'), rebuilds: nums(i.rebuilds), hours: n('hours') }; return { out: costPerHour(p), parsed: p }; }
    case 'mtbf_rate': { const p = { mtbf: n('mtbf'), mission: n('mission') }; return { out: mtbfRate(p), parsed: p }; }
    case 'rebuild_or_replace': {
      const p = { rebuildPrice: n('rebuildPrice'), rebuildLife: n('rebuildLife'), newPrice: n('newPrice'), newLife: n('newLife'), changeoutHours: n('changeoutHours'), costPerDownHour: n('costPerDownHour'), coreCredit: n('coreCredit'), hoursPerYear: n('hoursPerYear') };
      return { out: rebuildOrReplace(p), parsed: p };
    }
    case 'pf_interval': { const p = { pf: n('pf'), checks: n('checks'), leadTime: n('leadTime') }; return { out: pfInterval(p), parsed: p }; }
    case 'optimal_replacement': { const p = { beta: n('beta'), eta: n('eta'), plannedCost: n('plannedCost'), failureCost: n('failureCost') }; return { out: optimalReplacement(p), parsed: p }; }
    case 'failure_finding': { const p = { mtbf: n('mtbf'), unavailability: n('unavailability') / 100 }; return { out: failureFindingInterval(p), parsed: p }; }
    case 'strategy_cost': {
      const p = { beta: n('beta'), eta: n('eta'), failureCost: n('failureCost'), plannedCost: n('plannedCost'), inspectionCost: n('inspectionCost'), inspectionInterval: n('inspectionInterval'), detection: n('detection') / 100, repairCost: n('repairCost') };
      return { out: strategyCost(p), parsed: p };
    }
    case 'poisson_spares': { const p = { perYear: n('perYear'), leadDays: n('leadDays'), target: n('target') / 100, unitCost: opt('unitCost') }; return { out: poissonSpares(p), parsed: p }; }
    case 'rebuild_pool': {
      const p = { perYear: n('perYear'), cycleDays: n('cycleDays'), target: n('target') / 100, carryingCost: opt('carryingCost'), costPerDownHour: opt('costPerDownHour') };
      if ((p.carryingCost === undefined) !== (p.costPerDownHour === undefined)) throw new CalcError(['Enter both costs for the lowest-cost pool, or neither.']);
      return { out: rebuildPool(p), parsed: p };
    }
    case 'kit_stocking': { const p = { perYear: n('perYear'), target: n('target') / 100, parts: kitParts(i.parts) }; return { out: kitStocking(p), parsed: p }; }
    case 'lifetime_buy': {
      const p = { perYear: n('perYear'), years: n('years'), change: n('change') / 100, confidence: n('confidence') / 100, onHand: n('onHand'), unitCost: n('unitCost'), salvage: opt('salvage'), shortageCost: opt('shortageCost') };
      return { out: lifetimeBuy(p), parsed: p };
    }
  }
}

/** Kit parts typed one per line: item, quantity, lead days, unit cost, description. */
function kitParts(text: string | undefined): KitPart[] {
  return (text ?? '').split(/\n+/).map((l) => l.trim()).filter(Boolean).map((l, k) => {
    const [item = '', qty = '', lead = '', cost = '', ...rest] = l.split(',').map((x) => x.trim());
    const num = (x: string) => (x === '' ? NaN : Number(x));
    if (!Number.isFinite(num(qty)) || !Number.isFinite(num(lead))) throw new CalcError([`Line ${k + 1}: write item, quantity per kit, lead time in days, then the unit cost and description if known.`]);
    return { item, qty: num(qty), leadDays: num(lead), unitCost: cost === '' ? undefined : num(cost), description: rest.join(', ') || undefined };
  });
}

/** Calculators filled from another page (component history, spares) rather than the fleet filter. */
const FROM_PAGES: CalculatorId[] = ['rebuild_or_replace', 'rebuild_pool', 'kit_stocking'];

const linkBtn = { display: 'inline-flex', alignItems: 'center', textDecoration: 'none' } as const;

export function Calculators({ arg, sub, query }: { arg?: string; sub?: string; query: string }) {
  const info = CALCULATORS.find((c) => c.id === arg);
  if (info) return <Calculator key={`${info.id}/${sub ?? ''}`} info={info} savedId={sub} query={query} />;
  return <Library />;
}

// ---------- the library: search and saved analyses ----------

function Library() {
  const app = useApp();
  const tz = app.ds.site.timeZone;
  const [q, setQ] = useState('');
  const [showVoided, setShowVoided] = useState(false);
  const list = searchCalculators(q);
  const groups = [...new Set(list.map((c) => c.group))];
  const saved = [...app.analyses].filter((a) => showVoided || !a.voidedAt).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return (
    <div className="stack">
      <div className="page-head">
        <h2>Calculators</h2>
        <span className="muted small">Press Ctrl + K or Cmd + K on any page to find one.</span>
      </div>
      <label className="field" style={{ maxWidth: 480 }}>
        <span>Search</span>
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="For example weibull, MTBF, cost" aria-label="Search calculators" />
      </label>
      {groups.map((g) => (
        <section key={g} className="card">
          <h3 style={{ marginTop: 0 }}>{g}</h3>
          <div className="stack" style={{ gap: 8 }}>
            {list.filter((c) => c.group === g).map((c) => (
              <a key={c.id} href={`#/calc/${c.id}`} style={{ textDecoration: 'none', color: 'inherit' }}>
                <strong>{c.code} {c.name}</strong>{c.usesData && <span className="chip small" style={{ marginLeft: 8 }}>Uses fleet data</span>}
                <div className="small muted">{c.question}</div>
              </a>
            ))}
          </div>
        </section>
      ))}
      {!list.length && <p className="muted">No calculator matches “{q}”.</p>}

      <section className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0 }}>Saved analyses</h3>
          <label className="small"><input type="checkbox" checked={showVoided} onChange={(e) => setShowVoided(e.target.checked)} /> Show voided</label>
        </div>
        {saved.length ? (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Title</th><th>Calculator</th><th>Result</th><th>Saved by</th><th>When (site time)</th></tr></thead>
              <tbody>
                {saved.map((a) => {
                  const c = CALCULATORS.find((x) => x.id === a.calculator);
                  return (
                    <tr key={a.id} style={a.voidedAt ? { opacity: 0.6 } : undefined}>
                      <td><a href={`#/calc/${a.calculator}/${a.id}`}>{a.title}</a>{a.voidedAt && <span className="small muted"> (voided: {a.voidReason})</span>}</td>
                      <td>{c ? `${c.code} ${c.name}` : a.calculator}</td>
                      <td className="small">{a.sentence}</td>
                      <td>{app.userName(a.createdBy)}</td>
                      <td>{siteTime(a.createdAt, tz, true)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : <p className="muted small">Nothing saved yet. Open a calculator, run it and press Save.</p>}
      </section>
    </div>
  );
}

// ---------- one calculator ----------

function Calculator({ info, savedId, query }: { info: CalculatorInfo; savedId?: string; query: string }) {
  const app = useApp();
  const tz = app.ds.site.timeZone;
  const saved = savedId ? app.analyses.find((a) => a.id === savedId) : undefined;
  // A link from another page can fill inputs: ?perYear=12&cycleDays=75&note=...
  const filled = useMemo(() => {
    if (saved) return null;
    const q = new URLSearchParams(query);
    const keys = FIELDS[info.id].map((f) => f.key).filter((k) => q.has(k));
    return keys.length ? { inputs: Object.fromEntries(keys.map((k) => [k, q.get(k)!])) as Inputs, note: q.get('note') ?? 'Filled from a link' } : null;
  }, [saved, query, info.id]);
  const [inputs, setInputs] = useState<Inputs>(() => ({ ...EXAMPLE[info.id].inputs, ...(filled?.inputs ?? {}), ...((saved?.inputs as { form?: Inputs } | undefined)?.form ?? {}) }));
  const [dataNote, setDataNote] = useState(saved?.dataNote ?? filled?.note ?? 'Typed in');
  const [dataMsg, setDataMsg] = useState<string | null>(null);
  const filter = useMemo(() => filterFromQuery(query), [query]);
  const setFilter = (f: AnalyticsFilter) => { const q = filterToQuery(f); window.location.hash = `#/calc/${info.id}${q ? `?${q}` : ''}`; };
  const set = (k: string, v: string) => { setInputs((p) => ({ ...p, [k]: v })); if (dataNote !== 'Typed in' && !dataNote.endsWith('(edited)')) setDataNote(`${dataNote} (edited)`); };

  const run = useMemo((): Run | { errors: string[] } => {
    try { return compute(info.id, inputs); } catch (e) { if (e instanceof CalcError) return { errors: e.problems }; throw e; }
  }, [info.id, inputs]);

  const a = useMemo(
    () => (info.usesData && !FROM_PAGES.includes(info.id) ? analyse({ assets: app.ds.assets, flags: app.flags, smu: app.ds.smu, lifecycle: app.ds.lifecycle, rules: app.rules, now: app.now, calendar: app.ds.calendar, timeZone: tz }, filter) : null),
    [info.usesData, app.ds, app.flags, app.rules, app.now, filter],
  );
  const repairRows = useMemo(() => (a ? a.events.filter((e) => e.event.end).map((e) => ({ system: e.event.system ?? 'Not recorded', hours: e.hours })) : []), [a]);

  const useMyData = () => {
    if (!a) return;
    const q = filterToQuery(filter);
    const note = `Fleet data: ${a.assets.length} units, ${siteTime(a.period.from, tz, true)} to ${siteTime(a.period.to, tz, true)}${q ? `, filter ${q}` : ''}`;
    const fixed = (x: number | null, d = 1) => (x === null || !Number.isFinite(x) ? '' : String(Number(x.toFixed(d))));
    const k = a.kpis;
    let next: Inputs = {};
    let msg = '';
    switch (info.id) {
      case 'inherent_availability': next = { mtbf: fixed(k.mtbf), mttr: fixed(k.mttr, 2) }; msg = 'MTBF and MTTR for the units and dates chosen (KPI dictionary).'; break;
      case 'availability_target': next = { known: fixed(inputs.solve === 'mttr' ? k.mtbf : k.mttr, 2) }; msg = `The fleet ${inputs.solve === 'mttr' ? 'MTBF' : 'MTTR'} for the units and dates chosen.`; break;
      case 'mtbf_confidence': next = { hours: fixed(k.operatingHours, 0), failures: String(a.failures), endsAt: 'time' }; msg = 'Operating hours from SMU for the units and dates chosen, and the failures that match the filter.'; break;
      case 'weibull':
      case 'optimal_replacement':
      case 'strategy_cost':
      case 'conditional_weibull': {
        const data = lifeData(a.events.map((e) => e.event), a.assets.map((x) => x.id), app.ds.smu, a.period.from, a.period.to);
        if (info.id === 'weibull') {
          next = { lives: data.map((d) => `${Math.round(d.t)}${d.failed ? '' : 's'}`).join('\n') };
          msg = `${data.filter((d) => d.failed).length} failed lives and ${data.filter((d) => !d.failed).length} suspensions, in operating hours. Each repair is taken as making the unit as good as new.`;
        } else {
          try { const w = weibull(data); next = { beta: fixed(w.beta, 4), eta: fixed(w.eta, 1) }; msg = info.id === 'conditional_weibull' ? 'β and η fitted to the lives in the filter. Enter the hours this item has run.' : 'β and η fitted to the lives in the filter. Filter to one system or component, then enter the costs.'; } catch (e) { setDataMsg(e instanceof CalcError ? `Could not fit the data: ${e.problems.join(' ')}` : String(e)); return; }
        }
        break;
      }
      case 'repair_times': next = { hours: repairRows.map((r) => Number(r.hours.toFixed(2))).join(', ') }; msg = 'Down hours of each closed downtime event that matches the filter.'; break;
      default: return;
    }
    setInputs((p) => ({ ...p, ...next }));
    setDataNote(note);
    setDataMsg(msg);
  };

  const ok = 'out' in run ? run : null;
  const exportXlsx = async () => {
    if (!ok) return;
    const { xlsxBlob } = await import('../pack/xlsx');
    const sheets = [
      { name: 'Result', rows: [['Item', 'Value'], ['Calculator', `${info.code} ${info.name} (version ${info.version})`], ['Result', ok.out.sentence], ...Object.entries(ok.out.values).map(([k, v]) => [VALUE_LABELS[k]?.[0] ?? k, v]), ...ok.out.warnings.map((w) => ['Warning', w]), ['Data used', dataNote], ['Site', app.ds.site.name], ['Exported', siteTime(new Date().toISOString(), tz, true)]] },
      { name: 'Inputs', rows: [['Input', 'Value'], ...FIELDS[info.id].map((f) => [`${f.label}${f.unit ? ` (${f.unit})` : ''}`, inputs[f.key] ?? ''])] },
      { name: 'Formula', rows: [['Formula', info.formula], ['Assumptions', EXAMPLE[info.id].assumptions], ['Worked example', EXAMPLE[info.id].text], ['Reference', 'docs/calculators.md']] },
    ];
    if (info.id === 'weibull') sheets.push({ name: 'Lives', rows: [['Hours', 'Failed'], ...(ok.parsed as { data: LifeTime[] }).data.map((d) => [d.t, d.failed ? 'yes' : 'no (suspension)'])] });
    if (info.id === 'kit_stocking') sheets.push({ name: 'Parts', rows: [['Item', 'Description', 'Per kit', 'Lead time (days)', "Kits' worth", 'Keep', 'Part fill rate', 'Unit cost', 'Value'], ...(ok.out as unknown as { parts: KitPartResult[] }).parts.map((p) => [p.item, p.description ?? '', p.qty, p.leadDays, p.kits, p.stock, p.fill, p.unitCost ?? '', p.value ?? ''])] });
    if (info.id === 'repair_times') sheets.push({ name: 'Repairs', rows: [['Hours'], ...(ok.parsed as { hours: number[] }).hours.map((h) => [h])] });
    const blob = await xlsxBlob(sheets);
    const url = URL.createObjectURL(blob);
    const el = document.createElement('a');
    el.href = url;
    el.download = `${info.code}-${info.name.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()}.xlsx`;
    el.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="stack">
      <div className="page-head">
        <h2><a href="#/calc" className="small" style={{ fontWeight: 400 }}>Calculators</a> / {info.code} {info.name}</h2>
        <span className="muted small">{info.question}</span>
      </div>
      {saved && (
        <div className={saved.voidedAt ? 'errors' : 'card'} role="status">
          Saved as “{saved.title}” by {app.userName(saved.createdBy)}, {siteTime(saved.createdAt, tz, true)} (calculator version {saved.version}). Data: {saved.dataNote}.
          {saved.voidedAt && <> Voided by {app.userName(saved.voidedBy ?? '')}: {saved.voidReason}.</>}
          {saved.version !== info.version && <> The formula has changed since; the numbers below use the current version.</>}
        </div>
      )}

      {a && (
        <section className="card">
          <h3 style={{ marginTop: 0 }}>Use my data</h3>
          <FilterBar ds={app.ds} value={filter} onChange={setFilter} matched={`${a.assets.length} units, ${a.events.length} events`}
            extra={<button className="btn primary" onClick={useMyData}>Use my data</button>} />
          {dataMsg && <p className="small">{dataMsg} You can edit the values before running.</p>}
          {info.id === 'weibull' && <p className="small muted">Fleet lives assume each repair makes the unit as good as new. Filter to one system or component for a meaningful fit.</p>}
        </section>
      )}

      {(info.id === 'rebuild_pool' || info.id === 'kit_stocking') && (
        <section className="card">
          <h3 style={{ marginTop: 0 }}>Use my data</h3>
          <p className="small" style={{ margin: 0 }}>
            {info.id === 'rebuild_pool' ? 'The Spares page works out change-outs and the repair cycle for each model and component from the component history.' : 'The Spares page lists a kit for each PM job plan from the RCM library, with its parts and uses a year.'}{' '}
            <a href={`#/spares?tab=${info.id === 'rebuild_pool' ? 'pool' : 'kits'}`}>Open it</a> and follow a row's link to fill these inputs.
          </p>
        </section>
      )}

      {info.id === 'rebuild_or_replace' && <ComponentLives query={query} onUse={(next, note, msg) => { setInputs((p) => ({ ...p, ...next })); setDataNote(note); setDataMsg(msg); }} msg={dataMsg} />}

      <div className="grid two">
        <section className="card">
          <h3 style={{ marginTop: 0 }}>Inputs</h3>
          <div className="stack" style={{ gap: 10 }}>
            {FIELDS[info.id].map((f) => (
              <label key={f.key} className="field">
                <span>{f.label}{f.unit ? ` (${f.unit})` : ''}</span>
                {f.kind === 'select' ? (
                  <select value={inputs[f.key] ?? ''} onChange={(e) => set(f.key, e.target.value)}>{f.options!.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
                ) : f.kind === 'lives' || f.kind === 'list' ? (
                  <textarea rows={f.kind === 'lives' ? 8 : 3} value={inputs[f.key] ?? ''} onChange={(e) => set(f.key, e.target.value)} style={{ width: '100%' }} />
                ) : (
                  <input inputMode="decimal" value={inputs[f.key] ?? ''} onChange={(e) => set(f.key, e.target.value)} />
                )}
                {f.hint && <span className="small muted">{f.hint}</span>}
              </label>
            ))}
            <p className="small muted" style={{ margin: 0 }}>Data: {dataNote}</p>
          </div>
        </section>

        <section className="card">
          <h3 style={{ marginTop: 0 }}>Result</h3>
          {'errors' in run ? (
            <div className="errors" role="alert">{run.errors.join(' ')}</div>
          ) : (
            <>
              <p style={{ fontSize: 17 }}>{run.out.sentence}</p>
              {'band' in run.out && <p><strong>{String(run.out.band)}</strong></p>}
              {run.out.warnings.length > 0 && <div className="warns small" role="status">{run.out.warnings.map((w) => <div key={w}>⚠ {w}</div>)}</div>}
              <table className="small">
                <tbody>
                  {Object.entries(run.out.values).filter(([, v]) => v !== null).map(([k, v]) => (
                    <tr key={k}><th style={{ textAlign: 'left', fontWeight: 400 }}>{VALUE_LABELS[k]?.[0] ?? k}</th><td><strong>{VALUE_LABELS[k]?.[1](v!) ?? String(v)}</strong></td></tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </section>
      </div>

      {ok && <Chart id={info.id} run={ok} />}
      {info.id === 'repair_times' && a && <RepairGroups rows={repairRows} />}

      <section className="card">
        <h3 style={{ marginTop: 0 }}>Formula</h3>
        <p><code>{info.formula}</code></p>
        <p className="small"><strong>Assumptions:</strong> {EXAMPLE[info.id].assumptions}</p>
        <p className="small"><strong>Worked example:</strong> {EXAMPLE[info.id].text} <button className="linklike" onClick={() => { setInputs({ ...EXAMPLE[info.id].inputs }); setDataNote('Typed in'); setDataMsg(null); }}>Load it</button></p>
        <p className="small muted">Version {info.version}. Checked against SciPy; see the specification sheet in docs/calculators.md.</p>
      </section>

      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <button className="btn" disabled={!ok} onClick={() => void exportXlsx()}>Export to Excel</button>
        <a className="btn" style={linkBtn} href="#/calc">All calculators</a>
      </div>
      {ok && !saved && <SaveBox info={info} run={ok} inputs={inputs} dataNote={dataNote} />}
      {saved && !saved.voidedAt && <VoidBox saved={saved} />}
    </div>
  );
}

function SaveBox({ info, run, inputs, dataNote }: { info: CalculatorInfo; run: Run; inputs: Inputs; dataNote: string }) {
  const app = useApp();
  const [title, setTitle] = useState('');
  const [unitId, setUnitId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [rcaId, setRcaId] = useState('');
  const [msg, setMsg] = useState<ReactNode>(null);
  if (!can(app.actor, 'run_analyses')) return <p className="small muted">Supervisors, reliability engineers and superintendents can save analyses.</p>;
  const save = () => {
    const r = app.runAnalysis((ctx, list) => saveAnalysis(ctx, list, {
      calculator: info.id, title, inputs: { form: inputs, parsed: run.parsed }, result: run.out.values, sentence: run.out.sentence, dataNote,
      links: { ...(unitId ? { unitId } : {}), ...(projectId ? { projectId } : {}), ...(rcaId ? { rcaId } : {}) },
    }));
    if (!r.ok) return setMsg(<span className="errors">{r.errors.join(' ')}</span>);
    const id = r.audit[0]!.entityId;
    setMsg(<span>Saved. <a href={`#/calc/${info.id}/${id}`}>Open it</a></span>);
    setTitle('');
  };
  return (
    <section className="card">
      <h3 style={{ marginTop: 0 }}>Save</h3>
      <div className="grid two">
        <label className="field"><span>Title</span><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="For example 793F wheel motors, 2026" /></label>
        <label className="field"><span>Unit (optional)</span>
          <select value={unitId} onChange={(e) => setUnitId(e.target.value)}><option value="">None</option>{app.ds.assets.map((u) => <option key={u.id} value={u.id}>{u.unitNumber}</option>)}</select>
        </label>
        <label className="field"><span>Project (optional)</span>
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)}><option value="">None</option>{app.projects.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}</select>
        </label>
        <label className="field"><span>RCA (optional)</span>
          <select value={rcaId} onChange={(e) => setRcaId(e.target.value)}><option value="">None</option>{app.rcas.map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}</select>
        </label>
      </div>
      <div className="row" style={{ gap: 8, marginTop: 8 }}>
        <button className="btn primary" onClick={save}>Save analysis</button>
        {msg && <span className="small" role="status">{msg}</span>}
      </div>
    </section>
  );
}

function VoidBox({ saved }: { saved: SavedAnalysis }) {
  const app = useApp();
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  if (!can(app.actor, 'run_analyses')) return null;
  return (
    <section className="card">
      <h3 style={{ marginTop: 0 }}>Void this analysis</h3>
      <p className="small muted">Saved analyses are never deleted. A voided one stays on the list with its reason.</p>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <input aria-label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason" style={{ flex: 1, minWidth: 200 }} />
        <button className="btn" onClick={() => { const r = app.runAnalysis((ctx, list) => voidAnalysis(ctx, list, saved.id, reason)); setErr(r.ok ? null : r.errors.join(' ')); }}>Void</button>
      </div>
      {err && <p className="errors" role="alert">{err}</p>}
    </section>
  );
}

// ---------- charts ----------

const axis = { fontSize: 12, fill: 'var(--text-2)' };

function Chart({ id, run }: { id: CalculatorId; run: Run }) {
  if (id === 'weibull') {
    const w = run.out as unknown as { beta: number; eta: number; plot: Array<{ t: number; f: number }> };
    // Weibull paper: x = ln t, y = ln(−ln(1 − F)). The line is the maximum likelihood fit.
    const y = (f: number) => Math.log(-Math.log(1 - f));
    const pts = w.plot.map((p) => ({ x: Math.log(p.t), y: y(p.f), t: p.t, f: p.f }));
    const xs = pts.map((p) => p.x);
    const lo = Math.min(...xs) - 0.2;
    const hi = Math.max(...xs) + 0.2;
    const line = [lo, hi].map((x) => ({ x, fit: w.beta * (x - Math.log(w.eta)) }));
    const ticks = [0.01, 0.05, 0.1, 0.2, 0.5, 0.632, 0.9, 0.99];
    return (
      <section className="card">
        <h3 style={{ marginTop: 0 }}>Weibull probability plot</h3>
        <div style={{ height: 300 }}>
          <ResponsiveContainer>
            <ComposedChart margin={{ top: 8, right: 16, bottom: 20, left: 10 }}>
              <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
              <XAxis type="number" dataKey="x" domain={[lo, hi]} tick={axis} tickFormatter={(v: number) => Math.round(Math.exp(v)).toLocaleString('en-CA')} label={{ value: 'Operating hours (log scale)', position: 'insideBottom', offset: -12, fill: 'var(--text-2)', fontSize: 12 }} />
              <YAxis type="number" dataKey="y" ticks={ticks.map(y)} domain={[y(0.005), y(0.995)]} tick={axis} tickFormatter={(v: number) => `${Math.round((1 - Math.exp(-Math.exp(v))) * 1000) / 10}%`} />
              <Tooltip formatter={(v: number, name: string) => (name === 'Fit' ? [`${(100 * (1 - Math.exp(-Math.exp(v)))).toFixed(1)}%`, name] : [`${(100 * (1 - Math.exp(-Math.exp(v)))).toFixed(1)}%`, 'Median rank'])} labelFormatter={(v: number) => `${Math.round(Math.exp(v)).toLocaleString('en-CA')} h`} />
              <Legend verticalAlign="top" height={24} />
              <Line data={line} dataKey="fit" name="Fit" stroke="var(--brand)" strokeWidth={2} dot={false} isAnimationActive={false} />
              <Scatter data={pts} dataKey="y" name="Failures" fill="var(--down)" isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <p className="small muted">Failures plotted at median ranks (Bernard, with Johnson's adjusted ranks for suspensions). The plot is a picture only; the fit is the maximum likelihood one.</p>
      </section>
    );
  }
  if (id === 'conditional_weibull') {
    const p = run.parsed as { beta: number; eta: number; age: number; mission: number };
    const data = conditionalCurve(p.beta, p.eta, p.age, Math.max(p.mission * 2, p.eta * 0.5)).map((d) => ({ t: Math.round(d.t), r: Math.round(d.r * 1000) / 10 }));
    return (
      <section className="card">
        <h3 style={{ marginTop: 0 }}>Chance of running without failure, from {Math.round(p.age).toLocaleString('en-CA')} h</h3>
        <div style={{ height: 260 }}>
          <ResponsiveContainer>
            <LineChart data={data} margin={{ top: 8, right: 16, bottom: 20, left: 0 }}>
              <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
              <XAxis dataKey="t" type="number" tick={axis} label={{ value: 'Hours ahead', position: 'insideBottom', offset: -12, fill: 'var(--text-2)', fontSize: 12 }} />
              <YAxis unit="%" domain={[0, 100]} tick={axis} />
              <Tooltip formatter={(v: number) => [`${v}%`, 'No failure']} labelFormatter={(v: number) => `${v.toLocaleString('en-CA')} h ahead`} />
              <Line dataKey="r" stroke="var(--brand)" strokeWidth={2} dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </section>
    );
  }
  if (id === 'repair_times') {
    const h = (run.out as unknown as { histogram: Array<{ from: number; to: number; n: number }> }).histogram.map((b) => ({ bin: `${b.from}–${b.to}`, n: b.n }));
    return (
      <section className="card">
        <h3 style={{ marginTop: 0 }}>Repairs by duration (h)</h3>
        <div style={{ height: 240 }}>
          <ResponsiveContainer>
            <BarChart data={h} margin={{ top: 8, right: 16, bottom: 4, left: -10 }}>
              <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="bin" tick={axis} />
              <YAxis allowDecimals={false} tick={axis} />
              <Tooltip formatter={(v: number) => [v, 'Repairs']} labelFormatter={(v: string) => `${v} h`} />
              <Bar dataKey="n" name="Repairs" fill="var(--brand)" radius={[4, 4, 0, 0]} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>
    );
  }
  if (id === 'poisson_spares' || id === 'rebuild_pool') {
    const curve = (run.out as unknown as { curve: Array<{ s: number; fill: number; total?: number | null }> }).curve;
    const target = (run.parsed as { target: number }).target;
    const costs = curve.some((c) => c.total !== null && c.total !== undefined);
    // Very small pools cost so much in downtime that they would flatten the line; leave them off it.
    const least = Math.min(...curve.map((c) => c.total ?? Infinity));
    const data = curve.map((c) => ({ s: c.s, fill: Math.round(c.fill * 1000) / 10, total: c.total !== null && c.total !== undefined && c.total <= least * 4 ? c.total : null }));
    return (
      <section className="card">
        <h3 style={{ marginTop: 0 }}>Fill rate{costs ? ' and total cost' : ''} by {id === 'rebuild_pool' ? 'pool size' : 'stock level'}</h3>
        <div style={{ height: 260 }}>
          <ResponsiveContainer>
            <ComposedChart data={data} margin={{ top: 8, right: costs ? 8 : 16, bottom: 20, left: 0 }}>
              <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="s" tick={axis} label={{ value: id === 'rebuild_pool' ? 'Spares in the pool' : 'Stock (on the shelf and on order)', position: 'insideBottom', offset: -12, fill: 'var(--text-2)', fontSize: 12 }} />
              <YAxis yAxisId="f" unit="%" domain={[0, 100]} tick={axis} />
              {costs && <YAxis yAxisId="c" orientation="right" tick={axis} tickFormatter={(v: number) => `$${Math.round(v / 1000).toLocaleString('en-CA')}k`} />}
              <Tooltip formatter={(v: number, name: string) => (name === 'Fill rate' ? [`${v}%`, name] : [`$${Math.round(v).toLocaleString('en-CA')}`, name])} labelFormatter={(v: number) => `${v} ${id === 'rebuild_pool' ? 'in the pool' : 'in stock'}`} />
              <Legend verticalAlign="top" height={24} />
              <Bar yAxisId="f" dataKey="fill" name="Fill rate" fill="var(--brand)" isAnimationActive={false} radius={[4, 4, 0, 0]}>
                {data.map((d) => <Cell key={d.s} fill={d.fill >= target * 100 ? 'var(--brand)' : 'color-mix(in srgb, var(--brand) 35%, var(--surface))'} />)}
              </Bar>
              {costs && <Line yAxisId="c" dataKey="total" name="Total cost a year" stroke="var(--down)" strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} />}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <p className="small muted">Solid bars meet the {Math.round(target * 1000) / 10}% target.{costs ? ' Total cost = carrying the pool + down hours waiting × cost per down hour.' : ''}</p>
      </section>
    );
  }
  if (id === 'kit_stocking') {
    const parts = (run.out as unknown as { parts: KitPartResult[] }).parts;
    const money = (x: number) => `$${Math.round(x).toLocaleString('en-CA')}`;
    return (
      <section className="card">
        <h3 style={{ marginTop: 0 }}>Stock for each part</h3>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Item</th><th>Description</th><th>Per kit</th><th>Lead time (days)</th><th>Mean kits on order</th><th>Kits' worth</th><th>Keep</th><th>Part fill rate</th><th>Value</th></tr></thead>
            <tbody>
              {parts.map((p) => (
                <tr key={p.item}><td>{p.item}</td><td>{p.description ?? ''}</td><td>{p.qty}</td><td>{p.leadDays}</td><td>{p.mean.toFixed(2)}</td><td>{p.kits}</td><td><strong>{p.stock}</strong></td><td>{(p.fill * 100).toFixed(2)}%</td><td>{p.value === null ? '—' : money(p.value)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="small muted">Keep = quantity per kit × kits' worth, on the shelf and on order. Reorder one kit's worth each time a kit is used.</p>
      </section>
    );
  }
  if (id === 'lifetime_buy') {
    const curve = (run.out as unknown as { curve: Array<{ q: number; cdf: number }> }).curve.map((c) => ({ q: c.q, p: Math.round(c.cdf * 1000) / 10 }));
    const v = run.out.values;
    return (
      <section className="card">
        <h3 style={{ marginTop: 0 }}>Chance the buy lasts to the end</h3>
        <div style={{ height: 260 }}>
          <ResponsiveContainer>
            <LineChart data={curve} margin={{ top: 8, right: 16, bottom: 20, left: 0 }}>
              <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
              <XAxis dataKey="q" type="number" domain={['dataMin', 'dataMax']} tick={axis} label={{ value: 'Total on hand and bought', position: 'insideBottom', offset: -12, fill: 'var(--text-2)', fontSize: 12 }} />
              <YAxis unit="%" domain={[0, 100]} tick={axis} />
              <Tooltip formatter={(x: number) => [`${x}%`, 'Lasts to the end']} labelFormatter={(x: number) => `${x} in all`} />
              <Line dataKey="p" stroke="var(--brand)" strokeWidth={2} dot={false} isAnimationActive={false} />
              {v.needTotal !== null && <ReferenceLine x={v.needTotal} stroke="var(--text-2)" strokeDasharray="4 4" label={{ value: `${v.needTotal}`, position: 'top', fill: 'var(--text-2)', fontSize: 12 }} />}
            </LineChart>
          </ResponsiveContainer>
        </div>
      </section>
    );
  }
  if (id === 'risk_matrix') {
    const p = run.parsed as { likelihood: number; consequence: number };
    const colour = (s: number) => ({ Low: 'var(--run)', Medium: '#d4b000', High: 'var(--sched)', Extreme: 'var(--down)' } as Record<string, string>)[RISK_BANDS.find((b) => s <= b.max)!.band];
    return (
      <section className="card">
        <h3 style={{ marginTop: 0 }}>Risk matrix</h3>
        <div role="table" aria-label="Risk matrix" style={{ display: 'grid', gridTemplateColumns: 'auto repeat(5, minmax(36px, 56px))', gap: 2, width: 'fit-content', fontSize: 13 }}>
          {[5, 4, 3, 2, 1].map((l) => (
            <div key={l} role="row" style={{ display: 'contents' }}>
              <div role="rowheader" className="small muted" style={{ paddingRight: 6, alignSelf: 'center' }}>L{l}</div>
              {[1, 2, 3, 4, 5].map((c) => {
                const s = l * c;
                const here = l === p.likelihood && c === p.consequence;
                return (
                  <div key={c} role="cell" title={`${RISK_BANDS.find((b) => s <= b.max)!.band}, score ${s}`} style={{ height: 40, display: 'grid', placeItems: 'center', borderRadius: 4, background: `color-mix(in srgb, ${colour(s)} ${here ? 85 : 30}%, var(--surface))`, outline: here ? '3px solid var(--text)' : undefined, fontWeight: here ? 700 : 400 }}>{s}</div>
                );
              })}
            </div>
          ))}
          <div />
          {[1, 2, 3, 4, 5].map((c) => <div key={c} className="small muted" style={{ textAlign: 'center' }}>C{c}</div>)}
        </div>
        <p className="small muted">Rows are likelihood, columns consequence. Bands: {RISK_BANDS.map((b) => `${b.band} up to ${b.max}`).join(', ')}.</p>
      </section>
    );
  }
  return null;
}

function RepairGroups({ rows }: { rows: Array<{ system: string; hours: number }> }) {
  const groups = repairBySystem(rows);
  if (!rows.length) return null;
  return (
    <section className="card">
      <h3 style={{ marginTop: 0 }}>Fleet repairs by system</h3>
      {groups.length ? (
        <div className="table-wrap">
          <table>
            <thead><tr><th>System</th><th>Repairs</th><th>Median (h)</th><th>90th percentile (h)</th></tr></thead>
            <tbody>{groups.map((g) => <tr key={g.system}><td>{g.system}</td><td>{g.count}</td><td>{g.median.toFixed(1)}</td><td>{g.p90.toFixed(1)}</td></tr>)}</tbody>
          </table>
        </div>
      ) : <p className="small muted">No system has 5 or more closed repairs in this filter.</p>}
      <p className="small muted">Systems with fewer than 5 repairs are hidden. Longest 90th percentile first.</p>
    </section>
  );
}

// ---------- Ctrl + K / Cmd + K ----------

/** Find a calculator from any page. */
export function CalcPalette() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [i, setI] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setOpen((o) => !o); setQ(''); setI(0); }
      else if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => { if (open) input.current?.focus(); }, [open]);
  if (!open) return null;
  const list = searchCalculators(q);
  const go = (c: CalculatorInfo | undefined) => { if (!c) return; window.location.hash = `#/calc/${c.id}`; setOpen(false); };
  return (
    <>
      <div className="scrim" onClick={() => setOpen(false)} />
      <div role="dialog" aria-label="Find a calculator" className="card" style={{ position: 'fixed', top: '12vh', left: '50%', transform: 'translateX(-50%)', width: 'min(520px, calc(100% - 32px))', zIndex: 12, padding: 12 }}>
        <input ref={input} type="search" value={q} aria-label="Find a calculator" placeholder="Find a calculator…" style={{ width: '100%' }}
          onChange={(e) => { setQ(e.target.value); setI(0); }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setI((x) => Math.min(x + 1, list.length - 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setI((x) => Math.max(x - 1, 0)); }
            else if (e.key === 'Enter') go(list[i]);
          }} />
        <div role="listbox" style={{ marginTop: 8, maxHeight: '50vh', overflow: 'auto' }}>
          {list.map((c, k) => (
            <div key={c.id} role="option" aria-selected={k === i} onMouseEnter={() => setI(k)} onClick={() => go(c)}
              style={{ padding: '8px 10px', borderRadius: 6, cursor: 'pointer', background: k === i ? 'color-mix(in srgb, var(--brand) 15%, var(--surface))' : undefined }}>
              <strong>{c.code} {c.name}</strong>
              <div className="small muted">{c.question}</div>
            </div>
          ))}
          {!list.length && <p className="muted small">No calculator matches.</p>}
        </div>
      </div>
    </>
  );
}

// ---------- C-11: fill expected lives from the component history ----------

function ComponentLives({ query, onUse, msg }: { query: string; onUse: (next: Inputs, note: string, msg: string) => void; msg: string | null }) {
  const app = useApp();
  const q = new URLSearchParams(query);
  const models = [...new Set(app.ds.assets.map((a) => a.model))].sort();
  const [kind, setKind] = useState<ComponentKind>((q.get('kind') as ComponentKind) ?? 'engine');
  const [model, setModel] = useState(q.get('model') ?? models[0] ?? '');
  const lives = useMemo(() => allLives(componentStates(app.components, app.componentEvents, app.ds.assets, smuIndex(app.ds.smu), app.now)), [app.components, app.componentEvents, app.ds, app.now]);
  const m = meanLives(lives, kind, model || undefined);
  const use = () => {
    const next: Inputs = {};
    if (m.rebuilt !== null) next.rebuildLife = String(Math.round(m.rebuilt));
    if (m.fresh !== null) next.newLife = String(Math.round(m.fresh));
    const parts = [m.rebuilt !== null ? `rebuilt ${Math.round(m.rebuilt).toLocaleString('en-CA')} h` : 'too few rebuilt lives', m.fresh !== null ? `new ${Math.round(m.fresh).toLocaleString('en-CA')} h` : 'too few new lives'];
    onUse(next, `Component history: ${KIND_LABELS[kind].toLowerCase()}, ${model}, mean ended life`, `Mean ended life: ${parts.join(', ')} (at least 3 lives each).`);
  };
  return (
    <section className="card">
      <h3 style={{ marginTop: 0 }}>Use my data</h3>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'end' }}>
        <label className="field"><span>Component</span><select value={kind} onChange={(e) => setKind(e.target.value as ComponentKind)}>{COMPONENT_KINDS.map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}</select></label>
        <label className="field"><span>Model</span><select value={model} onChange={(e) => setModel(e.target.value)}>{models.map((x) => <option key={x}>{x}</option>)}</select></label>
        <button className="btn primary" onClick={use}>Use my data</button>
      </div>
      {msg && <p className="small">{msg} Prices stay as typed: enter your current quotes.</p>}
    </section>
  );
}
