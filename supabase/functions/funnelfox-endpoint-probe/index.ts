/* global Deno */

// ⚠️ TEMPORARY DIAGNOSTIC — DELETE AFTER THE AUDIT IS COMPLETE.
//
// One-off probe to discover whether FunnelFox exposes a *listing* endpoint for email-only contacts
// (customers / profiles / sessions / leads / contacts) that the app could use for the Leads page,
// instead of only the subscription-bound endpoints the repo uses today. It does NOT change any app
// behavior and is not imported by the frontend.
//
// Safety:
//  - Reuses the same Supabase platform JWT gate as the other funnelfox-* functions (deploy WITHOUT
//    --no-verify-jwt so only an authenticated user can call it).
//  - FUNNELFOX_SECRET is read only from Edge Function env (never returned to the caller).
//  - Responses are PII-safe by default: field *names* and presence flags only; email VALUES are
//    masked; the full (sanitized) sample row is gated behind the server-only FUNNELFOX_DEBUG flag,
//    matching the P0-5 pattern in _shared/funnelfox.ts.

import {
  corsHeaders,
  fetchFunnelFox,
  getFunnelFoxSecret,
  isFunnelFoxDebugEnabled,
  jsonResponse,
  methodNotAllowed,
  optionsResponse,
} from "../_shared/funnelfox.ts";

type JsonRecord = Record<string, unknown>;

// Endpoints to probe (the audit question) and the pagination variants requested.
const ENDPOINTS = ["/profiles", "/customers", "/sessions", "/leads", "/contacts"] as const;
const VARIANTS = ["", "?limit=1", "?page=1", "?cursor=1"] as const;

// Be polite to the upstream API: small gap between calls so the probe never looks like a burst.
const REQUEST_GAP_MS = 120;

// Attribution fields the Leads page needs; we report presence (by name) for each.
const TARGET_FIELDS = [
  "email",
  "customer_id",
  "profile_id",
  "session_id",
  "created_at",
  "country",
  "user_agent",
  "funnel",
  "campaign_path",
] as const;

// Common container keys a list endpoint might wrap its rows in.
const ARRAY_CONTAINERS = [
  "data", "results", "items", "records", "rows",
  "profiles", "customers", "sessions", "leads", "contacts",
];

// Keys that indicate pagination support.
const PAGINATION_KEY_RE = /cursor|has_more|next|prev|page|per_page|limit|offset|total|count/i;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function maskEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed.includes("@")) return null;
  const [local, domain] = trimmed.split("@");
  return `${local.slice(0, 2)}***@${domain}`;
}

// Find the first array of objects, either the payload itself or under a known container key.
function detectArray(payload: unknown): { containerKey: string | null; rows: JsonRecord[] } {
  if (Array.isArray(payload)) {
    return { containerKey: "(root)", rows: payload.filter((r): r is JsonRecord => Boolean(r && typeof r === "object")) };
  }
  const root = readRecord(payload);
  for (const key of ARRAY_CONTAINERS) {
    if (Array.isArray(root[key])) {
      return { containerKey: key, rows: (root[key] as unknown[]).filter((r): r is JsonRecord => Boolean(r && typeof r === "object")) };
    }
  }
  // One level of nesting (e.g. { data: { results: [...] } }).
  const nested = readRecord(root.data);
  for (const key of ARRAY_CONTAINERS) {
    if (Array.isArray(nested[key])) {
      return { containerKey: `data.${key}`, rows: (nested[key] as unknown[]).filter((r): r is JsonRecord => Boolean(r && typeof r === "object")) };
    }
  }
  return { containerKey: null, rows: [] };
}

function paginationFields(payload: unknown): string[] {
  const found = new Set<string>();
  const scan = (obj: JsonRecord, prefix: string) => {
    for (const key of Object.keys(obj)) {
      if (PAGINATION_KEY_RE.test(key)) found.add(prefix ? `${prefix}.${key}` : key);
    }
  };
  const root = readRecord(payload);
  scan(root, "");
  scan(readRecord(root.pagination), "pagination");
  scan(readRecord(root.meta), "meta");
  scan(readRecord(root.page), "page");
  return [...found];
}

// Presence of each target field by key name, searched a couple of levels deep (rows often nest
// attribution under profile/customer/session/metadata/funnel). Returns presence flags only.
function targetFieldPresence(row: JsonRecord): { presence: Record<string, boolean>; emailPreview: string | null } {
  const buckets: JsonRecord[] = [
    row,
    readRecord(row.profile),
    readRecord(row.customer),
    readRecord(row.user),
    readRecord(row.session),
    readRecord(row.funnel),
    readRecord(row.metadata),
    readRecord(readRecord(row.profile).metadata),
  ];
  const hasKey = (name: string) =>
    buckets.some((b) => Object.keys(b).some((k) => k.toLowerCase() === name || k.toLowerCase().replace(/[^a-z]/g, "").includes(name.replace(/_/g, ""))));

  const presence: Record<string, boolean> = {};
  for (const field of TARGET_FIELDS) presence[field] = hasKey(field);

  const emailPreview =
    maskEmail(readRecord(row.profile).email) ??
    maskEmail(row.email) ??
    maskEmail(readRecord(row.customer).email) ??
    maskEmail(readRecord(row.metadata).email);

  return { presence, emailPreview };
}

function sanitizeKeysDeep(value: unknown, depth = 0, maxDepth = 3): unknown {
  if (depth > maxDepth) return "…";
  if (Array.isArray(value)) return value.slice(0, 2).map((v) => sanitizeKeysDeep(v, depth + 1, maxDepth));
  if (!value || typeof value !== "object") {
    return typeof value === "string" && value.includes("@") ? maskEmail(value) ?? "[str]" : typeof value;
  }
  return Object.fromEntries(
    Object.entries(value as JsonRecord).map(([k, v]) => {
      const sensitive = /secret|token|password|authorization|card|pan|cvv|cvc|payment/i.test(k);
      return [k, sensitive ? "[redacted]" : sanitizeKeysDeep(v, depth + 1, maxDepth)];
    }),
  );
}

async function probe(path: string, secret: string, includeSample: boolean, includeStructure = false): Promise<JsonRecord> {
  try {
    const { status, ok, payload } = await fetchFunnelFox(path, secret);
    const { containerKey, rows } = detectArray(payload);
    const firstRow = rows[0];
    const pagination = paginationFields(payload);
    const target = firstRow ? targetFieldPresence(firstRow) : { presence: {}, emailPreview: null };

    const result: JsonRecord = {
      path,
      status,
      ok,
      supports_listing: rows.length > 0 || containerKey != null,
      array_container: containerKey,
      row_count: rows.length,
      supports_pagination: pagination.length > 0,
      pagination_fields: pagination,
      top_level_keys: Array.isArray(payload) ? ["(array)"] : Object.keys(readRecord(payload)).slice(0, 40),
      sample_row_keys: firstRow ? Object.keys(firstRow).slice(0, 60) : [],
      target_field_presence: target.presence,
      email_masked_preview: target.emailPreview,
    };
    // Full sanitized sample (key names + value *types*, emails masked) only when server debug is on.
    if (includeSample && firstRow) result.sanitized_sample_row = sanitizeKeysDeep(firstRow);
    // Structure discovery (screen/step audit): the whole payload reduced to key
    // names + value TYPES (emails masked, sensitive keys redacted), deeper than
    // the sample, plus the two public-URL fields a funnel exposes verbatim.
    if (includeStructure) {
      result.structure = sanitizeKeysDeep(payload, 0, 6);
      const record = readRecord(payload);
      result.revealed = {
        config_url: typeof record.config_url === "string" ? record.config_url : null,
        url: typeof record.url === "string" ? record.url : null,
      };
      // Volume/shape estimation: verbatim values of a fixed NON-PII whitelist
      // (timestamps, ids, version) for up to 200 list rows, and the screen/
      // element ids of a session's replies (never their values).
      const SAFE_FIELD_RE = /^(id|created_at|updated_at|funnel_id|funnel_version|origin|status|screen_id|element_id)$/;
      const pickSafe = (row: unknown): JsonRecord =>
        Object.fromEntries(Object.entries(readRecord(row)).filter(([key]) => SAFE_FIELD_RE.test(key)));
      result.revealed_rows = rows.slice(0, 200).map(pickSafe);
      if (Array.isArray(record.replies)) result.revealed_replies = record.replies.map(pickSafe);
    }
    return result;
  } catch (error) {
    return { path, status: null, ok: false, error: error instanceof Error ? error.message : "probe failed" };
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return optionsResponse();
  if (req.method !== "GET" && req.method !== "POST") return methodNotAllowed();

  const secret = getFunnelFoxSecret();
  if (!secret) return jsonResponse({ error: "FunnelFox is not configured (FUNNELFOX_SECRET missing)." }, 500);

  const includeSample = isFunnelFoxDebugEnabled();
  const results: JsonRecord[] = [];

  // Optional POST body { paths: ["/sessions?limit=1", ...] } probes exactly
  // those paths (discovery of screen/step endpoints) instead of the fixed
  // listing audit below. Paths are whitelisted to a safe character set and
  // capped so the probe can never be turned into a scraper.
  let customPaths: string[] = [];
  let includeStructure = false;
  if (req.method === "POST") {
    const body = await req.json().catch(() => null) as { paths?: unknown; include_structure?: unknown } | null;
    includeStructure = Boolean(body && body.include_structure === true);
    if (body && Array.isArray(body.paths)) {
      customPaths = body.paths
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter((value) => /^\/[A-Za-z0-9_\-\/?=&.]{1,160}$/.test(value))
        .slice(0, 25);
    }
  }

  if (customPaths.length) {
    for (const path of customPaths) {
      await delay(REQUEST_GAP_MS);
      results.push(await probe(path, secret, includeSample, includeStructure));
    }
  } else {
    // Baseline: confirm the known-good subscriptions endpoint responds with this secret.
    results.push({ note: "baseline (known endpoint)", ...(await probe("/subscriptions?limit=1", secret, includeSample)) });

    for (const endpoint of ENDPOINTS) {
      for (const variant of VARIANTS) {
        await delay(REQUEST_GAP_MS);
        results.push(await probe(`${endpoint}${variant}`, secret, includeSample));
      }
    }
  }

  const reachable = results.filter((r) => r.ok && r.supports_listing);

  return new Response(
    JSON.stringify(
      {
        generated_for: "FunnelFox listing-endpoint discovery audit (temporary)",
        debug_sample_included: includeSample,
        summary: {
          probed: results.length,
          listing_endpoints_found: reachable.map((r) => r.path),
          any_listing_endpoint: reachable.length > 0,
        },
        results,
      },
      null,
      2,
    ),
    { headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" } },
  );
});
