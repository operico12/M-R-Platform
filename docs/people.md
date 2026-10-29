# People: job titles, crews and access end dates

Code: `packages/core/src/people.ts` (tested in `test/people.test.ts`), the Users page in the console
and `supabase/migrations/20261118000001_people.sql` (tested in `supabase/tests/people_api.sql`).

## Job title and access role are separate

- The **job title** is what someone does at the site, such as Heavy duty technician, Electrician,
  Planner, Consultant or Contractor. It is for people to read, and for filters and reports later.
- The **access role** is what the app lets them do: Viewer, Technician, Supervisor, Reliability engineer,
  Superintendent or Admin. The permission matrix in `permissions.ts` (plan 11.2) decides what each role can do, and the database rules agree.
- When the Admin picks a title for a new person, the console fills in a suggested access role. The Admin can choose
  another. Changing an existing person's title never changes their access.
- Giving the Superintendent or Admin role still needs a superintendent's approval (docs/approvals.md), whatever the title.
- "Other" takes the person's own words, up to 60 characters.
- The Technician role can now be given from the console. Kiosk accounts still come with phase 1b.

| Title | Suggested role |
|---|---|
| Heavy duty technician, Electrician, Welder / fabricator, Millwright, Instrument technician, Condition monitoring technician, Apprentice, Lead hand | Technician |
| Equipment operator, Dispatcher, Maintenance planner, Maintenance scheduler, Stores / warehouse | Viewer |
| Maintenance supervisor, General foreman | Supervisor |
| Reliability engineer, Maintenance engineer | Reliability engineer |
| Maintenance superintendent, Maintenance manager | Superintendent (needs approval) |
| Data owner / system admin | Admin (needs approval) |
| Consultant, OEM / dealer representative | Viewer, with an end date |
| Contractor | Technician, with an end date |
| Other | Viewer |

## Crew and shift

- A person's crew is one of the crews in the site's shift calendar rotation (A, B, C or D on the default
  12-hour calendar), or "Days (straight days)".
- The Users page shows whether the person's crew is on shift now. This uses the site's time zone and calendar (rule 7), not the viewer's clock.
- Straight days are not in the rotation, so no on-shift status is shown for them.

## Access end date

- Consultants, contractors and OEM representatives are from outside the company. Their access must have
  a last day, up to 366 days ahead. Anyone else may have one too.
- Access stops at 00:00 site time after the last day, the same rule as acting roles.
- The database enforces it. From that time `my_site_ids()`, `is_site_member()` and `site_role()` treat the person as
  not a member, so every read and write rule refuses them. An invite past its end date is not used when they sign in.
- The person, their records and their history stay (rule 5). To let them back in, the Admin sets a new last day.
- Only the Admin changes titles, crews and end dates. A trigger refuses anyone else, including a superintendent applying an approval.
- The demo does not sign anyone out. It shows "Access ended" on the Users page.
