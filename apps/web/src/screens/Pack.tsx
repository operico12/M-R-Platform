// Weekly pack (MVP screen 5): pick a week, check it on screen, then export to
// PowerPoint or Excel, or print to PDF. Target: pack done in under 15 minutes.

import { STAGE_LABELS, can, packSummary, recentWeeks, weeklyPack, type WeeklyPack } from '@mr/core';
import { DraftBox } from '../components/DraftBox';
import { useMemo, useState } from 'react';
import { Bar, CartesianGrid, ComposedChart, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, XAxis, YAxis } from 'recharts';
import { FORMULAS, fmtH, fmtP, packFileName, siteStamp } from '../pack/common';
import { useApp } from '../store';

export function Pack({ query }: { query: string }) {
  const app = useApp();
  const tz = app.ds.site.timeZone;
  const weeks = useMemo(() => recentWeeks(tz, app.now, 12), [tz, app.now]);
  const wanted = new URLSearchParams(query).get('week');
  // Default: the last complete week.
  const week = weeks.find((w) => w.from.slice(0, 10) === wanted || w.label === wanted) ?? weeks[weeks.length - 2]!;
  const [busy, setBusy] = useState<string | null>(null);
  const allowed = can(app.actor, 'export_reports');

  const pack = useMemo(
    () => weeklyPack({
      assets: app.ds.assets, flags: app.flags, smu: app.ds.smu, lifecycle: app.ds.lifecycle, rules: app.rules, now: app.now,
      timeZone: tz, siteName: app.ds.site.name, fleetName: 'Haul trucks', shopLines: app.ds.shopLines, closures: app.ds.closures,
      targets: app.targets, weekOf: week.from,
    }),
    [app.ds, app.flags, app.rules, app.now, week.from, app.targets],
  );

  const run = async (what: string, f: () => Promise<void>) => {
    setBusy(what);
    try { await f(); } finally { setBusy(null); }
  };
  const pptx = () => run('PowerPoint', async () => (await import('../pack/pptx')).downloadPptx(pack));
  const xlsx = () => run('Excel', async () => {
    const { xlsxBlob } = await import('../pack/xlsx');
    const blob = await xlsxBlob(excelSheets(pack));
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${packFileName(pack)}.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
  });

  const k = pack.kpis;
  const trend = pack.trend.map((t) => ({ week: t.label, PA: pct(t.pa), Utilisation: pct(t.utilisation) }));

  return (
    <div className="stack pack">
      <div className="page-head no-print">
        <h2>Weekly pack</h2>
        <label className="small">Week of{' '}
          <select value={week.from} onChange={(e) => { const w = weeks.find((x) => x.from === e.target.value)!; window.location.hash = `#/pack?week=${w.from.slice(0, 10)}`; }}>
            {[...weeks].reverse().map((w, i) => <option key={w.from} value={w.from}>{w.label}{i === 0 ? ' (in progress)' : ''}</option>)}
          </select>
        </label>
        <button className="btn primary" disabled={!allowed || !!busy} onClick={pptx}>{busy === 'PowerPoint' ? 'Building…' : 'PowerPoint'}</button>
        <button className="btn" disabled={!allowed || !!busy} onClick={xlsx}>{busy === 'Excel' ? 'Building…' : 'Excel'}</button>
        <button className="btn" disabled={!allowed} onClick={() => window.print()}>Print or save as PDF</button>
        {!allowed && <span className="small muted">Your role can view the pack but not export it.</span>}
      </div>
      <p className="small muted no-print">The pack uses the same numbers as the Performance page. Publishing a pack and locking the week come with period locks in phase 1b.</p>

      <DraftBox
        title="Draft summary"
        draft={packSummary(pack)}
        note="Drafted from this pack's numbers; each sentence names its source. Copy it into the pack note and edit it. It is not saved."
        empty="Nothing to summarise for this week."
      />

      <section className="card page">
        <h2 style={{ margin: 0 }}>{pack.title}</h2>
        <p className="muted" style={{ marginTop: 4 }}>Week of {pack.week.label}{pack.partial ? ' (in progress)' : ''} · {pack.siteName} · generated {siteStamp(pack.generatedAt, tz)} site time</p>
        {pack.notes.map((n) => <p key={n} className="warns small">{n}</p>)}
        <div className="grid kpis">
          <Tile label="Physical availability" v={fmtP(k.pa)} sub={`Target ${fmtP(pack.targets.pa, 0)} · prior ${fmtP(pack.prior.pa)}`} />
          <Tile label="Utilisation" v={fmtP(k.utilisation)} sub={`Target ${fmtP(pack.targets.utilisation, 0)} · prior ${fmtP(pack.prior.utilisation)}`} />
          <Tile label="MTBF (op. h)" v={k.mtbf === null ? '—' : k.mtbf.toFixed(0)} sub={`${k.failures} failures`} />
          <Tile label="MTTR" v={fmtH(k.mttr)} sub={`${k.repairs} repairs`} />
          <Tile label="Mean downtime" v={fmtH(k.meanDowntime)} sub="per failure" />
        </div>
        <h3>PA and utilisation, last 12 weeks</h3>
        <div style={{ height: 240 }}>
          <ResponsiveContainer>
            <LineChart data={trend} margin={{ top: 8, right: 16, bottom: 0, left: -10 }}>
              <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
              <XAxis dataKey="week" tick={{ fontSize: 12, fill: 'var(--text-2)' }} />
              <YAxis domain={[60, 100]} ticks={[60, 70, 80, 90, 100]} allowDataOverflow unit="%" tick={{ fontSize: 12, fill: 'var(--text-2)' }} />
              <Legend />
              <ReferenceLine y={pack.targets.pa * 100} stroke="var(--down)" strokeDasharray="6 4" />
              <Line type="monotone" dataKey="PA" stroke="var(--brand)" strokeWidth={2.5} dot isAnimationActive={false} />
              <Line type="monotone" dataKey="Utilisation" stroke="var(--standby)" strokeWidth={2} dot isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </section>

      <section className="card page">
        <h3>Unscheduled downtime by system</h3>
        <div style={{ height: 260 }}>
          <ResponsiveContainer>
            <ComposedChart data={pack.pareto.slice(0, 10).map((r) => ({ system: r.system, hours: Math.round(r.hours), cumulative: Math.round(r.cumulative * 100) }))} margin={{ top: 8, right: 0, bottom: 40, left: -10 }}>
              <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
              <XAxis dataKey="system" angle={-30} textAnchor="end" interval={0} tick={{ fontSize: 11, fill: 'var(--text-2)' }} />
              <YAxis yAxisId="h" unit=" h" tick={{ fontSize: 12, fill: 'var(--text-2)' }} />
              <YAxis yAxisId="c" orientation="right" unit="%" domain={[0, 100]} tick={{ fontSize: 12, fill: 'var(--text-2)' }} />
              <Bar yAxisId="h" dataKey="hours" fill="var(--down)" isAnimationActive={false} />
              <Line yAxisId="c" dataKey="cumulative" stroke="var(--text-2)" dot={false} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <h3>Downline, repair and the shop</h3>
        <table>
          <tbody>
            <tr><td>Downline (waiting for crew, in transit, waiting for a line)</td><td className="num">{fmtH(pack.timeSplit.downline)}</td></tr>
            <tr><td>In repair (wrench time)</td><td className="num">{fmtH(pack.timeSplit.repair)}</td></tr>
            <tr><td>Waiting parts</td><td className="num">{fmtH(pack.timeSplit.waitingParts)}</td></tr>
            <tr><td>Waiting labour or other</td><td className="num">{fmtH(pack.timeSplit.waitingOther)}</td></tr>
            <tr><td>Ready for release</td><td className="num">{fmtH(pack.timeSplit.ready)}</td></tr>
            <tr><td>Shop release vs plan</td><td className="num">{fmtP(pack.shop.releaseVsPlan.rate, 0)} ({pack.shop.releaseVsPlan.onTime} of {pack.shop.releaseVsPlan.due})</td></tr>
            <tr><td>Fixed in the field</td><td className="num">{fmtP(pack.shop.fieldRepair.share, 0)} ({pack.shop.fieldRepair.field} of {pack.shop.fieldRepair.events})</td></tr>
            <tr><td>Line occupancy</td><td className="num">{pack.shop.lines.map((l) => `${l.name} ${fmtP(l.occupancy, 0)}`).join(' · ')}</td></tr>
          </tbody>
        </table>
      </section>

      <section className="card page">
        <h3>Top 10 bad actors</h3>
        <table>
          <thead><tr><th>Unit</th><th>Model</th><th className="num">Unscheduled down</th><th className="num">Failures</th><th className="num">PA</th><th>Main system</th></tr></thead>
          <tbody>{pack.badActors.map((b) => <tr key={b.unit}><td>{b.unit}</td><td>{b.model}</td><td className="num">{b.unscheduledDownHours.toFixed(1)} h</td><td className="num">{b.failures}</td><td className="num">{fmtP(b.pa)}</td><td>{b.topSystem}</td></tr>)}</tbody>
        </table>
        <h3>Down at time of report ({pack.downNow.length})</h3>
        <table>
          <thead><tr><th>Unit</th><th>Since</th><th className="num">Hours</th><th>Reason</th><th>Stage</th></tr></thead>
          <tbody>{pack.downNow.slice(0, 15).map((d) => <tr key={d.unit}><td>{d.unit}</td><td>{siteStamp(d.since, tz)}</td><td className="num">{d.hours.toFixed(1)}</td><td>{d.reason}</td><td>{d.stage ? STAGE_LABELS[d.stage] : '—'}{d.downline ? ' (downline)' : ''}</td></tr>)}</tbody>
        </table>
      </section>

      <section className="card page">
        <h3>How the numbers are worked out</h3>
        <ul className="small">{FORMULAS.map(([a, b]) => <li key={a}><strong>{a}</strong>: {b}</li>)}</ul>
      </section>
    </div>
  );
}

const pct = (x: number | null) => (x === null ? null : Math.round(x * 1000) / 10);

function Tile({ label, v, sub }: { label: string; v: string; sub: string }) {
  return <div className="card kpi"><div className="label">{label}</div><div className="value">{v}</div><div className="sub">{sub}</div></div>;
}

function excelSheets(p: WeeklyPack) {
  const r1 = (x: number | null) => (x === null ? null : Math.round(x * 10000) / 10000);
  const k = p.kpis;
  return [
    { name: 'Summary', rows: [
      ['Measure', 'This week', 'Prior week', 'Target'],
      ['Physical availability', r1(k.pa), r1(p.prior.pa), p.targets.pa],
      ['Utilisation', r1(k.utilisation), r1(p.prior.utilisation), p.targets.utilisation],
      ['MTBF (operating h)', r1(k.mtbf), r1(p.prior.mtbf), null],
      ['MTTR (h)', r1(k.mttr), r1(p.prior.mttr), null],
      ['Mean downtime (h)', r1(k.meanDowntime), r1(p.prior.meanDowntime), null],
      ['Failures', k.failures, p.prior.failures, null],
      ['Calendar h', r1(k.calendarHours), r1(p.prior.calendarHours), null],
      ['Scheduled down h', r1(k.scheduledDownHours), r1(p.prior.scheduledDownHours), null],
      ['Unscheduled down h', r1(k.unscheduledDownHours), r1(p.prior.unscheduledDownHours), null],
      ['Operating h', r1(k.operatingHours), r1(p.prior.operatingHours), null],
      ['Week from (UTC)', p.week.from, null, null],
      ['Week to (UTC)', p.week.to, null, null],
      ['Site time zone', p.timeZone, null, null],
    ] },
    { name: 'Trend', rows: [['Week of', 'PA', 'Utilisation', 'MTBF', 'Failures'], ...p.trend.map((t) => [t.label, r1(t.pa), r1(t.utilisation), r1(t.mtbf), t.failures])] },
    { name: 'Pareto', rows: [['System', 'Hours', 'Events', 'Cumulative share'], ...p.pareto.map((r) => [r.system, r1(r.hours), r.events, r1(r.cumulative)])] },
    { name: 'Stages', rows: [['Stage', 'Hours'], ...Object.entries(p.stageHours).map(([s, h]) => [STAGE_LABELS[s as keyof typeof STAGE_LABELS], r1(h)])] },
    { name: 'Shop lines', rows: [['Line', 'Occupancy', 'Occupied h', 'Open h'], ...p.shop.lines.map((l) => [l.name, r1(l.occupancy), r1(l.occupiedHours), r1(l.openHours)])] },
    { name: 'Bad actors', rows: [['Unit', 'Model', 'Unscheduled down h', 'Failures', 'PA', 'Main system'], ...p.badActors.map((b) => [b.unit, b.model, r1(b.unscheduledDownHours), b.failures, r1(b.pa), b.topSystem])] },
    { name: 'Down now', rows: [['Unit', 'Since (UTC)', 'Hours', 'Reason', 'Stage', 'Downline'], ...p.downNow.map((d) => [d.unit, d.since, r1(d.hours), d.reason, d.stage ? STAGE_LABELS[d.stage] : '', d.downline ? 'yes' : 'no'])] },
  ];
}
