/* global Deno */

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const FUNNELFOX_BASE_URL = "https://api.funnelfox.io/public/v1";

type JsonRecord = Record<string, unknown>;

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

export function optionsResponse(): Response {
  return new Response("ok", { headers: corsHeaders });
}

export function methodNotAllowed(): Response {
  return jsonResponse({ error: "Method not allowed." }, 405);
}

export function getFunnelFoxSecret(): string | null {
  return Deno.env.get("FUNNELFOX_SECRET")?.trim() || null;
}

// P0-5: the rich profile/debug response (raw profile keys + full profile + detected email) must NOT
// be exposed by default in production. It is gated behind a server-side FUNNELFOX_DEBUG env flag,
// which a caller cannot set. The per-request `debug` query param only refines an already-enabled
// debug environment.
export function isFunnelFoxDebugEnabled(): boolean {
  const flag = Deno.env.get("FUNNELFOX_DEBUG")?.trim().toLowerCase();
  return flag === "1" || flag === "true";
}

export async function readRequestParams(req: Request): Promise<URLSearchParams> {
  const url = new URL(req.url);
  const params = new URLSearchParams(url.search);

  if (req.method === "POST") {
    try {
      const body = await req.json() as JsonRecord;
      for (const [key, value] of Object.entries(body)) {
        if (value != null && !params.has(key)) params.set(key, String(value));
      }
    } catch {
      // Empty or non-JSON POST bodies are allowed; query params remain the source of truth.
    }
  }

  return params;
}

export async function fetchFunnelFox(path: string, secret: string): Promise<{ status: number; ok: boolean; payload: unknown }> {
  const upstream = await fetch(`${FUNNELFOX_BASE_URL}${path}`, {
    headers: {
      "Fox-Secret": secret,
      Accept: "application/json",
    },
  });

  let payload: unknown = null;
  try {
    payload = await upstream.json();
  } catch {
    payload = null;
  }

  return { status: upstream.status, ok: upstream.ok, payload };
}

function readRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function extractRows(payload: unknown): JsonRecord[] {
  const root = readRecord(payload);
  if (Array.isArray(root.data)) return root.data.filter((row): row is JsonRecord => Boolean(row && typeof row === "object"));
  if (Array.isArray(root.subscriptions)) {
    return root.subscriptions.filter((row): row is JsonRecord => Boolean(row && typeof row === "object"));
  }

  const nested = readRecord(root.data);
  if (Array.isArray(nested.data)) return nested.data.filter((row): row is JsonRecord => Boolean(row && typeof row === "object"));
  if (Array.isArray(nested.subscriptions)) {
    return nested.subscriptions.filter((row): row is JsonRecord => Boolean(row && typeof row === "object"));
  }

  return [];
}

function normalizeEmail(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function emailCoverage(payload: unknown) {
  const rows = extractRows(payload);
  const subscriptionsWithEmail = rows.filter((row) => {
    const profile = readRecord(row.profile);
    const customer = readRecord(row.customer);
    const user = readRecord(row.user);
    const metadata = readRecord(row.metadata);
    const profileMetadata = readRecord(profile.metadata);

    return [
      profile.email,
      row.profile_email,
      row.email,
      customer.email,
      row.customerEmail,
      row.customer_email,
      user.email,
      metadata.email,
      profileMetadata.email,
    ].some((value) => normalizeEmail(value));
  }).length;

  const totalSubscriptions = rows.length;
  return {
    total_subscriptions: totalSubscriptions,
    subscriptions_with_email: subscriptionsWithEmail,
    subscriptions_missing_email: totalSubscriptions - subscriptionsWithEmail,
    email_coverage_percent: totalSubscriptions ? (subscriptionsWithEmail / totalSubscriptions) * 100 : 0,
  };
}

export function subscriptionsDebugBody(secretExists: boolean, canCallFunnelFox: boolean, status?: number, payload?: unknown) {
  const coverage = payload
    ? emailCoverage(payload)
    : {
        total_subscriptions: 0,
        subscriptions_with_email: 0,
        subscriptions_missing_email: 0,
        email_coverage_percent: 0,
      };

  return {
    secret_exists: secretExists,
    can_call_funnelfox: canCallFunnelFox,
    funnelfox_status: status ?? null,
    subscription_count: coverage.total_subscriptions,
    ...coverage,
  };
}

function readPath(root: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => readRecord(current)[key], root);
}

function isSensitiveDebugKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return (
    normalized.includes("secret") ||
    normalized.includes("token") ||
    normalized.includes("password") ||
    normalized.includes("authorization") ||
    normalized.includes("provider_metadata") ||
    normalized.includes("providermetadata") ||
    normalized.includes("payment") ||
    normalized.includes("card") ||
    normalized.includes("pan") ||
    normalized.includes("cvv") ||
    normalized.includes("cvc")
  );
}

function sanitizeDebugValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeDebugValue);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value as JsonRecord).map(([key, entry]) => [
      key,
      isSensitiveDebugKey(key) ? "[redacted]" : sanitizeDebugValue(entry),
    ]),
  );
}

const PROFILE_EMAIL_PATHS = [
  "data.email",
  "email",
  "metadata.email",
  "replies.email",
  "fields.email",
  "attributes.email",
  "contact.email",
];

// Resolves the single profile email the app needs for enrichment, without exposing anything else.
export function detectProfileEmail(payload: unknown): string | null {
  const profile = readRecord(readRecord(payload).data ?? payload);
  for (const path of PROFILE_EMAIL_PATHS) {
    const value = normalizeEmail(readPath(payload, path) ?? readPath(profile, path));
    if (value) return value;
  }
  return null;
}

// Minimal, production-safe profile response: only the id and the resolved email. No raw profile,
// no key listing, no email-field enumeration (P0-5).
export function profileMinimalBody(profileId: string, payload: unknown) {
  return {
    profile_id: profileId,
    email: detectProfileEmail(payload),
  };
}

// Rich diagnostic body. Only return this when isFunnelFoxDebugEnabled() is true — it exposes the
// full (sanitized) profile and detected email, which is PII.
export function profileDebugBody(profileId: string, payload: unknown) {
  const profile = readRecord(readRecord(payload).data ?? payload);
  const emailLikeFieldsFound = PROFILE_EMAIL_PATHS
    .map((path) => ({ path, value: normalizeEmail(readPath(payload, path) ?? readPath(profile, path)) }))
    .filter((item) => item.value);

  return {
    profile_id: profileId,
    raw_profile_keys: Object.keys(profile),
    detected_email: emailLikeFieldsFound[0]?.value ?? null,
    checked_paths: PROFILE_EMAIL_PATHS,
    email_like_fields_found: emailLikeFieldsFound,
    profile: sanitizeDebugValue(profile),
  };
}
