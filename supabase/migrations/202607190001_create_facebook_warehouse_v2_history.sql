-- Facebook Warehouse V2 — Phase 1: append-only import history.
--
-- Observability layer ONLY. The active sync pipeline keeps writing
-- fact_facebook_stats (ClickHouse) and clickhouse_transaction_sync_state
-- exactly as before; these tables just make every sync/import permanent.
-- Nothing here is read by Cohorts, allocation, reconciliation or mapping.
--
-- Write order (by design, so no FK can invert it):
--   1. facebook_import_batches  — staged row, at sync start
--   2. facebook_raw_payloads    — one row per Capsuled API response, during fetch
--   3. facebook_batch_dq        — one row per batch, after validation
--   4. facebook_sync_runs       — one immutable row per run, at sync end
-- The run row is a completion EVENT (never a mutable state), which is why
-- batches carry run_id without a foreign key: the run row does not exist yet
-- while the batch is being written. Lineage integrity is enforced by the
-- recorder generating both UUIDs up front.

-- 1) facebook_sync_runs — one immutable row per sync run (success or failure).
--    Append-only: the trigger below rejects UPDATE and DELETE for every role.
create table if not exists public.facebook_sync_runs (
  run_id uuid primary key,
  auth_user_id uuid not null,
  started_at timestamptz not null,
  finished_at timestamptz not null,
  status text not null check (status in ('completed', 'failed')),
  -- Spec field name is "trigger"; named trigger_source to avoid the SQL keyword.
  trigger_source text not null default 'manual'
    check (trigger_source in ('manual', 'cron', 'backfill', 'migration')),
  mode text not null check (mode in ('incremental', 'full')),
  window_from date,
  window_to date,
  levels text[] not null default '{}'::text[],
  api_requests integer not null default 0,
  api_failures integer not null default 0,
  rows_received bigint not null default 0,
  rows_inserted bigint not null default 0,
  rows_updated bigint not null default 0,
  rows_skipped bigint not null default 0,
  duration_ms integer,
  error_message text,
  raw_response_metadata jsonb not null default '{}'::jsonb,
  warehouse_version text not null,
  batch_id uuid,
  created_at timestamptz not null default now()
);

create index if not exists facebook_sync_runs_user_started_idx
  on public.facebook_sync_runs (auth_user_id, started_at desc);
create index if not exists facebook_sync_runs_version_idx
  on public.facebook_sync_runs (auth_user_id, warehouse_version);

-- 2) facebook_import_batches — one row per import batch. The ONLY mutable
--    piece is the status state machine (staged → validated → published →
--    rolled_back) plus its write-once timestamps/checksum/notes. Rollback is a
--    status change — rows are NEVER deleted.
create table if not exists public.facebook_import_batches (
  batch_id uuid primary key,
  run_id uuid not null,
  auth_user_id uuid not null,
  status text not null default 'staged'
    check (status in ('staged', 'validated', 'published', 'rolled_back')),
  source text not null default 'capsuled_fb_stats',
  notes text,
  -- warehouse_version: assigned at staging time, BEFORE publish (spec §5).
  version text not null,
  checksum text,
  created_at timestamptz not null default now(),
  validated_at timestamptz,
  published_at timestamptz,
  rolled_back_at timestamptz
);

create index if not exists facebook_import_batches_user_created_idx
  on public.facebook_import_batches (auth_user_id, created_at desc);
create index if not exists facebook_import_batches_run_idx
  on public.facebook_import_batches (run_id);
create index if not exists facebook_import_batches_version_idx
  on public.facebook_import_batches (auth_user_id, version);

-- 3) facebook_raw_payloads — verbatim Capsuled API envelope per request.
--    Not normalized, not truncated. Append-only. This is the layer whose
--    absence made the 2026-05-08..2026-06-14 gap unrecoverable.
create table if not exists public.facebook_raw_payloads (
  payload_id uuid primary key default gen_random_uuid(),
  batch_id uuid not null,
  auth_user_id uuid not null,
  entity_level text not null
    check (entity_level in ('account', 'campaign', 'adset', 'ad', 'day')),
  -- 1-based request sequence within (batch_id, entity_level).
  page integer not null,
  request_date_from date,
  request_date_to date,
  http_ok boolean not null default true,
  payload_json jsonb not null,
  payload_bytes integer not null default 0,
  api_latency_ms integer not null default 0,
  received_at timestamptz not null default now()
);

create index if not exists facebook_raw_payloads_batch_idx
  on public.facebook_raw_payloads (batch_id, entity_level, page);
create index if not exists facebook_raw_payloads_user_received_idx
  on public.facebook_raw_payloads (auth_user_id, received_at desc);

-- 4) facebook_batch_dq — automatic data-quality report per batch. Append-only.
create table if not exists public.facebook_batch_dq (
  dq_id uuid primary key default gen_random_uuid(),
  batch_id uuid not null,
  run_id uuid not null,
  auth_user_id uuid not null,
  campaign_count integer not null default 0,
  account_count integer not null default 0,
  expected_days integer not null default 0,
  covered_days integer not null default 0,
  coverage_pct numeric,
  duplicate_keys integer not null default 0,
  duplicate_key_samples jsonb not null default '[]'::jsonb,
  missing_dates jsonb not null default '[]'::jsonb,
  spend_total numeric not null default 0,
  purchases_total numeric not null default 0,
  spend_by_level jsonb not null default '{}'::jsonb,
  computed_at timestamptz not null default now()
);

create index if not exists facebook_batch_dq_batch_idx
  on public.facebook_batch_dq (batch_id);
create index if not exists facebook_batch_dq_user_computed_idx
  on public.facebook_batch_dq (auth_user_id, computed_at desc);

-- ---- Append-only enforcement (applies to EVERY role, service_role included) --

create or replace function public.facebook_history_block_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception '% is append-only: % is not allowed', tg_table_name, tg_op;
end;
$$;

drop trigger if exists facebook_sync_runs_append_only on public.facebook_sync_runs;
create trigger facebook_sync_runs_append_only
before update or delete on public.facebook_sync_runs
for each row execute function public.facebook_history_block_mutation();

drop trigger if exists facebook_raw_payloads_append_only on public.facebook_raw_payloads;
create trigger facebook_raw_payloads_append_only
before update or delete on public.facebook_raw_payloads
for each row execute function public.facebook_history_block_mutation();

drop trigger if exists facebook_batch_dq_append_only on public.facebook_batch_dq;
create trigger facebook_batch_dq_append_only
before update or delete on public.facebook_batch_dq
for each row execute function public.facebook_history_block_mutation();

-- Batches: DELETE is never allowed; UPDATE may only advance the status state
-- machine and fill write-once fields. Identity/lineage columns are immutable.
create or replace function public.facebook_import_batches_guard()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'facebook_import_batches is delete-protected: rollback is a status change, not a DELETE';
  end if;
  if new.batch_id is distinct from old.batch_id
    or new.run_id is distinct from old.run_id
    or new.auth_user_id is distinct from old.auth_user_id
    or new.source is distinct from old.source
    or new.version is distinct from old.version
    or new.created_at is distinct from old.created_at then
    raise exception 'facebook_import_batches identity columns are immutable';
  end if;
  if old.checksum is not null and new.checksum is distinct from old.checksum then
    raise exception 'facebook_import_batches.checksum is write-once';
  end if;
  if old.validated_at is not null and new.validated_at is distinct from old.validated_at then
    raise exception 'facebook_import_batches.validated_at is write-once';
  end if;
  if old.published_at is not null and new.published_at is distinct from old.published_at then
    raise exception 'facebook_import_batches.published_at is write-once';
  end if;
  if old.rolled_back_at is not null and new.rolled_back_at is distinct from old.rolled_back_at then
    raise exception 'facebook_import_batches.rolled_back_at is write-once';
  end if;
  if new.status is distinct from old.status then
    if not (
      (old.status = 'staged' and new.status in ('validated', 'rolled_back'))
      or (old.status = 'validated' and new.status in ('published', 'rolled_back'))
      or (old.status = 'published' and new.status = 'rolled_back')
    ) then
      raise exception 'illegal facebook_import_batches status transition: % -> %', old.status, new.status;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists facebook_import_batches_guard on public.facebook_import_batches;
create trigger facebook_import_batches_guard
before update or delete on public.facebook_import_batches
for each row execute function public.facebook_import_batches_guard();

-- ---- RLS: clients may only READ their own history. All writes go through the
-- Edge Function (service role), and even service role cannot UPDATE/DELETE the
-- append-only tables thanks to the triggers above. No insert/update/delete
-- policies exist on purpose.

alter table public.facebook_sync_runs enable row level security;
alter table public.facebook_import_batches enable row level security;
alter table public.facebook_raw_payloads enable row level security;
alter table public.facebook_batch_dq enable row level security;

drop policy if exists "Users can read own facebook sync runs" on public.facebook_sync_runs;
create policy "Users can read own facebook sync runs"
on public.facebook_sync_runs
for select
using (auth.uid() = auth_user_id);

drop policy if exists "Users can read own facebook import batches" on public.facebook_import_batches;
create policy "Users can read own facebook import batches"
on public.facebook_import_batches
for select
using (auth.uid() = auth_user_id);

drop policy if exists "Users can read own facebook raw payloads" on public.facebook_raw_payloads;
create policy "Users can read own facebook raw payloads"
on public.facebook_raw_payloads
for select
using (auth.uid() = auth_user_id);

drop policy if exists "Users can read own facebook batch dq" on public.facebook_batch_dq;
create policy "Users can read own facebook batch dq"
on public.facebook_batch_dq
for select
using (auth.uid() = auth_user_id);
