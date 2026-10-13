-- Payment System Health, phase P2.5 (plan sections Q, P, X, N; plan AA row
-- P2.5): the alert engine's tables and the SQL functions that are the ONLY
-- way to change them.
--
--   1. public.payment_alert_rules -- one row per MVP rule (approval_drop,
--      issuer_fraud_rise, psp_integration_rise, post_ban_retries,
--      excessive_reattempts, unauthorized_complaints_rise, refund_rate_rise,
--      data_stale) with its warning / critical thresholds (in the rule's unit:
--      percentage points, a count, days), min_sample, window_days, the
--      comparison ('previous_window') and the other parameters in jsonb.
--      Seeded ON CONFLICT DO NOTHING: an owner's edit (thresholds, enabled,
--      params) is never reset by a re-apply. Network-ratio rules (VAMP / ECP)
--      are P4 and are not here.
--   2. public.payment_alert_runs -- one row per engine run (cron or manual):
--      the rate limit's memory (an Edge isolate has none worth trusting), the
--      run's summary for the UI ("last run"), and the failure text, which
--      never leaves the database.
--   3. public.payment_risk_alerts -- the alerts. alert_key = rule | scope_key |
--      window_end is unique per data key, so a daily run over the same data
--      window refreshes a row instead of adding one; scope_key (rule + scope)
--      is the condition's identity across windows. Labels and opaque keys only
--      (no MID / descriptor values, no emails, card data, tokens or IPs); the
--      explanation is the recommendation library's (fact -> likely explanation
--      -> unverified hypothesis -> compliant actions). A check constraint holds
--      the plan's rule that a low-confidence alert is never warning / critical.
--      psp_scoped is generated from scope.kind: the Edge filters on it for a
--      caller without payment_health.psp_global.view.
--
-- Functions (SECURITY DEFINER, search_path pinned, executable by service_role
-- only; the tables grant the service role SELECT alone, so a status can change
-- only through them -- with its history entry and its audit row):
--   payment_alerts_claim_run    -- serializes runs per data key (advisory xact
--                                  lock), refuses inside p_min_interval_seconds
--                                  of the last run or while one is running
--                                  (10-minute stale bound), opens the run row;
--   payment_alerts_apply_run    -- one transaction per run: refresh (same alert
--                                  key; an auto-resolved alert reopens, owner
--                                  statuses are kept), carry forward (an open
--                                  alert of the same rule + scope from an
--                                  earlier window takes the new window and
--                                  keeps status, assignee and history; also
--                                  under a former scope key the candidate
--                                  names in scope_aliases),
--                                  suppress (an alert repeating the evidence
--                                  of an owner-closed alert of the same
--                                  condition, unless more severe: a count
--                                  alert whose newest event it covered, a
--                                  rate alert whose window overlaps its own),
--                                  insert; then auto-resolve the open alerts
--                                  of the conditions the run found CLEAR
--                                  (status resolved, auto_resolved true;
--                                  dismissed and owner-resolved alerts are
--                                  never touched);
--   payment_alerts_fail_run     -- closes a run that failed;
--   payment_alert_update_status -- a person's status change: the transition
--                                  table (new -> investigating / resolved /
--                                  dismissed; investigating -> resolved /
--                                  dismissed; resolved / dismissed ->
--                                  investigating) under a row lock, the
--                                  history entry (with the optional note) and
--                                  the access_audit_log row through
--                                  public.access_write_audit, in one transaction.
--
-- RLS on, no policies, nothing for anon / authenticated (202610070001
-- conventions: the browser reads through the Edge only).
--
-- APPLY ORDER: after 202610120001 (guarded below: app.is_privileged_permission
-- must already call payment_health.manage_alerts privileged -- the key that
-- gates every write here). Apply this file on its own, as ONE transaction
-- (supabase db push does): the guard aborts the whole file. Re-applying is
-- safe: tables are IF NOT EXISTS, the seed inserts only missing rules,
-- functions are CREATE OR REPLACE and the grants are restated.

do $$
begin
  if to_regprocedure('app.is_privileged_permission(text)') is null
    or not app.is_privileged_permission('payment_health.manage_alerts')
    or to_regprocedure('public.payment_health_set_updated_at()') is null
    or to_regprocedure('public.access_write_audit(text, text, uuid, text, text, text, text, jsonb, jsonb, jsonb)') is null then
    raise exception using
      errcode = 'P0001',
      message = 'payment_health_alerts: 202610120001_payment_health_permissions.sql has not been applied',
      hint = 'Apply 202610120001 (payment_health.manage_alerts privileged) first; this migration follows the payment health series (README "Payment health P2.5").';
  end if;
end
$$;


-- ---------------------------------------------------------------------------
-- 1. payment_alert_rules
-- ---------------------------------------------------------------------------

create table if not exists public.payment_alert_rules (
  rule_key text primary key,
  enabled boolean not null default true,
  -- The rule's main threshold in its unit: percentage points (rate rules), a count (retry rules), days (data_stale).
  severity_warning numeric not null,
  severity_critical numeric not null,
  -- Observations per window (both windows of a comparison) for a high-confidence alert (plan P: 200 attempts).
  min_sample integer not null default 200,
  window_days integer not null default 7,
  compare text not null default 'previous_window',
  -- Rule-specific parameters: min_sample_info, maturity_days, sync_warning_hours, sync_critical_hours.
  params jsonb not null default '{}'::jsonb,
  description text not null,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payment_alert_rules_key_check check (rule_key ~ '^[a-z][a-z0-9_]{2,60}$'),
  constraint payment_alert_rules_thresholds_check check (severity_warning >= 0 and severity_critical >= severity_warning),
  constraint payment_alert_rules_min_sample_check check (min_sample > 0),
  constraint payment_alert_rules_window_check check (window_days between 1 and 90),
  constraint payment_alert_rules_compare_check check (compare = 'previous_window'),
  constraint payment_alert_rules_params_check check (jsonb_typeof(params) = 'object'),
  constraint payment_alert_rules_description_check check (btrim(description) <> '' and char_length(description) <= 1000)
);

comment on table public.payment_alert_rules is
  'Payment System Health alert rules (plan Q, P2.5): thresholds and parameters the owner may edit; the seed never resets an edit.';

drop trigger if exists payment_alert_rules_set_updated_at on public.payment_alert_rules;
create trigger payment_alert_rules_set_updated_at
before update on public.payment_alert_rules
for each row
execute function public.payment_health_set_updated_at();

-- The MVP rules. Mirrors DEFAULT_ALERT_RULES in paymentRiskAlertsContract.ts (a
-- parity test reads this block). Missing rules are added; existing rows -- the
-- owner's thresholds, enabled flags and params -- are left as they are.
insert into public.payment_alert_rules
  (rule_key, enabled, severity_warning, severity_critical, min_sample, window_days, compare, params, description)
values
  ('approval_drop', true, 5, 10, 200, 7, 'previous_window', '{"min_sample_info": 50}',
   'Attempt approval per PSP x MID and initiation (CIT / MIT), and per PSP with more than one MID, fell by at least the threshold in percentage points against the previous window, outside both 95% Wilson intervals.'),
  ('issuer_fraud_rise', true, 1, 2.5, 200, 7, 'previous_window', '{"min_sample_info": 50}',
   'Issuer fraud-suspicion declines (codes 59 / 63 / 83, else Primer SUSPECTED_FRAUD) per PSP x MID rose by at least the threshold in percentage points of attempts, significant per Wilson. The issuers'' suspicion, not confirmed fraud.'),
  ('psp_integration_rise', true, 1, 3, 200, 7, 'previous_window', '{"min_sample_info": 50}',
   'PSP / integration declines (AUTHORIZATION_FAILED without an issuer code) per PSP x MID, and those plus the unrouted declines (cause not verified) over all attempts, rose by at least the threshold in percentage points, significant per Wilson.'),
  ('post_ban_retries', true, 1, 10, 1, 30, 'previous_window', '{}',
   'Re-attempts on a card after a do-not-retry decline (DO_NOT_RETRY / STOP_ALL_PAYMENTS, Visa category 1, Mastercard MAC 03 / 21) in the last 30 days, CIT and MIT separately. The thresholds are counts. Network rules from secondary sources (unverified).'),
  ('excessive_reattempts', true, 1, 5, 1, 30, 'previous_window', '{}',
   'Card x merchant-account pairs with more than 15 declines in a rolling 30-day window ending in the last 30 days (attemptChains.ts; the Visa limit, unverified). The thresholds are counts of pairs.'),
  ('unauthorized_complaints_rise', true, 1, 3, 200, 7, 'previous_window', '{"min_sample_info": 50}',
   'Support requests flagged possible_unauthorized_charge per settled payment, attributed to the PSP x MID of the customer''s last settled payment within 30 days, rose by at least the threshold in percentage points, significant per Wilson. By received date: low confidence only while the support data does not reach the window''s end.'),
  ('refund_rate_rise', true, 1, 2.5, 200, 7, 'previous_window', '{"min_sample_info": 50, "maturity_days": 30}',
   'Refund rate per PSP x MID by original payment date rose by at least the threshold in percentage points, significant per Wilson, on the newest MATURE window (ending maturity_days before data_through).'),
  ('data_stale', true, 7, 14, 1, 1, 'previous_window', '{"sync_warning_hours": 72, "sync_critical_hours": 168}',
   'The newest attempt in the warehouse (data_through) is older than the thresholds in days, or the last ClickHouse sync of payment rows or of support requests is older than sync_warning_hours / sync_critical_hours.')
on conflict (rule_key) do nothing;


-- ---------------------------------------------------------------------------
-- 2. payment_alert_runs
-- ---------------------------------------------------------------------------

create table if not exists public.payment_alert_runs (
  id uuid primary key default gen_random_uuid(),
  -- The workspace data key (plan D1).
  auth_user_id uuid not null references auth.users (id) on delete cascade,
  trigger text not null,
  -- The member who asked (manual runs); null for the scheduler.
  actor_user_id uuid,
  status text not null default 'running',
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  data_through date,
  -- windows, per-rule outcomes, counts (the Edge's summary plus 'applied').
  summary jsonb not null default '{}'::jsonb,
  -- Failure text (may quote the warehouse): server-side only, never returned by alerts_list.
  error text,
  constraint payment_alert_runs_trigger_check check (trigger in ('cron', 'manual')),
  constraint payment_alert_runs_status_check check (status in ('running', 'succeeded', 'failed')),
  constraint payment_alert_runs_finished_check check ((status = 'running') = (finished_at is null)),
  constraint payment_alert_runs_summary_check check (jsonb_typeof(summary) = 'object'),
  constraint payment_alert_runs_error_check check (error is null or char_length(error) <= 1000)
);

create index if not exists payment_alert_runs_recent_idx on public.payment_alert_runs (auth_user_id, started_at desc);

comment on table public.payment_alert_runs is
  'Payment System Health alert engine runs: rate limit, last-run summary for the UI, failure text (server-side only).';


-- ---------------------------------------------------------------------------
-- 3. payment_risk_alerts
-- ---------------------------------------------------------------------------

create table if not exists public.payment_risk_alerts (
  id uuid primary key default gen_random_uuid(),
  -- The workspace data key (plan D1).
  auth_user_id uuid not null references auth.users (id) on delete cascade,
  rule_key text not null references public.payment_alert_rules (rule_key) on update cascade on delete restrict,
  -- rule | scope_key | window_end: a re-run over the same data window updates the row.
  alert_key text not null,
  -- rule + scope: the condition across windows (carry forward, auto-resolve).
  scope_key text not null,
  severity text not null,
  status text not null default 'new',
  -- {kind: account | tenant, processor {key,label}, merchant_account {key,label,processor,labelled}, initiation, subject}: labels and opaque keys only.
  scope jsonb not null default '{}'::jsonb,
  psp_scoped boolean generated always as (coalesce(scope ->> 'kind', '') = 'account') stored,
  -- Funnel labels (acquisition anchor) that moved the metric most.
  affected_funnels text[] not null default '{}'::text[],
  metric text not null,
  -- rate (a fraction 0..1; change_value in percentage points), count, days, hours.
  unit text not null,
  current_value numeric,
  baseline_value numeric,
  change_value numeric,
  sample_size integer not null default 0,
  data_confidence text not null,
  window_start date,
  window_end date not null,
  -- Numbers and the page request that reproduces them (evidence.reproduce).
  evidence jsonb not null default '{}'::jsonb,
  -- {fact, likely_explanation, hypothesis, action[]} from paymentRiskRecommendations.ts.
  explanation jsonb not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  resolved_at timestamptz,
  auto_resolved boolean not null default false,
  assignee uuid,
  -- [{at, event, from, to, by, auto, note}], appended by the engine and by payment_alert_update_status.
  status_history jsonb not null default '[]'::jsonb,
  last_run_id uuid references public.payment_alert_runs (id) on delete set null,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payment_risk_alerts_alert_key unique (auth_user_id, alert_key),
  constraint payment_risk_alerts_alert_key_check check (char_length(alert_key) between 1 and 400),
  constraint payment_risk_alerts_scope_key_check check (char_length(scope_key) between 1 and 300),
  constraint payment_risk_alerts_severity_check check (severity in ('info', 'warning', 'critical')),
  constraint payment_risk_alerts_status_check check (status in ('new', 'investigating', 'resolved', 'dismissed')),
  constraint payment_risk_alerts_confidence_check check (data_confidence in ('high', 'low')),
  -- Plan Q: an alert from a low sample or an incomplete window is only ever 'info'.
  constraint payment_risk_alerts_low_confidence_check check (data_confidence = 'high' or severity = 'info'),
  constraint payment_risk_alerts_unit_check check (unit in ('rate', 'count', 'days', 'hours')),
  constraint payment_risk_alerts_metric_check check (btrim(metric) <> ''),
  constraint payment_risk_alerts_sample_check check (sample_size >= 0),
  constraint payment_risk_alerts_window_check check (window_start is null or window_start <= window_end),
  constraint payment_risk_alerts_resolved_check check ((status = 'resolved') = (resolved_at is not null)),
  constraint payment_risk_alerts_auto_resolved_check check (not auto_resolved or status = 'resolved'),
  constraint payment_risk_alerts_scope_shape_check check (jsonb_typeof(scope) = 'object'),
  constraint payment_risk_alerts_evidence_shape_check check (jsonb_typeof(evidence) = 'object'),
  constraint payment_risk_alerts_history_shape_check check (jsonb_typeof(status_history) = 'array'),
  constraint payment_risk_alerts_explanation_shape_check check (
    jsonb_typeof(explanation) = 'object'
    and explanation ?& array['fact', 'likely_explanation', 'hypothesis', 'action']
    and jsonb_typeof(explanation -> 'action') = 'array'
  )
);

create index if not exists payment_risk_alerts_open_idx
  on public.payment_risk_alerts (auth_user_id, rule_key, scope_key) where status in ('new', 'investigating');
create index if not exists payment_risk_alerts_seen_idx on public.payment_risk_alerts (auth_user_id, last_seen_at desc);

comment on table public.payment_risk_alerts is
  'Payment System Health alerts (plan Q): one row per rule x scope episode; labels and opaque keys only. Written only by the payment_alerts_* / payment_alert_update_status functions.';

drop trigger if exists payment_risk_alerts_set_updated_at on public.payment_risk_alerts;
create trigger payment_risk_alerts_set_updated_at
before update on public.payment_risk_alerts
for each row
execute function public.payment_health_set_updated_at();


-- ---------------------------------------------------------------------------
-- Privileges: RLS on, no policies; the browser roles get nothing, the service
-- role reads (the Edge's alerts_list) and writes only through the functions.
-- ---------------------------------------------------------------------------

alter table public.payment_alert_rules enable row level security;
alter table public.payment_alert_runs enable row level security;
alter table public.payment_risk_alerts enable row level security;
revoke all on table public.payment_alert_rules, public.payment_alert_runs, public.payment_risk_alerts from public, anon, authenticated, service_role;
grant select on table public.payment_alert_rules, public.payment_alert_runs, public.payment_risk_alerts to service_role;


-- ---------------------------------------------------------------------------
-- 4. Functions
-- ---------------------------------------------------------------------------

-- Opens a run, or refuses: inside p_min_interval_seconds of the last run's
-- start (a person: 300 s; the scheduler: 60 s), or while a run started less
-- than 10 minutes ago is still running. Two concurrent callers serialize on
-- the advisory lock, so the second sees the first's row. A run left running
-- past the stale bound (an Edge isolate that died) is closed as failed.
create or replace function public.payment_alerts_claim_run(
  p_data_key uuid,
  p_trigger text,
  p_actor uuid,
  p_min_interval_seconds integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_last public.payment_alert_runs%rowtype;
  v_wait numeric := 0;
  v_id uuid;
  v_started timestamptz;
begin
  if p_data_key is null then
    raise exception using errcode = 'P0001', message = 'invalid: the data key is required';
  end if;
  if p_trigger is null or p_trigger not in ('cron', 'manual') then
    raise exception using errcode = 'P0001', message = 'invalid: trigger must be cron or manual';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('payment_alerts_claim_run:' || p_data_key::text, 0));

  select * into v_last
  from public.payment_alert_runs r
  where r.auth_user_id = p_data_key
  order by r.started_at desc
  limit 1;
  if found then
    v_wait := greatest(
      extract(epoch from (v_last.started_at + make_interval(secs => greatest(coalesce(p_min_interval_seconds, 0), 0)) - now())),
      case
        when v_last.status = 'running' and v_last.started_at > now() - interval '10 minutes'
          then extract(epoch from (v_last.started_at + interval '10 minutes' - now()))
        else 0
      end
    );
    if v_wait > 0 then
      return jsonb_build_object(
        'claimed', false,
        'retry_after_seconds', ceil(v_wait)::integer,
        'last_started_at', v_last.started_at,
        'last_status', v_last.status
      );
    end if;
  end if;

  update public.payment_alert_runs r
  set status = 'failed', finished_at = now(), error = 'abandoned: no result within 10 minutes'
  where r.auth_user_id = p_data_key and r.status = 'running';

  insert into public.payment_alert_runs (auth_user_id, trigger, actor_user_id)
  values (p_data_key, p_trigger, p_actor)
  returning id, started_at into v_id, v_started;

  return jsonb_build_object('claimed', true, 'run_id', v_id, 'started_at', v_started);
end;
$$;

-- Applies one run's evaluation (see the header). p_alerts: the candidates
-- (alert_key, scope_key, rule_key, severity, scope, affected_funnels, metric,
-- unit, current / baseline / change values, sample_size, data_confidence,
-- window_start, window_end, evidence, explanation, newest_event_day,
-- scope_aliases -- the keys the same scope had before, read for matching and
-- never stored); p_cleared: [{rule_key, scope_key}] the run found
-- conclusively clear (the engine lists the aliases there too).
create or replace function public.payment_alerts_apply_run(
  p_run_id uuid,
  p_data_key uuid,
  p_alerts jsonb,
  p_cleared jsonb,
  p_summary jsonb,
  p_data_through date
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_run public.payment_alert_runs%rowtype;
  v_alert jsonb;
  v_clear jsonb;
  v_existing public.payment_risk_alerts%rowtype;
  v_now timestamptz := now();
  v_scopes text[];
  v_newest date;
  v_count integer;
  v_inserted integer := 0;
  v_updated integer := 0;
  v_carried integer := 0;
  v_reopened integer := 0;
  v_suppressed integer := 0;
  v_resolved integer := 0;
  v_applied jsonb;
begin
  select * into v_run
  from public.payment_alert_runs r
  where r.id = p_run_id and r.auth_user_id = p_data_key
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'invalid: unknown alert run';
  end if;
  if v_run.status <> 'running' then
    raise exception using errcode = 'P0001', message = 'invalid: the alert run is already closed';
  end if;
  if jsonb_typeof(coalesce(p_alerts, '[]'::jsonb)) <> 'array' or jsonb_typeof(coalesce(p_cleared, '[]'::jsonb)) <> 'array' then
    raise exception using errcode = 'P0001', message = 'invalid: alerts and cleared must be arrays';
  end if;

  for v_alert in select value from jsonb_array_elements(coalesce(p_alerts, '[]'::jsonb)) loop
    -- 1. The same window again: refresh the figures. An auto-resolved alert that fires again reopens;
    --    any other status (an owner's investigating / resolved / dismissed) is kept.
    select * into v_existing
    from public.payment_risk_alerts a
    where a.auth_user_id = p_data_key and a.alert_key = v_alert ->> 'alert_key'
    for update;
    if found then
      update public.payment_risk_alerts a
      set severity = v_alert ->> 'severity',
          scope = coalesce(v_alert -> 'scope', '{}'::jsonb),
          affected_funnels = coalesce(array(select jsonb_array_elements_text(coalesce(v_alert -> 'affected_funnels', '[]'::jsonb))), '{}'::text[]),
          metric = v_alert ->> 'metric',
          unit = v_alert ->> 'unit',
          current_value = (v_alert ->> 'current_value')::numeric,
          baseline_value = (v_alert ->> 'baseline_value')::numeric,
          change_value = (v_alert ->> 'change_value')::numeric,
          sample_size = coalesce((v_alert ->> 'sample_size')::integer, 0),
          data_confidence = v_alert ->> 'data_confidence',
          evidence = coalesce(v_alert -> 'evidence', '{}'::jsonb),
          explanation = v_alert -> 'explanation',
          last_seen_at = v_now,
          last_run_id = p_run_id,
          status = case when a.status = 'resolved' and a.auto_resolved then 'new' else a.status end,
          resolved_at = case when a.status = 'resolved' and a.auto_resolved then null else a.resolved_at end,
          auto_resolved = case when a.status = 'resolved' and a.auto_resolved then false else a.auto_resolved end,
          status_history = case
            when a.status = 'resolved' and a.auto_resolved then a.status_history || jsonb_build_array(jsonb_build_object(
              'at', v_now, 'event', 'reopened', 'from', 'resolved', 'to', 'new', 'by', null, 'auto', true, 'note', null))
            else a.status_history
          end
      where a.id = v_existing.id;
      if v_existing.status = 'resolved' and v_existing.auto_resolved then
        v_reopened := v_reopened + 1;
      else
        v_updated := v_updated + 1;
      end if;
      continue;
    end if;

    -- The condition's keys: its scope key, and the keys the same scope had before (scope_aliases: an
    -- "Unlabelled MID" that psp_accounts_sync has registered since keeps its alerts' identity).
    v_scopes := array[v_alert ->> 'scope_key'] || coalesce(array(
      select jsonb_array_elements_text(case when jsonb_typeof(v_alert -> 'scope_aliases') = 'array' then v_alert -> 'scope_aliases' else '[]'::jsonb end)
    ), '{}'::text[]);

    -- 2. The same condition still open from an earlier window: the episode continues on the new window
    --    (under the current scope key when it was open under an alias).
    select * into v_existing
    from public.payment_risk_alerts a
    where a.auth_user_id = p_data_key
      and a.rule_key = v_alert ->> 'rule_key'
      and a.scope_key = any (v_scopes)
      and a.status in ('new', 'investigating')
    order by (a.scope_key = v_alert ->> 'scope_key') desc, a.window_end desc, a.last_seen_at desc
    limit 1
    for update;
    if found then
      update public.payment_risk_alerts a
      set alert_key = v_alert ->> 'alert_key',
          scope_key = v_alert ->> 'scope_key',
          severity = v_alert ->> 'severity',
          scope = coalesce(v_alert -> 'scope', '{}'::jsonb),
          affected_funnels = coalesce(array(select jsonb_array_elements_text(coalesce(v_alert -> 'affected_funnels', '[]'::jsonb))), '{}'::text[]),
          metric = v_alert ->> 'metric',
          unit = v_alert ->> 'unit',
          current_value = (v_alert ->> 'current_value')::numeric,
          baseline_value = (v_alert ->> 'baseline_value')::numeric,
          change_value = (v_alert ->> 'change_value')::numeric,
          sample_size = coalesce((v_alert ->> 'sample_size')::integer, 0),
          data_confidence = v_alert ->> 'data_confidence',
          window_start = (v_alert ->> 'window_start')::date,
          window_end = (v_alert ->> 'window_end')::date,
          evidence = coalesce(v_alert -> 'evidence', '{}'::jsonb),
          explanation = v_alert -> 'explanation',
          last_seen_at = v_now,
          last_run_id = p_run_id
      where a.id = v_existing.id;
      v_carried := v_carried + 1;
      continue;
    end if;

    -- 3. The evidence of an owner-closed alert (dismissed, or resolved by a person) of the same condition
    --    again: not news, so suppressed -- unless this one is more severe. A count alert repeats it when
    --    its newest event is no newer than the closed alert's window_end (a sliding 30-day window
    --    re-showing old re-attempts). A rate alert (no newest_event_day) repeats it while its window
    --    overlaps the closed one: window_end follows data_through, so every import is a new alert_key,
    --    and the next 7-day window shares 6 days with the one the owner closed. Once the overlap ends,
    --    a condition that still holds is a new alert. A freshness line without a window compares its end.
    v_newest := coalesce(
      nullif(v_alert ->> 'newest_event_day', '')::date,
      nullif(v_alert ->> 'window_start', '')::date,
      (v_alert ->> 'window_end')::date
    );
    if exists (
      select 1
      from public.payment_risk_alerts a
      where a.auth_user_id = p_data_key
        and a.rule_key = v_alert ->> 'rule_key'
        and a.scope_key = any (v_scopes)
        and (a.status = 'dismissed' or (a.status = 'resolved' and not a.auto_resolved))
        and a.window_end >= v_newest
        and (case v_alert ->> 'severity' when 'critical' then 2 when 'warning' then 1 else 0 end)
          <= (case a.severity when 'critical' then 2 when 'warning' then 1 else 0 end)
    ) then
      v_suppressed := v_suppressed + 1;
      continue;
    end if;

    -- 4. New.
    insert into public.payment_risk_alerts (
      auth_user_id, rule_key, alert_key, scope_key, severity, status, scope, affected_funnels, metric, unit,
      current_value, baseline_value, change_value, sample_size, data_confidence, window_start, window_end,
      evidence, explanation, first_seen_at, last_seen_at, status_history, last_run_id
    ) values (
      p_data_key,
      v_alert ->> 'rule_key',
      v_alert ->> 'alert_key',
      v_alert ->> 'scope_key',
      v_alert ->> 'severity',
      'new',
      coalesce(v_alert -> 'scope', '{}'::jsonb),
      coalesce(array(select jsonb_array_elements_text(coalesce(v_alert -> 'affected_funnels', '[]'::jsonb))), '{}'::text[]),
      v_alert ->> 'metric',
      v_alert ->> 'unit',
      (v_alert ->> 'current_value')::numeric,
      (v_alert ->> 'baseline_value')::numeric,
      (v_alert ->> 'change_value')::numeric,
      coalesce((v_alert ->> 'sample_size')::integer, 0),
      v_alert ->> 'data_confidence',
      (v_alert ->> 'window_start')::date,
      (v_alert ->> 'window_end')::date,
      coalesce(v_alert -> 'evidence', '{}'::jsonb),
      v_alert -> 'explanation',
      v_now,
      v_now,
      jsonb_build_array(jsonb_build_object('at', v_now, 'event', 'raised', 'from', null, 'to', 'new', 'by', null, 'auto', true, 'note', null)),
      p_run_id
    );
    v_inserted := v_inserted + 1;
  end loop;

  -- Auto-resolve: open alerts (new / investigating) of the conditions found clear. Dismissed and
  -- owner-resolved alerts are not open and are never touched.
  for v_clear in select value from jsonb_array_elements(coalesce(p_cleared, '[]'::jsonb)) loop
    with resolved as (
      update public.payment_risk_alerts a
      set status = 'resolved',
          resolved_at = v_now,
          auto_resolved = true,
          last_run_id = p_run_id,
          status_history = a.status_history || jsonb_build_array(jsonb_build_object(
            'at', v_now, 'event', 'auto_resolved', 'from', a.status, 'to', 'resolved', 'by', null, 'auto', true, 'note', null))
      where a.auth_user_id = p_data_key
        and a.rule_key = v_clear ->> 'rule_key'
        and a.scope_key = v_clear ->> 'scope_key'
        and a.status in ('new', 'investigating')
      returning 1
    )
    select count(*) into v_count from resolved;
    v_resolved := v_resolved + v_count;
  end loop;

  v_applied := jsonb_build_object(
    'inserted', v_inserted, 'updated', v_updated, 'carried', v_carried, 'reopened', v_reopened,
    'suppressed', v_suppressed, 'auto_resolved', v_resolved
  );
  update public.payment_alert_runs r
  set status = 'succeeded',
      finished_at = v_now,
      data_through = p_data_through,
      summary = coalesce(case when jsonb_typeof(p_summary) = 'object' then p_summary end, '{}'::jsonb) || jsonb_build_object('applied', v_applied)
  where r.id = p_run_id;
  return v_applied;
end;
$$;

-- Closes a run whose evaluation or apply failed (the text stays in the database).
create or replace function public.payment_alerts_fail_run(p_run_id uuid, p_data_key uuid, p_error text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  update public.payment_alert_runs r
  set status = 'failed', finished_at = now(), error = left(coalesce(nullif(btrim(p_error), ''), 'failed'), 1000)
  where r.id = p_run_id and r.auth_user_id = p_data_key and r.status = 'running';
end;
$$;

-- A person's status change (alert_update; the Edge has checked
-- payment_health.manage_alerts and that the caller may see the alert). The
-- transition table mirrors ALERT_STATUS_TRANSITIONS in
-- paymentRiskAlertsContract.ts (a parity test reads both). Errors: P0002
-- 'not_found: ...', P0001 'invalid_transition: <from> -> <to>' / 'invalid: ...'.
-- The audit row (payment_health.alert_status_changed) carries statuses and
-- ids only, never the note's text.
create or replace function public.payment_alert_update_status(
  p_data_key uuid,
  p_actor uuid,
  p_alert_id uuid,
  p_status text,
  p_note text,
  p_request_id text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_alert public.payment_risk_alerts%rowtype;
  v_allowed text[];
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_now timestamptz := now();
  v_row jsonb;
begin
  if p_data_key is null or p_actor is null then
    raise exception using errcode = 'P0001', message = 'invalid: the data key and the actor are required';
  end if;
  if v_note is not null and char_length(v_note) > 1000 then
    raise exception using errcode = 'P0001', message = 'invalid: the note is longer than 1000 characters';
  end if;

  select * into v_alert
  from public.payment_risk_alerts a
  where a.id = p_alert_id and a.auth_user_id = p_data_key
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'not_found: alert not found';
  end if;

  v_allowed := case v_alert.status
    when 'new' then array['investigating', 'resolved', 'dismissed']
    when 'investigating' then array['resolved', 'dismissed']
    when 'resolved' then array['investigating']
    when 'dismissed' then array['investigating']
    else array[]::text[]
  end;
  if p_status is null or not (p_status = any (v_allowed)) then
    raise exception using errcode = 'P0001', message = 'invalid_transition: ' || v_alert.status || ' -> ' || coalesce(p_status, 'null');
  end if;

  update public.payment_risk_alerts a
  set status = p_status,
      resolved_at = case when p_status = 'resolved' then v_now else null end,
      auto_resolved = false,
      -- Acknowledging assigns the alert to the member who did it, unless someone already holds it.
      assignee = case when p_status = 'investigating' then coalesce(a.assignee, p_actor) else a.assignee end,
      updated_by = p_actor,
      status_history = a.status_history || jsonb_build_array(jsonb_build_object(
        'at', v_now, 'event', 'status', 'from', v_alert.status, 'to', p_status, 'by', p_actor, 'auto', false, 'note', v_note))
  where a.id = v_alert.id
  returning to_jsonb(a.*) into v_row;

  perform public.access_write_audit(
    'payment_health.alert_status_changed',
    'user',
    p_actor,
    'payment_risk_alert',
    v_alert.id::text,
    'success',
    null,
    jsonb_build_object('status', v_alert.status, 'assignee', v_alert.assignee),
    jsonb_build_object('status', p_status, 'assignee', v_row ->> 'assignee', 'note', v_note is not null),
    jsonb_build_object('request_id', p_request_id, 'rule_key', v_alert.rule_key, 'severity', v_alert.severity, 'scope_key', v_alert.scope_key)
  );
  return v_row;
end;
$$;

-- A new function is EXECUTE-able by PUBLIC (and Supabase's default privileges
-- add anon / authenticated): each is stated. The Edge (service_role) only.
revoke all on function public.payment_alerts_claim_run(uuid, text, uuid, integer) from public, anon, authenticated;
revoke all on function public.payment_alerts_apply_run(uuid, uuid, jsonb, jsonb, jsonb, date) from public, anon, authenticated;
revoke all on function public.payment_alerts_fail_run(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.payment_alert_update_status(uuid, uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.payment_alerts_claim_run(uuid, text, uuid, integer) to service_role;
grant execute on function public.payment_alerts_apply_run(uuid, uuid, jsonb, jsonb, jsonb, date) to service_role;
grant execute on function public.payment_alerts_fail_run(uuid, uuid, text) to service_role;
grant execute on function public.payment_alert_update_status(uuid, uuid, uuid, text, text, text) to service_role;


-- ---------------------------------------------------------------------------
-- Fail closed: no table reachable by a browser role or without RLS; the
-- service role cannot write the tables directly; no function open to anon /
-- authenticated.
-- ---------------------------------------------------------------------------

do $$
declare
  v_open text;
  v_functions text;
begin
  select string_agg(c.relname, ', ' order by c.relname) into v_open
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname in ('payment_alert_rules', 'payment_alert_runs', 'payment_risk_alerts')
    and (
      not c.relrowsecurity
      or has_table_privilege('anon', c.oid, 'SELECT, INSERT, UPDATE, DELETE')
      or has_table_privilege('authenticated', c.oid, 'SELECT, INSERT, UPDATE, DELETE')
      or has_table_privilege('service_role', c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE')
    );
  if v_open is not null then
    raise exception 'payment_health_alerts: alert table(s) reachable by an API role or without RLS: %', v_open;
  end if;

  select string_agg(p.oid::regprocedure::text, ', ') into v_functions
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('payment_alerts_claim_run', 'payment_alerts_apply_run', 'payment_alerts_fail_run', 'payment_alert_update_status')
    and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'));
  if v_functions is not null then
    raise exception 'payment_health_alerts: alert function(s) executable by a browser role: %', v_functions;
  end if;
end
$$;
