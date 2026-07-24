/* global Deno */

// Lists the project's funnels from FunnelFox for the Funnels admin registry.
// Read-only: it never writes to Postgres — the page decides what to import.
//
// Why this exists instead of reading campaign_path out of ClickHouse: FunnelFox
// is the system of record for funnel IDENTITY and carries a human-readable
// `title`, while ClickHouse only knows paths that already produced traffic
// (so a funnel could not be registered before launch, and its display name
// would have to be machine-derived from the path).
//
// Deploy WITHOUT --no-verify-jwt so only an authenticated user can call it,
// matching the other funnelfox-* functions. FUNNELFOX_SECRET is read from Edge
// env and never returned to the caller.

import {
  fetchFunnelFox,
  getFunnelFoxSecret,
  jsonResponse,
  methodNotAllowed,
  optionsResponse,
  readRequestParams,
} from "../_shared/funnelfox.ts";

type JsonRecord = Record<string, unknown>;

// Bounded so a pagination bug upstream can never spin forever. 100/page is the
// documented maximum, so this covers 2,000 funnels — far beyond the ~43 this
// project actually has.
const MAX_PAGES = 20;
const PAGE_SIZE = 100;
const REQUEST_GAP_MS = 100;

function readRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Rows may sit under `data` (documented) or a few plausible aliases. */
function extractRows(payload: unknown): JsonRecord[] {
  const root = readRecord(payload);
  for (const key of ["data", "funnels", "results", "items"]) {
    const candidate = root[key];
    if (Array.isArray(candidate)) {
      return candidate.filter((row): row is JsonRecord => Boolean(row && typeof row === "object"));
    }
  }
  const nested = readRecord(root.data);
  for (const key of ["data", "funnels", "results", "items"]) {
    const candidate = nested[key];
    if (Array.isArray(candidate)) {
      return candidate.filter((row): row is JsonRecord => Boolean(row && typeof row === "object"));
    }
  }
  return [];
}

function extractPagination(payload: unknown): { cursor: string; hasMore: boolean } {
  const root = readRecord(payload);
  const pagination = readRecord(root.pagination ?? readRecord(root.data).pagination ?? root.meta);
  const cursor = text(pagination.cursor ?? pagination.next_cursor ?? pagination.next);
  const hasMoreRaw = pagination.has_more ?? pagination.hasMore;
  const hasMore = typeof hasMoreRaw === "boolean" ? hasMoreRaw : Boolean(cursor);
  return { cursor, hasMore };
}

/**
 * Only the fields the registry needs. Field names verified against the live
 * API (2026-07-24), not assumed from docs:
 *   alias   funnel path slug, e.g. "soulmate-sketch-en" -- byte-identical in
 *           shape to ff_campaign_path / campaign_path elsewhere in the app
 *           (no leading slash), so it joins without transformation
 *   id      stable ULID identity that survives a re-path
 *   title   human-readable name, the whole point of importing from here
 *   tags    FunnelFox's own labels, e.g. ["TikTok","WEB","🟢 Live"]
 *   status  "published" | ... , with is_draft alongside it
 * The docs mentioned a `deleted` flag; the live payload has no such field, so
 * publish state is expressed through status/is_draft instead.
 */
function normalizeFunnel(row: JsonRecord) {
  const tags = Array.isArray(row.tags) ? row.tags.map(text).filter(Boolean) : [];
  return {
    id: text(row.id ?? row.funnel_id),
    title: text(row.title ?? row.name),
    alias: text(row.alias ?? row.slug ?? row.path),
    type: text(row.type ?? row.funnel_type),
    status: text(row.status),
    is_draft: row.is_draft === true,
    environment: text(row.environment),
    last_published_at: text(row.last_published_at),
    tags,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return optionsResponse();
  if (req.method !== "GET" && req.method !== "POST") return methodNotAllowed();

  const secret = getFunnelFoxSecret();
  if (!secret) return jsonResponse({ error: "FunnelFox is not configured." }, 500);

  const params = await readRequestParams(req);
  // Diagnostic escape hatch: returns the RAW first-page keys so the exact
  // upstream field names can be confirmed without guessing. No PII — funnels
  // are configuration objects, not people.
  const inspect = params.get("inspect") === "1" || params.get("inspect") === "true";

  try {
    const funnels: ReturnType<typeof normalizeFunnel>[] = [];
    let cursor = "";
    let pages = 0;
    let firstPageSample: JsonRecord | null = null;
    let firstPageKeys: string[] = [];

    while (pages < MAX_PAGES) {
      const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (cursor) query.set("cursor", cursor);
      const upstream = await fetchFunnelFox(`/funnels?${query.toString()}`, secret);

      if (!upstream.ok) {
        return jsonResponse(
          { error: "FunnelFox API request failed.", status: upstream.status, page: pages + 1 },
          upstream.status === 404 ? 404 : 502,
        );
      }

      const rows = extractRows(upstream.payload);
      if (pages === 0) {
        firstPageSample = rows[0] ?? null;
        firstPageKeys = rows[0] ? Object.keys(rows[0]) : [];
      }
      funnels.push(...rows.map(normalizeFunnel));
      pages += 1;

      const pagination = extractPagination(upstream.payload);
      if (!pagination.hasMore || !pagination.cursor || rows.length === 0) break;
      cursor = pagination.cursor;
      await delay(REQUEST_GAP_MS);
    }

    if (inspect) {
      return jsonResponse({
        pages_fetched: pages,
        total_rows: funnels.length,
        first_page_raw_keys: firstPageKeys,
        first_row_sample: firstPageSample,
        normalized_sample: funnels.slice(0, 3),
      });
    }

    return jsonResponse({
      funnels: funnels.filter((funnel) => funnel.id),
      pages_fetched: pages,
      truncated: pages >= MAX_PAGES,
    });
  } catch (error) {
    return jsonResponse(
      { error: error instanceof Error ? error.message : "FunnelFox API request failed." },
      502,
    );
  }
});
