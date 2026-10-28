// A few actions and one RCA for the demo fleet, so the pages are not empty.
// Fictional and synthetic (CLAUDE.md rule 9). Live sites start with none.

import { EMPTY_FILTER, emptyFishbone, filterToQuery, siteToday, type Dataset, type ImprovementAction, type Rca } from '@mr/core';

export function demoImprovements(ds: Dataset): { actions: ImprovementAction[]; rcas: Rca[] } {
  const tz = ds.site.timeZone;
  const now = ds.generatedAt;
  const ago = (days: number) => new Date(Date.parse(now) - days * 864e5).toISOString();
  const date = (days: number) => siteToday(now, tz, days);
  const hyd = filterToQuery({ ...EMPTY_FILTER, systems: ['Hydraulics'], fleets: ['Haul trucks'] });
  const unit = ds.assets.find((a) => a.fleet === 'Haul trucks') ?? ds.assets[0]!;
  const unitQ = filterToQuery({ ...EMPTY_FILTER, units: [unit.id], systems: ['Electrical'] });
  const rcaId = 'demo-rca-1';
  const base = { createdBy: 'demo-reliability_engineer' };
  const actions: ImprovementAction[] = [
    {
      ...base, id: 'demo-action-1', title: 'Add hose clamp check to the 500 h PM', owner: 'demo-supervisor', due: date(-24), status: 'done',
      source: { kind: 'analysis', query: hyd, label: 'Hydraulics, Haul trucks' }, createdAt: ago(45), updatedAt: ago(21), startedAt: ago(40),
      doneAt: ago(21), doneNote: 'Job plan updated and briefed to both crews.',
    },
    {
      ...base, id: 'demo-action-2', title: 'Replace harness clips on the rear frame', owner: 'demo-technician', due: date(9), status: 'in_progress',
      source: { kind: 'rca', rcaId, query: unitQ, label: `RCA: ${unit.unitNumber} repeat electrical faults` }, createdAt: ago(6), updatedAt: ago(3), startedAt: ago(3),
    },
    {
      ...base, id: 'demo-action-3', title: 'Review tyre pressure checks at shift start', owner: 'demo-supervisor', due: date(-2), status: 'open',
      source: { kind: 'analysis', query: filterToQuery({ ...EMPTY_FILTER, systems: ['Tyres'] }), label: 'Tyres, all fleets' }, createdAt: ago(12), updatedAt: ago(12),
    },
  ];
  const rcas: Rca[] = [{
    id: rcaId, title: `${unit.unitNumber} repeat electrical faults`, problem: `${unit.unitNumber} has had repeat electrical stops in the last 90 days, mostly intermittent sensor faults found in the field.`,
    source: { kind: 'unit', unitId: unit.id, query: unitQ, label: unit.unitNumber }, flagIds: [],
    whys: ['Sensor reads open circuit', 'Harness connector moves on the frame', 'Retaining clips missing after the last frame repair'],
    fishbone: { ...emptyFishbone(), machine: ['Connector not sealed'], method: ['Frame repair procedure has no clip step'], environment: ['Wet pit, vibration on ramp'] },
    status: 'open', lead: 'demo-reliability_engineer', createdBy: 'demo-reliability_engineer', createdAt: ago(8), updatedAt: ago(3),
  }];
  return { actions, rcas };
}
