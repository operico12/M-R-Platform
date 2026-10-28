// Downtime analysis (MVP screen 3, plan 7.5 and 7.6): Pareto and trend for any
// slice of the data, every number drilling down to the events behind it.

import { EMPTY_FILTER, STAGE_LABELS, can, analyse, flagDownHours, filterFromQuery, filterToQuery, flagSystem, flagWhere, paretoOf, toCsv, weeklyTrend, type AnalyticsFilter, type ParetoKey, type Stage } from '@mr/core';
import { useMemo, useState } from 'react';
import { Bar, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { FilterBar } from '../components/FilterBar';
import { fmtHours, fmtNum, fmtPct, siteTime } from '../format';
import { newHref } from '../improve/describe';
import { useApp } from '../store';

const GROUPS: Array<[ParetoKey, string]> = [['system', 'System'], ['component', 'Component'], ['failure_mode', 'Failure mode'], ['unit', 'Unit'], ['reason', 'Reason code']];

export function Analysis({ query }: { query: string }) {
  const app = useApp();
  const tz = app.ds.site.timeZone;
  const filter = useMemo(() => filterFromQuery(query), [query]);
  const setFilter = (f: AnalyticsFilter) => {
    const q = filterToQuery(f);
    window.location.hash = `#/analysis${q ? `?${q}` : ''}`;
  };
  const [by, setBy] = useState<ParetoKey>('system');
  const unitName = (id: string) => app.ds.assets.find((a) => a.id === id)?.unitNumber ?? id;
  const lineName = (id?: string) => { const l = app.ds.shopLines.find((x) => x.id === id); return l ? l.name ?? `Line ${l.number}` : ''; };

  const a = useMemo(
    () => analyse({ assets: app.ds.assets, flags: app.flags, smu: app.ds.smu, lifecycle: app.ds.lifecycle, rules: app.rules, now: app.now, calendar: app.ds.calendar, timeZone: tz }, filter),
    [app.ds, app.flags, app.rules, app.now, filter],
  );
  const pareto = useMemo(() => paretoOf(a, by, unitName).slice(0, 15), [a, by]);
  const trend = useMemo(() => weeklyTrend(a, tz), [a]);
  // Plan 7.7: actions raised on this same slice (any date range) are marked on the weekly chart
  // in the week they started and the week they were done.
  const sliceKey = filterToQuery({ ...filter, range: EMPTY_FILTER.range });
  const sliceActions = app.actions.filter((x) => x.source.query !== undefined && x.status !== 'cancelled' && filterToQuery({ ...filterFromQuery(x.source.query), range: EMPTY_FILTER.range }) === sliceKey && (sliceKey !== '' || x.source.kind === 'analysis'));
  const weekOf = (iso: string) => (Date.parse(iso) < Date.parse(a.period.to) ? [...trend].reverse().find((t) => Date.parse(t.from) <= Date.parse(iso))?.week : undefined);
  const markers = [...new Map(sliceActions.flatMap((x) => {
    const out: Array<{ week: string; kind: 'started' | 'done' }> = [];
    const st = weekOf(x.startedAt ?? x.createdAt);
    if (st) out.push({ week: st, kind: 'started' });
    const dn = x.doneAt ? weekOf(x.doneAt) : undefined;
    if (dn) out.push({ week: dn, kind: 'done' });
    return out;
  }).map((m) => [`${m.week}|${m.kind}`, m])).values()];
  const stages = (Object.keys(a.stageHours) as Stage[]).map((s) => ({ stage: STAGE_LABELS[s], hours: Math.round(a.stageHours[s]) })).filter((x) => x.hours > 0);
  const rows = [...a.events].sort((x, y) => y.hours - x.hours);

  // Drill in: clicking a bar narrows the filter to it.
  const drill = (key: string) => {
    if (by === 'system') setFilter({ ...filter, systems: [key], systemsExclude: false });
    else if (by === 'unit') { const u = app.ds.assets.find((x) => x.unitNumber === key); if (u) setFilter({ ...filter, units: [u.id] }); }
    else if (by === 'component') setFilter({ ...filter, components: [key] });
  };

  const exportRows = () => {
    const head = ['Unit', 'Start (site time)', 'End (site time)', 'Type', 'System', 'Component', 'Failure mode', 'Field or shop', 'Shop line', 'Detected by', 'Counts as failure', 'Down h in period', 'Work orders'];
    const body = rows.flatMap(({ event, flags }) => flags.map((f) => [
      unitName(f.unitId), siteTime(f.start, tz, true), f.end ? siteTime(f.end, tz, true) : 'open', f.type, flagSystem(f), f.release?.component ?? '', f.release?.failureModes?.join('; ') ?? '',
      flagWhere(f), lineName(f.locations.find((l) => l.shopLineId)?.shopLineId), f.release?.detectionMethod ?? '', event.isFailure ? 'yes' : 'no',
      flagDownHours(f, a.period, app.now).toFixed(2), f.workOrders.join('; '),
    ]));
    const url = URL.createObjectURL(new Blob([toCsv([head, ...body])], { type: 'text/csv' }));
    const el = document.createElement('a');
    el.href = url;
    el.download = 'downtime-events.csv';
    el.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="stack">
      <div className="page-head">
        <h2>Downtime analysis</h2>
        <span className="muted small">{siteTime(a.period.from, tz, true)} – {siteTime(a.period.to, tz, true)} · {a.assets.length} units · site time zone {tz}</span>
      </div>

      <FilterBar
        ds={app.ds}
        value={filter}
        onChange={setFilter}
        matched={`${a.events.length} events matched`}
        extra={<>
          <button className="btn" onClick={() => void navigator.clipboard?.writeText(window.location.href)} title="Copy a link to this view">Copy link</button>
          {can(app.actor, 'create_actions') && <a className="btn" style={{ display: 'inline-flex', alignItems: 'center', textDecoration: 'none' }} href={newHref('actions', { kind: 'analysis', query: filterToQuery(filter) })}>Raise action</a>}
          {can(app.actor, 'run_rcas') && <a className="btn" style={{ display: 'inline-flex', alignItems: 'center', textDecoration: 'none' }} href={newHref('rca', { kind: 'analysis', query: filterToQuery(filter) })}>Start RCA</a>}
        </>}
      />

      <div className="grid kpis">
        <Tile label="Physical availability" v={fmtPct(a.kpis.pa)} sub="Units and dates only" />
        <Tile label="Utilisation" v={fmtPct(a.kpis.utilisation)} sub="Units and dates only" />
        <Tile label="MTBF (op. h)" v={fmtNum(a.kpis.mtbf, 0)} sub={`${a.kpis.failures} failures, all systems`} />
        <Tile label="Matching downtime" v={`${Math.round(a.downHours).toLocaleString()} h`} sub={`${a.events.length} events`} />
        <Tile label="Matching failures" v={String(a.failures)} sub={a.failures ? `${fmtHours(a.downHours / a.failures)} down per failure` : '—'} />
      </div>
      <p className="small muted">PA, utilisation and MTBF follow the unit and date filters. The other filters choose which downtime is analysed below.</p>

      <div className="grid two">
        <section className="card">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h3 style={{ margin: 0 }}>Pareto</h3>
            <label className="small">Group by{' '}
              <select value={by} onChange={(e) => setBy(e.target.value as ParetoKey)}>{GROUPS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
            </label>
          </div>
          <div style={{ height: 280 }}>
            <ResponsiveContainer>
              <ComposedChart data={pareto.map((r) => ({ key: r.key, hours: Math.round(r.hours), cumulative: Math.round(r.cumulative * 100) }))} margin={{ top: 8, right: 0, bottom: 50, left: -10 }}>
                <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                <XAxis dataKey="key" angle={-35} textAnchor="end" interval={0} tick={{ fontSize: 11, fill: 'var(--text-2)' }} />
                <YAxis yAxisId="h" unit=" h" tick={{ fontSize: 12, fill: 'var(--text-2)' }} />
                <YAxis yAxisId="c" orientation="right" unit="%" domain={[0, 100]} tick={{ fontSize: 12, fill: 'var(--text-2)' }} />
                <Tooltip />
                <Bar yAxisId="h" dataKey="hours" name="Down h" fill="var(--down)" cursor={by === 'system' || by === 'unit' || by === 'component' ? 'pointer' : undefined} onClick={(d: { key?: string }) => d.key && drill(d.key)} />
                <Line yAxisId="c" dataKey="cumulative" name="Cumulative %" stroke="var(--text-2)" dot={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          {(by === 'system' || by === 'unit' || by === 'component') && <p className="small muted">Click a bar to filter to it.</p>}
        </section>

        <section className="card">
          <h3>By week</h3>
          <div style={{ height: 280 }}>
            <ResponsiveContainer>
              <ComposedChart data={trend.map((w) => ({ ...w, hours: Math.round(w.hours) }))} margin={{ top: 8, right: 0, bottom: 0, left: -10 }}>
                <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                <XAxis dataKey="week" tick={{ fontSize: 12, fill: 'var(--text-2)' }} />
                <YAxis yAxisId="h" unit=" h" tick={{ fontSize: 12, fill: 'var(--text-2)' }} />
                <YAxis yAxisId="n" orientation="right" allowDecimals={false} tick={{ fontSize: 12, fill: 'var(--text-2)' }} />
                <Tooltip />
                <Bar yAxisId="h" dataKey="hours" name="Down h" fill="var(--brand)" />
                <Line yAxisId="n" dataKey="failures" name="Failures" stroke="var(--down)" strokeWidth={2} dot />
                {markers.map((m) => <ReferenceLine key={`${m.week}|${m.kind}`} yAxisId="h" x={m.week} stroke={m.kind === 'done' ? 'var(--run)' : 'var(--text-2)'} strokeWidth={2} strokeDasharray="4 3" label={{ value: m.kind === 'done' ? 'Action done' : 'Action started', position: m.kind === 'done' ? 'insideTopLeft' : 'insideBottomLeft', fill: m.kind === 'done' ? 'var(--run)' : 'var(--text-2)', fontSize: 11 }} />)}
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <p className="small muted">Weeks start Monday 00:00 site time. Events count in the week they start.{markers.length ? ' Dashed lines mark the weeks an action on this slice started (grey) and was done (green).' : ''}</p>
          {sliceActions.length > 0 && (
            <p className="small">Actions on this slice: {sliceActions.map((x, i) => <span key={x.id}>{i ? ', ' : ''}<a href={`#/actions/${x.id}`}>{x.title}</a></span>)}</p>
          )}
        </section>

        <section className="card">
          <h3>Where the time goes</h3>
          <div style={{ height: 240 }}>
            <ResponsiveContainer>
              <ComposedChart layout="vertical" data={stages} margin={{ top: 0, right: 16, bottom: 0, left: 40 }}>
                <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                <XAxis type="number" unit=" h" tick={{ fontSize: 12, fill: 'var(--text-2)' }} />
                <YAxis type="category" dataKey="stage" width={110} tick={{ fontSize: 12, fill: 'var(--text-2)' }} />
                <Tooltip />
                <Bar dataKey="hours" name="Hours" fill="var(--brand)" />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <p className="small muted">In repair is wrench time; every other stage is waiting.</p>
        </section>
      </div>

      <section>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h3>Events ({rows.length})</h3>
          <button className="btn" onClick={exportRows} disabled={!rows.length}>Export to CSV</button>
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Unit</th><th>Start</th><th>Type</th><th>System · component · mode</th><th>Where</th><th className="num">Down</th><th>Failure</th><th>Work order</th></tr></thead>
            <tbody>
              {rows.slice(0, 300).map(({ event, flags, hours }) => {
                const f = flags[0]!;
                return (
                  <tr key={event.id}>
                    <td><a href={`#/unit/${event.unitId}`}>{unitName(event.unitId)}</a></td>
                    <td>{siteTime(event.start, tz, true)}</td>
                    <td>{flags.map((x) => x.type).join(' → ')}</td>
                    <td>{flagSystem(f)}{f.release?.component ? ` · ${f.release.component}` : ''}{f.release?.failureModes?.length ? ` · ${f.release.failureModes.join(', ')}` : ''}</td>
                    <td>{flagWhere(f) === 'field' ? 'Field' : lineName(f.locations.find((l) => l.shopLineId)?.shopLineId) || 'Shop'}</td>
                    <td className="num">{fmtHours(hours)}</td>
                    <td>{event.isFailure ? 'Yes' : event.isMinorStop ? 'Minor stop' : 'No'}</td>
                    <td>{flags.flatMap((x) => x.workOrders).join(', ')}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {rows.length > 300 && <p className="small muted">Showing the 300 longest. Export to CSV for all {rows.length}.</p>}
      </section>
    </div>
  );
}

function Tile({ label, v, sub }: { label: string; v: string; sub: string }) {
  return (
    <div className="card kpi">
      <div className="label">{label}</div>
      <div className="value">{v}</div>
      <div className="sub">{sub}</div>
    </div>
  );
}
