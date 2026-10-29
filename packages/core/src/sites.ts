// Multi-site (phase 4 part 1, docs/multi-site.md; KPI-043). Adding and retiring
// a site of the tenant, and comparing the sites a person belongs to. Each
// site is worked out in its own time zone with its own rules, by the same
// KPI engine. Pure functions; the database checks the same rules.

import { IANAZone } from 'luxon';
import type { ConsoleContext, ConsoleResult } from './console.js';
import { computeKpis, type KpiResult, type Period } from './kpis.js';
import { can } from './permissions.js';
import { recentWeeks } from './time.js';
import type { FlagRulesConfig } from './config.js';
import type { Asset, AssetLifecycleInterval, AuditEntry, DownFlag, Iso, Site, SmuReading } from './types.js';

export interface SiteRecord extends Site {
  retiredAt?: Iso;
  retireReason?: string;
}

export interface SiteInput {
  name: string;
  timeZone: string;
}

export const isTimeZone = (tz: string) => !!tz && IANAZone.isValidZone(tz);

export function siteProblems(sites: SiteRecord[], tenantId: string, input: SiteInput, selfId?: string): string[] {
  const e: string[] = [];
  const name = input.name.trim();
  if (!name || name.length > 100) e.push('Name the site (1 to 100 characters).');
  else if (sites.some((s) => s.id !== selfId && s.tenantId === tenantId && !s.retiredAt && s.name.trim().toLowerCase() === name.toLowerCase())) e.push(`The tenant already has a site called ${name}.`);
  if (!isTimeZone(input.timeZone.trim())) e.push('Give an IANA time zone, for example America/Edmonton.');
  return e;
}

const refuse = (...errors: string[]): ConsoleResult<SiteRecord> => ({ ok: false, errors });
const log = (ctx: ConsoleContext, action: string, id: string, before: unknown, after: unknown, reason: string): AuditEntry =>
  ({ at: ctx.now, userId: ctx.actor.userId, action, entity: 'site', entityId: id, before, after, reason });

/**
 * A new site of the tenant. `ctx.actor` is the person's role at the site they are on, which must be
 * a site of the same tenant: only its Admin can add one. The adder becomes the new site's Admin.
 */
export function addSite(ctx: ConsoleContext, sites: SiteRecord[], tenantId: string, input: SiteInput): ConsoleResult<SiteRecord> {
  if (!can(ctx.actor, 'add_site')) return refuse('The Admin of a site of this tenant adds sites.');
  const e = siteProblems(sites, tenantId, input);
  if (e.length) return { ok: false, errors: e };
  const s: SiteRecord = { id: ctx.newId(), tenantId, name: input.name.trim(), timeZone: input.timeZone.trim() };
  return { ok: true, records: [s], audit: [log(ctx, 'add_site', s.id, null, s, `New site ${s.name}`)], warnings: [] };
}

/** Retire a site. `ctx.actor` is the person's role at that site. Its records stay. */
export function retireSite(ctx: ConsoleContext, sites: SiteRecord[], id: string, reason: string): ConsoleResult<SiteRecord> {
  if (!can(ctx.actor, 'add_site')) return refuse("The site's Admin retires it.");
  const s = sites.find((x) => x.id === id);
  if (!s || s.retiredAt) return refuse('That site is not active.');
  if (!sites.some((x) => x.id !== id && x.tenantId === s.tenantId && !x.retiredAt)) return refuse('This is the last active site of the tenant, so it cannot be retired.');
  if (!reason.trim()) return refuse('Give a reason.');
  const after: SiteRecord = { ...s, retiredAt: ctx.now, retireReason: reason.trim() };
  return { ok: true, records: [after], audit: [log(ctx, 'retire_site', id, s, after, reason.trim())], warnings: [] };
}

/** Sites for the switcher: active ones, the remembered one first if it is still there, then by name. */
export function switcherOrder<T extends { id: string; name: string; retiredAt?: Iso | null }>(sites: T[], remembered?: string | null): T[] {
  const live = sites.filter((s) => !s.retiredAt).sort((a, b) => a.name.localeCompare(b.name));
  const i = remembered ? live.findIndex((s) => s.id === remembered) : -1;
  if (i > 0) live.unshift(...live.splice(i, 1));
  return live;
}

// ---------- comparison (KPI-043) ----------

export interface SiteSnapshot {
  site: Site;
  assets: Asset[];
  flags: DownFlag[];
  smu: SmuReading[];
  lifecycle?: AssetLifecycleInterval[];
  rules: FlagRulesConfig;
}

export interface SiteRow {
  site: Site;
  period: Period;
  units: number;
  openFlags: number;
  kpi: KpiResult;
}

export interface SiteComparison {
  rows: SiteRow[];
  /** KPI-043: Σ available h ÷ Σ calendar h. */
  pa: number | null;
  calendarHours: number;
  availableHours: number;
}

/** The last `weeks` full reporting weeks in the site's own time zone. */
export function lastFullWeeks(timeZone: string, now: Iso, weeks: number): Period {
  const w = recentWeeks(timeZone, now, weeks + 1);
  return { from: w[0]!.from, to: w.at(-1)!.from };
}

export function compareSites(snaps: SiteSnapshot[], now: Iso, weeks = 1): SiteComparison {
  const rows = snaps.map((s): SiteRow => {
    const assets = s.assets.filter((a) => a.assetClass !== 'fixed_plant');
    const ids = new Set(assets.map((a) => a.id));
    const period = lastFullWeeks(s.site.timeZone, now, weeks);
    const kpi = computeKpis({ assets, flags: s.flags, smu: s.smu, lifecycle: s.lifecycle, rules: s.rules, now }, period);
    return { site: s.site, period, units: assets.length, openFlags: s.flags.filter((f) => f.state === 'open' && ids.has(f.unitId)).length, kpi };
  });
  const calendarHours = rows.reduce((t, r) => t + r.kpi.calendarHours, 0);
  const availableHours = rows.reduce((t, r) => t + r.kpi.availableHours, 0);
  return { rows, pa: calendarHours > 0 ? availableHours / calendarHours : null, calendarHours, availableHours };
}
