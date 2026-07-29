-- Support classification v2: model-read classification stored in Postgres.
--
-- v1 classified with keyword lists and kept ONE category per email, which left
-- 60% of the archive in 'Other/unclear' and silently dropped the second intent
-- of the 324 emails that ask to cancel AND be refunded in one sentence. v2
-- classifies by meaning (Claude) and records a primary intent plus the other
-- intents the email expresses.
--
-- Additive only: no column is dropped or retyped, so rows classified by v1 keep
-- working until the backfill reaches them. manual_category/manual_subcategory/
-- manual_urgency are untouched — a human correction always outranks any engine.

alter table public.support_requests
  add column if not exists secondary_categories jsonb not null default '[]'::jsonb,
  add column if not exists classification_model text;

comment on column public.support_requests.secondary_categories is
  'Other intents the email also expresses, beyond the primary `category`. JSON array of category strings.';
comment on column public.support_requests.classification_model is
  'Model id that produced the classification (null for rule-based rows).';

-- The classification job scans for rows not yet on the current version. Without
-- this index that scan is a seq scan over the whole table on every tick.
create index if not exists support_requests_classification_version_idx
  on public.support_requests (auth_user_id, classification_version, received_at desc);

-- Resumable job state, one slot per user. Mirrors clickhouse_validation_state:
-- one Edge invocation processes a bounded chunk, saves its cursor, and returns
-- 'partial' so the client calls again — the run survives page reloads and the
-- Edge Function time limit.
create table if not exists public.support_classification_state (
  auth_user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  job_name text not null,
  status text not null default 'never_started'
    check (status in ('never_started', 'running', 'partial', 'completed', 'failed')),
  classification_version text,
  model text,
  -- Keyset cursor over (received_at, id): stable under concurrent inserts, and
  -- oldest-first so a partial run always leaves a contiguous classified tail.
  cursor_received_at timestamptz,
  cursor_request_id uuid,
  rows_scanned bigint not null default 0,
  rows_classified bigint not null default 0,
  rows_failed bigint not null default 0,
  rows_expected bigint,
  batches_processed integer not null default 0,
  api_requests integer not null default 0,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  stopped_reason text
    check (stopped_reason is null or stopped_reason in (
      'chunk_complete', 'soft_timeout', 'max_batches_reached',
      'api_error', 'source_error', 'no_api_key', 'completed', 'stopped', 'unknown')),
  last_error text,
  created_at timestamptz not null default now(),
  primary key (auth_user_id, job_name)
);

create or replace function public.set_support_classification_state_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists support_classification_state_set_updated_at on public.support_classification_state;
create trigger support_classification_state_set_updated_at
before update on public.support_classification_state
for each row
execute function public.set_support_classification_state_updated_at();

alter table public.support_classification_state enable row level security;

drop policy if exists "Users can read own support classification state" on public.support_classification_state;
create policy "Users can read own support classification state"
on public.support_classification_state
for select
using (auth.uid() = auth_user_id);

drop policy if exists "Users can insert own support classification state" on public.support_classification_state;
create policy "Users can insert own support classification state"
on public.support_classification_state
for insert
with check (auth.uid() = auth_user_id);

drop policy if exists "Users can update own support classification state" on public.support_classification_state;
create policy "Users can update own support classification state"
on public.support_classification_state
for update
using (auth.uid() = auth_user_id)
with check (auth.uid() = auth_user_id);

drop policy if exists "Users can delete own support classification state" on public.support_classification_state;
create policy "Users can delete own support classification state"
on public.support_classification_state
for delete
using (auth.uid() = auth_user_id);
