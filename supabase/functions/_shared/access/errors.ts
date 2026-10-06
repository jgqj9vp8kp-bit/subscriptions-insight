// Access-gate error codes (plan §27 fail-closed rules). Every denial the gate
// produces has the shape { ok: false, error_code, error } so the browser can
// branch on the code instead of parsing prose.
//
// NEVER use the word "unavailable" (or other transport words such as
// "timeout", "network error", "connection ...") in a code or a message: the
// frontend circuit breaker (src/services/clickhouse.ts isWarehouseDownError)
// pattern-matches those words and would open the 45 s breaker on an access
// denial. src/test/accessGate.test.ts asserts this over every entry below.

export const ACCESS_ERROR = {
  METHOD_NOT_ALLOWED: "method_not_allowed",
  SERVER_NOT_CONFIGURED: "server_not_configured",
  INVALID_SESSION: "invalid_session",
  AUTH_SERVICE_ERROR: "auth_service_error",
  INVALID_BODY: "invalid_body",
  UNKNOWN_ACTION: "unknown_action",
  POLICY_MISSING: "policy_missing",
  ACCESS_SERVICE_ERROR: "access_service_error",
  WORKSPACE_NOT_BOOTSTRAPPED: "workspace_not_bootstrapped",
  NO_MEMBERSHIP: "no_membership",
  MEMBERSHIP_DISABLED: "membership_disabled",
  PERMISSION_DENIED: "permission_denied",
  RAW_ACCESS_REQUIRED: "raw_access_required",
  OWNER_REQUIRED: "owner_required",
  FULL_SCOPE_REQUIRED: "full_scope_required",
  SCOPE_NOT_SUPPORTED: "scope_not_supported",
  /** 409: a funnel-restricted read needs a fresh, validated cohort snapshot (Phase 2). */
  SCOPE_SNAPSHOT_NOT_READY: "scope_snapshot_not_ready",
  /** 403: an explicit cohort_key / funnel_key names a funnel outside the member's scope (R11). */
  FUNNEL_OUT_OF_SCOPE: "funnel_out_of_scope",
  SCOPE_VIOLATION: "scope_violation",
  CRON_NOT_CONFIGURED: "cron_not_configured",
  INVALID_CRON_SECRET: "invalid_cron_secret",
  TENANT_MISMATCH: "tenant_mismatch",
  CRON_ACTION_NOT_ALLOWED: "cron_action_not_allowed",
  UPSTREAM_ERROR: "upstream_error",
  REQUEST_FAILED: "request_failed",
} as const;

export type AccessErrorCode = (typeof ACCESS_ERROR)[keyof typeof ACCESS_ERROR];

export const ACCESS_ERROR_MESSAGES: Readonly<Record<AccessErrorCode, string>> = Object.freeze({
  method_not_allowed: "Method not allowed.",
  server_not_configured: "Server authentication is not configured.",
  invalid_session: "Invalid or expired session.",
  auth_service_error: "Could not verify the session with the authentication service. Please retry.",
  invalid_body: "Invalid JSON request body.",
  unknown_action: "Unsupported action.",
  policy_missing: "This action has no access policy.",
  access_service_error: "Could not resolve access for this account. Please retry.",
  workspace_not_bootstrapped: "The workspace has not been set up yet.",
  no_membership: "This account is not a member of the workspace.",
  membership_disabled: "This account's workspace membership is disabled.",
  permission_denied: "You do not have permission for this action.",
  raw_access_required: "Only the data owner can use this action.",
  owner_required: "Only the workspace Owner can use this action.",
  full_scope_required: "This action requires access to all funnels.",
  scope_not_supported: "This action is not yet enabled for funnel-restricted access.",
  scope_snapshot_not_ready: "Funnel-scoped data is being prepared. Please retry in a few minutes.",
  funnel_out_of_scope: "This funnel is outside your funnel access.",
  scope_violation: "Request failed.",
  cron_not_configured: "Scheduled-job authentication is not configured.",
  invalid_cron_secret: "Invalid cron secret.",
  tenant_mismatch: "The request names a different workspace tenant.",
  cron_action_not_allowed: "This action cannot be run by a scheduled job.",
  upstream_error: "Request failed.",
  request_failed: "Request failed.",
});

export interface AccessDenial {
  status: number;
  error_code: AccessErrorCode;
  error: string;
}

export function accessDenial(status: number, code: AccessErrorCode, error: string = ACCESS_ERROR_MESSAGES[code]): AccessDenial {
  return { status, error_code: code, error };
}

/** Thrown by a FunctionPolicy.normalizeAction for anything it does not map to a
 * known action. The gate turns it into 400 unknown_action (rule R3: no
 * "default to bundle" fall-throughs). */
export class ActionNormalizeError extends Error {
  constructor(message = ACCESS_ERROR_MESSAGES.unknown_action) {
    super(message);
    this.name = "ActionNormalizeError";
  }
}
