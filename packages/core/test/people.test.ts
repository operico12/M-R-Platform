// People (docs/people.md): job titles, crews and access end dates.

import { describe, expect, it } from 'vitest';
import { addUser, changeUser, type ConsoleContext, type SiteUser } from '../src/console.js';
import { DAYS_CREW, JOB_TITLES, accessEndFromLastDay, accessEnded, lastDayOfAccess, checkPerson, crewShiftAt, jobTitle, siteCrews, titleLabel } from '../src/people.js';
import { local, twelveHourCalendar } from '../src/time.js';
import { ASSIGNABLE_ROLES } from '../src/console.js';
import { TZ } from './helpers.js';

const cal = twelveHourCalendar(TZ);
const NOW = local(TZ, '2026-10-26 09:00');
let n = 0;
const admin: ConsoleContext = { actor: { userId: 'a1', role: 'admin', scope: ['*'] }, now: NOW, newId: () => `id-${++n}`, timeZone: TZ, calendar: cal };
const seed: SiteUser[] = [{ id: 'a1', name: 'Admin', email: 'admin@example.com', role: 'admin', scope: ['*'], addedAt: NOW }];
const base = { name: 'Kim', email: 'kim@example.com', role: 'technician' as const, scope: ['*'] };

describe('job titles', () => {
  it('every title suggests a role the console can give, and ids are unique', () => {
    for (const t of JOB_TITLES) expect(ASSIGNABLE_ROLES).toContain(t.suggestedRole);
    expect(new Set(JOB_TITLES.map((t) => t.id)).size).toBe(JOB_TITLES.length);
    expect(jobTitle('hd_technician')?.suggestedRole).toBe('technician');
  });

  it('shows the person\'s own words for Other', () => {
    expect(titleLabel({ jobTitle: 'other', jobTitleOther: 'Tyre fitter' })).toBe('Tyre fitter');
    expect(titleLabel({ jobTitle: 'planner' })).toBe('Maintenance planner');
    expect(titleLabel({})).toBe('');
  });
});

describe('crews and shifts', () => {
  it('lists the crews in the shift calendar plus straight days', () => {
    expect(siteCrews(cal)).toEqual(['A', 'B', 'C', 'D', DAYS_CREW]);
  });

  it('says whether a crew is on shift now, in site time', () => {
    const at = local(TZ, '2026-01-01 09:00'); // rotation day 0: A on days, C on nights
    expect(crewShiftAt(cal, 'A', at)).toEqual({ onShift: true, shift: 'day' });
    expect(crewShiftAt(cal, 'C', at)).toEqual({ onShift: false });
    expect(crewShiftAt(cal, 'C', local(TZ, '2026-01-01 22:00'))).toEqual({ onShift: true, shift: 'night' });
    expect(crewShiftAt(cal, DAYS_CREW, at)).toBeUndefined();
    expect(crewShiftAt(cal, undefined, at)).toBeUndefined();
  });
});

describe('checking a person', () => {
  it('needs an end date for people from outside the company, within a year', () => {
    expect(checkPerson({ jobTitle: 'contractor' }, cal, NOW, true).errors.join()).toMatch(/end date/);
    expect(checkPerson({ jobTitle: 'consultant', accessUntil: '2026-12-31T00:00:00Z' }, cal, NOW, true).errors).toEqual([]);
    expect(checkPerson({ jobTitle: 'consultant', accessUntil: '2028-01-01T00:00:00Z' }, cal, NOW, true).errors.join()).toMatch(/366 days/);
    expect(checkPerson({ jobTitle: 'consultant', accessUntil: '2026-01-01T00:00:00Z' }, cal, NOW, true).errors.join()).toMatch(/future/);
  });

  it('refuses titles and crews not on the lists, and Other without words', () => {
    expect(checkPerson({ jobTitle: 'pilot' }, cal, NOW, true).errors).toHaveLength(1);
    expect(checkPerson({ jobTitle: 'other' }, cal, NOW, true).errors).toHaveLength(1);
    expect(checkPerson({ crew: 'Z' }, cal, NOW, true).errors).toHaveLength(1);
    expect(checkPerson({ jobTitle: 'other', jobTitleOther: ' Tyre fitter ', crew: 'B' }, cal, NOW, true).clean).toEqual({ jobTitle: 'other', jobTitleOther: 'Tyre fitter', crew: 'B', accessUntil: undefined });
  });

  it('access ends at the end date', () => {
    expect(accessEnded({ accessUntil: '2026-10-26T00:00:00Z' }, NOW)).toBe(true);
    expect(accessEnded({ accessUntil: '2026-12-26T00:00:00Z' }, NOW)).toBe(false);
    expect(accessEnded({}, NOW)).toBe(false);
  });

  it('a last day ends access at midnight site time after it', () => {
    const end = accessEndFromLastDay('2026-11-30', TZ)!;
    expect(end).toBe(local(TZ, '2026-12-01 00:00'));
    expect(lastDayOfAccess(end, TZ)).toBe('2026-11-30');
    expect(accessEndFromLastDay('30/11/2026', TZ)).toBeUndefined();
  });
});

describe('the console keeps title, crew and end date', () => {
  it('adds a technician with a title and crew, and audits it', () => {
    const r = addUser(admin, seed, { ...base, jobTitle: 'electrician', crew: 'C' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const kim = r.records.at(-1)!;
    expect(kim).toMatchObject({ role: 'technician', jobTitle: 'electrician', crew: 'C' });
    expect(r.audit[0]!.after).toMatchObject({ jobTitle: 'electrician', crew: 'C' });
  });

  it('refuses a contractor with no end date, and clears a title when it is removed', () => {
    expect(addUser(admin, seed, { ...base, jobTitle: 'contractor' }).ok).toBe(false);
    const r = addUser(admin, seed, { ...base, jobTitle: 'contractor', accessUntil: '2026-11-30T00:00:00Z' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const kim = r.records.at(-1)!;
    const c = changeUser(admin, r.records, kim.id, { ...base, jobTitle: undefined, accessUntil: undefined }, 'now staff');
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    const after = c.records.find((u) => u.id === kim.id)!;
    expect('jobTitle' in after || 'accessUntil' in after).toBe(false);
  });
});
