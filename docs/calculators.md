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
| Maintenance strategy (phase 3) | P-F inspection interval | No |
| Maintenance strategy (phase 3) | Optimal replacement interval | Weibull fit from C-05 |
| Maintenance strategy (phase 3) | Failure-finding interval | No |
| Maintenance strategy (phase 3) | Strategy cost comparison | Weibull fit from C-05 |
| Spares (phase 3) | Spares for a fill rate (Poisson) | PM part uses a year from RCM |
| Spares (phase 3) | Rebuild pool | Change-outs and repair cycle from the component history |
| Spares (phase 3) | Kit stocking | PM kits from RCM job plans |
| Spares (phase 3) | Lifetime buy | No |

Pareto and jack-knife are already on the downtime analysis page. The RCM interval calculators C-12 to C-15 came with RCM (docs/rcm.md), and the spares
calculators C-16 to C-19 with spares sizing (docs/spares.md). Later parts add Crow-AMSAA, simulation
and the rest of 7.2.

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

## C-12 P-F inspection interval (phase 3, RCM)

- **Formula:** interval = the smaller of P-F interval ÷ n and P-F interval − lead time.
  - The P-F interval is the time from when a warning sign can first be found (P) to the failure (F).
  - n is the number of checks inside the P-F interval (2 by default, so a warning is found with at
    least half of the P-F interval left).
  - The lead time is how long it takes to plan, get parts and do the repair once the warning is
    found.
- **Assumptions:** the P-F interval is fairly steady. A wide spread needs a larger n.
- **Worked example:**
  - P-F 1,000 h, n = 2 and a 200 h lead time give min(500, 800) = 500 h.
  - With a 600 h lead time: min(500, 400) = 400 h.
- **Reference:** Moubray, *Reliability-centred Maintenance* (2nd ed.), chapter 7; SAE JA1012
  section 9.
- **Warning:** if the lead time is longer than the P-F interval, no interval works, because the
  warning comes too late to act.

## C-13 Optimal replacement interval (phase 3, RCM)

- **Formula:** the age T that gives the lowest cost per operating hour,
  C(T) = (Cp × R(T) + Cu × (1 − R(T))) ÷ ∫₀ᵀ R(t) dt, with R(t) = exp(−(t/η)^β).
  - Cp is the cost of a planned replacement and Cu the cost of a failure, including downtime.
  - The integral is the mean operating hours per cycle.
  - It is compared with run to failure: Cu ÷ MTBF, where MTBF = η × Γ(1 + 1/β).
- **Assumptions:** the Weibull fit describes the item; a replacement makes it as good as new; the
  cost of each kind of change does not depend on the age.
- **Method:** Simpson's rule for the integral, and a coarse search followed by golden-section search
  for the lowest cost.
- **Worked example:**
  - β = 3, η = 10,000 h, Cp = $40,000, Cu = $160,000.
  - T* = 5,542 h, at $11.06 an hour. 84.4% of items reach T* without failing.
  - Run to failure costs $17.92 an hour (MTBF 8,930 h).
- **Reference:** checked with SciPy 1.18 (`integrate.quad` and `optimize.minimize_scalar`):
  T* = 5,541.5 h, C(T*) = 11.0551.
- **Warnings:**
  - β of 1 or less: the failure rate does not rise with age, so replacement on age does not help.
  - Cu no more than Cp: replacing early cannot save money.

## C-14 Failure-finding interval (phase 3, RCM)

- **Formula:** FFI = 2 × U × M, where U is the unavailability the site accepts for the protective
  device and M its MTBF.
  - The unavailability this gives is checked with U = 1 − (M ÷ FFI) × (1 − exp(−FFI ÷ M)).
- **Assumptions:** one protective device; failures at random (constant rate); the check finds every
  failure and the device is repaired straight away.
- **Worked example:** M = 20,000 h and U = 1% give FFI = 400 h. The exact unavailability at 400 h is
  0.993%.
- **Reference:** Moubray, chapter 8; checked with SciPy 1.18 arithmetic.
- **Warning:** when FFI ÷ M is above 0.2, the simple formula gets less accurate; the page shows the
  exact unavailability.

## C-15 Strategy cost comparison (phase 3, RCM)

- **Formulas**, each as a cost per operating hour:
  - Run to failure = Cu ÷ MTBF.
  - Time-based = C(T*) from C-13.
  - Condition-based = Ci ÷ I + (p × Cc + (1 − p) × Cu) ÷ MTBF.
  - Ci is the cost of one inspection, I the inspection interval, p the chance an inspection finds
    the warning in time, and Cc the cost of a planned repair after a warning.
- **Assumptions:** failures start at the same rate under each strategy; a found warning becomes a
  planned repair; a missed one becomes a failure.
- **Worked example:**
  - β = 3, η = 10,000 h, Cu = $160,000, Cp = $40,000, Ci = $500, I = 500 h, p = 0.9, Cc = $40,000.
  - Run to failure costs $17.92 an hour.
  - Time-based costs $11.06 an hour, replacing at 5,542 h.
  - Condition-based costs $6.82 an hour, so it is the cheapest.
- **Reference:** arithmetic, with C-13 for the time-based figure.

## Spares calculators (phase 3)

C-16 to C-18 use one model, set out in `docs/spares.md`: one-for-one reorder, Poisson demand, and
N = the number on order or at rebuild, Poisson with mean m = demand a year × lead time in days ÷ 365.

- Fill rate F(s) = P(N ≤ s − 1), the chance a part is on the shelf when one is needed.
- No stock-out in a lead time = P(N ≤ s).
- Expected backorders EBO(s) = Σ (n − s) P(N = n) for n > s.

The Poisson probabilities are summed in log form, so they work for large means. Means above 100,000
are refused.

## C-16 Spares for a fill rate (Poisson)

- **Formula:** the smallest stock s with F(s) ≥ the target fill rate.
- **Inputs:** uses a year, lead time in days, target fill rate, and the unit cost (optional, for the
  stock value).
- **Assumptions:** the model above. Keep s on the shelf and on order, and order one each time one is
  used.
- **Worked example:**
  - 6 a year with a 60 day lead time: m = 0.986.
  - 95% target: s = 4, fill rate 98.18%, no stock-out in a lead time 99.65%, EBO 0.0041.
  - s = 3 would give a fill rate of 92.2%, below the target.
- **Reference:** Sherbrooke, *Optimal Inventory Modeling of Systems* (2nd ed.), chapter 2; checked
  with SciPy 1.18 `stats.poisson`.
- **Warning:** a mean below 0.05 in a lead time is a slow mover: keeping one is an insurance decision
  (consequence of not having it), not a statistics one.

## C-17 Rebuild pool

- **Formulas:** the same model, with the repair cycle as the lead time.
  - Pool for the target = the smallest s with F(s) ≥ target.
  - Waiting = EBO(s) × 365 unit-days a year; down hours waiting = EBO(s) × 8,760.
  - With costs: total a year = s × carrying cost of one spare a year + EBO(s) × 8,760 × cost per down
    hour. The lowest-cost pool is the s with the lowest total.
- **Inputs:** change-outs a year, repair cycle in days (removal to back in stores), target fill rate,
  and optionally the carrying cost of one spare a year and the cost per down hour (C-03).
- **Assumptions:** a unit waiting for a component is down all day. A scrapped component is replaced
  within the repair cycle.
- **Worked example:**
  - 12 change-outs a year with a 75 day cycle: m = 2.466.
  - 95% target: pool 6, fill rate 96.02%, EBO 0.0185, 6.8 unit-days (162 down hours) waiting a year.
  - At $60,000 a year to carry a spare and $2,500 a down hour, the lowest-cost pool is 8, at $509,674
    a year (pool 6 costs $765,771).
- **Reference:** Sherbrooke chapter 2 (Palm's theorem); checked with SciPy 1.18 `stats.poisson`.

## C-18 Kit stocking

- **Problem:** a kit of several parts is used k times a year, taking q of each part. A kit can be used
  only when every part is on the shelf. Each part has its own lead time.
- **Formula:** stock part i in whole kits, S = q × k. Part i is short when Nᵢ ≥ k, with Nᵢ Poisson
  with mean kit uses a year × its lead time ÷ 365, so its fill rate is Fᵢ(k) = P(Nᵢ ≤ k − 1).
  - Kit fill rate ≥ the product of the part fill rates. The parts are short at the same times (the
    same kit uses drive them), so the true rate is at least the product and at most the lowest part
    fill rate. The page shows both.
  - The stock is found by greedy marginal analysis: start at one kit of each part, then add one kit's
    worth of the part that raises the log of the product most per dollar, until the product reaches
    the target. Poisson is log-concave, so each step is the best value for money, and
    the result lies on the cheapest cost and fill rate curve (Sherbrooke).
- **Inputs:** kit uses a year, target kit fill rate, and the parts: item, quantity per kit, lead time
  in days, unit cost. A blank cost counts as 1, so the parts are then treated alike.
- **Assumptions:** the model above, and the parts are not used elsewhere. A part also used outside the
  kit needs its own demand added in C-16.
- **Worked example:**
  - 24 kits a year, 95% target. Filter: 2 per kit, 14 days, $80. Seal kit: 1, 45 days, $350. Pump: 1,
    90 days, $4,200.
  - Stock 12 filters (6 kits), 9 seal kits and 11 pumps. Kit fill rate at least 95.70% and at most
    96.07%. Stock value $50,310.
- **Reference:** Sherbrooke chapter 2 (marginal analysis); Esary, Proschan and Walkup (1967) for the
  lower bound on associated variables; checked with SciPy 1.18 and a simulation in the unit tests.

## C-19 Lifetime buy

- **Problem:** a part is being discontinued. How many to buy now to last the rest of the fleet's life?
- **Formula:**
  - Expected demand to the end D̄ = d × ((1 + g)^Y − 1) ÷ ln(1 + g), or d × Y when g = 0, where d is
    uses a year now, Y the years left and g the yearly change in uses (negative as units retire).
  - Total demand is Poisson with mean D̄. Total needed Q = the smallest Q with P(D ≤ Q) ≥ the
    confidence. Buy = Q − on hand, and not below 0.
  - Expected left over = E[(Q − D)⁺]; expected short = E[(D − Q)⁺].
  - With a shortage cost: cost-balanced total = the smallest Q with P(D ≤ Q) ≥ Cs ÷ (Cs + Co), where
    Cs = shortage cost − unit cost (the extra cost of being short of one) and Co = unit cost −
    salvage (the cost of one left over).
- **Inputs:** uses a year now, years left, yearly change in %, confidence, on hand, unit cost, and
  optionally the salvage value and the cost of being short of one (getting one another way, plus
  downtime).
- **Assumptions:** demand is random around the trend; parts on hand do not wear out on the shelf.
- **Worked example:**
  - 10 a year now, 6 years left, −10% a year, 90% confidence, 5 on hand, $2,000 each.
  - D̄ = 44.47. Q = 53, so buy 48 ($96,000). Expected left over 8.88, expected short 0.35.
  - Salvage $200 and a shortage cost of $15,000: critical ratio 13,000 ÷ 14,800 = 0.878, so Q = 52
    and buy 47.
- **Reference:** newsvendor model (Silver, Pyke and Thomas, *Inventory and Production Management in
  Supply Chains*, 4th ed., chapter 6); checked with SciPy 1.18 `stats.poisson`.
