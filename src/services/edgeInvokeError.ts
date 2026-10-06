// Reads the access gate's typed refusal out of a supabase.functions.invoke
// error (plan §14 "Typed errors"). The AI transports (aiAssistantClient,
// reportAi) map a refusal to their calm "unavailable" state instead of the loud
// transport-error state; every other failure keeps its message.

/** 403 codes meaning "this principal may not use the feature right now". */
const UNAVAILABLE_CODES: ReadonlySet<string> = new Set([
  "permission_denied",
  "scope_not_supported",
  "raw_access_required",
  "owner_required",
  "full_scope_required",
  "no_membership",
  "membership_disabled",
]);

export interface EdgeInvokeRefusal {
  status: number;
  errorCode: string | null;
  message: string | null;
}

/** The HTTP status / error_code / error text of a failed invoke, or null when no
 * HTTP response came back (network, CORS, not deployed). */
export async function readEdgeInvokeRefusal(error: unknown): Promise<EdgeInvokeRefusal | null> {
  const context = (error as { context?: unknown } | null)?.context;
  if (!(context instanceof Response)) return null;
  let errorCode: string | null = null;
  let message: string | null = null;
  try {
    const body = (await context.clone().json()) as { error_code?: unknown; error?: unknown };
    errorCode = typeof body?.error_code === "string" ? body.error_code : null;
    message = typeof body?.error === "string" ? body.error : null;
  } catch {
    // not JSON — status only
  }
  return { status: context.status, errorCode, message };
}

/** True when the refusal means the feature is not available to this member
 * (role or funnel scope), as opposed to a failure. */
export function isUnavailableRefusal(refusal: EdgeInvokeRefusal | null): boolean {
  return Boolean(refusal && refusal.status === 403 && refusal.errorCode && UNAVAILABLE_CODES.has(refusal.errorCode));
}
