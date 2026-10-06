// Pure bearer-session gate shared by ClickHouse Edge Functions. Keeping token
// parsing and user-session validation dependency-free makes the security
// contract testable without importing the Deno/Supabase runtime.
//
// Two different failures must never be confused (plan §10 step 1):
//   * the TOKEN is bad (missing, garbage, expired, revoked, user deleted)
//     → 401 invalid_session — the browser signs the user out;
//   * the AUTH SERVICE could not answer (network, 5xx, rate limit, a throw)
//     → 503 auth_service_error — the browser retries; the session is kept.
// Treating a GoTrue blip as 401 logged every signed-in user out at once.
// Both fail closed: neither ever yields an identity.

export interface VerifiedEdgeIdentity {
  id: string;
  email: string | null;
  token: string;
}

export type EdgeAuthFailure =
  | { status: 401; body: { error: string; error_code: "invalid_session" } }
  | { status: 503; body: { error: string; error_code: "auth_service_error" } };

export type EdgeAuthDecision = VerifiedEdgeIdentity | EdgeAuthFailure;

export interface GetUserResult {
  data: { user?: { id?: string | null; email?: string | null } | null } | null;
  error?: unknown;
}

const INVALID_SESSION: EdgeAuthFailure = { status: 401, body: { error: "Invalid or expired session.", error_code: "invalid_session" } };
const MISSING_SESSION: EdgeAuthFailure = { status: 401, body: { error: "Authentication required.", error_code: "invalid_session" } };
const AUTH_SERVICE_ERROR: EdgeAuthFailure = {
  status: 503,
  body: { error: "Could not verify the session with the authentication service. Please retry.", error_code: "auth_service_error" },
};

export function extractBearerToken(authorization: string | null | undefined): string {
  return (authorization ?? "").replace(/^Bearer\s+/i, "").trim();
}

const SUBJECT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The `sub` claim of a JWT-shaped bearer token, read WITHOUT verifying the
 * signature — so it is a hint, never an identity. The gate uses it only to
 * start resolve_access(sub) while getUser verifies the token (plan §10 step 2:
 * "in parallel"), and uses that row only when the VERIFIED user id is the same.
 * null for anything that is not a three-part token with a uuid subject (the
 * anon key, API keys, garbage). Never throws. */
export function unverifiedBearerSubject(token: string | null | undefined): string | null {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1] || parts[1].length > 4096) return null;
  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const claims = JSON.parse(atob(padded)) as { sub?: unknown } | null;
    const sub = claims && typeof claims === "object" ? claims.sub : null;
    return typeof sub === "string" && SUBJECT_UUID_RE.test(sub) ? sub : null;
  } catch {
    return null;
  }
}

/** supabase-js error classes that mean "the service did not answer", whatever
 * their status: AuthRetryableFetchError (network / 502-504, status 0 when the
 * request never left) and AuthUnknownError (a non-JSON body, e.g. a gateway page). */
const INFRA_ERROR_NAMES = new Set(["AuthRetryableFetchError", "AuthUnknownError"]);
/** 4xx statuses that are the service's fault, not the token's. */
const INFRA_CLIENT_STATUSES = new Set([408, 429]);

/** Classifies a supabase-js getUser error. GoTrue answers a bad, expired or
 * revoked JWT (bad_jwt, session_not_found, user_not_found) with 401/403 and
 * other request faults with 4xx — all "invalid". Anything the service could not
 * answer is "infra". An error without status or a recognized class name keeps
 * the historical meaning ("invalid"), matching the pre-classification gate. */
export function classifyGetUserError(error: unknown): "invalid" | "infra" {
  if (!error || typeof error !== "object") return "invalid";
  const shaped = error as { name?: unknown; status?: unknown };
  if (typeof shaped.name === "string" && INFRA_ERROR_NAMES.has(shaped.name)) return "infra";
  if (typeof shaped.status === "number") {
    if (shaped.status === 0 || shaped.status >= 500 || INFRA_CLIENT_STATUSES.has(shaped.status)) return "infra";
    return "invalid";
  }
  return "invalid";
}

export async function verifyEdgeBearerSession(input: {
  authorization: string | null | undefined;
  getUser: (token: string) => Promise<GetUserResult>;
}): Promise<EdgeAuthDecision> {
  const token = extractBearerToken(input.authorization);
  if (!token) return MISSING_SESSION;
  let result: GetUserResult;
  try {
    result = await input.getUser(token);
  } catch {
    // A throw is never the token's fault: supabase-js returns auth rejections
    // as { error }, so a rejection here is a transport / runtime failure.
    return AUTH_SERVICE_ERROR;
  }
  if (result?.error) return classifyGetUserError(result.error) === "infra" ? AUTH_SERVICE_ERROR : INVALID_SESSION;
  const user = result?.data?.user;
  if (!user?.id) return INVALID_SESSION;
  return { id: user.id, email: user.email ?? null, token };
}
