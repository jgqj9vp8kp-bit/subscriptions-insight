import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  activeCohortMemberWhere,
  buildCohortMembershipInsertSql,
  buildMaterializedFilterOptionsQuery,
  buildMaterializedCohortListQuery,
  COHORT_CLASSIFICATION_VERSION,
  rebuildCohortMembership,
  runMaterializedCohortList,
} from "../../supabase/functions/_shared/clickhouse/cohortMembership.ts";
import { normalizeCohortRequest } from "../../supabase/functions/_shared/clickhouse/cohorts.ts";
import type { ClickHouseClientLike, SupabaseLikeClient } from "../../supabase/functions/_shared/clickhouse/types.ts";
import type { CohortFilters, CohortRequest } from "../../supabase/functions/_shared/clickhouse/cohortContract.ts";

interface SnapshotRpcCall {
  functionName: string;
  params: Record<string, unknown>;
}

function fakeSupabase(
  state: Record<string, unknown> | null,
  rpcCalls: SnapshotRpcCall[] = [],
  rpcResult: Partial<Record<string, boolean>> = {},
): SupabaseLikeClient {
  return {
    from() {
      const builder = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => ({ data: state, error: null }),
        upsert: async (value: unknown) => ({ data: value, error: null }),
      };
      return builder as never;
    },
    rpc: async (functionName, params = {}) => {
      rpcCalls.push({ functionName, params });
      return { data: rpcResult[functionName] ?? true, error: null };
    },
  };
}

function fakeClickHouse(options: {
  count?: number;
  duplicateUsers?: number;
  insertFails?: boolean;
  validationFails?: boolean;
  commands?: string[];
} = {}): ClickHouseClientLike {
  return {
    command: async ({ query }) => {
      options.commands?.push(query);
      if (options.insertFails && query.includes("INSERT INTO fact_user_cohorts")) throw new Error("insert failed");
    },
    insert: async () => undefined,
    query: async ({ query }) => ({
      json: async () => {
        if (query.includes("warehouse_hash")) {
          return [{
            transaction_count: 10,
            unique_users: 4,
            max_row_version: "99",
            max_source_updated_at: "2026-07-12 00:00:00",
            warehouse_hash: "abc123",
          }];
        }
        if (query.includes("(SELECT count() FROM dynamic) dynamic_users")) {
          return [{
            dynamic_users: 4,
            materialized_users: options.validationFails ? 3 : 4,
            duplicate_users: options.duplicateUsers ?? 0,
            missing_users: options.validationFails ? 1 : 0,
            extra_users: 0,
            cohort_date_mismatches: 0,
            trial_event_time_mismatches: 0,
            trial_transaction_id_mismatches: 0,
            funnel_mismatches: 0,
            campaign_path_mismatches: 0,
            campaign_id_mismatches: 0,
            traffic_source_mismatches: 0,
            media_buyer_mismatches: 0,
            country_mismatches: 0,
            card_type_mismatches: 0,
            currency_mismatches: 0,
            price_plan_mismatches: 0,
          }];
        }
        if (query.includes("count() - uniqExact(canonical_user_id)")) return [{ c: options.duplicateUsers ?? 0 }];
        if (query.includes("count() AS c")) return [{ c: options.count ?? 4 }];
        return [{ common_users: 0, unchanged_users: 0 }];
      },
    }),
  };
}

const request: CohortRequest = {
  action: "list",
  date_from: "2026-06-01",
  date_to: "2026-06-30",
  filters: {
    funnel: ["soulmate"],
    campaign_path: [],
    campaign_id: ["cmp-1"],
    traffic_source: ["facebook"],
    price_plan: ["$4.99"],
    media_buyer: ["Ivan"],
    country: ["US"],
    card_type: ["credit"],
    currency: ["USD"],
    transaction_type: [],
    refund_status: "all",
  },
};

describe("ClickHouse cohort membership materialization", () => {
  it("materializes one row per canonical user from the proven classifier", () => {
    const sql = buildCohortMembershipInsertSql();
    expect(sql).toContain("INSERT INTO fact_user_cohorts");
    expect(sql).toContain("GROUP BY uid");
    expect(sql).toContain("argMin(et, (ets, tprio, tid)) trial_event_time");
    expect(sql).toContain("argMin(tid, (ets, tprio, tid)) trial_transaction_id");
    expect(sql).toContain("c_campaign_id campaign_id");
    expect(sql).toContain("c_traffic_source traffic_source");
    expect(sql).toContain("u_media_buyer media_buyer");
    expect(sql).toContain("u_country country");
    expect(sql).toContain("u_card_type card_type");
    expect(sql).not.toContain("any(c_campaign_id)");
    expect(sql).toContain("GROUP BY uid, c_date");
    expect(sql).not.toContain("raw_payload");
  });

  it("builds materialized report SQL by joining selected members, not by raw-history filtering", () => {
    const params: Record<string, unknown> = { auth_user_id: "user-1" };
    const sql = buildMaterializedCohortListQuery(request, { warehouse_version: "wh_1", classification_version: "cv_1" }, params);
    expect(sql).toContain("INNER JOIN fact_user_cohorts AS fc FINAL");
    expect(sql).toContain("fc.canonical_user_id = a.user_id");
    expect(sql).toContain("fc.campaign_id IN ({p_mcid_0:String})");
    expect(sql).toContain("fc.traffic_source IN ({p_mtsrc_0:String})");
    expect(sql).toContain("fc.country IN ({p_mcountry_0:String})");
    expect(sql).toContain("fc.card_type IN ({p_mcard_0:String})");
    expect(sql).toContain("fc.price_plan IN ({p_mplan_0:String})");
    expect(sql).toContain("tid = trial_transaction_id, 'trial'");
    expect(params.p_mcid_0).toBe("cmp-1");
    expect(params.p_mplan_0).toBe("$4.99");
  });

  it("binds active cohort member filters as parameters", () => {
    const params: Record<string, unknown> = {};
    const where = activeCohortMemberWhere(request.filters as CohortFilters, params);
    expect(where).toContain("fc.funnel IN ({p_mfn_0:String})");
    expect(where).toContain("fc.media_buyer IN ({p_mmb_0:String})");
    expect(where).not.toContain("Ivan");
    expect(params.p_mmb_0).toBe("Ivan");
  });

  // Intentional contract update (UTM filter): every cohort dimension still
  // comes from fact_user_cohorts, but the Media Buyer dropdown's UTM entries
  // need the authoritative first-trial utm_source, which only exists in
  // analytics_transactions. The options query therefore adds ONE narrow lookup
  // CTE (transaction_id -> utm_source, scoped to the auth user) joined by the
  // snapshot's trial_transaction_id — it never re-derives cohort dimensions
  // from raw history.
  it("builds filter options from fact_user_cohorts plus only the narrow trial-utm lookup", () => {
    const params: Record<string, unknown> = { auth_user_id: "user-1" };
    const nreq = normalizeCohortRequest({ action: "options" } as CohortRequest);
    const sql = buildMaterializedFilterOptionsQuery(nreq, { warehouse_version: "wh_1", classification_version: "cv_1" }, params);
    expect(sql).toContain("FROM fact_user_cohorts FINAL");
    expect(sql).toContain("'price_plan' dim");
    expect(sql).toContain("'traffic_source' dim");
    expect(sql).toContain("'utm_source' dim");
    // The ONLY analytics_transactions access is the trial-utm lookup CTE.
    const scans = sql.match(/FROM analytics_transactions[^\n]*/g) ?? [];
    expect(scans).toHaveLength(1);
    expect(sql).toContain("SELECT transaction_id, utm_source");
    expect(sql).toContain("tutm.transaction_id = fcm.trial_transaction_id");
    // FINAL scans stay in standalone CTEs — never FINAL directly in a join list.
    expect(sql).not.toMatch(/FINAL\s+(AS\s+\w+\s+)?(LEFT|INNER|JOIN)/);
    expect(params.warehouse_version).toBe("wh_1");
  });

  it("scopes filter options to the request's active filters (cascading dropdowns)", () => {
    const params: Record<string, unknown> = { auth_user_id: "user-1" };
    const nreq = normalizeCohortRequest({
      action: "options",
      filters: { campaign_path: ["soulmate-sketch"] },
    } as CohortRequest);
    const sql = buildMaterializedFilterOptionsQuery(nreq, { warehouse_version: "wh_1", classification_version: "cv_1" }, params);
    // The active campaign_path constrains every OTHER dimension's list...
    expect(sql).toContain("(campaign_path IN ({o_campaign_path_0:String})) AS m_campaign_path");
    expect(sql).toContain("cnt FROM members WHERE m_campaign_path = 1 GROUP BY country");
    // ...but not its own (else the dropdown would lock to the selected value).
    expect(sql).toContain("cnt FROM members  GROUP BY campaign_path");
    expect(params.o_campaign_path_0).toBe("soulmate-sketch");
  });

  it("skips a rebuild when the active snapshot already matches the warehouse version", async () => {
    const rpcCalls: SnapshotRpcCall[] = [];
    const result = await rebuildCohortMembership({
      authUserId: "user-1",
      supabase: fakeSupabase({
        status: "completed",
        active_warehouse_version: "wh_abc123",
        active_classification_version: COHORT_CLASSIFICATION_VERSION,
        active_generated_at: "2026-07-12T00:00:00Z",
        users_classified: 4,
        duplicate_users: 0,
        diagnostics: { validation: { status: "PASS" } },
      }, rpcCalls),
      clickhouse: fakeClickHouse(),
    });
    expect(result.rows_inserted).toBe(0);
    expect(result.unchanged_users).toBe(4);
    expect(rpcCalls).toHaveLength(0);
  });

  it("activates a completed snapshot only after rows are inserted", async () => {
    const rpcCalls: SnapshotRpcCall[] = [];
    const commands: string[] = [];
    const result = await rebuildCohortMembership({
      authUserId: "user-1",
      supabase: fakeSupabase(null, rpcCalls),
      clickhouse: fakeClickHouse({ count: 4, commands }),
      force: true,
    });
    expect(commands.some((query) => query.includes("INSERT INTO fact_user_cohorts"))).toBe(true);
    expect(result.status).toBe("completed");
    expect(result.users_classified).toBe(4);
    expect(rpcCalls.map((call) => call.functionName)).toEqual([
      "claim_clickhouse_cohort_snapshot_build",
      "complete_clickhouse_cohort_snapshot_build",
    ]);
    expect(JSON.stringify(rpcCalls.at(-1)?.params)).toContain('"p_warehouse_version":"wh_abc123"');
    expect(JSON.stringify(rpcCalls.at(-1)?.params)).toContain('"validation":{"status":"PASS"');
  });

  it("does not activate a built snapshot when membership validation fails", async () => {
    const rpcCalls: SnapshotRpcCall[] = [];
    await expect(rebuildCohortMembership({
      authUserId: "user-1",
      supabase: fakeSupabase({
        status: "completed",
        active_warehouse_version: "wh_old",
        active_classification_version: "cohort_classifier_v1_dynamic_sql",
        diagnostics: { validation: { status: "PASS" } },
      }, rpcCalls),
      clickhouse: fakeClickHouse({ count: 4, validationFails: true }),
      force: true,
    })).rejects.toThrow("validation failed");
    expect(rpcCalls.at(-1)?.functionName).toBe("fail_clickhouse_cohort_snapshot_build");
    const failedPatch = JSON.stringify(rpcCalls.at(-1)?.params);
    expect(failedPatch).toContain('"validation":{"status":"FAIL"');
    expect(failedPatch).not.toContain('"active_warehouse_version":"wh_abc123"');
  });

  // ---- One-warehouse-version-per-response (forensic audit regression) ------
  // A fake warehouse where the snapshot was built on `snapshotVersionHash` while
  // the LIVE table now holds `liveCount` rows under `liveVersionHash`. Every
  // query the materialized list path runs is routed by a distinctive marker.
  function fakeWarehouse(options: {
    liveCount: number;
    liveHash: string;
    fxTotal: number;
    fxNative: number;
    fxConverted: number;
    fingerprintFails?: boolean;
  }): ClickHouseClientLike {
    return {
      command: async () => undefined,
      insert: async () => undefined,
      query: async ({ query }) => ({
        json: async () => {
          if (query.includes("warehouse_hash")) {
            if (options.fingerprintFails) throw new Error("fingerprint query failed");
            return [{
              transaction_count: options.liveCount,
              unique_users: 10_242,
              max_row_version: "999",
              max_source_updated_at: "2026-07-14 11:10:17",
              warehouse_hash: options.liveHash,
            }];
          }
          if (query.includes("transactions_with_currency")) {
            return [{
              transactions_total: options.fxTotal,
              transactions_with_currency: options.fxTotal,
              transactions_without_currency: 0,
              transactions_native_usd: options.fxNative,
              transactions_converted: options.fxConverted,
              transactions_missing_fx_rate: 0,
              transactions_invalid_amount: 0,
              excluded_amount_original: 0,
              excluded_transactions: 0,
            }];
          }
          if (query.includes("system.tables")) return [{ c: 1 }];
          if (query.includes("INNER JOIN fact_user_cohorts")) return []; // aggregate rows
          if (query.includes("AS support_requests")) return [{ support_requests: 0, support_unique_emails: 0 }];
          if (query.includes("fact_subscriptions")) return [{ c: 0 }];
          if (query.includes("count() AS c")) return [{ c: 0 }];
          return []; // filter options
        },
      }),
    };
  }

  const activeSnapshotState = {
    status: "completed",
    active_warehouse_version: "wh_snapshotver",
    active_classification_version: "cohort_classifier_v1_dynamic_sql",
    active_generated_at: "2026-07-13T16:14:21.517Z",
    users_classified: 7_145,
    duplicate_users: 0,
    source_transactions: 28_885,
    source_unique_users: 10_031,
    diagnostics: { validation: { status: "PASS" } },
  };

  it("stale snapshot: response says stale/incomplete and carries BOTH versions — never 'complete'", async () => {
    const response = await runMaterializedCohortList({
      authUserId: "user-1",
      supabase: fakeSupabase(activeSnapshotState),
      // Live warehouse moved to 29,479 rows under a DIFFERENT version hash.
      clickhouse: fakeWarehouse({ liveCount: 29_479, liveHash: "livever", fxTotal: 29_479, fxNative: 26_191, fxConverted: 3_288 }),
      request: { action: "list" },
    });
    expect(response).not.toBeNull();
    const d = response!.diagnostics;
    expect(d.snapshot_stale).toBe(true);
    expect(d.snapshot_status).toBe("stale");
    expect(d.snapshot_complete).toBe(false);
    expect(d.report_complete).toBe(false);
    expect(d.source_transactions).toBe(28_885);
    expect(d.source_warehouse_version).toBe("wh_snapshotver");
    expect(d.current_warehouse_version).toBe("wh_livever");
    expect(d.current_warehouse_transactions).toBe(29_479);
    // FX totals and the live fingerprint in the SAME response agree with each other.
    expect(response!.fx_diagnostics?.transactions_total).toBe(d.current_warehouse_transactions);
  });

  it("current snapshot: FX status sum equals the scoped rows and the report is complete", async () => {
    const response = await runMaterializedCohortList({
      authUserId: "user-1",
      supabase: fakeSupabase({ ...activeSnapshotState, active_warehouse_version: "wh_livever", source_transactions: 29_479, source_unique_users: 10_242 }),
      clickhouse: fakeWarehouse({ liveCount: 29_479, liveHash: "livever", fxTotal: 29_479, fxNative: 26_191, fxConverted: 3_288 }),
      request: { action: "list" },
    });
    const d = response!.diagnostics;
    const fx = response!.fx_diagnostics!;
    expect(d.snapshot_stale).toBe(false);
    expect(d.snapshot_status).toBe("current");
    expect(d.snapshot_complete).toBe(true);
    expect(d.report_complete).toBe(true);
    // Invariant: native + converted + without currency + missing rate = rows in scope.
    expect(
      fx.transactions_native_usd + fx.transactions_converted + fx.transactions_without_currency + fx.transactions_missing_fx_rate,
    ).toBe(fx.transactions_total);
    expect(fx.transactions_total).toBe(d.source_transactions);
    expect(fx.transactions_total).toBe(d.current_warehouse_transactions);
    expect(d.source_warehouse_version).toBe(d.current_warehouse_version);
  });

  it("fingerprint unavailable: freshness is honestly unknown — not claimed complete", async () => {
    const response = await runMaterializedCohortList({
      authUserId: "user-1",
      supabase: fakeSupabase(activeSnapshotState),
      clickhouse: fakeWarehouse({ liveCount: 0, liveHash: "x", fxTotal: 29_479, fxNative: 26_191, fxConverted: 3_288, fingerprintFails: true }),
      request: { action: "list" },
    });
    const d = response!.diagnostics;
    expect(d.snapshot_stale).toBeUndefined();
    expect(d.report_complete).toBeUndefined();
    expect(d.snapshot_complete).toBe(false);
    expect(d.snapshot_status).toBe("completed"); // raw build status, no freshness claim
    expect(d.current_warehouse_version).toBeNull();
  });

  it("failed rebuild records failure without replacing the active snapshot", async () => {
    const rpcCalls: SnapshotRpcCall[] = [];
    await expect(rebuildCohortMembership({
      authUserId: "user-1",
      supabase: fakeSupabase({
        status: "completed",
        active_warehouse_version: "wh_old",
        active_classification_version: "cohort_classifier_v1_dynamic_sql",
      }, rpcCalls),
      clickhouse: fakeClickHouse({ insertFails: true }),
      force: true,
    })).rejects.toThrow("insert failed");
    expect(rpcCalls.at(-1)?.functionName).toBe("fail_clickhouse_cohort_snapshot_build");
    const failedPatch = JSON.stringify(rpcCalls.at(-1)?.params);
    expect(failedPatch).not.toContain("active_warehouse_version");
  });

  it("refuses to activate a rebuild whose CAS token was superseded", async () => {
    const rpcCalls: SnapshotRpcCall[] = [];
    await expect(rebuildCohortMembership({
      authUserId: "user-1",
      supabase: fakeSupabase(null, rpcCalls, { complete_clickhouse_cohort_snapshot_build: false }),
      clickhouse: fakeClickHouse({ count: 4 }),
      force: true,
    })).rejects.toThrow("superseded");
    const claimToken = rpcCalls.find((call) => call.functionName === "claim_clickhouse_cohort_snapshot_build")?.params.p_build_token;
    const completeToken = rpcCalls.find((call) => call.functionName === "complete_clickhouse_cohort_snapshot_build")?.params.p_build_token;
    expect(claimToken).toBeTruthy();
    expect(completeToken).toBe(claimToken);
    expect(rpcCalls.at(-1)?.functionName).toBe("fail_clickhouse_cohort_snapshot_build");
  });

  it("does not start a second rebuild while the snapshot lease is active", async () => {
    const rpcCalls: SnapshotRpcCall[] = [];
    const commands: string[] = [];
    await expect(rebuildCohortMembership({
      authUserId: "user-1",
      supabase: fakeSupabase(null, rpcCalls, { claim_clickhouse_cohort_snapshot_build: false }),
      clickhouse: fakeClickHouse({ commands }),
      force: true,
    })).rejects.toThrow("already in progress");
    expect(commands.some((query) => query.includes("INSERT INTO fact_user_cohorts"))).toBe(false);
  });

  it("uses lease claim and build-token CAS predicates in the database migration", () => {
    const sql = readFileSync("supabase/migrations/202607180001_add_cohort_snapshot_build_cas.sql", "utf8");
    expect(sql).toContain("lease_expires_at <= now()");
    expect(sql).toContain("and build_token = p_build_token");
    expect(sql).toContain("and building_warehouse_version = p_warehouse_version");
    expect(sql).toContain("grant execute on function public.complete_clickhouse_cohort_snapshot_build");
  });
});
