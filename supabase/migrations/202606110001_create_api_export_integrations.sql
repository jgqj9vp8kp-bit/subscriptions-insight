create extension if not exists pgcrypto;

create table if not exists public.api_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  key_hash text not null unique,
  prefix text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  allowed_scopes text[] not null default array[]::text[],
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists public.api_export_logs (
  id uuid primary key default gen_random_uuid(),
  api_key_id uuid references public.api_keys(id) on delete set null,
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null,
  params jsonb not null default '{}'::jsonb,
  status_code integer not null,
  rows_returned integer not null default 0,
  created_at timestamptz not null default now(),
  error_message text,
  key_prefix text
);

create index if not exists api_keys_user_created_at_idx on public.api_keys (user_id, created_at desc);
create index if not exists api_keys_key_hash_active_idx on public.api_keys (key_hash, is_active);
create index if not exists api_export_logs_user_created_at_idx on public.api_export_logs (user_id, created_at desc);
create index if not exists api_export_logs_api_key_created_at_idx on public.api_export_logs (api_key_id, created_at desc);

alter table public.api_keys enable row level security;
alter table public.api_export_logs enable row level security;

drop policy if exists "Users can read own api keys" on public.api_keys;
create policy "Users can read own api keys"
on public.api_keys
for select
using (auth.uid() = user_id);

drop policy if exists "Users can create own api keys" on public.api_keys;
create policy "Users can create own api keys"
on public.api_keys
for insert
with check (auth.uid() = user_id);

drop policy if exists "Users can update own api keys" on public.api_keys;
create policy "Users can update own api keys"
on public.api_keys
for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "Users can read own api export logs" on public.api_export_logs;
create policy "Users can read own api export logs"
on public.api_export_logs
for select
using (auth.uid() = user_id);
