// Access policy of the export-campaign-performance Edge function — the Export
// API (plan §7 row "Export API", §10 "Other contexts", §21).
//
// This function is called by external systems with an API key
// (verify_jwt = false; GET), so it cannot go through the JWT gate. Instead:
//   1. the key is looked up by its sha256 hash, exactly as before;
//   2. the key's CREATOR is resolved with resolve_access(key.user_id) — the
//      same resolver the gate uses, so a disabled or removed member's keys stop
//      working on the next call;
//   3. decideApiKeyAccess (below) builds an "api_key" AccessContext and requires
//      status ok, funnel scope `all` (else 403 scope_not_supported) and the
//      effective permission api_export.use;
//   4. every data read uses ctx.tenantKey (the workspace data key), never
//      key.user_id.
//
// api_export.use is privileged (requiresFullScope), so in practice only
// full-scope members can hold it; the explicit scope check still runs first so a
// restricted context is always refused with scope_not_supported (Milestone A —
// creator ∩ key funnel scope in SQL is Phase 5).
//
// Pure module (no Deno, no remote imports): vitest imports it directly.

import type { FunctionPolicy, RpcResult } from "../gate.ts";
import { ACCESS_ERROR, accessDenial, ActionNormalizeError, type AccessDenial, type AccessErrorCode } from "../errors.ts";
import {
  authorizeAction,
  buildAccessContext,
  parseResolveAccessRow,
  type AccessContext,
} from "../accessContext.ts";

export type ExportCampaignPerformanceAction = "campaign_performance" | "campaign_performance_geo";

/** The key scope an Export API key must carry (api_keys.allowed_scopes). */
export const EXPORT_API_KEY_SCOPE = "campaign_performance:read";

/** Consumers call the endpoint with query parameters only; the row shape is the
 * implicit action. `?breakdown=country` (alias `geo`) is the daily
 * campaign×country partition, which also reads Facebook campaign names, so it is
 * its own action. Every other breakdown value — including none — keeps the
 * legacy campaign rows: that default is the documented contract external
 * consumers rely on (API_EXPORT.md), so it is mapped explicitly here. */
export function normalizeExportCampaignPerformanceAction(input: { method: string; url: URL }): ExportCampaignPerformanceAction {
  if (input.method.toUpperCase() !== "GET") throw new ActionNormalizeError();
  const breakdown = String(input.url.searchParams.get("breakdown") ?? "").trim().toLowerCase();
  return breakdown === "country" || breakdown === "geo" ? "campaign_performance_geo" : "campaign_performance";
}

export const EXPORT_CAMPAIGN_PERFORMANCE_POLICY: FunctionPolicy<ExportCampaignPerformanceAction> = {
  fn: "export-campaign-performance",
  methods: ["GET"],
  normalizeAction: ({ method, url }) => normalizeExportCampaignPerformanceAction({ method, url }),
  actions: {
    campaign_performance: { allOf: ["api_export.use"] },
    campaign_performance_geo: { allOf: ["api_export.use"] },
  },
};

export type ApiKeyAccessDecision = { ok: true; ctx: AccessContext } | { ok: false; denial: AccessDenial; reason: string };

const sameId = (a: unknown, b: unknown) =>
  typeof a === "string" && typeof b === "string" && a.length > 0 && a.toLowerCase() === b.toLowerCase();

/** Decides an API-key request from the creator's resolve_access result. Every
 * resolver fault is 503 (rule R2: never "allow"); the statuses map like the JWT
 * gate's (R1); the actor is the key's creator (kind "api_key"), the tenant is
 * the workspace data key (R14: never taken from the request or the key). */
export function decideApiKeyAccess(input: {
  keyUserId: string;
  resolved: RpcResult | null | undefined;
  action: ExportCampaignPerformanceAction;
  requestId: string;
}): ApiKeyAccessDecision {
  const fail = (status: number, code: AccessErrorCode, reason: string): ApiKeyAccessDecision => ({
    ok: false,
    denial: accessDenial(status, code),
    reason,
  });
  if (!input.resolved || input.resolved.error) return fail(503, ACCESS_ERROR.ACCESS_SERVICE_ERROR, "resolve_access failed");
  const row = parseResolveAccessRow(input.resolved.data);
  if (!row) return fail(503, ACCESS_ERROR.ACCESS_SERVICE_ERROR, "malformed resolve_access row");
  // A row for anyone but the key's creator is discarded (§10 step 2).
  if (!sameId(row.user_id, input.keyUserId)) return fail(503, ACCESS_ERROR.ACCESS_SERVICE_ERROR, "resolve_access user mismatch");
  if (row.status === "no_workspace") return fail(503, ACCESS_ERROR.WORKSPACE_NOT_BOOTSTRAPPED, "no workspace");
  if (row.status === "no_membership") return fail(403, ACCESS_ERROR.NO_MEMBERSHIP, "key creator is not a member");
  if (row.status === "disabled") return fail(403, ACCESS_ERROR.MEMBERSHIP_DISABLED, "key creator is disabled");

  let ctx: AccessContext;
  try {
    ctx = buildAccessContext(row, { kind: "api_key", userId: input.keyUserId, email: row.email }, input.requestId);
  } catch (error) {
    return fail(503, ACCESS_ERROR.ACCESS_SERVICE_ERROR, error instanceof Error ? error.message : "context build failed");
  }
  if (ctx.restricted) return fail(403, ACCESS_ERROR.SCOPE_NOT_SUPPORTED, "funnel-restricted key creator");
  const denial = authorizeAction(ctx, EXPORT_CAMPAIGN_PERFORMANCE_POLICY.actions[input.action]);
  if (denial) return { ok: false, denial, reason: "not authorized" };
  return { ok: true, ctx };
}
