// Shop lines (plan 4.2, Figure 6, docs/shop-lines.md). Units that need a line, with a picker to put
// them on one; a tile per line with what is in it; closing and opening lines; and, for the Admin,
// adding, editing and retiring lines. Every change runs a core command.

import {
  LINE_LIMITS, LINE_TYPE_LABELS, LINE_TYPES, STAGE_LABELS, addLines, can, closeLine, closureNow, currentLocation, currentStage, editLine,
  lineName, lineOccupancy, moveLocation, openLine, openWaits, retireLine, unitsOnLine,
  type Asset, type DownFlag, type ShopLine,
} from '@mr/core';
import { useMemo, useState } from 'react';
import { FlagIcon } from '../components/FlagIcon';
import { FlagSheet } from '../components/FlagSheet';
import { fmtHours, fmtPct, hoursSince, locationLabel, siteTime } from '../format';
import { useApp } from '../store';

export function ShopLines() {
  const app = useApp();
  const tz = app.ds.site.timeZone;
  const [open, setOpen] = useState<Asset | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [manage, setManage] = useState(false);
  const unit = (id: string) => app.ds.assets.find((a) => a.id === id);
  const hrs = (iso?: string | null) => (iso ? fmtHours(hoursSince(iso, app.now)) : '');
  const waitLabel = (code: string) => app.waitKinds.find((x) => x.code === code)?.label ?? code;
  const openFlags = app.flags.filter((f) => f.state === 'open');
  const week = { from: new Date(Date.parse(app.now) - 7 * 864e5).toISOString(), to: app.now };

  const lines = useMemo(() => app.ds.shopLines.map((l) => ({
    l,
    closure: closureNow(l.id, app.ds.closures, app.now),
    inLine: unitsOnLine(l.id, app.flags),
    occ: lineOccupancy(l, app.flags, app.ds.closures, week, app.now).occupancy,
  // eslint-disable-next-line react-hooks/exhaustive-deps
  })), [app.ds.shopLines, app.ds.closures, app.flags, app.now]);

  // Down units that are not on a line: in the field, towing, or in the yard waiting for a line. Longest down first.
  const needLine = openFlags
    .filter((f) => { const k = currentLocation(f)?.kind; return k === 'field' || k === 'towing' || k === 'shop_yard'; })
    .filter((f) => unit(f.unitId)?.assetClass !== 'fixed_plant')
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const hasRoom = (x: (typeof lines)[number]) => !x.closure && x.inLine.length < x.l.capacity;
  const fits = (l: ShopLine, a?: Asset) => !a || l.fits.length === 0 || l.fits.includes(a.model);
  const roomFor = (a?: Asset) => lines.filter((x) => hasRoom(x) && fits(x.l, a));

  const inUse = lines.filter((x) => x.inLine.length > 0).length;
  const closed = lines.filter((x) => x.closure).length;
  const free = lines.filter(hasRoom).length;

  const putOnLine = (f: DownFlag, lineId: string) => {
    const a = unit(f.unitId);
    if (!a) return;
    const l = app.ds.shopLines.find((x) => x.id === lineId);
    const r = app.run(a, (ctx) => moveLocation(ctx, f, { kind: 'shop_line', shopLineId: lineId }));
    setMsg(r.ok ? { ok: true, text: `${a.unitNumber} is on ${l ? lineName(l) : 'the line'}.` } : { ok: false, text: r.errors.join(' ') });
  };

  const canClose = (l: ShopLine) => can(app.actor, 'open_close_line', l.shop);
  const canManage = can(app.actor, 'edit_shop_structure');

  const etaOf = (f: DownFlag) => {
    const eta = f.etas.at(-1);
    if (eta) {
      const late = Date.parse(eta.eta) < Date.parse(app.now);
      return <span className={`fchip ${late ? 'ch-late' : 'ch-muted'}`}><span className="fchip-l"><FlagIcon code="eta" size={13} /> {late ? 'ETA passed' : 'ETA'} {siteTime(eta.eta, tz, true)}</span></span>;
    }
    if (hoursSince(f.start, app.now) >= app.rules.etaRequiredAfterHours) return <span className="fchip ch-late"><span className="fchip-l"><FlagIcon code="eta" size={13} /> No ETA</span></span>;
    return null;
  };
  const waits = (f: DownFlag) => openWaits(f.unitId, app.waits).map((w) => (
    <span key={w.id} className="fchip ch-wait"><span className="fchip-l"><FlagIcon code={w.kind} size={13} /> {waitLabel(w.kind)}</span><span className="fchip-t">{hrs(w.start)}</span></span>
  ));

  return (
    <div className="stack shoplines">
      <div className="page-head">
        <h2>Shop lines</h2>
        {canManage && <button type="button" className="btn" onClick={() => setManage(!manage)} aria-expanded={manage}>{manage ? 'Done managing' : 'Manage lines'}</button>}
      </div>

      <div className="sl-summary" aria-label="Lines summary">
        <span className="sl-stat"><strong>{inUse}</strong> of {lines.length - closed} open lines in use</span>
        <span className="sl-stat sl-free"><strong>{free}</strong> free</span>
        {closed > 0 && <span className="sl-stat sl-closed"><strong>{closed}</strong> closed</span>}
        <span className={`sl-stat${needLine.length ? ' sl-need' : ''}`}><strong>{needLine.length}</strong> {needLine.length === 1 ? 'unit needs' : 'units need'} a line</span>
      </div>

      {msg && <div className={msg.ok ? 'card small' : 'errors'} role="status">{msg.text}</div>}

      {manage && canManage && <ManageLines onMsg={setMsg} />}

      <section aria-label="Needs a line">
        <h3 className="sl-h">Needs a line <span className="muted">· {needLine.length}</span></h3>
        {needLine.length === 0 ? <p className="small muted">No down unit is waiting for a line.</p> : (
          <div className="sl-need-grid">
            {needLine.map((f) => {
              const a = unit(f.unitId);
              const st = currentStage(f);
              const options = roomFor(a);
              return (
                <div key={f.id} className={`sl-need-card ${f.type === 'scheduled' ? 'sn-sched' : 'sn-unsched'}`}>
                  <button type="button" className="sl-unit linkish" onClick={() => a && setOpen(a)}>
                    <strong>{a?.unitNumber ?? f.unitId}</strong> <span className="muted small">{a?.model}</span>
                  </button>
                  <span className="sl-down">down {hrs(f.start)}</span>
                  <div className="sl-reason">{f.reasonCode} <span className="muted">· {locationLabel(f, app.ds)}</span></div>
                  <div className="small"><FlagIcon code={st?.stage ?? 'no_stage'} size={14} /> {st ? STAGE_LABELS[st.stage] : 'No stage'} <span className="muted">{hrs(st?.start)}</span></div>
                  <div className="chips">{waits(f)}{etaOf(f)}</div>
                  <label className="sl-put">
                    <span className="small muted">Put on a line</span>
                    <select value="" onChange={(e) => e.target.value && putOnLine(f, e.target.value)} disabled={options.length === 0}>
                      <option value="">{options.length ? 'Choose a line…' : 'No free line fits'}</option>
                      {options.map((x) => <option key={x.l.id} value={x.l.id}>{lineName(x.l)} · {LINE_TYPE_LABELS[x.l.lineType]}</option>)}
                    </select>
                  </label>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section aria-label="Lines">
        <h3 className="sl-h">Lines <span className="muted">· occupancy over the last 7 days, closed time left out</span></h3>
        {lines.length === 0 ? <p className="small muted">No lines yet.{canManage ? ' Press Manage lines to add them.' : ' The Admin adds them.'}</p> : (
          <div className="sl-grid">
            {lines.map(({ l, closure, inLine, occ }) => (
              <LineTile key={l.id} l={l} closure={closure} inLine={inLine} occ={occ} need={needLine.filter((f) => fits(l, unit(f.unitId)))}
                canClose={canClose(l)} onPick={(a) => setOpen(a)} onPut={putOnLine} onMsg={setMsg} waits={waits} etaOf={etaOf} />
            ))}
          </div>
        )}
      </section>

      {open && <FlagSheet asset={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function LineTile({ l, closure, inLine, occ, need, canClose, onPick, onPut, onMsg, waits, etaOf }: {
  l: ShopLine; closure?: { reason: string; start: string }; inLine: DownFlag[]; occ: number | null; need: DownFlag[]; canClose: boolean;
  onPick: (a: Asset) => void; onPut: (f: DownFlag, lineId: string) => void; onMsg: (m: { ok: boolean; text: string } | null) => void;
  waits: (f: DownFlag) => JSX.Element[]; etaOf: (f: DownFlag) => JSX.Element | null;
}) {
  const app = useApp();
  const [closing, setClosing] = useState(false);
  const [reason, setReason] = useState('');
  const unit = (id: string) => app.ds.assets.find((a) => a.id === id);
  const hrs = (iso?: string | null) => (iso ? fmtHours(hoursSince(iso, app.now)) : '');
  const full = inLine.length >= l.capacity;
  const state = closure ? 'closed' : inLine.length ? (full ? 'full' : 'part') : 'free';
  const doClose = () => {
    const r = app.runClosures((ctx) => closeLine(ctx, l, app.ds.closures, app.flags, reason));
    if (r.ok) { setClosing(false); setReason(''); onMsg({ ok: true, text: `${lineName(l)} is closed.` }); } else onMsg({ ok: false, text: r.errors.join(' ') });
  };
  const doOpen = () => {
    const r = app.runClosures((ctx) => openLine(ctx, l, app.ds.closures));
    onMsg(r.ok ? { ok: true, text: `${lineName(l)} is open again.` } : { ok: false, text: r.errors.join(' ') });
  };
  return (
    <div className={`sl-tile st-${state}`}>
      <div className="sl-tile-head">
        <strong className="sl-name">{lineName(l)}</strong>
        <span className="sl-type">{LINE_TYPE_LABELS[l.lineType]}</span>
        {l.capacity > 1 && <span className="muted small">{inLine.length}/{l.capacity}</span>}
      </div>
      {closure ? (
        <div className="sl-closed-body">
          <div><FlagIcon code="closed" size={14} /> <strong>Closed</strong> {hrs(closure.start)}</div>
          <div className="small muted">{closure.reason}</div>
          {canClose && <button type="button" className="btn" onClick={doOpen}>Open line</button>}
        </div>
      ) : (
        <>
          {inLine.map((f) => {
            const a = unit(f.unitId);
            const st = currentStage(f);
            return (
              <button key={f.id} type="button" className={`sl-occupant ${f.type === 'scheduled' ? 'so-sched' : 'so-unsched'}`} onClick={() => a && onPick(a)}>
                <span className="sl-occ-top"><strong>{a?.unitNumber}</strong><span className="muted small">{a?.model}</span><span className="sl-in">{hrs(currentLocation(f)?.start)} in line</span></span>
                <span className="sl-reason">{f.reasonCode}</span>
                <span className="small"><FlagIcon code={st?.stage ?? 'no_stage'} size={14} /> {st ? STAGE_LABELS[st.stage] : 'No stage'} <span className="muted">{hrs(st?.start)}</span></span>
                <span className="chips">{waits(f)}{etaOf(f)}</span>
              </button>
            );
          })}
          {!full && (
            <div className="sl-free-body">
              {inLine.length === 0 && <div className="sl-free-word">Free</div>}
              {need.length > 0 && (
                <select value="" aria-label={`Put a unit on ${lineName(l)}`} onChange={(e) => { const f = need.find((x) => x.id === e.target.value); if (f) onPut(f, l.id); }}>
                  <option value="">Put a unit here…</option>
                  {need.map((f) => <option key={f.id} value={f.id}>{unit(f.unitId)?.unitNumber} · {f.reasonCode} · down {hrs(f.start)}</option>)}
                </select>
              )}
            </div>
          )}
          {canClose && inLine.length === 0 && (closing ? (
            <div className="sl-close-form">
              <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why close it? e.g. crane inspection" aria-label="Reason for closing" />
              <div className="row" style={{ gap: 6 }}>
                <button type="button" className="btn danger" disabled={!reason.trim()} onClick={doClose}>Close line</button>
                <button type="button" className="btn" onClick={() => setClosing(false)}>Cancel</button>
              </div>
            </div>
          ) : <button type="button" className="linkish small sl-close-link" onClick={() => setClosing(true)}>Close this line</button>)}
        </>
      )}
      <div className="sl-occ" title="Occupancy over the last 7 days">
        <span className="sl-occ-bar"><span style={{ width: `${Math.round((occ ?? 0) * 100)}%` }} /></span>
        <span className="small muted">{fmtPct(occ, 0)} used</span>
      </div>
    </div>
  );
}

function ManageLines({ onMsg }: { onMsg: (m: { ok: boolean; text: string } | null) => void }) {
  const app = useApp();
  const [count, setCount] = useState(1);
  const [type, setType] = useState<ShopLine['lineType']>('general');
  const shop = app.ds.shopLines[0]?.shop ?? 'Main shop';
  const add = () => {
    const r = app.runLines((ctx) => addLines(ctx, app.ds.shopLines, count, type, app.ds.site.id, shop));
    onMsg(r.ok ? { ok: true, text: `Added ${count} ${count === 1 ? 'line' : 'lines'}.` } : { ok: false, text: r.errors.join(' ') });
  };
  return (
    <section className="card stack sl-manage" aria-label="Manage lines">
      <h3 style={{ margin: 0 }}>Manage lines</h3>
      <div className="row" style={{ gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <label className="field" style={{ width: 110 }}><span>How many</span>
          <input type="number" min={1} max={LINE_LIMITS.maxAdd} value={count} onChange={(e) => setCount(Number(e.target.value))} /></label>
        <label className="field" style={{ width: 160 }}><span>Type</span>
          <select value={type} onChange={(e) => setType(e.target.value as ShopLine['lineType'])}>{LINE_TYPES.map((t) => <option key={t} value={t}>{LINE_TYPE_LABELS[t]}</option>)}</select></label>
        <button type="button" className="btn primary" onClick={add}>Add lines</button>
      </div>
      <p className="small muted" style={{ margin: 0 }}>New lines take the next free numbers. Change a line below and press Save. Retiring keeps the line's history; a line with a unit in it cannot be retired.</p>
      <div className="sl-manage-list">
        {app.ds.shopLines.map((l) => <LineEditor key={l.id} l={l} onMsg={onMsg} />)}
      </div>
    </section>
  );
}

function LineEditor({ l, onMsg }: { l: ShopLine; onMsg: (m: { ok: boolean; text: string } | null) => void }) {
  const app = useApp();
  const [num, setNum] = useState(l.number === undefined ? '' : String(l.number));
  const [name, setName] = useState(l.name ?? '');
  const [type, setType] = useState(l.lineType);
  const [cap, setCap] = useState(l.capacity);
  const [fits, setFits] = useState(l.fits.join(', '));
  const [retiring, setRetiring] = useState(false);
  const [reason, setReason] = useState('');
  const dirty = num !== (l.number === undefined ? '' : String(l.number)) || name !== (l.name ?? '') || type !== l.lineType || cap !== l.capacity || fits !== l.fits.join(', ');
  const save = () => {
    const r = app.runLines((ctx) => editLine(ctx, app.ds.shopLines, l.id, { number: num.trim() ? Number(num) : undefined, name, lineType: type, capacity: cap, fits: fits.split(',') }));
    onMsg(r.ok ? { ok: true, text: 'Saved.' } : { ok: false, text: r.errors.join(' ') });
  };
  const retire = () => {
    const r = app.runLines((ctx) => retireLine(ctx, app.ds.shopLines, app.flags, l.id, reason));
    onMsg(r.ok ? { ok: true, text: `${lineName(l)} is retired.` } : { ok: false, text: r.errors.join(' ') });
  };
  return (
    <div className="sl-edit">
      <label className="field"><span>No.</span><input inputMode="numeric" value={num} onChange={(e) => setNum(e.target.value.replace(/\D/g, ''))} /></label>
      <label className="field"><span>Name</span><input value={name} maxLength={LINE_LIMITS.nameMax} onChange={(e) => setName(e.target.value)} placeholder="optional" /></label>
      <label className="field"><span>Type</span><select value={type} onChange={(e) => setType(e.target.value as ShopLine['lineType'])}>{LINE_TYPES.map((t) => <option key={t} value={t}>{LINE_TYPE_LABELS[t]}</option>)}</select></label>
      <label className="field"><span>Units</span><input type="number" min={1} max={LINE_LIMITS.maxCapacity} value={cap} onChange={(e) => setCap(Number(e.target.value))} /></label>
      <label className="field"><span>Models that fit</span><input value={fits} onChange={(e) => setFits(e.target.value)} placeholder="any" /></label>
      <div className="sl-edit-actions">
        <button type="button" className="btn primary" disabled={!dirty} onClick={save}>Save</button>
        {retiring ? (
          <>
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason" aria-label="Reason for retiring" />
            <button type="button" className="btn danger" disabled={!reason.trim()} onClick={retire}>Retire</button>
            <button type="button" className="btn" onClick={() => setRetiring(false)}>Cancel</button>
          </>
        ) : <button type="button" className="btn" onClick={() => setRetiring(true)}>Retire…</button>}
      </div>
    </div>
  );
}
