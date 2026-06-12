-- P0-3: scope the transactions dedup key per tenant.
--
-- The original warehouse migration created a GLOBAL unique index on transaction_id alone
-- (transactions_transaction_id_key), while every RLS policy and read is scoped per user via
-- auth_user_id. That mismatch is unsafe: two different accounts importing a provider that reuses
-- transaction_id namespaces -- or the deterministic `fallback:<sha256(email|amount|event_time)>` id,
-- which is identical across accounts -- collide on the global index. The other tenant's row is
-- invisible to the per-user fetch, so the row is classified as an insert and the upsert's INSERT
-- hits the global unique index; the ON CONFLICT DO UPDATE branch is then blocked by the per-user
-- UPDATE policy, failing the whole batch or silently dropping legitimate rows.
--
-- Fix: replace the global unique index with a composite unique index on (auth_user_id,
-- transaction_id) so dedup is tenant-safe while still preventing duplicates within one account.
-- The application upsert is updated to onConflict: 'auth_user_id,transaction_id' to match.

drop index if exists public.transactions_transaction_id_key;

create unique index if not exists transactions_auth_user_transaction_id_key
on public.transactions (auth_user_id, transaction_id);
