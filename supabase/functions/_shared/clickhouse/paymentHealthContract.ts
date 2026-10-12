// Payment System Health P2: the request / response contract of the
// clickhouse-payment-health Edge function (plan sections J, M, N, R, S, X).
//
// Pure module (no Deno globals, no ClickHouse): the runner (paymentHealth.ts),
// the policy (access/policies/clickhouse-payment-health.ts), the browser data
// source and the tests all read the same shapes and the same normalizer, so a
// filter the UI sends and a filter the SQL binds can never drift apart.
//
// Conventions the shapes follow:
//   * every value is an aggregate: no emails, user ids, transaction ids, card
//     fragments, tokens or IPs (plan S). MIDs and descriptors appear only as
//     registry labels with OPAQUE ids (psp_accounts.id, or a keyed hash for an
//     unlabelled one); instrument keys only as keyed hashes;
//   * a rate is null when its denominator is 0 (no data, never zero, plan O);
//   * comparisons carry both periods, the Wilson intervals and the sample
//     flags (paymentHealthMetrics.ts), never a bare "significant";
//   * the chain / retry figures are heuristics and the response says so
//     (meta.estimates);
//   * declines are never called fraud: issuer_suspected_fraud is the issuer's
//     suspicion code (plan G).

import type { DeclineClass, DeclineSeverity, RetryGuidance, BanSource } from "./declineTaxonomy.ts";
import type { MetricKey, PeriodComparison, RateEstimate, CountDecomposition } from "./paymentHealthMetrics.ts";
import type { PostBanSummary, ChainSummary } from "./attemptChains.ts";

// ---------------------------------------------------------------------------
// Actions, dimensions, limits
// ---------------------------------------------------------------------------

export const PAYMENT_HEALTH_ACTIONS = ["overview", "declines", "retries", "refunds_support", "sources", "options"] as const;
export type PaymentHealthAction = (typeof PAYMENT_HEALTH_ACTIONS)[number];

/** Default window when the request names no dates: the last 30 days up to today (UTC). */
export const DEFAULT_RANGE_DAYS = 30;
/** Longest window one request may ask for (current period; the baseline doubles the scan). */
export const MAX_RANGE_DAYS = 400;
/** Values per filter list. */
export const MAX_FILTER_VALUES = 200;
/** Attempt rows the retries action fetches at most; beyond it the report is flagged `limited` (plan Y). */
export const ATTEMPT_ROW_CAP = 300_000;
/** Plan M: a complaint is attributed to the LAST settled payment of its matched user within this many days before it. */
export const COMPLAINT_ATTRIBUTION_DAYS = 30;
/**
 * Plan P: refund and complaint rates are time-to-event figures by original
 * payment date — the newest window is structurally lower because its payments
 * have had fewer days to be refunded or complained about. Their comparison is
 * flagged immature (never significant) until data_through is this many days
 * past range.to; the plain incomplete flag (import lag) is not enough for them.
 */
export const REFUND_MATURITY_DAYS = 30;
/** The retries action reads this many days before the window too: a ban issued before the period still bans. */
export const RETRY_LOOKBACK_DAYS = 30;
/** Post-ban attempts and rolling windows returned at most (the summaries count everything). */
export const POST_BAN_ATTEMPT_LIMIT = 200;
export const ROLLING_WINDOW_LIMIT = 100;
/** Code-mix rows returned at most (sorted by count). */
export const CODE_MIX_LIMIT = 100;
/** What-changed contributors per dimension. */
export const WHAT_CHANGED_LIMIT = 8;
/** Daily trend up to this many days in the window; weekly beyond (bounded group rows). */
export const DAILY_TREND_MAX_DAYS = 120;
/** How long a computed retries report is served from memory per workspace + request (like leads.ts). */
export const PAYMENT_HEALTH_MEMO_TTL_MS = 60_000;
export const PAYMENT_HEALTH_MEMO_MAX_ENTRIES = 16;

/** The country of a row: the issuer (BIN) country — 98.4% filled against 77.4% for the billing address (plan F). */
export const COUNTRY_BASIS = "issuer_country" as const;
export const COUNTRY_BASIS_LABEL = "Issuer country (BIN)";

export const PAYMENT_HEALTH_DIMENSIONS = [
  "processor",
  "merchant_account",
  "descriptor",
  "funnel",
  "country",
  "card_network",
  "payment_method",
  "initiation",
  "stage",
] as const;
export type PaymentHealthDimension = (typeof PAYMENT_HEALTH_DIMENSIONS)[number];

/** Dimensions that name a PSP account: shown only with payment_health.psp_global.view (plan X). */
export const PSP_DIMENSIONS: ReadonlySet<PaymentHealthDimension> = new Set(["processor", "merchant_account", "descriptor"]);

export const DIMENSION_LABELS: Readonly<Record<PaymentHealthDimension, string>> = {
  processor: "Processor (PSP)",
  merchant_account: "Merchant account (MID)",
  descriptor: "Statement descriptor",
  funnel: "Funnel (acquisition anchor)",
  country: COUNTRY_BASIS_LABEL,
  card_network: "Card network",
  payment_method: "Payment method",
  initiation: "Initiation (CIT / MIT)",
  stage: "Stage",
};

/** Keys of rows whose value is absent: kept as their own line, never dropped (plan W). */
export const UNROUTED_PROCESSOR_KEY = "unrouted";
export const UNATTRIBUTED_FUNNEL_KEY = "unattributed";
export const UNKNOWN_VALUE_KEY = "unknown";

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

export type InitiationFilter = "cit" | "mit" | "unknown";

export interface PaymentHealthFilters {
  /** Processor keys as the options action lists them (STRIPE, ADYEN, ..., 'unrouted'). */
  processor: string[];
  /** Opaque merchant-account ids (psp_accounts.id or 'unlabelled:<hash>'). */
  merchant_account: string[];
  /** Opaque descriptor ids ('d:<hash>'). */
  descriptor: string[];
  /** Acquisition-anchor campaign paths (fact_user_cohorts), or 'unattributed'. */
  funnel: string[];
  /** Issuer (BIN) country codes, or 'unknown'. */
  country: string[];
  card_network: string[];
  payment_method: string[];
  initiation: InitiationFilter[];
  /** analytics_transactions.transaction_type values (successes carry a type; declines are failed_payment). */
  transaction_type: string[];
}

export interface DateWindow {
  /** YYYY-MM-DD, inclusive. */
  from: string;
  to: string;
  days: number;
}

export interface PaymentHealthRequest {
  action?: string;
  date_from?: string | null;
  date_to?: string | null;
  filters?: Partial<Record<keyof PaymentHealthFilters, unknown>> | null;
  /** The breakdown dimension of declines / refunds_support (default: processor when PSP dimensions are visible, else funnel). */
  dimension?: string | null;
}

export interface NormalizedPaymentHealthRequest {
  action: PaymentHealthAction;
  range: DateWindow;
  /** The previous window of the same length, ending the day before `range.from`. */
  compare: DateWindow;
  filters: PaymentHealthFilters;
  dimension: PaymentHealthDimension;
  /** Whether PSP dimensions were allowed for this caller (the runner strips them otherwise). */
  psp_visible: boolean;
}

/** A malformed request (400). */
export class PaymentHealthRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentHealthRequestError";
  }
}

/** A PSP dimension or filter from a caller without payment_health.psp_global.view (403 permission_denied). */
export class PaymentHealthPermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentHealthPermissionError";
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

function text(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

/** UTC day arithmetic on YYYY-MM-DD strings (no local-time drift). */
export function shiftDay(day: string, days: number): string {
  const at = Date.parse(`${day}T00:00:00.000Z`);
  return new Date(at + days * DAY_MS).toISOString().slice(0, 10);
}

/** Inclusive day count of [from, to]. */
export function daysInclusive(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / DAY_MS) + 1;
}

function validDay(value: unknown, field: string): string | null {
  if (value == null || value === "") return null;
  const raw = text(value).trim();
  if (!DATE_RE.test(raw) || Number.isNaN(Date.parse(`${raw}T00:00:00.000Z`))) {
    throw new PaymentHealthRequestError(`Invalid ${field} (YYYY-MM-DD): ${raw}`);
  }
  return raw;
}

/** A filter list: trimmed, transformed, then de-duplicated (so "visa" and "VISA" bind once). */
function list(value: unknown, field: string, transform: (entry: string) => string = (entry) => entry): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new PaymentHealthRequestError(`Filter ${field} must be an array.`);
  const out = Array.from(new Set(value.map((entry) => text(entry).trim()).filter(Boolean).map(transform)));
  if (out.length > MAX_FILTER_VALUES) throw new PaymentHealthRequestError(`Filter ${field} too large.`);
  return out;
}

export function isPaymentHealthAction(value: unknown): value is PaymentHealthAction {
  return typeof value === "string" && (PAYMENT_HEALTH_ACTIONS as readonly string[]).includes(value);
}

export function isPaymentHealthDimension(value: unknown): value is PaymentHealthDimension {
  return typeof value === "string" && (PAYMENT_HEALTH_DIMENSIONS as readonly string[]).includes(value);
}

/** The window pair of a request: [from, to] and the equal-length window before it. */
export function windowsFor(from: string, to: string): { range: DateWindow; compare: DateWindow } {
  const days = daysInclusive(from, to);
  const compareTo = shiftDay(from, -1);
  const compareFrom = shiftDay(compareTo, -(days - 1));
  return { range: { from, to, days }, compare: { from: compareFrom, to: compareTo, days } };
}

/**
 * Validates and defaults a request body. `today` is the caller's clock (UTC
 * day) so tests are deterministic; `pspVisible` says whether the caller may
 * name PSP dimensions — a PSP filter or dimension without it is refused
 * (PaymentHealthPermissionError), never silently dropped: a dropped filter
 * would answer with other numbers than the UI asked for.
 */
export function normalizePaymentHealthRequest(body: unknown, options: { today: string; pspVisible: boolean }): NormalizedPaymentHealthRequest {
  const req = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as PaymentHealthRequest;
  if (!isPaymentHealthAction(req.action)) throw new PaymentHealthRequestError(`Unknown payment health action: ${text(req.action) || "none"}`);

  const to = validDay(req.date_to, "date_to") ?? options.today;
  const from = validDay(req.date_from, "date_from") ?? shiftDay(to, -(DEFAULT_RANGE_DAYS - 1));
  if (from > to) throw new PaymentHealthRequestError(`date_from (${from}) is after date_to (${to}).`);
  const days = daysInclusive(from, to);
  if (days > MAX_RANGE_DAYS) throw new PaymentHealthRequestError(`The window spans ${days} days; the maximum is ${MAX_RANGE_DAYS}.`);

  const f = req.filters && typeof req.filters === "object" ? req.filters : {};
  const initiation = list(f.initiation, "initiation", (value) => value.toLowerCase());
  for (const value of initiation) {
    if (value !== "cit" && value !== "mit" && value !== "unknown") throw new PaymentHealthRequestError(`Filter initiation accepts cit, mit or unknown, not ${value}.`);
  }
  const upperUnless = (sentinel: string) => (value: string) => (value === sentinel ? value : value.toUpperCase());
  const filters: PaymentHealthFilters = {
    processor: list(f.processor, "processor", upperUnless(UNROUTED_PROCESSOR_KEY)),
    merchant_account: list(f.merchant_account, "merchant_account"),
    descriptor: list(f.descriptor, "descriptor"),
    funnel: list(f.funnel, "funnel"),
    country: list(f.country, "country", upperUnless(UNKNOWN_VALUE_KEY)),
    // The options action hands out the lowercase 'unknown' key for an empty value; upper-casing it would never match a row.
    card_network: list(f.card_network, "card_network", upperUnless(UNKNOWN_VALUE_KEY)),
    payment_method: list(f.payment_method, "payment_method", upperUnless(UNKNOWN_VALUE_KEY)),
    initiation: initiation as InitiationFilter[],
    transaction_type: list(f.transaction_type, "transaction_type"),
  };

  let dimension: PaymentHealthDimension;
  if (req.dimension == null || req.dimension === "") {
    dimension = options.pspVisible ? "processor" : "funnel";
  } else if (isPaymentHealthDimension(req.dimension)) {
    dimension = req.dimension;
  } else {
    throw new PaymentHealthRequestError(`Unknown dimension: ${text(req.dimension)}`);
  }

  if (!options.pspVisible) {
    const named = (["processor", "merchant_account", "descriptor"] as const).filter((key) => filters[key].length);
    if (named.length) throw new PaymentHealthPermissionError(`Filters ${named.join(", ")} need payment_health.psp_global.view.`);
    if (PSP_DIMENSIONS.has(dimension)) throw new PaymentHealthPermissionError(`Dimension ${dimension} needs payment_health.psp_global.view.`);
  }

  return { action: req.action, ...windowsFor(from, to), filters, dimension, psp_visible: options.pspVisible };
}

// ---------------------------------------------------------------------------
// Response: shared pieces
// ---------------------------------------------------------------------------

/** A dimension value as the UI shows it: an opaque key for filters, a label for people. */
export interface DimensionValue {
  key: string;
  label: string;
}

export interface MerchantAccountRef extends DimensionValue {
  /** psp_accounts.id, or 'unlabelled:<keyed hash>' for a MID the registry does not know; 'none' without a MID. */
  key: string;
  processor: string;
  /** false: the registry has no row (label "Unlabelled MID"); run psp_accounts_sync after an import. */
  labelled: boolean;
}

export interface DescriptorRef extends DimensionValue {
  /** 'd:<keyed hash>'; 'none' without a descriptor. */
  key: string;
  processor: string;
}

export interface FunnelAttribution {
  /** active: the anchor join ran on a validated fact_user_cohorts snapshot; no_snapshot: every row is 'unattributed'. */
  status: "active" | "no_snapshot";
  basis: "cohort_anchor";
  note: string;
}

export interface PaymentHealthMeta {
  action: PaymentHealthAction;
  generated_at: string;
  range: DateWindow;
  compare: DateWindow;
  /** The newest attempt day in the warehouse (tenant-wide), or null when empty. */
  data_through: string | null;
  /** range.to is after data_through: the manual CSV import has not covered the whole window (grey marker, plan P). */
  incomplete: boolean;
  /** Days between data_through and today; null without data. */
  lag_days: number | null;
  funnel_attribution: FunnelAttribution;
  country_basis: typeof COUNTRY_BASIS;
  country_basis_label: string;
  /** PSP × MID / descriptor breakdowns are in the body (payment_health.psp_global.view or the data owner). */
  psp_global_visible: boolean;
  /** Caps that were hit (see each action). */
  limited: Record<string, boolean>;
  /** Plain-language notes on what is an estimate / heuristic in this response. */
  estimates: string[];
  /** Metric dictionary keys the action's figures follow (paymentHealthMetrics.ts). */
  definitions: MetricKey[];
  query_duration_ms: number;
}

export interface Fraction {
  numerator: number;
  denominator: number;
}

/** The counts one group holds in one period (the SQL metric columns). */
export interface AttemptTotals {
  attempts: number;
  successes: number;
  declines: number;
  settled_amount_usd: number;
  /** Settled payments later refunded (amount_refunded > 0 on the original payment). */
  refunded: number;
  refund_amount_usd: number;
  /** Declines in the issuer_suspected_fraud class (plan G issuer_fraud_declines). Not fraud. */
  issuer_fraud_declines: number;
  lost_stolen_declines: number;
  authentication_declines: number;
  psp_integration_declines: number;
  cause_unverified_declines: number;
  /** Rows with decline_record_count > 1 (plan G cascade_rows). */
  cascade_rows: number;
  /** Attempts with a 3DS result. */
  three_ds_attempts: number;
}

export interface PeriodTotals {
  current: AttemptTotals;
  baseline: AttemptTotals;
}

export interface ApprovalBlock {
  approval: PeriodComparison;
  issuer_fraud_share: PeriodComparison;
  refund_rate: PeriodComparison;
}

/** One breakdown row: a dimension value with both periods and the derived comparisons. */
export interface BreakdownRow extends PeriodTotals, ApprovalBlock {
  dimension: PaymentHealthDimension;
  value: DimensionValue;
  /** Declines of the current period per mutually exclusive class. */
  decline_classes: Partial<Record<DeclineClass, number>>;
}

export interface TrendPoint {
  /** The bucket start (day, or the week's Monday when meta.trend_granularity = 'week'). */
  bucket: string;
  attempts: number;
  successes: number;
  declines: number;
  approval_rate: number | null;
  issuer_fraud_declines: number;
  settled_amount_usd: number;
  /** The bucket ends after data_through (incomplete). */
  incomplete: boolean;
}

// ---------------------------------------------------------------------------
// overview
// ---------------------------------------------------------------------------

export interface PspMidRow extends PeriodTotals, ApprovalBlock {
  processor: DimensionValue;
  merchant_account: MerchantAccountRef;
  decline_classes: Partial<Record<DeclineClass, number>>;
  /** Support requests flagged possible_unauthorized_charge attributed to this account (current / baseline windows by received_at). */
  complaints_unauthorized: { current: number; baseline: number };
  /**
   * complaints_unauthorized over the account's settled payments of the window
   * REGARDLESS of the request's filters: support requests carry no funnel /
   * country / network, so the numerator cannot be filtered and the denominator
   * is kept unfiltered to describe the same population (the attempt columns
   * above ARE filtered).
   */
  complaint_rate: PeriodComparison;
  trend: TrendPoint[];
}

export interface WhatChangedRow {
  dimension: PaymentHealthDimension;
  value: DimensionValue;
  /** Δdeclines = Δvolume × rate + volume × Δrate (plan H), declines over attempts. */
  decomposition: CountDecomposition;
}

export interface OverviewResponse {
  ok: true;
  action: "overview";
  meta: PaymentHealthMeta & { trend_granularity: "day" | "week" };
  totals: PeriodTotals & ApprovalBlock & {
    /** Declines of the current period per class (mutually exclusive). */
    decline_classes: Partial<Record<DeclineClass, number>>;
    complaints_unauthorized: { current: number; baseline: number; unattributed_current: number; unattributed_baseline: number };
    /** Flagged requests over the window's settled payments regardless of the active filters (support requests are not filterable). */
    support_unauthorized_rate: PeriodComparison;
  };
  /** One point per bucket of the whole window (a bucket without attempts is zero), buckets after data_through flagged incomplete. */
  trend: TrendPoint[];
  /** Empty without payment_health.psp_global.view. */
  psp_mid_rows: PspMidRow[];
  /** Top movers of the decline count per dimension (PSP dimensions only when visible). */
  what_changed: WhatChangedRow[];
}

// ---------------------------------------------------------------------------
// declines
// ---------------------------------------------------------------------------

export interface DeclineClassRow {
  decline_class: DeclineClass;
  label: string;
  current: number;
  baseline: number;
  /** Share of the current period's declines. */
  share_of_declines: number | null;
  /** Declines of this class over attempts, current vs baseline. */
  rate: PeriodComparison;
}

export interface CodeMixRow {
  decline_class: DeclineClass;
  issuer_result_code: string | null;
  primer_decline_code: string | null;
  advised_action: string | null;
  advice_code: string | null;
  severity: DeclineSeverity;
  retry_guidance: RetryGuidance;
  retry_ban: boolean;
  current: number;
  baseline: number;
}

export interface DeclinesResponse {
  ok: true;
  action: "declines";
  meta: PaymentHealthMeta;
  dimension: PaymentHealthDimension;
  totals: PeriodTotals & ApprovalBlock;
  by_class: DeclineClassRow[];
  by_dimension: BreakdownRow[];
  /** At most CODE_MIX_LIMIT rows by current count; meta.limited.code_mix says when more were dropped. */
  code_mix: CodeMixRow[];
  severity: { current: Record<DeclineSeverity, number>; baseline: Record<DeclineSeverity, number> };
}

// ---------------------------------------------------------------------------
// retries
// ---------------------------------------------------------------------------

export interface ChainRates {
  final_success_rate: RateEstimate;
  chain_first_try_approval_rate: RateEstimate;
  retry_recovery_rate: RateEstimate;
  cascade_recovery: RateEstimate;
  attempt_approval_rate: RateEstimate;
}

export interface PostBanAttemptRow {
  /** Keyed hash of payment_instrument_key: opaque, stable within the workspace. */
  instrument: string;
  ban_event_time: string;
  ban_sources: BanSource[];
  ban_decline_class: DeclineClass | null;
  event_time: string;
  minutes_since_ban: number;
  initiation_type: "cit" | "mit" | "unknown";
  processor_relation: "same" | "switched" | "unknown";
  succeeded: boolean;
  banned_again: boolean;
  /** null without payment_health.psp_global.view. */
  processor: DimensionValue | null;
  merchant_account: MerchantAccountRef | null;
}

export interface RollingWindowRow {
  instrument: string;
  merchant_account: MerchantAccountRef | null;
  max_declines: number;
  limit: number;
  window_start: string;
  window_end: string;
  decline_records_total: number;
}

export interface RetriesResponse {
  ok: true;
  action: "retries";
  meta: PaymentHealthMeta & {
    /** The rows the report read: the window plus RETRY_LOOKBACK_DAYS before it. */
    rows_window: DateWindow;
    rows_read: number;
    memo: "hit" | "miss" | "coalesced";
    chain_options: { cit_window_minutes: number; mit_window_hours: number; rolling_window_days: number; rolling_decline_limit: number };
  };
  /** Chains that started inside the window. */
  chains: ChainSummary & ChainRates;
  post_ban: PostBanSummary & { within_window: number };
  /** Newest POST_BAN_ATTEMPT_LIMIT rows (post_ban.attempts counts them all); meta.limited.post_ban_attempts when cut. */
  post_ban_attempts: PostBanAttemptRow[];
  /** windows: the pairs over the limit, at most ROLLING_WINDOW_LIMIT (violations counts them all); meta.limited.rolling_windows when cut. */
  rolling: { pairs: number; violations: number; windows: RollingWindowRow[] };
  cascade_rows: number;
}

// ---------------------------------------------------------------------------
// refunds_support
// ---------------------------------------------------------------------------

export interface RefundTimingBuckets {
  /** Refunded payments whose refund_observed_at is known. */
  observed: number;
  /** Refunded payments without an observed date (synced before P0). */
  unobserved: number;
  within_7_days: number;
  within_30_days: number;
  within_90_days: number;
  beyond_90_days: number;
}

export interface RefundMonthRow {
  /** Original payment month (YYYY-MM-01). */
  month: string;
  settled: number;
  refunded: number;
  refund_amount_usd: number;
  refund_rate: RateEstimate;
}

export interface ComplaintCounts {
  total: number;
  possible_unauthorized_charge: number;
  requires_refund: number;
  duplicate_charge: number;
}

export interface ComplaintMonthRow extends ComplaintCounts {
  /** Received month (YYYY-MM-01). */
  month: string;
  /** classification_version values seen in the month (a change is a trend break, plan F). */
  classification_versions: string[];
  /** The version set differs from the previous month's. */
  version_break: boolean;
  by_category: Array<{ category: string; count: number }>;
}

export interface ComplaintAccountRow extends ComplaintCounts {
  processor: DimensionValue;
  merchant_account: MerchantAccountRef;
}

export interface RefundsSupportResponse {
  ok: true;
  action: "refunds_support";
  meta: PaymentHealthMeta;
  dimension: PaymentHealthDimension;
  refunds: {
    totals: PeriodTotals & ApprovalBlock;
    by_dimension: BreakdownRow[];
    /** Current window by original payment month. */
    by_month: RefundMonthRow[];
    timing: RefundTimingBuckets;
  };
  complaints: {
    /** Both windows by received month (the comparison windows too). */
    by_month: ComplaintMonthRow[];
    current: ComplaintCounts & { unattributed: number };
    baseline: ComplaintCounts & { unattributed: number };
    /** Flagged requests over the window's settled payments regardless of the active filters (support requests are not filterable). */
    support_unauthorized_rate: PeriodComparison;
    /** Attribution to the last settled payment of the matched user within COMPLAINT_ATTRIBUTION_DAYS (current window). Empty without psp_global.view. */
    by_account: ComplaintAccountRow[];
    attribution_days: number;
  };
}

// ---------------------------------------------------------------------------
// sources
// ---------------------------------------------------------------------------

export interface ColumnCoverage {
  column: string;
  /** Rows with a value (non-empty / non-zero / not null) over attempt rows, tenant-wide. */
  filled: number;
  rows: number;
  share: number | null;
}

export interface SourcesResponse {
  ok: true;
  action: "sources";
  meta: PaymentHealthMeta;
  warehouse: {
    attempt_rows: number;
    first_day: string | null;
    last_day: string | null;
    last_synced_at: string | null;
    /** Rows whose raw_status is '' (synced before the P0 backfill): still counted as attempts. */
    rows_without_raw_status: number;
  };
  coverage: ColumnCoverage[];
  last_import: { imported_at: string | null; status: string | null; rows_total: number | null; rows_inserted: number | null; rows_updated: number | null; source: string | null } | null;
  sync_state: { status: string | null; updated_at: string | null; last_run_at: string | null } | null;
  support: {
    by_month: Array<{ month: string; requests: number; classification_versions: string[]; version_break: boolean }>;
  };
  /** The metric dictionary with the phase each metric's data arrives in (what is and is not measured). */
  metrics: Array<{ key: MetricKey; title: string; phase: string; available: boolean; heuristic: boolean; estimate: boolean; notes: string }>;
}

// ---------------------------------------------------------------------------
// options
// ---------------------------------------------------------------------------

export interface OptionsResponse {
  ok: true;
  action: "options";
  meta: PaymentHealthMeta;
  options: {
    /** Empty without payment_health.psp_global.view. */
    processor: DimensionValue[];
    merchant_account: MerchantAccountRef[];
    descriptor: DescriptorRef[];
    funnel: DimensionValue[];
    country: DimensionValue[];
    card_network: DimensionValue[];
    payment_method: DimensionValue[];
    initiation: DimensionValue[];
    transaction_type: DimensionValue[];
    dimensions: Array<DimensionValue & { psp: boolean }>;
  };
  bounds: { first_day: string | null; last_day: string | null };
}

export type PaymentHealthResponse = OverviewResponse | DeclinesResponse | RetriesResponse | RefundsSupportResponse | SourcesResponse | OptionsResponse;
