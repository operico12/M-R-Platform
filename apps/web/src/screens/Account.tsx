// Account (docs/access.md): who is signed in, two-step sign-in with an
// authenticator app, and the pieces the sign-in screen uses: the code check, the
// account request form and the session limit.

import { sessionCheck, type AccessSettings, type SessionCheck } from '@mr/core';
import { useCallback, useEffect, useState } from 'react';
import { myRequests, remote, requestAccess, requestSites, withdrawRequest, type MyRequest } from '../data/remote';
import { useApp } from '../store';

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ---------- two-step sign-in ----------

export interface MfaState { enrolled: boolean; factorId?: string; current: 'aal1' | 'aal2' | string; next: string }

export async function mfaState(): Promise<MfaState> {
  const [{ data: f }, { data: l }] = await Promise.all([remote!.auth.mfa.listFactors(), remote!.auth.mfa.getAuthenticatorAssuranceLevel()]);
  const totp = f?.totp?.find((x) => x.status === 'verified');
  return { enrolled: !!totp, factorId: totp?.id, current: l?.currentLevel ?? 'aal1', next: l?.nextLevel ?? 'aal1' };
}

/** Asks for the 6-digit code from the authenticator app; on success the sign-in is aal2. */
export function CodeCheck({ factorId, onDone, onSkip, skipLabel }: { factorId: string; onDone: () => void; onSkip?: () => void; skipLabel?: string }) {
  const [code, setCode] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const check = async () => {
    setBusy(true);
    const { error } = await remote!.auth.mfa.challengeAndVerify({ factorId, code: code.trim() });
    setBusy(false);
    if (error) return setErr(error.message);
    onDone();
  };
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); void check(); }}>
      <label className="field"><span>6-digit code from your authenticator app</span>
        <input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} /></label>
      {err && <p className="errors" role="alert">{err}</p>}
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <button className="btn primary" type="submit" disabled={busy || code.length !== 6}>Check code</button>
        {onSkip && <button className="btn" type="button" onClick={onSkip}>{skipLabel ?? 'Not now'}</button>}
      </div>
    </form>
  );
}

/** Adds an authenticator app: scan the QR code, then confirm with a code. */
export function MfaSetup({ onDone }: { onDone: () => void }) {
  const [enroll, setEnroll] = useState<{ id: string; qr: string; secret: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const start = async () => {
    setErr(null);
    const { data, error } = await remote!.auth.mfa.enroll({ factorType: 'totp', friendlyName: `Authenticator ${new Date().toISOString().slice(0, 10)}` });
    if (error || !data || data.type !== 'totp') return setErr(error?.message ?? 'Could not start.');
    setEnroll({ id: data.id, qr: data.totp.qr_code, secret: data.totp.secret });
  };
  if (!enroll) {
    return (
      <div className="stack">
        <button className="btn primary" onClick={() => void start()}>Set up an authenticator app</button>
        {err && <p className="errors" role="alert">{err}</p>}
      </div>
    );
  }
  return (
    <div className="stack">
      <p className="small" style={{ margin: 0 }}>Scan this with Microsoft Authenticator, Google Authenticator, 1Password or a similar app. Then type the code it shows.</p>
      <img src={enroll.qr} alt="QR code for your authenticator app" width={180} height={180} style={{ background: '#fff', padding: 8, borderRadius: 8 }} />
      <details className="small"><summary>Cannot scan? Type this key instead</summary><code style={{ wordBreak: 'break-all' }}>{enroll.secret}</code></details>
      <CodeCheck factorId={enroll.id} onDone={onDone} />
    </div>
  );
}

// ---------- the Account page ----------

export function Account() {
  const app = useApp();
  const [st, setSt] = useState<MfaState | null>(null);
  const [email, setEmail] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [setup, setSetup] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const { data } = await remote!.auth.getUser();
      setEmail(data.user?.email ?? '');
      setSt(await mfaState());
    } catch (e) { setErr(msg(e)); }
  }, []);
  useEffect(() => { if (app.mode === 'live') void refresh(); }, [app.mode, refresh]);
  const remove = async () => {
    if (!st?.factorId || !window.confirm('Turn off two-step sign-in for your account?')) return;
    const { error } = await remote!.auth.mfa.unenroll({ factorId: st.factorId });
    if (error) return setErr(error.message);
    await remote!.auth.refreshSession();
    void refresh();
  };
  if (app.mode === 'demo') {
    return (
      <div className="stack">
        <div className="page-head"><h2>Account</h2></div>
        <section className="card"><p className="muted">The demo has no sign-in. On the live site this page shows your email and lets you turn on two-step sign-in with an authenticator app.</p></section>
      </div>
    );
  }
  return (
    <div className="stack">
      <div className="page-head"><h2>Account</h2><span className="muted small">Signed in as {email || '…'}</span></div>
      <section className="card stack" aria-label="Two-step sign-in">
        <h3 style={{ margin: 0 }}>Two-step sign-in</h3>
        <p className="small muted" style={{ margin: 0 }}>After the email link, the app also asks for a 6-digit code from an app on your phone. Someone who gets into your email still cannot sign in as you.</p>
        {err && <p className="errors" role="alert">{err}</p>}
        {!st && !err && <p className="muted">Checking…</p>}
        {st?.enrolled && (
          <>
            <p style={{ margin: 0 }}>✓ On. {st.current === 'aal2' ? 'You passed the code check in this sign-in.' : 'You have not passed the code check in this sign-in yet.'}</p>
            {st.current !== 'aal2' && st.factorId && <CodeCheck factorId={st.factorId} onDone={() => window.location.reload()} />}
            {st.current === 'aal2' && <div><button className="btn danger" onClick={() => void remove()}>Turn off</button></div>}
          </>
        )}
        {st && !st.enrolled && (setup ? <MfaSetup onDone={() => window.location.reload()} /> : <div><button className="btn primary" onClick={() => setSetup(true)}>Turn on</button></div>)}
      </section>
      <section className="card stack">
        <p className="small muted" style={{ margin: 0 }}>Signed-in devices stay signed in for up to {app.accessSettings.sessionDays} days, or until {app.accessSettings.idleDays} days with no use.</p>
        <div><button className="btn" onClick={app.signOut}>Sign out</button></div>
      </section>
    </div>
  );
}

// ---------- account requests (before the person has a site) ----------

const STATUS: Record<MyRequest['status'], string> = { pending: 'Waiting for the Admin', approved: 'Approved', declined: 'Declined', withdrawn: 'Withdrawn' };

export function RequestAccess({ onApproved }: { onApproved: () => void }) {
  const [sites, setSites] = useState<Array<{ site_id: string; site_name: string }> | null>(null);
  const [mine, setMine] = useState<MyRequest[]>([]);
  const [site, setSite] = useState('');
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      const [s, m] = await Promise.all([requestSites(), myRequests()]);
      setSites(s);
      setMine(m);
      setSite((x) => x || s[0]?.site_id || '');
      if (m.some((r) => r.status === 'approved')) onApproved();
    } catch (e) { setErr(msg(e)); }
  }, [onApproved]);
  useEffect(() => { void load(); }, [load]);
  const send = async () => {
    setBusy(true);
    setErr(null);
    try { await requestAccess(site, name, note); setNote(''); await load(); } catch (e) { setErr(msg(e)); }
    setBusy(false);
  };
  const waiting = mine.filter((r) => r.status === 'pending').map((r) => r.site_id);
  const open = (sites ?? []).filter((s) => !waiting.includes(s.site_id));
  return (
    <div className="stack">
      {mine.length > 0 && (
        <ul className="small" style={{ margin: 0, paddingLeft: 18 }} aria-label="Your requests">
          {mine.slice(0, 5).map((r) => (
            <li key={r.id}>{r.site_name}: <strong>{STATUS[r.status]}</strong>{r.reason ? ` (${r.reason})` : ''}
              {r.status === 'pending' && <> · <a href="#" onClick={(e) => { e.preventDefault(); void withdrawRequest(r.id).then(load).catch((x) => setErr(msg(x))); }}>withdraw</a></>}</li>
          ))}
        </ul>
      )}
      {sites === null && !err && <p className="muted small">Checking which sites you can ask…</p>}
      {sites && open.length === 0 && waiting.length === 0 && <p className="small muted">No site takes requests from your email address. Ask your site Admin to invite you.</p>}
      {open.length > 0 && (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); void send(); }} aria-label="Request access">
          <strong>Request access</strong>
          <label className="field"><span>Site</span>
            <select value={site} onChange={(e) => setSite(e.target.value)}>{open.map((s) => <option key={s.site_id} value={s.site_id}>{s.site_name}</option>)}</select></label>
          <label className="field"><span>Your name</span><input required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} /></label>
          <label className="field"><span>Note for the Admin (optional)</span><input maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Your job and crew, or your supervisor" /></label>
          <div><button className="btn primary" type="submit" disabled={busy || !name.trim() || !site}>Send request</button></div>
        </form>
      )}
      {waiting.length > 0 && <div><button className="btn" onClick={() => void load()}>Check again</button></div>}
      {err && <p className="errors" role="alert">{err}</p>}
    </div>
  );
}

// ---------- session limit ----------

/** When this device signed in: the time Supabase puts in the token's "amr" list. */
export function signedInAt(accessToken: string | undefined): string | undefined {
  try {
    const p = JSON.parse(atob(accessToken!.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))) as { amr?: Array<{ timestamp?: number }> };
    const t = Math.max(...(p.amr ?? []).map((m) => m.timestamp ?? 0));
    return t > 0 ? new Date(t * 1000).toISOString() : undefined;
  } catch { return undefined; }
}

const KEY = (uid: string) => `mr.active.${uid}`;
const readActive = (uid: string) => { try { return localStorage.getItem(KEY(uid)) ?? undefined; } catch { return undefined; } };
const writeActive = (uid: string, at: string) => { try { localStorage.setItem(KEY(uid), at); } catch { /* storage blocked: the 30-day cap still holds */ } };

/**
 * Signs the person out when the sign-in is too old or the device has not been used for too long.
 * The database also refuses sign-ins older than 30 days.
 */
export function useSessionLimit(uid: string | undefined, signedInAt: string | undefined, s: AccessSettings | undefined, onExpired: (why: SessionCheck) => void) {
  useEffect(() => {
    if (!uid || !s) return;
    const check = () => {
      // A new sign-in counts as use: an old mark from before it must not sign the person straight out.
      const a = readActive(uid);
      const active = a && signedInAt && Date.parse(signedInAt) > Date.parse(a) ? signedInAt : a;
      const r = sessionCheck(signedInAt, active, new Date().toISOString(), s);
      if (r !== 'ok') onExpired(r);
      return r;
    };
    if (check() !== 'ok') return;
    writeActive(uid, new Date().toISOString());
    let last = 0;
    const touch = () => { const t = Date.now(); if (t - last > 60_000) { last = t; writeActive(uid, new Date(t).toISOString()); } };
    const onShow = () => { if (document.visibilityState === 'visible') { if (check() === 'ok') touch(); } };
    const timer = window.setInterval(check, 5 * 60_000);
    window.addEventListener('pointerdown', touch);
    window.addEventListener('keydown', touch);
    document.addEventListener('visibilitychange', onShow);
    return () => { window.clearInterval(timer); window.removeEventListener('pointerdown', touch); window.removeEventListener('keydown', touch); document.removeEventListener('visibilitychange', onShow); };
  }, [uid, signedInAt, s, onExpired]);
}
