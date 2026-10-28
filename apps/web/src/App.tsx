import { openAlerts, type Role } from '@mr/core';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { loadSite, mySites, remote, type Loaded, type RemoteSite } from './data/remote';
import { Board } from './screens/Board';
import { CalcPalette, Calculators } from './screens/Calculators';
import { Actions } from './screens/Actions';
import { Alerts } from './screens/Alerts';
import { Analysis } from './screens/Analysis';
import { Console } from './screens/Console';
import { DataQuality } from './screens/DataQuality';
import { Imports } from './screens/Imports';
import { Inspections } from './screens/Inspections';
import { Pack } from './screens/Pack';
import { Projects } from './screens/Projects';
import { RcaScreen } from './screens/Rca';
import { Performance } from './screens/Performance';
import { ShopLines } from './screens/ShopLines';
import { UnitList, UnitPage } from './screens/Units';
import { Work } from './screens/Work';
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
  ['#/analysis', 'Downtime analysis'],
  ['#/work', 'Work and PM'],
  ['#/inspections', 'Inspections'],
  ['#/calc', 'Calculators'],
  ['#/alerts', 'Alerts'],
  ['#/actions', 'Actions'],
  ['#/rca', 'Root cause analysis'],
  ['#/projects', 'Projects'],
  ['#/pack', 'Weekly pack'],
  ['#/quality', 'Data quality'],
  ['#/import', 'Data import'],
  ['#/console', 'Console'],
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
  const [route, query = ''] = hash.replace(/^#\//, '').split('?');
  const [path, arg, sub] = (route ?? '').split('/');

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
    case 'analysis': page = <Analysis query={query} />; break;
    case 'work': page = <Work />; break;
    case 'alerts': page = <Alerts />; break;
    case 'calc': page = <Calculators arg={arg || undefined} sub={sub || undefined} query={query} />; break;
    case 'inspections': page = <Inspections arg={arg || undefined} sub={sub} />; break;
    case 'pack': page = <Pack query={query} />; break;
    case 'actions': page = <Actions arg={arg} query={query} />; break;
    case 'rca': page = <RcaScreen arg={arg} query={query} />; break;
    case 'projects': page = <Projects arg={arg} query={query} />; break;
    case 'quality': page = <DataQuality />; break;
    case 'import': page = <Imports />; break;
    case 'rules': page = <Console tab="codes" />; break;
    case 'console': page = <Console tab={arg ?? 'users'} />; break;
    default: page = <Board tv={false} />;
  }

  const openCount = useMemo(
    () => openAlerts(app.ruleAlerts, app.alertAnswers, app.now, app.alertSettings.snoozeDays, app.ds.site.timeZone).open.length,
    [app.ruleAlerts, app.alertAnswers, app.now, app.alertSettings.snoozeDays, app.ds.site.timeZone],
  );

  if (tv) return <div className="tv"><main>{page}</main></div>;

  return (
    <div className="shell">
      <nav className="nav" aria-label="Main">
        <h1>M&amp;R Platform<small>{app.ds.site.name}</small></h1>
        {NAV.map(([href, label]) => (
          <a key={href} href={href} aria-current={hash.startsWith(href) || (href === '#/units' && path === 'unit') ? 'page' : undefined}>
            {label}{href === '#/alerts' && openCount > 0 && <span className="nav-count" aria-label={`${openCount} open`}>{openCount}</span>}
            {href === '#/inspections' && app.outbox.length > 0 && <span className="nav-count" aria-label={`${app.outbox.length} waiting to send`}>{app.outbox.length}</span>}
          </a>
        ))}
        <a href="#/tv">TV mode</a>
        <div className="grow" />
        {app.mode === 'demo' ? (
          <label>
            Viewing as (demo)
            <select value={app.actor.role} onChange={(e) => app.setRole(e.target.value as Role)}>
              {ROLES.map(([r, l]) => <option key={r} value={r}>{l}</option>)}
            </select>
          </label>
        ) : (
          <div className="small" style={{ marginTop: 8 }}>
            Signed in as {ROLES.find(([r]) => r === app.actor.role)?.[1]}
            {app.signOut && <button className="btn" style={{ marginTop: 6, width: '100%', minHeight: 36 }} onClick={app.signOut}>Sign out</button>}
          </div>
        )}
        <label>
          Theme
          <select value={app.theme} onChange={(e) => app.setTheme(e.target.value as 'light' | 'dark')}>
            <option value="light">Light (office)</option>
            <option value="dark">Dark (night shift)</option>
          </select>
        </label>
      </nav>
      <main>
        {app.syncError && (
          <div className="errors" role="alert" style={{ marginBottom: 12 }}>
            Your last change was not saved: {app.syncError}. The page has reloaded what the database holds.{' '}
            <button className="btn" onClick={app.clearSyncError}>OK</button>
          </div>
        )}
        {page}
      </main>
      <CalcPalette />
    </div>
  );
}

export function App() {
  if (!remote) {
    return (
      <AppProvider>
        <Shell />
      </AppProvider>
    );
  }
  return <Live />;
}

// ---------- live mode: sign in, pick the site, load it ----------

type LiveState =
  | { step: 'checking' }
  | { step: 'signed_out' }
  | { step: 'no_access'; email: string }
  | { step: 'loading' }
  | { step: 'ready'; data: Loaded; n: number }
  | { step: 'error'; message: string };

function Live() {
  const [st, setSt] = useState<LiveState>({ step: 'checking' });
  const [site, setSite] = useState<RemoteSite | null>(null);

  const load = useCallback(async () => {
    try {
      const { data } = await remote!.auth.getSession();
      if (!data.session) return setSt({ step: 'signed_out' });
      setSt({ step: 'loading' });
      const sites = await mySites();
      const chosen = sites[0];
      if (!chosen) return setSt({ step: 'no_access', email: data.session.user.email ?? '' });
      setSite(chosen);
      const loaded = await loadSite(chosen.site_id);
      setSt((prev) => ({ step: 'ready', data: loaded, n: prev.step === 'ready' ? prev.n + 1 : 0 }));
    } catch (e) {
      setSt({ step: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  useEffect(() => {
    void load();
    const { data } = remote!.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_IN' || event === 'SIGNED_OUT') void load();
    });
    return () => data.subscription.unsubscribe();
  }, [load]);

  const signOut = () => void remote!.auth.signOut();

  if (st.step === 'ready') {
    return (
      <AppProvider key={st.n} live={st.data} onReload={() => void load()} onSignOut={signOut}>
        <Shell />
      </AppProvider>
    );
  }
  return (
    <div className="signin">
      <div className="card" style={{ maxWidth: 420, margin: '10vh auto', padding: 24 }}>
        <h1 style={{ fontSize: 22, marginTop: 0 }}>M&amp;R Platform</h1>
        {st.step === 'checking' || st.step === 'loading' ? <p className="muted">{st.step === 'loading' ? `Loading ${site?.site_name ?? 'your site'}…` : 'Checking sign-in…'}</p> : null}
        {st.step === 'signed_out' && <SignIn />}
        {st.step === 'no_access' && (
          <>
            <p>You are signed in as <strong>{st.email}</strong>, but you have not been given access to a site yet.</p>
            <p className="small muted">Ask your site Admin to add this email address in Console, Users. Then sign in again.</p>
            <button className="btn" onClick={signOut}>Sign out</button>
          </>
        )}
        {st.step === 'error' && (
          <>
            <p className="errors" role="alert">Could not load the site: {st.message}</p>
            <button className="btn" onClick={() => void load()}>Try again</button> <button className="btn" onClick={signOut}>Sign out</button>
          </>
        )}
      </div>
    </div>
  );
}

function SignIn() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const send = async () => {
    setErr(null);
    const { error } = await remote!.auth.signInWithOtp({ email: email.trim(), options: { emailRedirectTo: window.location.origin + window.location.pathname, shouldCreateUser: true } });
    if (error) setErr(error.message);
    else setSent(true);
  };
  if (sent) return <p>Check your email. We sent a sign-in link to <strong>{email}</strong>. Open it on this device.</p>;
  return (
    <form onSubmit={(e) => { e.preventDefault(); void send(); }}>
      <p className="muted">Sign in with your work email. We email you a link; there is no password.</p>
      <label className="field"><span>Email</span><input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
      {err && <p className="errors" role="alert">{err}</p>}
      <button className="btn primary" type="submit">Email me a sign-in link</button>
    </form>
  );
}
