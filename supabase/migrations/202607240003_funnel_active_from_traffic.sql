-- Active now means "traffic is flowing", not "published in FunnelFox".
--
-- A funnel is active when its funnel_path (== ff_campaign_path in a
-- transaction, minus the leading slash) has at least one SUCCESSFUL
-- transaction within the trailing window (default 30 days). The flag stays a
-- stored column so Cohorts and other pages read it with one cheap query; this
-- function recomputes it, and a manual toggle can still override between runs
-- (the daily cron below re-derives it on the next tick).
--
-- security definer: the function updates public.funnels (shared registry) and
-- reads public.transactions, which is per-user RLS-scoped. Definer runs as the
-- migration owner (BYPASSRLS in Supabase managed Postgres) so it sees ALL
-- traffic across the deployment, which is what "is this funnel live" means --
-- traffic is traffic regardless of which account owns the rows.
create or replace function public.recompute_funnel_active_status(p_window_days int default 30)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_window int := greatest(coalesce(p_window_days, 30), 1);
  v_cutoff timestamptz := now() - make_interval(days => v_window);
  v_activated int;
  v_deactivated int;
  v_active_total int;
begin
  with active_paths as (
    select distinct ltrim(normalized_payload->'metadata'->>'ff_campaign_path', '/') as path
    from public.transactions
    where deleted_at is null
      and status = 'success'
      and event_time >= v_cutoff
      and nullif(ltrim(normalized_payload->'metadata'->>'ff_campaign_path', '/'), '') is not null
  ),
  computed as (
    select f.id, (f.funnel_path in (select path from active_paths)) as should_be_active, f.is_active
    from public.funnels f
  ),
  changed as (
    update public.funnels f
    set is_active = c.should_be_active
    from computed c
    where f.id = c.id
      and c.is_active is distinct from c.should_be_active
    returning c.should_be_active
  )
  select
    count(*) filter (where should_be_active),
    count(*) filter (where not should_be_active)
  into v_activated, v_deactivated
  from changed;

  select count(*) into v_active_total from public.funnels where is_active;

  return jsonb_build_object(
    'window_days', v_window,
    'activated', coalesce(v_activated, 0),
    'deactivated', coalesce(v_deactivated, 0),
    'active_total', v_active_total
  );
end;
$$;

revoke all on function public.recompute_funnel_active_status(int) from public;
grant execute on function public.recompute_funnel_active_status(int) to authenticated;

-- Daily recompute (06:00 UTC, after the FB warehouse tick at 05:30). Pure SQL,
-- so pg_cron calls it directly -- no pg_net/HTTP/secret like the FB tick, which
-- only needed HTTP because it reached ClickHouse. pg_cron was already installed
-- by 202607230002_fb_daily_cron.sql.
do $$
begin
  perform cron.unschedule('funnels-active-from-traffic');
exception when others then
  null;
end
$$;

select cron.schedule(
  'funnels-active-from-traffic',
  '0 6 * * *',
  $$select public.recompute_funnel_active_status(30)$$
);
