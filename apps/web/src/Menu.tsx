// Main menu (docs/menu.md): an icon bar of groups, the chosen group's pages beside it,
// pinned and recent pages, and a page search. Pins and recents are kept per person and site
// on this device; they are a convenience, not records.

import {
  MENU_GROUPS, MENU_LIMITS, MENU_PAGES, addRecent, cleanPins, menuPage, pageForRoute, recentToShow, searchPages, togglePin,
  type MenuGroupId, type MenuPage,
} from '@mr/core';
import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode } from 'react';

type View = 'pinned' | 'account' | MenuGroupId;

const ICONS: Record<View, ReactNode> = {
  pinned: <path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z" />,
  today: <path d="M3 12h4l3-8 4 16 3-8h4" />,
  assets: <path d="M3 7l9-4 9 4v10l-9 4-9-4zM3 7l9 4 9-4M12 11v10" />,
  analyse: <path d="M4 20V10M10 20V4M16 20v-7M2 20h20" />,
  improve: <path d="M9 12l2 2 4-4M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z" />,
  data: <path d="M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />,
  account: <><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7" /></>,
  admin: <><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1L7 17M17 7l2.1-2.1" /></>,
};

const Svg = ({ children }: { children: ReactNode }) => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);
const Icon = ({ v }: { v: View }) => <Svg>{ICONS[v]}</Svg>;
const SEARCH = <><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></>;
const SUN = <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>;
const MOON = <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />;

const Star = ({ on }: { on: boolean }) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill={on ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true">{ICONS.pinned}</svg>
);

function useStored<T>(key: string, read: (v: unknown) => T): [T, (v: T) => void] {
  const load = () => { try { const s = localStorage.getItem(key); return read(s === null ? null : JSON.parse(s)); } catch { return read(null); } };
  const [v, setV] = useState<T>(load);
  useEffect(() => { setV(load()); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = (next: T) => { setV(next); try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* storage can be unavailable */ } };
  return [v, save];
}

const readRecent = (v: unknown) => (Array.isArray(v) ? v.filter((h): h is string => typeof h === 'string' && !!menuPage(h)).slice(0, MENU_LIMITS.recent) : []);

export interface MenuProps {
  hash: string;
  storeKey: string;
  counts: Partial<Record<string, number>>;
  countLabel: (href: string, n: number) => string;
  top: ReactNode;
  /** Who is signed in, sign out, and the demo role picker: shown under the account button. */
  account: ReactNode;
  theme: 'light' | 'dark';
  onTheme: (t: 'light' | 'dark') => void;
}

export function Menu({ hash, storeKey, counts, countLabel, top, account, theme, onTheme }: MenuProps) {
  const current = pageForRoute(hash);
  const [pins, setPins] = useStored(`mr.pins.${storeKey}`, cleanPins);
  const [recent, setRecent] = useStored(`mr.recent.${storeKey}`, readRecent);
  const [view, setView] = useState<View>('pinned');
  const [q, setQ] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const search = useRef<HTMLInputElement>(null);
  // Folded (the default): only the icon bar shows; hovering or clicking a group opens its
  // pages as a pop-out. "Keep open" pins the list beside the bar. Kept per device.
  const [folded, setFolded] = useStored('mr.menu.folded', (v) => (typeof v === 'boolean' ? v : true));
  const [pop, setPop] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const panel = useRef<HTMLDivElement>(null);
  const later = (f: () => void, ms: number) => { window.clearTimeout(timer.current); timer.current = window.setTimeout(f, ms); };
  const hoverOpen = (v: View) => (e: RPointerEvent) => {
    if (!folded || e.pointerType !== 'mouse') return;
    later(() => { setView(v); setQ(''); setMsg(null); setPop(true); }, 120);
  };
  const hoverClose = (e: RPointerEvent) => {
    if (!folded || e.pointerType !== 'mouse') return;
    later(() => { if (!panel.current?.contains(document.activeElement) || document.activeElement?.tagName === 'A') setPop(false); }, 350);
  };
  const keep = () => window.clearTimeout(timer.current);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const [focusSearch, setFocusSearch] = useState(0);
  useEffect(() => { if (focusSearch) search.current?.focus(); }, [focusSearch]);

  // Follow the page: opening a page from outside the shown group shows its group.
  useEffect(() => {
    if (!current) return;
    if (current.href !== '#/tv') setRecent(addRecent(recent, current.href));
    if (view !== 'pinned' && view !== current.group) setView(current.group);
    setPop(false);
  }, [current?.href]); // eslint-disable-line react-hooks/exhaustive-deps

  // "/" jumps to the page search, unless someone is typing.
  useEffect(() => {
    if (!pop) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPop(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pop]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      e.preventDefault();
      setPop(true);
      setFocusSearch((n) => n + 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const groupCount = (g: View) => {
    const list = g === 'pinned' ? pins.map(menuPage).filter(Boolean) as MenuPage[] : MENU_PAGES.filter((p) => p.group === g);
    return list.reduce((n, p) => n + (counts[p.href] ?? 0), 0);
  };

  const pin = (href: string) => {
    const r = togglePin(pins, href);
    if (r.ok) { setPins(r.pins); setMsg(null); } else setMsg(r.error);
  };

  const results = useMemo(() => searchPages(q), [q]);
  const go = (href: string) => { window.location.hash = href; setQ(''); setPop(false); };

  const row = (p: MenuPage, showGroup = false) => {
    const n = counts[p.href] ?? 0;
    const on = pins.includes(p.href);
    return (
      <li key={p.href} className="menu-row">
        <a href={p.href} aria-current={current?.href === p.href ? 'page' : undefined} onClick={() => { setQ(''); setPop(false); }}>
          <span>{p.label}{showGroup && <small> · {MENU_GROUPS.find((g) => g.id === p.group)?.label}</small>}</span>
          {n > 0 && <span className="nav-count" aria-label={countLabel(p.href, n)}>{n}</span>}
        </a>
        <button type="button" className="menu-pin" aria-pressed={on} aria-label={`${on ? 'Unpin' : 'Pin'} ${p.label}`} title={on ? 'Unpin' : 'Pin'} onClick={() => pin(p.href)}>
          <Star on={on} />
        </button>
      </li>
    );
  };

  const views: Array<[View, string]> = [['pinned', 'Pinned'], ...MENU_GROUPS.map((g): [View, string] => [g.id, g.label])];
  const pinned = pins.map(menuPage).filter((p): p is MenuPage => !!p);
  const recents = recentToShow(recent, pins).map(menuPage).filter((p): p is MenuPage => !!p);

  return (
    <nav className={`menu${folded ? ' menu--folded' : ''}${pop ? ' menu--pop' : ''}`} aria-label="Main">
      <div className="menu-rail" aria-label="Menu groups" role="group">
        <span className="menu-mark" aria-hidden="true">M&amp;R</span>
        <button type="button" className="menu-group" aria-keyshortcuts="/" onClick={() => { if (folded) setPop(true); setFocusSearch((n) => n + 1); }}>
          <Svg>{SEARCH}</Svg><span>Find</span>
        </button>
        {views.map(([v, label]) => {
          const n = groupCount(v);
          return (
            <button key={v} type="button" className="menu-group" aria-pressed={view === v && !q} aria-expanded={folded ? pop && view === v : undefined}
              onPointerEnter={hoverOpen(v)} onPointerLeave={hoverClose}
              onClick={() => { keep(); setPop(folded && !(pop && view === v)); setView(v); setQ(''); setMsg(null); }}>
              <Icon v={v} />
              <span>{label}</span>
              {n > 0 && <span className="menu-dot" aria-label={`${n} waiting`} />}
            </button>
          );
        })}
        <span className="menu-rail-gap" />
        <button type="button" className="menu-group" aria-label={theme === 'dark' ? 'Switch to day mode' : 'Switch to night mode'} title={theme === 'dark' ? 'Night mode is on' : 'Day mode is on'}
          onClick={() => onTheme(theme === 'dark' ? 'light' : 'dark')}>
          <Svg>{theme === 'dark' ? MOON : SUN}</Svg><span aria-hidden="true">{theme === 'dark' ? 'Night' : 'Day'}</span>
        </button>
        <button type="button" className="menu-group" aria-pressed={view === 'account' && !q} aria-expanded={folded ? pop && view === 'account' : undefined}
          onPointerEnter={hoverOpen('account')} onPointerLeave={hoverClose}
          onClick={() => { keep(); setPop(folded && !(pop && view === 'account')); setView('account'); setQ(''); setMsg(null); }}>
          <Icon v="account" /><span>You</span>
        </button>
      </div>
      {pop && <div className="menu-scrim" onClick={() => setPop(false)} />}
      <div className="menu-panel" ref={panel} onPointerEnter={keep} onPointerLeave={hoverClose}>
        {folded ? (
          <button type="button" className="menu-fold" aria-label="Keep the page list open" title="Keep open" onClick={() => { setFolded(false); setPop(false); }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M7 6l6 6-6 6M13 6l6 6-6 6" /></svg>
          </button>
        ) : (
          <button type="button" className="menu-fold" aria-label="Fold the page list" title="Fold" onClick={() => setFolded(true)}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M17 6l-6 6 6 6M11 6l-6 6 6 6" /></svg>
          </button>
        )}
        {top}
        <label className="menu-search">
          <span className="sr-only">Find a page</span>
          <input ref={search} type="search" value={q} placeholder="Find a page" aria-keyshortcuts="/"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && results[0]) go(results[0].href); else if (e.key === 'Escape') setQ(''); }} />
          <kbd aria-hidden="true">/</kbd>
        </label>
        {q ? (
          <>
            <h2 className="menu-head">Pages</h2>
            {results.length ? <ul className="menu-list">{results.map((p) => row(p, true))}</ul> : <p className="menu-empty">No page matches “{q}”.</p>}
          </>
        ) : view === 'account' ? (
          <>
            <h2 className="menu-head">Account</h2>
            {account}
          </>
        ) : view === 'pinned' ? (
          <>
            <h2 className="menu-head">Pinned</h2>
            {pinned.length ? <ul className="menu-list">{pinned.map((p) => row(p))}</ul> : <p className="menu-empty">Pin pages with the star to keep them here.</p>}
            {recents.length > 0 && (<><h2 className="menu-head">Recent</h2><ul className="menu-list">{recents.map((p) => row(p))}</ul></>)}
          </>
        ) : (
          <>
            <h2 className="menu-head">{MENU_GROUPS.find((g) => g.id === view)?.label}</h2>
            <ul className="menu-list">{MENU_PAGES.filter((p) => p.group === view).map((p) => row(p))}</ul>
          </>
        )}
        {msg && <p className="menu-msg" role="status">{msg}</p>}
      </div>
    </nav>
  );
}
