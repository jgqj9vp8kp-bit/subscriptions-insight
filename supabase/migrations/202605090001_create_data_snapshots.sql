create extension if not exists pgcrypto;

create table if not exists public.data_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  dataset_type text not null check (
    dataset_type in (
      'palmer',
      'funnelfox_subscriptions',
      'facebook_traffic',
      'forecasting_settings'
    )
  ),
  name text not null default 'latest',
  payload jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, dataset_type)
);

create or replace function public.set_data_snapshots_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists data_snapshots_set_updated_at on public.data_snapshots;
create trigger data_snapshots_set_updated_at
before update on public.data_snapshots
for each row
execute function public.set_data_snapshots_updated_at();

alter table public.data_snapshots enable row level security;

drop policy if exists "Users can read own data snapshots" on public.data_snapshots;
create policy "Users can read own data snapshots"
on public.data_snapshots
for select
using (auth.uid() = user_id);

drop policy if exists "Users can insert own data snapshots" on public.data_snapshots;
create policy "Users can insert own data snapshots"
on public.data_snapshots
for insert
with check (auth.uid() = user_id);

drop policy if exists "Users can update own data snapshots" on public.data_snapshots;
create policy "Users can update own data snapshots"
on public.data_snapshots
for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "Users can delete own data snapshots" on public.data_snapshots;
create policy "Users can delete own data snapshots"
on public.data_snapshots
for delete
using (auth.uid() = user_id);
