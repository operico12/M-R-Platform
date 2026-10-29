-- Faster read rules (docs/a6-security.md, S-11).
--
-- The read policies said is_site_member(site_id). That function runs with the owner's rights,
-- so Postgres cannot fold it into the query and calls it once for every row it reads; since
-- 21-access it also reads the sign-in token on every call. Loading a site reads tens of
-- thousands of rows across a dozen calls at once, which sometimes ran past Supabase's 8-second
-- limit ("canceling statement due to statement timeout").
--
-- my_site_ids() answers the same question (the sites this person is a current member of, with a
-- sign-in under 30 days old) once per query. Every policy that used is_site_member(site_id) now
-- says site_id in (select my_site_ids()). Who can see what does not change.

create or replace function my_site_ids() returns setof uuid
language sql stable security definer set search_path = public as $$
  select m.site_id from site_members m
  where m.user_id = auth.uid() and m.retired_at is null and session_fresh();
$$;
revoke execute on function my_site_ids() from public, anon;
grant execute on function my_site_ids() to authenticated;

do $$
declare p record; q text; c text;
begin
  for p in
    select n.nspname, cl.relname, po.polname,
      pg_get_expr(po.polqual, po.polrelid) as qual, pg_get_expr(po.polwithcheck, po.polrelid) as chk
    from pg_policy po join pg_class cl on cl.oid = po.polrelid join pg_namespace n on n.oid = cl.relnamespace
    where n.nspname = 'public'
      and (coalesce(pg_get_expr(po.polqual, po.polrelid), '') like '%is_site_member(site_id)%'
        or coalesce(pg_get_expr(po.polwithcheck, po.polrelid), '') like '%is_site_member(site_id)%')
  loop
    q := replace(p.qual, 'is_site_member(site_id)', '(site_id in (select my_site_ids()))');
    c := replace(p.chk, 'is_site_member(site_id)', '(site_id in (select my_site_ids()))');
    if q is not null and c is not null then
      execute format('alter policy %I on %I.%I using (%s) with check (%s)', p.polname, p.nspname, p.relname, q, c);
    elsif q is not null then
      execute format('alter policy %I on %I.%I using (%s)', p.polname, p.nspname, p.relname, q);
    else
      execute format('alter policy %I on %I.%I with check (%s)', p.polname, p.nspname, p.relname, c);
    end if;
  end loop;
end $$;

-- The same for the sites list, keyed on its own id.
alter policy sites_read on sites using (id in (select my_site_ids()));

notify pgrst, 'reload schema';
