-- Self-terminating Sent-folder backfill driver (answered analytics rollout).
--
-- The Sent history import is resumable at 150 headers per invocation; instead
-- of a human pressing "Import Sent History" twenty times, a minutely pg_cron
-- job drives it: while the Sent state row has no history_completed_at it sends
-- sent_initial_sync / sent_continue_sync, once complete it fires ONE
-- rematch_replies {"mode":"full"} and unschedules itself. The edge function's
-- own already-running guard makes overlapping ticks harmless.
--
-- Mirrors invoke_support_mail_cron: the secret comes from
-- support_mail_cron_config (service-role only) and never leaves the database.

create or replace function public.invoke_support_sent_backfill_tick()
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  cfg public.support_mail_cron_config%rowtype;
  sent_state record;
  next_action text;
  request_id bigint;
begin
  select * into cfg from public.support_mail_cron_config where id = true;
  if not found then
    raise notice 'support_mail_cron_config is empty — sent backfill tick skipped';
    return null;
  end if;

  -- The Sent folder gets its own sync-state row; INBOX keeps folder 'INBOX'.
  select * into sent_state
  from public.support_mail_sync_state
  where folder <> 'INBOX'
  order by updated_at desc
  limit 1;

  if sent_state is null then
    next_action := 'sent_initial_sync';
  elsif sent_state.history_completed_at is null then
    next_action := case when sent_state.status = 'cursor_invalidated' then 'sent_initial_sync' else 'sent_continue_sync' end;
  else
    -- Backfill done: one full re-match (upgrades every request the Sent
    -- history can prove), then this job retires. The hourly sync_new tick owns
    -- everything incremental from here on.
    next_action := 'rematch_replies';
    perform cron.unschedule('support-sent-backfill-tick');
  end if;

  select net.http_post(
    url := cfg.function_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-support-mail-internal-secret', cfg.cron_secret
    ),
    body := case when next_action = 'rematch_replies'
      then jsonb_build_object('internal', true, 'action', next_action, 'mode', 'full')
      else jsonb_build_object('internal', true, 'action', next_action)
    end,
    timeout_milliseconds := 150000
  ) into request_id;
  return request_id;
end;
$$;

revoke all on function public.invoke_support_sent_backfill_tick() from public;
revoke all on function public.invoke_support_sent_backfill_tick() from anon;
revoke all on function public.invoke_support_sent_backfill_tick() from authenticated;

select cron.unschedule('support-sent-backfill-tick')
where exists (select 1 from cron.job where jobname = 'support-sent-backfill-tick');

select cron.schedule(
  'support-sent-backfill-tick',
  '* * * * *',
  $$select public.invoke_support_sent_backfill_tick()$$
);
