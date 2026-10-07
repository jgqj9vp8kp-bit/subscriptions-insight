-- Leads tab: the latest 1,000 leads, from a cached Postgres read (owner
-- decision 2026-10-07: speed over the whole history).
--
-- Why: the FunnelFox export filled public.funnelfox_leads (235k profile rows
-- with an email, 216k profile leads). leads_profile_candidates (202610060010)
-- ranks every one of them on each call: 5.8-12 s, against the 8 s
-- statement_timeout of the role PostgREST runs the Edge's service_role calls
-- under, so the Users -> Leads tab failed intermittently -- and it still showed
-- only the newest 50,000 profile leads.
--
-- Now the tab holds the newest 1,000 leads by lead date (clickhouse-users
-- leads_list / leads_overview trim the merged set to LEADS_RECENT_LIMIT, see
-- supabase/functions/_shared/clickhouse/leads.ts). The list, search, filters,
-- filter options and the lead counts (Total Leads, Leads Today, Leads Last 7
-- Days) cover those 1,000; Emails Found / Converted Excluded / Active Subs
-- Excluded stay whole-base counts (kpis below).
--
-- What this migration adds:
--   1. leads_recent_candidates_compute(p_data_key, p_limit) -> jsonb: the
--      candidates the newest-p_limit trim needs, nothing more:
--        profile_leads         (a) the newest p_limit + 1 representative profile
--                              leads (ties at the cut included) of emails
--                              OUTSIDE the warehouse, read newest-first along the
--                              created_at / session_created_at indexes and
--                              stopping there; plus (b) the representative
--                              profile of EVERY unpaid warehouse email, whatever
--                              its age -- the Edge merge folds it into the
--                              warehouse row ("both", lead_date = the earlier
--                              date), so all of them must be present for the
--                              trim to be exact;
--        profile_only_limited  more profile-only leads exist than (a) holds;
--        subscription_leads    unchanged (every subscription-only lead);
--        kpis                  unchanged, whole base (emails_found is counted as
--                              |non-preview profile emails| + |(warehouse U
--                              subscription emails) not among them|, the same
--                              number as the old three-way union).
--      Same exclusions (paid, active, linked through the profile's own
--      subscription), same representative profile per email (earliest
--      non-preview: lead_date asc nulls last, then profile_id) and same field
--      derivations (campaign_path falls back to the registry funnels.funnel_path)
--      as leads_profile_candidates. Proven on production (2026-10-07) against the
--      old RPC's CTEs: 0 differences on every field of the profile-only rows
--      inside the cut, of the 5,958 warehouse-email profiles, of the
--      subscription leads and of the KPIs (the paid flag's coalesce(..., false)
--      was added after that run; it only matters for an email whose live
--      transactions all have a NULL status, none today). It relies on funnelfox_leads.
--      normalized_email being stored normalized (lower(btrim()), what the sync
--      writes) so its equality lookups follow (auth_user_id, normalized_email).
--      PL/pgSQL running the query through EXECUTE ... USING: the statement is
--      planned with the key and the limit as constants every call (a one-shot
--      custom plan), exactly the plan that was measured; a LANGUAGE sql body
--      would be planned with them as unknown parameters (FETCH FIRST then
--      estimates 10% of the table).
--   2. public.funnelfox_leads_candidates_cache: one row per data key, the last
--      computed payload. RLS on, no policies, no browser grants (service-role /
--      cron state, like fb_cron_config).
--   3. leads_refresh_recent_candidates(p_data_key default workspace, p_limit
--      default 1000) -> jsonb {computed_at, duration_ms, profile_leads}:
--      computes and stores the cache row. Run by pg_cron (below) every 5 minutes.
--   4. leads_recent_candidates(p_data_key, p_limit default 1000,
--      p_max_age_seconds default 900) -> jsonb: what the Edge calls. Serves the
--      cache row when it was computed for this key and limit within the max age
--      (cached: true); otherwise computes inline, stores it and serves that
--      (cached: false). The payload carries computed_at either way. Cold reads of
--      the 116 MB heap while the export churns the buffer cache take 2.5-10 s, so
--      the Edge path must not compute on every load. A plain load accepts 900 s;
--      a refresh request (Refresh button, after a sync) asks for 60 s, so it
--      recomputes unless the cron just ran.
--      Known transient: the Edge merges this (up to ~5 min old) payload with the
--      LIVE ClickHouse warehouse rows. Until the next tick, an old profile lead
--      whose first transaction arrived after computed_at shows as a fresh
--      warehouse lead (its old profile is not in the payload, so it cannot fold
--      into "both" with the earlier date), and a recent profile-only lead that
--      just paid stays listed.
--   5. pg_cron job funnelfox-leads-recent-cache (*/5 * * * *): select
--      public.leads_refresh_recent_candidates(); -- pure SQL, no HTTP.
--
-- All three functions are SECURITY INVOKER with search_path '' and EXECUTE for
-- service_role only (Edge passes ctx.tenantKey); pg_cron runs as postgres. A
-- null key matches nothing and is never cached; an unknown key (no auth.users
-- row) is computed (empty) but not cached. leads_profile_candidates stays: the
-- Edge falls back to it while this migration is not applied yet.
--
-- APPLY ORDER: after 202610060010 (guarded below; independent of 202610060011).
-- The Edge build that calls leads_recent_candidates may be deployed before or
-- after it (it falls back to leads_profile_candidates on PGRST202 with the old
-- 50,000 cap -- a 1,000 cap there would drop the older profiles of unpaid
-- warehouse emails, which the newest-1,000 cut needs; slow, as before). Apply this
-- file on its own (README "FunnelFox Leads export"), never with supabase db
-- push while earlier-sorting migrations are pending. One transaction.

do $$
begin
  if to_regprocedure('public.leads_profile_candidates(uuid, integer)') is null
    or to_regprocedure('public.leads_try_timestamptz(text)') is null
    or to_regprocedure('public.active_funnelfox_subscription_emails(uuid)') is null
    or to_regprocedure('public.workspace_data_key()') is null then
    raise exception using
      errcode = 'P0001',
      message = 'leads_recent_candidates: 202610060010_funnelfox_leads_export.sql has not been applied',
      hint = 'Apply 202610060010 first: this migration reads funnelfox_leads.preview, leads_try_timestamptz and the '
        || 'transactions_live_owner_email_idx index it adds.';
  end if;
end
$$;


-- ---------------------------------------------------------------------------
-- 1. The candidates for the newest-p_limit lead set
-- ---------------------------------------------------------------------------

-- p_limit: null -> 1000, clamped to [0, 100000]. $1 = p_data_key, $2 = the limit.
create or replace function public.leads_recent_candidates_compute(p_data_key uuid, p_limit integer default 1000)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $fn$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 1000), 0), 100000);
  v_result jsonb;
begin
  execute $q$
  with
  warehouse as (
    -- Every live warehouse email of the owner, and whether it ever paid. Two-valued
    -- like the old RPC's count(*) filter (...) > 0: transactions.status is nullable,
    -- and a bare bool_or() over only-NULL statuses is NULL, which `not w.paid` in
    -- warehouse_profiles would treat as paid (dropping that email's profile).
    select lower(btrim(t.email)) as email, coalesce(bool_or(t.status = 'success'), false) as paid
    from public.transactions t
    where t.auth_user_id = $1 and t.deleted_at is null and t.email is not null and btrim(t.email) <> ''
    group by 1
  ),
  sets as (
    -- Active emails as a jsonb object: the ? operator is a key lookup, so the
    -- newest-first scans below stay nested loops that stop at the limit.
    select public.active_funnelfox_subscription_emails($1) as act
  ),
  active as (
    select k.email from sets cross join lateral jsonb_object_keys(sets.act) as k(email)
  ),
  subscriptions as (
    select e.email,
      nullif(regexp_replace(btrim(coalesce(s.profile_id, '')), '^pro_', '', 'i'), '') as profile_key,
      s.subscription_id, s.profile_id, s.created_at, s.funnel, s.raw_detail, s.raw_list,
      (coalesce(s.price, 0) > 0 and not (coalesce(s.status, '') ~* 'cancel' or s.renews is false)) as looks_paid,
      (
        coalesce(s.price, 0) > 0
        and s.period_ends_at > now()
        and coalesce(s.status, '') !~* 'expired|unpaid'
        and coalesce(s.raw_detail -> 'sandbox', s.raw_list -> 'sandbox') is distinct from 'true'::jsonb
      ) as paid_in_period
    from public.funnelfox_subscriptions s
    cross join lateral (select nullif(lower(btrim(s.normalized_email)), '') as email) e
    where s.auth_user_id = $1
  ),
  paying as (
    -- Profile keys whose OWN subscription shows a paying / subscribed customer:
    -- every stored profile email behind such a key is a linked email (never a lead).
    select coalesce(jsonb_object_agg(k.profile_key, true), '{}'::jsonb) as keys
    from (
      select distinct s.profile_key
      from subscriptions s cross join sets
      where s.profile_key is not null
        and (s.looks_paid or s.paid_in_period
          or exists (select 1 from warehouse w where w.email = s.email and w.paid)
          or (s.email is not null and sets.act ? s.email))
    ) k
  ),
  profile_only as (
    -- Representative (earliest non-preview) profiles of emails outside the
    -- warehouse, newest first, stopping after p_limit + 1 leads (ties at the cut
    -- included). Two streams so each follows an index: the dated rows by
    -- created_at, then the rows without created_at (lead_date =
    -- session_created_at, undated last).
    select * from (
      select l.profile_id, l.normalized_email as email, l.created_at as lead_date,
        l.funnel_id, l.campaign_path, l.campaign_id, l.utm_source, l.media_buyer, l.country_code
      from public.funnelfox_leads l cross join sets cross join paying
      where l.auth_user_id = $1 and not l.preview and l.normalized_email is not null and l.normalized_email <> ''
        and l.created_at is not null
        and not exists (
          select 1 from public.transactions t
          where t.auth_user_id = $1 and t.deleted_at is null and t.email is not null
            and lower(btrim(t.email)) = l.normalized_email)
        and not (sets.act ? l.normalized_email)
        and not exists (
          select 1 from public.funnelfox_leads o
          where o.auth_user_id = $1 and o.normalized_email = l.normalized_email and not o.preview
            and o.profile_id <> l.profile_id
            and coalesce(o.created_at, o.session_created_at) is not null
            and (coalesce(o.created_at, o.session_created_at) < l.created_at
              or (coalesce(o.created_at, o.session_created_at) = l.created_at and o.profile_id < l.profile_id)))
        and not exists (
          select 1 from public.funnelfox_leads x
          where x.auth_user_id = $1 and x.normalized_email = l.normalized_email and paying.keys ? x.profile_id)
      order by l.created_at desc
      fetch first ($2 + 1) rows with ties
    ) dated
    union all
    select * from (
      select l.profile_id, l.normalized_email as email, l.session_created_at as lead_date,
        l.funnel_id, l.campaign_path, l.campaign_id, l.utm_source, l.media_buyer, l.country_code
      from public.funnelfox_leads l cross join sets cross join paying
      where l.auth_user_id = $1 and not l.preview and l.normalized_email is not null and l.normalized_email <> ''
        and l.created_at is null
        and not exists (
          select 1 from public.transactions t
          where t.auth_user_id = $1 and t.deleted_at is null and t.email is not null
            and lower(btrim(t.email)) = l.normalized_email)
        and not (sets.act ? l.normalized_email)
        and not exists (
          select 1 from public.funnelfox_leads o
          where o.auth_user_id = $1 and o.normalized_email = l.normalized_email and not o.preview
            and o.profile_id <> l.profile_id
            and (
              (coalesce(o.created_at, o.session_created_at) is not null
                and (l.session_created_at is null
                  or coalesce(o.created_at, o.session_created_at) < l.session_created_at
                  or (coalesce(o.created_at, o.session_created_at) = l.session_created_at and o.profile_id < l.profile_id)))
              or (coalesce(o.created_at, o.session_created_at) is null and l.session_created_at is null
                and o.profile_id < l.profile_id)))
        and not exists (
          select 1 from public.funnelfox_leads x
          where x.auth_user_id = $1 and x.normalized_email = l.normalized_email and paying.keys ? x.profile_id)
      order by l.session_created_at desc nulls last
      fetch first ($2 + 1) rows with ties
    ) undated
  ),
  warehouse_profiles as (
    -- The representative profile of every unpaid warehouse email, whatever its
    -- age: the merge folds it into the warehouse row (both, the earlier date wins).
    select r.*
    from warehouse w cross join sets cross join paying
    cross join lateral (
      select l.profile_id, l.normalized_email as email, coalesce(l.created_at, l.session_created_at) as lead_date,
        l.funnel_id, l.campaign_path, l.campaign_id, l.utm_source, l.media_buyer, l.country_code
      from public.funnelfox_leads l
      where l.auth_user_id = $1 and l.normalized_email = w.email and not l.preview
      order by coalesce(l.created_at, l.session_created_at) asc nulls last, l.profile_id
      limit 1
    ) r
    where not w.paid
      and not (sets.act ? w.email)
      and not exists (
        select 1 from public.funnelfox_leads x
        where x.auth_user_id = $1 and x.normalized_email = w.email and paying.keys ? x.profile_id)
  ),
  loaded_profiles as (
    select * from profile_only
    union all
    select * from warehouse_profiles
  ),
  profile_emails as materialized (
    -- Distinct emails of the stored non-preview profiles (one index pass, read twice
    -- by emails_found).
    select distinct l.normalized_email as email from public.funnelfox_leads l
    where l.auth_user_id = $1 and l.normalized_email is not null and l.normalized_email <> '' and not l.preview
  ),
  subscription_rows as (
    select * from subscriptions s where s.email is not null
  ),
  subscription_leads as (
    select distinct on (r.email)
      r.email, r.subscription_id, r.profile_id, r.created_at, r.funnel, r.raw_detail, r.raw_list
    from subscription_rows r cross join sets cross join paying
    where not r.looks_paid
      and not exists (select 1 from subscription_rows q where q.email = r.email and q.paid_in_period)
      and not exists (select 1 from warehouse w where w.email = r.email)
      and not (sets.act ? r.email)
      and not exists (
        select 1 from public.funnelfox_leads x
        where x.auth_user_id = $1 and x.normalized_email = r.email and paying.keys ? x.profile_id)
      -- Not a profile lead either. With the checks above (outside the warehouse,
      -- not active, not linked) that is: no stored non-preview profile has this email.
      and not exists (
        select 1 from public.funnelfox_leads p
        where p.auth_user_id = $1 and p.normalized_email = r.email and not p.preview)
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
      select jsonb_agg(jsonb_build_object(
          'profile_id', lp.profile_id,
          'email', lp.email,
          'lead_date', lp.lead_date,
          'funnel_id', lp.funnel_id,
          'campaign_path', coalesce(nullif(btrim(lp.campaign_path), ''), f.funnel_path),
          'campaign_id', nullif(btrim(lp.campaign_id), ''),
          'utm_source', nullif(btrim(lp.utm_source), ''),
          'media_buyer', nullif(btrim(lp.media_buyer), ''),
          'country', nullif(btrim(lp.country_code), '')
        ) order by lp.lead_date desc nulls last, lp.email)
      from loaded_profiles lp
      left join public.funnels f on f.funnelfox_funnel_id = lp.funnel_id
    ), '[]'::jsonb),
    'profile_only_limited', (select count(*) from profile_only) > greatest($2, 0),
    'subscription_leads', coalesce((
      select jsonb_agg(jsonb_build_object(
          'email', so.email, 'lead_date', so.lead_date, 'funnel', so.funnel, 'customer_id', so.customer_id
        ) order by so.lead_date desc nulls last, so.email)
      from subscription_out so
    ), '[]'::jsonb),
    'kpis', jsonb_build_object(
      'emails_found', (
        (select count(*) from profile_emails)
        + (select count(*) from (
            select w.email from warehouse w
            union
            select r.email from subscription_rows r
          ) ws
          where not exists (select 1 from profile_emails p where p.email = ws.email))
      ),
      'converted_excluded', (select count(*) from warehouse w where w.paid),
      'active_subs_excluded', (
        select count(*) from active a
        where not exists (select 1 from warehouse w where w.email = a.email and w.paid)
      )
    )
  )
  $q$
  into v_result
  using p_data_key, v_limit;
  return v_result;
end;
$fn$;


-- ---------------------------------------------------------------------------
-- 2. Cache
-- ---------------------------------------------------------------------------

create table if not exists public.funnelfox_leads_candidates_cache (
  auth_user_id uuid primary key references auth.users (id) on delete cascade,
  -- The p_limit the payload was computed for (a different limit recomputes).
  profile_limit integer not null,
  computed_at timestamptz not null,
  duration_ms integer,
  payload jsonb not null
);

comment on table public.funnelfox_leads_candidates_cache is
  'Last leads_recent_candidates_compute payload per data key (Leads tab). Written by leads_recent_candidates / '
  'leads_refresh_recent_candidates (service_role, pg_cron); never read by the browser.';

-- Service-role / cron state: RLS on with no policies, and no browser privilege at all.
alter table public.funnelfox_leads_candidates_cache enable row level security;
revoke all on table public.funnelfox_leads_candidates_cache from public, anon, authenticated;
grant select, insert, update, delete on table public.funnelfox_leads_candidates_cache to service_role;


-- ---------------------------------------------------------------------------
-- 3. Refresh (pg_cron) and 4. the cached read (Edge)
-- ---------------------------------------------------------------------------

-- Computes and stores the cache row. p_data_key null -> the workspace data key
-- (the cron passes none); no workspace -> null (nothing to do). Returns a small
-- summary, never the payload (the cron logs it).
create or replace function public.leads_refresh_recent_candidates(p_data_key uuid default null, p_limit integer default 1000)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_key uuid := coalesce(p_data_key, public.workspace_data_key());
  v_limit integer := least(greatest(coalesce(p_limit, 1000), 0), 100000);
  v_started timestamptz;
  v_payload jsonb;
  v_duration integer;
begin
  if v_key is null then
    raise notice 'workspace is not bootstrapped — leads recent candidates refresh skipped';
    return null;
  end if;

  v_started := clock_timestamp();
  v_payload := public.leads_recent_candidates_compute(v_key, v_limit);
  v_duration := floor(extract(epoch from clock_timestamp() - v_started) * 1000)::integer;

  begin
    insert into public.funnelfox_leads_candidates_cache as c (auth_user_id, profile_limit, computed_at, duration_ms, payload)
    values (v_key, v_limit, v_started, v_duration, v_payload)
    on conflict (auth_user_id) do update
      set profile_limit = excluded.profile_limit,
          computed_at = excluded.computed_at,
          duration_ms = excluded.duration_ms,
          payload = excluded.payload
      -- A slower call that started earlier never overwrites a newer payload.
      where c.computed_at <= excluded.computed_at;
  exception
    when foreign_key_violation then
      -- Not an account: computed (empty), not cached.
      null;
  end;

  return jsonb_build_object(
    'computed_at', v_started,
    'duration_ms', v_duration,
    'profile_leads', jsonb_array_length(coalesce(v_payload -> 'profile_leads', '[]'::jsonb))
  );
end;
$$;

-- The Edge read: the cache row when it was computed for this key and limit at
-- most p_max_age_seconds ago (null -> 900, negative -> 0 = always recompute),
-- else an inline compute that is stored for the next call. VOLATILE because it
-- may write (PostgREST runs STABLE functions read-only). The payload gains
-- computed_at and cached.
create or replace function public.leads_recent_candidates(
  p_data_key uuid,
  p_limit integer default 1000,
  p_max_age_seconds integer default 900
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 1000), 0), 100000);
  v_max_age integer := greatest(coalesce(p_max_age_seconds, 900), 0);
  v_cached public.funnelfox_leads_candidates_cache%rowtype;
  v_started timestamptz;
  v_payload jsonb;
  v_duration integer;
begin
  if p_data_key is not null then
    select * into v_cached
    from public.funnelfox_leads_candidates_cache c
    where c.auth_user_id = p_data_key
      and c.profile_limit = v_limit
      and c.computed_at >= clock_timestamp() - make_interval(secs => v_max_age);
    if found then
      return v_cached.payload || jsonb_build_object('computed_at', v_cached.computed_at, 'cached', true);
    end if;
  end if;

  v_started := clock_timestamp();
  v_payload := public.leads_recent_candidates_compute(p_data_key, v_limit);
  v_duration := floor(extract(epoch from clock_timestamp() - v_started) * 1000)::integer;

  if p_data_key is not null then
    begin
      insert into public.funnelfox_leads_candidates_cache as c (auth_user_id, profile_limit, computed_at, duration_ms, payload)
      values (p_data_key, v_limit, v_started, v_duration, v_payload)
      on conflict (auth_user_id) do update
        set profile_limit = excluded.profile_limit,
            computed_at = excluded.computed_at,
            duration_ms = excluded.duration_ms,
            payload = excluded.payload
        where c.computed_at <= excluded.computed_at;
    exception
      when foreign_key_violation then
        null;
    end;
  end if;

  return v_payload || jsonb_build_object('computed_at', v_started, 'cached', false);
end;
$$;


-- ---------------------------------------------------------------------------
-- Grants. A new function is EXECUTE-able by PUBLIC (and Supabase's default
-- privileges add anon / authenticated), so each one is stated explicitly.
-- ---------------------------------------------------------------------------

revoke all on function public.leads_recent_candidates_compute(uuid, integer) from public, anon, authenticated;
revoke all on function public.leads_refresh_recent_candidates(uuid, integer) from public, anon, authenticated;
revoke all on function public.leads_recent_candidates(uuid, integer, integer) from public, anon, authenticated;

grant execute on function public.leads_recent_candidates_compute(uuid, integer) to service_role;
grant execute on function public.leads_refresh_recent_candidates(uuid, integer) to service_role;
grant execute on function public.leads_recent_candidates(uuid, integer, integer) to service_role;


-- ---------------------------------------------------------------------------
-- 5. pg_cron (installed by 202607230002): refresh the cache every 5 minutes, so
-- the Edge (max age 900 s) almost always reads it. Pure SQL, no HTTP. Runs as
-- postgres. Rescheduled idempotently.
-- ---------------------------------------------------------------------------

do $$
begin
  perform cron.unschedule('funnelfox-leads-recent-cache');
exception when others then null;
end $$;

select cron.schedule(
  'funnelfox-leads-recent-cache',
  '*/5 * * * *',
  $$select public.leads_refresh_recent_candidates()$$
);
