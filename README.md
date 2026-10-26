# M&R Platform

Maintenance and reliability platform for mobile mining fleets (and later fixed plant), running
alongside the ERP/CMMS and fleet management system. Phase 1a: file-based MVP.

## Run it

```bash
pnpm install
pnpm dev          # http://localhost:5173
pnpm test         # 116 core tests, including the plan and A7 worked examples
```

The app runs on a synthetic fleet of 40 haul trucks over 120 days, generated in the browser. Use
"Viewing as" in the side bar to see what each role can do.

## What is here

| Area | Where | Status |
| --- | --- | --- |
| Down flag state machine (A7 T1–T12, S1–S5, L1–L6, R1–R16) | `packages/core/src/flags.ts` | Done, tested |
| Time model, shift calendar, reporting split | `packages/core/src/time.ts` | Done, tested (incl. DST) |
| Tier 1 KPIs (PA, utilisation, MTBF, MTTR, MDT, queue, occupancy, release vs plan) | `packages/core/src/kpis.ts` | Done, tested |
| Checks and alerts (A7 section 8) | `packages/core/src/alerts.ts` | Done, tested |
| Permission matrix (plan 11.2) | `packages/core/src/permissions.ts` | Done |
| Synthetic fleet generator | `packages/core/src/synth` | Done, tested against the rules |
| Database schema with RLS, audit, no deletes | `supabase/migrations` | Done, smoke-tested on Postgres 16 |
| Status board, flag sheet, TV mode | `apps/web` | Done (in-memory data) |
| Shop lines, units, unit page, performance, data quality, flag rules | `apps/web` | Done (in-memory data) |
| Supabase wiring, sign-in, CSV import, PowerPoint/PDF pack | | Next |

See `CLAUDE.md` for the rules every change follows and `docs/` for the decisions.
