# Documents

Tier A documents from build plan v10, section 12. Plan says write these before coding; phase 1a
code started on 26 Oct 2026 with the defaults below, so building is not blocked. Anything a document
has not settled is a setting in code, not a hard-coded choice.

| # | Document | Status | Where |
| --- | --- | --- | --- |
| A1 | Vision and MVP scope | Covered by plan v10 sections 1 and 5 | Build plan |
| A2 | Time model and KPI dictionary | Tier 1 entries drafted from plan 3.3 and A7 section 9 | [kpi-dictionary.md](kpi-dictionary.md) |
| A3 | Data source and field mapping | Not started (needs a sample Maximo export) | |
| A4 | MVP requirements and acceptance tests | Acceptance tests partly encoded as golden tests | `packages/core/test` |
| A5 | Architecture decision records | ADR-001 to ADR-004 | [adr/](adr/) |
| A6 | Data-use, security and ownership | Not started. Repo uses synthetic data only | |
| A7 | Status, location and flag rules | Draft 0.1 under review; 9 open questions | [a7-open-questions.md](a7-open-questions.md) |
| A8 | Data model | Schema in `supabase/migrations` | |
| A9 | Reference lists | Starter systems, components and failure modes in the synthetic generator | `packages/core/src/synth/generate.ts` |
| A10 | Test data plan and golden dataset | Plan 3.2, Appendix A and A7 HT107 examples encoded; more Appendix E cases in `rules.test.ts` | `packages/core/test` |
| A11 | Glossary | Not started | |
| A12 | Project instruction file | Done | [`CLAUDE.md`](../CLAUDE.md) |
