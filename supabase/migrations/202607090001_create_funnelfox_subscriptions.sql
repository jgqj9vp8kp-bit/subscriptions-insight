create extension if not exists pgcrypto;

-- Durable, per-row storage for FunnelFox subscriptions synced via the staged,
-- resumable funnelfox-subscriptions-sync Edge Function. Mirrors the leads sync
-- design (funnelfox_leads + funnelfox_leads_sync_state). Scoped per auth user
-- via RLS. Upsert key is (auth_user_id, subscription_id).
create table if not exists public.funnelfox_subscriptions (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  subscription_id text not null,
  profile_id text,
  customer_id text,
  psp_id text,
  email text,
  normalized_email text,

  -- Normalized (lightweight) fields for querying/diagnostics. The frontend
  -- re-derives the full SubscriptionClean from raw via normalizeSubscription,
  -- so complex cancellation logic stays in one place (subscriptionTransform.ts).
  funnel text,
  campaign_path text,
  status text,
  renews boolean,
  cancelled_at timestamptz,
  period_ends_at timestamptz,
  product_name text,
  product_id text,
  price numeric,
  currency text,
  created_at timestamptz,
  updated_at timestamptz,
  synced_at timestamptz default now(),

  -- Raw payloads (list / detail / profile) preserved for re-derivation.
  raw_list jsonb,
  raw_detail jsonb,
  raw_profile jsonb,

  -- Per-row resume markers. detail_checked=false → still needs /subscriptions/{id};
  -- profile_checked=false → still eligible for /profiles/{id} email recovery.
  detail_checked boolean not null default false,
  profile_checked boolean not null default false,

  inserted_at timestamptz default now(),
  updated_row_at timestamptz default now(),

  unique (auth_user_id, subscription_id)
);

create index if not exists funnelfox_subscriptions_auth_user_id_idx on public.funnelfox_subscriptions (auth_user_id);
create index if not exists funnelfox_subscriptions_subscription_id_idx on public.funnelfox_subscriptions (subscription_id);
create index if not exists funnelfox_subscriptions_profile_id_idx on public.funnelfox_subscriptions (profile_id);
create index if not exists funnelfox_subscriptions_normalized_email_idx on public.funnelfox_subscriptions (normalized_email);
create index if not exists funnelfox_subscriptions_status_idx on public.funnelfox_subscriptions (status);
-- Partial indexes back the resumable candidate queries (cursor-less stages).
create index if not exists funnelfox_subscriptions_detail_pending_idx
  on public.funnelfox_subscriptions (auth_user_id, detail_checked) where detail_checked = false;
create index if not exists funnelfox_subscriptions_profile_pending_idx
  on public.funnelfox_subscriptions (auth_user_id, profile_checked) where profile_checked = false;

create or replace function public.set_funnelfox_subscriptions_updated_row_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_row_at = now();
  return new;
end;
$$;

drop trigger if exists funnelfox_subscriptions_set_updated_row_at on public.funnelfox_subscriptions;
create trigger funnelfox_subscriptions_set_updated_row_at
before update on public.funnelfox_subscriptions
for each row
execute function public.set_funnelfox_subscriptions_updated_row_at();

alter table public.funnelfox_subscriptions enable row level security;

drop policy if exists "Users can read own funnelfox subscriptions" on public.funnelfox_subscriptions;
create policy "Users can read own funnelfox subscriptions"
on public.funnelfox_subscriptions for select using (auth.uid() = auth_user_id);

drop policy if exists "Users can insert own funnelfox subscriptions" on public.funnelfox_subscriptions;
create policy "Users can insert own funnelfox subscriptions"
on public.funnelfox_subscriptions for insert with check (auth.uid() = auth_user_id);

drop policy if exists "Users can update own funnelfox subscriptions" on public.funnelfox_subscriptions;
create policy "Users can update own funnelfox subscriptions"
on public.funnelfox_subscriptions for update using (auth.uid() = auth_user_id) with check (auth.uid() = auth_user_id);

drop policy if exists "Users can delete own funnelfox subscriptions" on public.funnelfox_subscriptions;
create policy "Users can delete own funnelfox subscriptions"
on public.funnelfox_subscriptions for delete using (auth.uid() = auth_user_id);


-- Per-user staged/resumable sync state (singleton row per auth user).
create table if not exists public.funnelfox_subscriptions_sync_state (
  auth_user_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  last_list_cursor text,
  current_stage text,
  list_completed boolean not null default false,
  details_completed boolean not null default false,
  profiles_completed boolean not null default false,
  finalize_completed boolean not null default false,
  subscriptions_scanned_total integer not null default 0,
  subscriptions_total_reported_by_api integer,
  last_status text,
  last_error text,
  stopped_reason text,
  started_at timestamptz,
  finished_at timestamptz,
  duration_ms integer,
  last_full_sync_at timestamptz,
  stats jsonb,
  updated_at timestamptz default now()
);

create or replace function public.set_funnelfox_subscriptions_sync_state_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists funnelfox_subscriptions_sync_state_set_updated_at on public.funnelfox_subscriptions_sync_state;
create trigger funnelfox_subscriptions_sync_state_set_updated_at
before update on public.funnelfox_subscriptions_sync_state
for each row
execute function public.set_funnelfox_subscriptions_sync_state_updated_at();

alter table public.funnelfox_subscriptions_sync_state enable row level security;

drop policy if exists "Users can read own funnelfox subscriptions sync state" on public.funnelfox_subscriptions_sync_state;
create policy "Users can read own funnelfox subscriptions sync state"
on public.funnelfox_subscriptions_sync_state for select using (auth.uid() = auth_user_id);

drop policy if exists "Users can insert own funnelfox subscriptions sync state" on public.funnelfox_subscriptions_sync_state;
create policy "Users can insert own funnelfox subscriptions sync state"
on public.funnelfox_subscriptions_sync_state for insert with check (auth.uid() = auth_user_id);

drop policy if exists "Users can update own funnelfox subscriptions sync state" on public.funnelfox_subscriptions_sync_state;
create policy "Users can update own funnelfox subscriptions sync state"
on public.funnelfox_subscriptions_sync_state for update using (auth.uid() = auth_user_id) with check (auth.uid() = auth_user_id);

drop policy if exists "Users can delete own funnelfox subscriptions sync state" on public.funnelfox_subscriptions_sync_state;
create policy "Users can delete own funnelfox subscriptions sync state"
on public.funnelfox_subscriptions_sync_state for delete using (auth.uid() = auth_user_id);
