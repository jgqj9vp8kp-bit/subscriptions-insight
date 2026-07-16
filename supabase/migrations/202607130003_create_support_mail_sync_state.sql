create extension if not exists pgcrypto;

alter table public.support_import_batches
  add column if not exists source_type text not null default 'spreadsheet',
  add column if not exists source_label text;

alter table public.support_requests
  add column if not exists source_type text not null default 'spreadsheet',
  add column if not exists mailbox_key text,
  add column if not exists imap_folder text,
  add column if not exists imap_uid_validity text,
  add column if not exists imap_uid bigint,
  add column if not exists message_id text,
  add column if not exists normalized_message_id text,
  add column if not exists in_reply_to text,
  add column if not exists references_json jsonb not null default '[]'::jsonb,
  add column if not exists internal_date timestamptz,
  add column if not exists has_attachments boolean not null default false,
  add column if not exists attachment_count integer not null default 0,
  add column if not exists attachment_metadata jsonb not null default '[]'::jsonb,
  add column if not exists raw_size_bytes integer,
  add column if not exists imap_flags jsonb not null default '[]'::jsonb;

create unique index if not exists support_requests_auth_imap_uid_unique_idx
on public.support_requests (auth_user_id, mailbox_key, imap_folder, imap_uid_validity, imap_uid)
where source_type = 'imap'
  and mailbox_key is not null
  and imap_folder is not null
  and imap_uid_validity is not null
  and imap_uid is not null;

create unique index if not exists support_requests_auth_message_id_unique_idx
on public.support_requests (auth_user_id, normalized_message_id)
where normalized_message_id is not null and normalized_message_id <> '';

create index if not exists support_requests_auth_source_type_idx
on public.support_requests (auth_user_id, source_type);

create index if not exists support_requests_auth_mailbox_idx
on public.support_requests (auth_user_id, mailbox_key, imap_folder);

create table if not exists public.support_mail_sync_state (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  mailbox_key text not null,
  provider text not null default 'spacemail',
  host text not null,
  username text not null,
  folder text not null default 'INBOX',
  status text not null default 'idle',
  sync_mode text,
  uid_validity text,
  last_seen_uid bigint,
  highest_modseq text,
  messages_discovered integer not null default 0,
  messages_processed integer not null default 0,
  messages_inserted integer not null default 0,
  messages_updated integer not null default 0,
  messages_skipped integer not null default 0,
  messages_failed integer not null default 0,
  current_batch integer not null default 0,
  started_at timestamptz,
  completed_at timestamptz,
  last_success_at timestamptz,
  last_error_code text,
  last_error_message_sanitized text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint support_mail_sync_state_unique unique (auth_user_id, mailbox_key, folder),
  constraint support_mail_sync_state_status_check check (status in (
    'idle',
    'connecting',
    'discovering',
    'syncing',
    'partial',
    'completed',
    'failed',
    'stopped',
    'credentials_error',
    'cursor_invalidated'
  ))
);

create index if not exists support_mail_sync_state_auth_idx
on public.support_mail_sync_state (auth_user_id, updated_at desc);

create or replace function public.set_support_mail_sync_state_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists support_mail_sync_state_set_updated_at on public.support_mail_sync_state;
create trigger support_mail_sync_state_set_updated_at
before update on public.support_mail_sync_state
for each row
execute function public.set_support_mail_sync_state_updated_at();

alter table public.support_mail_sync_state enable row level security;

drop policy if exists "Users can read own support mail sync state" on public.support_mail_sync_state;
create policy "Users can read own support mail sync state"
on public.support_mail_sync_state for select
using (auth.uid() = auth_user_id);

drop policy if exists "Users can insert own support mail sync state" on public.support_mail_sync_state;
create policy "Users can insert own support mail sync state"
on public.support_mail_sync_state for insert
with check (auth.uid() = auth_user_id);

drop policy if exists "Users can update own support mail sync state" on public.support_mail_sync_state;
create policy "Users can update own support mail sync state"
on public.support_mail_sync_state for update
using (auth.uid() = auth_user_id)
with check (auth.uid() = auth_user_id);

drop policy if exists "Users can delete own support mail sync state" on public.support_mail_sync_state;
create policy "Users can delete own support mail sync state"
on public.support_mail_sync_state for delete
using (auth.uid() = auth_user_id);
