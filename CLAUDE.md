# M&R Platform: project instructions (A12)

Read this first. It is the project instruction file from build plan v10, section 12 (A12).

## What this is

A maintenance and reliability platform that sits beside the ERP/CMMS (Maximo first) and the fleet
management system. It runs the weekly reliability loop: live fleet status from timed down flags,
history, tier 1 KPIs, analysis, actions and projects. The ERP stays the system of record for assets,
work orders, parts and cost. No write-back to the ERP.

Current phase: **1a, file-based MVP** (plan section 5 and 13).

## Stack

- `packages/core`: TypeScript, pure functions only. Flag state machine (A7), time model and shift
  calendar, permissions, KPI engine, alerts, synthetic fleet generator. Tests with Vitest.
- `apps/web`: React 18 + Vite. Screens call core commands; they never change records directly.
- `supabase/migrations`: Postgres schema for Supabase (Canada Central). One migration tool only:
  plain SQL files in this folder, applied in name order.
- Later: a Python worker for connectors and reliability statistics (plan 6.1).

## Commands

```bash
pnpm install
pnpm test              # core unit and golden tests
pnpm typecheck
pnpm dev               # web app on http://localhost:5173 (synthetic fleet)
pnpm synth out.json    # write a synthetic fleet to a file
pnpm synth out.json --csv csv   # also write Maximo-style CSV files for the import screen
pnpm test:db           # apply migrations to a scratch Postgres and run the schema smoke test
```

## Rules

1. **Never change a KPI, flag rule or field mapping without updating its document first.**
   KPI formulas: `docs/kpi-dictionary.md`. Flag rules: A7 and `docs/a7-open-questions.md`.
   The golden tests in `packages/core/test/golden.test.ts` are hand-worked answers; if a change moves
   one of them, the change is wrong or the document must change first.
2. **A7 open questions are settings, not code.** Anything A7 has not settled lives in
   `packages/core/src/config.ts` (`FlagRulesConfig`, listed in `OPEN_A7_SETTINGS`). Never hard-code
   a choice. When Ope decides one, change the default, update `docs/a7-open-questions.md`, and add a
   test for the chosen behaviour.
3. **Business rules are small pure functions with tests** (plan 14.1). Same code in the browser,
   the server and the database jobs.
4. **Status is events, not fields.** A down flag has timed stage and location intervals. Durations
   are always calculated, never typed. Unit status is derived from the open flag.
5. **Nothing is deleted.** Records are voided or retired with a reason. No cascade deletes into
   history. Every change goes to the audit log with who, when, before, after and the real entry time.
6. **Tenant and site IDs on every table.** Row-level security per site.
7. **Site time zone and shift calendar** decide days, shifts and months. Never the viewer's browser.
8. **Deny by default.** Permissions come from the matrix in `packages/core/src/permissions.ts`
   (plan 11.2). A role not listed for an action cannot do it.
9. **Develop on synthetic data only.** No employer or site data in this repository.
10. One feature per branch, with tests. Ask for a fresh review of security, access rules and sync
    logic before merging.

## Naming

- Code and database: `snake_case` in SQL, `camelCase` in TypeScript, A7 terms exactly
  (down flag, stage, location, shop line, released, voided).
- Screen labels use the KPI dictionary and glossary terms exactly (PA, utilisation, scheduled down).

## Where the tier A documents live

`docs/README.md` lists all twelve and their status. The build plan and A7 are Word documents kept
outside the repo; their rules are referenced by section number in code comments (e.g. "A7 R9").
