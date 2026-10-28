import type { Role } from '@mr/core';
import { useEffect, useState } from 'react';
import { Board } from './screens/Board';
import { DataQuality, FlagRules } from './screens/DataQuality';
import { Imports } from './screens/Imports';
import { Performance } from './screens/Performance';
import { ShopLines } from './screens/ShopLines';
import { UnitList, UnitPage } from './screens/Units';
import { AppProvider, useApp } from './store';

function useHash(): string {
  const [h, setH] = useState(() => window.location.hash || '#/board');
  useEffect(() => {
    const f = () => setH(window.location.hash || '#/board');
    window.addEventListener('hashchange', f);
    return () => window.removeEventListener('hashchange', f);
  }, []);
  return h;
}

const NAV: Array<[string, string]> = [
  ['#/board', 'Status board'],
  ['#/lines', 'Shop lines'],
  ['#/units', 'Units'],
  ['#/performance', 'Performance'],
  ['#/quality', 'Data quality'],
  ['#/import', 'Data import'],
  ['#/rules', 'Flag rules'],
];

const ROLES: Array<[Role, string]> = [
  ['viewer', 'Viewer'],
  ['technician', 'Technician'],
  ['supervisor', 'Supervisor'],
  ['reliability_engineer', 'Reliability engineer'],
  ['superintendent', 'Superintendent'],
  ['admin', 'Admin'],
];

function Shell() {
  const hash = useHash();
  const app = useApp();
  const tv = hash.startsWith('#/tv');
  const [path, arg] = hash.replace(/^#\//, '').split('/');

  useEffect(() => {
    if (!tv) return;
    const prev = app.theme;
    app.setTheme('dark');
    return () => app.setTheme(prev);
  }, [tv]);

  let page;
  switch (path) {
    case 'tv':
    case 'board': page = <Board tv={tv} />; break;
    case 'lines': page = <ShopLines />; break;
    case 'units': page = <UnitList />; break;
    case 'unit': page = <UnitPage id={arg ?? ''} />; break;
    case 'performance': page = <Performance />; break;
    case 'quality': page = <DataQuality />; break;
    case 'import': page = <Imports />; break;
    case 'rules': page = <FlagRules />; break;
    default: page = <Board tv={false} />;
  }

  if (tv) return <div className="tv"><main>{page}</main></div>;

  return (
    <div className="shell">
      <nav className="nav" aria-label="Main">
        <h1>M&amp;R Platform<small>{app.ds.site.name}</small></h1>
        {NAV.map(([href, label]) => (
          <a key={href} href={href} aria-current={hash.startsWith(href) || (href === '#/units' && path === 'unit') ? 'page' : undefined}>{label}</a>
        ))}
        <a href="#/tv">TV mode</a>
        <div className="grow" />
        <label>
          Viewing as (demo)
          <select value={app.actor.role} onChange={(e) => app.setRole(e.target.value as Role)}>
            {ROLES.map(([r, l]) => <option key={r} value={r}>{l}</option>)}
          </select>
        </label>
        <label>
          Theme
          <select value={app.theme} onChange={(e) => app.setTheme(e.target.value as 'light' | 'dark')}>
            <option value="light">Light (office)</option>
            <option value="dark">Dark (night shift)</option>
          </select>
        </label>
      </nav>
      <main>{page}</main>
    </div>
  );
}

export function App() {
  return (
    <AppProvider>
      <Shell />
    </AppProvider>
  );
}
