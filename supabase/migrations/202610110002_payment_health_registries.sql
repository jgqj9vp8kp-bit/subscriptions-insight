-- Payment System Health, phase P1 (plan sections G, I, N, T, AA): the two
-- registries the module reads instead of hard-coding anything about PSP
-- accounts or card-network programs.
--
--   1. public.psp_accounts -- one row per (workspace data key, processor,
--      processorMerchantId): the MID registry. The raw MID stays in this table
--      and never leaves the database (plan S, X: MIDs and descriptors are shown
--      as registry labels only). Rows are seeded by INSERT ... SELECT from
--      public.transactions (raw_payload ->> 'processor' x raw_payload ->>
--      'processorMerchantId' of the workspace data key, live rows only) with the
--      owner's placeholder labels "Stripe MID #n" / "Adyen MID #n" numbered by
--      first-seen order (owner decision 4, 2026-10-11). legal_entity,
--      acquirer_country, descriptor_prefix, programs and manual_status are
--      empty until the owner fills them (plan N: the manual status carries its
--      source, observed_at and entered_by, so a hand-entered status is never
--      mistaken for an official feed). psp_accounts_sync(p_data_key, p_full)
--      repeats the seed for new MIDs after later imports (service_role only;
--      the P2 runner calls it through the Edge after an import, i.e. under
--      PostgREST's 8 s statement_timeout): INCREMENTALLY, reading only the
--      transactions written since the last call. public.psp_accounts_sync_state
--      keeps the per-key watermark on transactions.updated_at and the
--      (auth_user_id, updated_at, transaction_id) index of 202607110001 serves
--      the range; a full scan of the key groups every live row and detoasts
--      every raw_payload (65,964 rows, 3.0 s warm on production 2026-10-11,
--      right after the import churned the cache) and is reserved for the first
--      call (the seed) and p_full. Labels and manual fields are never
--      overwritten, only first_seen_at / last_seen_at move.
--   2. public.network_program_thresholds -- the Visa / Mastercard monitoring
--      thresholds of plan section D as rows (program, metric_key, region, scope,
--      effective window, warning / critical values, minimum count, unit), each
--      with its source URL, last_verified_at and a verified flag. Nothing about
--      a threshold is hard-coded in the alert engine (plan I). The retry-rule
--      rows (Visa excessive re-attempts, Mastercard MAC 03/21 and the TPE
--      limits) come from SECONDARY sources and are flagged verified = false
--      ("НЕ ПРОВЕРЕНО", plan D / AC): confirm with the acquirer before alerting
--      on them (owner decision 8). The early warning the UI shows before a
--      threshold (plan I: "e.g. at 70%") is derived from critical_value by the
--      caller; warning_value holds a level the NETWORK itself defines (VAMP
--      "non-compliant" below "excessive"), null otherwise.
--
-- All three tables (the sync state included): RLS on with no policies and no
-- browser privilege (the module reads them through Edge with the service-role
-- client: select / insert / update, no delete -- registry rows are retired,
-- never dropped). An updated_at trigger on both registries. Not tenant tables
-- in the lockdown sense: psp_accounts and the sync state carry auth_user_id =
-- the workspace data key, so any later service-role read filters on it; the
-- thresholds are network facts, shared.
--
-- APPLY ORDER: after 202610070001 (guarded below: its cache table is the
-- marker that the leads migrations have landed). Apply this file on its own,
-- as ONE transaction (supabase db push does): the guard aborts the whole file.
-- Re-applying is safe: tables are IF NOT EXISTS, the seed call is incremental
-- once a watermark exists (new MIDs only), and the threshold seed inserts only
-- the rows that are missing (ON CONFLICT DO NOTHING on the natural key): a
-- threshold the owner edited (verified, last_verified_at, values, notes) is
-- never reset by a re-run.

do $$
begin
  if to_regclass('public.funnelfox_leads_candidates_cache') is null
    or to_regprocedure('public.workspace_data_key()') is null then
    raise exception using
      errcode = 'P0001',
      message = 'payment_health_registries: 202610070001_leads_recent_candidates.sql has not been applied',
      hint = 'Apply 202610070001 first (README "FunnelFox Leads export"); this migration is applied after the leads series.';
  end if;
end
$$;


-- ---------------------------------------------------------------------------
-- updated_at trigger (shared by both registries)
-- ---------------------------------------------------------------------------

create or replace function public.payment_health_set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;


-- ---------------------------------------------------------------------------
-- 1. psp_accounts
-- ---------------------------------------------------------------------------

create table if not exists public.psp_accounts (
  id uuid primary key default gen_random_uuid(),
  -- The workspace data key (plan D1): every row belongs to the tenant.
  auth_user_id uuid not null references auth.users (id) on delete cascade,
  -- Primer's processor name, upper-cased: STRIPE, ADYEN.
  processor text not null,
  -- Primer's processorMerchantId, as relayed. Never shown; the label is.
  processor_merchant_id text not null,
  -- 1, 2, 3 ... per (data key, processor), in first-seen order; the number in the default label.
  seq integer not null,
  label text not null,
  legal_entity text,
  -- The acquirer's country or region (plan D: the Visa VAMP account key is descriptor x acquirer country).
  acquirer_country text,
  -- The static part of the statement descriptor (plan Q: one recognisable prefix).
  descriptor_prefix text,
  -- Network programs the account is enrolled in or monitored under: ["visa_vamp", "mc_ecm", ...].
  programs jsonb not null default '[]'::jsonb,
  -- Manually entered official status: {status, source, observed_at, entered_by} (plan N).
  manual_status jsonb not null default '{}'::jsonb,
  first_seen_at timestamptz,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint psp_accounts_processor_check check (processor <> '' and processor = upper(btrim(processor))),
  constraint psp_accounts_mid_check check (processor_merchant_id <> '' and processor_merchant_id = btrim(processor_merchant_id)),
  constraint psp_accounts_seq_check check (seq > 0),
  constraint psp_accounts_programs_check check (jsonb_typeof(programs) = 'array'),
  constraint psp_accounts_manual_status_check check (jsonb_typeof(manual_status) = 'object'),
  constraint psp_accounts_mid_key unique (auth_user_id, processor, processor_merchant_id),
  constraint psp_accounts_seq_key unique (auth_user_id, processor, seq)
);

comment on table public.psp_accounts is
  'Payment System Health MID registry: one row per processor x processorMerchantId of the workspace data key. '
  'The raw MID never leaves the database; the UI shows label. Seeded from public.transactions, extended by psp_accounts_sync.';
comment on column public.psp_accounts.manual_status is
  'Hand-entered official status {status, source, observed_at, entered_by}; the source is shown with the status.';

drop trigger if exists psp_accounts_set_updated_at on public.psp_accounts;
create trigger psp_accounts_set_updated_at
before update on public.psp_accounts
for each row
execute function public.payment_health_set_updated_at();

-- Supabase's default privileges grant ALL to service_role too: revoke, then
-- grant exactly what the Edge needs (no delete / truncate: rows are retired, not dropped).
alter table public.psp_accounts enable row level security;
revoke all on table public.psp_accounts from public, anon, authenticated, service_role;
grant select, insert, update on table public.psp_accounts to service_role;

-- The sync watermark, one row per data key: when psp_accounts_sync last ran,
-- so the next call reads only the transactions written since. Service-role
-- state like funnelfox_leads_candidates_cache: RLS on, no policies, no browser
-- grant; a row exists only for a real account (auth.users).
create table if not exists public.psp_accounts_sync_state (
  auth_user_id uuid primary key references auth.users (id) on delete cascade,
  -- now() of the last sync; the next incremental call reads transactions.updated_at from an hour before it.
  synced_through timestamptz not null,
  -- Live rows with both processor and processorMerchantId the last call read.
  scanned_rows integer not null default 0,
  -- The last call read the whole history (the first call, or p_full).
  last_full_scan boolean not null default false
);

comment on table public.psp_accounts_sync_state is
  'Per data key: when psp_accounts_sync last ran. The next call reads only transactions.updated_at after it (minus a one-hour overlap); p_full rescans everything.';

alter table public.psp_accounts_sync_state enable row level security;
revoke all on table public.psp_accounts_sync_state from public, anon, authenticated, service_role;
grant select, insert, update on table public.psp_accounts_sync_state to service_role;

-- The seed and the sync: inserts the (processor, MID) pairs of the data key's
-- live transactions that are not registered yet, numbered after the existing
-- rows of that processor, and moves first_seen_at / last_seen_at outwards on
-- the known ones. Labels and the manual fields are untouched. Incremental: it
-- reads the rows whose updated_at is after the key's watermark less a one-hour
-- overlap (an import statement that began before the last sync but committed
-- after it stamped its rows with an earlier updated_at), along the partial
-- (auth_user_id, updated_at, transaction_id) index; the cheap updated_at test
-- runs before the raw_payload expressions, so the rows outside the range are
-- never detoasted. The watermark is updated_at, not event_time: a backfilled
-- older month is still seen. No watermark yet (the seed) or p_full -> the
-- whole history. p_data_key null -> the workspace data key; no workspace ->
-- nothing. Returns the counts and the mode. The earlier one-argument overload
-- is dropped first: with both present, psp_accounts_sync(key) would be
-- ambiguous.
drop function if exists public.psp_accounts_sync(uuid);
create or replace function public.psp_accounts_sync(p_data_key uuid default null, p_full boolean default false)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_key uuid := coalesce(p_data_key, public.workspace_data_key());
  v_started timestamptz := now();
  v_since timestamptz;
  v_full boolean;
  v_scanned integer := 0;
  v_inserted integer := 0;
  v_updated integer := 0;
  v_total integer := 0;
begin
  if v_key is null then
    raise notice 'workspace is not bootstrapped — psp_accounts sync skipped';
    return jsonb_build_object('data_key', null, 'inserted', 0, 'updated', 0, 'accounts', 0, 'full_scan', false, 'scanned', 0);
  end if;

  select s.synced_through - interval '1 hour' into v_since
  from public.psp_accounts_sync_state s
  where s.auth_user_id = v_key;
  v_full := coalesce(p_full, false) or v_since is null;
  if v_full then
    v_since := '-infinity'::timestamptz;
  end if;

  with candidates as (
    select
      upper(btrim(t.raw_payload ->> 'processor')) as processor,
      btrim(t.raw_payload ->> 'processorMerchantId') as mid,
      t.event_time
    from public.transactions t
    where t.auth_user_id = v_key
      and t.updated_at > v_since
      and t.deleted_at is null
      and nullif(btrim(t.raw_payload ->> 'processor'), '') is not null
      and nullif(btrim(t.raw_payload ->> 'processorMerchantId'), '') is not null
  ),
  seen as (
    select c.processor, c.mid, min(c.event_time) as first_seen, max(c.event_time) as last_seen
    from candidates c
    group by 1, 2
  ),
  moved as (
    update public.psp_accounts a
    set first_seen_at = least(a.first_seen_at, s.first_seen),
        last_seen_at = greatest(a.last_seen_at, s.last_seen)
    from seen s
    where a.auth_user_id = v_key
      and a.processor = s.processor
      and a.processor_merchant_id = s.mid
      and (a.first_seen_at is distinct from least(a.first_seen_at, s.first_seen)
        or a.last_seen_at is distinct from greatest(a.last_seen_at, s.last_seen))
    returning a.id
  ),
  fresh as (
    select s.*,
      row_number() over (partition by s.processor order by s.first_seen, s.mid) as rn,
      coalesce((select max(a.seq) from public.psp_accounts a where a.auth_user_id = v_key and a.processor = s.processor), 0) as base
    from seen s
    where not exists (
      select 1 from public.psp_accounts a
      where a.auth_user_id = v_key and a.processor = s.processor and a.processor_merchant_id = s.mid)
  ),
  added as (
    insert into public.psp_accounts (auth_user_id, processor, processor_merchant_id, seq, label, first_seen_at, last_seen_at)
    select v_key, f.processor, f.mid, f.base + f.rn,
      initcap(lower(f.processor)) || ' MID #' || (f.base + f.rn),
      f.first_seen, f.last_seen
    from fresh f
    returning id
  )
  select (select count(*) from added), (select count(*) from moved), (select count(*) from candidates)
  into v_inserted, v_updated, v_scanned;

  select count(*) into v_total from public.psp_accounts a where a.auth_user_id = v_key;

  begin
    insert into public.psp_accounts_sync_state as s (auth_user_id, synced_through, scanned_rows, last_full_scan)
    values (v_key, v_started, v_scanned, v_full)
    on conflict (auth_user_id) do update
      set synced_through = excluded.synced_through,
          scanned_rows = excluded.scanned_rows,
          last_full_scan = excluded.last_full_scan
      -- A slower call that started earlier never moves the watermark back.
      where s.synced_through <= excluded.synced_through;
  exception
    when foreign_key_violation then
      -- Not an account (no auth.users row): nothing registered, nothing to remember.
      null;
  end;

  return jsonb_build_object(
    'data_key', v_key, 'inserted', v_inserted, 'updated', v_updated, 'accounts', v_total,
    'full_scan', v_full, 'scanned', v_scanned
  );
end;
$$;

-- The seed itself (as postgres, the migration's role): the first call has no
-- watermark and reads the whole history; a re-apply finds the watermark and
-- reads only what arrived since. A database without a workspace gets empty
-- registries and a notice.
select public.psp_accounts_sync();


-- ---------------------------------------------------------------------------
-- 2. network_program_thresholds
-- ---------------------------------------------------------------------------

create table if not exists public.network_program_thresholds (
  id uuid primary key default gen_random_uuid(),
  -- visa_vamp, visa_vamp_enumeration, mc_ecm, mc_hecm, mc_efm, visa_reattempts, mc_mac, mc_tpe
  program text not null,
  -- The figure the threshold applies to (vamp_ratio, vamp_count, chargeback_ratio, ...).
  metric_key text not null,
  -- global, cemea, regulated, non_regulated, ... as the network defines the variant.
  region text not null default 'global',
  -- What the threshold is measured per: merchant (account) or card.
  scope text not null default 'merchant',
  effective_from date not null,
  effective_to date,
  -- A level the network itself defines below critical (VAMP "non-compliant"); null when there is none.
  warning_value numeric,
  critical_value numeric,
  -- Minimum count for the ratio to apply (VAMP excessive: 1,500 fraud + disputes; ECM: 100 chargebacks).
  min_count integer,
  -- ratio (0..1), count, usd, share (0..1)
  unit text not null,
  source_url text not null,
  last_verified_at date,
  -- false = UNVERIFIED: a secondary source, confirm with the acquirer before alerting on it.
  verified boolean not null default false,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint network_program_thresholds_unit_check check (unit in ('ratio', 'count', 'usd', 'share')),
  constraint network_program_thresholds_scope_check check (scope in ('merchant', 'card')),
  constraint network_program_thresholds_window_check check (effective_to is null or effective_to >= effective_from),
  constraint network_program_thresholds_key unique (program, metric_key, region, scope, effective_from)
);

comment on table public.network_program_thresholds is
  'Card-network monitoring thresholds (plan D) with source URL, verification date and verified flag; never hard-coded.';

drop trigger if exists network_program_thresholds_set_updated_at on public.network_program_thresholds;
create trigger network_program_thresholds_set_updated_at
before update on public.network_program_thresholds
for each row
execute function public.payment_health_set_updated_at();

alter table public.network_program_thresholds enable row level security;
revoke all on table public.network_program_thresholds from public, anon, authenticated, service_role;
grant select, insert, update on table public.network_program_thresholds to service_role;

-- Seed (plan D, read 2026-10-10). effective_from is the start of the year the
-- page was read: the source does not date its thresholds. Re-applying inserts
-- only the rows that are missing (ON CONFLICT DO NOTHING on the natural key):
-- a row the owner edited after confirming a rule with the acquirer (verified,
-- last_verified_at, the values, notes; owner decision 8) is never reset by a
-- re-run, and a changed plan-D value reaches an existing row only through an
-- explicit UPDATE in a later migration. Rows the owner adds (a later
-- effective_from) are untouched.
insert into public.network_program_thresholds
  (program, metric_key, region, scope, effective_from, warning_value, critical_value, min_count, unit, source_url, last_verified_at, verified, notes)
values
  -- Visa VAMP, merchant level: (TC40 fraud + TC15 disputes) count / settled Visa payments of the SAME month.
  ('visa_vamp', 'vamp_ratio', 'global', 'merchant', '2026-01-01', 0.005, 0.015, 1500, 'ratio',
   'https://docs.stripe.com/disputes/monitoring-programs', '2026-10-10', true,
   'Non-compliant at 0.5%, excessive at 1.5% with at least 1,500 fraud + disputes in the month. Count-based: a transaction in both TC40 and TC15 counts twice; RDR, pre-dispute and CE 3.0-qualified TC40 are excluded; the account is the static descriptor part x acquirer country. The minimum count for the non-compliant level (the page says 5) is UNVERIFIED.'),
  ('visa_vamp', 'vamp_count', 'global', 'merchant', '2026-01-01', null, 1500, null, 'count',
   'https://docs.stripe.com/disputes/monitoring-programs', '2026-10-10', true,
   'Fraud reports + disputes in the month needed for the excessive level.'),
  ('visa_vamp', 'vamp_ratio', 'cemea', 'merchant', '2026-01-01', null, 0.022, 150, 'ratio',
   'https://docs.stripe.com/disputes/monitoring-programs', '2026-10-10', true,
   'CEMEA excessive level: 2.2% with at least 150 fraud + disputes and USD 75,000.'),
  ('visa_vamp', 'vamp_count', 'cemea', 'merchant', '2026-01-01', null, 150, null, 'count',
   'https://docs.stripe.com/disputes/monitoring-programs', '2026-10-10', true,
   'CEMEA excessive level count.'),
  ('visa_vamp', 'vamp_amount_usd', 'cemea', 'merchant', '2026-01-01', null, 75000, null, 'usd',
   'https://docs.stripe.com/disputes/monitoring-programs', '2026-10-10', true,
   'CEMEA excessive level amount (fraud + disputes).'),
  -- Visa VAMP enumeration (card testing): enumerated authorizations / all authorizations.
  ('visa_vamp_enumeration', 'enumeration_ratio', 'global', 'merchant', '2026-01-01', null, 0.20, 300000, 'ratio',
   'https://docs.stripe.com/disputes/monitoring-programs', '2026-10-10', true,
   'At least 300,000 enumerated authorizations and 20% of all authorizations.'),
  ('visa_vamp_enumeration', 'enumeration_count', 'global', 'merchant', '2026-01-01', null, 300000, null, 'count',
   'https://docs.stripe.com/disputes/monitoring-programs', '2026-10-10', true,
   'Enumerated authorizations in the month.'),
  -- Mastercard ECM / HECM: chargebacks of the month / settled Mastercard payments of the PREVIOUS month.
  ('mc_ecm', 'chargeback_count', 'global', 'merchant', '2026-01-01', null, 100, null, 'count',
   'https://docs.stripe.com/disputes/monitoring-programs', '2026-10-10', true,
   'ECM: 100-299 chargebacks with a ratio of 1.5-2.99%. Fines from the second month; exit after three months below.'),
  ('mc_ecm', 'chargeback_ratio', 'global', 'merchant', '2026-01-01', null, 0.015, 100, 'ratio',
   'https://docs.stripe.com/disputes/monitoring-programs', '2026-10-10', true,
   'Chargebacks of the month over settled Mastercard payments of the previous month.'),
  ('mc_hecm', 'chargeback_count', 'global', 'merchant', '2026-01-01', null, 300, null, 'count',
   'https://docs.stripe.com/disputes/monitoring-programs', '2026-10-10', true,
   'HECM: at least 300 chargebacks with a ratio of at least 3%.'),
  ('mc_hecm', 'chargeback_ratio', 'global', 'merchant', '2026-01-01', null, 0.03, 300, 'ratio',
   'https://docs.stripe.com/disputes/monitoring-programs', '2026-10-10', true,
   'Same denominator as ECM (previous month).'),
  -- Mastercard EFM: fraud chargebacks (4837 / 4863) / e-commerce transactions of the previous month, plus the 3DS share.
  ('mc_efm', 'ecom_transaction_count', 'global', 'merchant', '2026-01-01', null, 1000, null, 'count',
   'https://docs.stripe.com/disputes/monitoring-programs', '2026-10-10', true,
   'Entry condition: at least 1,000 e-commerce transactions in the previous month.'),
  ('mc_efm', 'fraud_chargeback_amount_usd', 'global', 'merchant', '2026-01-01', null, 50000, null, 'usd',
   'https://docs.stripe.com/disputes/monitoring-programs', '2026-10-10', true,
   'Fraud chargebacks above USD 50,000 in the month.'),
  ('mc_efm', 'fraud_chargeback_ratio', 'global', 'merchant', '2026-01-01', null, 0.005, 1000, 'ratio',
   'https://docs.stripe.com/disputes/monitoring-programs', '2026-10-10', true,
   'Fraud chargebacks over e-commerce transactions of the previous month above 0.50%. When ECM / ECP and EFM both apply, EFM does.'),
  ('mc_efm', 'three_ds_share_max', 'non_regulated', 'merchant', '2026-01-01', null, 0.10, null, 'share',
   'https://docs.stripe.com/disputes/monitoring-programs', '2026-10-10', true,
   'EFM applies only while the 3DS share of e-commerce transactions is at most 10% (non-regulated markets).'),
  ('mc_efm', 'three_ds_share_max', 'regulated', 'merchant', '2026-01-01', null, 0.50, null, 'share',
   'https://docs.stripe.com/disputes/monitoring-programs', '2026-10-10', true,
   'EFM applies only while the 3DS share is at most 50% (regulated markets).'),
  -- Re-attempt rules: SECONDARY sources, UNVERIFIED (plan D, AC; owner decision 8).
  ('visa_reattempts', 'reattempts_per_card_30d', 'global', 'card', '2026-01-01', null, 15, null, 'count',
   'https://www.payway.com/visa-excessive-reattempts-rule-fees', '2026-10-10', false,
   'UNVERIFIED. Visa decline categories 2-4: more than 15 re-attempts per card in 30 days is excessive (the PayPal page says 20). Confirm with the acquirer.'),
  ('visa_reattempts', 'reattempts_after_category_1', 'global', 'card', '2026-01-01', null, 0, null, 'count',
   'https://www.payway.com/visa-excessive-reattempts-rule-fees', '2026-10-10', false,
   'UNVERIFIED. Visa decline category 1 (issuer will never approve): any re-attempt on the same credential.'),
  ('mc_mac', 'reattempts_after_mac_03_21_30d', 'global', 'card', '2026-01-01', null, 0, null, 'count',
   'https://www.paypal.com/us/brc/article/avoid-excessive-retries-penalties', '2026-10-10', false,
   'UNVERIFIED. Mastercard MAC 03 (do not try again) / 21 (payment cancellation): a repeat of the same card within 30 days.'),
  ('mc_tpe', 'retries_per_card_24h', 'global', 'card', '2026-01-01', null, 10, null, 'count',
   'https://www.paypal.com/us/brc/article/avoid-excessive-retries-penalties', '2026-10-10', false,
   'UNVERIFIED. Mastercard Transaction Excellence Program: more than 10 retries of a soft decline in 24 hours. Not in plan D; reference only.'),
  ('mc_tpe', 'retries_per_card_30d', 'global', 'card', '2026-01-01', null, 35, null, 'count',
   'https://www.paypal.com/us/brc/article/avoid-excessive-retries-penalties', '2026-10-10', false,
   'UNVERIFIED. Mastercard Transaction Excellence Program: more than 35 retries of a soft decline in 30 days. Not in plan D; reference only.')
on conflict (program, metric_key, region, scope, effective_from) do nothing;


-- ---------------------------------------------------------------------------
-- Grants on the functions. A new function is EXECUTE-able by PUBLIC (and
-- Supabase's default privileges add anon / authenticated), so each is stated.
-- The trigger function needs no caller privilege (the trigger's creator had
-- it); the sync is the Edge's (service_role).
-- ---------------------------------------------------------------------------

revoke all on function public.payment_health_set_updated_at() from public, anon, authenticated, service_role;
revoke all on function public.psp_accounts_sync(uuid, boolean) from public, anon, authenticated;
grant execute on function public.psp_accounts_sync(uuid, boolean) to service_role;


-- ---------------------------------------------------------------------------
-- Fail closed: no registry (nor the sync state) is reachable by a browser role, and all have RLS.
-- ---------------------------------------------------------------------------

do $$
declare
  v_open text;
begin
  select string_agg(c.relname, ', ' order by c.relname) into v_open
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname in ('psp_accounts', 'psp_accounts_sync_state', 'network_program_thresholds')
    and (
      not c.relrowsecurity
      or has_table_privilege('anon', c.oid, 'SELECT, INSERT, UPDATE, DELETE')
      or has_table_privilege('authenticated', c.oid, 'SELECT, INSERT, UPDATE, DELETE')
    );
  if v_open is not null then
    raise exception 'payment_health_registries: registry table(s) reachable by a browser role or without RLS: %', v_open;
  end if;
end
$$;
