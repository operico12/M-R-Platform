import { openAlerts, type Role, type SessionCheck } from '@mr/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { loadSite, mySites, remote, type Loaded, type RemoteSite } from './data/remote';
import { Board } from './screens/Board';
import { Explorer } from './screens/Explorer';
import { Components } from './screens/Components';
import { CalcPalette, Calculators } from './screens/Calculators';
import { Condition } from './screens/Condition';
import { Rcm } from './screens/Rcm';
import { Spares } from './screens/Spares';
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
import { Assist } from './screens/Assist';
import { Plant } from './screens/Plant';
import { Sites } from './screens/Sites';
import { ApiAccess } from './screens/ApiAccess';
import { Account, CodeCheck, MfaSetup, RequestAccess, mfaState, signedInAt, useSessionLimit } from './screens/Account';
import { DEMO_SITES, rememberSite, rememberedSite, type SiteChoice } from './data/sites';
import { switcherOrder } from '@mr/core';
import { AppProvider, useApp } from './store';
import { Menu } from './Menu';

function useHash(): string {
  const [h, setH] = useState(() => window.location.hash || '#/board');
  useEffect(() => {
    const f = () => setH(window.location.hash || '#/board');
    window.addEventListener('hashchange', f);
    return () => window.removeEventListener('hashchange', f);
  }, []);
  return h;
}

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
    case 'plant': page = <Plant query={query} />; break;
    case 'units': page = <UnitList />; break;
    case 'unit': page = <UnitPage id={arg ?? ''} />; break;
    case 'performance': page = <Performance />; break;
    case 'analysis': page = <Analysis query={query} />; break;
    case 'explore': page = <Explorer query={query} />; break;
    case 'components': page = <Components arg={arg || undefined} query={query} />; break;
    case 'condition': page = <Condition arg={arg || undefined} sub={sub || undefined} query={query} />; break;
    case 'rcm': page = <Rcm arg={arg || undefined} sub={sub || undefined} query={query} />; break;
    case 'spares': page = <Spares query={query} />; break;
    case 'assist': page = <Assist query={query} />; break;
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
    case 'sites': page = <Sites />; break;
    case 'api': page = <ApiAccess />; break;
    case 'account': page = <Account />; break;
    default: page = <Board tv={false} />;
  }

  const openCount = useMemo(
    () => openAlerts(app.ruleAlerts, app.alertAnswers, app.now, app.alertSettings.snoozeDays, app.ds.site.timeZone).open.length,
    [app.ruleAlerts, app.alertAnswers, app.now, app.alertSettings.snoozeDays, app.ds.site.timeZone],
  );

  if (tv) return <div className="tv"><main>{page}</main></div>;

  return (
    <div className="shell">
      <Menu
        hash={hash}
        storeKey={`${app.mode === 'demo' ? 'demo' : app.actor.userId}.${app.ds.site.id}`}
        counts={{ '#/alerts': openCount, '#/inspections': app.outbox.length }}
        countLabel={(href, n) => (href === '#/inspections' ? `${n} waiting to send` : `${n} open`)}
        top={(
          <>
            <h1>M&amp;R Platform{app.sites.length > 1 ? null : <small>{app.ds.site.name}</small>}</h1>
            {app.sites.length > 1 && (
              <label className="site-switch">
                <select value={app.ds.site.id} onChange={(e) => app.switchSite(e.target.value)} aria-label="Site">
                  {app.sites.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                </select>
              </label>
            )}
          </>
        )}
        bottom={(
          <div className="menu-foot">
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
          </div>
        )}
      />
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
  if (!remote) return <Demo />;
  return <Live />;
}

/** Demo mode: two synthetic mines in different time zones; switching remounts the app on the other one. */
function Demo() {
  const [sites, setSites] = useState<SiteChoice[]>(DEMO_SITES);
  const [siteId, setSiteId] = useState(() => switcherOrder(DEMO_SITES, rememberedSite('demo'))[0]!.id);
  const pick = (id: string) => { rememberSite('demo', id); setSiteId(id); };
  return (
    <AppProvider key={siteId} sites={sites} siteId={siteId} onSwitchSite={pick} onSitesChanged={(next, to) => { setSites(next); if (to) pick(to); }}>
      <Shell />
    </AppProvider>
  );
}

const toChoice = (s: RemoteSite): SiteChoice => ({ id: s.site_id, name: s.site_name, timeZone: s.time_zone, role: s.role, tenantId: s.tenant_id ?? '' });

// ---------- live mode: sign in, pick the site, load it ----------

type LiveState =
  | { step: 'checking' }
  | { step: 'signed_out' }
  | { step: 'no_access'; email: string }
  | { step: 'mfa'; factorId: string }
  | { step: 'mfa_setup'; siteName: string }
  | { step: 'loading' }
  | { step: 'ready'; data: Loaded; n: number }
  | { step: 'error'; message: string };

function Live() {
  const [st, setSt] = useState<LiveState>({ step: 'checking' });
  const [site, setSite] = useState<RemoteSite | null>(null);
  const [sites, setSites] = useState<RemoteSite[]>([]);
  const wanted = useRef<string | null>(null);
  // Who the loaded site belongs to. Supabase reports "signed in" again each time the tab comes back
  // into view; that must not reload the site (and lose what is on screen) for the same person.
  const loadedFor = useRef<string | null>(null);
  // "Continue as Viewer" for this sign-in when a site asks Admins for two-step and none is set up.
  const viewerOk = useRef(false);
  const [who, setWho] = useState<{ uid: string; signedIn?: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { data } = await remote!.auth.getSession();
      if (!data.session) { loadedFor.current = null; return setSt({ step: 'signed_out' }); }
      loadedFor.current = data.session.user.id;
      setWho({ uid: data.session.user.id, signedIn: signedInAt(data.session.access_token) ?? data.session.user.last_sign_in_at ?? undefined });
      // Anyone who has two-step on passes the code check before anything loads.
      const mfa = await mfaState().catch(() => ({ enrolled: false, factorId: undefined, current: 'aal1', next: 'aal1' }));
      if (mfa.enrolled && mfa.current !== 'aal2' && mfa.factorId) return setSt({ step: 'mfa', factorId: mfa.factorId });
      setSt({ step: 'loading' });
      const list = await mySites();
      setSites(list);
      // The site asked for (a switch), else the one last chosen on this device, else the first by name.
      const uid = data.session.user.id;
      const order = switcherOrder(list.map((x) => ({ ...x, id: x.site_id, name: x.site_name })), wanted.current ?? rememberedSite(uid));
      const chosen = order[0];
      if (!chosen) return setSt({ step: 'no_access', email: data.session.user.email ?? '' });
      rememberSite(uid, chosen.site_id);
      setSite(chosen);
      if (chosen.mfa_required && !viewerOk.current) return setSt({ step: 'mfa_setup', siteName: chosen.site_name });
      const loaded = await loadSite(chosen.site_id);
      setSt((prev) => ({ step: 'ready', data: loaded, n: prev.step === 'ready' ? prev.n + 1 : 0 }));
    } catch (e) {
      setSt({ step: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  useEffect(() => {
    void load();
    const { data } = remote!.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT' || (event === 'SIGNED_IN' && session?.user.id !== loadedFor.current)) void load();
    });
    return () => data.subscription.unsubscribe();
  }, [load]);

  const signOut = () => void remote!.auth.signOut();
  const expired = useCallback((why: SessionCheck) => {
    setNotice(why === 'idle' ? 'You were signed out because this device was not used for a while. Sign in again.' : 'Your sign-in was older than the site allows. Sign in again.');
    void remote!.auth.signOut();
  }, []);
  useSessionLimit(st.step === 'ready' ? who?.uid : undefined, who?.signedIn, st.step === 'ready' ? st.data.accessSettings : undefined, expired);

  if (st.step === 'ready') {
    return (
      <AppProvider key={st.n} live={st.data} onReload={() => void load()} onSignOut={signOut} sites={sites.map(toChoice)} siteId={site?.site_id}
        onSwitchSite={(id) => { wanted.current = id; void load(); }} onSitesChanged={(_next, to) => { if (to) wanted.current = to; void load(); }}>
        <Shell />
      </AppProvider>
    );
  }
  return (
    <div className="signin">
      <div className="card" style={{ maxWidth: 420, margin: '10vh auto', padding: 24 }}>
        <h1 style={{ fontSize: 22, marginTop: 0 }}>M&amp;R Platform</h1>
        {st.step === 'checking' || st.step === 'loading' ? <p className="muted">{st.step === 'loading' ? `Loading ${site?.site_name ?? 'your site'}…` : 'Checking sign-in…'}</p> : null}
        {st.step === 'signed_out' && notice && <p className="small" role="status">{notice}</p>}
        {st.step === 'signed_out' && <SignIn />}
        {st.step === 'no_access' && (
          <>
            <p>You are signed in as <strong>{st.email}</strong>, but you do not have access to a site yet.</p>
            <RequestAccess onApproved={() => void load()} />
            <p className="small muted">Or ask your site Admin to invite this email address in Console, Users.</p>
            <button className="btn" onClick={signOut}>Sign out</button>
          </>
        )}
        {st.step === 'mfa' && (
          <>
            <p>Two-step sign-in is on for your account.</p>
            <CodeCheck factorId={st.factorId} onDone={() => void remote!.auth.refreshSession().then(() => load())} onSkip={signOut} skipLabel="Sign out" />
          </>
        )}
        {st.step === 'mfa_setup' && (
          <>
            <p>{st.siteName} asks Admins to use two-step sign-in. Set up an authenticator app to act as Admin, or continue as a Viewer for now.</p>
            <MfaSetup onDone={() => void remote!.auth.refreshSession().then(() => load())} />
            <div className="row" style={{ gap: 8, marginTop: 8 }}>
              <button className="btn" onClick={() => { viewerOk.current = true; void load(); }}>Continue as Viewer</button>
              <button className="btn" onClick={signOut}>Sign out</button>
            </div>
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
