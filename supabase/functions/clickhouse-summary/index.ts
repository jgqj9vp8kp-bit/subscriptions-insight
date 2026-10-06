/* global Deno */

// clickhouse-summary: the warehouse probe. The browser fingerprints its cache
// versions from the state rows in this response, and the data owner's
// Integrations panel shows the tenant KPI aggregate.
//
// Access (policies/clickhouse-summary.ts): any member who can open a page that
// runs the probe. With raw access or admin.diagnostics.view the body is exactly
// today's (KPIs + states, and the 200 { connected: false, error } shape when
// ClickHouse fails); everyone else gets the version-only member view and no
// KPI query runs on their behalf.

import { serveWithAccess } from "../_shared/clickhouse/http.ts";
import {
  getClickHouseSummary,
  getCohortSnapshotStateRow,
  getSupportSyncState,
  getTransactionSyncState,
  memberWarehouseSummary,
} from "../_shared/clickhouse/summary.ts";
import { createKeyedHasher } from "../_shared/clickhouse/cohortSubscriptions.ts";
import { ScopeViolation } from "../_shared/clickhouse/scopedClient.ts";
import {
  CLICKHOUSE_SUMMARY_POLICY,
  summaryKpisVisible,
  summaryVersionHashLabel,
} from "../_shared/access/policies/clickhouse-summary.ts";

/** Best-effort state read: null on an ordinary error, a ScopeViolation propagates. */
function orNull(error: unknown): null {
  if (error instanceof ScopeViolation) throw error;
  return null;
}

serveWithAccess(CLICKHOUSE_SUMMARY_POLICY, async ({ ctx, pg, clickhouse }) => {
  const tenantKey = ctx.tenantKey;

  if (!summaryKpisVisible(ctx)) {
    const [syncState, cohortSnapshotState, supportSyncState] = await Promise.all([
      getTransactionSyncState(pg, tenantKey).catch(orNull),
      getCohortSnapshotStateRow(pg, tenantKey).catch(orNull),
      getSupportSyncState(pg, tenantKey).catch(orNull),
    ]);
    // The service-role key never leaves the isolate; it only keys the HMAC that
    // makes the version tokens opaque (summary.ts "Member view").
    const hasher = await createKeyedHasher(Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", summaryVersionHashLabel(tenantKey));
    return memberWarehouseSummary({ hasher, syncState, cohortSnapshotState, supportSyncState });
  }

  try {
    const [summary, syncState, cohortSnapshotState, supportSyncState] = await Promise.all([
      getClickHouseSummary({ authUserId: tenantKey, supabase: pg, clickhouse: clickhouse() }),
      getTransactionSyncState(pg, tenantKey),
      getCohortSnapshotStateRow(pg, tenantKey),
      getSupportSyncState(pg, tenantKey),
    ]);
    return { ...summary, sync_state: syncState, cohort_snapshot_state: cohortSnapshotState, support_sync_state: supportSyncState };
  } catch (error) {
    if (error instanceof ScopeViolation) throw error;
    return {
      connected: false,
      error: error instanceof Error ? error.message : "Could not load ClickHouse summary.",
      sync_state: await getTransactionSyncState(pg, tenantKey).catch(orNull),
      cohort_snapshot_state: await getCohortSnapshotStateRow(pg, tenantKey).catch(orNull),
      support_sync_state: await getSupportSyncState(pg, tenantKey).catch(orNull),
    };
  }
});
