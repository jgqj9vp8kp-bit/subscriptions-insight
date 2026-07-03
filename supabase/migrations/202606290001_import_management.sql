-- Import management: safe Delete / Rollback / Duplicate-cleanup for the transaction warehouse.
--
-- Background: transactions.import_batch_id references import_batches(id) ON DELETE SET NULL. Deleting
-- a batch row therefore does NOT remove its transactions -- it only nulls the FK, leaving orphaned
-- rows in the warehouse. Every function below HARD-DELETES the transaction rows FIRST and the batch
-- row second, inside a single statement/transaction, so no orphan can ever survive a delete.
--
-- All functions are SECURITY INVOKER and additionally scope every statement by auth.uid(), so a user
-- can only ever touch their own batches/transactions (RLS still applies on top).

-- ---------------------------------------------------------------------------
-- Per-batch live transaction counts (for the details panel / cleanup preview).
-- Returns only batches that still own at least one transaction.
-- ---------------------------------------------------------------------------
create or replace function public.import_batch_transaction_counts()
returns table (import_batch_id uuid, transaction_count bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select t.import_batch_id, count(*)::bigint as transaction_count
  from public.transactions t
  where t.auth_user_id = auth.uid()
    and t.import_batch_id is not null
    and t.deleted_at is null
  group by t.import_batch_id;
$$;

-- ---------------------------------------------------------------------------
-- Delete a single import: its transactions, its file rows, and the batch row.
-- Validation: the batch must exist and belong to the caller, otherwise we abort
-- with an error (never silently no-op). Transactions are removed first so the FK
-- ON DELETE SET NULL can never orphan them.
-- ---------------------------------------------------------------------------
create or replace function public.delete_import_batch(p_batch_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_owner uuid;
  v_deleted_transactions bigint;
begin
  select user_id into v_owner
  from public.import_batches
  where id = p_batch_id
  for update;

  if v_owner is null then
    raise exception 'Import batch % not found', p_batch_id using errcode = 'no_data_found';
  end if;
  if v_owner <> auth.uid() then
    raise exception 'Not authorized to delete import batch %', p_batch_id using errcode = 'insufficient_privilege';
  end if;

  delete from public.transactions
  where import_batch_id = p_batch_id
    and auth_user_id = auth.uid();
  get diagnostics v_deleted_transactions = row_count;

  -- import_batch_files rows are removed by ON DELETE CASCADE when the batch is deleted.
  delete from public.import_batches
  where id = p_batch_id
    and user_id = auth.uid();

  return jsonb_build_object(
    'batch_id', p_batch_id,
    'deleted_transactions', v_deleted_transactions,
    'deleted_batches', 1
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Rollback an import: remove ONLY the data this import currently owns, but keep
-- the history row (marked 'rolled_back') as an audit trail. Older imports are
-- untouched because we filter strictly on this import_batch_id.
-- ---------------------------------------------------------------------------
create or replace function public.rollback_import_batch(p_batch_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_owner uuid;
  v_deleted_transactions bigint;
begin
  select user_id into v_owner
  from public.import_batches
  where id = p_batch_id
  for update;

  if v_owner is null then
    raise exception 'Import batch % not found', p_batch_id using errcode = 'no_data_found';
  end if;
  if v_owner <> auth.uid() then
    raise exception 'Not authorized to roll back import batch %', p_batch_id using errcode = 'insufficient_privilege';
  end if;

  delete from public.transactions
  where import_batch_id = p_batch_id
    and auth_user_id = auth.uid();
  get diagnostics v_deleted_transactions = row_count;

  update public.import_batches
  set status = 'rolled_back',
      notes = coalesce(nullif(notes, ''), 'Rolled back'),
      metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
        'rolled_back_at', now(),
        'rolled_back_transactions', v_deleted_transactions
      )
  where id = p_batch_id
    and user_id = auth.uid();

  return jsonb_build_object(
    'batch_id', p_batch_id,
    'deleted_transactions', v_deleted_transactions,
    'rolled_back', true
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Duplicate cleanup. For each checksum group of the caller's COMPLETED batches,
-- keep the newest (by imported_at) and delete the older completed duplicates.
-- Additionally delete every failed / cancelled / rolled_back batch. Transactions
-- of every removed batch are hard-deleted first.
--
-- p_dry_run = true  -> returns the plan counts WITHOUT deleting anything (preview).
-- p_dry_run = false -> performs the cleanup and returns the resulting counts.
-- ---------------------------------------------------------------------------
create or replace function public.cleanup_duplicate_imports(p_dry_run boolean default false)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_duplicate_imports bigint;
  v_failed_imports bigint;
  v_transactions bigint;
begin
  -- Batches to remove: older completed duplicates per checksum + all non-completed.
  create temporary table _import_cleanup_targets on commit drop as
  with completed as (
    select id, checksum, imported_at,
           row_number() over (
             partition by coalesce(checksum, id::text)
             order by imported_at desc, id desc
           ) as rn
    from public.import_batches
    where user_id = v_uid
      and status = 'completed'
  ),
  duplicate_completed as (
    select id from completed where rn > 1
  ),
  non_completed as (
    select id
    from public.import_batches
    where user_id = v_uid
      and status in ('failed', 'cancelled', 'rolled_back')
  )
  select id, 'duplicate'::text as reason from duplicate_completed
  union all
  select id, 'non_completed'::text as reason from non_completed;

  select count(*) filter (where reason = 'duplicate'),
         count(*) filter (where reason = 'non_completed')
  into v_duplicate_imports, v_failed_imports
  from _import_cleanup_targets;

  select count(*)::bigint into v_transactions
  from public.transactions
  where auth_user_id = v_uid
    and import_batch_id in (select id from _import_cleanup_targets)
    and deleted_at is null;

  if not p_dry_run then
    delete from public.transactions
    where auth_user_id = v_uid
      and import_batch_id in (select id from _import_cleanup_targets);

    delete from public.import_batches
    where user_id = v_uid
      and id in (select id from _import_cleanup_targets);
  end if;

  return jsonb_build_object(
    'dry_run', p_dry_run,
    'duplicate_imports', coalesce(v_duplicate_imports, 0),
    'failed_imports', coalesce(v_failed_imports, 0),
    'transactions_removed', coalesce(v_transactions, 0)
  );
end;
$$;

grant execute on function public.import_batch_transaction_counts() to authenticated;
grant execute on function public.delete_import_batch(uuid) to authenticated;
grant execute on function public.rollback_import_batch(uuid) to authenticated;
grant execute on function public.cleanup_duplicate_imports(boolean) to authenticated;
