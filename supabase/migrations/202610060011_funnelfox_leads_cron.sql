-- Unattended FunnelFox leads export (leads plan §2 A3, owner decision 3).
--
-- The sync is staged and resumable (profiles -> sessions -> reconcile, one
-- stage per Edge call), so it is driven by two cooperating jobs, like the
-- subscriptions sync (202607250001):
--
--   funnelfox-leads-advance  (every minute)     -- resume: runs the next pending
--       stage. Skipped here, without an HTTP call, while another call holds the
--       lease, while a FunnelFox 429 pause (stats.rate_limited_until) runs,
--       while the backoff after repeated FunnelFox errors runs
--       (stats.error_backoff_until), or once every stage is complete (the Edge
--       would only answer busy / rate limited / backing off / idle).
--   funnelfox-leads-refresh  (daily 06:15 UTC)  -- full_reset: a fresh crawl of
--       the profile list, after the 05:45 subscriptions refresh. Always posted;
--       the Edge applies it to a complete pipeline or one stuck in an error
--       (an unfinished, healthy backfill is only advanced).
--
-- Both post to funnelfox-leads-sync with the shared cron secret (x-cron-secret =
-- FB_CRON_SECRET, checked by the Edge gate's policy.cron branch) and the
-- workspace data key, like the senders in 202610050003. The target URL is
-- derived from fb_cron_config.function_url, so no new config is needed.
-- pg_cron / pg_net were installed by 202607230002.
--
-- APPLY ORDER (safe only after the code that serves the ticks is live):
--   1. 202610060010_funnelfox_leads_export.sql (columns + RPCs; guarded below);
--   2. deploy funnelfox-leads-sync with the lease, the idle no-op and the
--      policy.cron branch (actions sync / sync_full_reset), and clickhouse-users;
--   3. run the owner-only Diagnose probe and one manual Continue;
--   4. this migration.
-- Applied before step 2, every tick is refused by the deployed gate (no cron
-- branch -> session check -> 401) and does no work, but each one is a wasted
-- Edge invocation: keep the order.

do $$
begin
  if to_regprocedure('public.funnelfox_leads_acquire_lease(uuid, integer)') is null
    or to_regprocedure('public.funnelfox_leads_reconcile(uuid)') is null then
    raise exception using
      errcode = 'P0001',
      message = 'funnelfox_leads_cron: 202610060010_funnelfox_leads_export.sql has not been applied',
      hint = 'Apply 202610060010 and deploy the funnelfox-leads-sync Edge function with its cron branch first.';
  end if;
end
$$;

create or replace function public.invoke_funnelfox_leads_sync(p_full_reset boolean default false)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  cfg public.fb_cron_config%rowtype;
  v_data_key uuid := app.data_key();
  v_state public.funnelfox_leads_sync_state%rowtype;
  req_headers jsonb;
  target_url text;
  request_id bigint;
begin
  select * into cfg from public.fb_cron_config where id = true;
  if not found then
    raise notice 'fb_cron_config is empty — funnelfox leads cron skipped';
    return null;
  end if;
  if v_data_key is null then
    raise notice 'workspace is not bootstrapped — funnelfox leads cron skipped';
    return null;
  end if;

  -- The advance tick only: skip the HTTP call when the Edge could only answer
  -- busy (a call holds the lease) or idle (every stage complete). The daily
  -- refresh is always posted: it is what re-opens a completed pipeline.
  if not coalesce(p_full_reset, false) then
    select * into v_state from public.funnelfox_leads_sync_state s where s.auth_user_id = v_data_key;
    if found then
      if v_state.lease_until is not null and v_state.lease_until > clock_timestamp() then
        return null;
      end if;
      if v_state.profiles_completed and v_state.details_completed
        and v_state.sessions_completed and v_state.reconcile_completed then
        return null;
      end if;
      -- A FunnelFox 429 parks the pipeline until stats.rate_limited_until (an
      -- ISO string the Edge writes); until then it would only answer "rate
      -- limited". An unparsable value never blocks the tick.
      begin
        if (v_state.stats ->> 'rate_limited_until')::timestamptz > clock_timestamp() then
          return null;
        end if;
      exception when others then
        null;
      end;
      -- After a FunnelFox error the Edge backs the cron off exponentially
      -- (stats.error_backoff_until, at most an hour), so a persistent error is
      -- not retried every minute. Same rules as above.
      begin
        if (v_state.stats ->> 'error_backoff_until')::timestamptz > clock_timestamp() then
          return null;
        end if;
      exception when others then
        null;
      end;
    end if;
  end if;

  -- Same project/base, different function name.
  target_url := replace(cfg.function_url, 'clickhouse-facebook', 'funnelfox-leads-sync');

  req_headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'x-cron-secret', cfg.cron_secret
  );
  if cfg.anon_key <> '' then
    req_headers := req_headers
      || jsonb_build_object('Authorization', 'Bearer ' || cfg.anon_key)
      || jsonb_build_object('apikey', cfg.anon_key);
  end if;

  -- limit / max_pages are explicit: the Edge's defaults are for the button.
  select net.http_post(
    url := target_url,
    headers := req_headers,
    body := jsonb_build_object('auth_user_id', v_data_key, 'full_reset', p_full_reset, 'limit', 100, 'max_pages', 200),
    timeout_milliseconds := 150000
  ) into request_id;
  return request_id;
end;
$$;

-- pg_cron runs the jobs as postgres (the owner); nobody else needs it.
revoke all on function public.invoke_funnelfox_leads_sync(boolean) from public, anon, authenticated, service_role;

-- Reschedule idempotently.
do $$
begin
  perform cron.unschedule('funnelfox-leads-advance');
exception when others then null;
end $$;
do $$
begin
  perform cron.unschedule('funnelfox-leads-refresh');
exception when others then null;
end $$;

select cron.schedule(
  'funnelfox-leads-advance',
  '* * * * *',
  $$select public.invoke_funnelfox_leads_sync(false)$$
);

select cron.schedule(
  'funnelfox-leads-refresh',
  '15 6 * * *',
  $$select public.invoke_funnelfox_leads_sync(true)$$
);
