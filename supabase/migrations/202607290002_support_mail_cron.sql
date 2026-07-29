-- Hourly support-mail ingestion tick. The SpaceMail sync only ran when someone
-- pressed Sync on the Support page, so the inbox silently went stale (last
-- manual run 2026-07-27 stopped at UID 950 while the mailbox kept growing —
-- charts and cohort Support columns froze at July 22). The sync-support-mail
-- Edge Function already has a server-side entry (body.internal=true + the
-- x-support-mail-internal-secret header, owner resolved from sync state);
-- this migration gives it a pg_cron heartbeat, mirroring fb_daily_cron.
--
-- The secret lives in TWO places set at deploy time, never in git:
--   * Edge Function secret  SUPPORT_MAIL_SYNC_INTERNAL_SECRET
--   * support_mail_cron_config row (service-role only table)
--
-- One sync_new invocation imports at most 150 messages; a burst larger than
-- that simply drains over consecutive hourly ticks.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Single-row config. RLS enabled with no policies: only service_role /
-- SECURITY DEFINER functions can read it.
create table if not exists public.support_mail_cron_config (
  id boolean primary key default true check (id),
  cron_secret text not null,
  function_url text not null,
  updated_at timestamptz not null default now()
);

alter table public.support_mail_cron_config enable row level security;

create or replace function public.invoke_support_mail_cron()
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
  if not found then
    raise notice 'support_mail_cron_config is empty — support mail cron skipped';
    return null;
  end if;
  select net.http_post(
    url := cfg.function_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-support-mail-internal-secret', cfg.cron_secret
    ),
    body := jsonb_build_object('internal', true, 'action', 'sync_new'),
    timeout_milliseconds := 150000
  ) into request_id;
  return request_id;
end;
$$;

revoke all on function public.invoke_support_mail_cron() from public;
revoke all on function public.invoke_support_mail_cron() from anon;
revoke all on function public.invoke_support_mail_cron() from authenticated;

-- Reschedule idempotently (unschedule tolerates a missing job).
do $$
begin
  perform cron.unschedule('support-mail-sync-tick');
exception when others then
  null;
end
$$;

select cron.schedule(
  'support-mail-sync-tick',
  '7 * * * *', -- hourly at :07 — cheap (IMAP delta is usually a handful of mails)
  $$select public.invoke_support_mail_cron()$$
);
