// Supabase connection (plan 6.1). Used only when the build has a project URL
// and anon key; without them the app runs on the synthetic demo fleet.
// The anon key is public by design: row-level security decides what each
// signed-in person can read and write. Never put the service_role key here.

import { DEFAULT_FLAG_RULES, emptyFishbone, type ImprovementAction, type Rca, type AuditEntry, type Dataset, type DownFlag, type FlagRulesConfig, type ReasonCode, type Role, type ShiftCalendar, type SiteUser, type SmuReading, type Target, type WorkOrder, type Asset } from '@mr/core';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const remote: SupabaseClient | null = url && key ? createClient(url, key) : null;

export interface RemoteSite {
  site_id: string;
  site_name: string;
  time_zone: string;
  role: Role;
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

/** Turns any pending invite for the signed-in email into a membership, then lists the person's sites. */
export async function mySites(): Promise<RemoteSite[]> {
  if (!remote) return [];
  must(await remote.rpc('app_join'));
  return must(await remote.rpc('app_my_sites')) as RemoteSite[];
}

export async function loadSite(siteId: string): Promise<Loaded> {
  const [main, imp] = await Promise.all([remote!.rpc('app_load', { p_site: siteId }), remote!.rpc('app_load_improve', { p_site: siteId })]);
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
  const calendar: ShiftCalendar = { timeZone: d.site.timeZone, shifts: d.calendar?.shifts ?? [{ name: 'day', startLocal: '06:00' }, { name: 'night', startLocal: '18:00' }], rotation: d.calendar?.rotation ?? undefined };
  const flags = d.flags.map((f) => ({ ...f, stages: f.stages ?? [], locations: f.locations ?? [], etas: f.etas ?? [], workOrders: f.workOrders ?? [], source: f.source ?? 'app', setBy: f.setBy ?? '', enteredAt: f.enteredAt ?? f.start }));
  return {
    ds: {
      tenantId: d.site.tenantId,
      site: { id: d.site.id, name: d.site.name, timeZone: d.site.timeZone },
      calendar,
      assets: d.assets, lifecycle: d.lifecycle, shopLines: d.shopLines, closures: d.closures, fieldLocations: d.fieldLocations,
      flags, smu: d.smu.map((r) => ({ ...r, hours: Number(r.hours) })), workOrders: d.workOrders,
      generatedAt: new Date().toISOString(),
    },
    role: d.role,
    me: d.me,
    rules: { ...DEFAULT_FLAG_RULES, ...(d.rules ?? {}) },
    actions: improve.actions,
    rcas: improve.rcas.map((r) => ({ ...r, fishbone: { ...emptyFishbone(), ...(r.fishbone as Partial<Rca['fishbone']>) } })),
    users: d.users, codes: d.codes, targets: d.targets.map((t) => ({ ...t, value: Number(t.value), amber: Number(t.amber) })),
  };
}

export async function saveFlags(siteId: string, flags: DownFlag[], audit: AuditEntry[]): Promise<void> {
  must(await remote!.rpc('app_save_flags', { p_site: siteId, p_flags: flags }));
  if (audit.length) must(await remote!.rpc('app_log', { p_site: siteId, p_entries: audit }));
}

export async function saveRecords(siteId: string, kind: 'smu' | 'work_orders' | 'assets' | 'codes' | 'users' | 'actions' | 'rcas', rows: unknown[], audit: AuditEntry[] = []): Promise<void> {
  const fn = { smu: 'app_save_smu', work_orders: 'app_save_work_orders', assets: 'app_save_assets', codes: 'app_save_codes', users: 'app_save_users', actions: 'app_save_actions', rcas: 'app_save_rcas' }[kind];
  for (let i = 0; i < rows.length; i += 1000) must(await remote!.rpc(fn, { p_site: siteId, p_rows: rows.slice(i, i + 1000) }));
  if (audit.length) must(await remote!.rpc('app_log', { p_site: siteId, p_entries: audit }));
}

export async function saveTarget(siteId: string, t: Target, audit: AuditEntry[]): Promise<void> {
  must(await remote!.rpc('app_save_target', { p_site: siteId, t }));
  if (audit.length) must(await remote!.rpc('app_log', { p_site: siteId, p_entries: audit }));
}
