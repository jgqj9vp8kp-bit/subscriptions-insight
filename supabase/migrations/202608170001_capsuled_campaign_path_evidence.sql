-- Campaign -> funnel-path evidence for the Capsuled traffic snapshot
-- (Cohorts Spend/CAC defect, 2026-08-17).
--
-- capsuled-facebook-sync rebuilds the data_snapshots(facebook_traffic) payload
-- after every sync, but it only knows Meta campaign NAMES — and the client
-- joins traffic to cohorts by (date, campaign_path). This RPC returns the
-- observed (campaign_id, campaign_path) pairs from successful trial
-- transactions with distinct-user counts; the resolution RULE (unique path,
-- >= 3 users, Layer A aliases) lives in TS (capsuledTraffic.ts) where it is
-- unit-tested — the SQL is deliberately just the mechanical GROUP BY.
--
-- security invoker: called with the service-role client by the sync (RLS is
-- bypassed there); anyone else falls under transactions RLS anyway. Default
-- PUBLIC execute is revoked — this is an internal helper, not client API.
create or replace function public.capsuled_campaign_path_evidence(p_auth_user_id uuid)
returns table(campaign_id text, campaign_path text, trial_users bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select
    t.normalized_payload->>'campaign_id' as campaign_id,
    lower(btrim(t.normalized_payload->>'campaign_path')) as campaign_path,
    count(distinct t.normalized_payload->>'user_id') as trial_users
  from public.transactions t
  where t.deleted_at is null
    and t.auth_user_id = p_auth_user_id
    and t.normalized_payload->>'transaction_type' = 'trial'
    and t.normalized_payload->>'status' = 'success'
    and coalesce(t.normalized_payload->>'campaign_id', '') <> ''
    and coalesce(t.normalized_payload->>'campaign_path', '') <> ''
  group by 1, 2
$$;

revoke execute on function public.capsuled_campaign_path_evidence(uuid) from public, anon, authenticated;
grant execute on function public.capsuled_campaign_path_evidence(uuid) to service_role;
