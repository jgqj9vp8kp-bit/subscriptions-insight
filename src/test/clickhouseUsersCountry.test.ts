// Country filtering/sorting for the Users page (server side): the Unknown
// sentinel, dependent country options, list ORDER BY, and the action=decline
// bundle (totals + reason/stage rows + country breakdown with pass rates).

import { describe, expect, it } from "vitest";
import {
  UsersRequestError,
  normalizeUsersAction,
  normalizeUsersRequest,
  runUsersDecline,
  runUsersList,
  runUsersOptions,
  userWhere,
} from "../../supabase/functions/_shared/clickhouse/users.ts";
import { UNKNOWN_COUNTRY } from "../../supabase/functions/_shared/clickhouse/usersContract.ts";
import type { UsersRequest } from "../../supabase/functions/_shared/clickhouse/usersContract.ts";
import type { ClickHouseClientLike } from "../../supabase/functions/_shared/clickhouse/types.ts";
import { declineBreakdownMessageForTransaction } from "../../supabase/functions/_shared/clickhouse/paymentFailures.ts";
import type { Transaction } from "@/services/types";

interface Captured {
  query: string;
  query_params?: Record<string, unknown>;
}

interface DeclineFixture {
  totals?: Record<string, unknown>;
  reasons?: Array<Record<string, unknown>>;
  stages?: Array<Record<string, unknown>>;
  reasonMessages?: Array<Record<string, unknown>>;
  countries?: Array<Record<string, unknown>>;
  countryReasons?: Array<Record<string, unknown>>;
  listRows?: Array<Record<string, unknown>>;
  optionRows?: Array<Record<string, unknown>>;
}

// Stub ClickHouse client: captures every command/query and dispatches canned
// rows by recognizable SQL fragments (substring order matters: the more
// specific GROUP BY ucountry, reason must match before GROUP BY reason).
function stubClient(data: DeclineFixture = {}) {
  const commands: Captured[] = [];
  const queries: Captured[] = [];
  const client: ClickHouseClientLike = {
    command: async (input) => { commands.push(input); },
    query: async (input) => {
      queries.push(input);
      const q = input.query;
      let rows: unknown[] = [];
      if (q.includes("system.tables")) rows = [];
      else if (q.includes("'funnel' dim")) rows = data.optionRows ?? [];
      else if (q.includes("selected_users")) rows = [data.totals ?? {}];
      else if (q.includes("GROUP BY ucountry, reason")) rows = data.countryReasons ?? [];
      else if (q.includes("GROUP BY reason, dmsg")) rows = data.reasonMessages ?? [];
      else if (q.includes("GROUP BY reason")) rows = data.reasons ?? [];
      else if (q.includes("GROUP BY stage")) rows = data.stages ?? [];
      else if (q.includes("GROUP BY ucountry")) rows = data.countries ?? [];
      else if (q.includes("uniqExact(user_id)")) rows = [{ u: 0, t: 0, fx: 0 }];
      else if (q.includes("count() AS c")) rows = [{ c: 0 }];
      else rows = data.listRows ?? [];
      return { json: async <T>() => rows as T };
    },
  } as ClickHouseClientLike;
  return { client, commands, queries };
}

describe("country filter normalization + WHERE", () => {
  it("folds the Unknown sentinel case-insensitively and dedupes", () => {
    const nreq = normalizeUsersRequest({ filters: { country: ["US", "unknown", "UNKNOWN", "US"] } });
    expect(nreq.filters.country).toEqual(["US", UNKNOWN_COUNTRY]);
  });

  it("does not force-uppercase stored country codes (values must match warehouse)", () => {
    const nreq = normalizeUsersRequest({ filters: { country: ["us"] } });
    expect(nreq.filters.country).toEqual(["us"]);
  });

  it("single country binds as a parameter", () => {
    const params: Record<string, unknown> = {};
    const where = userWhere(normalizeUsersRequest({ filters: { country: ["US"] } }), params);
    expect(where).toContain("country_code IN ({p_co_0:String})");
    expect(params.p_co_0).toBe("US");
  });

  it("multi-country filter binds every value", () => {
    const params: Record<string, unknown> = {};
    const where = userWhere(normalizeUsersRequest({ filters: { country: ["US", "DE", "GB"] } }), params);
    expect(where).toContain("country_code IN ({p_co_0:String}, {p_co_1:String}, {p_co_2:String})");
    expect(params.p_co_2).toBe("GB");
  });

  it("Unknown alone selects users with no attributed country", () => {
    const where = userWhere(normalizeUsersRequest({ filters: { country: ["Unknown"] } }), {});
    expect(where).toContain("country_code IS NULL");
    expect(where).not.toContain("country_code IN");
  });

  it("mixed codes + Unknown OR the two conditions", () => {
    const params: Record<string, unknown> = {};
    const where = userWhere(normalizeUsersRequest({ filters: { country: ["US", "Unknown"] } }), params);
    expect(where).toContain("(country_code IN ({p_co_0:String}) OR country_code IS NULL)");
    expect(params.p_co_0).toBe("US");
  });

  it("never interpolates country values into SQL", () => {
    const params: Record<string, unknown> = {};
    const where = userWhere(normalizeUsersRequest({ filters: { country: ["US' OR 1=1 --"] } }), params);
    expect(where).not.toContain("OR 1=1");
    expect(params.p_co_0).toBe("US' OR 1=1 --");
  });
});

describe("users list country sort (server-side, before pagination)", () => {
  const request = (direction: "asc" | "desc"): UsersRequest => ({
    action: "list",
    sort: { field: "country_code", direction },
    pagination: { page: 2, page_size: 50 },
  });

  it("ascending: full-set ORDER BY with NULLS LAST and a stable secondary key, before LIMIT/OFFSET", async () => {
    const { client, queries } = stubClient();
    await runUsersList({ authUserId: "u1", clickhouse: client, request: request("asc") });
    const sql = queries.map((q) => q.query).find((q) => q.includes("ORDER BY")) ?? "";
    expect(sql).toContain("ORDER BY country_code ASC NULLS LAST, user_id ASC");
    expect(sql.indexOf("ORDER BY")).toBeLessThan(sql.indexOf("LIMIT {limit:UInt32} OFFSET {offset:UInt32}"));
  });

  it("descending keeps Unknown (NULL) last too", async () => {
    const { client, queries } = stubClient();
    await runUsersList({ authUserId: "u1", clickhouse: client, request: request("desc") });
    const sql = queries.map((q) => q.query).find((q) => q.includes("ORDER BY")) ?? "";
    expect(sql).toContain("ORDER BY country_code DESC NULLS LAST, user_id ASC");
  });

  it("pagination offset derives from the requested page over the sorted set", async () => {
    const { client, queries } = stubClient();
    await runUsersList({ authUserId: "u1", clickhouse: client, request: request("asc") });
    const main = queries.find((q) => q.query.includes("ORDER BY"));
    expect(main?.query_params?.limit).toBe(50);
    expect(main?.query_params?.offset).toBe(50);
  });
});

describe("dependent country options", () => {
  it("country options apply every filter EXCEPT country, and include Unknown", async () => {
    const { client, queries } = stubClient({
      optionRows: [
        { dim: "country", value: "US", cnt: 10 },
        { dim: "country", value: "DE", cnt: 3 },
        { dim: "country", value: UNKNOWN_COUNTRY, cnt: 5 },
      ],
    });
    const response = await runUsersOptions({
      authUserId: "u1",
      clickhouse: client,
      request: { action: "options", filters: { first_sub: "yes", country: ["US"] } },
    });
    const sql = queries.map((q) => q.query).find((q) => q.includes("'funnel' dim")) ?? "";
    const countryLine = sql.split("\n").find((line) => line.includes("'country' dim")) ?? "";
    expect(countryLine).toContain(`ifNull(country_code, '${UNKNOWN_COUNTRY}')`);
    expect(countryLine).toContain("has_first_subscription"); // other filters applied
    expect(countryLine).not.toContain("country_code IN"); // country itself excluded
    expect(countryLine).toContain("countIf(first_trial_date IS NOT NULL)"); // trial-user counts (Cohorts parity)
    const country = (response.filter_options as { country: Array<{ country_code: string; user_count: number }> }).country;
    expect(country.map((c) => c.country_code)).toEqual(["DE", "US", UNKNOWN_COUNTRY]); // A→Z, Unknown last
    expect(country.find((c) => c.country_code === UNKNOWN_COUNTRY)?.user_count).toBe(5);
  });
});

describe("action=decline", () => {
  it("is a recognized action; unknown actions still throw", () => {
    expect(normalizeUsersAction("decline")).toBe("decline");
    expect(() => normalizeUsersAction("drop")).toThrow(UsersRequestError);
  });

  it("rejects non-allowlisted country sort fields", () => {
    expect(() => normalizeUsersRequest({ decline: { country_sort: { field: "uid; DROP TABLE", direction: "asc" } } }))
      .toThrow(UsersRequestError);
    expect(normalizeUsersRequest({ decline: { country_sort: { field: "pass_rate_ex_if", direction: "asc" } } }).declineCountrySort)
      .toEqual({ field: "pass_rate_ex_if", direction: "asc" });
  });

  it("scopes the scratch table by auth user + user filters and binds display filters as params", async () => {
    const { client, commands, queries } = stubClient();
    await runUsersDecline({
      authUserId: "user-42",
      clickhouse: client,
      request: {
        action: "decline",
        filters: { country: ["US"], first_sub: "yes" },
        decline: { reasons: ["insufficient_funds"], stages: ["after_trial"] },
      },
    });
    const create = commands.find((c) => c.query.includes("CREATE TABLE ud_staged_"));
    expect(create).toBeTruthy();
    expect(create?.query).toContain("ENGINE = MergeTree");
    expect(create?.query).toContain("auth_user_id = {auth_user_id:String}");
    expect(create?.query).toContain("INNER JOIN selected");
    expect(create?.query).toContain(`ifNull(country_code, '${UNKNOWN_COUNTRY}')`);
    expect(create?.query).toContain("country_code IN ({p_co_0:String})");
    expect(create?.query_params?.p_co_0).toBe("US");
    // raw_payload is only READ inside extract() for the message drill-down —
    // the materialized projection stores just the extracted dmsg, never the blob.
    expect(create?.query).not.toContain("normalized_payload");
    expect(create?.query).toContain("SELECT uid, ucountry, is_success, is_failed, rn, event_day, reason, stage, dmsg,");
    expect(create?.query.split("extract(").length - 1).toBeGreaterThan(0);
    expect(create?.query).not.toMatch(/SELECT[^,]*raw_payload/);
    const totals = queries.find((q) => q.query.includes("selected_users"));
    expect(totals?.query).toContain("reason IN ({p_dar_0:String})");
    expect(totals?.query).toContain("stage IN ({p_das_0:String})");
    // The share denominator counters are unconditional (no display filter).
    expect(totals?.query).toContain("countIf(is_success = 1) successful_transactions");
    expect(totals?.query).toContain("countIf(is_failed = 1) failed_transactions_all");
    expect(totals?.query_params?.p_dar_0).toBe("insufficient_funds");
    expect(totals?.query_params?.p_das_0).toBe("after_trial");
    // scratch table is always dropped
    expect(commands.some((c) => c.query.startsWith("DROP TABLE IF EXISTS ud_staged_"))).toBe(true);
  });

  const fixture: DeclineFixture = {
    totals: {
      selected_users: 10, failed_users: 4, failed_transactions: 8,
      successful_transactions: 32, failed_transactions_all: 8,
      st_after_trial: 5, st_after_first_subscription: 2, st_after_renewal: 1, st_unknown: 0,
      users_with_country: 8, users_without_country: 2,
      attempts_with_country: 30, attempts_without_country: 5, unique_countries: 2,
    },
    reasons: [
      { reason: "do_not_honor", failed_users: 1, failed_transactions: 3, latest_failed_date: "2026-06-15", st_after_trial: 1, st_after_first_subscription: 1, st_after_renewal: 1, st_unknown: 0 },
      { reason: "insufficient_funds", failed_users: 3, failed_transactions: 5, latest_failed_date: "2026-07-01", st_after_trial: 4, st_after_first_subscription: 1, st_after_renewal: 0, st_unknown: 0 },
    ],
    stages: [
      { stage: "after_trial", failed_users: 4, failed_transactions: 5 },
      { stage: "after_first_subscription", failed_users: 2, failed_transactions: 2 },
      { stage: "after_renewal", failed_users: 1, failed_transactions: 1 },
    ],
    reasonMessages: [
      { reason: "insufficient_funds", dmsg: "Insufficient funds", failed_users: 2, failed_transactions: 4 },
      { reason: "insufficient_funds", dmsg: "Insufficient funds/over credit limit", failed_users: 1, failed_transactions: 1 },
      { reason: "do_not_honor", dmsg: "Suspected fraud", failed_users: 1, failed_transactions: 3 },
    ],
    countries: [
      { country: "US", total_attempts: 20, successful: 15, failed: 5, users_with_attempts: 6, users_with_success: 5, first_attempts: 6, first_success: 5, first_sub_attempts: 4, first_sub_success: 3, renewal_attempts: 5, renewal_success: 4, insufficient_funds: 4 },
      { country: "DE", total_attempts: 10, successful: 0, failed: 10, users_with_attempts: 2, users_with_success: 0, first_attempts: 2, first_success: 0, first_sub_attempts: 0, first_sub_success: 0, renewal_attempts: 0, renewal_success: 0, insufficient_funds: 0 },
      { country: UNKNOWN_COUNTRY, total_attempts: 5, successful: 5, failed: 0, users_with_attempts: 2, users_with_success: 2, first_attempts: 2, first_success: 2, first_sub_attempts: 1, first_sub_success: 1, renewal_attempts: 0, renewal_success: 0, insufficient_funds: 0 },
    ],
    countryReasons: [
      { country: "US", reason: "insufficient_funds", c: 4 },
      { country: "US", reason: "do_not_honor", c: 1 },
      { country: "DE", reason: "do_not_honor", c: 10 },
    ],
  };

  const declineRequest = (countrySort?: { field: string; direction: "asc" | "desc" }): UsersRequest => ({
    action: "decline",
    decline: countrySort ? { country_sort: countrySort } : {},
  });

  it("totals use the legacy formulas (rates as fractions, additive counts)", async () => {
    const { client } = stubClient(fixture);
    const res = await runUsersDecline({ authUserId: "u1", clickhouse: client, request: declineRequest() });
    expect(res.totals.selected_users).toBe(10);
    expect(res.totals.failed_users).toBe(4);
    expect(res.totals.failed_transactions).toBe(8);
    expect(res.totals.decline_rate).toBeCloseTo(0.4);
    expect(res.totals.avg_attempts).toBeCloseTo(2);
    // Share-of-all denominator: successful + ALL failed (unfiltered by the
    // reason/stage display filters).
    expect(res.totals.successful_transactions).toBe(32);
    expect(res.totals.total_transactions).toBe(40);
    expect(res.totals.top_reason).toBe("insufficient_funds"); // most failed transactions
    expect(res.totals.stage_totals).toEqual({ after_trial: 5, after_first_subscription: 2, after_renewal: 1, unknown: 0 });
    expect(res.diagnostics).toEqual({
      users_with_country: 8, users_without_country: 2,
      attempts_with_country: 30, attempts_without_country: 5, unique_countries: 2,
    });
  });

  it("reason rows: share/avg per legacy formulas, top stage by count with taxonomy-order ties", async () => {
    const { client } = stubClient(fixture);
    const res = await runUsersDecline({ authUserId: "u1", clickhouse: client, request: declineRequest() });
    expect(res.reason_rows.map((r) => r.reason)).toEqual(["insufficient_funds", "do_not_honor"]);
    const ifRow = res.reason_rows[0];
    expect(ifRow.share).toBeCloseTo(5 / 8);
    expect(ifRow.avg_attempts).toBeCloseTo(5 / 3);
    expect(ifRow.top_stage).toBe("after_trial");
    // three-way tie (1/1/1) resolves by stage taxonomy order → after_trial
    expect(res.reason_rows[1].top_stage).toBe("after_trial");
  });

  it("stage rows: top reason per stage from the per-reason stage counts", async () => {
    const { client } = stubClient(fixture);
    const res = await runUsersDecline({ authUserId: "u1", clickhouse: client, request: declineRequest() });
    const byStage = new Map(res.stage_rows.map((r) => [r.stage, r]));
    expect(byStage.get("after_trial")?.top_reason).toBe("insufficient_funds"); // 4 vs 1
    expect(byStage.get("after_renewal")?.top_reason).toBe("do_not_honor"); // 1 vs 0
    expect(byStage.get("after_trial")?.share).toBeCloseTo(5 / 8);
    expect(res.stage_rows.every((r) => r.failed_transactions > 0)).toBe(true);
  });

  it("country rows: pass-rate formulas, zero-success and zero-denominator cases (no NaN/Infinity)", async () => {
    const { client } = stubClient(fixture);
    const res = await runUsersDecline({ authUserId: "u1", clickhouse: client, request: declineRequest() });
    const us = res.country_rows.find((r) => r.country === "US");
    expect(us?.pass_rate).toBeCloseTo(15 / 20);
    expect(us?.pass_rate_ex_if).toBeCloseTo(15 / 16); // successful / (attempts - IF)
    expect(us?.user_pass_rate).toBeCloseTo(5 / 6);
    expect(us?.top_decline_reason).toBe("insufficient_funds");
    const de = res.country_rows.find((r) => r.country === "DE");
    expect(de?.pass_rate).toBe(0); // zero successes is 0, not null
    expect(de?.first_sub_pass_rate).toBeNull(); // zero denominator → null, never NaN
    expect(de?.renewal_pass_rate).toBeNull();
    const unknown = res.country_rows.find((r) => r.country === UNKNOWN_COUNTRY);
    expect(unknown?.failed).toBe(0); // zero failures country still present
    expect(unknown?.top_decline_reason).toBeNull();
    for (const row of res.country_rows) {
      for (const value of Object.values(row)) {
        if (typeof value === "number") expect(Number.isFinite(value)).toBe(true);
      }
    }
  });

  it("country sort A→Z keeps Unknown last", async () => {
    const { client } = stubClient(fixture);
    const res = await runUsersDecline({ authUserId: "u1", clickhouse: client, request: declineRequest({ field: "country", direction: "asc" }) });
    expect(res.country_rows.map((r) => r.country)).toEqual(["DE", "US", UNKNOWN_COUNTRY]);
  });

  it("country sort Z→A also keeps Unknown last", async () => {
    const { client } = stubClient(fixture);
    const res = await runUsersDecline({ authUserId: "u1", clickhouse: client, request: declineRequest({ field: "country", direction: "desc" }) });
    expect(res.country_rows.map((r) => r.country)).toEqual(["US", "DE", UNKNOWN_COUNTRY]);
  });

  it("metric sorts run over the full set (default total_attempts desc; null rates last)", async () => {
    const { client } = stubClient(fixture);
    const byAttempts = await runUsersDecline({ authUserId: "u1", clickhouse: client, request: declineRequest() });
    expect(byAttempts.country_rows.map((r) => r.country)).toEqual(["US", "DE", UNKNOWN_COUNTRY]);
    const { client: client2 } = stubClient(fixture);
    const byFsPr = await runUsersDecline({ authUserId: "u1", clickhouse: client2, request: declineRequest({ field: "first_sub_pass_rate", direction: "desc" }) });
    expect(byFsPr.country_rows[byFsPr.country_rows.length - 1].country).toBe("DE"); // null rate last
  });

  it("country totals are additive components, never averaged rates", async () => {
    const { client } = stubClient(fixture);
    const res = await runUsersDecline({ authUserId: "u1", clickhouse: client, request: declineRequest() });
    expect(res.country_totals.total_attempts).toBe(35);
    expect(res.country_totals.successful).toBe(20);
    expect(res.country_totals.pass_rate).toBeCloseTo(20 / 35); // NOT mean(0.75, 0, 1)
    expect(res.country_totals.pass_rate_ex_if).toBeCloseTo(20 / (35 - 4));
  });

  it("empty scope returns zeros and null rates (no NaN), with empty row sets", async () => {
    const { client } = stubClient({ totals: {} });
    const res = await runUsersDecline({ authUserId: "u1", clickhouse: client, request: declineRequest() });
    expect(res.totals.selected_users).toBe(0);
    expect(res.totals.decline_rate).toBeNull();
    expect(res.totals.avg_attempts).toBeNull();
    expect(res.reason_rows).toEqual([]);
    expect(res.stage_rows).toEqual([]);
    expect(res.country_rows).toEqual([]);
    expect(res.country_totals.pass_rate).toBeNull();
  });

  it("attaches the raw-message drill-down to its reason (sorted, share within reason)", async () => {
    const { client, commands, queries } = stubClient(fixture);
    const res = await runUsersDecline({ authUserId: "u1", clickhouse: client, request: declineRequest() });
    const ifRow = res.reason_rows.find((r) => r.reason === "insufficient_funds");
    expect(ifRow?.messages).toEqual([
      { message: "Insufficient funds", failed_users: 2, failed_transactions: 4, share: 4 / 5 },
      { message: "Insufficient funds/over credit limit", failed_users: 1, failed_transactions: 1, share: 1 / 5 },
    ]);
    const dnhRow = res.reason_rows.find((r) => r.reason === "do_not_honor");
    expect(dnhRow?.messages).toEqual([
      { message: "Suspected fraud", failed_users: 1, failed_transactions: 3, share: 1 },
    ]);
    // The message is extracted from raw_payload at materialization time —
    // result-message first, then message, both quoting styles.
    const create = commands.find((c) => c.query.includes("CREATE TABLE ud_staged_"));
    expect(create?.query).toContain("extract(c.raw_payload, '\\'payment_method_result_message\\': \\'([^\\']+)\\'')");
    expect(create?.query).toContain(`extract(c.raw_payload, '"message": "([^"]+)"')`);
    // The breakdown query respects the same display filters as the reason table.
    const messageQuery = queries.find((q) => q.query.includes("GROUP BY reason, dmsg"));
    expect(messageQuery).toBeTruthy();
  });

  it("message drill-down carries the reason/stage display filters", async () => {
    const { client, queries } = stubClient(fixture);
    await runUsersDecline({
      authUserId: "u1",
      clickhouse: client,
      request: { action: "decline", decline: { reasons: ["insufficient_funds"] } },
    });
    const messageQuery = queries.find((q) => q.query.includes("GROUP BY reason, dmsg"));
    expect(messageQuery?.query).toContain("reason IN ({p_dar_0:String})");
    expect(messageQuery?.query_params?.p_dar_0).toBe("insufficient_funds");
  });

  it("response contains no PII (emails / user ids / transaction ids)", async () => {
    const { client } = stubClient(fixture);
    const res = await runUsersDecline({ authUserId: "u1", clickhouse: client, request: declineRequest() });
    const json = JSON.stringify(res);
    expect(json).not.toContain("email");
    expect(json).not.toContain("user_id");
    expect(json).not.toContain("transaction_id");
    expect(json).not.toContain("raw_payload");
  });
});

describe("declineBreakdownMessageForTransaction (drill-down label, legacy path)", () => {
  const failedTx = (raw: Record<string, unknown>): Transaction =>
    ({ status: "failed", transaction_type: "failed_payment", raw, metadata: {}, transaction_id: "t1", user_id: "u1", email: "", event_time: "2026-07-01T00:00:00Z" } as unknown as Transaction);

  it("prefers the network result message (Python-repr declineReasons blob)", () => {
    const tx = failedTx({
      declineReasons: "[{'decline_reason': 'DO_NOT_HONOR', 'message': 'do_not_honor', 'payment_method_result_message': 'Suspected fraud'}]",
    });
    expect(declineBreakdownMessageForTransaction(tx)).toBe("Suspected fraud");
  });

  it("falls back to the message token when no result message exists", () => {
    const tx = failedTx({ declineReasons: "[{'message': 'fraudulent', 'payment_method_result_code': None}]" });
    expect(declineBreakdownMessageForTransaction(tx)).toBe("fraudulent");
  });

  it("handles real-JSON decline records too", () => {
    const tx = failedTx({ declineReasons: [{ payment_method_result_message: "Security violation", message: "do_not_honor" }] });
    expect(declineBreakdownMessageForTransaction(tx)).toBe("Security violation");
  });

  it("returns unknown when nothing is extractable", () => {
    expect(declineBreakdownMessageForTransaction(failedTx({}))).toBe("unknown");
  });
});
