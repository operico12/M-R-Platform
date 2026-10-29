import { describe, expect, it } from 'vitest';
import type { DownFlag } from '../src/types.js';
import { ALERT_PLAIN, sortAlerts } from '../src/alerts.js';
import { EMPTY_BOARD_FILTER, boardCounts, boardPlace, stageSince, boardFilterFromQuery, boardFilterToQuery, downSince, filterBoard, toggleIn, upSince, type StatusRow } from '../src/board.js';

function flag(id: string, unitId: string, start: string, end: string | null, extra: Partial<DownFlag> = {}): DownFlag {
  return {
    id, tenantId: 't1', siteId: 's1', unitId, type: 'unscheduled', state: end ? 'released' : 'open', reasonCode: 'Brakes', start, end,
    stages: [], locations: [], etas: [], workOrders: [], source: 'app', setBy: 'u', enteredAt: start, ...extra,
  };
}

const NOW = '2026-10-29T17:00:00.000Z';

describe('status board times', () => {
  it('counts down time from the first flag of a linked downtime event', () => {
    const a = flag('a', 'T1', '2026-10-28T08:00:00.000Z', '2026-10-28T12:00:00.000Z');
    const b = flag('b', 'T1', '2026-10-28T12:00:00.000Z', null, { linkedFromFlagId: 'a', linkKind: 'type_switch' });
    expect(downSince(b, [a, b])).toBe('2026-10-28T08:00:00.000Z');
    expect(downSince(a, [a, b])).toBe(a.start);
  });

  it('ignores a voided flag in the chain and survives a loop', () => {
    const v = flag('v', 'T1', '2026-10-27T00:00:00.000Z', '2026-10-27T01:00:00.000Z', { state: 'voided' });
    const b = flag('b', 'T1', '2026-10-28T12:00:00.000Z', null, { linkedFromFlagId: 'v' });
    expect(downSince(b, [v, b])).toBe(b.start);
    const x = flag('x', 'T1', '2026-10-28T10:00:00.000Z', null, { linkedFromFlagId: 'y' });
    const y = flag('y', 'T1', '2026-10-28T09:00:00.000Z', '2026-10-28T10:00:00.000Z', { linkedFromFlagId: 'x' });
    expect(downSince(x, [x, y])).toBe(y.start);
  });

  it('counts up time from the latest release before now', () => {
    const flags = [
      flag('1', 'T1', '2026-10-20T00:00:00.000Z', '2026-10-21T00:00:00.000Z'),
      flag('2', 'T1', '2026-10-25T00:00:00.000Z', '2026-10-26T06:00:00.000Z'),
      flag('3', 'T1', '2026-10-27T00:00:00.000Z', '2026-10-27T05:00:00.000Z', { state: 'voided' }),
      flag('4', 'T2', '2026-10-28T00:00:00.000Z', '2026-10-28T05:00:00.000Z'),
      flag('5', 'T1', '2026-10-30T00:00:00.000Z', '2026-10-30T05:00:00.000Z'),
    ];
    expect(upSince('T1', flags, NOW)).toBe('2026-10-26T06:00:00.000Z');
    expect(upSince('T3', flags, NOW)).toBeUndefined();
    // The end of a standby counts as coming back into use; a voided one does not.
    const sb = [{ unitId: 'T1', state: 'ended' as const, end: '2026-10-28T09:00:00.000Z' }, { unitId: 'T1', state: 'voided' as const, end: '2026-10-29T09:00:00.000Z' }];
    expect(upSince('T1', flags, NOW, sb)).toBe('2026-10-28T09:00:00.000Z');
  });
});

describe('three statuses', () => {
  const stage = (st: 'waiting_parts' | 'in_repair', start: string) => ({ stage: st, start, end: null, setBy: 'u', enteredAt: start });
  it('places a unit: down wins over standby, the sub-status is the current stage', () => {
    const down = { type: 'unscheduled' as const, stages: [stage('in_repair', '2026-10-29T01:00:00Z'), stage('waiting_parts', '2026-10-29T05:00:00Z')] };
    expect(boardPlace(down, { id: 'sb' }, false)).toEqual({ group: 'unsched', sub: 'waiting_parts', parked: false });
    expect(boardPlace({ type: 'scheduled', stages: [] }, undefined, false)).toEqual({ group: 'sched', sub: 'no_stage', parked: false });
    expect(boardPlace(undefined, { id: 'sb' }, false)).toEqual({ group: 'operational', sub: 'standby', parked: false });
    expect(boardPlace(undefined, undefined, false)).toEqual({ group: 'operational', sub: 'in_use', parked: false });
    // Parked is a tag under any of the three statuses.
    expect(boardPlace(undefined, undefined, true)).toEqual({ group: 'operational', sub: 'parked', parked: true });
    expect(boardPlace(down, undefined, true)).toEqual({ group: 'unsched', sub: 'waiting_parts', parked: true });
  });
  it('time in stage counts from the current stage start', () => {
    expect(stageSince({ start: '2026-10-29T01:00:00Z', stages: [stage('in_repair', '2026-10-29T01:00:00Z'), stage('waiting_parts', '2026-10-29T05:00:00Z')] })).toBe('2026-10-29T05:00:00Z');
    expect(stageSince({ start: '2026-10-29T01:00:00Z', stages: [] })).toBe('2026-10-29T01:00:00Z');
  });
});

describe('status board filters', () => {
  const rows: StatusRow[] = [
    { unitId: '1', unitNumber: 'HT101', model: '793F', group: 'operational', sub: 'in_use' },
    { unitId: '2', unitNumber: 'HT102', model: '793F', group: 'unsched', sub: 'waiting_parts', text: 'Tyres Tyre bay' },
    { unitId: '3', unitNumber: 'HT201', model: '797F', group: 'sched', sub: 'in_repair', text: 'PM 250 Line 3' },
    { unitId: '4', unitNumber: 'HT202', model: '797F', group: 'operational', sub: 'standby' },
    { unitId: '5', unitNumber: 'HT212', model: '797F', group: 'operational', sub: 'parked' },
    { unitId: '6', unitNumber: 'HT301', model: '797F', group: 'unsched', sub: 'in_repair' },
  ];
  const n = (f: Partial<typeof EMPTY_BOARD_FILTER>) => filterBoard(rows, { ...EMPTY_BOARD_FILTER, ...f }).map((r) => r.unitNumber);

  it('filters by status, sub-status, model and search together', () => {
    expect(n({})).toHaveLength(6);
    expect(n({ groups: ['operational'] })).toEqual(['HT101', 'HT202', 'HT212']);
    expect(n({ groups: ['operational'], models: ['797F'] })).toEqual(['HT202', 'HT212']);
    expect(n({ q: 'tyre' })).toEqual(['HT102']);
    expect(n({ q: 'waiting parts' })).toEqual(['HT102']);
    expect(n({ groups: ['unsched', 'sched'] })).toHaveLength(3);
    // The same stage under scheduled and unscheduled is two sub-statuses.
    expect(n({ subs: ['unsched:in_repair'] })).toEqual(['HT301']);
    // A status or a sub-status pressed: either shows.
    expect(n({ groups: ['sched'], subs: ['operational:standby'] })).toEqual(['HT201', 'HT202']);
  });

  it('counts what a press on a status or sub-status would show', () => {
    const c = boardCounts(rows, { ...EMPTY_BOARD_FILTER, groups: ['unsched'], subs: ['operational:standby'], models: ['797F'] });
    expect(c.groups).toEqual({ operational: 2, sched: 1, unsched: 1 });
    expect(c.subs).toEqual({ 'operational:standby': 1, 'sched:in_repair': 1, 'unsched:in_repair': 1, 'operational:parked': 1 });
  });

  it('round-trips the filter through the address, and old links still work', () => {
    const f = { groups: ['unsched' as const, 'sched' as const], subs: ['unsched:waiting_parts'], models: ['793F'], q: 'brake' };
    expect(boardFilterFromQuery(boardFilterToQuery(f))).toEqual(f);
    expect(boardFilterFromQuery('status=down,bogus,run,standby,parked&sub=unsched:nap,x,parked:parked&model=')).toEqual({ groups: ['unsched', 'operational'], subs: [], models: [], q: '' });
    expect(boardFilterToQuery(EMPTY_BOARD_FILTER)).toBe('');
    expect(toggleIn(['a'], 'a')).toEqual([]);
    expect(toggleIn(['a'], 'b')).toEqual(['a', 'b']);
  });
});

describe('alerts in plain words', () => {
  it('every kind has a title, a meaning and a next step', () => {
    for (const v of Object.values(ALERT_PLAIN)) expect(v.title && v.what && v.next).toBeTruthy();
  });
  it('lists the most urgent kind first, then the longest on', () => {
    const a = [
      { kind: 'flag_open_long' as const, since: '2026-10-20T00:00:00Z' },
      { kind: 'no_eta' as const, since: '2026-10-29T05:00:00Z' },
      { kind: 'eta_passed' as const, since: '2026-10-29T08:00:00Z' },
      { kind: 'no_eta' as const, since: '2026-10-29T01:00:00Z' },
    ];
    expect(sortAlerts(a).map((x) => `${x.kind} ${x.since.slice(11, 13)}`)).toEqual(['eta_passed 08', 'no_eta 01', 'no_eta 05', 'flag_open_long 00']);
  });
});
