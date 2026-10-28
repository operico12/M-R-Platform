// Three projects for the demo fleet, so the portfolio is not empty.
// Fictional and synthetic (CLAUDE.md rule 9). Live sites start with none.

import { EMPTY_FILTER, filterToQuery, siteToday, type Dataset, type Project } from '@mr/core';

export function demoProjects(ds: Dataset): Project[] {
  const tz = ds.site.timeZone;
  const now = ds.generatedAt;
  const ago = (days: number) => new Date(Date.parse(now) - days * 864e5).toISOString();
  const d = (days: number) => siteToday(now, tz, days);
  const RE = 'demo-reliability_engineer';
  const SUP = 'demo-superintendent';
  const supv = 'demo-supervisor';
  const tech = 'demo-technician';
  const trucks = ds.assets.filter((a) => a.fleet === 'Haul trucks').slice(0, 6).map((a) => a.id);
  const empty = { tasks: [], risks: [], decisions: [], costs: [], changes: [] };
  return [
    {
      ...empty,
      id: 'demo-project-1', title: 'Critical hose programme', owner: RE, stage: 'in_progress',
      charter: 'Hose failures are the largest hydraulic loss on the haul trucks. Replace critical hoses on hours before they fail, and fix routing where they rub.',
      scope: 'Hoist, steering and brake hoses on the haul truck fleet. Not loaders or support equipment.',
      stages: [{ stage: 'idea', at: ago(40), by: RE }, { stage: 'approved', at: ago(33), by: SUP, note: 'Funded from the reliability budget' }, { stage: 'in_progress', at: ago(30), by: RE }],
      start: d(-30), end: d(45), budget: 85000, forecastToComplete: 52000,
      tasks: [
        { id: 'demo-t1', title: 'Rank hoses by failure history', owner: RE, start: d(-30), due: d(-20), status: 'done', milestone: false, dependsOn: [], doneAt: ago(21) },
        { id: 'demo-t2', title: 'Agree replacement hours with the OEM', owner: RE, start: d(-20), due: d(-10), status: 'done', milestone: true, dependsOn: ['demo-t1'], doneAt: ago(9) },
        { id: 'demo-t3', title: 'Order hose kits', owner: supv, start: d(-9), due: d(-2), status: 'in_progress', milestone: false, dependsOn: ['demo-t2'] },
        { id: 'demo-t4', title: 'Fit kits at next PM, first six trucks', owner: tech, start: d(0), due: d(25), status: 'not_started', milestone: false, dependsOn: ['demo-t3'] },
        { id: 'demo-t5', title: 'Add hose hours to the PM job plan', owner: supv, start: d(5), due: d(30), status: 'not_started', milestone: true, dependsOn: ['demo-t2'] },
        { id: 'demo-t6', title: 'Review results', owner: RE, start: d(35), due: d(45), status: 'not_started', milestone: true, dependsOn: ['demo-t4', 'demo-t5'] },
      ],
      risks: [
        { id: 'demo-r1', kind: 'risk', text: 'Kit lead time longer than quoted', likelihood: 2, impact: 3, owner: supv, mitigation: 'Second supplier quoted', status: 'open', raisedAt: ago(20) },
        { id: 'demo-r2', kind: 'issue', text: 'Two trucks have non-standard hose routing after a repair', likelihood: 3, impact: 2, owner: tech, status: 'open', raisedAt: ago(8) },
      ],
      decisions: [{ id: 'demo-d1', at: ago(18), by: RE, text: 'OEM hoses only; no will-fit parts on critical circuits.' }],
      costs: [
        { id: 'demo-c1', date: d(-15), amount: 6500, text: 'OEM review and hose survey', reference: 'PO-DEMO-01', enteredBy: RE, enteredAt: ago(15) },
        { id: 'demo-c2', date: d(-5), amount: 31000, text: 'Hose kits, first batch', reference: 'PO-DEMO-02', enteredBy: supv, enteredAt: ago(5) },
      ],
      changes: [{ id: 'demo-cr1', text: 'Add the six support trucks to the scope', budget: 98000, status: 'proposed', raisedBy: RE, raisedAt: ago(3) }],
      links: { unitIds: trucks, workOrders: [], rcaIds: [], actionIds: ['demo-action-1'] },
      benefitQuery: filterToQuery({ ...EMPTY_FILTER, systems: ['Hydraulics'], fleets: ['Haul trucks'] }), expectedHoursPerYear: 400, valuePerDownHour: 1500,
      createdBy: RE, createdAt: ago(40), updatedAt: ago(3),
    },
    {
      ...empty,
      id: 'demo-project-2', title: 'Tyre pressure checks at shift start', owner: supv, stage: 'closed',
      charter: 'Tyre cuts and low-pressure stops rose over the summer. Add a pressure check to the pre-start and fix the gauges.',
      scope: 'All haul trucks, both crews.',
      stages: [{ stage: 'idea', at: ago(45), by: RE }, { stage: 'approved', at: ago(38), by: SUP }, { stage: 'in_progress', at: ago(30), by: RE }, { stage: 'closed', at: ago(20), by: RE, note: 'Check added to pre-start; gauges replaced.' }],
      start: d(-30), end: d(-20), budget: 8000, forecastToComplete: 0,
      tasks: [
        { id: 'demo-t7', title: 'Replace pressure gauges', owner: supv, start: d(-30), due: d(-25), status: 'done', milestone: false, dependsOn: [], doneAt: ago(26) },
        { id: 'demo-t8', title: 'Add check to the pre-start card', owner: supv, start: d(-25), due: d(-21), status: 'done', milestone: true, dependsOn: [], doneAt: ago(21) },
      ],
      costs: [{ id: 'demo-c3', date: d(-26), amount: 5200, text: 'Gauges', enteredBy: supv, enteredAt: ago(26) }],
      links: { unitIds: [], workOrders: [], rcaIds: [], actionIds: ['demo-action-3'] },
      benefitQuery: filterToQuery({ ...EMPTY_FILTER, systems: ['Tyres'] }), valuePerDownHour: 1500,
      createdBy: RE, createdAt: ago(45), updatedAt: ago(20),
    },
    {
      ...empty,
      id: 'demo-project-3', title: 'Second wash pad', owner: RE, stage: 'idea',
      charter: 'Units wait for the wash pad before every PM. A second pad would cut waiting for a line.',
      scope: 'Civil works, water treatment and drainage for one more pad.',
      stages: [{ stage: 'idea', at: ago(4), by: RE }],
      start: d(30), end: d(150), budget: 420000, forecastToComplete: 420000,
      links: { unitIds: [], workOrders: [], rcaIds: [], actionIds: [] },
      createdBy: RE, createdAt: ago(4), updatedAt: ago(4),
    },
  ];
}
