export * from "../../supabase/functions/_shared/clickhouse/fbAnalyticsCompute.ts";
import type { FbReconciliationRow } from "../../supabase/functions/_shared/clickhouse/fbAnalyticsCompute.ts";

// Dev-only guardrail: warn when FB Analytics and Cohorts disagree by more than the tolerance.
export function logFbReconciliationInDev(comparisons: FbReconciliationRow[]): void {
  if (!import.meta.env?.DEV) return;
  const mismatches = comparisons.filter((row) => row.mismatch);
  if (!mismatches.length) return;
  console.warn(
    "[FB Analytics] Totals do not reconcile with Cohorts (>0.1% diff): " +
      mismatches.map((row) => `${row.metric}: FB ${row.fbValue} vs Cohorts ${row.cohortValue} (${row.diffPct}%)`).join("; "),
  );
}
