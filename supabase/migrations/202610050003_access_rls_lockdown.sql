-- Access control Phase 1: RLS lockdown (plan §12 items 2-5 and 8).
--
-- Plan §26 order: access_core (202610050002) + `select public.bootstrap_workspace(...)`
-- (step 4), the access-aware Edge deploy (step 6) and the frontend deploy
-- (step 7) come FIRST; this migration is step 8. Its first statement refuses to
-- run before bootstrap: every policy below keys on the workspace
-- (app.data_key() / app.is_active_member()), so applying it to a database with
-- no workspace row would lock every account, the data owner included, out of
-- every table. Apply it as ONE transaction (supabase db push does) so the guard
-- aborts the whole file.
--
-- What it does:
--   1. RESTRICTIVE `lockdown_active_member` ((select app.is_active_member())) on
--      every public table `authenticated` can reach except the access tables
--      (202610050002 already gates those). A disabled member's still-valid JWT
--      and a signed-up account that is not a member read and write nothing.
--   2. RESTRICTIVE `lockdown_data_key` (owner column = (select app.data_key()))
--      on tenant data. Other accounts' private copies (made by self-provisioning
--      syncs, plan G1) become invisible, and employees never read tenant tables
--      through PostgREST (plan D2): they get data through Edge, which binds
--      ctx.tenantKey.
--   3. Registry: writes need funnels.manage AND funnel scope all.
--      replace_funnel_tags / recompute_funnel_active_status keep their public
--      names (the Funnels page calls them) but become permission-checked
--      wrappers over app.* internals; the daily recompute cron calls the internal
--      function directly; the recompute only counts data-key traffic.
--   4. Sync-state tables: the browser never writes them. grep of src/ finds only
--      SELECTs, on funnelfox_subscriptions_sync_state
--      (src/services/funnelfoxSubscriptionsSync.ts) and funnelfox_leads_sync_state
--      (src/services/funnelfoxLeads.ts); every writer is Edge with the
--      service-role client. Their authenticated INSERT/UPDATE/DELETE policies are
--      dropped and the write grants revoked; the read policies stay.
--   5. RPCs: support_apply_answer_matches -> service_role only; publish_report ->
--      definer with reports.publish, and the forgeable direct INSERT policy on
--      report_versions is dropped (publish_report is its only writer).
--   6. Cron (item 8): fb_cron_config must belong to the data owner (asserted);
--      the FB / FunnelFox cron senders post the workspace data key; the Sent
--      backfill tick reads only the data owner's sync state.
--
-- Every public table created by migrations up to 202610050002, classified:
--   (a) tenant data, written under the data owner -> active member + data key:
--       transactions, import_batches, import_batch_files (through its batch),
--       api_export_logs, capsuled_facebook_syncs, capsuled_facebook_stats,
--       funnelfox_leads, funnelfox_leads_sync_state, funnelfox_subscriptions,
--       funnelfox_subscriptions_sync_state, clickhouse_transaction_sync_state,
--       clickhouse_validation_state, clickhouse_cohort_snapshot_state,
--       support_messages, support_import_batches, support_requests,
--       support_mail_sync_state, support_classification_state, support_replies,
--       facebook_sync_runs, facebook_import_batches, facebook_raw_payloads,
--       facebook_batch_dq, facebook_campaign_mapping,
--       facebook_campaign_funnel_map, facebook_buyer_mapping,
--       facebook_known_gaps, facebook_sync_run_requests, and data_snapshots
--       rows of the dataset types (palmer, funnelfox_subscriptions,
--       facebook_traffic, and any type added later).
--   (b) actor-owned rows; own-row RLS unchanged -> active member only:
--       reports, report_versions, report_tasks, report_notes, report_targets,
--       report_settings, project_forecasts, forecast_scenarios,
--       ai_recommendations, ai_feedback, ai_assistant_runs, report_ai_runs,
--       api_keys, and data_snapshots rows of the per-user UI settings types
--       (forecasting_settings, cohorts_ui_settings).
--   (c) shared registry -> active member; writes need funnels.manage + scope
--       all: funnels, tags, funnel_tags.
--   (d) access tables (202610050002, already locked; untouched here):
--       workspaces, access_roles, workspace_members, member_scope_rules,
--       member_scope_values, access_audit_log, access_denial_counters.
--   (e) service-role-only config (RLS on, no policies, holds cron secrets):
--       fb_cron_config, support_mail_cron_config -> browser grants revoked.
--
-- Deferred to Phase 5 (plan §12.6, they wait for their Edge replacements):
-- api_keys INSERT/UPDATE and support_import_batches / support_requests client
-- writes keep their own-row write policies. Until then they are UI-gated to
-- rawAccess and covered by the RESTRICTIVE policies above.
--
-- Every helper is used in the `(select app.fn())` initPlan form, so it is
-- evaluated once per statement, not once per row.


-- ---------------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------------

do $$
declare
  v_data_key uuid;
  v_cron_owner uuid;
begin
  select w.data_key into v_data_key from public.workspaces w limit 1;
  if v_data_key is null then
    raise exception using
      errcode = 'P0001',
      message = 'access_rls_lockdown: public.workspaces is empty, the workspace is not bootstrapped',
      hint = 'Run select public.bootstrap_workspace(''<data owner uuid>'', ''SubEngine''); and deploy the '
        || 'access-aware Edge functions and frontend first (plan §26 steps 4-7). Applied before bootstrap, '
        || 'this migration would lock every account, the data owner included, out of every table.';
  end if;

  -- The FB and FunnelFox crons have been writing under this account. If it is
  -- not the data key, the workspace was bootstrapped with the wrong owner or the
  -- pre-flight (plan §26.1) was skipped: stop rather than hide that data.
  select c.auth_user_id into v_cron_owner from public.fb_cron_config c where c.id;
  if found and v_cron_owner is distinct from v_data_key then
    raise exception using
      errcode = 'P0001',
      message = 'access_rls_lockdown: fb_cron_config.auth_user_id is not the workspace data key',
      hint = 'Re-run the pre-flight (plan §26.1). Either bootstrap_workspace() was given the wrong data owner, '
        || 'or fb_cron_config.auth_user_id must be set to workspaces.data_key before this migration.';
  end if;
end
$$;


-- ---------------------------------------------------------------------------
-- 1. Active members only: (a) tenant data, (b) actor-owned rows, (c) registry
-- ---------------------------------------------------------------------------

do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    -- (a) tenant data
    'transactions', 'import_batches', 'import_batch_files', 'api_export_logs',
    'capsuled_facebook_syncs', 'capsuled_facebook_stats',
    'funnelfox_leads', 'funnelfox_leads_sync_state',
    'funnelfox_subscriptions', 'funnelfox_subscriptions_sync_state',
    'clickhouse_transaction_sync_state', 'clickhouse_validation_state', 'clickhouse_cohort_snapshot_state',
    'support_messages', 'support_import_batches', 'support_requests',
    'support_mail_sync_state', 'support_classification_state', 'support_replies',
    'facebook_sync_runs', 'facebook_import_batches', 'facebook_raw_payloads', 'facebook_batch_dq',
    'facebook_campaign_mapping', 'facebook_campaign_funnel_map', 'facebook_buyer_mapping',
    'facebook_known_gaps', 'facebook_sync_run_requests',
    'data_snapshots',
    -- (b) actor-owned rows.
    -- TODO(Phase 4, plan §22 saved-object scope stamps): a member narrowed from
    -- scope all to selected/none keeps PostgREST read access to the reports,
    -- versions and forecasts they saved while they had scope all (a revocation
    -- gap: the numbers were already shown to them). Phase 4's scope_paths stamp
    -- + `scope_paths <@ app.allowed_paths()` RLS closes it; until then narrowing
    -- does not revoke saved objects.
    'reports', 'report_versions', 'report_tasks', 'report_notes', 'report_targets', 'report_settings',
    'project_forecasts', 'forecast_scenarios',
    'ai_recommendations', 'ai_feedback', 'ai_assistant_runs', 'report_ai_runs',
    'api_keys',
    -- (c) shared registry
    'funnels', 'tags', 'funnel_tags'
  ] loop
    execute format('drop policy if exists lockdown_active_member on public.%I', v_table);
    execute format(
      'create policy lockdown_active_member on public.%I as restrictive for all to authenticated '
        || 'using ((select app.is_active_member())) with check ((select app.is_active_member()))',
      v_table
    );
  end loop;
end
$$;


-- ---------------------------------------------------------------------------
-- 2. Workspace data key only: (a) tenant data
-- ---------------------------------------------------------------------------

do $$
declare
  v_target record;
begin
  for v_target in
    select t.table_name, t.owner_column
    from (values
      ('transactions', 'auth_user_id'),
      ('import_batches', 'user_id'),
      ('api_export_logs', 'user_id'),
      ('capsuled_facebook_syncs', 'user_id'),
      ('capsuled_facebook_stats', 'user_id'),
      ('funnelfox_leads', 'auth_user_id'),
      ('funnelfox_leads_sync_state', 'auth_user_id'),
      ('funnelfox_subscriptions', 'auth_user_id'),
      ('funnelfox_subscriptions_sync_state', 'auth_user_id'),
      ('clickhouse_transaction_sync_state', 'auth_user_id'),
      ('clickhouse_validation_state', 'auth_user_id'),
      ('clickhouse_cohort_snapshot_state', 'auth_user_id'),
      ('support_messages', 'auth_user_id'),
      ('support_import_batches', 'auth_user_id'),
      ('support_requests', 'auth_user_id'),
      ('support_mail_sync_state', 'auth_user_id'),
      ('support_classification_state', 'auth_user_id'),
      ('support_replies', 'auth_user_id'),
      ('facebook_sync_runs', 'auth_user_id'),
      ('facebook_import_batches', 'auth_user_id'),
      ('facebook_raw_payloads', 'auth_user_id'),
      ('facebook_batch_dq', 'auth_user_id'),
      ('facebook_campaign_mapping', 'auth_user_id'),
      ('facebook_campaign_funnel_map', 'auth_user_id'),
      ('facebook_buyer_mapping', 'auth_user_id'),
      ('facebook_known_gaps', 'auth_user_id'),
      ('facebook_sync_run_requests', 'auth_user_id')
    ) as t(table_name, owner_column)
  loop
    execute format('drop policy if exists lockdown_data_key on public.%I', v_target.table_name);
    execute format(
      'create policy lockdown_data_key on public.%I as restrictive for all to authenticated '
        || 'using (%I = (select app.data_key())) with check (%I = (select app.data_key()))',
      v_target.table_name, v_target.owner_column, v_target.owner_column
    );
  end loop;
end
$$;

-- import_batch_files has no owner column: it belongs to its batch.
drop policy if exists lockdown_data_key on public.import_batch_files;
create policy lockdown_data_key
on public.import_batch_files
as restrictive
for all
to authenticated
using (
  exists (
    select 1 from public.import_batches b
    where b.id = import_batch_files.import_batch_id
      and b.user_id = (select app.data_key())
  )
)
with check (
  exists (
    select 1 from public.import_batches b
    where b.id = import_batch_files.import_batch_id
      and b.user_id = (select app.data_key())
  )
);

-- data_snapshots mixes both kinds: the per-user UI settings types stay
-- actor-owned (an employee keeps their own Cohorts / Forecasting settings);
-- every other type, including any added later, is tenant data (fail closed).
drop policy if exists lockdown_data_key on public.data_snapshots;
create policy lockdown_data_key
on public.data_snapshots
as restrictive
for all
to authenticated
using (
  dataset_type in ('forecasting_settings', 'cohorts_ui_settings')
  or user_id = (select app.data_key())
)
with check (
  dataset_type in ('forecasting_settings', 'cohorts_ui_settings')
  or user_id = (select app.data_key())
);


-- ---------------------------------------------------------------------------
-- 3. Registry: funnels.manage + funnel scope all for every write
-- ---------------------------------------------------------------------------

-- Reads stay open to every active member in Phase 1 (lockdown_active_member
-- above); Phase 2 scopes them through app.can_see_funnel().
do $$
declare
  v_table text;
  v_rule constant text := '(select app.has_permission(''funnels.manage'')) and (select app.funnel_scope_all())';
begin
  foreach v_table in array array['funnels', 'tags', 'funnel_tags'] loop
    execute format('drop policy if exists lockdown_registry_insert on public.%I', v_table);
    execute format('drop policy if exists lockdown_registry_update on public.%I', v_table);
    execute format('drop policy if exists lockdown_registry_delete on public.%I', v_table);
    execute format(
      'create policy lockdown_registry_insert on public.%I as restrictive for insert to authenticated with check (%s)',
      v_table, v_rule
    );
    execute format(
      'create policy lockdown_registry_update on public.%I as restrictive for update to authenticated using (%s) with check (%s)',
      v_table, v_rule, v_rule
    );
    execute format(
      'create policy lockdown_registry_delete on public.%I as restrictive for delete to authenticated using (%s)',
      v_table, v_rule
    );
  end loop;
end
$$;

-- Raised by the registry RPC wrappers. 42501 -> PostgREST answers 403.
create or replace function app.require_registry_manager()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not (app.has_permission('funnels.manage') and app.funnel_scope_all()) then
    raise exception using errcode = '42501',
      message = 'permission_denied: funnels.manage with funnel scope all is required';
  end if;
end;
$$;

-- Body of 202607240001 replace_funnel_tags, unchanged. Internal: no grants.
create or replace function app.replace_funnel_tags_internal(p_funnel_id uuid, p_tag_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_missing_tags uuid[];
begin
  if not exists (select 1 from public.funnels where id = p_funnel_id) then
    raise exception 'Funnel % not found', p_funnel_id using errcode = 'no_data_found';
  end if;

  select array_agg(t) into v_missing_tags
  from unnest(coalesce(p_tag_ids, array[]::uuid[])) as t
  where not exists (select 1 from public.tags where id = t);

  if v_missing_tags is not null then
    raise exception 'Unknown tag id(s): %', v_missing_tags using errcode = 'no_data_found';
  end if;

  delete from public.funnel_tags where funnel_id = p_funnel_id;

  insert into public.funnel_tags (funnel_id, tag_id)
  select p_funnel_id, t from unnest(coalesce(p_tag_ids, array[]::uuid[])) as t;

  return jsonb_build_object(
    'funnel_id', p_funnel_id,
    'tag_count', coalesce(array_length(p_tag_ids, 1), 0)
  );
end;
$$;

-- Body of 202607240003 recompute_funnel_active_status, limited to the data
-- key's transactions (plan §12.3): other accounts' private copies no longer
-- decide which funnels are live. Internal: the daily cron (as postgres) calls
-- it directly; browsers go through the wrapper below.
create or replace function app.recompute_funnel_active_status_internal(p_window_days int default 30)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_window int := greatest(coalesce(p_window_days, 30), 1);
  v_cutoff timestamptz := now() - make_interval(days => v_window);
  v_data_key uuid := app.data_key();
  v_activated int;
  v_deactivated int;
  v_active_total int;
begin
  -- No workspace => no traffic source. Fail instead of deactivating everything.
  if v_data_key is null then
    raise exception using errcode = 'P0001', message = 'invalid: workspace is not bootstrapped';
  end if;

  with active_paths as (
    select distinct ltrim(t.normalized_payload->'metadata'->>'ff_campaign_path', '/') as path
    from public.transactions t
    where t.auth_user_id = v_data_key
      and t.deleted_at is null
      and t.status = 'success'
      and t.event_time >= v_cutoff
      and nullif(ltrim(t.normalized_payload->'metadata'->>'ff_campaign_path', '/'), '') is not null
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

-- Same public names, arguments and results as before (src/services/funnels.ts
-- calls them); only the permission check is new.
create or replace function public.replace_funnel_tags(p_funnel_id uuid, p_tag_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app.require_registry_manager();
  return app.replace_funnel_tags_internal(p_funnel_id, p_tag_ids);
end;
$$;

create or replace function public.recompute_funnel_active_status(p_window_days int default 30)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app.require_registry_manager();
  return app.recompute_funnel_active_status_internal(p_window_days);
end;
$$;

-- The cron runs as postgres with no JWT, so the wrapper would refuse it: point
-- the job at the internal function (same name and schedule as 202607240003).
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
  $$select app.recompute_funnel_active_status_internal(30)$$
);


-- ---------------------------------------------------------------------------
-- 4. Sync-state tables: no browser writes
-- ---------------------------------------------------------------------------

drop policy if exists "Users can insert own ClickHouse sync state" on public.clickhouse_transaction_sync_state;
drop policy if exists "Users can update own ClickHouse sync state" on public.clickhouse_transaction_sync_state;
drop policy if exists "Users can delete own ClickHouse sync state" on public.clickhouse_transaction_sync_state;

drop policy if exists "Users can insert own ClickHouse validation state" on public.clickhouse_validation_state;
drop policy if exists "Users can update own ClickHouse validation state" on public.clickhouse_validation_state;
drop policy if exists "Users can delete own ClickHouse validation state" on public.clickhouse_validation_state;

drop policy if exists "Users can insert own ClickHouse cohort snapshot state" on public.clickhouse_cohort_snapshot_state;
drop policy if exists "Users can update own ClickHouse cohort snapshot state" on public.clickhouse_cohort_snapshot_state;
drop policy if exists "Users can delete own ClickHouse cohort snapshot state" on public.clickhouse_cohort_snapshot_state;

drop policy if exists "Users can insert own funnelfox leads sync state" on public.funnelfox_leads_sync_state;
drop policy if exists "Users can update own funnelfox leads sync state" on public.funnelfox_leads_sync_state;
drop policy if exists "Users can delete own funnelfox leads sync state" on public.funnelfox_leads_sync_state;

drop policy if exists "Users can insert own funnelfox subscriptions sync state" on public.funnelfox_subscriptions_sync_state;
drop policy if exists "Users can update own funnelfox subscriptions sync state" on public.funnelfox_subscriptions_sync_state;
drop policy if exists "Users can delete own funnelfox subscriptions sync state" on public.funnelfox_subscriptions_sync_state;

drop policy if exists "Users can insert own support mail sync state" on public.support_mail_sync_state;
drop policy if exists "Users can update own support mail sync state" on public.support_mail_sync_state;
drop policy if exists "Users can delete own support mail sync state" on public.support_mail_sync_state;

drop policy if exists "Users can insert own support classification state" on public.support_classification_state;
drop policy if exists "Users can update own support classification state" on public.support_classification_state;
drop policy if exists "Users can delete own support classification state" on public.support_classification_state;

-- Belt and braces: without a write policy RLS already refuses, but Supabase's
-- default grants would still advertise the writes. SELECT stays.
revoke insert, update, delete, truncate on table
  public.clickhouse_transaction_sync_state,
  public.clickhouse_validation_state,
  public.clickhouse_cohort_snapshot_state,
  public.funnelfox_leads_sync_state,
  public.funnelfox_subscriptions_sync_state,
  public.support_mail_sync_state,
  public.support_classification_state
from anon, authenticated;


-- ---------------------------------------------------------------------------
-- 5. RPC fixes
-- ---------------------------------------------------------------------------

-- Called only by Edge (supportReplyMatching.ts) with the service-role client.
revoke all on function public.support_apply_answer_matches(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.support_apply_answer_matches(uuid, jsonb) to service_role;

-- The legacy no-argument active_funnelfox_subscription_emails() merges EVERY
-- account's active subscriptions when the service role calls it (BYPASSRLS).
-- 202610050001 kept service_role's EXECUTE only for the pre-access Edge build;
-- the access-aware build (deployed at step 6, before this migration) calls the
-- p_data_key overload instead (cohortSubscriptions.ts). Close the cross-tenant
-- entry point. Browser callers keep the RLS-scoped form.
revoke all on function public.active_funnelfox_subscription_emails() from public, anon, service_role;
grant execute on function public.active_funnelfox_subscription_emails() to authenticated;

-- publish_report becomes the ONLY writer of report_versions, so it runs as
-- definer. RLS no longer applies inside it, so the owner predicate in the
-- lookup stands in for the "read own reports" policy (and for the old
-- auth.uid() check): someone else's report is "not found", exactly as before.
-- reports.publish is required; funnel scope all is required until Phase 4
-- replaces it with the saved-object scope stamp (plan §22).
create or replace function public.publish_report(p_report_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_report public.reports%rowtype;
  v_next integer;
begin
  if not app.has_permission('reports.publish') then
    raise exception using errcode = '42501', message = 'permission_denied: reports.publish is required';
  end if;
  if not app.funnel_scope_all() then
    raise exception using errcode = '42501',
      message = 'scope_not_supported: publishing a report requires funnel scope all';
  end if;

  select * into v_report from public.reports r
  where r.id = p_report_id
    and r.auth_user_id = (select auth.uid());
  if not found then
    raise exception 'Report % not found', p_report_id;
  end if;
  if v_report.snapshot = '{}'::jsonb then
    raise exception 'Report % has no collected data to publish', p_report_id;
  end if;

  select coalesce(max(v.version_no), 0) + 1 into v_next
  from public.report_versions v
  where v.report_id = p_report_id;

  insert into public.report_versions (
    report_id, auth_user_id, version_no, title, period_from, period_to,
    schema_version, engine_version, engine_versions,
    bindings, manual_inputs, snapshot, blocks
  ) values (
    v_report.id, v_report.auth_user_id, v_next, v_report.title,
    v_report.period_from, v_report.period_to,
    v_report.schema_version, v_report.engine_version, v_report.engine_versions,
    v_report.bindings, v_report.manual_inputs, v_report.snapshot, v_report.blocks
  );

  update public.reports
  set status = 'published',
      published_version_no = v_next,
      published_at = now()
  where id = p_report_id;

  return v_next;
end;
$$;

drop policy if exists "Users can insert own report versions" on public.report_versions;
revoke insert, update, delete, truncate on table public.report_versions from anon, authenticated;


-- ---------------------------------------------------------------------------
-- 6. Cron owner = workspace data key (plan §12.8)
-- ---------------------------------------------------------------------------

-- 202607230003 body; the request now names the workspace data key instead of
-- trusting fb_cron_config.auth_user_id (asserted equal above; the Edge gate
-- rejects any other value).
create or replace function public.invoke_fb_daily_cron()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  cfg public.fb_cron_config%rowtype;
  v_data_key uuid := app.data_key();
  req_headers jsonb;
  request_id bigint;
begin
  select * into cfg from public.fb_cron_config where id = true;
  if not found then
    raise notice 'fb_cron_config is empty — daily FB cron skipped';
    return null;
  end if;
  if v_data_key is null then
    raise notice 'workspace is not bootstrapped — daily FB cron skipped';
    return null;
  end if;
  req_headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'x-cron-secret', cfg.cron_secret
  );
  if cfg.anon_key <> '' then
    req_headers := req_headers
      || jsonb_build_object('Authorization', 'Bearer ' || cfg.anon_key)
      || jsonb_build_object('apikey', cfg.anon_key);
  end if;
  select net.http_post(
    url := cfg.function_url,
    headers := req_headers,
    body := jsonb_build_object('auth_user_id', v_data_key),
    timeout_milliseconds := 150000
  ) into request_id;
  return request_id;
end;
$$;

-- 202607250001 body, same change.
create or replace function public.invoke_funnelfox_subscriptions_sync(p_full_reset boolean default false)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  cfg public.fb_cron_config%rowtype;
  v_data_key uuid := app.data_key();
  req_headers jsonb;
  target_url text;
  request_id bigint;
begin
  select * into cfg from public.fb_cron_config where id = true;
  if not found then
    raise notice 'fb_cron_config is empty — funnelfox subscriptions cron skipped';
    return null;
  end if;
  if v_data_key is null then
    raise notice 'workspace is not bootstrapped — funnelfox subscriptions cron skipped';
    return null;
  end if;

  -- Same project/base, different function name.
  target_url := replace(cfg.function_url, 'clickhouse-facebook', 'funnelfox-subscriptions-sync');

  req_headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'x-cron-secret', cfg.cron_secret
  );
  if cfg.anon_key <> '' then
    req_headers := req_headers
      || jsonb_build_object('Authorization', 'Bearer ' || cfg.anon_key)
      || jsonb_build_object('apikey', cfg.anon_key);
  end if;

  select net.http_post(
    url := target_url,
    headers := req_headers,
    body := jsonb_build_object('auth_user_id', v_data_key, 'full_reset', p_full_reset),
    timeout_milliseconds := 150000
  ) into request_id;
  return request_id;
end;
$$;

-- 202609030002 body; the Sent-folder state is read for the data owner only
-- (it used to take the newest non-INBOX row of ANY account).
create or replace function public.invoke_support_sent_backfill_tick()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  cfg public.support_mail_cron_config%rowtype;
  v_data_key uuid := app.data_key();
  sent_state record;
  next_action text;
  request_id bigint;
begin
  select * into cfg from public.support_mail_cron_config where id = true;
  if not found then
    raise notice 'support_mail_cron_config is empty — sent backfill tick skipped';
    return null;
  end if;
  if v_data_key is null then
    raise notice 'workspace is not bootstrapped — sent backfill tick skipped';
    return null;
  end if;

  -- The Sent folder gets its own sync-state row; INBOX keeps folder 'INBOX'.
  select * into sent_state
  from public.support_mail_sync_state s
  where s.auth_user_id = v_data_key
    and s.folder <> 'INBOX'
  order by s.updated_at desc
  limit 1;

  if sent_state is null then
    next_action := 'sent_initial_sync';
  elsif sent_state.history_completed_at is null then
    next_action := case when sent_state.status = 'cursor_invalidated' then 'sent_initial_sync' else 'sent_continue_sync' end;
  else
    -- Backfill done: one full re-match, then this job retires.
    next_action := 'rematch_replies';
    perform cron.unschedule('support-sent-backfill-tick');
  end if;

  select net.http_post(
    url := cfg.function_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-support-mail-internal-secret', cfg.cron_secret
    ),
    body := case when next_action = 'rematch_replies'
      then jsonb_build_object('internal', true, 'action', next_action, 'mode', 'full')
      else jsonb_build_object('internal', true, 'action', next_action)
    end,
    timeout_milliseconds := 150000
  ) into request_id;
  return request_id;
end;
$$;

revoke all on function public.invoke_fb_daily_cron() from public, anon, authenticated;
revoke all on function public.invoke_funnelfox_subscriptions_sync(boolean) from public, anon, authenticated;
revoke all on function public.invoke_support_sent_backfill_tick() from public, anon, authenticated;

-- (e) The cron config rows hold the shared cron secrets. RLS (no policies)
-- already hides them; the browser roles need no privilege on them at all.
revoke all on table public.fb_cron_config, public.support_mail_cron_config from anon, authenticated;


-- ---------------------------------------------------------------------------
-- Grants on the functions created or replaced above. CREATE OR REPLACE keeps
-- an existing ACL and a new function is EXECUTE-able by PUBLIC, so each one is
-- stated explicitly.
-- ---------------------------------------------------------------------------

revoke all on function app.require_registry_manager() from public, anon, authenticated, service_role;
revoke all on function app.replace_funnel_tags_internal(uuid, uuid[]) from public, anon, authenticated, service_role;
revoke all on function app.recompute_funnel_active_status_internal(int) from public, anon, authenticated, service_role;

revoke all on function public.replace_funnel_tags(uuid, uuid[]) from public, anon, authenticated, service_role;
revoke all on function public.recompute_funnel_active_status(int) from public, anon, authenticated, service_role;
revoke all on function public.publish_report(uuid) from public, anon, authenticated, service_role;
grant execute on function public.replace_funnel_tags(uuid, uuid[]) to authenticated;
grant execute on function public.recompute_funnel_active_status(int) to authenticated;
grant execute on function public.publish_report(uuid) to authenticated;


-- ---------------------------------------------------------------------------
-- Fail closed: verify the result, so a table created outside migrations (the
-- dashboard) or a typo in the lists above aborts this migration instead of
-- leaving a hole.
-- ---------------------------------------------------------------------------

do $$
declare
  v_missing text;
  v_writable text;
begin
  -- Every public table the browser roles can reach, except the access tables,
  -- carries the RESTRICTIVE active-member policy.
  select string_agg(c.relname, ', ' order by c.relname) into v_missing
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind in ('r', 'p')
    and c.relname not in (
      'workspaces', 'access_roles', 'workspace_members', 'member_scope_rules',
      'member_scope_values', 'access_audit_log', 'access_denial_counters'
    )
    and (
      has_table_privilege('authenticated', c.oid, 'SELECT, INSERT, UPDATE, DELETE')
      or has_table_privilege('anon', c.oid, 'SELECT, INSERT, UPDATE, DELETE')
    )
    and not exists (
      select 1 from pg_catalog.pg_policy p
      where p.polrelid = c.oid
        and p.polname = 'lockdown_active_member'
        and not p.polpermissive
    );
  if v_missing is not null then
    raise exception using
      message = 'access_rls_lockdown: public table(s) reachable by the browser without lockdown_active_member: '
        || v_missing,
      hint = 'Classify them in this migration (tenant data, actor-owned or registry) or revoke the browser grants.';
  end if;

  -- No browser write policy is left on the sync-state tables or report_versions.
  select string_agg(distinct c.relname || '.' || p.polname, ', ') into v_writable
  from pg_catalog.pg_policy p
  join pg_catalog.pg_class c on c.oid = p.polrelid
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname in (
      'clickhouse_transaction_sync_state', 'clickhouse_validation_state', 'clickhouse_cohort_snapshot_state',
      'funnelfox_leads_sync_state', 'funnelfox_subscriptions_sync_state',
      'support_mail_sync_state', 'support_classification_state', 'report_versions'
    )
    and p.polpermissive
    and p.polcmd in ('a', 'w', 'd', '*');
  if v_writable is not null then
    raise exception 'access_rls_lockdown: browser write policies remain: %', v_writable;
  end if;

  -- Views, materialized views and foreign tables carry no policies: a view runs
  -- with its owner's rights (security_invoker off), so one over a tenant table
  -- would bypass both RESTRICTIVE policies above for every signed-in account,
  -- disabled members and non-members included. Same rule as 202610050002.
  select string_agg(c.relname, ', ' order by c.relname) into v_missing
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind in ('v', 'm', 'f')
    and (
      has_table_privilege('anon', c.oid, 'SELECT')
      or has_table_privilege('authenticated', c.oid, 'SELECT')
    )
    and not (
      c.relkind = 'v'
      and exists (
        select 1 from unnest(coalesce(c.reloptions, '{}'::text[])) as o(opt)
        where lower(o.opt) in ('security_invoker=true', 'security_invoker=on', 'security_invoker=1', 'security_invoker=yes')
      )
    );
  if v_missing is not null then
    raise exception using
      message = 'access_rls_lockdown: public view(s) / materialized view(s) / foreign table(s) readable by the browser roles bypass RLS: '
        || v_missing,
      hint = 'Recreate a view WITH (security_invoker = true), or revoke SELECT on it from anon and authenticated.';
  end if;
end
$$;
