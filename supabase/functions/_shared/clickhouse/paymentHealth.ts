// Payment System Health P2: the server-side runner behind the
// clickhouse-payment-health Edge function (plan sections G, J, M, N, R, S, X,
// Y). Six actions — overview, declines, retries, refunds_support, sources,
// options — over the same request contract (paymentHealthContract.ts).
//
// How the numbers are made (plan J "способ переиспользования"):
//   * Attempt metrics come STRAIGHT from analytics_transactions with CTE-only
//     SQL: no Payment Pass stage classifier, no pp_staged_* scratch table, so
//     the module can later become scopeReady. Attempts are the rows whose
//     raw_status is not CANCELLED / PENDING (ATTEMPT_RAW_STATUS_EXCLUSION, the
//     same denominator Payment Pass moved to in P0) and successes are
//     is_success — parity with Payment Pass on attempts / successes by
//     processor and day is a test (paymentHealthClickhouse.test.ts).
//   * The current window and the previous window of equal length are read in
//     ONE scan (`period` column), so every figure carries its comparison
//     (comparePeriods: Wilson intervals, sample flags).
//   * Decline classes: the SQL groups declines by the raw code columns
//     (lifecycle_event, issuer_result_code, primer_decline_code, advice_code,
//     advised_action, card_network, processor, decline_type, cascade flag) and
//     the Edge classifies each group with declineTaxonomy.ts — one taxonomy,
//     never a SQL re-implementation of it.
//   * Funnel = the user's ACQUISITION ANCHOR: a LEFT JOIN on the validated
//     fact_user_cohorts snapshot (cohortSnapshotState.ts), 'unattributed'
//     without one. This differs from Payment Pass's per-user argMin (`uattr`):
//     the totals agree, the per-funnel split may not (said in meta.estimates).
//   * MIDs and descriptors never leave the server as values: the registry
//     (public.psp_accounts, service-role read filtered on the data key) gives
//     each (processor, MID) its label and id; an unregistered MID is
//     "Unlabelled MID" with a keyed-hash id; descriptors get numbered labels and
//     keyed-hash ids. Filters name those ids and the runner binds the raw
//     values as query parameters.
//   * Retries: the window's attempt rows (minimal columns, capped at
//     ATTEMPT_ROW_CAP → meta.limited.attempt_rows) are fed to attemptChains.ts
//     in the Edge; the computed report is memoized per workspace + request for
//     PAYMENT_HEALTH_MEMO_TTL_MS like leads.ts (the chain build is the heavy
//     part, the rows are not kept).
//   * Complaints (plan M): fact_support_requests by received month, attributed
//     to the LAST settled payment of matched_user_id within
//     COMPLAINT_ATTRIBUTION_DAYS before received_at, else 'unattributed'.
//
// Every statement binds the tenant as {auth_user_id:String} (the ScopedReader
// forces ctx.tenantKey); every best-effort catch rethrows ScopeViolation (R7).
// Responses carry aggregates only: no emails, user ids, transaction ids,
// card fragments, tokens, IPs, raw MIDs or raw descriptors (plan S).

import type { ClickHouseClientLike, SupabaseLikeClient } from "./types.ts";
import { ANALYTICS_TRANSACTIONS_TABLE, FACT_SUPPORT_REQUESTS_TABLE, FACT_USER_COHORTS_TABLE } from "./schema.ts";
import { ATTEMPT_RAW_STATUS_EXCLUSION } from "./paymentAnalytics.ts";
import { ScopeViolation } from "./scopedClient.ts";
import { activeCohortSnapshotVersion, getCohortSnapshotState } from "./cohortSnapshotState.ts";
import { getTransactionSyncState } from "./summary.ts";
import { sha256Hex } from "../access/scope.ts";
import { DECLINE_CLASS_LABELS, classifyDecline, type DeclineClass, type DeclineClassification, type DeclineSeverity } from "./declineTaxonomy.ts";
import { PAYMENT_HEALTH_METRICS, comparePeriods, decomposeCountChange, rateWithSample, type MetricKey } from "./paymentHealthMetrics.ts";
import { DEFAULT_CHAIN_OPTIONS, buildAttemptChains, retryCompliance, type AttemptRow } from "./attemptChains.ts";
import {
  ATTEMPT_ROW_CAP,
  CODE_MIX_LIMIT,
  COMPLAINT_ATTRIBUTION_DAYS,
  COUNTRY_BASIS,
  COUNTRY_BASIS_LABEL,
  DAILY_TREND_MAX_DAYS,
  DIMENSION_LABELS,
  PAYMENT_HEALTH_DIMENSIONS,
  PAYMENT_HEALTH_MEMO_MAX_ENTRIES,
  PAYMENT_HEALTH_MEMO_TTL_MS,
  POST_BAN_ATTEMPT_LIMIT,
  PSP_DIMENSIONS,
  PaymentHealthRequestError,
  REFUND_MATURITY_DAYS,
  RETRY_LOOKBACK_DAYS,
  ROLLING_WINDOW_LIMIT,
  UNATTRIBUTED_FUNNEL_KEY,
  UNKNOWN_VALUE_KEY,
  UNROUTED_PROCESSOR_KEY,
  WHAT_CHANGED_LIMIT,
  daysInclusive,
  normalizePaymentHealthRequest,
  shiftDay,
  type ApprovalBlock,
  type AttemptTotals,
  type BreakdownRow,
  type CodeMixRow,
  type ColumnCoverage,
  type ComplaintAccountRow,
  type ComplaintCounts,
  type ComplaintMonthRow,
  type DeclineClassRow,
  type DescriptorRef,
  type DimensionValue,
  type DeclinesResponse,
  type MerchantAccountRef,
  type NormalizedPaymentHealthRequest,
  type OptionsResponse,
  type OverviewResponse,
  type PaymentHealthDimension,
  type PaymentHealthMeta,
  type PaymentHealthResponse,
  type PeriodTotals,
  type PostBanAttemptRow,
  type PspMidRow,
  type RefundMonthRow,
  type RefundTimingBuckets,
  type RefundsSupportResponse,
  type RetriesResponse,
  type RollingWindowRow,
  type SourcesResponse,
  type TrendPoint,
  type WhatChangedRow,
} from "./paymentHealthContract.ts";

export { PaymentHealthPermissionError, PaymentHealthRequestError } from "./paymentHealthContract.ts";

const TX = ANALYTICS_TRANSACTIONS_TABLE;
const FC = FACT_USER_COHORTS_TABLE;
const FSR = FACT_SUPPORT_REQUESTS_TABLE;
const TENANT = "auth_user_id = {auth_user_id:String}";

export interface PaymentHealthRunInput {
  /** ctx.tenantKey — the workspace data key, never the caller. */
  tenantKey: string;
  /** The request's ScopedReader. */
  clickhouse: ClickHouseClientLike;
  /** The gate's service-role client (registry, snapshot state, import state). */
  pg: SupabaseLikeClient;
  /** The request body (action included). */
  request: unknown;
  /** payment_health.psp_global.view or the data owner: PSP dimensions may be named and are returned. */
  pspVisible: boolean;
  /** Injectable clock (tests). */
  clock?: () => number;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const n = (value: unknown): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};
const s = (value: unknown): string => (typeof value === "string" ? value : value == null ? "" : String(value));
const nullable = (value: unknown): string | null => {
  const text = s(value).trim();
  return text ? text : null;
};

async function json<T = Record<string, unknown>>(client: ClickHouseClientLike, query: string, params: Record<string, unknown>): Promise<T[]> {
  const rs = await client.query({ query: `${query}\nFORMAT JSONEachRow`, query_params: params, format: "JSONEachRow" });
  return (await rs.json()) as T[];
}

/** UTC day of a clock value. */
function todayOf(clock: () => number): string {
  return new Date(clock()).toISOString().slice(0, 10);
}

/** ClickHouse Date / DateTime text ('2026-10-05' or '2026-10-05 12:00:00.000') → YYYY-MM-DD; null for the 1970 / empty sentinel. */
function dayOf(value: unknown): string | null {
  const text = s(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || text.startsWith("1970-01-01")) return null;
  return text;
}

/** Unix millis (toUnixTimestamp64Milli, Int64 serialized as text) → ISO. */
function isoOfMillis(value: unknown): string {
  const ms = n(value);
  return new Date(ms).toISOString();
}

function titleCase(token: string): string {
  return token.toLowerCase().replace(/(^|[_\s])(\w)/g, (_m, sep: string, ch: string) => `${sep === "_" ? " " : sep}${ch.toUpperCase()}`);
}

/** A stable, opaque id for a registry-less value: keyed by the workspace data key, 16 hex characters. */
async function opaqueId(tenantKey: string, kind: string, ...parts: string[]): Promise<string> {
  return (await sha256Hex([tenantKey, kind, ...parts].join("|"))).slice(0, 16);
}

/** Mutable counters of one group / period (AttemptTotals is the frozen shape). */
function emptyTotals(): AttemptTotals {
  return {
    attempts: 0,
    successes: 0,
    declines: 0,
    settled_amount_usd: 0,
    refunded: 0,
    refund_amount_usd: 0,
    issuer_fraud_declines: 0,
    lost_stolen_declines: 0,
    authentication_declines: 0,
    psp_integration_declines: 0,
    cause_unverified_declines: 0,
    cascade_rows: 0,
    three_ds_attempts: 0,
  };
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function finishTotals(totals: AttemptTotals): AttemptTotals {
  return { ...totals, settled_amount_usd: roundMoney(totals.settled_amount_usd), refund_amount_usd: roundMoney(totals.refund_amount_usd) };
}

/**
 * Plan P: which comparisons of this request may be called significant.
 *   immature        — range.to is after data_through: the import has not
 *                     covered the window (the same expression meta.incomplete
 *                     reports, computed once so the two cannot drift);
 *   refund_immature — data_through is less than REFUND_MATURITY_DAYS past
 *                     range.to: refund and complaint rates by original payment
 *                     date are structurally lower for the newest window, so
 *                     their "improvement" would only be maturity.
 */
interface Maturity {
  immature: boolean;
  refund_immature: boolean;
}

function maturityOf(nreq: NormalizedPaymentHealthRequest, registry: DimensionRegistry): Maturity {
  const last = registry.last_day;
  const immature = last ? nreq.range.to > last : true;
  const refundImmature = last ? shiftDay(nreq.range.to, REFUND_MATURITY_DAYS) > last : true;
  return { immature, refund_immature: immature || refundImmature };
}

function approvalBlock(periods: PeriodTotals, maturity: Maturity): ApprovalBlock {
  return {
    approval: comparePeriods(
      { numerator: periods.current.successes, denominator: periods.current.attempts },
      { numerator: periods.baseline.successes, denominator: periods.baseline.attempts },
      { immature: maturity.immature },
    ),
    issuer_fraud_share: comparePeriods(
      { numerator: periods.current.issuer_fraud_declines, denominator: periods.current.attempts },
      { numerator: periods.baseline.issuer_fraud_declines, denominator: periods.baseline.attempts },
      { immature: maturity.immature },
    ),
    refund_rate: comparePeriods(
      { numerator: periods.current.refunded, denominator: periods.current.successes },
      { numerator: periods.baseline.refunded, denominator: periods.baseline.successes },
      { immature: maturity.refund_immature },
    ),
  };
}

// ---------------------------------------------------------------------------
// Registry: processors, MIDs, descriptors → labels and opaque ids
// ---------------------------------------------------------------------------

interface RegistryAccount {
  id: string;
  processor: string;
  mid: string;
  label: string;
  descriptor_prefix: string | null;
}

interface RegistryRow {
  processor: string;
  mid: string;
  descriptor: string;
  first_seen: string;
  last_seen: string;
  rows: number;
}

export interface DimensionRegistry {
  /** `${processor}\u0000${mid}` → the account reference. */
  accounts: Map<string, MerchantAccountRef>;
  /** account key → the raw (processor, MID) pair to bind. */
  accountsByKey: Map<string, { processor: string; mid: string }>;
  /** `${processor}\u0000${descriptor}` → the descriptor reference. */
  descriptors: Map<string, DescriptorRef>;
  descriptorsByKey: Map<string, { processor: string; descriptor: string }>;
  processors: DimensionValue[];
  first_day: string | null;
  last_day: string | null;
}

const accountMapKey = (processor: string, mid: string) => `${processor}\u0000${mid}`;

export function processorLabel(key: string): string {
  if (key === UNROUTED_PROCESSOR_KEY) return "No processor (declined before routing)";
  return titleCase(key);
}

/** The psp_accounts rows of the tenant (service role: the data key is the only boundary). */
async function loadRegistryAccounts(pg: SupabaseLikeClient, tenantKey: string): Promise<RegistryAccount[]> {
  const { data, error } = await pg
    .from("psp_accounts")
    .select("id,processor,processor_merchant_id,label,descriptor_prefix")
    .eq("auth_user_id", tenantKey);
  if (error) throw new Error(`Could not read the PSP account registry: ${error.message}`);
  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    id: s(row.id),
    processor: s(row.processor).trim().toUpperCase(),
    mid: s(row.processor_merchant_id).trim(),
    label: s(row.label).trim() || "Unlabelled MID",
    descriptor_prefix: nullable(row.descriptor_prefix),
  }));
}

/** The distinct (processor, MID, descriptor) triples of the tenant's attempts, with first / last seen. */
async function loadRegistryRows(clickhouse: ClickHouseClientLike, tenantKey: string): Promise<RegistryRow[]> {
  // Aliases never reuse a source column name (`proc`, not `processor`): an
  // alias that shadows the column its own expression reads is a ClickHouse
  // cyclic-alias trap.
  const rows = await json(
    clickhouse,
    `/* ph:registry */ SELECT if(t.processor = '', '${UNROUTED_PROCESSOR_KEY}', upper(t.processor)) AS proc, t.processor_merchant_id AS mid,
  t.statement_descriptor AS descriptor, toString(min(toDate(t.event_time))) AS first_seen, toString(max(toDate(t.event_time))) AS last_seen, count() AS rows
FROM ${TX} AS t FINAL
WHERE t.${TENANT} AND t.${ATTEMPT_RAW_STATUS_EXCLUSION}
GROUP BY proc, mid, descriptor
ORDER BY proc, first_seen, mid, descriptor`,
    { auth_user_id: tenantKey },
  );
  return rows.map((row) => ({ processor: s(row.proc), mid: s(row.mid), descriptor: s(row.descriptor), first_seen: s(row.first_seen), last_seen: s(row.last_seen), rows: n(row.rows) }));
}

export async function loadDimensionRegistry(input: Pick<PaymentHealthRunInput, "tenantKey" | "clickhouse" | "pg">): Promise<DimensionRegistry> {
  const [accounts, rows] = await Promise.all([loadRegistryAccounts(input.pg, input.tenantKey), loadRegistryRows(input.clickhouse, input.tenantKey)]);
  const byPair = new Map(accounts.map((account) => [accountMapKey(account.processor, account.mid), account]));
  const registry: DimensionRegistry = {
    accounts: new Map(),
    accountsByKey: new Map(),
    descriptors: new Map(),
    descriptorsByKey: new Map(),
    processors: [],
    first_day: null,
    last_day: null,
  };
  const processors = new Set<string>();
  const descriptorFirstSeen = new Map<string, string>();
  for (const row of rows) {
    processors.add(row.processor);
    if (!registry.first_day || row.first_seen < registry.first_day) registry.first_day = row.first_seen;
    if (!registry.last_day || row.last_seen > registry.last_day) registry.last_day = row.last_seen;
    const pair = accountMapKey(row.processor, row.mid);
    if (!registry.accounts.has(pair)) {
      let ref: MerchantAccountRef;
      if (!row.mid) {
        ref = { key: `none:${row.processor}`, label: "No MID", processor: row.processor, labelled: false };
      } else {
        const account = byPair.get(pair);
        ref = account
          ? { key: account.id, label: account.label, processor: row.processor, labelled: true }
          : { key: `unlabelled:${await opaqueId(input.tenantKey, "mid", row.processor, row.mid)}`, label: "Unlabelled MID", processor: row.processor, labelled: false };
      }
      registry.accounts.set(pair, ref);
      registry.accountsByKey.set(ref.key, { processor: row.processor, mid: row.mid });
    }
    const descriptorKey = accountMapKey(row.processor, row.descriptor);
    if (!descriptorFirstSeen.has(descriptorKey) || row.first_seen < (descriptorFirstSeen.get(descriptorKey) as string)) descriptorFirstSeen.set(descriptorKey, row.first_seen);
  }
  // Descriptors: numbered per processor in first-seen order (a new descriptor
  // takes the next number); a registry descriptor_prefix the value starts with
  // names the account instead.
  const ordered = [...descriptorFirstSeen.entries()].sort(([a, aSeen], [b, bSeen]) => (a.split("\u0000")[0] < b.split("\u0000")[0] ? -1 : a.split("\u0000")[0] > b.split("\u0000")[0] ? 1 : aSeen < bSeen ? -1 : aSeen > bSeen ? 1 : a < b ? -1 : 1));
  const counters = new Map<string, number>();
  for (const [key] of ordered) {
    const [processor, descriptor] = key.split("\u0000");
    let ref: DescriptorRef;
    if (!descriptor) {
      ref = { key: `none:${processor}`, label: "No descriptor", processor };
    } else {
      const ordinal = (counters.get(processor) ?? 0) + 1;
      counters.set(processor, ordinal);
      const prefixed = accounts.find((account) => account.processor === processor && account.descriptor_prefix && descriptor.startsWith(account.descriptor_prefix));
      ref = {
        key: `d:${await opaqueId(input.tenantKey, "descriptor", processor, descriptor)}`,
        label: prefixed ? `${prefixed.descriptor_prefix} (${prefixed.label})` : `${processorLabel(processor)} descriptor #${ordinal}`,
        processor,
      };
    }
    registry.descriptors.set(key, ref);
    registry.descriptorsByKey.set(ref.key, { processor, descriptor });
  }
  registry.processors = [...processors].sort().map((key) => ({ key, label: processorLabel(key) }));
  return registry;
}

function accountRef(registry: DimensionRegistry, processor: string, mid: string): MerchantAccountRef {
  return registry.accounts.get(accountMapKey(processor, mid)) ?? { key: `none:${processor}`, label: mid ? "Unlabelled MID" : "No MID", processor, labelled: false };
}

function descriptorRef(registry: DimensionRegistry, processor: string, descriptor: string): DescriptorRef {
  return registry.descriptors.get(accountMapKey(processor, descriptor)) ?? { key: `none:${processor}`, label: descriptor ? "Unlabelled descriptor" : "No descriptor", processor };
}

// ---------------------------------------------------------------------------
// The funnel anchor snapshot
// ---------------------------------------------------------------------------

interface AnchorSnapshot {
  warehouse_version: string;
  classification_version: string;
}

/** The validated active fact_user_cohorts snapshot, or null (every row 'unattributed'). */
async function loadAnchorSnapshot(pg: SupabaseLikeClient, tenantKey: string): Promise<AnchorSnapshot | null> {
  try {
    return activeCohortSnapshotVersion(await getCohortSnapshotState(pg, tenantKey));
  } catch (error) {
    if (error instanceof ScopeViolation) throw error;
    // A state read fault is not a reason to fail the page: the funnel split
    // degrades to 'unattributed' and meta.funnel_attribution says so.
    return null;
  }
}

// ---------------------------------------------------------------------------
// SQL: the attempt base, the filters, the dimension columns
// ---------------------------------------------------------------------------

/** Plan J: the stage of a success is its type; a decline's is recovered from ff_billing_reason, else CIT / MIT (heuristic, labelled). */
export const STAGE_SQL =
  "multiIf(is_success = 1, transaction_type, ff_billing_reason != '', concat('declined_', lower(ff_billing_reason)), initiation_type = 'mit', 'declined_mit', initiation_type = 'cit', 'declined_cit', 'declined_unknown')";

/**
 * The attempt base of a window pair, as CTEs (no scratch table, plan J / Y):
 *   anchors — the validated snapshot's (user, acquisition path) pairs;
 *   src     — every attempt of [from, to] joined to its anchor, raw columns
 *             under `_raw` names where a derived column reuses the name
 *             (an alias that shadows the column its expression reads is a
 *             ClickHouse cyclic-alias trap);
 *   base    — the derived columns every tab groups by (period, processor,
 *             initiation, stage, card_network, country, funnel, ...);
 *   att     — base after the request's filters.
 */
function attemptCtes(
  nreq: NormalizedPaymentHealthRequest,
  registry: DimensionRegistry,
  snapshot: AnchorSnapshot | null,
  window: { from: string; to: string },
  params: Record<string, unknown>,
  filtersApplied = true,
): string {
  params.snapshot_warehouse_version = snapshot?.warehouse_version ?? "";
  params.snapshot_classification_version = snapshot?.classification_version ?? "";
  params.window_from = window.from;
  params.window_to = window.to;
  params.range_from = nreq.range.from;
  const where = filtersApplied ? filterWhere(nreq, registry, params) : "";
  return `anchors AS (
  SELECT canonical_user_id AS uid, campaign_path AS anchor_path
  FROM ${FC} FINAL
  WHERE ${TENANT} AND warehouse_version = {snapshot_warehouse_version:String}
    AND classification_version = {snapshot_classification_version:String} AND warehouse_version != ''
),
src AS (
  SELECT t.user_id AS user_id, t.transaction_id AS transaction_id, t.event_time AS event_time,
    t.raw_status AS raw_status, t.is_success AS is_success, t.is_refund AS is_refund,
    t.amount_usd AS amount_usd, t.refund_amount_usd AS refund_amount_usd, t.refund_observed_at AS refund_observed_at,
    t.processor AS processor_raw, t.processor_merchant_id AS processor_merchant_id, t.statement_descriptor AS statement_descriptor,
    t.initiation_type AS initiation_type, t.ff_billing_reason AS ff_billing_reason, t.transaction_type AS transaction_type,
    t.card_network AS card_network_raw, t.payment_method AS payment_method_raw, t.${COUNTRY_BASIS} AS country_raw,
    t.currency AS currency, t.original_amount AS original_amount, t.price_point AS price_point, t.payment_instrument_key AS payment_instrument_key,
    t.advised_action AS advised_action, t.advice_code AS advice_code, t.issuer_result_code AS issuer_result_code,
    t.primer_decline_code AS primer_decline_code, t.lifecycle_event AS lifecycle_event, t.decline_record_count AS decline_record_count,
    t.decline_type AS decline_type, t.three_ds_response AS three_ds_response,
    ifNull(a.anchor_path, '') AS anchor_path
  FROM ${TX} AS t FINAL
  LEFT JOIN anchors AS a ON a.uid = t.user_id
  WHERE t.${TENANT} AND t.${ATTEMPT_RAW_STATUS_EXCLUSION}
    AND toDate(t.event_time) >= {window_from:Date} AND toDate(t.event_time) <= {window_to:Date}
),
base AS (
  SELECT user_id, transaction_id, event_time, toDate(event_time) AS day,
    if(toDate(event_time) >= {range_from:Date}, 'current', 'baseline') AS period,
    raw_status, is_success, is_refund, amount_usd, refund_amount_usd, refund_observed_at,
    if(processor_raw = '', '${UNROUTED_PROCESSOR_KEY}', upper(processor_raw)) AS processor, processor_merchant_id, statement_descriptor,
    if(initiation_type = '', '${UNKNOWN_VALUE_KEY}', initiation_type) AS initiation, transaction_type, ${STAGE_SQL} AS stage,
    if(card_network_raw = '', '${UNKNOWN_VALUE_KEY}', upper(card_network_raw)) AS card_network, card_network_raw,
    if(payment_method_raw = '', '${UNKNOWN_VALUE_KEY}', upper(payment_method_raw)) AS payment_method,
    if(country_raw = '', '${UNKNOWN_VALUE_KEY}', upper(country_raw)) AS country,
    currency, original_amount, price_point, payment_instrument_key,
    advised_action, advice_code, issuer_result_code, primer_decline_code, lifecycle_event, decline_record_count, decline_type, three_ds_response,
    if(anchor_path = '', '${UNATTRIBUTED_FUNNEL_KEY}', anchor_path) AS funnel
  FROM src
),
att AS (SELECT * FROM base${where ? ` WHERE ${where}` : ""})`;
}

function inList(column: string, values: readonly string[], prefix: string, params: Record<string, unknown>): string {
  const placeholders = values.map((value, index) => {
    const key = `p_${prefix}_${index}`;
    params[key] = value;
    return `{${key}:String}`;
  });
  return `${column} IN (${placeholders.join(", ")})`;
}

/** The pair filters bind the RAW values the opaque ids stand for; an id the registry does not know is a 400. */
function pairFilter(
  columns: [string, string],
  keys: readonly string[],
  lookup: Map<string, { processor: string; value: string }>,
  prefix: string,
  params: Record<string, unknown>,
): string {
  const tuples: string[] = [];
  const nones: string[] = [];
  keys.forEach((key, index) => {
    if (key.startsWith("none:")) {
      const processor = key.slice(5);
      const name = `p_${prefix}_none_${index}`;
      params[name] = processor;
      nones.push(`(${columns[0]} = {${name}:String} AND ${columns[1]} = '')`);
      return;
    }
    const pair = lookup.get(key);
    if (!pair) throw new PaymentHealthRequestError(`Unknown ${prefix === "ma" ? "merchant account" : "descriptor"} id: ${key}`);
    const p = `p_${prefix}_${index}_p`;
    const v = `p_${prefix}_${index}_v`;
    params[p] = pair.processor;
    params[v] = pair.value;
    tuples.push(`({${p}:String}, {${v}:String})`);
  });
  const parts = [...nones];
  if (tuples.length) parts.push(`(${columns[0]}, ${columns[1]}) IN (${tuples.join(", ")})`);
  return parts.length === 1 ? parts[0] : `(${parts.join(" OR ")})`;
}

function filterWhere(nreq: NormalizedPaymentHealthRequest, registry: DimensionRegistry, params: Record<string, unknown>): string {
  const f = nreq.filters;
  const clauses: string[] = [];
  if (f.processor.length) clauses.push(inList("processor", f.processor, "proc", params));
  if (f.merchant_account.length) {
    const lookup = new Map([...registry.accountsByKey].map(([key, pair]) => [key, { processor: pair.processor, value: pair.mid }]));
    clauses.push(pairFilter(["processor", "processor_merchant_id"], f.merchant_account, lookup, "ma", params));
  }
  if (f.descriptor.length) {
    const lookup = new Map([...registry.descriptorsByKey].map(([key, pair]) => [key, { processor: pair.processor, value: pair.descriptor }]));
    clauses.push(pairFilter(["processor", "statement_descriptor"], f.descriptor, lookup, "desc", params));
  }
  if (f.funnel.length) clauses.push(inList("funnel", f.funnel, "fn", params));
  if (f.country.length) clauses.push(inList("country", f.country, "co", params));
  if (f.card_network.length) clauses.push(inList("card_network", f.card_network, "cn", params));
  if (f.payment_method.length) clauses.push(inList("payment_method", f.payment_method, "pm", params));
  if (f.initiation.length) clauses.push(inList("initiation", f.initiation, "init", params));
  if (f.transaction_type.length) clauses.push(inList("transaction_type", f.transaction_type, "tt", params));
  return clauses.join(" AND ");
}

/** The SQL columns a dimension groups by (merchant_account / descriptor need the processor too). */
const DIMENSION_COLUMNS: Readonly<Record<PaymentHealthDimension, readonly string[]>> = {
  processor: ["processor"],
  merchant_account: ["processor", "processor_merchant_id"],
  descriptor: ["processor", "statement_descriptor"],
  funnel: ["funnel"],
  country: ["country"],
  card_network: ["card_network"],
  payment_method: ["payment_method"],
  initiation: ["initiation"],
  stage: ["stage"],
};

const STAGE_LABELS: Readonly<Record<string, string>> = {
  trial: "Trial",
  first_subscription: "First subscription",
  renewal_2: "Renewal 2",
  renewal_3: "Renewal 3",
  renewal: "Renewal 4+",
  upsell: "Upsell",
  token_purchase: "Token purchase",
  failed_payment: "Declined (type not recovered)",
  declined_mit: "Declined (MIT: renewal / dunning)",
  declined_cit: "Declined (CIT: checkout)",
  declined_unknown: "Declined (initiation unknown)",
  unknown: "Unknown",
};

const INITIATION_LABELS: Readonly<Record<string, string>> = { cit: "CIT (customer-initiated)", mit: "MIT (merchant-initiated)", unknown: "Unknown" };

/** The DimensionValue of a grouped row (the row carries the DIMENSION_COLUMNS). */
function dimensionValueOf(dimension: PaymentHealthDimension, row: Record<string, unknown>, registry: DimensionRegistry): DimensionValue {
  switch (dimension) {
    case "processor":
      return { key: s(row.processor), label: processorLabel(s(row.processor)) };
    case "merchant_account":
      return accountRef(registry, s(row.processor), s(row.processor_merchant_id));
    case "descriptor":
      return descriptorRef(registry, s(row.processor), s(row.statement_descriptor));
    case "funnel": {
      const key = s(row.funnel) || UNATTRIBUTED_FUNNEL_KEY;
      return { key, label: key === UNATTRIBUTED_FUNNEL_KEY ? "Unattributed (no acquisition anchor)" : key };
    }
    case "country": {
      const key = s(row.country) || UNKNOWN_VALUE_KEY;
      return { key, label: key === UNKNOWN_VALUE_KEY ? "Unknown" : key };
    }
    case "card_network":
    case "payment_method": {
      const key = s(row[dimension]) || UNKNOWN_VALUE_KEY;
      return { key, label: key === UNKNOWN_VALUE_KEY ? "Unknown" : titleCase(key) };
    }
    case "initiation": {
      const key = s(row.initiation) || UNKNOWN_VALUE_KEY;
      return { key, label: INITIATION_LABELS[key] ?? key };
    }
    case "stage": {
      const key = s(row.stage) || UNKNOWN_VALUE_KEY;
      if (STAGE_LABELS[key]) return { key, label: STAGE_LABELS[key] };
      return { key, label: key.startsWith("declined_") ? `Declined (${titleCase(key.slice(9))})` : titleCase(key) };
    }
  }
}

// ---------------------------------------------------------------------------
// Grouped rows → totals (classification in the Edge)
// ---------------------------------------------------------------------------

/** The code columns the grouped SQL carries so the taxonomy can classify each group. */
const CODE_COLUMNS = "is_success, lifecycle_event, issuer_result_code, primer_decline_code, advice_code, advised_action, decline_type, card_network_raw, processor AS proc, if(decline_record_count > 1, 1, 0) AS cascade_row, if(three_ds_response != '', 1, 0) AS three_ds";
const CODE_GROUP = "is_success, lifecycle_event, issuer_result_code, primer_decline_code, advice_code, advised_action, decline_type, card_network_raw, proc, cascade_row, three_ds";
const METRIC_COLUMNS =
  "count() AS attempts, sum(is_success) AS successes, sumIf(amount_usd, is_success = 1) AS settled_amount_usd, countIf(is_success = 1 AND is_refund = 1) AS refunded, sumIf(refund_amount_usd, is_success = 1 AND is_refund = 1) AS refund_amount_usd";

interface GroupRow extends Record<string, unknown> {
  period?: string;
  attempts: unknown;
  successes: unknown;
  settled_amount_usd?: unknown;
  refunded?: unknown;
  refund_amount_usd?: unknown;
  is_success?: unknown;
  cascade_row?: unknown;
  three_ds?: unknown;
}

/** The taxonomy result of a decline group (null for a success group). */
export function classifyGroup(row: Record<string, unknown>): DeclineClassification | null {
  if (n(row.is_success) === 1) return null;
  const processor = s(row.proc);
  return classifyDecline({
    raw_status: "DECLINED",
    is_success: 0,
    processor: processor === UNROUTED_PROCESSOR_KEY ? "" : processor,
    card_network: s(row.card_network_raw),
    primer_decline_code: s(row.primer_decline_code),
    issuer_result_code: s(row.issuer_result_code),
    advice_code: s(row.advice_code),
    advised_action: s(row.advised_action),
    lifecycle_event: s(row.lifecycle_event),
    decline_type: s(row.decline_type),
    decline_record_count: n(row.cascade_row) === 1 ? 2 : 1,
  });
}

function addGroup(totals: AttemptTotals, row: GroupRow, classification: DeclineClassification | null, classes?: Map<DeclineClass, number>): void {
  const attempts = n(row.attempts);
  const successes = n(row.successes);
  totals.attempts += attempts;
  totals.successes += successes;
  totals.declines += attempts - successes;
  totals.settled_amount_usd += n(row.settled_amount_usd);
  totals.refunded += n(row.refunded);
  totals.refund_amount_usd += n(row.refund_amount_usd);
  if (n(row.three_ds) === 1) totals.three_ds_attempts += attempts;
  // Plan G cascade_rows counts EVERY row with decline_record_count > 1, a
  // payment that settled after an in-payment cascade included — the same
  // definition the retries action and the dictionary use, so it comes from the
  // SQL flag, not from the decline classification below.
  if (n(row.cascade_row) === 1) totals.cascade_rows += attempts;
  if (!classification) return;
  const declines = attempts - successes;
  if (classification.issuer_fraud_decline) totals.issuer_fraud_declines += declines;
  if (classification.lost_stolen_decline) totals.lost_stolen_declines += declines;
  if (classification.decline_class === "authentication") totals.authentication_declines += declines;
  if (classification.decline_class === "psp_integration") totals.psp_integration_declines += declines;
  if (classification.decline_class === "cause_unverified") totals.cause_unverified_declines += declines;
  if (classes) classes.set(classification.decline_class, (classes.get(classification.decline_class) ?? 0) + declines);
}

interface Rollup {
  periods: PeriodTotals;
  classes: { current: Map<DeclineClass, number>; baseline: Map<DeclineClass, number> };
}

function emptyRollup(): Rollup {
  return { periods: { current: emptyTotals(), baseline: emptyTotals() }, classes: { current: new Map(), baseline: new Map() } };
}

function addToRollup(rollup: Rollup, row: GroupRow, classification: DeclineClassification | null): void {
  const period = row.period === "baseline" ? "baseline" : "current";
  addGroup(rollup.periods[period], row, classification, rollup.classes[period]);
}

function classesOf(map: Map<DeclineClass, number>): Partial<Record<DeclineClass, number>> {
  const out: Partial<Record<DeclineClass, number>> = {};
  for (const [key, value] of [...map.entries()].sort(([, a], [, b]) => b - a)) out[key] = value;
  return out;
}

function finishPeriods(rollup: Rollup): PeriodTotals {
  return { current: finishTotals(rollup.periods.current), baseline: finishTotals(rollup.periods.baseline) };
}

/** Grouped rows → one BreakdownRow per dimension value, sorted by current attempts.
 * `classify` only for rows grouped with the code columns (the refund rows are not). */
function breakdownRows(dimension: PaymentHealthDimension, rows: GroupRow[], registry: DimensionRegistry, maturity: Maturity, classify = true): BreakdownRow[] {
  const byValue = new Map<string, { value: DimensionValue; rollup: Rollup }>();
  for (const row of rows) {
    const value = dimensionValueOf(dimension, row, registry);
    const entry = byValue.get(value.key) ?? { value, rollup: emptyRollup() };
    addToRollup(entry.rollup, row, classify ? classifyGroup(row) : null);
    byValue.set(value.key, entry);
  }
  return [...byValue.values()]
    .map(({ value, rollup }) => {
      const periods = finishPeriods(rollup);
      return { dimension, value, ...periods, ...approvalBlock(periods, maturity), decline_classes: classesOf(rollup.classes.current) };
    })
    .sort((a, b) => b.current.attempts - a.current.attempts || a.value.label.localeCompare(b.value.label));
}

// ---------------------------------------------------------------------------
// Meta
// ---------------------------------------------------------------------------

const FUNNEL_NOTE =
  "Funnel is the user's acquisition anchor (fact_user_cohorts), not the row's campaign_path: totals match Payment Pass, the per-funnel split can differ.";
const CHAIN_NOTE =
  "Attempt chains are a heuristic (Primer gives every retry a new orderId): same user, instrument (or currency + amount), price point and initiation within CIT 60 min / MIT 72 h windows.";
const RULES_NOTE = "Network re-attempt rules come from secondary sources (UNVERIFIED): potential violations, not fines.";
const REFUND_NOTE = "Refund timing uses refund_observed_at: the import that first saw amount_refunded > 0 (approximate until the settlement report / webhook).";
const COMPLAINT_NOTE =
  `Complaint → account attribution: the last settled payment of the matched user within ${COMPLAINT_ATTRIBUTION_DAYS} days before the request; none → unattributed. ` +
  "The complaint rate is over the window's settled payments regardless of the active filters (support requests carry no funnel / country / network).";
const MATURITY_NOTE =
  `Refund and complaint rates mature late (a payment can be refunded or complained about for weeks): their comparison is flagged incomplete and never called significant until data_through is ${REFUND_MATURITY_DAYS} days past the window.`;

interface RunContext {
  input: PaymentHealthRunInput;
  nreq: NormalizedPaymentHealthRequest;
  registry: DimensionRegistry;
  snapshot: AnchorSnapshot | null;
  maturity: Maturity;
  today: string;
  started: number;
  clock: () => number;
}

function buildMeta(
  ctx: RunContext,
  action: PaymentHealthMeta["action"],
  extra: { limited?: Record<string, boolean>; estimates?: string[]; definitions?: MetricKey[] } = {},
): PaymentHealthMeta {
  const { nreq, registry, snapshot, today, started, clock } = ctx;
  const dataThrough = registry.last_day;
  return {
    action,
    generated_at: new Date(clock()).toISOString(),
    range: nreq.range,
    compare: nreq.compare,
    data_through: dataThrough,
    // The same flag the comparisons were built with (maturityOf), never recomputed here.
    incomplete: ctx.maturity.immature,
    lag_days: dataThrough ? Math.max(0, daysInclusive(dataThrough, today) - 1) : null,
    funnel_attribution: {
      status: snapshot ? "active" : "no_snapshot",
      basis: "cohort_anchor",
      note: snapshot ? FUNNEL_NOTE : `${FUNNEL_NOTE} No validated cohort snapshot: every row is 'unattributed'.`,
    },
    country_basis: COUNTRY_BASIS,
    country_basis_label: COUNTRY_BASIS_LABEL,
    psp_global_visible: nreq.psp_visible,
    limited: extra.limited ?? {},
    estimates: extra.estimates ?? [],
    definitions: extra.definitions ?? [],
    query_duration_ms: clock() - started,
  };
}

// ---------------------------------------------------------------------------
// overview
// ---------------------------------------------------------------------------

interface ComplaintRow extends Record<string, unknown> {
  period: string;
  month: string;
  classification_version: string;
  category: string;
  processor: string;
  processor_merchant_id: string;
  total: unknown;
  unauthorized: unknown;
  refund_requests: unknown;
  duplicate: unknown;
}

interface SettledCountRow extends Record<string, unknown> {
  period: string;
  proc: string;
  mid: string;
  settled: unknown;
}

interface ComplaintData {
  complaints: ComplaintRow[];
  /** Settled payments of both windows per account, UNFILTERED: the complaint rate's denominator. */
  settled: SettledCountRow[];
}

/**
 * Complaints of both windows by received month × classifier version × category
 * × attributed account, plus the settled payments of both windows per account.
 * Neither statement applies the request's filters: a support request carries
 * no funnel / country / network / initiation, so the complaint rate is always
 * "flagged requests over the window's settled payments" — numerator and
 * denominator describe the same (whole-tenant) population. The filtered
 * successes of the attempt CTEs would make the rate climb under any filter.
 */
async function complaintRows(ctx: RunContext): Promise<ComplaintData> {
  const params: Record<string, unknown> = {
    auth_user_id: ctx.input.tenantKey,
    compare_from: ctx.nreq.compare.from,
    range_from: ctx.nreq.range.from,
    range_to: ctx.nreq.range.to,
    lookback_from: shiftDay(ctx.nreq.compare.from, -COMPLAINT_ATTRIBUTION_DAYS),
    attribution_days: COMPLAINT_ATTRIBUTION_DAYS,
  };
  const settled = json<SettledCountRow>(
    ctx.input.clickhouse,
    `/* ph:settled_counts */ SELECT if(toDate(t.event_time) >= {range_from:Date}, 'current', 'baseline') AS period,
  if(t.processor = '', '${UNROUTED_PROCESSOR_KEY}', upper(t.processor)) AS proc, t.processor_merchant_id AS mid, count() AS settled
FROM ${TX} AS t FINAL
WHERE t.${TENANT} AND t.is_success = 1 AND t.${ATTEMPT_RAW_STATUS_EXCLUSION}
  AND toDate(t.event_time) >= {compare_from:Date} AND toDate(t.event_time) <= {range_to:Date}
GROUP BY period, proc, mid`,
    { auth_user_id: ctx.input.tenantKey, compare_from: params.compare_from, range_from: params.range_from, range_to: params.range_to },
  );
  const complaints = json<ComplaintRow>(
    ctx.input.clickhouse,
    `/* ph:complaints */ WITH complaints AS (
  SELECT request_id, received_at, request_date AS day, toStartOfMonth(request_date) AS month, matched_user_id,
    possible_unauthorized_charge, requires_refund, duplicate_charge, category, classification_version
  FROM ${FSR} FINAL
  WHERE ${TENANT} AND request_date >= {compare_from:Date} AND request_date <= {range_to:Date}
),
settled AS (
  SELECT t.user_id AS uid, t.event_time AS paid_at, if(t.processor = '', '${UNROUTED_PROCESSOR_KEY}', upper(t.processor)) AS proc, t.processor_merchant_id AS mid
  FROM ${TX} AS t FINAL
  WHERE t.${TENANT} AND t.is_success = 1 AND t.${ATTEMPT_RAW_STATUS_EXCLUSION}
    AND toDate(t.event_time) >= {lookback_from:Date} AND toDate(t.event_time) <= {range_to:Date}
),
attributed AS (
  SELECT c.request_id AS request_id, argMax(st.proc, st.paid_at) AS proc, argMax(st.mid, st.paid_at) AS mid
  FROM complaints AS c
  INNER JOIN settled AS st ON st.uid = c.matched_user_id
  WHERE c.matched_user_id != '' AND st.paid_at <= c.received_at AND st.paid_at > c.received_at - toIntervalDay({attribution_days:UInt32})
  GROUP BY c.request_id
)
SELECT if(c.day >= {range_from:Date}, 'current', 'baseline') AS period, toString(c.month) AS month, c.classification_version AS classification_version,
  c.category AS category, if(ifNull(a.proc, '') = '', 'unattributed', a.proc) AS processor, ifNull(a.mid, '') AS processor_merchant_id,
  count() AS total, sum(c.possible_unauthorized_charge) AS unauthorized, sum(c.requires_refund) AS refund_requests, sum(c.duplicate_charge) AS duplicate
FROM complaints AS c
LEFT JOIN attributed AS a ON a.request_id = c.request_id
GROUP BY period, month, classification_version, category, processor, processor_merchant_id`,
    params,
  );
  const [complaintList, settledList] = await Promise.all([complaints, settled]);
  return { complaints: complaintList, settled: settledList };
}

interface PeriodCounts {
  current: number;
  baseline: number;
}

interface ComplaintRollup {
  current: ComplaintCounts & { unattributed: number };
  baseline: ComplaintCounts & { unattributed: number };
  byAccount: Map<string, { processor: DimensionValue; merchant_account: MerchantAccountRef; counts: ComplaintCounts }>;
  byAccountBaseline: Map<string, number>;
  byMonth: Map<string, { counts: ComplaintCounts; versions: Set<string>; categories: Map<string, number> }>;
  /** Settled payments of both windows, unfiltered (the complaint rate's denominator), tenant-wide and per account key. */
  settled: PeriodCounts;
  settledByAccount: Map<string, PeriodCounts>;
}

function emptyComplaintCounts(): ComplaintCounts & { unattributed: number } {
  return { total: 0, possible_unauthorized_charge: 0, requires_refund: 0, duplicate_charge: 0, unattributed: 0 };
}

/** The complaint rate of one account (or the tenant): flagged requests over the unfiltered settled payments of each window. */
function complaintRate(complaints: PeriodCounts, settled: PeriodCounts, maturity: Maturity) {
  return comparePeriods(
    { numerator: complaints.current, denominator: settled.current },
    { numerator: complaints.baseline, denominator: settled.baseline },
    { immature: maturity.refund_immature },
  );
}

function rollupComplaints(data: ComplaintData, registry: DimensionRegistry): ComplaintRollup {
  const rollup: ComplaintRollup = {
    current: emptyComplaintCounts(),
    baseline: emptyComplaintCounts(),
    byAccount: new Map(),
    byAccountBaseline: new Map(),
    byMonth: new Map(),
    settled: { current: 0, baseline: 0 },
    settledByAccount: new Map(),
  };
  for (const row of data.settled) {
    const period = row.period === "baseline" ? "baseline" : "current";
    const settled = n(row.settled);
    rollup.settled[period] += settled;
    const key = `${s(row.proc)}\u0000${accountRef(registry, s(row.proc), s(row.mid)).key}`;
    const entry = rollup.settledByAccount.get(key) ?? { current: 0, baseline: 0 };
    entry[period] += settled;
    rollup.settledByAccount.set(key, entry);
  }
  for (const row of data.complaints) {
    const period = row.period === "baseline" ? "baseline" : "current";
    const counts = { total: n(row.total), possible_unauthorized_charge: n(row.unauthorized), requires_refund: n(row.refund_requests), duplicate_charge: n(row.duplicate) };
    const target = rollup[period];
    target.total += counts.total;
    target.possible_unauthorized_charge += counts.possible_unauthorized_charge;
    target.requires_refund += counts.requires_refund;
    target.duplicate_charge += counts.duplicate_charge;
    const attributed = s(row.processor) !== "unattributed";
    if (!attributed) target.unattributed += counts.total;
    const month = s(row.month).slice(0, 10);
    const monthEntry = rollup.byMonth.get(month) ?? { counts: { total: 0, possible_unauthorized_charge: 0, requires_refund: 0, duplicate_charge: 0 }, versions: new Set<string>(), categories: new Map<string, number>() };
    monthEntry.counts.total += counts.total;
    monthEntry.counts.possible_unauthorized_charge += counts.possible_unauthorized_charge;
    monthEntry.counts.requires_refund += counts.requires_refund;
    monthEntry.counts.duplicate_charge += counts.duplicate_charge;
    if (s(row.classification_version)) monthEntry.versions.add(s(row.classification_version));
    const category = s(row.category) || "Unclassified";
    monthEntry.categories.set(category, (monthEntry.categories.get(category) ?? 0) + counts.total);
    rollup.byMonth.set(month, monthEntry);
    if (!attributed) continue;
    const account = accountRef(registry, s(row.processor), s(row.processor_merchant_id));
    const key = `${s(row.processor)}\u0000${account.key}`;
    if (period === "baseline") {
      rollup.byAccountBaseline.set(key, (rollup.byAccountBaseline.get(key) ?? 0) + counts.possible_unauthorized_charge);
      continue;
    }
    const entry = rollup.byAccount.get(key) ?? {
      processor: { key: s(row.processor), label: processorLabel(s(row.processor)) },
      merchant_account: account,
      counts: { total: 0, possible_unauthorized_charge: 0, requires_refund: 0, duplicate_charge: 0 },
    };
    entry.counts.total += counts.total;
    entry.counts.possible_unauthorized_charge += counts.possible_unauthorized_charge;
    entry.counts.requires_refund += counts.requires_refund;
    entry.counts.duplicate_charge += counts.duplicate_charge;
    rollup.byAccount.set(key, entry);
  }
  return rollup;
}

function complaintMonthRows(rollup: ComplaintRollup): ComplaintMonthRow[] {
  let previous: string | null = null;
  return [...rollup.byMonth.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([month, entry]) => {
      const versions = [...entry.versions].sort();
      const signature = versions.join("|");
      const row: ComplaintMonthRow = {
        month,
        ...entry.counts,
        classification_versions: versions,
        version_break: previous != null && previous !== signature,
        by_category: [...entry.categories.entries()].map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count || a.category.localeCompare(b.category)),
      };
      previous = signature;
      return row;
    });
}

function trendGranularity(nreq: NormalizedPaymentHealthRequest): "day" | "week" {
  return nreq.range.days <= DAILY_TREND_MAX_DAYS ? "day" : "week";
}

/** The Monday of a YYYY-MM-DD day (toStartOfWeek(day, 1)), UTC arithmetic. */
function mondayOf(day: string): string {
  const weekday = new Date(Date.parse(`${day}T00:00:00.000Z`)).getUTCDay(); // 0 = Sunday
  return shiftDay(day, -((weekday + 6) % 7));
}

/** Every bucket start of the window: each day, or each Monday from the week of range.from to range.to. */
function trendBuckets(range: { from: string; to: string }, granularity: "day" | "week"): string[] {
  const out: string[] = [];
  const step = granularity === "week" ? 7 : 1;
  for (let bucket = granularity === "week" ? mondayOf(range.from) : range.from; bucket <= range.to; bucket = shiftDay(bucket, step)) out.push(bucket);
  return out;
}

/**
 * The series over the WHOLE window: a bucket without attempts is a zero point
 * (a missing day must look like a gap, not vanish), and a bucket that ends
 * after data_through is flagged incomplete — which only a filled series can
 * show, because data_through is the newest attempt day, so no grouped row ever
 * lies beyond it.
 */
function trendPoints(rows: GroupRow[], granularity: "day" | "week", dataThrough: string | null, range: { from: string; to: string }): TrendPoint[] {
  const byBucket = new Map<string, AttemptTotals>();
  for (const bucket of trendBuckets(range, granularity)) byBucket.set(bucket, emptyTotals());
  for (const row of rows) {
    const bucket = s(row.bucket).slice(0, 10);
    const totals = byBucket.get(bucket) ?? emptyTotals();
    addGroup(totals, row, classifyGroup(row));
    byBucket.set(bucket, totals);
  }
  return [...byBucket.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([bucket, totals]) => {
      const end = granularity === "week" ? shiftDay(bucket, 6) : bucket;
      return {
        bucket,
        attempts: totals.attempts,
        successes: totals.successes,
        declines: totals.declines,
        approval_rate: totals.attempts > 0 ? totals.successes / totals.attempts : null,
        issuer_fraud_declines: totals.issuer_fraud_declines,
        settled_amount_usd: roundMoney(totals.settled_amount_usd),
        incomplete: dataThrough ? end > dataThrough : true,
      };
    });
}

const WHAT_CHANGED_DIMENSIONS: readonly PaymentHealthDimension[] = ["processor", "merchant_account", "initiation", "card_network", "country", "funnel"];

function whatChanged(rows: GroupRow[], registry: DimensionRegistry, pspVisible: boolean): WhatChangedRow[] {
  const out: WhatChangedRow[] = [];
  for (const dimension of WHAT_CHANGED_DIMENSIONS) {
    if (!pspVisible && PSP_DIMENSIONS.has(dimension)) continue;
    const byValue = new Map<string, { value: DimensionValue; current: { volume: number; count: number }; baseline: { volume: number; count: number } }>();
    for (const row of rows) {
      const value = dimensionValueOf(dimension, row, registry);
      const entry = byValue.get(value.key) ?? { value, current: { volume: 0, count: 0 }, baseline: { volume: 0, count: 0 } };
      const side = row.period === "baseline" ? entry.baseline : entry.current;
      side.volume += n(row.attempts);
      side.count += n(row.attempts) - n(row.successes);
      byValue.set(value.key, entry);
    }
    const movers = [...byValue.values()]
      .map((entry) => ({ dimension, value: entry.value, decomposition: decomposeCountChange(entry.baseline, entry.current) }))
      .filter((entry) => entry.decomposition.delta_count !== 0)
      .sort((a, b) => Math.abs(b.decomposition.delta_count) - Math.abs(a.decomposition.delta_count) || a.value.label.localeCompare(b.value.label))
      .slice(0, WHAT_CHANGED_LIMIT);
    out.push(...movers);
  }
  return out;
}

async function runOverview(ctx: RunContext): Promise<OverviewResponse> {
  const { input, nreq, registry, snapshot } = ctx;
  const window = { from: nreq.compare.from, to: nreq.range.to };
  const granularity = trendGranularity(nreq);

  const groupParams: Record<string, unknown> = { auth_user_id: input.tenantKey };
  const groups = json<GroupRow>(
    input.clickhouse,
    `/* ph:overview_groups */ WITH ${attemptCtes(nreq, registry, snapshot, window, groupParams)}
SELECT period, processor, processor_merchant_id, ${CODE_COLUMNS}, ${METRIC_COLUMNS}
FROM att
GROUP BY period, processor, processor_merchant_id, ${CODE_GROUP}`,
    groupParams,
  );

  const trendParams: Record<string, unknown> = { auth_user_id: input.tenantKey };
  const bucket = granularity === "week" ? "toStartOfWeek(day, 1)" : "day";
  const trend = json<GroupRow>(
    input.clickhouse,
    `/* ph:overview_trend */ WITH ${attemptCtes(nreq, registry, snapshot, window, trendParams)}
SELECT toString(${bucket}) AS bucket, processor, processor_merchant_id, ${CODE_COLUMNS}, ${METRIC_COLUMNS}
FROM att
WHERE period = 'current'
GROUP BY bucket, processor, processor_merchant_id, ${CODE_GROUP}`,
    trendParams,
  );

  const changeParams: Record<string, unknown> = { auth_user_id: input.tenantKey };
  const change = json<GroupRow>(
    input.clickhouse,
    `/* ph:overview_change */ WITH ${attemptCtes(nreq, registry, snapshot, window, changeParams)}
SELECT period, processor, processor_merchant_id, initiation, card_network, country, funnel, count() AS attempts, sum(is_success) AS successes
FROM att
GROUP BY period, processor, processor_merchant_id, initiation, card_network, country, funnel`,
    changeParams,
  );

  const [groupRows, trendRows, changeRows, complaintsRaw] = await Promise.all([groups, trend, change, complaintRows(ctx)]);

  const total = emptyRollup();
  const byAccount = new Map<string, { processor: DimensionValue; merchant_account: MerchantAccountRef; rollup: Rollup }>();
  for (const row of groupRows) {
    const classification = classifyGroup(row);
    addToRollup(total, row, classification);
    const account = accountRef(registry, s(row.processor), s(row.processor_merchant_id));
    const key = `${s(row.processor)}\u0000${account.key}`;
    const entry = byAccount.get(key) ?? { processor: { key: s(row.processor), label: processorLabel(s(row.processor)) }, merchant_account: account, rollup: emptyRollup() };
    addToRollup(entry.rollup, row, classification);
    byAccount.set(key, entry);
  }
  const trendByAccount = new Map<string, GroupRow[]>();
  for (const row of trendRows) {
    const account = accountRef(registry, s(row.processor), s(row.processor_merchant_id));
    const key = `${s(row.processor)}\u0000${account.key}`;
    const list = trendByAccount.get(key) ?? [];
    list.push(row);
    trendByAccount.set(key, list);
  }
  const complaints = rollupComplaints(complaintsRaw, registry);
  const maturity = ctx.maturity;

  const periods = finishPeriods(total);
  const pspRows: PspMidRow[] = nreq.psp_visible
    ? [...byAccount.entries()]
      .map(([key, entry]) => {
        const rowPeriods = finishPeriods(entry.rollup);
        const unauthorized = {
          current: complaints.byAccount.get(key)?.counts.possible_unauthorized_charge ?? 0,
          baseline: complaints.byAccountBaseline.get(key) ?? 0,
        };
        return {
          processor: entry.processor,
          merchant_account: entry.merchant_account,
          ...rowPeriods,
          ...approvalBlock(rowPeriods, maturity),
          decline_classes: classesOf(entry.rollup.classes.current),
          complaints_unauthorized: unauthorized,
          complaint_rate: complaintRate(unauthorized, complaints.settledByAccount.get(key) ?? { current: 0, baseline: 0 }, maturity),
          trend: trendPoints(trendByAccount.get(key) ?? [], granularity, registry.last_day, nreq.range),
        };
      })
      .sort((a, b) => b.current.attempts - a.current.attempts || a.processor.key.localeCompare(b.processor.key) || a.merchant_account.label.localeCompare(b.merchant_account.label))
    : [];

  const meta = buildMeta(ctx, "overview", {
    estimates: [FUNNEL_NOTE, COMPLAINT_NOTE, REFUND_NOTE, MATURITY_NOTE],
    definitions: ["attempts", "attempt_approval_rate", "decline_class", "issuer_fraud_declines", "refund_rate", "support_unauthorized_rate", "cascade_rows", "three_ds_rate"],
  });
  return {
    ok: true,
    action: "overview",
    meta: { ...meta, trend_granularity: granularity },
    totals: {
      ...periods,
      ...approvalBlock(periods, maturity),
      decline_classes: classesOf(total.classes.current),
      complaints_unauthorized: {
        current: complaints.current.possible_unauthorized_charge,
        baseline: complaints.baseline.possible_unauthorized_charge,
        unattributed_current: complaints.current.unattributed,
        unattributed_baseline: complaints.baseline.unattributed,
      },
      support_unauthorized_rate: complaintRate(
        { current: complaints.current.possible_unauthorized_charge, baseline: complaints.baseline.possible_unauthorized_charge },
        complaints.settled,
        maturity,
      ),
    },
    trend: trendPoints(trendRows, granularity, registry.last_day, nreq.range),
    psp_mid_rows: pspRows,
    what_changed: whatChanged(changeRows, registry, nreq.psp_visible),
  };
}

// ---------------------------------------------------------------------------
// declines
// ---------------------------------------------------------------------------

const SEVERITIES: readonly DeclineSeverity[] = ["soft", "hard", "unknown"];

async function runDeclines(ctx: RunContext): Promise<DeclinesResponse> {
  const { input, nreq, registry, snapshot } = ctx;
  const window = { from: nreq.compare.from, to: nreq.range.to };
  const columns = DIMENSION_COLUMNS[nreq.dimension].join(", ");
  const params: Record<string, unknown> = { auth_user_id: input.tenantKey };
  const rows = await json<GroupRow>(
    input.clickhouse,
    `/* ph:declines_groups */ WITH ${attemptCtes(nreq, registry, snapshot, window, params)}
SELECT period, ${columns}, ${CODE_COLUMNS}, ${METRIC_COLUMNS}
FROM att
GROUP BY period, ${columns}, ${CODE_GROUP}`,
    params,
  );

  const total = emptyRollup();
  const severity = { current: { soft: 0, hard: 0, unknown: 0 }, baseline: { soft: 0, hard: 0, unknown: 0 } } as { current: Record<DeclineSeverity, number>; baseline: Record<DeclineSeverity, number> };
  const codeMix = new Map<string, CodeMixRow>();
  for (const row of rows) {
    const classification = classifyGroup(row);
    addToRollup(total, row, classification);
    if (!classification) continue;
    const period = row.period === "baseline" ? "baseline" : "current";
    const declines = n(row.attempts) - n(row.successes);
    severity[period][classification.severity] += declines;
    const key = [classification.decline_class, classification.issuer_result_code ?? "", classification.primer_decline_code ?? "", classification.advised_action ?? "", classification.advice_code ?? ""].join("|");
    const entry = codeMix.get(key) ?? {
      decline_class: classification.decline_class,
      issuer_result_code: classification.issuer_result_code,
      primer_decline_code: classification.primer_decline_code,
      advised_action: classification.advised_action,
      advice_code: classification.advice_code,
      severity: classification.severity,
      retry_guidance: classification.retry_guidance,
      retry_ban: classification.retry_ban,
      current: 0,
      baseline: 0,
    };
    entry[period] += declines;
    codeMix.set(key, entry);
  }
  const periods = finishPeriods(total);
  const byClass: DeclineClassRow[] = [...new Set([...total.classes.current.keys(), ...total.classes.baseline.keys()])]
    .map((declineClass) => {
      const current = total.classes.current.get(declineClass) ?? 0;
      const baseline = total.classes.baseline.get(declineClass) ?? 0;
      return {
        decline_class: declineClass,
        label: DECLINE_CLASS_LABELS[declineClass],
        current,
        baseline,
        share_of_declines: periods.current.declines > 0 ? current / periods.current.declines : null,
        rate: comparePeriods({ numerator: current, denominator: periods.current.attempts }, { numerator: baseline, denominator: periods.baseline.attempts }, { immature: ctx.maturity.immature }),
      };
    })
    .sort((a, b) => b.current - a.current || a.decline_class.localeCompare(b.decline_class));

  const meta = buildMeta(ctx, "declines", {
    // A cap that was hit is said (meta.limited → the "cap hit" badge), never passed off as the whole mix.
    limited: { code_mix: codeMix.size > CODE_MIX_LIMIT },
    estimates: [FUNNEL_NOTE],
    definitions: ["attempts", "attempt_approval_rate", "decline_class", "decline_mix", "issuer_fraud_declines", "cascade_rows"],
  });
  return {
    ok: true,
    action: "declines",
    meta,
    dimension: nreq.dimension,
    totals: { ...periods, ...approvalBlock(periods, ctx.maturity) },
    by_class: byClass,
    by_dimension: breakdownRows(nreq.dimension, rows, registry, ctx.maturity),
    code_mix: [...codeMix.values()].sort((a, b) => b.current - a.current || b.baseline - a.baseline || a.decline_class.localeCompare(b.decline_class)).slice(0, CODE_MIX_LIMIT),
    severity: {
      current: Object.fromEntries(SEVERITIES.map((level) => [level, severity.current[level]])) as Record<DeclineSeverity, number>,
      baseline: Object.fromEntries(SEVERITIES.map((level) => [level, severity.baseline[level]])) as Record<DeclineSeverity, number>,
    },
  };
}

// ---------------------------------------------------------------------------
// retries (memoized per workspace + request)
// ---------------------------------------------------------------------------

interface AttemptRowRecord extends Record<string, unknown> {
  transaction_id: string;
  user_id: string;
  event_ms: unknown;
  raw_status: string;
  is_success: unknown;
}

const ATTEMPT_ROW_COLUMNS =
  "transaction_id, user_id, toUnixTimestamp64Milli(event_time) AS event_ms, raw_status, is_success, currency, original_amount, price_point, initiation, processor, processor_merchant_id, payment_instrument_key, card_network_raw, advised_action, advice_code, issuer_result_code, primer_decline_code, lifecycle_event, decline_record_count";

interface RetriesComputed {
  rows_read: number;
  /** The caps that were hit (meta.limited): the attempt-row read, the post-ban rows, the rolling windows. */
  limited: { attempt_rows: boolean; post_ban_attempts: boolean; rolling_windows: boolean };
  rows_window: { from: string; to: string; days: number };
  chains: RetriesResponse["chains"];
  post_ban: RetriesResponse["post_ban"];
  post_ban_attempts: PostBanAttemptRow[];
  rolling: RetriesResponse["rolling"];
  cascade_rows: number;
}

async function loadAttemptRows(ctx: RunContext, window: { from: string; to: string }): Promise<{ rows: AttemptRow[]; limited: boolean }> {
  const params: Record<string, unknown> = { auth_user_id: ctx.input.tenantKey, row_cap: ATTEMPT_ROW_CAP + 1 };
  const records = await json<AttemptRowRecord>(
    ctx.input.clickhouse,
    `/* ph:attempt_rows */ WITH ${attemptCtes(ctx.nreq, ctx.registry, ctx.snapshot, window, params)}
SELECT ${ATTEMPT_ROW_COLUMNS}
FROM att
ORDER BY event_time, transaction_id
LIMIT {row_cap:UInt32}`,
    params,
  );
  const limited = records.length > ATTEMPT_ROW_CAP;
  const rows: AttemptRow[] = (limited ? records.slice(0, ATTEMPT_ROW_CAP) : records).map((record) => ({
    transaction_id: s(record.transaction_id),
    user_id: s(record.user_id) || null,
    event_time: isoOfMillis(record.event_ms),
    raw_status: s(record.raw_status) || null,
    is_success: n(record.is_success) === 1,
    processor: s(record.processor) === UNROUTED_PROCESSOR_KEY ? null : s(record.processor) || null,
    processor_merchant_id: s(record.processor_merchant_id) || null,
    payment_instrument_key: s(record.payment_instrument_key) || null,
    currency: s(record.currency) || null,
    original_amount: n(record.original_amount),
    price_point: s(record.price_point) || null,
    initiation_type: s(record.initiation) === UNKNOWN_VALUE_KEY ? null : s(record.initiation) || null,
    card_network: s(record.card_network_raw) || null,
    advised_action: s(record.advised_action) || null,
    advice_code: s(record.advice_code) || null,
    issuer_result_code: s(record.issuer_result_code) || null,
    primer_decline_code: s(record.primer_decline_code) || null,
    lifecycle_event: s(record.lifecycle_event) || null,
    decline_record_count: n(record.decline_record_count),
  }));
  return { rows, limited };
}

/** The retry report of a row set: chains that started in the window, post-ban attempts inside it, rolling windows ending in it. */
export async function computeRetries(
  rows: readonly AttemptRow[],
  window: { from: string; to: string },
  rowsWindow: { from: string; to: string; days: number },
  options: { tenantKey: string; registry: DimensionRegistry; limited: boolean; pspVisible: boolean },
): Promise<RetriesComputed> {
  const fromIso = `${window.from}T00:00:00.000Z`;
  const toIso = `${window.to}T23:59:59.999Z`;
  const inWindow = (iso: string) => iso >= fromIso && iso <= toIso;

  const build = buildAttemptChains(rows);
  const chains = build.chains.filter((chain) => inWindow(chain.started_at));
  const attempts = chains.reduce((sum, chain) => sum + chain.attempt_count, 0);
  const successes = chains.reduce((sum, chain) => sum + chain.attempts.filter((attempt) => attempt.success).length, 0);
  const summary = {
    rows: rows.length,
    attempts,
    not_attempts: build.summary.not_attempts,
    chains: chains.length,
    chains_first_try_success: chains.filter((chain) => chain.first_try_success).length,
    chains_final_success: chains.filter((chain) => chain.final_success).length,
    chains_with_decline: chains.filter((chain) => chain.had_decline).length,
    chains_recovered: chains.filter((chain) => chain.recovered).length,
    chains_post_ban_success: chains.filter((chain) => chain.post_ban_success).length,
    chains_cascade: chains.filter((chain) => chain.cascade).length,
    chains_cascade_recovered: chains.filter((chain) => chain.cascade_recovered).length,
    chains_singleton: chains.filter((chain) => chain.key_kind === "singleton").length,
    cascade_rows: chains.reduce((sum, chain) => sum + chain.cascade_row_count, 0),
  };

  const compliance = retryCompliance(rows);
  const postBan = compliance.post_ban_attempts.filter((attempt) => inWindow(attempt.event_time));
  const postBanSummary: RetriesResponse["post_ban"] = {
    ...compliance.post_ban_summary,
    attempts: postBan.length,
    cit: postBan.filter((attempt) => attempt.initiation_type === "cit").length,
    mit: postBan.filter((attempt) => attempt.initiation_type === "mit").length,
    unknown_initiation: postBan.filter((attempt) => attempt.initiation_type === "unknown").length,
    same_processor: postBan.filter((attempt) => attempt.processor_relation === "same").length,
    switched_processor: postBan.filter((attempt) => attempt.processor_relation === "switched").length,
    unknown_processor: postBan.filter((attempt) => attempt.processor_relation === "unknown").length,
    succeeded: postBan.filter((attempt) => attempt.succeeded).length,
    succeeded_switched_processor: postBan.filter((attempt) => attempt.succeeded && attempt.processor_relation === "switched").length,
    within_one_hour: postBan.filter((attempt) => attempt.minutes_since_ban <= 60).length,
    retried_instruments: new Set(postBan.map((attempt) => attempt.payment_instrument_key)).size,
    within_window: postBan.length,
  };

  const banClassByTransaction = new Map<string, DeclineClass>();
  for (const chain of build.chains) {
    for (const attempt of chain.attempts) if (attempt.ban && attempt.decline) banClassByTransaction.set(attempt.transaction_id, attempt.decline.decline_class);
  }
  const newest = [...postBan].sort((a, b) => (a.event_time > b.event_time ? -1 : a.event_time < b.event_time ? 1 : 0)).slice(0, POST_BAN_ATTEMPT_LIMIT);
  const postBanRows: PostBanAttemptRow[] = [];
  for (const attempt of newest) {
    const processorKey = attempt.processor ? attempt.processor.toUpperCase() : UNROUTED_PROCESSOR_KEY;
    postBanRows.push({
      instrument: await opaqueId(options.tenantKey, "instrument", attempt.payment_instrument_key),
      ban_event_time: attempt.ban_event_time,
      ban_sources: attempt.ban_sources,
      ban_decline_class: banClassByTransaction.get(attempt.ban_transaction_id) ?? null,
      event_time: attempt.event_time,
      minutes_since_ban: Math.round(attempt.minutes_since_ban * 10) / 10,
      initiation_type: attempt.initiation_type,
      processor_relation: attempt.processor_relation,
      succeeded: attempt.succeeded,
      banned_again: attempt.banned_again,
      processor: options.pspVisible ? { key: processorKey, label: processorLabel(processorKey) } : null,
      merchant_account: options.pspVisible ? accountRef(options.registry, processorKey, attempt.processor_merchant_id ?? "") : null,
    });
  }

  const windows = compliance.rolling_windows.filter((entry) => inWindow(entry.window_end));
  const overLimit = windows.filter((candidate) => candidate.exceeds_limit);
  const rollingRows: RollingWindowRow[] = [];
  for (const entry of overLimit.slice(0, ROLLING_WINDOW_LIMIT)) {
    const processorKey = [...options.registry.accountsByKey.values()].find((pair) => pair.mid === entry.processor_merchant_id)?.processor ?? UNROUTED_PROCESSOR_KEY;
    rollingRows.push({
      instrument: await opaqueId(options.tenantKey, "instrument", entry.payment_instrument_key),
      merchant_account: options.pspVisible && entry.processor_merchant_id !== "unknown_mid" ? accountRef(options.registry, processorKey, entry.processor_merchant_id) : null,
      max_declines: entry.max_declines,
      limit: entry.limit,
      window_start: entry.window_start,
      window_end: entry.window_end,
      decline_records_total: entry.decline_records_total,
    });
  }

  return {
    rows_read: rows.length,
    limited: { attempt_rows: options.limited, post_ban_attempts: postBan.length > POST_BAN_ATTEMPT_LIMIT, rolling_windows: overLimit.length > ROLLING_WINDOW_LIMIT },
    rows_window: rowsWindow,
    chains: {
      ...summary,
      final_success_rate: rateWithSample(summary.chains_final_success, summary.chains),
      chain_first_try_approval_rate: rateWithSample(summary.chains_first_try_success, summary.chains),
      retry_recovery_rate: rateWithSample(summary.chains_recovered, summary.chains_with_decline),
      cascade_recovery: rateWithSample(summary.chains_cascade_recovered, summary.chains_cascade),
      attempt_approval_rate: rateWithSample(successes, attempts),
    },
    post_ban: postBanSummary,
    post_ban_attempts: postBanRows,
    rolling: { pairs: windows.length, violations: windows.filter((entry) => entry.exceeds_limit).length, windows: rollingRows },
    cascade_rows: rows.filter((row) => typeof row.decline_record_count === "number" && row.decline_record_count > 1 && inWindow(row.event_time)).length,
  };
}

interface RetriesMemoEntry {
  startedAt: number;
  settled: boolean;
  promise: Promise<RetriesComputed>;
}

const retriesMemo = new Map<string, RetriesMemoEntry>();

/** Test hook: forget every memoized retries report. */
export function resetPaymentHealthMemo(): void {
  retriesMemo.clear();
}

/** The memo key: workspace + the request's window and filters (never the caller). */
async function retriesMemoKey(tenantKey: string, nreq: NormalizedPaymentHealthRequest): Promise<string> {
  return `${tenantKey}|${await sha256Hex(JSON.stringify({ range: nreq.range, filters: nreq.filters }))}`;
}

/** Served from memory for PAYMENT_HEALTH_MEMO_TTL_MS after the load started; concurrent requests share one load; a failed load is never cached. */
async function retriesReport(ctx: RunContext): Promise<{ computed: RetriesComputed; memo: "hit" | "miss" | "coalesced" }> {
  const key = await retriesMemoKey(ctx.input.tenantKey, ctx.nreq);
  const now = ctx.clock();
  const existing = retriesMemo.get(key);
  if (existing && !existing.settled) return { computed: await existing.promise, memo: "coalesced" };
  if (existing && existing.settled && now - existing.startedAt < PAYMENT_HEALTH_MEMO_TTL_MS) return { computed: await existing.promise, memo: "hit" };

  const window = { from: ctx.nreq.range.from, to: ctx.nreq.range.to };
  const rowsWindow = { from: shiftDay(window.from, -RETRY_LOOKBACK_DAYS), to: window.to, days: daysInclusive(shiftDay(window.from, -RETRY_LOOKBACK_DAYS), window.to) };
  const entry: RetriesMemoEntry = { startedAt: now, settled: false, promise: Promise.resolve(null as unknown as RetriesComputed) };
  entry.promise = loadAttemptRows(ctx, rowsWindow)
    .then(({ rows, limited }) => computeRetries(rows, window, rowsWindow, { tenantKey: ctx.input.tenantKey, registry: ctx.registry, limited, pspVisible: true }))
    .then(
      (computed) => {
        entry.settled = true;
        return computed;
      },
      (error) => {
        if (retriesMemo.get(key) === entry) retriesMemo.delete(key);
        throw error;
      },
    );
  retriesMemo.delete(key);
  retriesMemo.set(key, entry);
  while (retriesMemo.size > PAYMENT_HEALTH_MEMO_MAX_ENTRIES) {
    const oldest = retriesMemo.keys().next().value;
    if (oldest === undefined) break;
    retriesMemo.delete(oldest);
  }
  return { computed: await entry.promise, memo: "miss" };
}

/** The memo holds the PSP-visible report (the memo key is the workspace + request, not the caller); a caller without psp_global.view gets the account references stripped here. */
function stripRetriesForViewer(computed: RetriesComputed): RetriesComputed {
  return {
    ...computed,
    post_ban_attempts: computed.post_ban_attempts.map((row) => ({ ...row, processor: null, merchant_account: null })),
    rolling: { ...computed.rolling, windows: computed.rolling.windows.map((row) => ({ ...row, merchant_account: null })) },
  };
}

async function runRetries(ctx: RunContext): Promise<RetriesResponse> {
  const { computed, memo } = await retriesReport(ctx);
  const report = ctx.nreq.psp_visible ? computed : stripRetriesForViewer(computed);
  const meta = buildMeta(ctx, "retries", {
    limited: { ...report.limited },
    estimates: [CHAIN_NOTE, RULES_NOTE, FUNNEL_NOTE],
    definitions: ["payment_intent", "final_success_rate", "chain_first_try_approval_rate", "retry_recovery_rate", "cascade_recovery", "retry_compliance", "cascade_rows", "attempt_approval_rate"],
  });
  return {
    ok: true,
    action: "retries",
    meta: {
      ...meta,
      rows_window: report.rows_window,
      rows_read: report.rows_read,
      memo,
      chain_options: {
        cit_window_minutes: DEFAULT_CHAIN_OPTIONS.citWindowMinutes,
        mit_window_hours: DEFAULT_CHAIN_OPTIONS.mitWindowHours,
        rolling_window_days: DEFAULT_CHAIN_OPTIONS.rollingWindowDays,
        rolling_decline_limit: DEFAULT_CHAIN_OPTIONS.rollingDeclineLimit,
      },
    },
    chains: report.chains,
    post_ban: report.post_ban,
    post_ban_attempts: report.post_ban_attempts,
    rolling: report.rolling,
    cascade_rows: report.cascade_rows,
  };
}

// ---------------------------------------------------------------------------
// refunds_support
// ---------------------------------------------------------------------------

const REFUND_TIMING_COLUMNS =
  "countIf(is_success = 1 AND is_refund = 1 AND refund_observed_at IS NOT NULL) AS refund_observed, " +
  "countIf(is_success = 1 AND is_refund = 1 AND refund_observed_at IS NOT NULL AND dateDiff('day', event_time, refund_observed_at) <= 7) AS refund_within_7, " +
  "countIf(is_success = 1 AND is_refund = 1 AND refund_observed_at IS NOT NULL AND dateDiff('day', event_time, refund_observed_at) <= 30) AS refund_within_30, " +
  "countIf(is_success = 1 AND is_refund = 1 AND refund_observed_at IS NOT NULL AND dateDiff('day', event_time, refund_observed_at) <= 90) AS refund_within_90";

async function runRefundsSupport(ctx: RunContext): Promise<RefundsSupportResponse> {
  const { input, nreq, registry, snapshot } = ctx;
  const window = { from: nreq.compare.from, to: nreq.range.to };
  const columns = DIMENSION_COLUMNS[nreq.dimension].join(", ");
  const params: Record<string, unknown> = { auth_user_id: input.tenantKey };
  const refunds = json<GroupRow>(
    input.clickhouse,
    `/* ph:refunds_groups */ WITH ${attemptCtes(nreq, registry, snapshot, window, params)}
SELECT period, ${columns}, toString(toStartOfMonth(day)) AS month, ${METRIC_COLUMNS}, ${REFUND_TIMING_COLUMNS}
FROM att
GROUP BY period, ${columns}, month`,
    params,
  );
  const [refundRows, complaintsRaw] = await Promise.all([refunds, complaintRows(ctx)]);

  const total = emptyRollup();
  const byMonth = new Map<string, AttemptTotals>();
  const timing: RefundTimingBuckets = { observed: 0, unobserved: 0, within_7_days: 0, within_30_days: 0, within_90_days: 0, beyond_90_days: 0 };
  for (const row of refundRows) {
    addToRollup(total, row, null);
    if (row.period !== "current") continue;
    const month = s(row.month).slice(0, 10);
    const totals = byMonth.get(month) ?? emptyTotals();
    addGroup(totals, row, null);
    byMonth.set(month, totals);
    const observed = n(row.refund_observed);
    timing.observed += observed;
    timing.unobserved += n(row.refunded) - observed;
    timing.within_7_days += n(row.refund_within_7);
    timing.within_30_days += n(row.refund_within_30) - n(row.refund_within_7);
    timing.within_90_days += n(row.refund_within_90) - n(row.refund_within_30);
    timing.beyond_90_days += observed - n(row.refund_within_90);
  }
  const periods = finishPeriods(total);
  const monthRows: RefundMonthRow[] = [...byMonth.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([month, totals]) => ({
      month,
      settled: totals.successes,
      refunded: totals.refunded,
      refund_amount_usd: roundMoney(totals.refund_amount_usd),
      refund_rate: rateWithSample(totals.refunded, totals.successes),
    }));
  const complaints = rollupComplaints(complaintsRaw, registry);

  const meta = buildMeta(ctx, "refunds_support", {
    estimates: [REFUND_NOTE, COMPLAINT_NOTE, MATURITY_NOTE, FUNNEL_NOTE],
    definitions: ["refund_rate", "support_unauthorized_rate", "attempts"],
  });
  return {
    ok: true,
    action: "refunds_support",
    meta,
    dimension: nreq.dimension,
    refunds: {
      totals: { ...periods, ...approvalBlock(periods, ctx.maturity) },
      by_dimension: breakdownRows(nreq.dimension, refundRows, registry, ctx.maturity, false),
      by_month: monthRows,
      timing,
    },
    complaints: {
      by_month: complaintMonthRows(complaints),
      current: complaints.current,
      baseline: complaints.baseline,
      support_unauthorized_rate: complaintRate(
        { current: complaints.current.possible_unauthorized_charge, baseline: complaints.baseline.possible_unauthorized_charge },
        complaints.settled,
        ctx.maturity,
      ),
      by_account: nreq.psp_visible
        ? [...complaints.byAccount.values()]
          .map((entry): ComplaintAccountRow => ({ processor: entry.processor, merchant_account: entry.merchant_account, ...entry.counts }))
          .sort((a, b) => b.possible_unauthorized_charge - a.possible_unauthorized_charge || b.total - a.total || a.processor.key.localeCompare(b.processor.key))
        : [],
      attribution_days: COMPLAINT_ATTRIBUTION_DAYS,
    },
  };
}

// ---------------------------------------------------------------------------
// sources
// ---------------------------------------------------------------------------

/** The P0 columns and the test that counts a row as "filled". */
const COVERAGE_COLUMNS: ReadonlyArray<[string, string]> = [
  ["raw_status", "raw_status != ''"],
  ["processor", "processor != ''"],
  ["processor_merchant_id", "processor_merchant_id != ''"],
  ["statement_descriptor", "statement_descriptor != ''"],
  ["initiation_type", "initiation_type != ''"],
  ["ff_billing_reason", "ff_billing_reason != ''"],
  ["payment_type_flag", "payment_type_flag != ''"],
  ["primer_decline_code", "primer_decline_code != ''"],
  ["issuer_result_code", "issuer_result_code != ''"],
  ["advice_code", "advice_code != ''"],
  ["advised_action", "advised_action != ''"],
  ["lifecycle_event", "lifecycle_event != ''"],
  ["decline_record_count", "decline_record_count > 0"],
  ["decline_type", "decline_type != ''"],
  ["three_ds_response", "three_ds_response != ''"],
  ["three_ds_challenge", "three_ds_challenge != ''"],
  ["three_ds_version", "three_ds_version != ''"],
  ["is_network_tokenized", "is_network_tokenized != ''"],
  ["account_number_type", "account_number_type != ''"],
  ["amount_authorized", "amount_authorized > 0"],
  ["billing_country", "billing_country != ''"],
  ["issuer_country", "issuer_country != ''"],
  ["payment_instrument_key", "payment_instrument_key != ''"],
  ["price_point", "price_point != ''"],
  ["price_id", "price_id != ''"],
  ["card_network", "card_network != ''"],
  ["payment_method", "payment_method != ''"],
];

const PHASE_AVAILABLE: ReadonlySet<string> = new Set(["P1", "P2"]);

async function runSources(ctx: RunContext): Promise<SourcesResponse> {
  const { input } = ctx;
  const coverageSelect = COVERAGE_COLUMNS.map(([column, test]) => `countIf(${test}) AS c_${column}`).join(", ");
  const coverage = json(
    input.clickhouse,
    `/* ph:coverage */ SELECT count() AS rows, countIf(raw_status = '') AS rows_without_raw_status, countIf(is_success = 1) AS successes,
  countIf(is_success = 1 AND is_refund = 1) AS refunded, countIf(is_success = 1 AND is_refund = 1 AND refund_observed_at IS NOT NULL) AS refund_observed,
  countIf(is_success = 0) AS declines, countIf(is_success = 0 AND decline_record_count > 0) AS declines_with_record,
  toString(min(toDate(event_time))) AS first_day, toString(max(toDate(event_time))) AS last_day, toString(toUnixTimestamp64Milli(max(clickhouse_synced_at))) AS last_synced_ms, ${coverageSelect}
FROM ${TX} FINAL
WHERE ${TENANT} AND ${ATTEMPT_RAW_STATUS_EXCLUSION}`,
    { auth_user_id: input.tenantKey },
  );
  const support = json(
    input.clickhouse,
    `/* ph:support_versions */ SELECT toString(toStartOfMonth(request_date)) AS month, classification_version, count() AS requests
FROM ${FSR} FINAL
WHERE ${TENANT}
GROUP BY month, classification_version
ORDER BY month, classification_version`,
    { auth_user_id: input.tenantKey },
  );
  const lastImport = input.pg
    .from("import_batches")
    .select("imported_at,status,rows_total,rows_inserted,rows_updated,source")
    .eq("user_id", input.tenantKey)
    .order("imported_at", { ascending: false })
    .limit(1);
  const syncState = getTransactionSyncState(input.pg, input.tenantKey).catch((error) => {
    if (error instanceof ScopeViolation) throw error;
    return null; // the sync state row is informational; a Postgres fault must not hide the page
  });
  const [coverageRows, supportRows, importResult, state] = await Promise.all([coverage, support, lastImport, syncState]);
  const cov = coverageRows[0] ?? {};
  const rows = n(cov.rows);
  const coverageList: ColumnCoverage[] = COVERAGE_COLUMNS.map(([column]) => ({ column, filled: n(cov[`c_${column}`]), rows, share: rows > 0 ? n(cov[`c_${column}`]) / rows : null }));
  // Two coverages whose denominator is not "every attempt": the decline codes
  // exist only on declines, the refund date only on refunded payments.
  const declines = n(cov.declines);
  const refunded = n(cov.refunded);
  coverageList.push(
    { column: "decline_record (of declines)", filled: n(cov.declines_with_record), rows: declines, share: declines > 0 ? n(cov.declines_with_record) / declines : null },
    { column: "refund_observed_at (of refunded)", filled: n(cov.refund_observed), rows: refunded, share: refunded > 0 ? n(cov.refund_observed) / refunded : null },
  );

  const monthMap = new Map<string, { requests: number; versions: Set<string> }>();
  for (const row of supportRows) {
    const month = s(row.month).slice(0, 10);
    const entry = monthMap.get(month) ?? { requests: 0, versions: new Set<string>() };
    entry.requests += n(row.requests);
    if (s(row.classification_version)) entry.versions.add(s(row.classification_version));
    monthMap.set(month, entry);
  }
  let previous: string | null = null;
  const supportByMonth = [...monthMap.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([month, entry]) => {
      const versions = [...entry.versions].sort();
      const signature = versions.join("|");
      const out = { month, requests: entry.requests, classification_versions: versions, version_break: previous != null && previous !== signature };
      previous = signature;
      return out;
    });

  const importRow = ((importResult?.data ?? []) as Array<Record<string, unknown>>)[0] ?? null;
  const stateRow = (state ?? null) as Record<string, unknown> | null;
  const meta = buildMeta(ctx, "sources", {
    estimates: [REFUND_NOTE],
    definitions: PAYMENT_HEALTH_METRICS.map((metric) => metric.key),
  });
  return {
    ok: true,
    action: "sources",
    meta,
    warehouse: {
      attempt_rows: rows,
      first_day: dayOf(cov.first_day),
      last_day: dayOf(cov.last_day),
      // Unix millis → ISO with a zone: a zone-less ClickHouse DateTime text would be parsed as LOCAL time by the browser. An empty table yields 0 (1970) → null.
      last_synced_at: n(cov.last_synced_ms) > 0 ? isoOfMillis(cov.last_synced_ms) : null,
      rows_without_raw_status: n(cov.rows_without_raw_status),
    },
    coverage: coverageList,
    last_import: importRow
      ? {
        imported_at: nullable(importRow.imported_at),
        status: nullable(importRow.status),
        rows_total: importRow.rows_total == null ? null : n(importRow.rows_total),
        rows_inserted: importRow.rows_inserted == null ? null : n(importRow.rows_inserted),
        rows_updated: importRow.rows_updated == null ? null : n(importRow.rows_updated),
        source: nullable(importRow.source),
      }
      : null,
    // Lifecycle only: no cursor, no counters, no error text (plan N, §24).
    sync_state: stateRow ? { status: nullable(stateRow.status), updated_at: nullable(stateRow.updated_at), last_run_at: nullable(stateRow.last_run_at ?? stateRow.last_synced_at) } : null,
    support: { by_month: supportByMonth },
    metrics: PAYMENT_HEALTH_METRICS.map((metric) => ({
      key: metric.key,
      title: metric.title,
      phase: metric.phase,
      available: PHASE_AVAILABLE.has(metric.phase),
      heuristic: metric.heuristic,
      estimate: metric.estimate,
      notes: metric.notes,
    })),
  };
}

// ---------------------------------------------------------------------------
// options
// ---------------------------------------------------------------------------

const OPTION_DIMENSIONS: readonly string[] = ["funnel", "country", "card_network", "payment_method", "initiation", "transaction_type"];

async function runOptions(ctx: RunContext): Promise<OptionsResponse> {
  const { input, nreq, registry, snapshot } = ctx;
  // The whole tenant history, unfiltered (a filter must never hide its own
  // other values), through the same base so the funnel anchor join applies.
  const params: Record<string, unknown> = { auth_user_id: input.tenantKey };
  // Inside the ClickHouse Date range (1970-01-01 .. 2149-06-06): a bound beyond it would not parse.
  const window = { from: "1970-01-02", to: "2100-12-31" };
  // One scan: each row contributes one (dimension, value) pair per dimension
  // (ARRAY JOIN over a literal tuple array), then one GROUP BY.
  const pairs = OPTION_DIMENSIONS.map((dimension) => `tuple('${dimension}', ${dimension})`).join(", ");
  const rows = await json(
    input.clickhouse,
    `/* ph:options */ WITH ${attemptCtes(nreq, registry, snapshot, window, params, false)}
SELECT tupleElement(pair, 1) AS d, tupleElement(pair, 2) AS v, count() AS n
FROM att
ARRAY JOIN [${pairs}] AS pair
GROUP BY d, v`,
    params,
  );
  const values = new Map<string, Array<{ key: string; n: number }>>();
  for (const row of rows) {
    const list = values.get(s(row.d)) ?? [];
    list.push({ key: s(row.v), n: n(row.n) });
    values.set(s(row.d), list);
  }
  const option = (dimension: PaymentHealthDimension | "transaction_type"): DimensionValue[] => {
    const list = (values.get(dimension) ?? []).filter((entry) => entry.key !== "");
    return list
      .map((entry) => (dimension === "transaction_type" ? { key: entry.key, label: STAGE_LABELS[entry.key] ?? titleCase(entry.key) } : dimensionValueOf(dimension, { [dimension]: entry.key }, registry)))
      .sort((a, b) => a.label.localeCompare(b.label));
  };
  const accounts = [...registry.accounts.values()].sort((a, b) => a.processor.localeCompare(b.processor) || a.label.localeCompare(b.label));
  const descriptors = [...registry.descriptors.values()].sort((a, b) => a.processor.localeCompare(b.processor) || a.label.localeCompare(b.label));
  const meta = buildMeta(ctx, "options", { estimates: [FUNNEL_NOTE] });
  return {
    ok: true,
    action: "options",
    meta,
    options: {
      processor: nreq.psp_visible ? registry.processors : [],
      merchant_account: nreq.psp_visible ? accounts : [],
      descriptor: nreq.psp_visible ? descriptors : [],
      funnel: option("funnel"),
      country: option("country"),
      card_network: option("card_network"),
      payment_method: option("payment_method"),
      initiation: option("initiation"),
      transaction_type: option("transaction_type"),
      dimensions: PAYMENT_HEALTH_DIMENSIONS.filter((dimension) => nreq.psp_visible || !PSP_DIMENSIONS.has(dimension)).map((dimension) => ({
        key: dimension,
        label: DIMENSION_LABELS[dimension],
        psp: PSP_DIMENSIONS.has(dimension),
      })),
    },
    bounds: { first_day: registry.first_day, last_day: registry.last_day },
  };
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export async function runPaymentHealth(input: PaymentHealthRunInput): Promise<PaymentHealthResponse> {
  const clock = input.clock ?? Date.now;
  const started = clock();
  const today = todayOf(clock);
  const nreq = normalizePaymentHealthRequest(input.request, { today, pspVisible: input.pspVisible });
  const [registry, snapshot] = await Promise.all([loadDimensionRegistry(input), loadAnchorSnapshot(input.pg, input.tenantKey)]);
  const ctx: RunContext = { input, nreq, registry, snapshot, maturity: maturityOf(nreq, registry), today, started, clock };
  switch (nreq.action) {
    case "overview":
      return runOverview(ctx);
    case "declines":
      return runDeclines(ctx);
    case "retries":
      return runRetries(ctx);
    case "refunds_support":
      return runRefundsSupport(ctx);
    case "sources":
      return runSources(ctx);
    case "options":
      return runOptions(ctx);
  }
}
