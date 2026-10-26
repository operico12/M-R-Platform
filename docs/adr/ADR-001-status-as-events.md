# ADR-001: Store status as timed events, not current-status fields

- Date: 2026-10-26 · Status: accepted
- Context: BayMaster kept failure details on the unit record and mixed location, stage and availability in one list, so PA and queue time were hard to calculate and history depended on a copy step (plan 16.2).
- Decision: A down flag is its own record from the moment a unit goes down. Stage and location are separate timed intervals linked to the flag. Unit status is derived from the open flag. Corrections are new records and audit rows; nothing is overwritten or deleted.
- Consequences: Every KPI and filter can be calculated from one record set, and reports can be re-run over history. Queries must aggregate intervals, so summary tables (`kpi_unit_shift`) are needed for speed.
