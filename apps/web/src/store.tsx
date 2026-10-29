// App state. For phase 1a development the data comes from the synthetic
// fleet in memory; the DataSource boundary is where Supabase plugs in.
// All writes go through the pure commands in @mr/core, so the screen can
// never do something the rules do not allow.

import {
  DEFAULT_FLAG_RULES,
  DEFAULT_STANDBY_REASONS,
  endStandbyForDown,
  type StandbyContext,
  type StandbyFlag,
  type StandbyReason,
  type StandbyResult,
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
  type PlantNode, type Shutdown, type ScopeItem, type RunOutcome, type Round, type RoundResult, startRound,
  DEFAULT_IMPORT_SOURCE, mappingFor, setImportSource, type ImportMapping, type ImportSource,
  addSite, retireSite, createApiKey, revokeApiKey, apiKeyFromHex, type ApiKeyInput, type ApiKeyRecord, DEFAULT_ACCESS, type AccessSettings, type AccessRequest, decideAccessRequest, type Role as AccessRole, twelveHourCalendar as _cal, type SiteInput, type SiteRecord, type SiteSnapshot,
  DEFAULT_PLANT_SETTINGS, generatePlant, type ClassifyResult, type DelayContext, type PlantSettings, type ProcessDelay, type RunSignal,
} from '@mr/core';
import { demoImprovements } from './data/demo-improve';
import { demoStandby } from './data/demo-standby';
import { addSiteRemote, loadAccessRequests, decideAccessRemote, loadApiKeys, createApiKeyRemote, revokeApiKeyRemote, loadSnapshot, retireSiteRemote, savePlantNodes, saveShutdown, sendRound, saveProcessDelays, saveRunSignals, type PlantData, saveRcmModes, saveJobPlanVersion, saveCmResponse, saveOilSamples, saveComponentRecord, saveViewRecord, saveAnalysisRecord, loadPhoto, saveForms, sendInspection, sendPhoto, SendError, saveAlertAnswer, saveDecision, saveRequests, saveFlags, saveStandby, saveRecords, saveSetting, saveTarget, saveTaskStatus, type Loaded } from './data/remote';
import { demoProjects } from './data/demo-projects';
import { demoForms, demoInspections } from './data/demo-inspections';
import { DEMO_SITES, demoFleet, type SiteChoice } from './data/sites';
import { backoffMs, forgetPhoto, localPhoto, readDrafts, readOutbox, readRoundDrafts, writeDrafts, writeOutbox, writeRoundDrafts, type OutboxItem } from './inspect/device';
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
  /** Add, change or retire a plant structure node (admin). */
  runNode: (cmd: (ctx: ConsoleContext) => ConsoleResult<PlantNode>) => ConsoleResult<PlantNode>;
  /** Plan, change, cancel or change the scope of a shutdown. */
  runShutdown: (cmd: (ctx: ConsoleContext) => ConsoleResult<Shutdown>) => ConsoleResult<Shutdown>;
  /** Start or end a shutdown: its flags and the shutdown are saved together. */
  runShutdownFlow: (cmd: (ctx: ConsoleContext, ctxFor: (a: Asset) => FlagContext) => RunOutcome) => RunOutcome;
  /** Submitted and voided rounds, including ones still in this device's outbox. */
  rounds: Round[];
  /** Rounds this person started on this device and has not submitted. Their stops are in `drafts`. */
  roundDrafts: Round[];
  beginRound: (form: InspectionForm) => ReturnType<typeof startRound>;
  /** Keep a round draft on the device (its skipped stops). */
  saveRoundDraft: (r: Round) => boolean;
  /** Drop a round draft and its stop drafts from the device. */
  discardRound: (id: string) => void;
  /** Submit, void or sign off a round. The round and its stops go to the outbox together. */
  runRound: (cmd: (ctx: ConsoleContext) => RoundResult | { ok: false; errors: string[] }) => RoundResult | { ok: false; errors: string[] };
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
  /** Standby flags (docs/standby.md): available but not in use. */
  standby: StandbyFlag[];
  standbyReasons: StandbyReason[];
  runStandby: (asset: Asset, cmd: (ctx: StandbyContext) => StandbyResult) => StandbyResult;
  lastSync: string;
  theme: 'light' | 'dark';
  setTheme: (t: 'light' | 'dark') => void;
  /** Which ERP this site's files come from, and the mapping they are read with (docs/field-mapping.md). */
  importSource: ImportSource;
  importMapping: ImportMapping;
  runImportSource: (cmd: (ctx: ConsoleContext, current: ImportSource) => ConsoleResult<ImportSource>) => ConsoleResult<ImportSource>;
  /** Sites this person belongs to (docs/multi-site.md). The current one is ds.site. */
  sites: SiteChoice[];
  switchSite: (id: string) => void;
  /** Units, flags, SMU and rules of a site for the Sites page. */
  snapshot: (site: SiteChoice) => Promise<SiteSnapshot>;
  addSite: (input: SiteInput) => Promise<ConsoleResult<SiteRecord>>;
  retireSite: (site: SiteChoice, reason: string) => Promise<ConsoleResult<SiteRecord>>;
  /** Sign-in rules for this site (docs/access.md). */
  accessSettings: AccessSettings;
  runAccessSettings: (cmd: (ctx: ConsoleContext, current: AccessSettings) => ConsoleResult<AccessSettings>) => ConsoleResult<AccessSettings>;
  /** Account requests to this site; the Admin's list. null until loaded. */
  accessRequests: AccessRequest[] | null;
  loadAccessRequests: () => Promise<void>;
  decideAccess: (id: string, approve: boolean, role: AccessRole | undefined, reason: string) => Promise<ConsoleResult<AccessRequest>>;
  /** Public API keys of this site (docs/public-api.md). null until loaded. */
  apiKeys: ApiKeyRecord[] | null;
  loadApiKeys: () => Promise<void>;
  /** Makes a key; `key` is the full key, to show once. */
  createApiKey: (input: ApiKeyInput) => Promise<{ ok: true; key: string } | { ok: false; errors: string[] }>;
  revokeApiKey: (id: string, reason: string) => Promise<ConsoleResult<ApiKeyRecord>>;
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

export function AppProvider({ children, live, onReload, onSignOut, sites = DEMO_SITES, siteId: chosenSite, onSwitchSite, onSitesChanged }: {
  children: ReactNode; live?: Loaded; onReload?: () => void; onSignOut?: () => void;
  /** Multi-site: the person's sites, the demo site to show, and what to do on a switch or after adding or retiring one. */
  sites?: SiteChoice[]; siteId?: string; onSwitchSite?: (id: string) => void; onSitesChanged?: (sites: SiteChoice[], switchTo?: string) => void;
}) {
  const [ds, setDs] = useState<Dataset>(() => live?.ds ?? demoFleet(sites.find((x) => x.id === chosenSite) ?? sites[0] ?? DEMO_SITES[0]!));
  const [syncError, setSyncError] = useState<string | null>(null);
  const [importRuns, setImportRuns] = useState<ImportRun[]>([]);
  const [targetList, setTargetList] = useState<Target[]>(() => live?.targets ?? []);
  const [codes, setCodes] = useState<ReasonCode[]>(() => (live?.codes.length ? live.codes : defaultReasonCodes()));
  // Demo people, one per role, so "Viewing as" acts as a real user. Names are fictional.
  const [users, setUsers] = useState<SiteUser[]>(() => live?.users ?? [
    ['viewer', 'Vic Viewer', 'planner', 'days'], ['technician', 'Tia Technician', 'hd_technician', 'A'], ['supervisor', 'Sam Supervisor', 'maintenance_supervisor', 'A'],
    ['reliability_engineer', 'Rae Reliability', 'reliability_engineer', 'days'], ['superintendent', 'Sol Superintendent', 'superintendent', 'days'], ['admin', 'Ada Admin', 'data_owner', undefined],
  ].map(([role, name, jobTitle, crew]) => ({ id: `demo-${role}`, name: name!, email: `${role}@example.com`, role: role as Role, scope: ['*'], addedAt: '2026-01-01T00:00:00.000Z', jobTitle, ...(crew ? { crew } : {}) })));
  const [flags, setFlags] = useState<DownFlag[]>(ds.flags);
  const [standby, setStandbyState] = useState<StandbyFlag[]>(() => live?.standby ?? demoStandby(ds));
  // A ref as well, so a down flag can end the open standby in the same step.
  const standbyRef = useRef(standby);
  const setStandby = useCallback((next: StandbyFlag[]) => { standbyRef.current = next; setStandbyState(next); }, []);
  // The demo plant, made once: its structure, flags and shutdowns, and its route forms, rounds and stop inspections.
  const [demoPlant] = useState(() => (live ? null : generatePlant({ seed: 42, days: 120, end: Date.parse(ds.generatedAt), timeZone: ds.site.timeZone, tenantId: ds.tenantId, siteId: ds.site.id, people: { technician: 'demo-technician', supervisor: 'demo-supervisor' } })));
  const [plant, setPlant] = useState<PlantData>(() => live?.plant ?? demoPlant!);
  const [plantSettings, setPlantSettings] = useState<PlantSettings>(() => live?.plantSettings ?? DEFAULT_PLANT_SETTINGS);
  const [importSource, setImportSourceState] = useState<ImportSource>(() => live?.importSource ?? DEFAULT_IMPORT_SOURCE);
  const importMapping = useMemo(() => mappingFor(importSource), [importSource]);
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
        const saved = live ? saveFlags(siteId, r.flags, r.audit) : null;
        saved?.catch(failed);
        // Flagging a unit down ends its open standby at the down start (docs/standby.md).
        const down = r.flags.find((f) => f.unitId === asset.id && (f.state === 'open' || f.state === 'proposed'));
        if (down) {
          const e = endStandbyForDown(standbyRef.current, down, { now: nowIso, actor });
          if (e.audit.length) {
            const changed = e.standby.filter((x, i) => x !== standbyRef.current[i]);
            setStandby(e.standby);
            setAudit((prev) => [...e.audit, ...prev]);
            // After the flag is saved: the standby row points at it.
            if (saved) saved.then(() => saveStandby(siteId, changed, e.audit)).catch(failed);
          }
        }
      }
      return r;
    },
    [flagCtx, keepFlags, live, failed, actor, setStandby],
  );

  const runStandby = useCallback(
    (asset: Asset, cmd: (ctx: StandbyContext) => StandbyResult): StandbyResult => {
      const nowIso = new Date().toISOString();
      const all = standbyRef.current;
      const mine = all.filter((x) => x.unitId === asset.id);
      const lc = ds.lifecycle.find((l) => l.assetId === asset.id && Date.parse(l.start) <= Date.parse(nowIso) && (!l.end || Date.parse(nowIso) < Date.parse(l.end)));
      const r = cmd({ now: nowIso, actor, asset, lifecycle: lc?.status, unitStandby: mine, unitFlags: flags.filter((f) => f.unitId === asset.id), reasons: DEFAULT_STANDBY_REASONS, newId });
      if (r.ok) {
        const changed = r.standby.filter((x) => !mine.includes(x));
        setStandby([...all.filter((x) => x.unitId !== asset.id), ...r.standby]);
        setAudit((prev) => [...r.audit, ...prev]);
        setNow(nowIso);
        if (live) saveStandby(siteId, changed, r.audit).catch(failed);
      }
      return r;
    },
    [actor, ds.lifecycle, flags, live, failed, setStandby],
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

  const runNode = useCallback(
    (cmd: (ctx: ConsoleContext) => ConsoleResult<PlantNode>): ConsoleResult<PlantNode> => {
      const nowIso = new Date().toISOString();
      const r = cmd({ actor, now: nowIso, newId, timeZone: ds.site.timeZone, calendar: ds.calendar });
      if (r.ok) {
        setPlant((p) => {
          const next = [...p.nodes];
          for (const n of r.records) {
            const i = next.findIndex((x) => x.id === n.id);
            if (i >= 0) next[i] = n;
            else next.push(n);
          }
          return { ...p, nodes: next };
        });
        setAudit((prev) => [...r.audit, ...prev]);
        setNow(nowIso);
        if (live) savePlantNodes(siteId, r.records, r.audit).catch(failed);
      }
      return r;
    },
    [actor, ds, live, failed],
  );
  const keepShutdown = useCallback((s: Shutdown) => setPlant((p) => ({ ...p, shutdowns: p.shutdowns.some((x) => x.id === s.id) ? p.shutdowns.map((x) => (x.id === s.id ? s : x)) : [...p.shutdowns, s] })), []);
  const runShutdown = useCallback(
    (cmd: (ctx: ConsoleContext) => ConsoleResult<Shutdown>): ConsoleResult<Shutdown> => {
      const nowIso = new Date().toISOString();
      const r = cmd({ actor, now: nowIso, newId, timeZone: ds.site.timeZone, calendar: ds.calendar });
      if (r.ok) {
        const s = r.records[0]!;
        const before = plant.shutdowns.find((x) => x.id === s.id);
        // Scope rows that are new, or newly taken out.
        const rows: ScopeItem[] = s.scope.filter((x) => { const b = before?.scope.find((y) => y.id === x.id); return !b || (!!x.removedAt && !b.removedAt); });
        keepShutdown(s);
        setAudit((prev) => [...r.audit, ...prev]);
        setNow(nowIso);
        if (live) saveShutdown(siteId, s, rows, r.audit).catch(failed);
      }
      return r;
    },
    [actor, ds, plant.shutdowns, keepShutdown, live, failed],
  );
  const runShutdownFlow = useCallback(
    (cmd: (ctx: ConsoleContext, ctxFor: (a: Asset) => FlagContext) => RunOutcome): RunOutcome => {
      const nowIso = new Date().toISOString();
      const r = cmd({ actor, now: nowIso, newId, timeZone: ds.site.timeZone, calendar: ds.calendar }, (a) => flagCtx(a, nowIso));
      if (r.ok) {
        keepFlags(r.flags, true);
        keepShutdown(r.shutdown);
        setAudit((prev) => [...r.audit, ...prev]);
        setNow(nowIso);
        if (live) {
          const sdAudit = r.audit.filter((a) => a.entity === 'shutdown');
          const flagAudit = r.audit.filter((a) => a.entity !== 'shutdown');
          saveFlags(siteId, r.flags, flagAudit).then(() => saveShutdown(siteId, r.shutdown, [], sdAudit)).catch(failed);
        }
      }
      return r;
    },
    [actor, ds, flagCtx, keepFlags, keepShutdown, live, failed],
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
        // New assets record the ERP they came from (docs/field-mapping.md).
        const src = r.raw[0]?.sourceSystem;
        saveRecords(siteId, r.kind, r.kind === 'assets' && src ? changed.map((x) => ({ ...(x as object), sourceSystem: src })) : changed, [entry]).catch(failed);
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
  const runImportSource = useCallback(
    (cmd: (ctx: ConsoleContext, current: ImportSource) => ConsoleResult<ImportSource>): ConsoleResult<ImportSource> => {
      const r = cmd({ actor, now: new Date().toISOString(), newId, timeZone: ds.site.timeZone, calendar: ds.calendar }, importSource);
      if (r.ok) {
        setImportSourceState(r.records[0]!);
        setAudit((prev) => [...r.audit, ...prev]);
        if (live) saveSetting(siteId, 'imports', r.records[0]!, r.audit[0]?.reason ?? '', r.audit).catch(failed);
      }
      return r;
    },
    [actor, ds, importSource, live, failed],
  );
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
  const [forms, setForms] = useState<InspectionForm[]>(() => live?.forms ?? [...demoForms(ds), ...demoPlant!.forms]);
  const [serverInspections, setServerInspections] = useState<Inspection[]>(() => live?.inspections ?? [...demoInspections(ds, demoForms(ds)), ...demoPlant!.inspections]);
  const [serverRounds, setServerRounds] = useState<Round[]>(() => live?.rounds ?? demoPlant!.rounds);
  const me = actor.userId;
  const [drafts, setDrafts] = useState<Inspection[]>(() => readDrafts(siteId, me));
  const [roundDrafts, setRoundDrafts] = useState<Round[]>(() => readRoundDrafts(siteId, me));
  const [outbox, setOutboxState] = useState<OutboxItem[]>(() => readOutbox(siteId, me));
  const outboxRef = useRef(outbox);
  useEffect(() => { setDrafts(readDrafts(siteId, me)); setRoundDrafts(readRoundDrafts(siteId, me)); const o = readOutbox(siteId, me); outboxRef.current = o; setOutboxState(o); }, [siteId, me]);
  const setOutbox = useCallback((o: OutboxItem[]) => { outboxRef.current = o; setOutboxState(o); writeOutbox(siteId, me, o); }, [siteId, me]);
  // What the screen shows: the database's list, with this device's unsent changes on top.
  const inspections = useMemo(() => {
    const m = new Map(serverInspections.map((i) => [i.id, i]));
    for (const o of outbox) {
      if (o.inspection) m.set(o.inspection.id, o.inspection);
      for (const i of o.inspections ?? []) m.set(i.id, i);
    }
    return [...m.values()];
  }, [serverInspections, outbox]);
  const rounds = useMemo(() => {
    const m = new Map(serverRounds.map((r) => [r.id, r]));
    for (const o of outbox) if (o.round) m.set(o.round.id, o.round);
    return [...m.values()];
  }, [serverRounds, outbox]);
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
        // A photo of a round stop waits for its round.
        const earlier = outboxRef.current.find((o) => o !== item && ((o.inspectionId === item.inspectionId && !o.refused && outboxRef.current.indexOf(o) < outboxRef.current.indexOf(item)) || o.id === item.after));
        if (earlier) continue;
        try {
          if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new SendError('No connection', false);
          const audit = item.audit.map((a) => (item.offline ? { ...a, offline: true, effectiveAt: a.at } : a));
          if (item.kind === 'inspection') {
            if (live) await sendInspection(siteId, item.inspection!, audit);
          } else if (item.kind === 'round') {
            if (live) await sendRound(siteId, item.round!, item.inspections ?? [], audit);
          } else {
            const data = localPhoto(item.photo!.id);
            if (!data) throw new SendError('The photo is no longer on this device.', true);
            if (live) await sendPhoto(siteId, { id: item.photo!.id, inspectionId: item.inspectionId, itemId: item.photo!.itemId, data });
            if (live) forgetPhoto(item.photo!.id);
          }
          const sentInsp = [...(item.inspection ? [item.inspection] : []), ...(item.inspections ?? [])];
          if (sentInsp.length) setServerInspections((prev) => { const ids = new Set(sentInsp.map((x) => x.id)); return [...prev.filter((x) => !ids.has(x.id)), ...sentInsp]; });
          if (item.round) setServerRounds((prev) => [...prev.filter((x) => x.id !== item.round!.id), item.round!]);
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
  const beginRound = useCallback((form: InspectionForm) => {
    const r = startRound({ actor, now: new Date().toISOString(), newId, timeZone: ds.site.timeZone, calendar: ds.calendar }, form);
    if (r.ok) {
      const rd = [...readRoundDrafts(siteId, me), r.round];
      setRoundDrafts(rd);
      writeRoundDrafts(siteId, me, rd);
      const next = [...readDrafts(siteId, me), ...r.drafts];
      setDrafts(next);
      writeDrafts(siteId, me, next);
    }
    return r;
  }, [actor, ds, siteId, me]);
  const saveRoundDraft = useCallback((r: Round) => {
    const rd = [...readRoundDrafts(siteId, me).filter((x) => x.id !== r.id), r];
    setRoundDrafts(rd);
    return writeRoundDrafts(siteId, me, rd);
  }, [siteId, me]);
  const forgetRound = useCallback((id: string, keepPhotos: boolean) => {
    const rd = readRoundDrafts(siteId, me).filter((x) => x.id !== id);
    setRoundDrafts(rd);
    writeRoundDrafts(siteId, me, rd);
    const all = readDrafts(siteId, me);
    if (!keepPhotos) for (const d of all.filter((x) => x.roundId === id)) for (const a of Object.values(d.answers)) for (const p of a.photos ?? []) forgetPhoto(p);
    const next = all.filter((x) => x.roundId !== id);
    setDrafts(next);
    writeDrafts(siteId, me, next);
  }, [siteId, me]);
  const discardRound = useCallback((id: string) => forgetRound(id, false), [forgetRound]);
  const runRound = useCallback(
    (cmd: (ctx: ConsoleContext) => RoundResult | { ok: false; errors: string[] }) => {
      const nowIso = new Date().toISOString();
      const r = cmd({ actor, now: nowIso, newId, timeZone: ds.site.timeZone, calendar: ds.calendar });
      if (r.ok) {
        setAudit((prev) => [...r.audit, ...prev]);
        const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
        const items: OutboxItem[] = [];
        const wasDraft = readRoundDrafts(siteId, me).some((x) => x.id === r.round.id);
        if (wasDraft || r.round.status === 'voided') {
          // A new round, or a void: the round and its stops in one item.
          const roundItem: OutboxItem = { id: newId(), kind: 'round', inspectionId: r.round.id, round: r.round, inspections: r.inspections, audit: r.audit, queuedAt: nowIso, offline, tries: 0, nextAt: nowIso };
          items.push(roundItem);
          if (wasDraft) {
            for (const i of r.inspections) for (const [itemId, a] of Object.entries(i.answers)) for (const p of a.photos ?? []) {
              items.push({ id: newId(), kind: 'photo', inspectionId: i.id, photo: { id: p, itemId }, after: roundItem.id, audit: [], queuedAt: nowIso, offline, tries: 0, nextAt: nowIso });
            }
            forgetRound(r.round.id, true);
          }
        } else {
          // Sign-off changes the stop inspections only.
          for (const i of r.inspections) items.push({ id: newId(), kind: 'inspection', inspectionId: i.id, inspection: i, audit: r.audit.filter((a) => a.entityId === i.id), queuedAt: nowIso, offline, tries: 0, nextAt: nowIso });
        }
        setOutbox([...outboxRef.current, ...items]);
        setNow(nowIso);
        setTimeout(() => void sendOutbox(), 0);
      }
      return r;
    },
    [actor, ds, siteId, me, setOutbox, sendOutbox, forgetRound],
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
  const snapshot = useCallback(async (site: SiteChoice): Promise<SiteSnapshot> => {
    if (live) return loadSnapshot(site.id, new Date(Date.now() - 36 * 864e5).toISOString());
    const d = site.id === ds.site.id ? { ...ds, flags } : demoFleet(site);
    return { site: { ...d.site, tenantId: d.tenantId }, assets: d.assets, flags: d.flags, smu: d.smu, lifecycle: d.lifecycle, rules };
  }, [live, ds, flags, rules]);
  const siteRecords = useMemo<SiteRecord[]>(() => sites.map((x) => ({ id: x.id, tenantId: x.tenantId, name: x.name, timeZone: x.timeZone })), [sites]);
  const addSiteCmd = useCallback(async (input: SiteInput): Promise<ConsoleResult<SiteRecord>> => {
    const r = addSite({ actor, now: new Date().toISOString(), newId, timeZone: ds.site.timeZone, calendar: ds.calendar }, siteRecords, ds.tenantId, input);
    if (!r.ok) return r;
    const s = r.records[0]!;
    try {
      if (live) await addSiteRemote(siteId, s);
    } catch (e) {
      return { ok: false, errors: [e instanceof Error ? e.message : String(e)] };
    }
    setAudit((prev) => [...r.audit, ...prev]);
    onSitesChanged?.([...sites, { id: s.id, name: s.name, timeZone: s.timeZone, tenantId: s.tenantId, role: 'admin' }]);
    return r;
  }, [actor, ds, siteRecords, live, siteId, sites, onSitesChanged]);
  const retireSiteCmd = useCallback(async (site: SiteChoice, reason: string): Promise<ConsoleResult<SiteRecord>> => {
    // The role that counts is the person's role at the site being retired.
    const who = live ? { ...actor, role: site.role } : actor;
    const r = retireSite({ actor: who, now: new Date().toISOString(), newId, timeZone: site.timeZone, calendar: _cal(site.timeZone) }, siteRecords, site.id, reason);
    if (!r.ok) return r;
    try {
      if (live) await retireSiteRemote(site.id, reason.trim());
    } catch (e) {
      return { ok: false, errors: [e instanceof Error ? e.message : String(e)] };
    }
    const rest = sites.filter((x) => x.id !== site.id);
    onSitesChanged?.(rest, site.id === ds.site.id ? rest[0]?.id : undefined);
    return r;
  }, [actor, live, siteRecords, sites, ds.site.id, onSitesChanged]);
  const [accessSettings, setAccessSettingsState] = useState<AccessSettings>(live?.accessSettings ?? DEFAULT_ACCESS);
  const runAccessSettings = useCallback(
    (cmd: (ctx: ConsoleContext, current: AccessSettings) => ConsoleResult<AccessSettings>): ConsoleResult<AccessSettings> => {
      const r = cmd({ actor, now: new Date().toISOString(), newId, timeZone: ds.site.timeZone, calendar: ds.calendar }, accessSettings);
      if (r.ok) {
        setAccessSettingsState(r.records[0]!);
        setAudit((prev) => [...r.audit, ...prev]);
        if (live) saveSetting(siteId, 'access', r.records[0]!, r.audit[0]?.reason ?? '', r.audit).catch(failed);
      }
      return r;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [actor, ds, accessSettings, live, failed],
  );
  // The demo starts with two synthetic requests so the Admin's side can be tried.
  const [accessRequests, setAccessRequests] = useState<AccessRequest[] | null>(live ? null : () => [
    { id: 'demo-req-1', siteId: ds.site.id, userId: 'demo-newcomer-1', email: 'newcomer.one@example-mining.com', name: 'Newcomer One', note: 'Haul truck technician, B crew', status: 'pending', createdAt: new Date(Date.now() - 3_600_000).toISOString() },
    { id: 'demo-req-2', siteId: ds.site.id, userId: 'demo-newcomer-2', email: 'newcomer.two@example-mining.com', name: 'Newcomer Two', status: 'pending', createdAt: new Date(Date.now() - 86_400_000).toISOString() },
  ]);
  const loadAccessRequestsCmd = useCallback(async () => {
    if (live) setAccessRequests(await loadAccessRequests(siteId));
  }, [live, siteId]);
  const decideAccessCmd = useCallback(async (id: string, approve: boolean, role: AccessRole | undefined, reason: string): Promise<ConsoleResult<AccessRequest>> => {
    const req = (accessRequests ?? []).find((x) => x.id === id);
    if (!req) return { ok: false, errors: ['No such request.'] };
    const r = decideAccessRequest({ actor, now: new Date().toISOString(), newId, timeZone: ds.site.timeZone, calendar: ds.calendar }, req, approve, role, reason);
    if (!r.ok) return r;
    try {
      if (live) { await decideAccessRemote(id, approve, role, reason); await loadAccessRequestsCmd(); return r; }
    } catch (e) {
      return { ok: false, errors: [e instanceof Error ? e.message : String(e)] };
    }
    setAccessRequests((prev) => (prev ?? []).map((x) => (x.id === id ? r.records[0]! : x)));
    setAudit((prev) => [...r.audit, ...prev]);
    return r;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actor, ds, live, accessRequests, loadAccessRequestsCmd]);
  const [apiKeys, setApiKeys] = useState<ApiKeyRecord[] | null>(live ? null : []);
  const loadApiKeysCmd = useCallback(async () => {
    if (live) setApiKeys(await loadApiKeys(siteId));
  }, [live, siteId]);
  const apiCtx = () => ({ actor, now: new Date().toISOString(), newId, timeZone: ds.site.timeZone, calendar: ds.calendar });
  const createApiKeyCmd = useCallback(async (input: ApiKeyInput) => {
    // In the demo the browser makes the key; live, the database makes it and keeps only its hash.
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const demoKey = apiKeyFromHex(Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(''));
    const r = createApiKey(apiCtx(), ds.site.id, input, demoKey);
    if (!r.ok) return r;
    try {
      if (live) {
        const key = await createApiKeyRemote(siteId, input);
        await loadApiKeysCmd();
        return { ok: true as const, key };
      }
    } catch (e) {
      return { ok: false as const, errors: [e instanceof Error ? e.message : String(e)] };
    }
    setApiKeys((prev) => [r.records[0]!, ...(prev ?? [])]);
    setAudit((prev) => [...r.audit, ...prev]);
    return { ok: true as const, key: demoKey };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actor, ds, live, siteId, loadApiKeysCmd]);
  const revokeApiKeyCmd = useCallback(async (id: string, reason: string): Promise<ConsoleResult<ApiKeyRecord>> => {
    const r = revokeApiKey(apiCtx(), apiKeys ?? [], id, reason);
    if (!r.ok) return r;
    try {
      if (live) {
        await revokeApiKeyRemote(id, reason.trim());
        await loadApiKeysCmd();
        return r;
      }
    } catch (e) {
      return { ok: false, errors: [e instanceof Error ? e.message : String(e)] };
    }
    setApiKeys((prev) => (prev ?? []).map((k) => (k.id === id ? r.records[0]! : k)));
    setAudit((prev) => [...r.audit, ...prev]);
    return r;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actor, ds, live, apiKeys, loadApiKeysCmd]);
  const value: AppState = { accessSettings, runAccessSettings, accessRequests, loadAccessRequests: loadAccessRequestsCmd, decideAccess: decideAccessCmd, apiKeys, loadApiKeys: loadApiKeysCmd, createApiKey: createApiKeyCmd, revokeApiKey: revokeApiKeyCmd, importSource, importMapping, runImportSource, sites, switchSite: (id: string) => onSwitchSite?.(id), snapshot, addSite: addSiteCmd, retireSite: retireSiteCmd, ds, forms, runForms, inspections, drafts, saveDraft, discardDraft, runInspection, outbox, sendOutbox: () => void sendOutbox(true), dropOutboxItem, photo, workSettings, runWorkSettings, alertSettings, runAlertSettings, alertAnswers, runAlertAnswer, analyses, runAnalysis, views, runView, components, componentEvents, lifeTargets, runComponents, oilSamples, cmResponses, conditionSettings, runSamples, runResponse, runConditionSettings, rcmModes, jobPlanVersions, rcmSettings, runRcm, runJobPlan, runRcmSettings, sparesSettings, runSparesSettings, assistSettings, runAssistSettings, suggester, plant, plantSettings, runPlantSettings, runDelay, runClassify, addSignals, runNode, runShutdown, runShutdownFlow, rounds, roundDrafts, beginRound, saveRoundDraft, discardRound, runRound, ruleAlerts: ruleAlertList, requests, runRequest, decide, actions: improve.actions, rcas: improve.rcas, projects: improve.projects, runImprove, people, userName, targets, targetOf, targetList, users, codes, runConsole, mode: live ? 'live' : 'demo', syncError, clearSyncError: () => setSyncError(null), signOut: onSignOut, importRuns, applyImport, newId, flags, standby, standbyReasons: DEFAULT_STANDBY_REASONS, runStandby, audit, rules, now, actor, setRole, run, lastSync: ds.generatedAt, theme, setTheme };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp outside AppProvider');
  return v;
}
