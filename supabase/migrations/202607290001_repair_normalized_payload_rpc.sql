-- Batch updater for the legacy normalized_payload repair (app-load performance).
--
-- March–early-April 2026 transactions predate the import path that copies
-- card-type and decline fields into normalized_payload, so those fields exist
-- only inside raw_payload. That forces the app to download raw_payload for every
-- row on startup (~278 MB per cold load, 7.3 MB vs 3.2 MB per 1000-row page).
-- The client recomputes the enriched payload with the SAME shared hydration
-- functions and applies it here in batches; after the repair the startup fetch
-- can skip raw_payload entirely. raw_payload itself is never modified — it stays
-- the source of truth, so the repair is recomputable at any time.
--
-- updated_at is bumped so the ClickHouse incremental sync re-syncs the repaired
-- rows on its next run. security invoker + auth_user_id guard keep it RLS-scoped.
create or replace function public.repair_transactions_normalized_payload(patches jsonb)
returns integer
language sql
security invoker
set search_path = public
as $$
  with incoming as (
    select (p->>'id')::uuid as id, (p->'normalized_payload')::jsonb as normalized_payload
    from jsonb_array_elements(patches) as p
  ),
  updated as (
    update public.transactions t
    set normalized_payload = i.normalized_payload,
        updated_at = now()
    from incoming i
    where t.id = i.id
      and t.auth_user_id = auth.uid()
    returning t.id
  )
  select count(*)::integer from updated
$$;

grant execute on function public.repair_transactions_normalized_payload(jsonb) to authenticated;
