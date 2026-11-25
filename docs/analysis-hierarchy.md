# Analysis: system and component panel, minimum downtime, hide

Ope, 8 Dec 2026: the Pareto and the jack-knife should have a panel like the one in the Bay Watch jack-knife: the systems and
their components with events and hours, drill into one, a minimum downtime, and hide things from the chart. Code:
`packages/core/src/analysis-hierarchy.ts` (tested in `test/analysis-hierarchy.test.ts`).

## The panel

- **Rows**: *All systems*, then each system with its events and down hours, largest first. Open a system to see its
  components (from the release, "Not recorded" when blank) with the same two numbers. Numbers are for the slice on the
  page (unit, date and downtime filters), after what is hidden and the minimum below.
- **Choose**: pressing *All systems*, a system or a component sets the page filter to it, the same as clicking a bar
  already does (`systems` or `components` in the link). That changes the downtime analysed, not PA, utilisation or MTBF.
- **Hide**: the × on a row, or right-click, hides that system or component from the **Pareto** and the **jack-knife**
  only. It stays in the events table, the weekly chart, the tiles and every KPI. Hidden items show as chips that bring
  them back, with *Clear all*. Hiding is a view setting; it is not in the link and is not saved.
- **Minimum downtime (h)**: groups with fewer down hours than this are left out of the Pareto, the jack-knife and the
  panel. Default 0.

## What changes in the numbers

- Hiding and the minimum remove whole groups, so the Pareto shares and cumulative line are recalculated over the
  groups that remain, and the jack-knife limits (KPI-024: total events ÷ groups, total hours ÷ total events) are
  calculated over the groups that remain. The chart says so when anything is hidden.
- A hidden system hides all its components, and a hidden component only that one.
- Nothing is deleted or changed in the records (rule 5). No KPI formula changes: this is a view over the same flags.
