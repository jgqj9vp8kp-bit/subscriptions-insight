/* global Deno */

// clickhouse-support: server-side Support Analytics read path and Supabase-to-
// ClickHouse synchronization. The browser never runs analytics SQL,
// classification, grouping, or statistics; it only receives aggregate bundles,
// paged rows, and one opened request detail — always of the workspace data
// (ctx.tenantKey), never of the caller.
//
// Access is decided by CLICKHOUSE_SUPPORT_POLICY before the handler runs
// (support.view for aggregates, support.messages.view for rows / bodies / any
// search, support.export for the export, admin.sync.run for the sync; funnel-
// restricted members are refused). The status diagnostics are stripped for
// readers without raw access or admin.sync.run.

import { serveWithAccess } from "../_shared/clickhouse/http.ts";
import {
  CLICKHOUSE_SUPPORT_POLICY,
  projectSupportStatusForViewer,
  supportReadOf,
  supportStatusDetailVisible,
} from "../_shared/access/policies/clickhouse-support.ts";
import {
  clickHouseSupportErrorResponse,
  normalizeSupportRequest,
  runSupportBundle,
  runSupportDetails,
  runSupportExport,
  runSupportList,
  runSupportOptions,
  runSupportStatus,
  runSupportSync,
  runSupportUnansweredContacts,
} from "../_shared/clickhouse/support.ts";
import type { SupportRequest } from "../_shared/clickhouse/supportContract.ts";

const QUERY_TIMEOUT_MS = 55_000;

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    work,
    new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error(`ClickHouse support request timed out after ${ms}ms.`)), ms)),
  ]);
}

serveWithAccess(
  CLICKHOUSE_SUPPORT_POLICY,
  async ({ ctx, action, body, pg, clickhouse }) => {
    const request = body as SupportRequest;
    // Same request validation as before access control (dates, sort, filters):
    // a malformed request is a 400 (SupportRequestError) for every action.
    normalizeSupportRequest(request);
    const common = { authUserId: ctx.tenantKey, clickhouse: clickhouse() };
    // Dispatch on the AUTHORIZED action (search variants run their base read);
    // every branch is explicit — there is no fallthrough to the bundle.
    const read = supportReadOf(action);
    if (read === "sync") return await withTimeout(runSupportSync({ ...common, supabase: pg, request }), QUERY_TIMEOUT_MS);
    if (read === "status") {
      const status = await withTimeout(runSupportStatus({ ...common, supabase: pg }), QUERY_TIMEOUT_MS);
      return supportStatusDetailVisible(ctx) ? status : projectSupportStatusForViewer(status);
    }
    if (read === "options") return await withTimeout(runSupportOptions(common), QUERY_TIMEOUT_MS);
    if (read === "list") return await withTimeout(runSupportList({ ...common, request }), QUERY_TIMEOUT_MS);
    if (read === "details") return await withTimeout(runSupportDetails({ ...common, request }), QUERY_TIMEOUT_MS);
    if (read === "export") return await withTimeout(runSupportExport({ ...common, request }), QUERY_TIMEOUT_MS);
    if (read === "unanswered_contacts") return await withTimeout(runSupportUnansweredContacts({ ...common, request }), QUERY_TIMEOUT_MS);
    if (read === "bundle") return await withTimeout(runSupportBundle({ ...common, supabase: pg, request }), QUERY_TIMEOUT_MS);
    throw new Error(`Unhandled support action: ${action}`);
  },
  // Same status / body as before access control; the gate sanitizes the body
  // for everyone but the data owner.
  { onError: (error) => clickHouseSupportErrorResponse(error) },
);
