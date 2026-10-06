// The one CORS header builder for Edge functions (plan §12.7: five copies
// consolidated into one). Allow-Origin stays "*" for now — a later phase swaps
// in the prod + Lovable-preview allowlist here, in one place.
//
// The browser can only read response headers listed in
// Access-Control-Expose-Headers, so x-build-id / x-request-id (stamped on every
// gated response) are exposed for the deploy gate and for support tickets.

import { BUILD_ID } from "./buildId.ts";

export const EXPOSED_RESPONSE_HEADERS: readonly string[] = Object.freeze(["x-build-id", "x-request-id"]);

const DEFAULT_ALLOWED_HEADERS = ["authorization", "x-client-info", "apikey", "content-type"];

export function buildCorsHeaders(options: { methods?: readonly string[]; extraAllowedHeaders?: readonly string[] } = {}): Record<string, string> {
  const methods = [...new Set([...(options.methods ?? ["GET", "POST"]).map((method) => method.toUpperCase()), "OPTIONS"])];
  const allowed = [...new Set([...DEFAULT_ALLOWED_HEADERS, ...(options.extraAllowedHeaders ?? []).map((header) => header.toLowerCase())])];
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": allowed.join(", "),
    "Access-Control-Allow-Methods": methods.join(", "),
    "Access-Control-Expose-Headers": EXPOSED_RESPONSE_HEADERS.join(", "),
  };
}

/** CORS plus the build stamp — the base header set of every Edge response. */
export function baseResponseHeaders(requestId?: string | null): Record<string, string> {
  const headers: Record<string, string> = { ...buildCorsHeaders(), "x-build-id": BUILD_ID };
  if (requestId) headers["x-request-id"] = requestId;
  return headers;
}
