-- Exclude FunnelFox sandbox/test-mode subscriptions from the Cohorts active-
-- subscription overlay.
--
-- Bug: a cohort showed far more Active Subscriptions than it had trials (e.g. 70
-- active vs 9 trials). Root cause — the overlay counts every active subscription
-- sharing an email with a cohort member, and FunnelFox test/sandbox emails carry
-- dozens of "active" sandbox subscriptions apiece. One reused QA email that ran a
-- single trial back in March dumped all of its sandbox subs into that one cohort.
--
-- FunnelFox marks these with a top-level `sandbox` boolean on the subscription
-- object. It is not persisted as a normalized column, so read it from the raw
-- payload (detail wins over list, mirroring subscriptionRowToClean's merge). Only
-- an explicit true excludes a row, so live subs (sandbox false / absent) are kept.
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
      and coalesce(
        (raw_detail ->> 'sandbox')::boolean,
        (raw_list ->> 'sandbox')::boolean,
        false
      ) = false
    group by 1
  ) grouped
$$;

grant execute on function public.active_funnelfox_subscription_emails() to authenticated;
