-- Read-only verification snapshot of the answered-analytics rollout
-- (2026-09-03). Emits NOTICEs during db push; changes nothing. Kept in the
-- migration history as the rollout's acceptance record.

do $$
declare
  replies_count bigint;
  sent_state record;
  tick_job_count bigint;
  src record;
  answered_total bigint := 0;
  unanswered bigint;
  matched_pending bigint;
  median_minutes numeric;
begin
  select count(*) into replies_count from public.support_replies;
  raise notice 'support_replies: % rows', replies_count;

  select status, history_total_messages, history_imported_messages, history_completed_at, folder
    into sent_state
  from public.support_mail_sync_state
  where folder <> 'INBOX'
  order by updated_at desc
  limit 1;
  raise notice 'sent state: folder=% status=% imported=%/% completed_at=%',
    sent_state.folder, sent_state.status, sent_state.history_imported_messages,
    sent_state.history_total_messages, sent_state.history_completed_at;

  select count(*) into tick_job_count from cron.job where jobname = 'support-sent-backfill-tick';
  raise notice 'backfill tick job still scheduled: % (0 = retired itself)', tick_job_count;

  for src in
    select coalesce(nullif(answer_source, ''), '(unanswered)') as source, count(*) as requests
    from public.support_requests
    where source_type = 'imap'
    group by 1
    order by 2 desc
  loop
    raise notice 'answer_source %: %', src.source, src.requests;
    if src.source <> '(unanswered)' then
      answered_total := answered_total + src.requests;
    end if;
  end loop;

  select count(*) into unanswered
  from public.support_requests
  where source_type = 'imap' and coalesce(answer_source, '') = '';

  select percentile_cont(0.5) within group (order by extract(epoch from (answered_at - received_at)) / 60)
    into median_minutes
  from public.support_requests
  where source_type = 'imap' and answered_at is not null;
  raise notice 'answered=% unanswered=% median_first_response_minutes=%',
    answered_total, unanswered, round(coalesce(median_minutes, -1));

  select count(*) into matched_pending
  from public.support_requests
  where source_type = 'imap' and answer_matched_at is null;
  raise notice 'requests never seen by the matcher: %', matched_pending;
end;
$$;
