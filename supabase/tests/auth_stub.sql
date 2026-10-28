-- Minimal stand-in for Supabase's auth schema so the migrations can be
-- tested on plain Postgres (CI and local). Not applied in Supabase.
create schema if not exists auth;
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
