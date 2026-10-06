// capsuled-facebook-sync access policy (plan §7 row "Capsuled / FunnelFox syncs").
//
// The function has ONE action: pull a Capsuled fb-stats window, store it under
// the workspace tenant (capsuled_facebook_syncs / capsuled_facebook_stats and the
// facebook_traffic snapshot) and echo what it imported. That is a sync trigger →
// admin.sync.run (the FB Analytics and Integrations "Capsuled sync" buttons).
// Before access control any signed-in account could call it and got its OWN
// private copy of the deployment-wide upstream data (G1); rows now always land
// under ctx.tenantKey.
//
// There is no status / read action: both pages read the latest sync row and the
// stored stats through PostgREST. The sync response echoes upstream payloads
// (rows[].raw_payload, lastApiResponse); those are stripped for everyone but the
// data owner.
//
// The browser POSTs { dateFrom, dateTo, level, force? } WITHOUT an action — that
// body IS the sync (the one default the function relies on), and GET with the
// same query parameters keeps working. Any other named action is a 400. Not
// scopeReady: funnel-restricted members get 403 (and admin.sync.run needs funnel
// scope `all` anyway). Pure module: vitest imports it.

import type { FunctionPolicy, NormalizeActionInput } from "../gate.ts";
import type { AccessContext } from "../accessContext.ts";
import { ActionNormalizeError } from "../errors.ts";

export type CapsuledFacebookSyncAction = "sync";

export function normalizeCapsuledFacebookSyncAction({ method, body }: NormalizeActionInput): CapsuledFacebookSyncAction {
  // GET carries its parameters in the query string and never had an action.
  if (method.toUpperCase() === "GET") return "sync";
  if (body.action === undefined || body.action === null || body.action === "sync") return "sync";
  throw new ActionNormalizeError();
}

export const CAPSULED_FACEBOOK_SYNC_POLICY: FunctionPolicy<CapsuledFacebookSyncAction> = {
  fn: "capsuled-facebook-sync",
  methods: ["GET", "POST"],
  normalizeAction: normalizeCapsuledFacebookSyncAction,
  actions: {
    sync: { allOf: ["admin.sync.run"], write: true },
  },
};

/** Upstream payloads in the sync response: the data owner only. */
export function capsuledRawPayloadsVisible(ctx: Pick<AccessContext, "rawAccess">): boolean {
  return ctx.rawAccess;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** The sync response for a caller without raw access: every row keeps its
 * metrics but loses raw_payload (the verbatim Capsuled row), and the echoed
 * upstream response text (metadata / diagnostics lastApiResponse) is nulled.
 * Shapes are unchanged, so the pages' diagnostics keep working. */
export function stripCapsuledSyncRawPayloads<T extends Record<string, unknown>>(result: T): T {
  const stripped: Record<string, unknown> = { ...result };
  if (Array.isArray(result.rows)) {
    stripped.rows = result.rows.map((row) => (isRecord(row) ? { ...row, raw_payload: null } : row));
  }
  for (const key of ["metadata", "diagnostics"] as const) {
    const section = result[key];
    if (isRecord(section) && Object.prototype.hasOwnProperty.call(section, "lastApiResponse")) {
      stripped[key] = { ...section, lastApiResponse: null };
    }
  }
  return stripped as T;
}

/** A failed sync carrying the status and body the function has always returned
 * (onError reproduces it; the gate sanitizes it for anyone but the data owner). */
export class CapsuledSyncError extends Error {
  readonly status: number;
  readonly body: Record<string, unknown>;

  constructor(status: number, body: Record<string, unknown>) {
    super(typeof body.error === "string" && body.error ? body.error : "Capsuled sync failed.");
    this.name = "CapsuledSyncError";
    this.status = status;
    this.body = body;
  }
}

export function capsuledFacebookSyncErrorResponse(error: unknown): { status: number; body: Record<string, unknown> } | null {
  if (!(error instanceof CapsuledSyncError)) return null;
  return { status: error.status, body: { ...error.body } };
}
