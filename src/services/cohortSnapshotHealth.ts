// Cohort snapshot freshness, derived from ONE clickhouse-cohorts response bundle.
//
// Root cause this guards against: the materialized Cohorts response used to mix
// build-time snapshot metadata ("source rows", "cohort users") with LIVE FX
// warehouse counts and a hardcoded `snapshot_complete: true`, so a snapshot built
// on 28,885 rows rendered as "complete" next to an FX panel counting 29,479.
// Everything here reads a single response object — never two cached queries.

import { rebuildClickHouseCohortMembership } from "@/services/clickhouse";
import { traceEvent } from "@/services/performanceTrace";
import type { CohortResponse } from "../../supabase/functions/_shared/clickhouse/cohortContract";

/** Structural subset of CohortFxDiagnostics / FxNormalizationDiagnostics this module needs. */
export interface FxTotalsLike {
  transactions_total?: number | null;
}

export type CohortSnapshotFreshness = "current" | "stale" | "unknown";

export interface CohortSnapshotHealth {
  /** True when the response came from the materialized snapshot path (metadata present). */
  known: boolean;
  status: CohortSnapshotFreshness;
  /** Transactions the snapshot was built on (build-time). */
  snapshotSourceTransactions: number | null;
  /** Live warehouse transactions from the SAME response (fingerprint, or FX total fallback). */
  warehouseTransactions: number | null;
  cohortUsers: number | null;
  snapshotGeneratedAt: string | null;
  /** Snapshot warehouse version vs the version current at response time. */
  snapshotWarehouseVersion: string | null;
  currentWarehouseVersion: string | null;
  /** True only when every section of the bundle describes one warehouse version. */
  reportComplete: boolean;
}

/**
 * Derive snapshot freshness from one response bundle.
 *
 * Preferred signal: the server's own fingerprint comparison (`snapshot_stale`,
 * new Edge build). Fallback for the currently deployed Edge build: compare the
 * bundle's build-time `source_transactions` against the bundle's live FX
 * `transactions_total` — a count mismatch proves staleness. The fallback is
 * skipped when a media_buyer filter is active (FX totals are then scoped to the
 * filter, not the warehouse) — freshness is reported as unknown, never guessed.
 */
export function deriveCohortSnapshotHealth(
  diagnostics: CohortResponse["diagnostics"] | undefined,
  fxDiagnostics: FxTotalsLike | undefined,
  opts: { mediaBuyerFilterActive: boolean },
): CohortSnapshotHealth {
  const snapshotMetadataPresent = Boolean(
    diagnostics && (diagnostics.active_snapshot_version != null || diagnostics.source_transactions != null),
  );
  if (!diagnostics || !snapshotMetadataPresent) {
    return {
      known: false,
      status: "unknown",
      snapshotSourceTransactions: null,
      warehouseTransactions: null,
      cohortUsers: null,
      snapshotGeneratedAt: null,
      snapshotWarehouseVersion: null,
      currentWarehouseVersion: null,
      reportComplete: false,
    };
  }

  const snapshotSourceTransactions = diagnostics.source_transactions ?? null;
  const cohortUsers = diagnostics.cohort_users ?? null;
  const snapshotGeneratedAt = diagnostics.snapshot_generated_at ?? null;
  const snapshotWarehouseVersion = diagnostics.source_warehouse_version ?? null;
  const currentWarehouseVersion = diagnostics.current_warehouse_version ?? null;

  // New Edge build: the server compared warehouse fingerprints in-request.
  if (typeof diagnostics.snapshot_stale === "boolean") {
    const status: CohortSnapshotFreshness = diagnostics.snapshot_stale ? "stale" : "current";
    return {
      known: true,
      status,
      snapshotSourceTransactions,
      warehouseTransactions: diagnostics.current_warehouse_transactions ?? null,
      cohortUsers,
      snapshotGeneratedAt,
      snapshotWarehouseVersion,
      currentWarehouseVersion,
      reportComplete: diagnostics.report_complete === true && !diagnostics.snapshot_stale,
    };
  }

  // Old Edge build fallback: FX totals in the SAME bundle count the live
  // warehouse. A count mismatch proves the snapshot predates the warehouse.
  // Count equality does NOT prove currency, so it is only "current" as far as
  // this bundle can honestly tell — the server-side fingerprint is authoritative.
  const fxTotal = fxDiagnostics?.transactions_total;
  if (typeof fxTotal === "number" && !opts.mediaBuyerFilterActive && snapshotSourceTransactions != null) {
    const stale = fxTotal !== snapshotSourceTransactions;
    return {
      known: true,
      status: stale ? "stale" : "current",
      snapshotSourceTransactions,
      warehouseTransactions: fxTotal,
      cohortUsers,
      snapshotGeneratedAt,
      snapshotWarehouseVersion,
      currentWarehouseVersion,
      reportComplete: !stale,
    };
  }

  return {
    known: true,
    status: "unknown",
    snapshotSourceTransactions,
    warehouseTransactions: null,
    cohortUsers,
    snapshotGeneratedAt,
    snapshotWarehouseVersion,
    currentWarehouseVersion,
    reportComplete: false,
  };
}

// ---- Automatic rebuild of a stale snapshot ---------------------------------
// One attempt per distinct staleness observation (snapshot version -> warehouse
// state), single-flight across the tab. rebuildClickHouseCohortMembership skips
// server-side when the snapshot is already current (force=false) and dispatches
// WAREHOUSE_ANALYTICS_INVALIDATED_EVENT on completion, which re-keys and
// refetches every warehouse-dependent page (see AnalyticsCacheGate).

type RebuildRunner = typeof rebuildClickHouseCohortMembership;

const attemptedRebuildKeys = new Set<string>();
let rebuildInFlight: Promise<void> | null = null;

/** Key of one staleness observation; a new sync or snapshot produces a new key. */
export function staleSnapshotRebuildKey(health: CohortSnapshotHealth): string | null {
  if (health.status !== "stale") return null;
  return [
    health.snapshotWarehouseVersion ?? "",
    health.currentWarehouseVersion ?? "",
    health.snapshotSourceTransactions ?? "",
    health.warehouseTransactions ?? "",
  ].join("→");
}

/** Test-only: reset the single-flight bookkeeping. */
export function resetCohortSnapshotAutoRebuildForTests(): void {
  attemptedRebuildKeys.clear();
  rebuildInFlight = null;
}

/**
 * Trigger a background snapshot rebuild for a stale observation, at most once
 * per key and never concurrently. Returns "started" when a rebuild was kicked
 * off, "skipped" otherwise. Never throws.
 */
export function ensureCohortSnapshotRebuild(
  health: CohortSnapshotHealth,
  rebuild: RebuildRunner = rebuildClickHouseCohortMembership,
): "started" | "skipped" {
  const key = staleSnapshotRebuildKey(health);
  if (!key || attemptedRebuildKeys.has(key) || rebuildInFlight) return "skipped";
  attemptedRebuildKeys.add(key);
  traceEvent("cohorts.snapshot_auto_rebuild_started", {
    snapshot_rows: health.snapshotSourceTransactions ?? 0,
    warehouse_rows: health.warehouseTransactions ?? 0,
  });
  rebuildInFlight = rebuild(false)
    .then((result) => {
      traceEvent("cohorts.snapshot_auto_rebuild_completed", {
        status: result.status ?? "unknown",
        users_classified: result.users_classified ?? 0,
        duration_ms: result.duration_ms ?? 0,
      });
    })
    .catch((error) => {
      traceEvent("cohorts.snapshot_auto_rebuild_failed", {
        error_class: error instanceof Error ? error.name : typeof error,
      });
    })
    .finally(() => {
      rebuildInFlight = null;
    });
  return "started";
}
