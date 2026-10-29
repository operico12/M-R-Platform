# Documents

Tier A documents from build plan v10, section 12. Plan says write these before coding; phase 1a
code started on 26 Oct 2026 with the defaults below, so building is not blocked. Anything a document
has not settled is a setting in code, not a hard-coded choice.

| # | Document | Status | Where |
| --- | --- | --- | --- |
| A1 | Vision and MVP scope | Covered by plan v10 sections 1 and 5 | Build plan |
| A2 | Time model and KPI dictionary | Tier 1 entries drafted from plan 3.3 and A7 section 9 | [kpi-dictionary.md](kpi-dictionary.md) |
| A3 | Data source and field mapping | Maximo and SAP PM file mappings written down; both need a real sample export from the site to confirm | [field-mapping.md](field-mapping.md), `packages/core/src/imports.ts` |
| A4 | MVP requirements and acceptance tests | Acceptance tests partly encoded as golden tests | `packages/core/test` |
| A5 | Architecture decision records | ADR-001 to ADR-004 | [adr/](adr/) |
| A6 | Data-use, security and ownership | First version and security review, 29 Oct 2026 | [a6-security.md](a6-security.md), `supabase/tests/security_audit.sql` |
| A7 | Status, location and flag rules | Draft 0.1 under review; 9 open questions | [a7-open-questions.md](a7-open-questions.md) |
| A8 | Data model | Schema in `supabase/migrations` | |
| A9 | Reference lists | Starter systems, components and failure modes in the synthetic generator | `packages/core/src/synth/generate.ts` |
| A10 | Test data plan and golden dataset | Plan 3.2, Appendix A and A7 HT107 examples encoded; more Appendix E cases in `rules.test.ts` | `packages/core/test` |
| A11 | Glossary | Not started | |
| A12 | Project instruction file | Done | [`CLAUDE.md`](../CLAUDE.md) |

Phase 2 rules: [reliability and threshold alerts](alert-rules.md), [approvals](approvals.md).

Phase 3 rules: [component life and rebuilds](component-life.md), [condition monitoring](condition-monitoring.md), [RCM to PM job plans](rcm.md), [spares and rebuild pool sizing](spares.md), [assist: the first AI features](ai-assist.md).

Phase 3b and 4 rules: [fixed plant](fixed-plant.md), [multi-site](multi-site.md), [public API](public-api.md), [access: account requests, sessions, two-step sign-in](access.md).

Setup: [connecting a Supabase project](setup-supabase.md).
