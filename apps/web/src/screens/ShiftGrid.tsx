// Shift grid (docs/shift-grid.md): one row per unit that was down, one cell per hour, coloured by what the unit
// was doing. All of it is calculated from the flags' stage intervals, in the site time zone.

import { dayWindow, shiftGrid, shiftWindow, siteToday, type GridCell } from '@mr/core';
import { useMemo, useState } from 'react';
import { fmtHours } from '../format';
import { useApp } from '../store';

const STATE_WORD = { repair: 'in repair', waiting: 'waiting', up: 'up', future: '' } as const;
const mins = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} h ${Math.round(m % 60)} min` : `${Math.round(m)} min`);

function cellTitle(c: GridCell, hour: string, stageLabel: (s: string) => string) {
  if (c.kind === 'future') return `${hour}: not yet`;
  const parts = [c.minutes.repair > 0 && `in repair ${mins(c.minutes.repair)}`, c.minutes.waiting > 0 && `waiting ${mins(c.minutes.waiting)}`, c.minutes.up > 0.5 && `up ${mins(c.minutes.up)}`].filter(Boolean);
  const stages = Object.entries(c.stages).map(([s, m]) => `${stageLabel(s)} ${mins(m)}`);
  return `${hour}: ${parts.join(', ')}${stages.length ? ` (${stages.join(', ')})` : ''}${c.type ? ` · ${c.type}` : ''}`;
}

export function ShiftGrid() {
  const app = useApp();
  const tz = app.ds.site.timeZone;
  const cal = app.ds.calendar;
  const [date, setDate] = useState(() => siteToday(app.now, tz));
  const [which, setWhich] = useState<string>('day-all');

  const win = useMemo(() => (which === 'day-all' ? dayWindow(date, tz) : shiftWindow(cal, date, which) ?? dayWindow(date, tz)), [which, date, tz, cal]);
  const grid = useMemo(() => shiftGrid({ flags: app.flags, assets: app.ds.assets, window: win, timeZone: tz, now: app.now }), [app.flags, app.ds.assets, win, tz, app.now]);
  const stageName = (s: string) => s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

  return (
    <div className="stack">
      <div className="page-head">
        <h2>Shift grid</h2>
        <span className="muted small">{win.label} · site time {tz} · {grid.rows.length} unit{grid.rows.length === 1 ? '' : 's'} down</span>
      </div>
      <div className="row">
        <label className="small">Date <input type="date" value={date} max={siteToday(app.now, tz)} onChange={(e) => e.target.value && setDate(e.target.value)} /></label>
        <label className="small">Window{' '}
          <select value={which} onChange={(e) => setWhich(e.target.value)}>
            <option value="day-all">Whole day</option>
            {cal.shifts.map((s) => <option key={s.name} value={s.name}>{s.name.replace(/^\w/, (c) => c.toUpperCase())} shift</option>)}
          </select>
        </label>
        <button type="button" className="btn" onClick={() => setDate(siteToday(app.now, tz, -1))}>Yesterday</button>
        <button type="button" className="btn" onClick={() => setDate(siteToday(app.now, tz))}>Today</button>
      </div>
      <div className="sg-legend small">
        <span><i className="sg-cell sg-u-repair" /> Unscheduled, in repair</span>
        <span><i className="sg-cell sg-u-waiting" /> Unscheduled, waiting</span>
        <span><i className="sg-cell sg-s-repair" /> Scheduled, in repair</span>
        <span><i className="sg-cell sg-s-waiting" /> Scheduled, waiting</span>
        <span><i className="sg-cell sg-up" /> Up</span>
        <span><i className="sg-cell sg-mixed" /> Dot: more than one state in the hour</span>
      </div>
      {grid.rows.length === 0 ? <p className="card muted">No unit was down in this window.</p> : (
        <div className="card table-wrap" style={{ padding: 0 }}>
          <table className="sg">
            <thead>
              <tr>
                <th className="sg-unit">Unit</th>
                {grid.hours.map((h) => <th key={h.from} className="sg-h">{h.label.replace(':00', '')}</th>)}
                <th className="num">Down</th>
                <th className="num">In repair</th>
              </tr>
            </thead>
            <tbody>
              {grid.rows.map((r) => (
                <tr key={r.assetId}>
                  <td className="sg-unit"><a href={`#/unit/${r.assetId}`}>{r.unitNumber}</a> <span className="muted small">{r.model}</span></td>
                  {r.cells.map((c, i) => (
                    <td key={c.from} className="sg-td">
                      <span
                        className={`sg-cell ${c.kind === 'future' ? 'sg-future' : c.kind === 'up' ? 'sg-up' : `sg-${c.type === 'scheduled' ? 's' : 'u'}-${c.kind}`}${c.mixed ? ' sg-mixed' : ''}`}
                        title={cellTitle(c, grid.hours[i]!.label, stageName)}
                        role="img"
                        aria-label={`${r.unitNumber} ${grid.hours[i]!.label}: ${c.kind === 'future' ? 'not yet' : `${c.type ?? ''} ${STATE_WORD[c.kind]}`.trim()}`}
                      />
                    </td>
                  ))}
                  <td className="num">{fmtHours(r.downHours)}</td>
                  <td className="num">{fmtHours(r.repairHours)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="small muted">Each cell is one hour, coloured by the state that held most of it. Hover for the exact minutes by stage. Calculated from the same stage intervals as the status board and KPIs; nothing here is typed.</p>
    </div>
  );
}
