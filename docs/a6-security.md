# A6: Data use, security and ownership

Phase 4 part 4 (plan section 13, "Scale": security review). This is the first version of A6 and
the record of the review done on 29 Oct 2026 over everything merged or open up to PR #30. It is
written for the platform owner and for a company's IT or security team that asks how the platform
handles their data.

## 1. Whose data it is

- Each company (tenant) owns the data its people enter and the files it imports. The platform holds
  it to run the reliability loop for that company and for nothing else.
- The ERP (Maximo, SAP) stays the system of record for assets, work orders, parts and cost. The
  platform reads exports and never writes back (plan 6.3).
- The repository holds **synthetic data only** (CLAUDE.md rule 9). No employer or site data is
  committed, used in tests or used to train anything.
- A company can ask for an export of all its rows (every table carries `tenant_id` and `site_id`).
  Because nothing is deleted (section 4), ending a company's use is done by retiring its sites; a
  full erase on request is a manual, logged operation by the platform owner.

## 2. What is held and where

| Data | Where | Notes |
| --- | --- | --- |
| Records (assets, flags, work orders, readings, actions, audit log) | Supabase Postgres, Canada Central | Row-level security per site |
| Inspection photos | Same database | Readable by members of the site |
| Sign-in (email address) | Supabase Auth | Email link, no passwords |
| The web app (code only, no data) | Vercel | Static files |
| Questions to Claude (assist, AI-5) | Sent to the Anthropic API from a Supabase Edge Function | Only the weekly numbers and record ids the question needs; see docs/ai-assist.md |

Personal data is limited to people's names and work email addresses, and who did what and when
(the audit log). No phone numbers, home addresses or HR data.

## 3. Keys and secrets

- The browser only has the project URL and the public **anon** key. They are in Vercel's
  environment settings and the git-ignored `apps/web/.env.local`, never in the repository.
- The **service_role** key is never used by the app, the repository or an Edge Function.
- The Anthropic key is the Supabase secret `ANTHROPIC_API_KEY`. It stays on the server.
- Platform API keys (docs/public-api.md) are shown once; only a SHA-256 hash is kept.
- Nobody is asked to paste a key into chat, email or a ticket.

## 4. Access rules

- **Deny by default** (rule 8). Roles and actions come from `packages/core/src/permissions.ts`.
  The database checks the same rules with row-level security and in its functions.
- Every table has row-level security and `tenant_id` and `site_id` (rule 6). A person reads only
  the sites they are a member of; a role reaches only what its policies allow.
- **Nothing is deleted** (rule 5). The app roles have no delete or truncate right on any table,
  no policy allows deletes, and no foreign key cascades. Records are voided or retired with a
  reason. The audit log cannot be edited.
- Functions that run with the owner's rights fix their search path and check the caller first.
- The anon key alone reaches nothing except `api_v1`, which needs a platform API key.
- These rules are checked over the whole schema by `supabase/tests/security_audit.sql`, so a new
  table or function that breaks one fails the database tests.

## 5. Web app

Security headers are set in `apps/web/vercel.json`:
- A content security policy: scripts only from the app itself, and connections only to Supabase.
- No framing, so other sites cannot put the app inside their pages.
- No content sniffing.
- A strict referrer policy.
- HTTPS only.
- The camera allowed only for the app itself (inspection photos).

The app writes no raw HTML. React escapes all text.

## 6. Review findings (29 Oct 2026)

| # | Finding | Severity | Status |
| --- | --- | --- | --- |
| S-1 | Four "for all" policies (codes, shop lines, members, invites) let a site's Admin hard-delete rows through the REST API, against rule 5. | Medium | Fixed: insert and update policies only (`20261115000001_security_hardening.sql`) |
| S-2 | The app roles had delete and truncate rights on every table. Row-level security blocked deletes, but only because no policy allowed them. | Low | Fixed: rights removed, and removed by default for new tables |
| S-3 | The anon role had table rights and could run every function. Row-level security returned nothing to it, but the surface was larger than needed. | Low | Fixed: anon reaches only `api_v1` |
| S-4 | `site_has_superintendent` answered for any site id. | Low | Fixed: it answers only members of that site |
| S-5 | Asset imports under a new fleet name failed: there was no insert policy on fleets. | Bug | Fixed in PR #29 |
| S-6 | The assist Edge Function allowed calls from any web origin. A sign-in is still needed. | Low | Fixed: set the secret `ALLOWED_ORIGIN` to the app's address |
| S-7 | No security headers on the web app. | Low | Fixed: `apps/web/vercel.json` |
| S-8 | `app_log` lets a member add audit entries for their own actions. They are always recorded as that person, and nothing can edit them. | Accepted | Needed for offline work; reviewed |
| S-9 | Supabase Auth lets anyone sign up with an email link. A new account sees nothing until an Admin invites that email or approves its request. | Accepted | Requests only reach sites that list the person's email domain (docs/access.md) |
| S-10 | The style policy allows inline styles (React style attributes). Scripts stay blocked. | Accepted | Low risk |
| S-11 | Read rules called `is_site_member(site_id)` once per row, so loading a site sometimes passed Supabase's 8-second limit (found 29 Oct 2026). | Bug | Fixed: `site_id in (select my_site_ids())`, checked once per query (`20261117000001_rls_speed.sql`); the security audit refuses the old form |

## 7. Incidents

- A leaked platform API key: revoke it on the API access page with a reason, then make a new one.
- A leaked anon key: low risk by design (section 4). Rotate it in Supabase and in Vercel.
- A leaked Anthropic key: revoke it at console.anthropic.com, set the new one as the secret.
- A wrong record: void or retire it with a reason; the audit log keeps the history.
- Anything else: the platform owner reviews the audit log for the site and the time.

## 8. Settings for the platform owner

1. Run `20-security-hardening.sql` in the Supabase SQL editor after 19.
2. In Supabase, under Edge Functions, then Secrets, set `ALLOWED_ORIGIN` to
   `https://m-r-platform.vercel.app`.
3. Keep "Allow new users to sign up" on in Supabase (Authentication, Sign In / Providers): account
   requests need it. A new account reaches nothing until an Admin approves it (docs/access.md).
4. Redeploy the Vercel project once this PR is merged, so the security headers apply.

## Later

- A penetration test by an outside firm before the first paying company.
- Company single sign-on (docs/access.md, Later).
- A data processing agreement template for companies.
