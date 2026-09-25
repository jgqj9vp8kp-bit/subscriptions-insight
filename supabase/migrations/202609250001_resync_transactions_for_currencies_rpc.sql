-- Re-sync helper for the missing-FX incident (2026-09-25).
--
-- Six warehouse currencies (BRL, AUD, CAD, NZD, PHP, ZAR) had no rate in
-- fxRates.ts, so the ClickHouse mapper wrote gross_amount_usd = 0 for every
-- one of their transactions — counts present, revenue zero (the new *-web-pt
-- funnels charge in BRL: 92 trials, Gross Rev $0.00). The rates are now in
-- fxRates.ts; the Supabase rows themselves are correct (normalized_payload
-- carries the original amount, no fx_status), so nothing is rewritten here.
-- Bumping updated_at is enough: the ClickHouse incremental sync is keyset on
-- updated_at and re-maps the rows with the new rates on its next run, and the
-- newer row_version wins under FINAL.
--
-- Same shape as repair_transactions_zero_decimal_amounts: security invoker +
-- auth_user_id guard keep it RLS-scoped; the MATERIALIZED candidates CTE
-- fences the plan to the cheap column filters (no jsonb detoast).
create or replace function public.resync_transactions_for_currencies(target_currencies text[])
returns integer
language sql
security invoker
set search_path = public
as $$
  with candidates as materialized (
    select id
    from public.transactions
    where deleted_at is null
      and auth_user_id = auth.uid()
      and upper(btrim(currency)) = any (target_currencies)
  ),
  updated as (
    update public.transactions t
    set updated_at = now()
    from candidates c
    where t.id = c.id
    returning t.id
  )
  select count(*)::integer from updated
$$;

grant execute on function public.resync_transactions_for_currencies(text[]) to authenticated;
