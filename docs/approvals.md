# Approvals

Phase 2 (plan 11.3 "Two people for big changes", 11.4 "Approvals", 11.5 "Propose, approve, apply",
11.7 phase 2 "Superintendent approvals for all governed changes").

## What needs approval in this release

| Change | Who asks | Who approves | Applied as |
| --- | --- | --- | --- |
| A KPI target (value, amber band, scope, start) | Reliability engineer or superintendent | A superintendent (or acting superintendent) who did not ask | A new target from the requested start. If that start has passed by the time it is approved, it starts at the next shift instead, and says so |
| A component target life (model, kind, hours, start date; docs/component-life.md) | Reliability engineer or superintendent | A superintendent who did not ask | A new target life from the requested start date. Lives that ended earlier keep the old target. The database builds it from the request itself, so the values cannot change between asking and applying |
| Giving someone the Admin or Superintendent role | Admin (data owner) | A superintendent who did not ask | The person's role changes |
| An acting role with an end date | Admin (data owner) | A superintendent who did not ask | The person acts in that role until the end date, then goes back automatically |

Nobody approves their own request, including a superintendent who asks. A request can be approved,
rejected (with a reason), withdrawn by the person who asked, or sent back with a question. Questions
and answers stay on the request. Requests are never deleted, and every step is in the audit log with
the real time it was entered.

## Starting a site (choice to confirm)

A site with no active superintendent has nobody who can approve. Until the first superintendent
exists, the admin can give the Superintendent or Admin role directly; the change is marked "no
superintendent yet, applied without approval" in the audit log. Once there is a superintendent, those
grants need approval. Inviting someone straight into the Admin or Superintendent role is only allowed
in the same starting case; otherwise invite them as a viewer and ask for the role.

Once a site has a superintendent it keeps one: the admin cannot remove or demote the last
superintendent (give the role to someone else first, with approval). Without this, removing the
superintendent would reopen the starting rule. Only the admin changes roles; a superintendent
changes one only by approving a request.

This is not settled by the plan. It is the smallest rule that lets a new site start; Ope to confirm.

## Not yet

- Changes in a locked period (A7 R5): the flag commands already refuse them; the request and approval
  flow for them comes with the period lock.
- Flag rule and KPI definition changes: flag rules are read-only in the app until A7 is settled.
- Undo from the audit log (plan 11.5).
