// Console, Access (docs/access.md): who may ask for an account, the requests
// waiting, the session limits and two-step sign-in for Admins. Every change
// runs a core command.

import { ACCESS_LIMITS, REQUESTABLE_ROLES, ROLE_LABELS, can, setAccessSettings, type AccessRequest, type Role } from '@mr/core';
import { useEffect, useState } from 'react';
import { siteTime } from '../format';
import { Errors } from '../improve/ui';
import { useApp } from '../store';
import { mfaState } from './Account';

export function AccessPage() {
  const app = useApp();
  if (!can(app.actor, 'manage_access')) return <p className="locked small">🔒 The site's Admin answers account requests and sets the sign-in rules.</p>;
  return (
    <div className="stack">
      <Requests />
      <Rules />
    </div>
  );
}

function Requests() {
  const app = useApp();
  const [err, setErr] = useState<string[] | null>(null);
  useEffect(() => { app.loadAccessRequests().catch((e) => setErr([e instanceof Error ? e.message : String(e)])); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [app.ds.site.id]);
  const list = app.accessRequests;
  const waiting = (list ?? []).filter((r) => r.status === 'pending');
  const done = (list ?? []).filter((r) => r.status !== 'pending').slice(0, 20);
  const tz = app.ds.site.timeZone;
  return (
    <section className="card stack" aria-label="Account requests">
      <h3 style={{ margin: 0 }}>Account requests</h3>
      <p className="small muted" style={{ margin: 0 }}>People whose email domain is listed below can ask for an account after signing in with an email link. Approve them with a role, or decline with a reason they will see.</p>
      <Errors list={err} />
      {list === null && !err && <p className="muted">Loading…</p>}
      {list && waiting.length === 0 && <p className="muted small">No requests waiting.</p>}
      {waiting.map((r) => <RequestRow key={r.id} r={r} />)}
      {done.length > 0 && (
        <details className="small"><summary>Answered ({done.length})</summary>
          <ul style={{ paddingLeft: 18 }}>{done.map((r) => <li key={r.id}>{r.name} ({r.email}): {r.status}{r.role ? ` as ${ROLE_LABELS[r.role]}` : ''}{r.reason ? `, ${r.reason}` : ''}{r.decidedAt ? `, ${siteTime(r.decidedAt, tz, true)}` : ''}</li>)}</ul>
        </details>
      )}
    </section>
  );
}

function RequestRow({ r }: { r: AccessRequest }) {
  const app = useApp();
  const [role, setRole] = useState<Role>('viewer');
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const answer = async (approve: boolean) => {
    setBusy(true);
    const x = await app.decideAccess(r.id, approve, approve ? role : undefined, reason);
    setBusy(false);
    setErr(x.ok ? null : x.errors);
  };
  return (
    <div className="card stack" style={{ padding: 12 }} aria-label={`Request from ${r.name}`}>
      <div><strong>{r.name}</strong> <span className="small muted">{r.email} · asked {siteTime(r.createdAt, app.ds.site.timeZone, true)}</span></div>
      {r.note && <div className="small">“{r.note}”</div>}
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label className="field" style={{ minWidth: 180 }}><span>Role</span>
          <select value={role} onChange={(e) => setRole(e.target.value as Role)}>{REQUESTABLE_ROLES.map((x) => <option key={x} value={x}>{ROLE_LABELS[x]}</option>)}</select></label>
        <button className="btn primary" disabled={busy} onClick={() => void answer(true)}>Approve</button>
        <label className="field" style={{ flex: '1 1 200px' }}><span>Reason (needed to decline)</span><input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
        <button className="btn danger" disabled={busy || !reason.trim()} onClick={() => void answer(false)}>Decline</button>
      </div>
      <Errors list={err} />
    </div>
  );
}

function Rules() {
  const app = useApp();
  const cur = app.accessSettings;
  const [domains, setDomains] = useState(cur.requestDomains.join(', '));
  const [sessionDays, setSessionDays] = useState(cur.sessionDays);
  const [idleDays, setIdleDays] = useState(cur.idleDays);
  const [adminMfa, setAdminMfa] = useState(cur.adminMfa);
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState<string[] | null>(null);
  const [passed, setPassed] = useState(app.mode === 'demo');
  useEffect(() => { if (app.mode === 'live') mfaState().then((m) => setPassed(m.current === 'aal2')).catch(() => setPassed(false)); }, [app.mode]);
  const save = () => {
    const next = { requestDomains: domains.split(/[\s,;]+/), sessionDays, idleDays, adminMfa };
    const r = app.runAccessSettings((ctx, c) => setAccessSettings(ctx, c, next, reason, passed));
    setMsg(r.ok ? ['Saved.'] : r.errors);
    if (r.ok) { setReason(''); setDomains(r.records[0]!.requestDomains.join(', ')); }
  };
  return (
    <section className="card stack" aria-label="Sign-in rules">
      <h3 style={{ margin: 0 }}>Sign-in rules</h3>
      <label className="field"><span>Email domains that may ask for an account (the part after the @, comma between)</span>
        <input value={domains} onChange={(e) => setDomains(e.target.value)} placeholder="example-mining.com" /></label>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <label className="field" style={{ flex: '1 1 160px' }}><span>Sign in again after (days)</span>
          <input type="number" min={1} max={ACCESS_LIMITS.maxSessionDays} value={sessionDays} onChange={(e) => setSessionDays(Number(e.target.value))} /></label>
        <label className="field" style={{ flex: '1 1 160px' }}><span>Sign out after no use for (days)</span>
          <input type="number" min={1} max={ACCESS_LIMITS.maxIdleDays} value={idleDays} onChange={(e) => setIdleDays(Number(e.target.value))} /></label>
      </div>
      <label className="row small" style={{ gap: 6 }}>
        <input type="checkbox" checked={adminMfa} onChange={(e) => setAdminMfa(e.target.checked)} />
        Admins must use two-step sign-in. Until they pass the code check, they act as Viewers.
      </label>
      {adminMfa && !cur.adminMfa && !passed && <p className="small">First turn on two-step sign-in for yourself on the <a href="#/account">Account</a> page and pass the code check, so you are not locked out.</p>}
      <label className="field"><span>Reason for the change</span><input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
      <div><button className="btn primary" onClick={save}>Save</button></div>
      {msg && <div className={msg[0] === 'Saved.' ? 'small' : 'errors'} role="status">{msg.map((x) => <div key={x}>{x}</div>)}</div>}
      <p className="small muted" style={{ margin: 0 }}>The database also refuses any sign-in older than 30 days. Superintendent and Admin roles are never given by a request; use a role change with approval.</p>
    </section>
  );
}
