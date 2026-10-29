// Main menu (docs/menu.md): pages in six groups, plus each person's pinned and recent pages
// and a page search. Pure functions; the web app keeps pins and recents per person and site.

export type MenuGroupId = 'today' | 'assets' | 'analyse' | 'improve' | 'data' | 'admin';

export interface MenuPage { href: string; label: string; group: MenuGroupId; words?: string }
export interface MenuGroup { id: MenuGroupId; label: string }

export const MENU_GROUPS: MenuGroup[] = [
  { id: 'today', label: 'Today' },
  { id: 'assets', label: 'Assets' },
  { id: 'analyse', label: 'Analyse' },
  { id: 'improve', label: 'Improve' },
  { id: 'data', label: 'Data' },
  { id: 'admin', label: 'Admin' },
];

/** Every page in the main menu. `words` are other names people search by. */
export const MENU_PAGES: MenuPage[] = [
  { href: '#/board', label: 'Status board', group: 'today', words: 'fleet down flags live' },
  { href: '#/lines', label: 'Shop lines', group: 'today', words: 'bays workshop' },
  { href: '#/plant', label: 'Plant overview', group: 'today', words: 'fixed plant' },
  { href: '#/alerts', label: 'Alerts', group: 'today' },
  { href: '#/tv', label: 'TV mode', group: 'today', words: 'screen display' },
  { href: '#/units', label: 'Units', group: 'assets', words: 'trucks equipment assets' },
  { href: '#/components', label: 'Components', group: 'assets', words: 'engines life' },
  { href: '#/condition', label: 'Condition', group: 'assets', words: 'oil samples readings' },
  { href: '#/spares', label: 'Spares', group: 'assets', words: 'parts stock' },
  { href: '#/inspections', label: 'Inspections', group: 'assets', words: 'checklists forms rounds' },
  { href: '#/performance', label: 'Performance', group: 'analyse', words: 'kpi pa availability utilisation mtbf mttr' },
  { href: '#/analysis', label: 'Downtime analysis', group: 'analyse', words: 'pareto bad actors' },
  { href: '#/explore', label: 'Explorer', group: 'analyse', words: 'charts query' },
  { href: '#/rcm', label: 'RCM', group: 'analyse', words: 'fmea failure modes strategy' },
  { href: '#/calc', label: 'Calculators', group: 'analyse', words: 'weibull reliability' },
  { href: '#/assist', label: 'Assist', group: 'analyse', words: 'ai claude questions' },
  { href: '#/actions', label: 'Actions', group: 'improve', words: 'tasks' },
  { href: '#/rca', label: 'Root cause analysis', group: 'improve', words: 'rca why' },
  { href: '#/projects', label: 'Projects', group: 'improve' },
  { href: '#/work', label: 'Work and PM', group: 'improve', words: 'work orders backlog preventive maintenance' },
  { href: '#/pack', label: 'Weekly pack', group: 'improve', words: 'report meeting' },
  { href: '#/import', label: 'Data import', group: 'data', words: 'maximo sap csv upload' },
  { href: '#/quality', label: 'Data quality', group: 'data', words: 'checks missing' },
  { href: '#/console', label: 'Console', group: 'admin', words: 'users codes settings access requests' },
  { href: '#/sites', label: 'Sites', group: 'admin', words: 'mines' },
  { href: '#/api', label: 'API access', group: 'admin', words: 'keys' },
  { href: '#/account', label: 'Account', group: 'admin', words: 'sign out two-step password' },
];

export const MENU_LIMITS = { pins: 8, recent: 4 } as const;
export const DEFAULT_PINS = ['#/board', '#/lines', '#/performance', '#/actions', '#/pack'];

const byHref = new Map(MENU_PAGES.map((p) => [p.href, p]));
export const menuPage = (href: string) => byHref.get(href);

/** The menu page a route belongs to: `unit/T-101` is under Units, `console/access` under Console. */
export function pageForRoute(hash: string): MenuPage | undefined {
  const path = hash.replace(/^#\//, '').split(/[/?]/)[0] ?? '';
  if (path === 'unit') return byHref.get('#/units');
  if (path === 'rules') return byHref.get('#/console');
  return byHref.get(`#/${path}`) ?? (path === '' ? byHref.get('#/board') : undefined);
}

/** Known pages only, no repeats, at most the limit. Unknown entries (a page that was removed) drop out. */
export function cleanPins(pins: unknown): string[] {
  if (!Array.isArray(pins)) return [...DEFAULT_PINS];
  const out: string[] = [];
  for (const h of pins) if (typeof h === 'string' && byHref.has(h) && !out.includes(h)) out.push(h);
  return out.slice(0, MENU_LIMITS.pins);
}

export type PinResult = { ok: true; pins: string[] } | { ok: false; error: string };

export function togglePin(pins: string[], href: string): PinResult {
  if (!byHref.has(href)) return { ok: false, error: 'That page is not in the menu.' };
  if (pins.includes(href)) return { ok: true, pins: pins.filter((h) => h !== href) };
  if (pins.length >= MENU_LIMITS.pins) return { ok: false, error: `Pin up to ${MENU_LIMITS.pins} pages. Unpin one first.` };
  return { ok: true, pins: [...pins, href] };
}

/** Most recent first, no repeats, pinned pages left out (they are already one click away). */
export function addRecent(recent: string[], href: string): string[] {
  if (!byHref.has(href)) return recent;
  return [href, ...recent.filter((h) => h !== href && byHref.has(h))].slice(0, MENU_LIMITS.recent);
}

export const recentToShow = (recent: string[], pins: string[]) => recent.filter((h) => !pins.includes(h) && byHref.has(h));

/** Pages matching what was typed: label starts first, then label words, then other names. */
export function searchPages(q: string, pages: MenuPage[] = MENU_PAGES): MenuPage[] {
  const t = q.trim().toLowerCase();
  if (!t) return [];
  const score = (p: MenuPage) => {
    const l = p.label.toLowerCase();
    if (l.startsWith(t)) return 0;
    if (l.split(/\s+/).some((w) => w.startsWith(t))) return 1;
    if (l.includes(t)) return 2;
    if ((p.words ?? '').split(/\s+/).some((w) => w.startsWith(t))) return 3;
    return -1;
  };
  return pages
    .map((p, i) => ({ p, s: score(p), i }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => a.s - b.s || a.i - b.i)
    .map((x) => x.p);
}
