# Analytics explorer (phase 2)

Build plan 7.5 to 7.7. Code: `packages/core/src/explorer.ts`; page `#/explore`.

The downtime analysis page answers one slice at a time. The explorer adds the rest of 7.5 and 7.6:
- compare two slices;
- break any measure down by one or two dimensions;
- show spread;
- control charts;
- suggested findings;
- saved views.

It uses the same filter bar and link format as downtime analysis, so any view can be shared by its
link.

## Rows

Each **row** is one downtime event in the slice (KPI dictionary R7 grouping), with:

| Field | Meaning |
| --- | --- |
| Down h | Hours of the event's matching flags inside the period (as downtime analysis). |
| Repair h | Time in the In repair stage. |
| Wait h | Time waiting: for crew, for a line, for parts, for labour, other. |
| First wrench h | KPI-010: event start to the first In repair. Empty when it never reached In repair. |
| Failure | Counts as a failure (KPI-005, A7 R9). |

Each row also has its **dimensions**, taken from the event's first matching flag:
- system, component, failure mode;
- unit, model, fleet;
- shift and crew at the event start (site shift calendar);
- field or shop, shop line, detection method, flag type;
- day of week and hour of day (site time zone).

Named people are never a dimension (plan 11.2).

## Measures

Every measure works on any group of rows. "Matching" means the rows in the group.

| Measure | Formula |
| --- | --- |
| Events | count of rows |
| Failures | count of rows that are failures |
| Down h | sum of down h |
| Mean down h | down h ÷ events |
| Median and P90 down h | percentiles of down h (linear between ranks, as C-07) |
| MTTR | repair h ÷ rows with repair h > 0 (KPI-006) |
| Wait h | sum of wait h |
| Mean first wrench | mean of first wrench h over rows that have one (KPI-010) |
| MTBF | operating h ÷ failures (KPI-005) |

The operating hours for MTBF depend on how the rows are grouped:
- **Unit, model or fleet:** the operating hours of those units.
- **Anything else (system, shift, line and so on):** the operating hours of all units in the slice.

So "MTBF by system" means the fleet's hours between hydraulic failures.

## Compare (KPI-028)

Slice A and slice B each have their own full filter. The page shows each measure for A and B, the difference, and the change in %.

"Outside normal variation" means the difference is bigger than chance would explain for these sample sizes (two-sided p < 0.05). It is only judged when both sides have at least 5 rows.

The test depends on the measure:
- **Failure rate (MTBF):** failures per operating hour. A conditional binomial test with a normal approximation: given n = fa + fb failures, fa ~ Bin(n, Ta ÷ (Ta + Tb)).
- **Per-event durations** (down h, repair h, wait h, first wrench): Mann-Whitney U with a normal approximation and a tie correction. It compares the whole distribution, so a few long events cannot carry it alone.
- **Counts and sums** (events, down h total): shown, not tested, because they depend on the window length.

## Breakdown and heat map

Pick one dimension for a ranked table, or two for a heat map, and any measure.
- Cells with fewer than 5 rows show their count but no median, P90, mean or MTTR, as in C-07.
- Every cell drills down to its events.

## Spread

A box plot per group of a duration measure, with:
- the box from the 25th to the 75th percentile, and a line at the median;
- whiskers to the furthest point within 1.5 × the box height;
- points beyond the whiskers shown separately.

Groups with fewer than 5 rows are hidden.

## Control chart (KPI-029)

An individuals and moving range (XmR) chart of a weekly value: down h, events or failures.
- Centre line = the mean.
- Limits = mean ± 2.66 × the mean moving range. The lower limit is not below 0.
- A week outside the limits is flagged as a real change, not normal variation.
- Needs at least 6 weeks. Weeks start Monday 00:00 site time, as on the downtime page.

## Suggested findings (plan 7.7)

For each pair of system with shift, crew, field or shop, line or detection, the page compares one combination against the rest of the same system. An example combination is hydraulics on night shift, compared with hydraulics on other shifts.

The comparison uses the chosen duration measure and the Mann-Whitney test above. A combination is listed when:
- both sides have at least 5 rows;
- p < 0.01, which is stricter than compare because many combinations are tried;
- the median differs by at least 0.5 h.

The top 8 are listed, largest median difference first, each with a sentence. For example: "Hydraulics on night shift: median wait 2.1 h vs 0.6 h on other shifts (14 vs 31 events)."

Each finding opens compare with the two slices already set, and can be raised as an action.

## Saved views

- A view is a name plus the page link (filters, compare slice, measure, dimensions).
- It can be private or shared with the site.
- Anyone who can run analyses saves views (plan 11.2 "Run calculators and analyses"): supervisor, reliability engineer, superintendent. Everyone at the site sees shared views.
- Views are never deleted. They are retired with a reason, and every change goes to the audit log.

**Later:**
- a role default view;
- a weekly email of a view, which needs the mail service (phase 1b);
- cost filters, which need work order cost;
- labour, craft and contractor filters, which need crew assignment (phase 1b).

## Filters: what exists now

Plan 7.5 lists about 65 filters in nine groups. These work now:
- **Time:** range and presets, shift, crew, and new: day of week.
- **Asset:** fleet, model, unit.
- **Failure:** scheduled or unscheduled, system (include or exclude), component, detection method, failures only, and new: failure mode.
- **Repair details:** field or shop, shop line.

These wait for data the platform does not hold yet:
- work order fields, criticality, SMU and age bands, rebuilds, oil samples and cost (phase 2 to 3 imports);
- crew assignment, craft, contractor and labour hours (phase 1b);
- plant areas (phase 3b).
