-- Repair amounts for zero-decimal currencies (JPY defect, 2026-07-31).
--
-- The Palmer importer divided every integer amount by 100 ("cents -> units"),
-- but ISO 4217 exponent-0 currencies have NO minor unit: raw amount "6415" JPY
-- means Y6,415 (~$42), and the warehouse stored 64.15 — every yen amount was
-- 100x too small before FX conversion even ran. The importer is fixed
-- (currency-aware minor-unit factor); this RPC re-derives the stored amounts of
-- already-imported rows from raw_payload — the untouched source of truth — with
-- the same zero-decimal rule. The caller passes the currency registry so the
-- list lives in exactly one place (fxRates.ts ZERO_DECIMAL_CURRENCIES).
--
-- Idempotent: rows whose stored amounts already match are skipped, so a second
-- run updates 0. updated_at is bumped so the ClickHouse incremental sync picks
-- the rows up on its next run. security invoker + auth_user_id guard keep it
-- RLS-scoped, mirroring repair_transactions_normalized_payload.
create or replace function public.repair_transactions_zero_decimal_amounts(zero_decimal_currencies text[])
returns integer
language sql
security invoker
set search_path = public
as $$
  with source as (
    select id,
      abs(nullif(regexp_replace(raw_payload->>'amount', '[^0-9.-]', '', 'g'), '')::numeric) as gross,
      coalesce(nullif(regexp_replace(raw_payload->>'amountRefunded', '[^0-9.-]', '', 'g'), '')::numeric, 0) as refunded
    from public.transactions
    where deleted_at is null
      and auth_user_id = auth.uid()
      and upper(btrim(currency)) = any (zero_decimal_currencies)
      and raw_payload ? 'amount'
  ),
  updated as (
    update public.transactions t
    set amount_gross = s.gross,
        amount_net = s.gross - s.refunded,
        amount_refunded = s.refunded,
        normalized_payload = t.normalized_payload || jsonb_build_object(
          'amount_usd', s.gross,
          'gross_amount_usd', s.gross,
          'net_amount_usd', s.gross - s.refunded,
          'refund_amount_usd', s.refunded,
          'is_refunded', s.refunded > 0
        ),
        updated_at = now()
    from source s
    where t.id = s.id
      and s.gross is not null
      and (t.amount_gross is distinct from s.gross
        or t.amount_refunded is distinct from s.refunded)
    returning t.id
  )
  select count(*)::integer from updated
$$;

grant execute on function public.repair_transactions_zero_decimal_amounts(text[]) to authenticated;
