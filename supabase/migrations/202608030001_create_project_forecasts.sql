-- Saved project-level forecasts (Project Forecasting rev.3, phase P7).
--
-- A row stores BOTH lineage (`bindings`: the edited entries + shared costs +
-- policy — the only thing the UI edits) AND the replayable state: the frozen
-- per-funnel engine snapshots plus the spend ledgers the numbers were scoped
-- against. Replay is a pure function of the row — zero network, bit-identical —
-- so editing global defaults or re-running spend resolution later never moves a
-- saved project ("Refresh from sources" re-resolves explicitly and shows a
-- field-level diff before overwriting anything).
--
-- Scalar columns exist so the LIST view never parses jsonb, and so a
-- provisional project (attributed-only basis, known-gap window) is visible in
-- the list before opening it. forecast_model pins the v1 semantic
-- (acquisition_cohort_day0 — common Day 0, not a calendar P&L) in the data.
create table if not exists public.project_forecasts (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  notes text,
  schema_version integer not null,
  engine_version text not null,
  forecast_model text not null default 'acquisition_cohort_day0',
  spend_basis text not null default 'full_funnel_spend',
  source_window_from date not null,
  source_window_to date not null,
  source_as_of timestamptz not null,
  funnel_count integer not null default 0,
  total_planned_budget numeric not null default 0,
  window_source_spend numeric not null default 0,
  project_scoped_spend numeric not null default 0,
  out_of_project_spend numeric not null default 0,
  spend_coverage numeric not null default 0,
  spend_incomplete boolean not null default false,
  provisional_reasons text[] not null default '{}',
  bindings jsonb not null,
  frozen jsonb not null default '{}'::jsonb,
  window_ledger jsonb not null,
  funnel_ledgers jsonb not null default '{}'::jsonb,
  seed_evidence jsonb not null default '{}'::jsonb,
  resolved_at timestamptz not null,
  visibility text not null default 'personal',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists project_forecasts_auth_user_id_idx on public.project_forecasts (auth_user_id);
create index if not exists project_forecasts_updated_idx on public.project_forecasts (auth_user_id, updated_at desc);
create index if not exists project_forecasts_window_idx on public.project_forecasts (auth_user_id, source_window_from, source_window_to);

create or replace function public.set_project_forecasts_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists project_forecasts_set_updated_at on public.project_forecasts;
create trigger project_forecasts_set_updated_at
before update on public.project_forecasts
for each row
execute function public.set_project_forecasts_updated_at();

alter table public.project_forecasts enable row level security;

drop policy if exists "Users can read own project forecasts" on public.project_forecasts;
create policy "Users can read own project forecasts"
on public.project_forecasts for select using (auth.uid() = auth_user_id);

drop policy if exists "Users can insert own project forecasts" on public.project_forecasts;
create policy "Users can insert own project forecasts"
on public.project_forecasts for insert with check (auth.uid() = auth_user_id);

drop policy if exists "Users can update own project forecasts" on public.project_forecasts;
create policy "Users can update own project forecasts"
on public.project_forecasts for update using (auth.uid() = auth_user_id) with check (auth.uid() = auth_user_id);

drop policy if exists "Users can delete own project forecasts" on public.project_forecasts;
create policy "Users can delete own project forecasts"
on public.project_forecasts for delete using (auth.uid() = auth_user_id);
