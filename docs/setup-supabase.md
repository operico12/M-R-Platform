# Connecting a Supabase project

Without these settings the app runs on the synthetic demo fleet in the browser. With them, people sign in and every change is saved to the database. The row-level security rules in `supabase/migrations` decide who can read and write what.

## 1. Create the project

On supabase.com, create a project in the **Canada (Central)** region (plan 6.1, data residency). Keep separate projects for dev, test and production.

## 2. Apply the migrations

Apply every file in `supabase/migrations`, in name order. Either paste each one into the SQL editor, or use the Supabase CLI:

```bash
supabase link --project-ref <ref>
supabase db push
```

## 3. Load the demo fleet and invite the first Admin (dev and test only)

```bash
pnpm seed:sql --admin you@example.com > seed.sql
psql "<connection string from Project settings, Database>" -f seed.sql
```

The file is about 4 MB with 120 days of history. Add `--days 30` for a file small enough to paste into the SQL editor. The seed is synthetic only (CLAUDE.md rule 9). For production, load real data through the import screen instead.

## 4. Auth settings

Under Authentication, URL configuration:
- Set the Site URL to the address the app is served from.
- Add the same address to Redirect URLs.

Sign-in uses email links (no passwords). Anyone can request a link, but they see nothing until an Admin has added their email in Console, Users. `app_join()` turns that invite into a membership the first time they sign in.

## 5. Point the app at it

Copy `apps/web/.env.example` to `apps/web/.env.local` and fill in:
- the Project URL
- the anon public key

For a hosted build, set the same two values as build environment variables. Never use the service_role key in the app.

## 6. Host it on Vercel

1. On vercel.com, Add New, Project, and import the GitHub repo.
   - Root Directory: `apps/web`. Application Preset: Vite. Leave the build settings as they are; Vercel installs the whole pnpm workspace.
   - Until the stacked PRs are merged, set Settings, Git, Production Branch to the newest branch.
2. Under Environment Variables, add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` (the anon key only), for Production and Preview. Then deploy.
3. In Supabase, Authentication, URL configuration:
   - Site URL: the production address, for example `https://m-r-platform.vercel.app`.
   - Redirect URLs: the same address, plus `https://m-r-platform-*.vercel.app/**` for preview deployments.

The app uses `#/` page addresses, so no rewrite rules are needed.

## 7. Questions with Claude (Assist, "Ask")

The Ask tab (docs/ai-assist.md AI-5) calls the Edge Function `supabase/functions/assist-ask`. The
Anthropic key lives only in Supabase as a secret, never in the app, Vercel or this repository.

1. Run the migration `20261109000001_assist_questions.sql` (or the add-on file
   `14-assist-questions.sql`) in the SQL editor.
2. Create an API key at console.anthropic.com (Settings, API keys). Set a monthly spend limit there
   too.
3. In Supabase: Edge Functions, Secrets, add `ANTHROPIC_API_KEY` with that key.
4. Deploy the function, either way:
   - Dashboard: Edge Functions, Deploy a new function, "Via editor", name it `assist-ask`, and paste
     `index.ts` and `logic.ts` from `supabase/functions/assist-ask` as two files.
   - Command line: `supabase functions deploy assist-ask --project-ref <project ref>`.
   Leave "Verify JWT" on: only signed-in people can call it.
5. Sign in as a supervisor, reliability engineer or superintendent, open Assist, Ask, and ask a
   question. Each person can ask 20 a day; the questions and answers are kept in `assist_questions`.

## How saving works

- Every change still runs through the core rules in the browser first.
- The result is saved with the `app_save_*` functions. These run as the signed-in person, so the database's row-level security has the final say.
- The command's own audit entry (reason, back-dated time) goes to the audit log through `app_log`. The database also logs every row change.
- If a save is refused, the screen says so and reloads what the database holds.

`pnpm test:db` checks all of this on a scratch Postgres:
- A supervisor's flag saves and loads back.
- A viewer and an outsider are refused.
- Invites only work for the matching email.
- Only the reliability engineer can set targets.
