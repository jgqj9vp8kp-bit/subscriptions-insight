create table if not exists public.clickhouse_cohort_snapshot_state (
  auth_user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  snapshot_name text not null default 'fact_user_cohorts',
  status text not null default 'never_started'
    check (status in ('never_started', 'building', 'completed', 'failed')),
  active_warehouse_version text,
  active_classification_version text,
  active_generated_at timestamptz,
  building_warehouse_version text,
  building_classification_version text,
  started_at timestamptz,
  finished_at timestamptz,
  duration_ms integer,
  users_classified bigint not null default 0,
  rows_inserted bigint not null default 0,
  duplicate_users bigint not null default 0,
  removed_or_invalidated bigint not null default 0,
  source_transactions bigint,
  source_unique_users bigint,
  last_error text,
  diagnostics jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (auth_user_id, snapshot_name)
);

create index if not exists clickhouse_cohort_snapshot_state_status_idx
on public.clickhouse_cohort_snapshot_state (auth_user_id, status, updated_at desc);

create or replace function public.set_clickhouse_cohort_snapshot_state_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists clickhouse_cohort_snapshot_state_set_updated_at on public.clickhouse_cohort_snapshot_state;
create trigger clickhouse_cohort_snapshot_state_set_updated_at
before update on public.clickhouse_cohort_snapshot_state
for each row
execute function public.set_clickhouse_cohort_snapshot_state_updated_at();

alter table public.clickhouse_cohort_snapshot_state enable row level security;

drop policy if exists "Users can read own ClickHouse cohort snapshot state" on public.clickhouse_cohort_snapshot_state;
create policy "Users can read own ClickHouse cohort snapshot state"
on public.clickhouse_cohort_snapshot_state
for select
using (auth.uid() = auth_user_id);

drop policy if exists "Users can insert own ClickHouse cohort snapshot state" on public.clickhouse_cohort_snapshot_state;
create policy "Users can insert own ClickHouse cohort snapshot state"
on public.clickhouse_cohort_snapshot_state
for insert
with check (auth.uid() = auth_user_id);

drop policy if exists "Users can update own ClickHouse cohort snapshot state" on public.clickhouse_cohort_snapshot_state;
create policy "Users can update own ClickHouse cohort snapshot state"
on public.clickhouse_cohort_snapshot_state
for update
using (auth.uid() = auth_user_id)
with check (auth.uid() = auth_user_id);

drop policy if exists "Users can delete own ClickHouse cohort snapshot state" on public.clickhouse_cohort_snapshot_state;
create policy "Users can delete own ClickHouse cohort snapshot state"
on public.clickhouse_cohort_snapshot_state
for delete
using (auth.uid() = auth_user_id);
