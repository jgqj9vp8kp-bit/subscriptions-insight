-- Active FunnelFox subscriptions, grouped by normalized email, for the Cohorts
-- server-side active-subscription overlay (clickhouse-cohorts joins these emails
-- to the cohort snapshot). Returns ONE jsonb object {email: [subscription_id,…]}
-- so it dodges PostgREST's ~1000-row response cap and keeps the "active now"
-- definition in a single place.
--
-- "Active now" mirrors isSubscriptionActiveNow (the definition the client cohort
-- compute uses): renews = true, status not expired/unpaid/failed/cancel, and
-- period_ends_at strictly in the future. security invoker + the table's RLS
-- ("read own") scope this to the calling user; now() is evaluated server-side.
create or replace function public.active_funnelfox_subscription_emails()
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(jsonb_object_agg(email, ids), '{}'::jsonb)
  from (
    select
      lower(btrim(normalized_email)) as email,
      jsonb_agg(distinct subscription_id) as ids
    from public.funnelfox_subscriptions
    where normalized_email is not null
      and btrim(normalized_email) <> ''
      and renews = true
      and coalesce(status, '') !~* 'expired|unpaid|failed|cancel'
      and period_ends_at > now()
    group by 1
  ) grouped
$$;

grant execute on function public.active_funnelfox_subscription_emails() to authenticated;
