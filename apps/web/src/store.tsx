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
  defaultReasonCodes,
  targetValue,
} from '@mr/core';
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
  /** Run a console command; on success keep its records and audit entries. */
  runConsole: <T>(cmd: (ctx: ConsoleContext) => ConsoleResult<T>, keep: (records: T[]) => void) => ConsoleResult<T>;
  setTargetList: (t: Target[]) => void;
  setUsers: (u: SiteUser[]) => void;
  setCodes: (c: ReasonCode[]) => void;
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
const newId = () => `local-${Date.now().toString(36)}-${++idSeq}`;

function readTheme(): 'light' | 'dark' {
  try {
    const t = localStorage.getItem('mr.theme');
    if (t === 'light' || t === 'dark') return t;
  } catch {
    /* storage can be unavailable */
  }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [ds, setDs] = useState<Dataset>(() => generateFleet({ seed: 42, units: 40, days: 120 }));
  const [importRuns, setImportRuns] = useState<ImportRun[]>([]);
  const [targetList, setTargetList] = useState<Target[]>([]);
  const [codes, setCodes] = useState<ReasonCode[]>(defaultReasonCodes);
  // Demo people, one per role, so "Viewing as" acts as a real user. Names are fictional.
  const [users, setUsers] = useState<SiteUser[]>(() => [
    ['viewer', 'Vic Viewer'], ['technician', 'Tia Technician'], ['supervisor', 'Sam Supervisor'],
    ['reliability_engineer', 'Rae Reliability'], ['superintendent', 'Sol Superintendent'], ['admin', 'Ada Admin'],
  ].map(([role, name]) => ({ id: `demo-${role}`, name: name!, email: `${role}@example.com`, role: role as Role, scope: ['*'], addedAt: '2026-01-01T00:00:00.000Z' })));
  const [flags, setFlags] = useState<DownFlag[]>(ds.flags);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [now, setNow] = useState(() => new Date().toISOString());
  const [role, setRole] = useState<Role>('supervisor');
  const [theme, setThemeState] = useState<'light' | 'dark'>(readTheme);
  const rules = DEFAULT_FLAG_RULES;

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

  const actor: Actor = useMemo(() => ({ userId: `demo-${role}`, role, scope: ['*'] }), [role]);

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
      }
      return r;
    },
    [actor, ds, flags, rules],
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
      setAudit((prev) => [
        { at, userId: actor.userId, action: `import_${r.kind}`, entity: 'import_run', entityId: run.id, before: null, after: { fileName, ...r.stats }, reason: `File import: ${fileName}` },
        ...prev,
      ]);
    },
    [actor],
  );

  const scope = { fleet: 'Haul trucks' };
  const targetOf = useCallback((kpi: TargetKpi) => targetValue(targetList, kpi, scope, now), [targetList, now]);
  const targets: PackTargets = { pa: targetOf('pa')!.value, utilisation: targetOf('utilisation')!.value };

  const runConsole = useCallback(
    <T,>(cmd: (ctx: ConsoleContext) => ConsoleResult<T>, keep: (records: T[]) => void): ConsoleResult<T> => {
      const nowIso = new Date().toISOString();
      const r = cmd({ actor, now: nowIso, newId, timeZone: ds.site.timeZone, calendar: ds.calendar });
      if (r.ok) {
        keep(r.records);
        setAudit((prev) => [...r.audit, ...prev]);
      }
      return r;
    },
    [actor, ds],
  );
  const value: AppState = { ds, targets, targetOf, targetList, users, codes, runConsole, setTargetList, setUsers, setCodes, importRuns, applyImport, newId, flags, audit, rules, now, actor, setRole, run, lastSync: ds.generatedAt, theme, setTheme };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp outside AppProvider');
  return v;
}
