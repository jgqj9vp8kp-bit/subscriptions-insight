-- Fix for the daily FB cron tick: the Edge gateway verifies a JWT BEFORE the
-- function body runs (observed live: pg_net POST -> 401
-- UNAUTHORIZED_NO_AUTH_HEADER, net._http_response id 1), so the x-cron-secret
-- branch was never reached. The public anon key satisfies the gateway; the
-- function still authenticates the actual work with FB_CRON_SECRET.

alter table public.fb_cron_config
  add column if not exists anon_key text not null default '';

create or replace function public.invoke_fb_daily_cron()
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  cfg public.fb_cron_config%rowtype;
  req_headers jsonb;
  request_id bigint;
begin
  select * into cfg from public.fb_cron_config where id = true;
  if not found then
    raise notice 'fb_cron_config is empty — daily FB cron skipped';
    return null;
  end if;
  req_headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'x-cron-secret', cfg.cron_secret
  );
  if cfg.anon_key != '' then
    req_headers := req_headers
      || jsonb_build_object('Authorization', 'Bearer ' || cfg.anon_key)
      || jsonb_build_object('apikey', cfg.anon_key);
  end if;
  select net.http_post(
    url := cfg.function_url,
    headers := req_headers,
    body := jsonb_build_object('auth_user_id', cfg.auth_user_id),
    timeout_milliseconds := 150000
  ) into request_id;
  return request_id;
end;
$$;

revoke all on function public.invoke_fb_daily_cron() from public;
revoke all on function public.invoke_fb_daily_cron() from anon;
revoke all on function public.invoke_fb_daily_cron() from authenticated;
