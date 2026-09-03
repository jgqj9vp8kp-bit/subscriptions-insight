-- One-shot: re-run the FULL reply match after the matcher switched to the
-- address grain (any Sent mail to the customer's address answers their
-- requests; the 14-day recipient window is gone, and a 'contact' tier marks
-- people we wrote to before their message). Same internal-secret pattern as
-- invoke_support_mail_cron; pg_net is async, verification follows separately.

do $$
declare
  cfg public.support_mail_cron_config%rowtype;
begin
  select * into cfg from public.support_mail_cron_config where id = true;
  if not found then
    raise notice 'support_mail_cron_config is empty — rematch skipped';
    return;
  end if;
  perform net.http_post(
    url := cfg.function_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-support-mail-internal-secret', cfg.cron_secret
    ),
    body := jsonb_build_object('internal', true, 'action', 'rematch_replies', 'mode', 'full'),
    timeout_milliseconds := 150000
  );
  raise notice 'full rematch dispatched';
end;
$$;
