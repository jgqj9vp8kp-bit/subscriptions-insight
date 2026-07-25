-- Periodic FunnelFox subscription sync (persist to funnelfox_subscriptions and
-- keep it fresh). The sync is staged and resumable — one Edge invocation runs
-- one stage (list -> details -> profiles -> finalize) — so a daily refresh is
-- carried out by two cooperating jobs:
--
--   funnelfox-subscriptions-refresh  (daily 05:45 UTC) — full_reset: re-opens
--       the list + re-checks, starting a fresh daily crawl.
--   funnelfox-subscriptions-advance  (every 15 min)   — resume: advances the
--       next pending stage; a cheap no-op once the pipeline is complete.
--
-- Both hit funnelfox-subscriptions-sync with the shared cron secret. Reuses the
-- fb_cron_config row (auth_user_id / cron_secret / anon_key) set up for the FB
-- tick; the target URL is derived from the stored FB function_url so no new
-- config is needed. pg_cron / pg_net were installed by 202607230002.

create or replace function public.invoke_funnelfox_subscriptions_sync(p_full_reset boolean default false)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  cfg public.fb_cron_config%rowtype;
  req_headers jsonb;
  target_url text;
  request_id bigint;
begin
  select * into cfg from public.fb_cron_config where id = true;
  if not found then
    raise notice 'fb_cron_config is empty — funnelfox subscriptions cron skipped';
    return null;
  end if;

  -- Same project/base, different function name.
  target_url := replace(cfg.function_url, 'clickhouse-facebook', 'funnelfox-subscriptions-sync');

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
    url := target_url,
    headers := req_headers,
    body := jsonb_build_object('auth_user_id', cfg.auth_user_id, 'full_reset', p_full_reset),
    timeout_milliseconds := 150000
  ) into request_id;
  return request_id;
end;
$$;

revoke all on function public.invoke_funnelfox_subscriptions_sync(boolean) from public;
revoke all on function public.invoke_funnelfox_subscriptions_sync(boolean) from anon;
revoke all on function public.invoke_funnelfox_subscriptions_sync(boolean) from authenticated;

-- Reschedule idempotently.
do $$
begin
  perform cron.unschedule('funnelfox-subscriptions-refresh');
exception when others then null;
end $$;
do $$
begin
  perform cron.unschedule('funnelfox-subscriptions-advance');
exception when others then null;
end $$;

select cron.schedule(
  'funnelfox-subscriptions-refresh',
  '45 5 * * *',
  $$select public.invoke_funnelfox_subscriptions_sync(true)$$
);

select cron.schedule(
  'funnelfox-subscriptions-advance',
  '*/15 * * * *',
  $$select public.invoke_funnelfox_subscriptions_sync(false)$$
);
