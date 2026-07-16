// Forensic-audit regression tests for Cohorts snapshot freshness:
// a snapshot built on an older warehouse version must render as STALE (never
// "complete"), diagnostics must come from ONE response bundle, and a stale
// observation triggers exactly one background rebuild.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deriveCohortSnapshotHealth,
  ensureCohortSnapshotRebuild,
  resetCohortSnapshotAutoRebuildForTests,
  staleSnapshotRebuildKey,
  type CohortSnapshotHealth,
} from "@/services/cohortSnapshotHealth";
import type { CohortResponse } from "../../supabase/functions/_shared/clickhouse/cohortContract";

const FILTERS_APPLIED = {
  date_range: false, funnel: false, campaign_path: false, refund_status: false,
  media_buyer: false, currency: false, country: false, card_type: false,
  campaign_id: false, traffic_source: false, price_plan: false,
};

function snapshotDiagnostics(overrides: Partial<CohortResponse["diagnostics"]> = {}): CohortResponse["diagnostics"] {
  return {
    transactions_scanned: 28_885,
    users_scanned: 10_031,
    missing_identity: 0,
    missing_fx: 0,
    unknown_products: 0,
    subscription_data_status: "empty_source",
    filters_applied: FILTERS_APPLIED,
    active_snapshot_version: "wh_old:cohort_classifier_v1_dynamic_sql",
    source_warehouse_version: "wh_old",
    snapshot_generated_at: "2026-07-13T16:14:21.517Z",
    source_transactions: 28_885,
    cohort_users: 7_145,
    ...overrides,
  };
}

const fx = (total: number) => ({ transactions_total: total });

describe("deriveCohortSnapshotHealth — one version per report bundle", () => {
  it("new Edge contract: server-computed snapshot_stale=false → current + report complete", () => {
    const health = deriveCohortSnapshotHealth(
      snapshotDiagnostics({
        snapshot_stale: false,
        report_complete: true,
        snapshot_status: "current",
        snapshot_complete: true,
        source_transactions: 29_479,
        current_warehouse_version: "wh_old",
        current_warehouse_transactions: 29_479,
      }),
      fx(29_479),
      { mediaBuyerFilterActive: false },
    );
    expect(health.status).toBe("current");
    expect(health.reportComplete).toBe(true);
    expect(health.warehouseTransactions).toBe(29_479);
    expect(health.snapshotSourceTransactions).toBe(29_479);
  });

  it("new Edge contract: snapshot_stale=true is NEVER rendered as complete (report_complete=false)", () => {
    const health = deriveCohortSnapshotHealth(
      snapshotDiagnostics({
        snapshot_stale: true,
        report_complete: false,
        snapshot_status: "stale",
        snapshot_complete: false,
        current_warehouse_version: "wh_new",
        current_warehouse_transactions: 29_479,
      }),
      fx(29_479),
      { mediaBuyerFilterActive: false },
    );
    expect(health.status).toBe("stale");
    expect(health.reportComplete).toBe(false);
    expect(health.snapshotSourceTransactions).toBe(28_885);
    expect(health.warehouseTransactions).toBe(29_479);
  });

  it("report_complete=true from the server is still rejected when snapshot_stale=true (version mismatch wins)", () => {
    const health = deriveCohortSnapshotHealth(
      snapshotDiagnostics({ snapshot_stale: true, report_complete: true }),
      fx(29_479),
      { mediaBuyerFilterActive: false },
    );
    expect(health.status).toBe("stale");
    expect(health.reportComplete).toBe(false);
  });

  it("old Edge contract (production bug): FX 29,479 vs source rows 28,885 in ONE bundle → stale, not complete", () => {
    const health = deriveCohortSnapshotHealth(snapshotDiagnostics(), fx(29_479), { mediaBuyerFilterActive: false });
    expect(health.status).toBe("stale");
    expect(health.reportComplete).toBe(false);
    expect(health.warehouseTransactions).toBe(29_479);
    expect(health.snapshotSourceTransactions).toBe(28_885);
  });

  it("old Edge contract: equal counts → current", () => {
    const health = deriveCohortSnapshotHealth(
      snapshotDiagnostics({ source_transactions: 29_479 }),
      fx(29_479),
      { mediaBuyerFilterActive: false },
    );
    expect(health.status).toBe("current");
    expect(health.reportComplete).toBe(true);
  });

  it("old Edge contract: media_buyer filter scopes FX totals → freshness is unknown, never guessed", () => {
    const health = deriveCohortSnapshotHealth(snapshotDiagnostics(), fx(1_234), { mediaBuyerFilterActive: true });
    expect(health.status).toBe("unknown");
    expect(health.reportComplete).toBe(false);
  });

  it("dynamic (non-materialized) response without snapshot metadata → known=false", () => {
    const health = deriveCohortSnapshotHealth(
      {
        transactions_scanned: 29_479,
        users_scanned: 10_242,
        missing_identity: 0,
        missing_fx: 0,
        unknown_products: 0,
        subscription_data_status: "empty_source",
        filters_applied: FILTERS_APPLIED,
      },
      fx(29_479),
      { mediaBuyerFilterActive: false },
    );
    expect(health.known).toBe(false);
    expect(health.status).toBe("unknown");
  });

  it("missing diagnostics → known=false, report incomplete", () => {
    const health = deriveCohortSnapshotHealth(undefined, undefined, { mediaBuyerFilterActive: false });
    expect(health.known).toBe(false);
    expect(health.reportComplete).toBe(false);
  });
});

describe("ensureCohortSnapshotRebuild — one rebuild per staleness observation", () => {
  const staleHealth = (): CohortSnapshotHealth =>
    deriveCohortSnapshotHealth(snapshotDiagnostics(), fx(29_479), { mediaBuyerFilterActive: false });

  beforeEach(() => resetCohortSnapshotAutoRebuildForTests());
  afterEach(() => resetCohortSnapshotAutoRebuildForTests());

  it("triggers exactly once for the same observation (re-renders do not stack rebuilds)", async () => {
    const rebuild = vi.fn().mockResolvedValue({ status: "completed", users_classified: 7_356, duration_ms: 5000 });
    expect(ensureCohortSnapshotRebuild(staleHealth(), rebuild)).toBe("started");
    expect(ensureCohortSnapshotRebuild(staleHealth(), rebuild)).toBe("skipped");
    await vi.waitFor(() => expect(rebuild).toHaveBeenCalledTimes(1));
    expect(ensureCohortSnapshotRebuild(staleHealth(), rebuild)).toBe("skipped");
    expect(rebuild).toHaveBeenCalledTimes(1);
  });

  it("a NEW staleness observation (new warehouse state) triggers a new rebuild", async () => {
    const rebuild = vi.fn().mockResolvedValue({ status: "completed" });
    expect(ensureCohortSnapshotRebuild(staleHealth(), rebuild)).toBe("started");
    await vi.waitFor(() => expect(rebuild).toHaveBeenCalledTimes(1));
    const next = deriveCohortSnapshotHealth(snapshotDiagnostics(), fx(30_001), { mediaBuyerFilterActive: false });
    expect(staleSnapshotRebuildKey(next)).not.toBe(staleSnapshotRebuildKey(staleHealth()));
    // Retry until the first rebuild's in-flight guard clears, then the new key starts.
    await vi.waitFor(() => expect(ensureCohortSnapshotRebuild(next, rebuild)).toBe("started"));
    await vi.waitFor(() => expect(rebuild).toHaveBeenCalledTimes(2));
  });

  it("never triggers for current or unknown snapshots", () => {
    const rebuild = vi.fn();
    const current = deriveCohortSnapshotHealth(snapshotDiagnostics({ source_transactions: 29_479 }), fx(29_479), { mediaBuyerFilterActive: false });
    const unknown = deriveCohortSnapshotHealth(snapshotDiagnostics(), fx(1), { mediaBuyerFilterActive: true });
    expect(ensureCohortSnapshotRebuild(current, rebuild)).toBe("skipped");
    expect(ensureCohortSnapshotRebuild(unknown, rebuild)).toBe("skipped");
    expect(rebuild).not.toHaveBeenCalled();
  });

  it("a failing rebuild is swallowed (page keeps serving the old snapshot) and not re-attempted for the same key", async () => {
    const rebuild = vi.fn().mockRejectedValue(new Error("edge down"));
    expect(ensureCohortSnapshotRebuild(staleHealth(), rebuild)).toBe("started");
    await vi.waitFor(() => expect(rebuild).toHaveBeenCalledTimes(1));
    expect(ensureCohortSnapshotRebuild(staleHealth(), rebuild)).toBe("skipped");
  });
});

describe("atomic report bundle", () => {
  it("loadCohortsFromClickHouse maps rows, totals, diagnostics and FX from ONE response object", async () => {
    vi.resetModules();
    const response = {
      ok: true,
      source: "clickhouse",
      generated_at: "2026-07-14T12:00:00.000Z",
      query_duration_ms: 42,
      rows: [],
      totals: {},
      filter_options: {},
      fx_diagnostics: fx(29_479),
      token_diagnostics: {
        token_purchases_total: 1, token_purchases_matched: 1, token_purchases_matched_by_email: 0,
        token_purchases_unmatched: 0, token_unmatched_amount: 0, unknown_products: [], unknown_addon_revenue: 0,
      },
      diagnostics: snapshotDiagnostics(),
    };
    vi.doMock("@/services/clickhouse", () => ({
      runClickHouseCohorts: vi.fn().mockResolvedValue(response),
      runClickHouseCohortDetails: vi.fn(),
    }));
    const { loadCohortsFromClickHouse } = await import("@/services/cohortsDataSource");
    const bundle = await loadCohortsFromClickHouse({ action: "list" });
    // Same response object end-to-end: no field may come from another fetch/cache.
    expect(bundle.diagnostics).toBe(response.diagnostics);
    expect(bundle.fxDiagnostics).toBe(response.fx_diagnostics);
    expect(bundle.durationMs).toBe(42);
    vi.doUnmock("@/services/clickhouse");
    vi.resetModules();
  });
});
