alter table public.support_mail_sync_state
  add column if not exists mailbox_messages integer not null default 0,
  add column if not exists mailbox_uid_next bigint,
  add column if not exists history_first_uid bigint,
  add column if not exists history_last_uid bigint,
  add column if not exists history_total_messages integer not null default 0,
  add column if not exists history_imported_messages integer not null default 0,
  add column if not exists history_remaining_messages integer not null default 0,
  add column if not exists history_completed_at timestamptz,
  add column if not exists current_uid bigint,
  add column if not exists last_imported_uid bigint,
  add column if not exists current_batch_total integer not null default 0,
  add column if not exists current_batch_processed integer not null default 0,
  add column if not exists current_batch_started_at timestamptz,
  add column if not exists last_batch_duration_ms integer,
  add column if not exists last_batch_messages_per_second numeric not null default 0,
  add column if not exists last_sync_imported integer not null default 0,
  add column if not exists last_sync_new_messages integer not null default 0;

create index if not exists support_mail_sync_state_history_idx
on public.support_mail_sync_state (auth_user_id, mailbox_key, folder, history_completed_at);
