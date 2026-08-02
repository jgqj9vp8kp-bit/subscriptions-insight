// Fetch shim for Project Forecasting seeding (P3).
//
// Exactly two network calls per resolve — the window-scoped cohorts list and the
// spend ledger — then everything is pure (resolveProjectFromCohortRows +
// runResolvedProject in the shared module). Deliberately date-windowed:
// PlanMode's unfiltered full-history fetch (PlanMode.tsx:263) is the perf bug
// this module must not repeat.
import { loadCohortsFromClickHouse } from "@/services/cohortsDataSource";
import { fetchProjectSpendLedger } from "@/services/projectSpendLedger";
import type { CohortRowLike, DateWindow } from "@/services/funnelEconomics";
import type {
  FunnelSpendLedger,
  WindowSpendLedger,
} from "@/services/funnelEconomics";

export interface ProjectSeedData {
  window: DateWindow;
  rows: CohortRowLike[];
  windowLedger: WindowSpendLedger;
  funnelLedgers: Record<string, FunnelSpendLedger>;
  cohortsSource: "clickhouse";
  cohortsDurationMs: number;
}

/** Load everything a project resolve needs for one window. The cohort request
 * carries no member filters in v1 — the project scopes by funnel selection, not
 * by global filters (§24: funnel selection is scoping, not filtering). */
export async function loadProjectSeedData(window: DateWindow): Promise<ProjectSeedData> {
  const [cohorts, ledger] = await Promise.all([
    loadCohortsFromClickHouse({
      action: "list",
      date_from: window.from,
      date_to: window.to,
      filters: {
        funnel: [], campaign_path: [], campaign_id: [], traffic_source: [],
        price_plan: [], media_buyer: [], country: [], card_type: [], currency: [],
        transaction_type: [], refund_status: "all",
      },
    }),
    fetchProjectSpendLedger(window),
  ]);
  return {
    window,
    // CohortRow satisfies CohortRowLike structurally (incl. fb_spend from the
    // server's Model-1 overlay); the deriver reads only the shared fields.
    rows: cohorts.cohorts as unknown as CohortRowLike[],
    windowLedger: ledger.windowLedger,
    funnelLedgers: ledger.funnelLedgers,
    cohortsSource: "clickhouse",
    cohortsDurationMs: cohorts.durationMs,
  };
}
