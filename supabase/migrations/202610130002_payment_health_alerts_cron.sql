-- Payment System Health P2.5: the daily alert run (plan Q "Движок: ежедневно").
--
-- Apply AFTER the functions are deployed: clickhouse-payment-health must
-- already accept the cron-only `alerts_tick` action (x-cron-secret = the shared
-- FB cron secret). The older function has no cron branch, so a tick reaches its
-- user branch with the anon key and is answered 401 invalid_session. And after
-- 202610130001 (guarded below): the tick writes payment_risk_alerts.
--
-- Once a day at 07:40 UTC -- after the 06:15 FunnelFox leads refresh and the
-- night's syncs, before the owner's day -- pg_cron calls
-- invoke_payment_alerts_tick(), which posts {auth_user_id: <workspace data key>,
-- action: 'alerts_tick'} to the function. The run itself is idempotent per data
-- window (alert_key = rule | scope | window_end) and the function skips a tick
-- that fires within a minute of another run, so a repeated or manual tick
-- (`select public.invoke_payment_alerts_tick();` from the SQL editor) is safe.
-- It returns the pg_net request id: read that response
-- (`net._http_response where id = <it>`), never "the newest row" -- other
-- cron jobs post through pg_net too.
--
-- Mirrors invoke_cohort_membership_tick (202610060002): same config row, same
-- headers, the workspace data key in the body (the Edge cron context rejects
-- any other tenant), the function URL derived from fb_cron_config.function_url.
-- Re-applying is safe: CREATE OR REPLACE and an unschedule + schedule of the
-- same job name, so exactly one job exists.

do $$
begin
  if to_regclass('public.payment_risk_alerts') is null
    or to_regprocedure('public.payment_alerts_apply_run(uuid, uuid, jsonb, jsonb, jsonb, date)') is null then
    raise exception using
      errcode = 'P0001',
      message = 'payment_health_alerts_cron: 202610130001_payment_health_alerts.sql has not been applied',
      hint = 'Apply 202610130001 first, deploy the functions, then this file (README "Payment health P2.5").';
  end if;
end
$$;

create or replace function public.invoke_payment_alerts_tick()
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
    raise notice 'fb_cron_config is empty — payment alerts tick skipped';
    return null;
  end if;
  if v_data_key is null then
    raise notice 'workspace is not bootstrapped — payment alerts tick skipped';
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
    url := replace(cfg.function_url, 'clickhouse-facebook', 'clickhouse-payment-health'),
    headers := req_headers,
    body := jsonb_build_object('auth_user_id', v_data_key, 'action', 'alerts_tick'),
    timeout_milliseconds := 150000
  ) into request_id;
  return request_id;
end;
$$;

-- pg_cron runs it as postgres; no API role may trigger a run through it.
revoke all on function public.invoke_payment_alerts_tick() from public, anon, authenticated, service_role;

do $$
begin
  perform cron.unschedule('payment-health-alerts');
exception when others then
  null;
end
$$;

select cron.schedule(
  'payment-health-alerts',
  '40 7 * * *',
  $$select public.invoke_payment_alerts_tick()$$
);
