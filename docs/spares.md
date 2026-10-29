# Spares and rebuild pool sizing

Phase 3. This covers the "Spares" group of plan 7.2 (Poisson spares at a confidence level, multi-part
kits, rebuild pool, lifetime buy) and the "Critical spares" line of plan 4. The calculators are C-16
to C-19 in `docs/calculators.md`. The page code is in `packages/core/src/spares.ts`.

The ERP stays the system of record for parts, stock and reorder settings (plan 1). The platform works
out how many to keep and shows the reasons. A planner then changes the stock levels in Maximo. Nothing
is written back.

## The model behind every number

Every spares number on the page and in C-16 to C-18 uses the same model, so the results agree:

- **One-for-one reorder.** Each time a part is used, one is ordered (or a removed component is sent
  for rebuild). The stock level s is what is on the shelf plus what is on order or at rebuild.
- **Demand is random at a steady rate** (Poisson). Then the number on order at any moment is Poisson
  with mean = demand per year × lead time in years (Palm's theorem). This holds whatever the spread of
  the lead time, as long as orders do not overtake each other in a way that changes the mean.
- **Fill rate** = the chance a part is on the shelf when one is needed = P(N ≤ s − 1), where N is
  the number on order.
- **Expected backorders** (EBO) = the average number of needs waiting for a part at any moment =
  Σ (n − s) P(N = n) over n above s.
- **Waiting** = EBO × 365 unit-days a year: by Little's law, the days spent waiting for a part across
  all needs in a year.

The **confidence level** in the plan is the fill rate. The site target is the setting `fillTarget`
(95% by default). The page also shows the chance of no stock-out in one lead time, P(N ≤ s), because
some people use that meaning. It is always higher than the fill rate for the same s.

Assumptions shown on the page:

- PM demand is regular, not random. Poisson then gives a little more stock than a perfectly regular
  demand needs; the extra covers PMs brought forward and breakdowns.
- A scrapped component is replaced by a purchase. The page assumes the purchase arrives within the
  repair cycle; a longer purchase lead time needs more spares.

## Rebuild pool (plan 4 "Critical spares", rotables)

For each model and component kind (engine, transmission and the rest from `docs/component-life.md`):

| Column | How it is worked out |
| --- | --- |
| Installed | Components of that kind installed on units of the model now |
| Pool now | Components of that kind that fit the model, in stores or at rebuild. A component that fits more than one model is counted for each, and marked shared |
| Change-outs a year, history | Removals in the last 365 days from units of the model, for failure or planned. Removals for access or a swap ("other") are left out, because the component goes back on |
| Change-outs a year, forecast | Change-outs due in the next 365 days from the change-out forecast (at target life, `docs/component-life.md`). Failures before target are not in it |
| Change-outs used | The larger of the two by default (setting `demandBasis`: larger, history or forecast) |
| Repair cycle | Mean days from Removed to Back from rebuild, for components of that kind and model that came back in the last 730 days (setting `cycleWindowDays`). Needs 3 or more (setting `minCycles`); otherwise the setting `defaultCycleDays` (90) is used and marked |
| Pool needed | The smallest pool with a fill rate at or above `fillTarget` (C-17) |
| Fill rate now | The fill rate with the pool now |
| Waiting now | Expected unit-days a year waiting for a component with the pool now |
| Verdict | Short by n (pool now below pool needed), Enough, or n more than needed (pool now more than needed by 2 or more) |

The repair cycle runs from removal, so it includes time in stores before the component is sent. A
removal followed by an install (the component went straight back on) or a scrap is not a cycle.

Each row links to C-17 with its numbers filled in, to add the costs and find the pool with the lowest
total cost.

## PM parts from RCM

For each model with an RCM library (`docs/rcm.md`), each part on a scheduled task:

- **Uses a year** = quantity × fleet hours a year ÷ the PM level the task is packaged into. The task
  is done every time a PM at that level or a larger one that holds it is done, so every level hours.
- **Fleet hours a year** = the sum of each unit's burn rate (`docs/component-life.md`) × 365. Parked
  units count 0.
- Parts with the same item number are added up across tasks and models.

Each part links to C-16 with the uses a year filled in. The lead time is the setting `leadDays` (30)
until it is typed in, because lead times live in the ERP.

**PM kits.** Each job plan from the current library is a kit: all the parts of its tasks. Kit uses a
year = fleet hours a year × the share of PMs done at that level ÷ the level hours.

- With nested PMs (RCM setting `nested`), a PM at hour h is the largest level that divides h, among
  the levels that are multiples of this one. So a 500 h kit is used at 500, 1,500, 2,500 h and so on,
  and the 1,000 h kit at 1,000 and 3,000 h when there is a 2,000 h level.
- Without nested PMs, each level is done every level hours.

Each kit links to C-18 with its parts and uses a year filled in.

## Settings

Site settings, changed by people with `edit_spares`, with a reason and an audit entry:

| Setting | Default | Meaning |
| --- | --- | --- |
| `fillTarget` | 0.95 | Target fill rate (confidence level) |
| `demandBasis` | larger | Change-outs a year from history, forecast or the larger |
| `cycleWindowDays` | 730 | How far back repair cycles are taken |
| `minCycles` | 3 | Fewest repair cycles before the measured mean is used |
| `defaultCycleDays` | 90 | Repair cycle used with too few cycles |
| `leadDays` | 30 | Lead time filled into C-16 and C-18 from the PM parts list |

## Who can do what

| Action | Roles |
| --- | --- |
| See the spares page | Everyone at the site |
| Change spares settings | Reliability engineer, superintendent (`edit_spares`) |
| Save a calculator result | Supervisor, reliability engineer, superintendent (`run_analyses`, as for every calculator) |

Plan 11.2 has no row for spares. Settings follow the RCM settings.

## Later

- Importing ERP item usage, stock on hand and lead times (A3 mapping) to size every critical spare,
  not only rotables and PM parts.
- Component values from the cost table to find the lowest-cost pool on the page itself, for the
  roles that can see costs.
