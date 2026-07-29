-- Hourly classification tick.
--
-- Without it, classification only runs when someone opens the Support page and
-- presses the button, so every email arriving in between sits on the keyword
-- rules — which is the very thing this work exists to replace. The mail sync
-- already has an hourly tick; this one runs half an hour offset from it so new
-- mail is imported first and classified right after.
--
-- Reuses the support pipeline's existing shared secret
-- (SUPPORT_MAIL_SYNC_INTERNAL_SECRET + support_mail_cron_config.cron_secret) —
-- one secret for one pipeline, nothing new to configure.
--
-- One invocation is bounded by the job itself (batches × batch size), and a
-- rejected API key stops it after a single request, so an unattended tick
-- cannot run away with cost.

alter table public.support_mail_cron_config
  add column if not exists classify_function_url text;

comment on column public.support_mail_cron_config.classify_function_url is
  'Endpoint of the classify-support-requests Edge Function used by the hourly classification tick.';

create or replace function public.invoke_support_classification_cron()
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  cfg public.support_mail_cron_config%rowtype;
  request_id bigint;
begin
  select * into cfg from public.support_mail_cron_config where id = true;
  if not found or coalesce(cfg.classify_function_url, '') = '' then
    raise notice 'support classification cron is not configured — skipped';
    return null;
  end if;
  select net.http_post(
    url := cfg.classify_function_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-support-mail-internal-secret', cfg.cron_secret
    ),
    -- "continue" resumes an interrupted backfill; on a fresh cursor the job
    -- starts from the oldest unclassified email either way.
    body := jsonb_build_object('internal', true, 'action', 'continue'),
    timeout_milliseconds := 150000
  ) into request_id;
  return request_id;
end;
$$;

revoke all on function public.invoke_support_classification_cron() from public;
revoke all on function public.invoke_support_classification_cron() from anon;
revoke all on function public.invoke_support_classification_cron() from authenticated;

do $$
begin
  perform cron.unschedule('support-classification-tick');
exception when others then
  null;
end
$$;

select cron.schedule(
  'support-classification-tick',
  '37 * * * *', -- 30 minutes after the mail tick at :07
  $$select public.invoke_support_classification_cron()$$
);
