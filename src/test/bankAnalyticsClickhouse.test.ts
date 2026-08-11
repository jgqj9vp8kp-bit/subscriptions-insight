// Bank analytics server layer: SQL safety, the coverage invariant, and the
// distinction the whole feature hangs on — '' (not reported) versus 'unknown'
// (the provider's literal word) never merging.
import { describe, expect, it } from "vitest";
import {
  assertCoverageReconciles,
  normalizeBankRequest,
  runBankAnalytics,
  runBankDetail,
} from "../../supabase/functions/_shared/clickhouse/bankAnalytics.ts";
import { PaymentAnalyticsRequestError } from "../../supabase/functions/_shared/clickhouse/paymentAnalytics.ts";
import { MAX_ISSUER_ROWS } from "../../supabase/functions/_shared/clickhouse/bankContract.ts";
import type { ClickHouseClientLike } from "../../supabase/functions/_shared/clickhouse/types.ts";

function fakeClickHouse(rowsFor: (sql: string) => unknown[]): { client: ClickHouseClientLike; queries: string[]; params: Array<Record<string, unknown>> } {
  const queries: string[] = [];
  const params: Array<Record<string, unknown>> = [];
  const client: ClickHouseClientLike = {
    command: async ({ query }) => { queries.push(String(query)); },
    insert: async () => undefined,
    query: async ({ query, query_params }) => {
      const sql = String(query);
      queries.push(sql);
      params.push((query_params ?? {}) as Record<string, unknown>);
      return { json: async () => rowsFor(sql) };
    },
  };
  return { client, queries, params };
}

// A coverage row that reconciles: 10 = 7 + 2 + 1.
const COVERAGE_ROW = {
  total: 10, identified: 7, reported_unknown: 2, missing: 1,
  id_ok: 4, id_fail: 3, unid_ok: 1, unid_fail: 2, non_attempt: 0,
};

function standardRows(sql: string): unknown[] {
  if (sql.includes("countIf(issuer_key = 'unknown') reported_unknown")) return [COVERAGE_ROW];
  if (sql.includes("min(issuer_name) name, min(issuer_group) grp,")) {
    return [{ k: "sutton_bank", name: "Sutton Bank", grp: "sutton_bank", attempts: 5, successful: 1, failed: 4 }];
  }
  if (sql.includes("uniqExact(issuer_key) member_count")) {
    return [{ gk: "sutton_bank", member_count: 1, attempts: 5, successful: 1, failed: 4 }];
  }
  return [];
}

describe("normalizeBankRequest", () => {
  it("rejects an issuer_key outside the closed slug charset", () => {
    expect(() => normalizeBankRequest({ issuer_key: "x'; DROP TABLE--" })).toThrow(PaymentAnalyticsRequestError);
    expect(() => normalizeBankRequest({ issuer_key: "SUTTON BANK" })).toThrow(PaymentAnalyticsRequestError);
    expect(normalizeBankRequest({ issuer_key: "sutton_bank" }).issuerKey).toBe("sutton_bank");
  });

  it("clamps trend_top_n into its bounds", () => {
    expect(normalizeBankRequest({}).trendTopN).toBe(8);
    expect(normalizeBankRequest({ trend_top_n: 500 }).trendTopN).toBe(20);
    expect(normalizeBankRequest({ trend_top_n: -1 }).trendTopN).toBe(1);
  });
});

describe("assertCoverageReconciles", () => {
  it("passes when identified + unknown + missing equals total", () => {
    expect(() => assertCoverageReconciles({
      total_attempts: 10, identified_attempts: 7, reported_unknown_attempts: 2, missing_attempts: 1,
      identified_success: 4, identified_failed: 3, unidentified_success: 1, unidentified_failed: 2,
      non_attempt_rows: 0,
    })).not.toThrow();
  });

  it("throws when the numbers do not add up — a doctored fixture must fail", () => {
    expect(() => assertCoverageReconciles({
      total_attempts: 10, identified_attempts: 7, reported_unknown_attempts: 2, missing_attempts: 2,
      identified_success: 4, identified_failed: 3, unidentified_success: 1, unidentified_failed: 2,
      non_attempt_rows: 0,
    })).toThrow(/does not reconcile/);
  });
});

describe("runBankAnalytics SQL", () => {
  async function run() {
    const fake = fakeClickHouse(standardRows);
    const bundle = await runBankAnalytics({
      authUserId: "user-1", clickhouse: fake.client,
      request: { filters: { funnel: ["soulmate"] } },
    });
    return { ...fake, bundle };
  }

  it("scopes by auth_user_id and never touches payload columns", async () => {
    const { queries, params } = await run();
    const all = queries.join("\n");
    expect(all).toContain("auth_user_id = {auth_user_id:String}");
    expect(params.some((p) => p.auth_user_id === "user-1") || queries.some((q) => q.includes("CREATE TABLE"))).toBe(true);
    expect(all).not.toMatch(/raw_payload|normalized_payload|First6|Last4|Cardholder|Expiration/i);
  });

  it("materializes into the sweeper-reachable scratch prefix and drops it", async () => {
    const { queries } = await run();
    const create = queries.find((q) => q.includes("CREATE TABLE"));
    expect(create).toMatch(/CREATE TABLE pp_staged_[0-9a-f]{32} /);
    const drop = queries.filter((q) => q.startsWith("DROP TABLE IF EXISTS pp_staged_"));
    expect(drop.length).toBeGreaterThan(0);
  });

  it("groups issuers explicitly, never coalescing '' into 'unknown'", async () => {
    const { queries } = await run();
    const issuerSql = queries.find((q) => q.includes("GROUP BY issuer_key") && q.includes("min(issuer_name)"));
    expect(issuerSql).toBeTruthy();
    // The generic groupBy's `|| "unknown"` coalescing must not appear here: the
    // coverage split depends on '' and 'unknown' staying apart.
    expect(issuerSql).not.toContain("ifNull");
    expect(issuerSql).toContain("ORDER BY attempts DESC, issuer_key ASC");
    expect(issuerSql).toContain("LIMIT {row_cap:UInt32}");
  });

  it("binds the filter and the row cap as parameters, not literals", async () => {
    const { queries, params } = await run();
    const issuerSql = queries.find((q) => q.includes("GROUP BY issuer_key") && q.includes("min(issuer_name)")) ?? "";
    expect(issuerSql).toContain("funnel IN ({p_fn_0:String})");
    expect(issuerSql).not.toContain("soulmate");
    expect(params.some((p) => p.p_fn_0 === "soulmate")).toBe(true);
    expect(params.some((p) => p.row_cap === MAX_ISSUER_ROWS + 1)).toBe(true);
  });

  it("returns the banks discriminator so a router fallthrough is detectable", async () => {
    const { bundle } = await run();
    expect(bundle.action).toBe("banks");
    expect(bundle.coverage.total_attempts).toBe(10);
    expect(bundle.issuer_rows[0]?.issuer_key).toBe("sutton_bank");
    expect(bundle.truncated).toBe(false);
  });

  it("refuses to answer when coverage does not reconcile", async () => {
    const fake = fakeClickHouse((sql) => {
      if (sql.includes("countIf(issuer_key = 'unknown') reported_unknown")) {
        return [{ ...COVERAGE_ROW, missing: 99 }];
      }
      return standardRows(sql);
    });
    await expect(runBankAnalytics({
      authUserId: "user-1", clickhouse: fake.client, request: {},
    })).rejects.toThrow(/does not reconcile/);
  });
});

describe("runBankDetail", () => {
  it("requires a valid issuer_key", async () => {
    const fake = fakeClickHouse(() => []);
    await expect(runBankDetail({
      authUserId: "user-1", clickhouse: fake.client, request: {},
    })).rejects.toThrow(PaymentAnalyticsRequestError);
  });

  it("scopes every panel to the requested issuer via a bound parameter", async () => {
    const fake = fakeClickHouse(() => []);
    await runBankDetail({
      authUserId: "user-1", clickhouse: fake.client,
      request: { issuer_key: "sutton_bank" },
    });
    const all = fake.queries.join("\n");
    expect(all).toContain("issuer_key IN ({p_ik_0:String})");
    expect(fake.params.some((p) => p.p_ik_0 === "sutton_bank")).toBe(true);
    expect(all).not.toMatch(/raw_payload|normalized_payload|First6|Last4|Cardholder/i);
  });

  it("cross-tabs card type on the per-transaction column, not the user-attributed one", async () => {
    const fake = fakeClickHouse(() => []);
    await runBankDetail({
      authUserId: "user-1", clickhouse: fake.client,
      request: { issuer_key: "sutton_bank" },
    });
    // issuer × card_type must not mix a per-transaction dimension with the
    // uattr-flattened one — the detail reads card_type_tx.
    expect(fake.queries.some((q) => q.includes("GROUP BY card_type_tx"))).toBe(true);
  });
});
