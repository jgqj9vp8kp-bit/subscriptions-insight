// AI-signals glue for the Cohorts page: the deterministic engine runs over the
// rows the page ALREADY shows. Two auxiliary inputs load in the background and
// never block the chips:
//  - funnel passports (trial_duration_days) gate Trial→Paid maturity;
//  - one payment-analytics bundle grouped by campaign_path supplies pass rates
//    (path level — per-cohort pass rate is not tracked; the engine labels it).
// Until they arrive the engine simply reports those input families as missing.
import { useMemo } from "react";
import { computeAiSignals, type AiEngineOutput, type AiPassRateSlice, type AiRecommendation } from "@/services/aiSignals";
import { usePaymentAnalyticsBundle } from "@/hooks/usePaymentAnalyticsCache";
import type { PaymentAnalyticsQuery } from "@/services/paymentAnalyticsDataSource";
import type { CohortRow } from "@/services/types";

export function aiCohortKey(row: Pick<CohortRow, "cohort_date" | "funnel" | "campaign_path">): string {
  return `${row.cohort_date}|${row.funnel}|${row.campaign_path}`;
}

export interface UseAiCohortSignalsResult {
  output: AiEngineOutput | null;
  byCohort: ReadonlyMap<string, AiRecommendation>;
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
    () => ({
      dateBasis: "cohort",
      dateFrom: dateFrom || null,
      dateTo: dateTo || null,
      funnel: "all", campaignPath: "all", campaignId: "all", mediaBuyer: "all",
      country: "all", cardType: "all", stage: "all", declineReason: "all",
      transactionType: "all", outcome: "all",
      groupBy: "campaign_path", firstTxDimension: "funnel", renewalDimension: "funnel",
    }),
    [dateFrom, dateTo],
  );

  const payment = usePaymentAnalyticsBundle({
    query: paymentQuery,
    userScopeHash,
    warehouseVersion,
    enabled: enabled && rows.length > 0,
  });

  const passRates = useMemo(() => {
    const segmentRows = payment.chBundle?.segmentRows;
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
    return { level: "campaign_path" as const, byKey };
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

  return { output, byCohort, paymentLoading: payment.isInitialLoading };
}
