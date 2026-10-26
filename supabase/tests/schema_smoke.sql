-- Smoke test for the core schema: the database itself enforces R1, R3,
-- "nothing is deleted" and the audit trail. Run with psql -v ON_ERROR_STOP=1.
\set QUIET on
begin;
insert into tenants (id, name) values ('00000000-0000-0000-0000-000000000001', 'Test tenant');
insert into sites (id, tenant_id, name, time_zone) values ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'Test mine', 'America/Vancouver');
insert into assets (id, tenant_id, site_id, unit_number) values ('00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', 'HT107');
insert into down_flags (id, tenant_id, site_id, asset_id, flag_type, state, reason_code, starts_at)
  values ('00000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000003', 'unscheduled', 'open', 'Breakdown', '2026-10-26 15:02Z');

-- R1: a second open flag is refused.
do $$ begin
  insert into down_flags (tenant_id, site_id, asset_id, flag_type, state, reason_code, starts_at)
  values ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000003', 'unscheduled', 'open', 'x', '2026-10-26 16:00Z');
  raise exception 'R1 not enforced';
exception when unique_violation then null; end $$;

-- R3: an overlapping released flag is refused.
do $$ begin
  insert into down_flags (tenant_id, site_id, asset_id, flag_type, state, reason_code, starts_at, ends_at)
  values ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000003', 'unscheduled', 'released', 'x', '2026-10-26 14:00Z', '2026-10-26 15:30Z');
  raise exception 'R3 not enforced';
exception when exclusion_violation then null; end $$;

-- A voided overlapping flag is fine (it never counts).
insert into down_flags (tenant_id, site_id, asset_id, flag_type, state, reason_code, starts_at, ends_at, void_reason)
values ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000003', 'unscheduled', 'voided', 'x', '2026-10-26 14:00Z', '2026-10-26 15:30Z', 'Wrong unit');

-- Nothing is deleted.
do $$ begin
  delete from down_flags where id = '00000000-0000-0000-0000-000000000010';
  raise exception 'delete not refused';
exception when raise_exception then
  if sqlerrm like '%never deleted%' then null; else raise; end if;
end $$;
do $$ begin
  delete from assets where id = '00000000-0000-0000-0000-000000000003';
  raise exception 'delete not refused';
exception when raise_exception then
  if sqlerrm like '%never deleted%' then null; else raise; end if;
end $$;

-- Stage interval: only one open per flag; Waiting other needs a reason.
insert into flag_stage_intervals (tenant_id, site_id, flag_id, stage, starts_at)
values ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000010', 'waiting_crew', '2026-10-26 15:02Z');
do $$ begin
  insert into flag_stage_intervals (tenant_id, site_id, flag_id, stage, starts_at)
  values ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000010', 'in_repair', '2026-10-26 15:40Z');
  raise exception 'two open stages allowed';
exception when unique_violation then null; end $$;
do $$ begin
  update flag_stage_intervals set ends_at = '2026-10-26 15:40Z' where flag_id = '00000000-0000-0000-0000-000000000010';
  insert into flag_stage_intervals (tenant_id, site_id, flag_id, stage, starts_at)
  values ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000010', 'waiting_other', '2026-10-26 15:40Z');
  raise exception 'waiting_other without reason allowed';
exception when check_violation then null; end $$;

-- Releasing needs an end time; the audit trail captured every change.
update down_flags set state = 'released', ends_at = '2026-10-27 01:10Z' where id = '00000000-0000-0000-0000-000000000010';
do $$ declare n int; begin
  select count(*) into n from audit_log where entity = 'down_flags';
  if n < 3 then raise exception 'audit log has % rows for down_flags', n; end if;
end $$;

-- The audit log cannot be edited.
do $$ begin
  update audit_log set reason = 'tamper';
  raise exception 'audit log update allowed';
exception when raise_exception then
  if sqlerrm like '%cannot be changed%' then null; else raise; end if;
end $$;

rollback;
\echo 'schema smoke test passed'
