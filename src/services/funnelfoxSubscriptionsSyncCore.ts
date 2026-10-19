// Pure, dependency-injected core for the staged FunnelFox Subscriptions sync.
//
// This module is the unit-tested twin of the funnelfox-subscriptions-sync Edge
// Function: the Edge runtime cannot import `@/` aliases, so the same helpers are
// duplicated verbatim there and kept in lockstep. Everything here is pure and
// I/O-free — network and clock are injected — so the stage machine, resume,
// timeouts, and concurrency can be tested without Deno, network, or Supabase.

export type JsonRecord = Record<string, unknown>;

export type SubscriptionSyncStage =
  | "subscriptions_list"
  | "subscription_details"
  | "profile_enrichment"
  | "finalize";

export const SUBSCRIPTION_SYNC_STAGES: SubscriptionSyncStage[] = [
  "subscriptions_list",
  "subscription_details",
  "profile_enrichment",
  "finalize",
];

export type SyncStoppedReason =
  | "completed"
  | "soft_timeout"
  | "max_pages_reached"
  | "rate_limited"
  | "api_error"
  | "user_cancelled"
  | "unknown";

export interface SubscriptionStageCompletion {
  list_completed: boolean;
  details_completed: boolean;
  profiles_completed: boolean;
  finalize_completed: boolean;
}

// One invocation runs ONE stage: the requested one, else the next incomplete
// stage in fixed order, else finalize (idempotent tail).
export function nextIncompleteStage(flags: SubscriptionStageCompletion): SubscriptionSyncStage | null {
  if (!flags.list_completed) return "subscriptions_list";
  if (!flags.details_completed) return "subscription_details";
  if (!flags.profiles_completed) return "profile_enrichment";
  if (!flags.finalize_completed) return "finalize";
  return null;
}

// api_error and timeout win even when the page also reported more.
export function determineStopReason(input: {
  pages: number;
  maxPages: number;
  hasMoreOnLastPage: boolean;
  timedOut: boolean;
  apiError: boolean;
}): SyncStoppedReason {
  if (input.apiError) return "api_error";
  if (input.timedOut) return "soft_timeout";
  if (!input.hasMoreOnLastPage) return "completed";
  if (input.pages >= input.maxPages) return "max_pages_reached";
  return "unknown";
}

export function statusFromStopReason(reason: SyncStoppedReason): "ok" | "partial" | "error" {
  switch (reason) {
    case "completed":
      return "ok";
    case "api_error":
      return "error";
    default:
      return "partial";
  }
}

// A cursor-less enrichment stage (details / profiles) is only fully done when
// nothing was timed-out-skipped AND no candidate rows remain. Transient API
// failures leave rows unchecked → stage stays incomplete → Continue resumes it.
// A FunnelFox 429 stops the run (the rest stays unchecked for the next tick).
export function enrichStopReason(timeoutSkipped: number, apiError = false, rateLimited = false): SyncStoppedReason {
  if (apiError) return "api_error";
  if (rateLimited) return "rate_limited";
  return timeoutSkipped > 0 ? "soft_timeout" : "completed";
}

export function enrichStageComplete(timeoutSkipped: number, remainingUnchecked: number): boolean {
  return timeoutSkipped === 0 && remainingUnchecked === 0;
}

export function resolveStartCursor(savedCursor: string | null | undefined, fullReset: boolean): string | undefined {
  if (fullReset) return undefined;
  return savedCursor ?? undefined;
}

export function fullResetState(): SubscriptionStageCompletion & { current_stage: SubscriptionSyncStage; last_list_cursor: null } {
  return {
    list_completed: false,
    details_completed: false,
    profiles_completed: false,
    finalize_completed: false,
    current_stage: "subscriptions_list",
    last_list_cursor: null,
  };
}

export function computeCoveragePercent(scannedTotal: number, totalReported: number | null): number | null {
  if (!totalReported || totalReported <= 0) return null;
  return Math.min(100, Math.round((scannedTotal / totalReported) * 10000) / 100);
}

export function computeCoverageWarning(input: {
  stoppedReason: SyncStoppedReason;
  stage: SubscriptionSyncStage;
  hasPendingDetails: boolean;
  hasPendingProfiles: boolean;
  missingEmailAfterEnrichment: number;
}): { coverage_warning: boolean; coverage_warning_message: string } {
  if (input.stoppedReason === "max_pages_reached") {
    return {
      coverage_warning: true,
      coverage_warning_message: "Sync stopped because max_pages was reached while FunnelFox still had more subscriptions. Click Continue Sync.",
    };
  }
  if (input.stoppedReason === "soft_timeout") {
    return {
      coverage_warning: true,
      coverage_warning_message: "Sync stopped at the soft time budget. Click Continue Sync to resume from the last cursor.",
    };
  }
  if (input.stoppedReason === "rate_limited") {
    return {
      coverage_warning: true,
      coverage_warning_message: "FunnelFox rate-limited the detail requests (HTTP 429); the next run resumes them.",
    };
  }
  if (input.stoppedReason === "api_error") {
    return {
      coverage_warning: true,
      coverage_warning_message: "Sync stopped because the FunnelFox API returned an error before finishing.",
    };
  }
  if (input.hasPendingDetails) {
    return { coverage_warning: true, coverage_warning_message: "Subscription details are incomplete. Click Continue Sync." };
  }
  if (input.hasPendingProfiles) {
    return { coverage_warning: true, coverage_warning_message: "Email enrichment is incomplete. Click Continue Sync." };
  }
  if (input.missingEmailAfterEnrichment > 0) {
    return {
      coverage_warning: true,
      coverage_warning_message: `${input.missingEmailAfterEnrichment} subscriptions still have no email after enrichment (FunnelFox has none for them).`,
    };
  }
  return { coverage_warning: false, coverage_warning_message: "" };
}

export function readReportedTotal(pagination: JsonRecord): number | null {
  for (const key of ["total", "total_count", "totalCount", "count"]) {
    const value = pagination[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

// ---- row extraction (mirror of the Edge Function's column builders) ----------

export function readRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value);
}

export function strOrNull(value: unknown): string | null {
  return str(value) || null;
}

export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.trim().toLowerCase() || null;
}

/** Email candidate paths, mirror of subscriptionTransform.extractEmail. */
export function emailFromSubscriptionRaw(raw: JsonRecord): string | null {
  const profile = readRecord(raw.profile);
  const customer = readRecord(raw.customer);
  const user = readRecord(raw.user);
  const metadata = readRecord(raw.metadata);
  const profileMetadata = readRecord(profile.metadata);
  for (const value of [
    profile.email,
    raw.profile_email,
    raw.email,
    customer.email,
    raw.customerEmail,
    raw.customer_email,
    user.email,
    metadata.email,
    profileMetadata.email,
  ]) {
    const email = normalizeEmail(value);
    if (email) return email;
  }
  return null;
}

export function profileIdFromSubscriptionRaw(raw: JsonRecord): string | null {
  const profile = readRecord(raw.profile);
  const raw_id = str(raw.profile_id) || str(profile.id) || str(raw.profileId);
  if (!raw_id) return null;
  return raw_id.startsWith("pro_") ? raw_id.slice(4) : raw_id;
}

export interface SubscriptionListColumns {
  subscription_id: string;
  profile_id: string | null;
  customer_id: string | null;
  psp_id: string | null;
  email: string | null;
  normalized_email: string | null;
  status: string | null;
  renews: boolean | null;
  product_name: string | null;
  product_id: string | null;
  price: number | null;
  currency: string | null;
  created_at: string | null;
  updated_at: string | null;
  cancelled_at: string | null;
  period_ends_at: string | null;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Number(String(value ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) && String(value ?? "").trim() ? parsed : null;
}

/** Lightweight normalized columns for the DB row + diagnostics (not the full SubscriptionClean). */
export function subscriptionListColumns(raw: JsonRecord): SubscriptionListColumns {
  const product = readRecord(raw.product);
  const email = emailFromSubscriptionRaw(raw);
  const renewsRaw = raw.renews;
  const priceCents = numberOrNull(raw.price_usd ?? raw.price);
  return {
    subscription_id: str(raw.id ?? raw.subscription_id),
    profile_id: profileIdFromSubscriptionRaw(raw),
    customer_id: strOrNull(readRecord(raw.customer).id ?? raw.customer_id),
    psp_id: strOrNull(raw.psp_id),
    email,
    normalized_email: email,
    status: strOrNull(raw.status)?.toLowerCase() ?? null,
    renews: typeof renewsRaw === "boolean" ? renewsRaw : renewsRaw == null ? null : Boolean(renewsRaw),
    product_name: strOrNull(product.name ?? raw.product_name),
    product_id: strOrNull(product.id ?? raw.product_id),
    price: priceCents == null ? null : Math.round((priceCents / 100) * 100) / 100,
    currency: strOrNull(raw.currency),
    created_at: strOrNull(raw.created_at),
    updated_at: strOrNull(raw.updated_at),
    cancelled_at: strOrNull(raw.cancelled_at),
    period_ends_at: strOrNull(raw.period_ends_at),
  };
}

/**
 * Columns the LIST stage may write. The /subscriptions list payload carries no
 * profile/product/customer, so its normalized email/profile_id/product_* are
 * always null — and an upsert that includes them overwrites what the DETAIL
 * stage enriched (found live: 8,921/8,921 rows with an email in raw_detail had
 * a null email column, so the Cohorts active-subscription overlay matched
 * nothing). Enrichment columns are owned by the detail/profile stages only.
 */
export const LIST_STAGE_ENRICHMENT_COLUMNS = [
  "profile_id", "customer_id", "email", "normalized_email", "product_name", "product_id",
] as const;

export type SubscriptionListUpsertColumns = Omit<SubscriptionListColumns, (typeof LIST_STAGE_ENRICHMENT_COLUMNS)[number]>;

export function subscriptionListUpsertColumns(columns: SubscriptionListColumns): SubscriptionListUpsertColumns {
  const { profile_id: _p, customer_id: _c, email: _e, normalized_email: _n, product_name: _pn, product_id: _pi, ...rest } = columns;
  return rest;
}

/** The funnel alias FunnelFox attaches to a subscription DETAIL — byte-identical
 * to campaign_path elsewhere in the app (see funnelfox-funnels). The list
 * payload never carries it. */
export function funnelAliasFromSubscriptionRaw(raw: JsonRecord): string | null {
  const funnel = readRecord(raw.funnel);
  const alias = str(funnel.alias ?? funnel.slug ?? raw.funnel_alias);
  return alias || null;
}

/** Rows the daily full refresh re-opens for detail enrichment: only those that
 * never got a detail or still lack an email. Re-opening ALL rows every day made
 * the ~900-details-per-run budget chase 14.6k rows and never finish. */
export const FULL_RESET_DETAIL_REOPEN_FILTER = "raw_detail.is.null,normalized_email.is.null";

/**
 * A list row needs a /subscriptions/{id} detail call only when it is missing
 * fields details would supply. Fully-populated list rows skip enrichment.
 */
export function needsSubscriptionDetail(columns: SubscriptionListColumns): boolean {
  return (
    !columns.email ||
    !columns.profile_id ||
    !columns.product_name ||
    !columns.period_ends_at
  );
}

// ---- stale detail cards (2026-10-19) -----------------------------------------

/** A stored row as the list stage reads it: its card's status / renews come as
 * text (`raw_detail->>status`, `raw_detail->>renews`). */
export interface StoredDetailCard {
  subscription_id: string;
  detail_checked?: boolean | null;
  card_status?: string | null;
  card_renews?: string | boolean | null;
}

function flagOrNull(value: unknown): boolean | null {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return null;
}

/**
 * The detail card is a snapshot taken at the first fetch (about the trial
 * purchase); the list is re-crawled every day. The card is stale when the
 * list's status or renews flag no longer matches it (2026-10-19: 2,603 of
 * 16,725 cards, among them 1,411 cancels the card still showed as renewing).
 * A row without a card status (never fetched, or a stored 404 body) has
 * nothing to refresh, and an unknown value on either side is no difference.
 */
export function isDetailCardStale(
  list: { status: string | null; renews: boolean | null },
  card: Pick<StoredDetailCard, "card_status" | "card_renews">,
): boolean {
  const cardStatus = str(card.card_status).toLowerCase();
  if (!cardStatus) return false;
  const listStatus = str(list.status).toLowerCase();
  if (listStatus && listStatus !== cardStatus) return true;
  const cardRenews = flagOrNull(card.card_renews);
  return list.renews != null && cardRenews != null && list.renews !== cardRenews;
}

/** Ids of a list batch whose checked card is stale: the list stage re-opens
 * them (detail_checked = false) and the detail stage re-fetches them. New rows
 * and rows already queued are left alone. The list is crawled once per daily
 * cycle, so a card is re-fetched at most once a day even if FunnelFox's list
 * and card keep disagreeing. */
export function staleDetailCardIds(
  listRows: Array<{ subscription_id: string; status: string | null; renews: boolean | null }>,
  stored: StoredDetailCard[],
): string[] {
  const byId = new Map(stored.map((row) => [row.subscription_id, row]));
  const ids = new Set<string>();
  for (const row of listRows) {
    const card = byId.get(row.subscription_id);
    if (!card || card.detail_checked === false) continue;
    if (isDetailCardStale(row, card)) ids.add(row.subscription_id);
  }
  return Array.from(ids);
}

/**
 * The card a re-fetch stores. FunnelFox keeps the cancellation reason only
 * while the cancel is scheduled ("User requested cancellation", renewal off)
 * and drops it once the subscription is cancelled (2026-10-19: 582 scheduled
 * cards carry one, 0 of 12,556 cancelled ones do). A reason the stored card
 * had is kept when the fresh one has none — otherwise the refresh would turn
 * a user's own cancel at the period end into "auto". Only while the fresh card
 * still shows a cancel: a renewing card means the cancel was undone, and a
 * later cancel must not inherit the old reason.
 */
export function refreshedDetailCard(fresh: JsonRecord, priorReason: string | null | undefined): JsonRecord {
  const reason = str(priorReason);
  const showsCancel = str(fresh.status).toLowerCase().includes("cancel") || flagOrNull(fresh.renews) === false;
  if (!showsCancel || str(fresh.cancellation_reason) || !reason) return fresh;
  return { ...fresh, cancellation_reason: reason, cancellation_reason_source: "previous_card" };
}

export type DetailWrite = "store_card" | "keep_card" | "retry";

/** What a detail response does to the row. A 404/410 on a re-fetch keeps the
 * stored card (it holds the email, product, funnel and reason) and only marks
 * the row checked; a first fetch stores the body as before. Anything transient
 * leaves the row unchecked for the next run. */
export function detailWrite(kind: DetailOutcome, hadCard: boolean): DetailWrite {
  if (kind === "transient_unchecked") return "retry";
  if (kind === "gone_checked" && hadCard) return "keep_card";
  return "store_card";
}

export function countEmailCoverage(rows: Array<{ email?: string | null; normalized_email?: string | null }>): {
  withEmail: number;
  withoutEmail: number;
} {
  let withEmail = 0;
  for (const row of rows) {
    if (row.normalized_email ?? row.email) withEmail += 1;
  }
  return { withEmail, withoutEmail: rows.length - withEmail };
}

/** Unique profile_ids across candidate rows → each profile is fetched exactly once. */
export function uniqueProfileIds(rows: Array<{ profile_id?: string | null }>): string[] {
  const seen = new Set<string>();
  for (const row of rows) {
    const id = row.profile_id?.trim();
    if (id) seen.add(id);
  }
  return Array.from(seen);
}

// ---- crawling (injected fetchPage) -------------------------------------------

export interface CrawlPageResult {
  ok: boolean;
  rows: JsonRecord[];
  hasMore: boolean;
  nextCursor: string | null;
  totalReported: number | null;
  /** Short diagnostic for a failed page (HTTP status + upstream message). */
  errorMessage?: string | null;
}

export type FetchListPage = (cursor: string | undefined) => Promise<CrawlPageResult>;

export interface CrawlOutcome {
  rows: JsonRecord[];
  pages: number;
  lastCursor: string | null;
  hasMoreOnLastPage: boolean;
  stoppedReason: SyncStoppedReason;
  totalReported: number | null;
  /** Why the crawl stopped on api_error — persisted to sync_state.last_error
   * (it used to be written as null, leaving a failing tick undiagnosable). */
  apiErrorMessage: string | null;
}

export async function crawlList(
  fetchPage: FetchListPage,
  opts: { startCursor: string | undefined; maxPages: number; isExpired: () => boolean },
): Promise<CrawlOutcome> {
  const rows: JsonRecord[] = [];
  let cursor = opts.startCursor;
  let pages = 0;
  let lastCursor: string | null = opts.startCursor ?? null;
  let hasMoreOnLastPage = false;
  let apiError = false;
  let apiErrorMessage: string | null = null;
  let timedOut = false;
  let totalReported: number | null = null;

  while (pages < opts.maxPages) {
    if (opts.isExpired()) {
      timedOut = true;
      break;
    }
    const page = await fetchPage(cursor);
    if (!page.ok) { apiError = true; apiErrorMessage = page.errorMessage ?? "FunnelFox API returned a non-2xx response."; break; }
    pages += 1;
    rows.push(...page.rows);
    hasMoreOnLastPage = page.hasMore;
    totalReported = page.totalReported ?? totalReported;
    if (!page.hasMore || !page.nextCursor) {
      lastCursor = page.nextCursor ?? null;
      cursor = page.nextCursor ?? undefined;
      // has_more true but no next_cursor is a terminal API quirk, not "more".
      if (!page.nextCursor) hasMoreOnLastPage = false;
      break;
    }
    cursor = page.nextCursor;
    lastCursor = page.nextCursor;
  }

  return {
    rows,
    pages,
    lastCursor,
    hasMoreOnLastPage,
    stoppedReason: determineStopReason({ pages, maxPages: opts.maxPages, hasMoreOnLastPage, timedOut, apiError }),
    apiErrorMessage: apiError ? apiErrorMessage : null,
    totalReported,
  };
}

// ---- concurrency-limited enrichment (injected fetchOne) ----------------------

export type DetailOutcome = "checked" | "gone_checked" | "transient_unchecked";

// Only 404/410 are terminal "checked, nothing there". Every other failure is
// transient → leave the row unchecked so a later run retries it.
export function detailOutcome(ok: boolean, status: number): DetailOutcome {
  if (ok) return "checked";
  if (status === 404 || status === 410) return "gone_checked";
  return "transient_unchecked";
}

export interface EnrichItem {
  id: string;
}

export interface EnrichResult<T> {
  attempted: number;
  fetched: number;
  failed: number;
  gone: number;
  timeoutSkipped: number;
  /** A 429 stopped the pool; the items not attempted count as timeoutSkipped. */
  rateLimited: boolean;
  values: Array<{ id: string; ok: boolean; status: number; value: T | null }>;
}

export async function enrichPool<T>(
  items: EnrichItem[],
  opts: {
    concurrency: number;
    isExpired: () => boolean;
    fetchOne: (id: string) => Promise<{ ok: boolean; status: number; value: T | null }>;
  },
): Promise<EnrichResult<T>> {
  const result: EnrichResult<T> = { attempted: 0, fetched: 0, failed: 0, gone: 0, timeoutSkipped: 0, rateLimited: false, values: [] };
  let index = 0;

  const worker = async () => {
    while (index < items.length) {
      if (opts.isExpired() || result.rateLimited) return;
      const current = items[index];
      index += 1;
      result.attempted += 1;
      try {
        const outcome = await opts.fetchOne(current.id);
        result.values.push({ id: current.id, ...outcome });
        if (outcome.status === 429) result.rateLimited = true;
        const kind = detailOutcome(outcome.ok, outcome.status);
        if (kind === "checked") result.fetched += 1;
        else if (kind === "gone_checked") result.gone += 1;
        else result.failed += 1;
      } catch {
        result.failed += 1;
        result.values.push({ id: current.id, ok: false, status: 0, value: null });
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(opts.concurrency, items.length)) }, () => worker()),
  );
  result.timeoutSkipped = Math.max(0, items.length - index);
  return result;
}

// ---- driver control ----------------------------------------------------------

export interface SubscriptionSyncResponse {
  status: "ok" | "partial" | "error";
  all_stages_completed: boolean;
  made_progress: boolean;
  dry_run?: boolean;
}

// Continue the multi-call driver until: error, all stages done, no progress, or dry run.
export function shouldContinueSubscriptionSync(response: SubscriptionSyncResponse): boolean {
  if (response.dry_run) return false;
  if (response.status === "error") return false;
  if (response.all_stages_completed) return false;
  if (!response.made_progress) return false;
  return true;
}

// ---- integrity / parity check (Phase 4/5) -----------------------------------

export type ParityCheck = "pass" | "fail" | "unknown";

/**
 * Automatic integrity check: after all stages complete, the number of stored
 * subscriptions must equal FunnelFox's own reported total. Returns "unknown"
 * until the sync is fully finished (partial runs cannot be compared).
 */
export function parityCheck(
  storedTotal: number | null | undefined,
  reportedTotal: number | null | undefined,
  allStagesCompleted: boolean,
): ParityCheck {
  if (!allStagesCompleted) return "unknown";
  if (typeof storedTotal !== "number" || typeof reportedTotal !== "number") return "unknown";
  return storedTotal === reportedTotal ? "pass" : "fail";
}

/**
 * Final persisted sync status. A fully-finished sync whose stored count does not
 * match FunnelFox is surfaced as "completed_with_inconsistencies" (not "completed"),
 * so a silent under-count can never masquerade as success.
 */
export function finalSyncStatus(
  allStagesCompleted: boolean,
  baseStatus: "ok" | "partial" | "error",
  parity: ParityCheck,
): "completed" | "completed_with_inconsistencies" | "partial" | "failed" {
  if (baseStatus === "error") return "failed";
  if (!allStagesCompleted) return "partial";
  return parity === "fail" ? "completed_with_inconsistencies" : "completed";
}
