# ADR-002: Flag rules and KPIs as pure TypeScript functions

- Date: 2026-10-26 · Status: accepted
- Context: Plan 14.1 asks for business rules as small pure functions with tests, so the same logic runs on the screens, the server and database jobs.
- Options: (1) rules in SQL triggers; (2) rules in the UI; (3) a shared pure library.
- Decision: `packages/core` holds the state machine, time model, permissions and KPIs as pure functions. The database enforces the invariants it can (one open flag, no overlaps, no deletes, audit) as a backstop.
- Consequences: Fast tests and one source of truth. Database jobs that calculate KPIs must call the same library (Edge Function or worker), not re-implement formulas in SQL.
