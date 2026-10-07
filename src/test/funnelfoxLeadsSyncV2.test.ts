// FunnelFox Leads sync v2 (plan §2 A1/A2/A3 + the 2026-10-06 addendum): emails come ONLY from the
// profile LIST row, only profiles with an email are stored, /profiles/{id} is never called, the
// reconcile is the SQL RPC, cron-driven with a lease, a 429 backoff and 10-page checkpoints.
//
// Part 1 tests the pure helpers in src/services/funnelfoxLeadsTransform.ts. Part 2 runs the REAL
// Edge handler (supabase/functions/funnelfox-leads-sync/index.ts — serveWithAccess is mocked to
// capture it) against an in-memory supabase-js fake and a fake FunnelFox API, so the Deno mirror is
// held to the same behaviour.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CURSOR_RESET_AFTER_ERRORS,
  DEFAULT_RETRY_AFTER_SECONDS,
  ERROR_BACKOFF_MAX_SECONDS,
  FLUSH_EVERY_PAGES,
  MAX_RETRY_AFTER_SECONDS,
  addProfileScan,
  collectEmailPaths,
  crawlList,
  detectListOrder,
  errorBackoffSeconds,
  groupRowsByKeySet,
  idForms,
  normalizeProfileId,
  parseProfileListRow,
  parseRetryAfterSeconds,
  planRun,
  rateLimitHeaderNames,
  readErrorBackoffUntilMs,
  readNextCursor,
  readPassCounters,
  readRateLimitedUntilMs,
  resolveIntParam,
  scanProfileRows,
  summarizeProfileSample,
  summarizeSessionSample,
  ulidIso,
  ulidTimestampMs,
  type CrawlPageResult,
  type StageCompletion,
} from "@/services/funnelfoxLeadsTransform";
import { FunnelFoxEdgeError } from "../../supabase/functions/_shared/funnelfox.ts";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function ulidFor(ms: number, suffix = "ABCDEFGHJKMNPQRS"): string {
  let head = "";
  let n = ms;
  for (let i = 0; i < 10; i += 1) {
    head = CROCKFORD[n % 32] + head;
    n = Math.floor(n / 32);
  }
  return head + suffix;
}

const NONE_DONE: StageCompletion = { profiles_completed: false, sessions_completed: false, reconcile_completed: false };
const ALL_DONE: StageCompletion = { profiles_completed: true, sessions_completed: true, reconcile_completed: true };

// =============================================================================================
// Part 1 — pure helpers
// =============================================================================================

describe("resolveIntParam: a missing parameter uses the default (the 1-profile-per-call bug)", () => {
  it("undefined / null / '' fall back; numbers and numeric strings are clamped", () => {
    // What the old page sent: JSON.stringify dropped limit/max_pages, so the Edge read
    // url.searchParams.get() === null — Number(null) === 0 was clamped up to 1.
    expect(resolveIntParam(undefined, 100, 1, 500)).toBe(100);
    expect(resolveIntParam(null, 200, 1, 1000)).toBe(200);
    expect(resolveIntParam("", 200, 1, 1000)).toBe(200);
    expect(resolveIntParam("abc", 200, 1, 1000)).toBe(200);
    expect(resolveIntParam(0, 100, 1, 500)).toBe(1);
    expect(resolveIntParam("50", 100, 1, 500)).toBe(50);
    expect(resolveIntParam(9999, 100, 1, 500)).toBe(500);
    expect(resolveIntParam(12.9, 100, 1, 500)).toBe(12);
  });
});

describe("readNextCursor: pagination.cursor ?? pagination.next_cursor, never the same cursor twice", () => {
  it("reads FunnelFox's `cursor` key, falls back to `next_cursor`", () => {
    expect(readNextCursor({ cursor: "abc", has_more: true })).toEqual({ cursor: "abc", key: "cursor", stuck: false });
    expect(readNextCursor({ next_cursor: "def", has_more: true })).toEqual({ cursor: "def", key: "next_cursor", stuck: false });
    expect(readNextCursor({ cursor: "", next_cursor: "def" })).toEqual({ cursor: "def", key: "next_cursor", stuck: false });
    expect(readNextCursor({ cursor: 42 })).toEqual({ cursor: null, key: null, stuck: false });
    expect(readNextCursor({})).toEqual({ cursor: null, key: null, stuck: false });
  });

  it("skips a cursor equal to the one the page was requested with (it would loop on one page)", () => {
    expect(readNextCursor({ cursor: "same", next_cursor: "next" }, "same")).toEqual({ cursor: "next", key: "next_cursor", stuck: false });
    expect(readNextCursor({ cursor: "same" }, "same")).toEqual({ cursor: null, key: null, stuck: true });
  });
});

describe("profile ids + ULID timestamps", () => {
  it("normalizeProfileId strips a pro_ prefix (the funnelfox_subscriptions form)", () => {
    expect(normalizeProfileId("pro_01ABC")).toBe("01ABC");
    expect(normalizeProfileId("PRO_01ABC")).toBe("01ABC");
    expect(normalizeProfileId(" 01ABC ")).toBe("01ABC");
    expect(normalizeProfileId(null)).toBe("");
  });

  it("decodes the ULID time; non-ULID ids give null; created_at falls back to it", () => {
    const ms = Date.UTC(2026, 9, 6, 12, 30, 0);
    const id = ulidFor(ms);
    expect(ulidTimestampMs(id)).toBe(ms);
    expect(ulidTimestampMs(`pro_${id}`)).toBe(ms);
    expect(ulidTimestampMs(id.toLowerCase())).toBe(ms);
    expect(ulidIso(id)).toBe(new Date(ms).toISOString());
    expect(ulidTimestampMs("P00001")).toBeNull();
    expect(ulidTimestampMs("ZZZZZZZZZZZZZZZZZZZZZZZZZZ")).toBeNull(); // out of the plausible window
    expect(parseProfileListRow({ id: id }).created_at).toBe(new Date(ms).toISOString());
    expect(parseProfileListRow({ id: id, created_at: "2026-01-01T00:00:00Z" }).created_at).toBe("2026-01-01T00:00:00Z");
  });
});

describe("scanProfileRows + pass counters", () => {
  it("dedupes ids within a batch, stores only rows with an email, counts preview and the rest", () => {
    const scan = scanProfileRows([
      { id: "pro_A", email: "a@x.com", preview: true },
      { id: "A", email: "dup@x.com" }, // same bare id → duplicate
      { id: "B", preview: true },
      { id: "C", email: "c@x.com", preview: false },
      { id: "", email: "noid@x.com" },
    ]);
    expect(scan.store.map((p) => [p.profile_id, p.normalized_email, p.preview])).toEqual([
      ["A", "a@x.com", true],
      ["C", "c@x.com", false],
    ]);
    expect(scan).toMatchObject({ scanned: 3, with_email: 2, without_email: 1, preview: 2, preview_with_email: 1, skipped_no_profile_id: 1, duplicates: 1 });
  });

  it("counters accumulate across batches and restart at zero on a reset", () => {
    const counters = readPassCounters({ profiles_scanned_total: 10, profiles_with_email: 3, preview_excluded: 1 }, false);
    addProfileScan(counters, scanProfileRows([{ id: "x", email: "x@y.com" }, { id: "y" }]));
    expect(counters).toMatchObject({ profiles_scanned_total: 12, profiles_with_email: 4, profiles_without_email: 1, preview_excluded: 1 });
    expect(Object.values(readPassCounters({ profiles_scanned_total: 10 }, true)).every((value) => value === 0)).toBe(true);
    expect(readPassCounters(null, false).profiles_scanned_total).toBe(0);
  });
});

describe("groupRowsByKeySet: a bulk upsert never NULLs a key some rows lack", () => {
  it("splits rows by their exact key set, keeping order inside each group", () => {
    const groups = groupRowsByKeySet([
      { profile_id: "a", funnel_id: "f" },
      { profile_id: "b" },
      { funnel_id: "g", profile_id: "c" },
    ]);
    expect(groups).toEqual([[{ profile_id: "a", funnel_id: "f" }, { funnel_id: "g", profile_id: "c" }], [{ profile_id: "b" }]]);
  });
});

describe("parseRetryAfterSeconds + rate_limited_until", () => {
  const now = Date.UTC(2026, 9, 6, 12, 0, 0);
  it("reads delta seconds or an HTTP date, clamps, defaults to 60s", () => {
    expect(parseRetryAfterSeconds("120", now)).toBe(120);
    expect(parseRetryAfterSeconds("1.2", now)).toBe(2);
    expect(parseRetryAfterSeconds(new Date(now + 90_000).toUTCString(), now)).toBe(90);
    expect(parseRetryAfterSeconds("0", now)).toBe(1);
    expect(parseRetryAfterSeconds("999999", now)).toBe(MAX_RETRY_AFTER_SECONDS);
    expect(parseRetryAfterSeconds(null, now)).toBe(DEFAULT_RETRY_AFTER_SECONDS);
    expect(parseRetryAfterSeconds("soon", now)).toBe(DEFAULT_RETRY_AFTER_SECONDS);
    expect(DEFAULT_RETRY_AFTER_SECONDS).toBe(60);
  });

  it("readRateLimitedUntilMs reads stats.rate_limited_until", () => {
    expect(readRateLimitedUntilMs({ rate_limited_until: "2026-10-06T12:01:00.000Z" })).toBe(Date.UTC(2026, 9, 6, 12, 1, 0));
    expect(readRateLimitedUntilMs({ rate_limited_until: null })).toBeNull();
    expect(readRateLimitedUntilMs(null)).toBeNull();
  });

  it("the error backoff doubles from 60s per consecutive FunnelFox error, capped at an hour", () => {
    expect([1, 2, 3, 4, 6, 7, 50].map(errorBackoffSeconds)).toEqual([60, 120, 240, 480, 1920, 3600, 3600]);
    expect(ERROR_BACKOFF_MAX_SECONDS).toBe(3600);
    expect(errorBackoffSeconds(0)).toBe(60);
    expect(errorBackoffSeconds(Number.NaN)).toBe(60);
    expect(readErrorBackoffUntilMs({ error_backoff_until: "2026-10-06T12:01:00.000Z" })).toBe(Date.UTC(2026, 9, 6, 12, 1, 0));
    expect(readErrorBackoffUntilMs({})).toBeNull();
  });
});

describe("planRun: idle no-op, 429 park, cron refresh never restarts a running backfill", () => {
  const now = Date.UTC(2026, 9, 6, 12, 0, 0);
  const plan = (over: Partial<Parameters<typeof planRun>[0]>) =>
    planRun({ flags: NONE_DONE, requestedStage: null, fullReset: false, cron: false, rateLimitedUntilMs: null, nowMs: now, ...over });

  it("runs the next incomplete stage; idle once everything is complete", () => {
    expect(plan({})).toEqual({ kind: "run", stage: "profiles", reset: false });
    expect(plan({ flags: { ...NONE_DONE, profiles_completed: true } })).toEqual({ kind: "run", stage: "sessions", reset: false });
    expect(plan({ flags: ALL_DONE })).toEqual({ kind: "idle" });
    expect(plan({ flags: ALL_DONE, cron: true })).toEqual({ kind: "idle" });
    // An explicit stage still runs on a complete pipeline.
    expect(plan({ flags: ALL_DONE, requestedStage: "reconcile" })).toEqual({ kind: "run", stage: "reconcile", reset: false });
  });

  it("a user reset always restarts; a cron reset restarts only a complete pipeline", () => {
    const midway = { ...NONE_DONE, profiles_completed: true };
    expect(plan({ flags: midway, fullReset: true })).toEqual({ kind: "run", stage: "profiles", reset: true });
    expect(plan({ flags: midway, fullReset: true, cron: true })).toEqual({ kind: "run", stage: "sessions", reset: false });
    expect(plan({ flags: ALL_DONE, fullReset: true, cron: true })).toEqual({ kind: "run", stage: "profiles", reset: true });
  });

  it("a running 429 backoff parks every run (resets included); an expired one does not", () => {
    expect(plan({ rateLimitedUntilMs: now + 30_000 })).toEqual({ kind: "rate_limited", until: new Date(now + 30_000).toISOString(), stage: "profiles" });
    expect(plan({ rateLimitedUntilMs: now + 30_000, fullReset: true }).kind).toBe("rate_limited");
    expect(plan({ rateLimitedUntilMs: now - 1 })).toEqual({ kind: "run", stage: "profiles", reset: false });
    // Idle wins over a stale backoff: a complete pipeline answers idle.
    expect(plan({ flags: ALL_DONE, rateLimitedUntilMs: now + 30_000 })).toEqual({ kind: "idle" });
  });

  it("a cron reset restarts an unfinished pipeline whose last run failed (a stuck cursor cannot stall it for good)", () => {
    const midway = { ...NONE_DONE, profiles_completed: true };
    expect(plan({ flags: midway, fullReset: true, cron: true, lastStatus: "error" })).toEqual({ kind: "run", stage: "profiles", reset: true });
    for (const lastStatus of ["partial", "ok", null]) {
      expect(plan({ flags: midway, fullReset: true, cron: true, lastStatus }), String(lastStatus)).toEqual({ kind: "run", stage: "sessions", reset: false });
    }
  });

  it("after FunnelFox errors the cron backs off; a user click and a reset are not held back", () => {
    const until = now + 120_000;
    expect(plan({ cron: true, errorBackoffUntilMs: until, lastStatus: "error" })).toEqual({ kind: "error_backoff", until: new Date(until).toISOString(), stage: "profiles" });
    expect(plan({ cron: false, errorBackoffUntilMs: until, lastStatus: "error" })).toEqual({ kind: "run", stage: "profiles", reset: false });
    expect(plan({ cron: true, fullReset: true, errorBackoffUntilMs: until, lastStatus: "error" })).toEqual({ kind: "run", stage: "profiles", reset: true });
    expect(plan({ cron: true, errorBackoffUntilMs: now - 1 })).toEqual({ kind: "run", stage: "profiles", reset: false });
    // A 429 pause still wins over everything.
    expect(plan({ cron: true, fullReset: true, lastStatus: "error", rateLimitedUntilMs: until }).kind).toBe("rate_limited");
  });
});

describe("crawlList: checkpoints every N pages, 429, stuck cursor", () => {
  const pager = (total: number, perPage = 1) => {
    const seen: Array<string | undefined> = [];
    const fetchPage = async (cursor: string | undefined): Promise<CrawlPageResult> => {
      seen.push(cursor);
      const offset = cursor ? Number(cursor.slice(1)) : 0;
      const next = offset + perPage;
      return {
        ok: true,
        status: 200,
        rows: Array.from({ length: Math.min(perPage, total - offset) }, (_, i) => ({ id: `p${offset + i}` })),
        hasMore: next < total,
        nextCursor: next < total ? `c${next}` : null,
        cursorKey: "cursor",
        paginationKeys: ["cursor", "has_more"],
      };
    };
    return { fetchPage, seen };
  };

  it("hands rows + the resume cursor to onCheckpoint every flushEveryPages pages; the tail is returned", async () => {
    const { fetchPage } = pager(25);
    const checkpoints: Array<{ rows: number; cursor: string }> = [];
    const outcome = await crawlList(fetchPage, {
      maxPages: 200,
      isExpired: () => false,
      flushEveryPages: FLUSH_EVERY_PAGES,
      onCheckpoint: async (rows, cursor) => {
        checkpoints.push({ rows: rows.length, cursor });
      },
    });
    expect(FLUSH_EVERY_PAGES).toBe(10);
    expect(checkpoints).toEqual([
      { rows: 10, cursor: "c10" },
      { rows: 10, cursor: "c20" },
    ]);
    expect(outcome.rows).toHaveLength(5);
    expect(outcome).toMatchObject({ pages: 25, scannedRows: 25, checkpoints: 2, stoppedReason: "completed", cursorKey: "cursor", paginationKeys: ["cursor", "has_more"] });
  });

  it("no checkpoint at the last allowed page (the caller's final write owns it)", async () => {
    const { fetchPage } = pager(100);
    const cursors: string[] = [];
    const outcome = await crawlList(fetchPage, { maxPages: 20, isExpired: () => false, flushEveryPages: 10, onCheckpoint: async (_rows, cursor) => void cursors.push(cursor) });
    expect(cursors).toEqual(["c10"]);
    expect(outcome.stoppedReason).toBe("max_pages_reached");
    expect(outcome.lastCursor).toBe("c20");
    expect(outcome.rows).toHaveLength(10);
  });

  it("a 429 stops with rate_limited; other failures are api_error; both keep the failed page's cursor", async () => {
    const failing = (status: number) => async (cursor: string | undefined): Promise<CrawlPageResult> =>
      cursor === "c2"
        ? { ok: false, status, rows: [], hasMore: false, nextCursor: null, retryAfterSeconds: status === 429 ? 30 : null, errorMessage: `HTTP ${status}`, rateLimitHeaders: ["retry-after"] }
        : { ok: true, status: 200, rows: [{ id: cursor ?? "c0" }], hasMore: true, nextCursor: cursor ? `c${Number(cursor.slice(1)) + 1}` : "c1" };
    const limited = await crawlList(failing(429), { maxPages: 10, isExpired: () => false });
    expect(limited).toMatchObject({ pages: 2, stoppedReason: "rate_limited", retryAfterSeconds: 30, lastCursor: "c2", errorMessage: "HTTP 429", rateLimitHeaders: ["retry-after"] });
    const broken = await crawlList(failing(500), { maxPages: 10, isExpired: () => false });
    expect(broken).toMatchObject({ pages: 2, stoppedReason: "api_error", lastCursor: "c2", retryAfterSeconds: null });
  });

  it("has_more with a cursor that does not advance is an api_error, not a silent 'completed'", async () => {
    const outcome = await crawlList(
      async () => ({ ok: true, rows: [{ id: "x" }], hasMore: true, nextCursor: null, cursorStuck: true }),
      { startCursor: "same", maxPages: 10, isExpired: () => false },
    );
    expect(outcome.pages).toBe(1);
    expect(outcome.stoppedReason).toBe("api_error");
    expect(outcome.errorMessage).toMatch(/did not advance/);
    expect(outcome.lastCursor).toBe("same");
    expect(outcome.cursorRejected).toBe(true);
  });

  it("has_more with the next cursor under a key the sync does not read fails closed, naming the key names", async () => {
    const outcome = await crawlList(
      async (cursor) => ({ ok: true, rows: [{ id: cursor ?? "first" }], hasMore: true, nextCursor: null, paginationKeys: ["has_more", "next"] }),
      { startCursor: "c5", maxPages: 10, isExpired: () => false },
    );
    expect(outcome).toMatchObject({ pages: 1, stoppedReason: "api_error", hasMoreOnLastPage: true, lastCursor: "c5", cursorRejected: false });
    expect(outcome.rows).toEqual([{ id: "c5" }]); // the page's rows are kept
    expect(outcome.errorMessage).toBe("FunnelFox pagination has has_more=true but no recognised next cursor (pagination keys: has_more, next).");
  });

  it("cursorRejected: a 4xx that means 'bad cursor' on a resumed cursor — not a 5xx, an auth error or the first page", async () => {
    const failingWith = (status: number) => async (): Promise<CrawlPageResult> => ({ ok: false, status, rows: [], hasMore: false, nextCursor: null, errorMessage: `HTTP ${status}` });
    for (const status of [400, 404, 410, 422]) {
      expect((await crawlList(failingWith(status), { startCursor: "saved", maxPages: 5, isExpired: () => false })).cursorRejected, String(status)).toBe(true);
    }
    for (const status of [401, 403, 408, 500, 502, 0]) {
      expect((await crawlList(failingWith(status), { startCursor: "saved", maxPages: 5, isExpired: () => false })).cursorRejected, String(status)).toBe(false);
    }
    expect((await crawlList(failingWith(404), { maxPages: 5, isExpired: () => false })).cursorRejected).toBe(false);
    expect(CURSOR_RESET_AFTER_ERRORS).toBe(3);
  });
});

describe("diagnose helpers: key names and counts only", () => {
  const base = Date.UTC(2026, 9, 6);
  const rows = [
    { id: ulidFor(base - 0), created_at: new Date(base - 0).toISOString(), funnel_id: "f", preview: false, email: "Secret.Person@Example.com" },
    { id: `pro_${ulidFor(base - 60_000)}`, created_at: new Date(base - 60_000).toISOString(), funnel_id: "f", preview: true },
    { id: ulidFor(base - 120_000), created_at: new Date(base - 120_000).toISOString(), funnel_id: "f", preview: true, email: "other@example.org" },
  ];

  it("detects the list order from created_at (or ULID time)", () => {
    expect(detectListOrder(rows)).toBe("newest_first");
    expect(detectListOrder([...rows].reverse())).toBe("oldest_first");
    expect(detectListOrder([rows[1], rows[0], rows[2]])).toBe("mixed");
    expect(detectListOrder([rows[0]])).toBe("unknown");
    expect(detectListOrder(rows.map(({ id }) => ({ id })))).toBe("newest_first");
  });

  it("collectEmailPaths reports path names (arrays as []) including reply values, never values", () => {
    const paths = collectEmailPaths({ email: "a@b.co", replies: [{ value: "c@d.co" }, { answer: "nope" }], nested: { contact: { text: "e@f.co" } } });
    expect(paths.sort()).toEqual(["email", "nested.contact.text", "replies[].value"]);
  });

  it("summarizeProfileSample / summarizeSessionSample carry no email or id value", () => {
    const summary = summarizeProfileSample(rows);
    expect(summary).toMatchObject({
      rows: 3,
      with_email: 2,
      root_email: 2,
      without_email: 1,
      preview_true: 2,
      preview_with_email: 1,
      preview_types: { boolean: 3 },
      id_forms: { pro_prefixed: 1, bare: 2, missing: 0, ulid: 3 },
      created_at_present: 3,
      order: "newest_first",
      email_paths: ["email"],
      key_counts: { created_at: 3, email: 2, funnel_id: 3, id: 3, preview: 3 },
    });
    const sessions = summarizeSessionSample(
      [{ id: "s1", profile_id: `pro_${ulidFor(base)}`, created_at: new Date(base).toISOString() }, { id: "s2", created_at: new Date(base - 1).toISOString() }],
      new Set([ulidFor(base)]),
    );
    expect(sessions).toMatchObject({ rows: 2, with_profile_id: 1, matching_profile_sample: 1, profile_id_forms: { pro_prefixed: 1, missing: 1 }, order: "newest_first" });
    const text = JSON.stringify({ summary, sessions });
    expect(text).not.toContain("@");
    expect(text).not.toContain(ulidFor(base));
  });

  it("idForms + rateLimitHeaderNames", () => {
    expect(idForms(["pro_a", "b", "", null])).toEqual({ pro_prefixed: 1, bare: 1, missing: 2, ulid: 0 });
    const headers = new Headers({ "Retry-After": "5", "X-RateLimit-Remaining": "9", "Content-Type": "application/json" });
    expect(rateLimitHeaderNames(headers)).toEqual(["retry-after", "x-ratelimit-remaining"]);
    expect(rateLimitHeaderNames(undefined)).toEqual([]);
  });
});

// =============================================================================================
// Part 2 — the real Edge handler against an in-memory database and a fake FunnelFox
// =============================================================================================

type Row = Record<string, unknown>;
type Handler = (args: Record<string, unknown>) => Promise<unknown>;

const captured = vi.hoisted(() => ({ handler: null as null | ((args: Record<string, unknown>) => Promise<unknown>), policy: null as unknown, options: null as unknown }));

vi.mock("../../supabase/functions/_shared/clickhouse/http.ts", () => ({
  serveWithAccess: (policy: unknown, handler: (args: Record<string, unknown>) => Promise<unknown>, options: unknown) => {
    captured.handler = handler;
    captured.policy = policy;
    captured.options = options;
  },
}));

const DATA_KEY = "11111111-1111-4111-8111-111111111111";
const OWNER_CTX = { tenantKey: DATA_KEY, rawAccess: true, actor: { kind: "user" } };
const CRON_CTX = { tenantKey: DATA_KEY, rawAccess: false, actor: { kind: "cron" } };

const TABLE_DEFAULTS: Record<string, Row> = {
  funnelfox_leads: { is_lead: false, detail_checked: false, preview: false, has_successful_payment: false, has_active_subscription: false },
  funnelfox_leads_sync_state: { profiles_completed: false, details_completed: false, sessions_completed: false, reconcile_completed: false, profiles_scanned_total: 0, sessions_scanned_total: 0 },
};

interface Write {
  table: string;
  op: "upsert" | "update";
  payload: Row[];
}

/** Just enough of supabase-js for the function: from().select/eq/in/not/maybeSingle/upsert/update + rpc. */
class FakeDb {
  tables: Record<string, Row[]> = { funnelfox_leads: [], funnelfox_leads_sync_state: [] };
  writes: Write[] = [];
  rpcCalls: Array<{ name: string; args: Row }> = [];
  leaseFree = true;
  /** The held lease's token (the RPC answers it on acquire; only it releases the lease). */
  leaseToken: string | null = null;
  private leaseSeq = 0;
  failUpsert: ((table: string, rows: Row[]) => string | null) | null = null;
  reconcileResult: Row = { checked: 3, leads: 2, paid_excluded: 1, active_excluded: 0 };
  /** The inline funnelfox_leads_reconcile fails with this message (e.g. the 8 s statement timeout). */
  reconcileError: string | null = null;
  /**
   * funnelfox_leads_reconcile_request (migration 202610070001): "applied" = queued, and the last
   * applied run's summary is reconcileResult; "first" = queued, nothing applied yet; "missing" =
   * PostgREST's PGRST202 / 404 (migration not applied); or an explicit PostgREST answer.
   */
  reconcileRequest: "applied" | "first" | "missing" | { data?: unknown; error?: Row | null; status?: number } = "applied";
  /** Microsecond timestamps, as Postgres serializes timestamptz inside jsonb. */
  reconcileRequestedAt = "2026-10-06T12:00:00.123456+00:00";
  reconcileAppliedAt = "2026-10-06T11:58:30.5+00:00";

  from(table: string) {
    return new FakeQuery(this, table);
  }

  private reconcileRequestAnswer(args: Row) {
    const mode = this.reconcileRequest;
    if (mode === "missing") {
      return {
        data: null,
        error: { code: "PGRST202", message: "Could not find the function public.funnelfox_leads_reconcile_request(p_data_key) in the schema cache", details: null, hint: null },
        status: 404,
      };
    }
    if (typeof mode === "object") return { data: mode.data ?? null, error: mode.error ?? null, status: mode.status ?? (mode.error ? 400 : 200) };
    const row = this.tables.funnelfox_leads_sync_state.find((state) => state.auth_user_id === args.p_data_key);
    if (!row) return { data: { queued: false, requested_at: null, last_applied_at: null, last_summary: null }, error: null, status: 200 };
    row.reconcile_requested_at = this.reconcileRequestedAt;
    const applied = mode === "applied";
    return {
      data: {
        queued: true,
        requested_at: this.reconcileRequestedAt,
        last_applied_at: applied ? this.reconcileAppliedAt : null,
        last_summary: applied ? { ...this.reconcileResult, updated: 0, duration_ms: 41_000, applied_at: this.reconcileAppliedAt } : null,
      },
      error: null,
      status: 200,
    };
  }

  async rpc(name: string, args: Row) {
    this.rpcCalls.push({ name, args });
    if (name === "funnelfox_leads_acquire_lease") {
      if (!this.leaseFree) return { data: null, error: null };
      this.leaseFree = false;
      this.leaseSeq += 1;
      this.leaseToken = `lease-token-${this.leaseSeq}`;
      return { data: this.leaseToken, error: null };
    }
    if (name === "funnelfox_leads_release_lease") {
      if (args.p_token != null && args.p_token === this.leaseToken) {
        this.leaseFree = true;
        this.leaseToken = null;
      }
      return { data: null, error: null };
    }
    if (name === "funnelfox_leads_reconcile_request") return this.reconcileRequestAnswer(args);
    if (name === "funnelfox_leads_reconcile") {
      if (this.reconcileError) return { data: null, error: { code: "57014", message: this.reconcileError }, status: 500 };
      return { data: this.reconcileResult, error: null };
    }
    return { data: null, error: { message: `function public.${name} does not exist` } };
  }

  state(): Row {
    return this.tables.funnelfox_leads_sync_state[0];
  }
  leads(): Row[] {
    return this.tables.funnelfox_leads;
  }
  lead(profileId: string): Row | undefined {
    return this.leads().find((row) => row.profile_id === profileId);
  }
  stateWrites(): Write[] {
    return this.writes.filter((write) => write.table === "funnelfox_leads_sync_state");
  }
}

class FakeQuery implements PromiseLike<Record<string, unknown>> {
  private op: "select" | "upsert" | "update" = "select";
  private filters: Array<(row: Row) => boolean> = [];
  private payload: unknown = null;
  private conflict: string[] = [];
  private head = false;
  private counted = false;
  private single = false;

  constructor(private readonly db: FakeDb, private readonly table: string) {}

  select(_columns?: string, options?: { count?: string; head?: boolean }) {
    this.head = Boolean(options?.head);
    this.counted = Boolean(options?.count);
    return this;
  }
  eq(column: string, value: unknown) {
    this.filters.push((row) => row[column] === value);
    return this;
  }
  in(column: string, values: unknown[]) {
    const set = new Set(values);
    this.filters.push((row) => set.has(row[column]));
    return this;
  }
  not(column: string, operator: string, value: unknown) {
    if (operator !== "is") throw new Error(`unsupported not.${operator}`);
    this.filters.push((row) => (row[column] ?? null) !== value);
    return this;
  }
  maybeSingle() {
    this.single = true;
    return this;
  }
  upsert(rows: unknown, options?: { onConflict?: string }) {
    this.op = "upsert";
    this.payload = rows;
    this.conflict = String(options?.onConflict ?? "").split(",").map((key) => key.trim()).filter(Boolean);
    return this;
  }
  update(patch: Row) {
    this.op = "update";
    this.payload = patch;
    return this;
  }

  then<T1 = Record<string, unknown>, T2 = never>(
    onFulfilled?: ((value: Record<string, unknown>) => T1 | PromiseLike<T1>) | null,
    onRejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
  ): PromiseLike<T1 | T2> {
    return Promise.resolve().then(() => this.run()).then(onFulfilled, onRejected);
  }

  private run(): Record<string, unknown> {
    const rows = (this.db.tables[this.table] ??= []);
    if (this.op === "upsert") {
      const list = (Array.isArray(this.payload) ? this.payload : [this.payload]) as Row[];
      this.db.writes.push({ table: this.table, op: "upsert", payload: list });
      const failure = this.db.failUpsert?.(this.table, list);
      if (failure) return { data: null, error: { message: failure } };
      // supabase-js bulk upsert: a key missing from some rows is sent as NULL for them.
      const keys = [...new Set(list.flatMap((row) => Object.keys(row)))];
      const seen = new Set<string>();
      for (const input of list) {
        const filled: Row = Object.fromEntries(keys.map((key) => [key, key in input ? input[key] : null]));
        const conflictKey = this.conflict.map((key) => String(filled[key])).join("|");
        if (seen.has(conflictKey)) return { data: null, error: { message: "ON CONFLICT DO UPDATE command cannot affect row a second time" } };
        seen.add(conflictKey);
        const existing = rows.find((row) => this.conflict.every((key) => row[key] === filled[key]));
        if (existing) Object.assign(existing, filled);
        else rows.push({ ...TABLE_DEFAULTS[this.table], ...filled });
      }
      return { data: null, error: null };
    }
    const matched = rows.filter((row) => this.filters.every((filter) => filter(row)));
    if (this.op === "update") {
      this.db.writes.push({ table: this.table, op: "update", payload: [this.payload as Row] });
      for (const row of matched) Object.assign(row, this.payload as Row);
      return { data: null, error: null };
    }
    if (this.counted && this.head) return { data: null, count: matched.length, error: null };
    if (this.single) return { data: matched[0] ? { ...matched[0] } : null, error: null };
    return { data: matched.map((row) => ({ ...row })), error: null };
  }
}

interface FoxOptions {
  profiles?: Row[];
  sessions?: Row[];
  /** The pagination key the next cursor is sent under (the sync reads `cursor` / `next_cursor`). */
  cursorKey?: string;
  /** Respond with this status to the Nth call of a path (1-based). */
  failAt?: { path: "/profiles" | "/sessions"; call: number; status: number; retryAfter?: string };
  /** Answer every request carrying this cursor with this status (an expired / invalid cursor). */
  rejectCursor?: { cursor: string; status: number };
  /** Answer the Nth call of a path with this raw 200 body. */
  rawBodyAt?: { path: "/profiles" | "/sessions"; call: number; body: string };
}

function fakeFox(options: FoxOptions) {
  const calls: string[] = [];
  const perPath: Record<string, number> = {};
  const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push(`${url.pathname}${url.search}`);
    const path = url.pathname.replace(/^\/public\/v1/, "");
    if (path !== "/profiles" && path !== "/sessions") return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    perPath[path] = (perPath[path] ?? 0) + 1;
    const fail = options.failAt;
    if (fail && fail.path === path && fail.call === perPath[path]) {
      const headers: Record<string, string> = { "Content-Type": "application/json", "X-RateLimit-Limit": "100" };
      if (fail.retryAfter) headers["Retry-After"] = fail.retryAfter;
      return new Response(JSON.stringify({ message: fail.status === 429 ? "Too Many Requests" : "Upstream exploded" }), { status: fail.status, headers });
    }
    if (options.rejectCursor && url.searchParams.get("cursor") === options.rejectCursor.cursor) {
      return new Response(JSON.stringify({ message: "cursor expired" }), { status: options.rejectCursor.status, headers: { "Content-Type": "application/json" } });
    }
    const raw = options.rawBodyAt;
    if (raw && raw.path === path && raw.call === perPath[path]) return new Response(raw.body, { status: 200, headers: { "Content-Type": "text/html" } });
    const source = (path === "/profiles" ? options.profiles : options.sessions) ?? [];
    const limit = Number(url.searchParams.get("limit") ?? 10);
    const offset = Number((url.searchParams.get("cursor") ?? "c0").slice(1));
    const next = offset + limit;
    const hasMore = next < source.length;
    const body = { data: source.slice(offset, next), pagination: { [options.cursorKey ?? "cursor"]: hasMore ? `c${next}` : null, has_more: hasMore } };
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json", "X-RateLimit-Remaining": "99" } });
  });
  return { fetchMock, calls };
}

const BASE_MS = Date.UTC(2026, 9, 6, 12, 0, 0);
const isoAt = (minutesAgo: number) => new Date(BASE_MS - minutesAgo * 60_000).toISOString();

/** Newest first. Every 4th profile carries an email, every 10th is a preview run. */
function profileRows(count: number, idOf: (i: number) => string = (i) => `P${String(i).padStart(5, "0")}`): Row[] {
  return Array.from({ length: count }, (_, i) => {
    const row: Row = { id: idOf(i), created_at: isoAt(i), funnel_id: `fn_${i % 3}`, preview: i % 10 === 0 };
    if (i % 4 === 0) row.email = `Lead${i}@Example.com`;
    return row;
  });
}

async function invoke(db: FakeDb, options: { action?: string; body?: Row; ctx?: Row; query?: string } = {}) {
  const result = await (captured.handler as Handler)({
    ctx: options.ctx ?? OWNER_CTX,
    action: options.action ?? "sync",
    body: options.body ?? {},
    url: new URL(`https://edge.test/functions/v1/funnelfox-leads-sync${options.query ?? ""}`),
    req: new Request("https://edge.test/functions/v1/funnelfox-leads-sync", { method: "POST" }),
    pg: db,
    clickhouse: () => {
      throw new Error("the leads sync never opens a ClickHouse reader");
    },
  });
  if (result instanceof Response) return { status: result.status, body: JSON.parse(await result.text()) as Row };
  return { status: 200, body: result as Row };
}

/** A nested field of a JSON body (undefined when any step is missing). */
function field(value: unknown, ...path: string[]): unknown {
  return path.reduce<unknown>((current, key) => (current && typeof current === "object" ? (current as Row)[key] : undefined), value);
}

const leaseCalls = (db: FakeDb) => db.rpcCalls.filter((call) => call.name.includes("lease")).map((call) => call.name.replace("funnelfox_leads_", ""));

describe("Edge funnelfox-leads-sync handler (real code, fake I/O)", () => {
  beforeAll(async () => {
    // A string-typed specifier: vitest loads the Deno entry point at runtime (serveWithAccess is
    // mocked above), while `tsc -p tsconfig.app.json` does not pull the Deno-only module graph
    // (Deno globals, esm.sh imports) into the browser program.
    const edgeEntry: string = "../../supabase/functions/funnelfox-leads-sync/index.ts";
    await import(/* @vite-ignore */ edgeEntry);
    expect(captured.handler).toBeTypeOf("function");
    expect((captured.policy as { fn: string }).fn).toBe("funnelfox-leads-sync");
  });

  let env: Record<string, string | undefined>;
  beforeEach(() => {
    env = { FUNNELFOX_SECRET: "fox-secret" };
    vi.stubGlobal("Deno", { env: { get: (name: string) => env[name] } });
    vi.spyOn(console, "info").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("no limit / max_pages in the body: 100-row pages until has_more=false; only profiles with an email are stored", async () => {
    const fox = fakeFox({ profiles: profileRows(250) });
    vi.stubGlobal("fetch", fox.fetchMock);
    const db = new FakeDb();
    // Exactly what the old page sent (JSON.stringify drops undefined limit / max_pages).
    const { body } = await invoke(db, { body: { dry_run: false, full_reset: false } });

    expect(fox.calls).toEqual(["/public/v1/profiles?limit=100", "/public/v1/profiles?limit=100&cursor=c100", "/public/v1/profiles?limit=100&cursor=c200"]);
    expect(body).toMatchObject({ status: "partial", dry_run: false, stage: "profiles", next_stage: "sessions", all_stages_completed: false, made_progress: true, stopped_reason: "completed" });
    expect(body.summary).toMatchObject({
      profiles_scanned_total: 250,
      profiles_with_email: 63,
      profiles_without_email: 187,
      preview_excluded: 25,
      preview_with_email: 13,
      profiles_total_saved: 63,
      emails_found: 63,
      remaining_detail_unchecked: 0,
      rate_limited_until: null,
    });
    expect(field(body, "summary", "profiles_last_pass")).toMatchObject({ profiles_scanned_total: 250, profiles_with_email: 63 });

    expect(db.leads()).toHaveLength(63);
    expect(db.lead("P00000")).toMatchObject({
      auth_user_id: DATA_KEY,
      email: "Lead0@Example.com",
      normalized_email: "lead0@example.com",
      email_source: "list",
      detail_checked: true,
      preview: true,
      funnel_id: "fn_0",
      created_at: isoAt(0),
      is_lead: false, // the DB default; the profiles stage never writes conversion state
    });
    for (const row of db.leads()) {
      for (const key of ["raw_profile_list", "raw_profile_detail", "raw_session", "has_successful_payment"]) {
        if (key === "has_successful_payment") expect(row[key]).toBe(false);
        else expect(row).not.toHaveProperty(key);
      }
    }
    expect(db.state()).toMatchObject({
      auth_user_id: DATA_KEY,
      profiles_completed: true,
      details_completed: true,
      sessions_completed: false,
      reconcile_completed: false,
      last_profiles_cursor: null,
      profiles_scanned_total: 250,
      current_stage: "sessions",
      last_status: "partial",
      last_error: null,
    });
    // Never the detail endpoint; the lease was taken and given back with its own token.
    expect(fox.calls.some((call) => /\/profiles\/[^?]/.test(call))).toBe(false);
    expect(leaseCalls(db)).toEqual(["acquire_lease", "release_lease"]);
    expect(db.rpcCalls[0].args).toEqual({ p_data_key: DATA_KEY, p_seconds: 120 });
    expect(db.rpcCalls[1].args).toEqual({ p_data_key: DATA_KEY, p_token: "lease-token-1" });
    expect(db.leaseFree).toBe(true);
    // Every FunnelFox page carries an abort signal (the page timeout).
    for (const [, init] of fox.fetchMock.mock.calls) expect(init?.signal).toBeDefined();
    expect(body.summary).toMatchObject({ consecutive_api_errors: 0, error_backoff_until: null, cursor_reset: false });
  });

  it("checkpoints rows + cursor every 10 pages, so a killed call loses at most 10 pages", async () => {
    const fox = fakeFox({ profiles: profileRows(250) });
    vi.stubGlobal("fetch", fox.fetchMock);
    const db = new FakeDb();
    await invoke(db, { body: { limit: 10 } });
    expect(fox.calls).toHaveLength(25);
    const checkpoints = db.stateWrites().filter((write) => write.op === "update").map((write) => write.payload[0]);
    expect(checkpoints.map((patch) => [patch.last_profiles_cursor, patch.profiles_scanned_total])).toEqual([
      ["c100", 100],
      ["c200", 200],
    ]);
    expect((checkpoints[0].stats as Row).profiles_with_email).toBe(25);
    // Rows of the first 10 pages were written before the first checkpoint.
    const firstCheckpoint = db.writes.findIndex((write) => write.table === "funnelfox_leads_sync_state" && write.op === "update");
    const leadsBefore = db.writes.slice(0, firstCheckpoint).filter((write) => write.table === "funnelfox_leads").flatMap((write) => write.payload);
    expect(leadsBefore).toHaveLength(25);
  });

  it("reads `next_cursor` too, stores bare ids, and an explicit max_pages stops with max_pages_reached + the cursor", async () => {
    const fox = fakeFox({ profiles: profileRows(50, (i) => `pro_X${i}`), cursorKey: "next_cursor" });
    vi.stubGlobal("fetch", fox.fetchMock);
    const db = new FakeDb();
    const { body } = await invoke(db, { body: { limit: 10, max_pages: 2 } });
    expect(fox.calls).toEqual(["/public/v1/profiles?limit=10", "/public/v1/profiles?limit=10&cursor=c10"]);
    expect(body).toMatchObject({ status: "partial", stopped_reason: "max_pages_reached", coverage_warning: true, made_progress: true });
    expect(db.state()).toMatchObject({ profiles_completed: false, last_profiles_cursor: "c20" });
    expect(db.leads().map((row) => row.profile_id)).toEqual(["X0", "X4", "X8", "X12", "X16"]);
    // The next call resumes from the saved cursor.
    await invoke(db, { body: { limit: 10, max_pages: 2 } });
    expect(fox.calls[2]).toBe("/public/v1/profiles?limit=10&cursor=c20");
  });

  it("profiles → sessions → reconcile: attribution only for stored profiles, earliest wins, reconcile is the SQL RPC", async () => {
    const profiles = profileRows(12); // emails on P00000, P00004, P00008
    const sessions: Row[] = [
      { id: "s_late", profile_id: "pro_P00000", created_at: isoAt(-30), origin: "https://lp.example.com/x?utm_source=4&utm_campaign=late", country: "us" },
      { id: "s_early", profile_id: "P00000", created_at: isoAt(-5), origin: "https://lp.example.com/x?utm_source=19&utm_campaign=early&campaign_id=c9", country: "de", user_agent: "UA", funnel_id: "fn_session" },
      { id: "s_noemail", profile_id: "P00001", created_at: isoAt(-5), origin: "https://lp.example.com/y?utm_source=22" },
      { id: "s_orphan", created_at: isoAt(-5) },
      { id: "s_p4", profile_id: "P00004", created_at: isoAt(-4), origin: "utm_source=22&utm_content=ad1" },
    ];
    const fox = fakeFox({ profiles, sessions });
    vi.stubGlobal("fetch", fox.fetchMock);
    const db = new FakeDb();
    // A stored profile whose funnel_id came earlier must not be nulled by a list row without one.
    profiles[8] = { ...profiles[8] };
    delete profiles[8].funnel_id;
    db.tables.funnelfox_leads.push({
      ...TABLE_DEFAULTS.funnelfox_leads,
      auth_user_id: DATA_KEY,
      profile_id: "P00008",
      funnel_id: "fn_kept",
      email: "Lead8@Example.com",
      normalized_email: "lead8@example.com",
    });

    const first = await invoke(db, { body: { conversion: { paid_emails: ["lead0@example.com"] } } });
    expect(first.body.stage).toBe("profiles");
    expect(db.lead("P00008")?.funnel_id).toBe("fn_kept");

    const second = await invoke(db);
    expect(second.body).toMatchObject({ stage: "sessions", next_stage: "reconcile", status: "partial" });
    expect(second.body.summary).toMatchObject({ sessions_total_scanned_this_run: 5, sessions_matched_stored_profiles: 2, sessions_joined: 2, sessions_without_profile_id: 1 });
    expect(db.lead("P00000")).toMatchObject({
      session_id: "s_early",
      session_created_at: isoAt(-5),
      campaign_path: "early",
      campaign_id: "c9",
      utm_source: "19",
      media_buyer: "Artem A",
      country_code: "DE",
      user_agent: "UA",
      funnel_id: "fn_0", // the profile's funnel wins over the session's
    });
    expect(db.lead("P00004")).toMatchObject({ session_id: "s_p4", utm_source: "22", media_buyer: "Artem D", campaign_id: "ad1" });
    expect(db.lead("P00001")).toBeUndefined(); // no email → never stored, even with a session
    expect(db.leads().every((row) => !("raw_session" in row))).toBe(true);
    expect(db.state()).toMatchObject({ sessions_completed: true, last_sessions_cursor: null, sessions_scanned_total: 5 });

    const third = await invoke(db, { body: { conversion: { paid_emails: ["lead0@example.com"] } } });
    expect(third.body).toMatchObject({ status: "ok", stage: "reconcile", next_stage: null, all_stages_completed: true });
    expect(third.body.summary).toMatchObject({ reconcile_rows: 3, leads_found: 2, converted_excluded: 1, active_sub_excluded: 0 });
    // Queued for pg_cron (migration 202610070001), never run through PostgREST.
    expect(db.rpcCalls.find((call) => call.name === "funnelfox_leads_reconcile_request")?.args).toEqual({ p_data_key: DATA_KEY });
    expect(db.rpcCalls.some((call) => call.name === "funnelfox_leads_reconcile")).toBe(false);
    // The browser context is ignored: nothing but the RPC decides conversion.
    expect(db.leads().every((row) => row.is_lead === false && row.has_successful_payment === false)).toBe(true);
    expect(db.state()).toMatchObject({ reconcile_completed: true, last_status: "ok", current_stage: "reconcile" });
    expect(db.state().last_full_sync_at).toEqual(expect.any(String));
  });

  it("idle: a complete pipeline answers without a lease, a fetch or a write; an explicit stage still runs", async () => {
    const fox = fakeFox({ profiles: profileRows(4) });
    vi.stubGlobal("fetch", fox.fetchMock);
    const db = new FakeDb();
    db.tables.funnelfox_leads_sync_state.push({ auth_user_id: DATA_KEY, profiles_completed: true, sessions_completed: true, reconcile_completed: true, stats: { profiles_with_email: 7 } });

    for (const ctx of [OWNER_CTX, CRON_CTX]) {
      const { body } = await invoke(db, { ctx });
      expect(body).toMatchObject({ status: "ok", idle: true, made_progress: false, all_stages_completed: true, stage: null });
      expect(body.summary).toEqual({ profiles_with_email: 7 });
    }
    expect(fox.calls).toEqual([]);
    expect(db.writes).toEqual([]);
    expect(db.rpcCalls).toEqual([]);

    const explicit = await invoke(db, { body: { stage: "reconcile" } });
    expect(explicit.body).toMatchObject({ status: "ok", stage: "reconcile" });
    expect(leaseCalls(db)).toEqual(["acquire_lease", "release_lease"]);
  });

  describe("stage 3: the reconcile is queued for pg_cron (incident 2026-10-07)", () => {
    const READY: Row = { auth_user_id: DATA_KEY, profiles_completed: true, details_completed: true, sessions_completed: true, reconcile_completed: false };
    const nonLeaseCalls = (db: FakeDb) => db.rpcCalls.filter((call) => !call.name.includes("lease"));
    const readyDb = (stats: Row | null = null) => {
      const db = new FakeDb();
      db.tables.funnelfox_leads_sync_state.push({ ...TABLE_DEFAULTS.funnelfox_leads_sync_state, ...READY, last_status: "error", last_error: "reconcile failed: canceling statement due to statement timeout", stats });
      return db;
    };
    beforeEach(() => {
      vi.stubGlobal("fetch", fakeFox({}).fetchMock);
    });

    it("one request RPC (one row update), never the inline reconcile; the stage completes and stats carry the last applied run", async () => {
      const db = readyDb({ profiles_with_email: 7 });
      const { status, body } = await invoke(db);
      expect(status).toBe(200);
      expect(body).toMatchObject({ status: "ok", stage: "reconcile", next_stage: null, all_stages_completed: true, stopped_reason: "completed", made_progress: true });
      expect(nonLeaseCalls(db)).toEqual([{ name: "funnelfox_leads_reconcile_request", args: { p_data_key: DATA_KEY } }]);
      expect(body.summary).toMatchObject({
        profiles_with_email: 7,
        reconcile_queued_at: "2026-10-06T12:00:00.123Z",
        reconcile_rows: 3,
        leads_found: 2,
        converted_excluded: 1,
        active_sub_excluded: 0,
        reconciled_at: "2026-10-06T11:58:30.500Z",
        all_stages_completed: true,
      });
      expect(db.state()).toMatchObject({ reconcile_completed: true, last_status: "ok", last_error: null, current_stage: "reconcile" });
      expect(db.state().last_full_sync_at).toEqual(expect.any(String));
      // The Edge's state write never touches the queue column the request stamped.
      expect(db.state().reconcile_requested_at).toBe(db.reconcileRequestedAt);
      for (const write of db.stateWrites()) for (const payload of write.payload) expect(payload).not.toHaveProperty("reconcile_requested_at");
      expect(leaseCalls(db)).toEqual(["acquire_lease", "release_lease"]);
    });

    it("the first queued reconcile (nothing applied yet) completes and keeps the previous counts", async () => {
      const previous = { reconcile_rows: 20, leads_found: 11, converted_excluded: 4, active_sub_excluded: 1, reconciled_at: "2026-10-01T00:00:00.000Z" };
      const db = readyDb(previous);
      db.reconcileRequest = "first";
      const { body } = await invoke(db);
      expect(body).toMatchObject({ status: "ok", stage: "reconcile", all_stages_completed: true });
      expect(body.summary).toMatchObject({ ...previous, reconcile_queued_at: "2026-10-06T12:00:00.123Z" });
      expect(db.state()).toMatchObject({ reconcile_completed: true, last_status: "ok", last_error: null });

      // No previous counts either: none are invented.
      const fresh = readyDb(null);
      fresh.reconcileRequest = "first";
      const second = await invoke(fresh);
      expect(second.body.summary).toMatchObject({ reconcile_queued_at: "2026-10-06T12:00:00.123Z" });
      for (const key of ["reconcile_rows", "leads_found", "converted_excluded", "active_sub_excluded", "reconciled_at"]) {
        expect(second.body.summary as Row).not.toHaveProperty(key);
      }
    });

    it("the request RPC missing (migration 202610070001 not applied: PGRST202, 404 or the message) → the inline reconcile, exactly as before", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const shapes: Array<{ data?: unknown; error?: Row | null; status?: number } | "missing"> = [
        "missing",
        { error: { code: "PGRST202", message: "Could not find the function" }, status: 400 },
        { error: { message: "Not Found" }, status: 404 },
        { error: { code: "XX000", message: "Could not find the function public.funnelfox_leads_reconcile_request(p_data_key) in the schema cache" }, status: 400 },
      ];
      for (const shape of shapes) {
        const db = readyDb({ profiles_with_email: 7 });
        db.reconcileRequest = shape;
        const before = Date.now();
        const { status, body } = await invoke(db);
        expect(status, JSON.stringify(shape)).toBe(200);
        expect(nonLeaseCalls(db).map((call) => call.name)).toEqual(["funnelfox_leads_reconcile_request", "funnelfox_leads_reconcile"]);
        expect(nonLeaseCalls(db)[1].args).toEqual({ p_data_key: DATA_KEY });
        expect(body).toMatchObject({ status: "ok", stage: "reconcile", all_stages_completed: true });
        expect(body.summary).toMatchObject({ reconcile_rows: 3, leads_found: 2, converted_excluded: 1, active_sub_excluded: 0 });
        expect(Date.parse(String(field(body, "summary", "reconciled_at")))).toBeGreaterThanOrEqual(before - 1000);
        expect(body.summary as Row).not.toHaveProperty("reconcile_queued_at");
        expect(db.state()).toMatchObject({ reconcile_completed: true, last_status: "ok" });
      }
      expect(warn).toHaveBeenCalledTimes(shapes.length);
    });

    it("the inline fallback still fails the run on a reconcile error (as before)", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const db = readyDb();
      db.reconcileRequest = "missing";
      db.reconcileError = "canceling statement due to statement timeout";
      const { status, body } = await invoke(db);
      expect(status).toBe(502);
      expect(body).toEqual({ error: "FunnelFox leads sync failed.", detail: "reconcile failed: canceling statement due to statement timeout" });
      expect(db.state()).toMatchObject({ reconcile_completed: false, last_status: "error", last_error: "reconcile failed: canceling statement due to statement timeout" });
      expect(db.leaseFree).toBe(true);
    });

    it("any other request error (or nothing queued) fails the run without an inline reconcile", async () => {
      const cases: Array<{ answer: { data?: unknown; error?: Row | null; status?: number }; detail: string }> = [
        { answer: { error: { code: "57014", message: "canceling statement due to statement timeout" }, status: 500 }, detail: "reconcile request failed: canceling statement due to statement timeout" },
        { answer: { error: { code: "42501", message: "permission denied for function funnelfox_leads_reconcile_request" }, status: 403 }, detail: "reconcile request failed: permission denied for function funnelfox_leads_reconcile_request" },
        { answer: { data: { queued: false, requested_at: null, last_applied_at: null, last_summary: null } }, detail: "reconcile request failed: the sync state row to queue it on is missing." },
        { answer: { data: null }, detail: "reconcile request failed: the sync state row to queue it on is missing." },
      ];
      for (const { answer, detail } of cases) {
        const db = readyDb();
        db.reconcileRequest = answer;
        const { status, body } = await invoke(db);
        expect(status, detail).toBe(502);
        expect(body).toEqual({ error: "FunnelFox leads sync failed.", detail });
        expect(nonLeaseCalls(db).map((call) => call.name)).toEqual(["funnelfox_leads_reconcile_request"]);
        expect(db.state()).toMatchObject({ reconcile_completed: false, last_status: "error", last_error: detail });
        expect(db.leaseFree).toBe(true);
      }
      // The cron gets the gate-mapped error.
      const cron = readyDb();
      cron.reconcileRequest = cases[0].answer;
      await expect(invoke(cron, { ctx: CRON_CTX })).rejects.toBeInstanceOf(FunnelFoxEdgeError);
    });
  });

  it("busy: another call holds the lease → no fetch, no write", async () => {
    const fox = fakeFox({ profiles: profileRows(4) });
    vi.stubGlobal("fetch", fox.fetchMock);
    const db = new FakeDb();
    db.leaseFree = false;
    const { body } = await invoke(db);
    expect(body).toMatchObject({ status: "busy", busy: true, made_progress: false, stage: "profiles", all_stages_completed: false });
    expect(fox.calls).toEqual([]);
    expect(db.writes).toEqual([]);
    expect(leaseCalls(db)).toEqual(["acquire_lease"]);
  });

  it("a 429 parks the pipeline until Retry-After; pages before it are kept; the next tick resumes from the refused page", async () => {
    const fox = fakeFox({ profiles: profileRows(300), failAt: { path: "/profiles", call: 3, status: 429, retryAfter: "120" } });
    vi.stubGlobal("fetch", fox.fetchMock);
    const db = new FakeDb();
    const before = Date.now();
    const { body } = await invoke(db);
    expect(body).toMatchObject({ status: "partial", stopped_reason: "rate_limited", rate_limited: true, made_progress: true, coverage_warning: true });
    const until = Date.parse(String(body.rate_limited_until));
    expect(until).toBeGreaterThanOrEqual(before + 120_000);
    expect(until).toBeLessThan(Date.now() + 121_000);
    expect(db.state()).toMatchObject({ last_profiles_cursor: "c200", profiles_completed: false, last_status: "partial" });
    expect(String(db.state().last_error)).toContain("HTTP 429");
    expect((db.state().stats as Row).rate_limited_until).toBe(body.rate_limited_until);
    expect(db.leads()).toHaveLength(50);

    // Parked: no lease, no fetch, no write — for the cron tick and the button alike.
    const writesBefore = db.writes.length;
    const callsBefore = fox.calls.length;
    for (const ctx of [CRON_CTX, OWNER_CTX]) {
      const parked = await invoke(db, { ctx });
      expect(parked.body).toMatchObject({ status: "partial", rate_limited: true, made_progress: false, stopped_reason: "rate_limited", rate_limited_until: body.rate_limited_until });
    }
    expect(db.writes.length).toBe(writesBefore);
    expect(fox.calls.length).toBe(callsBefore);

    // Backoff over → resumes from the refused page and clears the marker.
    (db.state().stats as Row).rate_limited_until = new Date(Date.now() - 1000).toISOString();
    const resumed = await invoke(db, { ctx: CRON_CTX });
    expect(fox.calls[callsBefore]).toBe("/public/v1/profiles?limit=100&cursor=c200");
    expect(resumed.body).toMatchObject({ status: "partial", stopped_reason: "completed", rate_limited: false, rate_limited_until: null });
    expect(db.state()).toMatchObject({ profiles_completed: true, last_error: null });
    expect(db.leads()).toHaveLength(75);
  });

  it("a non-429 upstream error is status error with last_error; the cursor stays on the failed page", async () => {
    const fox = fakeFox({ profiles: profileRows(300), failAt: { path: "/profiles", call: 2, status: 500 } });
    vi.stubGlobal("fetch", fox.fetchMock);
    const db = new FakeDb();
    const before = Date.now();
    const { status, body } = await invoke(db);
    expect(status).toBe(200);
    expect(body).toMatchObject({ status: "error", stopped_reason: "api_error", made_progress: true });
    expect(db.state()).toMatchObject({ last_profiles_cursor: "c100", profiles_completed: false, last_status: "error" });
    expect(String(db.state().last_error)).toContain("HTTP 500");
    expect(db.leads()).toHaveLength(25);
    // The cron backs off for 60s after the first error; a server error never drops the cursor.
    const stats = db.state().stats as Row;
    expect(stats).toMatchObject({ consecutive_api_errors: 1, cursor_reset: false });
    expect(Date.parse(String(stats.error_backoff_until))).toBeGreaterThanOrEqual(before + 60_000);
    expect(body.error_backoff_until).toBe(stats.error_backoff_until);
  });

  it("has_more with the next cursor under an unrecognised key fails closed: status error, the pass is never marked complete", async () => {
    const fox = fakeFox({ profiles: profileRows(250), cursorKey: "next" });
    vi.stubGlobal("fetch", fox.fetchMock);
    const db = new FakeDb();
    const { body } = await invoke(db);
    expect(fox.calls).toEqual(["/public/v1/profiles?limit=100"]);
    expect(body).toMatchObject({ status: "error", stopped_reason: "api_error", all_stages_completed: false });
    expect(db.state()).toMatchObject({ profiles_completed: false, last_status: "error", last_profiles_cursor: null, current_stage: "profiles" });
    expect(String(db.state().last_error)).toBe("FunnelFox pagination has has_more=true but no recognised next cursor (pagination keys: has_more, next).");
    expect(db.leads()).toHaveLength(25); // the first page's emails are kept
    // The daily refresh would hit the same wall: it stays visible as an error, never "ok".
    expect(field(body, "summary", "profiles_last_pass")).toBeUndefined();
  });

  it("a 2xx without a data array is an error, never an empty last page that completes the pass", async () => {
    const fox = fakeFox({ profiles: profileRows(250), rawBodyAt: { path: "/profiles", call: 2, body: "<html>maintenance</html>" } });
    vi.stubGlobal("fetch", fox.fetchMock);
    const db = new FakeDb();
    const { body } = await invoke(db);
    expect(body).toMatchObject({ status: "error", stopped_reason: "api_error" });
    expect(db.state()).toMatchObject({ profiles_completed: false, last_profiles_cursor: "c100", last_status: "error" });
    expect(String(db.state().last_error)).toBe("FunnelFox /profiles HTTP 200 returned no data array (body keys: none).");
  });

  it("a cursor FunnelFox keeps refusing: the cron backs off, the cursor is dropped after 3 errors in a row, the pass restarts", async () => {
    const fox = fakeFox({ profiles: profileRows(300), rejectCursor: { cursor: "expired-cursor", status: 404 } });
    vi.stubGlobal("fetch", fox.fetchMock);
    const db = new FakeDb();
    db.tables.funnelfox_leads_sync_state.push({
      auth_user_id: DATA_KEY,
      last_profiles_cursor: "expired-cursor",
      profiles_scanned_total: 200,
      stats: { profiles_scanned_total: 200, profiles_with_email: 50 },
    });
    const stats = () => db.state().stats as Row;

    // Error 1: status error, 60s backoff, the cursor is kept (one 404 may be a blip).
    const t0 = Date.now();
    const first = await invoke(db, { ctx: CRON_CTX });
    expect(first.body).toMatchObject({ status: "error", stopped_reason: "api_error", made_progress: false });
    expect(db.state()).toMatchObject({ last_status: "error", last_profiles_cursor: "expired-cursor", profiles_scanned_total: 200 });
    expect(stats()).toMatchObject({ consecutive_api_errors: 1, cursor_reset: false });
    expect(Date.parse(String(stats().error_backoff_until))).toBeGreaterThanOrEqual(t0 + 60_000);

    // The cron waits the backoff out: no lease, no fetch, no write.
    const writes = db.writes.length;
    const calls = fox.calls.length;
    const parked = await invoke(db, { ctx: CRON_CTX });
    expect(parked.body).toMatchObject({ status: "error", error_backoff: true, made_progress: false, error_backoff_until: stats().error_backoff_until });
    expect(db.writes.length).toBe(writes);
    expect(fox.calls.length).toBe(calls);
    expect(leaseCalls(db)).toEqual(["acquire_lease", "release_lease"]);

    // The owner's click is not held back. Error 2: the backoff doubles.
    await invoke(db);
    expect(stats().consecutive_api_errors).toBe(2);
    expect(Date.parse(String(stats().error_backoff_until)) - Date.now()).toBeGreaterThan(110_000);
    expect(db.state().last_profiles_cursor).toBe("expired-cursor");

    // Error 3 (backoff over): the refused cursor is dropped and the pass counters restart with it.
    stats().error_backoff_until = new Date(Date.now() - 1000).toISOString();
    await invoke(db, { ctx: CRON_CTX });
    expect(db.state()).toMatchObject({ last_status: "error", last_profiles_cursor: null, profiles_scanned_total: 0, profiles_completed: false });
    expect(stats()).toMatchObject({ consecutive_api_errors: 3, cursor_reset: true, profiles_scanned_total: 0, profiles_with_email: 0 });
    expect(String(db.state().last_error)).toMatch(/HTTP 404: cursor expired The saved profiles cursor was dropped after 3 errors in a row/);

    // Next tick (backoff over): the pass restarts from the newest page, completes, and the error clears.
    stats().error_backoff_until = null;
    const restarted = await invoke(db, { ctx: CRON_CTX });
    expect(fox.calls.slice(-3)).toEqual(["/public/v1/profiles?limit=100", "/public/v1/profiles?limit=100&cursor=c100", "/public/v1/profiles?limit=100&cursor=c200"]);
    expect(restarted.body).toMatchObject({ stopped_reason: "completed", next_stage: "sessions" });
    expect(db.state()).toMatchObject({ profiles_completed: true, last_error: null, last_status: "partial" });
    expect(stats()).toMatchObject({ consecutive_api_errors: 0, error_backoff_until: null, cursor_reset: false, profiles_scanned_total: 300 });
  });

  it("the daily refresh restarts an unfinished pipeline left in an error (a healthy one is only advanced)", async () => {
    const fox = fakeFox({ profiles: profileRows(150) });
    vi.stubGlobal("fetch", fox.fetchMock);
    const db = new FakeDb();
    db.tables.funnelfox_leads_sync_state.push({
      auth_user_id: DATA_KEY,
      profiles_completed: false,
      last_profiles_cursor: "c100",
      last_status: "error",
      last_error: "FunnelFox /profiles HTTP 400: bad cursor",
      stats: { consecutive_api_errors: 5, error_backoff_until: new Date(Date.now() + 3_600_000).toISOString() },
    });
    const refresh = await invoke(db, { ctx: CRON_CTX, action: "sync_full_reset", body: { auth_user_id: DATA_KEY, full_reset: true, limit: 100, max_pages: 200 } });
    expect(fox.calls[0]).toBe("/public/v1/profiles?limit=100");
    expect(db.stateWrites()[0].payload[0]).toMatchObject({ last_profiles_cursor: null, profiles_completed: false, sessions_completed: false });
    expect(refresh.body).toMatchObject({ stage: "profiles", stopped_reason: "completed", status: "partial" });
    expect(db.state()).toMatchObject({ last_status: "partial", last_error: null, profiles_completed: true });
    expect(db.state().stats as Row).toMatchObject({ consecutive_api_errors: 0, error_backoff_until: null });
  });

  it("a FunnelFox page that hangs is abandoned after the page timeout (an api_error), so no call outlives its lease", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const fetchMock = vi.fn(
        (_input: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("The operation was aborted.")));
          }),
      );
      vi.stubGlobal("fetch", fetchMock);
      const db = new FakeDb();
      db.tables.funnelfox_leads_sync_state.push({ auth_user_id: DATA_KEY, last_profiles_cursor: "c100", stats: {} });
      const pending = invoke(db, { ctx: CRON_CTX });
      await vi.advanceTimersByTimeAsync(20_000);
      const { body } = await pending;
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(body).toMatchObject({ status: "error", stopped_reason: "api_error" });
      expect(String(db.state().last_error)).toBe("FunnelFox /profiles request failed: FunnelFox request timed out after 20000ms.");
      expect(db.state().last_profiles_cursor).toBe("c100");
      expect(leaseCalls(db)).toEqual(["acquire_lease", "release_lease"]);
      expect(db.leaseFree).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the lease is released only with this call's token (a stale holder never frees the next one's lease)", async () => {
    const fox = fakeFox({ profiles: profileRows(4) });
    vi.stubGlobal("fetch", fox.fetchMock);
    const db = new FakeDb();
    // Simulate the call outliving its lease: mid-run another holder takes it.
    const realRpc = db.rpc.bind(db);
    db.rpc = async (name: string, args: Row) => {
      if (name === "funnelfox_leads_release_lease") {
        db.leaseToken = "someone-else";
        db.leaseFree = false;
      }
      return realRpc(name, args);
    };
    await invoke(db);
    expect(db.rpcCalls.find((call) => call.name === "funnelfox_leads_release_lease")?.args).toEqual({ p_data_key: DATA_KEY, p_token: "lease-token-1" });
    expect(db.leaseFree).toBe(false);
    expect(db.leaseToken).toBe("someone-else");
  });

  it("a user full reset writes every flag false + both cursors null BEFORE crawling, zeroes the pass counters, keeps rows", async () => {
    const fox = fakeFox({ profiles: profileRows(8) });
    vi.stubGlobal("fetch", fox.fetchMock);
    const db = new FakeDb();
    db.tables.funnelfox_leads.push({ auth_user_id: DATA_KEY, profile_id: "OLD", email: "old@x.com", normalized_email: "old@x.com" });
    db.tables.funnelfox_leads_sync_state.push({
      auth_user_id: DATA_KEY,
      profiles_completed: true,
      details_completed: true,
      sessions_completed: true,
      reconcile_completed: true,
      last_profiles_cursor: "stale_p",
      last_sessions_cursor: "stale_s",
      profiles_scanned_total: 999,
      stats: { profiles_scanned_total: 999, profiles_with_email: 500, profile_details_fetched: 12, remaining_without_email_after_checked: 3 },
    });

    const { body } = await invoke(db, { action: "sync_full_reset", body: { full_reset: true } });
    const start = db.stateWrites()[0];
    expect(start.op).toBe("upsert");
    expect(start.payload[0]).toMatchObject({
      auth_user_id: DATA_KEY,
      profiles_completed: false,
      details_completed: true,
      sessions_completed: false,
      reconcile_completed: false,
      last_profiles_cursor: null,
      last_sessions_cursor: null,
      profiles_scanned_total: 0,
      current_stage: "profiles",
    });
    expect(fox.calls[0]).toBe("/public/v1/profiles?limit=100");
    expect(body.summary).toMatchObject({ profiles_scanned_total: 8, profiles_with_email: 2 });
    expect(body.summary).not.toHaveProperty("profile_details_fetched");
    expect(body.summary).not.toHaveProperty("remaining_without_email_after_checked");
    expect(db.state()).toMatchObject({ profiles_completed: true, sessions_completed: false, reconcile_completed: false, last_sessions_cursor: null });
    expect(db.lead("OLD")).toBeDefined();
  });

  it("a cron full_reset while the backfill is unfinished is a plain advance; once complete it restarts", async () => {
    const fox = fakeFox({ profiles: profileRows(300) });
    vi.stubGlobal("fetch", fox.fetchMock);
    const db = new FakeDb();
    db.tables.funnelfox_leads_sync_state.push({ auth_user_id: DATA_KEY, profiles_completed: false, last_profiles_cursor: "c200", profiles_scanned_total: 200, stats: { profiles_scanned_total: 200 } });
    const advance = await invoke(db, { ctx: CRON_CTX, action: "sync_full_reset", body: { auth_user_id: DATA_KEY, full_reset: true, limit: 100, max_pages: 200 } });
    expect(fox.calls).toEqual(["/public/v1/profiles?limit=100&cursor=c200"]);
    expect(field(advance.body, "summary", "profiles_scanned_total")).toBe(300);
    expect(db.stateWrites()[0].payload[0]).not.toHaveProperty("last_profiles_cursor");

    Object.assign(db.state(), { profiles_completed: true, sessions_completed: true, reconcile_completed: true });
    const refresh = await invoke(db, { ctx: CRON_CTX, action: "sync_full_reset", body: { auth_user_id: DATA_KEY, full_reset: true, limit: 100, max_pages: 200 } });
    expect(fox.calls[1]).toBe("/public/v1/profiles?limit=100");
    expect(refresh.body).toMatchObject({ stage: "profiles", next_stage: "sessions" });
    expect(db.state()).toMatchObject({ sessions_completed: false, reconcile_completed: false });
    expect((db.state().stats as Row).last_actor).toBe("cron");
  });

  it("errors: the owner gets the detailed 502, the cron a FunnelFoxEdgeError (gate-mapped); the lease is always released", async () => {
    const fox = fakeFox({ profiles: profileRows(8) });
    vi.stubGlobal("fetch", fox.fetchMock);
    const db = new FakeDb();
    db.failUpsert = (table) => (table === "funnelfox_leads" ? "permission denied for table funnelfox_leads" : null);
    const owner = await invoke(db);
    expect(owner.status).toBe(502);
    expect(owner.body).toEqual({ error: "FunnelFox leads sync failed.", detail: "profiles upsert failed: permission denied for table funnelfox_leads" });
    expect(db.state()).toMatchObject({ last_status: "error", last_error: "profiles upsert failed: permission denied for table funnelfox_leads" });
    expect(leaseCalls(db)).toEqual(["acquire_lease", "release_lease"]);

    await expect(invoke(db, { ctx: CRON_CTX })).rejects.toBeInstanceOf(FunnelFoxEdgeError);
    expect(leaseCalls(db)).toEqual(["acquire_lease", "release_lease", "acquire_lease", "release_lease"]);
    expect(db.leaseFree).toBe(true);
  });

  it("a missing lease RPC (migration not applied) fails closed before any crawl", async () => {
    const fox = fakeFox({ profiles: profileRows(8) });
    vi.stubGlobal("fetch", fox.fetchMock);
    const db = new FakeDb();
    db.rpc = async (name: string, args: Row) => {
      db.rpcCalls.push({ name, args });
      return { data: null, error: { message: `function public.${name} does not exist` } };
    };
    const { status, body } = await invoke(db);
    expect(status).toBe(502);
    expect(String(body.detail)).toContain("lease unavailable");
    expect(fox.calls).toEqual([]);
    expect(db.writes).toEqual([]);
  });

  it("no FUNNELFOX_SECRET → 500 before anything else", async () => {
    env = {};
    const db = new FakeDb();
    const { status, body } = await invoke(db);
    expect(status).toBe(500);
    expect(body).toEqual({ error: "FunnelFox is not configured." });
    expect(db.rpcCalls).toEqual([]);
  });

  it("dry_run is a PII-free diagnose: key names, counts, cursor key, has_more, preview count, sample size — no writes, no detail calls", async () => {
    const profiles = profileRows(150, (i) => ulidFor(BASE_MS - i * 60_000));
    const sessions = [
      { id: "s1", profile_id: `pro_${ulidFor(BASE_MS)}`, created_at: isoAt(0), origin: "https://lp/x?utm_source=4", country: "us" },
      { id: "s2", profile_id: ulidFor(BASE_MS - 60_000), created_at: isoAt(1) },
    ];
    const fox = fakeFox({ profiles, sessions });
    vi.stubGlobal("fetch", fox.fetchMock);
    const db = new FakeDb();
    const { status, body } = await invoke(db, { action: "dry_run", body: { dry_run: true, limit: 100, max_pages: 2 } });
    expect(status).toBe(200);
    expect(fox.calls).toEqual(["/public/v1/profiles?limit=100", "/public/v1/profiles?limit=100&cursor=c100", "/public/v1/sessions?limit=100"]);
    expect(db.writes).toEqual([]);
    expect(db.rpcCalls).toEqual([]);
    expect(body).toMatchObject({ status: "ok", dry_run: true, made_progress: false });
    const d = body.diagnostics as Row;
    expect(d).toMatchObject({
      profiles_pages_probed: 2,
      profiles_rows_probed: 150,
      profiles_has_more_on_last_page: false,
      list_row_contains_email: true,
      list_rows_with_email: 38,
      sample_size: { profiles: 150, sessions: 2 },
      profile_detail_endpoint: "not_called",
      rate_limit_headers: ["x-ratelimit-remaining"],
    });
    expect(d.profiles as Row).toMatchObject({
      pagination_keys: ["cursor", "has_more"],
      cursor_key: "cursor",
      has_more: false,
      with_email: 38,
      root_email: 38,
      without_email: 112,
      preview_true: 15,
      preview_with_email: 8,
      preview_types: { boolean: 150 },
      id_forms: { pro_prefixed: 0, bare: 150, missing: 0, ulid: 150 },
      order: "newest_first",
      email_paths: ["email"],
      key_counts: { created_at: 150, email: 38, funnel_id: 150, id: 150, preview: 150 },
    });
    expect(d.sessions as Row).toMatchObject({ rows: 2, with_profile_id: 2, matching_profile_sample: 2, profile_id_forms: { pro_prefixed: 1, bare: 1 }, order: "newest_first" });
    const text = JSON.stringify(body);
    expect(text).not.toContain("@");
    expect(text).not.toContain("c100"); // no cursor values
    expect(text).not.toContain(ulidFor(BASE_MS)); // no ids
  });

  it("the source keeps the contracts the access tests and the plan rely on", () => {
    const source = readFileSync(resolve(process.cwd(), "supabase/functions/funnelfox-leads-sync/index.ts"), "utf8");
    expect(source).not.toMatch(/fetchFunnelFox\(`\/profiles\/\$\{/); // never the detail endpoint
    expect(source).not.toContain("raw_profile_list");
    expect(source).not.toContain("raw_session:");
    expect(source).not.toContain("body.conversion");
    expect(source).not.toContain("detectProfileEmail");
    for (const rpc of ["funnelfox_leads_acquire_lease", "funnelfox_leads_release_lease", "funnelfox_leads_reconcile_request", "funnelfox_leads_reconcile"]) {
      expect(source).toContain(`"${rpc}"`);
    }
    // The ClickHouse Leads runner is not loaded by this function (isMissingRpcError is mirrored).
    expect(source).not.toMatch(/from "\.\.\/_shared\/clickhouse\/leads\.ts"/);
  });
});
