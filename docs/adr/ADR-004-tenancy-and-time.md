# ADR-004: Tenant and site on every table; site time zone for all reporting

- Date: 2026-10-26 · Status: accepted
- Context: BayMaster had no site or organisation ID and used the viewer's browser time zone (plan 16.2).
- Decision: Every business table has `tenant_id` and `site_id`, with row-level security by site membership. Times are stored as UTC `timestamptz`; days, shifts and months use the site's IANA time zone and shift calendar, including DST changes.
- Consequences: A second site needs no rebuild. Every report must pass the site calendar.
