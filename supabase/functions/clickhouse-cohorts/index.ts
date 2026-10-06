/* global Deno */

// clickhouse-cohorts: server-side Cohorts read path. Runs the parity-proven
// cohort SQL in ClickHouse for the workspace tenant (ctx.tenantKey) and returns
// only aggregated rows / totals / diagnostics — never raw payloads, transaction
// ids, SQL, or credentials.
//
// Access (policies/clickhouse-cohorts.ts): list / details / options per the
// pages that call them. Two parts of a list response are stripped, not denied,
// because the Cohorts page asks for them on every list request:
//   * fb_allocation_diagnostics — computed only with raw access or
//     admin.diagnostics.view (and the FB_COHORT_ALLOCATION_DIAGNOSTICS_ENABLED
//     flag, as before);
//   * active_user_ids / active_subscription_ids — customer emails / FunnelFox
//     ids for the data owner, keyed tokens for everyone else (the browser only
//     unions them, so every count stays exact).

import { serveWithAccess } from "../_shared/clickhouse/http.ts";
import {
  runCohortDetails,
  runCohortList,
  runCohortOptions,
} from "../_shared/clickhouse/cohorts.ts";
import {
  runMaterializedCohortList,
  runMaterializedCohortOptions,
} from "../_shared/clickhouse/cohortMembership.ts";
import type { CohortRequest } from "../_shared/clickhouse/cohortContract.ts";
import { fbAllocationDiagnosticsFeatureEnabled } from "../_shared/clickhouse/fbAllocationDiagnostics.ts";
import { createKeyedHasher, pseudonymizeActiveIdentities } from "../_shared/clickhouse/cohortSubscriptions.ts";
import {
  CLICKHOUSE_COHORTS_POLICY,
  canServeFbAllocationDiagnostics,
  cohortDetailedErrorsVisible,
  cohortIdentitiesVisible,
  cohortIdentityHashLabel,
  cohortsErrorResponse,
} from "../_shared/access/policies/clickhouse-cohorts.ts";

const QUERY_TIMEOUT_MS = 25_000;

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    work,
    new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error(`ClickHouse cohort query timed out after ${ms}ms.`)), ms)),
  ]);
}

serveWithAccess(CLICKHOUSE_COHORTS_POLICY, async ({ ctx, action, body, pg, clickhouse }) => {
  const request = body as CohortRequest;
  const authUserId = ctx.tenantKey;
  const ch = clickhouse();

  if (action === "options") {
    const materialized = await withTimeout(
      runMaterializedCohortOptions({ authUserId, supabase: pg, clickhouse: ch, request }),
      QUERY_TIMEOUT_MS,
    );
    if (materialized) return materialized;
    return await withTimeout(runCohortOptions({ authUserId, clickhouse: ch, request }), QUERY_TIMEOUT_MS);
  }
  if (action === "details") {
    return await withTimeout(
      runCohortDetails({ authUserId, clickhouse: ch, request, detailedErrors: cohortDetailedErrorsVisible(ctx) }),
      QUERY_TIMEOUT_MS,
    );
  }

  // list / list_fb_allocation_diagnostics
  const materialized = await withTimeout(
    runMaterializedCohortList({
      authUserId,
      supabase: pg,
      clickhouse: ch,
      request,
      allocationDiagnosticsEnabled: fbAllocationDiagnosticsFeatureEnabled(
        Deno.env.get("FB_COHORT_ALLOCATION_DIAGNOSTICS_ENABLED"),
      ) && canServeFbAllocationDiagnostics(ctx),
    }),
    QUERY_TIMEOUT_MS,
  );
  const result = materialized ?? await withTimeout(runCohortList({ authUserId, clickhouse: ch, request, supabase: pg }), QUERY_TIMEOUT_MS);
  if (!cohortIdentitiesVisible(ctx)) {
    // The service-role key never leaves the isolate; it only keys the HMAC.
    const hasher = await createKeyedHasher(Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", cohortIdentityHashLabel(authUserId));
    await pseudonymizeActiveIdentities(result.rows, hasher);
  }
  return result;
}, {
  // Validation errors are client faults (400); everything else is a warehouse
  // fault (502). The gate sanitizes both for anyone but the data owner.
  onError: cohortsErrorResponse,
});
