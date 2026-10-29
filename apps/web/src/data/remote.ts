// Supabase connection (plan 6.1). Used only when the build has a project URL
// and anon key; without them the app runs on the synthetic demo fleet.
// The anon key is public by design: row-level security decides what each
// signed-in person can read and write. Never put the service_role key here.

import { DEFAULT_FLAG_RULES, DEFAULT_WORK_SETTINGS, withAlertDefaults, type ApprovalRequest, type AuditRecord, type AlertAnswer, type AlertSettings, emptyFishbone, type WorkSettings, type ImprovementAction, type Project, type Rca, type AuditEntry, type Dataset, type DownFlag, type FlagRulesConfig, type ReasonCode, type Role, type ShiftCalendar, type SiteUser, type SmuReading, type Target, type WorkOrder, type Asset, type Inspection, type InspectionForm, type SavedAnalysis, type SavedView, type Component, type ComponentEvent, type LifeTarget, type OilSample, type CmResponse, type ConditionSettings, withConditionDefaults, type RcmMode, type JobPlanVersion, type RcmSettings, withRcmDefaults, type SparesSettings, withSparesDefaults, type AssistSettings, withAssistDefaults, type PlantNode, type ProcessDelay, type RunSignal, type PlantSettings, withPlantDefaults, type Shutdown, type ScopeItem, type Round, type SiteSnapshot, type SiteRecord, twelveHourCalendar, type ImportSource, withImportDefaults, type ApiKeyRecord, type ApiKeyInput, type ApiScope, type AccessSettings, withAccessDefaults, type AccessRequest, type StandbyFlag } from '@mr/core';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const remote: SupabaseClient | null = url && key ? createClient(url, key) : null;

export interface RemoteSite {
  site_id: string;
  site_name: string;
  time_zone: string;
  role: Role;
  /** From the multi-site migration; older databases leave it out. */
  tenant_id?: string;
  /** The site wants the authenticator code check before this person acts as Admin (docs/access.md). */
  mfa_required?: boolean;
}

export interface Loaded {
  ds: Dataset;
  role: Role;
  me: string;
  rules: FlagRulesConfig;
  users: SiteUser[];
  codes: ReasonCode[];
  targets: Target[];
  actions: ImprovementAction[];
  rcas: Rca[];
  projects: Project[];
  /** Standby flags (docs/standby.md), SQL 24. */
  standby: StandbyFlag[];
  workSettings: WorkSettings;
  alertSettings: AlertSettings;
  alertAnswers: AlertAnswer[];
  requests: ApprovalRequest[];
  forms: InspectionForm[];
  inspections: Inspection[];
  /** Plant rounds (docs/fixed-plant.md): one inspection per stop done. */
  rounds: Round[];
  analyses: SavedAnalysis[];
  views: SavedView[];
  conditionSettings: ConditionSettings;
  rcmSettings: RcmSettings;
  sparesSettings: SparesSettings;
  assistSettings: AssistSettings;
  /** Fixed plant (docs/fixed-plant.md): equipment and their flags are split out of ds by asset class. */
  plant: PlantData;
  plantSettings: PlantSettings;
  /** Which ERP the site's files come from (docs/field-mapping.md). */
  importSource: ImportSource;
  accessSettings: AccessSettings;
}

export interface PlantData {
  nodes: PlantNode[];
  equipment: Asset[];
  flags: DownFlag[];
  delays: ProcessDelay[];
  signals: RunSignal[];
  /** Part 2. */
  shutdowns: Shutdown[];
  /** Extra work orders for the plant demo; live work orders are all in ds.workOrders. */
  workOrders: WorkOrder[];
}

/** Postgres returns "+00:00" offsets; the app compares ISO strings, so make them all "Z". */
function iso<T>(v: T): T {
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?\+00:00$/.test(v)) return new Date(v).toISOString() as T;
  if (Array.isArray(v)) return v.map(iso) as T;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, iso(x)])) as T;
  return v;
}

function must<T>(r: { data: T; error: { message: string } | null }): T {
  if (r.error) throw new Error(r.error.message);
  return r.data;
}

/**
 * For features added after a site was set up: if the database does not have the function yet
 * (PostgREST PGRST202), the feature starts empty instead of the whole site failing to load.
 * The missing migration still needs running; the console logs which one.
 */
function optional<T>(r: { data: T; error: { message: string; code?: string } | null }, empty: T, what: string): T {
  if (r.error?.code === 'PGRST202') {
    console.warn(`${what} is not set up in this database yet. Run its migration in supabase/migrations.`);
    return empty;
  }
  return must(r);
}

/** Turns any pending invite for the signed-in email into a membership, then lists the person's sites. */
export async function mySites(): Promise<RemoteSite[]> {
  if (!remote) return [];
  must(await remote.rpc('app_join'));
  return must(await remote.rpc('app_my_sites')) as RemoteSite[];
}

/** A new site of the tenant of `fromSite` (docs/multi-site.md). The adder becomes its Admin. */
export async function addSiteRemote(fromSite: string, s: SiteRecord): Promise<void> {
  const cal = twelveHourCalendar(s.timeZone);
  must(await remote!.rpc('app_add_site', { p_from: fromSite, s, p_calendar: { shifts: cal.shifts, rotation: cal.rotation }, p_rules: DEFAULT_FLAG_RULES }));
}

export async function retireSiteRemote(siteId: string, reason: string): Promise<void> {
  must(await remote!.rpc('app_retire_site', { p_site: siteId, p_reason: reason }));
}

// ---------- access (docs/access.md) ----------

export interface MyRequest { id: string; site_id: string; site_name: string; status: AccessRequest['status']; role: Role | null; reason: string | null; created_at: string }

/** Sites this signed-in person may ask for an account (their email domain is listed there). */
export async function requestSites(): Promise<Array<{ site_id: string; site_name: string }>> {
  return must(await remote!.rpc('app_request_sites')) as Array<{ site_id: string; site_name: string }>;
}
export async function myRequests(): Promise<MyRequest[]> {
  return must(await remote!.rpc('app_my_access_requests')) as MyRequest[];
}
export async function requestAccess(siteId: string, name: string, note: string): Promise<void> {
  must(await remote!.rpc('app_request_access', { p_site: siteId, p_name: name.trim(), p_note: note.trim() || null }));
}
export async function withdrawRequest(id: string): Promise<void> {
  must(await remote!.rpc('app_withdraw_access', { p_id: id }));
}
/** The site's requests. Row-level security shows them to the site's Admin only. */
export async function loadAccessRequests(siteId: string): Promise<AccessRequest[]> {
  const rows = must(await remote!.from('access_requests').select('*').eq('site_id', siteId).order('created_at', { ascending: false }).limit(200)) as Array<{
    id: string; site_id: string; user_id: string; email: string; name: string; note: string | null; status: AccessRequest['status']; role: Role | null;
    decided_by: string | null; decided_at: string | null; reason: string | null; created_at: string;
  }>;
  const t = (x: string | null) => (x ? new Date(x).toISOString() : undefined);
  return rows.map((r) => ({
    id: r.id, siteId: r.site_id, userId: r.user_id, email: r.email, name: r.name, note: r.note ?? undefined, status: r.status, createdAt: t(r.created_at)!,
    role: r.role ?? undefined, decidedBy: r.decided_by ?? undefined, decidedAt: t(r.decided_at), reason: r.reason ?? undefined,
  }));
}
export async function decideAccessRemote(id: string, approve: boolean, role: Role | undefined, reason: string): Promise<void> {
  must(await remote!.rpc('app_decide_access', { p_id: id, p_approve: approve, p_role: approve ? role : null, p_reason: reason.trim() || null }));
}

// ---------- public API keys (docs/public-api.md) ----------

/** The site's keys with their use. Row-level security shows them to the site's Admin only. */
export async function loadApiKeys(siteId: string): Promise<ApiKeyRecord[]> {
  const rows = must(await remote!.rpc('app_api_keys', { p_site: siteId })) as Array<{
    id: string; name: string; prefix: string; scopes: ApiScope[]; expires_at: string; created_at: string; created_by: string | null;
    revoked_at: string | null; revoked_by: string | null; revoke_reason: string | null; last_used_at: string | null; calls_24h: number;
  }>;
  const t = (x: string | null) => (x ? new Date(x).toISOString() : undefined);
  return rows.map((r) => ({
    id: r.id, siteId, name: r.name, prefix: r.prefix, scopes: r.scopes, expiresAt: t(r.expires_at)!, createdAt: t(r.created_at)!, createdBy: r.created_by ?? '',
    revokedAt: t(r.revoked_at), revokedBy: r.revoked_by ?? undefined, revokeReason: r.revoke_reason ?? undefined, lastUsedAt: t(r.last_used_at), calls24h: Number(r.calls_24h),
  }));
}

/** The database makes the key and returns it this once. */
export async function createApiKeyRemote(siteId: string, input: ApiKeyInput): Promise<string> {
  const r = must(await remote!.rpc('app_create_api_key', { p_site: siteId, p_name: input.name.trim(), p_scopes: input.scopes, p_days: input.days ?? 365 })) as { key: string };
  return r.key;
}

export async function revokeApiKeyRemote(id: string, reason: string): Promise<void> {
  must(await remote!.rpc('app_revoke_api_key', { p_id: id, p_reason: reason }));
}

/** The REST address other systems call (docs/public-api.md). The anon key is public; never the service key. */
export const apiEndpoint = (url || 'https://<project>.supabase.co').replace(/\/$/, '') + '/rest/v1/rpc/api_v1';

/** What the Sites page needs from one site: units, flags, SMU and rules for the last few weeks. */
export async function loadSnapshot(siteId: string, since: string): Promise<SiteSnapshot> {
  const d = iso(must(await remote!.rpc('app_load', { p_site: siteId, p_since: since }))) as {
    site: { id: string; tenantId: string; name: string; timeZone: string };
    rules: Partial<FlagRulesConfig> | null; assets: Asset[]; lifecycle: Dataset['lifecycle']; flags: DownFlag[]; smu: SmuReading[];
  };
  return {
    site: d.site,
    assets: d.assets, lifecycle: d.lifecycle,
    flags: d.flags.map((f) => ({ ...f, stages: f.stages ?? [], locations: f.locations ?? [], etas: f.etas ?? [], workOrders: f.workOrders ?? [], source: f.source ?? 'app', setBy: f.setBy ?? '', enteredAt: f.enteredAt ?? f.start })),
    smu: d.smu.map((r) => ({ ...r, hours: Number(r.hours) })),
    rules: { ...DEFAULT_FLAG_RULES, ...(d.rules ?? {}) },
  };
}

/** One more try when the database cancels a slow call (Postgres code 57014, statement timeout). */
async function rpcRetry(fn: string, args: Record<string, unknown>) {
  const r = await remote!.rpc(fn, args);
  return r.error?.code === '57014' ? remote!.rpc(fn, args) : r;
}

export async function loadSite(siteId: string): Promise<Loaded> {
  const since = new Date(Date.now() - 730 * 864e5).toISOString();
  const [main, imp, proj, wk, ans, appr, anl, vw, cmp, cond, rcmr, plnt, sds] = await Promise.all([
    rpcRetry('app_load', { p_site: siteId }), rpcRetry('app_load_improve', { p_site: siteId }), rpcRetry('app_load_projects', { p_site: siteId }),
    rpcRetry('app_load_work', { p_site: siteId }),
    rpcRetry('app_load_alert_answers', { p_site: siteId }),
    rpcRetry('app_load_approvals', { p_site: siteId }),
    rpcRetry('app_load_analyses', { p_site: siteId }),
    rpcRetry('app_load_views', { p_site: siteId }),
    rpcRetry('app_load_components', { p_site: siteId }),
    rpcRetry('app_load_condition', { p_site: siteId, p_since: since }),
    rpcRetry('app_load_rcm', { p_site: siteId }),
    rpcRetry('app_load_plant', { p_site: siteId, p_since: new Date(Date.now() - 400 * 864e5).toISOString() }),
    rpcRetry('app_load_shutdowns', { p_site: siteId }),
  ]);
  // Title, crew and end date (SQL 23). Before that file is run the function is missing; load without them.
  const ppl = await rpcRetry('app_load_people', { p_site: siteId });
  const people = new Map(((ppl.error ? [] : iso(ppl.data)) as Array<Pick<SiteUser, 'id' | 'jobTitle' | 'jobTitleOther' | 'crew' | 'accessUntil'>>).map((x) => [x.id, x]));
  const insp = await loadInspections(siteId);
  const sby = await rpcRetry('app_load_standby', { p_site: siteId, p_since: since });
  const work = iso(must(wk)) as { plans: Array<Partial<WorkOrder> & { id: string }>; settings: { work?: Partial<WorkSettings>; alerts?: Partial<AlertSettings>; condition?: Partial<ConditionSettings>; rcm?: Partial<RcmSettings>; spares?: Partial<SparesSettings>; assist?: Partial<AssistSettings>; plant?: Partial<PlantSettings>; imports?: Partial<ImportSource>; access?: Partial<AccessSettings> } };
  const plans = new Map(work.plans.map((x) => [x.id, x]));
  const num = (v: unknown) => (v === undefined || v === null ? undefined : Number(v));
  const projects = (iso(must(proj)) as Project[]).map((p) => ({
    ...p, budget: Number(p.budget), forecastToComplete: Number(p.forecastToComplete),
    expectedHoursPerYear: p.expectedHoursPerYear === undefined ? undefined : Number(p.expectedHoursPerYear),
    valuePerDownHour: p.valuePerDownHour === undefined ? undefined : Number(p.valuePerDownHour),
    links: { unitIds: [], workOrders: [], rcaIds: [], actionIds: [], ...(p.links as Partial<Project['links']>) },
  }));
  const improve = iso(must(imp)) as { actions: ImprovementAction[]; rcas: Rca[] };
  const d = iso(must(main)) as {
    site: { id: string; tenantId: string; name: string; timeZone: string };
    role: Role; me: string;
    calendar: { shifts: ShiftCalendar['shifts']; rotation?: ShiftCalendar['rotation'] } | null;
    rules: Partial<FlagRulesConfig> | null;
    assets: Asset[]; lifecycle: Dataset['lifecycle']; shopLines: Dataset['shopLines']; closures: Dataset['closures'];
    fieldLocations: string[]; flags: DownFlag[]; smu: SmuReading[]; workOrders: WorkOrder[];
    codes: ReasonCode[]; targets: Target[]; users: SiteUser[];
  };
  const approvals = iso(must(appr)) as { requests: ApprovalRequest[]; acting: Array<{ userId: string; role: Role; until: string }>; targets: Array<{ id: string; requestId: string; approvedBy?: string }> };
  const acting = new Map(approvals.acting.map((x) => [x.userId, x]));
  const approvedTargets = new Map(approvals.targets.map((x) => [x.id, { requestId: x.requestId, approvedBy: x.approvedBy }]));
  const parts = iso(optional(cmp, { components: [], events: [], targets: [] }, 'Components')) as { components: Component[]; events: ComponentEvent[]; targets: LifeTarget[] };
  const oil = iso(optional(cond, { samples: [], responses: [] }, 'Condition monitoring')) as { samples: OilSample[]; responses: CmResponse[] };
  const rcm = iso(optional(rcmr, { modes: [], versions: [] }, 'RCM')) as { modes: RcmMode[]; versions: JobPlanVersion[] };
  const pl = iso(optional(plnt, { nodes: [], delays: [], signals: [] }, 'Fixed plant')) as Omit<PlantData, 'equipment' | 'flags'>;
  const calendar: ShiftCalendar = { timeZone: d.site.timeZone, shifts: d.calendar?.shifts ?? [{ name: 'day', startLocal: '06:00' }, { name: 'night', startLocal: '18:00' }], rotation: d.calendar?.rotation ?? undefined };
  const allFlags = d.flags.map((f) => ({ ...f, stages: f.stages ?? [], locations: f.locations ?? [], etas: f.etas ?? [], workOrders: f.workOrders ?? [], source: f.source ?? 'app', setBy: f.setBy ?? '', enteredAt: f.enteredAt ?? f.start }));
  // Plant equipment and its flags live apart from the mobile fleet, so mobile screens never see them.
  const plantIds = new Set(d.assets.filter((a) => a.assetClass === 'fixed_plant').map((a) => a.id));
  const flags = allFlags.filter((f) => !plantIds.has(f.unitId));
  return {
    ds: {
      tenantId: d.site.tenantId,
      site: { id: d.site.id, name: d.site.name, timeZone: d.site.timeZone },
      calendar,
      assets: d.assets.filter((a) => !plantIds.has(a.id)), lifecycle: d.lifecycle, shopLines: d.shopLines, closures: d.closures, fieldLocations: d.fieldLocations,
      flags, smu: d.smu.map((r) => ({ ...r, hours: Number(r.hours) })),
      workOrders: d.workOrders.map((w) => {
        const p = plans.get(w.id);
        return p ? { ...w, ...p, estimatedHours: num(p.estimatedHours), actualLabourHours: num(p.actualLabourHours) } : w;
      }),
      components: parts.components.map((c) => ({ ...c, models: c.models ?? [], hoursAtEntry: Number(c.hoursAtEntry), rebuildsAtEntry: Number(c.rebuildsAtEntry) })),
      componentEvents: parts.events.map((e) => ({
        ...e, smu: num(e.smu), cost: num(e.cost), warrantyHours: num(e.warrantyHours), warrantyMonths: num(e.warrantyMonths),
      })),
      lifeTargets: parts.targets.map((t) => ({ ...t, hours: Number(t.hours) })),
      oilSamples: oil.samples.map((x) => ({ ...x, smu: num(x.smu), oilHours: num(x.oilHours), readings: x.readings ?? {}, reasons: x.reasons ?? [] })),
      cmResponses: oil.responses,
      rcmModes: rcm.modes.map((m) => ({ ...m, answers: m.answers ?? {}, parts: (m.parts ?? []).map((p) => ({ ...p, qty: Number(p.qty) })), intervalHours: num(m.intervalHours), taskHours: num(m.taskHours), people: num(m.people) })),
      jobPlanVersions: rcm.versions.map((v) => ({ ...v, hours: Number(v.hours) })),
      generatedAt: new Date().toISOString(),
    },
    role: d.role,
    me: d.me,
    rules: { ...DEFAULT_FLAG_RULES, ...(d.rules ?? {}) },
    actions: improve.actions,
    projects,
    workSettings: { ...DEFAULT_WORK_SETTINGS, ...(work.settings.work ?? {}) },
    alertSettings: withAlertDefaults(work.settings.alerts),
    conditionSettings: withConditionDefaults(work.settings.condition),
    rcmSettings: withRcmDefaults(work.settings.rcm),
    sparesSettings: withSparesDefaults(work.settings.spares),
    assistSettings: withAssistDefaults(work.settings.assist),
    plant: {
      nodes: pl.nodes.map((n) => ({ ...n, plannedRateTph: n.plannedRateTph === undefined ? undefined : Number(n.plannedRateTph) })),
      equipment: d.assets.filter((a) => plantIds.has(a.id)),
      flags: allFlags.filter((f) => plantIds.has(f.unitId)),
      delays: pl.delays,
      signals: pl.signals,
      shutdowns: (iso(optional(sds, [], 'Shutdowns')) as Shutdown[]).map((x) => ({ ...x, equipmentIds: x.equipmentIds ?? [], flagIds: x.flagIds ?? [], scope: x.scope ?? [] })),
      workOrders: [],
    },
    plantSettings: withPlantDefaults(work.settings.plant),
    importSource: withImportDefaults(work.settings.imports),
    accessSettings: withAccessDefaults(work.settings.access),
    alertAnswers: iso(must(ans)) as AlertAnswer[],
    requests: approvals.requests,
    forms: insp.forms,
    inspections: insp.inspections,
    rounds: insp.rounds,
    analyses: iso(optional(anl, [], 'Saved analyses')) as SavedAnalysis[],
    views: iso(optional(vw, [], 'Saved views')) as SavedView[],
    rcas: improve.rcas.map((r) => ({ ...r, fishbone: { ...emptyFishbone(), ...(r.fishbone as Partial<Rca['fishbone']>) } })),
    users: d.users.map((u) => { const a = acting.get(u.id); const p = people.get(u.id); return { ...u, ...(p ?? {}), ...(a ? { actingRole: a.role, actingUntil: a.until } : {}) }; }),
    codes: d.codes,
    standby: iso(optional(sby, [], 'Standby flags')) as StandbyFlag[],
    targets: d.targets.map((t) => ({ ...t, value: Number(t.value), amber: Number(t.amber), ...(approvedTargets.get(t.id) ?? {}) })),
  };
}

export async function saveFlags(siteId: string, flags: DownFlag[], audit: AuditEntry[]): Promise<void> {
  must(await remote!.rpc('app_save_flags', { p_site: siteId, p_flags: flags }));
  if (audit.length) must(await remote!.rpc('app_log', { p_site: siteId, p_entries: audit }));
}

/** Standby flags as the core commands return them; matched by id. */
export async function saveStandby(siteId: string, rows: StandbyFlag[], audit: AuditEntry[]): Promise<void> {
  must(await remote!.rpc('app_save_standby', { p_site: siteId, p_rows: rows }));
  if (audit.length) must(await remote!.rpc('app_log', { p_site: siteId, p_entries: audit }));
}

export async function saveRecords(siteId: string, kind: 'smu' | 'work_orders' | 'assets' | 'codes' | 'users' | 'actions' | 'rcas' | 'projects', rows: unknown[], audit: AuditEntry[] = []): Promise<void> {
  const fn = { smu: 'app_save_smu', work_orders: 'app_save_work_orders', assets: 'app_save_assets', codes: 'app_save_codes', users: 'app_save_users', actions: 'app_save_actions', rcas: 'app_save_rcas', projects: 'app_save_projects' }[kind];
  for (let i = 0; i < rows.length; i += 1000) must(await remote!.rpc(fn, { p_site: siteId, p_rows: rows.slice(i, i + 1000) }));
  if (audit.length) must(await remote!.rpc('app_log', { p_site: siteId, p_entries: audit }));
}

export async function saveTarget(siteId: string, t: Target, audit: AuditEntry[]): Promise<void> {
  must(await remote!.rpc('app_save_target', { p_site: siteId, t }));
  if (audit.length) must(await remote!.rpc('app_log', { p_site: siteId, p_entries: audit }));
}

/** A task owner who does not run projects updates only their own task (see app_set_task_status). */
export async function saveTaskStatus(siteId: string, projectId: string, taskId: string, status: string, note?: string): Promise<void> {
  must(await remote!.rpc('app_set_task_status', { p_site: siteId, p_project: projectId, p_task: taskId, p_status: status, p_note: note ?? null }));
}

export async function saveSetting(siteId: string, key: 'work' | 'alerts' | 'condition' | 'rcm' | 'spares' | 'assist' | 'plant' | 'imports' | 'access', value: object, reason: string, audit: AuditEntry[]): Promise<void> {
  must(await remote!.rpc('app_save_setting', { p_site: siteId, p_key: key, p_value: value, p_reason: reason }));
  if (audit.length) must(await remote!.rpc('app_log', { p_site: siteId, p_entries: audit }));
}

/** Answers are append-only; the database sets who and when. */
export async function saveAlertAnswer(siteId: string, a: AlertAnswer, audit: AuditEntry[]): Promise<void> {
  must(await remote!.rpc('app_save_alert_answer', { p_site: siteId, p_answer: a }));
  if (audit.length) must(await remote!.rpc('app_log', { p_site: siteId, p_entries: audit }));
}

/** A new saved analysis, or a void. The database sets who and when. */
export async function saveAnalysisRecord(siteId: string, a: SavedAnalysis, audit: AuditEntry[]): Promise<void> {
  must(await remote!.rpc('app_save_analysis', { p_site: siteId, a }));
  if (audit.length) must(await remote!.rpc('app_log', { p_site: siteId, p_entries: audit }));
}

/** A new saved view, or retiring one. The database sets who and when. */
export async function saveViewRecord(siteId: string, v: SavedView, audit: AuditEntry[]): Promise<void> {
  must(await remote!.rpc('app_save_view', { p_site: siteId, v }));
  if (audit.length) must(await remote!.rpc('app_log', { p_site: siteId, p_entries: audit }));
}

/** A new component, then its first event (Received). The database sets who and when. */
export async function saveComponentRecord(siteId: string, c: Component | null, events: ComponentEvent[], audit: AuditEntry[]): Promise<void> {
  if (c) must(await remote!.rpc('app_save_component', { p_site: siteId, c }));
  for (const e of events) must(await remote!.rpc('app_save_component_event', { p_site: siteId, e }));
  if (audit.length) must(await remote!.rpc('app_log', { p_site: siteId, p_entries: audit }));
}

/** New oil samples (typed in or from a lab file), voids, and responses. The database sets who and when. */
export async function saveOilSamples(siteId: string, added: OilSample[], voided: OilSample[], audit: AuditEntry[]): Promise<void> {
  for (let i = 0; i < added.length; i += 500) must(await remote!.rpc('app_save_oil_samples', { p_site: siteId, p_rows: added.slice(i, i + 500) }));
  for (const v of voided) must(await remote!.rpc('app_void_oil_sample', { p_site: siteId, p_id: v.id, p_reason: v.voidReason }));
  if (audit.length) must(await remote!.rpc('app_log', { p_site: siteId, p_entries: audit }));
}

export async function saveCmResponse(siteId: string, r: CmResponse, audit: AuditEntry[]): Promise<void> {
  must(await remote!.rpc('app_save_cm_response', { p_site: siteId, r }));
  if (audit.length) must(await remote!.rpc('app_log', { p_site: siteId, p_entries: audit }));
}

/** A new failure mode revision, or retiring one. The database sets who and when. */
export async function saveRcmModes(siteId: string, added: RcmMode[], retired: RcmMode[], audit: AuditEntry[]): Promise<void> {
  for (const m of added) must(await remote!.rpc('app_save_rcm_mode', { p_site: siteId, m }));
  for (const m of retired) must(await remote!.rpc('app_retire_rcm_mode', { p_site: siteId, p_id: m.id, p_reason: m.retireReason }));
  if (audit.length) must(await remote!.rpc('app_log', { p_site: siteId, p_entries: audit }));
}

export async function saveJobPlanVersion(siteId: string, v: JobPlanVersion, audit: AuditEntry[]): Promise<void> {
  must(await remote!.rpc('app_issue_job_plan', { p_site: siteId, v }));
  if (audit.length) must(await remote!.rpc('app_log', { p_site: siteId, p_entries: audit }));
}

/** New process delays, ends and voids. The database sets who and when. */
export async function saveProcessDelays(siteId: string, delays: ProcessDelay[], audit: AuditEntry[]): Promise<void> {
  for (const d of delays) must(await remote!.rpc('app_save_process_delay', { p_site: siteId, d }));
  if (audit.length) must(await remote!.rpc('app_log', { p_site: siteId, p_entries: audit }));
}

/** Plant structure nodes: new, changed or retired. The admin only (row-level security). */
export async function savePlantNodes(siteId: string, nodes: PlantNode[], audit: AuditEntry[]): Promise<void> {
  for (const n of nodes) must(await remote!.rpc('app_save_plant_node', { p_site: siteId, n }));
  if (audit.length) must(await remote!.rpc('app_log', { p_site: siteId, p_entries: audit }));
}

/** A shutdown step, and the scope rows it added or took out. The guard allows only the steps in order. */
export async function saveShutdown(siteId: string, s: Shutdown, scope: ScopeItem[], audit: AuditEntry[]): Promise<void> {
  must(await remote!.rpc('app_save_shutdown', { p_site: siteId, s }));
  if (scope.length) must(await remote!.rpc('app_save_shutdown_scope', { p_site: siteId, p_shutdown: s.id, rows: scope }));
  if (audit.length) must(await remote!.rpc('app_log', { p_site: siteId, p_entries: audit }));
}

/** Historian run and stop signals from a file. A signal already loaded is skipped. */
export async function saveRunSignals(siteId: string, rows: RunSignal[], audit: AuditEntry[]): Promise<void> {
  for (let i = 0; i < rows.length; i += 1000) must(await remote!.rpc('app_save_run_signals', { p_site: siteId, rows: rows.slice(i, i + 1000) }));
  if (audit.length) must(await remote!.rpc('app_log', { p_site: siteId, p_entries: audit }));
}

/** The audit log between two instants, newest first. Row-level security decides what comes back. */
export async function loadAudit(siteId: string, from: string, to: string): Promise<AuditRecord[]> {
  return iso(must(await remote!.rpc('app_load_audit', { p_site: siteId, p_from: from, p_to: to }))) as AuditRecord[];
}

/** New requests, notes and withdrawals. The database sets who asked and when. */
export async function saveRequests(siteId: string, rows: ApprovalRequest[], audit: AuditEntry[]): Promise<void> {
  must(await remote!.rpc('app_save_requests', { p_site: siteId, p_rows: rows }));
  if (audit.length) must(await remote!.rpc('app_log', { p_site: siteId, p_entries: audit }));
}

/** A decision and what it applies (a KPI target or a target life), in one database transaction. */
export async function saveDecision(siteId: string, id: string, decision: 'approved' | 'rejected', note: string, target: Target | LifeTarget | undefined, audit: AuditEntry[]): Promise<void> {
  must(await remote!.rpc('app_decide_request', { p_site: siteId, p_id: id, p_decision: decision, p_note: note, p_target: target ?? null }));
  if (audit.length) must(await remote!.rpc('app_log', { p_site: siteId, p_entries: audit }));
}

/** Forms, and inspections from the last 180 days plus older ones with open defects. */
async function loadInspections(siteId: string): Promise<{ forms: InspectionForm[]; inspections: Inspection[]; rounds: Round[] }> {
  const since = new Date(Date.now() - 180 * 864e5).toISOString();
  const d = iso(must(await remote!.rpc('app_load_inspections', { p_site: siteId, p_since: since }))) as { forms: InspectionForm[]; inspections: Inspection[]; rounds?: Round[] };
  return {
    rounds: (d.rounds ?? []).map((r) => ({ ...r, skipped: r.skipped ?? [] })),
    forms: d.forms.map((f) => ({ ...f, models: f.models ?? [] })),
    inspections: d.inspections.map((i) => ({ ...i, smu: i.smu === undefined ? undefined : Number(i.smu), score: i.score === undefined || i.score === null ? null : Number(i.score), defects: i.defects ?? [] })),
  };
}

export async function saveForms(siteId: string, forms: InspectionForm[], audit: AuditEntry[]): Promise<void> {
  for (const f of forms) must(await remote!.rpc('app_save_form', { p_site: siteId, f }));
  if (audit.length) must(await remote!.rpc('app_log', { p_site: siteId, p_entries: audit }));
}

/** An outbox send failed. `refused` means the database said no, so retrying will not help. */
export class SendError extends Error {
  constructor(message: string, readonly refused: boolean) { super(message); }
}

function sent(r: { error: { message: string; code?: string } | null }): void {
  if (!r.error) return;
  // Postgres classes 22 (bad data), 23 (rule broken), 42 (not allowed) and P0 (raised by a guard).
  throw new SendError(r.error.message, /^(22|23|42|P0)/.test(r.error.code ?? ''));
}

/** A submitted inspection, or a later step on it. The database sets who and when. */
export async function sendInspection(siteId: string, i: Inspection, audit: AuditEntry[]): Promise<void> {
  sent(await remote!.rpc('app_save_inspection', { p_site: siteId, i }));
  if (audit.length) sent(await remote!.rpc('app_log', { p_site: siteId, p_entries: audit }));
}

/** A submitted round with its stop inspections, or the void of a round. The database sets who and when. */
export async function sendRound(siteId: string, r: Round, inspections: Inspection[], audit: AuditEntry[]): Promise<void> {
  sent(await remote!.rpc('app_save_round', { p_site: siteId, r, p_inspections: inspections }));
  if (audit.length) sent(await remote!.rpc('app_log', { p_site: siteId, p_entries: audit }));
}

export async function sendPhoto(siteId: string, p: { id: string; inspectionId: string; itemId: string; data: string }): Promise<void> {
  sent(await remote!.rpc('app_save_photo', { p_site: siteId, p }));
}

export async function loadPhoto(siteId: string, id: string): Promise<string | undefined> {
  return (must(await remote!.rpc('app_load_photo', { p_site: siteId, p_id: id })) as string | null) ?? undefined;
}

/** AI-5 (docs/ai-assist.md): ask Claude through the assist-ask Edge Function. The key stays on the server. */
export type AskReply =
  | { outcome: 'answered' | 'cannot_answer'; lines: string[]; cited: string[] }
  | { outcome: 'failed_check' | 'refused' | 'no_answer'; message: string }
  | { outcome: 'error'; message: string };

export async function askAssist(siteId: string, question: string, context: unknown): Promise<AskReply> {
  if (!remote) return { outcome: 'error', message: 'Questions need the live site.' };
  const { data, error } = await remote.functions.invoke('assist-ask', { body: { siteId, question, context } });
  if (error) {
    let message = 'Could not reach the question service. Is the assist-ask function deployed?';
    const res = (error as { context?: Response }).context;
    if (res && typeof res.json === 'function') {
      try { const b = await res.json(); if (b?.error) message = String(b.error); } catch { /* keep the default */ }
    }
    return { outcome: 'error', message };
  }
  return data as AskReply;
}
