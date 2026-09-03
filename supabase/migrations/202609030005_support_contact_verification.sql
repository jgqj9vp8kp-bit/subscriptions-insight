-- Read-only acceptance snapshot of the contact-grain answered analytics
-- (2026-09-03). Mirrors 202609030003 but at the address grain: 1 unit = 1
-- unique customer address; answered = any Sent mail to that address.

do $$
declare
  src record;
  contacts bigint;
  answered_contacts bigint;
  unanswered_contacts bigint;
  median_minutes numeric;
begin
  for src in
    select coalesce(nullif(answer_source, ''), '(unanswered)') as source, count(*) as messages,
           count(distinct coalesce(nullif(normalized_email, ''), sender_name)) as addresses
    from public.support_requests
    where source_type = 'imap'
    group by 1
    order by 2 desc
  loop
    raise notice 'answer_source %: % messages / % addresses', src.source, src.messages, src.addresses;
  end loop;

  select count(distinct coalesce(nullif(normalized_email, ''), sender_name)),
         count(distinct coalesce(nullif(normalized_email, ''), sender_name)) filter (where coalesce(answer_source, '') <> ''),
         count(distinct coalesce(nullif(normalized_email, ''), sender_name)) filter (where coalesce(answer_source, '') = '')
    into contacts, answered_contacts, unanswered_contacts
  from public.support_requests
  where source_type = 'imap';
  raise notice 'contacts total=% answered=% with_zero_outgoing=%', contacts, answered_contacts, unanswered_contacts;

  select percentile_cont(0.5) within group (order by extract(epoch from (answered_at - received_at)) / 60)
    into median_minutes
  from public.support_requests
  where source_type = 'imap' and answered_at is not null;
  raise notice 'median_first_response_minutes=%', round(coalesce(median_minutes, -1));
end;
$$;
