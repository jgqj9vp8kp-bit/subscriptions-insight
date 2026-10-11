-- Payment health P0: data quality fixes (plan "Payment System Health" AA P0,
-- owner decision 1, 2026-10-11). A separate release with a before / after
-- comparison (scripts/sql/p0_before_after.sql, README "Payment health P0").
--
-- Why:
--   1. Refunds are stored only as amount_refunded on the original payment; the
--      Primer export carries no refund date. The only date we can observe is
--      the import that first saw amount_refunded > 0 -- and an import rewrites
--      the whole row (upsert), so a column the browser writes would be lost on
--      the next import. A BEFORE INSERT / UPDATE trigger sets it ONCE and never
--      moves it (plan M). Existing refunded rows are backfilled with updated_at:
--      APPROXIMATE (the last time the row was rewritten, not the refund), said
--      so in the column comment and in the README.
--   2. The warehouse import paired raw CSV rows with transactions by array
--      index, but transformPalmerRows re-sorts the transactions, so 32 live rows
--      hold ANOTHER customer's raw_payload (same event second, 5 s apart at
--      most; 6 with the opposite raw status, 4 with another processor). Every
--      payment health column is read from raw_payload, so they are repaired
--      here from the row that holds the correct payload (raw_payload->>'id' =
--      transaction_id), and normalized_payload->'raw' is rebuilt from it with
--      the same key subset palmerTransform.ts normalizePalmerRows writes
--      (app.palmer_normalized_raw below mirrors it; the importer now pairs by
--      id: src/services/transactionWarehouse.ts prepareWarehouseRecords).
--      The three keys normalized_payload derives from the payload (card_type,
--      normalized_decline_reason, decline_message) are dropped on the repaired
--      rows: the ClickHouse mapper (cardTypeFromTransaction,
--      declineDetailsForTransaction) and the browser hydration read them FIRST
--      and fall back to the payload only when they are absent, and the legacy
--      repair (src/services/normalizedPayloadRepair.ts) had derived them from
--      the merged, mis-paired payload (3 success rows carry a decline bucket a
--      neighbour's DECLINED payload gave them; 14 card types disagree with the
--      payload). Dropped, they are re-derived from the repaired payload on the
--      next sync / hydration; normalized_payload->'raw' carries the funding
--      type and declineReasons, so the browser's slim fetch needs no raw_payload.
--   3. transactions.country_code is empty on 100% of rows: the importer read a
--      top-level ff_country_code CSV column that does not exist (its '' won the
--      typeof check) while the FunnelFox country lives in metadata.ff_country_code.
--      The importer is fixed; history is backfilled from the metadata JSON with
--      a safe parse (invalid JSON -> skipped). Semantics stay "the FunnelFox
--      country": never the billing or the issuer country.
--
-- What this migration adds / changes:
--   a. public.transactions.refund_observed_at timestamptz; the trigger
--      transactions_set_refund_observed_at (app.transactions_refund_observed_at,
--      BEFORE INSERT OR UPDATE); backfill of refunded rows (updated_at).
--   b. app.palmer_raw_value / app.palmer_parse_metadata / app.palmer_normalized_raw:
--      SQL mirrors of palmerTransform.ts valueFrom / parseMetadata / the `raw`
--      subset of normalizePalmerRows (kept, revoked from every API role, so a
--      later repair can reuse them); the repair of the mis-paired rows
--      (raw_payload, normalized_payload->'raw' rebuilt, the derived card_type /
--      decline keys dropped); a fail-closed assertion that no row whose correct
--      payload exists is left mismatched.
--   c. app.try_jsonb_object: safe text -> jsonb object; the country_code backfill.
--
-- Nothing here changes `status`: CANCELLED / PENDING rows stay 'failed' (a new
-- status value would make ~210 of them cohort anchors); Payment Pass excludes
-- them through the new ClickHouse raw_status column instead.
--
-- Browser roles: no new privilege. The new column rides the existing
-- transactions grants (the owner's own rows through RLS); the browser never
-- writes refund_observed_at (the trigger owns it), and the helper functions are
-- EXECUTE-able by nobody but postgres.
--
-- APPLY ORDER: after 202610070001 (guarded below). Apply this file on its own
-- (README "Payment health P0"): `supabase db query --linked -f ...` then
-- `supabase migration repair --status applied 202610110001`, never
-- `supabase db push` while earlier-sorting migrations are pending. One
-- transaction: the assertion at the end aborts the whole file. Then deploy the
-- functions (the backfill selects refund_observed_at) and run a FULL ClickHouse
-- backfill from Integrations (new columns). Idempotent: a second run adds
-- nothing, repairs 0 rows and backfills 0 rows.

do $$
begin
  if to_regclass('public.funnelfox_leads_candidates_cache') is null then
    raise exception using
      errcode = 'P0001',
      message = 'payment_health_p0: 202610070001_leads_recent_candidates.sql has not been applied',
      hint = 'Apply 202610070001 first (README "FunnelFox Leads export", step 6); this migration lands on the '
        || 'production shape after it.';
  end if;
end
$$;


-- ---------------------------------------------------------------------------
-- a. refund_observed_at: set once by a trigger, never moved
-- ---------------------------------------------------------------------------

alter table public.transactions
  add column if not exists refund_observed_at timestamptz;

comment on column public.transactions.refund_observed_at is
  'When an import first saw amount_refunded > 0 (set once by transactions_set_refund_observed_at, never moved). '
  'Rows refunded before 2026-10-11 were backfilled with updated_at: APPROXIMATE, the last rewrite of the row, '
  'not the refund date (the Primer export has none).';

-- BEFORE INSERT OR UPDATE. Three rules, in this order:
--   * once set, the value is immutable: an UPDATE keeps OLD's value whatever
--     the new row says (an import upsert sends the whole row);
--   * a transition from no refund (null / 0) to amount_refunded > 0 stamps
--     now() -- unless the statement supplies a value (the backfill below);
--   * an INSERT that already carries amount_refunded > 0 stamps now() the same way.
create or replace function app.transactions_refund_observed_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and old.refund_observed_at is not null then
    new.refund_observed_at := old.refund_observed_at;
  elsif coalesce(new.amount_refunded, 0) > 0
    and (tg_op = 'INSERT' or coalesce(old.amount_refunded, 0) <= 0) then
    new.refund_observed_at := coalesce(new.refund_observed_at, now());
  end if;
  return new;
end;
$$;

drop trigger if exists transactions_set_refund_observed_at on public.transactions;
create trigger transactions_set_refund_observed_at
before insert or update on public.transactions
for each row
execute function app.transactions_refund_observed_at();

-- Backfill (approximate, see the column comment). The SET reads the row's
-- OLD updated_at; the updated_at trigger then bumps it, which re-queues these
-- rows for the incremental ClickHouse sync (the rollout runs a full one anyway).
do $$
declare
  v_backfilled integer;
begin
  update public.transactions t
  set refund_observed_at = t.updated_at
  where coalesce(t.amount_refunded, 0) > 0
    and t.refund_observed_at is null;
  get diagnostics v_backfilled = row_count;
  raise notice 'payment_health_p0: refund_observed_at backfilled on % refunded row(s) (approximate: updated_at)', v_backfilled;
end
$$;


-- ---------------------------------------------------------------------------
-- b. SQL mirrors of palmerTransform.ts (valueFrom / parseMetadata / raw subset)
-- ---------------------------------------------------------------------------

-- valueFrom(row, aliases): the first alias (in order) whose key matches a row
-- key after normalizeKey (lower-case, non-alphanumerics stripped) and holds a
-- non-blank value; the value is returned untrimmed; '' when none does.
create or replace function app.palmer_raw_value(raw jsonb, variadic aliases text[])
returns text
language sql
immutable
set search_path = ''
as $$
  select coalesce((
    select v.value
    from unnest(aliases) with ordinality as a(alias, ord)
    cross join lateral (
      select e.value
      from jsonb_each_text(raw) as e(key, value)
      where lower(regexp_replace(e.key, '[^a-zA-Z0-9]', '', 'g')) = lower(regexp_replace(a.alias, '[^a-zA-Z0-9]', '', 'g'))
        and e.value is not null
        and btrim(e.value) <> ''
      order by e.key desc
      limit 1
    ) as v
    order by a.ord
    limit 1
  ), '');
$$;

-- Safe text -> jsonb OBJECT (null for blank, invalid JSON or a non-object).
create or replace function app.try_jsonb_object(p_text text)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_parsed jsonb;
begin
  if p_text is null or btrim(p_text) = '' then
    return null;
  end if;
  begin
    v_parsed := p_text::jsonb;
  exception when others then
    return null;
  end;
  if jsonb_typeof(v_parsed) <> 'object' then
    return null;
  end if;
  return v_parsed;
end;
$$;

-- parseMetadata(row): the JSON of the metadata cell (through its aliases; {}
-- when absent / invalid / not an object), then the direct columns of the same
-- names win alongside it (non-blank only). Key list = palmerTransform.ts.
create or replace function app.palmer_parse_metadata(raw jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_meta jsonb := coalesce(app.try_jsonb_object(app.palmer_raw_value(raw, 'metadata', 'meta', 'custom_fields', 'custom fields', 'payload')), '{}'::jsonb);
  v_key text;
  v_direct text;
begin
  foreach v_key in array array[
    'ff_funnel_id', 'ff_campaign_path', 'ff_billing_reason', 'ff_country_code', 'country', 'country_code', 'ip_country',
    'initialUrl', 'email', 'utm_campaign', 'utm_content', 'utm_source', 'paymentInstrumentBinDataAccountFundingType',
    'card_type', 'funding', 'card_funding', 'issuer_card_type'
  ] loop
    v_direct := app.palmer_raw_value(raw, v_key);
    if v_direct <> '' then
      v_meta := v_meta || jsonb_build_object(v_key, v_direct);
    end if;
  end loop;
  return v_meta;
end;
$$;

-- normalizePalmerRows(...).raw: the exact key subset (palmerTransform.ts
-- `raw: { ... }`), every key present, '' when the row lacks it.
create or replace function app.palmer_normalized_raw(raw jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'metadata', meta.value,
    'ff_country_code', coalesce(nullif(app.palmer_raw_value(raw, 'ff_country_code'), ''), btrim(coalesce(meta.value ->> 'ff_country_code', ''))),
    'paymentInstrumentBinDataAccountFundingType', app.palmer_raw_value(raw, 'paymentInstrumentBinDataAccountFundingType'),
    'status', app.palmer_raw_value(raw, 'status'),
    'processor', app.palmer_raw_value(raw, 'processor'),
    'declineReasons', app.palmer_raw_value(raw, 'declineReasons', 'decline_reasons', 'declineReason'),
    'payment_method_result_code', app.palmer_raw_value(raw, 'payment_method_result_code'),
    'payment_method_result_message', app.palmer_raw_value(raw, 'payment_method_result_message'),
    'payment_method_advice_code', app.palmer_raw_value(raw, 'payment_method_advice_code'),
    'payment_method_advice_message', app.palmer_raw_value(raw, 'payment_method_advice_message'),
    'advised_action', app.palmer_raw_value(raw, 'advised_action'),
    'transaction_lifecycle_event', app.palmer_raw_value(raw, 'transaction_lifecycle_event'),
    'message', app.palmer_raw_value(raw, 'message', 'error_message', 'failure_reason'),
    'paymentInstrumentThreeDSecureAuthenticationResponseCode', app.palmer_raw_value(raw, 'paymentInstrumentThreeDSecureAuthenticationResponseCode'),
    'paymentInstrumentThreeDSecureAuthenticationReasonCode', app.palmer_raw_value(raw, 'paymentInstrumentThreeDSecureAuthenticationReasonCode'),
    'paymentInstrumentThreeDSecureAuthenticationReasonText', app.palmer_raw_value(raw, 'paymentInstrumentThreeDSecureAuthenticationReasonText')
  )
  from (select app.palmer_parse_metadata(raw) as value) as meta;
$$;


-- ---------------------------------------------------------------------------
-- b'. Repair of the mis-paired rows
-- ---------------------------------------------------------------------------

-- Every row t with raw_payload->>'id' <> transaction_id takes the raw_payload
-- of a row s of the same account whose raw_payload->>'id' = t.transaction_id
-- (a live s before a soft-deleted one, then the earliest). The snapshots are
-- one materialized CTE evaluated against the statement's snapshot, so two rows
-- that swapped payloads do not interfere. Where normalized_payload has a `raw`
-- object (palmer rows) it is rebuilt from the repaired payload and the three
-- derived keys (card_type, normalized_decline_reason, decline_message) are
-- dropped, so the mapper and the hydration re-derive them from the repaired
-- payload (they read the keys first, see the header); the rest of
-- normalized_payload is untouched. A row without a `raw` object keeps its keys:
-- the browser's slim fetch would have nothing to re-derive them from. The
-- updated_at trigger re-queues the rows for the ClickHouse sync.
do $$
declare
  v_repaired integer;
  v_unrepairable integer;
  v_remaining integer;
begin
  with mismatched as (
    select t.id, t.auth_user_id, t.transaction_id
    from public.transactions t
    where t.raw_payload ? 'id'
      and t.raw_payload ->> 'id' <> t.transaction_id
  ),
  snapshots as materialized (
    select distinct on (m.id) m.id as target_id, s.raw_payload as correct_payload
    from mismatched m
    join public.transactions s
      on s.auth_user_id = m.auth_user_id
     and s.raw_payload ->> 'id' = m.transaction_id
    order by m.id, (s.deleted_at is null) desc, s.event_time, s.id
  ),
  repaired as (
    update public.transactions t
    set raw_payload = s.correct_payload,
        normalized_payload = case
          when jsonb_typeof(t.normalized_payload -> 'raw') = 'object'
            then jsonb_set(
              t.normalized_payload - array['card_type', 'normalized_decline_reason', 'decline_message'],
              '{raw}', app.palmer_normalized_raw(s.correct_payload))
          else t.normalized_payload
        end
    from snapshots s
    where t.id = s.target_id
    returning t.id
  )
  select count(*) into v_repaired from repaired;

  -- Mismatched rows whose correct payload exists nowhere stay as they are
  -- (nothing to repair them from); they are reported, not failed on.
  select
    count(*) filter (where not exists (
      select 1 from public.transactions s
      where s.auth_user_id = t.auth_user_id and s.raw_payload ->> 'id' = t.transaction_id)),
    count(*) filter (where exists (
      select 1 from public.transactions s
      where s.auth_user_id = t.auth_user_id and s.raw_payload ->> 'id' = t.transaction_id))
  into v_unrepairable, v_remaining
  from public.transactions t
  where t.raw_payload ? 'id'
    and t.raw_payload ->> 'id' <> t.transaction_id;

  raise notice 'payment_health_p0: repaired % mis-paired raw payload(s); % mismatched row(s) have no correct payload anywhere and were left as is',
    v_repaired, v_unrepairable;

  if v_remaining > 0 then
    raise exception using
      errcode = 'P0001',
      message = format('payment_health_p0: %s row(s) still hold another row''s raw_payload although the correct payload exists', v_remaining),
      hint = 'The repair must leave no such row; inspect raw_payload->>''id'' <> transaction_id before re-running.';
  end if;
end
$$;


-- ---------------------------------------------------------------------------
-- c. country_code backfill (FunnelFox country from metadata.ff_country_code)
-- ---------------------------------------------------------------------------

-- Same source as the fixed importer: a top-level ff_country_code column when
-- an export ever has one, else metadata.ff_country_code through a safe parse
-- (invalid JSON -> the row is skipped). Only empty country_code values are
-- filled; a value already stored is never changed.
do $$
declare
  v_filled integer;
begin
  with parsed as (
    select t.id,
      nullif(btrim(coalesce(
        nullif(t.raw_payload ->> 'ff_country_code', ''),
        app.try_jsonb_object(t.raw_payload ->> 'metadata') ->> 'ff_country_code'
      )), '') as country
    from public.transactions t
    where coalesce(btrim(t.country_code), '') = ''
      and (t.raw_payload ? 'metadata' or t.raw_payload ? 'ff_country_code')
  ),
  filled as (
    update public.transactions t
    set country_code = p.country
    from parsed p
    where t.id = p.id
      and p.country is not null
    returning t.id
  )
  select count(*) into v_filled from filled;
  raise notice 'payment_health_p0: country_code filled on % row(s) from metadata.ff_country_code', v_filled;
end
$$;


-- ---------------------------------------------------------------------------
-- Grants. A new function is EXECUTE-able by PUBLIC (and Supabase's default
-- privileges add anon / authenticated / service_role): none of these is called
-- by an API role -- the trigger fires as the table owner's trigger, the mirrors
-- are for migrations and repairs run as postgres.
-- ---------------------------------------------------------------------------

revoke all on function app.transactions_refund_observed_at() from public, anon, authenticated, service_role;
revoke all on function app.palmer_raw_value(jsonb, text[]) from public, anon, authenticated, service_role;
revoke all on function app.try_jsonb_object(text) from public, anon, authenticated, service_role;
revoke all on function app.palmer_parse_metadata(jsonb) from public, anon, authenticated, service_role;
revoke all on function app.palmer_normalized_raw(jsonb) from public, anon, authenticated, service_role;
