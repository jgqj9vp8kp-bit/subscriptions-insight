-- Facebook Warehouse V2 — Phase 0: mapping & control-plane tables (Postgres side).
-- Roadmap rev.2 establishes TWO distinct mapping layers:
--   A. campaign alias:  observed utm_campaign  -> actual source Meta campaign_id
--      (successor of the hardcoded CONFIRMED_FB_CAMPAIGN_ALIASES; feeds
--       user-attributed matching, classification-only, never allocation math);
--   B. campaign->funnel: actual source campaign_id -> funnel
--      (feeds FULL FUNNEL SPEND — must resolve campaigns with ZERO users;
--       evidence ladder: destination_url > campaign_path > copy_relation >
--       manual > name_rule(suggested only) > unknown).
-- Mapping is DATA, not code: adding a confirmed pair is an INSERT, not a deploy.
-- Nothing reads these tables yet (Phase 0 = schema only, zero readers).
--
-- Mutability rules:
--   - mapping tables are UI-editable by their owner, but identity columns are
--     frozen and DELETE is rejected — corrections happen by retiring a row
--     (status='retired') and inserting a new one, so history is never lost;
--   - facebook_known_gaps and facebook_sync_run_requests are append-only
--     (facebook_history_block_mutation() from migration 202607190001).

-- 1) Layer A: campaign alias mapping ----------------------------------------------

create table if not exists public.facebook_campaign_mapping (
  mapping_id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  observed_campaign_id text not null,
  fb_campaign_id text not null,
  mapping_type text not null check (mapping_type in ('confirmed_alias', 'url_template', 'manual', 'heuristic')),
  confidence numeric check (confidence >= 0 and confidence <= 1),
  evidence jsonb not null default '{}'::jsonb,
  status text not null default 'active' check (status in ('active', 'retired')),
  valid_from date,
  valid_to date,
  created_by text,
  created_at timestamptz not null default now(),
  retired_at timestamptz,
  retire_reason text
);

create unique index if not exists facebook_campaign_mapping_active_pair_idx
  on public.facebook_campaign_mapping (auth_user_id, observed_campaign_id, fb_campaign_id)
  where status = 'active';
create index if not exists facebook_campaign_mapping_user_observed_idx
  on public.facebook_campaign_mapping (auth_user_id, observed_campaign_id);

-- 2) Layer B: campaign -> funnel mapping ------------------------------------------

create table if not exists public.facebook_campaign_funnel_map (
  map_id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  fb_campaign_id text not null,
  funnel text not null,
  match_kind text not null check (match_kind in ('confirmed', 'suggested')),
  evidence_source text not null check (evidence_source in ('destination_url', 'campaign_path', 'copy_relation', 'manual', 'name_rule')),
  confidence numeric check (confidence >= 0 and confidence <= 1),
  evidence jsonb not null default '{}'::jsonb,
  status text not null default 'active' check (status in ('active', 'retired')),
  valid_from date,
  valid_to date,
  created_by text,
  created_at timestamptz not null default now(),
  retired_at timestamptz,
  retire_reason text,
  -- name_rule evidence may only ever produce a SUGGESTED mapping (rev.2 rule).
  constraint facebook_campaign_funnel_map_name_rule_suggested
    check (evidence_source <> 'name_rule' or match_kind = 'suggested')
);

-- One ACTIVE CONFIRMED funnel per campaign; any number of retired/suggested rows.
create unique index if not exists facebook_campaign_funnel_map_active_confirmed_idx
  on public.facebook_campaign_funnel_map (auth_user_id, fb_campaign_id)
  where status = 'active' and match_kind = 'confirmed';
create index if not exists facebook_campaign_funnel_map_user_campaign_idx
  on public.facebook_campaign_funnel_map (auth_user_id, fb_campaign_id);

-- 3) utm_source -> media buyer mapping (replaces the 4x-duplicated hardcode) ------

create table if not exists public.facebook_buyer_mapping (
  buyer_mapping_id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  utm_source text not null,
  buyer text not null,
  status text not null default 'active' check (status in ('active', 'retired')),
  valid_from date,
  valid_to date,
  created_by text,
  created_at timestamptz not null default now(),
  retired_at timestamptz,
  retire_reason text
);

create unique index if not exists facebook_buyer_mapping_active_source_idx
  on public.facebook_buyer_mapping (auth_user_id, utm_source)
  where status = 'active';

-- 4) Known-unrecoverable windows (reconciliation must tell an EXPLAINED hole from
--    an unknown one; e.g. 2026-05-08..2026-06-14 if the source probe returns empty).

create table if not exists public.facebook_known_gaps (
  gap_id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  gap_from date not null,
  gap_to date not null,
  level text not null,
  reason text not null,
  evidence jsonb not null default '{}'::jsonb,
  decided_by text,
  decided_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint facebook_known_gaps_window check (gap_from <= gap_to)
);

-- 5) Per-request sync telemetry (child of facebook_sync_runs; the verbatim payload
--    itself lives in the ClickHouse raw layer, this is the control-plane index).

create table if not exists public.facebook_sync_run_requests (
  request_id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null,
  run_id uuid not null,
  request_seq integer not null,
  entity_level text,
  request_date date,
  http_status integer,
  row_count integer,
  api_latency_ms integer,
  error_message text,
  created_at timestamptz not null default now(),
  constraint facebook_sync_run_requests_seq unique (run_id, request_seq)
);

create index if not exists facebook_sync_run_requests_user_run_idx
  on public.facebook_sync_run_requests (auth_user_id, run_id);

-- 6) Mutation guards ---------------------------------------------------------------

-- Editable mapping tables: DELETE is rejected, identity columns are frozen.
create or replace function public.facebook_mapping_guard()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception '% is retire-only: set status=retired instead of DELETE', tg_table_name;
  end if;
  if new.auth_user_id is distinct from old.auth_user_id
    or new.created_at is distinct from old.created_at then
    raise exception '% identity columns are immutable', tg_table_name;
  end if;
  return new;
end;
$$;

create trigger facebook_campaign_mapping_guard
  before update or delete on public.facebook_campaign_mapping
  for each row execute function public.facebook_mapping_guard();

create trigger facebook_campaign_funnel_map_guard
  before update or delete on public.facebook_campaign_funnel_map
  for each row execute function public.facebook_mapping_guard();

create trigger facebook_buyer_mapping_guard
  before update or delete on public.facebook_buyer_mapping
  for each row execute function public.facebook_mapping_guard();

-- Append-only tables reuse the Phase 1 blocker (rejects UPDATE and DELETE).
create trigger facebook_known_gaps_append_only
  before update or delete on public.facebook_known_gaps
  for each row execute function public.facebook_history_block_mutation();

create trigger facebook_sync_run_requests_append_only
  before update or delete on public.facebook_sync_run_requests
  for each row execute function public.facebook_history_block_mutation();

-- 7) RLS ---------------------------------------------------------------------------

alter table public.facebook_campaign_mapping enable row level security;
alter table public.facebook_campaign_funnel_map enable row level security;
alter table public.facebook_buyer_mapping enable row level security;
alter table public.facebook_known_gaps enable row level security;
alter table public.facebook_sync_run_requests enable row level security;

-- Mapping tables are owner-editable from the UI (insert/update own rows).
create policy facebook_campaign_mapping_select_own on public.facebook_campaign_mapping
  for select using (auth.uid() = auth_user_id);
create policy facebook_campaign_mapping_insert_own on public.facebook_campaign_mapping
  for insert with check (auth.uid() = auth_user_id);
create policy facebook_campaign_mapping_update_own on public.facebook_campaign_mapping
  for update using (auth.uid() = auth_user_id) with check (auth.uid() = auth_user_id);

create policy facebook_campaign_funnel_map_select_own on public.facebook_campaign_funnel_map
  for select using (auth.uid() = auth_user_id);
create policy facebook_campaign_funnel_map_insert_own on public.facebook_campaign_funnel_map
  for insert with check (auth.uid() = auth_user_id);
create policy facebook_campaign_funnel_map_update_own on public.facebook_campaign_funnel_map
  for update using (auth.uid() = auth_user_id) with check (auth.uid() = auth_user_id);

create policy facebook_buyer_mapping_select_own on public.facebook_buyer_mapping
  for select using (auth.uid() = auth_user_id);
create policy facebook_buyer_mapping_insert_own on public.facebook_buyer_mapping
  for insert with check (auth.uid() = auth_user_id);
create policy facebook_buyer_mapping_update_own on public.facebook_buyer_mapping
  for update using (auth.uid() = auth_user_id) with check (auth.uid() = auth_user_id);

-- Known gaps: a human decision — owner can read and record, never mutate.
create policy facebook_known_gaps_select_own on public.facebook_known_gaps
  for select using (auth.uid() = auth_user_id);
create policy facebook_known_gaps_insert_own on public.facebook_known_gaps
  for insert with check (auth.uid() = auth_user_id);

-- Sync request telemetry: written only by the service-role recorder; owners read.
create policy facebook_sync_run_requests_select_own on public.facebook_sync_run_requests
  for select using (auth.uid() = auth_user_id);
