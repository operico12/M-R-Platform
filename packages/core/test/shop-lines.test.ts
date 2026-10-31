// Managing shop lines and closures (docs/shop-lines.md).
import { describe, expect, it } from 'vitest';
import type { ConsoleContext } from '../src/console.js';
import { activeLines, addLines, closeLine, closureNow, editLine, openLine, retireLine, unitsOnLine } from '../src/shop-lines.js';
import type { Role } from '../src/types.js';
import { LINES, TZ, actor, cal, fixtureFlag } from './helpers.js';

const NOW = '2026-10-31T12:00:00.000Z';
let n = 0;
const ctx = (role: Role, scope: string[] = ['*']): ConsoleContext => ({ actor: actor(role, scope), now: NOW, newId: () => `new${++n}`, timeZone: TZ, calendar: cal });
const inL2 = fixtureFlag({ id: 'F1', unitId: 'HT1', type: 'unscheduled', start: '2026-10-31T08:00:00.000Z', end: null, state: 'open',
  locations: [{ kind: 'shop_line', shopLineId: 'L2', start: '2026-10-31T08:00:00.000Z', end: null, setBy: 'x', enteredAt: '2026-10-31T08:00:00.000Z' }] });

describe('adding and changing lines (Admin)', () => {
  it('only the Admin adds lines; new lines take the next free numbers', () => {
    expect(addLines(ctx('superintendent'), LINES, 2, 'general', 's1', 'Truck shop').ok).toBe(false);
    expect(addLines(ctx('reliability_engineer'), LINES, 2, 'general', 's1', 'Truck shop').ok).toBe(false);
    const r = addLines(ctx('admin'), LINES, 2, 'general', 's1', 'Truck shop');
    expect(r.ok && r.records.slice(-2).map((l) => l.number)).toEqual([7, 8]);
    expect(r.ok && r.audit.map((a) => a.action)).toEqual(['add_line', 'add_line']);
    expect(addLines(ctx('admin'), LINES, 0, 'general', 's1', 'Truck shop').ok).toBe(false);
    expect(addLines(ctx('admin'), LINES, 21, 'general', 's1', 'Truck shop').ok).toBe(false);
  });

  it('fills a gap left by a retired line', () => {
    const r1 = retireLine(ctx('admin'), LINES, [], 'L3', 'Bay rebuilt');
    const r2 = r1.ok ? addLines(ctx('admin'), r1.records, 1, 'pm', 's1', 'Truck shop') : r1;
    expect(r2.ok && r2.records.at(-1)).toMatchObject({ number: 3, lineType: 'pm' });
  });

  it('edits a line and checks number, capacity and duplicates', () => {
    const ok = editLine(ctx('admin'), LINES, 'L1', { number: 1, name: ' Big bay ', lineType: 'general', capacity: 2, fits: ['793F', ' 793F', ''] });
    expect(ok.ok && ok.records[0]).toMatchObject({ number: 1, name: 'Big bay', capacity: 2, fits: ['793F'] });
    const bad = editLine(ctx('admin'), LINES, 'L1', { number: 2, lineType: 'general', capacity: 11, fits: [] });
    expect(bad.ok || bad.errors).toEqual(['Another open line is already number 2.', 'Capacity is 1 to 10 units.']);
    expect(editLine(ctx('admin'), LINES, 'L1', { lineType: 'general', capacity: 1, fits: [] }).ok).toBe(false);
  });

  it('retires a line with a reason, never one with a unit in it, and keeps it for history', () => {
    expect(retireLine(ctx('admin'), LINES, [inL2], 'L2', 'Gone').ok).toBe(false);
    expect(retireLine(ctx('admin'), LINES, [], 'L2', ' ').ok).toBe(false);
    const r = retireLine(ctx('admin'), LINES, [], 'L2', 'Bay converted to storage');
    expect(r.ok && r.records.length).toBe(LINES.length);
    expect(r.ok && r.records.find((l) => l.id === 'L2')).toMatchObject({ retiredAt: NOW, retiredReason: 'Bay converted to storage' });
    expect(r.ok && activeLines(r.records).some((l) => l.id === 'L2')).toBe(false);
  });
});

describe('closing and opening lines', () => {
  const L1 = LINES[0]!;
  it('supervisors in the shop, the superintendent and the Admin close a line with a reason', () => {
    expect(closeLine(ctx('technician'), L1, [], [], 'Crane').ok).toBe(false);
    expect(closeLine(ctx('supervisor', ['Pit 2']), L1, [], [], 'Crane').ok).toBe(false);
    expect(closeLine(ctx('supervisor', ['Truck shop']), L1, [], [], 'Crane').ok).toBe(true);
    expect(closeLine(ctx('admin'), L1, [], [], ' ').ok).toBe(false);
    const L2 = LINES[1]!;
    expect(closeLine(ctx('admin'), L2, [], [inL2], 'Crane').ok).toBe(false);
  });

  it('opens it again by ending the closure now', () => {
    const c = closeLine(ctx('superintendent'), L1, [], [], 'Crane inspection');
    expect(c.ok && closureNow('L1', c.records, NOW)).toBeTruthy();
    expect(c.ok && closeLine(ctx('admin'), L1, c.records, [], 'Again').ok).toBe(false);
    const later = { ...ctx('admin'), now: '2026-10-31T14:00:00.000Z' };
    const o = c.ok ? openLine(later, L1, c.records) : c;
    expect(o.ok && o.records[0]!.end).toBe('2026-10-31T14:00:00.000Z');
    expect(o.ok && closureNow('L1', o.records, '2026-10-31T14:00:00.000Z')).toBeUndefined();
    expect(openLine(later, L1, []).ok).toBe(false);
  });

  it('counts the units on a line', () => {
    expect(unitsOnLine('L2', [inL2]).map((f) => f.id)).toEqual(['F1']);
    expect(unitsOnLine('L1', [inL2])).toEqual([]);
  });
});
