// App state. For phase 1a development the data comes from the synthetic
// fleet in memory; the DataSource boundary is where Supabase plugs in.
// All writes go through the pure commands in @mr/core, so the screen can
// never do something the rules do not allow.

import {
  DEFAULT_FLAG_RULES,
  generateFleet,
  type Actor,
  type Asset,
  type AuditEntry,
  type CommandResult,
  type Dataset,
  type DownFlag,
  type FlagContext,
  type FlagRulesConfig,
  type ImportKind,
  type ImportResult,
  type PackTargets,
  type Role,
  type ConsoleContext,
  type ConsoleResult,
  type ReasonCode,
  type SiteUser,
  type Target,
  type TargetKpi,
  type ImprovementAction,
  type Rca,
  type Project,
  type WorkSettings,
  DEFAULT_WORK_SETTINGS,
  can,
  defaultReasonCodes,
  targetValue,
} from '@mr/core';
import { demoImprovements } from './data/demo-improve';
import { saveFlags, saveRecords, saveSetting, saveTarget, saveTaskStatus, type Loaded } from './data/remote';
import { demoProjects } from './data/demo-projects';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

/** One file load, as a sync run (plan 6.3: every run is logged with counts and errors). */
export interface ImportRun {
  id: string;
  at: string;
  by: string;
  fileName: string;
  kind: ImportKind;
  stats: ImportResult<unknown>['stats'];
  issues: ImportResult<unknown>['issues'];
}

export interface AppState {
  ds: Dataset;
  /** PA and utilisation targets in force now, for the haul truck fleet. */
  targets: PackTargets;
  /** Target in force now for a KPI, with its amber band; `set` is false while it is still the placeholder. */
  targetOf: (kpi: TargetKpi) => { value: number; amber: number; set: boolean } | undefined;
  targetList: Target[];
  users: SiteUser[];
  codes: ReasonCode[];
  /** Run a console command; on success keep its records and audit entries (and save them when live). */
  runConsole: <T>(kind: 'targets' | 'users' | 'codes', cmd: (ctx: ConsoleContext) => ConsoleResult<T>) => ConsoleResult<T>;
  actions: ImprovementAction[];
  rcas: Rca[];
  projects: Project[];
  workSettings: WorkSettings;
  /** Run a work settings command; on success keep and save the new settings. */
  runWorkSettings: (cmd: (ctx: ConsoleContext) => ConsoleResult<WorkSettings>) => ConsoleResult<WorkSettings>;
  /** Run an action, RCA or project command; same as runConsole. */
  runImprove: <T>(kind: 'actions' | 'rcas' | 'projects', cmd: (ctx: ConsoleContext) => ConsoleResult<T>) => ConsoleResult<T>;
  /** Users who can own an action or lead an RCA: active, and signed in at least once. */
  people: SiteUser[];
  userName: (id: string) => string;
  /** 'demo' runs on the synthetic fleet in this browser; 'live' reads and saves through Supabase. */
  mode: 'demo' | 'live';
  /** Set when a save to the database failed; the screen shows it and the data is reloaded. */
  syncError: string | null;
  clearSyncError: () => void;
  signOut?: () => void;
  importRuns: ImportRun[];
  applyImport: (fileName: string, r: ImportResult<unknown>) => void;
  newId: () => string;
  flags: DownFlag[];
  audit: AuditEntry[];
  rules: FlagRulesConfig;
  now: string;
  actor: Actor;
  setRole: (r: Role) => void;
  run: (asset: Asset, cmd: (ctx: FlagContext) => CommandResult) => CommandResult;
  lastSync: string;
  theme: 'light' | 'dark';
  setTheme: (t: 'light' | 'dark') => void;
}

const Ctx = createContext<AppState | null>(null);

let idSeq = 0;
// Live records need database ids (uuid); demo ids just need to be unique.
const newId = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `local-${Date.now().toString(36)}-${++idSeq}`);

function readTheme(): 'light' | 'dark' {
  try {
    const t = localStorage.getItem('mr.theme');
    if (t === 'light' || t === 'dark') return t;
  } catch {
    /* storage can be unavailable */
  }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function AppProvider({ children, live, onReload, onSignOut }: { children: ReactNode; live?: Loaded; onReload?: () => void; onSignOut?: () => void }) {
  const [ds, setDs] = useState<Dataset>(() => live?.ds ?? generateFleet({ seed: 42, units: 40, days: 120 }));
  const [syncError, setSyncError] = useState<string | null>(null);
  const [importRuns, setImportRuns] = useState<ImportRun[]>([]);
  const [targetList, setTargetList] = useState<Target[]>(() => live?.targets ?? []);
  const [codes, setCodes] = useState<ReasonCode[]>(() => (live?.codes.length ? live.codes : defaultReasonCodes()));
  // Demo people, one per role, so "Viewing as" acts as a real user. Names are fictional.
  const [users, setUsers] = useState<SiteUser[]>(() => live?.users ?? [
    ['viewer', 'Vic Viewer'], ['technician', 'Tia Technician'], ['supervisor', 'Sam Supervisor'],
    ['reliability_engineer', 'Rae Reliability'], ['superintendent', 'Sol Superintendent'], ['admin', 'Ada Admin'],
  ].map(([role, name]) => ({ id: `demo-${role}`, name: name!, email: `${role}@example.com`, role: role as Role, scope: ['*'], addedAt: '2026-01-01T00:00:00.000Z' })));
  const [flags, setFlags] = useState<DownFlag[]>(ds.flags);
  const [improve, setImprove] = useState(() => (live ? { actions: live.actions, rcas: live.rcas, projects: live.projects } : { ...demoImprovements(ds), projects: demoProjects(ds) }));
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [now, setNow] = useState(() => new Date().toISOString());
  const [role, setRole] = useState<Role>('supervisor');
  const [theme, setThemeState] = useState<'light' | 'dark'>(readTheme);
  const rules = live?.rules ?? DEFAULT_FLAG_RULES;
  const siteId = ds.site.id;
  // A failed save means the screen no longer matches the database: say so, then reload.
  const failed = useCallback((e: unknown) => { setSyncError(e instanceof Error ? e.message : String(e)); onReload?.(); }, [onReload]);

  useEffect(() => {
    const t = setInterval(() => setNow(new Date().toISOString()), 60_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const setTheme = useCallback((t: 'light' | 'dark') => {
    setThemeState(t);
    try {
      localStorage.setItem('mr.theme', t);
    } catch {
      /* ignore */
    }
  }, []);

  const actor: Actor = useMemo(
    () => (live ? { userId: live.me, role: live.role, scope: live.users.find((u) => u.id === live.me)?.scope ?? [] } : { userId: `demo-${role}`, role, scope: ['*'] }),
    [role, live],
  );

  const run = useCallback(
    (asset: Asset, cmd: (ctx: FlagContext) => CommandResult): CommandResult => {
      const nowIso = new Date().toISOString();
      const lc = ds.lifecycle.find((l) => l.assetId === asset.id && Date.parse(l.start) <= Date.parse(nowIso) && (!l.end || Date.parse(nowIso) < Date.parse(l.end)));
      const ctx: FlagContext = {
        now: nowIso,
        actor,
        rules,
        calendar: ds.calendar,
        asset,
        lifecycle: lc?.status ?? 'active',
        unitFlags: flags.filter((f) => f.unitId === asset.id),
        siteOpenFlags: flags.filter((f) => f.state === 'open'),
        shopLines: ds.shopLines,
        lineClosures: ds.closures,
        newId,
      };
      const r = cmd(ctx);
      if (r.ok) {
        setFlags((prev) => {
          const next = [...prev];
          for (const f of r.flags) {
            const i = next.findIndex((x) => x.id === f.id);
            if (i >= 0) next[i] = f;
            else next.push(f);
          }
          return next;
        });
        setAudit((prev) => [...r.audit, ...prev]);
        setNow(nowIso);
        if (live) saveFlags(siteId, r.flags, r.audit).catch(failed);
      }
      return r;
    },
    [actor, ds, flags, rules, live, failed],
  );

  const applyImport = useCallback(
    (fileName: string, r: ImportResult<unknown>) => {
      const at = new Date().toISOString();
      setDs((prev) => {
        if (r.kind === 'assets') return { ...prev, assets: r.records as Dataset['assets'] };
        if (r.kind === 'work_orders') return { ...prev, workOrders: r.records as Dataset['workOrders'] };
        return { ...prev, smu: r.records as Dataset['smu'] };
      });
      const run: ImportRun = { id: newId(), at, by: actor.userId, fileName, kind: r.kind, stats: r.stats, issues: r.issues };
      setImportRuns((prev) => [run, ...prev]);
      const entry: AuditEntry = { at, userId: actor.userId, action: `import_${r.kind}`, entity: 'import_run', entityId: run.id, before: null, after: { fileName, ...r.stats }, reason: `File import: ${fileName}` };
      setAudit((prev) => [entry, ...prev]);
      if (live) {
        const changed = [...r.inserted, ...r.updated.map((u) => u.after)];
        saveRecords(siteId, r.kind, changed, [entry]).catch(failed);
      }
    },
    [actor, live, failed],
  );

  const scope = { fleet: 'Haul trucks' };
  const targetOf = useCallback((kpi: TargetKpi) => targetValue(targetList, kpi, scope, now), [targetList, now]);
  const targets: PackTargets = { pa: targetOf('pa')!.value, utilisation: targetOf('utilisation')!.value };

  const runConsole = useCallback(
    <T,>(kind: 'targets' | 'users' | 'codes', cmd: (ctx: ConsoleContext) => ConsoleResult<T>): ConsoleResult<T> => {
      const nowIso = new Date().toISOString();
      const r = cmd({ actor, now: nowIso, newId, timeZone: ds.site.timeZone, calendar: ds.calendar });
      if (r.ok) {
        if (kind === 'targets') setTargetList(r.records as Target[]);
        else if (kind === 'users') setUsers(r.records as SiteUser[]);
        else setCodes(r.records as ReasonCode[]);
        setAudit((prev) => [...r.audit, ...prev]);
        if (live) {
          // Save only the records this command touched.
          const ids = new Set(r.audit.map((a) => a.entityId));
          const changed = (r.records as Array<{ id: string }>).filter((x) => ids.has(x.id));
          const p = kind === 'targets' ? Promise.all(changed.map((t) => saveTarget(siteId, t as Target, r.audit))) : saveRecords(siteId, kind, changed, r.audit);
          p.catch(failed);
        }
      }
      return r;
    },
    [actor, ds, live, failed],
  );
  const [workSettings, setWorkSettingsState] = useState<WorkSettings>(() => live?.workSettings ?? { ...DEFAULT_WORK_SETTINGS, craftHoursPerWeek: 480 });
  const runWorkSettings = useCallback(
    (cmd: (ctx: ConsoleContext) => ConsoleResult<WorkSettings>): ConsoleResult<WorkSettings> => {
      const r = cmd({ actor, now: new Date().toISOString(), newId, timeZone: ds.site.timeZone, calendar: ds.calendar });
      if (r.ok) {
        setWorkSettingsState(r.records[0]!);
        setAudit((prev) => [...r.audit, ...prev]);
        if (live) saveSetting(siteId, 'work', r.records[0]!, r.audit[0]!.reason ?? '', r.audit).catch(failed);
      }
      return r;
    },
    [actor, ds, live, failed],
  );
  const runImprove = useCallback(
    <T,>(kind: 'actions' | 'rcas' | 'projects', cmd: (ctx: ConsoleContext) => ConsoleResult<T>): ConsoleResult<T> => {
      const nowIso = new Date().toISOString();
      const r = cmd({ actor, now: nowIso, newId, timeZone: ds.site.timeZone, calendar: ds.calendar });
      if (r.ok) {
        setImprove((prev) => ({ ...prev, [kind]: r.records }));
        setAudit((prev) => [...r.audit, ...prev]);
        setNow(nowIso);
        if (live) {
          const ids = new Set(r.audit.map((a) => a.entityId));
          const changed = (r.records as Array<{ id: string }>).filter((x) => ids.has(x.id));
          if (kind === 'projects' && !can(actor, 'run_projects')) {
            // A task owner: the database lets them change only their own task's status.
            const before = r.audit[0]!.before as Project;
            const after = changed[0] as Project;
            const t = after.tasks.find((x) => before.tasks.find((y) => y.id === x.id)?.status !== x.status);
            if (t) saveTaskStatus(siteId, after.id, t.id, t.status, t.note).catch(failed);
          } else {
            saveRecords(siteId, kind, changed, r.audit).catch(failed);
          }
        }
      }
      return r;
    },
    [actor, ds, live, failed],
  );
  const people = useMemo(() => users.filter((u) => !u.retiredAt && !u.invited), [users]);
  const userName = useCallback((id: string) => users.find((u) => u.id === id)?.name ?? 'Unknown user', [users]);
  const value: AppState = { ds, workSettings, runWorkSettings, actions: improve.actions, rcas: improve.rcas, projects: improve.projects, runImprove, people, userName, targets, targetOf, targetList, users, codes, runConsole, mode: live ? 'live' : 'demo', syncError, clearSyncError: () => setSyncError(null), signOut: onSignOut, importRuns, applyImport, newId, flags, audit, rules, now, actor, setRole, run, lastSync: ds.generatedAt, theme, setTheme };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp outside AppProvider');
  return v;
}
