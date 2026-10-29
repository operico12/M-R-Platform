# Public API, version 1 (read-only)

Phase 4 part 3 (plan section 13, "Scale"). Other systems at the company read the live status and
the history from the platform: a dashboard, a planning tool, the data warehouse. Version 1 **only
reads**. Nothing writes through the API, and the platform never writes back to the ERP (plan 6.3).

Code: `packages/core/src/api.ts` (key rules), `supabase/migrations/20261114000001_public_api.sql`
(the database checks the same rules and answers the calls), page **API access** (`#/api`).

## Keys

- A key belongs to **one site**. A call can only read that site's rows. A system that needs two
  sites uses two keys.
- The site's **Admin** creates and revokes keys (permission `manage_api_keys`). Creating one needs a
  name (what system uses it, 1 to 80 characters) and at least one scope.
- A key looks like `mrk_` followed by 64 hex characters. It is **shown once**, when it is made. The
  database keeps only its SHA-256 hash and the first 12 characters (to tell keys apart on screen).
  Nobody, the Admin included, can read a key back later. A lost key is revoked and a new one made.
- Every key expires. The default is 365 days after it is made; the longest is 730 days. An expired
  or revoked key is refused like an unknown key.
- **Revoking** needs a reason. Revoked keys stay listed with who revoked them, when and why. Keys are
  never deleted (CLAUDE.md rule 5). Creating and revoking go to the audit log.
- Rotation: make the new key, move the system over, then revoke the old key.

## Scopes

| Scope | What it reads |
| --- | --- |
| `units` | Each active unit: number, class (mobile or fixed plant), fleet, and its status now (up, or the open down flag's type, stage, location and start). |
| `flags` | Down flags that overlap a time window, with their stage and location intervals. Voided flags are left out. |
| `work_orders` | Work orders changed since a time, in pages. |
| `smu` | SMU readings in a time window. Voided readings are left out. |

KPIs are not in version 1. They will come from stored KPI results worked out by the same KPI engine
the app uses (CLAUDE.md rule 3), so the API never has a second copy of a formula. Cost fields are
not returned.

## Calling it

One endpoint, through the project's REST address. The project's public (anon) key goes in `apikey`,
as for the app; the platform key goes in its own header. The anon key alone reads nothing.

```bash
curl -s https://<project>.supabase.co/rest/v1/rpc/api_v1 \
  -H "apikey: <the project's anon key>" \
  -H "x-mr-api-key: mrk_..." \
  -H "content-type: application/json" \
  -d '{"resource": "flags", "params": {"from": "2026-10-01T00:00:00Z", "to": "2026-10-08T00:00:00Z"}}'
```

| Resource | Params |
| --- | --- |
| `units` | none |
| `flags`, `smu` | `from`, `to`: ISO 8601 times with an offset. `to` after `from`, at most 92 days apart. |
| `work_orders` | `changed_since` (ISO time, required), `cursor` (from the last page), `limit` (1 to 500, default 500). |

Every answer is JSON:

```json
{ "api_version": 1, "site": { "id": "…", "name": "…", "time_zone": "America/Vancouver" },
  "resource": "flags", "generated_at": "2026-10-29T15:00:00Z", "data": [ … ], "next_cursor": null }
```

- Times are UTC (ISO 8601). The site time zone is in the answer, so a caller can show site time
  (rule 7). Durations are not stored, so they are not returned; work them out from the intervals.
- An open flag or interval has `ends_at` null.
- `work_orders` is ordered by change time. While `next_cursor` is not null, call again with it.

## Limits and errors

- **60 calls per key per minute.** One more is refused with "Too many calls" until the minute has
  passed.
- Every answered call is logged (key, resource, time, rows returned); refused calls are not. The Admin sees the last call time and
  the calls in the last 24 hours for each key. The log is never edited.
- Errors are a PostgREST error with a message. A missing, unknown, expired or revoked key all get
  the same answer, "API key not accepted", so a caller cannot tell which keys exist. A key without
  the scope gets "This key cannot read <resource>". Bad params say what is wrong.

## Security

- The read function runs with the owner's rights but checks the key first, and every query in it
  is filtered to the key's site. It is the only way the anon role reaches site rows; row-level
  security on the tables is not changed.
- The key table and the call log are readable only by the site's Admin, and only through row-level
  security. The hash is never sent to the app.
- The key is in a header, not the address, so it does not end up in web server address logs.
- This is part of the security review (A6) before merging.

## Later

- KPI results per week and per shift, once the worker stores them.
- Webhooks when a unit goes down or comes back.
- Keys for more than one site of a tenant.
