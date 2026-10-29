# Field mapping (A3): Maximo and SAP PM files

Phase 4 part 2 (plan section 13, "Scale": more ERPs). This is the A3 document for file imports.
The ERP stays the system of record; the platform reads exports and never writes back (plan 6.3).
Live connectors stay in phase 1b. The code is `MAXIMO_DEFAULT_MAPPING` and `SAP_PM_DEFAULT_MAPPING`
in `packages/core/src/imports.ts`.

Both mappings are **starting points**. Column names, work types and statuses differ from site to
site; each needs checking against a real export from that site before go-live. Nothing in the
repository comes from an employer or site system (CLAUDE.md rule 9).

## Choosing the source system

Setting `imports.sourceSystem`, per site: `maximo` (default) or `sap_pm`. The data owner (Admin in
phase 1a, permission `manage_imports`) changes it on the Data import page, with a reason. Every
import then reads columns with that mapping. Rows already imported keep the source system they came
from, so a site that moves from one ERP to the other keeps its history.

The setting can also give the site value the files use (for example the SAP maintenance plant
`1000`); rows for any other site value are left out, as before.

## Rules that apply to both

- **Column names** are matched without regard to case.
- **Joined columns**: a mapping entry `A+B` reads columns A and B and joins them with a space. SAP
  lists give the date and the time of an event in two columns (for example `GETRI` and `GEUZI`); the
  mapping reads them as one time. Only the first column must be present; a missing second column
  reads as empty.
- **Dates** without an offset are site local time (rule 7). Formats are tried in the order listed.
- **Numbers** accept `1234.5`, `1,234.5`, `1234,5`, `1.234,5` (two or more dot groups or a comma
  decimal) and a trailing minus as SAP writes negatives (`12,5-`). A plain `1.234` is read as
  1.234, never 1,234.
- **Work order numbers** are matched after the prefix (`WO`, `PM`, `#`) is removed and leading zeros
  of an all-digit number are dropped. SAP order `000004001234` and `4001234` are the same order.
- **Statuses** can hold several words. SAP writes system and user statuses together, such as
  `REL MACM WSHD`. Each word is looked up:
  - the work order is **closed** when any word is a closed status;
  - its **readiness** (KPI-021) is the most limiting of the words found, in this order: waiting for
    approval, waiting for parts, waiting for shutdown, in progress, ready. Words not in the map are
    ignored; if none is in the map the readiness is unknown.
  - A one-word Maximo status gives the same result as before.

## Maximo (default)

| Platform field | Assets | Work orders | Meter readings |
| --- | --- | --- | --- |
| ERP asset number | ASSETNUM | ASSETNUM | ASSETNUM |
| Unit number | ASSETNUM | | |
| Fleet, model, serial | ASSETTYPE, MODEL, SERIALNUM | | |
| Functional location | LOCATION | | |
| Number, type, status, priority | | WONUM, WORKTYPE, STATUS, WOPRIORITY | |
| Description | | DESCRIPTION | |
| Reported, finished, changed | | REPORTDATE, ACTFINISH, CHANGEDATE | |
| Target and scheduled start and finish | | TARGSTARTDATE, TARGCOMPDATE, SCHEDSTART, SCHEDFINISH | |
| Estimated and actual hours | | ESTDUR, ACTLABHRS | |
| PM, originating record | | PMNUM, ORIGRECORDID | |
| Reading time and hours | | | READINGDATE, READING (METERNAME = SMU) |
| Site filter | SITEID | SITEID | SITEID |

Work types: PM → PM; CM, EM, BD → corrective; INSP → inspection; CAP, PROJ → project. Closed:
COMP, CLOSE, CAN. Readiness: WAPPR approval, WMATL parts, WPCOND shutdown, APPR and WSCH ready, INPRG
in progress.

## SAP PM

From the standard list reports: equipment list (IH08), order list (IW38 or IW39) and measurement
documents (IK17), exported to a spreadsheet with technical column names.

| Platform field | Equipment (IH08) | Orders (IW39) | Measurement documents (IK17) |
| --- | --- | --- | --- |
| ERP asset number | EQUNR | EQUNR | EQUNR |
| Unit number | TIDNR (technical identification) | | |
| Fleet, model, serial | EQART (object type), TYPBZ (model number), SERGE | | |
| Functional location | TPLNR | | |
| Number, type, status, priority | | AUFNR, AUART, STTXT+USTXT, PRIOK | |
| Description | | KTEXT | |
| Reported, finished, changed | | ERDAT, GETRI+GEUZI, AEDAT | |
| Target (basic) start and finish | | GSTRP, GLTRP | |
| Scheduled start and finish | | GSTRS, GLTRS | |
| Estimated and actual hours | | ARBEI, ISMNW | |
| Maintenance plan | | WARPL | |
| Reading time and value | | | IDATE+ITIME, RECDV (PSORT = SMU) |
| Site filter | SWERK (maintenance plant) | SWERK | SWERK |

- Order types (placeholder; sites configure their own): PM01 → corrective, PM02 → PM, PM03 →
  inspection, PM04 → project, PM05 → corrective.
- Closed: TECO (technically complete), CLSD (closed), DLFL (deletion flag). Cancelled work (left out of
  schedule and PM compliance) is CAN in Maximo and DLFL in SAP.
- Readiness: CRTD → waiting for approval (created, not released), MSPT → waiting for parts (missing
  parts), WSHD → waiting for shutdown (a user status; rename to the site's own), PCNF → in progress
  (partly confirmed), REL → ready.
- SAP has no originating work order on the order list; inspection follow-ups (KPI-028) count only
  when the column is mapped.
- Dates: `dd.MM.yyyy`, with or without `HH:mm:ss`, and the internal `yyyyMMdd` and `HHmmss`.
- The sample files the app writes for SAP use the same columns and `dd.MM.yyyy HH:mm:ss`.

## Later

- Mapping each column on screen, per site, with a preview (today the site picks Maximo or SAP and
  the site value; other changes are a code change with this document first).
- SAP notifications (IW29) for failure coding (damage, cause and object part codes).
- Live connectors to both ERPs (phase 1b).
