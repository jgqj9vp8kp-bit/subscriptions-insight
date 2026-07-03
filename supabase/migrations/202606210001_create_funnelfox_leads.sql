create extension if not exists pgcrypto;

-- FunnelFox leads: contacts discovered via /public/v1/profiles + /sessions that left an email but
-- have not converted (no successful payment, no active subscription). Scoped per auth user via RLS.
create table if not exists public.funnelfox_leads (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  profile_id text not null,
  email text,
  normalized_email text,
  created_at timestamptz,
  updated_at timestamptz,
  synced_at timestamptz default now(),

  -- Funnel / session attribution
  session_id text,
  session_created_at timestamptz,
  funnel_id text,
  funnel_version text,
  funnel text,
  campaign_path text,
  campaign_id text,
  utm_source text,
  media_buyer text,
  country_code text,
  city text,
  postal text,
  user_agent text,
  origin text,

  -- Conversion state (reconciled against the warehouse + FunnelFox subscriptions client-side)
  has_successful_payment boolean default false,
  has_active_subscription boolean default false,
  is_lead boolean default true,
  first_trial_at timestamptz,
  first_sub_at timestamptz,

  -- Raw payloads (debug / re-derivation)
  raw_profile_list jsonb,
  raw_profile_detail jsonb,
  raw_session jsonb,

  -- Audit
  inserted_at timestamptz default now(),
  updated_row_at timestamptz default now(),

  unique (auth_user_id, profile_id)
);

create index if not exists funnelfox_leads_auth_user_id_idx on public.funnelfox_leads (auth_user_id);
create index if not exists funnelfox_leads_profile_id_idx on public.funnelfox_leads (profile_id);
create index if not exists funnelfox_leads_normalized_email_idx on public.funnelfox_leads (normalized_email);
create index if not exists funnelfox_leads_created_at_idx on public.funnelfox_leads (created_at);
create index if not exists funnelfox_leads_session_created_at_idx on public.funnelfox_leads (session_created_at);
create index if not exists funnelfox_leads_campaign_path_idx on public.funnelfox_leads (campaign_path);
create index if not exists funnelfox_leads_campaign_id_idx on public.funnelfox_leads (campaign_id);
create index if not exists funnelfox_leads_media_buyer_idx on public.funnelfox_leads (media_buyer);
create index if not exists funnelfox_leads_country_code_idx on public.funnelfox_leads (country_code);
create index if not exists funnelfox_leads_is_lead_idx on public.funnelfox_leads (is_lead);

create or replace function public.set_funnelfox_leads_updated_row_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_row_at = now();
  return new;
end;
$$;

drop trigger if exists funnelfox_leads_set_updated_row_at on public.funnelfox_leads;
create trigger funnelfox_leads_set_updated_row_at
before update on public.funnelfox_leads
for each row
execute function public.set_funnelfox_leads_updated_row_at();

alter table public.funnelfox_leads enable row level security;

drop policy if exists "Users can read own funnelfox leads" on public.funnelfox_leads;
create policy "Users can read own funnelfox leads"
on public.funnelfox_leads
for select
using (auth.uid() = auth_user_id);

drop policy if exists "Users can insert own funnelfox leads" on public.funnelfox_leads;
create policy "Users can insert own funnelfox leads"
on public.funnelfox_leads
for insert
with check (auth.uid() = auth_user_id);

drop policy if exists "Users can update own funnelfox leads" on public.funnelfox_leads;
create policy "Users can update own funnelfox leads"
on public.funnelfox_leads
for update
using (auth.uid() = auth_user_id)
with check (auth.uid() = auth_user_id);

drop policy if exists "Users can delete own funnelfox leads" on public.funnelfox_leads;
create policy "Users can delete own funnelfox leads"
on public.funnelfox_leads
for delete
using (auth.uid() = auth_user_id);


-- Per-user sync state / cursors. Prepared for incremental sync; MVP uses safe full crawls.
create table if not exists public.funnelfox_leads_sync_state (
  auth_user_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  last_profiles_cursor text,
  last_sessions_cursor text,
  last_full_sync_at timestamptz,
  last_profiles_synced_at timestamptz,
  last_sessions_synced_at timestamptz,
  last_status text,
  last_error text,
  stats jsonb,
  updated_at timestamptz default now()
);

create or replace function public.set_funnelfox_leads_sync_state_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists funnelfox_leads_sync_state_set_updated_at on public.funnelfox_leads_sync_state;
create trigger funnelfox_leads_sync_state_set_updated_at
before update on public.funnelfox_leads_sync_state
for each row
execute function public.set_funnelfox_leads_sync_state_updated_at();

alter table public.funnelfox_leads_sync_state enable row level security;

drop policy if exists "Users can read own funnelfox leads sync state" on public.funnelfox_leads_sync_state;
create policy "Users can read own funnelfox leads sync state"
on public.funnelfox_leads_sync_state
for select
using (auth.uid() = auth_user_id);

drop policy if exists "Users can insert own funnelfox leads sync state" on public.funnelfox_leads_sync_state;
create policy "Users can insert own funnelfox leads sync state"
on public.funnelfox_leads_sync_state
for insert
with check (auth.uid() = auth_user_id);

drop policy if exists "Users can update own funnelfox leads sync state" on public.funnelfox_leads_sync_state;
create policy "Users can update own funnelfox leads sync state"
on public.funnelfox_leads_sync_state
for update
using (auth.uid() = auth_user_id)
with check (auth.uid() = auth_user_id);

drop policy if exists "Users can delete own funnelfox leads sync state" on public.funnelfox_leads_sync_state;
create policy "Users can delete own funnelfox leads sync state"
on public.funnelfox_leads_sync_state
for delete
using (auth.uid() = auth_user_id);
