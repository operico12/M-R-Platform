// Management console, phase 1a pages (plan 11.4, 11.6, 11.7): Users, Targets
// (no approval step yet) and Flags and codes. Same layout on every page: a
// list, a panel to change it, a note on what the change affects.

import {
  PHASE_1A_ROLES,
  ROLE_LABELS,
  TARGET_KPIS,
  addCode,
  addUser,
  can,
  changeUser,
  editCode,
  permission,
  permissionsFor,
  retireCode,
  retireUser,
  setTarget,
  targetFor,
  type ReasonCode,
  type Role,
  type SiteUser,
  type TargetKpi,
} from '@mr/core';
import { useState, type ReactNode } from 'react';
import { siteTime } from '../format';
import { useApp } from '../store';
import { FlagRules } from './DataQuality';
import { AlertRulesPage } from './AlertRules';
import { AuditLogPage } from './AuditLog';
import { WorkSettingsPage } from './WorkSettings';

type Tab = 'users' | 'targets' | 'work' | 'alerts' | 'codes' | 'audit';
const TABS: Array<[Tab, string]> = [['users', 'Users'], ['targets', 'Targets'], ['work', 'Work settings'], ['alerts', 'Alert rules'], ['codes', 'Flags and codes'], ['audit', 'Audit log']];

export function Console({ tab }: { tab: string }) {
  const t: Tab = TABS.some(([k]) => k === tab) ? (tab as Tab) : 'users';
  return (
    <div className="stack">
      <div className="page-head"><h2>Console</h2><span className="muted small">Every change is in the audit trail with who, when, before and after.</span></div>
      <div className="chips" role="tablist">
        {TABS.map(([k, l]) => <a key={k} role="tab" aria-selected={t === k} className="chip" aria-pressed={t === k} style={{ display: 'inline-flex', alignItems: 'center', textDecoration: 'none', minHeight: 40 }} href={`#/console/${k}`}>{l}</a>)}
      </div>
      {t === 'users' && <Users />}
      {t === 'targets' && <Targets />}
      {t === 'work' && <WorkSettingsPage />}
      {t === 'alerts' && <AlertRulesPage />}
      {t === 'codes' && <Codes />}
      {t === 'audit' && <AuditLogPage />}
    </div>
  );
}

function Errors({ list }: { list: string[] | null }) {
  if (!list?.length) return null;
  return <div className="errors" role="alert">{list.map((e) => <div key={e}>{e}</div>)}</div>;
}

function Panel({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  return (
    <section className="card" aria-label={title} style={{ borderColor: 'var(--brand)' }}>
      <div className="row" style={{ justifyContent: 'space-between' }}><h3 style={{ margin: 0 }}>{title}</h3><button className="btn" onClick={onClose}>Close</button></div>
      {children}
    </section>
  );
}

const PERM_WORD: Record<string, string> = { yes: 'Yes', area: 'In their area', propose: 'Propose', approve: 'Approve', request: 'Request' };

// ---------- users ----------

function Users() {
  const app = useApp();
  const allowed = can(app.actor, 'manage_users');
  const [edit, setEdit] = useState<SiteUser | 'new' | null>(null);
  const [view, setView] = useState<SiteUser | null>(null);
  const live = app.users.filter((u) => !u.retiredAt);
  const gone = app.users.filter((u) => u.retiredAt);
  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <p className="small muted" style={{ margin: 0 }}>Phase 1a roles: Viewer, Supervisor, Reliability engineer and Admin. Technician and kiosk accounts, single sign-on and acting roles come in phase 1b.</p>
        <button className="btn primary" disabled={!allowed} onClick={() => setEdit('new')}>Add user</button>
      </div>
      {!allowed && <p className="small muted">Only the Admin can change users. You can see who has access.</p>}
      {edit && <UserForm user={edit === 'new' ? null : edit} onDone={() => setEdit(null)} />}
      {view && (
        <Panel title={`What ${view.name} can do now`} onClose={() => setView(null)}>
          <p className="small muted">{ROLE_LABELS[view.role]} · {view.scope.includes('*') ? 'whole site' : view.scope.join(', ')}. From the permission matrix (plan 11.2); anything not listed is not allowed.</p>
          <ul>{permissionsFor(view.role).map((p) => <li key={p.action}>{p.label}: <strong>{PERM_WORD[p.permission]}</strong></li>)}</ul>
        </Panel>
      )}
      <div className="table-wrap">
        <table>
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Scope</th><th /></tr></thead>
          <tbody>
            {live.map((u) => (
              <tr key={u.id}>
                <td>{u.name}{u.id === app.actor.userId ? ' (you)' : ''}</td><td>{u.email}</td>
                <td>{ROLE_LABELS[u.role]}{PHASE_1A_ROLES.includes(u.role) ? '' : ' · demo only'}</td>
                <td>{u.scope.includes('*') ? 'Whole site' : u.scope.join(', ')}</td>
                <td className="row" style={{ gap: 6 }}>
                  <button className="btn" onClick={() => setView(u)}>What they can do</button>
                  {allowed && <button className="btn" onClick={() => setEdit(u)}>Change</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {gone.length > 0 && (
        <details><summary className="small">Removed users ({gone.length})</summary>
          <ul className="small">{gone.map((u) => <li key={u.id}>{u.name} ({u.email}), removed {siteTime(u.retiredAt!, app.ds.site.timeZone, true)}: {u.retiredReason}</li>)}</ul>
        </details>
      )}
    </>
  );
}

function UserForm({ user, onDone }: { user: SiteUser | null; onDone: () => void }) {
  const app = useApp();
  const [name, setName] = useState(user?.name ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [role, setRole] = useState<Role>(user && PHASE_1A_ROLES.includes(user.role) ? user.role : 'viewer');
  const [whole, setWhole] = useState(user ? user.scope.includes('*') : true);
  const [areas, setAreas] = useState(user && !user.scope.includes('*') ? user.scope.join(', ') : '');
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<string[] | null>(null);
  const input = { name, email, role, scope: whole ? ['*'] : areas.split(',').map((x) => x.trim()).filter(Boolean) };

  const save = () => {
    const r = user
      ? app.runConsole('users', (c) => changeUser(c, app.users, user.id, input, reason))
      : app.runConsole('users', (c) => addUser(c, app.users, input));
    if (r.ok) onDone(); else setErrors(r.errors);
  };
  const remove = () => {
    const r = app.runConsole('users', (c) => retireUser(c, app.users, user!.id, reason));
    if (r.ok) onDone(); else setErrors(r.errors);
  };
  return (
    <Panel title={user ? `Change ${user.name}` : 'Add user'} onClose={onDone}>
      <div className="grid two">
        <label className="field"><span>Name</span><input value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="field"><span>Email</span><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        <label className="field"><span>Role</span>
          <select value={role} onChange={(e) => setRole(e.target.value as Role)}>{PHASE_1A_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}</select>
        </label>
        <div className="field"><span>Scope</span>
          <label className="small"><input type="checkbox" checked={whole} onChange={(e) => setWhole(e.target.checked)} /> Whole site</label>
          {!whole && <input placeholder="Areas or fleets, comma separated" value={areas} onChange={(e) => setAreas(e.target.value)} />}
        </div>
        {user && <label className="field"><span>Reason for the change</span><input value={reason} onChange={(e) => setReason(e.target.value)} /></label>}
      </div>
      <p className="small muted">They will be able to: {permissionsFor(role).map((p) => `${p.label.toLowerCase()} (${PERM_WORD[p.permission]!.toLowerCase()})`).join('; ')}.</p>
      <Errors list={errors} />
      <div className="row">
        <button className="btn primary" onClick={save}>{user ? 'Save' : 'Add user'}</button>
        {user && <button className="btn danger" onClick={remove}>Remove access</button>}
      </div>
      {user && <p className="small muted">Removing access keeps the person's records and history. Nothing is deleted.</p>}
    </Panel>
  );
}

// ---------- targets ----------

const fmtTarget = (kpi: TargetKpi, v: number) => (TARGET_KPIS[kpi].unit === '%' ? `${(v * 100).toFixed(1)}%` : `${v.toFixed(1)} h`);

function Targets() {
  const app = useApp();
  const tz = app.ds.site.timeZone;
  const p = permission(app.actor.role, 'change_targets');
  const allowed = p === 'propose' || p === 'approve';
  const [kpi, setKpi] = useState<TargetKpi>('pa');
  const [model, setModel] = useState('');
  const [value, setValue] = useState('');
  const [amber, setAmber] = useState('');
  const [from, setFrom] = useState<'next_shift' | 'date'>('next_shift');
  const [date, setDate] = useState('');
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<string[] | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const pct = TARGET_KPIS[kpi].unit === '%';
  const models = [...new Set(app.ds.assets.map((a) => a.model))].sort();
  const history = [...app.targetList].sort((a, b) => Date.parse(b.setAt) - Date.parse(a.setAt));

  const save = () => {
    const v = Number(value) / (pct ? 100 : 1);
    const a = Number(amber || 0) / (pct ? 100 : 1);
    const r = app.runConsole('targets', (c) => setTarget(c, app.targetList, { kpi, fleet: 'Haul trucks', model: model || undefined, value: v, amber: a, from: from === 'next_shift' ? 'next_shift' : date, reason }));
    if (r.ok) { setErrors(null); setSaved(`Saved. ${TARGET_KPIS[kpi].label} target ${fmtTarget(kpi, v)} applies from ${siteTime(r.records.at(-1)!.effectiveFrom, tz, true)}.`); setValue(''); setReason(''); }
    else { setSaved(null); setErrors(r.errors); }
  };

  return (
    <>
      <section className="card">
        <h3>Targets in force now · Haul trucks</h3>
        <table>
          <thead><tr><th>KPI</th><th className="num">Target</th><th className="num">Amber band</th><th>Since</th><th>Set by</th></tr></thead>
          <tbody>
            {(Object.keys(TARGET_KPIS) as TargetKpi[]).map((k) => {
              const t = targetFor(app.targetList, k, { fleet: 'Haul trucks' }, app.now);
              const v = app.targetOf(k);
              return (
                <tr key={k}>
                  <td>{TARGET_KPIS[k].label}</td>
                  <td className="num">{v ? fmtTarget(k, v.value) : '—'}</td>
                  <td className="num">{v ? `${TARGET_KPIS[k].higherIsBetter ? '−' : '+'}${TARGET_KPIS[k].unit === '%' ? `${(v.amber * 100).toFixed(1)} pts` : `${v.amber.toFixed(1)} h`}` : '—'}</td>
                  <td>{t ? siteTime(t.effectiveFrom, tz, true) : v ? 'Placeholder' : 'Not set'}</td>
                  <td>{t ? t.setBy : ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="small muted">Green on or better than target, amber within the band, red beyond it. A model target overrides the fleet target for that model.</p>
      </section>

      <section className="card">
        <h3>Set a target</h3>
        {!allowed && <p className="small muted">The reliability engineer sets targets. In phase 1a there is no approval step; superintendent approval arrives in phase 2.</p>}
        <fieldset disabled={!allowed} style={{ border: 0, padding: 0, margin: 0 }}>
          <div className="grid two">
            <label className="field"><span>KPI</span><select value={kpi} onChange={(e) => setKpi(e.target.value as TargetKpi)}>{(Object.keys(TARGET_KPIS) as TargetKpi[]).map((k) => <option key={k} value={k}>{TARGET_KPIS[k].label}</option>)}</select></label>
            <label className="field"><span>Applies to</span><select value={model} onChange={(e) => setModel(e.target.value)}><option value="">All haul trucks</option>{models.map((m) => <option key={m} value={m}>Model {m} only</option>)}</select></label>
            <label className="field"><span>Target ({pct ? '%' : 'hours'})</span><input inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} placeholder={pct ? 'e.g. 90' : 'e.g. 120'} /></label>
            <label className="field"><span>Amber band ({pct ? 'points' : 'hours'})</span><input inputMode="decimal" value={amber} onChange={(e) => setAmber(e.target.value)} placeholder={pct ? 'e.g. 3' : 'e.g. 10'} /></label>
            <div className="field"><span>Applies from</span>
              <label className="small"><input type="radio" checked={from === 'next_shift'} onChange={() => setFrom('next_shift')} /> The next shift</label>
              <label className="small"><input type="radio" checked={from === 'date'} onChange={() => setFrom('date')} /> A date (00:00 site time) <input type="date" value={date} onChange={(e) => { setDate(e.target.value); setFrom('date'); }} /></label>
            </div>
            <label className="field"><span>Reason</span><input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. 2027 budget" /></label>
          </div>
          <p className="small muted">Affects: the Performance page, the weekly pack and red, amber and green on every PA and utilisation figure from that date. Past weeks keep the target that applied then.</p>
          <Errors list={errors} />
          {saved && <p className="small" role="status">✓ {saved}</p>}
          <button className="btn primary" onClick={save}>Save target</button>
        </fieldset>
      </section>

      <section className="card">
        <h3>Target history</h3>
        {history.length === 0 ? <p className="small muted">No targets set yet. The app uses placeholders (PA 90%, utilisation 85%).</p> : (
          <div className="table-wrap"><table>
            <thead><tr><th>KPI</th><th>Applies to</th><th className="num">Target</th><th>From</th><th>Set by</th><th>Set at</th><th>Reason</th></tr></thead>
            <tbody>{history.map((t) => <tr key={t.id}><td>{TARGET_KPIS[t.kpi].label}</td><td>{t.model ? `Model ${t.model}` : t.fleet ?? 'All'}</td><td className="num">{fmtTarget(t.kpi, t.value)}</td><td>{siteTime(t.effectiveFrom, tz, true)}</td><td>{t.setBy}</td><td>{siteTime(t.setAt, tz, true)}</td><td>{t.reason}</td></tr>)}</tbody>
          </table></div>
        )}
      </section>
    </>
  );
}

// ---------- flags and codes ----------

function Codes() {
  const app = useApp();
  const allowed = can(app.actor, 'edit_codes');
  const [edit, setEdit] = useState<ReasonCode | 'new' | null>(null);
  const live = app.codes.filter((c) => !c.retiredAt);
  const gone = app.codes.filter((c) => c.retiredAt);
  return (
    <>
      <section className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0 }}>Reason codes</h3>
          <button className="btn primary" disabled={!allowed} onClick={() => setEdit('new')}>Add code</button>
        </div>
        <p className="small muted">{allowed ? 'Codes are retired, never deleted, so old flags keep their reason.' : permission(app.actor.role, 'edit_codes') === 'propose' ? 'You can propose code changes once the approvals inbox arrives in phase 1b. The Admin makes changes for now.' : 'Only the Admin can change codes.'}</p>
        {edit && <CodeForm code={edit === 'new' ? null : edit} onDone={() => setEdit(null)} />}
        <div className="table-wrap" style={{ maxHeight: 360 }}>
          <table>
            <thead><tr><th>Code</th><th>Label</th><th>For</th><th>Maximo code</th><th /></tr></thead>
            <tbody>{live.map((c) => (
              <tr key={c.id}><td><code>{c.code}</code></td><td>{c.label}</td><td>{c.appliesTo}</td><td>{c.externalCode ?? <span className="muted">not mapped</span>}</td>
                <td>{allowed && <button className="btn" onClick={() => setEdit(c)}>Change</button>}</td></tr>
            ))}</tbody>
          </table>
        </div>
        {gone.length > 0 && (
          <details><summary className="small">Retired codes ({gone.length})</summary>
            <ul className="small">{gone.map((c) => <li key={c.id}><code>{c.code}</code> {c.label}: {c.retiredReason}</li>)}</ul>
          </details>
        )}
      </section>
      <FlagRules />
    </>
  );
}

function CodeForm({ code, onDone }: { code: ReasonCode | null; onDone: () => void }) {
  const app = useApp();
  const [c, setC] = useState(code?.code ?? '');
  const [label, setLabel] = useState(code?.label ?? '');
  const [appliesTo, setAppliesTo] = useState<ReasonCode['appliesTo']>(code?.appliesTo ?? 'unscheduled');
  const [ext, setExt] = useState(code?.externalCode ?? '');
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<string[] | null>(null);
  const inUse = code ? app.flags.filter((f) => f.reasonCode === code.label).length : 0;
  const save = () => {
    const r = code
      ? app.runConsole('codes', (x) => editCode(x, app.codes, code.id, { label, appliesTo, externalCode: ext }, reason))
      : app.runConsole('codes', (x) => addCode(x, app.codes, { code: c, label, appliesTo, externalCode: ext }));
    if (r.ok) onDone(); else setErrors(r.errors);
  };
  const retire = () => {
    const r = app.runConsole('codes', (x) => retireCode(x, app.codes, code!.id, reason));
    if (r.ok) onDone(); else setErrors(r.errors);
  };
  return (
    <Panel title={code ? `Change ${code.code}` : 'Add reason code'} onClose={onDone}>
      <div className="grid two">
        <label className="field"><span>Code</span><input value={c} disabled={!!code} onChange={(e) => setC(e.target.value.toUpperCase())} /></label>
        <label className="field"><span>Label shown when flagging</span><input value={label} onChange={(e) => setLabel(e.target.value)} /></label>
        <label className="field"><span>For</span><select value={appliesTo} onChange={(e) => setAppliesTo(e.target.value as ReasonCode['appliesTo'])}><option value="unscheduled">Unscheduled</option><option value="scheduled">Scheduled</option></select></label>
        <label className="field"><span>Maximo failure class or problem code</span><input value={ext} onChange={(e) => setExt(e.target.value)} /></label>
        {code && <label className="field"><span>Reason for the change</span><input value={reason} onChange={(e) => setReason(e.target.value)} /></label>}
      </div>
      {code && <p className="small muted">Affects: new flags only. {inUse} existing flags use this reason and keep it as entered.</p>}
      <Errors list={errors} />
      <div className="row">
        <button className="btn primary" onClick={save}>{code ? 'Save' : 'Add code'}</button>
        {code && <button className="btn danger" onClick={retire}>Retire code</button>}
      </div>
    </Panel>
  );
}
