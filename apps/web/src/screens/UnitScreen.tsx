// Unit screen parts (docs/unit-screen.md): the stop now, repair details, assigned technicians,
// investigation, notes and the unit's history. Screens call core commands only.

import {
  NOTE_KIND_LABELS, STAGE_LABELS, addNote, assignTechnician, assignable, assignmentHours, clearInvestigation, currentStage, lineName,
  markInvestigation, notesFor, setRepairDetails, unassignTechnician, unitHistory, voidNote, can, hasRole,
  type Asset, type DownFlag, type HistoryItem, type LocationInterval, type NoteKind, type RepairDetails,
} from '@mr/core';
import { useMemo, useState } from 'react';
import { FlagIcon } from '../components/FlagIcon';
import { fmtHours, hoursSince, locationLabel, siteTime } from '../format';
import { newHref } from '../improve/describe';
import { useApp } from '../store';

const Errors = ({ e }: { e: string[] | null }) => (e && e.length ? <div className="errors" role="alert">{e.map((x) => <div key={x}>{x}</div>)}</div> : null);

/** The stop as it is now: problem, stage, where, ETA, waits. */
export function UnitNow({ a, f }: { a: Asset; f: DownFlag }) {
  const app = useApp();
  const tz = app.ds.site.timeZone;
  const st = currentStage(f);
  const eta = f.etas.at(-1);
  const waits = app.waits.filter((w) => w.unitId === a.id && w.state !== 'voided' && Date.parse(w.start) >= Date.parse(f.start) - 1);
  const kind = (c: string) => app.waitKinds.find((k) => k.code === c)?.label ?? c;
  return (
    <section className="card us-now">
      <h3>Now</h3>
      <dl className="us-facts">
        <div><dt>Problem</dt><dd>{f.reasonCode}</dd></div>
        <div><dt>Stage</dt><dd><FlagIcon code={st?.stage ?? 'no_stage'} /> {st ? STAGE_LABELS[st.stage] : 'No stage set'}{st && <span className="muted small"> · {fmtHours(hoursSince(st.start, app.now))}</span>}</dd></div>
        <div><dt>Where</dt><dd>{locationLabel(f, app.ds)}</dd></div>
        <div><dt>ETA</dt><dd>{eta ? <span className={Date.parse(eta.eta) < Date.parse(app.now) ? 'eta-late' : ''}>{siteTime(eta.eta, tz, true)}</span> : <span className="muted">None set</span>}</dd></div>
        <div><dt>Work orders</dt><dd>{f.workOrders.length ? f.workOrders.join(', ') : <span className="muted">None</span>}</dd></div>
      </dl>
      {waits.length > 0 && (
        <ul className="fitems us-waits">
          {waits.map((w) => (
            <li key={w.id} className={`fi-wait${w.state === 'open' ? ' fi-run' : ''}`}>
              <span className="fi-l"><FlagIcon code={w.kind} size={14} /> {kind(w.kind)}{w.note ? ` · ${w.note}` : ''}</span>
              <span className="fi-t">{fmtHours((Date.parse(w.end ?? app.now) - Date.parse(w.start)) / 3.6e6)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** System, major component, component, failure mode and findings, filled in while the stop is open. */
export function RepairDetailsCard({ a, f }: { a: Asset; f: DownFlag }) {
  const app = useApp();
  const r = f.release ?? {};
  const editable = f.state === 'open' && can(app.actor, 'update_stage', a.fleet);
  const [edit, setEdit] = useState(false);
  const [d, setD] = useState<RepairDetails>({});
  const [err, setErr] = useState<string[] | null>(null);
  // Suggestions from what the site has recorded before.
  const seen = useMemo(() => {
    const sys = new Set<string>(), maj = new Set<string>(), comp = new Set<string>(), fm = new Set<string>();
    for (const x of app.flags) {
      const q = x.release; if (!q) continue;
      if (q.system) sys.add(q.system); if (q.majorComponent) maj.add(q.majorComponent); if (q.component) comp.add(q.component);
      for (const m of q.failureModes ?? []) fm.add(m);
    }
    return { sys: [...sys].sort(), maj: [...maj].sort(), comp: [...comp].sort(), fm: [...fm].sort() };
  }, [app.flags]);
  const start = () => { setD({ system: r.system ?? f.system, majorComponent: r.majorComponent, component: r.component, failureModes: r.failureModes, findings: r.findings }); setErr(null); setEdit(true); };
  const save = () => {
    const res = app.run(a, (ctx) => setRepairDetails(ctx, f, d));
    if (res.ok) setEdit(false); else setErr(res.errors);
  };
  const field = (label: string, key: 'system' | 'majorComponent' | 'component', list: string[]) => (
    <label className="field"><span>{label}</span>
      <input list={`us-${key}`} value={(d[key] as string) ?? ''} onChange={(e) => setD({ ...d, [key]: e.target.value })} maxLength={200} />
      <datalist id={`us-${key}`}>{list.map((x) => <option key={x} value={x} />)}</datalist>
    </label>
  );
  return (
    <section className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h3>Repair details</h3>
        {editable && !edit && <button className="btn" onClick={start}>Edit</button>}
      </div>
      {!edit ? (
        <dl className="us-facts">
          <div><dt>System</dt><dd>{r.system ?? f.system ?? <span className="muted">Not yet</span>}</dd></div>
          <div><dt>Major component</dt><dd>{r.majorComponent ?? <span className="muted">Not yet</span>}</dd></div>
          <div><dt>Component</dt><dd>{r.component ?? <span className="muted">Not yet</span>}</dd></div>
          <div><dt>Failure mode</dt><dd>{r.failureModes?.length ? r.failureModes.join(', ') : <span className="muted">Not yet</span>}</dd></div>
          <div><dt>Findings</dt><dd>{r.findings ?? <span className="muted">None</span>}</dd></div>
          {f.state === 'released' && r.repairSummary && <div><dt>Repair</dt><dd>{r.repairSummary}</dd></div>}
        </dl>
      ) : (
        <div className="stack">
          {field('System', 'system', seen.sys)}
          {field('Major component', 'majorComponent', seen.maj)}
          {field('Component', 'component', seen.comp)}
          <label className="field"><span>Failure mode</span>
            <input list="us-fm" value={d.failureModes?.[0] ?? ''} onChange={(e) => setD({ ...d, failureModes: e.target.value ? [e.target.value] : [] })} maxLength={200} />
            <datalist id="us-fm">{seen.fm.map((x) => <option key={x} value={x} />)}</datalist>
          </label>
          <label className="field"><span>Findings</span><textarea rows={3} value={d.findings ?? ''} onChange={(e) => setD({ ...d, findings: e.target.value })} maxLength={2000} /></label>
          <Errors e={err} />
          <div className="row"><button className="btn primary" onClick={save}>Save details</button><button className="btn" onClick={() => setEdit(false)}>Cancel</button></div>
        </div>
      )}
      {!editable && f.state === 'open' && <p className="small muted">Technicians, supervisors in this area, reliability engineers and superintendents fill these in.</p>}
    </section>
  );
}

/** People on the unit now, with their time, and who else has worked this stop. */
export function TechniciansCard({ a, f }: { a: Asset; f: DownFlag }) {
  const app = useApp();
  const mine = app.assignments.filter((x) => x.downFlagId === f.id && x.state !== 'voided');
  const on = mine.filter((x) => x.state === 'open');
  const before = mine.filter((x) => x.state === 'ended');
  const may = f.state === 'open' && can(app.actor, 'assign_technicians', a.fleet);
  const pickable = assignable(app.users, app.now).filter((p) => !on.some((x) => x.userId === p.id));
  const [who, setWho] = useState('');
  const [err, setErr] = useState<string[] | null>(null);
  const assign = () => { const r = app.runAssignments(a, (ctx, list) => assignTechnician(ctx, list, who)); if (r.ok) { setWho(''); setErr(null); } else setErr(r.errors); };
  const off = (id: string) => { const r = app.runAssignments(a, (ctx, list) => unassignTechnician(ctx, list, id)); setErr(r.ok ? null : r.errors); };
  return (
    <section className="card">
      <h3>Technicians</h3>
      {on.length === 0 ? <p className="small muted">Nobody assigned{f.state === 'open' ? ' yet' : ''}.</p> : (
        <ul className="us-people">
          {on.map((x) => (
            <li key={x.id}>
              <FlagIcon code="LABOUR" /> <strong>{app.userName(x.userId)}</strong>
              <span className="muted small"> · on it {fmtHours(assignmentHours(x, app.now))}</span>
              {may && <button className="linklike small" onClick={() => off(x.id)}>Take off</button>}
            </li>
          ))}
        </ul>
      )}
      {before.length > 0 && <p className="small muted">Earlier on this stop: {before.map((x) => `${app.userName(x.userId)} (${fmtHours(assignmentHours(x, app.now))})`).join(', ')}</p>}
      {may && (
        <div className="row">
          <select value={who} onChange={(e) => setWho(e.target.value)} aria-label="Person to assign">
            <option value="">Choose a person…</option>
            {pickable.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <button className="btn primary" disabled={!who} onClick={assign}>Assign</button>
        </div>
      )}
      {f.state === 'open' && !may && <p className="small muted">Supervisors in this area, reliability engineers and superintendents assign people.</p>}
      <Errors e={err} />
    </section>
  );
}

/** Mark the stop for investigation, or clear the mark, with a reason. */
export function InvestigationCard({ a, f }: { a: Asset; f: DownFlag }) {
  const app = useApp();
  const tz = app.ds.site.timeZone;
  const inv = f.investigation && !f.investigation.clearedAt ? f.investigation : undefined;
  const may = can(app.actor, 'mark_investigation');
  const [reason, setReason] = useState('');
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string[] | null>(null);
  const go = (clear: boolean) => {
    const r = app.run(a, (ctx) => (clear ? clearInvestigation(ctx, f, reason) : markInvestigation(ctx, f, reason)));
    if (r.ok) { setReason(''); setOpen(false); setErr(null); } else setErr(r.errors);
  };
  return (
    <section className={`card${inv ? ' us-inv-on' : ''}`}>
      <h3>Investigation</h3>
      {inv ? (
        <p className="small"><strong>Marked for investigation</strong> by {app.userName(inv.by)}, {siteTime(inv.at, tz, true)}: {inv.reason}
          {can(app.actor, 'run_rcas') && <> · <a href={newHref('rca', { kind: 'flag', unitId: a.id, flagId: f.id })}>Start RCA</a></>}</p>
      ) : <p className="small muted">Not marked.{f.investigation?.clearedAt ? ` Last mark cleared: ${f.investigation.clearReason}` : ''}</p>}
      {may && !open && <button className="btn" onClick={() => setOpen(true)}>{inv ? 'Clear the mark' : 'Mark for investigation'}</button>}
      {may && open && (
        <div className="stack">
          <label className="field"><span>{inv ? 'Why it is not needed' : 'Why it needs an investigation'}</span><input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} /></label>
          <div className="row"><button className="btn primary" disabled={!reason.trim()} onClick={() => go(!!inv)}>{inv ? 'Clear' : 'Mark'}</button><button className="btn" onClick={() => setOpen(false)}>Cancel</button></div>
        </div>
      )}
      <Errors e={err} />
    </section>
  );
}

/** Repair notes and comments: add one, read them newest first, void your own. */
export function NotesCard({ a }: { a: Asset }) {
  const app = useApp();
  const tz = app.ds.site.timeZone;
  const list = notesFor(app.notes, a.id);
  const may = can(app.actor, 'add_notes');
  const [kind, setKind] = useState<NoteKind>('repair');
  const [text, setText] = useState('');
  const [err, setErr] = useState<string[] | null>(null);
  const [voiding, setVoiding] = useState<string | null>(null);
  const [why, setWhy] = useState('');
  const add = () => { const r = app.runNotes(a, (ctx, notes) => addNote(ctx, notes, { kind, text })); if (r.ok) { setText(''); setErr(null); } else setErr(r.errors); };
  const doVoid = (id: string) => { const r = app.runNotes(a, (ctx, notes) => voidNote(ctx, notes, id, why)); if (r.ok) { setVoiding(null); setWhy(''); setErr(null); } else setErr(r.errors); };
  return (
    <section className="card us-notes">
      <h3>Notes</h3>
      {may ? (
        <div className="stack">
          <div className="row" role="radiogroup" aria-label="Kind of note">
            {(['repair', 'comment'] as NoteKind[]).map((k) => <button key={k} type="button" className="chip" aria-pressed={kind === k} onClick={() => setKind(k)}>{NOTE_KIND_LABELS[k]}</button>)}
          </div>
          <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} placeholder={kind === 'repair' ? 'What was found or done' : 'Anything the next person should know'} aria-label="Note" />
          <div><button className="btn primary" disabled={!text.trim()} onClick={add}>Add note</button></div>
        </div>
      ) : <p className="small muted">Technicians, supervisors, reliability engineers and superintendents add notes.</p>}
      <Errors e={err} />
      {list.length === 0 ? <p className="small muted">No notes yet.</p> : (
        <ul className="us-notelist">
          {list.map((n) => (
            <li key={n.id} className={n.voidedAt ? 'us-voided' : ''}>
              <div className="small muted"><strong className={`us-kind us-kind-${n.kind}`}>{NOTE_KIND_LABELS[n.kind]}</strong> · {n.by === app.actor.userId ? 'You' : app.userName(n.by)} · {siteTime(n.at, tz, true)}</div>
              <div className="us-text">{n.text}</div>
              {n.voidedAt && <div className="small muted">Voided: {n.voidReason}</div>}
              {!n.voidedAt && ((n.by === app.actor.userId && may) || hasRole(app.actor, 'superintendent')) && (voiding === n.id ? (
                <div className="row"><input value={why} onChange={(e) => setWhy(e.target.value)} placeholder="Why it is wrong" aria-label="Reason" /><button className="btn" disabled={!why.trim()} onClick={() => doVoid(n.id)}>Void</button><button className="linklike small" onClick={() => setVoiding(null)}>Cancel</button></div>
              ) : <button className="linklike small" onClick={() => { setVoiding(n.id); setWhy(''); }}>Void</button>)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function placeOf(l: LocationInterval | undefined, lines: { id: string }[]): string {
  if (!l) return '';
  if (l.kind === 'shop_line') { const x = lines.find((s) => s.id === l.shopLineId); return x ? lineName(x as never) : 'a shop line'; }
  if (l.kind === 'field') return l.fieldLocation ? `the field (${l.fieldLocation})` : 'the field';
  if (l.kind === 'towing') return 'towing';
  if (l.kind === 'shop_yard') return 'the shop yard';
  return l.functionalLocation ?? 'in place';
}

/** Everything that happened to the unit, newest first. */
export function HistoryCard({ a }: { a: Asset }) {
  const app = useApp();
  const tz = app.ds.site.timeZone;
  const [all, setAll] = useState(false);
  const items = useMemo(() => unitHistory({
    unitId: a.id, flags: app.flags, standby: app.standby, waits: app.waits, assignments: app.assignments, notes: app.notes, lifecycle: app.ds.lifecycle, now: app.now,
  }), [a.id, app.flags, app.standby, app.waits, app.assignments, app.notes, app.ds.lifecycle, app.now]);
  const [only, setOnly] = useState<'all' | 'stops' | 'notes' | 'standby'>('all');
  const group = (k: HistoryItem['kind']) => (k === 'note' ? 'notes' : k === 'standby' || k === 'standby_end' || k === 'parked' || k === 'parked_end' ? 'standby' : 'stops');
  const picked = only === 'all' ? items : items.filter((h) => group(h.kind) === only);
  const shown = all ? picked : picked.slice(0, 40);
  const wait = (c?: string) => app.waitKinds.find((k) => k.code === c)?.label ?? c ?? '';
  const sb = (c?: string) => app.standbyReasons.find((k) => k.code === c)?.label ?? c ?? '';
  const who = (id?: string) => (!id ? '' : id === app.actor.userId ? 'You' : app.userName(id));
  const say = (h: HistoryItem): { icon: string; text: string; tone: string } => {
    switch (h.kind) {
      case 'down': return { icon: h.code ?? 'unscheduled', text: `${h.code === 'scheduled' ? 'Scheduled down' : 'Down'}: ${h.text}`, tone: h.code === 'scheduled' ? 'sched' : 'down' };
      case 'proposed': return { icon: 'proposed', text: `Down proposed: ${h.text}`, tone: 'warn' };
      case 'stage': return { icon: h.code ?? 'no_stage', text: `Stage: ${STAGE_LABELS[h.code as keyof typeof STAGE_LABELS] ?? h.code}`, tone: 'info' };
      case 'move': return { icon: h.location?.kind ?? 'field', text: `Moved to ${placeOf(h.location, app.ds.shopLines)}`, tone: 'info' };
      case 'eta': return { icon: 'eta', text: `ETA set: ${h.text ? siteTime(h.text, tz, true) : ''}`, tone: 'info' };
      case 'release': return { icon: 'in_use', text: `Released, up again after ${fmtHours(h.hours)} down`, tone: 'run' };
      case 'void': return { icon: 'alert', text: `Stop voided${h.text ? `: ${h.text}` : ''}`, tone: 'muted' };
      case 'investigate': return { icon: 'alert', text: `Marked for investigation: ${h.text}`, tone: 'warn' };
      case 'investigate_clear': return { icon: 'alert', text: `Investigation mark cleared: ${h.text}`, tone: 'muted' };
      case 'standby': return { icon: h.code ?? 'standby', text: `Standby: ${sb(h.code)}${h.text ? ` · ${h.text}` : ''}`, tone: 'standby' };
      case 'standby_end': return { icon: 'standby', text: `Standby ended (${sb(h.code)}, ${fmtHours(h.hours)})`, tone: 'muted' };
      case 'parked': return { icon: 'parked', text: 'Parked', tone: 'muted' };
      case 'parked_end': return { icon: 'parked', text: `Back from parked after ${fmtHours(h.hours)}`, tone: 'muted' };
      case 'wait': return { icon: h.code ?? 'OTHER', text: `Waiting: ${wait(h.code)}${h.text ? ` · ${h.text}` : ''}`, tone: 'sched' };
      case 'wait_end': return { icon: h.code ?? 'OTHER', text: `${wait(h.code)} wait ended (${fmtHours(h.hours)})`, tone: 'muted' };
      case 'assign': return { icon: 'LABOUR', text: `Assigned: ${app.userName(h.code ?? '')}`, tone: 'info' };
      case 'unassign': return { icon: 'LABOUR', text: `${app.userName(h.code ?? '')} off the unit (${fmtHours(h.hours)})`, tone: 'muted' };
      case 'note': return { icon: h.code === 'repair' ? 'TOOLS' : 'OTHER', text: `${NOTE_KIND_LABELS[h.code as NoteKind] ?? 'Note'}: ${h.text}`, tone: 'note' };
      default: return { icon: 'OTHER', text: h.kind, tone: 'info' };
    }
  };
  return (
    <section className="card">
      <h3>History</h3>
      <div className="chips" role="radiogroup" aria-label="Show" style={{ marginBottom: 8 }}>
        {([['all', 'All'], ['stops', 'Stops and repairs'], ['notes', 'Notes'], ['standby', 'Standby and parked']] as const).map(([k, l]) => (
          <button key={k} type="button" className="chip" aria-pressed={only === k} onClick={() => setOnly(k)}>{l}</button>
        ))}
      </div>
      {picked.length === 0 ? <p className="small muted">Nothing recorded yet.</p> : (
        <ol className="us-history">
          {shown.map((h, i) => {
            const s = say(h);
            return (
              <li key={`${h.refId}-${h.kind}-${i}`} className={`uh-${s.tone}${h.voided ? ' us-voided' : ''}`}>
                <span className="uh-time small muted">{siteTime(h.at, tz, true)}</span>
                <span className="uh-icon"><FlagIcon code={s.icon} size={14} /></span>
                <span className="uh-text">{s.text}{h.by && <span className="muted small"> · {who(h.by)}</span>}</span>
              </li>
            );
          })}
        </ol>
      )}
      {picked.length > 40 && <button className="linklike small" onClick={() => setAll(!all)}>{all ? 'Show less' : `Show all ${picked.length}`}</button>}
    </section>
  );
}
