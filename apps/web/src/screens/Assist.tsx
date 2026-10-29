// Assist (phase 3, plan 9; docs/ai-assist.md): how well code suggestions do on
// this site's own held-back flags, flags whose coding needs a look with the
// suggested codes, possible duplicate work orders, and the settings. Nothing here
// changes a record: suggestions are used on the release form, duplicates are
// checked in Maximo.

import {
  CODE_FIELDS, CODE_FIELD_LABELS, CODING_CHECK_LABELS, STARTER_CODES, can, codedRows, codingIssues, duplicateWorkOrders, flagText, holdoutCheck, liveSuggestion,
  passes, setAssistSettings, suggestCodes, workOrderIndex, type AssistSettings, type FieldScore,
  askContext, recentWeeks, weeklyPack,
} from '@mr/core';
import dictionary from '../../../../docs/kpi-dictionary.md?raw';
import { askAssist, type AskReply } from '../data/remote';
import { useMemo, useState } from 'react';
import { siteTime } from '../format';
import { useApp } from '../store';

type Tab = 'ask' | 'check' | 'review' | 'duplicates' | 'settings';
const TABS: Array<[Tab, string]> = [['ask', 'Ask'], ['check', 'Code suggestions'], ['review', 'Coding review'], ['duplicates', 'Duplicate work orders'], ['settings', 'Settings']];

const pct = (x: number | null) => (x === null ? '—' : `${(x * 100).toFixed(1)}%`);

export function Assist({ query }: { query: string }) {
  const app = useApp();
  const q = new URLSearchParams(query);
  const tab = (TABS.find(([k]) => k === q.get('tab'))?.[0] ?? (app.mode === 'live' ? 'ask' : 'check')) as Tab;
  const { check, live } = app.suggester;
  const dups = useMemo(() => duplicateWorkOrders(app.ds.workOrders, app.assistSettings), [app.ds.workOrders, app.assistSettings]);
  return (
    <div className="stack">
      <div className="page-head">
        <h2>Assist</h2>
        <span className="muted small">Suggestions learned from this site's own records. A person decides every change; nothing is sent outside the platform.</span>
      </div>
      <div className="grid kpis">
        <Tile label="Code suggestions" value={live.length ? 'On' : 'Off'} note={live.length ? `For ${live.map((f) => CODE_FIELD_LABELS[f].toLowerCase()).join(', ')}` : app.assistSettings.suggestCodes ? 'Switched on, but no code passes the check now' : 'Switched off'} />
        <Tile label="Held-back score, system" value={pct(check.system.score)} note={`On the latest ${check.held} of ${check.trainedOn + check.held} clean flags`} />
        <Tile label="Possible duplicate work orders" value={String(dups.length)} note={dups.length ? `${dups.reduce((a, g) => a + g.workOrders.length, 0)} open work orders to check` : 'None found'} />
      </div>
      <div className="chips" role="tablist">
        {TABS.map(([k, l]) => <a key={k} role="tab" className="chip" aria-pressed={tab === k} aria-selected={tab === k} href={`#/assist?tab=${k}`} style={{ minHeight: 40, display: 'inline-flex', alignItems: 'center', textDecoration: 'none' }}>{l}</a>)}
      </div>
      {tab === 'ask' && <AskTab />}
      {tab === 'check' && <CheckTab />}
      {tab === 'review' && <ReviewTab />}
      {tab === 'duplicates' && <DuplicatesTab />}
      {tab === 'settings' && <SettingsTab />}
    </div>
  );
}

function Tile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="card">
      <div className="small muted">{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700 }}>{value}</div>
      {note && <div className="small muted">{note}</div>}
    </div>
  );
}

function CheckTab() {
  const app = useApp();
  const s = app.assistSettings;
  const { check, live } = app.suggester;
  const tz = app.ds.site.timeZone;
  const verdict = (f: FieldScore) => (passes(f, s) ? 'Passes' : f.held < s.minHoldout ? `Too few held back (${s.minHoldout} needed)` : `Below ${pct(s.minScore)}`);
  return (
    <section className="card">
      <h3>How well it suggests, on flags it did not learn from</h3>
      <p className="small muted">
        It learns from released failures with clean system, component and failure mode, and is tested on the latest {pct(s.holdoutShare)} of them
        {check.heldFrom ? ` (released from ${siteTime(check.heldFrom, tz, true)})` : ''}. A code is suggested only when its score is {pct(s.minScore)} or more and suggestions are switched on.
        Below {pct(s.minConfidence)} chance it gives no suggestion; that counts as a miss.
      </p>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Code</th><th>Held back</th><th>Answered</th><th>Right</th><th>Precision</th><th>Recall</th><th>Score (F1)</th><th>Check</th><th>Shown</th></tr></thead>
          <tbody>
            {CODE_FIELDS.map((f) => (
              <tr key={f}>
                <td>{CODE_FIELD_LABELS[f]}</td><td>{check[f].held}</td><td>{check[f].answered}</td><td>{check[f].right}</td>
                <td>{pct(check[f].precision)}</td><td>{pct(check[f].recall)}</td><td><strong>{pct(check[f].score)}</strong></td>
                <td style={{ color: passes(check[f], s) ? undefined : 'var(--down)' }}>{verdict(check[f])}</td>
                <td>{live.includes(f) ? 'Yes' : 'No'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {app.mode === 'demo' && <p className="small warns">Demo data: the synthetic text is cleaner than real work orders, so expect lower scores on site data.</p>}
      <p className="small muted">Precision: right ÷ answered. Recall: right ÷ held back. A component or failure mode is right only when the system is right too.</p>
    </section>
  );
}

function ReviewTab() {
  const app = useApp();
  const tz = app.ds.site.timeZone;
  const { model, live } = app.suggester;
  const unit = useMemo(() => new Map(app.ds.assets.map((a) => [a.id, a.unitNumber])), [app.ds.assets]);
  const rows = useMemo(() => {
    const idx = workOrderIndex(app.ds.workOrders);
    const since = Date.parse(app.now) - 90 * 86_400_000;
    const clean = new Set(codedRows(app.flags, app.ds.workOrders, STARTER_CODES).map((r) => r.flagId));
    return app.flags
      .filter((f) => f.type === 'unscheduled' && f.state === 'released' && f.end && Date.parse(f.end) >= since && !clean.has(f.id))
      .map((f) => {
        const issues = codingIssues(f).filter((i) => i !== 'no_cause');
        const text = flagText(f, idx);
        return { f, issues, text, s: liveSuggestion(suggestCodes(model, text, app.assistSettings.minConfidence), live) };
      })
      .filter((r) => r.issues.length)
      .sort((a, b) => Date.parse(b.f.end!) - Date.parse(a.f.end!));
  }, [app.flags, app.ds.workOrders, app.now, model, live, app.assistSettings.minConfidence]);
  return (
    <section className="card">
      <h3>Released failures in the last 90 days whose coding needs a look</h3>
      <p className="small muted">
        {live.length ? 'The suggested codes come from the text. ' : 'Suggested codes show here once suggestions are switched on and pass the check. '}
        A7 has no rule yet for changing codes on a released flag, so this list is for review and coaching; it changes nothing.
      </p>
      {rows.length === 0 ? <p className="muted">Nothing to review.</p> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Unit</th><th>Released</th><th>Coded</th><th>Needs a look</th><th>Text</th><th>Suggested</th></tr></thead>
            <tbody>
              {rows.slice(0, 200).map(({ f, issues, text, s }) => (
                <tr key={f.id}>
                  <td><a href={`#/unit/${f.unitId}`}>{unit.get(f.unitId) ?? f.unitId}</a></td>
                  <td style={{ whiteSpace: "nowrap" }}>{siteTime(f.end!, tz, true)}</td>
                  <td>{[f.release?.system ?? f.system, f.release?.component, f.release?.failureModes?.join(', ')].filter(Boolean).join(' / ')}</td>
                  <td className="small">{issues.map((i) => CODING_CHECK_LABELS[i]).join('; ')}</td>
                  <td className="small" style={{ maxWidth: 320 }}>{text}</td>
                  <td className="small">{CODE_FIELDS.filter((k) => s[k]).map((k) => `${s[k]!.code} (${Math.round(s[k]!.chance * 100)}%)`).join(' / ') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function DuplicatesTab() {
  const app = useApp();
  const tz = app.ds.site.timeZone;
  const s = app.assistSettings;
  const unit = useMemo(() => new Map(app.ds.assets.map((a) => [a.id, a.unitNumber])), [app.ds.assets]);
  const groups = useMemo(() => duplicateWorkOrders(app.ds.workOrders, s), [app.ds.workOrders, s]);
  return (
    <section className="card">
      <h3>Open corrective work orders that may be the same job</h3>
      <p className="small muted">Same unit, reported within {s.duplicateDays} days, and {pct(s.duplicateSimilarity)} or more of their words in common. Check them in Maximo; nothing is changed here.</p>
      {groups.length === 0 ? <p className="muted">No possible duplicates.</p> : (
        <div className="stack">
          {groups.map((g) => (
            <div key={g.workOrders.map((w) => w.id).join()} className="card">
              <div className="small"><strong><a href={`#/unit/${g.assetId}`}>{unit.get(g.assetId) ?? g.assetId}</a></strong> <span className="muted">· {g.workOrders.length} work orders · {pct(g.similarity)} of words in common</span></div>
              <ul className="small" style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                {g.workOrders.map((w) => <li key={w.id}>{w.number} · {siteTime(w.reportedAt!, tz, true)} · {w.status ?? ''} · {w.description}</li>)}
              </ul>
            </div>
          ))}
        </div>
      )}
      <p className="small muted">Repeat failures (same unit and system soon after a release) are on the downtime analysis page (KPI-025).</p>
    </section>
  );
}

function SettingsTab() {
  const app = useApp();
  const allowed = can(app.actor, 'edit_assist');
  const cur = app.assistSettings;
  const [v, setV] = useState<AssistSettings>(cur);
  const [text, setText] = useState({ minConfidence: String(cur.minConfidence * 100), minScore: String(cur.minScore * 100), holdoutShare: String(cur.holdoutShare * 100), duplicateSimilarity: String(cur.duplicateSimilarity * 100) });
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const n = (x: string) => (x.trim() === '' ? NaN : Number(x));
  const save = () => {
    const next: AssistSettings = { ...v, minConfidence: n(text.minConfidence) / 100, minScore: n(text.minScore) / 100, holdoutShare: n(text.holdoutShare) / 100, duplicateSimilarity: n(text.duplicateSimilarity) / 100 };
    // The check for the new settings, so switching on is judged by what will be used.
    const ok = [next.minConfidence, next.holdoutShare].every(Number.isFinite);
    const check = ok ? holdoutCheck(codedRows(app.flags, app.ds.workOrders, STARTER_CODES), STARTER_CODES, next) : null;
    const r = app.runAssistSettings((ctx, c) => setAssistSettings(ctx, c, next, reason, check));
    setMsg(r.ok ? { ok: true, text: 'Saved.' } : { ok: false, text: r.errors.join(' ') });
    if (r.ok) { setReason(''); setV(r.records[0]!); }
  };
  const pctField = (k: keyof typeof text, label: string) => (
    <label className="field"><span>{label}</span><input inputMode="decimal" value={text[k]} onChange={(e) => setText({ ...text, [k]: e.target.value })} /></label>
  );
  return (
    <section className="card" style={{ maxWidth: 760 }}>
      <h3>Assist settings</h3>
      <p className="small muted">{allowed ? 'Changes go to the audit log with your reason. Suggestions can only be switched on when a code passes the held-back check.' : 'Reliability engineers and superintendents change these.'}</p>
      <fieldset disabled={!allowed} style={{ border: 0, padding: 0, margin: 0 }}>
        <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <input type="checkbox" checked={v.suggestCodes} onChange={(e) => setV({ ...v, suggestCodes: e.target.checked })} style={{ width: 22, height: 22 }} />
          <span>Show failure code suggestions on the release form</span>
        </label>
        <div className="grid two" style={{ gap: 10, alignItems: 'start' }}>
          {pctField('minConfidence', 'Lowest chance to suggest (%)')}
          {pctField('minScore', 'Held-back score needed (%)')}
          {pctField('holdoutShare', 'Share of latest flags held back (%)')}
          <label className="field"><span>Fewest held-back flags</span><input inputMode="numeric" value={v.minHoldout} onChange={(e) => setV({ ...v, minHoldout: n(e.target.value) })} /></label>
          <label className="field"><span>Days to compare work orders</span><input inputMode="numeric" value={v.duplicateDays} onChange={(e) => setV({ ...v, duplicateDays: n(e.target.value) })} /></label>
          {pctField('duplicateSimilarity', 'Words in common for a duplicate (%)')}
        </div>
        {allowed && (
          <>
            <label className="field" style={{ marginTop: 10 }}><span>Reason for the change</span><input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
            <button className="btn primary" style={{ marginTop: 10 }} onClick={save}>Save settings</button>
          </>
        )}
      </fieldset>
      {msg && <div className={msg.ok ? 'card' : 'errors'} role="status" style={{ marginTop: 10 }}>{msg.text}</div>}
    </section>
  );
}

const EXAMPLES = ['Why was PA below target last week?', 'Which system cost the most downtime, and is it getting worse?', 'What is the difference between MTTR and mean downtime?'];

/** AI-5: a question about the latest complete week, answered by Claude from the KPI dictionary and the pack numbers (docs/ai-assist.md). */
function AskTab() {
  const app = useApp();
  const tz = app.ds.site.timeZone;
  const allowed = can(app.actor, 'ask_assist');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<{ q: string; r: AskReply } | null>(null);
  const weeks = useMemo(() => recentWeeks(tz, app.now, 12), [tz, app.now]);
  const week = weeks[weeks.length - 2]!;
  const ctx = useMemo(() => askContext(weeklyPack({
    assets: app.ds.assets, flags: app.flags, smu: app.ds.smu, lifecycle: app.ds.lifecycle, rules: app.rules, now: app.now,
    timeZone: tz, siteName: app.ds.site.name, fleetName: 'Haul trucks', shopLines: app.ds.shopLines, closures: app.ds.closures,
    targets: app.targets, weekOf: week.from,
  }), dictionary), [app.ds, app.flags, app.rules, app.now, week.from, app.targets, tz]);
  const live = app.mode === 'live';
  const ask = async () => {
    const question = q.trim();
    if (!question || busy) return;
    setBusy(true);
    try { setRes({ q: question, r: await askAssist(app.ds.site.id, question, ctx) }); } finally { setBusy(false); }
  };
  return (
    <section className="card" style={{ maxWidth: 860 }}>
      <h3>Ask about the week of {ctx.week}</h3>
      <p className="small muted">
        Claude answers from the KPI dictionary and this week's pack numbers only, and every line names its source. It is sent the question and those
        numbers, with no names and no costs. Answers that cite anything else are not shown. 20 questions a day each.
      </p>
      {!live && <p className="small warns">Questions need the live site: the Anthropic key is kept on the server, so the demo cannot ask.</p>}
      {live && !allowed && <p className="small muted">Supervisors, reliability engineers and superintendents can ask.</p>}
      <fieldset disabled={!live || !allowed || busy} style={{ border: 0, padding: 0, margin: 0 }}>
        <label className="field"><span>Your question</span>
          <textarea rows={2} maxLength={500} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void ask(); }} />
        </label>
        <div className="row" style={{ marginTop: 8 }}>
          <button className="btn primary" onClick={() => void ask()} disabled={!q.trim()}>{busy ? 'Asking…' : 'Ask'}</button>
          {EXAMPLES.map((x) => <button key={x} className="chip" onClick={() => setQ(x)}>{x}</button>)}
        </div>
      </fieldset>
      {res && (
        <div className="card" role="status" style={{ marginTop: 12 }}>
          <p className="small muted" style={{ marginTop: 0 }}>{res.q}</p>
          {'lines' in res.r ? (
            <>
              {res.r.outcome === 'cannot_answer' && <p className="small warns">The numbers it was given cannot fully answer this.</p>}
              <ul style={{ margin: 0, paddingLeft: 20, overflowWrap: 'anywhere' }}>{res.r.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>
              <p className="small muted" style={{ marginBottom: 0 }}>Check it against the pack before you use it.</p>
            </>
          ) : <p className={res.r.outcome === 'error' ? 'errors' : 'small'} style={{ margin: 0 }}>{res.r.message}</p>}
        </div>
      )}
    </section>
  );
}
