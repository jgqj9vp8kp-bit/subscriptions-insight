create table if not exists public.capsuled_facebook_syncs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  date_from date not null,
  date_to date not null,
  level text not null check (level in ('account', 'campaign', 'adset', 'ad', 'day')),
  status text not null check (status in ('success', 'failed', 'partial')),
  raw_payload jsonb,
  rows_imported integer not null default 0,
  api_freshness text,
  facebook_stats_date date,
  duration_ms integer,
  last_api_response text,
  failed_requests text[] not null default array[]::text[],
  error_message text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);

create table if not exists public.capsuled_facebook_stats (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  sync_id uuid references public.capsuled_facebook_syncs(id) on delete set null,
  import_key text not null,
  date_from date not null,
  date_to date not null,
  level text not null check (level in ('account', 'campaign', 'adset', 'ad', 'day')),
  campaign_id text,
  campaign_name text,
  ad_account_id text,
  ad_account_name text,
  spend numeric not null default 0,
  fb_purchases numeric not null default 0,
  cpp numeric,
  impressions numeric not null default 0,
  clicks numeric not null default 0,
  ctr numeric,
  cpc numeric,
  cpm numeric,
  outbound_clicks numeric not null default 0,
  outbound_ctr numeric,
  currency text,
  raw_payload jsonb not null default '{}'::jsonb,
  last_import_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists capsuled_facebook_stats_user_import_key_idx
on public.capsuled_facebook_stats (user_id, import_key);

create index if not exists capsuled_facebook_stats_user_campaign_idx
on public.capsuled_facebook_stats (user_id, campaign_id);

create index if not exists capsuled_facebook_stats_user_imported_idx
on public.capsuled_facebook_stats (user_id, last_import_at desc);

create index if not exists capsuled_facebook_syncs_user_created_idx
on public.capsuled_facebook_syncs (user_id, created_at desc);

alter table public.capsuled_facebook_syncs enable row level security;
alter table public.capsuled_facebook_stats enable row level security;

drop policy if exists "Users can read own Capsuled Facebook syncs" on public.capsuled_facebook_syncs;
create policy "Users can read own Capsuled Facebook syncs"
on public.capsuled_facebook_syncs
for select
using (auth.uid() = user_id);

drop policy if exists "Users can read own Capsuled Facebook stats" on public.capsuled_facebook_stats;
create policy "Users can read own Capsuled Facebook stats"
on public.capsuled_facebook_stats
for select
using (auth.uid() = user_id);
