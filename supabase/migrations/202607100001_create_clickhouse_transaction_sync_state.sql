create table if not exists public.clickhouse_transaction_sync_state (
  auth_user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  sync_name text not null,
  status text not null default 'never_started'
    check (status in ('never_started', 'running', 'partial', 'completed', 'completed_with_inconsistencies', 'failed')),
  current_stage text,
  stopped_reason text
    check (stopped_reason is null or stopped_reason in ('completed', 'max_batches_reached', 'soft_timeout', 'source_error', 'clickhouse_error', 'mapping_error', 'unknown')),
  cursor_updated_at timestamptz,
  cursor_transaction_id text,
  started_at timestamptz,
  finished_at timestamptz,
  duration_ms integer,
  rows_scanned bigint not null default 0,
  rows_mapped bigint not null default 0,
  rows_inserted bigint not null default 0,
  rows_skipped bigint not null default 0,
  batches_processed integer not null default 0,
  last_error text,
  last_run_mode text check (last_run_mode is null or last_run_mode in ('continue', 'full_backfill', 'validate_only')),
  source_total bigint,
  clickhouse_total bigint,
  parity_status text,
  diagnostics jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (auth_user_id, sync_name)
);

create index if not exists clickhouse_transaction_sync_state_status_idx
on public.clickhouse_transaction_sync_state (auth_user_id, status, updated_at desc);

create or replace function public.set_clickhouse_transaction_sync_state_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists clickhouse_transaction_sync_state_set_updated_at on public.clickhouse_transaction_sync_state;
create trigger clickhouse_transaction_sync_state_set_updated_at
before update on public.clickhouse_transaction_sync_state
for each row
execute function public.set_clickhouse_transaction_sync_state_updated_at();

alter table public.clickhouse_transaction_sync_state enable row level security;

drop policy if exists "Users can read own ClickHouse sync state" on public.clickhouse_transaction_sync_state;
create policy "Users can read own ClickHouse sync state"
on public.clickhouse_transaction_sync_state
for select
using (auth.uid() = auth_user_id);

drop policy if exists "Users can insert own ClickHouse sync state" on public.clickhouse_transaction_sync_state;
create policy "Users can insert own ClickHouse sync state"
on public.clickhouse_transaction_sync_state
for insert
with check (auth.uid() = auth_user_id);

drop policy if exists "Users can update own ClickHouse sync state" on public.clickhouse_transaction_sync_state;
create policy "Users can update own ClickHouse sync state"
on public.clickhouse_transaction_sync_state
for update
using (auth.uid() = auth_user_id)
with check (auth.uid() = auth_user_id);

drop policy if exists "Users can delete own ClickHouse sync state" on public.clickhouse_transaction_sync_state;
create policy "Users can delete own ClickHouse sync state"
on public.clickhouse_transaction_sync_state
for delete
using (auth.uid() = auth_user_id);
