# Multi-site

Phase 4 part 1 (plan section 13, "Scale": multi-site; exit test "second site live"). This covers
belonging to more than one site, switching between them, comparing sites, and adding or retiring a
site. More ERPs (SAP), the public API, the security review and billing are later parts of phase 4.

The code is in `packages/core/src/sites.ts`. The database already carries tenant and site IDs on
every table with row-level security per site (CLAUDE.md rule 6), so a second site needs no copy of
the schema.

## Sites and people

- A **tenant** is one customer. A **site** is one mine or plant of that tenant, with its own time
  zone, shift calendar, flag rules, codes, targets and people.
- A person can belong to several sites, with a role per site. Their role and scope at one site say
  nothing about another (deny by default, CLAUDE.md rule 8). The Admin of each site invites people
  to that site in Console, Users, as before.
- Each screen shows one site at a time. Days, shifts, weeks and months are that site's, from its time
  zone and shift calendar (rule 7). Nothing on a site screen mixes records from two sites.

## Switching site

- The site name in the menu is a switcher when the person belongs to more than one site. Choosing a
  site loads it; the person's role there applies.
- The app remembers the last site chosen, per person, on that device only (a convenience; nothing
  depends on it). Without it, the first site by name opens.
- Unsent inspections and rounds stay in the outbox of the site they were made at and are sent when
  that site is open again (drafts and outbox are kept per site and person, as in phase 2).

## Comparing sites

The **Sites** page compares the sites the person belongs to, side by side. A site only appears if the
person is a member there; there is no tenant-wide view of sites they are not a member of.

- Period: the last full reporting week of each site (Monday 00:00 to Monday 00:00 in that site's time
  zone), or the last four full weeks. Two sites in different time zones therefore cover slightly
  different instants; each uses its own week, as its own weekly pack does.
- Columns: units, open down flags now, PA (KPI-001), utilisation (KPI-002), unscheduled down hours,
  MTBF and MTTR (KPI dictionary), each worked out by the same KPI engine and the site's own flag rules.
  Fixed plant equipment is left out, as on the truck status board; plant KPIs stay on each site's
  Plant page.
- A total row gives **multi-site PA (KPI-043)**: Σ available h ÷ Σ calendar h over the sites shown.
  It weights each site by its hours, so a bigger fleet counts for more. Utilisation, MTBF and MTTR are
  not rolled up; each site's own value is shown.
- Cost is not shown on this page.

## Adding and retiring a site

Permission `add_site`: admin only.

- **Who**: the Admin of any active site of the tenant can add a site to that tenant. They become the
  new site's first Admin and invite its people from there. A person who is not an Admin at any site of
  the tenant cannot add one.
- **What is given**: a name (1 to 100 characters, unique among the tenant's active sites) and an IANA
  time zone (for example America/Edmonton). The new site starts with the default 12-hour shift
  calendar (06:00 and 18:00 site time), the default flag rules and the starter reason codes. Each is
  changed afterwards in that site's Console.
- **Retiring**: the Admin of that site retires it with a reason. Its records stay (nothing is deleted,
  rule 5) and it drops out of the switcher and the Sites page. The last active site of a tenant cannot
  be retired.
- Adding and retiring are written to the audit log of the site concerned.

## Settings

None. Anything above that a site wants different (calendar, rules, codes) is that site's own setting.

## Later

- Tenant administrators who manage every site without being a member of each (plan 11, "Later:
  multi-site administration").
- Cross-site benchmarks by model and component, and copying forms, codes and RCM libraries between
  sites.
- KPIs calculated in the database into summary tables (plan section 15 lesson), so the Sites page does
  not load each site's flags into the browser.
