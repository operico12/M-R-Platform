// Performance dashboard (plan 4.2, Figure 4): PA and utilisation headline,
// MTBF, MTTR and mean downtime, trend against target, downtime by system,
// where downtime goes by stage, bad actors. Weekly pack export.

import { OPEN_A7_SETTINGS, STAGE_LABELS, computeKpis, downtimePareto, recentWeeks, type KpiResult, type Stage } from '@mr/core';
import { useMemo } from 'react';
import { Bar, CartesianGrid, ComposedChart, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { fmtHours, fmtNum, fmtPct, siteTime } from '../format';
import { useApp } from '../store';

// Placeholder targets until the superintendent sets them in the console (plan 11.4).
const TARGETS = { pa: 0.9, utilisation: 0.85 };

const FORMULAS: Record<string, string> = {
  pa: 'PA = (calendar h − maintenance downtime h) ÷ calendar h. Standby is not deducted.',
  util: 'Utilisation = operating h (SMU) ÷ available h. SMU includes idle time.',
  mtbf: 'MTBF = operating h ÷ failures. A failure is an unscheduled event of at least 15 min (A7 R9, D1).',
  mttr: 'MTTR = time In repair ÷ repairs.',
  mdt: 'Mean downtime = unscheduled downtime h ÷ failures. Includes waiting for parts, labour or a line.',
};

export function Performance() {
  const app = useApp();
  const tz = app.ds.site.timeZone;
  const weeks = useMemo(() => recentWeeks(tz, app.now, 12), [tz, app.now]);
  const input = useMemo(
    () => ({ assets: app.ds.assets, flags: app.flags, smu: app.ds.smu, lifecycle: app.ds.lifecycle, rules: app.rules, now: app.now }),
    [app.ds, app.flags, app.rules, app.now],
  );
  const series = useMemo(() => weeks.map((w) => ({ w, k: computeKpis(input, w) })), [weeks, input]);
  // Headline: last complete week.
  const last = series[series.length - 2]!;
  const prev = series[series.length - 3]!;
  const p28 = { from: weeks[weeks.length - 5]!.from, to: weeks[weeks.length - 1]!.from };
  const pareto = useMemo(() => downtimePareto(input, p28), [input, p28.from, p28.to]);
  const k28 = useMemo(() => computeKpis(input, p28), [input, p28.from, p28.to]);
  const bad = useMemo(
    () =>
      app.ds.assets
        .map((a) => ({ a, k: computeKpis({ ...input, assets: [a] }, p28) }))
        .sort((x, y) => y.k.unscheduledDownHours - x.k.unscheduledDownHours)
        .slice(0, 10),
    [app.ds.assets, input, p28.from, p28.to],
  );
  const unsettled = (key: string) => OPEN_A7_SETTINGS.find((s) => s.key === key);

  const trend = series.map(({ w, k }) => ({ week: w.label, PA: pct(k.pa), Utilisation: pct(k.utilisation), MTBF: k.mtbf ? Math.round(k.mtbf) : null }));
  const stages = (Object.keys(k28.stageHours) as Stage[]).map((s) => ({ stage: STAGE_LABELS[s], hours: Math.round(k28.stageHours[s]) })).filter((x) => x.hours > 0);

  const exportPack = () => downloadCsv(`weekly-pack-${last.w.label.replace(' ', '-')}.csv`, packRows(series, app.ds.assets.length));

  return (
    <div className="stack">
      <div className="page-head">
        <h2>Performance · Haul trucks</h2>
        <span className="muted small">Week of {last.w.label} (last complete week) · site time zone {tz}</span>
        <button className="btn" onClick={exportPack}>Export weekly pack (CSV)</button>
      </div>
      <div className="trust"><span>Last sync {siteTime(app.lastSync, tz, true)}</span><span>Source: down flags + SMU readings</span></div>

      <div className="grid kpis">
        <Kpi id="pa" label="Physical availability" v={fmtPct(last.k.pa)} d={delta(last.k.pa, prev.k.pa)} rag={rag(last.k.pa, TARGETS.pa)} target={`Target ${fmtPct(TARGETS.pa, 0)}`} />
        <Kpi id="util" label="Utilisation" v={fmtPct(last.k.utilisation)} d={delta(last.k.utilisation, prev.k.utilisation)} rag={rag(last.k.utilisation, TARGETS.utilisation)} target={`Target ${fmtPct(TARGETS.utilisation, 0)}`} />
        <Kpi id="mtbf" label="MTBF (op. h)" v={fmtNum(last.k.mtbf, 0)} d={`${last.k.failures} failures, ${last.k.minorStops} minor stops`} />
        <Kpi id="mttr" label="MTTR" v={fmtHours(last.k.mttr)} d={`${last.k.repairs} repairs`} flag={unsettled('mttrDenominator')?.question} />
        <Kpi id="mdt" label="Mean downtime" v={fmtHours(last.k.meanDowntime)} d={`Gap to MTTR = logistics: ${fmtHours((last.k.meanDowntime ?? 0) - (last.k.mttr ?? 0))}`} flag={unsettled('meanDowntime')?.question} />
      </div>

      <div className="grid two">
        <section className="card">
          <h3>PA and utilisation by week</h3>
          <div style={{ height: 260 }}>
            <ResponsiveContainer>
              <LineChart data={trend} margin={{ top: 8, right: 16, bottom: 0, left: -10 }}>
                <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                <XAxis dataKey="week" tick={{ fontSize: 12, fill: 'var(--text-2)' }} />
                <YAxis domain={[60, 100]} ticks={[60, 70, 80, 90, 100]} allowDataOverflow unit="%" tick={{ fontSize: 12, fill: 'var(--text-2)' }} />
                <Tooltip formatter={(v: number) => `${v}%`} />
                <Legend />
                <ReferenceLine y={TARGETS.pa * 100} stroke="var(--brand)" strokeDasharray="6 4" label={{ value: 'PA target', fontSize: 11, fill: 'var(--text-2)', position: 'insideTopLeft' }} />
                <Line type="monotone" dataKey="PA" stroke="var(--brand)" strokeWidth={2.5} dot />
                <Line type="monotone" dataKey="Utilisation" stroke="var(--standby)" strokeWidth={2} dot />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <p className="small muted">The last point is the current, partial week.</p>
        </section>

        <section className="card">
          <h3>Unscheduled downtime by system, last 4 weeks <a className="small" href="#/analysis?type=unscheduled">Filter and drill down →</a></h3>
          <div style={{ height: 260 }}>
            <ResponsiveContainer>
              <ComposedChart data={pareto.map((r) => ({ system: r.key, hours: Math.round(r.hours), cumulative: Math.round(r.cumulative * 100) }))} margin={{ top: 8, right: 0, bottom: 40, left: -10 }}>
                <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                <XAxis dataKey="system" angle={-35} textAnchor="end" interval={0} tick={{ fontSize: 11, fill: 'var(--text-2)' }} />
                <YAxis yAxisId="h" unit=" h" tick={{ fontSize: 12, fill: 'var(--text-2)' }} />
                <YAxis yAxisId="c" orientation="right" unit="%" domain={[0, 100]} tick={{ fontSize: 12, fill: 'var(--text-2)' }} />
                <Tooltip />
                <Bar yAxisId="h" dataKey="hours" fill="var(--down)" />
                <Line yAxisId="c" dataKey="cumulative" stroke="var(--text-2)" dot={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </section>

        <section className="card">
          <h3>Where downtime goes, last 4 weeks</h3>
          <div style={{ height: 240 }}>
            <ResponsiveContainer>
              <ComposedChart layout="vertical" data={stages} margin={{ top: 0, right: 16, bottom: 0, left: 40 }}>
                <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                <XAxis type="number" unit=" h" tick={{ fontSize: 12, fill: 'var(--text-2)' }} />
                <YAxis type="category" dataKey="stage" width={110} tick={{ fontSize: 12, fill: 'var(--text-2)' }} />
                <Tooltip />
                <Bar dataKey="hours" fill="var(--brand)" />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <p className="small muted">In repair is wrench time; every other stage is waiting.</p>
        </section>

        <section className="card">
          <h3>Bad actors, last 4 weeks</h3>
          <table>
            <thead><tr><th>Unit</th><th className="num">Unsched. down</th><th className="num">Failures</th><th className="num">PA</th></tr></thead>
            <tbody>
              {bad.map(({ a, k }) => (
                <tr key={a.id}>
                  <td><a href={`#/unit/${a.id}`}>{a.unitNumber}</a></td>
                  <td className="num"><a href={`#/analysis?type=unscheduled&unit=${a.id}`}>{fmtHours(k.unscheduledDownHours)}</a></td>
                  <td className="num">{k.failures}</td>
                  <td className="num">{fmtPct(k.pa)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}

const pct = (x: number | null) => (x === null ? null : Math.round(x * 1000) / 10);
const delta = (a: number | null, b: number | null) => (a === null || b === null ? '' : `${a >= b ? '▲' : '▼'} ${Math.abs((a - b) * 100).toFixed(1)} pts vs prior week`);
function rag(v: number | null, target: number): 'green' | 'amber' | 'red' | undefined {
  if (v === null) return undefined;
  if (v >= target) return 'green';
  if (v >= target - 0.03) return 'amber';
  return 'red';
}

function Kpi({ id, label, v, d, rag: r, target, flag }: { id: string; label: string; v: string; d?: string; rag?: 'green' | 'amber' | 'red'; target?: string; flag?: string }) {
  return (
    <div className="card kpi" title={FORMULAS[id]}>
      <div className="label">
        {label}
        {r && <span className={`rag ${r}`}>{r === 'green' ? '✓ on target' : r === 'amber' ? '! near' : '✕ below'}</span>}
        {flag && <span className="unsettled" title={`Unsettled A7 rule: ${flag}`}>rule open</span>}
      </div>
      <div className="value">{v}</div>
      {target && <div className="sub">{target}</div>}
      {d && <div className="sub">{d}</div>}
      <div className="sub" style={{ fontSize: 11 }}>{FORMULAS[id]}</div>
    </div>
  );
}

function packRows(series: Array<{ w: { label: string; from: string; to: string }; k: KpiResult }>, units: number): string[][] {
  const head = ['Week', 'Units', 'Calendar h', 'Sched down h', 'Unsched down h', 'Operating h', 'Standby h', 'PA', 'Utilisation', 'Failures', 'Minor stops', 'MTBF h', 'MTTR h', 'Mean downtime h', 'Waiting for a line h', 'Waiting parts h'];
  return [
    head,
    ...series.map(({ w, k }) => [
      w.label, String(units), k.calendarHours.toFixed(1), k.scheduledDownHours.toFixed(1), k.unscheduledDownHours.toFixed(1), k.operatingHours.toFixed(1), k.standbyHours.toFixed(1),
      fmtPct(k.pa, 2), fmtPct(k.utilisation, 2), String(k.failures), String(k.minorStops), fmtNum(k.mtbf, 1), fmtNum(k.mttr, 2), fmtNum(k.meanDowntime, 2),
      k.stageHours.waiting_line.toFixed(1), k.stageHours.waiting_parts.toFixed(1),
    ]),
  ];
}

function downloadCsv(name: string, rows: string[][]) {
  const csv = rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
