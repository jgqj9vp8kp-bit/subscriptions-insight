// Cohorts data-source abstraction.
//
// Feature flag VITE_COHORTS_DATA_SOURCE: "clickhouse" (server-side ClickHouse
// drives the table; the client compute stays only as the on-failure / unreproduced-
// filter fallback) or "legacy" (client compute only). The two engines never run
// simultaneously for comparison. Legacy code is never removed.
//
// This module maps the Edge Function's aggregate rows onto the existing CohortRow
// view model (deriving rates/LTVs with the SAME formulas as analytics.ts).
// compareCohortResults remains as an offline parity utility (used by tests and
// ad-hoc verification), but is NOT executed by the page.

import { computeCohortsWithDiagnostics, type ComputeCohortsOptions, type MonetizationDiagnostics } from "@/services/analytics";
import { buildCohortId } from "@/services/cohortIdentity";
import { runClickHouseCohorts, runClickHouseCohortDetails } from "@/services/clickhouse";
import { publicRuntimeConfig } from "@/config/publicRuntimeConfig";
import type { CardType, CohortRow, Funnel, MediaBuyer, Transaction } from "@/services/types";
import type { FxNormalizationDiagnostics } from "@/services/currencyNormalization";
import type { CampaignIdOption } from "@/services/cohortCampaignIds";
import type { CountryUserCount } from "@/services/userCountry";
import type { CohortCardTypeOption } from "@/services/cohortCardTypes";
import type { MediaBuyerOption } from "@/services/cohortMediaBuyer";
import type { SubscriptionClean } from "@/types/subscriptions";
import type {
  CohortAggregateRow,
  CohortDetailsResponse,
  CohortRequest,
  CohortResponse,
  SubscriptionDataStatus,
} from "../../supabase/functions/_shared/clickhouse/cohortContract";

// Filter-option lists shaped exactly like the client builders, so the page drops
// them into the existing dropdowns unchanged. These are CASCADING: the server
// scopes every list to the request's active filters, minus that list's own
// dimension (see cohortFilterOptions.ts).
export interface CohortFilterOptionsView {
  funnel: Funnel[];
  campaign_path: string[];
  traffic_source: string[];
  price_plan: string[];
  currency: string[];
  campaign_id: CampaignIdOption[];
  country: CountryUserCount[];
  card_type: CohortCardTypeOption[];
  media_buyer: MediaBuyerOption[];
}

export type CohortsDataSourceMode = "legacy" | "clickhouse";

export function cohortsDataSourceMode(): CohortsDataSourceMode {
  return publicRuntimeConfig.cohortsDataSource === "legacy" ? "legacy" : "clickhouse";
}

function round2(x: number): number {
  return Math.floor(x * 100 + 0.5) / 100;
}

export interface CohortsSourceResult {
  cohorts: CohortRow[];
  source: "clickhouse" | "legacy";
  durationMs: number;
  subscriptionDataStatus?: SubscriptionDataStatus;
  diagnostics?: CohortResponse["diagnostics"];
  /** Server-built CASCADING dropdown options, scoped to the request's filters (clickhouse source only). */
  filterOptions?: CohortFilterOptionsView;
  /** How those options were scoped: filters applied/ignored, scope user count, duration. */
  filterOptionsDiagnostics?: CohortResponse["filter_options_diagnostics"];
  /** Dataset-level FX/token diagnostics for the panels (clickhouse source only). */
  fxDiagnostics?: FxNormalizationDiagnostics;
  tokenDiagnostics?: MonetizationDiagnostics;
}

// Non-reversible synthetic ids sized to a count. Because each user belongs to
// exactly ONE cohort, the page's cross-cohort `new Set(flatMap(...))` dedup over
// these yields the correct total — without shipping any real user ids.
function synthIds(cohortId: string, prefix: string, count: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) out.push(`${cohortId}:${prefix}${i}`);
  return out;
}

// ---- Map one Edge aggregate row -> a full CohortRow view model ------------
// Derived rates/LTVs use the exact analytics.ts formulas so the ClickHouse path
// is a drop-in. Subscription (active/cancelled) metrics stay 0/deferred; the
// lazy breakdowns (plan/currency/token pack) load on row expand.

export function mapAggregateToCohortRow(agg: CohortAggregateRow): CohortRow {
  const trial = agg.trial_users || 0;
  const byLevel = agg.renewal_users_by_level ?? {};
  const renewalN = (lvl: number) => Number(byLevel[lvl] ?? 0);
  const gross = agg.gross_revenue;
  const net = agg.net_revenue;
  const div = (a: number, b: number) => (b ? (a / b) * 100 : 0);
  const cohortId = buildCohortId(agg.funnel, agg.campaign_path, agg.cohort_date);

  return {
    cohort_id: cohortId,
    cohort_date: agg.cohort_date,
    funnel: agg.funnel as CohortRow["funnel"],
    campaign_path: agg.campaign_path,
    trial_users: trial,
    support_users: agg.support_users ?? 0,
    support_rate: agg.support_rate ?? 0,
    // Subscription metrics deferred (fact_subscriptions empty) — not zero-proven.
    active_users: 0,
    active_rate: 0,
    active_subscriptions: 0,
    active_subscriptions_rate: 0,
    active_subscription_user_ids: [],
    active_subscription_ids: [],
    cancelled_users: 0,
    cancellation_rate: 0,
    user_cancelled_users: 0,
    user_cancel_rate: 0,
    auto_cancelled_users: 0,
    auto_cancel_rate: 0,
    cancelled_active_users: 0,
    active_user_ids: [],
    cancelled_user_ids: [],
    user_cancelled_user_ids: [],
    auto_cancelled_user_ids: [],
    cancelled_active_user_ids: [],
    upsell_users: agg.upsell_users,
    first_subscription_users: agg.first_subscription_users,
    renewal_2_users: renewalN(2),
    renewal_3_users: renewalN(3),
    renewal_4_users: renewalN(4),
    renewal_5_users: renewalN(5),
    renewal_6_users: renewalN(6),
    renewal_users_by_level: { ...byLevel },
    renewal_users: agg.renewal_users,
    refund_users: agg.refund_users,
    // Synthetic, cohort-scoped ids so the totals memo's cross-cohort dedup counts
    // correctly (each user is in one cohort). No real user ids are shipped.
    refunded_user_ids: synthIds(cohortId, "r", agg.refund_users),
    plan_breakdown: [],
    trial_revenue: agg.trial_revenue,
    upsell_revenue: agg.upsell_revenue,
    first_subscription_revenue: agg.first_subscription_revenue,
    renewal_revenue: agg.renewal_revenue,
    upsell_1_users: agg.upsell_1_users,
    upsell_2_users: agg.upsell_2_users,
    upsell_3_users: agg.upsell_3_users,
    upsell_extra_users: agg.upsell_extra_users,
    upsell_1_revenue: agg.upsell_1_revenue,
    upsell_2_revenue: agg.upsell_2_revenue,
    upsell_3_revenue: agg.upsell_3_revenue,
    upsell_extra_revenue: agg.upsell_extra_revenue,
    upsell_1_cr: div(agg.upsell_1_users, trial),
    upsell_2_cr: div(agg.upsell_2_users, trial),
    upsell_3_cr: div(agg.upsell_3_users, trial),
    funnel_upsell_users: agg.funnel_upsell_users,
    funnel_upsell_revenue: agg.funnel_upsell_revenue,
    token_buyers: agg.token_buyers,
    token_buyer_cr: div(agg.token_buyers, trial),
    token_purchases: agg.token_purchases,
    token_gross_revenue: agg.token_gross_revenue,
    token_net_revenue: agg.token_net_revenue,
    avg_token_revenue_per_trial: trial ? round2(agg.token_net_revenue / trial) : 0,
    avg_token_revenue_per_buyer: agg.token_buyers ? round2(agg.token_net_revenue / agg.token_buyers) : 0,
    addon_revenue: agg.addon_revenue,
    token_buyer_user_ids: synthIds(cohortId, "t", agg.token_buyers),
    token_pack_breakdown: [],
    currency_breakdown: [],
    currency_mix: "",
    fx_missing_amount: agg.fx_missing_amount,
    fx_missing_transactions: agg.fx_missing_transactions,
    net_revenue_1m: agg.net_revenue_1m,
    ltv_1m_per_user: agg.ltv_1m_per_user,
    amount_refunded: agg.amount_refunded,
    refund_rate: div(agg.refund_users, trial),
    gross_revenue: gross,
    net_revenue: net,
    gross_ltv: trial ? round2(gross / trial) : 0,
    net_ltv: trial ? round2(net / trial) : 0,
    trial_to_upsell_cr: div(agg.upsell_users, trial),
    trial_to_first_subscription_cr: div(agg.first_subscription_users, trial),
    first_subscription_to_renewal_2_cr: div(renewalN(2), agg.first_subscription_users),
    renewal_2_to_renewal_3_cr: div(renewalN(3), renewalN(2)),
    revenue_d0: agg.revenue_d0,
    revenue_d7: agg.revenue_d7,
    revenue_d14: agg.revenue_d14,
    revenue_d30: agg.revenue_d30,
    revenue_d60: agg.revenue_d60,
    revenue_d37: 0,
    revenue_d67: 0,
    revenue_total: net,
    ltv_d7: trial ? round2(agg.revenue_d7 / trial) : 0,
    ltv_d14: trial ? round2(agg.revenue_d14 / trial) : 0,
    ltv_d30: trial ? round2(agg.revenue_d30 / trial) : 0,
  };
}

// ---- Loaders --------------------------------------------------------------

export function mapFilterOptions(fo: CohortResponse["filter_options"]): CohortFilterOptionsView | undefined {
  if (!fo || !("funnel" in fo)) return undefined;
  return {
    funnel: (fo.funnel ?? []) as Funnel[],
    campaign_path: fo.campaign_path ?? [],
    traffic_source: fo.traffic_source ?? [],
    price_plan: fo.price_plan ?? [],
    currency: fo.currency ?? [],
    campaign_id: fo.campaign_id ?? [],
    country: fo.country ?? [],
    card_type: (fo.card_type ?? []).map((o) => ({ card_type: o.card_type as CardType, trial_count: o.trial_count })),
    media_buyer: (fo.media_buyer ?? []).map((o) => ({ media_buyer: o.media_buyer as MediaBuyer, trial_count: o.trial_count })),
  };
}

export async function loadCohortsFromClickHouse(request: CohortRequest): Promise<CohortsSourceResult> {
  const started = Date.now();
  const response = await runClickHouseCohorts({ ...request, action: "list" });
  if (!response.ok) throw new Error(response.error || "ClickHouse cohorts request failed.");
  const cohorts = (response.rows ?? [])
    .map(mapAggregateToCohortRow)
    .sort((a, b) => (a.cohort_date < b.cohort_date ? 1 : -1));
  return {
    cohorts,
    source: "clickhouse",
    durationMs: response.query_duration_ms ?? Date.now() - started,
    subscriptionDataStatus: response.diagnostics?.subscription_data_status,
    diagnostics: response.diagnostics,
    filterOptions: mapFilterOptions(response.filter_options),
    filterOptionsDiagnostics: response.filter_options_diagnostics,
    fxDiagnostics: response.fx_diagnostics as FxNormalizationDiagnostics | undefined,
    tokenDiagnostics: response.token_diagnostics
      ? ({ ...response.token_diagnostics, unknown_products: [] } as unknown as MonetizationDiagnostics)
      : undefined,
  };
}

export async function loadCohortDetailsFromClickHouse(
  cohortKey: { cohort_date: string; funnel: string; campaign_path: string },
  request: Omit<CohortRequest, "action" | "cohort_key"> = {},
): Promise<CohortDetailsResponse> {
  const response = await runClickHouseCohortDetails({ ...request, action: "details", cohort_key: cohortKey });
  if (!response.ok) throw new Error(response.error || "ClickHouse cohort details request failed.");
  return response;
}

export function loadCohortsFromLegacyClient(
  txs: Transaction[],
  subscriptions: SubscriptionClean[],
  options: ComputeCohortsOptions,
): CohortsSourceResult {
  const started = Date.now();
  const { cohorts } = computeCohortsWithDiagnostics(txs, subscriptions, options);
  return { cohorts, source: "legacy", durationMs: Date.now() - started };
}

// ---- Parity comparison (Phase 7) -----------------------------------------

const COUNT_METRICS = [
  "trial_users", "first_subscription_users", "renewal_users",
  "renewal_2_users", "renewal_3_users", "renewal_4_users", "renewal_5_users", "renewal_6_users",
  "upsell_1_users", "upsell_2_users", "upsell_3_users", "upsell_extra_users", "funnel_upsell_users",
  "token_buyers", "token_purchases", "refund_users",
] as const;

const MONEY_METRICS = [
  "gross_revenue", "net_revenue", "amount_refunded",
  "revenue_d0", "revenue_d7", "revenue_d14", "revenue_d30", "revenue_d60",
  "trial_revenue", "first_subscription_revenue", "renewal_revenue",
  "upsell_1_revenue", "upsell_2_revenue", "upsell_3_revenue", "upsell_extra_revenue", "funnel_upsell_revenue",
  "token_gross_revenue", "token_net_revenue", "addon_revenue",
  "net_revenue_1m", "ltv_1m_per_user", "gross_ltv", "net_ltv",
] as const;

const RATE_METRICS = [
  "trial_to_first_subscription_cr", "refund_rate",
] as const;

export interface CohortMetricMismatch {
  cohort_key: string;
  metric: string;
  legacy: number;
  clickhouse: number;
  diff: number;
  kind: "count" | "money" | "rate";
}

export interface CohortParityReport {
  status: "PASS" | "FAIL" | "NOT_APPLICABLE";
  matched_rows: number;
  missing_in_clickhouse: string[]; // cohort keys legacy has, ClickHouse lacks
  missing_in_legacy: string[]; // cohort keys ClickHouse has, legacy lacks
  mismatches: CohortMetricMismatch[];
  max_money_diff: number;
  max_rate_diff: number;
  legacy_duration_ms: number;
  clickhouse_duration_ms: number;
  compared_at: string;
  note?: string;
}

function num(v: unknown): number {
  const p = Number(v ?? 0);
  return Number.isFinite(p) ? p : 0;
}

// Money tolerance: max($0.01, 0.01% of the larger magnitude).
function moneyTolerance(a: number, b: number): number {
  return Math.max(0.01, Math.max(Math.abs(a), Math.abs(b)) * 0.0001);
}

export function compareCohortResults(
  legacy: CohortsSourceResult,
  clickhouse: CohortsSourceResult,
  options: { notApplicable?: boolean; note?: string } = {},
): CohortParityReport {
  const keyOf = (c: CohortRow) => c.cohort_id || buildCohortId(c.funnel, c.campaign_path, c.cohort_date);
  const legacyMap = new Map(legacy.cohorts.map((c) => [keyOf(c), c]));
  const chMap = new Map(clickhouse.cohorts.map((c) => [keyOf(c), c]));

  const missing_in_clickhouse: string[] = [];
  const missing_in_legacy: string[] = [];
  for (const key of legacyMap.keys()) if (!chMap.has(key)) missing_in_clickhouse.push(key);
  for (const key of chMap.keys()) if (!legacyMap.has(key)) missing_in_legacy.push(key);

  const mismatches: CohortMetricMismatch[] = [];
  let maxMoney = 0;
  let maxRate = 0;
  let matched = 0;

  for (const [key, lc] of legacyMap) {
    const cc = chMap.get(key);
    if (!cc) continue;
    matched += 1;
    const lr = lc as unknown as Record<string, number>;
    const cr = cc as unknown as Record<string, number>;

    for (const m of COUNT_METRICS) {
      const lv = num(lr[m]);
      const cv = num(cr[m]);
      if (lv !== cv) mismatches.push({ cohort_key: key, metric: m, legacy: lv, clickhouse: cv, diff: cv - lv, kind: "count" });
    }
    for (const m of MONEY_METRICS) {
      const lv = num(lr[m]);
      const cv = num(cr[m]);
      const diff = Math.abs(cv - lv);
      if (diff > maxMoney) maxMoney = diff;
      if (diff > moneyTolerance(lv, cv)) mismatches.push({ cohort_key: key, metric: m, legacy: lv, clickhouse: cv, diff: cv - lv, kind: "money" });
    }
    for (const m of RATE_METRICS) {
      const lv = num(lr[m]);
      const cv = num(cr[m]);
      const diff = Math.abs(cv - lv);
      if (diff > maxRate) maxRate = diff;
      if (diff > 0.0001) mismatches.push({ cohort_key: key, metric: m, legacy: lv, clickhouse: cv, diff: cv - lv, kind: "rate" });
    }
  }

  const clean = mismatches.length === 0 && missing_in_clickhouse.length === 0 && missing_in_legacy.length === 0;
  return {
    status: options.notApplicable ? "NOT_APPLICABLE" : clean ? "PASS" : "FAIL",
    matched_rows: matched,
    missing_in_clickhouse,
    missing_in_legacy,
    mismatches: mismatches.slice(0, 200),
    max_money_diff: round2(maxMoney),
    max_rate_diff: maxRate,
    legacy_duration_ms: legacy.durationMs,
    clickhouse_duration_ms: clickhouse.durationMs,
    compared_at: new Date().toISOString(),
    note: options.note,
  };
}

// Whether the active filters are all reproduced server-side. When a filter is
// active but not reproduced, shadow parity is NOT_APPLICABLE (comparing
// different populations would be a false mismatch).
export function filtersFullyReproduced(diagnostics: CohortResponse["diagnostics"] | undefined, active: {
  country: boolean; card_type: boolean; campaign_id: boolean; traffic_source?: boolean; price_plan?: boolean;
}): boolean {
  return cohortFilterReproductionStatus(diagnostics, active).applicable;
}

export function cohortFilterReproductionStatus(
  diagnostics: CohortResponse["diagnostics"] | undefined,
  active: { country: boolean; card_type: boolean; campaign_id: boolean; traffic_source?: boolean; price_plan?: boolean },
): { applicable: boolean; unsupportedFilters: string[]; reason: string; filtersApplied: CohortResponse["diagnostics"]["filters_applied"] | null } {
  if (!diagnostics) {
    return {
      applicable: false,
      unsupportedFilters: ["diagnostics"],
      reason: "ClickHouse response did not include cohort filter diagnostics.",
      filtersApplied: null,
    };
  }
  const fa = diagnostics.filters_applied;
  const unsupportedFilters = [
    active.country && !fa.country ? "country" : null,
    active.card_type && !fa.card_type ? "card_type" : null,
    active.campaign_id && !fa.campaign_id ? "campaign_id" : null,
    active.traffic_source && !fa.traffic_source ? "traffic_source" : null,
    active.price_plan && !fa.price_plan ? "price_plan" : null,
  ].filter((value): value is string => Boolean(value));
  return {
    applicable: unsupportedFilters.length === 0,
    unsupportedFilters,
    reason: unsupportedFilters.length
      ? `Active filters not reproduced server-side: ${unsupportedFilters.join(", ")}.`
      : "All active fallback-gated filters are reproduced server-side.",
    filtersApplied: fa,
  };
}

export type { CohortRow, MediaBuyer, CardType };
