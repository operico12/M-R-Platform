// Down list (docs/down-list.md): every down unit in one sortable table with what it is waiting for, the latest
// comment and when it is expected back. A view over existing records; nothing here is typed or stored.

import { EMPTY_DOWN_FILTER, STAGES, STAGE_LABELS, downList, downListCsv, filterDownList, sortDownList, type DownListFilter, type DownSortKey, type Stage } from '@mr/core';
import { useMemo, useState } from 'react';
import { fmtHours, hoursSince, siteTime } from '../format';
import { useApp } from '../store';

const COLS: Array<[DownSortKey, string, string?]> = [
  ['unit', 'Unit'], ['type', 'Type'], ['stage', 'Stage'], ['location', 'Location'], ['down', 'Down', 'num'], ['expected', 'Expected back'], ['comment', 'Last comment'],
];

export function DownList() {
  const app = useApp();
  const tz = app.ds.site.timeZone;
  const [f, setF] = useState<DownListFilter>(EMPTY_DOWN_FILTER);
  const [sort, setSort] = useState<{ key: DownSortKey; dir: 'asc' | 'desc' }>({ key: 'down', dir: 'desc' });
  const waitLabel = (k: string) => app.waitKinds.find((x) => x.code === k)?.label ?? k;

  const all = useMemo(
    () => downList({ assets: app.ds.assets, flags: app.flags, waits: app.waits, comments: app.comments, lines: app.ds.shopLines, now: app.now, waitLabel }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [app.ds.assets, app.flags, app.waits, app.comments, app.ds.shopLines, app.now],
  );
  const rows = useMemo(() => sortDownList(filterDownList(all, f, app.now), sort.key, sort.dir), [all, f, app.now, sort]);

  const head = (key: DownSortKey, label: string, cls?: string) => (
    <th key={key} className={cls} aria-sort={sort.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className="linkish" onClick={() => setSort(sort.key === key ? { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'down' || key === 'comment' ? 'desc' : 'asc' })}>
        {label}{sort.key === key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
      </button>
    </th>
  );

  const download = () => {
    const url = URL.createObjectURL(new Blob([downListCsv(rows, (iso) => siteTime(iso, tz, true), app.userName)], { type: 'text/csv' }));
    const el = document.createElement('a');
    el.href = url;
    el.download = 'down-list.csv';
    el.click();
    URL.revokeObjectURL(url);
  };
  const clear = () => setF(EMPTY_DOWN_FILTER);
  const active = JSON.stringify(f) !== JSON.stringify(EMPTY_DOWN_FILTER);

  return (
    <div className="stack">
      <div className="page-head">
        <h2>Down list</h2>
        <span className="muted small">{rows.length} of {all.length} down unit{all.length === 1 ? '' : 's'} · site time {tz}</span>
      </div>
      <div className="row">
        <input value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} placeholder="Search unit, reason, location, waiting for, comment…" aria-label="Search" style={{ minWidth: 260 }} />
        <label className="small">Type{' '}
          <select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value as DownListFilter['type'] })}>
            <option value="all">All</option><option value="unscheduled">Unscheduled</option><option value="scheduled">Scheduled</option>
          </select>
        </label>
        <label className="small">Stage{' '}
          <select value={f.stage} onChange={(e) => setF({ ...f, stage: e.target.value as Stage | 'all' })}>
            <option value="all">All</option>{STAGES.map((s) => <option key={s} value={s}>{STAGE_LABELS[s]}</option>)}
          </select>
        </label>
        <button type="button" className="chip" aria-pressed={f.late} onClick={() => setF({ ...f, late: !f.late })}>Late</button>
        <button type="button" className="chip" aria-pressed={f.noEta} onClick={() => setF({ ...f, noEta: !f.noEta })}>No ETA</button>
        <button type="button" className="chip" aria-pressed={f.quiet} onClick={() => setF({ ...f, quiet: !f.quiet })}>No comment in 24 h</button>
        {active && <button type="button" className="linkish small" onClick={clear}>Clear filters</button>}
        <button type="button" className="btn" style={{ marginLeft: 'auto' }} onClick={download} disabled={rows.length === 0}>Download CSV</button>
      </div>
      {rows.length === 0 ? <p className="card muted">{all.length === 0 ? 'Nothing is down.' : 'No unit matches these filters.'}</p> : (
        <div className="card table-wrap" style={{ padding: 0 }}>
          <table>
            <thead>
              <tr>
                {COLS.slice(0, 7).map(([k, l, c]) => (k === 'comment' ? null : head(k, l, c)))}
                <th>Waiting for</th>
                {head('comment', 'Last comment')}
                <th>Work orders</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.flagId}>
                  <td><a href={`#/unit/${r.unitId}`}><strong>{r.unitNumber}</strong></a> <span className="muted small">{r.model}</span></td>
                  <td><span className={`status ${r.type === 'scheduled' ? 'sched' : 'down'}`}>{r.type === 'scheduled' ? '▲' : '■'}</span> {r.type}</td>
                  <td>{r.stageLabel} <span className="muted small">{fmtHours(r.stageHours)}</span></td>
                  <td>{r.location}</td>
                  <td className="num">{fmtHours(r.downHours)}</td>
                  <td>
                    {r.expectedBack ? (
                      <span className={r.late ? 'status down' : undefined} title={r.expectedSource === 'plan' ? 'Start plus planned hours' : 'Latest ETA'}>
                        {siteTime(r.expectedBack, tz, true)}{r.expectedSource === 'plan' ? ' (plan)' : ''}{r.late ? ' · late' : ''}
                      </span>
                    ) : <span className="muted">No ETA</span>}
                  </td>
                  <td>{r.waiting.length ? <div className="chips">{r.waiting.map((w) => <span key={w} className="chip static">{w}</span>)}</div> : <span className="muted">—</span>}</td>
                  <td style={{ maxWidth: 340 }}>
                    {r.lastComment ? (
                      <>
                        <div className="dl-comment">{r.lastComment.text}</div>
                        <div className="small muted">{app.userName(r.lastComment.by)} · {fmtHours(hoursSince(r.lastComment.at, app.now))} ago{r.commentCount > 1 ? ` · ${r.commentCount} comments` : ''}</div>
                      </>
                    ) : <span className="muted">No comments</span>}
                  </td>
                  <td>{r.workOrders.join(', ') || <span className="muted">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="small muted">Expected back is the latest ETA that was set, or start plus planned hours for scheduled work (marked plan). It is what people entered, not a forecast. Open a unit to read every comment.</p>
    </div>
  );
}
