// Flag sheet: flag down in 3 taps, move the stage in 2, release through the
// checklist (plan 10.4). Every button calls a core command; the rules decide.

import {
  LOCATION_LABELS,
  STAGE_LABELS,
  SYSTEMS,
  activeCodes,
  can,
  canPropose,
  changeStage,
  confirmProposal,
  currentLocation,
  currentStage,
  flagDown,
  lineName,
  moveLocation,
  proposeDown,
  rejectProposal,
  release,
  releaseChecklist,
  setEta,
  shiftAt,
  switchType,
  voidFlag,
  currentStandby,
  endStandby,
  startStandby,
  voidStandby,
  type StandbyResult,
  type WaitResult,
  endWait,
  openWaits,
  startWait,
  voidWait,
  type Asset,
  type CommandResult,
  type DownFlag,
  type FlagType,
  type LocationKind,
  type ReleaseDetails,
  type Stage,
} from '@mr/core';
import { flagText, liveSuggestion, suggestCodes, workOrderIndex, type Ranked, PLANT_SYSTEMS, classifyAsMaintenance, classifyNotAStop, resumeAfter } from '@mr/core';
import { useMemo, useState } from 'react';
import { fmtHours, fromLocalInput, hoursSince, locationLabel, siteTime, stageLabel, toLocalInput } from '../format';
import { useApp } from '../store';
import { FlagIcon } from './FlagIcon';


export function FlagSheet({ asset, onClose }: { asset: Asset; onClose: () => void }) {
  const app = useApp();
  const plant = asset.assetClass === 'fixed_plant';
  const flag = (plant ? app.plant.flags : app.flags).find((f) => f.unitId === asset.id && (f.state === 'open' || f.state === 'proposed'));
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="sheet" role="dialog" aria-label={`${asset.unitNumber} flag`}>
        <button className="btn close" onClick={onClose} aria-label="Close">✕</button>
        <h3>
          {asset.unitNumber} <span className="muted small">{asset.model} · {asset.fleet}</span>
        </h3>
        {!flag && !plant && <StandbyPanel asset={asset} onDone={onClose} />}
        {!flag && <FlagDownForm asset={asset} onDone={onClose} />}
        {flag?.state === 'proposed' && (plant ? <PlantProposalPanel asset={asset} flag={flag} /> : <ProposalPanel asset={asset} flag={flag} />)}
        {flag?.state === 'open' && <OpenFlagPanel asset={asset} flag={flag} onDone={onClose} />}
        <p className="small muted" style={{ marginTop: 24 }}>
          {plant ? <a href="#/plant" onClick={onClose}>Open plant overview →</a> : <a href={`#/unit/${asset.id}`} onClick={onClose}>Open unit page →</a>}
        </p>
      </aside>
    </>
  );
}

// ---------- standby (docs/standby.md) ----------

function StandbyPanel({ asset, onDone }: { asset: Asset; onDone: () => void }) {
  const app = useApp();
  const tz = app.ds.site.timeZone;
  const open = currentStandby(asset.id, app.standby);
  const allowed = can(app.actor, 'set_standby', asset.fleet);
  const [reason, setReason] = useState('');
  const [start, setStart] = useState('');
  const [voidWhy, setVoidWhy] = useState('');
  const [showVoid, setShowVoid] = useState(false);
  const [r, setR] = useState<StandbyResult | null>(null);
  const label = (code: string) => app.standbyReasons.find((x) => x.code === code)?.label ?? code;
  const done = (x: StandbyResult) => { setR(x); if (x.ok) onDone(); };
  const errors = r && !r.ok ? <div className="errors" role="alert">{r.errors.map((e) => <div key={e}>{e}</div>)}</div> : null;

  if (open) {
    return (
      <section className="standby-panel">
        <div className="status standby"><FlagIcon code="standby" /> STANDBY</div>
        <p style={{ margin: '4px 0 8px' }}><FlagIcon code={open.reasonCode} /> <strong>{label(open.reasonCode)}</strong> since {siteTime(open.start, tz, true)} · {fmtHours(hoursSince(open.start, app.now))}</p>
        {open.note && <p className="small muted">{open.note}</p>}
        {allowed && (
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button className="btn primary big" onClick={() => done(app.runStandby(asset, (c) => endStandby(c, open.id, new Date().toISOString())))}>Back in use now</button>
            <button className="btn" onClick={() => setShowVoid((v) => !v)}>Raised by mistake?</button>
          </div>
        )}
        {showVoid && (
          <div className="row" style={{ gap: 8, marginTop: 8 }}>
            <input value={voidWhy} onChange={(e) => setVoidWhy(e.target.value)} placeholder="Why it was wrong" aria-label="Why it was wrong" />
            <button className="btn danger" onClick={() => done(app.runStandby(asset, (c) => voidStandby(c, open.id, voidWhy)))}>Void standby</button>
          </div>
        )}
        {errors}
        <p className="small muted">If the unit is now broken or going in for work, flag it down below. That ends the standby at the down time.</p>
      </section>
    );
  }
  if (!allowed) return null;
  return (
    <details className="standby-panel">
      <summary>Available but not in use? Start standby</summary>
      <div className="chips" role="group" aria-label="Standby reason" style={{ margin: '8px 0' }}>
        {app.standbyReasons.map((x) => (
          <button key={x.code} type="button" className="chip" aria-pressed={reason === x.code} onClick={() => setReason(x.code)}><FlagIcon code={x.code} />{x.label}</button>
        ))}
      </div>
      <label className="field"><span>Started (site time, leave blank for now)</span>
        <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} max={toLocalInput(app.now, tz)} />
      </label>
      <button className="btn primary" disabled={!reason} onClick={() => done(app.runStandby(asset, (c) => startStandby(c, { reasonCode: reason, start: start ? fromLocalInput(start, tz) : new Date().toISOString() })))}>Start standby</button>
      {errors}
      <p className="small muted">Standby does not change PA. It counts against utilisation (time) while the unit is available.</p>
    </details>
  );
}

// ---------- wait tags (docs/wait-tags.md) ----------

function WaitPanel({ asset }: { asset: Asset }) {
  const app = useApp();
  const tz = app.ds.site.timeZone;
  const open = openWaits(asset.id, app.waits);
  const allowed = can(app.actor, 'set_waits', asset.fleet);
  const [kind, setKind] = useState('');
  const [start, setStart] = useState('');
  const [note, setNote] = useState('');
  const [voiding, setVoiding] = useState<string | null>(null);
  const [voidWhy, setVoidWhy] = useState('');
  const [r, setR] = useState<WaitResult | null>(null);
  const label = (code: string) => app.waitKinds.find((k) => k.code === code)?.label ?? code;
  const go = (x: WaitResult) => { setR(x); if (x.ok) { setKind(''); setStart(''); setNote(''); setVoiding(null); setVoidWhy(''); } };
  const free = app.waitKinds.filter((k) => !open.some((w) => w.kind === k.code));
  const needNote = app.waitKinds.find((k) => k.code === kind)?.noteRequired;
  return (
    <section className="wait-panel" aria-label="Waiting for">
      <div className="wp-head">
        <strong>Waiting for</strong>
        <span className="small muted">Several can run at once. Each is timed on its own; the stage above stays as it is.</span>
      </div>
      {open.length === 0 ? <p className="small muted" style={{ margin: '4px 0' }}>Nothing marked.</p> : (
        <ul className="wp-list">
          {open.map((w) => (
            <li key={w.id}>
              <span className="wp-what"><FlagIcon code={w.kind} /> <strong>{label(w.kind)}</strong>{w.note && <span className="small muted"> · {w.note}</span>}<span className="small muted"> · since {siteTime(w.start, tz, true)}</span></span>
              <span className="wp-time">{fmtHours(hoursSince(w.start, app.now))}</span>
              {allowed && (
                <span className="wp-act">
                  <button type="button" className="btn" onClick={() => go(app.runWaits(asset, (c) => endWait(c, w.id, new Date().toISOString())))}>Done</button>
                  <button type="button" className="linkish small" onClick={() => setVoiding(voiding === w.id ? null : w.id)}>Wrong?</button>
                </span>
              )}
              {voiding === w.id && (
                <span className="row wp-void">
                  <input value={voidWhy} onChange={(e) => setVoidWhy(e.target.value)} placeholder="Why it was wrong" aria-label="Why it was wrong" />
                  <button type="button" className="btn danger" onClick={() => go(app.runWaits(asset, (c) => voidWait(c, w.id, voidWhy)))}>Void</button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {allowed ? (
        <details className="wp-add">
          <summary>Add what it is waiting for</summary>
          <div className="chips" role="group" aria-label="Waiting for" style={{ margin: '8px 0' }}>
            {free.map((k) => <button key={k.code} type="button" className="chip" aria-pressed={kind === k.code} onClick={() => setKind(k.code)}><FlagIcon code={k.code} />{k.label}</button>)}
          </div>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <label className="field"><span>Started (site time, blank for now)</span>
              <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} max={toLocalInput(app.now, tz)} />
            </label>
            <label className="field" style={{ flex: '1 1 180px' }}><span>Note{needNote ? '' : ' (optional)'}</span>
              <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder={needNote ? 'What is it waiting for?' : 'Part number, who, ...'} />
            </label>
            <button type="button" className="btn primary" disabled={!kind || (needNote && !note.trim())}
              onClick={() => go(app.runWaits(asset, (c) => startWait(c, { kind, note, start: start ? fromLocalInput(start, tz) : new Date().toISOString() })))}>Start timing</button>
          </div>
        </details>
      ) : <p className="small muted">Technicians and supervisors in this area can mark what the unit is waiting for.</p>}
      {r && !r.ok && <div className="errors" role="alert">{r.errors.map((e) => <div key={e}>{e}</div>)}</div>}
    </section>
  );
}

function Result({ r }: { r: CommandResult | null }) {
  if (!r) return null;
  if (!r.ok) return <div className="errors" role="alert">{r.errors.map((e) => <div key={e}>{e}</div>)}</div>;
  if (r.warnings.length) return <div className="warns">{r.warnings.join(' ')}</div>;
  return null;
}

function Locked({ who }: { who: string }) {
  return <p className="locked">🔒 {who} can do this.</p>;
}

// ---------- flag down ----------

function FlagDownForm({ asset, onDone }: { asset: Asset; onDone: () => void }) {
  const app = useApp();
  const tz = app.ds.site.timeZone;
  const area = asset.fleet;
  const direct = can(app.actor, 'set_clear_flag', area);
  const propose = !direct && canPropose(app.actor, 'set_clear_flag', area);
  const [type, setType] = useState<FlagType>('unscheduled');
  const [reason, setReason] = useState('');
  const [earlier, setEarlier] = useState(false);
  const [start, setStart] = useState(() => toLocalInput(new Date().toISOString(), tz));
  const [locKind, setLocKind] = useState<LocationKind>('field');
  const [fieldLoc, setFieldLoc] = useState(app.ds.fieldLocations[0]!);
  const [lineId, setLineId] = useState('');
  const [override, setOverride] = useState('');
  const [etaH, setEtaH] = useState<number | null>(null);
  const [r, setR] = useState<CommandResult | null>(null);
  const freeLines = useFreeLines(asset);
  const plant = asset.assetClass === 'fixed_plant';

  if (!direct && !propose) return <Locked who="Supervisors, reliability engineers and superintendents" />;
  // Active reason codes from the console; retired codes cannot be picked. Plant systems for fixed plant (docs/fixed-plant.md).
  const reasons = plant && type === 'unscheduled' ? Object.keys(PLANT_SYSTEMS) : activeCodes(app.codes, type).map((c) => c.label);

  const submit = () => {
    const startIso = earlier ? fromLocalInput(start, tz) : new Date().toISOString();
    const location = plant ? { kind: 'in_place' as const } : {
      kind: locKind,
      fieldLocation: locKind === 'field' ? fieldLoc : undefined,
      shopLineId: locKind === 'shop_line' ? lineId : undefined,
      overrideReason: override || undefined,
    };
    const res = propose
      ? app.run(asset, (ctx) => proposeDown(ctx, { reasonCode: reason, start: startIso, location, typeSuggestion: type }))
      : app.run(asset, (ctx) =>
          flagDown(ctx, {
            type,
            reasonCode: reason,
            system: type === 'unscheduled' ? reason : undefined,
            start: startIso,
            location,
            eta: etaH ? new Date(Date.parse(startIso) + etaH * 3_600_000).toISOString() : undefined,
            plannedDurationHours: type === 'scheduled' && etaH ? etaH : undefined,
          }),
        );
    setR(res);
    if (res.ok) onDone();
  };

  return (
    <div>
      <p className="muted small">{propose ? 'Technicians propose; a supervisor confirms.' : 'Start time defaults to now.'}</p>
      <div className="field">
        <span>Type</span>
        <div className="chips">
          {(['unscheduled', 'scheduled'] as const).map((t) => (
            <button key={t} className="chip" aria-pressed={type === t} onClick={() => { setType(t); setReason(''); }}>
              <FlagIcon code={t} />{t === 'unscheduled' ? 'Unscheduled' : 'Scheduled'}
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <span>{type === 'unscheduled' ? 'System' : 'Reason'}</span>
        <div className="chips">
          {reasons.map((x) => (
            <button key={x} className="chip" aria-pressed={reason === x} onClick={() => setReason(x)}>{x}</button>
          ))}
        </div>
      </div>
      {plant ? (
        <p className="small">In place at {asset.functionalLocation ?? <strong>no functional location</strong>}</p>
      ) : (
      <div className="field">
        <span>Where is it?</span>
        <div className="chips">
          {(['field', 'shop_yard', 'shop_line'] as const).map((k) => (
            <button key={k} className="chip" aria-pressed={locKind === k} onClick={() => setLocKind(k)}><FlagIcon code={k} />{LOCATION_LABELS[k]}</button>
          ))}
        </div>
      </div>
      )}
      {!plant && locKind === 'field' && (
        <label className="field">
          <span>Field location</span>
          <select value={fieldLoc} onChange={(e) => setFieldLoc(e.target.value)}>
            {app.ds.fieldLocations.map((f) => <option key={f}>{f}</option>)}
          </select>
        </label>
      )}
      {!plant && locKind === 'shop_line' && (
        <LinePicker lines={freeLines} value={lineId} onChange={setLineId} override={override} setOverride={setOverride} />
      )}
      {!propose && (
        <div className="field">
          <span>ETA (optional; required after {app.rules.etaRequiredAfterHours} h)</span>
          <div className="chips">
            {[null, 2, 4, 8, 12, 24].map((h) => (
              <button key={String(h)} className="chip" aria-pressed={etaH === h} onClick={() => setEtaH(h)}>{h === null ? 'Later' : `+${h} h`}</button>
            ))}
          </div>
        </div>
      )}
      <div className="field">
        <label className="row">
          <input type="checkbox" checked={earlier} onChange={(e) => setEarlier(e.target.checked)} /> Started earlier
        </label>
        {earlier && <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} aria-label="Start time (site time)" />}
        {earlier && <span className="small muted">Back-dated entries keep the real entry time and your name in the audit trail.</span>}
      </div>
      <Result r={r} />
      <button className="btn primary big" disabled={!reason} onClick={submit}>{propose ? 'Propose down' : 'Flag down'}</button>
    </div>
  );
}

function useFreeLines(asset: Asset) {
  const app = useApp();
  return useMemo(() => {
    const now = app.now;
    return app.ds.shopLines.map((l) => {
      const closed = app.ds.closures.some((c) => c.lineId === l.id && Date.parse(c.start) <= Date.parse(now) && (!c.end || Date.parse(now) < Date.parse(c.end)));
      const used = app.flags.filter((f) => f.state === 'open' && f.unitId !== asset.id && currentLocation(f)?.kind === 'shop_line' && currentLocation(f)?.shopLineId === l.id).length;
      const fits = l.fits.length === 0 || l.fits.includes(asset.model);
      return { line: l, closed, full: used >= l.capacity, fits };
    });
  }, [app.ds, app.flags, app.now, asset]);
}

function LinePicker({ lines, value, onChange, override, setOverride }: {
  lines: ReturnType<typeof useFreeLines>;
  value: string;
  onChange: (v: string) => void;
  override: string;
  setOverride: (v: string) => void;
}) {
  const chosen = lines.find((l) => l.line.id === value);
  return (
    <div className="field">
      <span>Shop line</span>
      <div className="chips">
        {lines.map(({ line, closed, full, fits }) => (
          <button key={line.id} className="chip" aria-pressed={value === line.id} disabled={closed || full} onClick={() => onChange(line.id)} title={closed ? 'Closed' : full ? 'Full' : fits ? 'Free' : 'Free, but the unit does not fit this line type'}>
            {lineName(line)} {closed ? '(closed)' : full ? '(full)' : fits ? '' : '(!)'}
          </button>
        ))}
      </div>
      {chosen && !chosen.fits && (
        <label className="field">
          <span>This unit does not fit {lineName(chosen.line)}. Override reason</span>
          <input value={override} onChange={(e) => setOverride(e.target.value)} />
        </label>
      )}
    </div>
  );
}

// ---------- proposal ----------

function ProposalPanel({ asset, flag }: { asset: Asset; flag: DownFlag }) {
  const app = useApp();
  const [r, setR] = useState<CommandResult | null>(null);
  const [why, setWhy] = useState('');
  const ok = can(app.actor, 'set_clear_flag', asset.fleet);
  return (
    <div>
      <p><strong>Proposed down</strong> by {flag.setBy} at {siteTime(flag.start, app.ds.site.timeZone)}: {flag.reasonCode}, {locationLabel(flag, app.ds)}.</p>
      <p className="small muted">It does not count until a supervisor confirms it.</p>
      <Result r={r} />
      {ok ? (
        <div className="stack">
          <div className="row">
            <button className="btn primary" onClick={() => setR(app.run(asset, (ctx) => confirmProposal(ctx, flag, { type: 'unscheduled' })))}>Confirm unscheduled</button>
            <button className="btn" onClick={() => setR(app.run(asset, (ctx) => confirmProposal(ctx, flag, { type: 'scheduled' })))}>Confirm scheduled</button>
          </div>
          <label className="field"><span>Reject reason</span><input value={why} onChange={(e) => setWhy(e.target.value)} /></label>
          <button className="btn danger" onClick={() => setR(app.run(asset, (ctx) => rejectProposal(ctx, flag, why)))}>Reject</button>
        </div>
      ) : (
        <Locked who="Supervisors" />
      )}
    </div>
  );
}

/** A historian stop on plant equipment (docs/fixed-plant.md). Process delays are classified on the Plant page, where stops in one circuit are grouped. */
function PlantProposalPanel({ asset, flag }: { asset: Asset; flag: DownFlag }) {
  const app = useApp();
  const [r, setR] = useState<CommandResult | null>(null);
  const [why, setWhy] = useState('');
  const [system, setSystem] = useState('');
  const ok = can(app.actor, 'set_clear_flag', asset.fleet);
  return (
    <div>
      <p><strong>Stopped</strong> at {siteTime(flag.start, app.ds.site.timeZone, true)}. {flag.notes}</p>
      <p className="small muted">Was this maintenance or a process delay? It does not count until someone classifies it.</p>
      <Result r={r} />
      {ok ? (
        <div className="stack">
          <label className="field"><span>Maintenance: system</span>
            <select value={system} onChange={(e) => setSystem(e.target.value)}><option value="">Choose…</option>{Object.keys(PLANT_SYSTEMS).map((s) => <option key={s}>{s}</option>)}</select>
          </label>
          <button className="btn primary" disabled={!system} onClick={() => setR(app.run(asset, (ctx) => classifyAsMaintenance(ctx, flag, system)))}>Maintenance</button>
          <p className="small"><a href="#/plant">Process delay: classify on the Plant page →</a></p>
          <label className="field"><span>Not a stop: reason</span><input value={why} onChange={(e) => setWhy(e.target.value)} placeholder="For example a duty and standby change" /></label>
          <button className="btn" disabled={!why.trim()} onClick={() => setR(app.run(asset, (ctx) => classifyNotAStop(ctx, flag, why)))}>Not a stop</button>
        </div>
      ) : (
        <Locked who="Supervisors, reliability engineers and superintendents" />
      )}
    </div>
  );
}

// ---------- open flag ----------

function OpenFlagPanel({ asset, flag, onDone }: { asset: Asset; flag: DownFlag; onDone: () => void }) {
  const app = useApp();
  const tz = app.ds.site.timeZone;
  const [r, setR] = useState<CommandResult | null>(null);
  const [mode, setMode] = useState<'none' | 'move' | 'release' | 'switch' | 'void' | 'eta'>('none');
  const cur = currentStage(flag);
  const loc = currentLocation(flag);
  const eta = flag.etas.at(-1);
  const canStage = can(app.actor, 'update_stage', asset.fleet);
  const canFlag = can(app.actor, 'set_clear_flag', asset.fleet);
  const canMove = can(app.actor, 'move_location', asset.fleet);
  const shift = shiftAt(app.ds.calendar, app.now);

  const stages: Stage[] = ['waiting_crew', 'in_repair', 'waiting_parts', 'waiting_labour', 'waiting_other', 'ready_for_release'];
  return (
    <div className="stack">
      <div className="card">
        <div className={`status ${flag.type === 'scheduled' ? 'sched' : 'down'}`}>{flag.type === 'scheduled' ? '▲ SCHEDULED' : '■ UNSCHEDULED'}</div>
        <div style={{ fontSize: 18, fontWeight: 700 }}>{flag.reasonCode}</div>
        <div className="small">
          Down {fmtHours(hoursSince(flag.start, app.now))} since {siteTime(flag.start, tz, true)} · {stageLabel(flag)} · {locationLabel(flag, app.ds)}
        </div>
        <div className="small">
          ETA: {eta ? siteTime(eta.eta, tz, true) : <strong style={{ color: 'var(--down)' }}>No ETA</strong>}
          {flag.etas.length > 1 && <span className="muted"> (first: {siteTime(flag.etas[0]!.eta, tz)})</span>}
        </div>
        <div className="small muted">Shift: {shift.name}, crew {shift.crew ?? '—'} · Source: {flag.source}</div>
      </div>

      <div>
        <div className="field">
          <span>Stage</span>
          {canStage ? (
            <div className="chips">
              {stages.map((s) => (
                <button
                  key={s}
                  className="chip"
                  aria-pressed={cur?.stage === s}
                  disabled={loc?.kind === 'towing'}
                  onClick={() => {
                    if (cur?.stage === s) return;
                    const reason = s === 'waiting_other' ? window.prompt(`Reason (${app.rules.waitingOtherReasons.join(', ')})`) ?? '' : undefined;
                    setR(app.run(asset, (ctx) => changeStage(ctx, flag, { stage: s, reason })));
                  }}
                >
                  <FlagIcon code={s} />{STAGE_LABELS[s]}
                </button>
              ))}
            </div>
          ) : (
            <Locked who="Technicians and supervisors in this area" />
          )}
        </div>
      </div>

      {asset.assetClass !== 'fixed_plant' && <WaitPanel asset={asset} />}

      <Result r={r} />

      <div className="row">
        {asset.assetClass !== 'fixed_plant' && <button className="btn" disabled={!canMove} onClick={() => setMode('move')}>Move</button>}
        <button className="btn" disabled={!canFlag} onClick={() => setMode('eta')}>ETA</button>
        <button className="btn" disabled={!can(app.actor, 'reclassify_flag', asset.fleet)} onClick={() => setMode('switch')}>Switch type</button>
        <button className="btn primary" disabled={!canFlag} onClick={() => setMode('release')}>Release</button>
        <button className="btn danger" disabled={!can(app.actor, 'void_flag', asset.fleet)} onClick={() => setMode('void')}>Void</button>
      </div>
      {!canFlag && <Locked who="Supervisors, reliability engineers and superintendents" />}

      {mode === 'move' && <MovePanel asset={asset} flag={flag} setR={setR} done={() => setMode('none')} />}
      {mode === 'eta' && <EtaPanel asset={asset} flag={flag} setR={setR} done={() => setMode('none')} />}
      {mode === 'switch' && <ReasonPanel label={`Switch to ${flag.type === 'scheduled' ? 'unscheduled' : 'scheduled'}`} hint="Closes this flag now and opens a linked one with the same stage and location (R7)." onGo={(reason) => { const x = app.run(asset, (ctx) => switchType(ctx, flag, { reason })); setR(x); if (x.ok) setMode('none'); }} />}
      {mode === 'void' && <ReasonPanel label="Void flag" hint="Entered in error. Kept in the audit trail, removed from every KPI." onGo={(reason) => { const x = app.run(asset, (ctx) => voidFlag(ctx, flag, reason)); setR(x); if (x.ok) onDone(); }} />}
      {mode === 'release' && <ReleasePanel asset={asset} flag={flag} setR={setR} onDone={onDone} />}
    </div>
  );
}

function MovePanel({ asset, flag, setR, done }: { asset: Asset; flag: DownFlag; setR: (r: CommandResult) => void; done: () => void }) {
  const app = useApp();
  const [kind, setKind] = useState<LocationKind>('towing');
  const [lineId, setLineId] = useState('');
  const [fieldLoc, setFieldLoc] = useState(app.ds.fieldLocations[0]!);
  const [reason, setReason] = useState('');
  const [override, setOverride] = useState('');
  const lines = useFreeLines(asset);
  return (
    <div className="card">
      <h3>Move unit</h3>
      <div className="chips" style={{ marginBottom: 12 }}>
        {(['field', 'towing', 'shop_yard', 'shop_line'] as const).map((k) => (
          <button key={k} className="chip" aria-pressed={kind === k} onClick={() => setKind(k)}><FlagIcon code={k} />{LOCATION_LABELS[k]}</button>
        ))}
      </div>
      {kind === 'field' && (
        <label className="field"><span>Field location</span>
          <select value={fieldLoc} onChange={(e) => setFieldLoc(e.target.value)}>{app.ds.fieldLocations.map((f) => <option key={f}>{f}</option>)}</select>
        </label>
      )}
      {kind === 'shop_line' && <LinePicker lines={lines} value={lineId} onChange={setLineId} override={override} setOverride={setOverride} />}
      <label className="field"><span>Reason (needed for some moves)</span><input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
      <button
        className="btn primary"
        onClick={() => {
          const x = app.run(asset, (ctx) => moveLocation(ctx, flag, { kind, shopLineId: kind === 'shop_line' ? lineId : undefined, fieldLocation: kind === 'field' ? fieldLoc : undefined, reason: reason || undefined, overrideReason: override || undefined }));
          setR(x);
          if (x.ok) done();
        }}
      >
        Move
      </button>
    </div>
  );
}

function EtaPanel({ asset, flag, setR, done }: { asset: Asset; flag: DownFlag; setR: (r: CommandResult) => void; done: () => void }) {
  const app = useApp();
  const set = (h: number) => {
    const x = app.run(asset, (ctx) => setEta(ctx, flag, new Date(Date.now() + h * 3_600_000).toISOString()));
    setR(x);
    if (x.ok) done();
  };
  return (
    <div className="card">
      <h3>ETA from now</h3>
      <div className="chips">{[1, 2, 4, 8, 12, 24, 48].map((h) => <button key={h} className="chip" onClick={() => set(h)}>+{h} h</button>)}</div>
      <p className="small muted">Every ETA is kept. The first one counts for shop release vs plan (D10).</p>
    </div>
  );
}

function ReasonPanel({ label, hint, onGo }: { label: string; hint: string; onGo: (reason: string) => void }) {
  const [reason, setReason] = useState('');
  return (
    <div className="card">
      <h3>{label}</h3>
      <p className="small muted">{hint}</p>
      <label className="field"><span>Reason</span><input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
      <button className="btn primary" disabled={!reason} onClick={() => onGo(reason)}>{label}</button>
    </div>
  );
}

function ReleasePanel({ asset, flag, setR, onDone }: { asset: Asset; flag: DownFlag; setR: (r: CommandResult) => void; onDone: () => void }) {
  const app = useApp();
  const plant = asset.assetClass === 'fixed_plant';
  const codes: Record<string, { components: string[]; modes: string[] }> = plant ? PLANT_SYSTEMS : SYSTEMS;
  const sys = flag.system && codes[flag.system] ? flag.system : '';
  const [d, setD] = useState<ReleaseDetails>({ system: sys, failureModes: [], workOrder: flag.workOrders[0], pmOrWorkOrder: flag.workOrders[0] });
  const [reason, setReason] = useState('');
  // Fixed plant: the historian may already show it running again; offer that as the release time.
  const resumed = plant ? resumeAfter(app.plant.signals, asset.id, flag.start) : null;
  const [atResume, setAtResume] = useState(!!resumed);
  const missing = releaseChecklist(flag, d);
  const def = d.system ? codes[d.system] : undefined;
  const u = flag.type === 'unscheduled';
  return (
    <div className="card">
      <h3>Release checklist</h3>
      {u ? (
        <>
          <label className="field"><span>Repair summary</span><textarea rows={2} value={d.repairSummary ?? ''} onChange={(e) => setD({ ...d, repairSummary: e.target.value })} /></label>
          <label className="field"><span>Findings (optional)</span><input value={d.findings ?? ''} onChange={(e) => setD({ ...d, findings: e.target.value || undefined })} /></label>
          {!plant && <CodeSuggestions flag={flag} d={d} setD={setD} />}
          <label className="field"><span>System</span>
            <select value={d.system ?? ''} onChange={(e) => setD({ ...d, system: e.target.value, component: undefined, failureModes: [] })}>
              <option value="">Choose…</option>{Object.keys(codes).map((s) => <option key={s}>{s}</option>)}
            </select>
          </label>
          {def && (
            <>
              <label className="field"><span>Component</span>
                <select value={d.component ?? ''} onChange={(e) => setD({ ...d, component: e.target.value })}>
                  <option value="">Choose…</option>{def.components.map((c) => <option key={c}>{c}</option>)}
                </select>
              </label>
              <div className="field"><span>Failure mode (one or more)</span>
                <div className="chips">
                  {def.modes.map((m) => {
                    const on = d.failureModes?.includes(m);
                    return <button key={m} className="chip" aria-pressed={on} onClick={() => setD({ ...d, failureModes: on ? d.failureModes!.filter((x) => x !== m) : [...(d.failureModes ?? []), m] })}>{m}</button>;
                  })}
                </div>
              </div>
            </>
          )}
          <label className="field"><span>Work order</span><input value={d.workOrder ?? ''} onChange={(e) => setD({ ...d, workOrder: e.target.value })} /></label>
          <label className="field"><span>Detection method (optional)</span>
            <select value={d.detectionMethod ?? ''} onChange={(e) => setD({ ...d, detectionMethod: (e.target.value || undefined) as ReleaseDetails['detectionMethod'] })}>
              <option value="">—</option>{['operator', 'pm', 'inspection', 'condition_monitoring', 'alarm', 'other'].map((x) => <option key={x}>{x}</option>)}
            </select>
          </label>
        </>
      ) : (
        <>
          <label className="field"><span>PM or work order</span><input value={d.pmOrWorkOrder ?? ''} onChange={(e) => setD({ ...d, pmOrWorkOrder: e.target.value })} /></label>
          <label className="field"><span>Findings (write "None" if none)</span><input value={d.findings ?? ''} onChange={(e) => setD({ ...d, findings: e.target.value || undefined })} /></label>
        </>
      )}
      {!u && <label className="field"><span>Repair summary</span><textarea rows={2} value={d.repairSummary ?? ''} onChange={(e) => setD({ ...d, repairSummary: e.target.value })} /></label>}
      {currentLocation(flag)?.kind === 'shop_yard' && (
        <label className="field"><span>Reason for releasing from the yard</span><input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
      )}
      {resumed && (
        <label className="row small">
          <input type="checkbox" checked={atResume} onChange={(e) => setAtResume(e.target.checked)} /> Release at {siteTime(resumed, app.ds.site.timeZone, true)}, when the historian shows it running again
        </label>
      )}
      {missing.length > 0 && <p className="small muted">Still needed: {missing.join(', ')}</p>}
      <button
        className="btn primary big"
        disabled={missing.length > 0}
        onClick={() => {
          const x = app.run(asset, (ctx) => release(ctx, flag, { details: d, reason: reason || undefined, at: resumed && atResume ? resumed : undefined }));
          setR(x);
          if (x.ok) onDone();
        }}
      >
        Release {asset.unitNumber}
      </button>
    </div>
  );
}

/** AI-1 (docs/ai-assist.md): codes suggested from the text, only codes that passed the held-back check. "Use" fills the form; the person still releases. */
function CodeSuggestions({ flag, d, setD }: { flag: DownFlag; d: ReleaseDetails; setD: (d: ReleaseDetails) => void }) {
  const app = useApp();
  const { model, check, live } = app.suggester;
  const text = useMemo(() => flagText({ ...flag, release: d }, workOrderIndex(app.ds.workOrders)), [flag, d, app.ds.workOrders]);
  if (!live.length || !text.trim()) return null;
  const min = app.assistSettings.minConfidence;
  const given = d.system || undefined;
  const s = liveSuggestion(suggestCodes(model, text, min, given), live, given);
  const free = given && live.includes('system') ? suggestCodes(model, text, min).system : null;
  const other = free && free.code !== given ? free : null;
  if (!s.system && !s.component && !s.mode && !other) return <p className="small muted">No code suggestion from the text yet.</p>;
  const why = (r: Ranked) => `${Math.round(r.chance * 100)}%${r.words.length ? `, from "${r.words.join('", "')}"` : ''}`;
  const use = () => {
    const system = s.system?.code ?? d.system;
    setD({ ...d, system, component: s.component?.code ?? (s.system ? undefined : d.component), failureModes: s.mode ? [s.mode.code] : s.system ? [] : d.failureModes });
  };
  const useOther = () => {
    const t = liveSuggestion(suggestCodes(model, text, min, other!.code), live, other!.code);
    setD({ ...d, system: other!.code, component: t.component?.code, failureModes: t.mode ? [t.mode.code] : [] });
  };
  return (
    <div className="card" style={{ background: 'var(--surface-2, transparent)' }} aria-label="Suggested codes">
      <p className="small" style={{ margin: 0 }}><strong>Suggested from the text</strong> <span className="muted">(learned from {check.trainedOn + check.held} released flags at this site; check it before you release)</span></p>
      <ul className="small" style={{ margin: '4px 0', paddingLeft: 18 }}>
        {s.system && <li>System: <strong>{s.system.code}</strong> <span className="muted">{why(s.system)}</span></li>}
        {s.component && <li>Component: <strong>{s.component.code}</strong> <span className="muted">{why(s.component)}</span></li>}
        {s.mode && <li>Failure mode: <strong>{s.mode.code}</strong> <span className="muted">{why(s.mode)}</span></li>}
        {other && <li>The text reads more like <strong>{other.code}</strong> <span className="muted">({why(other)})</span> than {given}</li>}
      </ul>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        {(s.system || s.component || s.mode) && <button className="btn" onClick={use}>Use suggestion</button>}
        {other && <button className="btn" onClick={useOther}>Use {other.code}</button>}
      </div>
    </div>
  );
}
