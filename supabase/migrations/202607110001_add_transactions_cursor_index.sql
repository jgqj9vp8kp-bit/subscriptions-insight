-- Additive index only. Supports the owner-scoped keyset cursor query used by the
-- ClickHouse backfill AND validation source reads:
--   WHERE auth_user_id = $1 AND deleted_at IS NULL
--     AND (updated_at, transaction_id) within a compound lower/upper cursor
--   ORDER BY updated_at ASC, transaction_id ASC
-- Without this, PostgreSQL Seq Scans all rows and Sorts on every page (intermittent
-- 8s statement_timeout). This index provides the exact sort order and range, so the
-- planner does an index range scan and only detoasts normalized_payload for the
-- LIMITed output rows. Partial on `deleted_at IS NULL` matches the query predicate
-- and keeps the index small. No existing index/table/column is altered.
--
-- NOTE: CREATE INDEX CONCURRENTLY cannot run inside a transaction block. Apply this
-- migration via a non-transactional execution path (this project applies migrations
-- with `supabase db query --linked -f`, which runs statements in autocommit).
CREATE INDEX CONCURRENTLY IF NOT EXISTS transactions_auth_updated_tx_active_idx
ON public.transactions (auth_user_id, updated_at, transaction_id)
WHERE deleted_at IS NULL;
