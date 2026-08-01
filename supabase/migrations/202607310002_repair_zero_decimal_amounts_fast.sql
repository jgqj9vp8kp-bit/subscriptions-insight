-- Faster plan for the zero-decimal amount repair.
--
-- The first version timed out under PostgREST's statement_timeout: its WHERE
-- carried `raw_payload ? 'amount'`, and the planner is free to evaluate that
-- qual across the whole seq scan — detoasting every row's multi-KB raw_payload
-- (~37.7k rows) before the currency filter has narrowed anything. The
-- MATERIALIZED candidates CTE fences the plan: the cheap column filters run
-- first and jsonb work touches only the handful of zero-decimal rows. The
-- `? 'amount'` qual is gone entirely — a missing key extracts to NULL and is
-- dropped by `s.gross is not null`, same outcome without the detoast.
create or replace function public.repair_transactions_zero_decimal_amounts(zero_decimal_currencies text[])
returns integer
language sql
security invoker
set search_path = public
as $$
  with candidates as materialized (
    select id, raw_payload
    from public.transactions
    where deleted_at is null
      and auth_user_id = auth.uid()
      and upper(btrim(currency)) = any (zero_decimal_currencies)
  ),
  source as (
    select id,
      abs(nullif(regexp_replace(raw_payload->>'amount', '[^0-9.-]', '', 'g'), '')::numeric) as gross,
      coalesce(nullif(regexp_replace(raw_payload->>'amountRefunded', '[^0-9.-]', '', 'g'), '')::numeric, 0) as refunded
    from candidates
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
