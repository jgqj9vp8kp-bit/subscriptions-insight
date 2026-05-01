import { normalizeSubscription } from "@/services/subscriptionTransform";
import type { FunnelFoxListResponse, FunnelFoxSubscriptionRaw, SubscriptionClean } from "@/types/subscriptions";

const DEFAULT_PROXY_ENDPOINT = "/api/funnelfox/subscriptions";
const DEFAULT_SUBSCRIPTION_DETAILS_ENDPOINT = "/api/funnelfox/subscription";
const DEFAULT_PROFILE_DEBUG_ENDPOINT = "/api/funnelfox/profile";
const DETAIL_CONCURRENCY_LIMIT = 5;
const DETAIL_REQUEST_DELAY_MS = 75;
const DETAIL_RETRY_DELAY_MS = 750;
const DETAIL_MAX_RETRIES = 2;

type FunnelFoxRequestOptions = {
  secret?: string;
};

export type FunnelFoxDebugResponse = {
  secret_exists: boolean;
  can_call_funnelfox: boolean;
  funnelfox_status: number | null;
  subscription_count: number;
};

export type FunnelFoxSyncDiagnostics = {
  total_subscriptions: number;
  subscriptions_with_profile_id: number;
  subscriptions_missing_profile_id: number;
  missing_email_before_details: number;
  details_fetched: number;
  detail_requests_attempted: number;
  detail_requests_skipped_due_to_cache: number;
  detail_requests_skipped_due_to_complete_data: number;
  emails_enriched_from_details: number;
  missing_email_after_details: number;
  price_normalization_applied: boolean;
  warnings: string[];
};

export type FunnelFoxSyncResult = {
  rows: SubscriptionClean[];
  diagnostics: FunnelFoxSyncDiagnostics;
};

export type FunnelFoxProfileDebugResponse = {
  profile_id: string;
  raw_profile_keys: string[];
  detected_email: string | null;
  checked_paths: string[];
  email_like_fields_found: Array<{ path: string; value: string }>;
  profile: unknown;
};

function isMockMode(): boolean {
  return import.meta.env.VITE_FUNNELFOX_MOCK !== "false";
}

function proxyEndpoint(): string {
  return import.meta.env.VITE_FUNNELFOX_PROXY_URL || DEFAULT_PROXY_ENDPOINT;
}

function subscriptionDetailsEndpoint(): string {
  return import.meta.env.VITE_FUNNELFOX_SUBSCRIPTION_DETAILS_URL || DEFAULT_SUBSCRIPTION_DETAILS_ENDPOINT;
}

function profileDebugEndpoint(): string {
  return import.meta.env.VITE_FUNNELFOX_PROFILE_DEBUG_URL || DEFAULT_PROFILE_DEBUG_ENDPOINT;
}

function extractRows(response: FunnelFoxListResponse): FunnelFoxSubscriptionRaw[] {
  if (Array.isArray(response.data)) return response.data;
  if (Array.isArray(response.subscriptions)) return response.subscriptions;

  const nestedData = response.data as unknown;
  if (nestedData && typeof nestedData === "object") {
    const nested = nestedData as FunnelFoxListResponse;
    if (Array.isArray(nested.data)) return nested.data;
    if (Array.isArray(nested.subscriptions)) return nested.subscriptions;
  }

  return [];
}

async function safeErrorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const payload = (await res.json()) as { error?: string };
    if (payload.error === "FunnelFox sync is not configured.") {
      return "Add FunnelFox Secret Key or configure FUNNELFOX_SECRET on the server.";
    }
    if (payload.error) return payload.error;
  } catch {
    // Keep the generic fallback when the proxy returns a non-JSON error body.
  }
  return fallback;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export async function listSubscriptions(cursor?: string): Promise<FunnelFoxListResponse> {
  if (isMockMode()) {
    return {
      data: [],
      pagination: { has_more: false, next_cursor: null },
    };
  }

  const url = new URL(proxyEndpoint(), window.location.origin);
  if (cursor) url.searchParams.set("cursor", cursor);
  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(await safeErrorMessage(res, `Could not load FunnelFox subscriptions (HTTP ${res.status}).`));
  }
  return res.json() as Promise<FunnelFoxListResponse>;
}

function requestHeaders(options?: FunnelFoxRequestOptions): HeadersInit | undefined {
  const secret = options?.secret?.trim();
  return secret ? { "X-FunnelFox-Secret": secret } : undefined;
}

export async function listSubscriptionsWithOptions(
  cursor?: string,
  options?: FunnelFoxRequestOptions,
): Promise<FunnelFoxListResponse> {
  if (isMockMode() && !options?.secret?.trim()) {
    return {
      data: [],
      pagination: { has_more: false, next_cursor: null },
    };
  }

  const url = new URL(proxyEndpoint(), window.location.origin);
  if (cursor) url.searchParams.set("cursor", cursor);
  const res = await fetch(url.toString(), { headers: requestHeaders(options) });
  if (!res.ok) {
    throw new Error(await safeErrorMessage(res, `Could not load FunnelFox subscriptions (HTTP ${res.status}).`));
  }
  return res.json() as Promise<FunnelFoxListResponse>;
}

export async function testFunnelFoxConnection(options?: FunnelFoxRequestOptions): Promise<FunnelFoxDebugResponse> {
  const url = new URL(proxyEndpoint(), window.location.origin);
  url.searchParams.set("debug", "1");
  const res = await fetch(url.toString(), { headers: requestHeaders(options) });
  if (!res.ok) {
    throw new Error(await safeErrorMessage(res, `Could not test FunnelFox connection (HTTP ${res.status}).`));
  }
  return res.json() as Promise<FunnelFoxDebugResponse>;
}

export async function fetchProfileDebug(profileId: string, options?: FunnelFoxRequestOptions): Promise<FunnelFoxProfileDebugResponse> {
  const url = new URL(profileDebugEndpoint(), window.location.origin);
  url.searchParams.set("id", profileId);
  const res = await fetch(url.toString(), { headers: requestHeaders(options) });
  if (!res.ok) {
    throw new Error(await safeErrorMessage(res, `Could not load FunnelFox profile debug (HTTP ${res.status}).`));
  }
  return res.json() as Promise<FunnelFoxProfileDebugResponse>;
}

async function fetchSubscriptionDetails(subscriptionId: string, options?: FunnelFoxRequestOptions): Promise<FunnelFoxSubscriptionRaw> {
  const url = new URL(subscriptionDetailsEndpoint(), window.location.origin);
  url.searchParams.set("id", subscriptionId);

  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= DETAIL_MAX_RETRIES; attempt += 1) {
    const res = await fetch(url.toString(), { headers: requestHeaders(options) });
    if (res.ok) {
      const payload = (await res.json()) as { data?: FunnelFoxSubscriptionRaw } & FunnelFoxSubscriptionRaw;
      return (payload.data && typeof payload.data === "object" ? payload.data : payload) as FunnelFoxSubscriptionRaw;
    }

    lastError = new Error(await safeErrorMessage(res, `Could not load FunnelFox subscription details (HTTP ${res.status}).`));
    if (res.status !== 429 || attempt === DETAIL_MAX_RETRIES) break;

    const retryAfter = Number(res.headers.get("Retry-After"));
    await delay(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : DETAIL_RETRY_DELAY_MS * (attempt + 1));
  }

  throw lastError ?? new Error("Could not load FunnelFox subscription details.");
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function safeDebugValue(value: unknown): unknown {
  if (!value || typeof value !== "object") return value ?? null;
  const record = readRecord(value);
  return {
    type: Array.isArray(value) ? "array" : "object",
    keys: Object.keys(record),
    id: record.id ?? null,
    profile_id: record.profile_id ?? null,
    customer_id: record.customer_id ?? null,
    customer: typeof record.customer === "string" || typeof record.customer === "number" ? record.customer : null,
    profile: typeof record.profile === "string" || typeof record.profile === "number" ? record.profile : null,
  };
}

function logFirstRawSubscriptionDebug(rows: FunnelFoxSubscriptionRaw[]) {
  const raw = rows[0];
  if (!raw) return;
  const data = readRecord(raw.data);

  console.info("FunnelFox first raw subscription profile candidates", {
    keys: Object.keys(raw),
    customer: safeDebugValue(raw.customer),
    customer_id: raw.customer_id ?? null,
    profile: safeDebugValue(raw.profile),
    profile_id: raw.profile_id ?? null,
    profileId: raw.profileId ?? null,
    customerId: raw.customerId ?? null,
    user: safeDebugValue(raw.user),
    user_id: raw.user_id ?? null,
    id: raw.id ?? null,
    psp_id: raw.psp_id ?? null,
    data: {
      keys: Object.keys(data),
      customer: safeDebugValue(data.customer),
      profile: safeDebugValue(data.profile),
      profile_id: data.profile_id ?? null,
      customer_id: data.customer_id ?? null,
    },
  });
}

function needsSubscriptionDetails(row: SubscriptionClean): boolean {
  return !row.email || !row.profile_id || !row.product_name || !row.funnel_title || !row.funnel_alias;
}

function mergeSubscriptionDetails(row: SubscriptionClean, detail: SubscriptionClean): SubscriptionClean {
  return {
    ...row,
    email: row.email ?? detail.email,
    profile_id: row.profile_id || detail.profile_id,
    status: detail.status || row.status,
    renews: detail.renews ?? row.renews,
    cancelled_at: detail.cancelled_at ?? row.cancelled_at,
    cancellation_reason: detail.cancellation_reason ?? row.cancellation_reason,
    is_active_now: detail.period_ends_at ? detail.is_active_now : row.is_active_now,
    period_ends_at: detail.period_ends_at || row.period_ends_at,
    product_name: detail.product_name || row.product_name,
    product_id: detail.product_id || row.product_id,
    funnel_title: detail.funnel_title || row.funnel_title,
    funnel_alias: detail.funnel_alias || row.funnel_alias,
    session_id: detail.session_id || row.session_id,
    price_usd: detail.price_usd || row.price_usd,
    raw: row.raw,
  };
}

async function enrichFromSubscriptionDetails(
  rows: SubscriptionClean[],
  options?: FunnelFoxRequestOptions,
): Promise<{
  rows: SubscriptionClean[];
  detailsFetched: number;
  detailRequestsAttempted: number;
  skippedDueToCache: number;
  skippedDueToCompleteData: number;
  emailsEnriched: number;
  warnings: string[];
}> {
  const detailCache = new Map<string, SubscriptionClean | null>();
  const warnings: string[] = [];
  let skippedDueToCache = 0;
  let skippedDueToCompleteData = 0;

  const detailIds: string[] = [];
  for (const row of rows) {
    if (!row.subscription_id) continue;
    if (!needsSubscriptionDetails(row)) {
      skippedDueToCompleteData += 1;
      continue;
    }
    if (detailCache.has(row.subscription_id)) {
      skippedDueToCache += 1;
      continue;
    }

    detailCache.set(row.subscription_id, null);
    detailIds.push(row.subscription_id);
  }

  let cursor = 0;
  async function worker() {
    while (cursor < detailIds.length) {
      const subscriptionId = detailIds[cursor];
      cursor += 1;
      if (DETAIL_REQUEST_DELAY_MS) await delay(DETAIL_REQUEST_DELAY_MS);

      try {
        const detail = await fetchSubscriptionDetails(subscriptionId, options);
        detailCache.set(subscriptionId, normalizeSubscription(detail));
      } catch {
        detailCache.set(subscriptionId, null);
        warnings.push(`Could not enrich subscription ${subscriptionId}.`);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(DETAIL_CONCURRENCY_LIMIT, detailIds.length) }, () => worker()),
  );

  let emailsEnriched = 0;
  const enriched = rows.map((row) => {
    const detail = detailCache.get(row.subscription_id);
    if (!detail) return row;
    const merged = mergeSubscriptionDetails(row, detail);
    if (!row.email && merged.email) emailsEnriched += 1;
    return merged;
  });

  return {
    rows: enriched,
    detailsFetched: detailCache.size,
    detailRequestsAttempted: detailIds.length,
    skippedDueToCache,
    skippedDueToCompleteData,
    emailsEnriched,
    warnings,
  };
}

export async function syncAllSubscriptionsWithDiagnostics(options?: FunnelFoxRequestOptions): Promise<FunnelFoxSyncResult> {
  const rows: FunnelFoxSubscriptionRaw[] = [];
  let cursor: string | undefined;
  let hasMore = true;

  while (hasMore) {
    const page = await listSubscriptionsWithOptions(cursor, options);
    const pageRows = extractRows(page);
    console.info("FunnelFox raw list page count", {
      page_count: pageRows.length,
      total_before_page: rows.length,
      has_more: Boolean(page.pagination?.has_more),
    });
    rows.push(...pageRows);
    hasMore = Boolean(page.pagination?.has_more);
    cursor = page.pagination?.next_cursor ?? undefined;
    if (hasMore && !cursor) break;
  }

  logFirstRawSubscriptionDebug(rows);

  const normalized = rows.map(normalizeSubscription);
  console.info("FunnelFox normalized subscriptions count", { count: normalized.length });
  const withEmailBefore = normalized.filter((row) => Boolean(row.email)).length;
  const detailEnriched = await enrichFromSubscriptionDetails(normalized, options);
  console.info("FunnelFox enriched subscriptions count", { count: detailEnriched.rows.length });
  const withEmailAfter = detailEnriched.rows.filter((row) => Boolean(row.email)).length;
  const withProfileId = detailEnriched.rows.filter((row) => Boolean(row.profile_id)).length;
  const total = detailEnriched.rows.length;

  console.info(
    "FunnelFox subscriptions after enrichment",
    detailEnriched.rows.slice(0, 5).map((row) => ({
      email: row.email,
      profile_id: row.profile_id,
    })),
  );

  return {
    rows: detailEnriched.rows,
    diagnostics: {
      total_subscriptions: total,
      subscriptions_with_profile_id: withProfileId,
      subscriptions_missing_profile_id: total - withProfileId,
      missing_email_before_details: total - withEmailBefore,
      details_fetched: detailEnriched.detailsFetched,
      detail_requests_attempted: detailEnriched.detailRequestsAttempted,
      detail_requests_skipped_due_to_cache: detailEnriched.skippedDueToCache,
      detail_requests_skipped_due_to_complete_data: detailEnriched.skippedDueToCompleteData,
      emails_enriched_from_details: detailEnriched.emailsEnriched,
      missing_email_after_details: total - withEmailAfter,
      price_normalization_applied: true,
      warnings: detailEnriched.warnings,
    },
  };
}

export async function syncAllSubscriptions(options?: FunnelFoxRequestOptions): Promise<SubscriptionClean[]> {
  const result = await syncAllSubscriptionsWithDiagnostics(options);
  return result.rows;
}
