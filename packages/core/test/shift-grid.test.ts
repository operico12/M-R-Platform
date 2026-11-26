// Shift grid (docs/shift-grid.md): one row per unit down in the window, one cell per hour, from the stage
// intervals. Worked by hand.

import { describe, expect, it } from 'vitest';
import { dayWindow, shiftGrid, shiftWindow } from '../src/shift-grid.js';
import type { DownFlag } from '../src/types.js';
import { L, TZ, cal, fixtureFlag, truck } from './helpers.js';

const st = (stage: DownFlag['stages'][number]['stage'], a: string, b: string | null) => ({ stage, start: L(a), end: b ? L(b) : null, setBy: 'x', enteredAt: L(a) });
const flag = (id: string, unit: string, a: string, b: string | null, stages: DownFlag['stages'], over: Partial<DownFlag> = {}): DownFlag =>
  fixtureFlag({ id, unitId: unit, type: 'unscheduled', start: L(a), end: b ? L(b) : null, state: b ? 'released' : 'open', stages, ...over });
const assets = [truck('ht1'), truck('ht2'), truck('ht3')];
const day = dayWindow('2026-10-26', TZ);
const NOW = L('2026-10-27 08:00');
const run = (flags: DownFlag[], over: Partial<Parameters<typeof shiftGrid>[0]> = {}) => shiftGrid({ flags, assets, window: day, timeZone: TZ, now: NOW, ...over });

describe('shiftGrid cells', () => {
  // Down 06:30 to 09:15: waiting for crew 06:30 to 07:00, in repair 07:00 to 09:15.
  const a = flag('a', 'ht1', '2026-10-26 06:30', '2026-10-26 09:15', [st('waiting_crew', '2026-10-26 06:30', '2026-10-26 07:00'), st('in_repair', '2026-10-26 07:00', '2026-10-26 09:15')]);
  const g = run([a]);
  const cell = (h: number) => g.rows[0]!.cells[h]!;

  it('has 24 cells for a normal day, labelled in site time', () => {
    expect(g.hours).toHaveLength(24);
    expect(g.hours[6]!.label).toBe('6:00');
  });

  it('takes the state with the most minutes in each hour', () => {
    expect(cell(5).kind).toBe('up'); // not down yet
    expect(cell(6)).toMatchObject({ kind: 'waiting', mixed: true }); // 30 waiting, 30 up
    expect(cell(6).minutes).toEqual({ repair: 0, waiting: 30, up: 30 });
    expect(cell(7)).toMatchObject({ kind: 'repair', mixed: false });
    expect(cell(8)).toMatchObject({ kind: 'repair', mixed: false });
    expect(cell(9)).toMatchObject({ kind: 'up', mixed: true }); // 15 repair, 45 up
    expect(cell(9).minutes.repair).toBe(15);
    expect(cell(10).kind).toBe('up');
  });

  it('lists the minutes in each stage, and the type of the flag', () => {
    expect(cell(6).stages).toEqual({ waiting_crew: 30 });
    expect(cell(7).type).toBe('unscheduled');
    expect(cell(5).type).toBeUndefined();
  });

  it('totals the down and in-repair hours from the same intervals', () => {
    expect(g.rows[0]!.downHours).toBeCloseTo(2.75, 9);
    expect(g.rows[0]!.repairHours).toBeCloseTo(2.25, 9);
  });

  it('breaks a tie in favour of the down state, repair first', () => {
    const tie = flag('t', 'ht1', '2026-10-26 10:30', '2026-10-26 11:30', [st('in_repair', '2026-10-26 10:30', '2026-10-26 11:30')]);
    const t = run([tie]).rows[0]!;
    expect(t.cells[10]!.kind).toBe('repair'); // 30 repair, 30 up
    expect(t.cells[11]!.kind).toBe('repair');
  });
});

describe('shiftGrid rows', () => {
  const a = flag('a', 'ht1', '2026-10-26 08:00', '2026-10-26 10:00', [st('in_repair', '2026-10-26 08:00', '2026-10-26 10:00')]);
  const b = flag('b', 'ht2', '2026-10-26 08:00', '2026-10-26 14:00', [st('waiting_parts', '2026-10-26 08:00', '2026-10-26 14:00')], { type: 'scheduled' });

  it('has a row only for units that were down, largest down time first', () => {
    const g = run([a, b]);
    expect(g.rows.map((r) => r.unitNumber)).toEqual(['HT2', 'HT1']);
    expect(g.rows[0]!.cells[9]).toMatchObject({ kind: 'waiting', type: 'scheduled' });
  });

  it('leaves out proposed and voided flags, and flags outside the window', () => {
    expect(run([{ ...a, state: 'voided' }, { ...b, state: 'proposed' }]).rows).toEqual([]);
    expect(run([flag('o', 'ht1', '2026-10-24 08:00', '2026-10-25 08:00', [st('in_repair', '2026-10-24 08:00', '2026-10-25 08:00')])]).rows).toEqual([]);
  });

  it('shows the stage at the start of the window for a flag that began earlier, and runs an open flag to now', () => {
    const long = flag('l', 'ht3', '2026-10-25 20:00', null, [st('waiting_parts', '2026-10-25 20:00', null)]);
    const g = run([long], { now: L('2026-10-26 12:00') });
    expect(g.rows[0]!.cells[0]!.kind).toBe('waiting');
    expect(g.rows[0]!.cells[11]).toMatchObject({ kind: 'waiting' });
    expect(g.rows[0]!.cells[12]!.kind).toBe('future'); // 12:00 onwards has not happened
    expect(g.rows[0]!.downHours).toBeCloseTo(12, 9);
  });

  it('does not count two overlapping flags twice', () => {
    const x = flag('x', 'ht1', '2026-10-26 08:00', '2026-10-26 10:00', [st('in_repair', '2026-10-26 08:00', '2026-10-26 10:00')]);
    const y = flag('y', 'ht1', '2026-10-26 09:00', '2026-10-26 11:00', [st('in_repair', '2026-10-26 09:00', '2026-10-26 11:00')]);
    expect(run([x, y]).rows[0]!.downHours).toBeCloseTo(3, 9);
  });
});

describe('windows', () => {
  it('cuts a shift: 12 cells on the day shift, crew shown', () => {
    const w = shiftWindow(cal, '2026-10-26', 'day')!;
    expect(w.from).toBe(L('2026-10-26 06:00'));
    expect(w.to).toBe(L('2026-10-26 18:00'));
    expect(shiftGrid({ flags: [], assets, window: w, timeZone: TZ, now: NOW }).hours).toHaveLength(12);
    expect(w.label).toMatch(/day shift \(crew [A-D]\)/);
    expect(shiftWindow(cal, '2026-10-26', 'swing')).toBeUndefined();
  });

  it('has 23 cells on the spring daylight-saving day and 25 on the autumn one', () => {
    expect(shiftGrid({ flags: [], assets, window: dayWindow('2026-03-08', TZ), timeZone: TZ, now: L('2026-03-09 00:00') }).hours).toHaveLength(23);
    // Denver: clocks go back on 1 November 2026. (Current tz data keeps Vancouver on daylight time, so it has no 25-hour day.)
    expect(shiftGrid({ flags: [], assets, window: dayWindow('2026-11-01', 'America/Denver'), timeZone: 'America/Denver', now: '2026-11-03T00:00:00.000Z' }).hours).toHaveLength(25);
  });
});
