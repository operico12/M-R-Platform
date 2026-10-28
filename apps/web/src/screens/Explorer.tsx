// Analytics explorer (plan 7.5 to 7.7; docs/analytics-explorer.md): compare two
// slices, break any measure down by one or two dimensions, spread, control
// charts, suggested findings, saved views. Everything lives in the page link.

import {
  DIMENSION_LABELS, DURATION_LABELS, MEASURE_LABELS, analyse, breakdown, can, compareSlices, controlChart, eventRows, filterFromQuery,
  filterToQuery, findings, heatMap, retireView, saveView, sliceOperatingHours, spread, toCsv, visibleViews, weeklyTrend,
  type AnalyticsFilter, type Dimension, type Duration, type EventRow, type FilteredAnalysis, type Measure,
} from '@mr/core';
import { useMemo, useState } from 'react';
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { FilterBar } from '../components/FilterBar';
import { siteTime } from '../format';
import { newHref } from '../improve/describe';
import { useApp } from '../store';

type Tab = 'compare' | 'breakdown' | 'heatmap' | 'spread' | 'control' | 'findings';
const TABS: Array<[Tab, string]> = [['compare', 'Compare'], ['breakdown', 'Breakdown'], ['heatmap', 'Heat map'], ['spread', 'Spread'], ['control', 'Control chart'], ['findings', 'Findings']];
const EXPLORER_KEYS = ['tab', 'dim', 'dim2', 'measure', 'dur', 'series'];
const DIMS = Object.keys(DIMENSION_LABELS) as Dimension[];
const MEASURES = Object.keys(MEASURE_LABELS) as Measure[];
const DURATIONS = Object.keys(DURATION_LABELS) as Duration[];
const SERIES: Array<['hours' | 'events' | 'failures', string]> = [['hours', 'Down h'], ['events', 'Events'], ['failures', 'Failures']];

interface State { tab: Tab; dim: Dimension; dim2: Dimension; measure: Measure; dur: Duration; series: 'hours' | 'events' | 'failures'; a: AnalyticsFilter; b: AnalyticsFilter }

/** One link holds slice A (plain keys), slice B ("b." keys) and the page settings. */
function parse(query: string): State {
  const q = new URLSearchParams(query);
  const a = new URLSearchParams();
  const b = new URLSearchParams();
  for (const [k, v] of q) {
    if (k.startsWith('b.')) b.set(k.slice(2), v);
    else if (!EXPLORER_KEYS.includes(k)) a.set(k, v);
  }
  const pick = <T extends string>(v: string | null, all: readonly T[], d: T): T => (v && (all as readonly string[]).includes(v) ? (v as T) : d);
  const A = filterFromQuery(a.toString());
  return {
    tab: pick(q.get('tab'), TABS.map((t) => t[0]), 'compare'),
    dim: pick(q.get('dim'), DIMS, 'system'), dim2: pick(q.get('dim2'), DIMS, 'shift'),
    measure: pick(q.get('measure'), MEASURES, 'down_h'), dur: pick(q.get('dur'), DURATIONS, 'down'),
    series: pick(q.get('series'), SERIES.map((s) => s[0]), 'hours'),
    a: A, b: b.toString() ? filterFromQuery(b.toString()) : { ...A, shifts: A.shifts.length ? [] : ['night'] },
  };
}

function toQuery(s: State): string {
  const q = new URLSearchParams(filterToQuery(s.a));
  for (const [k, v] of new URLSearchParams(filterToQuery(s.b))) q.set(`b.${k}`, v);
  const d = parse('');
  if (s.tab !== d.tab) q.set('tab', s.tab);
  if (s.dim !== d.dim) q.set('dim', s.dim);
  if (s.dim2 !== d.dim2) q.set('dim2', s.dim2);
  if (s.measure !== d.measure) q.set('measure', s.measure);
  if (s.dur !== d.dur) q.set('dur', s.dur);
  if (s.series !== d.series) q.set('series', s.series);
  return q.toString();
}

const fmt = (m: Measure | 'p', v: number | null): string => {
  if (v === null || !Number.isFinite(v)) return '—';
  if (m === 'events' || m === 'failures') return String(Math.round(v));
  if (m === 'down_h' || m === 'wait_h' || m === 'mtbf') return Math.round(v).toLocaleString('en-CA');
  return v.toFixed(2);
};
const linkBtn = { display: 'inline-flex', alignItems: 'center', textDecoration: 'none' } as const;

export function Explorer({ query }: { query: string }) {
  const app = useApp();
  const tz = app.ds.site.timeZone;
  const st = useMemo(() => parse(query), [query]);
  const go = (patch: Partial<State>) => { const q = toQuery({ ...st, ...patch }); window.location.hash = `#/explore${q ? `?${q}` : ''}`; };
  const [drill, setDrill] = useState<{ title: string; rows: EventRow[] } | null>(null);

  const input = { assets: app.ds.assets, flags: app.flags, smu: app.ds.smu, lifecycle: app.ds.lifecycle, rules: app.rules, now: app.now, calendar: app.ds.calendar, timeZone: tz };
  const slice = (f: AnalyticsFilter) => {
    const an = analyse(input, f);
    return { an, rows: eventRows(an, app.ds.assets, app.ds.calendar, app.ds.shopLines), hours: sliceOperatingHours(input, an.assets, an) };
  };
  const A = useMemo(() => slice(st.a), [app.ds, app.flags, app.rules, app.now, st.a]);
  const B = useMemo(() => (st.tab === 'compare' ? slice(st.b) : null), [app.ds, app.flags, app.rules, app.now, st.b, st.tab]);
  const unitHours = (an: FilteredAnalysis) => (dim: Dimension, key: string) =>
    sliceOperatingHours(input, an.assets.filter((x) => (dim === 'unit' ? x.unitNumber : dim === 'model' ? x.model : x.fleet) === key), an);

  return (
    <div className="stack">
      <div className="page-head">
        <h2>Explorer</h2>
        <span className="muted small">{siteTime(A.an.period.from, tz, true)} – {siteTime(A.an.period.to, tz, true)} · site time zone {tz}</span>
      </div>
      <Views query={toQuery(st)} />
      <div className="chips" role="tablist">
        {TABS.map(([k, l]) => <button key={k} role="tab" className="chip" aria-pressed={st.tab === k} onClick={() => { setDrill(null); go({ tab: k }); }} style={{ minHeight: 40 }}>{l}</button>)}
      </div>

      <FilterBar ds={app.ds} value={st.a} onChange={(a) => go({ a })} matched={`${st.tab === 'compare' ? 'A: ' : ''}${A.rows.length} events matched`}
        extra={<>
          {can(app.actor, 'create_actions') && <a className="btn" style={linkBtn} href={newHref('actions', { kind: 'analysis', query: filterToQuery(st.a) })}>Raise action</a>}
          <button className="btn" onClick={() => void navigator.clipboard?.writeText(window.location.href)}>Copy link</button>
        </>} />

      {st.tab === 'compare' && B && <Compare st={st} go={go} A={A} B={B} onDrill={setDrill} />}
      {st.tab === 'breakdown' && <Breakdown st={st} go={go} rows={A.rows} hours={A.hours} unitHours={unitHours(A.an)} onDrill={setDrill} />}
      {st.tab === 'heatmap' && <Heat st={st} go={go} rows={A.rows} hours={A.hours} onDrill={setDrill} />}
      {st.tab === 'spread' && <Spread st={st} go={go} rows={A.rows} />}
      {st.tab === 'control' && <Control st={st} go={go} an={A.an} />}
      {st.tab === 'findings' && <Findings st={st} go={go} rows={A.rows} onDrill={setDrill} />}

      {drill && <Drill title={drill.title} rows={drill.rows} onClose={() => setDrill(null)} />}
    </div>
  );
}

type Sl = { an: FilteredAnalysis; rows: EventRow[]; hours: number };
type Props = { st: State; go: (p: Partial<State>) => void };

function Select<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: Array<[T, string]>; onChange: (v: T) => void }) {
  return (
    <label className="small">{label}{' '}
      <select value={value} onChange={(e) => onChange(e.target.value as T)}>{options.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
    </label>
  );
}
const dimOptions = DIMS.map((d) => [d, DIMENSION_LABELS[d]] as [Dimension, string]);

// ---------- compare ----------

function Compare({ st, go, A, B, onDrill }: Props & { A: Sl; B: Sl; onDrill: (d: { title: string; rows: EventRow[] }) => void }) {
  const app = useApp();
  const lines = compareSlices(A.rows, A.hours, B.rows, B.hours);
  const preset = (a: Partial<AnalyticsFilter>, b: Partial<AnalyticsFilter>) => go({ a: { ...st.a, ...a }, b: { ...st.a, ...b } });
  return (
    <>
      <section className="card">
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <strong className="small">Quick compare:</strong>
          <button className="chip" onClick={() => preset({ shifts: ['day'] }, { shifts: ['night'] })}>Day vs night</button>
          <button className="chip" onClick={() => preset({ crews: ['A'] }, { crews: ['C'] })}>Crew A vs crew C</button>
          <button className="chip" onClick={() => preset({ where: ['field'] }, { where: ['shop'] })}>Field vs shop</button>
          <button className="chip" onClick={() => preset({ range: { preset: '28d' } }, { range: { from: new Date(Date.parse(app.now) - 56 * 864e5).toLocaleDateString('en-CA', { timeZone: app.ds.site.timeZone }), to: new Date(Date.parse(app.now) - 29 * 864e5).toLocaleDateString('en-CA', { timeZone: app.ds.site.timeZone }) } })}>Last 28 days vs the 28 before</button>
        </div>
        <h3 style={{ marginBottom: 4 }}>Slice B</h3>
      </section>
      <FilterBar ds={app.ds} value={st.b} onChange={(b) => go({ b })} matched={`B: ${B.rows.length} events matched`} />
      <section className="card">
        <h3 style={{ marginTop: 0 }}>A compared with B</h3>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Measure</th><th>A</th><th>B</th><th>B − A</th><th>Change</th><th>Normal variation?</th></tr></thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.measure}>
                  <td>{MEASURE_LABELS[l.measure]}</td>
                  <td>{fmt(l.measure, l.a)}</td>
                  <td>{fmt(l.measure, l.b)}</td>
                  <td>{fmt(l.measure, l.diff)}</td>
                  <td>{l.pct === null ? '—' : `${l.pct > 0 ? '+' : ''}${(l.pct * 100).toFixed(0)}%`}</td>
                  <td>{l.p === null ? <span className="muted small">not tested</span> : l.outside ? <strong>▲ Outside (p = {l.p.toFixed(3)})</strong> : <span className="small">Within (p = {l.p.toFixed(2)})</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="small muted">“Outside” means the difference is bigger than chance would explain for these sample sizes (p &lt; 0.05). Durations use the Mann-Whitney test; MTBF compares failure rates. Totals depend on the window length, so they are not tested. Each side needs at least 5 events (KPI-028).</p>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn" onClick={() => onDrill({ title: 'Slice A events', rows: A.rows })}>A events</button>
          <button className="btn" onClick={() => onDrill({ title: 'Slice B events', rows: B.rows })}>B events</button>
        </div>
      </section>
    </>
  );
}

// ---------- breakdown ----------

function Breakdown({ st, go, rows, hours, unitHours, onDrill }: Props & { rows: EventRow[]; hours: number; unitHours: (d: Dimension, k: string) => number; onDrill: (d: { title: string; rows: EventRow[] }) => void }) {
  const groups = breakdown(rows, st.dim, hours, unitHours);
  const shown: Measure[] = ['events', 'failures', 'down_h', 'mean_down_h', 'median_down_h', 'p90_down_h', 'mttr', 'mean_wait_h', 'first_wrench_h', 'mtbf'];
  return (
    <section className="card">
      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <h3 style={{ margin: 0 }}>Breakdown by {DIMENSION_LABELS[st.dim].toLowerCase()}</h3>
        <Select label="By" value={st.dim} options={dimOptions} onChange={(dim) => go({ dim })} />
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>{DIMENSION_LABELS[st.dim]}</th>{shown.map((m) => <th key={m}>{MEASURE_LABELS[m]}</th>)}</tr></thead>
          <tbody>
            {groups.map((g) => (
              <tr key={g.key}>
                <td><button className="linklike" onClick={() => onDrill({ title: `${DIMENSION_LABELS[st.dim]}: ${g.key}`, rows: g.rows })}>{g.key}</button></td>
                {shown.map((m) => <td key={m}>{fmt(m, g.summary[m])}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small muted">Means, medians, P90 and MTTR show from 5 events. MTBF by unit, model or fleet uses those units' operating hours; by anything else it uses the whole slice's hours. Click a row for its events.</p>
    </section>
  );
}

// ---------- heat map ----------

function Heat({ st, go, rows, hours, onDrill }: Props & { rows: EventRow[]; hours: number; onDrill: (d: { title: string; rows: EventRow[] }) => void }) {
  const m = heatMap(rows, st.dim, st.dim2, st.measure, hours);
  const values = [...m.cells.values()].map((c) => c.value).filter((v): v is number => v !== null);
  const max = Math.max(1e-9, ...values);
  return (
    <section className="card">
      <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <h3 style={{ margin: 0 }}>Heat map</h3>
        <Select label="Rows" value={st.dim} options={dimOptions} onChange={(dim) => go({ dim })} />
        <Select label="Columns" value={st.dim2} options={dimOptions} onChange={(dim2) => go({ dim2 })} />
        <Select label="Measure" value={st.measure} options={MEASURES.filter((x) => x !== 'mtbf').map((x) => [x, MEASURE_LABELS[x]] as [Measure, string])} onChange={(measure) => go({ measure })} />
      </div>
      <div className="table-wrap">
        <table className="small">
          <thead><tr><th>{DIMENSION_LABELS[st.dim]} \ {DIMENSION_LABELS[st.dim2]}</th>{m.cols.map((c) => <th key={c}>{c}</th>)}</tr></thead>
          <tbody>
            {m.rows.map((r) => (
              <tr key={r}>
                <th style={{ textAlign: 'left' }}>{r}</th>
                {m.cols.map((c) => {
                  const cell = m.cells.get(`${r}\u0000${c}`);
                  if (!cell) return <td key={c} />;
                  const t = cell.value === null ? 0 : cell.value / max;
                  return (
                    <td key={c} style={{ padding: 0 }}>
                      <button onClick={() => onDrill({ title: `${r} · ${c}`, rows: cell.rows })} title={`${cell.n} events`}
                        style={{ width: '100%', minHeight: 36, border: 0, cursor: 'pointer', color: t > 0.6 ? '#fff' : 'var(--text)', background: cell.value === null ? 'transparent' : `color-mix(in srgb, var(--brand) ${Math.round(10 + t * 85)}%, var(--surface))` }}>
                        {cell.value === null ? <span className="muted">n={cell.n}</span> : fmt(st.measure, cell.value)}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small muted">Darker is higher. The 12 largest rows and columns by down h. Cells with fewer than 5 events show only their count for means, medians and MTTR. Click a cell for its events.</p>
    </section>
  );
}

// ---------- spread ----------

function Spread({ st, go, rows }: Props & { rows: EventRow[] }) {
  const boxes = spread(rows, st.dim, st.dur).slice(0, 15);
  const top = Math.max(1, ...boxes.map((b) => b.hi));
  const x = (v: number) => `${Math.min(100, (v / top) * 100)}%`;
  return (
    <section className="card">
      <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <h3 style={{ margin: 0 }}>Spread</h3>
        <Select label="Of" value={st.dur} options={DURATIONS.map((d) => [d, DURATION_LABELS[d]] as [Duration, string])} onChange={(dur) => go({ dur })} />
        <Select label="By" value={st.dim} options={dimOptions} onChange={(dim) => go({ dim })} />
      </div>
      {boxes.length ? (
        <div role="table" aria-label="Box plot" style={{ display: 'grid', gridTemplateColumns: 'minmax(90px, 160px) 1fr auto', gap: '6px 10px', alignItems: 'center', marginTop: 12 }}>
          {boxes.map((b) => (
            <div key={b.key} role="row" style={{ display: 'contents' }}>
              <div role="rowheader" className="small" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.key}</div>
              <div role="cell" style={{ position: 'relative', height: 22 }} title={`n ${b.n}, P25 ${b.q1.toFixed(1)}, median ${b.median.toFixed(1)}, P75 ${b.q3.toFixed(1)}, whiskers ${b.lo.toFixed(1)}–${b.hi.toFixed(1)}`}>
                <div style={{ position: 'absolute', top: 10, height: 2, left: x(b.lo), width: `calc(${x(b.hi)} - ${x(b.lo)})`, background: 'var(--text-2)' }} />
                <div style={{ position: 'absolute', top: 2, height: 18, left: x(b.q1), width: `calc(${x(b.q3)} - ${x(b.q1)})`, minWidth: 2, background: 'color-mix(in srgb, var(--brand) 35%, var(--surface))', border: '1px solid var(--brand)', borderRadius: 4 }} />
                <div style={{ position: 'absolute', top: 0, height: 22, left: x(b.median), width: 2, background: 'var(--text)' }} />
              </div>
              <div role="cell" className="small muted">n {b.n} · median {b.median.toFixed(1)} h{b.outliers.length ? ` · ${b.outliers.length} long` : ''}</div>
            </div>
          ))}
        </div>
      ) : <p className="muted small">No group has 5 or more events.</p>}
      <p className="small muted">The box runs from the 25th to the 75th percentile, with a line at the median. Whiskers reach the furthest event within 1.5 × the box. Longer events are counted as “long”. The scale is 0 to {top.toFixed(1)} h. Groups with fewer than 5 events are hidden; the widest boxes are first.</p>
    </section>
  );
}

// ---------- control chart ----------

function Control({ st, go, an }: Props & { an: FilteredAnalysis }) {
  const app = useApp();
  const weeks = weeklyTrend(an, app.ds.site.timeZone);
  const c = controlChart(weeks.map((w) => ({ label: w.week, value: st.series === 'hours' ? Math.round(w.hours * 10) / 10 : w[st.series] })));
  return (
    <section className="card">
      <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <h3 style={{ margin: 0 }}>Control chart (weekly)</h3>
        <Select label="Value" value={st.series} options={SERIES} onChange={(series) => go({ series })} />
        {'preset' in st.a.range && st.a.range.preset !== '90d' && <button className="chip" onClick={() => go({ a: { ...st.a, range: { preset: '90d' } } })}>Use 90 days</button>}
      </div>
      {c ? (
        <>
          <div style={{ height: 280 }}>
            <ResponsiveContainer>
              <LineChart data={c.points} margin={{ top: 12, right: 16, bottom: 4, left: -10 }}>
                <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                <XAxis dataKey="label" tick={{ fontSize: 12, fill: 'var(--text-2)' }} />
                <YAxis tick={{ fontSize: 12, fill: 'var(--text-2)' }} />
                <Tooltip formatter={(v: number) => [v, SERIES.find((s) => s[0] === st.series)![1]]} />
                <ReferenceLine y={c.ucl} stroke="var(--down)" strokeDasharray="5 4" label={{ value: `Upper ${c.ucl.toFixed(1)}`, position: 'insideTopRight', fill: 'var(--text-2)', fontSize: 11 }} />
                <ReferenceLine y={c.centre} stroke="var(--text-2)" label={{ value: `Mean ${c.centre.toFixed(1)}`, position: 'insideTopRight', fill: 'var(--text-2)', fontSize: 11 }} />
                {c.lcl > 0 && <ReferenceLine y={c.lcl} stroke="var(--down)" strokeDasharray="5 4" label={{ value: `Lower ${c.lcl.toFixed(1)}`, position: 'insideBottomRight', fill: 'var(--text-2)', fontSize: 11 }} />}
                <Line dataKey="value" stroke="var(--brand)" strokeWidth={2} isAnimationActive={false}
                  dot={(p: { cx?: number; cy?: number; payload?: { out: boolean }; index?: number }) => <circle key={p.index} cx={p.cx} cy={p.cy} r={p.payload?.out ? 6 : 4} fill={p.payload?.out ? 'var(--down)' : 'var(--brand)'} stroke="var(--surface)" strokeWidth={2} />} />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <p className="small">{c.points.some((p) => p.out) ? `Outside the limits: ${c.points.filter((p) => p.out).map((p) => `week of ${p.label}`).join(', ')}. That is a real change, not normal variation.` : 'Every week is inside the limits: the changes are normal variation.'}</p>
        </>
      ) : <p className="muted">A control chart needs at least 6 weeks. Pick a longer date range.</p>}
      <p className="small muted">XmR chart (KPI-029): limits are the mean ± 2.66 × the mean week-to-week change. Weeks start Monday 00:00 site time; the current week is partial.</p>
    </section>
  );
}

// ---------- findings ----------

function Findings({ st, go, rows, onDrill }: Props & { rows: EventRow[]; onDrill: (d: { title: string; rows: EventRow[] }) => void }) {
  const list = findings(rows, st.dur);
  const compareHref = (system: string, dim: Dimension, value: string) => {
    const base = { ...st.a, systems: [system], systemsExclude: false };
    const key = dim === 'shift' ? 'shifts' : dim === 'crew' ? 'crews' : dim === 'where' ? 'where' : dim === 'detection' ? 'detection' : null;
    if (!key) return null;
    const v = dim === 'crew' ? value.replace(/^Crew /, '') : dim === 'where' ? value.toLowerCase() : value;
    const q = toQuery({ ...st, tab: 'compare', measure: 'down_h', a: { ...base, [key]: [v] }, b: { ...base } });
    return `#/explore?${q}`;
  };
  return (
    <section className="card">
      <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <h3 style={{ margin: 0 }}>Suggested findings</h3>
        <Select label="Looking at" value={st.dur} options={DURATIONS.map((d) => [d, DURATION_LABELS[d]] as [Duration, string])} onChange={(dur) => go({ dur })} />
      </div>
      {list.length ? (
        <ol className="stack" style={{ gap: 10, paddingLeft: 20 }}>
          {list.map((f) => {
            const href = compareHref(f.system, f.dim, f.value);
            const these = rows.filter((r) => r.dims.system === f.system && r.dims[f.dim] === f.value);
            return (
              <li key={`${f.system}|${f.dim}|${f.value}`}>
                <div>{f.sentence}</div>
                <div className="small row" style={{ gap: 10, flexWrap: 'wrap' }}>
                  <span className="muted">p = {f.p.toFixed(4)}</span>
                  <button className="linklike" onClick={() => onDrill({ title: `${f.system} · ${f.value}`, rows: these })}>Events</button>
                  {href && <a href={href}>Compare</a>}
                  <a href={newHref('actions', { kind: 'analysis', query: filterToQuery({ ...st.a, systems: [f.system], systemsExclude: false }) })}>Raise action</a>
                </div>
              </li>
            );
          })}
        </ol>
      ) : <p className="muted">Nothing stands out in this slice. Try a longer date range or another measure.</p>}
      <p className="small muted">Each combination of a system with a shift, crew, field or shop, line or detection method is compared with the rest of that system. It is listed when both sides have at least 5 events, the medians differ by at least 0.5 h, and p &lt; 0.01. Largest difference first. Crews and shifts, never named people (plan 11.2).</p>
    </section>
  );
}

// ---------- drill-down ----------

function Drill({ title, rows, onClose }: { title: string; rows: EventRow[]; onClose: () => void }) {
  const app = useApp();
  const tz = app.ds.site.timeZone;
  const sorted = [...rows].sort((a, b) => b.downH - a.downH);
  const exportCsv = () => {
    const head = ['Unit', 'Start (site time)', 'System', 'Component', 'Failure mode', 'Shift', 'Crew', 'Field or shop', 'Shop line', 'Detected by', 'Failure', 'Down h', 'Repair h', 'Wait h', 'First wrench h'];
    const body = sorted.map((r) => [r.dims.unit, siteTime(r.start, tz, true), r.dims.system, r.dims.component, r.dims.failure_mode, r.dims.shift, r.dims.crew, r.dims.where, r.dims.line, r.dims.detection, r.failure ? 'yes' : 'no', r.downH.toFixed(2), r.repairH.toFixed(2), r.waitH.toFixed(2), r.firstWrenchH === null ? '' : r.firstWrenchH.toFixed(2)]);
    const url = URL.createObjectURL(new Blob([toCsv([head, ...body])], { type: 'text/csv' }));
    const el = document.createElement('a');
    el.href = url;
    el.download = 'explorer-events.csv';
    el.click();
    URL.revokeObjectURL(url);
  };
  return (
    <section className="card" aria-label="Events">
      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <h3 style={{ margin: 0 }}>{title}: {rows.length} events</h3>
        <div className="row" style={{ gap: 8 }}>
          {can(app.actor, 'export_reports') && <button className="btn" onClick={exportCsv}>Export</button>}
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      </div>
      <div className="table-wrap" style={{ maxHeight: 420, overflow: 'auto' }}>
        <table className="small">
          <thead><tr><th>Unit</th><th>Start</th><th>System</th><th>Component</th><th>Shift</th><th>Where</th><th>Down h</th><th>Repair h</th><th>Wait h</th></tr></thead>
          <tbody>
            {sorted.slice(0, 300).map((r) => (
              <tr key={r.id}>
                <td><a href={`#/unit/${r.unitId}`}>{r.dims.unit}</a></td><td>{siteTime(r.start, tz, true)}</td><td>{r.dims.system}</td><td>{r.dims.component}</td>
                <td>{r.dims.shift} · {r.dims.crew}</td><td>{r.dims.where}</td><td>{r.downH.toFixed(1)}</td><td>{r.repairH.toFixed(1)}</td><td>{r.waitH.toFixed(1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > 300 && <p className="small muted">Showing the 300 longest. Export has them all.</p>}
    </section>
  );
}

// ---------- saved views ----------

function Views({ query }: { query: string }) {
  const app = useApp();
  const mine = visibleViews(app.views, app.actor.userId);
  const [name, setName] = useState('');
  const [shared, setShared] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);
  const canSave = can(app.actor, 'run_analyses');
  const save = () => {
    const r = app.runView((ctx, list) => saveView(ctx, list, { name, query, shared }));
    setMsg(r.ok ? 'Saved.' : r.errors.join(' '));
    if (r.ok) setName('');
  };
  const retire = (id: string) => {
    const reason = window.prompt('Why retire this view?');
    if (reason === null) return;
    const r = app.runView((ctx, list) => retireView(ctx, list, id, reason));
    setMsg(r.ok ? 'Retired.' : r.errors.join(' '));
  };
  return (
    <details className="card">
      <summary><strong>Saved views</strong> <span className="small muted">({mine.length})</span></summary>
      <div className="stack" style={{ gap: 8, marginTop: 8 }}>
        {mine.length ? (
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {mine.map((v) => (
              <li key={v.id}>
                <a href={`#/explore${v.query ? `?${v.query}` : ''}`}>{v.name}</a>
                <span className="small muted"> · {v.shared ? 'shared' : 'only me'} · {app.userName(v.createdBy)}</span>
                {((v.createdBy === app.actor.userId && canSave) || (v.shared && app.actor.role === 'superintendent')) && <> <button className="linklike small" onClick={() => retire(v.id)}>Retire</button></>}
              </li>
            ))}
          </ul>
        ) : <p className="small muted" style={{ margin: 0 }}>No saved views yet.</p>}
        {canSave ? (
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <input aria-label="View name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name this view" style={{ flex: 1, minWidth: 180 }} />
            <label className="small"><input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} /> Share with the site</label>
            <button className="btn primary" onClick={save}>Save this view</button>
            {msg && <span className="small" role="status">{msg}</span>}
          </div>
        ) : <p className="small muted" style={{ margin: 0 }}>Supervisors, reliability engineers and superintendents can save views. Anyone can copy the link.</p>}
      </div>
    </details>
  );
}

