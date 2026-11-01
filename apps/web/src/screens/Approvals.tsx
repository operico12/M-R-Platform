// Console, Approvals (plan 11.4): one inbox for governed changes with their
// impact. A superintendent who did not ask approves, rejects with a reason, or
// asks a question; the person who asked answers or withdraws (docs/approvals.md).

import { REQUEST_STATUS_LABELS, addRequestNote, canDecide, waitingOn, withdrawRequest, type ApprovalRequest } from '@mr/core';
import { useState } from 'react';
import { siteTime } from '../format';
import { Errors } from '../improve/ui';
import { useApp } from '../store';

const KIND_LABELS: Record<ApprovalRequest['kind'], string> = { target: 'Target', life_target: 'Target life', role_grant: 'Role', acting_role: 'Acting role' };

export function ApprovalsPage() {
  const app = useApp();
  const tz = app.ds.site.timeZone;
  const mine = waitingOn(app.requests, app.actor.userId, app.actor);
  const mineIds = new Set(mine.map((r) => r.id));
  const others = app.requests.filter((r) => r.status === 'pending' && !mineIds.has(r.id));
  const [flash, setFlash] = useState<string[]>([]);
  const decided = app.requests.filter((r) => r.status !== 'pending').sort((a, b) => (b.decidedAt ?? '').localeCompare(a.decidedAt ?? ''));
  return (
    <>
      <section className="card">
        <h3 style={{ marginTop: 0 }}>Waiting for you ({mine.length})</h3>
        <p className="small muted" style={{ marginTop: 0 }}>KPI targets, target life, Admin and Superintendent roles, and acting roles need a superintendent who did not ask (plan 11.3). Nothing is applied until it is approved.</p>
        {flash.length > 0 && <div role="status" className="small" style={{ marginBottom: 8 }}>{flash.map((x) => <div key={x}>✓ {x}</div>)}</div>}
        {mine.length ? <div style={{ display: 'grid', gap: 12 }}>{mine.map((r) => <RequestCard key={r.id} r={r} onDone={setFlash} />)}</div> : <p className="muted">Nothing waiting for you.</p>}
      </section>
      {others.length > 0 && (
        <section className="card">
          <h3 style={{ marginTop: 0 }}>Waiting for someone else ({others.length})</h3>
          <div style={{ display: 'grid', gap: 12 }}>{others.map((r) => <RequestCard key={r.id} r={r} onDone={setFlash} />)}</div>
        </section>
      )}
      <section className="card">
        <h3 style={{ marginTop: 0 }}>Decided ({decided.length})</h3>
        {decided.length ? (
          <div className="table-wrap"><table>
            <thead><tr><th>Request</th><th>Asked by</th><th>Outcome</th><th>By</th><th>When</th><th>Note</th></tr></thead>
            <tbody>{decided.map((r) => (
              <tr key={r.id}>
                <td><span className="small muted">{KIND_LABELS[r.kind]}</span> {r.title}</td>
                <td>{app.userName(r.requestedBy)}</td>
                <td>{REQUEST_STATUS_LABELS[r.status]}</td>
                <td>{r.decidedBy ? app.userName(r.decidedBy) : ''}</td>
                <td>{r.decidedAt ? siteTime(r.decidedAt, tz, true) : ''}</td>
                <td className="small">{r.decisionNote ?? ''}</td>
              </tr>
            ))}</tbody>
          </table></div>
        ) : <p className="muted">None yet.</p>}
      </section>
    </>
  );
}

function RequestCard({ r, onDone }: { r: ApprovalRequest; onDone: (messages: string[]) => void }) {
  const app = useApp();
  const tz = app.ds.site.timeZone;
  const me = app.actor.userId;
  const approver = canDecide(app.actor, r.kind) && (r.requestedBy !== me || !!app.actor.fullAccess);
  const asker = r.requestedBy === me;
  const [mode, setMode] = useState<'approve' | 'reject' | 'note' | 'withdraw' | null>(null);
  const [text, setText] = useState('');
  const [errors, setErrors] = useState<string[] | null>(null);
  const submit = () => {
    const res = mode === 'approve' || mode === 'reject' ? app.decide(r.id, mode, text)
      : mode === 'note' ? app.runRequest((c) => addRequestNote(c, app.requests, r.id, text))
        : app.runRequest((c) => withdrawRequest(c, app.requests, r.id, text));
    if (!res.ok) { setErrors(res.errors); return; }
    const what = { approve: `Approved: ${r.title}. Applied.`, reject: `Rejected: ${r.title}.`, note: 'Note added.', withdraw: `Withdrawn: ${r.title}.` }[mode!];
    onDone([what, ...res.warnings]);
    setErrors(null); setMode(null); setText('');
  };
  const label = { approve: 'Approve', reject: 'Reject', note: approver ? 'Send question' : 'Send answer', withdraw: 'Withdraw' };
  const prompt = { approve: 'Note (optional)', reject: 'Why it is rejected', note: approver ? 'Your question' : 'Your answer', withdraw: 'Why (optional)' };

  return (
    <article className="card" aria-label={r.title} style={{ background: 'var(--surface)' }}>
      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <span className="small" style={{ padding: '2px 10px', borderRadius: 12, background: 'var(--surface-2)', fontWeight: 600 }}>{KIND_LABELS[r.kind]}</span>
        <span className="small muted">Asked by {app.userName(r.requestedBy)}, {siteTime(r.requestedAt, tz, true)}</span>
      </div>
      <h4 style={{ margin: '8px 0 4px' }}>{r.title}</h4>
      <p style={{ margin: '0 0 6px' }}><strong>Reason:</strong> {r.reason}</p>
      <ul className="small" style={{ margin: '0 0 6px', paddingLeft: 18 }}>{r.impact.map((x) => <li key={x}>{x}</li>)}</ul>
      {r.notes.length > 0 && (
        <div className="small" style={{ borderLeft: '3px solid var(--border)', paddingLeft: 10, margin: '8px 0' }}>
          {r.notes.map((n, i) => <p key={i} style={{ margin: '4px 0' }}><strong>{app.userName(n.by)}</strong> <span className="muted">{siteTime(n.at, tz, true)}</span>: {n.text}</p>)}
        </div>
      )}
      {!approver && !asker && <p className="small muted" style={{ margin: 0 }}>Waiting for a superintendent who did not ask.</p>}
      {asker && !approver && canDecide(app.actor, r.kind) && <p className="small muted" style={{ margin: 0 }}>You asked, so another superintendent decides.</p>}
      {mode === null ? (
        <div className="row" style={{ flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
          {approver && <button className="btn primary" onClick={() => setMode('approve')}>Approve</button>}
          {approver && <button className="btn" onClick={() => setMode('reject')}>Reject</button>}
          {(approver || asker) && <button className="btn" onClick={() => setMode('note')}>{approver ? 'Ask a question' : 'Answer'}</button>}
          {asker && <button className="btn" onClick={() => setMode('withdraw')}>Withdraw</button>}
        </div>
      ) : (
        <div style={{ marginTop: 8 }}>
          <label className="field"><span>{prompt[mode]}</span><input autoFocus value={text} onChange={(e) => setText(e.target.value)} /></label>
          <div className="row" style={{ gap: 8 }}>
            <button className={`btn ${mode === 'reject' || mode === 'withdraw' ? 'danger' : 'primary'}`} onClick={submit}>{label[mode]}</button>
            <button className="btn" onClick={() => { setMode(null); setErrors(null); }}>Cancel</button>
          </div>
        </div>
      )}
      <Errors list={errors} />
    </article>
  );
}
