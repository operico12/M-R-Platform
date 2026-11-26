// History (docs/history.md): every downtime event, newest first, to search, filter, sort, page, export and open.
// A view over the flags; open a row for each flag's comments, time breakdown and changes.

import { EMPTY_HISTORY_FILTER, commentCounts, filterHistory, historyCsv, historyRows, sortHistory, type HistoryFilter, type HistorySortKey } from '@mr/core';
import { Fragment, useMemo, useState } from 'react';
import { FlagDetail } from '../components/FlagHistoryPanel';
import { fmtHours, siteTime } from '../format';
import { useApp } from '../store';

const PAGE_SIZES = [25, 50, 100];

export function History() {
  const app = useApp();
  const tz = app.ds.site.timeZone;
  const [f, setF] = useState<HistoryFilter>(EMPTY_HISTORY_FILTER);
  const [sort, setSort] = useState<{ key: HistorySortKey; dir: 'asc' | 'desc' }>({ key: 'start', dir: 'desc' });
  const [size, setSize] = useState(25);
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);

  const all = useMemo(
    () => historyRows({ assets: app.ds.assets, flags: app.flags, lines: app.ds.shopLines, rules: app.rules, now: app.now }),
    [app.ds.assets, app.flags, app.ds.shopLines, app.rules, app.now],
  );
  const rows = useMemo(() => sortHistory(filterHistory(all, f, tz), sort.key, sort.dir), [all, f, tz, sort]);
  const counts = useMemo(() => commentCounts(app.comments), [app.comments]);
  const systems = useMemo(() => [...new Set(all.map((r) => r.system).filter(Boolean))].sort(), [all]);
  const models = useMemo(() => [...new Set(all.map((r) => r.model).filter(Boolean))].sort(), [all]);
  const asset = (id: string) => app.ds.assets.find((a) => a.id === id)!;

  const pages = Math.max(1, Math.ceil(rows.length / size));
  const cur = Math.min(page, pages);
  const visible = rows.slice((cur - 1) * size, cur * size);
  const set = (patch: Partial<HistoryFilter>) => { setF({ ...f, ...patch }); setPage(1); };
  const active = JSON.stringify(f) !== JSON.stringify(EMPTY_HISTORY_FILTER);

  const head = (key: HistorySortKey, label: string, cls?: string) => (
    <th className={cls} aria-sort={sort.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className="linkish" onClick={() => setSort(sort.key === key ? { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'start' || key === 'end' || key === 'down' ? 'desc' : 'asc' })}>
        {label}{sort.key === key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
      </button>
    </th>
  );

  const download = () => {
    const url = URL.createObjectURL(new Blob([historyCsv(rows, (iso) => siteTime(iso, tz, true))], { type: 'text/csv' }));
    const el = document.createElement('a');
    el.href = url;
    el.download = `history-${f.from || 'all'}-to-${f.to || 'now'}.csv`;
    el.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="stack">
      <div className="page-head">
        <h2>History</h2>
        <span className="muted small">{rows.length} of {all.length} downtime events · site time {tz}</span>
      </div>
      <div className="row">
        <input value={f.q} onChange={(e) => set({ q: e.target.value })} placeholder="Search unit, reason, system, component, work order…" aria-label="Search" style={{ minWidth: 260 }} />
        <label className="small">From <input type="date" value={f.from} onChange={(e) => set({ from: e.target.value })} /></label>
        <label className="small">To <input type="date" value={f.to} onChange={(e) => set({ to: e.target.value })} /></label>
        <label className="small">Type{' '}
          <select value={f.type} onChange={(e) => set({ type: e.target.value as HistoryFilter['type'] })}>
            <option value="all">All</option><option value="unscheduled">Unscheduled</option><option value="scheduled">Scheduled</option>
          </select>
        </label>
        <label className="small">State{' '}
          <select value={f.state} onChange={(e) => set({ state: e.target.value as HistoryFilter['state'] })}>
            <option value="all">All</option><option value="open">Open</option><option value="released">Released</option>
          </select>
        </label>
      </div>
      <div className="row">
        <label className="small">System{' '}
          <select value={f.system} onChange={(e) => set({ system: e.target.value })}><option value="">All</option>{systems.map((s) => <option key={s} value={s}>{s}</option>)}</select>
        </label>
        <label className="small">Model{' '}
          <select value={f.model} onChange={(e) => set({ model: e.target.value })}><option value="">All</option>{models.map((s) => <option key={s} value={s}>{s}</option>)}</select>
        </label>
        <label className="small">Down h, min <input type="number" min={0} style={{ width: 72 }} value={f.minHours ?? ''} onChange={(e) => set({ minHours: e.target.value === '' ? null : Math.max(0, Number(e.target.value)) })} /></label>
        <label className="small">max <input type="number" min={0} style={{ width: 72 }} value={f.maxHours ?? ''} onChange={(e) => set({ maxHours: e.target.value === '' ? null : Math.max(0, Number(e.target.value)) })} /></label>
        <button type="button" className="chip" aria-pressed={f.failuresOnly} onClick={() => set({ failuresOnly: !f.failuresOnly })}>Failures only</button>
        {active && <button type="button" className="linkish small" onClick={() => { setF(EMPTY_HISTORY_FILTER); setPage(1); }}>Clear filters</button>}
        <button type="button" className="btn" style={{ marginLeft: 'auto' }} onClick={download} disabled={rows.length === 0}>Download CSV ({rows.length})</button>
      </div>

      {rows.length === 0 ? <p className="card muted">{all.length === 0 ? 'No downtime events yet.' : 'No event matches these filters.'}</p> : (
        <div className="card table-wrap" style={{ padding: 0 }}>
          <table>
            <thead>
              <tr>
                {head('unit', 'Unit')}{head('model', 'Model')}{head('start', 'Start')}{head('end', 'End')}{head('down', 'Down', 'num')}
                <th>Type</th>{head('system', 'System')}<th>Reason · component · mode</th><th>Where</th>
                <th className="num">In repair</th><th className="num">Waiting</th><th className="num">To 1st wrench</th><th>Work orders</th><th /> 
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => {
                const isOpen = open === r.eventId;
                const nComments = r.flags.reduce((s, x) => s + (counts.get(x.id) ?? 0), 0);
                return (
                  <Fragment key={r.eventId}>
                    <tr>
                      <td><a href={`#/unit/${r.unitId}`}><strong>{r.unitNumber}</strong></a></td>
                      <td>{r.model}</td>
                      <td>{siteTime(r.start, tz, true)}</td>
                      <td>{r.end ? siteTime(r.end, tz, true) : <span className="status down">open</span>}</td>
                      <td className="num">{fmtHours(r.downHours)}</td>
                      <td>{r.types.map((t) => (t === 'scheduled' ? '▲' : '■')).join('')} {r.types.length > 1 ? r.types.join(' → ') : r.types[0]}{r.isMinorStop ? ' · minor stop' : ''}</td>
                      <td>{r.system || <span className="muted">—</span>}</td>
                      <td>{[r.reason, r.component, r.failureModes.join(', ')].filter(Boolean).join(' · ')}</td>
                      <td>{r.where}</td>
                      <td className="num">{fmtHours(r.inRepairHours)}</td>
                      <td className="num">{fmtHours(r.waitingHours)}</td>
                      <td className="num">{r.firstWrenchHours === null ? '—' : fmtHours(r.firstWrenchHours)}</td>
                      <td>{r.workOrders.join(', ') || <span className="muted">—</span>}</td>
                      <td><button type="button" className="linkish" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : r.eventId)}>{isOpen ? 'Close' : 'Open'}{nComments ? ` · ${nComments}` : ''}</button></td>
                    </tr>
                    {isOpen && (
                      <tr className="fc-row">
                        <td colSpan={14}>
                          {r.flags.map((fl) => (
                            <div key={fl.id} style={{ marginBottom: 12 }}>
                              {r.flags.length > 1 && <h4 style={{ margin: '0 0 6px' }}>{fl.type === 'scheduled' ? '▲ Scheduled' : '■ Unscheduled'} · {siteTime(fl.start, tz, true)} – {fl.end ? siteTime(fl.end, tz, true) : 'now'}</h4>}
                              <FlagDetail asset={asset(r.unitId)} flag={fl} commentCount={counts.get(fl.id) ?? 0} />
                            </div>
                          ))}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <label className="small">Rows per page{' '}
          <select value={size} onChange={(e) => { setSize(Number(e.target.value)); setPage(1); }}>{PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}</select>
        </label>
        <div className="row">
          <button type="button" className="btn" disabled={cur <= 1} onClick={() => setPage(cur - 1)}>Previous</button>
          <span className="small">{cur} / {pages}</span>
          <button type="button" className="btn" disabled={cur >= pages} onClick={() => setPage(cur + 1)}>Next</button>
        </div>
      </div>
      <p className="small muted">One row per downtime event: flags linked by a type switch are one event. Dates are site dates and filter on the event start. Open a row for each flag's comments, time breakdown and changes.</p>
    </div>
  );
}
