# Calculator library (phase 2 core set)

Build plan v10 sections 7.2 and 7.3. Each calculator has the specification sheet asked for in 7.3:
formula, assumptions, inputs, a worked example, and the reference used to check it. The code is in
`packages/core/src/calculators.ts`, and every worked example below is a unit test in
`packages/core/test/calculators.test.ts`.

The answers were checked against SciPy 1.18 (`scipy.stats`), used as the reference software, unless a
line says otherwise.

## How every calculator works (7.3)

- **Readable result:** inputs, the numbers, a chart where it helps, and one plain sentence saying
  what they mean.
- **Formula shown:** the formula and this worked example are on the page.
- **Run on my data:** "Use my data" fills the inputs from the fleet for the filter chosen on the
  page.
  - The platform numbers are the KPI dictionary ones: MTBF and MTTR (KPI dictionary), failures as A7
    R9 counts them, and operating hours from SMU.
  - The filled values can be edited before running.
- **Saved:** "Save" keeps the calculator, its inputs, its result, a note of the data used (the
  filter and the period), the calculator version and the author. It can be linked to a unit, a
  project or an RCA.
  - Saved analyses are never deleted. A wrong one is voided with a reason.
  - The supervisor, reliability engineer and superintendent roles can save (plan 11.2 "Run
    calculators and analyses"). Everyone at the site can read them.
- **Export:** an Excel file with the inputs, the result and the formula.
- **Easy to find:** a search box, and Ctrl + K or Cmd + K from any page.
- **Honest about data:** warnings for small samples, such as fewer than 5 failures or fewer than 10
  repairs.

## Phase 2 set

| Group | Calculator | Uses platform data |
| --- | --- | --- |
| Availability and time | Inherent availability | MTBF, MTTR |
| Availability and time | Availability target solver | MTBF, MTTR |
| Availability and time | Cost of downtime per hour | No |
| Failure and life data | Field MTBF with lower confidence limit | Operating hours, failures |
| Failure and life data | Weibull with suspensions and confidence bounds | Hours between failures per unit |
| Failure and life data | Conditional Weibull (remaining life) | From a Weibull result |
| Maintainability | Repair time distribution | Repair durations |
| Prioritisation | Risk matrix | No |
| Cost | Cost per hour of component life | No |
| Converters | MTBF and failure rate | No |
| Cost (phase 3) | Rebuild or replace | Mean component lives from the component history |

Pareto and jack-knife are already on the downtime analysis page. Later phases add Crow-AMSAA, spares,
RCM intervals, simulation and the rest of 7.2.

---

## C-01 Inherent availability

- **Formula:** Ai = MTBF ÷ (MTBF + MTTR).
- **Assumptions:**
  - MTBF is in operating hours and MTTR is in repair hours.
  - This is the availability the design and repair times allow. It ignores waiting for parts and
    shop lines, so it is not PA, which is calendar based (KPI dictionary).
- **Inputs:** MTBF (h), MTTR (h).
- **Worked example:** MTBF 120 h and MTTR 6 h give Ai = 120 ÷ 126 = 0.9524 (95.2%).
- **Reference:** arithmetic.

## C-02 Availability target solver

- **Formulas:**
  - Required MTBF = A × MTTR ÷ (1 − A).
  - Longest MTTR allowed = MTBF × (1 − A) ÷ A.
- **Inputs:** target A (0 to 1, exclusive), and either MTTR or MTBF.
- **Worked example:**
  - A = 92% with MTTR 8 h needs MTBF ≥ 92 h.
  - A = 92% with MTBF 60 h allows MTTR ≤ 5.217 h.
- **Reference:** arithmetic.

## C-03 Cost of downtime per hour

- **Formula:** cost per hour = lost tonnes per hour × margin per tonne + other costs per hour.
- **Assumptions:** lost production is not made up later. Other costs cover items such as standby
  crew and hired equipment.
- **Worked example:** 250 t/h × $12/t + $300/h = $3,300 per down hour.
- **Reference:** arithmetic.

## C-04 Field MTBF with lower confidence limit

- **Formulas:**
  - Point estimate = T ÷ r.
  - One-sided lower limit = 2T ÷ χ²(C; ν).
- **Terms:**
  - T is the total operating hours.
  - r is the number of failures.
  - C is the confidence level.
  - ν = 2r + 2 when the observation ends at a time (field data, the default), or ν = 2r when it ends
    at a failure.
- **Assumptions:** constant failure rate (exponential), and units alike.
- **Warning:** fewer than 5 failures.
- **Worked examples:**
  - T = 1,000 h, r = 2, C = 90%, time-ended: χ²(0.90; 6) = 10.6446, so the lower limit is 187.9 h.
    The point estimate is 500 h.
  - The same data ended at a failure: χ²(0.90; 4) = 7.7794, so the lower limit is 257.1 h.
  - With no failures: χ²(0.90; 2) = 4.6052, so the lower limit is 434.3 h, and there is no point
    estimate.
- **Reference:** `scipy.stats.chi2.ppf`.

## C-05 Weibull with suspensions

- **Method:** maximum likelihood with right-censored data (suspensions). β solves

  Σ tᵢ^β ln tᵢ ÷ Σ tᵢ^β − 1/β − (1/r) Σ_failures ln tᵢ = 0

  over all times, and then η = (Σ tᵢ^β ÷ r)^(1/β).
- **Confidence bounds (Fisher matrix):**
  - The variances come from the inverse of the observed information matrix at the estimate.
  - Bounds are β × exp(± z √Var(β) ÷ β), and the same form for η.
  - z is the standard normal value for the two-sided level (90% gives z = 1.645).
- **Outputs:**
  - β and η with their bounds.
  - B10 life = η (−ln 0.9)^(1/β).
  - A probability plot using median ranks (Bernard's approximation with Johnson's adjusted ranks for
    suspensions). The plot is a picture only; the fit is the maximum likelihood one.
- **Readout:**
  - β < 1 suggests early-life failures.
  - β ≈ 1 suggests random failures, where time-based replacement does not help.
  - β > 1 suggests wear-out, where a planned replacement or inspection interval can help.
  - The readout says "about 1" when the bounds include 1.
- **Warnings:**
  - Fewer than 5 failures gives very wide bounds.
  - Fewer than 2 failures cannot be fitted.
- **Run on my data:**
  - For the units and system in the filter, each unit's operating hours between failures is a failed
    life.
  - The hours since its last failure (or since the start of the data) is a suspension.
  - This assumes each repair restores the item to as good as new. The page says so.
- **Worked example:**
  - Failures at 1200, 1850, 2400, 3100, 3900, 4600 and 5800 h, with suspensions at 2000, 3500, 5000
    and 6000 h.
  - Estimates: β = 2.155 and η = 4,868 h.
  - 90% two-sided bounds: β from 1.289 to 3.605, and η from 3,643 to 6,504 h.
  - B10 = 1,714 h.
- **Reference:** `scipy.stats.weibull_min.fit` with `CensoredData` and `floc=0` for β and η. The
  bounds come from a numerical Hessian of the same log-likelihood in NumPy.

## C-06 Conditional Weibull (remaining life)

- **Formulas:**
  - Survival over the next t hours, for an item already at T hours: R(t | T) = exp(−((T + t)/η)^β +
    (T/η)^β).
  - Median remaining life = η ((T/η)^β + ln 2)^(1/β) − T.
- **Worked example:** β = 2.1553 and η = 4,867.9 h, at T = 3,000 h:
  - R(1,000 | 3,000) = 0.7389.
  - The median remaining life is 1,969 h.
- **Reference:** direct evaluation in NumPy.

## C-07 Repair time distribution

- **Outputs:** count, mean, median and 90th percentile of repair durations, and a histogram.
  - Percentiles use linear interpolation between ranks (Excel PERCENTILE.INC).
- **Run on my data:**
  - Durations are the down hours of each downtime event in the filter.
  - By default they are grouped by system, with groups of fewer than 5 hidden.
- **Warning:** fewer than 10 repairs.
- **Worked example:** 1.5, 2, 2.5, 3, 4, 4.5, 6, 8, 12 and 30 h give a mean of 7.35 h, a median of
  4.25 h and a 90th percentile of 13.8 h.
- **Reference:** `numpy.percentile` (linear).

## C-08 Risk matrix

- **Formula:** score = likelihood (1 to 5) × consequence (1 to 5).
- **Default bands:**
  - Low: 1 to 4.
  - Medium: 5 to 9.
  - High: 10 to 16.
  - Extreme: 20 to 25.
- These bands are a starting point. A site that uses its own corporate matrix should change them
  (to confirm with Ope).
- **Worked example:** likelihood 4 × consequence 4 = 16, which is High.
- **Reference:** arithmetic.

## C-09 Cost per hour of component life

- **Formula:** (purchase + fitting + all rebuild costs) ÷ total hours of life.
- **Worked example:** $180,000 + $6,000 + two rebuilds at $45,000, over 24,000 h, comes to $11.50 per
  hour.
- **Reference:** arithmetic.

## C-10 MTBF and failure rate

- **Formulas:**
  - λ = 1 ÷ MTBF per hour.
  - Failures per million hours = 10⁶ ÷ MTBF.
  - Chance of no failure over a mission of t hours: R(t) = exp(−t ÷ MTBF), assuming a constant
    failure rate.
- **Worked example:** MTBF 500 h gives λ = 0.002 per hour, which is 2,000 per million hours. R(100 h)
  = 0.8187.
- **Reference:** arithmetic.

## C-11 Rebuild or replace (phase 3)

- **Formulas**, for each option, as a cost per hour of life:
  - Rebuild = (rebuild price + change-out hours × cost per down hour) ÷ expected life after rebuild.
  - Replace = (new price + change-out hours × cost per down hour − core credit) ÷ expected new life.
  - Break-even life = rebuild cost ÷ replace cost per hour. This is how long a rebuild must last to
    match a new one.
  - Yearly difference = the gap per hour × operating hours a year.
- **Uses platform data:** the expected lives open with the mean ended life of rebuilt and of new
  components of that kind and model, when there are at least 3 of each (docs/component-life.md).
- **Worked example:**
  - Inputs: rebuild $280,000 for 16,000 h; new $600,000 for 22,000 h; 24 h change-out at $2,500 an
    hour; $60,000 core credit; 6,000 h a year.
  - Rebuild costs $21.25 an hour and replace costs $27.27 an hour.
  - Break-even life is 12,467 h, and rebuilding saves $36,136 a year.
- **Reference:** life cycle costing arithmetic (plan 7.1 "Life cycle cost / rebuild vs replace").
