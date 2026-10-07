-- FunnelFox leads: full profile export + server-side Leads (leads plan §2 A2
-- item 12, §3 "Postgres RPC leads_profile_candidates", ADDENDUM owner decisions).
--
-- Live probe (2026-10-06): the FunnelFox profile LIST row is
-- {id, created_at, funnel_id, preview, email?}; 24% of rows carry `email` at the
-- root and `preview` is a boolean on every row. The /profiles/{id} detail
-- endpoint has NO email, so the sync no longer runs a detail stage: emails come
-- only from the list, and only profiles that carry an email are stored (light
-- columns, no raw payloads). Profile ids are already bare (no `pro_` prefix), so
-- no id rewrite is needed.
--
-- What this migration does:
--   1. funnelfox_leads.preview (FunnelFox editor/preview runs; never a lead) and
--      funnelfox_leads.email_source ('list' for list-sourced emails);
--      funnelfox_leads_sync_state.lease_until (one sync call at a time);
--      funnelfox_leads.is_lead now defaults to false: a row is a lead only once
--      funnelfox_leads_reconcile() says so.
--   2. Legacy rows (written by the 1-profile-per-call build): the email and the
--      preview flag the list row already carried are copied out of
--      raw_profile_list; rows that still have no email are deleted (owner
--      decision 1: store only profiles with an email; the full re-crawl rebuilds
--      everything from FunnelFox), and the raw jsonb payloads of the surviving
--      rows are cleared (decision 1: no raw payloads stored). The sync state is
--      reset (cursors, stage flags, counters, stale stats) so the first run of
--      the new sync starts from the newest profile instead of resuming the old
--      1-per-call cursor.
--   3. Indexes: (auth_user_id, normalized_email) for the email reads; the
--      single-column indexes no read path filters on are dropped (every sync
--      lookup is (auth_user_id, profile_id), covered by the unique constraint);
--      a covering index on the live warehouse emails so the paid / seen-email
--      anti-joins below are index-only instead of a scan of every transaction
--      payload.
--   4. RPCs, all SECURITY INVOKER with search_path '' and EXECUTE for
--      service_role only (Edge passes ctx.tenantKey; a browser caller must never
--      name a tenant). Every one filters on p_data_key explicitly -- service_role
--      bypasses RLS -- and a null key matches nothing, never "every owner":
--        funnelfox_leads_reconcile(p_data_key)                   -> jsonb
--        funnelfox_leads_acquire_lease(p_data_key, s)            -> uuid (lease token, null = busy)
--        funnelfox_leads_release_lease(p_data_key, p_token)      -> void
--        leads_profile_candidates(p_data_key, p_profile_limit)   -> jsonb
--      plus the internal helper leads_try_timestamptz(text) (a cast that yields
--      null instead of raising on an impossible date).
--
-- Email identity everywhere is lower(btrim(email)), the same normalization as
-- the browser (src/services/leads.ts normalizeEmail) and the active-subscription
-- RPC. "Paid" = a live (deleted_at is null) public.transactions row with
-- status 'success'. "Active" = public.active_funnelfox_subscription_emails
-- (p_data_key), the Cohorts definition (owner decision 5).
--
-- A stored profile is also never a lead when ITS OWN FunnelFox subscription
-- (funnelfox_subscriptions.profile_id = funnelfox_leads.profile_id, bare ids on
-- both sides) shows a paying / subscribed customer: the checkout email can
-- differ from the email typed into the quiz. "Shows a paying customer" = the
-- subscription's email is paid or active, or the subscription is priced and
-- either not cancelled (src/services/leads.ts "looks like a paid sub") or still
-- inside its paid period (the browser's is_active_now: period_ends_at in the
-- future, not expired / unpaid, not sandbox).
--
-- Deploy order: this migration, then the Edge functions that call these RPCs
-- (funnelfox-leads-sync, clickhouse-users), then 202610060011 (pg_cron).


-- ---------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------

alter table public.funnelfox_leads
  add column if not exists preview boolean not null default false,
  add column if not exists email_source text;

alter table public.funnelfox_leads
  alter column is_lead set default false;

alter table public.funnelfox_leads_sync_state
  add column if not exists lease_until timestamptz,
  add column if not exists lease_token uuid;


-- ---------------------------------------------------------------------------
-- 2. Legacy rows and sync state
-- ---------------------------------------------------------------------------

-- The list row already carried the email and the preview flag; the old build
-- never copied them into columns.
update public.funnelfox_leads l
set
  preview = case
    when jsonb_typeof(l.raw_profile_list -> 'preview') = 'boolean' then (l.raw_profile_list ->> 'preview')::boolean
    else l.preview
  end,
  email = case when src.list_email is not null then src.list_email else l.email end,
  normalized_email = case when src.list_email is not null then lower(src.list_email) else l.normalized_email end,
  email_source = case when src.list_email is not null then 'list' else l.email_source end
from (
  select
    i.id,
    case
      when i.normalized_email is null
        and jsonb_typeof(i.raw_profile_list -> 'email') = 'string'
        and btrim(i.raw_profile_list ->> 'email') ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
      then btrim(i.raw_profile_list ->> 'email')
    end as list_email
  from public.funnelfox_leads i
  where i.raw_profile_list is not null
) src
where l.id = src.id
  and (
    src.list_email is not null
    or jsonb_typeof(l.raw_profile_list -> 'preview') = 'boolean'
  );

-- Owner decision 1: only profiles that carry an email are stored.
delete from public.funnelfox_leads
where normalized_email is null
   or btrim(normalized_email) = '';

-- Owner decision 1: no raw FunnelFox payloads are kept, the surviving legacy
-- rows included (the email and the preview flag were copied out above; the new
-- sync never writes these columns).
update public.funnelfox_leads
set
  raw_profile_list = null,
  raw_profile_detail = null,
  raw_session = null
where raw_profile_list is not null
   or raw_profile_detail is not null
   or raw_session is not null;

-- Start the new pipeline from the newest profile (see header, item 2).
update public.funnelfox_leads_sync_state
set
  current_stage = null,
  last_profiles_cursor = null,
  last_sessions_cursor = null,
  profiles_completed = false,
  details_completed = false,
  sessions_completed = false,
  reconcile_completed = false,
  profiles_total_reported_by_api = null,
  profiles_scanned_total = 0,
  sessions_scanned_total = 0,
  stats = null,
  lease_until = null,
  lease_token = null;


-- ---------------------------------------------------------------------------
-- 3. Indexes
-- ---------------------------------------------------------------------------

create index if not exists funnelfox_leads_owner_email_idx
  on public.funnelfox_leads (auth_user_id, normalized_email)
  where normalized_email is not null;

-- No read path filters on these: the sync looks rows up by
-- (auth_user_id, profile_id) (unique constraint) and every Leads read is
-- tenant-scoped through the RPC below.
drop index if exists public.funnelfox_leads_profile_id_idx;
drop index if exists public.funnelfox_leads_campaign_path_idx;
drop index if exists public.funnelfox_leads_campaign_id_idx;
drop index if exists public.funnelfox_leads_media_buyer_idx;
drop index if exists public.funnelfox_leads_country_code_idx;
drop index if exists public.funnelfox_leads_is_lead_idx;

-- Live warehouse emails per owner, normalized. INCLUDE carries what the paid /
-- first-trial / first-subscription reads need, so reconcile and the candidates
-- RPC answer from the index (the heap rows hold the full raw payloads).
create index if not exists transactions_live_owner_email_idx
  on public.transactions (auth_user_id, (lower(btrim(email))))
  include (status, transaction_type, event_time, email)
  where deleted_at is null and email is not null;


-- ---------------------------------------------------------------------------
-- 4. RPCs
-- ---------------------------------------------------------------------------

-- Conversion state for every stored profile of p_data_key, in one set-based
-- UPDATE that touches only rows whose state changed (replaces the browser-fed
-- reconcile stage). Counts, over the owner's rows:
--   checked          every row
--   leads            is_lead after this call (email, not paid, not active, not preview)
--   paid_excluded    email has a live successful transaction, or a stored
--                    profile with that email has its own subscription showing a
--                    paying / subscribed customer (see header)
--   active_excluded  email has an active subscription and is NOT paid (disjoint
--                    from paid_excluded, so the KPIs add up)
--   updated          rows this call changed
create or replace function public.funnelfox_leads_reconcile(p_data_key uuid)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  with paid as (
    select
      lower(btrim(t.email)) as email,
      min(t.event_time) filter (where t.transaction_type = 'trial') as first_trial_at,
      min(t.event_time) filter (where t.transaction_type = 'first_subscription') as first_sub_at
    from public.transactions t
    where t.auth_user_id = p_data_key
      and t.deleted_at is null
      and t.email is not null
      and t.status = 'success'
      and btrim(t.email) <> ''
    group by 1
  ),
  active as (
    select k.email
    from jsonb_object_keys(public.active_funnelfox_subscription_emails(p_data_key)) as k(email)
  ),
  -- Profiles whose OWN subscription shows a paying / subscribed customer
  -- (header; same predicate as leads_profile_candidates.linked_emails).
  linked_profiles as (
    select distinct regexp_replace(btrim(s.profile_id), '^pro_', '', 'i') as profile_key
    from public.funnelfox_subscriptions s
    cross join lateral (select nullif(lower(btrim(s.normalized_email)), '') as email) e
    where s.auth_user_id = p_data_key
      and nullif(btrim(s.profile_id), '') is not null
      and (
        (coalesce(s.price, 0) > 0 and not (coalesce(s.status, '') ~* 'cancel' or s.renews is false))
        or (
          coalesce(s.price, 0) > 0
          and s.period_ends_at > now()
          and coalesce(s.status, '') !~* 'expired|unpaid'
          and coalesce(s.raw_detail -> 'sandbox', s.raw_list -> 'sandbox') is distinct from 'true'::jsonb
        )
        or exists (select 1 from paid p where p.email = e.email)
        or exists (select 1 from active a where a.email = e.email)
      )
  ),
  -- Per email: any of the owner's stored profiles with that email is linked.
  linked_emails as (
    select distinct e.email
    from public.funnelfox_leads l
    cross join lateral (select nullif(lower(btrim(l.normalized_email)), '') as email) e
    join linked_profiles lp on lp.profile_key = l.profile_id
    where l.auth_user_id = p_data_key
      and e.email is not null
  ),
  computed as (
    select
      l.id,
      (p.email is not null or le.email is not null) as paid,
      a.email is not null as active,
      (e.email is not null and p.email is null and le.email is null and a.email is null and not l.preview) as is_lead,
      p.first_trial_at,
      p.first_sub_at
    from public.funnelfox_leads l
    cross join lateral (select nullif(lower(btrim(l.normalized_email)), '') as email) e
    left join paid p on p.email = e.email
    left join active a on a.email = e.email
    left join linked_emails le on le.email = e.email
    where l.auth_user_id = p_data_key
  ),
  updated as (
    update public.funnelfox_leads l
    set
      has_successful_payment = c.paid,
      has_active_subscription = c.active,
      is_lead = c.is_lead,
      first_trial_at = c.first_trial_at,
      first_sub_at = c.first_sub_at
    from computed c
    where l.id = c.id
      and (l.has_successful_payment, l.has_active_subscription, l.is_lead, l.first_trial_at, l.first_sub_at)
        is distinct from (c.paid, c.active, c.is_lead, c.first_trial_at, c.first_sub_at)
    returning 1
  )
  select jsonb_build_object(
    'checked', (select count(*) from computed),
    'leads', (select count(*) from computed where is_lead),
    'paid_excluded', (select count(*) from computed where paid),
    'active_excluded', (select count(*) from computed where active and not paid),
    'updated', (select count(*) from updated)
  )
$$;

-- One sync call at a time per owner (cron tick vs. the button). A conditional
-- upsert: it takes the lease only when none is held or the held one expired,
-- and creates the state row on the very first call. Concurrent callers
-- serialize on the row lock / the primary key, so exactly one gets a token.
-- Returns the new lease token (null = another call holds the lease); only that
-- token releases it. p_seconds must outlive the longest call; an expired lease
-- is free to take. (Dropped first: an earlier draft returned boolean.)
drop function if exists public.funnelfox_leads_acquire_lease(uuid, integer);
create or replace function public.funnelfox_leads_acquire_lease(p_data_key uuid, p_seconds int)
returns uuid
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_token uuid;
begin
  if p_data_key is null then
    raise exception using errcode = '22004', message = 'funnelfox_leads_acquire_lease: p_data_key is required';
  end if;
  if p_seconds is null or p_seconds < 1 or p_seconds > 3600 then
    raise exception using errcode = '22023', message = 'funnelfox_leads_acquire_lease: p_seconds must be between 1 and 3600';
  end if;

  insert into public.funnelfox_leads_sync_state as s (auth_user_id, lease_until, lease_token)
  values (p_data_key, clock_timestamp() + make_interval(secs => p_seconds), pg_catalog.gen_random_uuid())
  on conflict (auth_user_id) do update
    set lease_until = excluded.lease_until,
        lease_token = excluded.lease_token
    where s.lease_until is null or s.lease_until <= clock_timestamp()
  returning s.lease_token into v_token;

  return v_token;
end;
$$;

-- Ends the owner's lease, but only for the holder of p_token: a call that
-- outlived its lease (which the next call then took) never frees the new
-- holder's lease. (Dropped first: an earlier draft took no token.)
drop function if exists public.funnelfox_leads_release_lease(uuid);
create or replace function public.funnelfox_leads_release_lease(p_data_key uuid, p_token uuid)
returns void
language sql
volatile
security invoker
set search_path = ''
as $$
  update public.funnelfox_leads_sync_state s
  set lease_until = null,
      lease_token = null
  where s.auth_user_id = p_data_key
    and s.lease_token = p_token
$$;

-- text -> timestamptz that yields null instead of raising on an impossible
-- value (2026-02-30, 2026-13-01): one malformed FunnelFox date must never fail
-- the whole candidates read. Callers still gate the input with an ISO-shape
-- regex, so words like 'now' / 'today' never reach the cast.
create or replace function public.leads_try_timestamptz(p_value text)
returns timestamptz
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  return p_value::timestamptz;
exception
  when others then
    return null;
end;
$$;

-- Lead candidates from Postgres for the server-side Leads list (clickhouse-users
-- leads_list / leads_overview merge them with the ClickHouse warehouse rows):
--
--   profile_leads       stored FunnelFox profiles with an email, not preview,
--                       not paid, not active, and no stored profile of the email
--                       linked to its own paying / subscribed subscription
--                       (header). One row per email: the earliest profile
--                       (lead_date = created_at, else the session date).
--                       campaign_path: the session's, else the funnel registry
--                       path for the profile's FunnelFox funnel id. Light columns
--                       only: user_agent / origin are read per page by the Edge
--                       (they are the bulk of a row). Newest first; at most
--                       p_profile_limit rows (null = all) -- the Edge merges the
--                       set in memory, so it bounds what one call transfers.
--   profile_leads_total / profile_leads_truncated
--                       the uncapped count, and whether the cap cut the list.
--   subscription_leads  mirrors src/services/leads.ts (subscription-only leads):
--                       the email is not in the live warehouse at all (any
--                       status), not active, not linked (above), and not already a
--                       profile lead; per subscription, a paid (price > 0)
--                       non-cancelled one is skipped, and an email with a priced
--                       subscription still inside its paid period is a paying
--                       customer (the browser excluded it through is_active_now);
--                       one row per email, the first qualifying subscription by
--                       subscription_id. funnel = the browser's
--                       mapSubscriptionFunnel over the funnel alias + title;
--                       lead_date = created_at, else period_starts_at (an
--                       impossible date gives null, never an error);
--                       customer_id = profile_id, else subscription_id.
--   kpis                over distinct emails: emails_found = warehouse U
--                       profiles (non-preview) U subscriptions; converted_excluded
--                       = emails with a successful payment; active_subs_excluded
--                       = active emails that are not paid (disjoint).
-- (Dropped first: an earlier draft had no p_profile_limit.)
drop function if exists public.leads_profile_candidates(uuid);
create or replace function public.leads_profile_candidates(p_data_key uuid, p_profile_limit integer default null)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with warehouse as (
    -- Every live warehouse email of the owner, and whether it ever paid.
    select
      lower(btrim(t.email)) as email,
      count(*) filter (where t.status = 'success') > 0 as paid
    from public.transactions t
    where t.auth_user_id = p_data_key
      and t.deleted_at is null
      and t.email is not null
      and btrim(t.email) <> ''
    group by 1
  ),
  active as (
    select k.email
    from jsonb_object_keys(public.active_funnelfox_subscription_emails(p_data_key)) as k(email)
  ),
  subscriptions as (
    -- Every FunnelFox subscription of the owner, with the flags the exclusions read.
    select
      e.email,
      nullif(regexp_replace(btrim(coalesce(s.profile_id, '')), '^pro_', '', 'i'), '') as profile_key,
      s.subscription_id,
      s.profile_id,
      s.created_at,
      s.funnel,
      s.raw_detail,
      s.raw_list,
      -- "looks like a paid, non-cancelled sub" (leads.ts): price > 0 and
      -- neither status contains 'cancel' nor renews = false.
      (coalesce(s.price, 0) > 0 and not (coalesce(s.status, '') ~* 'cancel' or s.renews is false)) as looks_paid,
      -- Priced and still inside its paid period, cancelled or not (the
      -- browser's is_active_now: not expired / unpaid, not sandbox).
      (
        coalesce(s.price, 0) > 0
        and s.period_ends_at > now()
        and coalesce(s.status, '') !~* 'expired|unpaid'
        and coalesce(s.raw_detail -> 'sandbox', s.raw_list -> 'sandbox') is distinct from 'true'::jsonb
      ) as paid_in_period
    from public.funnelfox_subscriptions s
    cross join lateral (select nullif(lower(btrim(s.normalized_email)), '') as email) e
    where s.auth_user_id = p_data_key
  ),
  linked_emails as (
    -- Emails of stored profiles whose OWN subscription shows a paying /
    -- subscribed customer, whatever email the checkout used (header).
    select distinct e.email
    from public.funnelfox_leads l
    cross join lateral (select nullif(lower(btrim(l.normalized_email)), '') as email) e
    join subscriptions s on s.profile_key = l.profile_id
    where l.auth_user_id = p_data_key
      and e.email is not null
      and (
        s.looks_paid
        or s.paid_in_period
        or exists (select 1 from warehouse w where w.email = s.email and w.paid)
        or exists (select 1 from active a where a.email = s.email)
      )
  ),
  profiles as (
    select distinct on (e.email)
      e.email,
      l.profile_id,
      coalesce(l.created_at, l.session_created_at) as lead_date,
      l.funnel_id,
      l.campaign_path,
      l.campaign_id,
      l.utm_source,
      l.media_buyer,
      l.country_code
    from public.funnelfox_leads l
    cross join lateral (select nullif(lower(btrim(l.normalized_email)), '') as email) e
    where l.auth_user_id = p_data_key
      and e.email is not null
      and not l.preview
    order by e.email, coalesce(l.created_at, l.session_created_at) asc nulls last, l.profile_id
  ),
  profile_leads as (
    select p.*, f.funnel_path as registry_path
    from profiles p
    left join public.funnels f on f.funnelfox_funnel_id = p.funnel_id
    where not exists (select 1 from warehouse w where w.email = p.email and w.paid)
      and not exists (select 1 from active a where a.email = p.email)
      and not exists (select 1 from linked_emails le where le.email = p.email)
  ),
  ranked_profile_leads as (
    select pl.*, row_number() over (order by pl.lead_date desc nulls last, pl.email) as rn
    from profile_leads pl
  ),
  subscription_rows as (
    select * from subscriptions s where s.email is not null
  ),
  subscription_leads as (
    select distinct on (r.email)
      r.email,
      r.subscription_id,
      r.profile_id,
      r.created_at,
      r.funnel,
      r.raw_detail,
      r.raw_list
    from subscription_rows r
    where not r.looks_paid
      and not exists (select 1 from subscription_rows q where q.email = r.email and q.paid_in_period)
      and not exists (select 1 from warehouse w where w.email = r.email)
      and not exists (select 1 from active a where a.email = r.email)
      and not exists (select 1 from linked_emails le where le.email = r.email)
      and not exists (select 1 from profile_leads p where p.email = r.email)
    order by r.email, r.subscription_id
  ),
  subscription_out as (
    select
      sl.email,
      coalesce(sl.profile_id, sl.subscription_id) as customer_id,
      coalesce(
        sl.created_at,
        case when ps.value ~ '^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?(Z|[+-]\d{2}(:?\d{2})?)?$'
          then public.leads_try_timestamptz(ps.value)
        end
      ) as lead_date,
      case
        when hay.value like '%past%' or hay.value like '%life%' then 'past_life'
        when hay.value like '%soul%' then 'soulmate'
        when hay.value like '%star%' then 'starseed'
        else 'unknown'
      end as funnel
    from subscription_leads sl
    -- The browser merges {...raw_list, ...raw_detail}: the detail's keys win.
    cross join lateral (
      select case
        when jsonb_typeof(sl.raw_detail) = 'object' and sl.raw_detail ? 'funnel' then sl.raw_detail -> 'funnel'
        else sl.raw_list -> 'funnel'
      end as value
    ) fn
    cross join lateral (
      select lower(concat_ws(' ', coalesce(nullif(fn.value ->> 'alias', ''), sl.funnel), fn.value ->> 'title')) as value
    ) hay
    cross join lateral (
      select coalesce(nullif(sl.raw_detail ->> 'period_starts_at', ''), nullif(sl.raw_list ->> 'period_starts_at', '')) as value
    ) ps
  )
  select jsonb_build_object(
    'profile_leads', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'profile_id', rp.profile_id,
          'email', rp.email,
          'lead_date', rp.lead_date,
          'funnel_id', rp.funnel_id,
          'campaign_path', coalesce(nullif(btrim(rp.campaign_path), ''), rp.registry_path),
          'campaign_id', nullif(btrim(rp.campaign_id), ''),
          'utm_source', nullif(btrim(rp.utm_source), ''),
          'media_buyer', nullif(btrim(rp.media_buyer), ''),
          'country', nullif(btrim(rp.country_code), '')
        )
        order by rp.rn
      )
      from ranked_profile_leads rp
      where p_profile_limit is null or rp.rn <= greatest(p_profile_limit, 0)
    ), '[]'::jsonb),
    'profile_leads_total', (select count(*) from profile_leads),
    'profile_leads_truncated', coalesce(
      p_profile_limit is not null and (select count(*) from profile_leads) > greatest(p_profile_limit, 0),
      false
    ),
    'subscription_leads', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'email', so.email,
          'lead_date', so.lead_date,
          'funnel', so.funnel,
          'customer_id', so.customer_id
        )
        order by so.lead_date desc nulls last, so.email
      )
      from subscription_out so
    ), '[]'::jsonb),
    'kpis', jsonb_build_object(
      'emails_found', (
        select count(*) from (
          select w.email from warehouse w
          union
          select p.email from profiles p
          union
          select r.email from subscription_rows r
        ) found
      ),
      'converted_excluded', (select count(*) from warehouse w where w.paid),
      'active_subs_excluded', (
        select count(*) from active a
        where not exists (select 1 from warehouse w where w.email = a.email and w.paid)
      )
    )
  )
$$;


-- ---------------------------------------------------------------------------
-- Grants. A new function is EXECUTE-able by PUBLIC (and Supabase's default
-- privileges add anon / authenticated), so each one is stated explicitly.
-- ---------------------------------------------------------------------------

revoke all on function public.funnelfox_leads_reconcile(uuid) from public, anon, authenticated;
revoke all on function public.funnelfox_leads_acquire_lease(uuid, int) from public, anon, authenticated;
revoke all on function public.funnelfox_leads_release_lease(uuid, uuid) from public, anon, authenticated;
revoke all on function public.leads_profile_candidates(uuid, integer) from public, anon, authenticated;
revoke all on function public.leads_try_timestamptz(text) from public, anon, authenticated;

grant execute on function public.funnelfox_leads_reconcile(uuid) to service_role;
grant execute on function public.funnelfox_leads_acquire_lease(uuid, int) to service_role;
grant execute on function public.funnelfox_leads_release_lease(uuid, uuid) to service_role;
grant execute on function public.leads_profile_candidates(uuid, integer) to service_role;
grant execute on function public.leads_try_timestamptz(text) to service_role;
