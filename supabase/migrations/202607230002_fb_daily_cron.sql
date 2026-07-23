-- Daily Facebook warehouse tick (design §8: reconciliation runs by cron, not
-- only after manual syncs). pg_cron fires a pg_net POST to the
-- clickhouse-facebook Edge Function with the shared cron secret; the function
-- runs an incremental sync + stores a recon snapshot (V2 parity included), so
-- the 7-green-days cutover gate accrues even on days nobody opens the app.
--
-- The secret lives in TWO places set at deploy time, never in git:
--   * Edge Function secret  FB_CRON_SECRET (supabase secrets set ...)
--   * fb_cron_config row    (insert via SQL; table is service-role only)

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Single-row config. No RLS policies on purpose: with RLS enabled and no
-- policies, only service_role / SECURITY DEFINER functions can read it.
create table if not exists public.fb_cron_config (
  id boolean primary key default true check (id),
  auth_user_id uuid not null,
  cron_secret text not null,
  function_url text not null,
  updated_at timestamptz not null default now()
);

alter table public.fb_cron_config enable row level security;

create or replace function public.invoke_fb_daily_cron()
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  cfg public.fb_cron_config%rowtype;
  request_id bigint;
begin
  select * into cfg from public.fb_cron_config where id = true;
  if not found then
    raise notice 'fb_cron_config is empty — daily FB cron skipped';
    return null;
  end if;
  select net.http_post(
    url := cfg.function_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', cfg.cron_secret
    ),
    body := jsonb_build_object('auth_user_id', cfg.auth_user_id),
    timeout_milliseconds := 150000
  ) into request_id;
  return request_id;
end;
$$;

revoke all on function public.invoke_fb_daily_cron() from public;
revoke all on function public.invoke_fb_daily_cron() from anon;
revoke all on function public.invoke_fb_daily_cron() from authenticated;

-- Reschedule idempotently (unschedule tolerates a missing job).
do $$
begin
  perform cron.unschedule('fb-daily-warehouse-tick');
exception when others then
  null;
end
$$;

select cron.schedule(
  'fb-daily-warehouse-tick',
  '30 5 * * *', -- 05:30 UTC daily, after Capsuled's own overnight refresh
  $$select public.invoke_fb_daily_cron()$$
);
