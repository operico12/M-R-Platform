# Shop lines: the lines page, putting a down unit on a line, and managing lines

Plan 4.2 (Figure 6), A7 L1–L2 and 5.2. Ope, 31 Oct 2026: the old page was hard to use; a down unit
must be easy to put on a line, and the Admin must be able to set how many lines there are.

## 1. The page

- **Summary chips** on top: lines in use (of open lines), free, closed, units that need a line.
- **Needs a line**: every open down flag whose unit is not on a line (in the field, towing, or in the
  shop yard waiting for a line), longest down first. Each shows the unit, model, reason, where it is, the
  stage and its time, how long it has been down, its wait tags and its ETA. A **Put on a line** picker
  lists the lines that are open and have room, the ones that fit the model first; choosing one moves
  the unit there (A7 T6 `moveLocation`, with all its rules: L1 full, L2 closed, model fit and D8 override,
  A7 5.2 move matrix, S2 stage follows the location). A line that does not fit the model is shown but
  needs a supervisor's override reason, as on the unit sheet.
- **Lines**: one tile per open line, in sort order. A tile shows the line name, its type, its capacity,
  and either the units in it (unit, reason, stage, time in line, ETA, wait tags) or **Free**, or
  **Closed** with the reason. A thin bar shows occupancy over the last 7 days (closed time excluded,
  KPI dictionary). Tapping a unit opens its sheet. A free line shows a **Put a unit here** picker
  listing the units that need a line.
- Supervisors (own area), the superintendent and the Admin can **close** a line with a reason
  (from now) and **open** it again (permission `open_close_line`). A line with a unit in it cannot be closed.

## 2. Managing lines (Admin)

Permission `edit_shop_structure` (Admin; a reliability engineer may propose). On the page, **Manage lines**:

- **Add lines**: how many (1 to 20) and the type. New lines get the next free numbers ("Line 7",
  "Line 8"...). Capacity 1, any model, unless changed.
- **Edit** a line: number and/or name (at least one), type, capacity (1 to 10), models that fit
  (empty = any). Two open lines cannot share a number.
- **Retire** a line with a reason. Nothing is deleted (rule 5): a retired line drops off the page and
  out of new moves, and its history stays. A line with a unit in it cannot be retired.
- Every change is audited.

## 3. Database

- `app_save_lines(p_site, p_rows)`: the Admin's changes; creates the site's shop ("Main shop") if
  it has none. Retired lines keep `retired_at` and `retired_reason`.
- `app_save_closures(p_site, p_rows)`: a closure is inserted, then may only be ended once.
- Unchanged: `site_role()` decides who may write (Admin for lines; supervisor, superintendent, Admin
  for closures), audit triggers record every change, and deletes are refused.
