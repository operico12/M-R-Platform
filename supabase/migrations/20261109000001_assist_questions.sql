-- AI-5 questions answered by Claude (phase 3; docs/ai-assist.md). The Edge Function
-- assist-ask calls these with the asker's own sign-in, so the role check and the
-- daily limit are enforced here, not in the function. Nothing is deleted.

create table assist_questions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  site_id uuid not null references sites(id),
  user_id uuid not null,
  asked_at timestamptz not null default now(),
  question text not null check (length(question) between 1 and 500),
  outcome text not null default 'pending' check (outcome in ('pending', 'answered', 'cannot_answer', 'failed_check', 'refused', 'no_answer', 'error')),
  answer_lines text[] not null default '{}',
  cited text[] not null default '{}',
  model text,
  input_tokens integer,
  output_tokens integer,
  finished_at timestamptz
);
create index assist_questions_user_day on assist_questions (site_id, user_id, asked_at);

create trigger assist_questions_no_delete before delete on assist_questions for each row execute function refuse_delete();
create trigger assist_questions_audit after insert or update on assist_questions for each row execute function audit_row();
alter table assist_questions enable row level security;
-- Your own questions; reliability engineers and superintendents read all at the site. Writes only through the functions below.
create policy assist_questions_read on assist_questions for select
  using (user_id = auth.uid() or site_role(site_id) in ('reliability_engineer', 'superintendent'));

-- ask_assist (packages/core/src/permissions.ts): supervisor, reliability engineer, superintendent. 20 a person a site day.
create or replace function app_assist_start(p_site uuid, p_question text) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_tz text;
  v_tenant uuid;
  v_count integer;
  v_id uuid;
begin
  if auth.uid() is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  if coalesce(site_role(p_site)::text, '') not in ('supervisor', 'reliability_engineer', 'superintendent') then
    raise exception 'Your role cannot ask questions here.' using errcode = '42501';
  end if;
  select time_zone, tenant_id into v_tz, v_tenant from sites where id = p_site;
  select count(*) into v_count from assist_questions
    where site_id = p_site and user_id = auth.uid()
      and asked_at >= (date_trunc('day', now() at time zone v_tz) at time zone v_tz);
  if v_count >= 20 then raise exception 'Daily limit reached: 20 questions a day.' using errcode = 'P0001'; end if;
  insert into assist_questions (tenant_id, site_id, user_id, question)
    values (v_tenant, p_site, auth.uid(), trim(p_question)) returning id into v_id;
  return v_id;
end $$;

-- Close your own pending question once. The answer is kept as given.
create or replace function app_assist_finish(p_id uuid, p_outcome text, p_lines text[], p_cited text[], p_model text, p_input_tokens integer, p_output_tokens integer) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_outcome = 'pending' then raise exception 'A finished question needs an outcome.'; end if;
  update assist_questions
    set outcome = p_outcome, answer_lines = coalesce(p_lines, '{}'), cited = coalesce(p_cited, '{}'),
        model = p_model, input_tokens = p_input_tokens, output_tokens = p_output_tokens, finished_at = now()
    where id = p_id and user_id = auth.uid() and outcome = 'pending';
  if not found then raise exception 'No pending question of yours with that id.' using errcode = '42501'; end if;
end $$;

revoke all on function app_assist_start(uuid, text) from public;
revoke all on function app_assist_finish(uuid, text, text[], text[], text, integer, integer) from public;
grant execute on function app_assist_start(uuid, text) to authenticated;
grant execute on function app_assist_finish(uuid, text, text[], text[], text, integer, integer) to authenticated;
grant select on assist_questions to authenticated;
