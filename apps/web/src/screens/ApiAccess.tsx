// API access (docs/public-api.md): read-only keys for other systems. The site's
// Admin makes a key (shown once), sees when each key was last used, and revokes
// keys with a reason. Every change runs a core command.

import { API_LIMITS, API_SCOPES, apiKeyStatus, can, type ApiKeyRecord, type ApiScope } from '@mr/core';
import { useEffect, useState } from 'react';
import { apiEndpoint } from '../data/remote';
import { siteTime } from '../format';
import { Errors } from '../improve/ui';
import { useApp } from '../store';

/** A date with the year, in site time (rule 7): keys last up to two years. */
const siteDay = (iso: string, tz: string) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));

const STATUS: Record<ReturnType<typeof apiKeyStatus>, string> = { active: 'Active', expired: 'Expired', revoked: 'Revoked' };

export function ApiAccess() {
  const app = useApp();
  const allowed = can(app.actor, 'manage_api_keys');
  const [loadErr, setLoadErr] = useState<string | null>(null);
  useEffect(() => {
    if (!allowed) return;
    app.loadApiKeys().catch((e) => setLoadErr(e instanceof Error ? e.message : String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowed, app.ds.site.id]);
  return (
    <div className="stack">
      <div className="page-head">
        <h2>API access</h2>
        <span className="muted small">Read-only keys for other systems at the company, such as a dashboard or the data warehouse. A key reads one site: {app.ds.site.name}.</span>
      </div>
      {!allowed ? (
        <p className="locked small">🔒 The site's Admin makes and revokes API keys.</p>
      ) : (
        <>
          <NewKey />
          <section className="card stack" aria-label="Keys">
            <h3 style={{ margin: 0 }}>Keys</h3>
            {loadErr && <p className="errors" role="alert">Could not load the keys: {loadErr}</p>}
            {app.apiKeys === null && !loadErr && <p className="muted">Loading…</p>}
            {app.apiKeys?.length === 0 && <p className="muted small">No keys yet.</p>}
            {!!app.apiKeys?.length && <KeyTable keys={app.apiKeys} />}
          </section>
        </>
      )}
      <HowTo />
    </div>
  );
}

function NewKey() {
  const app = useApp();
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<ApiScope[]>(['units']);
  const [days, setDays] = useState<number>(API_LIMITS.defaultDays);
  const [err, setErr] = useState<string[] | null>(null);
  const [shown, setShown] = useState<{ name: string; key: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const toggle = (s: ApiScope) => setScopes((x) => (x.includes(s) ? x.filter((y) => y !== s) : [...x, s]));
  const make = async () => {
    setBusy(true);
    const r = await app.createApiKey({ name, scopes, days });
    setBusy(false);
    if (!r.ok) return setErr(r.errors);
    setErr(null);
    setCopied(false);
    setShown({ name: name.trim(), key: r.key });
    setName('');
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(shown!.key); setCopied(true); } catch { setCopied(false); }
  };
  return (
    <section className="card stack" aria-label="Make a key">
      <h3 style={{ margin: 0 }}>Make a key</h3>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label className="field" style={{ flex: '2 1 220px' }}><span>System that uses it</span><input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="e.g. Shift dashboard" /></label>
        <label className="field" style={{ flex: '0 1 140px' }}><span>Expires after (days)</span>
          <input type="number" min={1} max={API_LIMITS.maxDays} value={days} onChange={(e) => setDays(Number(e.target.value))} /></label>
      </div>
      <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0, gap: 4 }}>
        <legend className="small muted">It can read</legend>
        {(Object.keys(API_SCOPES) as ApiScope[]).map((s) => (
          <label key={s} className="row small" style={{ gap: 6 }}>
            <input type="checkbox" checked={scopes.includes(s)} onChange={() => toggle(s)} /> <code>{s}</code> {API_SCOPES[s]}
          </label>
        ))}
      </fieldset>
      <div><button className="btn primary" disabled={busy || !name.trim() || !scopes.length} onClick={() => void make()}>Make key</button></div>
      <Errors list={err} />
      {shown && (
        <div className="card stack" role="status" style={{ borderColor: 'var(--warn, #b7791f)' }}>
          <strong>Key for {shown.name}. Copy it now: it is not shown again.</strong>
          <code style={{ wordBreak: 'break-all' }} aria-label="New API key">{shown.key}</code>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button className="btn" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy key'}</button>
            <button className="btn" onClick={() => setShown(null)}>I have stored it</button>
          </div>
          <span className="small muted">Store it in the other system's secret store. Do not email it, paste it in chat or put it in a code repository. If it is lost or leaked, revoke it and make a new one.</span>
        </div>
      )}
    </section>
  );
}

function KeyTable({ keys }: { keys: ApiKeyRecord[] }) {
  const app = useApp();
  const tz = app.ds.site.timeZone;
  const [err, setErr] = useState<string[] | null>(null);
  const revoke = async (k: ApiKeyRecord) => {
    const why = window.prompt(`Reason for revoking the key for ${k.name}. Calls with it are refused from now on.`) ?? '';
    if (!why.trim()) return;
    const r = await app.revokeApiKey(k.id, why);
    setErr(r.ok ? null : r.errors);
  };
  return (
    <>
      <div className="table-wrap">
        <table>
          <thead><tr><th>System</th><th>Key starts</th><th>Reads</th><th>Status</th><th>Expires</th><th>Last call</th><th>Calls, 24 h</th><th /></tr></thead>
          <tbody>
            {keys.map((k) => {
              const st = apiKeyStatus(k, app.now);
              return (
                <tr key={k.id}>
                  <td><strong>{k.name}</strong><div className="small muted">made {siteDay(k.createdAt, tz)} by {app.userName(k.createdBy)}</div></td>
                  <td><code>{k.prefix}…</code></td>
                  <td className="small">{k.scopes.join(', ')}</td>
                  <td>{STATUS[st]}{k.revokeReason && <div className="small muted">{siteTime(k.revokedAt!, tz, true)}: {k.revokeReason}</div>}</td>
                  <td className="small">{siteDay(k.expiresAt, tz)}</td>
                  <td className="small">{k.lastUsedAt ? siteTime(k.lastUsedAt, tz, true) : app.mode === 'demo' ? 'not in the demo' : 'never'}</td>
                  <td>{k.calls24h ?? 0}</td>
                  <td>{st !== 'revoked' && <button className="btn danger" onClick={() => void revoke(k)}>Revoke</button>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <Errors list={err} />
      <p className="small muted" style={{ margin: 0 }}>Keys are never deleted. Revoked and expired keys stay listed. To rotate, make a new key, move the system to it, then revoke the old one.</p>
    </>
  );
}

function HowTo() {
  const app = useApp();
  const example = `curl -s ${apiEndpoint} \\
  -H "apikey: <the project's public anon key>" \\
  -H "x-mr-api-key: mrk_..." \\
  -H "content-type: application/json" \\
  -d '{"resource": "units"}'`;
  return (
    <section className="card stack" aria-label="How to call it">
      <h3 style={{ margin: 0 }}>How another system calls it</h3>
      <pre className="small" style={{ overflowX: 'auto', margin: 0, whiteSpace: 'pre' }}>{example}</pre>
      <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
        <li><code>units</code>: no params. <code>flags</code> and <code>smu</code>: <code>{'{"from": "…Z", "to": "…Z"}'}</code>, at most {API_LIMITS.windowDays} days. <code>work_orders</code>: <code>{'{"changed_since": "…Z"}'}</code>, then the <code>cursor</code> each page returns.</li>
        <li>Times are UTC. The answer gives the site time zone ({app.ds.site.timeZone}).</li>
        <li>At most {API_LIMITS.callsPerMinute} calls a minute per key. Read only: nothing can be changed through the API. Costs are not returned.</li>
        {app.mode === 'demo' && <li>This is the demo: keys made here only live in this browser tab and cannot call anything.</li>}
      </ul>
    </section>
  );
}
