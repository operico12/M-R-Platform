// Console, Audit log (plan 11.4): every change with who, when, before, after
// and reason; filter and export. Read-only, for the superintendent and the
// admin. In the demo it shows the changes made in this browser session.

import {
  EMPTY_AUDIT_FILTER, auditCsv, auditRange, siteToday, auditDiff, auditEntityLabel, auditValue, can, filterAudit, isRowChange,
  type AuditFilter, type AuditRecord,
} from '@mr/core';
import { Fragment, useEffect, useMemo, useState } from 'react';
import { loadAudit } from '../data/remote';
import { siteTime } from '../format';
import { useApp } from '../store';

const SHOW = 300;

export function AuditLogPage() {
  const app = useApp();
  const tz = app.ds.site.timeZone;
  const today = siteToday(app.now, tz);
  const [f, setF] = useState<AuditFilter>({ ...EMPTY_AUDIT_FILTER, from: siteToday(app.now, tz, -6), to: today });
  const [loaded, setLoaded] = useState<AuditRecord[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [reload, setReload] = useState(0);
  const allowed = can(app.actor, 'view_audit_log');

  // Live: fetch the date range from the database. Demo: this session's entries.
  useEffect(() => {
    if (app.mode !== 'live' || !allowed || !f.from || !f.to) return;
    const { from, to } = auditRange(f.from, f.to, tz);
    setLoading(true);
    loadAudit(app.ds.site.id, from, to)
      .then((r) => { setLoaded(r); setError(null); })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [app.mode, allowed, f.from, f.to, reload]);

  const source: AuditRecord[] = app.mode === 'live' ? loaded ?? [] : app.audit;
  const rows = useMemo(() => filterAudit(source, f, tz), [source, f, tz]);
  const people = useMemo(() => [...new Set(source.map((r) => r.userId))].map((id) => [id, app.userName(id)] as const).sort((a, b) => a[1].localeCompare(b[1])), [source]);
  const types = useMemo(() => [...new Set([...source.map((r) => auditEntityLabel(r.entity))])].sort(), [source]);

  if (!allowed) return <section className="card"><p className="muted">The full audit log is for the superintendent and the admin (plan 11.4). Each record's own history shows on its page.</p></section>;

  const exportCsv = () => {
    const url = URL.createObjectURL(new Blob([auditCsv(rows, tz, app.userName)], { type: 'text/csv' }));
    const el = document.createElement('a');
    el.href = url;
    el.download = `audit-log-${f.from ?? 'all'}-to-${f.to ?? today}.csv`;
    el.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="card">
      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <h3 style={{ margin: 0 }}>Audit log</h3>
        <div className="row" style={{ gap: 8 }}>
          {app.mode === 'live' && <button className="btn" onClick={() => setReload(reload + 1)} disabled={loading}>{loading ? 'Loading…' : 'Reload'}</button>}
          {can(app.actor, 'export_reports') && <button className="btn" onClick={exportCsv} disabled={!rows.length}>Export to CSV</button>}
        </div>
      </div>
      <p className="small muted">
        Read-only. Times are site time ({tz}). Nothing is ever deleted; a change is undone by a new change.
        {app.mode === 'demo' ? ' The demo shows the changes made in this browser session.' : ' Each change appears twice: what the person did in the app, with the reason, and the database row before and after.'}
      </p>

      <div className="row" style={{ flexWrap: 'wrap', gap: 12, alignItems: 'end' }}>
        <label className="small" style={{ display: 'grid', gap: 2 }}>From<input type="date" value={f.from ?? ''} max={f.to} onChange={(e) => setF({ ...f, from: e.target.value || undefined })} /></label>
        <label className="small" style={{ display: 'grid', gap: 2 }}>To<input type="date" value={f.to ?? ''} min={f.from} onChange={(e) => setF({ ...f, to: e.target.value || undefined })} /></label>
        <label className="small" style={{ display: 'grid', gap: 2 }}>Record
          <select value={f.entities[0] ?? ''} onChange={(e) => setF({ ...f, entities: e.target.value ? [e.target.value] : [] })}>
            <option value="">All records</option>
            {types.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <label className="small" style={{ display: 'grid', gap: 2 }}>Person
          <select value={f.users[0] ?? ''} onChange={(e) => setF({ ...f, users: e.target.value ? [e.target.value] : [] })}>
            <option value="">Everyone</option>
            {people.map(([id, n]) => <option key={id} value={id}>{n}</option>)}
          </select>
        </label>
        <label className="small" style={{ display: 'grid', gap: 2, flex: '1 1 180px' }}>Search<input value={f.text} placeholder="Action, reason, value or id" onChange={(e) => setF({ ...f, text: e.target.value })} /></label>
        {app.mode === 'live' && <label className="small row" style={{ gap: 6 }}><input type="checkbox" checked={f.appOnly} onChange={(e) => setF({ ...f, appOnly: e.target.checked })} />App entries only</label>}
      </div>

      {error && <div className="errors" role="alert">Could not load the audit log: {error}</div>}
      <p className="small muted">{rows.length} {rows.length === 1 ? 'change' : 'changes'}{rows.length > SHOW ? `, showing the newest ${SHOW}. Narrow the filters or export to see them all.` : ''}</p>

      {rows.length ? (
        <div className="table-wrap" style={{ maxHeight: 640 }}>
          <table>
            <thead><tr><th>Entered</th><th>Who</th><th>Record</th><th>Action</th><th>Reason</th><th>Changes</th></tr></thead>
            <tbody>{rows.slice(0, SHOW).map((r, i) => {
              const diff = auditDiff(r.before, r.after);
              return (
                <Fragment key={r.id ?? `${r.at}-${i}`}>
                  <tr>
                    <td style={{ whiteSpace: 'nowrap' }}>{siteTime(r.at, tz, true)}{r.effectiveAt ? <div className="small"><strong>Back-dated to {siteTime(r.effectiveAt, tz, true)}</strong></div> : null}</td>
                    <td>{app.userName(r.userId)}</td>
                    <td>{auditEntityLabel(r.entity)}{isRowChange(r) ? <span className="small muted"> (row)</span> : null}<div className="small muted">{String(r.entityId ?? '').slice(0, 8)}</div></td>
                    <td>{r.action.replace(/_/g, ' ')}</td>
                    <td className="small">{r.reason ?? ''}</td>
                    <td><button className="linklike" aria-expanded={open === i} onClick={() => setOpen(open === i ? null : i)}>{diff.length} {diff.length === 1 ? 'field' : 'fields'}</button></td>
                  </tr>
                  {open === i && (
                    <tr><td colSpan={6} style={{ background: 'var(--surface-2)' }}>
                      {diff.length ? (
                        <table className="small" style={{ margin: 0 }}>
                          <thead><tr><th>Field</th><th>Before</th><th>After</th></tr></thead>
                          <tbody>{diff.map((c) => (
                            <tr key={c.field}><td>{c.field}</td><td style={{ wordBreak: 'break-word', maxWidth: 360 }}>{auditValue(c.before) || '—'}</td><td style={{ wordBreak: 'break-word', maxWidth: 360 }}>{auditValue(c.after) || '—'}</td></tr>
                          ))}</tbody>
                        </table>
                      ) : <span className="small muted">No field changed.</span>}
                    </td></tr>
                  )}
                </Fragment>
              );
            })}</tbody>
          </table>
        </div>
      ) : <p className="muted">{loading ? 'Loading…' : app.mode === 'demo' ? 'No changes in this session yet. Flag a unit down, answer an alert or change a setting, then come back.' : 'No changes match.'}</p>}
    </section>
  );
}
