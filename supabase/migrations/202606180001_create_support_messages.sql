create extension if not exists pgcrypto;

create table if not exists public.support_messages (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  message_id text not null,
  thread_id text,
  mailbox text not null default 'support@azora-astro.com',
  folder text not null default 'INBOX',
  from_email text,
  from_name text,
  to_email text,
  subject text,
  body_text text,
  body_html text,
  received_at timestamptz,
  synced_at timestamptz not null default now(),
  detected_intent text not null default 'unknown',
  matched_user_email text,
  matched_user_id text,
  cohort_id text,
  cohort_date date,
  campaign_path text,
  campaign_id text,
  media_buyer text,
  country_code text,
  card_type text,
  subscription_status text,
  refund_status text,
  amount_paid numeric(18,2),
  amount_refunded numeric(18,2),
  raw_headers jsonb not null default '{}'::jsonb,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint support_messages_intent_check check (
    detected_intent in (
      'refund_request',
      'cancel_subscription',
      'payment_problem',
      'access_problem',
      'general_support',
      'unknown'
    )
  ),
  constraint support_messages_user_message_unique unique (auth_user_id, message_id)
);

create index if not exists support_messages_auth_user_id_idx on public.support_messages (auth_user_id);
create index if not exists support_messages_received_at_idx on public.support_messages (received_at desc);
create index if not exists support_messages_from_email_idx on public.support_messages (from_email);
create index if not exists support_messages_detected_intent_idx on public.support_messages (detected_intent);
create index if not exists support_messages_campaign_path_idx on public.support_messages (campaign_path);
create index if not exists support_messages_campaign_id_idx on public.support_messages (campaign_id);
create index if not exists support_messages_media_buyer_idx on public.support_messages (media_buyer);
create index if not exists support_messages_country_code_idx on public.support_messages (country_code);
create index if not exists support_messages_card_type_idx on public.support_messages (card_type);

create or replace function public.set_support_messages_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists support_messages_set_updated_at on public.support_messages;
create trigger support_messages_set_updated_at
before update on public.support_messages
for each row
execute function public.set_support_messages_updated_at();

alter table public.support_messages enable row level security;

drop policy if exists "Users can read own support messages" on public.support_messages;
create policy "Users can read own support messages"
on public.support_messages
for select
using (auth.uid() = auth_user_id);

drop policy if exists "Users can insert own support messages" on public.support_messages;
create policy "Users can insert own support messages"
on public.support_messages
for insert
with check (auth.uid() = auth_user_id);

drop policy if exists "Users can update own support messages" on public.support_messages;
create policy "Users can update own support messages"
on public.support_messages
for update
using (auth.uid() = auth_user_id)
with check (auth.uid() = auth_user_id);

drop policy if exists "Users can delete own support messages" on public.support_messages;
create policy "Users can delete own support messages"
on public.support_messages
for delete
using (auth.uid() = auth_user_id);
