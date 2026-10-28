// Condition monitoring (phase 3; docs/condition-monitoring.md): the condition
// board, alerts waiting for a response, overdue samples, the control chart,
// entering or importing lab results, settings, and a page per sample.
// Screens call core commands only.

import {
  COMPARTMENT_LABELS, COMPARTMENT_POSITION, COMPARTMENT_SHORT, COMPARTMENTS, ELEMENTS, RESPONSE_LABELS, SEVERITIES, SEVERITY_LABELS,
  buildBaselines, can, compartmentLower, cmResponse, conditionActions, conditionAlerts, conditionBoard, elementById, fmtReading, histogram, historyKey, importLabFile,
  labSeverityOf, oilControlChart, parseCsv, recordSample, respondToSample, risingElements, sampleHistory, samplesDue, setConditionSettings, smuIndex, voidSample,
  type Compartment, type ConditionSettings, type Element, type OilSample, type ResponseAction, type Severity,
} from '@mr/core';
import { useMemo, useState, type ReactNode } from 'react';
import { Bar, BarChart, CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis } from 'recharts';
import { fromLocalInput, toLocalInput } from '../format';
import { useApp } from '../store';

type Tab = 'board' | 'alerts' | 'due' | 'chart' | 'enter' | 'settings';
const TABS: Array<[Tab, string]> = [['board', 'Condition board'], ['alerts', 'Waiting for a response'], ['due', 'Samples due'], ['chart', 'Control chart'], ['enter', 'Enter or import'], ['settings', 'Settings']];

/** Every severity has a word and a shape, never colour alone (plan 10.7). */
export const SEV_STYLE: Record<Severity, { shape: string; short: string; bg: string; fg: string }> = {
  normal: { shape: '●', short: 'OK', bg: 'color-mix(in srgb, var(--run) 18%, var(--surface))', fg: 'var(--text)' },
  monitor: { shape: '◆', short: 'Mon', bg: 'color-mix(in srgb, var(--sched) 28%, var(--surface))', fg: 'var(--text)' },
  action: { shape: '▲', short: 'Act', bg: 'color-mix(in srgb, var(--down) 30%, var(--surface))', fg: 'var(--text)' },
  critical: { shape: '✖', short: 'Crit', bg: 'var(--down)', fg: '#fff' },
};
const SEV_DOT: Record<Severity, string> = { normal: 'var(--run)', monitor: 'var(--sched)', action: '#e65100', critical: 'var(--down)' };

export function SevBadge({ s, title }: { s: Severity; title?: string }) {
  const st = SEV_STYLE[s];
  return <span title={title} style={{ padding: '2px 8px', borderRadius: 4, background: st.bg, color: st.fg, fontWeight: 600, whiteSpace: 'nowrap' }}>{st.shape} {SEVERITY_LABELS[s]}</span>;
}

const day = (iso: string, tz: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: tz, day: 'numeric', month: 'short', year: 'numeric' });
const dayTime = (iso: string, tz: string) => new Date(iso).toLocaleString('en-CA', { timeZone: tz, day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const h0 = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : Math.round(x).toLocaleString('en-CA'));
const pct = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : `${(x * 100).toFixed(0)}%`);
const hoursLeft = (dueAt: string, now: string) => {
  const h = (Date.parse(dueAt) - Date.parse(now)) / 3600000;
  return h >= 0 ? `${h < 1 ? '<1' : Math.round(h)} h left` : `${Math.round(-h)} h late`;
};

/** Everything the page shows, worked out once. */
export function useCondition() {
  const app = useApp();
  const tz = app.ds.site.timeZone;
  const s = app.conditionSettings;
  const modelOf = useMemo(() => { const m = new Map(app.ds.assets.map((a) => [a.id, a.model])); return (id: string) => m.get(id); }, [app.ds.assets]);
  const baselines = useMemo(() => buildBaselines(app.oilSamples, modelOf, app.now, s), [app.oilSamples, modelOf, app.now, s]);
  const idx = useMemo(() => smuIndex(app.ds.smu), [app.ds.smu]);
  const trucks = useMemo(() => app.ds.assets.filter((a) => a.assetClass === 'mobile' && a.fleet === 'Haul trucks'), [app.ds.assets]);
  const due = useMemo(() => samplesDue(trucks, app.ds.lifecycle, app.oilSamples, idx, app.now, s), [trucks, app.ds.lifecycle, app.oilSamples, idx, app.now, s]);
  const board = useMemo(() => conditionBoard(trucks, app.oilSamples, baselines, due), [trucks, app.oilSamples, baselines, due]);
  const alerts = useMemo(() => conditionAlerts(app.oilSamples, app.cmResponses, app.now, s), [app.oilSamples, app.cmResponses, app.now, s]);
  const hist = useMemo(() => sampleHistory(app.oilSamples), [app.oilSamples]);
  return { app, tz, s, modelOf, baselines, idx, trucks, due, board, alerts, hist };
}
type Data = ReturnType<typeof useCondition>;

export function Condition({ arg, sub, query }: { arg?: string; sub?: string; query: string }) {
  const d = useCondition();
  if (arg === 'sample' && sub) return <SamplePage d={d} id={sub} />;
  const q = new URLSearchParams(query);
  const tab = (TABS.find(([k]) => k === q.get('tab'))?.[0] ?? 'board') as Tab;
  const go = (t: Tab) => { window.location.hash = `#/condition?tab=${t}`; };
  const { app, alerts, due } = d;
  const now = Date.parse(app.now);
  const waiting = alerts.filter((a) => a.status === 'waiting' || a.status === 'overdue');
  const kpi = cmResponse(app.oilSamples, app.cmResponses, new Date(now - 28 * 864e5).toISOString(), app.now, app.now, d.s);
  const yearAgo = new Date(now - 365 * 864e5).toISOString();
  const acts = conditionActions(app.cmResponses.filter((r) => r.at >= yearAgo), app.oilSamples, app.ds.workOrders);
  const overdue = due.filter((x) => x.status === 'overdue').length;
  const last30 = app.oilSamples.filter((x) => !x.voidedAt && Date.parse(x.takenAt) > now - 30 * 864e5);
  return (
    <div className="stack">
      <div className="page-head">
        <h2>Condition</h2>
        <span className="muted small">Oil analysis by unit and compartment, against the fleet baseline for the same model.</span>
      </div>
      <div className="grid kpis">
        <Tile label="Waiting for a response" value={String(waiting.length)} note={`${waiting.filter((a) => a.status === 'overdue').length} past target time`} warn={waiting.some((a) => a.status === 'overdue')} />
        <Tile label="Response in time, last 4 weeks (KPI-032)" value={pct(kpi.value)} note={kpi.total ? `${kpi.inTime} of ${kpi.total}; ${kpi.late} late, ${kpi.missing} not answered` : 'No alerts due in the period'} />
        <Tile label="Samples overdue" value={String(overdue)} note={`${due.filter((x) => x.status === 'due_soon').length} due soon, ${due.filter((x) => x.status === 'none').length} never sampled`} warn={overdue > 0} />
        <Tile label="Actions raised, last 12 months" value={`${acts.raised}`} note={`${acts.closed} closed in the ERP, ${acts.raised - acts.closed} open`} />
        <Tile label="Samples, last 30 days" value={String(last30.length)} note={`${last30.filter((x) => x.severity === 'action' || x.severity === 'critical').length} at Action or Critical`} />
      </div>
      <div className="chips" role="tablist">
        {TABS.map(([k, l]) => <button key={k} role="tab" className="chip" aria-pressed={tab === k} onClick={() => go(k)} style={{ minHeight: 40 }}>{l}{k === 'alerts' && waiting.length > 0 && <span className="nav-count">{waiting.length}</span>}</button>)}
      </div>
      {tab === 'board' && <BoardTab d={d} />}
      {tab === 'alerts' && <AlertsTab d={d} />}
      {tab === 'due' && <DueTab d={d} />}
      {tab === 'chart' && <ChartTab d={d} query={q} />}
      {tab === 'enter' && <EnterTab d={d} />}
      {tab === 'settings' && <SettingsTab d={d} />}
    </div>
  );
}

function Tile({ label, value, note, warn }: { label: string; value: string; note?: string; warn?: boolean }) {
  return (
    <div className="card">
      <div className="small muted">{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, color: warn ? 'var(--down)' : undefined }}>{value}</div>
      {note && <div className="small muted">{note}</div>}
    </div>
  );
}

const unitNo = (d: Data, id: string) => d.app.ds.assets.find((a) => a.id === id)?.unitNumber ?? '—';
const sampleLink = (x: OilSample, text: ReactNode) => <a href={`#/condition/sample/${x.id}`}>{text}</a>;
const lastIndex = <T,>(a: T[], f: (x: T) => boolean) => { for (let i = a.length - 1; i >= 0; i--) if (f(a[i]!)) return i; return -1; };
const risingText = (els: Element[]) => els.map((e) => elementById(e).short).join(', ');

// ---------- board ----------

function BoardTab({ d }: { d: Data }) {
  const models = [...new Set(d.trucks.map((a) => a.model))].sort();
  const [model, setModel] = useState('');
  const [worstFirst, setWorstFirst] = useState(true);
  let rows = d.board.filter((r) => !model || r.unit.model === model);
  if (worstFirst) rows = [...rows].sort((a, b) => SEVERITIES.indexOf(b.worst ?? 'normal') - SEVERITIES.indexOf(a.worst ?? 'normal') || a.unit.unitNumber.localeCompare(b.unit.unitNumber));
  return (
    <section className="card">
      <div className="row" style={{ gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0 }}>Latest sample per compartment</h3>
        <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}><span>Model</span>
          <select value={model} onChange={(e) => setModel(e.target.value)}><option value="">All</option>{models.map((m) => <option key={m}>{m}</option>)}</select>
        </label>
        <label className="small row" style={{ gap: 6 }}><input type="checkbox" checked={worstFirst} onChange={(e) => setWorstFirst(e.target.checked)} /> Worst first</label>
      </div>
      <div className="table-wrap">
        <table className="small">
          <thead><tr><th>Unit</th>{COMPARTMENTS.map((c) => <th key={c} title={COMPARTMENT_LABELS[c]}>{COMPARTMENT_SHORT[c]}</th>)}</tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.unit.id}>
                <th style={{ textAlign: 'left' }}><a href={`#/unit/${r.unit.id}`}>{r.unit.unitNumber}</a> <span className="muted">{r.unit.model}</span></th>
                {r.cells.map((c) => {
                  const st = c.latest ? SEV_STYLE[c.latest.severity] : null;
                  const late = c.due?.status === 'overdue';
                  const title = c.latest
                    ? `${COMPARTMENT_LABELS[c.compartment]}: ${SEVERITY_LABELS[c.latest.severity]}, ${day(c.latest.takenAt, d.tz)}${c.rising.length ? `. Rising: ${risingText(c.rising)}` : ''}${late ? '. Sample overdue' : ''}`
                    : `${COMPARTMENT_LABELS[c.compartment]}: no sample on record`;
                  return (
                    <td key={c.compartment} style={{ padding: 0 }}>
                      {c.latest && st ? (
                        <a href={`#/condition/sample/${c.latest.id}`} title={title}
                          style={{ display: 'block', minWidth: 56, padding: '8px 6px', textAlign: 'center', textDecoration: 'none', fontWeight: 600, background: st.bg, color: st.fg, outline: late ? '2px dashed var(--sched)' : undefined, outlineOffset: -3 }}>
                          {st.shape} {st.short}{c.rising.length ? ' ↑' : ''}
                        </a>
                      ) : <span className="muted" title={title} style={{ display: 'block', padding: '8px 6px', textAlign: 'center' }}>none</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="row small" style={{ gap: 12, marginTop: 8, flexWrap: 'wrap' }}>
        {SEVERITIES.map((s) => <SevBadge key={s} s={s} />)}
        <span>↑ an element rose three samples in a row and is well above the fleet mean</span>
        <span><span aria-hidden style={{ display: 'inline-block', width: 14, height: 14, outline: '2px dashed var(--sched)', marginRight: 4 }} />sample overdue</span>
      </div>
    </section>
  );
}

// ---------- alerts ----------

function AlertsTab({ d }: { d: Data }) {
  const { app, tz, alerts } = d;
  const waiting = alerts.filter((a) => a.status === 'waiting' || a.status === 'overdue');
  const done = alerts.filter((a) => a.response).sort((a, b) => Date.parse(b.response!.at) - Date.parse(a.response!.at)).slice(0, 30);
  const acts = conditionActions(app.cmResponses, app.oilSamples, app.ds.workOrders);
  return (
    <div className="stack">
      <section className="card">
        <h3>Waiting for a response ({waiting.length})</h3>
        <p className="small muted">Samples at Action or Critical. Target: Critical within {d.s.responseHours.critical} h, Action within {d.s.responseHours.action} h of the lab report.</p>
        {waiting.length === 0 ? <p className="muted">Nothing waiting.</p> : (
          <div className="table-wrap">
            <table className="small">
              <thead><tr><th>Severity</th><th>Unit</th><th>Compartment</th><th>Taken</th><th>Reported</th><th>Target time</th><th>Why</th></tr></thead>
              <tbody>
                {waiting.map((a) => (
                  <tr key={a.sample.id}>
                    <td>{sampleLink(a.sample, <SevBadge s={a.sample.severity} />)}</td>
                    <td>{unitNo(d, a.sample.unitId)}</td><td>{COMPARTMENT_LABELS[a.sample.compartment]}</td>
                    <td>{day(a.sample.takenAt, tz)}</td><td>{a.sample.reportedAt ? dayTime(a.sample.reportedAt, tz) : '—'}</td>
                    <td style={{ color: a.status === 'overdue' ? 'var(--down)' : undefined, fontWeight: a.status === 'overdue' ? 700 : undefined }}>{hoursLeft(a.dueAt, app.now)}</td>
                    <td>{a.sample.reasons[0] ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="card">
        <h3>Open actions ({acts.open.length})</h3>
        <p className="small muted">Responses that raised a work order. One counts as closed once that work order is closed in the latest ERP import.</p>
        {acts.open.length === 0 ? <p className="muted">None open.</p> : (
          <div className="table-wrap">
            <table className="small">
              <thead><tr><th>Work order</th><th>ERP status</th><th>Unit</th><th>Compartment</th><th>Raised</th></tr></thead>
              <tbody>
                {acts.open.slice(0, 50).map((o) => (
                  <tr key={o.response.id}>
                    <td>{o.response.workOrder}</td><td>{o.workOrder ? o.workOrder.status ?? 'Open' : 'Not in the ERP import yet'}</td>
                    <td>{o.sample ? unitNo(d, o.sample.unitId) : ''}</td><td>{o.sample ? sampleLink(o.sample, COMPARTMENT_LABELS[o.sample.compartment]) : ''}</td>
                    <td>{day(o.response.at, tz)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="card">
        <h3>Recent responses</h3>
        <div className="table-wrap">
          <table className="small">
            <thead><tr><th>Sample</th><th>Unit</th><th>Response</th><th>By</th><th>When</th><th>In time</th></tr></thead>
            <tbody>
              {done.map((a) => (
                <tr key={a.sample.id}>
                  <td>{sampleLink(a.sample, <SevBadge s={a.sample.severity} />)}</td><td>{unitNo(d, a.sample.unitId)} {COMPARTMENT_SHORT[a.sample.compartment]}</td>
                  <td>{RESPONSE_LABELS[a.response!.action]}{a.response!.workOrder ? ` ${a.response!.workOrder}` : ''}</td>
                  <td>{app.userName(a.response!.by)}</td><td>{dayTime(a.response!.at, tz)}</td>
                  <td>{a.status === 'in_time' ? '✓ Yes' : '✗ Late'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

// ---------- samples due ----------

function DueTab({ d }: { d: Data }) {
  const order = { overdue: 0, due_soon: 1, none: 2, ok: 3 } as const;
  const [showOk, setShowOk] = useState(false);
  const rows = d.due.filter((x) => showOk || x.status !== 'ok').sort((a, b) => order[a.status] - order[b.status] || (b.hoursOver ?? 0) - (a.hoursOver ?? 0));
  const label = { overdue: '✖ Overdue', due_soon: '◆ Due soon', none: '○ No sample on record', ok: '● Not due' };
  return (
    <section className="card">
      <div className="row" style={{ gap: 12, alignItems: 'center' }}>
        <h3 style={{ margin: 0 }}>Samples due</h3>
        <label className="small row" style={{ gap: 6 }}><input type="checkbox" checked={showOk} onChange={(e) => setShowOk(e.target.checked)} /> Show ones not due</label>
      </div>
      <p className="small muted">Due at the last sample's unit SMU plus the interval (engine {d.s.intervals.engine} h, others {d.s.intervals.transmission} h). Overdue past {d.s.tolerancePct}% of the interval. Active units only.</p>
      <div className="table-wrap">
        <table className="small">
          <thead><tr><th>Status</th><th>Unit</th><th>Compartment</th><th>Last sample</th><th>SMU then</th><th>Due at SMU</th><th>SMU now</th><th>Hours over</th></tr></thead>
          <tbody>
            {rows.map((x) => (
              <tr key={`${x.unit.id}|${x.compartment}`}>
                <td style={{ color: x.status === 'overdue' ? 'var(--down)' : undefined, fontWeight: x.status === 'overdue' ? 700 : undefined }}>{label[x.status]}</td>
                <td><a href={`#/unit/${x.unit.id}`}>{x.unit.unitNumber}</a></td><td>{COMPARTMENT_LABELS[x.compartment]}</td>
                <td>{x.lastAt ? day(x.lastAt, d.tz) : '—'}</td><td>{h0(x.lastSmu)}</td><td>{h0(x.dueSmu)}</td><td>{h0(x.smuNow)}</td>
                <td>{x.hoursOver !== undefined && x.hoursOver > 0 ? h0(x.hoursOver) : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ---------- control chart ----------

function ChartTab({ d, query }: { d: Data; query: URLSearchParams }) {
  const { app, tz } = d;
  const models = [...new Set(d.trucks.map((a) => a.model))].sort();
  const [model, setModel] = useState(query.get('model') ?? models[0] ?? '');
  const [comp, setComp] = useState<Compartment>((query.get('compartment') as Compartment) ?? 'engine');
  const [el, setEl] = useState<Element>((query.get('element') as Element) ?? 'fe');
  const [unit, setUnit] = useState(query.get('unit') ?? '');
  const chart = oilControlChart(app.oilSamples, d.modelOf, model, comp, el, app.now, d.baselines);
  const b = chart.baseline;
  const def = elementById(el);
  const pts = chart.points.map((p) => ({ x: Date.parse(p.at), y: p.value, unit: unitNo(d, p.unitId), sev: p.severity, mine: p.unitId === unit }));
  const bins = histogram(chart.points.map((p) => p.value));
  const units = d.trucks.filter((a) => a.model === model);
  const lines: Array<[number, string, string]> = b ? [[b.mean, 'Mean', 'var(--text-2)'], [b.high[0], 'Monitor', SEV_DOT.monitor], [b.high[1], 'Action', SEV_DOT.action], [b.high[2], 'Critical', SEV_DOT.critical],
    ...(b.low ? ([[b.low[0], 'Monitor', SEV_DOT.monitor], [b.low[1], 'Action', SEV_DOT.action], [b.low[2], 'Critical', SEV_DOT.critical]] as Array<[number, string, string]>) : [])] : [];
  const fmtX = (t: number) => new Date(t).toLocaleDateString('en-CA', { timeZone: tz, month: 'short', day: 'numeric' });
  return (
    <div className="stack">
      <section className="card">
        <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
          <label className="field"><span>Model</span><select value={model} onChange={(e) => setModel(e.target.value)}>{models.map((m) => <option key={m}>{m}</option>)}</select></label>
          <label className="field"><span>Compartment</span><select value={comp} onChange={(e) => setComp(e.target.value as Compartment)}>{COMPARTMENTS.map((c) => <option key={c} value={c}>{COMPARTMENT_LABELS[c]}</option>)}</select></label>
          <label className="field"><span>Element</span><select value={el} onChange={(e) => setEl(e.target.value as Element)}>{ELEMENTS.map((x) => <option key={x.id} value={x.id}>{x.label}{x.short !== x.label ? ` (${x.short})` : ''}</option>)}</select></label>
          <label className="field"><span>Highlight unit</span><select value={unit} onChange={(e) => setUnit(e.target.value)}><option value="">None</option>{units.map((u) => <option key={u.id} value={u.id}>{u.unitNumber}</option>)}</select></label>
        </div>
        <h3>{model} {compartmentLower(comp)}: {def.label} ({def.unit}), last 12 months</h3>
        {b ? (
          <p className="small muted">Fleet baseline from {b.n} samples: mean {fmtReading(el, b.mean)}, σ {b.sd.toFixed(def.decimals + 1)}. Limits at {d.s.sigmas.join(', ')}σ: {b.high.map((x) => fmtReading(el, x)).join(', ')}{b.low ? `; low ${b.low.map((x) => fmtReading(el, x)).join(', ')}` : ''}.</p>
        ) : <p className="small muted">Not enough samples for a fleet baseline (needs {d.s.minSamples}). Only lab ratings count.</p>}
        {pts.length === 0 ? <p className="muted">No samples.</p> : (
          <div style={{ width: '100%', height: 320 }} aria-label={`Control chart of ${def.label}`}>
            <ResponsiveContainer>
              <ScatterChart margin={{ top: 8, right: 70, bottom: 8, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="x" type="number" domain={['dataMin', 'dataMax']} tickFormatter={fmtX} tick={{ fontSize: 11, fill: 'var(--text-2)' }} />
                <YAxis dataKey="y" type="number" tick={{ fontSize: 11, fill: 'var(--text-2)' }} unit={def.unit === '%' ? '%' : ''} />
                <ZAxis range={[28, 28]} />
                <Tooltip cursor={false} contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
                  formatter={(v: number, n: string) => (n === 'y' ? fmtReading(el, v) : fmtX(v))} labelFormatter={() => ''} />
                {lines.map(([y, l, c], i) => <ReferenceLine key={i} y={y} stroke={c} strokeDasharray={l === 'Mean' ? undefined : '6 4'} label={{ value: l, position: 'right', fontSize: 11, fill: c }} />)}
                <Scatter data={pts.filter((p) => !p.mine)} fill="var(--standby)" fillOpacity={0.55} name="Fleet" isAnimationActive={false} />
                {unit && <Scatter data={pts.filter((p) => p.mine)} fill="var(--accent, #1f6feb)" name={unitNo(d, unit)} line={{ stroke: 'var(--accent, #1f6feb)' }} isAnimationActive={false} />}
              </ScatterChart>
            </ResponsiveContainer>
          </div>
        )}
        <p className="small muted">Each dot is one sample. Lines: the fleet mean and the {d.s.sigmas.join(', ')}σ limits as they stand today.{unit ? ` ${unitNo(d, unit)} in blue.` : ''}</p>
      </section>
      {bins.length > 0 && (
        <section className="card">
          <h3>Spread</h3>
          <div style={{ width: '100%', height: 200 }}>
            <ResponsiveContainer>
              <BarChart data={bins.map((x) => ({ label: x.from.toFixed(def.decimals), count: x.count }))} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--text-2)' }} />
                <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: 'var(--text-2)' }} />
                <Tooltip contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)' }} />
                <Bar dataKey="count" name="Samples" fill="var(--standby)" />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <p className="small muted">Samples by {def.label.toLowerCase()} ({def.unit}), from the lower edge of each bar.</p>
        </section>
      )}
    </div>
  );
}

// ---------- entering and importing ----------

function EnterTab({ d }: { d: Data }) {
  const { app, tz } = d;
  const allowed = can(app.actor, 'record_condition');
  const [f, setF] = useState<Record<string, string>>({ unitId: d.trucks[0]?.id ?? '', compartment: 'engine', takenAt: toLocalInput(app.now, tz), reportedAt: '' });
  const [msg, setMsg] = useState<{ ok: boolean; text: string; id?: string } | null>(null);
  const [imp, setImp] = useState<{ file: string; added: number; duplicates: number; issues: Array<{ row: number; message: string }>; flagged: number } | null>(null);
  const set = (k: string, v: string) => setF((x) => ({ ...x, [k]: v }));
  const num = (k: string) => (f[k]?.trim() ? Number(f[k]) : undefined);
  if (!allowed) return <section className="card"><p className="muted">Supervisors, reliability engineers and superintendents enter oil results.</p></section>;
  const save = () => {
    const readings: Record<string, number> = {};
    for (const e of ELEMENTS) { const v = num(e.id); if (v !== undefined) readings[e.id] = v; }
    let id = '';
    const r = app.runSamples((ctx, data, s) => {
      const out = recordSample(ctx, data, {
        unitId: f.unitId!, compartment: f.compartment as Compartment, takenAt: f.takenAt ? fromLocalInput(f.takenAt, tz) : '', reportedAt: f.reportedAt ? fromLocalInput(f.reportedAt, tz) : undefined,
        smu: num('smu'), oilHours: num('oilHours'), labRef: f.labRef, labSeverity: labSeverityOf(f.labSeverity), readings, comment: f.comment,
      }, s);
      if (out.ok) id = out.records.at(-1)!.id;
      return out;
    });
    if (r.ok) {
      const x = r.records.at(-1)!;
      setMsg({ ok: true, text: `Saved: ${SEVERITY_LABELS[x.severity]}. ${x.reasons[0] ?? ''}`, id });
      setF((p) => ({ unitId: p.unitId ?? '', compartment: p.compartment ?? 'engine', takenAt: p.takenAt ?? '', reportedAt: '' }));
    } else setMsg({ ok: false, text: r.errors.join(' ') });
  };
  const onFile = async (file: File | undefined) => {
    if (!file) return;
    const table = parseCsv(await file.text());
    const r = app.runSamples((ctx, data, s) => importLabFile(ctx, data, table, file.name, s));
    if (!r.ok) { setImp(null); setMsg({ ok: false, text: r.errors.join(' ') }); return; }
    setMsg(null);
    setImp({ file: file.name, added: r.added.length, duplicates: r.duplicates, issues: r.issues, flagged: r.added.filter((x) => x.severity === 'action' || x.severity === 'critical').length });
  };
  const field = (k: string, label: string, el?: ReactNode) => <label className="field" key={k}><span>{label}</span>{el ?? <input inputMode="decimal" value={f[k] ?? ''} onChange={(e) => set(k, e.target.value)} />}</label>;
  return (
    <div className="grid two">
      <section className="card">
        <h3>Import a lab file</h3>
        <p className="small muted">A CSV export from the lab portal. Columns are matched by name (unit, compartment, sample date, lab number, meter, severity, elements). Results already held, by lab number, are skipped, so the same file can be loaded twice. Times without an offset are site time ({tz}).</p>
        <input type="file" accept=".csv,text/csv" onChange={(e) => void onFile(e.target.files?.[0])} aria-label="Lab CSV file" />
        {imp && (
          <div className="card" role="status" style={{ marginTop: 10 }}>
            <strong>{imp.file}:</strong> {imp.added} added ({imp.flagged} at Action or Critical), {imp.duplicates} already held, {imp.issues.length} skipped or noted.
            {imp.issues.length > 0 && <ul className="small">{imp.issues.slice(0, 20).map((i, k) => <li key={k}>Row {i.row}: {i.message}</li>)}</ul>}
          </div>
        )}
      </section>
      <section className="card">
        <h3>Enter one result</h3>
        <div className="grid two" style={{ gap: 10 }}>
          {field('unitId', 'Unit', <select value={f.unitId} onChange={(e) => set('unitId', e.target.value)}>{d.trucks.map((a) => <option key={a.id} value={a.id}>{a.unitNumber}</option>)}</select>)}
          {field('compartment', 'Compartment', <select value={f.compartment} onChange={(e) => set('compartment', e.target.value)}>{COMPARTMENTS.map((c) => <option key={c} value={c}>{COMPARTMENT_LABELS[c]}</option>)}</select>)}
          {field('takenAt', 'Taken (site time)', <input type="datetime-local" value={f.takenAt} onChange={(e) => set('takenAt', e.target.value)} />)}
          {field('reportedAt', 'Lab reported (site time)', <input type="datetime-local" value={f.reportedAt} onChange={(e) => set('reportedAt', e.target.value)} />)}
          {field('smu', 'Unit SMU (h)')}
          {field('oilHours', 'Oil hours')}
          {field('labRef', 'Lab number', <input value={f.labRef ?? ''} onChange={(e) => set('labRef', e.target.value)} />)}
          {field('labSeverity', 'Lab severity', <select value={f.labSeverity ?? ''} onChange={(e) => set('labSeverity', e.target.value)}><option value="">Not given</option>{SEVERITIES.map((s) => <option key={s} value={s}>{SEVERITY_LABELS[s]}</option>)}</select>)}
          {ELEMENTS.map((e) => field(e.id, `${e.label} (${e.unit})`))}
        </div>
        <label className="field" style={{ marginTop: 10 }}><span>Lab comment</span><input value={f.comment ?? ''} onChange={(e) => set('comment', e.target.value)} /></label>
        <button className="btn primary" style={{ marginTop: 10 }} onClick={save}>Save result</button>
        {msg && <div className={msg.ok ? 'card' : 'errors'} role="status" style={{ marginTop: 10 }}>{msg.text} {msg.id && <a href={`#/condition/sample/${msg.id}`}>Open it</a>}</div>}
      </section>
    </div>
  );
}

// ---------- settings ----------

function SettingsTab({ d }: { d: Data }) {
  const { app } = d;
  const allowed = can(app.actor, 'edit_condition_settings');
  const [v, setV] = useState<ConditionSettings>(d.s);
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const save = () => {
    const r = app.runConditionSettings((ctx, cur) => setConditionSettings(ctx, cur, v, reason));
    setMsg(r.ok ? { ok: true, text: 'Saved. New samples are judged with these settings; past samples keep the severity they were given.' } : { ok: false, text: r.errors.join(' ') });
    if (r.ok) setReason('');
  };
  const n = (x: string) => Number(x);
  return (
    <section className="card" style={{ maxWidth: 760 }}>
      <h3>Condition monitoring settings</h3>
      <p className="small muted">{allowed ? 'Changes go to the audit log with your reason.' : 'Reliability engineers, superintendents and the admin change these.'}</p>
      <fieldset disabled={!allowed} style={{ border: 0, padding: 0, margin: 0 }}>
        <h4>Sample interval (unit SMU hours)</h4>
        <div className="grid two" style={{ gap: 10 }}>
          {COMPARTMENTS.map((c) => <label key={c} className="field"><span>{COMPARTMENT_LABELS[c]}</span><input inputMode="numeric" value={v.intervals[c]} onChange={(e) => setV({ ...v, intervals: { ...v.intervals, [c]: n(e.target.value) } })} /></label>)}
          <label className="field"><span>Overdue tolerance (% of interval)</span><input inputMode="decimal" value={v.tolerancePct} onChange={(e) => setV({ ...v, tolerancePct: n(e.target.value) })} /></label>
        </div>
        <h4>Fleet baseline and limits</h4>
        <div className="grid two" style={{ gap: 10 }}>
          <label className="field"><span>Baseline window (days)</span><input inputMode="numeric" value={v.baselineDays} onChange={(e) => setV({ ...v, baselineDays: n(e.target.value) })} /></label>
          <label className="field"><span>Minimum samples for a baseline</span><input inputMode="numeric" value={v.minSamples} onChange={(e) => setV({ ...v, minSamples: n(e.target.value) })} /></label>
          {(['Monitor', 'Action', 'Critical'] as const).map((l, i) => (
            <label key={l} className="field"><span>{l} limit (σ above the mean)</span><input inputMode="decimal" value={v.sigmas[i]} onChange={(e) => { const s = [...v.sigmas] as [number, number, number]; s[i] = n(e.target.value); setV({ ...v, sigmas: s }); }} /></label>
          ))}
        </div>
        <h4>Response target time (hours from the lab report)</h4>
        <div className="grid two" style={{ gap: 10 }}>
          <label className="field"><span>Critical</span><input inputMode="numeric" value={v.responseHours.critical} onChange={(e) => setV({ ...v, responseHours: { ...v.responseHours, critical: n(e.target.value) } })} /></label>
          <label className="field"><span>Action</span><input inputMode="numeric" value={v.responseHours.action} onChange={(e) => setV({ ...v, responseHours: { ...v.responseHours, action: n(e.target.value) } })} /></label>
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

// ---------- one sample ----------

function SamplePage({ d, id }: { d: Data; id: string }) {
  const { app, tz } = d;
  const x = app.oilSamples.find((s) => s.id === id);
  const [trendEl, setTrendEl] = useState<Element>(((x && Object.keys(x.readings)[0]) as Element | undefined) ?? 'fe');
  const [resp, setResp] = useState<{ action: ResponseAction; workOrder: string; note: string }>({ action: 'resample', workOrder: '', note: '' });
  const [voidReason, setVoidReason] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  if (!x) return <section className="card"><p>Sample not found. <a href="#/condition">Back to Condition</a></p></section>;
  const unit = app.ds.assets.find((a) => a.id === x.unitId);
  const hist = d.hist.get(historyKey(x.unitId, x.compartment)) ?? [];
  const rising = risingElements(hist, unit?.model, d.baselines);
  const alert = d.alerts.find((a) => a.sample.id === x.id);
  const response = app.cmResponses.find((r) => r.sampleId === x.id);
  const canRespond = can(app.actor, 'record_condition') && alert && !response;
  const canVoid = !x.voidedAt && ((x.enteredBy === app.actor.userId && can(app.actor, 'record_condition')) || app.actor.role === 'superintendent');
  const shown = ELEMENTS.filter((e) => hist.some((h) => h.readings[e.id] !== undefined));
  const trend = hist.slice(-12).map((h) => ({ label: new Date(h.takenAt).toLocaleDateString('en-CA', { timeZone: tz, month: 'short', day: 'numeric' }), v: h.readings[trendEl] }));
  const tb = d.baselines.get(`${unit?.model}|${x.compartment}|${trendEl}`);
  const respond = () => {
    const r = app.runResponse((ctx, data) => respondToSample(ctx, data, x.id, { action: resp.action, workOrder: resp.workOrder, note: resp.note }));
    setMsg(r.ok ? { ok: true, text: 'Response saved.' } : { ok: false, text: r.errors.join(' ') });
  };
  const doVoid = () => {
    const r = app.runSamples((ctx, data) => voidSample(ctx, data.samples, x.id, voidReason));
    setMsg(r.ok ? { ok: true, text: 'Voided. It no longer counts in the baseline, the board or the KPI.' } : { ok: false, text: r.errors.join(' ') });
  };
  return (
    <div className="stack">
      <div className="page-head">
        <h2><a href="#/condition" className="small" style={{ fontWeight: 400 }}>Condition</a> / {unit?.unitNumber} {compartmentLower(x.compartment)}, {day(x.takenAt, tz)}</h2>
        <div className="grow" />
        {x.voidedAt ? <span className="errors">Voided: {x.voidReason}</span> : <SevBadge s={x.severity} />}
      </div>
      <div className="grid two">
        <section className="card">
          <h3>Result</h3>
          <dl className="small" style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '4px 12px', margin: 0 }}>
            <dt>Unit</dt><dd><a href={`#/unit/${x.unitId}`}>{unit?.unitNumber}</a> {unit?.model}</dd>
            <dt>Taken</dt><dd>{dayTime(x.takenAt, tz)}</dd>
            <dt>Lab reported</dt><dd>{x.reportedAt ? dayTime(x.reportedAt, tz) : '—'}</dd>
            <dt>Unit SMU</dt><dd>{h0(x.smu)} h</dd>
            <dt>Oil hours</dt><dd>{h0(x.oilHours)}</dd>
            <dt>Lab number</dt><dd>{x.labRef ?? '—'}</dd>
            <dt>Lab rating</dt><dd>{x.labSeverity ? SEVERITY_LABELS[x.labSeverity] : '—'}</dd>
            <dt>Entered</dt><dd>{app.userName(x.enteredBy)}, {dayTime(x.enteredAt, tz)}</dd>
          </dl>
          {x.comment && <p><strong>Lab comment:</strong> {x.comment}</p>}
          <h4>Why it is {SEVERITY_LABELS[x.severity]}</h4>
          {x.reasons.length ? <ul className="small">{x.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul> : <p className="small muted">All readings within the fleet baseline, and the lab rated it normal.</p>}
          <p className="small muted">Worked out when it was entered, from the baseline at that time.</p>
          {rising.length > 0 && <p className="small"><strong>Rising:</strong> {risingText(rising)} went up three samples in a row and is more than 1σ above the fleet mean.</p>}
        </section>
        <section className="card">
          <h3>Readings against today's fleet baseline</h3>
          <div className="table-wrap">
            <table className="small">
              <thead><tr><th>Element</th><th className="num">This sample</th><th className="num">Fleet mean</th><th className="num">Monitor</th><th className="num">Action</th><th className="num">Critical</th></tr></thead>
              <tbody>
                {ELEMENTS.filter((e) => x.readings[e.id] !== undefined).map((e) => {
                  const b = d.baselines.get(`${unit?.model}|${x.compartment}|${e.id}`);
                  const v = x.readings[e.id]!;
                  const over = b ? lastIndex(b.high, (l) => v > l) : -1;
                  const under = b?.low ? lastIndex(b.low, (l) => v < l) : -1;
                  const lvl = Math.max(over, under);
                  return (
                    <tr key={e.id}>
                      <td>{e.label}{e.short !== e.label ? ` (${e.short})` : ''}</td>
                      <td className="num" style={{ fontWeight: lvl >= 0 ? 700 : undefined }}>{fmtReading(e.id, v)}{lvl >= 0 ? ` ${SEV_STYLE[SEVERITIES[lvl + 1]!].shape}` : ''}</td>
                      <td className="num">{b ? b.mean.toFixed(e.decimals) : '—'}</td>
                      {[0, 1, 2].map((i) => <td key={i} className="num">{b ? `${b.high[i]!.toFixed(e.decimals)}${b.low ? ` / ${b.low[i]!.toFixed(e.decimals)}` : ''}` : '—'}</td>)}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="small muted"><a href={`#/condition?tab=chart&model=${unit?.model}&compartment=${x.compartment}&element=${trendEl}&unit=${x.unitId}`}>Open the control chart</a></p>
        </section>
      </div>
      <section className="card">
        <div className="row" style={{ gap: 12, alignItems: 'center' }}>
          <h3 style={{ margin: 0 }}>History: {unit?.unitNumber} {compartmentLower(x.compartment)}</h3>
          <select value={trendEl} onChange={(e) => setTrendEl(e.target.value as Element)} aria-label="Element">{shown.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}</select>
        </div>
        <div style={{ width: '100%', height: 220 }}>
          <ResponsiveContainer>
            <LineChart data={trend} margin={{ top: 8, right: 70, bottom: 0, left: -10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--text-2)' }} />
              <YAxis tick={{ fontSize: 11, fill: 'var(--text-2)' }} domain={[0, (max: number) => Math.ceil(Math.max(max, tb ? tb.high[1] : 0) * 1.1)]} />
              <Tooltip contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)' }} />
              {tb && [[tb.high[0], 'Monitor', SEV_DOT.monitor], [tb.high[1], 'Action', SEV_DOT.action], [tb.high[2], 'Critical', SEV_DOT.critical]].map(([y, l, c]) => <ReferenceLine key={l as string} y={y as number} stroke={c as string} strokeDasharray="6 4" label={{ value: l as string, position: 'right', fontSize: 11, fill: c as string }} />)}
              <Line dataKey="v" name={elementById(trendEl).label} stroke="var(--accent, #1f6feb)" dot isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <div className="table-wrap">
          <table className="small">
            <thead><tr><th>Taken</th><th>SMU</th><th>Severity</th>{shown.map((e) => <th key={e.id} className="num">{e.short}</th>)}</tr></thead>
            <tbody>
              {[...hist].reverse().slice(0, 12).map((h) => (
                <tr key={h.id} style={{ fontWeight: h.id === x.id ? 700 : undefined }}>
                  <td>{sampleLink(h, day(h.takenAt, tz))}</td><td>{h0(h.smu)}</td><td><SevBadge s={h.severity} /></td>
                  {shown.map((e) => <td key={e.id} className="num">{h.readings[e.id] === undefined ? '' : h.readings[e.id]!.toFixed(e.decimals)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <div className="grid two">
        {(alert || response) && (
          <section className="card">
            <h3>Response</h3>
            {alert && <p className="small">Target: within {x.severity === 'critical' ? d.s.responseHours.critical : d.s.responseHours.action} h of the lab report, by {dayTime(alert.dueAt, tz)}.</p>}
            {response ? (
              <p>{RESPONSE_LABELS[response.action]}{response.workOrder ? ` (work order ${response.workOrder})` : ''}: {response.note}<br /><span className="small muted">{app.userName(response.by)}, {dayTime(response.at, tz)}{alert ? (alert.status === 'in_time' ? ', in time' : ', late') : ''}</span></p>
            ) : canRespond ? (
              <div className="stack" style={{ gap: 10 }}>
                <label className="field"><span>Response</span><select value={resp.action} onChange={(e) => setResp({ ...resp, action: e.target.value as ResponseAction })}>{(Object.keys(RESPONSE_LABELS) as ResponseAction[]).map((k) => <option key={k} value={k}>{RESPONSE_LABELS[k]}</option>)}</select></label>
                {resp.action === 'work_order' && <label className="field"><span>Work order number (from the ERP)</span><input value={resp.workOrder} onChange={(e) => setResp({ ...resp, workOrder: e.target.value })} /></label>}
                <label className="field"><span>{resp.action === 'no_action' ? 'Why no action is needed' : 'Note'}</span><input value={resp.note} onChange={(e) => setResp({ ...resp, note: e.target.value })} /></label>
                <button className="btn primary" onClick={respond}>Save response</button>
              </div>
            ) : <p className="small muted">{x.voidedAt ? 'Voided samples need no response.' : 'Supervisors, reliability engineers and superintendents respond.'}</p>}
          </section>
        )}
        {canVoid && (
          <section className="card">
            <h3>Void this sample</h3>
            <p className="small muted">For a result entered against the wrong unit or compartment, or a bad bottle. It stays on record, marked void.</p>
            <label className="field"><span>Reason</span><input value={voidReason} onChange={(e) => setVoidReason(e.target.value)} /></label>
            <button className="btn danger" style={{ marginTop: 10 }} onClick={doVoid}>Void</button>
          </section>
        )}
      </div>
      {msg && <div className={msg.ok ? 'card' : 'errors'} role="status">{msg.text}</div>}
    </div>
  );
}

// ---------- for other pages ----------

/** Unit page: latest result per compartment. */
export function UnitCondition({ unitId }: { unitId: string }) {
  const d = useCondition();
  const row = d.board.find((r) => r.unit.id === unitId);
  if (!row || row.cells.every((c) => !c.latest)) return null;
  return (
    <section className="card">
      <h3>Oil analysis</h3>
      <div className="table-wrap">
        <table className="small">
          <thead><tr><th>Compartment</th><th>Latest</th><th>Taken</th><th>Rising</th><th>Next sample</th></tr></thead>
          <tbody>
            {row.cells.map((c) => (
              <tr key={c.compartment}>
                <td>{COMPARTMENT_LABELS[c.compartment]}</td>
                <td>{c.latest ? sampleLink(c.latest, <SevBadge s={c.latest.severity} />) : <span className="muted">none</span>}</td>
                <td>{c.latest ? day(c.latest.takenAt, d.tz) : ''}</td>
                <td>{risingText(c.rising)}</td>
                <td style={{ color: c.due?.status === 'overdue' ? 'var(--down)' : undefined }}>{c.due?.status === 'overdue' ? `Overdue by ${h0(c.due.hoursOver)} h` : c.due?.dueSmu ? `At ${h0(c.due.dueSmu)} h` : c.due?.status === 'none' ? 'No sample on record' : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Life board overlay: latest oil severity for the compartment that holds a position's component. */
export function useOilByPosition() {
  const app = useApp();
  return useMemo(() => {
    const hist = sampleHistory(app.oilSamples);
    return (unitId: string, positionId: string): OilSample | undefined => {
      const c = COMPARTMENTS.find((x) => COMPARTMENT_POSITION[x] === positionId);
      return c ? hist.get(historyKey(unitId, c))?.at(-1) : undefined;
    };
  }, [app.oilSamples]);
}
