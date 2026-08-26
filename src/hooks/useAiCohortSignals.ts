// AI-signals glue for the analytics pages: the deterministic engine runs over
// the rows each page ALREADY shows. Auxiliary inputs load in the background and
// never block the chips:
//  - funnel passports (trial_duration_days) gate Trial→Paid maturity (Cohorts);
//  - one payment-analytics bundle (grouped by campaign_path on Cohorts,
//    campaign_id on FB Analytics) supplies pass rates.
// Until they arrive the engine simply reports those input families as missing.
import { useMemo } from "react";
import { computeAiSignals, type AiEngineOutput, type AiPassRateSlice, type AiRecommendation } from "@/services/aiSignals";
import type { AiCampaignDailyPoint } from "@/services/aiCampaignSeries";
import { usePaymentAnalyticsBundle } from "@/hooks/usePaymentAnalyticsCache";
import type { PaymentAnalyticsQuery } from "@/services/paymentAnalyticsDataSource";
import type { SegmentRow } from "@/services/paymentPassAnalytics";
import type { FbAnalyticsRow } from "@/services/fbAnalytics";
import type { CohortRow } from "@/services/types";

export function aiCohortKey(row: Pick<CohortRow, "cohort_date" | "funnel" | "campaign_path">): string {
  return `${row.cohort_date}|${row.funnel}|${row.campaign_path}`;
}

function passSlicesByKey(segmentRows: readonly SegmentRow[] | undefined): Record<string, AiPassRateSlice> | null {
  if (!segmentRows?.length) return null;
  const byKey: Record<string, AiPassRateSlice> = {};
  for (const row of segmentRows) {
    byKey[row.key] = {
      attempts: row.attempts,
      successful: row.successful,
      pass_rate: row.pass_rate,
      pass_rate_ex_if: row.pass_rate_ex_if,
      first_sub_attempts: row.first_sub_attempts,
      first_sub_pass_rate: row.first_sub_pass_rate,
      renewal_attempts: row.renewal_attempts,
      renewal_pass_rate: row.renewal_pass_rate,
    };
  }
  return byKey;
}

function basePaymentQuery(dateFrom: string | null, dateTo: string | null, groupBy: "campaign_path" | "campaign_id"): PaymentAnalyticsQuery {
  return {
    dateBasis: "cohort",
    dateFrom: dateFrom || null,
    dateTo: dateTo || null,
    funnel: "all", campaignPath: "all", campaignId: "all", mediaBuyer: "all",
    country: "all", cardType: "all", stage: "all", declineReason: "all",
    transactionType: "all", outcome: "all",
    groupBy, firstTxDimension: "funnel", renewalDimension: "funnel",
  };
}

export interface UseAiCohortSignalsResult {
  output: AiEngineOutput | null;
  byCohort: ReadonlyMap<string, AiRecommendation>;
  /** Path-grain recommendations (the Funnels view's rows), keyed by campaign_path. */
  byPath: ReadonlyMap<string, AiRecommendation>;
  /** True while the pass-rate bundle is still on its way (chips already work). */
  paymentLoading: boolean;
}

export function useAiCohortSignals(params: {
  rows: readonly CohortRow[];
  enabled: boolean;
  dateFrom: string | null;
  dateTo: string | null;
  /** funnel_path -> trial_duration_days, from the page's own listFunnels load. */
  trialDurationDaysByPath: Readonly<Record<string, number | null>>;
  userScopeHash: string;
  warehouseVersion: string;
}): UseAiCohortSignalsResult {
  const { rows, enabled, dateFrom, dateTo, trialDurationDaysByPath, userScopeHash, warehouseVersion } = params;

  const paymentQuery = useMemo<PaymentAnalyticsQuery>(
    () => basePaymentQuery(dateFrom, dateTo, "campaign_path"),
    [dateFrom, dateTo],
  );

  const payment = usePaymentAnalyticsBundle({
    query: paymentQuery,
    userScopeHash,
    warehouseVersion,
    enabled: enabled && rows.length > 0,
  });

  const passRates = useMemo(() => {
    const byKey = passSlicesByKey(payment.chBundle?.segmentRows);
    return byKey ? { level: "campaign_path" as const, byKey } : null;
  }, [payment.chBundle]);

  // Stable per render-day: the engine is pure and must not observe a ticking clock.
  const asOfDate = useMemo(() => new Date().toISOString().slice(0, 10), []);

  const output = useMemo(() => {
    if (!enabled || rows.length === 0) return null;
    return computeAiSignals({
      surface: "cohort",
      cohortRows: rows,
      passRates,
      trialDurationDaysByPath,
      asOfDate,
    });
  }, [enabled, rows, passRates, trialDurationDaysByPath, asOfDate]);

  const byCohort = useMemo(() => {
    const map = new Map<string, AiRecommendation>();
    for (const rec of output?.recommendations ?? []) {
      if (rec.scope.kind !== "cohort") continue;
      map.set(`${rec.scope.cohortDate}|${rec.scope.funnel}|${rec.scope.campaignPath}`, rec);
    }
    return map;
  }, [output]);

  const byPath = useMemo(() => {
    const map = new Map<string, AiRecommendation>();
    for (const rec of output?.recommendations ?? []) {
      if (rec.scope.kind === "path") map.set(rec.scope.campaignPath, rec);
    }
    return map;
  }, [output]);

  return { output, byCohort, byPath, paymentLoading: payment.isInitialLoading };
}

export interface UseAiCampaignSignalsResult {
  output: AiEngineOutput | null;
  byCampaign: ReadonlyMap<string, AiRecommendation>;
  paymentLoading: boolean;
}

/** FB Analytics twin: campaign surface, pass rates grouped by campaign_id. */
export function useAiCampaignSignals(params: {
  rows: readonly FbAnalyticsRow[];
  enabled: boolean;
  dateFrom: string | null;
  dateTo: string | null;
  /** Daily spend/purchases per campaign_id (aiCampaignSeries) — the trend axis. */
  dailySeries?: Readonly<Record<string, readonly AiCampaignDailyPoint[]>>;
  userScopeHash: string;
  warehouseVersion: string;
}): UseAiCampaignSignalsResult {
  const { rows, enabled, dateFrom, dateTo, dailySeries, userScopeHash, warehouseVersion } = params;

  const paymentQuery = useMemo<PaymentAnalyticsQuery>(
    () => basePaymentQuery(dateFrom, dateTo, "campaign_id"),
    [dateFrom, dateTo],
  );

  const payment = usePaymentAnalyticsBundle({
    query: paymentQuery,
    userScopeHash,
    warehouseVersion,
    enabled: enabled && rows.length > 0,
  });

  const passRates = useMemo(() => {
    const byKey = passSlicesByKey(payment.chBundle?.segmentRows);
    return byKey ? { level: "campaign_id" as const, byKey } : null;
  }, [payment.chBundle]);

  const asOfDate = useMemo(() => new Date().toISOString().slice(0, 10), []);

  const output = useMemo(() => {
    if (!enabled || rows.length === 0) return null;
    return computeAiSignals({
      surface: "campaign",
      campaignRows: rows,
      campaignDailySeries: dailySeries,
      passRates,
      asOfDate,
    });
  }, [enabled, rows, dailySeries, passRates, asOfDate]);

  const byCampaign = useMemo(() => {
    const map = new Map<string, AiRecommendation>();
    for (const rec of output?.recommendations ?? []) {
      if (rec.scope.kind === "campaign") map.set(rec.scope.campaignId, rec);
    }
    return map;
  }, [output]);

  return { output, byCampaign, paymentLoading: payment.isInitialLoading };
}
