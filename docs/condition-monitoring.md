# Condition monitoring

Phase 3 (plan 3.3 "Condition monitoring response", 4 "Condition monitoring" and the condition
monitoring board in 4.2, 7.2 "Condition monitoring" calculators). This first release covers **oil
analysis** for the mobile fleet. Vibration, thermography and ultrasound for rotating plant come with
phase 3b (plan 4.3). Inspection findings already go through Inspections and their defects.

Everything below that the plan does not fix is a site setting (`ConditionSettings` in
`packages/core/src/condition.ts`), edited by reliability engineers, superintendents and the admin,
with a reason and an audit entry.

## Samples

A sample is one oil result for one unit and one compartment.

| Field | Notes |
| --- | --- |
| Unit, compartment | Compartments: engine, transmission, torque converter, differential, final drive LH, final drive RH, hydraulic |
| Taken at | When the sample was drawn (site time) |
| Reported at | When the lab reported it. The response clock starts here; if blank, when it was entered |
| Unit SMU | Unit hours when taken. Used for overdue samples |
| Oil hours | Hours on the oil, if the lab gives it |
| Lab reference | The lab's sample number. Unique per site, so a lab file can be loaded twice safely |
| Lab severity | The lab's own rating, mapped to the four levels below |
| Readings | Any of the elements below |
| Lab comment | Free text |

Elements:

| Element | Unit | Kind | Minimum step |
| --- | --- | --- | --- |
| Iron (Fe), copper (Cu), aluminium (Al), chromium (Cr), lead (Pb) | ppm | Wear metal, higher is worse | 5 ppm |
| Silicon (Si) | ppm | Dirt, higher is worse | 5 ppm |
| Sodium (Na), potassium (K) | ppm | Coolant, higher is worse | 5 ppm |
| Water | % | Higher is worse | 0.05% |
| Soot | % | Higher is worse (engines) | 0.3% |
| Viscosity at 100 °C | cSt | Two-sided: too low or too high | 1 cSt |

Samples are never edited or deleted. A wrong sample is voided with a reason, by the person who
entered it or a superintendent. A voided sample leaves the baseline, the board and the KPI.

## Severity

Four levels, worst last: **Normal**, **Monitor**, **Action**, **Critical**.

Lab ratings map as: A, 1, normal, ok → Normal. B, 2, monitor, caution → Monitor. C, 3, action,
abnormal, warning → Action. D, X, 4, critical, severe, urgent → Critical. Anything else is left
blank, and the import says so.

**Fleet baseline** (plan 4: "trend limits against the fleet baseline for the same model and
compartment"). For each model, compartment and element:

- Use the fleet's samples reported in the 365 days before the sample being judged (setting
  `baselineDays`), not voided, and not themselves rated Action or Critical, so bad samples do not
  widen the limits.
- With at least 20 such samples (setting `minSamples`), the baseline is their mean and standard
  deviation σ. With fewer, there is no baseline and only the lab severity counts; the screen says
  "not enough samples for a fleet baseline".
- Limits: Monitor at mean + 2σ, Action at mean + 3σ, Critical at mean + 4σ (setting `sigmas`).
  Each limit is at least one minimum step (table above) above the one below it, and the first at
  least one step above the mean, so a near-constant element (sodium at 0 to 1 ppm) does not alarm
  on 2 ppm.
- Viscosity has the same limits below the mean as well.

A sample's severity is the worse of the lab severity and the worst element against the baseline.
The reasons are kept with it, for example "Fe 84 ppm: above the action limit of 61 ppm (793F engine
fleet mean 22, 212 samples)".

**Worked out once.** The severity is worked out when the sample is entered, from the baseline at that
moment, and stored with the sample. A later change to the baseline or the settings does not change
past samples, so the response KPI does not move under people's feet. The database refuses a stored
severity lower than the lab severity.

**Rising.** On the board and the unit page, an element is marked rising when it went up on each of the
unit's last four samples for that compartment (three rises in a row) and the latest is more than 1σ
above the fleet mean. Rising does not change the severity.

Not in this release: limits per oil hour (wear metals build up with hours on the oil), and limits
per element set by the site. Both are settings to add when a site asks.

## Overdue samples

Each compartment has a sample interval in SMU hours (setting `intervals`): engine 250 h, every other
compartment 500 h.

- **Due** at the unit's SMU when the last sample was taken + interval. That SMU comes from the unit's
  meter readings, and from the sample's own SMU only when there are none, because lab files often
  carry a mistyped meter.
- **Due soon** within 10% of the interval before that.
- **Overdue** when the unit's SMU now is past due + 10% of the interval (setting `tolerancePct`,
  the same idea as PM compliance tolerance, plan 3.3).
- A compartment with no sample is listed as "no sample on record".
- Only units that are active now. Parked and decommissioned units are left out.

## Responding to a sample

A sample at Action or Critical needs a response (setting `respondTo`). Anyone who records condition
results (supervisor, reliability engineer, superintendent) can respond. A response is one of:

| Response | Needs |
| --- | --- |
| Resample | A note |
| Inspect | A note |
| Work order raised | The work order number from the ERP (no write-back, plan 1) |
| Component change planned | A note. Plan it on the component life board |
| No action | A reason |

One response per sample. It is never edited; the time is the time it was entered.

**Target time** (setting `responseHours`): Critical 24 hours, Action 72 hours, from when the lab
reported it (or when it was entered, if no report time).

**Actions raised and closed.** A response with a work order counts as an action raised. It counts as
closed once that work order, matched by number, is closed in the latest ERP import.

## KPI-032 Condition monitoring response (plan 3.3)

Alerts responded to within the target time ÷ alerts whose target time ended in the period.

- An alert is a sample at Action or Critical, not voided.
- An alert still inside its target time and not yet answered is left out until its time ends.
- An alert answered late, or not answered, counts against.
- Lead indicator. Code: `cmResponse` in `condition.ts`.

Example: four alerts with target times ending in the week. Two answered in time, one answered 10
hours late, one not answered. KPI-032 = 2 ÷ 4 = 50%.

## Lab file import

Labs export CSV from their portals (plan 2, "Oil analysis lab"). The Condition page reads one with
these headers (any case; the first match wins):

| Field | Headers |
| --- | --- |
| Unit | Unit, Unit ID, Unit No, Equipment, Asset, Asset ID |
| Compartment | Compartment, Component, Comp |
| Taken at | Sample Date, Date Sampled, Sampled, Date Taken |
| Reported at | Report Date, Date Reported, Reported, Completed |
| Lab reference | Lab No, Lab Number, Sample No, Sample ID, Lab Ref |
| Unit SMU | Unit Hours, Equipment Hours, Meter, SMU, Machine Hours |
| Oil hours | Oil Hours, Hours on Oil, Fluid Hours, Oil Age |
| Lab severity | Severity, Status, Evaluation, Rating |
| Elements | Fe or Iron, Cu or Copper, Al or Aluminium or Aluminum, Cr or Chromium, Pb or Lead, Si or Silicon, Na or Sodium, K or Potassium, Water (a header with "ppm" is divided by 10,000), Soot, V100 or Visc 100 or Viscosity |
| Lab comment | Comment, Comments, Recommendation |

Compartment names are matched loosely ("Eng", "Trans", "TC", "Diff", "Rear axle", "LH Final",
"Final drive left", "Hyd"). Rows with an unknown unit or compartment, no sample date, or a sample date
in the future are skipped and listed. Rows whose lab reference is already held are skipped as
duplicates. Dates without an offset are site time (rule 7).

## Board and screens

- **Condition board** (plan 4.2): one row per unit, one column per compartment, showing the latest
  sample's severity as a word and a shape, plus rising markers. Below it: samples waiting for a
  response, overdue samples, KPI-032 for the last 4 weeks, and actions raised and closed.
- **Control chart** (plan 7.2): pick model, compartment and element. Every fleet sample over time
  with the mean and the three limits drawn, a histogram, and one unit highlighted.
- **Unit page**: the unit's latest result per compartment and its history.
- **Component life board**: each engine, transmission, torque converter, differential and final drive
  cell shows the latest oil severity for that compartment (plan 4.2 "with oil analysis severity
  overlaid").

## Who can do what

| Action | Roles |
| --- | --- |
| See condition data | Everyone at the site |
| Enter or import samples, respond, void own samples | Supervisor, reliability engineer, superintendent (`record_condition`) |
| Void anyone's sample | Superintendent |
| Change condition settings | Reliability engineer, superintendent, admin (`edit_condition_settings`, like alert rules) |

Plan 11.2 has no row for condition monitoring. These follow the nearest rows: recording mirrors
component events, settings mirror "Edit alert rules and thresholds".
