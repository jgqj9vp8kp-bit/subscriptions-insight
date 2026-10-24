// Payback page queries (spec 2026-10-24 §3–§4): the clickhouse-cohorts "ltv"
// curve, one spend_ledger call per window (the display window, and lazily the
// drilldown's six trend months), and the funnel registry's display names.
//
// Keys carry the access partition like every analytics entry (plan §20), plus
// the warehouse version where the member may read it (the probe is keyed on
// its own permission list; a forecasting-only member keys on "whv_unknown" and
// relies on the 5-minute staleness instead). The "payback" root is not a
// warehouse-dependent root on purpose: its entries are not persisted to
// session storage (an ltv response holds every path's day rows for ~13 months).
// So the warehouse-invalidated event (a sync, or a snapshot rebuild that
// completed) is followed here: it refetches the payback entries too.
import { useEffect } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useOptionalAccess } from "@/hooks/useAccess";
import { GC_MS, STALE_MS, transientRetry, useCacheScope, useWarehouseVersion } from "@/hooks/useAnalyticsCache";
import { WAREHOUSE_ANALYTICS_INVALIDATED_EVENT } from "@/services/analyticsCache";
import type { CohortSnapshotHealth } from "@/services/cohortSnapshotHealth";
import { runClickHouseCohortLtv } from "@/services/clickhouse";
import { listFunnels } from "@/services/funnels";
import { fetchProjectSpendLedger, type ProjectSpendLedgerResponse } from "@/services/projectSpendLedger";
import { traceRequest } from "@/services/performanceTrace";
import { WAREHOUSE_PROBE_VIEW_PERMISSIONS } from "../../supabase/functions/_shared/access/policies/clickhouse-summary.ts";
import type { CohortLtvResponse } from "../../supabase/functions/_shared/clickhouse/cohortContract.ts";
import type { PaybackWindow } from "@/services/ltvPayback";

export const PAYBACK_QUERY_ROOT = "payback" as const;
/** The server's answer while the data owner has no validated cohort snapshot. */
export const PAYBACK_SNAPSHOT_NOT_READY = "cohort_snapshot_not_ready";

export function paybackLtvKey(partition: string, warehouseVersion: string, range: PaybackWindow) {
  return [PAYBACK_QUERY_ROOT, "ltv", partition, warehouseVersion, range.from, range.to] as const;
}

export function paybackLedgerKey(partition: string, window: PaybackWindow) {
  return [PAYBACK_QUERY_ROOT, "ledger", partition, window.from, window.to] as const;
}

export function paybackFunnelNamesKey(partition: string) {
  return [PAYBACK_QUERY_ROOT, "funnel-names", partition] as const;
}

/** ok: false from the ltv action, kept apart so the page can say "not ready yet". */
export class PaybackLtvError extends Error {
  constructor(readonly code: string) {
    super(code === PAYBACK_SNAPSHOT_NOT_READY ? "The cohort snapshot is not ready yet." : `The payback request failed (${code}).`);
    this.name = "PaybackLtvError";
  }
}

export interface PaybackQueryState<T> {
  data: T | null;
  /** First load, nothing to show yet. */
  loading: boolean;
  /** A new key is loading while the previous answer stays on screen. */
  refreshing: boolean;
  error: unknown;
  refetch: () => void;
}

/** The warehouse version where this member may read it. clickhouse-summary
 * answers only the probe keys; without one, the version is "whv_unknown" (no
 * request, no 403) and the entries simply age out after five minutes. */
export function usePaybackWarehouseVersion(): { version: string; ready: boolean } {
  const access = useOptionalAccess();
  return useWarehouseVersion(!access || access.canAny(WAREHOUSE_PROBE_VIEW_PERMISSIONS));
}

/** A stale ltv answer in the Cohorts page's freshness terms, for the shared
 * single-flight rebuild (ensureCohortSnapshotRebuild); null unless the server
 * said the snapshot is stale. */
export function paybackSnapshotHealth(ltv: Pick<CohortLtvResponse, "snapshot_stale" | "diagnostics"> | null): CohortSnapshotHealth | null {
  if (!ltv || ltv.snapshot_stale !== true) return null;
  const snapshotWarehouseVersion = ltv.diagnostics.active_snapshot_version.split(":")[0] || null;
  return {
    known: true,
    status: "stale",
    snapshotSourceTransactions: null,
    warehouseTransactions: null,
    cohortUsers: null,
    snapshotGeneratedAt: ltv.diagnostics.snapshot_generated_at,
    snapshotWarehouseVersion,
    currentWarehouseVersion: ltv.diagnostics.current_warehouse_version ?? null,
    reportComplete: false,
  };
}

/** The ltv curve for a cohort range (every path in the viewer's scope). */
export function usePaybackLtv(range: PaybackWindow | null): PaybackQueryState<CohortLtvResponse> {
  const partition = useCacheScope("");
  const { version, ready } = usePaybackWarehouseVersion();
  const client = useQueryClient();
  useEffect(() => {
    // The warehouse version in the key moves at import time, not when the
    // snapshot rebuild finishes: refetch on the rebuild's own event.
    const onInvalidated = () => void client.invalidateQueries({ queryKey: [PAYBACK_QUERY_ROOT] });
    window.addEventListener(WAREHOUSE_ANALYTICS_INVALIDATED_EVENT, onInvalidated);
    return () => window.removeEventListener(WAREHOUSE_ANALYTICS_INVALIDATED_EVENT, onInvalidated);
  }, [client]);
  const enabled = range !== null && partition !== "" && ready;
  const query = useQuery({
    queryKey: range ? paybackLtvKey(partition, version, range) : [PAYBACK_QUERY_ROOT, "ltv", "idle"],
    queryFn: () => traceRequest("payback.ltv_request", "payback:ltv", async () => {
      const response = await runClickHouseCohortLtv({ date_from: range!.from, date_to: range!.to });
      if (!response.ok) throw new PaybackLtvError(response.error || "unknown");
      return response;
    }, { edge_function: "clickhouse-cohorts" }),
    enabled,
    staleTime: STALE_MS,
    gcTime: GC_MS,
    retry: (count, error) => !(error instanceof PaybackLtvError) && transientRetry(count, error),
    refetchOnWindowFocus: false,
    // No keepPreviousData: another range's rows would be read against the new
    // window and show partial numbers until the answer arrives.
  });
  return {
    data: enabled ? (query.data ?? null) : null,
    loading: (enabled && query.isPending) || (range !== null && !ready),
    refreshing: query.isFetching && !query.isPending,
    error: query.error,
    refetch: () => void query.refetch(),
  };
}

function ledgerQuery(partition: string, window: PaybackWindow | null, enabled: boolean, slot = 0) {
  return {
    // A window-less (never enabled) slot still needs a key of its own: useQueries
    // warns on duplicates, and the trend has one slot per month.
    queryKey: window ? paybackLedgerKey(partition, window) : [PAYBACK_QUERY_ROOT, "ledger", "idle", slot],
    queryFn: () => traceRequest("payback.ledger_request", "payback:ledger", () => fetchProjectSpendLedger(window!), { edge_function: "clickhouse-facebook" }),
    enabled: enabled && window !== null && partition !== "",
    staleTime: STALE_MS,
    gcTime: GC_MS,
    retry: transientRetry,
    refetchOnWindowFocus: false,
  };
}

/** One spend_ledger call (null window: none needed). */
export function usePaybackLedger(window: PaybackWindow | null): PaybackQueryState<ProjectSpendLedgerResponse> & { settled: boolean } {
  const partition = useCacheScope("");
  const query = useQuery(ledgerQuery(partition, window, true));
  const active = window !== null && partition !== "";
  return {
    data: active ? (query.data ?? null) : null,
    loading: active && query.isPending,
    refreshing: false,
    error: query.error,
    refetch: () => void query.refetch(),
    settled: !active || query.isSuccess || query.isError,
  };
}

export interface PaybackTrendLedger {
  data: ProjectSpendLedgerResponse | null;
  loading: boolean;
  failed: boolean;
}

// Static, so useQueries keeps the combined array stable until a result changes
// (the page memoizes the trend on it).
function combineTrendLedgers(results: ReadonlyArray<{ data?: ProjectSpendLedgerResponse; isPending: boolean; isError: boolean; fetchStatus: string }>): PaybackTrendLedger[] {
  return results.map((result) => ({
    data: result.data ?? null,
    // A disabled query (closed drilldown, or a month without payments) is pending but idle.
    loading: result.isPending && result.fetchStatus !== "idle",
    failed: result.isError,
  }));
}

/** The drilldown trend: one lazy ledger call per month, only while it is open
 * (a null window — a month after the newest payment — needs none). */
export function usePaybackTrendLedgers(windows: ReadonlyArray<PaybackWindow | null>, enabled: boolean): PaybackTrendLedger[] {
  const partition = useCacheScope("");
  return useQueries({
    queries: windows.map((window, slot) => ledgerQuery(partition, window, enabled, slot)),
    combine: combineTrendLedgers,
  });
}

/** campaign path → the funnel's display name (registry; best effort, empty on failure). */
export function usePaybackFunnelNames(): ReadonlyMap<string, string> {
  const partition = useCacheScope("");
  const query = useQuery({
    queryKey: paybackFunnelNamesKey(partition),
    queryFn: async () => {
      const funnels = await listFunnels();
      const names = new Map<string, string>();
      for (const funnel of funnels) {
        if (!funnel.display_name) continue;
        for (const path of [funnel.funnel_path, ...funnel.paths.map((entry) => entry.path)]) {
          if (path && !names.has(path)) names.set(path, funnel.display_name);
        }
      }
      return names;
    },
    enabled: partition !== "",
    staleTime: STALE_MS,
    gcTime: GC_MS,
    retry: false,
    refetchOnWindowFocus: false,
  });
  return query.data ?? EMPTY_NAMES;
}

const EMPTY_NAMES: ReadonlyMap<string, string> = new Map();
