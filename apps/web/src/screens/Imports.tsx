// Data import (MVP screen 6, plan 6.2 and 6.3). Pick a file, see what it would
// change and every problem found, then load it. Nothing is loaded until the
// data owner presses Load, and loading never deletes anything.

import {
  DQ_RULE_LABELS,
  MAXIMO_DEFAULT_MAPPING,
  can,
  detectKind,
  formatSourceDate,
  importAssets,
  importScore,
  importSmu,
  importWorkOrders,
  parseCsv,
  toCsv,
  toSourceCsv,
  type ImportKind,
  type ImportResult,
  type Table,
} from '@mr/core';
import { useMemo, useState } from 'react';
import { fmtPct, siteTime } from '../format';
import { useApp } from '../store';

const KIND_LABEL: Record<ImportKind, string> = { assets: 'Asset list', work_orders: 'Work orders', smu: 'SMU readings' };

export function Imports() {
  const app = useApp();
  const tz = app.ds.site.timeZone;
  const [file, setFile] = useState<{ name: string; table: Table } | null>(null);
  const [kind, setKind] = useState<ImportKind | null>(null);
  const [loaded, setLoaded] = useState<string | null>(null);
  const allowed = can(app.actor, 'manage_imports');

  const preview: ImportResult<unknown> | null = useMemo(() => {
    if (!file || !kind) return null;
    const ctx = { tenantId: app.ds.tenantId, siteId: app.ds.site.id, timeZone: tz, now: new Date().toISOString(), newId: app.newId };
    if (kind === 'assets') return importAssets(file.table, app.ds.assets, ctx);
    if (kind === 'work_orders') return importWorkOrders(file.table, app.ds.workOrders, app.ds.assets, ctx);
    return importSmu(file.table, app.ds.smu, app.ds.assets, ctx);
  }, [file, kind, app.ds]);

  const open = (name: string, text: string) => {
    const table = parseCsv(text);
    setFile({ name, table });
    setKind(detectKind(table.header));
    setLoaded(null);
  };
  const onFile = async (f: File | undefined) => {
    if (f) open(f.name, await f.text());
  };
  const load = () => {
    if (!file || !preview) return;
    app.applyImport(file.name, preview);
    setLoaded(file.name);
    setFile(null);
  };

  const exports = () => toSourceCsv(app.ds, tz);
  const errors = preview?.issues.filter((i) => i.severity === 'error') ?? [];
  const warnings = preview?.issues.filter((i) => i.severity === 'warning') ?? [];

  return (
    <div className="stack">
      <div className="page-head"><h2>Data import</h2><span className="muted small">Maximo exports as CSV · times read in site time ({tz})</span></div>

      <section className="card">
        <h3>1. Choose a file</h3>
        <p className="small muted">An asset list, a work order export or SMU readings. The kind is worked out from the columns. Load the asset list first, so work orders and readings can find their units.</p>
        <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
          <label className="btn primary">
            Choose CSV file
            <input type="file" accept=".csv,text/csv" hidden onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = ''; }} />
          </label>
          <button className="btn" onClick={() => open('sample-smu-with-problems.csv', sampleSmu(app.ds))}>Try sample SMU file (with problems)</button>
          <button className="btn" onClick={() => open('sample-workorders-update.csv', sampleWorkOrders(app.ds))}>Try sample work order update</button>
        </div>
        <p className="small muted" style={{ marginTop: 12 }}>
          Download the current data in Maximo layout:{' '}
          <a href="#/import" onClick={(e) => { e.preventDefault(); download('assets.csv', exports().assets); }}>assets</a> ·{' '}
          <a href="#/import" onClick={(e) => { e.preventDefault(); download('workorders.csv', exports().workOrders); }}>work orders</a> ·{' '}
          <a href="#/import" onClick={(e) => { e.preventDefault(); download('meterreadings.csv', exports().smu); }}>SMU readings</a>
        </p>
        {loaded && <p className="small" role="status">✓ Loaded {loaded}. See the import history below.</p>}
      </section>

      {file && (
        <section className="card">
          <h3>2. Check what it will do · {file.name}</h3>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <label className="field" style={{ minWidth: 200 }}>
              <span>File holds</span>
              <select value={kind ?? ''} onChange={(e) => setKind((e.target.value || null) as ImportKind | null)}>
                <option value="">Not recognised: choose</option>
                {(Object.keys(KIND_LABEL) as ImportKind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
              </select>
            </label>
            <span className="small muted">{file.table.rows.length} rows · columns {file.table.header.join(', ')}</span>
          </div>

          {!kind && <p className="errors">The columns do not match the field mapping. Expected {MAXIMO_DEFAULT_MAPPING.assets.unitNumber} for assets, {MAXIMO_DEFAULT_MAPPING.workOrders.number} for work orders, or {MAXIMO_DEFAULT_MAPPING.smu.at} and {MAXIMO_DEFAULT_MAPPING.smu.hours} for SMU readings.</p>}

          {preview && (
            <>
              <div className="counts" style={{ margin: '12px 0' }}>
                <Count n={preview.stats.inserted} word="new" />
                <Count n={preview.stats.updated} word="changed" />
                <Count n={preview.stats.unchanged} word="already held" />
                <Count n={preview.stats.skipped} word="not for this site or meter" />
                <Count n={preview.stats.failed} word="refused" cls={preview.stats.failed ? 'down' : undefined} />
                <Count n={importScore(preview.stats) === null ? '—' : fmtPct(importScore(preview.stats), 0)} word="loaded cleanly" />
              </div>

              {preview.issues.length > 0 && (
                <div className="table-wrap" style={{ maxHeight: 300 }}>
                  <table>
                    <thead><tr><th>Row</th><th>Result</th><th>Check</th><th>Detail</th></tr></thead>
                    <tbody>
                      {[...errors, ...warnings].slice(0, 200).map((i, k) => (
                        <tr key={k}>
                          <td>{i.row || 'file'}</td>
                          <td><span className={`status ${i.severity === 'error' ? 'down' : 'sched'}`}>{i.severity === 'error' ? '■ Refused' : '▲ Loaded, check'}</span></td>
                          <td>{DQ_RULE_LABELS[i.rule]}</td>
                          <td>{i.message}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {preview.updated.length > 0 && (
                <details style={{ marginTop: 12 }}>
                  <summary className="small">Show changes ({preview.updated.length})</summary>
                  <ul className="small">
                    {preview.updated.slice(0, 50).map((u, k) => <li key={k}>{describeChange(u.before as Record<string, unknown>, u.after as Record<string, unknown>)}</li>)}
                  </ul>
                </details>
              )}

              <div className="row" style={{ marginTop: 16, gap: 8 }}>
                <button className="btn primary" disabled={!allowed || preview.stats.inserted + preview.stats.updated === 0} onClick={load}>
                  Load {preview.stats.inserted + preview.stats.updated} records
                </button>
                <button className="btn" onClick={() => setFile(null)}>Cancel</button>
                {!allowed && <span className="small muted">Only the Admin (data owner) can load files. Switch "Viewing as" to Admin to try it.</span>}
              </div>
              <p className="small muted">Refused rows are not loaded. Fix them in the ERP or the file and load it again; rows already held are not duplicated.</p>
            </>
          )}
        </section>
      )}

      <section className="card">
        <h3>Import history</h3>
        {app.importRuns.length === 0 ? <p className="small muted">No files loaded in this session. The demo starts from the synthetic fleet.</p> : (
          <div className="table-wrap"><table>
            <thead><tr><th>When</th><th>File</th><th>Kind</th><th className="num">New</th><th className="num">Changed</th><th className="num">Refused</th><th className="num">Warnings</th><th>By</th></tr></thead>
            <tbody>{app.importRuns.map((r) => (
              <tr key={r.id}>
                <td>{siteTime(r.at, tz, true)}</td><td>{r.fileName}</td><td>{KIND_LABEL[r.kind]}</td>
                <td className="num">{r.stats.inserted}</td><td className="num">{r.stats.updated}</td><td className="num">{r.stats.failed}</td>
                <td className="num">{r.issues.filter((i) => i.severity === 'warning').length}</td><td>{r.by}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
        <p className="small muted">Every row read is kept exactly as received, so a mapping fix can be re-run over old files (plan 6.2).</p>
      </section>
    </div>
  );
}

function Count({ n, word, cls }: { n: number | string; word: string; cls?: string }) {
  return (
    <div className="count">
      <div className={cls ? `status ${cls}` : 'small muted'}>{word}</div>
      <div className="n">{n}</div>
    </div>
  );
}

function describeChange(before: Record<string, unknown>, after: Record<string, unknown>): string {
  const name = String(after.unitNumber ?? after.number ?? '');
  const diffs = Object.keys(after).filter((k) => JSON.stringify(after[k]) !== JSON.stringify(before[k]) && k !== 'sourceModifiedAt');
  return `${name}: ${diffs.map((k) => `${k} ${before[k] ?? '—'} → ${after[k] ?? '—'}`).join(', ')}`;
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------- sample files built from the current data ----------

type Ds = ReturnType<typeof useApp>['ds'];

/** Mid-shift readings for every unit (new), plus the problems a real export has. */
function sampleSmu(ds: Ds): string {
  const tz = ds.site.timeZone;
  const rows: Array<Array<string | number>> = [['ASSETNUM', 'METERNAME', 'READINGDATE', 'READING', 'SITEID']];
  for (const a of ds.assets) {
    const rs = ds.smu.filter((r) => r.unitId === a.id).slice(-2);
    if (rs.length < 2) continue;
    const [p, q] = rs as [typeof rs[0], typeof rs[0]];
    const mid = new Date((Date.parse(p.at) + Date.parse(q.at)) / 2).toISOString();
    rows.push([a.externalAssetId ?? a.unitNumber, 'SMU', formatSourceDate(mid, tz), Math.round(((p.hours + q.hours) / 2) * 10) / 10, 'DEMO']);
  }
  const [a1, a2, a3] = ds.assets;
  const last = (id: string) => ds.smu.filter((r) => r.unitId === id).at(-1)!;
  rows.push([a1!.unitNumber, 'SMU', formatSourceDate(last(a1!.id).at, tz), last(a1!.id).hours + 3, 'DEMO']); // conflicts with the held reading
  rows.push([a2!.unitNumber, 'SMU', formatSourceDate(new Date(Date.parse(last(a2!.id).at) + 60_000).toISOString(), tz), last(a2!.id).hours + 50, 'DEMO']); // faster than the clock
  rows.push([a3!.unitNumber, 'ODOMETER', formatSourceDate(last(a3!.id).at, tz), 182_455, 'DEMO']); // not the SMU meter
  rows.push(['HT999', 'SMU', formatSourceDate(last(a3!.id).at, tz), 1200, 'DEMO']); // unknown unit
  rows.push([a3!.unitNumber, 'SMU', '31/02/2026 25:00', 1200, 'DEMO']); // bad date
  rows.push([a3!.unitNumber, 'SMU', formatSourceDate(last(a3!.id).at, tz), last(a3!.id).hours, 'NORTH']); // another site
  return toCsv(rows);
}

/** Some open backlog work completed in the ERP, two new work orders, and one for a unit we do not know. */
function sampleWorkOrders(ds: Ds): string {
  const tz = ds.site.timeZone;
  const now = new Date().toISOString();
  const rows: Array<Array<string | number | undefined>> = [['WONUM', 'ASSETNUM', 'WORKTYPE', 'STATUS', 'WOPRIORITY', 'DESCRIPTION', 'REPORTDATE', 'ACTFINISH', 'CHANGEDATE', 'SITEID']];
  const backlog = ds.workOrders.filter((w) => w.open && w.status !== 'INPRG').slice(0, 5);
  for (const w of backlog) rows.push([w.number, w.externalAssetId, w.woType, 'COMP', w.priority, w.description, formatSourceDate(w.reportedAt, tz), formatSourceDate(now, tz), formatSourceDate(now, tz), 'DEMO']);
  const a = ds.assets[4]!;
  rows.push(['990001', a.unitNumber, 'CM', 'WAPPR', '2', 'Left mirror cracked', formatSourceDate(now, tz), '', formatSourceDate(now, tz), 'DEMO']);
  rows.push(['990002', a.unitNumber, 'PM', 'APPR', '3', 'PM 500 service', formatSourceDate(now, tz), '', formatSourceDate(now, tz), 'DEMO']);
  rows.push(['990003', 'HT999', 'CM', 'WAPPR', '2', 'Unit not in register', formatSourceDate(now, tz), '', formatSourceDate(now, tz), 'DEMO']);
  return toCsv(rows);
}
