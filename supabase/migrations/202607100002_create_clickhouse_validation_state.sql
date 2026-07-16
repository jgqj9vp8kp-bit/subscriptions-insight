-- Additive: resumable, staged ClickHouse validation progress. Does NOT touch
-- clickhouse_transaction_sync_state, the transactions table, or any analytics.
create table if not exists public.clickhouse_validation_state (
  auth_user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  validation_name text not null,
  status text not null default 'never_started'
    check (status in ('never_started', 'running', 'partial', 'completed', 'failed')),
  stage text
    check (stage is null or stage in ('initialize', 'source_scan', 'finalize', 'done')),
  validation_scope text,
  validation_run text,
  lower_cursor_updated_at timestamptz,
  lower_cursor_transaction_id text,
  upper_cursor_updated_at timestamptz,
  upper_cursor_transaction_id text,
  current_cursor_updated_at timestamptz,
  current_cursor_transaction_id text,
  rows_processed bigint not null default 0,
  pages_processed integer not null default 0,
  source_rows_expected bigint,
  source_aggregates jsonb not null default '{}'::jsonb,
  source_id_chunk_count integer not null default 0,
  clickhouse_aggregates jsonb not null default '{}'::jsonb,
  missing_ids_count bigint,
  extra_ids_count bigint,
  duplicate_ids_count bigint,
  gross_difference numeric,
  net_difference numeric,
  refund_difference numeric,
  parity_status text,
  started_at timestamptz,
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  stopped_reason text
    check (stopped_reason is null or stopped_reason in (
      'chunk_complete', 'soft_timeout', 'max_pages_reached',
      'source_error', 'clickhouse_error', 'completed', 'unknown')),
  last_error text,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  primary key (auth_user_id, validation_name)
);

create index if not exists clickhouse_validation_state_status_idx
on public.clickhouse_validation_state (auth_user_id, status, updated_at desc);

create or replace function public.set_clickhouse_validation_state_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists clickhouse_validation_state_set_updated_at on public.clickhouse_validation_state;
create trigger clickhouse_validation_state_set_updated_at
before update on public.clickhouse_validation_state
for each row
execute function public.set_clickhouse_validation_state_updated_at();

alter table public.clickhouse_validation_state enable row level security;

drop policy if exists "Users can read own ClickHouse validation state" on public.clickhouse_validation_state;
create policy "Users can read own ClickHouse validation state"
on public.clickhouse_validation_state
for select
using (auth.uid() = auth_user_id);

drop policy if exists "Users can insert own ClickHouse validation state" on public.clickhouse_validation_state;
create policy "Users can insert own ClickHouse validation state"
on public.clickhouse_validation_state
for insert
with check (auth.uid() = auth_user_id);

drop policy if exists "Users can update own ClickHouse validation state" on public.clickhouse_validation_state;
create policy "Users can update own ClickHouse validation state"
on public.clickhouse_validation_state
for update
using (auth.uid() = auth_user_id)
with check (auth.uid() = auth_user_id);

drop policy if exists "Users can delete own ClickHouse validation state" on public.clickhouse_validation_state;
create policy "Users can delete own ClickHouse validation state"
on public.clickhouse_validation_state
for delete
using (auth.uid() = auth_user_id);
