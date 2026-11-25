# Flag comments

Ope, 8 Dec 2026: when a flag is raised or running, people must be able to add comments, and the comments must be
reviewable later, after the unit is back up. Code: `packages/core/src/comments.ts` (tested in `test/comments.test.ts`),
`supabase/migrations/20261201000001_flag_comments.sql` (tested in `supabase/tests/flag_comments_api.sql`).

## What a comment is

- It belongs to one down flag, and optionally to one wait tag on that flag ("waiting for parts: part 1234 is
  on the 14:00 truck"). It has text (1 to 1000 characters), who wrote it and when it was entered.
- Comments are a thread, oldest first. The wait tag's own note (up to 300 characters, written when the tag is
  raised) stays on the tag and is shown at the top of that tag's thread; comments add to it.
- A comment is **never edited and never deleted** (rule 5). A wrong or inappropriate comment is *voided* with a
  reason. A voided comment stays in the thread, struck through, with who voided it, when and why.
- The time is the time it was entered (the server's clock). A comment cannot be back-dated.
- Every add and void goes to the audit log with who, when, before and after.

## Rules

- A comment can be added to an **open** or **released** down flag. Released flags keep taking comments so a
  finding after the repair (for example "root cause confirmed by the lab") stays with the event. A voided or
  proposed flag takes none.
- A comment on a wait tag must name a tag on the same flag. A voided tag takes none.
- Who can add: permission `add_notes` (plan 11.2): technician, supervisor, reliability engineer and superintendent.
  Viewers and the Admin cannot.
- Who can void: the person who wrote it, a supervisor, a reliability engineer or a superintendent. A reason is required (up to 300 characters).

## Where they show

- **Unit sheet**: the flag's thread, with a box to add a comment (and a "Re:" picker to attach it to an open
  wait tag), and "Void" on each comment you may void.
- **Unit page, Down flags table**: a Comments column with the count; open a row to read the whole thread for
  that flag, including released ones, with the wait tags and their times.
- **Status board** and **shop lines**: unchanged.

## Database

- `flag_comments` is insert-only: the guard trigger refuses any change except voiding once with a reason, stamps
  `set_by` and `entered_at` itself, and checks the flag and wait tag belong to the same unit and site. Deletes are
  refused, and an audit trigger records every change. Row-level security follows the site, and the roles that may
  write follow the matrix above.
- `app_save_comments(site, rows)` and `app_load_comments(site, since)` are the only calls the app makes.
