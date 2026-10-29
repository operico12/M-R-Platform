import { describe, expect, it } from 'vitest';
import type { DownFlag } from '../src/types.js';
import { EMPTY_BOARD_FILTER, boardCounts, boardFilterFromQuery, boardFilterToQuery, downSince, filterBoard, toggleIn, upSince, type StatusRow } from '../src/board.js';

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
  });
});

describe('status board filters', () => {
  const rows: StatusRow[] = [
    { unitId: '1', unitNumber: 'HT101', model: '793F', status: 'run' },
    { unitId: '2', unitNumber: 'HT102', model: '793F', status: 'down', text: 'Tyres Tyre bay' },
    { unitId: '3', unitNumber: 'HT201', model: '797F', status: 'sched', text: 'PM 250 Line 3' },
    { unitId: '4', unitNumber: 'HT202', model: '797F', status: 'run' },
    { unitId: '5', unitNumber: 'HT212', model: '797F', status: 'parked' },
  ];

  it('filters by status, model and search together', () => {
    expect(filterBoard(rows, EMPTY_BOARD_FILTER)).toHaveLength(5);
    expect(filterBoard(rows, { ...EMPTY_BOARD_FILTER, statuses: ['run'] }).map((r) => r.unitNumber)).toEqual(['HT101', 'HT202']);
    expect(filterBoard(rows, { statuses: ['run'], models: ['797F'], q: '' }).map((r) => r.unitNumber)).toEqual(['HT202']);
    expect(filterBoard(rows, { ...EMPTY_BOARD_FILTER, q: 'tyre' }).map((r) => r.unitNumber)).toEqual(['HT102']);
    expect(filterBoard(rows, { ...EMPTY_BOARD_FILTER, statuses: ['down', 'sched'] })).toHaveLength(2);
  });

  it('counts what a click on a status would show', () => {
    expect(boardCounts(rows, { statuses: ['down'], models: ['797F'], q: '' })).toEqual({ run: 1, sched: 1, down: 0, stale: 0, parked: 1 });
  });

  it('round-trips the filter through the address', () => {
    const f = { statuses: ['down' as const, 'sched' as const], models: ['793F'], q: 'brake' };
    expect(boardFilterFromQuery(boardFilterToQuery(f))).toEqual(f);
    expect(boardFilterFromQuery('status=down,bogus&model=')).toEqual({ statuses: ['down'], models: [], q: '' });
    expect(boardFilterToQuery(EMPTY_BOARD_FILTER)).toBe('');
    expect(toggleIn(['a'], 'a')).toEqual([]);
    expect(toggleIn(['a'], 'b')).toEqual(['a', 'b']);
  });
});
