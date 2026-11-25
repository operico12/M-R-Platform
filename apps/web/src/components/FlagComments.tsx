// Comments on a down flag and its wait tags (docs/flag-comments.md): read the thread, add to it,
// and void a wrong comment with a reason. Open and released flags take comments; nothing is
// ever edited or deleted, so the thread can be reviewed later.

import { addComment, can, canVoidComment, commentsOf, voidComment, type Asset, type CommentResult, type DownFlag } from '@mr/core';
import { useState } from 'react';
import { siteTime } from '../format';
import { useApp } from '../store';

export function CommentThread({ asset, flag }: { asset: Asset; flag: DownFlag }) {
  const app = useApp();
  const tz = app.ds.site.timeZone;
  const thread = commentsOf(flag.id, app.comments);
  const waits = app.waits.filter((w) => w.downFlagId === flag.id && w.state !== 'voided');
  const waitLabel = (kind: string) => app.waitKinds.find((k) => k.code === kind)?.label ?? kind;
  const canAdd = can(app.actor, 'add_notes', asset.fleet) && (flag.state === 'open' || flag.state === 'released');
  const [text, setText] = useState('');
  const [re, setRe] = useState('');
  const [voiding, setVoiding] = useState<string | null>(null);
  const [why, setWhy] = useState('');
  const [r, setR] = useState<CommentResult | null>(null);
  const go = (x: CommentResult) => { setR(x); if (x.ok) { setText(''); setRe(''); setVoiding(null); setWhy(''); } };

  return (
    <div className="fc" aria-label="Comments">
      {thread.length === 0 ? <p className="small muted" style={{ margin: '4px 0' }}>No comments yet.</p> : (
        <ul className="fc-list">
          {thread.map((c) => {
            const w = c.waitTagId ? app.waits.find((x) => x.id === c.waitTagId) : undefined;
            return (
              <li key={c.id} className={c.state === 'voided' ? 'fc-voided' : undefined}>
                <div className="fc-meta small muted">
                  <strong>{app.userName(c.setBy)}</strong> · {siteTime(c.enteredAt, tz, true)}
                  {w && <span className="fc-re"> · re: {waitLabel(w.kind)}</span>}
                </div>
                <div className="fc-text">{c.text}</div>
                {c.state === 'voided' && <div className="small muted">Voided by {c.voidedBy ? app.userName(c.voidedBy) : 'someone'}{c.voidedAt ? ` · ${siteTime(c.voidedAt, tz, true)}` : ''}: {c.voidReason}</div>}
                {canVoidComment(app.actor, c, asset.fleet) && (
                  voiding === c.id ? (
                    <span className="row" style={{ gap: 6, marginTop: 4 }}>
                      <input value={why} onChange={(e) => setWhy(e.target.value)} maxLength={300} placeholder="Why it is being voided" aria-label="Why it is being voided" />
                      <button type="button" className="btn danger" onClick={() => go(app.runComments(asset, (ctx) => voidComment(ctx, c.id, why)))}>Void</button>
                    </span>
                  ) : <button type="button" className="linkish small" onClick={() => setVoiding(c.id)}>Void</button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {canAdd ? (
        <div className="fc-add">
          <label className="field"><span>Add a comment</span>
            <textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={1000} rows={2} placeholder="What happened, what is needed, who is chasing…" />
          </label>
          <div className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
            {waits.length > 0 && (
              <label className="field"><span>About</span>
                <select value={re} onChange={(e) => setRe(e.target.value)}>
                  <option value="">The flag</option>
                  {waits.map((x) => <option key={x.id} value={x.id}>{waitLabel(x.kind)}{x.state === 'open' ? '' : ' (ended)'}</option>)}
                </select>
              </label>
            )}
            <button type="button" className="btn primary" disabled={!text.trim()}
              onClick={() => go(app.runComments(asset, (ctx) => addComment(ctx, { downFlagId: flag.id, ...(re ? { waitTagId: re } : {}), text })))}>Add comment</button>
          </div>
        </div>
      ) : <p className="small muted">{flag.state === 'open' || flag.state === 'released' ? 'Technicians, supervisors and engineers can comment.' : 'This flag takes no comments.'}</p>}
      {r && !r.ok && <div className="errors" role="alert">{r.errors.map((e) => <div key={e}>{e}</div>)}</div>}
    </div>
  );
}
