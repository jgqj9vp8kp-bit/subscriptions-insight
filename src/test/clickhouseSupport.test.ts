import { describe, expect, it } from "vitest";
import { supportWarehouseVersionFromSummary, WAREHOUSE_DEPENDENT_ROOTS } from "@/services/analyticsCache";
import { buildSupportRequest } from "@/services/supportDataSource";
import { supportListKey } from "@/services/supportCache";
import { parseSupportCsvText } from "@/services/supportAnalytics";
import {
  classifySupportRequestServer,
  enrichSupportAttribution,
  normalizeSupportAttributionEmail,
  normalizeSupportRequest,
  runSupportBundle,
  runSupportDetails,
  runSupportExport,
  runSupportList,
  runSupportOptions,
  runSupportUnansweredContacts,
  supportAttributionStatus,
  SupportRequestError,
  SUPPORT_FACT_COLUMNS,
} from "../../supabase/functions/_shared/clickhouse/support.ts";
import { CREATE_FACT_SUPPORT_REQUESTS_SQL, FACT_SUPPORT_REQUESTS_TABLE } from "../../supabase/functions/_shared/clickhouse/schema.ts";
import type { ClickHouseClientLike, SupabaseLikeClient } from "../../supabase/functions/_shared/clickhouse/types.ts";

function fakeSupabase(snapshot: Record<string, unknown> | null): SupabaseLikeClient {
  return {
    from() {
      const builder = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => ({ data: snapshot, error: null }),
      };
      return builder as never;
    },
  };
}

describe("clickhouse-support architecture", () => {
  it("adds Support to warehouse-dependent invalidation roots", () => {
    expect(WAREHOUSE_DEPENDENT_ROOTS).toContain("support");
  });

  it("includes support sync state in the warehouse version fingerprint", () => {
    const a = supportWarehouseVersionFromSummary({
      support_sync_state: { cursor_transaction_id: "req_1", cursor_updated_at: "2026-07-13T00:00:00.000Z", clickhouse_total: 10, status: "completed" },
    } as never);
    const b = supportWarehouseVersionFromSummary({
      support_sync_state: { cursor_transaction_id: "req_2", cursor_updated_at: "2026-07-13T00:01:00.000Z", clickhouse_total: 11, status: "completed" },
    } as never);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^swhv_/);
  });

  it("defines the fact_support_requests warehouse table", () => {
    expect(FACT_SUPPORT_REQUESTS_TABLE).toBe("fact_support_requests");
    expect(CREATE_FACT_SUPPORT_REQUESTS_SQL).toContain("CREATE TABLE IF NOT EXISTS fact_support_requests");
    expect(CREATE_FACT_SUPPORT_REQUESTS_SQL).toContain("ENGINE = ReplacingMergeTree(row_version)");
    expect(CREATE_FACT_SUPPORT_REQUESTS_SQL).toContain("message_body String");
    expect(CREATE_FACT_SUPPORT_REQUESTS_SQL).toContain("automatic_category");
    expect(CREATE_FACT_SUPPORT_REQUESTS_SQL).toContain("matched_user_id String");
    expect(CREATE_FACT_SUPPORT_REQUESTS_SQL).toContain("funnel LowCardinality(String) DEFAULT 'Unknown'");
    expect(CREATE_FACT_SUPPORT_REQUESTS_SQL).toContain("attribution_status LowCardinality(String)");
    expect(CREATE_FACT_SUPPORT_REQUESTS_SQL).toContain("attribution_version String");
  });

  it("carries the answered-analytics columns through the table AND the attribution rewrite", () => {
    // The attribution INSERT-SELECT rewrites whole rows through
    // SUPPORT_FACT_COLUMNS: any column in the table but missing there is
    // silently zeroed on the next attribution pass.
    expect(CREATE_FACT_SUPPORT_REQUESTS_SQL).toContain("answered_at Nullable(DateTime64(3, 'UTC'))");
    expect(CREATE_FACT_SUPPORT_REQUESTS_SQL).toContain("answer_source LowCardinality(String) DEFAULT ''");
    expect(CREATE_FACT_SUPPORT_REQUESTS_SQL).toContain("reply_count UInt32 DEFAULT 0");
    expect(SUPPORT_FACT_COLUMNS).toContain("answered_at");
    expect(SUPPORT_FACT_COLUMNS).toContain("answer_source");
    expect(SUPPORT_FACT_COLUMNS).toContain("reply_count");
  });

  it("lists unanswered contacts at the ADDRESS grain with the shared filter scope", async () => {
    const queries: Array<{ sql: string; params: Record<string, unknown> }> = [];
    const clickhouse: ClickHouseClientLike = {
      command: async () => undefined,
      insert: async () => undefined,
      query: async ({ query, query_params }) => {
        queries.push({ sql: query, params: query_params ?? {} });
        return {
          json: async () => query.includes("GROUP BY normalized_email")
            ? [{ email: "jane@example.com", sender_name: "Jane", messages: 3, first_received_at: "2026-08-01T10:00:00.000Z", last_received_at: "2026-08-20T10:00:00.000Z", last_subject: "Still waiting", last_category: "Refund", high_priority: 1 }]
            : [{ contacts: 2 }],
        };
      },
    };
    const response = await runSupportUnansweredContacts({
      authUserId: "owner-1",
      clickhouse,
      request: { action: "unanswered_contacts", date_from: "2026-08-01", filters: { category: ["Refund"] } },
    });
    const contactsSql = queries[0]?.sql ?? "";
    // One row per unique address; the verdict spans EVERY message of the
    // address (a person answered in another thread never appears here); the
    // person must have at least one answerable (non spam/auto) request.
    expect(contactsSql).toContain("GROUP BY normalized_email");
    expect(contactsSql).toContain("countIf(answer_source != '') = 0");
    expect(contactsSql).toContain("countIf(category NOT IN ('Spam/unrelated', 'Automated notification')) > 0");
    expect(contactsSql).toContain("normalized_email != ''");
    // The page's filters travel through the shared whereClause.
    expect(contactsSql).toContain("request_date >= toDate({date_from:String})");
    expect(queries[0]?.params).toMatchObject({ auth_user_id: "owner-1", category_0: "Refund" });
    expect(response.action).toBe("unanswered_contacts");
    expect(response.rows).toEqual([{
      email: "jane@example.com", sender_name: "Jane", messages: 3,
      first_received_at: "2026-08-01T10:00:00.000Z", last_received_at: "2026-08-20T10:00:00.000Z",
      last_subject: "Still waiting", last_category: "Refund", high_priority: 1,
    }]);
    expect(response.total_contacts).toBe(1);
    expect(response.contacts_without_email).toBe(2);
  });

  it("filters answered/unanswered on answer_source, not answered_at", async () => {
    // answered_at alone would miss the imap_flag/customer_reply tiers,
    // which prove an answer but carry no timestamp.
    const queries: Array<{ sql: string }> = [];
    const clickhouse: ClickHouseClientLike = {
      command: async () => undefined,
      insert: async () => undefined,
      query: async ({ query }) => {
        queries.push({ sql: query });
        return { json: async () => query.includes("SELECT count() AS count") ? [{ count: 0 }] : [] };
      },
    };
    await runSupportList({
      authUserId: "owner-1",
      clickhouse,
      request: { action: "list", filters: { answered: "yes" } },
    });
    expect(queries.at(-1)?.sql).toContain("answer_source != ''");
    await runSupportList({
      authUserId: "owner-1",
      clickhouse,
      request: { action: "list", filters: { answered: "no" } },
    });
    expect(queries.at(-1)?.sql).toContain("answer_source = ''");
    expect(normalizeSupportRequest({ action: "list", filters: {} }).filters.answered).toBe("all");
  });

  it("builds server-side Support Edge requests from UI filters", () => {
    const request = buildSupportRequest({
      page: 2,
      pageSize: 50,
      sortBy: "received_at",
      sortDir: "desc",
      filters: {
        dateFrom: "2026-06-01",
        dateTo: "2026-06-30",
        category: "Refund",
        subcategory: "refund_request",
        language: "en",
        urgency: "high",
        matchStatus: "matched",
        requiresCancellation: "all",
        requiresRefund: true,
        paymentRelated: true,
        deliveryRelated: false,
        manualStatus: "manual",
        search: "charge",
        importBatchId: "batch_1",
        funnel: ["soulmate", "palm-reading", "soulmate"],
        campaignPath: [" soulmate/main ", "past-life/landing", "soulmate/main"],
      },
    }, "list");
    expect(request.action).toBe("list");
    expect(request.filters?.category).toEqual(["Refund"]);
    expect(request.filters?.funnel).toEqual(["palm-reading", "soulmate"]);
    expect(request.filters?.campaign_path).toEqual(["past-life/landing", "soulmate/main"]);
    expect(request.filters?.matched).toBe("yes");
    expect(request.filters?.requires_refund).toBe("yes");
    expect(request.filters?.delivery_related).toBe("no");
    expect(request.filters?.search).toBe("charge");
    expect(request.pagination).toEqual({ page: 2, page_size: 50 });
  });

  it("normalizes funnel and Campaign Path filters in cache keys without browser-side data", () => {
    const base = {
      userScopeHash: "u_hash",
      warehouseVersion: "wh_1",
      request: {
        page: 1,
        pageSize: 50,
        sortBy: "funnel" as const,
        sortDir: "asc" as const,
        filters: {
          funnel: [" soulmate ", "palm", "soulmate"],
          campaignPath: [" soulmate/main ", "past-life/landing", "soulmate/main"],
        },
      },
    };
    const key = supportListKey(base);
    expect(JSON.stringify(key)).toContain('"funnel":["palm","soulmate"]');
    expect(JSON.stringify(key)).toContain('"campaignPath":["past-life/landing","soulmate/main"]');
    expect(JSON.stringify(key)).toContain('"sortBy":"funnel"');
  });

  it("normalizes and validates attribution email", () => {
    expect(normalizeSupportAttributionEmail("  User@Example.COM ")).toBe("user@example.com");
    expect(normalizeSupportAttributionEmail("not-an-email")).toBe("");
    expect(normalizeSupportAttributionEmail("   ")).toBe("");
  });

  it("maps one authoritative cohort user to one funnel status", () => {
    expect(supportAttributionStatus({ normalizedEmail: "a@example.com", cohortUserCount: 1, transactionUserCount: 1 })).toBe("matched");
    expect(supportAttributionStatus({ normalizedEmail: "missing@example.com", cohortUserCount: 0, transactionUserCount: 0 })).toBe("unmatched_email");
    expect(supportAttributionStatus({ normalizedEmail: "known@example.com", cohortUserCount: 0, transactionUserCount: 1 })).toBe("user_without_trial");
    expect(supportAttributionStatus({ normalizedEmail: "shared@example.com", cohortUserCount: 2, transactionUserCount: 2 })).toBe("ambiguous");
  });

  it("applies multi-funnel filtering and whole-result funnel sorting in ClickHouse", async () => {
    const queries: Array<{ sql: string; params: Record<string, unknown> }> = [];
    const clickhouse: ClickHouseClientLike = {
      command: async () => undefined,
      insert: async () => undefined,
      query: async ({ query, query_params }) => {
        queries.push({ sql: query, params: query_params ?? {} });
        return { json: async () => query.includes("SELECT count() AS count") ? [{ count: 101 }] : [] };
      },
    };
    const response = await runSupportList({
      authUserId: "owner-1",
      clickhouse,
      request: {
        action: "list",
        filters: { funnel: ["Soulmate", "Unknown"] },
        sort: { field: "funnel", direction: "asc" },
        pagination: { page: 2, page_size: 50 },
      },
    });
    const listSql = queries.at(-1)?.sql ?? "";
    expect(response.pagination).toEqual({ page: 2, page_size: 50, total_rows: 101, total_pages: 3 });
    expect(listSql).toContain("funnel IN ({funnel_0:String}, {funnel_1:String})");
    expect(listSql).toContain("if(funnel = 'Unknown' OR funnel = '', 1, 0) ASC");
    expect(listSql).toContain("lowerUTF8(funnel) ASC");
    expect(listSql).toContain("LIMIT {limit:UInt32} OFFSET {offset:UInt32}");
    expect(queries.at(-1)?.params).toMatchObject({ auth_user_id: "owner-1", funnel_0: "Soulmate", funnel_1: "Unknown", limit: 50, offset: 50 });
  });

  it("exports through the SAME filter and order as the list, with the body and FINAL", async () => {
    // Two invariants live here. FINAL: fact_support_requests is a
    // ReplacingMergeTree holding several versions per email (the classifier and
    // manual corrections rewrite rows), so a read without it returns superseded
    // versions too — more rows than the screen shows, carrying stale
    // categories. And the same WHERE/ORDER BY as runSupportList, because a file
    // that covers a different set than the screen is worse than no file.
    const queries: Array<{ sql: string; params: Record<string, unknown> }> = [];
    const clickhouse: ClickHouseClientLike = {
      command: async () => undefined,
      insert: async () => undefined,
      query: async ({ query, query_params }) => {
        queries.push({ sql: query, params: query_params ?? {} });
        return { json: async () => query.includes("SELECT count() AS count") ? [{ count: 450 }] : [] };
      },
    };
    const request = {
      action: "export" as const,
      filters: { funnel: ["Soulmate"] },
      sort: { field: "funnel", direction: "asc" as const },
      pagination: { page: 2, page_size: 200 },
    };
    const response = await runSupportExport({ authUserId: "owner-1", clickhouse, request });

    const sql = queries.at(-1)?.sql ?? "";
    expect(sql).toContain("FINAL");
    expect(sql).toContain("message_body");
    expect(sql).toContain("funnel IN ({funnel_0:String})");
    expect(sql).toContain("if(funnel = 'Unknown' OR funnel = '', 1, 0) ASC");
    expect(sql).toContain("request_id ASC");
    expect(queries.at(-1)?.params).toMatchObject({ auth_user_id: "owner-1", funnel_0: "Soulmate" });

    // The discriminator the client checks: without it a fallthrough to the
    // analytics bundle would be written out as an empty file.
    expect(response.action).toBe("export");
    expect(response.total_rows).toBe(450);
    expect(response.page).toBe(2);
    expect(response.has_more).toBe(true);
  });

  it("caps the export page size regardless of what the caller asks for", async () => {
    // The body is an unbounded String; the ceiling is about response bytes, not
    // rows, and a caller must not be able to raise it.
    const queries: Array<{ params: Record<string, unknown> }> = [];
    const clickhouse: ClickHouseClientLike = {
      command: async () => undefined,
      insert: async () => undefined,
      query: async ({ query, query_params }) => {
        queries.push({ params: query_params ?? {} });
        return { json: async () => query.includes("SELECT count() AS count") ? [{ count: 10_000 }] : [] };
      },
    };
    const response = await runSupportExport({
      authUserId: "owner-1",
      clickhouse,
      request: { action: "export", pagination: { page: 1, page_size: 5000 } },
    });
    expect(response.page_size).toBeLessThanOrEqual(500);
    expect(queries.at(-1)?.params.limit).toBe(response.page_size);
  });

  it("accepts export as an action rather than falling back to bundle", () => {
    expect(normalizeSupportRequest({ action: "export" }).action).toBe("export");
  });

  it("supports descending server-side funnel sort", async () => {
    const queries: string[] = [];
    const clickhouse: ClickHouseClientLike = {
      command: async () => undefined,
      insert: async () => undefined,
      query: async ({ query }) => {
        queries.push(query);
        return { json: async () => query.includes("SELECT count() AS count") ? [{ count: 0 }] : [] };
      },
    };
    await runSupportList({ authUserId: "owner-1", clickhouse, request: { action: "list", sort: { field: "funnel", direction: "desc" } } });
    expect(queries.at(-1)).toContain("lowerUTF8(funnel) DESC");
  });

  it("filters, paginates, and sorts Campaign Path server-side with empty values last", async () => {
    const queries: Array<{ sql: string; params: Record<string, unknown> }> = [];
    const clickhouse: ClickHouseClientLike = {
      command: async () => undefined,
      insert: async () => undefined,
      query: async ({ query, query_params }) => {
        queries.push({ sql: query, params: query_params ?? {} });
        return { json: async () => query.includes("SELECT count() AS count") ? [{ count: 125 }] : [] };
      },
    };
    const response = await runSupportList({
      authUserId: "owner-1",
      clickhouse,
      request: {
        action: "list",
        filters: { campaign_path: ["soulmate/main", "—"] },
        sort: { field: "campaign_path", direction: "asc" },
        pagination: { page: 3, page_size: 50 },
      },
    });
    const listSql = queries.at(-1)?.sql ?? "";
    expect(response.pagination).toEqual({ page: 3, page_size: 50, total_rows: 125, total_pages: 3 });
    expect(listSql).toContain("(campaign_path IN ({campaign_path_0:String}) OR campaign_path = '')");
    expect(listSql).toContain("campaign_path,");
    expect(listSql).not.toContain("nullIf(campaign_path, '') AS campaign_path");
    expect(listSql).toContain("if(campaign_path = '', 1, 0) ASC, lowerUTF8(campaign_path) ASC");
    expect(listSql).toContain("LIMIT {limit:UInt32} OFFSET {offset:UInt32}");
    expect(queries.at(-1)?.params).toMatchObject({ auth_user_id: "owner-1", campaign_path_0: "soulmate/main", limit: 50, offset: 100 });

    await runSupportList({
      authUserId: "owner-1",
      clickhouse,
      request: { action: "list", filters: { campaign_path: ["—"] }, sort: { field: "campaign_path", direction: "desc" } },
    });
    expect(queries.at(-1)?.sql).toContain("campaign_path = ''");
    expect(queries.at(-1)?.sql).toContain("if(campaign_path = '', 1, 0) ASC, lowerUTF8(campaign_path) DESC");
  });

  it("returns Funnel and Campaign Path from options and details without exposing matched_user_id", async () => {
    const clickhouse: ClickHouseClientLike = {
      command: async () => undefined,
      insert: async () => undefined,
      query: async ({ query }) => ({
        json: async () => {
          if (query.includes("GROUP BY funnel ORDER BY")) return [{ funnel: "Soulmate", requests: 3 }, { funnel: "Unknown", requests: 1 }];
          if (query.includes("GROUP BY campaign_path ORDER BY")) return [{ campaign_path: "soulmate/main", requests: 3 }, { campaign_path: "—", requests: 1 }];
          if (query.includes("message_body")) return [{
            id: "req-1",
            funnel: "Soulmate",
            campaign_path: "soulmate/main",
            cohort_date: "2026-06-01",
            attribution_status: "matched",
            matched_user_id: "must-not-leak",
            message_body: "Help",
          }];
          return [];
        },
      }),
    };
    const options = await runSupportOptions({ authUserId: "owner-1", clickhouse });
    const details = await runSupportDetails({ authUserId: "owner-1", clickhouse, request: { action: "details", request_id: "req-1" } });
    expect(options.filter_options.funnels).toEqual([{ funnel: "Soulmate", requests: 3 }, { funnel: "Unknown", requests: 1 }]);
    expect(options.filter_options.campaign_paths).toEqual([{ campaign_path: "soulmate/main", requests: 3 }, { campaign_path: "—", requests: 1 }]);
    expect(details.row).toMatchObject({ funnel: "Soulmate", campaign_path: "soulmate/main", cohort_date: "2026-06-01", attribution_status: "matched" });
    expect(details.row).not.toHaveProperty("matched_user_id");
  });

  it("keeps the unfiltered Support request free of a funnel predicate", () => {
    const normalized = normalizeSupportRequest({ action: "bundle", filters: { funnel: [] } });
    expect(normalized.filters.funnel).toEqual([]);
    const browserRequest = buildSupportRequest({
      page: 1,
      pageSize: 50,
      sortBy: "received_at",
      sortDir: "desc",
      filters: { funnel: [] },
    });
    expect(browserRequest.filters?.funnel).toEqual([]);
  });

  it("uses one funnel-filtered scope for KPIs, rankings, chart data, and diagnostics", async () => {
    const queries: string[] = [];
    const clickhouse: ClickHouseClientLike = {
      command: async () => undefined,
      insert: async () => undefined,
      query: async ({ query }) => {
        queries.push(query);
        return { json: async () => [] };
      },
    };
    const response = await runSupportBundle({
      authUserId: "owner-1",
      supabase: fakeSupabase(null),
      clickhouse,
      request: { action: "bundle", filters: { funnel: ["Soulmate"] } },
    });
    const analytical = queries.filter((sql) => sql.includes("{funnel_0:String}"));
    expect(analytical.some((sql) => sql.includes("count() total"))).toBe(true);
    expect(analytical.some((sql) => sql.includes("GROUP BY request_date, funnel"))).toBe(true);
    expect(analytical.some((sql) => sql.includes("GROUP BY category ORDER BY requests"))).toBe(true);
    expect(analytical.some((sql) => sql.includes("uniqueSupportUsers"))).toBe(true);
    expect(response.summary.kpis.totalRequests).toBe(0);
    expect(response.diagnostics.support_rate_denominator_available).toBe(false);
    expect(JSON.stringify(response.summary)).not.toContain("matched_user_id");
    expect(JSON.stringify(response.summary)).not.toContain("normalized_email");
  });

  it("builds Campaign Path ranking and Support Rate from the active Cohorts denominator", async () => {
    const queries: string[] = [];
    const clickhouse: ClickHouseClientLike = {
      command: async () => undefined,
      insert: async () => undefined,
      query: async ({ query }) => {
        queries.push(query);
        return {
          json: async () => {
            if (query.includes("count() total")) return [{ total: 4, matched: 3, active_days: 1 }];
            if (query.includes("campaignPath,") && query.includes("uniqueSupportUsers")) return [
              { campaignPath: "soulmate/main", requests: 3, uniqueSupportUsers: 2, cancellationRequests: 1, refundRequests: 1, highPriority: 1, latestRequest: "2026-07-13 10:00:00" },
              { campaignPath: "—", requests: 1, uniqueSupportUsers: 1, cancellationRequests: 0, refundRequests: 1, highPriority: 0, latestRequest: "2026-07-12 10:00:00" },
            ];
            if (query.includes("SELECT funnel, campaign_path, uniqExact(canonical_user_id) trialUsers")) return [
              { funnel: "soulmate", campaign_path: "soulmate/main", trialUsers: 10 },
              { funnel: "unknown", campaign_path: "", trialUsers: 5 },
            ];
            return [];
          },
        };
      },
    };
    const response = await runSupportBundle({
      authUserId: "owner-1",
      supabase: fakeSupabase({
        status: "completed",
        active_warehouse_version: "wh_active",
        active_classification_version: "cohort_v1",
        duplicate_users: 0,
        diagnostics: { validation: { status: "PASS" } },
      }),
      clickhouse,
      request: { action: "bundle", filters: { campaign_path: ["soulmate/main"] } },
    });
    expect(response.summary.campaignPathRanking).toEqual([
      expect.objectContaining({ campaignPath: "soulmate/main", requests: 3, uniqueSupportUsers: 2, trialUsers: 10, supportRate: 20 }),
      expect.objectContaining({ campaignPath: "—", requests: 1, uniqueSupportUsers: 1, trialUsers: 5, supportRate: 20 }),
    ]);
    const analytical = queries.filter((sql) => sql.includes("{campaign_path_0:String}"));
    expect(analytical.some((sql) => sql.includes("count() total"))).toBe(true);
    expect(analytical.some((sql) => sql.includes("GROUP BY campaign_path"))).toBe(true);
    expect(queries.some((sql) => sql.includes("analytics_transactions"))).toBe(false);
  });

  it("backfills attribution idempotently from active fact_user_cohorts and preserves manual fields", async () => {
    const commands: string[] = [];
    let staleCalls = 0;
    const clickhouse: ClickHouseClientLike = {
      command: async ({ query }) => { commands.push(query); },
      insert: async () => undefined,
      query: async ({ query }) => ({
        json: async () => {
          if (query.includes("count() rows_scanned")) return [{ rows_scanned: staleCalls++ === 0 ? 2 : 0 }];
          if (query.includes("funnel_matched")) return [{ funnel_matched: 1, unknown: 1, users_without_trial: 1, unmatched_email: 0, ambiguous: 0 }];
          return [];
        },
      }),
    };
    const supabase = fakeSupabase({
      status: "completed",
      active_warehouse_version: "wh_active",
      active_classification_version: "cohort_v1",
      duplicate_users: 0,
      diagnostics: { validation: { status: "PASS" } },
    });
    const first = await enrichSupportAttribution({ authUserId: "owner-1", supabase, clickhouse });
    const second = await enrichSupportAttribution({ authUserId: "owner-1", supabase, clickhouse });
    expect(first).toMatchObject({ rows_scanned: 2, funnel_matched: 1, unknown: 1, users_without_trial: 1, attribution_version: "wh_active|cohort_v1" });
    expect(second.rows_scanned).toBe(0);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain("FROM fact_user_cohorts FINAL");
    expect(commands[0]).toContain("argMin(funnel, (cohort_date, trial_event_time, trial_transaction_id)) funnel");
    expect(commands[0]).toContain("s.manual_category, s.manual_subcategory");
    expect(commands[0]).toContain("s.message_body, s.source_hash, s.classification_version");
    expect(commands[0]).toContain("WHERE s.auth_user_id = {auth_user_id:String}");
    expect(commands[0]).not.toContain("argMax(funnel");
  });

  it("validates Support Edge requests server-side", () => {
    expect(() => normalizeSupportRequest({ action: "list", sort: { field: "message_body; drop table", direction: "asc" } })).toThrow(SupportRequestError);
    expect(() => normalizeSupportRequest({ action: "list", date_from: "06-01-2026" })).toThrow(SupportRequestError);
  });

  it("classifies support requests on the ClickHouse/Edge shared server module", () => {
    expect(classifySupportRequestServer("Refund", "I want my money back").category).toBe("Refund");
    expect(classifySupportRequestServer("Cancelación", "Solicito dar de baja mi suscripción").category).toBe("Cancellation");
    expect(classifySupportRequestServer("Unauthorized charge", "I did not subscribe").urgency).toBe("high");
  });

  it("does not perform browser-side category classification during import parsing", () => {
    const parsed = parseSupportCsvText([
      "data,data2,data3,data5,email,matched_contact_name",
      "A,Refund,I want my money back,30 июн,a@example.com,A",
    ].join("\n"), { importYear: 2026 });
    expect(parsed.rows[0].category).toBe("Other/unclear");
    expect(parsed.rows[0].subcategory).toBe("pending_server_classification");
    expect(parsed.rows[0].classification_reason).toContain("Pending server-side ClickHouse classification");
  });
});
