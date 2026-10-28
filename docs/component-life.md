# Component life and rebuilds (phase 3)

Build plan sections 4 (module "Component life and rebuild management"), 4.2 (component life board),
7.1 (Weibull, life cycle cost) and the tier 2 KPI "Component life ratio".
Code: `packages/core/src/components.ts`. Page: `#/components`.

A major component (engine, transmission and so on) is tracked by its **serial**. It moves between
units, stores and rebuild vendors over many years. The page answers:
- How many hours has each component done against its target life?
- Which change-outs are coming up, and in which weeks?
- How long do components really last, and does it depend on the rebuild vendor?
- Which warranty claims and core returns are open?
- What does each hour of component life cost?

The ERP stays the system of record for parts and cost (plan 6.3). This module keeps the component
history that the ERP does not keep well. Later it can be filled from the ERP's rotating items.

## Positions

Haul trucks have these positions. A site can use any subset of them.

| Position | Kind |
| --- | --- |
| Engine | engine |
| Transmission | transmission |
| Torque converter | torque_converter |
| Differential | differential |
| Final drive LH, Final drive RH | final_drive |
| Front strut LH, Front strut RH | front_strut |
| Rear strut LH, Rear strut RH | rear_strut |

A component has one **kind**. It can only go into a position of that kind, on a unit whose model is in
the component's list of models. An empty list means any model.

## Status is events

A component's history is a list of **events**. Each event is entered once and never edited. A
mistake is put right by voiding the latest event with a reason.

| Event | What it records |
| --- | --- |
| Received | Component comes into stores: new, exchange or used. Includes purchase cost, warranty hours or months, and the date the core is due back (exchange only). |
| Installed | Unit, position, date and time, and the unit's SMU at install. |
| Removed | Date and time, SMU, and the reason: **failure**, **planned** (life reached, midlife or campaign) or **other** (removed for access, swapped to another unit). Includes the down flag and work order. |
| Sent to rebuild | Vendor, date and the vendor's reference. |
| Back from rebuild | Date, rebuild cost, and warranty hours or months. |
| Core returned | The core for an exchange component has gone back. Includes the core credit. |
| Warranty claim | Claim opened, accepted or rejected, with the amount. |
| Scrapped | Date and reason. Final. |

Status is worked out from the events, never typed in:
- **In stores:** after Received, Back from rebuild or Removed.
- **Installed:** after Installed.
- **At rebuild:** after Sent to rebuild.
- **Scrapped:** after Scrapped.

### Rules

- **Install:** the component must be in stores, and the position on the unit must be empty. The kind
  and model must fit. The SMU at install must not be below the unit's SMU at the previous removal from
  that position.
- **Remove:** the component must be installed. The SMU must be at least the SMU at install. A removal
  for failure without a down flag gives a warning: link the flag so the failure counts the same
  everywhere.
- **Send to rebuild:** the component must be in stores. The vendor is required.
- **Back from rebuild:** the component must be at rebuild.
- **Scrap:** the component must not be installed. A reason is required.
- **Times:** an event cannot be dated before the previous event of the same component, or in the
  future.
- **SMU check:** if the SMU entered is more than 50 h from the unit's SMU reading at that time, the
  event is saved with a warning to check it.

## Hours

- **Hours since rebuild** (or since new): the hours the component had when first registered, plus,
  for each install since it was last received or rebuilt, the unit's SMU at removal (or now) minus the
  SMU at install.
- **Rebuild count:** the count when first registered, plus one for each Back from rebuild.
- **A life** is the hours from Received or Back from rebuild up to the next Sent to rebuild or
  Scrapped.
  - A life is a **failure** if the last removal in it for failure or planned was for failure.
    Otherwise it is a **suspension**: the component was taken out before it failed.
  - A component that is still in service is an open life, and counts as a suspension at its hours
    now.
  - A removal for "other" followed by a refit does not end a life.

## Target life

The target life is set per model and kind, for example 793F engine 20,000 h.
- Targets are effective-dated. A change applies from its start date, and older lives keep the
  target that applied when they ended.
- A change needs approval, like a KPI target (decided by Ope, 2026-10-28; docs/approvals.md). A
  reliability engineer or superintendent asks, with a reason. A superintendent who did not ask
  approves it, and only then does it apply. The record keeps who asked, who approved and the
  request it came from. Every step goes to the audit log.
- Nothing applies while the request waits, and only one request can wait for the same model, kind
  and start date.
- The synthetic site's defaults are illustrative, not OEM figures:

| Kind | 793F | 797F |
| --- | --- | --- |
| Engine | 20,000 | 22,000 |
| Transmission | 16,000 | 16,000 |
| Torque converter | 16,000 | 16,000 |
| Differential | 24,000 | 24,000 |
| Final drive | 18,000 | 18,000 |
| Front strut, rear strut | 12,000 | 12,000 |

## Component life board (plan 4.2)

The board shows units in rows and positions in columns. Each cell shows:
- the serial;
- the hours since rebuild;
- the **% of target life**.

| Colour | % of target life |
| --- | --- |
| Green | below 75% |
| Amber | 75% to below 90% |
| Red | 90% to below 100% |
| Past target | 100% or more |

The bands are the setting `lifeBands` (default 0.75 and 0.90).

The oil analysis severity is overlaid when condition monitoring arrives, in the next part of phase 3.

## Change-out forecast

For each installed component, the forecast date is when it reaches its target life:
- **Remaining hours** = target life − hours since rebuild. This can be negative if it is already past
  target.
- **Burn rate** = the unit's SMU hours per site day over the last 28 days.
  - If the unit has readings for fewer than 7 of those days, the model's average burn rate is used
    instead.
  - A parked unit has no burn rate, so no forecast date.
- **Forecast date** = now + remaining hours ÷ burn rate, in days. A component already past its target
  is due now.

The page lists change-outs by week for the next 12 weeks, and a count by site month for the next 12
months, split by kind. This is the number of exchange components the site will need, which the next
part of phase 3 (spares and rebuild pool sizing) builds on.

## Weibull and risk before target

For each kind and model, the page fits a Weibull with suspensions (C-05) to the component lives:
- failed lives are failures;
- planned removals and open lives are suspensions.

It needs at least 2 failures, as C-05 does. For each installed component, the page then shows the
**chance it fails before reaching target life**, using conditional Weibull (C-06):

P = 1 − R(target − hours | hours).

This is the number behind the plan's exit test for phase 3: decide one component strategy from
platform data.

## Component life ratio (KPI-030)

For lives that ended in the period:

Life ratio = hours at the end of the life ÷ target life for that model and kind.

- The ratio is shown separately for failures and for planned removals.
- **% reaching target** = lives with a ratio of 1 or more ÷ all ended lives.
- **Early failures** = failed lives with a ratio below 0.25. These point at fitting or rebuild
  quality.

## Rebuild vendors

For each vendor:
- rebuilds sent and returned;
- mean turnaround, from Sent to rebuild to Back from rebuild, in days;
- mean life after rebuild, over ended lives;
- life ratio;
- early failures;
- cost per hour of life.

Each vendor statistic is only shown with at least 3 ended lives.

## Cost per hour of life achieved

For each ended life:

Cost per hour = (cost that started the life + warranty recovered as a negative) ÷ hours.

The cost that started the life is the purchase cost on Received, or the rebuild cost on Back from
rebuild. For a kind or a vendor:

Cost per hour = sum of costs ÷ sum of hours.

This is calculator C-09, applied to the platform's data.

Costs follow plan 11.2 "View cost and labour rates": only reliability engineers, superintendents and
admins see or enter them. The database keeps costs in a separate table that other roles cannot read.

## Rebuild or replace (calculator C-11)

Each option's cost per hour of life:

(price + change-out hours × cost per down hour − core credit) ÷ expected life.

- **Rebuild:** the rebuild price, the expected life after rebuild, and its change-outs.
- **Replace:** the new price, the expected new life, and the core credit if the old one is traded in.
- The cheaper cost per hour wins.
- The difference is shown per year at the component's burn rate.
- It also shows the **break-even life**: how long a rebuilt component must last to match a new one.

Inputs open with the platform's mean lives for the kind and model when there are enough ended lives.
Otherwise you type them in.

## Warranty

- A component is under warranty after Received or Back from rebuild while both are true:
  - hours since then are below the warranty hours;
  - the date is before the warranty months run out.
- A blank limit means no limit of that type. A blank warranty means none.
- A removal for failure while under warranty puts the component on the **warranty claims** list. It
  stays there until a Warranty claim event closes it, accepted or rejected.

## Core returns

- An exchange component received with a core due date is on the **cores outstanding** list until a
  Core returned event.
- It turns red after the due date.

## Who can do what

| Action | Roles |
| --- | --- |
| See components, the board, forecast, Weibull | Everyone at the site |
| Record events: receive, install, remove, send, return, scrap, claims, cores | Supervisor, reliability engineer, superintendent (`record_components`) |
| Change target life | Reliability engineer or superintendent asks; a superintendent who did not ask approves (`edit_life_targets`) |
| See and enter costs | Reliability engineer, superintendent, admin (`view_cost`) |
| Void the latest event | Whoever entered it, or a superintendent, with a reason |

## Later

- Filling the history from the ERP's rotating item records (A3 mapping).
- The oil analysis overlay and component condition (phase 3, condition monitoring).
- Rebuild pool sizing from the forecast (phase 3, spares).
