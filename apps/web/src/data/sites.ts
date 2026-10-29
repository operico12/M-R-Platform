// Sites the person can switch between (docs/multi-site.md). In live mode they come
// from app_my_sites; in demo mode there are two synthetic mines in different time zones.

import { generateFleet, type Dataset, type Role } from '@mr/core';

export interface SiteChoice {
  id: string;
  name: string;
  timeZone: string;
  /** The person's role at this site. */
  role: Role;
  tenantId: string;
}

export const DEMO_TENANT = 'tenant-demo';
export const DEMO_SITES: SiteChoice[] = [
  { id: 'site-demo', name: 'Demo mine (synthetic)', timeZone: 'America/Vancouver', role: 'admin', tenantId: DEMO_TENANT },
  { id: 'site-demo-b', name: 'Demo mine B (synthetic)', timeZone: 'America/Edmonton', role: 'admin', tenantId: DEMO_TENANT },
];

const cache = new Map<string, Dataset>();
const seedOf = (id: string) => (id === 'site-demo' ? 42 : [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 9973, 7));

/** The synthetic fleet for a demo site. Site A is the usual 40-truck demo; others are smaller. */
export function demoFleet(site: Pick<SiteChoice, 'id' | 'name' | 'timeZone'>): Dataset {
  const hit = cache.get(site.id);
  if (hit) return hit;
  const a = site.id === 'site-demo';
  const ds = generateFleet({ seed: seedOf(site.id), units: a ? 40 : 24, days: 120, timeZone: site.timeZone });
  const out: Dataset = a ? ds : { ...ds, site: { id: site.id, name: site.name, timeZone: site.timeZone }, calendar: { ...ds.calendar, timeZone: site.timeZone } };
  cache.set(site.id, out);
  return out;
}

const key = (user: string) => `mr.site.${user}`;
/** The last site chosen, per person, on this device only. */
export function rememberedSite(user: string): string | null {
  try { return localStorage.getItem(key(user)); } catch { return null; }
}
export function rememberSite(user: string, id: string) {
  try { localStorage.setItem(key(user), id); } catch { /* storage can be unavailable */ }
}
