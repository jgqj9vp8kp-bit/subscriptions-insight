alter table public.clickhouse_cohort_snapshot_state
  add column if not exists build_token uuid,
  add column if not exists lease_expires_at timestamptz;

create or replace function public.claim_clickhouse_cohort_snapshot_build(
  p_auth_user_id uuid,
  p_build_token uuid,
  p_warehouse_version text,
  p_classification_version text,
  p_started_at timestamptz,
  p_lease_seconds integer,
  p_source_transactions bigint,
  p_source_unique_users bigint,
  p_diagnostics jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  affected integer;
begin
  insert into public.clickhouse_cohort_snapshot_state (
    auth_user_id, snapshot_name, status, building_warehouse_version,
    building_classification_version, build_token, lease_expires_at,
    started_at, finished_at, last_error, source_transactions,
    source_unique_users, diagnostics, updated_at
  ) values (
    p_auth_user_id, 'fact_user_cohorts', 'building', p_warehouse_version,
    p_classification_version, p_build_token,
    p_started_at + make_interval(secs => greatest(30, p_lease_seconds)),
    p_started_at, null, null, p_source_transactions,
    p_source_unique_users, p_diagnostics, now()
  )
  on conflict (auth_user_id, snapshot_name) do update set
    status = 'building',
    building_warehouse_version = excluded.building_warehouse_version,
    building_classification_version = excluded.building_classification_version,
    build_token = excluded.build_token,
    lease_expires_at = excluded.lease_expires_at,
    started_at = excluded.started_at,
    finished_at = null,
    last_error = null,
    source_transactions = excluded.source_transactions,
    source_unique_users = excluded.source_unique_users,
    diagnostics = excluded.diagnostics,
    updated_at = now()
  where clickhouse_cohort_snapshot_state.status <> 'building'
     or clickhouse_cohort_snapshot_state.lease_expires_at is null
     or clickhouse_cohort_snapshot_state.lease_expires_at <= now();

  get diagnostics affected = row_count;
  return affected = 1;
end;
$$;

create or replace function public.complete_clickhouse_cohort_snapshot_build(
  p_auth_user_id uuid,
  p_build_token uuid,
  p_warehouse_version text,
  p_classification_version text,
  p_generated_at timestamptz,
  p_finished_at timestamptz,
  p_duration_ms integer,
  p_users_classified bigint,
  p_rows_inserted bigint,
  p_duplicate_users bigint,
  p_removed_or_invalidated bigint,
  p_source_transactions bigint,
  p_source_unique_users bigint,
  p_diagnostics jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  affected integer;
begin
  update public.clickhouse_cohort_snapshot_state set
    status = 'completed',
    active_warehouse_version = p_warehouse_version,
    active_classification_version = p_classification_version,
    active_generated_at = p_generated_at,
    building_warehouse_version = null,
    building_classification_version = null,
    build_token = null,
    lease_expires_at = null,
    finished_at = p_finished_at,
    duration_ms = p_duration_ms,
    users_classified = p_users_classified,
    rows_inserted = p_rows_inserted,
    duplicate_users = p_duplicate_users,
    removed_or_invalidated = p_removed_or_invalidated,
    source_transactions = p_source_transactions,
    source_unique_users = p_source_unique_users,
    diagnostics = p_diagnostics,
    last_error = null,
    updated_at = now()
  where auth_user_id = p_auth_user_id
    and snapshot_name = 'fact_user_cohorts'
    and status = 'building'
    and build_token = p_build_token
    and building_warehouse_version = p_warehouse_version
    and building_classification_version = p_classification_version;

  get diagnostics affected = row_count;
  return affected = 1;
end;
$$;

create or replace function public.fail_clickhouse_cohort_snapshot_build(
  p_auth_user_id uuid,
  p_build_token uuid,
  p_finished_at timestamptz,
  p_duration_ms integer,
  p_error text,
  p_diagnostics jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  affected integer;
begin
  update public.clickhouse_cohort_snapshot_state set
    status = 'failed',
    finished_at = p_finished_at,
    duration_ms = p_duration_ms,
    last_error = p_error,
    diagnostics = p_diagnostics,
    build_token = null,
    lease_expires_at = null,
    updated_at = now()
  where auth_user_id = p_auth_user_id
    and snapshot_name = 'fact_user_cohorts'
    and status = 'building'
    and build_token = p_build_token;

  get diagnostics affected = row_count;
  return affected = 1;
end;
$$;

revoke all on function public.claim_clickhouse_cohort_snapshot_build(uuid, uuid, text, text, timestamptz, integer, bigint, bigint, jsonb) from public, anon, authenticated;
revoke all on function public.complete_clickhouse_cohort_snapshot_build(uuid, uuid, text, text, timestamptz, timestamptz, integer, bigint, bigint, bigint, bigint, bigint, bigint, jsonb) from public, anon, authenticated;
revoke all on function public.fail_clickhouse_cohort_snapshot_build(uuid, uuid, timestamptz, integer, text, jsonb) from public, anon, authenticated;
grant execute on function public.claim_clickhouse_cohort_snapshot_build(uuid, uuid, text, text, timestamptz, integer, bigint, bigint, jsonb) to service_role;
grant execute on function public.complete_clickhouse_cohort_snapshot_build(uuid, uuid, text, text, timestamptz, timestamptz, integer, bigint, bigint, bigint, bigint, bigint, bigint, jsonb) to service_role;
grant execute on function public.fail_clickhouse_cohort_snapshot_build(uuid, uuid, timestamptz, integer, text, jsonb) to service_role;
