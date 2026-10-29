import { describe, expect, it } from 'vitest';
import { DEFAULT_PINS, MENU_GROUPS, MENU_LIMITS, MENU_PAGES, addRecent, cleanPins, pageForRoute, recentToShow, searchPages, togglePin } from '../src/menu.js';

describe('menu', () => {
  it('puts every page in exactly one known group, with no repeats', () => {
    const groups = new Set(MENU_GROUPS.map((g) => g.id));
    expect(MENU_PAGES.every((p) => groups.has(p.group))).toBe(true);
    expect(new Set(MENU_PAGES.map((p) => p.href)).size).toBe(MENU_PAGES.length);
    expect(MENU_GROUPS.every((g) => MENU_PAGES.some((p) => p.group === g.id))).toBe(true);
  });

  it('finds the menu page for sub-routes', () => {
    expect(pageForRoute('#/unit/T-101')?.label).toBe('Units');
    expect(pageForRoute('#/console/access')?.label).toBe('Console');
    expect(pageForRoute('#/rules')?.label).toBe('Console');
    expect(pageForRoute('#/rca/abc?x=1')?.label).toBe('Root cause analysis');
    expect(pageForRoute('')?.label).toBe('Status board');
    expect(pageForRoute('#/nope')).toBeUndefined();
  });

  it('cleans stored pins', () => {
    expect(cleanPins(null)).toEqual(DEFAULT_PINS);
    expect(cleanPins(['#/rca', '#/rca', '#/gone', 7])).toEqual(['#/rca']);
    expect(cleanPins(MENU_PAGES.map((p) => p.href))).toHaveLength(MENU_LIMITS.pins);
  });

  it('pins and unpins, with a limit', () => {
    const r = togglePin(['#/board'], '#/rca');
    expect(r).toEqual({ ok: true, pins: ['#/board', '#/rca'] });
    expect(togglePin(['#/board', '#/rca'], '#/board')).toEqual({ ok: true, pins: ['#/rca'] });
    const full = MENU_PAGES.slice(0, MENU_LIMITS.pins).map((p) => p.href);
    expect(togglePin(full, '#/account').ok).toBe(false);
    expect(togglePin([], '#/nope').ok).toBe(false);
  });

  it('keeps recent pages newest first and hides pinned ones', () => {
    let r: string[] = [];
    for (const h of ['#/rca', '#/spares', '#/rca', '#/calc', '#/units', '#/sites']) r = addRecent(r, h);
    expect(r).toEqual(['#/sites', '#/units', '#/calc', '#/rca']);
    expect(recentToShow(r, ['#/units'])).toEqual(['#/sites', '#/calc', '#/rca']);
    expect(addRecent(r, '#/nope')).toBe(r);
  });

  it('searches labels before other names', () => {
    expect(searchPages('')).toEqual([]);
    expect(searchPages('per')[0]?.label).toBe('Performance');
    expect(searchPages('analysis').map((p) => p.label)).toEqual(['Downtime analysis', 'Root cause analysis']);
    expect(searchPages('weibull')[0]?.label).toBe('Calculators');
    expect(searchPages('maximo')[0]?.label).toBe('Data import');
    expect(searchPages('zzz')).toEqual([]);
  });
});
