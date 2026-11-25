// System and component panel for the Pareto and jack-knife (docs/analysis-hierarchy.md): the systems and their
// components with events and hours, what a person has hidden, and a minimum downtime. A view over the same flags;
// nothing is changed or deleted (rule 5).

import { flagSystem } from './filters.js';
import type { FilteredAnalysis, FilteredEvent } from './filters.js';
import { flagDownHours } from './kpis.js';
import type { DownFlag } from './types.js';

/** Hidden keys: `sys::<System>` or `comp::<System>::<Component>`. */
export const hideSystemKey = (system: string) => `sys::${system}`;
export const hideComponentKey = (system: string, component: string) => `comp::${system}::${component}`;

export const NOT_RECORDED = 'Not recorded';
const componentOf = (f: DownFlag) => f.release?.component || NOT_RECORDED;

export function isHidden(f: DownFlag, hidden: ReadonlySet<string>): boolean {
  const sys = flagSystem(f);
  return hidden.has(hideSystemKey(sys)) || hidden.has(hideComponentKey(sys, componentOf(f)));
}

/** The analysis without the hidden systems and components. Events left with no flags drop out. */
export function withoutHidden(a: FilteredAnalysis, hidden: ReadonlySet<string>): FilteredAnalysis {
  if (hidden.size === 0) return a;
  const events: FilteredEvent[] = [];
  for (const e of a.events) {
    const flags = e.flags.filter((f) => !isHidden(f, hidden));
    if (!flags.length) continue;
    events.push({ event: e.event, flags, hours: flags.reduce((s, f) => s + flagDownHours(f, a.period, a.now), 0) });
  }
  return { ...a, events, downHours: events.reduce((s, e) => s + e.hours, 0), failures: events.filter((e) => e.event.isFailure).length };
}

export interface HierarchyRow {
  key: string;
  events: number;
  hours: number;
}
export interface SystemRow extends HierarchyRow {
  components: HierarchyRow[];
}

/**
 * Systems with their components, largest first. Events are counted once per group (an event with two flags in
 * the same system counts once there). Groups under `minHours` are left out.
 */
export function failureHierarchy(a: FilteredAnalysis, minHours = 0): SystemRow[] {
  type Acc = { hours: number; events: Set<string> };
  const systems = new Map<string, Acc & { comps: Map<string, Acc> }>();
  for (const e of a.events) {
    for (const f of e.flags) {
      const h = flagDownHours(f, a.period, a.now);
      const sys = systems.get(flagSystem(f)) ?? { hours: 0, events: new Set<string>(), comps: new Map<string, Acc>() };
      sys.hours += h;
      sys.events.add(e.event.id);
      const c = sys.comps.get(componentOf(f)) ?? { hours: 0, events: new Set<string>() };
      c.hours += h;
      c.events.add(e.event.id);
      sys.comps.set(componentOf(f), c);
      systems.set(flagSystem(f), sys);
    }
  }
  const rows = (m: Map<string, Acc>): HierarchyRow[] =>
    [...m].map(([key, v]) => ({ key, events: v.events.size, hours: v.hours })).filter((r) => r.hours >= minHours).sort((x, y) => y.hours - x.hours);
  return [...systems]
    .map(([key, v]) => ({ key, events: v.events.size, hours: v.hours, components: rows(v.comps) }))
    .filter((r) => r.hours >= minHours)
    .sort((x, y) => y.hours - x.hours);
}

export interface ShareRow { key: string; hours: number; events: number; share: number; cumulative: number }

/** Drop groups under `minHours` and recompute the shares and the cumulative line over what is left. */
export function minHoursRows<T extends { hours: number; events: number; key: string }>(rows: T[], minHours: number): Array<T & { share: number; cumulative: number }> {
  const kept = minHours > 0 ? rows.filter((r) => r.hours >= minHours) : rows;
  const total = kept.reduce((s, r) => s + r.hours, 0);
  let cum = 0;
  return kept.map((r) => {
    cum += r.hours;
    return { ...r, share: total ? r.hours / total : 0, cumulative: total ? cum / total : 0 };
  });
}
