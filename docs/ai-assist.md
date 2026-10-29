# Assist: the first AI features

Phase 3, plan section 9. The code is in `packages/core/src/assist.ts`. This first part is
"guardrails first": every feature works on the platform itself, with no outside language model. A
language model can be added later behind the same guardrails (see "Later").

## Guardrails (plan 9)

These hold for every assist feature, now and later:

1. **A person decides.** Assist only suggests or drafts. Nothing it produces changes a record until
   a person accepts it in a normal form, and that form runs the normal command with its normal
   permission check and audit entry.
2. **Only the site's own codes.** A code suggestion is always one from the site's code list (A9
   reference list). Assist never invents a code.
3. **Cite the records used.** Every sentence in a draft names the records it came from. A draft that
   cites a record it was not given is refused, not shown (`checkCitations`).
4. **Measured before it is switched on.** Code suggestions are tested on the site's own recent
   records that the model did not learn from. They can only be switched on when the score passes
   the site setting `minScore` (0.8, plan 9 research note: about 0.80 for a model fitted to a site's
   own records).
5. **No write-back to the ERP.** Duplicate work orders are shown for a planner to check in Maximo.
6. **Site data stays with the site.** The code suggester learns in the browser from the site's own
   released flags each time the page loads. Nothing is sent outside the platform, and nothing is
   learned across sites.
7. **Abstain when unsure.** When the best suggestion is less likely than `minConfidence`, assist
   says "no suggestion" rather than guess.

## AI-1 Failure code suggestion

**Where:** the release form of an unscheduled flag, and the failure coding quality list (KPI-026).

**What it reads:** the text of the flag: its notes, the work order descriptions (long description in
Maximo), the repair summary and the findings. Words are lower-cased; common words (the, and, a, was,
...) are dropped; a plural "s" is taken off.

**What it learns from:** released unscheduled flags at the site whose coding is clean for the three
codes it suggests. A flag is used when its component is not "Other", its failure mode is not
"Unknown", and its component is in its system (the KPI-026 checks `component_other`, `mode_unknown`
and `component_mismatch`). The cause code is not suggested, so a missing cause code does not stop a
flag being used.

**How it suggests** (naive Bayes, one of the simplest text classifiers, chosen because the reasons
can be shown):

1. **System** first: for each system, the chance of the words given the system, times the share of
   failures on that system. Each word is counted once per flag. Words never seen with a system get
   a small count (add-one smoothing), so one new word cannot rule a system out.
2. Then **component** and **failure mode**, each only from that system's list on the site's code
   list.
3. Each suggestion shows its chance (the scores turned into shares that add to 100%) and the three
   words that pointed to it most.
4. If the best chance is below `minConfidence` (0.6), that code has no suggestion.

**How it is measured** (the held-back check):

- The flags it can learn from are put in order of release time. The latest `holdoutShare` (20%)
  are held back. It learns from the rest and suggests codes for the held-back flags.
- For each code (system, component, failure mode):
  - **Answered** = held-back flags where it gave a suggestion.
  - **Precision** = right suggestions ÷ answered.
  - **Recall** = right suggestions ÷ all held-back flags.
  - **Score** = F1 = 2 × precision × recall ÷ (precision + recall). This is the micro-F1 of the plan
    9 research note, counting "no suggestion" as a miss.
- A component or failure mode is right only when the system is right too.
- A code **passes** when the score is at or above `minScore` and at least `minHoldout` (30) flags were
  held back. With fewer, the result is shown but nothing passes.

**Switching it on:** the setting `suggestCodes`. It can only be turned on when at least one code
passes; then only the codes that pass are suggested. If a code later fails (the check runs each time
the page loads), its suggestions stop showing and the settings tab says why.

**Accepting:** "Use" fills the release form with the suggestion. The person can change it before
releasing. The release then runs as before (A7 T9).

## AI-2 Duplicate work orders

**Where:** the Work page, "Possible duplicates".

Two open corrective work orders are a possible duplicate when:

- they are on the same unit,
- they were reported within `duplicateDays` (7) of each other, and
- their descriptions share at least `duplicateSimilarity` (0.5) of their words: the words in both
  ÷ the words in either (Jaccard), after the same word clean-up as AI-1. Descriptions with fewer than
  two words left are not compared.

Pairs are grouped, so three alike work orders show as one group of three. The planner checks them
in Maximo; the platform changes nothing.

**Repeats:** a repeat failure (same unit and system within the repeat window, KPI-025) is already
found by the reliability page; assist links to it rather than repeat it.

## AI-3 Weekly pack summary draft

**Where:** the weekly pack, "Draft summary".

A few sentences drafted from the pack's own numbers, each with its source:

- PA and utilisation against target, and the change from the week before (KPI-001, KPI-002).
- Failures, MTBF and MTTR (KPI-005, KPI-006).
- The top system on the downtime Pareto and its share of unscheduled down hours.
- The top bad actor unit and its top system (KPI-027).
- Shop release against plan (KPI-012), when any releases were due.
- Units down now, with the longest.

Each sentence cites KPI numbers and unit numbers, like `[KPI-001]` and `[unit:HT-104]`. The draft is
checked against the records in the pack (`checkCitations`); one unknown citation and the draft is
refused. The person copies the draft into the pack note and edits it. It is not saved by itself.

## AI-4 RCA timeline draft

**Where:** a root cause analysis, "Draft timeline".

A list in time order of what happened to the flags under study, from their records only:

- the flag start, each stage and location change, each ETA set, and the release (with the repair
  summary and findings),
- the work orders on those flags (reported and completed),
- component removals and installs, and oil samples, on the same units from 30 days before the first
  flag to its last release.

Each line cites its record, like `[flag:…]`, `[wo:…]`, `[component:…]` or `[oil:…]`. The draft is
checked the same way as AI-3. The person copies it into the problem statement or a why.

## AI-5 Questions in plain language

Not in this part. Answering questions needs a language model to read the question; it is the first
feature for the model (see "Later"). The answer must use the definitions in `docs/kpi-dictionary.md`
and cite the records it used, and pass `checkCitations`.

## Settings

Site setting `assist`, changed by people with `edit_assist`, with a reason and an audit entry:

| Setting | Default | Meaning |
| --- | --- | --- |
| `suggestCodes` | off | Show failure code suggestions (only codes that pass the check) |
| `minConfidence` | 0.6 | Below this chance, no suggestion |
| `minScore` | 0.8 | Held-back score a code needs to be suggested |
| `holdoutShare` | 0.2 | Share of the latest flags held back for the check |
| `minHoldout` | 30 | Fewest held-back flags before a code can pass |
| `duplicateDays` | 7 | Days between two work orders to compare them |
| `duplicateSimilarity` | 0.5 | Share of words in common for a possible duplicate |

## Who can do what

| Action | Roles |
| --- | --- |
| See suggestions and drafts | Anyone who can see the page they are on |
| Use a suggestion on a release | Whoever can release the flag (`set_clear_flag`) |
| Change assist settings, switch suggestions on | Reliability engineer, superintendent (`edit_assist`) |

Plan 11.2 has no row for assist. Settings follow the RCM and spares settings.

## Later

- **A language model** for AI-5 and for better drafts, called from a Supabase Edge Function with the
  key kept as a Supabase secret, never in the app or the repository. It gets only the records the
  person can see, and its answer must pass `checkCitations`. Plan 9 prefers a local model for
  sensitive data; the choice is Ope's.
- **Recoding a released flag** from a suggestion on the coding quality list. A7 has no rule for
  changing failure codes after release (T9 locks them; R5 locks closed periods). Until A7 says, the
  list shows the suggestion and the person recodes in Maximo.
- Recording whether each suggestion was used, to watch the score in daily use as well as on the
  held-back flags.
