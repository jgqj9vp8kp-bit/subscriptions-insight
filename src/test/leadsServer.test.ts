// Server-side Leads (leads plan §3): clickhouse-users leads_list /
// leads_overview over _shared/clickhouse/leads.ts.
//
// Parity: the computeLeads fixtures (src/test/leads.test.ts) are mapped into
// analytics_transactions rows by the real import mapper, Query A's aggregates
// are evaluated over those rows by a reference evaluator that mirrors the SQL
// term by term, and the runner's merged rows must equal computeLeads' rows
// field for field. The rest drives the pure merge / filter / sort / paging
// helpers, the per-workspace memo (hit, coalescing, TTL, refresh, failures),
// tenant binding through a real ScopedReader, ScopeViolation propagation, the
// sanitized sync state, and the 400 mapping of a malformed request.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { computeLeads, type LeadRecord } from "@/services/leads";
import type { Transaction } from "@/services/types";
import type { SubscriptionClean } from "@/types/subscriptions";
import {
  buildLeadsSyncState,
  buildWarehouseLeadsQuery,
  filterLeadRows,
  funnelFromProfile,
  leadsFilterOptions,
  isMissingRpcError,
  keepNewestLeads,
  leadsSummary,
  LEADS_CANDIDATES_MAX_AGE_SECONDS,
  LEADS_CANDIDATES_REFRESH_MAX_AGE_SECONDS,
  LEADS_LEGACY_PROFILE_LIMIT,
  LEADS_MEMO_TTL_MS,
  LEADS_RECENT_LIMIT,
  loadLeadsDataset,
  mergeLeads,
  mergeLeadsWithProfiles,
  normalizeLeadCampaignPath,
  oldestLeadDate,
  paginateLeadRows,
  parseLeadsProfileCandidates,
  parseWarehouseLeadRow,
  readLeadsSyncState,
  resetLeadsMemo,
  runLeadsList,
  runLeadsOverview,
  sanitizeSyncStats,
  sortLeadRows,
  type LeadsRunInput,
  type ProfileLeadCandidate,
  type SubscriptionLeadCandidate,
  type WarehouseLeadCandidate,
} from "../../supabase/functions/_shared/clickhouse/leads.ts";
import {
  LeadsRequestError,
  normalizeLeadsRequest,
  UNKNOWN_COUNTRY,
  type LeadRow,
  type LeadsListResponse,
  type NormalizedLeadsFilters,
} from "../../supabase/functions/_shared/clickhouse/leadsContract.ts";
import {
  mapSupabaseTransactionsToClickHouse,
  type ClickHouseTransactionRow,
  type SupabaseTransactionRow,
} from "../../supabase/functions/_shared/clickhouse/transactionMapper.ts";
import { createScopedReader, ScopeViolation } from "../../supabase/functions/_shared/clickhouse/scopedClient.ts";
import type { ClickHouseClientLike } from "../../supabase/functions/_shared/clickhouse/types.ts";
import { buildAccessContext, parseResolveAccessRow, type AccessContext } from "../../supabase/functions/_shared/access/accessContext.ts";
import { handleWithAccess, type AccessGateDeps, type AccessHandler } from "../../supabase/functions/_shared/access/gate.ts";
import { ACCESS_ERROR } from "../../supabase/functions/_shared/access/errors.ts";
import { CLICKHOUSE_USERS_POLICY, type ClickHouseUsersAction } from "../../supabase/functions/_shared/access/policies/clickhouse-users.ts";

const DATA_KEY = "11111111-1111-4111-8111-111111111111";
const OTHER_KEY = "99999999-9999-4999-8999-999999999999";
const WORKSPACE = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-06-21T12:00:00.000Z").getTime();

// ---- computeLeads fixtures (same builders as src/test/leads.test.ts) ----------------

function tx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    transaction_id: overrides.transaction_id ?? "tx_1",
    user_id: overrides.user_id ?? "user_1",
    email: overrides.email ?? "lead@example.com",
    event_time: overrides.event_time ?? "2026-06-10T10:00:00.000Z",
    amount_usd: 0,
    gross_amount_usd: 0,
    refund_amount_usd: 0,
    net_amount_usd: 0,
    is_refunded: false,
    currency: "USD",
    status: overrides.status ?? "failed",
    transaction_type: overrides.transaction_type ?? "failed_payment",
    funnel: overrides.funnel ?? "soulmate",
    campaign_path: overrides.campaign_path ?? "soulmate-reading",
    product: "Trial",
    traffic_source: "facebook",
    campaign_id: overrides.campaign_id ?? "cmp_1",
    classification_reason: "test",
    metadata: overrides.metadata ?? { ff_country_code: "us", utm_source: "ivan" },
    ...overrides,
  };
}

function sub(overrides: Partial<SubscriptionClean> = {}): SubscriptionClean {
  return {
    subscription_id: overrides.subscription_id ?? "sub_1",
    psp_id: "",
    email: overrides.email ?? null,
    profile_id: overrides.profile_id ?? "pro_1",
    status: overrides.status ?? "active",
    renews: true,
    sandbox: overrides.sandbox ?? false,
    is_cancelled: overrides.is_cancelled ?? false,
    cancelled_at: null,
    cancellation_source: null,
    cancellation_reason: null,
    days_to_cancel: null,
    hours_before_period_end: null,
    cancellation_timing_bucket: "not_cancelled",
    cancellation_type: "not_cancelled",
    is_active_now: overrides.is_active_now ?? false,
    created_at: overrides.created_at ?? "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
    period_starts_at: "2026-06-01T00:00:00.000Z",
    period_ends_at: "2026-07-01T00:00:00.000Z",
    billing_interval: "month",
    billing_interval_count: 1,
    price_usd: overrides.price_usd ?? 0,
    currency: "USD",
    payment_provider: "stripe",
    product_name: "Plan",
    product_id: "prod_1",
    funnel_title: overrides.funnel_title ?? "",
    funnel_alias: overrides.funnel_alias ?? "",
    session_id: "sess_1",
    raw: {},
  };
}

// ---- the warehouse as Query A sees it --------------------------------------------------

/** The fixtures as analytics_transactions rows, through the real import mapper. */
function warehouseRows(transactions: Transaction[]): ClickHouseTransactionRow[] {
  const rows: SupabaseTransactionRow[] = transactions.map((t) => ({
    transaction_id: t.transaction_id,
    user_id: t.user_id,
    email: t.email,
    event_time: t.event_time,
    status: t.status,
    transaction_type: t.transaction_type,
    normalized_payload: t as unknown as Record<string, unknown>,
    raw_payload: (t.raw as Record<string, unknown> | undefined) ?? null,
    updated_at: "2026-06-20T00:00:00.000Z",
  }));
  return mapSupabaseTransactionsToClickHouse({ authUserId: DATA_KEY, rows }).rows;
}

const UA_KEYS = ["user_agent", "userAgent", "ua", "browser_user_agent"];

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** leadUserAgentRowSql, evaluated: metadata keys first, then raw (raw_payload wins per key). */
function rowUserAgent(row: ClickHouseTransactionRow): string {
  const payload = asObject(JSON.parse(row.normalized_payload)) ?? {};
  const metadata = asObject(payload.metadata);
  for (const key of UA_KEYS) {
    const value = metadata?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  const raw = asObject(JSON.parse(row.raw_payload)) ?? {};
  const payloadRaw = asObject(payload.raw);
  for (const key of UA_KEYS) {
    const value = Object.prototype.hasOwnProperty.call(raw, key) ? raw[key] : payloadRaw?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/** buildWarehouseLeadsQuery, evaluated term by term over the mapped rows. */
function evaluateQueryA(rows: ClickHouseTransactionRow[]): Array<Record<string, unknown>> {
  const time = (row: ClickHouseTransactionRow) => Date.parse(`${row.event_time}Z`);
  const byTime = (a: ClickHouseTransactionRow, b: ClickHouseTransactionRow) =>
    time(a) - time(b) || (a.transaction_id < b.transaction_id ? -1 : a.transaction_id > b.transaction_id ? 1 : 0);
  const failed = (row: ClickHouseTransactionRow) =>
    !["refunded", "chargeback"].includes(row.status) && !["refund", "chargeback"].includes(row.transaction_type) && (row.is_failed === 1 || row.decline_reason !== "");
  const countryPriority = (row: ClickHouseTransactionRow) => (row.country_code === "" ? 2 : row.is_success === 1 ? 0 : 1);
  const paid = new Set(rows.filter((row) => row.is_success === 1 && row.normalized_email !== "").map((row) => row.normalized_email));
  const groups = new Map<string, ClickHouseTransactionRow[]>();
  for (const row of rows) groups.set(row.user_id, [...(groups.get(row.user_id) ?? []), row]);

  const out: Array<Record<string, unknown>> = [];
  for (const [userId, group] of groups) {
    const sorted = [...group].sort(byTime);
    const email = sorted.find((row) => row.normalized_email !== "")?.normalized_email ?? "";
    if (!email || paid.has(email)) continue;
    const trialUtm = sorted.find((row) => row.is_success === 1 && row.transaction_type === "trial")?.utm_source ?? "";
    const firstUtm = sorted.find((row) => row.utm_source !== "")?.utm_source ?? "";
    const countryRow = [...group].sort((a, b) => countryPriority(a) - countryPriority(b) || time(a) - time(b))[0];
    const failedRows = sorted.filter(failed);
    out.push({
      customer_id: userId,
      email,
      first_touch_ms: String(time(sorted[0])), // Int64 → quoted in JSONEachRow
      funnel: sorted[0].funnel,
      campaign_path: sorted[0].campaign_path,
      campaign_id: sorted[0].campaign_id,
      utm_source: trialUtm !== "" ? trialUtm : firstUtm,
      country: countryRow.country_code,
      has_declines: failedRows.length > 0 ? 1 : 0,
      decline_reason: failedRows.at(-1)?.decline_reason ?? "",
      user_agent: sorted.map(rowUserAgent).find((value) => value !== "") ?? "",
    });
  }
  return out;
}

// ---- fakes ----------------------------------------------------------------------------

function accessRow(userId: string, options: { scope?: "all" | "selected"; dataKey?: string } = {}) {
  const scope = options.scope ?? "all";
  const dataKey = options.dataKey ?? DATA_KEY;
  return {
    status: "ok",
    workspace_id: WORKSPACE,
    data_key: dataKey,
    member_id: "44444444-4444-4444-8444-444444444444",
    user_id: userId,
    email: "owner@example.com",
    display_name: "Owner",
    is_data_owner: userId === dataKey,
    raw_access: userId === dataKey,
    role: { id: "role-1", key: "owner", name: "Owner", is_owner: true, permissions: [] },
    funnel_scope: { mode: scope, funnel_ids: scope === "selected" ? ["55555555-5555-4555-8555-555555555555"] : [], paths: scope === "selected" ? ["soulmate"] : [] },
    access_version: "7",
    partition: "partition-hash",
  };
}

function ownerContext(options: { scope?: "all" | "selected"; dataKey?: string } = {}): AccessContext {
  const dataKey = options.dataKey ?? DATA_KEY;
  const parsed = parseResolveAccessRow(accessRow(dataKey, { ...options, dataKey }));
  if (!parsed) throw new Error("bad fixture row");
  return buildAccessContext(parsed, { kind: "user", userId: dataKey, email: "owner@example.com" }, "req-leads-1");
}

interface Warehouse {
  raw: ClickHouseClientLike;
  queries: Array<{ query: string; params: Record<string, unknown> }>;
}

function fakeWarehouse(rows: Array<Record<string, unknown>> | (() => Promise<Array<Record<string, unknown>>>)): Warehouse {
  const queries: Warehouse["queries"] = [];
  const raw: ClickHouseClientLike = {
    query: vi.fn(async (input: { query: string; query_params?: Record<string, unknown> }) => {
      queries.push({ query: input.query, params: input.query_params ?? {} });
      const result = typeof rows === "function" ? await rows() : rows;
      return { json: async () => result };
    }),
    command: vi.fn(async () => undefined),
    insert: vi.fn(async () => undefined),
  };
  return { raw, queries };
}

interface PgOptions {
  candidates?: unknown;
  candidatesError?: string;
  /** leads_recent_candidates fails only when called with this p_max_age_seconds
   * (e.g. a refresh's inline compute hitting the statement timeout). */
  candidatesErrorAtMaxAge?: { maxAge: number; message: string; code?: string };
  /** leads_recent_candidates is not deployed (PostgREST PGRST202 / 404): the old RPC answers `legacyCandidates`. */
  recentMissing?: boolean;
  legacyCandidates?: unknown;
  legacyError?: string;
  active?: Record<string, string[]>;
  syncState?: Record<string, unknown> | null;
  syncStateError?: string;
  /** funnelfox_leads rows the per-page user_agent / origin read answers from. */
  profileDetails?: Array<{ auth_user_id?: string; profile_id: string; user_agent: string | null; origin: string | null }>;
  profileDetailsError?: string;
}

function fakePg(options: PgOptions = {}) {
  const rpc = vi.fn(async (fn: string, params?: Record<string, unknown>) => {
    if (fn === "leads_recent_candidates") {
      if (options.recentMissing) {
        return {
          data: null,
          error: { code: "PGRST202", message: "Could not find the function public.leads_recent_candidates(p_data_key, p_limit, p_max_age_seconds) in the schema cache" },
          status: 404,
        };
      }
      if (options.candidatesError) return { data: null, error: { message: options.candidatesError } };
      const failAt = options.candidatesErrorAtMaxAge;
      if (failAt && params?.p_max_age_seconds === failAt.maxAge) return { data: null, error: { code: failAt.code, message: failAt.message } };
      return { data: options.candidates ?? { profile_leads: [], subscription_leads: [], kpis: {} }, error: null };
    }
    if (fn === "leads_profile_candidates" && options.recentMissing) {
      if (options.legacyError) return { data: null, error: { message: options.legacyError } };
      return { data: options.legacyCandidates ?? { profile_leads: [], subscription_leads: [], kpis: {} }, error: null };
    }
    if (fn === "active_funnelfox_subscription_emails") return { data: options.active ?? {}, error: null };
    return { data: null, error: { message: `unexpected rpc ${fn} ${JSON.stringify(params)}` } };
  });
  const eq = vi.fn();
  /** Every funnelfox_leads detail read: the columns and the profile ids asked for. */
  const detailReads: Array<{ columns: string; ids: unknown[]; tenant: unknown }> = [];
  const from = vi.fn((table: string) => {
    let columns = "";
    let ids: unknown[] = [];
    let tenant: unknown = null;
    const builder = {
      select: (cols?: string) => {
        columns = cols ?? "";
        return builder;
      },
      eq: (column: string, value: unknown) => {
        eq(table, column, value);
        if (column === "auth_user_id") tenant = value;
        return builder;
      },
      in: (_column: string, values: unknown[]) => {
        ids = values;
        return builder;
      },
      maybeSingle: async () =>
        options.syncStateError ? { data: null, error: { message: options.syncStateError } } : { data: options.syncState ?? null, error: null },
      then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => {
        detailReads.push({ columns, ids, tenant });
        const result = options.profileDetailsError
          ? { data: null, error: { message: options.profileDetailsError } }
          : {
              data: (options.profileDetails ?? [])
                .filter((row) => (row.auth_user_id ?? DATA_KEY) === tenant && ids.includes(row.profile_id))
                .map(({ profile_id, user_agent, origin }) => ({ profile_id, user_agent, origin })),
              error: null,
            };
        return Promise.resolve(result).then(resolve, reject);
      },
    };
    return builder;
  });
  return { client: { rpc, from } as unknown as LeadsRunInput["pg"], rpc, from, eq, detailReads };
}

function runInput(overrides: Partial<LeadsRunInput> & { warehouse?: Warehouse; ctx?: AccessContext; pgOptions?: PgOptions } = {}): LeadsRunInput & { warehouse: Warehouse; pgFake: ReturnType<typeof fakePg> } {
  const ctx = overrides.ctx ?? ownerContext();
  const warehouse = overrides.warehouse ?? fakeWarehouse([]);
  const pgFake = fakePg(overrides.pgOptions);
  return {
    tenantKey: overrides.tenantKey ?? ctx.tenantKey,
    clickhouse: overrides.clickhouse ?? createScopedReader(ctx, warehouse.raw),
    pg: overrides.pg ?? pgFake.client,
    request: overrides.request ?? { action: "leads_list" },
    clock: overrides.clock ?? (() => NOW),
    warehouse,
    pgFake,
  };
}

beforeEach(() => resetLeadsMemo());

// ---- parity with computeLeads -----------------------------------------------------------

type Comparable = Pick<LeadRow, "customer_id" | "email" | "funnel" | "campaign_path" | "campaign_id" | "media_buyer" | "country" | "session_date" | "lead_date" | "days_since_visit" | "user_agent" | "has_declines" | "decline_reason" | "source">;

const iso = (value: string | null | undefined) => (value ? new Date(value).toISOString() : null);

function fromRecord(lead: LeadRecord): Comparable {
  return {
    customer_id: lead.customer_id,
    email: lead.email,
    funnel: lead.funnel,
    campaign_path: lead.campaign_path,
    campaign_id: lead.campaign_id,
    media_buyer: lead.media_buyer,
    country: lead.country,
    session_date: iso(lead.session_date),
    lead_date: iso(lead.lead_created || lead.session_date),
    days_since_visit: lead.days_since_visit,
    user_agent: lead.user_agent,
    has_declines: lead.has_declines,
    decline_reason: lead.decline_reason,
    source: lead.source,
  };
}

function fromRow(row: LeadRow): Comparable {
  const { customer_id, email, funnel, campaign_path, campaign_id, media_buyer, country, session_date, lead_date, days_since_visit, user_agent, has_declines, decline_reason, source } = row;
  return { customer_id, email, funnel, campaign_path, campaign_id, media_buyer, country, session_date, lead_date, days_since_visit, user_agent, has_declines, decline_reason, source };
}

const byIdentity = (a: Comparable, b: Comparable) => `${a.customer_id}|${a.email}`.localeCompare(`${b.customer_id}|${b.email}`);

async function serverLeads(transactions: Transaction[], subscriptions: SubscriptionClean[] = []): Promise<LeadsListResponse> {
  const active: Record<string, string[]> = {};
  for (const s of subscriptions) {
    const email = s.email?.trim().toLowerCase();
    if (email && s.is_active_now) active[email] = [...(active[email] ?? []), s.subscription_id];
  }
  const input = runInput({
    warehouse: fakeWarehouse(evaluateQueryA(warehouseRows(transactions))),
    pgOptions: { active },
    request: { action: "leads_list", page_size: 200 },
  });
  return runLeadsList(input);
}

const PARITY_CASES: Array<[string, Transaction[], SubscriptionClean[]]> = [
  ["an email that only ever has failed payments", [tx()], []],
  ["an email with a successful payment", [
    tx({ transaction_id: "a", status: "failed", transaction_type: "failed_payment" }),
    tx({ transaction_id: "b", status: "success", transaction_type: "trial" }),
  ], []],
  ["an email with an active subscription", [tx()], [sub({ email: "lead@example.com", is_active_now: true })]],
  ["rows without an email", [tx({ email: "" })], []],
  ["paid status across user_ids sharing an email", [
    tx({ transaction_id: "a", user_id: "u1", status: "failed", transaction_type: "failed_payment" }),
    tx({ transaction_id: "b", user_id: "u2", status: "success", transaction_type: "first_subscription" }),
  ], []],
  ["first-touch attribution (funnel, campaign, country, utm → media buyer, session date)", [
    tx({ transaction_id: "a", event_time: "2026-06-12T10:00:00.000Z", campaign_id: "late", metadata: { ff_country_code: "us", utm_source: "4" } }),
    tx({ transaction_id: "b", event_time: "2026-06-10T10:00:00.000Z", campaign_id: "first", metadata: { ff_country_code: "us", utm_source: "4" } }),
  ], []],
  ["the latest decline reason", [
    tx({ transaction_id: "a", event_time: "2026-06-10T10:00:00.000Z", metadata: { ff_country_code: "us", declineReasons: "[{'decline_reason': 'INSUFFICIENT_FUNDS'}]" } }),
    tx({ transaction_id: "b", event_time: "2026-06-15T10:00:00.000Z", metadata: { ff_country_code: "us", declineReasons: "[{'decline_reason': 'DO_NOT_HONOR'}]" } }),
  ], []],
  ["two leads in different funnels and countries", [
    tx({ transaction_id: "a", user_id: "u1", email: "a@example.com", funnel: "soulmate", event_time: "2026-06-10T10:00:00.000Z", metadata: { ff_country_code: "us" } }),
    tx({ transaction_id: "b", user_id: "u2", email: "b@example.com", funnel: "starseed", event_time: "2026-06-15T10:00:00.000Z", metadata: { ff_country_code: "gb" } }),
  ], []],
  ["the user agent of the earliest transaction that carries one", [
    tx({ transaction_id: "a", event_time: "2026-06-10T10:00:00.000Z", metadata: { ff_country_code: "us" } }),
    tx({ transaction_id: "b", event_time: "2026-06-11T10:00:00.000Z", metadata: { ff_country_code: "us", user_agent: "  Mozilla/5.0 (iPhone)  " } }),
    tx({ transaction_id: "c", event_time: "2026-06-12T10:00:00.000Z", metadata: { ff_country_code: "us", userAgent: "Mozilla/5.0 (Android)" } }),
  ], []],
  ["a user agent only in the raw payload", [
    tx({ transaction_id: "a", metadata: { ff_country_code: "us" }, raw: { ua: "RawAgent/1.0" } }),
  ], []],
  ["two customers sharing one unpaid email", [
    tx({ transaction_id: "a", user_id: "u1", event_time: "2026-06-10T10:00:00.000Z" }),
    tx({ transaction_id: "b", user_id: "u2", event_time: "2026-06-14T10:00:00.000Z", metadata: { ff_country_code: "de", utm_source: "22" } }),
  ], []],
  ["a utm source only on a later attempt", [
    tx({ transaction_id: "a", event_time: "2026-06-10T10:00:00.000Z", metadata: { ff_country_code: "us" } }),
    tx({ transaction_id: "b", event_time: "2026-06-11T10:00:00.000Z", metadata: { ff_country_code: "us", utm_source: "19" } }),
  ], []],
  ["refunds and chargebacks are not declines", [
    tx({ transaction_id: "a", status: "refunded", transaction_type: "refund" }),
    tx({ transaction_id: "b", user_id: "u2", email: "cb@example.com", status: "chargeback", transaction_type: "chargeback" }),
  ], []],
  ["a pending attempt the processor declined (raw status)", [
    tx({ transaction_id: "a", status: "pending" as Transaction["status"], transaction_type: "unknown", raw: { status: "DECLINED" } }),
  ], []],
  ["a mixed population", [
    tx({ transaction_id: "a", user_id: "u1", email: "One@Example.com ", event_time: "2026-06-01T08:00:00.000Z", metadata: { ff_country_code: "fr", utm_source: "4" } }),
    tx({ transaction_id: "b", user_id: "u1", email: "one@example.com", event_time: "2026-06-03T08:00:00.000Z", status: "failed", metadata: { ff_country_code: "fr", declineReasons: "[{'decline_reason': 'EXPIRED_CARD'}]" } }),
    tx({ transaction_id: "c", user_id: "u2", email: "two@example.com", event_time: "2026-06-20T23:00:00.000Z", campaign_path: "", campaign_id: "" }),
    tx({ transaction_id: "d", user_id: "u3", email: "paid@example.com", status: "success", transaction_type: "trial" }),
    tx({ transaction_id: "e", user_id: "u4", email: "paid@example.com", status: "failed" }),
  ], [sub({ email: "two@example.com", is_active_now: false })]],
];

describe("parity with computeLeads (warehouse-only input)", () => {
  it.each(PARITY_CASES)("%s", async (_label, transactions, subscriptions) => {
    const expected = computeLeads(transactions, subscriptions, NOW).filter((lead) => lead.source === "warehouse").map(fromRecord).sort(byIdentity);
    const response = await serverLeads(transactions, subscriptions);
    expect(response.rows.map(fromRow).sort(byIdentity)).toEqual(expected);
    for (const row of response.rows) {
      expect(row.source).toBe("warehouse");
      expect(row.key).toBe(`w:${row.customer_id}`);
      expect(row.origin).toBeNull();
    }
  });

  it("the parity population is not vacuous", async () => {
    const counts = await Promise.all(PARITY_CASES.map(async ([, transactions, subscriptions]) => {
      resetLeadsMemo();
      return (await serverLeads(transactions, subscriptions)).pagination.total_rows;
    }));
    expect(counts).toEqual([1, 0, 0, 0, 0, 1, 1, 2, 1, 1, 2, 1, 2, 1, 2]);
  });

  it("subscription-only candidates map to computeLeads' subscription leads", () => {
    const subscription = sub({ email: "SubOnly@example.com", is_active_now: false, is_cancelled: true, funnel_alias: "soulmate-v2", profile_id: "prof_9", created_at: "2026-06-05T00:00:00.000Z" });
    const [expected] = computeLeads([], [subscription], NOW);
    // What leads_profile_candidates returns for that subscription.
    const candidate: SubscriptionLeadCandidate = { email: "subonly@example.com", lead_date: "2026-06-05T00:00:00+00:00", funnel: "soulmate", customer_id: "prof_9" };
    const [row] = mergeLeads({ warehouse: [], subscriptions: [candidate], now: NOW });
    expect(fromRow(row)).toEqual(fromRecord(expected));
    expect(row.key).toBe("s:subonly@example.com");
  });
});

// ---- Query A ---------------------------------------------------------------------------

describe("Query A (warehouse lead candidates)", () => {
  const sql = buildWarehouseLeadsQuery();

  it("reads only analytics_transactions FINAL for the bound tenant", () => {
    expect(sql.match(/FROM analytics_transactions FINAL/g)).toHaveLength(3);
    expect(sql.match(/auth_user_id = \{auth_user_id:String\}/g)).toHaveLength(3);
    expect(sql).not.toMatch(/fact_|facebook_/);
    expect(sql.trim().endsWith("FORMAT JSONEachRow")).toBe(true);
  });

  it("uses the agreed expressions", () => {
    expect(sql).toContain("argMinIf(normalized_email, (event_time, transaction_id), normalized_email != '') AS w_email");
    expect(sql).toContain("toUnixTimestamp64Milli(min(event_time)) AS w_first_touch_ms");
    for (const column of ["funnel", "campaign_path", "campaign_id"]) expect(sql).toContain(`argMin(${column}, (event_time, transaction_id)) AS w_${column}`);
    expect(sql).toContain("argMin(country_code, (multiIf(country_code = '', 2, is_success = 1, 0, 1), event_time)) AS w_country");
    expect(sql).toContain("WHERE w_email != '' AND w_email NOT IN (SELECT email FROM paid)");
    expect(sql).toContain("is_success = 1 AND normalized_email != ''");
    expect(sql).toContain("if(l.w_trial_utm != '', l.w_trial_utm, l.w_first_utm) AS utm_source");
    // The payload is read only for lead users, and only rows that can carry a user agent.
    expect(sql).toContain("AND user_id IN (SELECT user_id FROM leads)");
    expect(sql).toContain(`multiSearchAny(normalized_payload, ['"user_agent"', '"userAgent"', '"ua"', '"browser_user_agent"'])`);
    // No aggregate is aliased to the column it reads (ClickHouse alias shadowing).
    expect(sql).not.toMatch(/\bAS (funnel|campaign_path|campaign_id|utm_source|country_code|decline_reason|user_id)\b,?\n\s+argM/);
  });

  it("parses a JSONEachRow row (Int64 quoted, UInt8 flags, empty strings)", () => {
    expect(parseWarehouseLeadRow({
      customer_id: "u1", email: "a@example.com", first_touch_ms: "1749549600000", funnel: "soulmate", campaign_path: "", campaign_id: "",
      utm_source: " 4 ", country: "", has_declines: 1, decline_reason: "", user_agent: "",
    })).toEqual({
      customer_id: "u1", email: "a@example.com", session_date: "2025-06-10T10:00:00.000Z", funnel: "soulmate", campaign_path: "", campaign_id: "",
      utm_source: "4", country: null, user_agent: null, has_declines: true, decline_reason: null,
    });
  });
});

// ---- merge rules --------------------------------------------------------------------------

function warehouseCandidate(overrides: Partial<WarehouseLeadCandidate> = {}): WarehouseLeadCandidate {
  return {
    customer_id: "u1",
    email: "lead@example.com",
    session_date: "2026-06-10T10:00:00.000Z",
    funnel: "soulmate",
    campaign_path: "soulmate-reading",
    campaign_id: "cmp_1",
    utm_source: "4",
    country: "US",
    user_agent: "WarehouseAgent",
    has_declines: true,
    decline_reason: "do_not_honor",
    ...overrides,
  };
}

function profileCandidate(overrides: Partial<ProfileLeadCandidate> = {}): ProfileLeadCandidate {
  return {
    profile_id: "prof_1",
    email: "lead@example.com",
    lead_date: "2026-06-08T09:00:00.000Z",
    funnel_id: "fun_01",
    campaign_path: null,
    campaign_id: null,
    utm_source: null,
    media_buyer: null,
    country: null,
    user_agent: "ProfileAgent",
    origin: "https://quiz.example.com/soulmate",
    ...overrides,
  };
}

describe("mergeLeads", () => {
  it("a profile matching a warehouse lead enriches it (source both); the warehouse attribution stays", () => {
    const [row] = mergeLeads({
      warehouse: [warehouseCandidate()],
      profiles: [profileCandidate({ campaign_path: "FB_Soulmate_US_Broad", campaign_id: "ff_cmp", utm_source: "19", country: "gb" })],
      now: NOW,
    });
    expect(row).toEqual({
      key: "w:u1",
      email: "lead@example.com",
      lead_date: "2026-06-08T09:00:00.000Z", // the earlier of the two
      funnel: "soulmate",
      // The owner's existing values (and filter vocabulary) are kept: the profile's utm_campaign,
      // ad id, buyer and session geo never overwrite them.
      campaign_path: "soulmate-reading",
      campaign_id: "cmp_1",
      media_buyer: "Ivan",
      country: "US",
      session_date: "2026-06-10T10:00:00.000Z", // the warehouse first touch
      days_since_visit: 13, // from lead_date
      customer_id: "u1",
      user_agent: "ProfileAgent",
      origin: "https://quiz.example.com/soulmate",
      source: "both",
      has_declines: true,
      decline_reason: "do_not_honor",
    });
  });

  it("a 'both' row takes from the profile only what the warehouse lacks (unknown / empty), normalized", () => {
    const [row] = mergeLeads({
      warehouse: [warehouseCandidate({ funnel: "unknown", campaign_path: "", campaign_id: "", utm_source: null, country: null })],
      profiles: [profileCandidate({ funnel_id: "soulmate-fun", campaign_path: "/Soulmate Sketch/?utm=x", campaign_id: "ff_cmp", utm_source: "19", country: "gb" })],
      now: NOW,
    });
    expect(row).toMatchObject({
      source: "both",
      funnel: "soulmate",
      campaign_path: "soulmate-sketch",
      campaign_id: "ff_cmp",
      media_buyer: "Artem A",
      country: "GB",
    });
  });

  it("profile campaign paths are normalized like the warehouse import (palmerTransform)", () => {
    const rows = mergeLeads({
      warehouse: [],
      profiles: [
        profileCandidate({ profile_id: "a", email: "a@x.io", campaign_path: "https://quiz.example.com/Soulmate-1-SP/?utm_source=4" }),
        profileCandidate({ profile_id: "b", email: "b@x.io", campaign_path: "FB Campaign_US" }),
        profileCandidate({ profile_id: "c", email: "c@x.io", campaign_path: "  " }),
      ],
      now: NOW,
    });
    expect(Object.fromEntries(rows.map((row) => [row.customer_id, row.campaign_path]))).toEqual({ a: "soulmate-1-sp", b: "fb-campaign-us", c: "unknown" });
    expect(normalizeLeadCampaignPath("/soulmate-reading/")).toBe("soulmate-reading");
  });

  it("mergeLeadsWithProfiles maps each profile-backed row to its profile id (for the per-page detail read)", () => {
    const { rows, profileIdByKey } = mergeLeadsWithProfiles({
      warehouse: [warehouseCandidate()],
      profiles: [profileCandidate(), profileCandidate({ profile_id: "prof_2", email: "solo@example.com" })],
      subscriptions: [{ email: "sub@example.com", lead_date: null, funnel: null }],
      now: NOW,
    });
    expect(rows.map((row) => row.key)).toEqual(["w:u1", "p:prof_2", "s:sub@example.com"]);
    expect([...profileIdByKey]).toEqual([["w:u1", "prof_1"], ["p:prof_2", "prof_2"]]);
  });

  it("keeps the warehouse date when the profile is later, and the warehouse user agent when the profile has none", () => {
    const [row] = mergeLeads({
      warehouse: [warehouseCandidate()],
      profiles: [profileCandidate({ lead_date: "2026-06-12T00:00:00.000Z", user_agent: null, origin: null })],
      now: NOW,
    });
    expect(row.lead_date).toBe("2026-06-10T10:00:00.000Z");
    expect(row.days_since_visit).toBe(11);
    expect(row.user_agent).toBe("WarehouseAgent");
    expect(row.origin).toBeNull();
    expect(row.source).toBe("both");
  });

  it("enriches every warehouse customer of the email", () => {
    const rows = mergeLeads({
      warehouse: [warehouseCandidate(), warehouseCandidate({ customer_id: "u2", session_date: "2026-06-15T00:00:00.000Z" })],
      profiles: [profileCandidate()],
      now: NOW,
    });
    expect(rows.map((row) => [row.key, row.source])).toEqual([["w:u1", "both"], ["w:u2", "both"]]);
  });

  it("other profiles are their own rows with profile attribution", () => {
    const [row] = mergeLeads({
      warehouse: [],
      profiles: [profileCandidate({ email: " New@Example.com ", campaign_path: "starseed-quiz", campaign_id: "c9", utm_source: "19", country: "de" })],
      now: NOW,
    });
    expect(row).toEqual({
      key: "p:prof_1",
      email: "new@example.com",
      lead_date: "2026-06-08T09:00:00.000Z",
      funnel: "starseed",
      campaign_path: "starseed-quiz",
      campaign_id: "c9",
      media_buyer: "Artem A",
      country: "DE",
      session_date: "2026-06-08T09:00:00.000Z",
      days_since_visit: 13,
      customer_id: "prof_1",
      user_agent: "ProfileAgent",
      origin: "https://quiz.example.com/soulmate",
      source: "funnelfox_profile",
      has_declines: false,
      decline_reason: null,
    });
  });

  it("a stored media buyer is kept; an unknown one falls back to the utm source", () => {
    const rows = mergeLeads({
      warehouse: [],
      profiles: [
        profileCandidate({ profile_id: "p1", email: "a@x.io", media_buyer: "Artem D", utm_source: "4" }),
        profileCandidate({ profile_id: "p2", email: "b@x.io", media_buyer: "Somebody", utm_source: "4" }),
        profileCandidate({ profile_id: "p3", email: "c@x.io", media_buyer: null, utm_source: null }),
      ],
      now: NOW,
    });
    expect(rows.map((row) => row.media_buyer)).toEqual(["Artem D", "Ivan", "Unknown"]);
  });

  it("duplicate profile emails keep the earliest profile", () => {
    const rows = mergeLeads({
      warehouse: [],
      profiles: [
        profileCandidate({ profile_id: "late", lead_date: "2026-06-12T00:00:00.000Z" }),
        profileCandidate({ profile_id: "undated", lead_date: null }),
        profileCandidate({ profile_id: "early", lead_date: "2026-06-02T00:00:00.000Z" }),
      ],
      now: NOW,
    });
    expect(rows.map((row) => row.customer_id)).toEqual(["early"]);
  });

  it("subscription-only rows are added only for emails not already present", () => {
    const rows = mergeLeads({
      warehouse: [warehouseCandidate()],
      profiles: [profileCandidate({ email: "profile@example.com" })],
      subscriptions: [
        { email: "lead@example.com", lead_date: "2026-06-01T00:00:00.000Z", funnel: "soulmate" },
        { email: "PROFILE@example.com", lead_date: "2026-06-01T00:00:00.000Z", funnel: "soulmate" },
        { email: "sub@example.com", lead_date: "2026-06-01T00:00:00.000Z", funnel: "past_life", customer_id: "prof_s" },
        { email: "sub@example.com", lead_date: "2026-05-01T00:00:00.000Z", funnel: "starseed" },
      ],
      now: NOW,
    });
    expect(rows.map((row) => [row.key, row.source])).toEqual([
      ["w:u1", "warehouse"],
      ["p:prof_1", "funnelfox_profile"],
      ["s:sub@example.com", "funnelfox_subscription"],
    ]);
    expect(rows[2]).toMatchObject({ customer_id: "prof_s", funnel: "past_life", campaign_path: "unknown", media_buyer: "Unknown", country: null, days_since_visit: 20 });
  });

  it("an email with an active subscription is never a lead, whatever the source", () => {
    const rows = mergeLeads({
      warehouse: [warehouseCandidate()],
      profiles: [profileCandidate({ email: "p@example.com" })],
      subscriptions: [{ email: "s@example.com", lead_date: null, funnel: null }],
      activeEmails: new Map([["LEAD@example.com", ["sub-1"]], ["p@example.com", ["sub-2"]], ["s@example.com", ["sub-3"]]]),
      now: NOW,
    });
    expect(rows).toEqual([]);
  });

  it("a profile of an excluded warehouse customer does not resurrect it", () => {
    const rows = mergeLeads({
      warehouse: [warehouseCandidate()],
      profiles: [profileCandidate()],
      activeEmails: ["lead@example.com"],
      now: NOW,
    });
    expect(rows).toEqual([]);
  });

  it("classifies profile funnels like the warehouse import", () => {
    expect(funnelFromProfile("fun_01", "soulmate-sketch")).toBe("soulmate");
    expect(funnelFromProfile(null, "past-life-regression")).toBe("past_life");
    expect(funnelFromProfile("starseed_v2", null)).toBe("starseed");
    expect(funnelFromProfile("fun_01", null)).toBe("unknown");
  });

  it("parses the RPC payload defensively (object or JSON text; rows without an email are dropped)", () => {
    const payload = {
      profile_leads: [
        { profile_id: "p1", email: "a@x.io", lead_date: "2026-06-01T00:00:00+00:00", funnel_id: "f", campaign_path: "  ", country: "us" },
        { profile_id: "p2", email: null },
        "junk",
      ],
      subscription_leads: [{ email: "s@x.io", lead_date: null, funnel: "soulmate", customer_id: "c1" }, { email: "" }],
      kpis: { emails_found: "12", converted_excluded: 3, active_subs_excluded: null },
    };
    for (const data of [payload, JSON.stringify(payload)]) {
      const parsed = parseLeadsProfileCandidates(data);
      expect(parsed.profile_leads).toHaveLength(1);
      expect(parsed.profile_leads[0]).toMatchObject({ profile_id: "p1", lead_date: "2026-06-01T00:00:00.000Z", campaign_path: null, country: "us", user_agent: null, origin: null });
      expect(parsed.subscription_leads).toEqual([{ email: "s@x.io", lead_date: null, funnel: "soulmate", customer_id: "c1" }]);
      expect(parsed.kpis).toEqual({ emails_found: 12, converted_excluded: 3, active_subs_excluded: 0 });
      // No limit flag, no cache fields: nothing limited, never cached.
      expect(parsed).toMatchObject({ profile_only_limited: false, computed_at: null, cached: false });
    }
    // leads_recent_candidates: the limit flag and the cache stamp.
    expect(parseLeadsProfileCandidates({ ...payload, profile_only_limited: true, computed_at: "2026-10-07T10:00:00.123456+00:00", cached: true })).toMatchObject({
      profile_only_limited: true,
      computed_at: "2026-10-07T10:00:00.123Z",
      cached: true,
    });
    // The old leads_profile_candidates (the fallback): its truncation flag is the limit flag.
    expect(parseLeadsProfileCandidates({ ...payload, profile_leads_total: "70000", profile_leads_truncated: true })).toMatchObject({
      profile_only_limited: true,
      computed_at: null,
      cached: false,
    });
    expect(parseLeadsProfileCandidates(null)).toEqual({
      profile_leads: [], profile_only_limited: false, subscription_leads: [],
      kpis: { emails_found: 0, converted_excluded: 0, active_subs_excluded: 0 },
      computed_at: null, cached: false,
    });
  });

  it("recognizes PostgREST's missing-function answer (PGRST202 / 404) and nothing else", () => {
    expect(isMissingRpcError({ code: "PGRST202", message: "x" })).toBe(true);
    expect(isMissingRpcError({ message: "Could not find the function public.leads_recent_candidates(p_data_key) in the schema cache" })).toBe(true);
    expect(isMissingRpcError({ message: "boom" }, 404)).toBe(true);
    for (const error of [{ code: "57014", message: "canceling statement due to statement timeout" }, { message: "permission denied for function" }, null, "PGRST202"]) {
      expect(isMissingRpcError(error, 500), JSON.stringify(error)).toBe(false);
    }
  });
});

// ---- request contract, filters, sort, pages ---------------------------------------------

function sampleRows(): LeadRow[] {
  return mergeLeads({
    warehouse: [
      warehouseCandidate({ customer_id: "u1", email: "alpha@example.com", session_date: "2026-06-21T08:00:00.000Z", country: "US", has_declines: true }),
      warehouseCandidate({ customer_id: "u2", email: "bravo@example.com", session_date: "2026-06-10T08:00:00.000Z", funnel: "starseed", country: null, utm_source: "22", has_declines: false, decline_reason: null }),
    ],
    profiles: [
      profileCandidate({ profile_id: "p1", email: "charlie@example.com", lead_date: "2026-06-18T00:00:00.000Z", campaign_path: "soulmate-quiz", country: "gb" }),
      profileCandidate({ profile_id: "p2", email: "bravo@example.com", lead_date: "2026-06-01T00:00:00.000Z" }),
    ],
    subscriptions: [
      { email: "delta@example.com", lead_date: null, funnel: "past_life", customer_id: "sub_d" },
    ],
    now: NOW,
  });
}

const filtersOf = (filters: Record<string, unknown>): NormalizedLeadsFilters => normalizeLeadsRequest({ action: "leads_list", filters }).filters;

describe("normalizeLeadsRequest", () => {
  it("defaults: lead_date desc, page 1, 50 rows, every source", () => {
    expect(normalizeLeadsRequest({ action: "leads_list" })).toEqual({
      action: "leads_list",
      filters: { search: "", dateFrom: null, dateTo: null, funnel: [], campaignPath: [], campaignId: [], mediaBuyer: [], country: [], source: [], hasDeclines: "all" },
      sortKey: "lead_date",
      sortDir: "desc",
      page: 1,
      pageSize: 50,
      refresh: false,
    });
  });

  it("normalizes filters, the sort and paging", () => {
    const normalized = normalizeLeadsRequest({
      action: "leads_overview",
      filters: { search: "  Bob ", date_from: "2026-06-01", date_to: "2026-06-30", funnel: ["soulmate", "soulmate", " "], country: ["us", "unknown"], source: ["warehouse", "both"], has_declines: "yes" },
      sort: { key: "email", dir: "asc" },
      page: "3",
      page_size: 5000,
      refresh: true,
    });
    expect(normalized.filters).toMatchObject({ search: "Bob", dateFrom: "2026-06-01", dateTo: "2026-06-30", funnel: ["soulmate"], country: ["US", UNKNOWN_COUNTRY], source: ["warehouse", "both"], hasDeclines: "has" });
    expect(normalized).toMatchObject({ action: "leads_overview", sortKey: "email", sortDir: "asc", page: 3, pageSize: 200, refresh: true });
    expect(normalizeLeadsRequest({ action: "leads_list", filters: { source: "all", has_declines: false } }).filters).toMatchObject({ source: [], hasDeclines: "none" });
    expect(normalizeLeadsRequest({ action: "leads_list", page: -2, page_size: 0 })).toMatchObject({ page: 1, pageSize: 50 });
  });

  it.each([
    ["an unknown sort key", { action: "leads_list", sort: { key: "raw_payload" } }],
    ["a malformed date", { action: "leads_list", filters: { date_from: "2026-6-1" } }],
    ["an inverted date range", { action: "leads_list", filters: { date_from: "2026-06-30", date_to: "2026-06-01" } }],
    ["a non-array list filter", { action: "leads_list", filters: { funnel: "soulmate" } }],
    ["an oversized list filter", { action: "leads_list", filters: { campaign_id: Array.from({ length: 501 }, (_, i) => `c${i}`) } }],
    ["an unknown source", { action: "leads_list", filters: { source: "csv" } }],
    ["a non-object filters", { action: "leads_list", filters: "x" }],
    ["a users action", { action: "list" }],
  ])("rejects %s with LeadsRequestError", (_label, body) => {
    expect(() => normalizeLeadsRequest(body)).toThrow(LeadsRequestError);
  });
});

describe("filter / sort / paginate", () => {
  const rows = sampleRows();
  const keys = (list: LeadRow[]) => list.map((row) => row.key);

  it("the sample covers every source", () => {
    expect(rows.map((row) => [row.key, row.source])).toEqual([
      ["w:u1", "warehouse"], ["w:u2", "both"], ["p:p1", "funnelfox_profile"], ["s:delta@example.com", "funnelfox_subscription"],
    ]);
  });

  it("filters by search, dates, lists, the Unknown country, source and declines", () => {
    expect(keys(filterLeadRows(rows, filtersOf({ search: "BRAVO" })))).toEqual(["w:u2"]);
    expect(keys(filterLeadRows(rows, filtersOf({ search: "p1" })))).toEqual(["p:p1"]);
    expect(keys(filterLeadRows(rows, filtersOf({ date_from: "2026-06-02", date_to: "2026-06-20" })))).toEqual(["p:p1"]);
    expect(keys(filterLeadRows(rows, filtersOf({ date_from: "2026-06-01" })))).toEqual(["w:u1", "w:u2", "p:p1"]); // undated row excluded
    expect(keys(filterLeadRows(rows, filtersOf({ funnel: ["starseed", "past_life"] })))).toEqual(["w:u2", "s:delta@example.com"]);
    expect(keys(filterLeadRows(rows, filtersOf({ campaign_path: ["soulmate-quiz"] })))).toEqual(["p:p1"]);
    expect(keys(filterLeadRows(rows, filtersOf({ media_buyer: ["Artem D"] })))).toEqual(["w:u2"]);
    expect(keys(filterLeadRows(rows, filtersOf({ country: ["gb"] })))).toEqual(["p:p1"]);
    expect(keys(filterLeadRows(rows, filtersOf({ country: ["Unknown"] })))).toEqual(["w:u2", "s:delta@example.com"]);
    expect(keys(filterLeadRows(rows, filtersOf({ country: ["US", "Unknown"] })))).toEqual(["w:u1", "w:u2", "s:delta@example.com"]);
    expect(keys(filterLeadRows(rows, filtersOf({ source: "both" })))).toEqual(["w:u2"]);
    expect(keys(filterLeadRows(rows, filtersOf({ source: ["funnelfox_profile", "funnelfox_subscription"] })))).toEqual(["p:p1", "s:delta@example.com"]);
    expect(keys(filterLeadRows(rows, filtersOf({ has_declines: "has" })))).toEqual(["w:u1"]);
    expect(keys(filterLeadRows(rows, filtersOf({ has_declines: "none" })))).toEqual(["w:u2", "p:p1", "s:delta@example.com"]);
  });

  it("sorts by the allowlisted key, missing values last in both directions, ties by row key", () => {
    expect(keys(sortLeadRows(rows, "lead_date", "desc"))).toEqual(["w:u1", "p:p1", "w:u2", "s:delta@example.com"]);
    expect(keys(sortLeadRows(rows, "lead_date", "asc"))).toEqual(["w:u2", "p:p1", "w:u1", "s:delta@example.com"]);
    expect(keys(sortLeadRows(rows, "email", "asc"))).toEqual(["w:u1", "w:u2", "p:p1", "s:delta@example.com"]);
    expect(keys(sortLeadRows(rows, "country", "asc"))).toEqual(["p:p1", "w:u1", "s:delta@example.com", "w:u2"]);
    expect(keys(sortLeadRows(rows, "has_declines", "desc"))).toEqual(["w:u1", "p:p1", "s:delta@example.com", "w:u2"]);
    expect(keys(sortLeadRows(rows, "days_since_visit", "asc"))).toEqual(["w:u1", "p:p1", "w:u2", "s:delta@example.com"]);
    expect(rows.map((row) => row.key)).toEqual(["w:u1", "w:u2", "p:p1", "s:delta@example.com"]); // input untouched
  });

  it("keepNewestLeads: the newest N by lead date, ties by row key, undated last; oldestLeadDate ignores undated rows", () => {
    const at = (key: string, leadDate: string | null): LeadRow => ({ ...rows[0], key, lead_date: leadDate });
    const set = [
      at("p:b", "2026-06-20T00:00:00.000Z"),
      at("s:undated", null),
      at("p:a", "2026-06-20T00:00:00.000Z"), // ties with p:b: the key decides
      at("w:new", "2026-06-21T00:00:00.000Z"),
      at("p:old", "2026-06-01T00:00:00.000Z"),
    ];
    expect(keepNewestLeads(set, 3).map((row) => row.key)).toEqual(["w:new", "p:a", "p:b"]);
    expect(keepNewestLeads(set, 2).map((row) => row.key)).toEqual(["w:new", "p:a"]);
    expect(keepNewestLeads(set, 10).map((row) => row.key)).toEqual(["w:new", "p:a", "p:b", "p:old", "s:undated"]);
    expect(keepNewestLeads(set, 0)).toEqual([]);
    expect(set.map((row) => row.key)).toEqual(["p:b", "s:undated", "p:a", "w:new", "p:old"]); // input untouched
    // Same result as the page's default sort, so page 1 of the cut set is page 1 of the whole set.
    expect(keepNewestLeads(set, 4)).toEqual(sortLeadRows(set, "lead_date", "desc").slice(0, 4));

    expect(oldestLeadDate(keepNewestLeads(set, 3))).toBe("2026-06-20T00:00:00.000Z");
    expect(oldestLeadDate(set)).toBe("2026-06-01T00:00:00.000Z");
    expect(oldestLeadDate([at("s:undated", null)])).toBeNull();
    expect(oldestLeadDate([])).toBeNull();
  });

  it("paginates with totals", () => {
    const sorted = sortLeadRows(rows, "email", "asc");
    expect(paginateLeadRows(sorted, 2, 3)).toEqual({ rows: [sorted[3]], pagination: { page: 2, page_size: 3, total_rows: 4, total_pages: 2 } });
    expect(paginateLeadRows(sorted, 5, 3).rows).toEqual([]);
    expect(paginateLeadRows([], 1, 50).pagination).toEqual({ page: 1, page_size: 50, total_rows: 0, total_pages: 1 });
  });

  it("filter options carry counts, A→Z, the Unknown country last and sources in merge order", () => {
    const options = leadsFilterOptions(rows);
    expect(options.funnel).toEqual([{ value: "past_life", count: 1 }, { value: "soulmate", count: 2 }, { value: "starseed", count: 1 }]);
    expect(options.country).toEqual([{ value: "GB", count: 1 }, { value: "US", count: 1 }, { value: UNKNOWN_COUNTRY, count: 2 }]);
    expect(options.campaign_id).toEqual([{ value: "cmp_1", count: 2 }]);
    expect(options.source.map((entry) => entry.value)).toEqual(["warehouse", "funnelfox_profile", "both", "funnelfox_subscription"]);
  });

  it("summary counts today / the last 7 days on lead_date and passes the RPC KPIs through", () => {
    expect(leadsSummary(rows, { emails_found: 40, converted_excluded: 30, active_subs_excluded: 2 }, NOW)).toEqual({
      total_leads: 4, emails_found: 40, converted_excluded: 30, active_subs_excluded: 2, leads_today: 1, leads_last_7_days: 2,
    });
  });
});

// ---- runners: tenant binding, memo, errors -------------------------------------------------

const WAREHOUSE_ROW = {
  customer_id: "u1", email: "lead@example.com", first_touch_ms: String(Date.parse("2026-06-10T10:00:00.000Z")), funnel: "soulmate",
  campaign_path: "soulmate-reading", campaign_id: "cmp_1", utm_source: "4", country: "US", has_declines: 1, decline_reason: "do_not_honor", user_agent: "",
};

describe("runLeadsList / runLeadsOverview", () => {
  it("bind the workspace tenant everywhere (ScopedReader param, both RPCs, the sync state)", async () => {
    const input = runInput({
      warehouse: fakeWarehouse([WAREHOUSE_ROW]),
      pgOptions: { syncState: { auth_user_id: DATA_KEY, last_status: "ok" } },
      request: { action: "leads_overview" },
    });
    const response = await runLeadsOverview(input);
    expect(response.ok).toBe(true);
    expect(input.warehouse.queries).toHaveLength(1);
    expect(input.warehouse.queries[0].params).toEqual({ auth_user_id: DATA_KEY });
    expect(input.pgFake.rpc).toHaveBeenCalledWith("leads_recent_candidates", { p_data_key: DATA_KEY, p_limit: LEADS_RECENT_LIMIT, p_max_age_seconds: LEADS_CANDIDATES_MAX_AGE_SECONDS });
    expect(input.pgFake.rpc).not.toHaveBeenCalledWith("leads_profile_candidates", expect.anything());
    expect(input.pgFake.rpc).toHaveBeenCalledWith("active_funnelfox_subscription_emails", { p_data_key: DATA_KEY });
    expect(input.pgFake.eq).toHaveBeenCalledWith("funnelfox_leads_sync_state", "auth_user_id", DATA_KEY);
    expect(LEADS_RECENT_LIMIT).toBe(1_000);
    expect(LEADS_CANDIDATES_MAX_AGE_SECONDS).toBe(900);
  });

  it("asks for exactly the limit the SQL defaults to (the pg_cron job caches that default; another limit never hits the cache)", () => {
    const sql = readFileSync(resolve(process.cwd(), "supabase/migrations/202610070001_leads_recent_candidates.sql"), "utf8");
    const defaultOf = (fn: string) => {
      const match = new RegExp(`create or replace function public\\.${fn}\\(([^)]*)\\)`, "i").exec(sql);
      const limit = match ? /p_limit integer default (\d+)/i.exec(match[1]) : null;
      return limit ? Number(limit[1]) : null;
    };
    expect(defaultOf("leads_recent_candidates")).toBe(LEADS_RECENT_LIMIT);
    expect(defaultOf("leads_refresh_recent_candidates")).toBe(LEADS_RECENT_LIMIT);
    expect(defaultOf("leads_recent_candidates_compute")).toBe(LEADS_RECENT_LIMIT);
    expect(sql).toMatch(/p_max_age_seconds integer default 900/);
    expect(sql).toMatch(/cron\.schedule\(\s*'funnelfox-leads-recent-cache',\s*'\*\/5 \* \* \* \*',\s*\$\$select public\.leads_refresh_recent_candidates\(\)\$\$/);
  });

  it("falls back to the old leads_profile_candidates while migration 202610070001 is not applied (PGRST202)", async () => {
    const input = runInput({
      warehouse: fakeWarehouse([]),
      pgOptions: {
        recentMissing: true,
        legacyCandidates: {
          profile_leads: [{ profile_id: "p1", email: "old@example.com", lead_date: "2026-06-20T00:00:00+00:00" }],
          profile_leads_total: 5_000,
          profile_leads_truncated: true,
          subscription_leads: [],
          kpis: { emails_found: 7, converted_excluded: 2, active_subs_excluded: 1 },
        },
      },
      request: { action: "leads_overview" },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const response = await runLeadsOverview(input);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("leads_recent_candidates is missing"));
    warn.mockRestore();
    // The old cap (what the previous build sent), not LEADS_RECENT_LIMIT: the old RPC
    // ranks warehouse-email profiles with the rest, and the "both" merge needs the older ones.
    expect(input.pgFake.rpc).toHaveBeenCalledWith("leads_profile_candidates", { p_data_key: DATA_KEY, p_profile_limit: LEADS_LEGACY_PROFILE_LIMIT });
    expect(LEADS_LEGACY_PROFILE_LIMIT).toBe(50_000);
    expect(response.summary).toMatchObject({ total_leads: 1, emails_found: 7, converted_excluded: 2, active_subs_excluded: 1 });
    // The old RPC's truncation flag says older leads were left out; it has no cache.
    expect(response.diagnostics).toMatchObject({
      lead_set_limit: LEADS_RECENT_LIMIT, lead_set_limited: true, lead_set_oldest_date: "2026-06-20T00:00:00.000Z",
      candidates_computed_at: null, candidates_cached: false,
    });

    resetLeadsMemo();
    const failing = runInput({ pgOptions: { recentMissing: true, legacyError: "canceling statement due to statement timeout" } });
    const quiet = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(runLeadsList(failing)).rejects.toThrow("Could not load FunnelFox lead candidates: canceling statement due to statement timeout");
    quiet.mockRestore();
  });

  it("any other candidates error fails the request without the fallback (a timeout is not a missing function)", async () => {
    const input = runInput({ pgOptions: { candidatesError: "canceling statement due to statement timeout" } });
    await expect(runLeadsList(input)).rejects.toThrow("Could not load FunnelFox lead candidates: canceling statement due to statement timeout");
    expect(input.pgFake.rpc).not.toHaveBeenCalledWith("leads_profile_candidates", expect.anything());
    // A plain load already accepted the cron's payload: no retry.
    expect(input.pgFake.rpc.mock.calls.filter(([fn]) => fn === "leads_recent_candidates")).toHaveLength(1);
  });

  const recentMaxAges = (fake: ReturnType<typeof fakePg>) =>
    fake.rpc.mock.calls.filter(([fn]) => fn === "leads_recent_candidates").map(([, params]) => params?.p_max_age_seconds);

  it("a refresh request asks for candidates at most a minute old (it must see data newer than itself); a plain load accepts the cron's", async () => {
    expect(LEADS_CANDIDATES_REFRESH_MAX_AGE_SECONDS).toBe(60);
    const warehouse = fakeWarehouse([WAREHOUSE_ROW]);
    const plain = runInput({ warehouse });
    expect((await runLeadsList(plain)).diagnostics.memo).toBe("miss");
    expect(recentMaxAges(plain.pgFake)).toEqual([LEADS_CANDIDATES_MAX_AGE_SECONDS]);

    const refreshed = runInput({ warehouse, request: { action: "leads_list", refresh: true } });
    expect((await runLeadsList(refreshed)).diagnostics.memo).toBe("refresh");
    expect(refreshed.pgFake.rpc).toHaveBeenCalledWith("leads_recent_candidates", {
      p_data_key: DATA_KEY, p_limit: LEADS_RECENT_LIMIT, p_max_age_seconds: LEADS_CANDIDATES_REFRESH_MAX_AGE_SECONDS,
    });
    expect(recentMaxAges(refreshed.pgFake)).toEqual([LEADS_CANDIDATES_REFRESH_MAX_AGE_SECONDS]);

    // The refreshed set is memoized: the next plain request is a hit, no RPC.
    const after = runInput({ warehouse });
    expect((await runLeadsList(after)).diagnostics.memo).toBe("hit");
    expect(recentMaxAges(after.pgFake)).toEqual([]);
  });

  it("a refresh whose inline compute fails retries once with the cron's payload; when that fails too the request fails", async () => {
    const timeout = { maxAge: LEADS_CANDIDATES_REFRESH_MAX_AGE_SECONDS, code: "57014", message: "canceling statement due to statement timeout" };
    const input = runInput({
      request: { action: "leads_list", refresh: true },
      pgOptions: {
        candidatesErrorAtMaxAge: timeout,
        candidates: {
          profile_leads: [{ profile_id: "p1", email: "new@example.com", lead_date: "2026-06-20T00:00:00+00:00" }],
          subscription_leads: [], kpis: {}, computed_at: "2026-06-21T11:57:00+00:00", cached: true,
        },
      },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const response = await runLeadsList(input);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("retrying with the cached payload"), expect.objectContaining({ code: "57014" }));
    warn.mockRestore();
    expect(response.pagination.total_rows).toBe(1);
    expect(response.diagnostics).toMatchObject({ candidates_cached: true, candidates_computed_at: "2026-06-21T11:57:00.000Z" });
    expect(recentMaxAges(input.pgFake)).toEqual([LEADS_CANDIDATES_REFRESH_MAX_AGE_SECONDS, LEADS_CANDIDATES_MAX_AGE_SECONDS]);
    expect(input.pgFake.rpc).not.toHaveBeenCalledWith("leads_profile_candidates", expect.anything());

    resetLeadsMemo();
    const failing = runInput({ request: { action: "leads_list", refresh: true }, pgOptions: { candidatesError: "canceling statement due to statement timeout" } });
    const quiet = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(runLeadsList(failing)).rejects.toThrow("Could not load FunnelFox lead candidates: canceling statement due to statement timeout");
    quiet.mockRestore();
    expect(recentMaxAges(failing.pgFake)).toEqual([LEADS_CANDIDATES_REFRESH_MAX_AGE_SECONDS, LEADS_CANDIDATES_MAX_AGE_SECONDS]);
    expect(failing.pgFake.rpc).not.toHaveBeenCalledWith("leads_profile_candidates", expect.anything());
  });

  it("a refresh before migration 202610070001 goes straight to the old RPC (no retry of the missing function)", async () => {
    const input = runInput({ request: { action: "leads_list", refresh: true }, pgOptions: { recentMissing: true } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await runLeadsList(input);
    warn.mockRestore();
    expect(recentMaxAges(input.pgFake)).toEqual([LEADS_CANDIDATES_REFRESH_MAX_AGE_SECONDS]);
    expect(input.pgFake.rpc).toHaveBeenCalledWith("leads_profile_candidates", { p_data_key: DATA_KEY, p_profile_limit: LEADS_LEGACY_PROFILE_LIMIT });
  });

  it("a runner handed another tenant is a scope violation, not a silent override", async () => {
    const ctx = ownerContext();
    const input = runInput({ ctx, tenantKey: OTHER_KEY, warehouse: fakeWarehouse([WAREHOUSE_ROW]) });
    await expect(runLeadsList(input)).rejects.toBeInstanceOf(ScopeViolation);
    expect(ctx.violations).toContain("tenant_param_mismatch");
    expect(input.warehouse.queries).toEqual([]);
  });

  it("a ScopeViolation is never swallowed (restricted context; overview's best-effort sync read included)", async () => {
    const ctx = ownerContext({ scope: "selected" });
    const list = runInput({ ctx, warehouse: fakeWarehouse([WAREHOUSE_ROW]) });
    await expect(runLeadsList(list)).rejects.toBeInstanceOf(ScopeViolation);
    resetLeadsMemo();
    const overview = runInput({ ctx, warehouse: fakeWarehouse([WAREHOUSE_ROW]), request: { action: "leads_overview" } });
    await expect(runLeadsOverview(overview)).rejects.toBeInstanceOf(ScopeViolation);
    expect(ctx.violations.length).toBeGreaterThan(0);
    expect(list.warehouse.queries).toEqual([]);

    const throwing = { from: () => { throw new ScopeViolation("restricted_protected_table", "x"); } } as unknown as LeadsRunInput["pg"];
    await expect(readLeadsSyncState(throwing, DATA_KEY, NOW)).rejects.toBeInstanceOf(ScopeViolation);
  });

  it("a malformed request is a LeadsRequestError before any read", async () => {
    const input = runInput({ warehouse: fakeWarehouse([WAREHOUSE_ROW]), request: { action: "leads_list", sort: { key: "password" } } });
    await expect(runLeadsList(input)).rejects.toBeInstanceOf(LeadsRequestError);
    expect(input.warehouse.queries).toEqual([]);
    expect(input.pgFake.rpc).not.toHaveBeenCalled();
  });

  it("a failing candidates RPC fails the request (the lead set would be silently partial)", async () => {
    const input = runInput({ warehouse: fakeWarehouse([WAREHOUSE_ROW]), pgOptions: { candidatesError: "function does not exist" } });
    await expect(runLeadsList(input)).rejects.toThrow("Could not load FunnelFox lead candidates: function does not exist");
  });

  it("merges the three sources and pages the result", async () => {
    const input = runInput({
      warehouse: fakeWarehouse([WAREHOUSE_ROW, { ...WAREHOUSE_ROW, customer_id: "u-active", email: "active@example.com" }]),
      pgOptions: {
        active: { "active@example.com": ["sub-a"] },
        candidates: {
          profile_leads: [
            { profile_id: "p1", email: "lead@example.com", lead_date: "2026-06-09T00:00:00+00:00" },
            { profile_id: "p2", email: "new@example.com", lead_date: "2026-06-20T00:00:00+00:00", campaign_path: "starseed-quiz" },
          ],
          profile_only_limited: false,
          computed_at: "2026-06-21T11:58:00+00:00",
          cached: true,
          subscription_leads: [{ email: "sub@example.com", lead_date: "2026-06-19T00:00:00+00:00", funnel: "past_life", customer_id: "prof_s" }],
          kpis: { emails_found: 9, converted_excluded: 4, active_subs_excluded: 1 },
        },
        profileDetails: [
          { profile_id: "p1", user_agent: "UA-1", origin: "https://o/1" },
          { profile_id: "p2", user_agent: "UA-2", origin: "https://o/2" },
          { auth_user_id: OTHER_KEY, profile_id: "p2", user_agent: "LEAK", origin: "LEAK" },
        ],
      },
      request: { action: "leads_list", page: 1, page_size: 2 },
    });
    const response = await runLeadsList(input);
    expect(response.rows.map((row) => [row.key, row.source])).toEqual([["p:p2", "funnelfox_profile"], ["s:sub@example.com", "funnelfox_subscription"]]);
    expect(response.pagination).toEqual({ page: 1, page_size: 2, total_rows: 3, total_pages: 2 });
    expect(response.diagnostics).toEqual({
      warehouse_leads: 0, profile_leads: 1, both_leads: 1, subscription_leads: 1, memo: "miss", dataset_age_ms: 0,
      // Three leads, well under the limit: nothing was left out.
      lead_set_limit: LEADS_RECENT_LIMIT, lead_set_limited: false, lead_set_oldest_date: "2026-06-09T00:00:00.000Z",
      candidates_computed_at: "2026-06-21T11:58:00.000Z", candidates_cached: true,
    });
    // user_agent / origin are read for the page's profile rows only, tenant-bound.
    expect(input.pgFake.detailReads).toEqual([{ columns: "profile_id,user_agent,origin", ids: ["p2"], tenant: DATA_KEY }]);
    expect(response.rows[0]).toMatchObject({ user_agent: "UA-2", origin: "https://o/2" });
    expect(response.rows[1]).toMatchObject({ user_agent: null, origin: null });
    expect(JSON.stringify(response)).not.toMatch(/active@example\.com|SELECT|auth_user_id|LEAK/);

    // Page 2 (memo hit): the "both" row gets its profile's details.
    const page2 = await runLeadsList({ ...input, request: { action: "leads_list", page: 2, page_size: 2 } });
    expect(page2.rows).toHaveLength(1);
    expect(page2.rows[0]).toMatchObject({ key: "w:u1", source: "both", user_agent: "UA-1", origin: "https://o/1" });
    expect(input.pgFake.detailReads.at(-1)).toEqual({ columns: "profile_id,user_agent,origin", ids: ["p1"], tenant: DATA_KEY });
    // The memoized rows themselves were never written into.
    const page2Again = await runLeadsList({ ...input, pg: fakePg({}).client, request: { action: "leads_list", page: 2, page_size: 2 } });
    expect(page2Again.rows[0]).toMatchObject({ user_agent: null, origin: null });
  });

  it("the page's profile details are best effort: a failed read keeps the merged values and says so", async () => {
    const input = runInput({
      warehouse: fakeWarehouse([{ ...WAREHOUSE_ROW, user_agent: "WarehouseUA" }]),
      pgOptions: {
        candidates: { profile_leads: [{ profile_id: "p1", email: "lead@example.com", lead_date: "2026-06-09T00:00:00+00:00" }], subscription_leads: [], kpis: {} },
        profileDetailsError: "statement timeout",
      },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const response = await runLeadsList(input);
    warn.mockRestore();
    expect(response.rows).toEqual([expect.objectContaining({ key: "w:u1", source: "both", user_agent: "WarehouseUA", origin: null })]);
    expect(response.diagnostics.profile_details_unavailable).toBe(true);
  });

  it("keeps only the newest LEADS_RECENT_LIMIT leads: list, search, filters, options and lead counts cover them; the whole-base KPIs pass through", async () => {
    // 1,200 profile-only leads, one per minute back from NOW - 30 min (newest p0000),
    // 400 warehouse leads one per hour back from NOW - 2 days, 3 subscription leads (one undated).
    const minute = 60_000;
    const iso = (ms: number) => new Date(ms).toISOString();
    const profiles = Array.from({ length: 1_200 }, (_, i) => ({
      profile_id: `p${String(i).padStart(4, "0")}`,
      email: `profile${i}@example.com`,
      lead_date: iso(NOW - 30 * minute - i * minute),
      campaign_path: i % 2 ? "soulmate-quiz" : "starseed-quiz",
    }));
    const warehouse = Array.from({ length: 400 }, (_, i) => ({
      ...WAREHOUSE_ROW, customer_id: `u${i}`, email: `wh${i}@example.com`, first_touch_ms: String(NOW - 2 * 86_400_000 - i * 3_600_000),
    }));
    const input = runInput({
      warehouse: fakeWarehouse(warehouse),
      pgOptions: {
        candidates: {
          profile_leads: profiles,
          profile_only_limited: true,
          subscription_leads: [
            { email: "sub-new@example.com", lead_date: iso(NOW - 10 * minute), funnel: "soulmate", customer_id: "s1" },
            { email: "sub-old@example.com", lead_date: "2025-01-01T00:00:00+00:00", funnel: "soulmate", customer_id: "s2" },
            { email: "sub-undated@example.com", lead_date: null, funnel: "soulmate", customer_id: "s3" },
          ],
          kpis: { emails_found: 230_265, converted_excluded: 14_744, active_subs_excluded: 120 },
          computed_at: iso(NOW - 4 * minute),
          cached: true,
        },
      },
      request: { action: "leads_overview" },
    });
    const overview = await runLeadsOverview(input);
    expect(overview.summary).toEqual({
      total_leads: LEADS_RECENT_LIMIT,
      // Whole base, untouched by the cut.
      emails_found: 230_265, converted_excluded: 14_744, active_subs_excluded: 120,
      // Over the kept 1,000 (NOW = 12:00 UTC): sub-new + p0000..p0690 came in today
      // (11:30 back to 00:00), all of them in the last 7 days.
      leads_today: 692,
      leads_last_7_days: LEADS_RECENT_LIMIT,
    });
    // The newest 1,000 are: sub-new (NOW - 10 min) + p0000..p0998 (NOW - 30 min .. NOW - 1,028 min).
    // The warehouse leads (2+ days old), sub-old and the undated sub are left out.
    expect(overview.diagnostics).toMatchObject({
      warehouse_leads: 0, profile_leads: 999, both_leads: 0, subscription_leads: 1,
      lead_set_limit: 1_000, lead_set_limited: true, lead_set_oldest_date: iso(NOW - 30 * minute - 998 * minute),
      candidates_computed_at: iso(NOW - 4 * minute), candidates_cached: true,
    });
    expect(overview.filter_options.source).toEqual([{ value: "funnelfox_profile", count: 999 }, { value: "funnelfox_subscription", count: 1 }]);
    expect(overview.filter_options.campaign_path.reduce((total, option) => total + option.count, 0)).toBe(1_000);

    // The list pages over the same 1,000 rows (memo hit), newest first.
    const list = await runLeadsList({ ...input, request: { action: "leads_list", page: 20, page_size: 50 } });
    expect(list.pagination).toEqual({ page: 20, page_size: 50, total_rows: 1_000, total_pages: 20 });
    expect(list.rows.at(-1)?.key).toBe("p:p0998");
    // Search and filters cannot reach a lead outside the cut.
    const outside = await runLeadsList({ ...input, request: { action: "leads_list", filters: { search: "profile1100@" } } });
    expect(outside.pagination.total_rows).toBe(0);
    const inside = await runLeadsList({ ...input, request: { action: "leads_list", filters: { search: "profile998@" } } });
    expect(inside.rows.map((row) => row.key)).toEqual(["p:p0998"]);
    const warehouseOnly = await runLeadsList({ ...input, request: { action: "leads_list", filters: { source: "warehouse" } } });
    expect(warehouseOnly.pagination.total_rows).toBe(0);
    // Sorting another way still sorts the kept set only.
    const oldestFirst = await runLeadsList({ ...input, request: { action: "leads_list", sort: { key: "lead_date", dir: "asc" }, page_size: 1 } });
    expect(oldestFirst.rows.map((row) => row.key)).toEqual(["p:p0998"]);
  });

  it("a 'both' row competes with its merged (earlier) date: an old profile date drops it even when the warehouse date is new", async () => {
    const minute = 60_000;
    const iso = (ms: number) => new Date(ms).toISOString();
    const profiles = Array.from({ length: LEADS_RECENT_LIMIT }, (_, i) => ({
      profile_id: `p${String(i).padStart(4, "0")}`, email: `profile${i}@example.com`, lead_date: iso(NOW - 60 * minute - i * minute),
    }));
    const input = runInput({
      warehouse: fakeWarehouse([
        // First touch 1 minute ago, but its profile came in two years ago: lead_date = the profile's.
        { ...WAREHOUSE_ROW, customer_id: "u-both", email: "both@example.com", first_touch_ms: String(NOW - minute) },
        // Warehouse-only and new: kept.
        { ...WAREHOUSE_ROW, customer_id: "u-new", email: "new@example.com", first_touch_ms: String(NOW - 2 * minute) },
      ]),
      pgOptions: {
        candidates: {
          profile_leads: [...profiles, { profile_id: "p-both", email: "both@example.com", lead_date: "2024-10-01T00:00:00+00:00" }],
          profile_only_limited: false,
          subscription_leads: [],
          kpis: {},
        },
      },
      request: { action: "leads_list", page_size: 200 },
    });
    const response = await runLeadsList(input);
    expect(response.pagination.total_rows).toBe(LEADS_RECENT_LIMIT);
    const keys = new Set<string>();
    for (let page = 1; page <= response.pagination.total_pages; page += 1) {
      const next = await runLeadsList({ ...input, request: { action: "leads_list", page, page_size: 200 } });
      for (const row of next.rows) keys.add(row.key);
    }
    expect(keys.has("w:u-new")).toBe(true);
    expect(keys.has("w:u-both")).toBe(false);
    // 1,002 merged leads (1,000 profiles + 2 warehouse): the cut left two out, the oldest profile and the both row.
    expect(keys.has("p:p0999")).toBe(false);
    expect(keys.has("p:p0998")).toBe(true);
    expect(response.diagnostics).toMatchObject({ lead_set_limited: true, both_leads: 0, warehouse_leads: 1, profile_leads: 999 });
  });

  it("the cut keeps the per-page profile details only for kept rows", async () => {
    const candidates = {
      profile_leads: Array.from({ length: LEADS_RECENT_LIMIT + 5 }, (_, i) => ({
        profile_id: `p${String(i).padStart(4, "0")}`, email: `profile${i}@example.com`, lead_date: new Date(NOW - (i + 1) * 60_000).toISOString(),
      })),
      profile_only_limited: true,
      subscription_leads: [],
      kpis: {},
    };
    const dropped = ["p1000", "p1001", "p1002", "p1003", "p1004"];
    const input = runInput({
      warehouse: fakeWarehouse([]),
      pgOptions: {
        candidates,
        profileDetails: [
          { profile_id: "p0999", user_agent: "UA-kept", origin: "https://o/kept" },
          ...dropped.map((profile_id) => ({ profile_id, user_agent: "UA-dropped", origin: "https://o/dropped" })),
        ],
      },
      request: { action: "leads_list", page: 20, page_size: 50 },
    });
    const response = await runLeadsList(input);
    expect(response.rows.at(-1)).toMatchObject({ key: "p:p0999", user_agent: "UA-kept", origin: "https://o/kept" });
    expect(input.pgFake.detailReads).toHaveLength(1);
    expect(input.pgFake.detailReads[0].ids).toHaveLength(50);
    // Page 21 exists only without the cut (p1000..p1004 sit at indices 1,000..1,004):
    // with it the page is empty and no profile details are read.
    const beyond = await runLeadsList({ ...input, request: { action: "leads_list", page: 21, page_size: 50 } });
    expect(beyond.diagnostics.memo).toBe("hit");
    expect(beyond.rows).toEqual([]);
    expect(beyond.pagination).toEqual({ page: 21, page_size: 50, total_rows: LEADS_RECENT_LIMIT, total_pages: 20 });
    expect(input.pgFake.detailReads).toHaveLength(1);
    expect(input.pgFake.detailReads.flatMap((read) => read.ids).filter((id) => dropped.includes(String(id)))).toEqual([]);

    // The dataset itself: only the kept rows map to a profile id.
    const dataset = await loadLeadsDataset(
      { tenantKey: DATA_KEY, clickhouse: createScopedReader(ownerContext(), fakeWarehouse([]).raw), pg: fakePg({ candidates }).client },
      NOW,
    );
    expect(dataset.rows).toHaveLength(LEADS_RECENT_LIMIT);
    expect(dataset.profileIdByKey.size).toBe(LEADS_RECENT_LIMIT);
    for (const id of dropped) expect(dataset.profileIdByKey.has(`p:${id}`), id).toBe(false);
    expect(dataset.profileIdByKey.get("p:p0999")).toBe("p0999");
  });

  it("overview: summary, options and the sanitized sync state", async () => {
    const input = runInput({
      warehouse: fakeWarehouse([WAREHOUSE_ROW]),
      pgOptions: {
        candidates: { profile_leads: [], subscription_leads: [], kpis: { emails_found: 5, converted_excluded: 3, active_subs_excluded: 1 } },
        syncState: {
          auth_user_id: DATA_KEY, last_status: "partial", current_stage: "sessions", last_full_sync_at: null, last_error: "FunnelFox said: secret",
          last_profiles_cursor: "cursor-secret", lease_until: new Date(NOW + 30_000).toISOString(),
          profiles_completed: true, sessions_completed: false, reconcile_completed: false,
          stats: { profiles_scanned_total: 1200, profiles_with_email: 300, preview_excluded: 7, all_stages_completed: false, stage: "sessions", note: "free text", cursor: { next: "cursor-secret" } },
        },
      },
      request: { action: "leads_overview" },
    });
    const response = await runLeadsOverview(input);
    expect(response.summary).toEqual({ total_leads: 1, emails_found: 5, converted_excluded: 3, active_subs_excluded: 1, leads_today: 0, leads_last_7_days: 0 });
    expect(response.filter_options.media_buyer).toEqual([{ value: "Ivan", count: 1 }]);
    expect(response.sync_state).toEqual({
      status: "partial",
      current_stage: "sessions",
      last_full_sync_at: null,
      stats: { profiles_scanned_total: 1200, profiles_with_email: 300, preview_excluded: 7, all_stages_completed: false, stage: "sessions" },
      rate_limited_until: null,
      next_tick_hint: "2026-06-21T12:01:00.000Z",
      running: true,
    });
    expect(JSON.stringify(response)).not.toContain("secret");
  });

  it("the sync state degrades to empty on a read error", async () => {
    const input = runInput({ pgOptions: { syncStateError: "column lease_until does not exist" }, request: { action: "leads_overview" } });
    const response = await runLeadsOverview(input);
    expect(response.sync_state).toMatchObject({ status: null, current_stage: null, stats: {}, running: false });
  });
});

describe("sync state projection", () => {
  it("rate limit pause, daily refresh and next-minute hints", () => {
    const paused = buildLeadsSyncState({ last_status: "rate_limited", stats: { rate_limited_until: new Date(NOW + 90_000).toISOString() } }, NOW);
    expect(paused.rate_limited_until).toBe("2026-06-21T12:01:30.000Z");
    expect(paused.next_tick_hint).toBe("2026-06-21T12:01:30.000Z");

    const stale = buildLeadsSyncState({ stats: { rate_limited_until: new Date(NOW - 1).toISOString() } }, NOW);
    expect(stale.rate_limited_until).toBeNull();
    expect(stale.stats.rate_limited_until).toBe("2026-06-21T11:59:59.999Z");

    const complete = buildLeadsSyncState({ profiles_completed: true, sessions_completed: true, reconcile_completed: true, last_full_sync_at: "2026-06-21T06:20:00+00:00" }, NOW);
    expect(complete.next_tick_hint).toBe("2026-06-22T06:15:00.000Z");
    expect(complete.last_full_sync_at).toBe("2026-06-21T06:20:00.000Z");
    expect(buildLeadsSyncState({ stats: { all_stages_completed: true } }, Date.parse("2026-06-21T05:00:00.000Z")).next_tick_hint).toBe("2026-06-21T06:15:00.000Z");

    expect(buildLeadsSyncState(null, NOW)).toEqual({
      status: null, current_stage: null, last_full_sync_at: null, stats: {}, rate_limited_until: null, next_tick_hint: "2026-06-21T12:01:00.000Z", running: false,
    });
  });

  it("keeps only scalar stats and allowlisted text", () => {
    expect(sanitizeSyncStats({ a: 1, b: true, c: null, d: Number.NaN, e: "x", stage: "profiles", rate_limited_until: "t", nested: { cursor: "c" }, list: [1] })).toEqual({
      a: 1, b: true, c: null, stage: "profiles", rate_limited_until: "t",
    });
    expect(sanitizeSyncStats("nope")).toEqual({});
  });
});

describe("per-workspace memo (60 s, in-flight coalescing)", () => {
  it("serves repeated requests from memory within the TTL, then reloads", async () => {
    let now = NOW;
    const warehouse = fakeWarehouse([WAREHOUSE_ROW]);
    const make = (request: Record<string, unknown>) => runInput({ warehouse, request, clock: () => now });

    const first = await runLeadsList(make({ action: "leads_list" }));
    now += 10_000;
    const second = await runLeadsList(make({ action: "leads_list", page: 2, filters: { search: "lead" } }));
    const overview = await runLeadsOverview(make({ action: "leads_overview" }));
    expect(warehouse.queries).toHaveLength(1);
    expect([first.diagnostics.memo, second.diagnostics.memo, overview.diagnostics.memo]).toEqual(["miss", "hit", "hit"]);
    expect(second.diagnostics.dataset_age_ms).toBe(10_000);

    now = NOW + LEADS_MEMO_TTL_MS;
    const third = await runLeadsList(make({ action: "leads_list" }));
    expect(third.diagnostics.memo).toBe("miss");
    expect(warehouse.queries).toHaveLength(2);
  });

  it("coalesces concurrent requests into one load", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const warehouse = fakeWarehouse(async () => {
      await gate;
      return [WAREHOUSE_ROW];
    });
    const pending = [
      runLeadsList(runInput({ warehouse })),
      runLeadsOverview(runInput({ warehouse, request: { action: "leads_overview" } })),
      runLeadsList(runInput({ warehouse, request: { action: "leads_list", page: 2 } })),
    ];
    await new Promise((resolveTick) => setTimeout(resolveTick, 0));
    release();
    const responses = await Promise.all(pending);
    expect(warehouse.queries).toHaveLength(1);
    expect(responses.map((response) => response.diagnostics.memo)).toEqual(["miss", "coalesced", "coalesced"]);
  });

  it("a refresh never joins a plain load already in flight (it may predate the sync); refreshes coalesce with each other", async () => {
    const gates: Array<() => void> = [];
    const results = [[WAREHOUSE_ROW], [WAREHOUSE_ROW, { ...WAREHOUSE_ROW, customer_id: "u2", email: "after-sync@example.com" }]];
    let call = 0;
    const warehouse = fakeWarehouse(async () => {
      const rows = results[Math.min(call, results.length - 1)];
      call += 1;
      await new Promise<void>((resolveGate) => gates.push(resolveGate));
      return rows;
    });
    // A plain list load starts (before the sync finished) …
    const plain = runLeadsList(runInput({ warehouse }));
    await new Promise((resolveTick) => setTimeout(resolveTick, 0));
    // … then the panel sees the finished pass and refreshes the list and the overview together.
    const refreshedList = runLeadsList(runInput({ warehouse, request: { action: "leads_list", refresh: true } }));
    const refreshedOverview = runLeadsOverview(runInput({ warehouse, request: { action: "leads_overview", refresh: true } }));
    await new Promise((resolveTick) => setTimeout(resolveTick, 0));
    for (const open of gates) open();
    const [first, list, overview] = await Promise.all([plain, refreshedList, refreshedOverview]);
    expect(warehouse.queries).toHaveLength(2);
    expect(first.diagnostics.memo).toBe("miss");
    expect(first.pagination.total_rows).toBe(1);
    expect([list.diagnostics.memo, overview.diagnostics.memo]).toEqual(["refresh", "coalesced"]);
    expect(list.pagination.total_rows).toBe(2);
    expect(overview.summary.total_leads).toBe(2);
    // The memo now holds the post-sync set.
    expect((await runLeadsList(runInput({ warehouse }))).diagnostics).toMatchObject({ memo: "hit" });
    expect(warehouse.queries).toHaveLength(2);
  });

  it("refresh bypasses a settled entry", async () => {
    const warehouse = fakeWarehouse([WAREHOUSE_ROW]);
    await runLeadsList(runInput({ warehouse }));
    const refreshed = await runLeadsList(runInput({ warehouse, request: { action: "leads_list", refresh: true } }));
    expect(refreshed.diagnostics.memo).toBe("refresh");
    expect(warehouse.queries).toHaveLength(2);
  });

  it("never caches a failure", async () => {
    let fail = true;
    const warehouse = fakeWarehouse(async () => {
      if (fail) throw new Error("ClickHouse is down");
      return [WAREHOUSE_ROW];
    });
    await expect(runLeadsList(runInput({ warehouse }))).rejects.toThrow("ClickHouse is down");
    fail = false;
    const response = await runLeadsList(runInput({ warehouse }));
    expect(response.diagnostics.memo).toBe("miss");
    expect(response.pagination.total_rows).toBe(1);
    expect(warehouse.queries).toHaveLength(2);
  });

  it("is keyed by workspace: another tenant never sees this one's leads", async () => {
    await runLeadsList(runInput({ warehouse: fakeWarehouse([WAREHOUSE_ROW]) }));
    const otherCtx = ownerContext({ dataKey: OTHER_KEY });
    const other = runInput({ ctx: otherCtx, warehouse: fakeWarehouse([]) });
    const response = await runLeadsList(other);
    expect(response.rows).toEqual([]);
    expect(response.diagnostics.memo).toBe("miss");
    expect(other.warehouse.queries[0].params).toEqual({ auth_user_id: OTHER_KEY });
  });
});

// ---- the Edge entrypoint ------------------------------------------------------------------

describe("clickhouse-users entrypoint", () => {
  const source = readFileSync(resolve(process.cwd(), "supabase/functions/clickhouse-users/index.ts"), "utf8");

  it("branches on the leads actions before the users runners and passes the gate's pg client", () => {
    const leadsBranch = source.indexOf('action === "leads_list" || action === "leads_overview"');
    expect(leadsBranch).toBeGreaterThan(0);
    expect(leadsBranch).toBeLessThan(source.indexOf("runUsersOptions(input)"));
    expect(source).toContain("{ tenantKey: ctx.tenantKey, clickhouse: clickhouse(), pg, request: body }");
    expect(source).toMatch(/async \(\{ ctx, action, body, clickhouse, pg \}\)/);
  });

  it("maps LeadsRequestError to 400 like UsersRequestError", () => {
    expect(source).toContain("error instanceof UsersRequestError || error instanceof LeadsRequestError ? 400 : 502");
  });

  // The gate with the real policy and the same onError shape as index.ts.
  async function callGate(body: Record<string, unknown>, userId: string) {
    const raw = fakeWarehouse([WAREHOUSE_ROW]);
    const pg = fakePg();
    const deps: AccessGateDeps = {
      configError: null,
      pg: { ...(pg.client as object), auth: { getUser: vi.fn() } } as unknown as AccessGateDeps["pg"],
      getUser: vi.fn(async () => ({ data: { user: { id: userId, email: "x@example.com" } }, error: null })),
      loadAccess: vi.fn(async () => ({ data: { ...accessRow(userId), role: userId === DATA_KEY ? accessRow(userId).role : { id: "r", key: "custom", name: "All", is_owner: false, permissions: ["users.view", "users.pii.view", "leads.view"] } }, error: null })),
      workspaceDataKey: vi.fn(async () => ({ data: DATA_KEY, error: null })),
      readEnv: vi.fn(() => undefined),
      createClickHouse: vi.fn((ctx: AccessContext) => createScopedReader(ctx, raw.raw)),
      newRequestId: () => "req-gate",
      log: vi.fn(),
    };
    const handler: AccessHandler<ClickHouseUsersAction> = async ({ ctx, action, body: requestBody, clickhouse, pg: client }) => {
      const input = { tenantKey: ctx.tenantKey, clickhouse: clickhouse(), pg: client, request: requestBody };
      return action === "leads_list" ? runLeadsList(input) : runLeadsOverview(input);
    };
    const req = new Request("https://edge.test/functions/v1/clickhouse-users", {
      method: "POST",
      headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const response = await handleWithAccess(req, CLICKHOUSE_USERS_POLICY, handler, deps, {
      onError: (error) => ({ status: error instanceof LeadsRequestError ? 400 : 502, body: { ok: false, source: "clickhouse", error: error instanceof Error ? error.message : "failed" } }),
    });
    return { status: response.status, json: (await response.json()) as Record<string, unknown>, raw };
  }

  it("serves the data owner, answers a malformed request 400, and refuses a member holding every leads key", async () => {
    const ok = await callGate({ action: "leads_list" }, DATA_KEY);
    expect(ok.status).toBe(200);
    expect((ok.json.rows as LeadRow[]).map((row) => row.key)).toEqual(["w:u1"]);
    expect(ok.raw.queries[0].params).toEqual({ auth_user_id: DATA_KEY });

    const bad = await callGate({ action: "leads_list", sort: { key: "nope" } }, DATA_KEY);
    expect(bad.status).toBe(400);
    expect(bad.json).toMatchObject({ ok: false, source: "clickhouse", error: "Unsupported sort key: nope" });
    expect(bad.raw.queries).toEqual([]);

    const member = await callGate({ action: "leads_overview" }, "22222222-2222-4222-8222-222222222222");
    expect(member.status).toBe(403);
    expect(member.json.error_code).toBe(ACCESS_ERROR.RAW_ACCESS_REQUIRED);
    expect(member.raw.queries).toEqual([]);
  });
});
