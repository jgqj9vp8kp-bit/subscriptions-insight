-- Payment health P0: the before / after comparison (plan "Проверка" P0;
-- README "Payment health P0"). READ-ONLY: every statement is a SELECT over
-- public.transactions of the workspace data key. Run each numbered statement
-- on its own (the CLI runs one query per call):
--
--   npx supabase db query --linked --project-ref wsjbpkderyhdefukppvb "<one statement>"
--
-- Run the whole set BEFORE applying 202610110001_payment_health_p0.sql and
-- again AFTER it (and a third time after the full ClickHouse backfill if you
-- want to compare Payment Pass by eye). What must hold:
--   * #2 (trial anchors): count AND checksum IDENTICAL before and after. The
--     migration touches raw_payload, normalized_payload->'raw' (plus its derived
--     card_type / decline keys on the repaired rows), country_code and
--     refund_observed_at only; status, amounts, times and billing_reason never
--     move, so the classifier's anchor set cannot.
--   * #1 (attempts by processor x raw status): the TOTAL is identical; up to
--     32 rows move between cells (the repaired payloads: 6 change raw status,
--     4 change processor as of 2026-10-10).
--   * #3 (country fill rate): 0% before, ~37.5% after (metadata.ff_country_code
--     coverage, plan F); never above the metadata coverage of #3b.
--   * #4 (mismatched raw ids): 32 before (2026-10-10); after, `repairable` = 0
--     (`unrepairable` rows, whose correct payload exists nowhere, may stay).
--   * #5 (normalized raw status / processor vs the raw payload, where both carry
--     a value): 8 status (6 of them the opposite outcome) and 4 processor
--     disagreements before (2026-10-11, all among the mis-paired rows), 0 after.
--   * #6 (refunds): `with_observed_at` = 0 before (column absent -> null), equal
--     to `refunded_rows` after.
--   * #7 (derived keys of normalized_payload vs the raw payload): 14 card-type
--     disagreements and 3 success rows with a decline bucket before (2026-10-11,
--     all among the mis-paired rows), 0 and 0 after.
-- No PII: nothing below selects emails, payload text, card data or ids.

-- 1. Attempts by processor x raw status (Primer status verbatim). CANCELLED /
--    PENDING are the rows Payment Pass stops counting as attempts after the
--    ClickHouse backfill (status stays 'failed').
select coalesce(nullif(t.raw_payload ->> 'processor', ''), '(none)') as processor,
       upper(coalesce(nullif(btrim(t.raw_payload ->> 'status'), ''), '(none)')) as raw_status,
       count(*) as rows
from public.transactions t
where t.auth_user_id = public.workspace_data_key()
  and t.deleted_at is null
group by 1, 2
order by 1, 2;

-- 2. Trial anchors per the classifier definition (classifier.ts / palmerTransform
--    classifyUserTransactions): the first SUCCESSFUL payment of a user that is
--    neither an upsell (billing_reason contains 'upsell') nor a token amount
--    (USD 4.99 / 9.99 / 24.99, EUR 4.99, COP 17199 in the original currency).
--    One row: the number of anchored users and a checksum of (user, anchor
--    transaction) pairs. Both must be identical before and after.
with rows as (
  select coalesce(nullif(t.user_id, ''), lower(nullif(t.email, '')), t.transaction_id) as uid,
         t.transaction_id,
         t.event_time,
         upper(coalesce(t.normalized_payload ->> 'currency', t.currency, '')) as cur,
         coalesce((t.normalized_payload ->> 'gross_amount_usd')::numeric, t.amount_gross, 0) as amt,
         coalesce(t.normalized_payload ->> 'billing_reason', '') as billing_reason,
         coalesce(t.normalized_payload ->> 'transaction_type', t.transaction_type, '') as ttype
  from public.transactions t
  where t.auth_user_id = public.workspace_data_key()
    and t.deleted_at is null
    and coalesce(t.normalized_payload ->> 'status', t.status) = 'success'
),
eligible as (
  select *
  from rows r
  where position('upsell' in lower(r.billing_reason)) = 0
    and not (
      (r.cur = 'USD' and (abs(r.amt - 4.99) < 0.005 or abs(r.amt - 9.99) < 0.005 or abs(r.amt - 24.99) < 0.005))
      or (r.cur = 'EUR' and abs(r.amt - 4.99) < 0.005)
      or (r.cur = 'COP' and abs(r.amt - 17199) < 0.005)
    )
),
anchors as (
  select distinct on (uid) uid, transaction_id
  from eligible
  order by uid, event_time,
    case ttype when 'trial' then 0 when 'upsell' then 1 when 'first_subscription' then 2
      when 'renewal_2' then 3 when 'renewal_3' then 3 when 'renewal' then 3 else 4 end,
    transaction_id
)
select count(*) as trial_anchors,
       md5(string_agg(uid || '|' || transaction_id, ',' order by uid)) as anchors_checksum
from anchors;

-- 3. country_code fill rate (Postgres column). Before: 0 filled.
select count(*) as rows,
       count(*) filter (where coalesce(btrim(t.country_code), '') <> '') as country_filled,
       round(100.0 * count(*) filter (where coalesce(btrim(t.country_code), '') <> '') / greatest(count(*), 1), 2) as fill_rate_pct
from public.transactions t
where t.auth_user_id = public.workspace_data_key()
  and t.deleted_at is null;

-- 3b. The ceiling of #3: rows whose metadata JSON carries ff_country_code
--     (regexp on the text cell, so it runs before the migration's safe-parse
--     helper exists).
select count(*) as rows,
       count(*) filter (where (t.raw_payload ->> 'metadata') ~ '"ff_country_code"\s*:\s*"[^"]+"') as metadata_has_country
from public.transactions t
where t.auth_user_id = public.workspace_data_key()
  and t.deleted_at is null;

-- 4. Mis-paired raw payloads: rows whose raw_payload->>'id' is another
--    transaction's id. `repairable` = the correct payload exists in another
--    row of the same account (must be 0 after the migration).
select count(*) as mismatched,
       count(*) filter (where exists (
         select 1 from public.transactions s
         where s.auth_user_id = t.auth_user_id and s.raw_payload ->> 'id' = t.transaction_id)) as repairable,
       count(*) filter (where not exists (
         select 1 from public.transactions s
         where s.auth_user_id = t.auth_user_id and s.raw_payload ->> 'id' = t.transaction_id)) as unrepairable
from public.transactions t
where t.auth_user_id = public.workspace_data_key()
  and t.raw_payload ? 'id'
  and t.raw_payload ->> 'id' <> t.transaction_id;

-- 5. Consistency of the normalized copy with the raw payload: rows whose
--    normalized_payload->'raw'->>'status' disagrees with raw_payload->>'status'
--    where BOTH carry a value, and the same for the processor. 4,905 older rows
--    have a normalized raw subset written before it carried the status /
--    processor keys ('' there is not a disagreement, and the migration does not
--    touch those rows), so a blank side is excluded. Before: 8 status (6 of
--    them the opposite outcome) and 4 processor disagreements (2026-10-11, all
--    among the mis-paired rows); 0 after.
select count(*) filter (where coalesce(t.normalized_payload -> 'raw' ->> 'status', '') <> ''
         and coalesce(t.raw_payload ->> 'status', '') <> ''
         and upper(t.normalized_payload -> 'raw' ->> 'status') <> upper(t.raw_payload ->> 'status')) as status_disagrees,
       count(*) filter (where coalesce(t.normalized_payload -> 'raw' ->> 'processor', '') <> ''
         and coalesce(t.raw_payload ->> 'processor', '') <> ''
         and (t.normalized_payload -> 'raw' ->> 'processor') <> (t.raw_payload ->> 'processor')) as processor_disagrees
from public.transactions t
where t.auth_user_id = public.workspace_data_key()
  and t.deleted_at is null
  and jsonb_typeof(t.normalized_payload -> 'raw') = 'object';

-- 6. Refunded rows with / without refund_observed_at. Read through to_jsonb so
--    the statement parses BEFORE the column exists (then every row counts as
--    "without").
select count(*) as refunded_rows,
       count(*) filter (where (to_jsonb(t) ->> 'refund_observed_at') is not null) as with_observed_at,
       count(*) filter (where (to_jsonb(t) ->> 'refund_observed_at') is null) as without_observed_at
from public.transactions t
where t.auth_user_id = public.workspace_data_key()
  and t.deleted_at is null
  and coalesce(t.amount_refunded, 0) > 0;

-- 7. Derived keys of normalized_payload (card_type / normalized_decline_reason /
--    decline_message) vs the raw payload. The ClickHouse mapper and the browser
--    hydration read these keys FIRST and fall back to the payload only when they
--    are absent, so a value the legacy repair derived from a mis-paired payload
--    would survive the raw_payload repair; the migration drops the three keys on
--    the repaired rows and both consumers re-derive them from the repaired
--    payload. `card_type_disagrees`: normalized card_type vs the funding type of
--    raw_payload (normalizeCardType mirrored); `success_with_decline_bucket`:
--    success rows carrying a decline bucket (a mis-paired DECLINED payload made
--    them look failed to the legacy repair). 14 and 3 before (2026-10-11, all
--    among the mis-paired rows), 0 and 0 after.
select count(*) filter (where t.normalized_payload ? 'card_type'
         and nullif(btrim(t.raw_payload ->> 'paymentInstrumentBinDataAccountFundingType'), '') is not null
         and (t.normalized_payload ->> 'card_type') <> case
           when lower(t.raw_payload ->> 'paymentInstrumentBinDataAccountFundingType') like '%prepaid%' then 'prepaid'
           when lower(t.raw_payload ->> 'paymentInstrumentBinDataAccountFundingType') like '%debit%' then 'debit'
           when lower(t.raw_payload ->> 'paymentInstrumentBinDataAccountFundingType') like '%credit%' then 'credit'
           else 'other' end) as card_type_disagrees,
       count(*) filter (where t.status = 'success'
         and nullif(t.normalized_payload ->> 'normalized_decline_reason', '') is not null) as success_with_decline_bucket
from public.transactions t
where t.auth_user_id = public.workspace_data_key()
  and t.deleted_at is null;
