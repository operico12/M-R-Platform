// A down flag's detail in the Down flags table (docs/flag-history.md, docs/flag-comments.md):
// Comments, Time (where the time went, stage by stage, line by line, wait by wait) and
// Changes (every recorded edit with who, when and why). Read-only apart from comments.

import { flagAuditRange, flagBreakdown, flagChanges, type Asset, type AuditRecord, type DownFlag } from '@mr/core';
import { useEffect, useMemo, useState } from 'react';
import { loadAudit } from '../data/remote';
import { fmtHours, siteTime } from '../format';
import { useApp } from '../store';
import { CommentThread } from './FlagComments';

type Tab = 'comments' | 'time' | 'changes';

export function FlagDetail({ asset, flag, commentCount }: { asset: Asset; flag: DownFlag; commentCount: number }) {
  const [tab, setTab] = useState<Tab>('comments');
  const tabs: Array<[Tab, string]> = [['comments', `Comments (${commentCount})`], ['time', 'Time'], ['changes', 'Changes']];
  return (
    <div>
      <div className="row" role="tablist" aria-label="Flag detail" style={{ gap: 6, marginBottom: 8 }}>
        {tabs.map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={`btn${tab === k ? ' primary' : ''}`} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>
      {tab === 'comments' && <CommentThread asset={asset} flag={flag} />}
      {tab === 'time' && <TimeBreakdown flag={flag} />}
      {tab === 'changes' && <ChangeLog flag={flag} />}
    </div>
  );
}

function TimeBreakdown({ flag }: { flag: DownFlag }) {
  const app = useApp();
  const tz = app.ds.site.timeZone;
  const b = useMemo(() => flagBreakdown(flag, app.waits, app.ds.shopLines, app.now), [flag, app.waits, app.ds.shopLines, app.now]);
  const waitLabel = (k: string) => app.waitKinds.find((x) => x.code === k)?.label ?? k;
  const pct = (h: number) => (b.downHours > 0 ? `${Math.round((h / b.downHours) * 100)}%` : '');
  const rows = (items: Array<{ label: string; hours: number }>) => items.map((x) => (
    <tr key={x.label}><td>{x.label}</td><td className="num">{fmtHours(x.hours)}</td><td className="num muted">{pct(x.hours)}</td></tr>
  ));
  return (
    <div className="stack">
      <div className="sl-summary">
        <span className="sl-stat"><strong>{fmtHours(b.downHours)}</strong> down</span>
        <span className="sl-stat"><strong>{fmtHours(b.inRepairHours)}</strong> in repair</span>
        <span className="sl-stat"><strong>{fmtHours(b.notInRepairHours)}</strong> not in repair</span>
        <span className="sl-stat"><strong>{b.firstWrenchHours === null ? '—' : fmtHours(b.firstWrenchHours)}</strong> to first wrench</span>
        <span className="sl-stat"><strong>{fmtHours(b.waitingOnSomethingHours)}</strong> waiting on something</span>
      </div>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12 }}>
        <table><caption className="small muted" style={{ textAlign: 'left' }}>By stage</caption><tbody>{rows(b.byStage)}</tbody></table>
        <table><caption className="small muted" style={{ textAlign: 'left' }}>By location</caption><tbody>{rows(b.byLocationKind)}</tbody></table>
        {b.byLine.length > 0 && <table><caption className="small muted" style={{ textAlign: 'left' }}>By shop line</caption><tbody>{rows(b.byLine)}</tbody></table>}
        {b.byWait.length > 0 && <table><caption className="small muted" style={{ textAlign: 'left' }}>Waits (can overlap)</caption><tbody>{rows(b.byWait.map((x) => ({ label: waitLabel(x.kind), hours: x.hours })))}</tbody></table>}
      </div>
      <table>
        <caption className="small muted" style={{ textAlign: 'left' }}>Moves, in order</caption>
        <thead><tr><th>Where</th><th>From</th><th>To</th><th className="num">Time</th><th>Moved by</th></tr></thead>
        <tbody>{b.moves.map((m, i) => (
          <tr key={i}><td>{m.label}</td><td>{siteTime(m.start, tz, true)}</td><td>{m.end ? siteTime(m.end, tz, true) : 'now'}</td><td className="num">{fmtHours(m.hours)}</td><td>{app.userName(m.by)}</td></tr>
        ))}</tbody>
      </table>
      <table>
        <caption className="small muted" style={{ textAlign: 'left' }}>Stages, in order</caption>
        <thead><tr><th>Stage</th><th>From</th><th>To</th><th className="num">Time</th><th>Set by</th></tr></thead>
        <tbody>{b.stages.map((m, i) => (
          <tr key={i}><td>{m.label}</td><td>{siteTime(m.start, tz, true)}</td><td>{m.end ? siteTime(m.end, tz, true) : 'now'}</td><td className="num">{fmtHours(m.hours)}</td><td>{app.userName(m.by)}</td></tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function ChangeLog({ flag }: { flag: DownFlag }) {
  const app = useApp();
  const tz = app.ds.site.timeZone;
  const [loaded, setLoaded] = useState<AuditRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Live: the flag's audit entries come from the database for its dates. Demo: this session's changes.
  useEffect(() => {
    if (app.mode !== 'live') return;
    const { from, to } = flagAuditRange(flag, app.now);
    loadAudit(app.ds.site.id, from, to).then((r) => { setLoaded(r); setError(null); }).catch((e: Error) => setError(e.message));
  }, [app.mode, flag.id, flag.state, app.ds.site.id]);

  const source: AuditRecord[] = app.mode === 'live' ? loaded ?? [] : app.audit;
  const changes = useMemo(() => flagChanges(source, flag.id), [source, flag.id]);
  if (error) return <p className="small" role="alert">Could not load the history: {error}</p>;
  if (app.mode === 'live' && !loaded) return <p className="small muted">Loading…</p>;
  if (changes.length === 0) return <p className="small muted">{app.mode === 'live' ? 'No recorded changes.' : 'No changes recorded in this session. The demo fleet starts with no history; live, every change is kept.'}</p>;
  return (
    <ul className="fc-list">
      {changes.map((c, i) => (
        <li key={i}>
          <div className="small muted"><strong>{app.userName(c.userId)}</strong> · {siteTime(c.at, tz, true)}{c.effectiveAt ? ` (for ${siteTime(c.effectiveAt, tz, true)})` : ''} · {c.action.replace(/_/g, ' ')}</div>
          <div><strong>{c.label}</strong>: {c.before ? <span className="muted" style={{ textDecoration: 'line-through' }}>{c.before}</span> : <span className="muted">(none)</span>} → {c.after || <span className="muted">(none)</span>}</div>
          {c.reason && <div className="small muted">Why: {c.reason}</div>}
        </li>
      ))}
    </ul>
  );
}
