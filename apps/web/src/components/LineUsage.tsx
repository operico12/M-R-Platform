// Shop line usage over time (docs/shop-lines.md section 4, KPI-047): pick a period and a grouping
// (day, week, month, year) and see how much of each line's capacity was occupied, and how much of
// that was worked on. All periods are cut in the site time zone.

import { USAGE_GROUPINGS, defaultGrouping, lineName, lineUsage, toCsv, usageCsvRows, usagePresets, type UsageGrouping } from '@mr/core';
import { useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { fmtHours, fromLocalInput, toLocalInput } from '../format';
import { useApp } from '../store';

const pct = (x: number | null, d = 0) => (x === null ? '—' : `${(x * 100).toFixed(d)}%`);

export function LineUsage() {
  const app = useApp();
  const tz = app.ds.site.timeZone;
  const presets = useMemo(() => usagePresets(tz, app.now), [tz, app.now]);
  const [presetKey, setPresetKey] = useState('last_12_months');
  const [custom, setCustom] = useState<{ from: string; to: string }>({ from: '', to: '' });
  const [picked, setPicked] = useState<UsageGrouping | null>(null);

  const useCustom = presetKey === 'custom' && custom.from && custom.to && custom.from <= custom.to;
  const period = useMemo(() => {
    if (useCustom) {
      // A whole-day range in site time: the "to" day is included.
      const to = new Date(Date.parse(fromLocalInput(`${custom.to}T00:00`, tz)) + 24 * 3_600_000);
      return { from: fromLocalInput(`${custom.from}T00:00`, tz), to: to.toISOString() };
    }
    return (presets.find((p) => p.key === presetKey) ?? presets[4]!).period;
  }, [useCustom, custom, presetKey, presets, tz]);
  const grouping = picked ?? defaultGrouping(period);

  const usage = useMemo(
    () => lineUsage({ lines: app.ds.shopLines, flags: app.flags, closures: app.ds.closures, period, grouping, timeZone: tz, now: app.now }),
    [app.ds.shopLines, app.flags, app.ds.closures, period, grouping, tz, app.now],
  );

  const chart = usage.groups.map((g, i) => {
    const f = usage.fleet.groups[i]!;
    const cap = f.openHours > 0 ? f.openHours : 0;
    // Share of capacity: worked and idle stack to the usage figure.
    const share = (h: number) => (f.usage !== null && f.occupiedHours > 0 ? Math.round((h / f.occupiedHours) * f.usage * 1000) / 10 : 0);
    return { label: g.label, Worked: cap ? share(f.workedHours) : 0, 'Occupied, not in repair': cap ? share(f.idleHours) : 0 };
  });

  const download = () => {
    const rows = usageCsvRows(usage, lineName);
    const head = Object.keys(rows[0] ?? { line: '' });
    const url = URL.createObjectURL(new Blob([toCsv([head, ...rows.map((r) => head.map((h) => r[h]))])], { type: 'text/csv' }));
    const el = document.createElement('a');
    el.href = url;
    el.download = `line-usage-${grouping}.csv`;
    el.click();
    URL.revokeObjectURL(url);
  };

  const t = usage.fleet.total;
  return (
    <section aria-label="Line usage over time" className="stack">
      <h3 className="sl-h">Line usage over time <span className="muted">· site time, closed time left out</span></h3>
      <div className="row">
        <label className="small">Period{' '}
          <select value={presetKey} onChange={(e) => setPresetKey(e.target.value)}>
            {presets.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
            <option value="custom">Choose dates…</option>
          </select>
        </label>
        {presetKey === 'custom' && (
          <>
            <label className="small">From <input type="date" value={custom.from} max={toLocalInput(app.now, tz).slice(0, 10)} onChange={(e) => setCustom({ ...custom, from: e.target.value })} /></label>
            <label className="small">To <input type="date" value={custom.to} max={toLocalInput(app.now, tz).slice(0, 10)} onChange={(e) => setCustom({ ...custom, to: e.target.value })} /></label>
            {!useCustom && <span className="small muted">Pick both dates.</span>}
          </>
        )}
        <div className="row" role="group" aria-label="Group by">
          {USAGE_GROUPINGS.map((g) => (
            <button key={g.value} type="button" className={`btn${g.value === grouping ? ' primary' : ''}`} aria-pressed={g.value === grouping} onClick={() => setPicked(g.value)}>{g.label}</button>
          ))}
        </div>
        <button type="button" className="btn" onClick={download} disabled={usage.rows.length === 0 || usage.groups.length === 0}>Download CSV</button>
      </div>

      <div className="sl-summary">
        <span className="sl-stat"><strong>{pct(t.usage, 1)}</strong> usage</span>
        <span className="sl-stat"><strong>{fmtHours(t.occupiedHours)}</strong> occupied</span>
        <span className="sl-stat"><strong>{fmtHours(t.workedHours)}</strong> in repair</span>
        <span className="sl-stat"><strong>{fmtHours(t.idleHours)}</strong> occupied, not in repair</span>
      </div>

      {usage.groups.length === 0 ? <p className="small muted">Nothing in this period yet.</p> : (
        <>
          <div className="card" style={{ height: 280 }}>
            <ResponsiveContainer>
              <BarChart data={chart}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="label" fontSize={12} />
                <YAxis unit="%" domain={[0, 100]} fontSize={12} />
                <Tooltip formatter={(v) => `${v}%`} />
                <Legend />
                <Bar dataKey="Worked" stackId="u" fill="var(--run)" />
                <Bar dataKey="Occupied, not in repair" stackId="u" fill="var(--sched)" />
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="card" style={{ overflowX: 'auto' }}>
            <table>
              <caption className="small muted" style={{ textAlign: 'left' }}>Usage by line and period (darker = busier)</caption>
              <thead>
                <tr>
                  <th>Line</th>
                  {usage.groups.map((g) => <th key={g.from} className="num">{g.label}</th>)}
                  <th className="num">All</th>
                  <th className="num">Occupied</th>
                  <th className="num">In repair</th>
                  <th className="num">Visits</th>
                  <th className="num">Units</th>
                </tr>
              </thead>
              <tbody>
                {usage.rows.map((r) => (
                  <tr key={r.line.id}>
                    <td>{lineName(r.line)}{r.line.retiredAt ? <span className="muted small"> (retired)</span> : null}</td>
                    {r.groups.map((u, i) => (
                      <td key={i} className="num" style={u.usage === null ? undefined : { background: `color-mix(in srgb, var(--run) ${Math.round(u.usage * 70)}%, transparent)` }} title={u.usage === null ? 'Closed' : `${fmtHours(u.occupiedHours)} of ${fmtHours(u.openHours)} open`}>{pct(u.usage)}</td>
                    ))}
                    <td className="num"><strong>{pct(r.total.usage, 1)}</strong></td>
                    <td className="num">{fmtHours(r.total.occupiedHours)}</td>
                    <td className="num">{fmtHours(r.total.workedHours)}</td>
                    <td className="num">{r.total.visits}</td>
                    <td className="num">{r.total.units}</td>
                  </tr>
                ))}
                <tr>
                  <td><strong>All lines</strong></td>
                  {usage.fleet.groups.map((u, i) => <td key={i} className="num"><strong>{pct(u.usage)}</strong></td>)}
                  <td className="num"><strong>{pct(t.usage, 1)}</strong></td>
                  <td className="num">{fmtHours(t.occupiedHours)}</td>
                  <td className="num">{fmtHours(t.workedHours)}</td>
                  <td colSpan={2} />
                </tr>
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
