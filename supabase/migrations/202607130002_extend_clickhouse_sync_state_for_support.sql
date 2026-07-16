alter table public.clickhouse_transaction_sync_state
drop constraint if exists clickhouse_transaction_sync_state_last_run_mode_check;

alter table public.clickhouse_transaction_sync_state
add constraint clickhouse_transaction_sync_state_last_run_mode_check
check (
  last_run_mode is null
  or last_run_mode in ('continue', 'full_backfill', 'validate_only', 'support_sync')
);

alter table public.clickhouse_transaction_sync_state
drop constraint if exists clickhouse_transaction_sync_state_stopped_reason_check;

alter table public.clickhouse_transaction_sync_state
add constraint clickhouse_transaction_sync_state_stopped_reason_check
check (
  stopped_reason is null
  or stopped_reason in (
    'completed',
    'max_batches_reached',
    'soft_timeout',
    'source_error',
    'clickhouse_error',
    'mapping_error',
    'unknown',
    'support_sync_error'
  )
);
