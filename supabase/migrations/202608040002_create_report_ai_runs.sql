-- Reports R9: the generation log.
--
-- The support classifier has no equivalent, and that is a gap this project has
-- already felt: when a classification looked wrong there was no way to answer
-- "which model, which prompt version, and what did it cost". A report carries
-- management decisions, so every generation is recorded — including the ones
-- that were rejected by validation, which are the interesting ones.
--
-- Append-only in spirit but not enforced by a trigger: unlike report_versions
-- this is diagnostics, not the published artefact, and an operator clearing an
-- old log costs nothing. Hence a delete policy exists here and does not there.
create table if not exists public.report_ai_runs (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  -- Plain uuid, no FK: a run must survive its report being archived, and a
  -- cascade is not wanted here for the same reason report_tasks avoids one.
  report_id uuid,
  block_id text,
  provider text not null default 'anthropic',
  model text not null,
  prompt_version text not null,
  action text not null default 'generate'
    check (action in ('generate', 'regenerate_block')),
  input_tokens integer,
  output_tokens integer,
  estimated_cost_usd numeric,
  duration_ms integer,
  status text not null
    check (status in ('ok', 'validation_failed', 'error', 'cancelled')),
  -- The violations the validator raised, verbatim. This is what makes a
  -- rejected generation explainable a week later.
  validation jsonb not null default '{}'::jsonb,
  error text,
  created_at timestamptz not null default now()
);

create index if not exists report_ai_runs_user_created_idx
  on public.report_ai_runs (auth_user_id, created_at desc);

create index if not exists report_ai_runs_report_idx
  on public.report_ai_runs (report_id, created_at desc);

alter table public.report_ai_runs enable row level security;

drop policy if exists "Users can read own report ai runs" on public.report_ai_runs;
create policy "Users can read own report ai runs"
on public.report_ai_runs for select using (auth.uid() = auth_user_id);

drop policy if exists "Users can insert own report ai runs" on public.report_ai_runs;
create policy "Users can insert own report ai runs"
on public.report_ai_runs for insert with check (auth.uid() = auth_user_id);

drop policy if exists "Users can delete own report ai runs" on public.report_ai_runs;
create policy "Users can delete own report ai runs"
on public.report_ai_runs for delete using (auth.uid() = auth_user_id);
