/* global Deno */

// clickhouse-cohort-membership: the fact_user_cohorts snapshot — its state, the
// CAS-leased rebuild and the dynamic-vs-materialized validation — always for
// the workspace tenant (ctx.tenantKey), never for the caller.
//
// Access (policies/clickhouse-cohort-membership.ts): status for cohorts viewers
// (detail fields only for the data owner and warehouse operators); rebuild,
// forced rebuild and validate need admin.warehouse.manage; cron_tick is the
// freshness cron (x-cron-secret) that keeps the snapshot current for
// funnel-restricted reads — an unforced rebuild in "tick" mode whose body is
// only { ok, action, tick_status, campaign_scope }.

import { serveWithAccess } from "../_shared/clickhouse/http.ts";
import {
  CohortRebuildBusyError,
  getCohortSnapshotState,
  rebuildCohortMembership,
  validateCohortMembership,
} from "../_shared/clickhouse/cohortMembership.ts";
import { ScopeViolation } from "../_shared/clickhouse/scopedClient.ts";
import {
  CLICKHOUSE_COHORT_MEMBERSHIP_POLICY,
  CohortMembershipActionError,
  cohortMembershipErrorResponse,
  legacyMembershipAction,
  projectSnapshotStateForViewer,
  snapshotStateDetailVisible,
} from "../_shared/access/policies/clickhouse-cohort-membership.ts";

const QUERY_TIMEOUT_MS = 55_000;

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    work,
    new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error(`ClickHouse cohort membership action timed out after ${ms}ms.`)), ms)),
  ]);
}

serveWithAccess(CLICKHOUSE_COHORT_MEMBERSHIP_POLICY, async ({ ctx, action, pg, clickhouse }) => {
  const responseAction = legacyMembershipAction(action);
  try {
    if (action === "cron_tick") {
      try {
        const result = await withTimeout(
          rebuildCohortMembership({
            authUserId: ctx.tenantKey,
            supabase: pg,
            clickhouse: clickhouse(),
            force: false,
            mode: "tick",
          }),
          QUERY_TIMEOUT_MS,
        );
        return { ok: true, action: "cron_tick", tick_status: result.tick_status, campaign_scope: result.campaign_scope };
      } catch (error) {
        // Another build holds the lease: that build keeps the snapshot current.
        if (error instanceof CohortRebuildBusyError) return { ok: true, action: "cron_tick", tick_status: "in_progress" };
        throw error;
      }
    }
    if (action === "rebuild" || action === "rebuild_force") {
      const result = await withTimeout(
        rebuildCohortMembership({
          authUserId: ctx.tenantKey,
          supabase: pg,
          clickhouse: clickhouse(),
          force: action === "rebuild_force",
        }),
        QUERY_TIMEOUT_MS,
      );
      return { ok: true, action: responseAction, ...result };
    }
    if (action === "validate") {
      const result = await withTimeout(
        validateCohortMembership({ authUserId: ctx.tenantKey, supabase: pg, clickhouse: clickhouse() }),
        QUERY_TIMEOUT_MS,
      );
      return { ok: true, action: responseAction, ...result };
    }
    const state = await getCohortSnapshotState(pg, ctx.tenantKey);
    return {
      ok: true,
      action: responseAction,
      state: snapshotStateDetailVisible(ctx) ? state : projectSnapshotStateForViewer(state as Record<string, unknown> | null),
    };
  } catch (error) {
    if (error instanceof ScopeViolation) throw error;
    // Re-thrown with the action name so onError can rebuild today's 502 body.
    throw new CohortMembershipActionError(responseAction, error);
  }
}, { onError: cohortMembershipErrorResponse });
