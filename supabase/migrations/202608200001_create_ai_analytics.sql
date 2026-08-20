-- AI Analytics layer storage (assistant runs, recommendation history, feedback).
--
-- Three small tables behind the deterministic AI layer (aiSignals engine +
-- ai-analytics edge function). Shapes follow the established precedents:
--   ai_assistant_runs   -> report_ai_runs (202608040002): cost/validation audit
--                          trail, delete allowed (diagnostics, not an artefact);
--   ai_recommendations  -> report_versions (202608040001): append-only history
--                          with a mutation-guard trigger, select+insert only;
--   ai_feedback         -> report_ai_runs: plain-uuid reference, no FK.

-- 1) Assistant run log: one row per model call, whatever the outcome.
create table if not exists public.ai_assistant_runs (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  surface text not null default 'global',
  provider text not null default 'anthropic',
  model text not null,
  prompt_version text not null,
  question_chars integer,
  input_tokens integer,
  output_tokens integer,
  estimated_cost_usd numeric,
  duration_ms integer,
  status text not null check (status in ('ok', 'validation_failed', 'error', 'cancelled')),
  validation jsonb not null default '{}'::jsonb,
  error text,
  created_at timestamptz not null default now()
);

create index if not exists ai_assistant_runs_user_created_idx
  on public.ai_assistant_runs (auth_user_id, created_at desc);

alter table public.ai_assistant_runs enable row level security;

drop policy if exists "Users can view own ai assistant runs" on public.ai_assistant_runs;
create policy "Users can view own ai assistant runs" on public.ai_assistant_runs
  for select using (auth.uid() = auth_user_id);

drop policy if exists "Users can insert own ai assistant runs" on public.ai_assistant_runs;
create policy "Users can insert own ai assistant runs" on public.ai_assistant_runs
  for insert with check (auth.uid() = auth_user_id);

drop policy if exists "Users can delete own ai assistant runs" on public.ai_assistant_runs;
create policy "Users can delete own ai assistant runs" on public.ai_assistant_runs
  for delete using (auth.uid() = auth_user_id);

-- 2) Recommendation history: append-only snapshots per (surface, context).
--    Written when the engine output for a context differs from the last stored
--    snapshot; powers the future "recommendation history" view (brief §18).
--    auth_user_id carries NO cascading FK on purpose — the mutation guard
--    below would abort an account deletion mid-cascade (report_versions
--    precedent, documented there as load-bearing).
create table if not exists public.ai_recommendations (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null,
  surface text not null check (surface in ('cohort', 'campaign')),
  context_hash text not null,
  engine_version text not null,
  warehouse_version text,
  thresholds jsonb not null default '{}'::jsonb,
  recommendations jsonb not null default '[]'::jsonb,
  opportunities jsonb not null default '[]'::jsonb,
  input_status jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists ai_recommendations_user_context_idx
  on public.ai_recommendations (auth_user_id, surface, context_hash, created_at desc);

create or replace function public.reject_ai_recommendation_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'ai_recommendations rows are append-only';
end;
$$;

drop trigger if exists ai_recommendations_guard on public.ai_recommendations;
create trigger ai_recommendations_guard
  before update or delete on public.ai_recommendations
  for each row execute function public.reject_ai_recommendation_mutation();

alter table public.ai_recommendations enable row level security;

drop policy if exists "Users can view own ai recommendations" on public.ai_recommendations;
create policy "Users can view own ai recommendations" on public.ai_recommendations
  for select using (auth.uid() = auth_user_id);

drop policy if exists "Users can insert own ai recommendations" on public.ai_recommendations;
create policy "Users can insert own ai recommendations" on public.ai_recommendations
  for insert with check (auth.uid() = auth_user_id);

-- 3) Feedback on recommendations / assistant answers.
create table if not exists public.ai_feedback (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  subject_kind text not null check (subject_kind in ('recommendation', 'assistant_answer')),
  subject_id text not null,
  verdict text not null check (verdict in ('up', 'down')),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists ai_feedback_user_created_idx
  on public.ai_feedback (auth_user_id, created_at desc);

alter table public.ai_feedback enable row level security;

drop policy if exists "Users can view own ai feedback" on public.ai_feedback;
create policy "Users can view own ai feedback" on public.ai_feedback
  for select using (auth.uid() = auth_user_id);

drop policy if exists "Users can insert own ai feedback" on public.ai_feedback;
create policy "Users can insert own ai feedback" on public.ai_feedback
  for insert with check (auth.uid() = auth_user_id);

drop policy if exists "Users can delete own ai feedback" on public.ai_feedback;
create policy "Users can delete own ai feedback" on public.ai_feedback
  for delete using (auth.uid() = auth_user_id);
