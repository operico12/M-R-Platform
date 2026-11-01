// Unit screen (docs/unit-screen.md): notes, assigned technicians, repair details, investigation, history.

import { describe, expect, it } from 'vitest';
import { changeStage, clearInvestigation, flagDown, markInvestigation, release, setRepairDetails, voidFlag } from '../src/flags.js';
import { addNote, assignTechnician, assignable, assignmentHours, settleAssignments, unassignTechnician, voidNote, type Assignment, type UnitContext, type UnitNote } from '../src/unit-notes.js';
import { unitHistory } from '../src/unit-history.js';
import type { Role } from '../src/types.js';
import { L, Store, actor, truck } from './helpers.js';

const T = truck('ht1');
let n = 0;
const newId = () => `u${++n}`;
const down = () => {
  const s = new Store(T);
  s.apply(flagDown(s.ctx(L('2026-10-26 08:00')), {
    type: 'unscheduled', reasonCode: 'Hydraulics', start: L('2026-10-26 08:00'), location: { kind: 'field', fieldLocation: 'Pit 2' },
    details: { system: 'Hydraulics', failureModes: ['Hose burst'] },
  }));
  return s;
};
const uctx = (s: Store, now: string, role: Role = 'supervisor', who = actor(role)): UnitContext => ({ now, actor: who, asset: T, unitFlags: s.flags, newId });

describe('failure mode and repair details', () => {
  it('can be entered when marking down, and are kept on the stop', () => {
    const s = down();
    expect(s.open.release).toEqual({ system: 'Hydraulics', failureModes: ['Hose burst'] });
    expect(s.open.system).toBe('Hydraulics');
  });

  it('are filled in while open by anyone who updates the stage, and blanks clear a field', () => {
    const s = down();
    const d = { system: 'Hydraulics', majorComponent: 'Hoist', component: 'Hoist cylinder hose', failureModes: ['Hose burst'], findings: 'Chafed on frame' };
    s.apply(setRepairDetails(s.ctx(L('2026-10-26 09:00'), actor('technician')), s.open, d));
    expect(s.open.release).toEqual(d);
    expect(setRepairDetails(s.ctx(L('2026-10-26 09:00'), actor('viewer')), s.open, d).ok).toBe(false);
    s.apply(setRepairDetails(s.ctx(L('2026-10-26 09:10')), s.open, { ...d, findings: ' ' }));
    expect(s.open.release?.findings).toBeUndefined();
  });

  it('count toward the release checklist and carry into the release record', () => {
    const s = down();
    s.apply(setRepairDetails(s.ctx(L('2026-10-26 09:00')), s.open, { system: 'Hydraulics', majorComponent: 'Hoist', component: 'Hose', failureModes: ['Hose burst'] }));
    s.apply(changeStage(s.ctx(L('2026-10-26 09:30')), s.open, { stage: 'in_repair', at: L('2026-10-26 09:30') }));
    const r = release(s.ctx(L('2026-10-26 11:00')), s.open, { details: { repairSummary: 'Hose replaced', workOrder: 'WO-1' } });
    if (!r.ok) throw new Error(r.errors.join());
    expect(r.flags[0]!.release).toMatchObject({ majorComponent: 'Hoist', component: 'Hose', repairSummary: 'Hose replaced' });
  });

  it('cannot change after release', () => {
    const s = down();
    const closed = { ...s.open, state: 'released' as const, end: L('2026-10-26 10:00') };
    expect(setRepairDetails(s.ctx(L('2026-10-26 11:00')), closed, { system: 'Engine' }).ok).toBe(false);
  });
});

describe('mark for investigation', () => {
  it('a supervisor marks with a reason; it can be cleared with a reason; technicians cannot', () => {
    const s = down();
    expect(markInvestigation(s.ctx(L('2026-10-26 09:00'), actor('technician')), s.open, 'Third time').ok).toBe(false);
    expect(markInvestigation(s.ctx(L('2026-10-26 09:00')), s.open, ' ').ok).toBe(false);
    s.apply(markInvestigation(s.ctx(L('2026-10-26 09:00')), s.open, 'Third hose this month'));
    expect(s.open.investigation).toMatchObject({ reason: 'Third hose this month', by: 'supervisor-1' });
    expect(markInvestigation(s.ctx(L('2026-10-26 09:05')), s.open, 'again').ok).toBe(false);
    s.apply(clearInvestigation(s.ctx(L('2026-10-26 10:00'), actor('reliability_engineer')), s.open, 'Known routing issue, action open'));
    expect(s.open.investigation?.clearedBy).toBe('reliability_engineer-1');
    expect(s.audit.map((a) => (a as { action: string }).action)).toContain('clear_investigation');
  });
});

describe('notes', () => {
  it('repair notes and comments, tied to the open stop; never empty; viewers cannot', () => {
    const s = down();
    const r = addNote(uctx(s, L('2026-10-26 09:00'), 'technician'), [], { kind: 'repair', text: ' Found hose chafed ' });
    if (!r.ok) throw new Error(r.errors.join());
    expect(r.records[0]).toMatchObject({ kind: 'repair', text: 'Found hose chafed', downFlagId: s.open.id, by: 'technician-1' });
    expect(addNote(uctx(s, L('2026-10-26 09:00'), 'technician'), [], { kind: 'comment', text: '  ' }).ok).toBe(false);
    expect(addNote(uctx(s, L('2026-10-26 09:00'), 'viewer'), [], { kind: 'comment', text: 'hi' }).ok).toBe(false);
    const up = addNote({ ...uctx(s, L('2026-10-26 09:00')), unitFlags: [] }, [], { kind: 'comment', text: 'Running well' });
    expect(up.ok && up.records[0]!.downFlagId).toBeUndefined();
  });

  it('only the writer or a superintendent voids a note, with a reason; it is kept', () => {
    const s = down();
    const r = addNote(uctx(s, L('2026-10-26 09:00'), 'technician'), [], { kind: 'comment', text: 'Wrong unit' });
    if (!r.ok) throw new Error();
    const id = r.records[0]!.id;
    expect(voidNote(uctx(s, L('2026-10-26 09:10'), 'supervisor'), r.records, id, 'x').ok).toBe(false);
    expect(voidNote(uctx(s, L('2026-10-26 09:10'), 'technician'), r.records, id, '').ok).toBe(false);
    const v = voidNote(uctx(s, L('2026-10-26 09:10'), 'technician'), r.records, id, 'Meant HT2');
    expect(v.ok && v.records.length).toBe(1);
    expect(v.ok && v.records[0]!.voidReason).toBe('Meant HT2');
    expect(voidNote(uctx(s, L('2026-10-26 09:10'), 'superintendent'), r.records, id, 'Cleanup').ok).toBe(true);
  });
});

describe('assigned technicians', () => {
  it('supervisors assign people to a down unit, once at a time each; technicians cannot assign', () => {
    const s = down();
    const a = assignTechnician(uctx(s, L('2026-10-26 09:00')), [], 'tech-a');
    if (!a.ok) throw new Error(a.errors.join());
    expect(assignTechnician(uctx(s, L('2026-10-26 09:00')), a.records, 'tech-a').ok).toBe(false);
    expect(assignTechnician(uctx(s, L('2026-10-26 09:00'), 'technician'), [], 'tech-b').ok).toBe(false);
    expect(assignTechnician({ ...uctx(s, L('2026-10-26 09:00')), unitFlags: [] }, [], 'tech-b').ok).toBe(false);
    expect(assignTechnician(uctx(s, L('2026-10-26 09:00'), 'supervisor', actor('supervisor', ['other-fleet'])), [], 'tech-b').ok).toBe(false);
    const off = unassignTechnician(uctx(s, L('2026-10-26 11:00')), a.records, a.records[0]!.id);
    if (!off.ok) throw new Error();
    expect(assignmentHours(off.records[0]!, L('2026-10-26 12:00'))).toBe(2);
  });

  it('end at the release, and are voided with the flag', () => {
    const s = down();
    const a = assignTechnician(uctx(s, L('2026-10-26 09:00')), [], 'tech-a');
    if (!a.ok) throw new Error();
    s.apply(changeStage(s.ctx(L('2026-10-26 09:30')), s.open, { stage: 'in_repair', at: L('2026-10-26 09:30') }));
    s.apply(release(s.ctx(L('2026-10-26 11:00')), s.open, { details: { component: 'Hose', repairSummary: 'Replaced', workOrder: 'WO-1' } }));
    const done = settleAssignments(a.records, s.flags, { now: L('2026-10-26 11:05'), actor: actor('supervisor') });
    expect(done.records[0]).toMatchObject({ state: 'ended', end: L('2026-10-26 11:00') });

    const s2 = down();
    const b = assignTechnician(uctx(s2, L('2026-10-26 09:00')), [], 'tech-a');
    if (!b.ok) throw new Error();
    s2.apply(voidFlag(s2.ctx(L('2026-10-26 09:10')), s2.open, 'Wrong unit'));
    expect(settleAssignments(b.records, s2.flags, { now: L('2026-10-26 09:10'), actor: actor('supervisor') }).records[0]!.state).toBe('voided');
  });

  it('can pick technicians, supervisors and technician job titles still on site', () => {
    const now = L('2026-10-26 09:00');
    const people = [
      { id: 'a', role: 'technician' }, { id: 'b', role: 'supervisor' }, { id: 'c', role: 'viewer', jobTitle: 'contractor' },
      { id: 'd', role: 'viewer' }, { id: 'e', role: 'technician', retiredAt: L('2026-10-01 00:00') }, { id: 'f', role: 'technician', accessUntil: L('2026-10-25 00:00') },
    ];
    expect(assignable(people, now).map((p) => p.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('history', () => {
  it('lists the stop, its steps, notes, technicians and standby, newest first', () => {
    const s = down();
    s.apply(markInvestigation(s.ctx(L('2026-10-26 08:30')), s.open, 'Repeat'));
    s.apply(changeStage(s.ctx(L('2026-10-26 09:30')), s.open, { stage: 'in_repair', at: L('2026-10-26 09:30') }));
    const a = assignTechnician(uctx(s, L('2026-10-26 09:00')), [], 'tech-a');
    const nt = addNote(uctx(s, L('2026-10-26 10:00'), 'technician'), [], { kind: 'repair', text: 'Hose replaced' });
    if (!a.ok || !nt.ok) throw new Error();
    s.apply(release(s.ctx(L('2026-10-26 11:00')), s.open, { details: { component: 'Hose', repairSummary: 'Replaced', workOrder: 'WO-1' } }));
    const assigns: Assignment[] = settleAssignments(a.records, s.flags, { now: L('2026-10-26 11:00'), actor: actor('supervisor') }).records;
    const notes: UnitNote[] = nt.records;
    const standby = [{ id: 'sb', tenantId: 't', siteId: 's', unitId: 'ht1', reasonCode: 'CRIB', kind: 'operating_delay' as const, start: L('2026-10-26 12:00'), end: L('2026-10-26 12:30'), state: 'ended' as const, setBy: 'x', enteredAt: L('2026-10-26 12:00') }];
    const h = unitHistory({ unitId: 'ht1', flags: s.flags, assignments: assigns, notes, standby, now: L('2026-10-26 13:00') });
    expect(h.map((x) => x.kind)).toEqual(['standby_end', 'standby', 'release', 'unassign', 'note', 'stage', 'assign', 'investigate', 'down']);
    expect(h.find((x) => x.kind === 'release')!.hours).toBe(3);
    expect(h.find((x) => x.kind === 'unassign')!.hours).toBe(2);
  });
});
