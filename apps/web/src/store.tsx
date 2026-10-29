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
  type AlertAnswer,
  type SavedAnalysis,
  type SavedView,
  type ApprovalRequest,
  type DecideResult,
  decideRequest,
  type RuleAlert,
  ruleAlerts,
  type AlertSettings,
  type Inspection,
  type InspectionForm,
  DEFAULT_ALERT_SETTINGS,
  DEFAULT_WORK_SETTINGS,
  can,
  defaultReasonCodes,
  targetValue,
  smuIndex, type Component, type ComponentData, type ComponentEvent, type LifeTarget, type RecordResult,
  DEFAULT_CONDITION_SETTINGS, type CmResponse, type ConditionData, type ConditionSettings, type OilSample,
  DEFAULT_RCM_SETTINGS, type JobPlanVersion, type RcmMode, type RcmSettings, DEFAULT_SPARES_SETTINGS, type SparesSettings,
  DEFAULT_ASSIST_SETTINGS, STARTER_CODES, buildSuggester, type AssistSettings, type Suggester,
  DEFAULT_PLANT_SETTINGS, generatePlant, type ClassifyResult, type DelayContext, type PlantSettings, type ProcessDelay, type RunSignal,
} from '@mr/core';
import { demoImprovements } from './data/demo-improve';
import { saveProcessDelays, saveRunSignals, type PlantData, saveRcmModes, saveJobPlanVersion, saveCmResponse, saveOilSamples, saveComponentRecord, saveViewRecord, saveAnalysisRecord, loadPhoto, saveForms, sendInspection, sendPhoto, SendError, saveAlertAnswer, saveDecision, saveRequests, saveFlags, saveRecords, saveSetting, saveTarget, saveTaskStatus, type Loaded } from './data/remote';
import { demoProjects } from './data/demo-projects';
import { demoForms, demoInspections } from './data/demo-inspections';
import { backoffMs, forgetPhoto, localPhoto, readDrafts, readOutbox, writeDrafts, writeOutbox, type OutboxItem } from './inspect/device';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

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
  alertSettings: AlertSettings;
  runAlertSettings: (cmd: (ctx: ConsoleContext) => ConsoleResult<AlertSettings>) => ConsoleResult<AlertSettings>;
  /** Answers to reliability and threshold alerts, oldest first. Never changed; a newer answer takes over. */
  alertAnswers: AlertAnswer[];
  /** Approval requests this person can see (docs/approvals.md). */
  requests: ApprovalRequest[];
  /** Ask, add a note or withdraw. */
  runRequest: (cmd: (ctx: ConsoleContext) => ConsoleResult<ApprovalRequest>) => ConsoleResult<ApprovalRequest>;
  /** Approve or reject; an approval applies the change. */
  decide: (id: string, decision: 'approve' | 'reject', note: string) => DecideResult;
  /** Reliability and threshold alerts true now, answered or not (docs/alert-rules.md). */
  ruleAlerts: RuleAlert[];
  runAlertAnswer: (cmd: (ctx: ConsoleContext) => ConsoleResult<AlertAnswer>) => ConsoleResult<AlertAnswer>;
  /** Saved calculator results, voided ones included (docs/calculators.md). */
  analyses: SavedAnalysis[];
  /** Save or void an analysis; the command gets the current list and returns the new one. */
  runAnalysis: (cmd: (ctx: ConsoleContext, list: SavedAnalysis[]) => ConsoleResult<SavedAnalysis>) => ConsoleResult<SavedAnalysis>;
  /** Saved explorer views this person can see, retired ones included (docs/analytics-explorer.md). */
  views: SavedView[];
  runView: (cmd: (ctx: ConsoleContext, list: SavedView[]) => ConsoleResult<SavedView>) => ConsoleResult<SavedView>;
  /** Component serials, their events and target lives (docs/component-life.md). Costs only for cost roles. */
  components: Component[];
  componentEvents: ComponentEvent[];
  lifeTargets: LifeTarget[];
  /** Register a component, record an event or void one. */
  runComponents: (cmd: (ctx: ConsoleContext, data: ComponentData) => RecordResult) => RecordResult;
  /** Oil samples (voided ones included), responses and settings (docs/condition-monitoring.md). */
  oilSamples: OilSample[];
  cmResponses: CmResponse[];
  conditionSettings: ConditionSettings;
  /** Enter, import or void samples. The command gets the current data and returns the new sample list. */
  runSamples: <R extends ConsoleResult<OilSample>>(cmd: (ctx: ConsoleContext, data: ConditionData, s: ConditionSettings) => R) => R;
  runResponse: (cmd: (ctx: ConsoleContext, data: ConditionData) => ConsoleResult<CmResponse>) => ConsoleResult<CmResponse>;
  runConditionSettings: (cmd: (ctx: ConsoleContext, current: ConditionSettings) => ConsoleResult<ConditionSettings>) => ConsoleResult<ConditionSettings>;
  /** RCM failure mode revisions, issued job plans and settings (docs/rcm.md). */
  rcmModes: RcmMode[];
  jobPlanVersions: JobPlanVersion[];
  rcmSettings: RcmSettings;
  runRcm: (cmd: (ctx: ConsoleContext, modes: RcmMode[]) => ConsoleResult<RcmMode>) => ConsoleResult<RcmMode>;
  runJobPlan: (cmd: (ctx: ConsoleContext, versions: JobPlanVersion[]) => ConsoleResult<JobPlanVersion>) => ConsoleResult<JobPlanVersion>;
  runRcmSettings: (cmd: (ctx: ConsoleContext, current: RcmSettings) => ConsoleResult<RcmSettings>) => ConsoleResult<RcmSettings>;
  sparesSettings: SparesSettings;
  runSparesSettings: (cmd: (ctx: ConsoleContext, current: SparesSettings) => ConsoleResult<SparesSettings>) => ConsoleResult<SparesSettings>;
  /** Assist settings and the code suggester, learned from this site's released flags (docs/ai-assist.md). */
  assistSettings: AssistSettings;
  runAssistSettings: (cmd: (ctx: ConsoleContext, current: AssistSettings) => ConsoleResult<AssistSettings>) => ConsoleResult<AssistSettings>;
  suggester: Suggester;
  /** Fixed plant (docs/fixed-plant.md): structure, equipment, their flags, process delays and historian signals. */
  plant: PlantData;
  plantSettings: PlantSettings;
  runPlantSettings: (cmd: (ctx: ConsoleContext, current: PlantSettings) => ConsoleResult<PlantSettings>) => ConsoleResult<PlantSettings>;
  /** Record, end or void a process delay. `area` is the plant scope for the permission check. */
  runDelay: (area: string, cmd: (ctx: DelayContext, delays: ProcessDelay[]) => ConsoleResult<ProcessDelay>) => ConsoleResult<ProcessDelay>;
  /** Classify historian stops as a process delay: one delay record and the proposals rejected together. */
  runClassify: (area: string, cmd: (ctxFor: (assetId: string) => FlagContext, dctx: DelayContext, delays: ProcessDelay[]) => ClassifyResult) => ClassifyResult;
  /** Keep historian signals loaded from a file. Stops in them are proposed with `run` and proposeStop. */
  addSignals: (fileName: string, signals: RunSignal[], stats: { rows: number; added: number; skipped: number }) => void;
  /** Inspection forms, every version (docs/inspections.md). */
  forms: InspectionForm[];
  runForms: (cmd: (ctx: ConsoleContext) => ConsoleResult<InspectionForm>) => ConsoleResult<InspectionForm>;
  /** Submitted, signed-off and voided inspections, including ones still in this device's outbox. */
  inspections: Inspection[];
  /** This person's drafts on this device. */
  drafts: Inspection[];
  /** Keep a draft on the device (start, or each answer as it is filled in). */
  saveDraft: (i: Inspection) => boolean;
  /** Drop a draft from the device; it never reached the database. */
  discardDraft: (id: string) => void;
  /** Run an inspection command. A submitted or changed inspection goes to the outbox. */
  runInspection: (cmd: (ctx: ConsoleContext) => ConsoleResult<Inspection>, photos?: Array<{ id: string; itemId: string }>) => ConsoleResult<Inspection>;
  /** Waiting to reach the database, oldest first. */
  outbox: OutboxItem[];
  /** Try the outbox now. */
  sendOutbox: () => void;
  /** Take a refused item out of the outbox. */
  dropOutboxItem: (id: string) => void;
  /** A photo by id, from this device or the database. */
  photo: (id: string) => Promise<string | undefined>;
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
  const [plant, setPlant] = useState<PlantData>(() => live?.plant ?? generatePlant({ seed: 42, days: 120, end: Date.parse(ds.generatedAt), timeZone: ds.site.timeZone, tenantId: ds.tenantId, siteId: ds.site.id }));
  const [plantSettings, setPlantSettings] = useState<PlantSettings>(() => live?.plantSettings ?? DEFAULT_PLANT_SETTINGS);
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

  const flagCtx = useCallback((asset: Asset, nowIso: string): FlagContext => {
    const list = asset.assetClass === 'fixed_plant' ? plant.flags : flags;
    const lc = ds.lifecycle.find((l) => l.assetId === asset.id && Date.parse(l.start) <= Date.parse(nowIso) && (!l.end || Date.parse(nowIso) < Date.parse(l.end)));
    return {
      now: nowIso,
      actor,
      rules,
      calendar: ds.calendar,
      asset,
      lifecycle: lc?.status ?? 'active',
      unitFlags: list.filter((f) => f.unitId === asset.id),
      siteOpenFlags: list.filter((f) => f.state === 'open'),
      shopLines: ds.shopLines,
      lineClosures: ds.closures,
      newId,
    };
  }, [actor, ds, flags, plant.flags, rules]);
  const keepFlags = useCallback((changed: DownFlag[], plantSide: boolean) => {
    const merge = (prev: DownFlag[]) => {
      const next = [...prev];
      for (const f of changed) {
        const i = next.findIndex((x) => x.id === f.id);
        if (i >= 0) next[i] = f;
        else next.push(f);
      }
      return next;
    };
    if (plantSide) setPlant((p) => ({ ...p, flags: merge(p.flags) }));
    else setFlags(merge);
  }, []);

  // Plant equipment flags go to the plant's list; everything else to the fleet's.
  const run = useCallback(
    (asset: Asset, cmd: (ctx: FlagContext) => CommandResult): CommandResult => {
      const nowIso = new Date().toISOString();
      const r = cmd(flagCtx(asset, nowIso));
      if (r.ok) {
        keepFlags(r.flags, asset.assetClass === 'fixed_plant');
        setAudit((prev) => [...r.audit, ...prev]);
        setNow(nowIso);
        if (live) saveFlags(siteId, r.flags, r.audit).catch(failed);
      }
      return r;
    },
    [flagCtx, keepFlags, live, failed],
  );

  const runDelay = useCallback(
    (area: string, cmd: (ctx: DelayContext, delays: ProcessDelay[]) => ConsoleResult<ProcessDelay>): ConsoleResult<ProcessDelay> => {
      const nowIso = new Date().toISOString();
      const r = cmd({ actor, now: nowIso, newId, timeZone: ds.site.timeZone, calendar: ds.calendar, area }, plant.delays);
      if (r.ok) {
        setPlant((p) => {
          const next = [...p.delays];
          for (const d of r.records) {
            const i = next.findIndex((x) => x.id === d.id);
            if (i >= 0) next[i] = d;
            else next.push(d);
          }
          return { ...p, delays: next };
        });
        setAudit((prev) => [...r.audit, ...prev]);
        setNow(nowIso);
        if (live) saveProcessDelays(siteId, r.records, r.audit).catch(failed);
      }
      return r;
    },
    [actor, ds, plant.delays, live, failed],
  );

  const runClassify = useCallback(
    (area: string, cmd: (ctxFor: (assetId: string) => FlagContext, dctx: DelayContext, delays: ProcessDelay[]) => ClassifyResult): ClassifyResult => {
      const nowIso = new Date().toISOString();
      const byId = new Map(plant.equipment.map((a) => [a.id, a]));
      const r = cmd((id) => flagCtx(byId.get(id)!, nowIso), { actor, now: nowIso, newId, timeZone: ds.site.timeZone, calendar: ds.calendar, area }, plant.delays);
      if (r.ok) {
        keepFlags(r.flags, true);
        setPlant((p) => ({ ...p, delays: [...p.delays, ...r.delays] }));
        setAudit((prev) => [...r.audit, ...prev]);
        setNow(nowIso);
        if (live) {
          const delayAudit = r.audit.filter((a) => a.entity === 'process_delay');
          const flagAudit = r.audit.filter((a) => a.entity !== 'process_delay');
          saveProcessDelays(siteId, r.delays, delayAudit).then(() => saveFlags(siteId, r.flags, flagAudit)).catch(failed);
        }
      }
      return r;
    },
    [actor, ds, plant.delays, plant.equipment, flagCtx, keepFlags, live, failed],
  );

  const addSignals = useCallback(
    (fileName: string, signals: RunSignal[], stats: { rows: number; added: number; skipped: number }) => {
      const at = new Date().toISOString();
      setPlant((p) => ({ ...p, signals: [...p.signals, ...signals] }));
      const entry: AuditEntry = { at, userId: actor.userId, action: 'import_run_signals', entity: 'import_run', entityId: newId(), before: null, after: { fileName, ...stats }, reason: `File import: ${fileName}` };
      setAudit((prev) => [entry, ...prev]);
      setNow(at);
      if (live) saveRunSignals(siteId, signals, [entry]).catch(failed);
    },
    [actor, live, failed],
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
  const [alertSettings, setAlertSettingsState] = useState<AlertSettings>(() => live?.alertSettings ?? DEFAULT_ALERT_SETTINGS);
  const runAlertSettings = useCallback(
    (cmd: (ctx: ConsoleContext) => ConsoleResult<AlertSettings>): ConsoleResult<AlertSettings> => {
      const r = cmd({ actor, now: new Date().toISOString(), newId, timeZone: ds.site.timeZone, calendar: ds.calendar });
      if (r.ok) {
        setAlertSettingsState(r.records[0]!);
        setAudit((prev) => [...r.audit, ...prev]);
        if (live) saveSetting(siteId, 'alerts', r.records[0]!, r.audit[0]!.reason ?? '', r.audit).catch(failed);
      }
      return r;
    },
    [actor, ds, live, failed],
  );
  const [alertAnswers, setAlertAnswers] = useState<AlertAnswer[]>(() => live?.alertAnswers ?? []);
  const runAlertAnswer = useCallback(
    (cmd: (ctx: ConsoleContext) => ConsoleResult<AlertAnswer>): ConsoleResult<AlertAnswer> => {
      const nowIso = new Date().toISOString();
      const r = cmd({ actor, now: nowIso, newId, timeZone: ds.site.timeZone, calendar: ds.calendar });
      if (r.ok) {
        setAlertAnswers((prev) => [...prev, ...r.records]);
        setAudit((prev) => [...r.audit, ...prev]);
        if (live) saveAlertAnswer(siteId, r.records[0]!, r.audit).catch(failed);
      }
      return r;
    },
    [actor, ds, live, failed],
  );
  const [analyses, setAnalyses] = useState<SavedAnalysis[]>(() => live?.analyses ?? []);
  const analysesRef = useRef(analyses);
  analysesRef.current = analyses;
  const runAnalysis = useCallback(
    (cmd: (ctx: ConsoleContext, list: SavedAnalysis[]) => ConsoleResult<SavedAnalysis>): ConsoleResult<SavedAnalysis> => {
      const r = cmd({ actor, now: new Date().toISOString(), newId, timeZone: ds.site.timeZone, calendar: ds.calendar }, analysesRef.current);
      if (r.ok) {
        analysesRef.current = r.records;
        setAnalyses(r.records);
        setAudit((prev) => [...r.audit, ...prev]);
        const changed = r.records.find((x) => x.id === r.audit[0]?.entityId);
        if (live && changed) saveAnalysisRecord(siteId, changed, r.audit).catch(failed);
      }
      return r;
    },
    [actor, ds, live, failed],
  );
  const [views, setViews] = useState<SavedView[]>(() => live?.views ?? []);
  const viewsRef = useRef(views);
  viewsRef.current = views;
  const runView = useCallback(
    (cmd: (ctx: ConsoleContext, list: SavedView[]) => ConsoleResult<SavedView>): ConsoleResult<SavedView> => {
      const r = cmd({ actor, now: new Date().toISOString(), newId, timeZone: ds.site.timeZone, calendar: ds.calendar }, viewsRef.current);
      if (r.ok) {
        viewsRef.current = r.records;
        setViews(r.records);
        setAudit((prev) => [...r.audit, ...prev]);
        const changed = r.records.find((x) => x.id === r.audit[0]?.entityId);
        if (live && changed) saveViewRecord(siteId, changed, r.audit).catch(failed);
      }
      return r;
    },
    [actor, ds, live, failed],
  );
  const smuIdx = useMemo(() => smuIndex(ds.smu), [ds.smu]);
  const [components, setComponents] = useState<Component[]>(ds.components ?? []);
  const [componentEvents, setComponentEvents] = useState<ComponentEvent[]>(ds.componentEvents ?? []);
  const compRef = useRef({ components, events: componentEvents });
  compRef.current = { components, events: componentEvents };
  const runComponents = useCallback(
    (cmd: (ctx: ConsoleContext, data: ComponentData) => RecordResult): RecordResult => {
      const prev = compRef.current;
      const r = cmd({ actor, now: new Date().toISOString(), newId, timeZone: ds.site.timeZone, calendar: ds.calendar }, { components: prev.components, events: prev.events, assets: ds.assets, smu: smuIdx });
      if (r.ok) {
        compRef.current = { components: r.components, events: r.events };
        setComponents(r.components);
        setComponentEvents(r.events);
        setAudit((a) => [...r.audit, ...a]);
        const before = new Map(prev.events.map((e) => [e.id, e]));
        const changed = r.events.filter((e) => before.get(e.id) !== e);
        const added = r.components.find((c) => !prev.components.includes(c)) ?? null;
        if (live) saveComponentRecord(siteId, added, changed, r.audit).catch(failed);
      }
      return r;
    },
    [actor, ds, smuIdx, live, failed],
  );
  const [lifeTargets, setLifeTargets] = useState<LifeTarget[]>(ds.lifeTargets ?? []);

  const [oilSamples, setOilSamples] = useState<OilSample[]>(ds.oilSamples ?? []);
  const [cmResponses, setCmResponses] = useState<CmResponse[]>(ds.cmResponses ?? []);
  const [conditionSettings, setConditionSettingsState] = useState<ConditionSettings>(() => live?.conditionSettings ?? DEFAULT_CONDITION_SETTINGS);
  const condRef = useRef({ samples: oilSamples, responses: cmResponses, settings: conditionSettings });
  condRef.current = { samples: oilSamples, responses: cmResponses, settings: conditionSettings };
  const runSamples = useCallback(
    <R extends ConsoleResult<OilSample>,>(cmd: (ctx: ConsoleContext, data: ConditionData, s: ConditionSettings) => R): R => {
      const prev = condRef.current;
      const r = cmd({ actor, now: new Date().toISOString(), newId, timeZone: ds.site.timeZone, calendar: ds.calendar }, { samples: prev.samples, responses: prev.responses, assets: ds.assets }, prev.settings);
      if (r.ok) {
        condRef.current = { ...prev, samples: r.records };
        setOilSamples(r.records);
        setAudit((a) => [...r.audit, ...a]);
        const before = new Map(prev.samples.map((x) => [x.id, x]));
        const added = r.records.filter((x) => !before.has(x.id));
        const voided = r.records.filter((x) => before.has(x.id) && before.get(x.id) !== x && x.voidedAt);
        if (live && (added.length || voided.length)) saveOilSamples(siteId, added, voided, r.audit).catch(failed);
      }
      return r;
    },
    [actor, ds, live, failed],
  );
  const runResponse = useCallback(
    (cmd: (ctx: ConsoleContext, data: ConditionData) => ConsoleResult<CmResponse>): ConsoleResult<CmResponse> => {
      const prev = condRef.current;
      const r = cmd({ actor, now: new Date().toISOString(), newId, timeZone: ds.site.timeZone, calendar: ds.calendar }, { samples: prev.samples, responses: prev.responses, assets: ds.assets });
      if (r.ok) {
        condRef.current = { ...prev, responses: r.records };
        setCmResponses(r.records);
        setAudit((a) => [...r.audit, ...a]);
        const added = r.records.filter((x) => !prev.responses.includes(x));
        if (live) for (const x of added) saveCmResponse(siteId, x, r.audit).catch(failed);
      }
      return r;
    },
    [actor, ds, live, failed],
  );
  const runConditionSettings = useCallback(
    (cmd: (ctx: ConsoleContext, current: ConditionSettings) => ConsoleResult<ConditionSettings>): ConsoleResult<ConditionSettings> => {
      const r = cmd({ actor, now: new Date().toISOString(), newId, timeZone: ds.site.timeZone, calendar: ds.calendar }, condRef.current.settings);
      if (r.ok) {
        condRef.current = { ...condRef.current, settings: r.records[0]! };
        setConditionSettingsState(r.records[0]!);
        setAudit((a) => [...r.audit, ...a]);
        if (live) saveSetting(siteId, 'condition', r.records[0]!, r.audit[0]!.reason ?? '', r.audit).catch(failed);
      }
      return r;
    },
    [actor, ds, live, failed],
  );
  const [rcmModes, setRcmModes] = useState<RcmMode[]>(ds.rcmModes ?? []);
  const [jobPlanVersions, setJobPlanVersions] = useState<JobPlanVersion[]>(ds.jobPlanVersions ?? []);
  const [rcmSettings, setRcmSettingsState] = useState<RcmSettings>(() => live?.rcmSettings ?? DEFAULT_RCM_SETTINGS);
  const rcmRef = useRef({ modes: rcmModes, versions: jobPlanVersions, settings: rcmSettings });
  rcmRef.current = { modes: rcmModes, versions: jobPlanVersions, settings: rcmSettings };
  const runRcm = useCallback(
    (cmd: (ctx: ConsoleContext, modes: RcmMode[]) => ConsoleResult<RcmMode>): ConsoleResult<RcmMode> => {
      const prev = rcmRef.current;
      const r = cmd({ actor, now: new Date().toISOString(), newId, timeZone: ds.site.timeZone, calendar: ds.calendar }, prev.modes);
      if (r.ok) {
        rcmRef.current = { ...prev, modes: r.records };
        setRcmModes(r.records);
        setAudit((a) => [...r.audit, ...a]);
        const before = new Map(prev.modes.map((x) => [x.id, x]));
        const added = r.records.filter((x) => !before.has(x.id));
        const retired = r.records.filter((x) => before.has(x.id) && before.get(x.id) !== x && x.retiredAt);
        if (live && (added.length || retired.length)) saveRcmModes(siteId, added, retired, r.audit).catch(failed);
      }
      return r;
    },
    [actor, ds, live, failed],
  );
  const runJobPlan = useCallback(
    (cmd: (ctx: ConsoleContext, versions: JobPlanVersion[]) => ConsoleResult<JobPlanVersion>): ConsoleResult<JobPlanVersion> => {
      const prev = rcmRef.current;
      const r = cmd({ actor, now: new Date().toISOString(), newId, timeZone: ds.site.timeZone, calendar: ds.calendar }, prev.versions);
      if (r.ok) {
        rcmRef.current = { ...prev, versions: r.records };
        setJobPlanVersions(r.records);
        setAudit((a) => [...r.audit, ...a]);
        const added = r.records.filter((x) => !prev.versions.includes(x));
        if (live) for (const v of added) saveJobPlanVersion(siteId, v, r.audit).catch(failed);
      }
      return r;
    },
    [actor, ds, live, failed],
  );
  const runRcmSettings = useCallback(
    (cmd: (ctx: ConsoleContext, current: RcmSettings) => ConsoleResult<RcmSettings>): ConsoleResult<RcmSettings> => {
      const r = cmd({ actor, now: new Date().toISOString(), newId, timeZone: ds.site.timeZone, calendar: ds.calendar }, rcmRef.current.settings);
      if (r.ok) {
        rcmRef.current = { ...rcmRef.current, settings: r.records[0]! };
        setRcmSettingsState(r.records[0]!);
        setAudit((a) => [...r.audit, ...a]);
        if (live) saveSetting(siteId, 'rcm', r.records[0]!, r.audit[0]!.reason ?? '', r.audit).catch(failed);
      }
      return r;
    },
    [actor, ds, live, failed],
  );
  const [sparesSettings, setSparesSettingsState] = useState<SparesSettings>(() => live?.sparesSettings ?? DEFAULT_SPARES_SETTINGS);
  const sparesRef = useRef(sparesSettings);
  sparesRef.current = sparesSettings;
  const runSparesSettings = useCallback(
    (cmd: (ctx: ConsoleContext, current: SparesSettings) => ConsoleResult<SparesSettings>): ConsoleResult<SparesSettings> => {
      const r = cmd({ actor, now: new Date().toISOString(), newId, timeZone: ds.site.timeZone, calendar: ds.calendar }, sparesRef.current);
      if (r.ok) {
        sparesRef.current = r.records[0]!;
        setSparesSettingsState(r.records[0]!);
        setAudit((a) => [...r.audit, ...a]);
        if (live) saveSetting(siteId, 'spares', r.records[0]!, r.audit[0]!.reason ?? '', r.audit).catch(failed);
      }
      return r;
    },
    [actor, ds, live, failed],
  );
  const [assistSettings, setAssistSettingsState] = useState<AssistSettings>(() => live?.assistSettings ?? DEFAULT_ASSIST_SETTINGS);
  const assistRef = useRef(assistSettings);
  assistRef.current = assistSettings;
  const runAssistSettings = useCallback(
    (cmd: (ctx: ConsoleContext, current: AssistSettings) => ConsoleResult<AssistSettings>): ConsoleResult<AssistSettings> => {
      const r = cmd({ actor, now: new Date().toISOString(), newId, timeZone: ds.site.timeZone, calendar: ds.calendar }, assistRef.current);
      if (r.ok) {
        assistRef.current = r.records[0]!;
        setAssistSettingsState(r.records[0]!);
        setAudit((a) => [...r.audit, ...a]);
        if (live) saveSetting(siteId, 'assist', r.records[0]!, r.audit[0]!.reason ?? '', r.audit).catch(failed);
      }
      return r;
    },
    [actor, ds, live, failed],
  );
  // Learned in the browser from this site's own records; nothing leaves the platform (docs/ai-assist.md guardrail 6).
  const runPlantSettings = useCallback(
    (cmd: (ctx: ConsoleContext, current: PlantSettings) => ConsoleResult<PlantSettings>): ConsoleResult<PlantSettings> => {
      const r = cmd({ actor, now: new Date().toISOString(), newId, timeZone: ds.site.timeZone, calendar: ds.calendar }, plantSettings);
      if (r.ok) {
        setPlantSettings(r.records[0]!);
        setAudit((prev) => [...r.audit, ...prev]);
        if (live) saveSetting(siteId, 'plant', r.records[0]!, r.audit[0]?.reason ?? '', r.audit).catch(failed);
      }
      return r;
    },
    [actor, ds, plantSettings, live, failed],
  );
  const suggester = useMemo(() => buildSuggester(flags, ds.workOrders, STARTER_CODES, assistSettings), [flags, ds.workOrders, assistSettings]);
  const ruleAlertList = useMemo(
    () => ruleAlerts({ assets: ds.assets, flags, smu: ds.smu, lifecycle: ds.lifecycle, rules, now, timeZone: ds.site.timeZone, workOrders: ds.workOrders, targets: targetList, workSettings }, alertSettings),
    [ds, flags, rules, now, targetList, workSettings, alertSettings],
  );
  const [requests, setRequests] = useState<ApprovalRequest[]>(() => live?.requests ?? []);
  const runRequest = useCallback(
    (cmd: (ctx: ConsoleContext) => ConsoleResult<ApprovalRequest>): ConsoleResult<ApprovalRequest> => {
      const r = cmd({ actor, now: new Date().toISOString(), newId, timeZone: ds.site.timeZone, calendar: ds.calendar });
      if (r.ok) {
        setRequests(r.records);
        setAudit((prev) => [...r.audit, ...prev]);
        if (live) {
          const ids = new Set(r.audit.map((a) => a.entityId));
          saveRequests(siteId, r.records.filter((x) => ids.has(x.id)), r.audit).catch(failed);
        }
      }
      return r;
    },
    [actor, ds, live, failed],
  );
  const decide = useCallback(
    (id: string, decision: 'approve' | 'reject', note: string): DecideResult => {
      const nowIso = new Date().toISOString();
      const r = decideRequest({ actor, now: nowIso, newId, timeZone: ds.site.timeZone, calendar: ds.calendar }, { requests, targets: targetList, users, lifeTargets }, id, decision, note);
      if (r.ok) {
        setRequests(r.records);
        if (r.targets) setTargetList(r.targets);
        if (r.users) setUsers(r.users);
        if (r.lifeTargets) setLifeTargets(r.lifeTargets);
        setAudit((prev) => [...r.audit, ...prev]);
        setNow(nowIso);
        if (live) {
          const done = r.records.find((x) => x.id === id)!;
          const target = done.kind === 'target' ? r.targets?.find((t) => t.id === done.appliedId) : undefined;
          const lifeTarget = done.kind === 'life_target' ? r.lifeTargets?.find((t) => t.id === done.appliedId) : undefined;
          saveDecision(siteId, id, decision === 'approve' ? 'approved' : 'rejected', note, target ?? lifeTarget, r.audit).catch(failed);
        }
      }
      return r;
    },
    [actor, ds, live, failed, requests, targetList, users, lifeTargets],
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

  // ---------- inspections (docs/inspections.md) ----------
  const [forms, setForms] = useState<InspectionForm[]>(() => live?.forms ?? demoForms(ds));
  const [serverInspections, setServerInspections] = useState<Inspection[]>(() => live?.inspections ?? demoInspections(ds, demoForms(ds)));
  const me = actor.userId;
  const [drafts, setDrafts] = useState<Inspection[]>(() => readDrafts(siteId, me));
  const [outbox, setOutboxState] = useState<OutboxItem[]>(() => readOutbox(siteId, me));
  const outboxRef = useRef(outbox);
  useEffect(() => { setDrafts(readDrafts(siteId, me)); const o = readOutbox(siteId, me); outboxRef.current = o; setOutboxState(o); }, [siteId, me]);
  const setOutbox = useCallback((o: OutboxItem[]) => { outboxRef.current = o; setOutboxState(o); writeOutbox(siteId, me, o); }, [siteId, me]);
  // What the screen shows: the database's list, with this device's unsent changes on top.
  const inspections = useMemo(() => {
    const m = new Map(serverInspections.map((i) => [i.id, i]));
    for (const o of outbox) if (o.inspection) m.set(o.inspection.id, o.inspection);
    return [...m.values()];
  }, [serverInspections, outbox]);
  const runForms = useCallback(
    (cmd: (ctx: ConsoleContext) => ConsoleResult<InspectionForm>): ConsoleResult<InspectionForm> => {
      const r = cmd({ actor, now: new Date().toISOString(), newId, timeZone: ds.site.timeZone, calendar: ds.calendar });
      if (r.ok) {
        setForms(r.records);
        setAudit((prev) => [...r.audit, ...prev]);
        // New versions and newly retired ones are new objects; the rest are unchanged.
        if (live) saveForms(siteId, r.records.filter((f) => !forms.includes(f)), r.audit).catch(failed);
      }
      return r;
    },
    [actor, ds, live, failed, forms],
  );
  const saveDraft = useCallback((i: Inspection) => {
    const next = [...readDrafts(siteId, me).filter((x) => x.id !== i.id), i];
    setDrafts(next);
    return writeDrafts(siteId, me, next);
  }, [siteId, me]);
  const discardDraft = useCallback((id: string) => {
    const d = readDrafts(siteId, me).find((x) => x.id === id);
    for (const a of Object.values(d?.answers ?? {})) for (const p of a.photos ?? []) forgetPhoto(p);
    const next = readDrafts(siteId, me).filter((x) => x.id !== id);
    setDrafts(next);
    writeDrafts(siteId, me, next);
  }, [siteId, me]);
  const sending = useRef(false);
  /** `now` ignores the wait between tries: the connection is back, or the person pressed Try now. */
  const sendOutbox = useCallback(async (now = false) => {
    if (sending.current) return;
    sending.current = true;
    const tried = new Set<string>();
    try {
      for (;;) {
        const t = Date.now();
        const item = outboxRef.current.find((o) => !o.refused && !tried.has(o.id) && (now || Date.parse(o.nextAt) <= t));
        if (item) tried.add(item.id);
        if (!item) break;
        // Keep the order for one inspection: a later step waits for the earlier one.
        const earlier = outboxRef.current.find((o) => o.inspectionId === item.inspectionId && o !== item && !o.refused && outboxRef.current.indexOf(o) < outboxRef.current.indexOf(item));
        if (earlier) break;
        try {
          if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new SendError('No connection', false);
          const audit = item.audit.map((a) => (item.offline ? { ...a, offline: true, effectiveAt: a.at } : a));
          if (item.kind === 'inspection') {
            if (live) await sendInspection(siteId, item.inspection!, audit);
          } else {
            const data = localPhoto(item.photo!.id);
            if (!data) throw new SendError('The photo is no longer on this device.', true);
            if (live) await sendPhoto(siteId, { id: item.photo!.id, inspectionId: item.inspectionId, itemId: item.photo!.itemId, data });
            if (live) forgetPhoto(item.photo!.id);
          }
          if (item.inspection) setServerInspections((prev) => [...prev.filter((x) => x.id !== item.inspection!.id), item.inspection!]);
          setOutbox(outboxRef.current.filter((o) => o.id !== item.id));
        } catch (e) {
          const refused = e instanceof SendError && e.refused;
          const tries = item.tries + 1;
          setOutbox(outboxRef.current.map((o) => (o.id === item.id ? { ...o, tries, refused, lastError: e instanceof Error ? e.message : String(e), nextAt: new Date(Date.now() + backoffMs(tries)).toISOString() } : o)));
          if (!refused) break;
        }
      }
    } finally {
      sending.current = false;
    }
  }, [live, siteId, setOutbox]);
  // Retry when the connection comes back, and every 15 s while anything waits.
  useEffect(() => {
    const back = () => void sendOutbox(true);
    window.addEventListener('online', back);
    const t = setInterval(() => { if (outboxRef.current.some((o) => !o.refused)) void sendOutbox(); }, 15_000);
    void sendOutbox();
    return () => { window.removeEventListener('online', back); clearInterval(t); };
  }, [sendOutbox]);
  const runInspection = useCallback(
    (cmd: (ctx: ConsoleContext) => ConsoleResult<Inspection>, photos: Array<{ id: string; itemId: string }> = []): ConsoleResult<Inspection> => {
      const nowIso = new Date().toISOString();
      const r = cmd({ actor, now: nowIso, newId, timeZone: ds.site.timeZone, calendar: ds.calendar });
      if (r.ok) {
        setAudit((prev) => [...r.audit, ...prev]);
        const ids = new Set(r.audit.map((a) => a.entityId));
        const changed = r.records.filter((x) => ids.has(x.id) && x.status !== 'draft');
        const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
        const items: OutboxItem[] = [];
        for (const i of changed) {
          items.push({ id: newId(), kind: 'inspection', inspectionId: i.id, inspection: i, audit: r.audit.filter((a) => a.entityId === i.id), queuedAt: nowIso, offline, tries: 0, nextAt: nowIso });
          for (const p of photos) items.push({ id: newId(), kind: 'photo', inspectionId: i.id, photo: p, audit: [], queuedAt: nowIso, offline, tries: 0, nextAt: nowIso });
          // A submitted draft leaves the device's drafts.
          if (drafts.some((d) => d.id === i.id)) {
            const next = readDrafts(siteId, me).filter((d) => d.id !== i.id);
            setDrafts(next);
            writeDrafts(siteId, me, next);
          }
        }
        setOutbox([...outboxRef.current, ...items]);
        setNow(nowIso);
        setTimeout(() => void sendOutbox(), 0);
      }
      return r;
    },
    [actor, ds, drafts, siteId, me, setOutbox, sendOutbox],
  );
  const dropOutboxItem = useCallback((id: string) => setOutbox(outboxRef.current.filter((o) => o.id !== id)), [setOutbox]);
  const photoCache = useRef(new Map<string, string>());
  const photo = useCallback(async (id: string) => {
    const hit = photoCache.current.get(id) ?? localPhoto(id);
    if (hit) return hit;
    if (!live) return undefined;
    const data = await loadPhoto(siteId, id);
    if (data) photoCache.current.set(id, data);
    return data;
  }, [live, siteId]);
  const people = useMemo(() => users.filter((u) => !u.retiredAt && !u.invited), [users]);
  const userName = useCallback((id: string) => users.find((u) => u.id === id)?.name ?? 'Unknown user', [users]);
  const value: AppState = { ds, forms, runForms, inspections, drafts, saveDraft, discardDraft, runInspection, outbox, sendOutbox: () => void sendOutbox(true), dropOutboxItem, photo, workSettings, runWorkSettings, alertSettings, runAlertSettings, alertAnswers, runAlertAnswer, analyses, runAnalysis, views, runView, components, componentEvents, lifeTargets, runComponents, oilSamples, cmResponses, conditionSettings, runSamples, runResponse, runConditionSettings, rcmModes, jobPlanVersions, rcmSettings, runRcm, runJobPlan, runRcmSettings, sparesSettings, runSparesSettings, assistSettings, runAssistSettings, suggester, plant, plantSettings, runPlantSettings, runDelay, runClassify, addSignals, ruleAlerts: ruleAlertList, requests, runRequest, decide, actions: improve.actions, rcas: improve.rcas, projects: improve.projects, runImprove, people, userName, targets, targetOf, targetList, users, codes, runConsole, mode: live ? 'live' : 'demo', syncError, clearSyncError: () => setSyncError(null), signOut: onSignOut, importRuns, applyImport, newId, flags, audit, rules, now, actor, setRole, run, lastSync: ds.generatedAt, theme, setTheme };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp outside AppProvider');
  return v;
}
