-- Access control Phase 2: keep the cohort snapshot fresh for restricted members
-- (implementation spec §2.2 / §3.8).
--
-- Apply AFTER the scope-aware Edge deploy: clickhouse-cohort-membership must
-- already accept the cron-only `cron_tick` action (x-cron-secret = the shared
-- FB cron secret), otherwise every tick is answered 400.
--
-- Every 15 minutes the tick asks clickhouse-cohort-membership to compare the
-- warehouse fingerprint with the active snapshot: current -> fresh_verified_at
-- moves (and a missing campaign scope is built), changed -> the snapshot is
-- rebuilt. Restricted members get 409 scope_snapshot_not_ready on a snapshot
-- not verified within the freshness bound (6 h), so the tick only runs while a
-- restricted (selected / none scope) active member exists, or when forced from
-- the SQL editor: `select public.invoke_cohort_membership_tick(true);`.
--
-- Mirrors invoke_funnelfox_subscriptions_sync (202610050003): same config row,
-- same headers, the workspace data key in the body (the Edge cron context
-- rejects any other tenant).

create or replace function public.invoke_cohort_membership_tick(p_force boolean default false)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  cfg public.fb_cron_config%rowtype;
  v_data_key uuid := app.data_key();
  req_headers jsonb;
  request_id bigint;
begin
  select * into cfg from public.fb_cron_config where id = true;
  if not found then
    raise notice 'fb_cron_config is empty — cohort membership tick skipped';
    return null;
  end if;
  if v_data_key is null then
    raise notice 'workspace is not bootstrapped — cohort membership tick skipped';
    return null;
  end if;
  if not p_force and not exists (
    select 1
    from public.workspace_members m
    left join public.member_scope_rules r on r.member_id = m.id and r.dimension = 'funnel'
    where m.status = 'active' and coalesce(r.mode, 'none') <> 'all'
  ) then
    return null;
  end if;

  req_headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'x-cron-secret', cfg.cron_secret
  );
  if cfg.anon_key <> '' then
    req_headers := req_headers
      || jsonb_build_object('Authorization', 'Bearer ' || cfg.anon_key)
      || jsonb_build_object('apikey', cfg.anon_key);
  end if;

  select net.http_post(
    url := replace(cfg.function_url, 'clickhouse-facebook', 'clickhouse-cohort-membership'),
    headers := req_headers,
    body := jsonb_build_object('auth_user_id', v_data_key, 'action', 'cron_tick'),
    timeout_milliseconds := 150000
  ) into request_id;
  return request_id;
end;
$$;

-- pg_cron runs it as postgres; no API role may trigger a rebuild through it.
revoke all on function public.invoke_cohort_membership_tick(boolean) from public, anon, authenticated, service_role;

do $$
begin
  perform cron.unschedule('cohort-membership-freshness');
exception when others then
  null;
end
$$;

select cron.schedule(
  'cohort-membership-freshness',
  '7,22,37,52 * * * *',
  $$select public.invoke_cohort_membership_tick(false)$$
);
