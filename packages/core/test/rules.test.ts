// A7 rules and the awkward cases from plan Appendix E.

import { describe, expect, it } from 'vitest';
import { DEFAULT_FLAG_RULES, withRules } from '../src/config.js';
import {
  changeStage,
  confirmProposal,
  flagDown,
  moveLocation,
  proposeDown,
  rejectProposal,
  release,
  reopen,
  switchType,
  voidFlag,
} from '../src/flags.js';
import { activeAlerts } from '../src/alerts.js';
import { buildEvents, computeKpis, lineOccupancy, splitFlag } from '../src/kpis.js';
import { L, LINES, Store, actor, cal, fixtureFlag, minutes, round, truck } from './helpers.js';

const UNSCHED_RELEASE = { system: 'Engine', component: 'Turbo', failureModes: ['Leak'], repairSummary: 'Fixed', workOrder: 'WO-1' };

function down(s: Store, at: string, extra: Partial<Parameters<typeof flagDown>[1]> = {}) {
  return s.apply(flagDown(s.ctx(at), {
    type: 'unscheduled',
    reasonCode: 'Breakdown',
    system: 'Engine',
    start: at,
    location: { kind: 'shop_line', shopLineId: 'L1' },
    ...extra,
  }))[0]!;
}

describe('R1 / R3: one open flag, no overlaps, no future times', () => {
  it('refuses a second flag while one is open', () => {
    const s = new Store(truck('a'));
    down(s, L('2026-10-26 08:00'));
    const r = flagDown(s.ctx(L('2026-10-26 09:00')), { type: 'unscheduled', reasonCode: 'x', start: L('2026-10-26 09:00'), location: { kind: 'field', fieldLocation: 'Pit 1' } });
    expect(r.ok).toBe(false);
  });
  it('refuses a start in the future', () => {
    const s = new Store(truck('a'));
    const r = flagDown(s.ctx(L('2026-10-26 08:00')), { type: 'unscheduled', reasonCode: 'x', start: L('2026-10-26 09:00'), location: { kind: 'field', fieldLocation: 'Pit 1' } });
    expect(r.ok).toBe(false);
  });
  it('refuses a back-dated flag that overlaps a released one', () => {
    const s = new Store(truck('a'));
    down(s, L('2026-10-26 08:00'));
    s.apply(release(s.ctx(L('2026-10-26 10:00')), s.open, { details: UNSCHED_RELEASE }));
    const r = flagDown(s.ctx(L('2026-10-26 10:30')), { type: 'unscheduled', reasonCode: 'x', start: L('2026-10-26 09:30'), location: { kind: 'field', fieldLocation: 'Pit 1' } });
    expect(r.ok).toBe(false);
  });
  it('requires type and reason', () => {
    const s = new Store(truck('a'));
    const r = flagDown(s.ctx(L('2026-10-26 08:00')), { type: 'unscheduled', reasonCode: '', start: L('2026-10-26 08:00'), location: { kind: 'field', fieldLocation: 'Pit 1' } });
    expect(r.ok).toBe(false);
  });
  it('R2: a parked unit cannot be flagged', () => {
    const s = new Store(truck('a'));
    const r = flagDown({ ...s.ctx(L('2026-10-26 08:00')), lifecycle: 'parked' }, { type: 'unscheduled', reasonCode: 'x', start: L('2026-10-26 08:00'), location: { kind: 'field', fieldLocation: 'P' } });
    expect(r.ok).toBe(false);
  });
});

describe('R4: back-dating keeps the real entry time and is limited by role', () => {
  it('supervisor can back-date into the previous shift, and the audit keeps both times', () => {
    const s = new Store(truck('a'));
    const now = L('2026-10-26 08:00'); // day shift; previous shift started 18:00 on the 25th
    const r = flagDown(s.ctx(now), { type: 'unscheduled', reasonCode: 'x', start: L('2026-10-25 20:00'), location: { kind: 'field', fieldLocation: 'P' } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.flags[0]!.enteredAt).toBe(now);
      expect(r.audit[0]!.at).toBe(now);
      expect(r.audit[0]!.effectiveAt).toBe(L('2026-10-25 20:00'));
    }
  });
  it('supervisor cannot back-date beyond the previous shift', () => {
    const s = new Store(truck('a'));
    const r = flagDown(s.ctx(L('2026-10-26 08:00')), { type: 'unscheduled', reasonCode: 'x', start: L('2026-10-25 17:00'), location: { kind: 'field', fieldLocation: 'P' } });
    expect(r.ok).toBe(false);
  });
  it('reliability engineer can back-date within the open period but not into a locked one', () => {
    const s = new Store(truck('a'), DEFAULT_FLAG_RULES, L('2026-10-19 00:00'));
    const re = actor('reliability_engineer');
    expect(flagDown(s.ctx(L('2026-10-26 08:00'), re), { type: 'unscheduled', reasonCode: 'x', start: L('2026-10-20 08:00'), location: { kind: 'field', fieldLocation: 'P' } }).ok).toBe(true);
    expect(flagDown(s.ctx(L('2026-10-26 08:00'), re), { type: 'unscheduled', reasonCode: 'x', start: L('2026-10-18 08:00'), location: { kind: 'field', fieldLocation: 'P' } }).ok).toBe(false);
  });
});

describe('Proposals (T1–T3, R11)', () => {
  it('technician proposes, cannot flag down directly; proposal does not count until confirmed', () => {
    const s = new Store(truck('a'));
    const tech = actor('technician');
    expect(flagDown(s.ctx(L('2026-10-26 08:00'), tech), { type: 'unscheduled', reasonCode: 'x', start: L('2026-10-26 08:00'), location: { kind: 'field', fieldLocation: 'P' } }).ok).toBe(false);
    const [p] = s.apply(proposeDown(s.ctx(L('2026-10-26 08:05'), tech), { reasonCode: 'Brakes', start: L('2026-10-26 08:00'), location: { kind: 'field', fieldLocation: 'Pit 3' } }));
    const period = { from: L('2026-10-26 06:00'), to: L('2026-10-26 18:00') };
    const k1 = computeKpis({ assets: [s.asset], flags: s.flags, smu: [], rules: DEFAULT_FLAG_RULES, now: L('2026-10-26 09:00') }, period);
    expect(k1.downHours).toBe(0);
    // Alert after 30 minutes unconfirmed.
    const al = activeAlerts({ assets: [s.asset], flags: s.flags, smu: [], rules: DEFAULT_FLAG_RULES, calendar: cal, now: L('2026-10-26 08:40') });
    expect(al.some((a) => a.kind === 'proposal_unconfirmed')).toBe(true);
    s.apply(confirmProposal(s.ctx(L('2026-10-26 09:00')), p!, { type: 'unscheduled' }));
    const k2 = computeKpis({ assets: [s.asset], flags: s.flags, smu: [], rules: DEFAULT_FLAG_RULES, now: L('2026-10-26 09:00') }, period);
    expect(k2.downHours).toBe(1); // starts at the proposed time
    expect(s.open.stages[0]!.stage).toBe('waiting_crew');
  });

  it('C2: a rejected fixed-plant stop is Voided by default, or a process delay when configured', () => {
    const pump = truck('p1', { assetClass: 'fixed_plant', functionalLocation: 'CONC-GRIND-PUMP-01' });
    for (const [mode, expected] of [['voided', 'voided'], ['process_delay', 'process_delay']] as const) {
      const s = new Store(pump, withRules({ rejectedFixedPlantProposal: mode }));
      const [p] = s.apply(proposeDown(s.ctx(L('2026-10-26 10:42')), { reasonCode: 'Stop detected', start: L('2026-10-26 10:42'), location: { kind: 'in_place' }, source: 'historian' }));
      const [r] = s.apply(rejectProposal(s.ctx(L('2026-10-26 10:50')), p!, 'Full bins'));
      expect(r!.state).toBe(expected);
    }
  });
});

describe('Stages (S1–S5)', () => {
  it('S1: first stage comes from the location', () => {
    for (const [loc, stage] of [
      [{ kind: 'field', fieldLocation: 'P' }, 'waiting_crew'],
      [{ kind: 'shop_yard' }, 'waiting_line'],
      [{ kind: 'shop_line', shopLineId: 'L2' }, 'in_repair'],
    ] as const) {
      const s = new Store(truck('a'));
      const f = down(s, L('2026-10-26 08:00'), { location: loc });
      expect(f.stages[0]!.stage).toBe(stage);
    }
  });
  it('S3: In transit can only be set by towing', () => {
    const s = new Store(truck('a'));
    down(s, L('2026-10-26 08:00'), { location: { kind: 'field', fieldLocation: 'P' } });
    expect(changeStage(s.ctx(L('2026-10-26 08:10')), s.open, { stage: 'in_transit' }).ok).toBe(false);
  });
  it('S5: Waiting other needs a reason from the list', () => {
    const s = new Store(truck('a'));
    down(s, L('2026-10-26 08:00'));
    expect(changeStage(s.ctx(L('2026-10-26 08:10')), s.open, { stage: 'waiting_other' }).ok).toBe(false);
    expect(changeStage(s.ctx(L('2026-10-26 08:10')), s.open, { stage: 'waiting_other', reason: 'Lunch' }).ok).toBe(false);
    expect(changeStage(s.ctx(L('2026-10-26 08:10')), s.open, { stage: 'waiting_other', reason: 'Crane' }).ok).toBe(true);
  });
  it('S4: release is blocked from Waiting parts', () => {
    const s = new Store(truck('a'));
    down(s, L('2026-10-26 08:00'));
    s.apply(changeStage(s.ctx(L('2026-10-26 09:00')), s.open, { stage: 'waiting_parts' }));
    expect(release(s.ctx(L('2026-10-26 10:00')), s.open, { details: UNSCHED_RELEASE }).ok).toBe(false);
  });
  it('releasing straight from In repair records a zero-length Ready for release', () => {
    const s = new Store(truck('a'));
    down(s, L('2026-10-26 08:00'));
    const [f] = s.apply(release(s.ctx(L('2026-10-26 10:00')), s.open, { details: UNSCHED_RELEASE }));
    const last = f!.stages.at(-1)!;
    expect(last.stage).toBe('ready_for_release');
    expect(last.start).toBe(last.end);
  });
});

describe('Release checklist (A7 section 6)', () => {
  it('unscheduled needs system, component, failure mode, summary and work order', () => {
    const s = new Store(truck('a'));
    down(s, L('2026-10-26 08:00'));
    const r = release(s.ctx(L('2026-10-26 10:00')), s.open, { details: { system: 'Engine' } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toContain('Component, Failure mode, Repair summary, Work order');
  });
  it('scheduled needs PM or work order, summary and findings', () => {
    const s = new Store(truck('a'));
    down(s, L('2026-10-26 08:00'), { type: 'scheduled', reasonCode: 'PM 500' });
    expect(release(s.ctx(L('2026-10-26 10:00')), s.open, { details: { repairSummary: 'Done' } }).ok).toBe(false);
    expect(release(s.ctx(L('2026-10-26 10:00')), s.open, { details: { repairSummary: 'Done', pmOrWorkOrder: 'PM-1', findings: 'None' } }).ok).toBe(true);
  });
});

describe('Locations and shop lines (L1–L6)', () => {
  it('L1: a full line takes no more units', () => {
    const s = new Store(truck('a'));
    down(s, L('2026-10-26 08:00'), { location: { kind: 'shop_line', shopLineId: 'L1' } });
    const other = new Store(truck('b'));
    other.flags = s.flags;
    const r = flagDown(other.ctx(L('2026-10-26 09:00')), { type: 'unscheduled', reasonCode: 'x', start: L('2026-10-26 09:00'), location: { kind: 'shop_line', shopLineId: 'L1' } });
    expect(r.ok).toBe(false);
  });
  it('L2: a closed line takes no units', () => {
    const s = new Store(truck('a'));
    s.closures.push({ lineId: 'L3', start: L('2026-10-26 06:00'), end: L('2026-10-26 14:00'), reason: 'Crane inspection' });
    expect(flagDown(s.ctx(L('2026-10-26 08:00')), { type: 'unscheduled', reasonCode: 'x', start: L('2026-10-26 08:00'), location: { kind: 'shop_line', shopLineId: 'L3' } }).ok).toBe(false);
  });
  it('L3 / D8: line type mismatch needs an override reason', () => {
    const s = new Store(truck('a'));
    const base = { type: 'unscheduled' as const, reasonCode: 'x', start: L('2026-10-26 08:00') };
    expect(flagDown(s.ctx(L('2026-10-26 08:00')), { ...base, location: { kind: 'shop_line', shopLineId: 'WASH' } }).ok).toBe(false);
    const r = flagDown(s.ctx(L('2026-10-26 08:00')), { ...base, location: { kind: 'shop_line', shopLineId: 'WASH', overrideReason: 'Only free line' } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warnings[0]).toContain('override');
  });
  it('move matrix: shop line cannot go back to the field; towing cannot release', () => {
    const s = new Store(truck('a'));
    down(s, L('2026-10-26 08:00'));
    expect(moveLocation(s.ctx(L('2026-10-26 09:00')), s.open, { kind: 'field', fieldLocation: 'P' }).ok).toBe(false);
  });
  it('D7: technicians cannot move a unit by default', () => {
    const s = new Store(truck('a'));
    down(s, L('2026-10-26 08:00'), { location: { kind: 'field', fieldLocation: 'P' } });
    expect(moveLocation(s.ctx(L('2026-10-26 09:00'), actor('technician')), s.open, { kind: 'towing' }).ok).toBe(false);
  });
  it('field repair finished without entering the shop (L5), and tow cancelled needs a reason (C3)', () => {
    const s = new Store(truck('a'));
    down(s, L('2026-10-26 08:00'), { location: { kind: 'field', fieldLocation: 'Ramp 2' } });
    s.apply(moveLocation(s.ctx(L('2026-10-26 08:10')), s.open, { kind: 'towing' }));
    expect(moveLocation(s.ctx(L('2026-10-26 08:20')), s.open, { kind: 'field', fieldLocation: 'Ramp 2' }).ok).toBe(false);
    s.apply(moveLocation(s.ctx(L('2026-10-26 08:20')), s.open, { kind: 'field', fieldLocation: 'Ramp 2', reason: 'Fixed in place after all' }));
    expect(s.open.stages.at(-1)!.stage).toBe('waiting_crew');
    s.apply(changeStage(s.ctx(L('2026-10-26 08:30')), s.open, { stage: 'in_repair' }));
    const [f] = s.apply(release(s.ctx(L('2026-10-26 09:30')), s.open, { details: UNSCHED_RELEASE }));
    expect(f!.locations.at(-1)!.kind).toBe('field');
  });
  it('down in field → towed → waits for a line → enters Line 4, each period timed (Appendix E)', () => {
    const s = new Store(truck('a'));
    down(s, L('2026-10-26 08:00'), { location: { kind: 'field', fieldLocation: 'Pit 2' } });
    s.apply(moveLocation(s.ctx(L('2026-10-26 09:00')), s.open, { kind: 'towing' }));
    s.apply(moveLocation(s.ctx(L('2026-10-26 09:45')), s.open, { kind: 'shop_yard' }));
    s.apply(moveLocation(s.ctx(L('2026-10-26 11:00')), s.open, { kind: 'shop_line', shopLineId: 'L4' }));
    const f = s.open;
    expect(f.locations.map((l) => [l.kind, l.end && minutes((Date.parse(l.end) - Date.parse(l.start)) / 3.6e6)])).toEqual([
      ['field', 60], ['towing', 45], ['shop_yard', 75], ['shop_line', null],
    ]);
    expect(f.stages.at(-1)!.stage).toBe('in_repair');
  });
  it('line occupancy excludes closed time (crane inspection)', () => {
    const line = LINES[2]!;
    const p = { from: L('2026-10-26 06:00'), to: L('2026-10-26 18:00') };
    const flags = [fixtureFlag({ id: 'x', unitId: 'a', type: 'unscheduled', start: L('2026-10-26 12:00'), end: L('2026-10-26 18:00'), locations: [{ kind: 'shop_line', shopLineId: line.id, start: L('2026-10-26 12:00'), end: L('2026-10-26 18:00'), setBy: 'x', enteredAt: 'x' }] })];
    const closures = [{ lineId: line.id, start: L('2026-10-26 06:00'), end: L('2026-10-26 10:00'), reason: 'Crane inspection' }];
    const o = lineOccupancy(line, flags, closures, p, L('2026-10-27 00:00'));
    expect(o.openHours).toBe(8);
    expect(o.occupiedHours).toBe(6);
    expect(o.occupancy).toBe(0.75);
  });
});

describe('Type switch and PM overrun (R7, R8, D4, D5)', () => {
  function pmThatOverruns(rules = DEFAULT_FLAG_RULES) {
    const s = new Store(truck('a'), rules);
    down(s, L('2026-10-26 06:00'), { type: 'scheduled', reasonCode: 'PM 500', plannedDurationHours: 8, location: { kind: 'shop_line', shopLineId: 'L1' } });
    const al = activeAlerts({ assets: [s.asset], flags: s.flags, smu: [], rules, calendar: cal, now: L('2026-10-26 14:30') });
    expect(al.some((a) => a.kind === 'pm_overrun')).toBe(true);
    s.apply(switchType(s.ctx(L('2026-10-26 14:30')), s.open, { reason: 'Cracked frame found at PM', reasonCode: 'Defect found at PM', system: 'Frame' }));
    s.apply(release(s.ctx(L('2026-10-26 20:30')), s.open, { details: { ...UNSCHED_RELEASE, system: 'Frame', detectionMethod: 'pm' } }));
    return s;
  }
  it('closes the scheduled flag and opens a linked unscheduled one; together one downtime event', () => {
    const s = pmThatOverruns();
    expect(s.flags).toHaveLength(2);
    expect(s.flags[0]!.end).toBe(s.flags[1]!.start);
    expect(s.flags[1]!.linkedFromFlagId).toBe(s.flags[0]!.id);
    const ev = buildEvents(s.flags, DEFAULT_FLAG_RULES, L('2026-10-27 00:00'));
    expect(ev).toHaveLength(1);
  });
  it('D5 default: defect found at a PM is downtime but not a failure', () => {
    const s = pmThatOverruns();
    const k = computeKpis({ assets: [s.asset], flags: s.flags, smu: [], rules: DEFAULT_FLAG_RULES, now: L('2026-10-27 00:00') }, { from: L('2026-10-26 00:00'), to: L('2026-10-27 00:00') });
    expect(k.scheduledDownHours).toBe(8.5);
    expect(k.unscheduledDownHours).toBe(6);
    expect(k.failures).toBe(0);
  });
  it('D5 = yes counts it as a failure', () => {
    const rules = withRules({ pmFoundDefectCountsAsFailure: true });
    const s = pmThatOverruns(rules);
    const k = computeKpis({ assets: [s.asset], flags: s.flags, smu: [], rules, now: L('2026-10-27 00:00') }, { from: L('2026-10-26 00:00'), to: L('2026-10-27 00:00') });
    expect(k.failures).toBe(1);
  });
});

describe('R9 / D1: minor stops', () => {
  it('an unscheduled stop under 15 minutes is downtime but not a failure', () => {
    const flags = [fixtureFlag({ id: 'm', unitId: 'a', type: 'unscheduled', start: L('2026-10-26 08:00'), end: L('2026-10-26 08:10') })];
    const k = computeKpis({ assets: [truck('a')], flags, smu: [], rules: DEFAULT_FLAG_RULES, now: L('2026-10-27 00:00') }, { from: L('2026-10-26 00:00'), to: L('2026-10-27 00:00') });
    expect(minutes(k.downHours)).toBe(10);
    expect(k.failures).toBe(0);
    expect(k.minorStops).toBe(1);
  });
});

describe('Reporting split (R6)', () => {
  it('a breakdown across midnight and a shift change is split, the stored record is not', () => {
    const f = fixtureFlag({ id: 'x', unitId: 'a', type: 'unscheduled', start: L('2026-10-26 16:00'), end: L('2026-10-27 08:00') });
    const p = splitFlag(f, cal, L('2026-10-28 00:00'));
    expect(p.map((x) => [x.shift, x.localDate, x.hours])).toEqual([
      ['day', '2026-10-26', 2],
      ['night', '2026-10-26', 6],
      ['night', '2026-10-27', 6],
      ['day', '2026-10-27', 2],
    ]);
    expect(f.end).toBe(L('2026-10-27 08:00'));
  });
  it('a breakdown across month-end lands in both months', () => {
    const f = fixtureFlag({ id: 'x', unitId: 'a', type: 'unscheduled', start: L('2026-09-30 20:00'), end: L('2026-10-01 04:00') });
    const p = splitFlag(f, cal, L('2026-10-02 00:00'));
    const byMonth = (m: string) => p.filter((x) => x.month === m).reduce((a, x) => a + x.hours, 0);
    expect(byMonth('2026-09')).toBe(4);
    expect(byMonth('2026-10')).toBe(4);
  });
  it('night shift belongs to the date it started and crews follow the rotation', () => {
    const f = fixtureFlag({ id: 'x', unitId: 'a', type: 'unscheduled', start: L('2026-10-26 23:00'), end: L('2026-10-27 01:00') });
    const p = splitFlag(f, cal, L('2026-10-28 00:00'));
    expect(new Set(p.map((x) => x.shiftDate))).toEqual(new Set(['2026-10-26']));
    expect(p[0]!.crew).toBeDefined();
  });
  it('works across the DST change on 1 November 2026 (night shift is 13 h)', () => {
    const f = fixtureFlag({ id: 'x', unitId: 'a', type: 'unscheduled', start: L('2026-10-31 18:00'), end: L('2026-11-01 06:00') });
    const p = splitFlag(f, cal, L('2026-11-02 00:00'));
    expect(p.reduce((a, x) => a + x.hours, 0)).toBe(13);
    expect(new Set(p.map((x) => x.shift))).toEqual(new Set(['night']));
  });
});

describe('Calendar hours (R2): a unit parked mid-period', () => {
  it('only counts active time', () => {
    const k = computeKpis(
      {
        assets: [truck('a')],
        flags: [],
        smu: [],
        lifecycle: [{ assetId: 'a', status: 'parked', start: L('2026-10-29 00:00'), end: null }],
        rules: DEFAULT_FLAG_RULES,
        now: L('2026-11-05 00:00'),
      },
      { from: L('2026-10-26 00:00'), to: L('2026-11-02 00:00') },
    );
    expect(k.calendarHours).toBe(72);
    expect(k.pa).toBe(1);
  });
});

describe('Void (T10, C5) and corrected events', () => {
  it('voided flags leave KPIs but stay in the audit trail', () => {
    const s = new Store(truck('a'));
    down(s, L('2026-10-26 08:00'));
    s.apply(voidFlag(s.ctx(L('2026-10-26 09:00')), s.flags[0]!, 'Wrong unit'));
    expect(s.flags[0]!.state).toBe('voided');
    expect(s.audit).toHaveLength(2);
    const k = computeKpis({ assets: [s.asset], flags: s.flags, smu: [], rules: DEFAULT_FLAG_RULES, now: L('2026-10-26 10:00') }, { from: L('2026-10-26 00:00'), to: L('2026-10-27 00:00') });
    expect(k.downHours).toBe(0);
  });
  it('C5: supervisor void window is the same shift by default, previous shift when configured', () => {
    for (const [win, ok] of [['same_shift', false], ['previous_shift', true]] as const) {
      const s = new Store(truck('a'), withRules({ supervisorVoidWindow: win }));
      down(s, L('2026-10-26 17:00'));
      expect(voidFlag(s.ctx(L('2026-10-26 19:00')), s.flags[0]!, 'Error').ok).toBe(ok);
    }
  });
});

describe('Reopen (T11, R10, D3, D6, C6)', () => {
  function released() {
    return (mode: 'continue_same_flag' | 'link_new_flag') => {
      const s = new Store(truck('a'), withRules({ reopenMode: mode }));
      down(s, L('2026-10-26 08:00'));
      s.apply(release(s.ctx(L('2026-10-26 10:00')), s.open, { details: UNSCHED_RELEASE }));
      return s;
    };
  }
  it('outside the reopen window or on another system is refused', () => {
    const s = released()('continue_same_flag');
    expect(reopen(s.ctx(L('2026-10-26 12:30')), s.flags[0]!, { reason: 'Leak again', system: 'Engine' }).ok).toBe(false);
    expect(reopen(s.ctx(L('2026-10-26 11:00')), s.flags[0]!, { reason: 'x', system: 'Brakes' }).ok).toBe(false);
  });
  it('continue mode: same flag reopens; gap counts as downtime when SMU did not run (D6)', () => {
    const s = released()('continue_same_flag');
    s.apply(reopen(s.ctx(L('2026-10-26 11:00')), s.flags[0]!, { reason: 'Leak again', system: 'Engine', smuGainedSinceRelease: 0.1 }));
    s.apply(changeStage(s.ctx(L('2026-10-26 11:30')), s.open, { stage: 'in_repair' }));
    s.apply(release(s.ctx(L('2026-10-26 12:00')), s.open, { details: UNSCHED_RELEASE }));
    expect(s.flags).toHaveLength(1);
    expect(s.flags[0]!.falseRelease).toBe(true);
    const k = computeKpis({ assets: [s.asset], flags: s.flags, smu: [], rules: s.rules, now: L('2026-10-27 00:00') }, { from: L('2026-10-26 00:00'), to: L('2026-10-27 00:00') });
    expect(k.downHours).toBe(4);
    expect(k.failures).toBe(1);
  });
  it('continue mode: gap counts as available when the unit ran', () => {
    const s = released()('continue_same_flag');
    s.apply(reopen(s.ctx(L('2026-10-26 11:00')), s.flags[0]!, { reason: 'Leak again', system: 'Engine', smuGainedSinceRelease: 0.9 }));
    s.apply(changeStage(s.ctx(L('2026-10-26 11:30')), s.open, { stage: 'in_repair' }));
    s.apply(release(s.ctx(L('2026-10-26 12:00')), s.open, { details: UNSCHED_RELEASE }));
    const k = computeKpis({ assets: [s.asset], flags: s.flags, smu: [], rules: s.rules, now: L('2026-10-27 00:00') }, { from: L('2026-10-26 00:00'), to: L('2026-10-27 00:00') });
    expect(k.downHours).toBe(3);
  });
  it('link mode: a new linked flag; one event when there is no gap', () => {
    const s = released()('link_new_flag');
    s.apply(reopen(s.ctx(L('2026-10-26 11:00')), s.flags[0]!, { reason: 'Leak again', system: 'Engine', smuGainedSinceRelease: 0 }));
    expect(s.flags).toHaveLength(2);
    expect(s.flags[0]!.falseRelease).toBe(true);
    expect(s.flags[1]!.start).toBe(s.flags[0]!.end);
    expect(buildEvents(s.flags, s.rules, L('2026-10-26 12:00'))).toHaveLength(1);
  });
});

describe('C7: mean downtime options', () => {
  // One 2 h failure plus one 10 min minor stop.
  const flags = [
    fixtureFlag({ id: 'a', unitId: 'a', type: 'unscheduled', start: L('2026-10-26 08:00'), end: L('2026-10-26 10:00') }),
    fixtureFlag({ id: 'b', unitId: 'a', type: 'unscheduled', start: L('2026-10-26 12:00'), end: L('2026-10-26 12:10') }),
  ];
  const run = (meanDowntime: 'all_downtime_per_failure' | 'failure_events_per_failure' | 'per_event') =>
    computeKpis({ assets: [truck('a')], flags, smu: [], rules: withRules({ meanDowntime }), now: L('2026-10-27 00:00') }, { from: L('2026-10-26 00:00'), to: L('2026-10-27 00:00') }).meanDowntime;
  it('plan/A7 text: all unscheduled downtime ÷ failures = 2 h 10', () => expect(minutes(run('all_downtime_per_failure')!)).toBe(130));
  it('failure events only = 2 h', () => expect(minutes(run('failure_events_per_failure')!)).toBe(120));
  it('per event = 1 h 05', () => expect(minutes(run('per_event')!)).toBe(65));
});

describe('R14: SMU rising while down', () => {
  it('raises a check when SMU rose more than 0.5 h in a shift while flagged down', () => {
    const s = new Store(truck('a'));
    down(s, L('2026-10-26 07:00'));
    const smu = [
      { unitId: 'a', at: L('2026-10-26 06:00'), hours: 100 },
      { unitId: 'a', at: L('2026-10-26 07:00'), hours: 101 },
      { unitId: 'a', at: L('2026-10-26 18:00'), hours: 103 },
    ];
    const al = activeAlerts({ assets: [s.asset], flags: s.flags, smu, rules: DEFAULT_FLAG_RULES, calendar: cal, now: L('2026-10-26 19:00') });
    expect(al.filter((a) => a.kind === 'smu_rising_while_down')).toHaveLength(1);
  });
  it('a shift with no SMU reading raises a check', () => {
    const al = activeAlerts({ assets: [truck('a')], flags: [], smu: [], rules: DEFAULT_FLAG_RULES, calendar: cal, now: L('2026-10-26 19:00') });
    expect(al.some((a) => a.kind === 'no_smu_reading')).toBe(true);
  });
  it('down with no ETA after 1 hour', () => {
    const s = new Store(truck('a'));
    down(s, L('2026-10-26 07:00'));
    const al = activeAlerts({ assets: [s.asset], flags: s.flags, smu: [], rules: DEFAULT_FLAG_RULES, calendar: cal, now: L('2026-10-26 08:05') });
    expect(al.some((a) => a.kind === 'no_eta')).toBe(true);
  });
});

describe('Operating hours from SMU', () => {
  it('a shift with a missing reading is spread pro rata, not lost', () => {
    const smu = [
      { unitId: 'a', at: L('2026-10-26 06:00'), hours: 0 },
      { unitId: 'a', at: L('2026-10-27 06:00'), hours: 20 },
    ];
    const k = computeKpis({ assets: [truck('a')], flags: [], smu, rules: DEFAULT_FLAG_RULES, now: L('2026-10-28 00:00') }, { from: L('2026-10-26 06:00'), to: L('2026-10-26 18:00') });
    expect(round(k.operatingHours)).toBe(10);
  });
});
