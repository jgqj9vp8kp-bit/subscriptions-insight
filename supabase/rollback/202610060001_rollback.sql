-- Rollback of supabase/migrations/202610060001_access_phase2_scope.sql
-- (implementation spec §2.3 / §8 "Rollback" step 4).
--
-- NOT a migration (it lives outside supabase/migrations, so supabase db push
-- and the test harness never run it). Run it by hand, as postgres, AFTER
-- restricted members are disabled, the cohort-membership-freshness cron is
-- unscheduled and the last pre-Phase-2 main Edge build (91fea2f as of
-- 2026-10-07: the server-side Leads, the latest-1,000 candidates and the queued
-- reconcile; see README Rollback step 3) is redeployed, so restricted members get
-- 403 everywhere again:
--   npx.cmd supabase db query --linked -f supabase/rollback/202610060001_rollback.sql
-- or paste it into the SQL editor. It is one transaction.
--
-- What it restores:
--   * resolve_access / my_access / allowed_paths derive paths from
--     funnels.funnel_path again (202610050002 bodies);
--   * every active member reads the whole registry again (the three
--     lockdown_registry_scope policies are dropped; writes keep the
--     202610050003 rule, lockdown_active_member stays);
--   * funnels.funnel_path is no longer canonicalized or mirrored, and a re-path
--     bumps access_version through funnels_bump_member_access_version again.
-- What it leaves in place (unused, harmless): public.funnel_paths with its
-- rows, triggers, policies and RPCs, the clickhouse_cohort_snapshot_state
-- active_* / freshness columns and the RPCs that write them (the replaced
-- complete_clickhouse_cohort_snapshot_build only sets more columns), and the
-- cohort-membership-freshness cron (unschedule it separately, spec §8 step 3).

begin;

-- 202610050002 body.
create or replace function app.resolve_access_core(p_user_id uuid, p_include_data_key boolean)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_ws public.workspaces%rowtype;
  v_member public.workspace_members%rowtype;
  v_role public.access_roles%rowtype;
  v_mode text;
  v_funnel_ids uuid[] := '{}'::uuid[];
  v_paths text[] := '{}'::text[];
  v_email text;
  v_partition text;
  v_result jsonb;
begin
  if p_user_id is null then
    return jsonb_build_object('status', 'no_membership', 'user_id', null);
  end if;

  select * into v_ws from public.workspaces limit 1;
  if not found then
    return jsonb_build_object('status', 'no_workspace', 'user_id', p_user_id, 'workspace_id', null);
  end if;

  select * into v_member
  from public.workspace_members m
  where m.user_id = p_user_id and m.workspace_id = v_ws.id;
  if not found then
    return jsonb_build_object('status', 'no_membership', 'user_id', p_user_id, 'workspace_id', v_ws.id);
  end if;

  if v_member.status <> 'active' then
    return jsonb_build_object('status', 'disabled', 'user_id', p_user_id, 'workspace_id', v_ws.id);
  end if;

  select * into v_role from public.access_roles r where r.id = v_member.role_id;
  if not found then
    -- Impossible under the FK; fail closed (Edge maps an RPC error to 503).
    raise exception 'access role % missing for member %', v_member.role_id, v_member.id;
  end if;

  v_mode := app.member_scope_mode(v_member.id);
  if v_mode = 'selected' then
    v_funnel_ids := app.member_funnel_ids(v_member.id);
    select coalesce(array_agg(distinct p order by p), '{}'::text[]) into v_paths
    from (
      select app.canonical_funnel_path(f.funnel_path) as p
      from public.funnels f
      where f.id = any (v_funnel_ids)
    ) paths
    where p is not null;
  end if;

  select u.email into v_email from auth.users u where u.id = p_user_id;

  v_partition := encode(sha256(convert_to(concat_ws('|',
    v_ws.id::text,
    p_user_id::text,
    v_member.access_version::text,
    v_mode,
    array_to_string(v_funnel_ids, ',')
  ), 'UTF8')), 'hex');

  v_result := jsonb_build_object(
    'status', 'ok',
    'workspace_id', v_ws.id,
    'member_id', v_member.id,
    'user_id', p_user_id,
    'email', coalesce(v_email, nullif(v_member.email_snapshot, '')),
    'display_name', nullif(v_member.display_name, ''),
    'is_data_owner', v_member.is_data_owner,
    'raw_access', p_user_id = v_ws.data_key,
    'role', jsonb_build_object(
      'id', v_role.id,
      'key', v_role.key,
      'name', v_role.name,
      'is_owner', v_role.is_owner,
      'permissions', to_jsonb(v_role.permissions)
    ),
    'funnel_scope', jsonb_build_object(
      'mode', v_mode,
      'funnel_ids', to_jsonb(v_funnel_ids),
      'paths', to_jsonb(v_paths)
    ),
    'access_version', v_member.access_version::text,
    'partition', v_partition
  );

  if p_include_data_key then
    v_result := v_result || jsonb_build_object('data_key', v_ws.data_key);
  end if;

  return v_result;
end;
$$;

-- 202610050002 body.
create or replace function app.allowed_paths()
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select case sr.mode
      when 'all' then array['*']::text[]
      when 'selected' then (
        select coalesce(array_agg(distinct p order by p), '{}'::text[])
        from (
          select app.canonical_funnel_path(f.funnel_path) as p
          from public.member_scope_values v
          join public.funnels f on f.id = v.funnel_id
          where v.member_id = m.id and v.dimension = 'funnel'
        ) paths
        where p is not null
      )
      else '{}'::text[]
    end
    from public.workspace_members m
    left join public.member_scope_rules sr on sr.member_id = m.id and sr.dimension = 'funnel'
    where m.user_id = (select auth.uid()) and m.status = 'active'
  ), '{}'::text[])
$$;

drop policy if exists lockdown_registry_scope on public.funnels;
drop policy if exists lockdown_registry_scope on public.funnel_tags;
drop policy if exists lockdown_registry_scope on public.tags;

drop trigger if exists funnels_canonicalize_path on public.funnels;
drop trigger if exists funnels_sync_paths on public.funnels;

-- 202610050002 trigger (its function was kept by 202610060001).
drop trigger if exists funnels_bump_member_access_version on public.funnels;
create trigger funnels_bump_member_access_version
after update of funnel_path on public.funnels
for each row
when (old.funnel_path is distinct from new.funnel_path)
execute function app.funnel_path_bump_members();

commit;
