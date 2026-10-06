-- Phase 0 isolation fix: owner-scoped active-subscription RPC.
--
-- Bug (plan §3, "Known isolation bugs"): active_funnelfox_subscription_emails()
-- has NO owner predicate. It is `security invoker` and was meant to be scoped by
-- funnelfox_subscriptions' own-row RLS ("read own") -- which holds for a browser
-- (authenticated) caller. But the Cohorts overlay calls it from Edge through the
-- SERVICE-ROLE client (supabase/functions/_shared/clickhouse/cohortSubscriptions.ts,
-- activeSubscriptionsByEmail -> supabase.rpc("active_funnelfox_subscription_emails")).
-- service_role has BYPASSRLS, so that call returns the active subscriptions of
-- EVERY account in the deployment, merged into one email map: a cross-tenant read.
--
-- Fix: an explicit-owner overload that filters on the owner column
-- (funnelfox_subscriptions.auth_user_id = p_data_key) instead of trusting RLS.
-- Edge passes the workspace data key (ctx.tenantKey), never the caller. It is
-- service_role only: a browser caller must never be able to name a tenant.
--
-- The no-arg function is KEPT (identical body): for an authenticated caller it is
-- correctly RLS-scoped to auth.uid(), and the currently deployed Edge code still
-- calls it until the fan-out wave switches cohortSubscriptions.ts to the overload.
-- It is revoked from anon (and from PUBLIC, through which anon also had EXECUTE
-- by Postgres default); authenticated and service_role keep EXECUTE explicitly so
-- today's deploy keeps working.

create or replace function public.active_funnelfox_subscription_emails(p_data_key uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  -- Same "active now" + sandbox-exclusion definition as the no-arg function
  -- (202607260001); the only difference is the explicit owner predicate.
  -- A null p_data_key matches nothing ('{}'), never "all owners".
  select coalesce(jsonb_object_agg(email, ids), '{}'::jsonb)
  from (
    select
      lower(btrim(s.normalized_email)) as email,
      jsonb_agg(distinct s.subscription_id) as ids
    from public.funnelfox_subscriptions s
    where s.auth_user_id = p_data_key
      and s.normalized_email is not null
      and btrim(s.normalized_email) <> ''
      and s.renews = true
      and coalesce(s.status, '') !~* 'expired|unpaid|failed|cancel'
      and s.period_ends_at > now()
      and coalesce(
        (s.raw_detail ->> 'sandbox')::boolean,
        (s.raw_list ->> 'sandbox')::boolean,
        false
      ) = false
    group by 1
  ) grouped
$$;

revoke all on function public.active_funnelfox_subscription_emails(uuid) from public, anon, authenticated;
grant execute on function public.active_funnelfox_subscription_emails(uuid) to service_role;

-- Legacy no-arg form: authenticated (RLS-scoped) and service_role (deprecated
-- cross-tenant caller, see header) only. Never anon.
revoke all on function public.active_funnelfox_subscription_emails() from public, anon;
grant execute on function public.active_funnelfox_subscription_emails() to authenticated, service_role;
