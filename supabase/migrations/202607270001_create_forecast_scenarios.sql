-- Saved forecast scenarios for the Forecasting redesign (v3 spec §13/§22, phase P5).
--
-- A scenario row stores BOTH its lineage (`bindings`: entity refs + the override
-- patch the user applied) AND the frozen, fully-resolved, JSON-serializable engine
-- snapshot (`frozen`: FrozenForecastInputs, schema-versioned). The snapshot is what
-- the engine re-runs — editing shared configuration later never silently rewrites a
-- saved forecast ("Refresh from sources" re-resolves explicitly and overwrites).
--
-- Visibility: rows are personal (RLS "own rows") for now — team sharing is an open
-- business decision (spec Q5); the `visibility` column is reserved for it.
create table if not exists public.forecast_scenarios (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  notes text,
  funnel_id text not null,
  scenario_type text not null default 'custom',
  horizon_periods integer not null,
  bindings jsonb not null default '{}'::jsonb,
  frozen jsonb not null,
  source_scenario_id uuid,
  visibility text not null default 'personal',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists forecast_scenarios_auth_user_id_idx on public.forecast_scenarios (auth_user_id);
create index if not exists forecast_scenarios_funnel_idx on public.forecast_scenarios (auth_user_id, funnel_id);

create or replace function public.set_forecast_scenarios_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists forecast_scenarios_set_updated_at on public.forecast_scenarios;
create trigger forecast_scenarios_set_updated_at
before update on public.forecast_scenarios
for each row
execute function public.set_forecast_scenarios_updated_at();

alter table public.forecast_scenarios enable row level security;

drop policy if exists "Users can read own forecast scenarios" on public.forecast_scenarios;
create policy "Users can read own forecast scenarios"
on public.forecast_scenarios for select using (auth.uid() = auth_user_id);

drop policy if exists "Users can insert own forecast scenarios" on public.forecast_scenarios;
create policy "Users can insert own forecast scenarios"
on public.forecast_scenarios for insert with check (auth.uid() = auth_user_id);

drop policy if exists "Users can update own forecast scenarios" on public.forecast_scenarios;
create policy "Users can update own forecast scenarios"
on public.forecast_scenarios for update using (auth.uid() = auth_user_id) with check (auth.uid() = auth_user_id);

drop policy if exists "Users can delete own forecast scenarios" on public.forecast_scenarios;
create policy "Users can delete own forecast scenarios"
on public.forecast_scenarios for delete using (auth.uid() = auth_user_id);
