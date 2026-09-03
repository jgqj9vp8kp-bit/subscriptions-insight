-- Answered/unanswered support analytics: storage half.
--
-- 1) public.support_replies — headers of OUR outgoing mail from the SpaceMail
--    Sent folder. Deliberately NOT rows in support_requests: replies are not
--    requests, must never enter classification or request analytics, and only
--    their headers matter (threading + recipient + sent time). Bodies are not
--    stored — matching is header-only and BODY.PEEK[HEADER] keeps the full
--    retrospective backfill cheap.
-- 2) answered_* derived columns on public.support_requests, written by the
--    reply matcher (supportReplyMatching.ts). The existing BEFORE UPDATE
--    trigger bumps updated_at, so the ClickHouse keyset sync picks changed
--    rows up with no extra plumbing.
-- 3) support_apply_answer_matches RPC — one round trip applies a batch of
--    matcher outcomes (per-row PostgREST updates would be hundreds of calls
--    on the post-backfill full re-match).

create table if not exists public.support_replies (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  mailbox_key text not null,
  folder text not null,
  imap_uid_validity text not null,
  imap_uid bigint not null,
  message_id text not null,
  -- Unlike support_requests.normalized_message_id this is NEVER nulled on
  -- collision: duplicates across UIDVALIDITY re-imports are deduped by the
  -- matcher, not by dropping the join key.
  normalized_message_id text,
  in_reply_to text,                                  -- normalized (lowercase, no angle brackets)
  references_json jsonb not null default '[]'::jsonb, -- normalized ids
  from_email text,
  to_email text,                                     -- first To address (parseRawEmail contract)
  to_emails jsonb not null default '[]'::jsonb,      -- ALL normalized To + Cc addresses
  cc_email text,
  subject text,
  sent_at timestamptz,                               -- Date header, fallback INTERNALDATE
  internal_date timestamptz,
  raw_size_bytes integer,
  imap_flags jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  constraint support_replies_uid_unique unique (auth_user_id, mailbox_key, folder, imap_uid_validity, imap_uid)
);

create index if not exists support_replies_in_reply_to_idx
  on public.support_replies (auth_user_id, in_reply_to);
create index if not exists support_replies_references_gin
  on public.support_replies using gin (references_json);
create index if not exists support_replies_sent_at_idx
  on public.support_replies (auth_user_id, sent_at);
create index if not exists support_replies_message_id_idx
  on public.support_replies (auth_user_id, normalized_message_id);

alter table public.support_replies enable row level security;

drop policy if exists "Users can read own support replies" on public.support_replies;
create policy "Users can read own support replies"
  on public.support_replies for select
  using (auth.uid() = auth_user_id);
-- No insert/update/delete policies: writes are service-role only (the mail sync).

-- Derived answer state on requests. answer_source values:
--   'thread'         proven by In-Reply-To/References of a Sent reply (has answered_at)
--   'recipient'      Sent mail to the same customer after the request (has answered_at)
--   'imap_flag'      the INBOX message carries \Answered (no timestamp)
--   'customer_reply' the customer replied to OUR mail whose Sent copy is gone (no timestamp)
--   ''/null          no evidence of an answer
alter table public.support_requests
  add column if not exists answered_at timestamptz,
  add column if not exists answer_source text,
  add column if not exists answered_reply_id uuid references public.support_replies(id) on delete set null,
  add column if not exists reply_count integer not null default 0,
  add column if not exists answer_matched_at timestamptz;

create index if not exists support_requests_answer_source_idx
  on public.support_requests (auth_user_id, answer_source)
  where source_type = 'imap';

-- Batch-apply matcher outcomes in one statement. Runs under the service-role
-- edge client; the explicit auth_user_id predicate keeps it scoped even so.
create or replace function public.support_apply_answer_matches(
  p_auth_user_id uuid,
  p_matches jsonb
) returns integer
language sql
as $$
  with m as (
    select * from jsonb_to_recordset(p_matches)
      as x(id uuid, answered_at timestamptz, answer_source text, answered_reply_id uuid, reply_count integer)
  ), updated as (
    update public.support_requests r
    set answered_at = m.answered_at,
        answer_source = m.answer_source,
        answered_reply_id = m.answered_reply_id,
        reply_count = coalesce(m.reply_count, 0),
        answer_matched_at = now()
    from m
    where r.id = m.id and r.auth_user_id = p_auth_user_id
    returning r.id
  )
  select count(*)::integer from updated;
$$;
