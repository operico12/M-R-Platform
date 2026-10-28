// Reliability views on the downtime analysis page (phase 2): jack-knife
// chart, bad actors, repeat failures and failure coding quality. Same filter
// as the Pareto above them, so the numbers add up.

import {
  CODING_CHECK_LABELS, ZONE_LABELS, badActors, buildEvents, codingQuality, failuresOnly, flagSystem, jackKnife, paretoOf, repeatFailures,
  type CodingCheck, type FilteredAnalysis, type JackKnifeZone, type ParetoKey,
} from '@mr/core';
import { useMemo, useState } from 'react';
import { CartesianGrid, LabelList, ReferenceLine, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis } from 'recharts';
import { fmtHours, fmtPct, siteTime } from '../format';
import { useApp } from '../store';

type View = 'jack' | 'actors' | 'repeats' | 'coding';
const VIEWS: Array<[View, string]> = [['jack', 'Jack-knife'], ['actors', 'Bad actors'], ['repeats', 'Repeat failures'], ['coding', 'Coding quality']];
const ZONE_COLOR: Record<JackKnifeZone, string> = { acute_chronic: 'var(--down)', chronic: 'var(--sched)', acute: 'var(--brand)', within: 'var(--stale)' };
const GROUPS: Array<[ParetoKey, string]> = [['system', 'System'], ['component', 'Component'], ['failure_mode', 'Failure mode'], ['unit', 'Unit']];

export function ReliabilityViews({ a, onUnit, onSystem }: { a: FilteredAnalysis; onUnit: (id: string) => void; onSystem: (s: string) => void }) {
  const [view, setView] = useState<View>('jack');
  return (
    <section className="card">
      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0 }}>Reliability</h3>
        <div className="chips">{VIEWS.map(([k, l]) => <button key={k} className="chip" aria-pressed={view === k} onClick={() => setView(k)} style={{ minHeight: 40 }}>{l}</button>)}</div>
      </div>
      {view === 'jack' && <JackKnife a={a} onSystem={onSystem} />}
      {view === 'actors' && <Actors a={a} onUnit={onUnit} />}
      {view === 'repeats' && <Repeats a={a} />}
      {view === 'coding' && <Coding a={a} />}
    </section>
  );
}

function useRepeats(a: FilteredAnalysis, days: number) {
  const app = useApp();
  const history = useMemo(() => buildEvents(app.flags, app.rules, app.now), [app.flags, app.rules, app.now]);
  return useMemo(() => repeatFailures(a, history, days), [a, history, days]);
}

function JackKnife({ a, onSystem }: { a: FilteredAnalysis; onSystem: (s: string) => void }) {
  const app = useApp();
  const [by, setBy] = useState<ParetoKey>('system');
  const unitName = (id: string) => app.ds.assets.find((x) => x.id === id)?.unitNumber ?? id;
  const j = useMemo(() => jackKnife(paretoOf(failuresOnly(a), by, unitName)), [a, by]);
  const zones = (Object.keys(ZONE_LABELS) as JackKnifeZone[]).filter((z) => j.points.some((p) => p.zone === z));
  if (!j.points.length) return <p className="muted">No downtime in this slice.</p>;
  const maxE = Math.max(...j.points.map((p) => p.events));
  const maxM = Math.max(...j.points.map((p) => p.mean));
  const minM = Math.min(...j.points.map((p) => p.mean));
  const xMax = Math.max(maxE * 1.5, j.eventLimit * 2);
  const xTicks = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000].filter((t) => t <= xMax);
  return (
    <>
      <div className="row" style={{ marginTop: 8 }}>
        <label className="small">Group by <select value={by} onChange={(e) => setBy(e.target.value as ParetoKey)}>{GROUPS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
      </div>
      <div style={{ height: 360 }}>
        <ResponsiveContainer>
          <ScatterChart margin={{ top: 16, right: 24, bottom: 24, left: 0 }}>
            <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
            <XAxis type="number" dataKey="events" name="Events" scale="log" domain={[0.8, xMax]} ticks={xTicks} allowDataOverflow tick={{ fontSize: 12, fill: 'var(--text-2)' }}
              label={{ value: 'Events (log)', position: 'insideBottom', offset: -12, fill: 'var(--text-2)', fontSize: 12 }} />
            <YAxis type="number" dataKey="mean" name="Mean down h" scale="log" domain={[Math.max(0.05, minM / 1.5), Math.max(maxM * 1.5, j.meanLimit * 2)]} allowDataOverflow
              tickFormatter={(v: number) => (v >= 10 ? v.toFixed(0) : v.toFixed(1))} tick={{ fontSize: 12, fill: 'var(--text-2)' }}
              label={{ value: 'Mean h per event (log)', angle: -90, position: 'insideLeft', offset: 12, fill: 'var(--text-2)', fontSize: 12 }} />
            <ReferenceLine x={j.eventLimit} stroke="var(--text-2)" strokeDasharray="4 3" />
            <ReferenceLine y={j.meanLimit} stroke="var(--text-2)" strokeDasharray="4 3" />
            <Tooltip formatter={(v: number, name: string) => [name === 'Events' ? v : fmtHours(v), name]} labelFormatter={() => ''} />
            {zones.map((z) => (
              <Scatter key={z} name={ZONE_LABELS[z]} data={j.points.filter((p) => p.zone === z)} fill={ZONE_COLOR[z]} cursor={by === 'system' ? 'pointer' : undefined}
                onClick={(d: { key?: string }) => by === 'system' && d.key && onSystem(d.key)}>
                <LabelList dataKey="key" position="right" style={{ fontSize: 11, fill: 'var(--text)' }} />
              </Scatter>
            ))}
          </ScatterChart>
        </ResponsiveContainer>
      </div>
      <div className="row small" style={{ flexWrap: 'wrap', gap: 12 }}>{zones.map((z) => <span key={z}><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 5, background: ZONE_COLOR[z], marginRight: 4 }} />{ZONE_LABELS[z]}</span>)}</div>
      <p className="small muted">Failures only; planned work such as PMs is left out. Dashed lines: {j.eventLimit.toFixed(1)} events (total events ÷ groups) and {fmtHours(j.meanLimit)} per event (total hours ÷ total events). Top right needs both fewer events and shorter repairs; top left is long repairs; bottom right is frequent stops. KPI-024.{by === 'system' ? ' Click a point to filter to it.' : ''}</p>
      <div className="table-wrap">
        <table className="small">
          <thead><tr><th>{GROUPS.find(([k]) => k === by)?.[1]}</th><th className="num">Events</th><th className="num">Mean</th><th className="num">Down</th><th>Zone</th></tr></thead>
          <tbody>{j.points.slice(0, 12).map((p) => <tr key={p.key}><td>{p.key}</td><td className="num">{p.events}</td><td className="num">{fmtHours(p.mean)}</td><td className="num">{fmtHours(p.hours)}</td><td>{ZONE_LABELS[p.zone]}</td></tr>)}</tbody>
        </table>
      </div>
    </>
  );
}

function Actors({ a, onUnit }: { a: FilteredAnalysis; onUnit: (id: string) => void }) {
  const app = useApp();
  const r = useRepeats(a, 30);
  const rows = useMemo(() => badActors(a, r.repeats, 10), [a, r]);
  const unit = (id: string) => app.ds.assets.find((x) => x.id === id)?.unitNumber ?? id;
  const total = a.downHours;
  return (
    <>
      <div className="table-wrap" style={{ marginTop: 8 }}>
        <table>
          <thead><tr><th>#</th><th>Unit</th><th className="num">Down</th><th className="num">Share</th><th className="num">Events</th><th className="num">Failures</th><th className="num">Repeats (30 d)</th><th>Top system</th><th /></tr></thead>
          <tbody>
            {rows.map((x, i) => (
              <tr key={x.unitId}>
                <td>{i + 1}</td>
                <td><a href={`#/unit/${x.unitId}`}>{unit(x.unitId)}</a></td>
                <td className="num">{fmtHours(x.hours)}</td>
                <td className="num">{fmtPct(total ? x.hours / total : null, 0)}</td>
                <td className="num">{x.events}</td>
                <td className="num">{x.failures}</td>
                <td className="num">{x.repeats || ''}</td>
                <td>{x.topSystem} <span className="muted small">{fmtHours(x.topSystemHours)}</span></td>
                <td><button className="btn" style={{ minHeight: 32 }} onClick={() => onUnit(x.unitId)}>Filter</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small muted">Top 10 units by matching down hours (KPI-027). Raise an action or start an RCA from the unit page.</p>
    </>
  );
}

function Repeats({ a }: { a: FilteredAnalysis }) {
  const app = useApp();
  const tz = app.ds.site.timeZone;
  const [days, setDays] = useState(30);
  const r = useRepeats(a, days);
  const unit = (id: string) => app.ds.assets.find((x) => x.id === id)?.unitNumber ?? id;
  return (
    <>
      <div className="row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
        <label className="small">Window <select value={days} onChange={(e) => setDays(Number(e.target.value))}>{[7, 14, 30, 60, 90].map((d) => <option key={d} value={d}>{d} days</option>)}</select></label>
        <strong>{fmtPct(r.share, 0)}</strong><span className="small muted">of {r.failures} failures were repeats ({r.repeats.length}).</span>
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Unit</th><th>System</th><th>Failed</th><th>Previous release</th><th className="num">Days between</th><th>Previous component · mode</th><th>This component · mode</th></tr></thead>
          <tbody>
            {[...r.repeats].sort((x, y) => x.days - y.days).slice(0, 100).map((x) => {
              const pf = x.previous.flags[0]!;
              const cf = x.event.flags[0]!;
              return (
                <tr key={x.event.id}>
                  <td><a href={`#/unit/${x.event.unitId}`}>{unit(x.event.unitId)}</a></td>
                  <td>{x.system}</td>
                  <td>{siteTime(x.event.start, tz, true)}</td>
                  <td>{siteTime(x.previous.end!, tz, true)}</td>
                  <td className="num">{x.days.toFixed(1)}</td>
                  <td className="small">{pf.release?.component ?? ''} · {pf.release?.failureModes?.join(', ') ?? ''}</td>
                  <td className="small">{cf.release?.component ?? ''} · {cf.release?.failureModes?.join(', ') ?? ''}</td>
                </tr>
              );
            })}
            {!r.repeats.length && <tr><td colSpan={7} className="muted">No repeat failures in this slice.</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="small muted">A repeat is a failure on the same unit and system within the window after the last one was released, even if that was before the period (KPI-025). Same component twice points at the repair; different components point at the system.</p>
    </>
  );
}

function Coding({ a }: { a: FilteredAnalysis }) {
  const app = useApp();
  const tz = app.ds.site.timeZone;
  const q = useMemo(() => codingQuality(a, app.ds.calendar), [a]);
  const [check, setCheck] = useState<CodingCheck | null>(null);
  const unit = (id: string) => app.ds.assets.find((x) => x.id === id)?.unitNumber ?? id;
  const rows = q.rows.filter((r) => (check ? r.issues.includes(check) : r.issues.length));
  return (
    <>
      <div className="grid kpis" style={{ marginTop: 8 }}>
        <div className="card kpi"><div className="label">Clean coding</div><div className="value">{fmtPct(q.score, 0)}</div><div className="sub">{q.clean} of {q.released} released failures</div></div>
        {(Object.keys(CODING_CHECK_LABELS) as CodingCheck[]).map((c) => (
          <button key={c} className="card kpi" aria-pressed={check === c} onClick={() => setCheck(check === c ? null : c)} style={{ textAlign: 'left', cursor: 'pointer', font: 'inherit', color: 'inherit', borderColor: check === c ? 'var(--brand)' : undefined }}>
            <div className="label">{CODING_CHECK_LABELS[c]}</div><div className="value">{q.byCheck[c]}</div><div className="sub">{fmtPct(q.released ? q.byCheck[c] / q.released : null, 0)}</div>
          </button>
        ))}
      </div>
      <div className="grid two">
        <div className="table-wrap">
          <table>
            <thead><tr><th>Crew and shift at release</th><th className="num">Released</th><th className="num">Clean</th></tr></thead>
            <tbody>{q.byCrew.map((c) => <tr key={c.crew}><td>{c.crew}</td><td className="num">{c.released}</td><td className="num">{fmtPct(c.score, 0)}</td></tr>)}</tbody>
          </table>
        </div>
        <p className="small muted">Checks against the reference lists (A9 starter lists until the site's own are loaded): a specific component that belongs to the system, a known failure mode, and a cause code. By crew and shift, not by person, so it points at coaching and the code lists rather than at people (KPI-026). Click a check to list the flags.</p>
      </div>
      <h4>{check ? CODING_CHECK_LABELS[check] : 'Flags with any gap'} ({rows.length})</h4>
      <div className="table-wrap">
        <table className="small">
          <thead><tr><th>Unit</th><th>Released</th><th>System</th><th>Component</th><th>Failure mode</th><th>Cause</th><th>Gaps</th></tr></thead>
          <tbody>
            {rows.slice(0, 100).map(({ flag: f, issues }) => (
              <tr key={f.id}>
                <td><a href={`#/unit/${f.unitId}`}>{unit(f.unitId)}</a></td>
                <td>{siteTime(f.end ?? f.start, tz, true)}</td>
                <td>{flagSystem(f)}</td>
                <td>{f.release?.component ?? ''}</td>
                <td>{f.release?.failureModes?.join(', ') ?? ''}</td>
                <td>{f.release?.causeCode ?? ''}</td>
                <td>{issues.map((i) => CODING_CHECK_LABELS[i]).join('; ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > 100 && <p className="small muted">Showing 100 of {rows.length}.</p>}
    </>
  );
}
