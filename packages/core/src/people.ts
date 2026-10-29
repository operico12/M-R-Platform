// People (docs/people.md): job title, crew and access end date for each person at a site.
// The job title is what the person does; the access role (permissions.ts) is what the app lets
// them do. A title only suggests a role; the Admin chooses, and the permission matrix decides.

import { DateTime } from 'luxon';
import { shiftAt, type ShiftCalendar } from './time.js';
import type { Iso, Role } from './types.js';

export interface JobTitle {
  id: string;
  label: string;
  /** The access role the console picks when this title is chosen. The Admin can change it. */
  suggestedRole: Role;
  /** People from outside the company: access must have an end date. */
  external?: boolean;
}

export const JOB_TITLES: JobTitle[] = [
  { id: 'hd_technician', label: 'Heavy duty technician', suggestedRole: 'technician' },
  { id: 'electrician', label: 'Electrician', suggestedRole: 'technician' },
  { id: 'welder', label: 'Welder / fabricator', suggestedRole: 'technician' },
  { id: 'millwright', label: 'Millwright', suggestedRole: 'technician' },
  { id: 'instrument_tech', label: 'Instrument technician', suggestedRole: 'technician' },
  { id: 'cm_technician', label: 'Condition monitoring technician', suggestedRole: 'technician' },
  { id: 'apprentice', label: 'Apprentice', suggestedRole: 'technician' },
  { id: 'lead_hand', label: 'Lead hand', suggestedRole: 'technician' },
  { id: 'operator', label: 'Equipment operator', suggestedRole: 'viewer' },
  { id: 'dispatcher', label: 'Dispatcher', suggestedRole: 'viewer' },
  { id: 'maintenance_supervisor', label: 'Maintenance supervisor', suggestedRole: 'supervisor' },
  { id: 'general_foreman', label: 'General foreman', suggestedRole: 'supervisor' },
  { id: 'planner', label: 'Maintenance planner', suggestedRole: 'viewer' },
  { id: 'scheduler', label: 'Maintenance scheduler', suggestedRole: 'viewer' },
  { id: 'stores', label: 'Stores / warehouse', suggestedRole: 'viewer' },
  { id: 'reliability_engineer', label: 'Reliability engineer', suggestedRole: 'reliability_engineer' },
  { id: 'maintenance_engineer', label: 'Maintenance engineer', suggestedRole: 'reliability_engineer' },
  { id: 'superintendent', label: 'Maintenance superintendent', suggestedRole: 'superintendent' },
  { id: 'maintenance_manager', label: 'Maintenance manager', suggestedRole: 'superintendent' },
  { id: 'data_owner', label: 'Data owner / system admin', suggestedRole: 'admin' },
  { id: 'consultant', label: 'Consultant', suggestedRole: 'viewer', external: true },
  { id: 'contractor', label: 'Contractor', suggestedRole: 'technician', external: true },
  { id: 'oem_rep', label: 'OEM / dealer representative', suggestedRole: 'viewer', external: true },
  { id: 'other', label: 'Other', suggestedRole: 'viewer' },
];

export const PEOPLE_LIMITS = { otherTitleMax: 60, externalMaxDays: 366 } as const;

/** Straight days (no rotation), the one crew every site has. */
export const DAYS_CREW = 'days';

export const jobTitle = (id?: string) => JOB_TITLES.find((t) => t.id === id);

/** What to show for a person's title: the list label, or their own words for "Other". */
export const titleLabel = (p: { jobTitle?: string; jobTitleOther?: string }) =>
  p.jobTitle === 'other' ? (p.jobTitleOther?.trim() || 'Other') : jobTitle(p.jobTitle)?.label ?? '';

/** The crews in the site's shift calendar rotation (A, B, C, D on the default calendar), plus straight days. */
export function siteCrews(cal: ShiftCalendar): string[] {
  const set = new Set<string>();
  for (const day of cal.rotation?.pattern ?? []) for (const c of Object.values(day)) set.add(c);
  return [...[...set].sort(), DAYS_CREW];
}

export const crewLabel = (crew?: string) => (!crew ? '' : crew === DAYS_CREW ? 'Days (straight days)' : `Crew ${crew}`);

/**
 * Whether the person's crew is on shift at a time, from the site's shift calendar (rule 7).
 * Straight days are not in the rotation, so the calendar cannot say; undefined.
 */
export function crewShiftAt(cal: ShiftCalendar, crew: string | undefined, at: Iso): { onShift: boolean; shift?: string } | undefined {
  if (!crew || crew === DAYS_CREW || !cal.rotation) return undefined;
  const s = shiftAt(cal, at);
  return s.crew === crew ? { onShift: true, shift: s.name } : { onShift: false };
}

/** Access has ended: the database refuses the person from this time (docs/people.md). */
export const accessEnded = (p: { accessUntil?: Iso }, now: Iso) => !!p.accessUntil && Date.parse(p.accessUntil) <= Date.parse(now);

export interface PersonDetails {
  jobTitle?: string;
  jobTitleOther?: string;
  crew?: string;
  accessUntil?: Iso;
}

/** Checks a person's title, crew and end date. Returns the cleaned details or the problems. */
export function checkPerson(d: PersonDetails, cal: ShiftCalendar, now: Iso, isNew: boolean): { errors: string[]; clean: PersonDetails } {
  const e: string[] = [];
  const t = d.jobTitle ? jobTitle(d.jobTitle) : undefined;
  if (d.jobTitle && !t) e.push('Choose a job title from the list, or Other.');
  const other = d.jobTitle === 'other' ? d.jobTitleOther?.trim() ?? '' : '';
  if (d.jobTitle === 'other' && !other) e.push('Write the job title for Other.');
  if (other.length > PEOPLE_LIMITS.otherTitleMax) e.push(`The job title is up to ${PEOPLE_LIMITS.otherTitleMax} characters.`);
  if (d.crew && !siteCrews(cal).includes(d.crew)) e.push("Choose a crew from the site's shift calendar.");
  const until = d.accessUntil ? Date.parse(d.accessUntil) : undefined;
  if (until !== undefined && Number.isNaN(until)) e.push('The access end date is not a date.');
  if (t?.external && until === undefined) e.push(`${t.label}s are from outside the company, so give their access an end date.`);
  if (until !== undefined && !Number.isNaN(until)) {
    if (isNew && until <= Date.parse(now)) e.push('The access end date must be in the future.');
    if (t?.external && until - Date.parse(now) > PEOPLE_LIMITS.externalMaxDays * 86_400_000) e.push(`Access for people from outside the company can be up to ${PEOPLE_LIMITS.externalMaxDays} days; extend it later if needed.`);
  }
  const clean: PersonDetails = {
    jobTitle: t?.id,
    jobTitleOther: other || undefined,
    crew: d.crew || undefined,
    accessUntil: until !== undefined && !Number.isNaN(until) ? new Date(until).toISOString() : undefined,
  };
  return { errors: e, clean };
}

/** A site-local last day (YYYY-MM-DD) as the moment access ends: 00:00 site time after it, like acting roles. */
export function accessEndFromLastDay(lastDay: string, tz: string): Iso | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(lastDay)) return undefined;
  const d = DateTime.fromISO(lastDay, { zone: tz });
  return d.isValid ? d.plus({ days: 1 }).startOf('day').toUTC().toISO()! : undefined;
}

/** The last site-local day of access, for showing and editing. */
export const lastDayOfAccess = (accessUntil: Iso, tz: string) => DateTime.fromISO(accessUntil, { zone: tz }).minus({ minutes: 1 }).toISODate()!;
