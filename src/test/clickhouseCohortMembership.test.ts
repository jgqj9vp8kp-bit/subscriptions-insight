import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  activeCohortMemberWhere,
  buildCohortMembershipInsertSql,
  buildMaterializedFilterOptionsQuery,
  buildMaterializedCohortListQuery,
  CAMPAIGN_SCOPE_BUDGET_MS,
  COHORT_CLASSIFICATION_VERSION,
  CohortRebuildBusyError,
  rebuildCohortMembership,
  runMaterializedCohortList,
  snapshotRetentionSql,
  TICK_FAILURE_BACKOFF_MAX_MS,
} from "../../supabase/functions/_shared/clickhouse/cohortMembership.ts";
import { CAMPAIGN_SCOPE_VERSION } from "../../supabase/functions/_shared/clickhouse/cohortSnapshotState.ts";
import { ScopeViolation } from "../../supabase/functions/_shared/clickhouse/scopedClient.ts";
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
    platform: ["android"],
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
    expect(sql).toContain("u_platform platform");
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
    expect(sql).toContain("fc.platform IN ({p_mplat_0:String})");
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

  it("binds campaign_path_exclude as a parameterized NOT IN on the member scope", () => {
    const params: Record<string, unknown> = {};
    const where = activeCohortMemberWhere(
      { ...(request.filters as CohortFilters), campaign_path_exclude: ["soulmate-sketch-es"] },
      params,
    );
    expect(where).toContain("fc.campaign_path NOT IN ({p_mcpx_0:String})");
    expect(where).not.toContain("soulmate-sketch-es");
    expect(params.p_mcpx_0).toBe("soulmate-sketch-es");
    // Absent (old clients) or empty -> no clause.
    const cleanParams: Record<string, unknown> = {};
    expect(activeCohortMemberWhere(request.filters as CohortFilters, cleanParams)).not.toContain("NOT IN");
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
    const commands: string[] = [];
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
      clickhouse: fakeClickHouse({ commands }),
    });
    expect(result.rows_inserted).toBe(0);
    expect(result.unchanged_users).toBe(4);
    // No claim, no reclassification. Phase 2: freshness is observed, and the
    // campaign scope this pre-Phase-2 snapshot lacks is filled in (PASS → recorded).
    expect(commands.some((query) => query.includes("INSERT INTO fact_user_cohorts"))).toBe(false);
    expect(rpcCalls.map((call) => call.functionName)).toEqual([
      "observe_clickhouse_cohort_snapshot_fingerprint",
      "set_clickhouse_campaign_scope_version",
    ]);
    expect(result.campaign_scope?.status).toBe("PASS");
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
      "observe_clickhouse_cohort_snapshot_fingerprint",
      "claim_clickhouse_cohort_snapshot_build",
      "complete_clickhouse_cohort_snapshot_build",
      "set_clickhouse_campaign_scope_version",
    ]);
    const complete = JSON.stringify(rpcCalls[2]?.params);
    expect(complete).toContain('"p_warehouse_version":"wh_abc123"');
    expect(complete).toContain('"validation":{"status":"PASS"');
    // Activation carries exactly the pre-Phase-2 diagnostics; the campaign
    // scope is built after it and recorded by its own RPC.
    expect(complete).not.toContain("campaign_scope");
    // A first attempt claims with exactly the pre-Phase-2 diagnostics.
    expect(Object.keys(rpcCalls[1]?.params.p_diagnostics as object)).toEqual(["warehouse"]);
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

describe("email-matched token revenue on the snapshot path (TODO_MONETIZATION item 3)", () => {
  it("keeps the snapshot INSERT free of email-token rows (uid-keyed identity)", () => {
    const sql = buildCohortMembershipInsertSql();
    expect(sql).not.toContain("etok");
    expect(sql).not.toContain("via_email");
    expect(sql).toContain("FROM membership");
  });

  it("unions email-matched token rows into the materialized aggregate", () => {
    const params: Record<string, unknown> = { auth_user_id: "user-1" };
    const sql = buildMaterializedCohortListQuery(request, { warehouse_version: "wh_1", classification_version: "cv_1" }, params);
    expect(sql).toContain("cemail AS");
    expect(sql).toContain("etok AS");
    expect(sql).toContain("FROM finx");
    // Exclusion covers ALL snapshot members (fcall) — a member hidden by
    // filters still never has their own rows re-attributed by email. The email
    // map itself (fcm) only covers filter-passing members, like the client.
    expect(sql).toContain("a.user_id NOT IN (SELECT canonical_user_id FROM fcall)");
    expect(sql).toContain("a.transaction_type = 'token_purchase'");
    // Email rows carry the member's cohort key and cannot enter sequences.
    expect(sql).toContain("0 lvl, 0 slot");
    // The member filters bind into the email-map CTE too.
    expect(sql).toContain("fc.campaign_id IN ({p_mcid_0:String})");
  });
});

// ---- access Phase 2: freshness, campaign scope, retention, the cron tick (spec §3.8) ----

describe("snapshot rebuild for funnel-restricted freshness", () => {
  /** One ordered event log over both clients, plus every RPC / command / insert. */
  function rebuildHarness(options: {
    state?: Record<string, unknown> | null;
    rpcResult?: Partial<Record<string, boolean>>;
    rpcError?: Partial<Record<string, string>>;
    campaignScopeFails?: boolean;
    campaignScopeHangs?: boolean;
    insertFails?: boolean;
    retentionError?: () => Error;
  } = {}) {
    const events: string[] = [];
    const rpcCalls: SnapshotRpcCall[] = [];
    const commands: Array<{ query: string; params: Record<string, unknown> }> = [];
    const inserts: Array<{ table: string; values: Record<string, unknown>[] }> = [];
    const supabase: SupabaseLikeClient = {
      from() {
        const builder = {
          select: () => builder,
          eq: () => builder,
          maybeSingle: async () => ({ data: options.state ?? null, error: null }),
        };
        return builder as never;
      },
      rpc: async (functionName, params = {}) => {
        rpcCalls.push({ functionName, params });
        events.push(`rpc:${functionName}`);
        const error = options.rpcError?.[functionName];
        if (error) return { data: null, error: { message: error } };
        return { data: options.rpcResult?.[functionName] ?? true, error: null };
      },
    };
    const clickhouse: ClickHouseClientLike = {
      command: async ({ query, query_params }) => {
        commands.push({ query, params: query_params ?? {} });
        const head = query.trim().split(/\s+/).slice(0, 3).join(" ");
        events.push(`command:${head}`);
        if (options.retentionError && query.startsWith("ALTER TABLE")) throw options.retentionError();
        if (options.insertFails && query.includes("INSERT INTO fact_user_cohorts")) throw new Error("insert failed");
      },
      insert: async ({ table, values }) => {
        inserts.push({ table, values: values as Record<string, unknown>[] });
        events.push(`insert:${table}`);
      },
      query: async ({ query }) => ({
        json: async () => {
          if (query.includes("warehouse_hash")) {
            return [{ transaction_count: 10, unique_users: 4, max_row_version: "99", max_source_updated_at: "2026-10-06 00:00:00", warehouse_hash: "abc123" }];
          }
          if (query.includes("(SELECT count() FROM dynamic) dynamic_users")) {
            return [{ dynamic_users: 4, materialized_users: 4, duplicate_users: 0, missing_users: 0, extra_users: 0 }];
          }
          // Campaign scope evidence and its FINAL read-back (campaignScope.ts).
          if (query.includes("AS cid") && options.campaignScopeHangs) return new Promise<never>(() => undefined);
          if (query.includes("AS cid")) return [{ cid: "c1", campaign_path: "soulmate-sketch", users: 3 }, { cid: "c2", campaign_path: "palm-reading", users: 1 }];
          if (query.includes("AS scope_rows")) {
            return [{ scope_rows: options.campaignScopeFails ? 1 : 2, campaign_ids: 2, bad_resolved: 0, bad_mixed: 0, anchor_total: 4 }];
          }
          if (query.includes("count() - uniqExact(canonical_user_id)")) return [{ c: 0 }];
          if (query.includes("count() AS c")) return [{ c: 4 }];
          return [{ common_users: 0, unchanged_users: 0 }];
        },
      }),
    };
    return { supabase, clickhouse, events, rpcCalls, commands, inserts };
  }

  const CURRENT = {
    status: "completed",
    active_warehouse_version: "wh_abc123",
    active_classification_version: COHORT_CLASSIFICATION_VERSION,
    active_generated_at: "2026-10-06T00:00:00Z",
    users_classified: 4,
    duplicate_users: 0,
    diagnostics: { validation: { status: "PASS" } },
    active_validation: { status: "PASS" },
    active_campaign_scope_version: CAMPAIGN_SCOPE_VERSION,
  };
  const OLD = {
    status: "completed",
    active_warehouse_version: "wh_old",
    active_classification_version: "cohort_classifier_v2",
    users_classified: 3,
    duplicate_users: 0,
    diagnostics: { validation: { status: "PASS" } },
  };
  const names = (calls: SnapshotRpcCall[]) => calls.map((call) => call.functionName);
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

  it("observes freshness first (fingerprint + classifier version); a current snapshot is left alone", async () => {
    const h = rebuildHarness({ state: CURRENT });
    const result = await rebuildCohortMembership({ authUserId: "user-1", supabase: h.supabase, clickhouse: h.clickhouse, mode: "tick" });
    expect(names(h.rpcCalls)).toEqual(["observe_clickhouse_cohort_snapshot_fingerprint"]);
    expect(h.rpcCalls[0].params).toEqual({
      p_auth_user_id: "user-1",
      p_warehouse_version: "wh_abc123",
      p_classification_version: COHORT_CLASSIFICATION_VERSION,
    });
    expect(result).toMatchObject({ status: "completed", rows_inserted: 0, tick_status: "current" });
    expect(result.campaign_scope).toBeUndefined();
    expect(h.commands.map((command) => command.query).filter((query) => !query.includes("CREATE TABLE IF NOT EXISTS fact_user_cohorts"))).toEqual([]);
    expect(h.inserts).toEqual([]);
  });

  it("an observe fault (migration not applied, RPC error) never fails the rebuild", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const h = rebuildHarness({ state: CURRENT, rpcError: { observe_clickhouse_cohort_snapshot_fingerprint: "function does not exist" } });
    await expect(rebuildCohortMembership({ authUserId: "user-1", supabase: h.supabase, clickhouse: h.clickhouse })).resolves.toMatchObject({ status: "completed" });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("current snapshot without a campaign scope: builds it for the ACTIVE versions and records it, no reclassify", async () => {
    const h = rebuildHarness({ state: { ...CURRENT, active_campaign_scope_version: null } });
    const result = await rebuildCohortMembership({ authUserId: "user-1", supabase: h.supabase, clickhouse: h.clickhouse, mode: "tick" });
    expect(result.tick_status).toBe("campaign_scope_rebuilt");
    expect(result.campaign_scope).toMatchObject({ version: CAMPAIGN_SCOPE_VERSION, status: "PASS", rows: 2, resolved: 1, unresolved: 1 });
    expect(names(h.rpcCalls)).toEqual(["observe_clickhouse_cohort_snapshot_fingerprint", "set_clickhouse_campaign_scope_version"]);
    expect(h.rpcCalls[1].params).toEqual({
      p_auth_user_id: "user-1",
      p_warehouse_version: "wh_abc123",
      p_classification_version: COHORT_CLASSIFICATION_VERSION,
      p_scope_version: CAMPAIGN_SCOPE_VERSION,
    });
    expect(h.inserts.map((insert) => insert.table)).toEqual(["fact_campaign_scope"]);
    expect(h.inserts[0].values.every((row) => row.warehouse_version === "wh_abc123" && row.classification_version === COHORT_CLASSIFICATION_VERSION)).toBe(true);
    expect(h.commands.some((command) => command.query.includes("INSERT INTO fact_user_cohorts"))).toBe(false);
    expect(h.commands.some((command) => command.query.startsWith("ALTER TABLE"))).toBe(false);
    // The user action reports the same fill, without a tick_status.
    const user = rebuildHarness({ state: { ...CURRENT, active_campaign_scope_version: null } });
    const userResult = await rebuildCohortMembership({ authUserId: "user-1", supabase: user.supabase, clickhouse: user.clickhouse });
    expect(userResult.tick_status).toBeUndefined();
    expect(userResult.campaign_scope?.status).toBe("PASS");
  });

  it("a FAIL on the fill path records nothing (the tick retries next time)", async () => {
    const h = rebuildHarness({ state: { ...CURRENT, active_campaign_scope_version: null }, campaignScopeFails: true });
    const result = await rebuildCohortMembership({ authUserId: "user-1", supabase: h.supabase, clickhouse: h.clickhouse, mode: "tick" });
    expect(result.campaign_scope?.status).toBe("FAIL");
    expect(result.tick_status).toBe("current");
    expect(names(h.rpcCalls)).toEqual(["observe_clickhouse_cohort_snapshot_fingerprint"]);
  });

  it("the fill path is time-bounded too: past the budget it reports FAIL and answers", async () => {
    vi.useFakeTimers();
    try {
      const h = rebuildHarness({ state: { ...CURRENT, active_campaign_scope_version: null }, campaignScopeHangs: true });
      const pending = rebuildCohortMembership({ authUserId: "user-1", supabase: h.supabase, clickhouse: h.clickhouse, mode: "tick" });
      await vi.advanceTimersByTimeAsync(CAMPAIGN_SCOPE_BUDGET_MS);
      const result = await pending;
      expect(result).toMatchObject({ status: "completed", tick_status: "current", rows_inserted: 0 });
      expect(result.campaign_scope).toMatchObject({ status: "FAIL", error: expect.stringMatching(/exceeded/) });
      expect(names(h.rpcCalls)).toEqual(["observe_clickhouse_cohort_snapshot_fingerprint"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a current snapshot whose last build failed is rebuilt (the owner's materialized path needs it completed)", async () => {
    const h = rebuildHarness({ state: { ...CURRENT, status: "failed", building_warehouse_version: "wh_other", finished_at: ago(5) } });
    const result = await rebuildCohortMembership({ authUserId: "user-1", supabase: h.supabase, clickhouse: h.clickhouse });
    expect(names(h.rpcCalls)).toContain("claim_clickhouse_cohort_snapshot_build");
    expect(result.rows_inserted).toBe(4);
  });

  it("full build: the campaign scope of the NEW versions is built after activation; a FAIL never fails the build", async () => {
    const h = rebuildHarness({ state: OLD, campaignScopeFails: true });
    const result = await rebuildCohortMembership({ authUserId: "user-1", supabase: h.supabase, clickhouse: h.clickhouse, mode: "tick" });
    expect(result).toMatchObject({ status: "completed", tick_status: "rebuilt", warehouse_version: "wh_abc123" });
    expect(result.campaign_scope?.status).toBe("FAIL");
    const complete = h.rpcCalls.find((call) => call.functionName === "complete_clickhouse_cohort_snapshot_build");
    const diagnostics = complete?.params.p_diagnostics as Record<string, unknown>;
    // Owner-regression review: activation is the pre-Phase-2 path — no
    // campaign-scope statement runs before the complete CAS, and its
    // diagnostics carry no campaign_scope.
    expect(diagnostics).not.toHaveProperty("campaign_scope");
    expect(diagnostics.validation).toMatchObject({ status: "PASS" });
    expect(h.inserts[0].values.every((row) => row.warehouse_version === "wh_abc123")).toBe(true);
    const completeAt = h.events.indexOf("rpc:complete_clickhouse_cohort_snapshot_build");
    expect(h.events.indexOf("command:INSERT INTO fact_user_cohorts")).toBeLessThan(completeAt);
    expect(h.events.indexOf("insert:fact_campaign_scope")).toBeGreaterThan(completeAt);
    const firstScopeStatement = h.commands.findIndex((command) => command.query.includes("fact_campaign_scope"));
    expect(h.commands.slice(0, firstScopeStatement).some((command) => command.query.includes("INSERT INTO fact_user_cohorts"))).toBe(true);
    expect(h.events.lastIndexOf("command:CREATE TABLE IF")).toBeGreaterThan(completeAt); // the fact_campaign_scope ensure
    // A FAIL records nothing.
    expect(names(h.rpcCalls)).not.toContain("set_clickhouse_campaign_scope_version");
  });

  it("full build: a PASS is recorded for the NEW versions after activation, before retention", async () => {
    const h = rebuildHarness({ state: OLD });
    const result = await rebuildCohortMembership({ authUserId: "user-1", supabase: h.supabase, clickhouse: h.clickhouse, mode: "tick" });
    expect(result.campaign_scope?.status).toBe("PASS");
    expect(names(h.rpcCalls)).toEqual([
      "observe_clickhouse_cohort_snapshot_fingerprint",
      "claim_clickhouse_cohort_snapshot_build",
      "complete_clickhouse_cohort_snapshot_build",
      "set_clickhouse_campaign_scope_version",
    ]);
    expect(h.rpcCalls[3].params).toEqual({
      p_auth_user_id: "user-1",
      p_warehouse_version: "wh_abc123",
      p_classification_version: COHORT_CLASSIFICATION_VERSION,
      p_scope_version: CAMPAIGN_SCOPE_VERSION,
    });
    expect(h.events.indexOf("insert:fact_campaign_scope")).toBeGreaterThan(h.events.indexOf("rpc:complete_clickhouse_cohort_snapshot_build"));
    expect(h.events.indexOf("rpc:set_clickhouse_campaign_scope_version")).toBeLessThan(h.events.indexOf("command:ALTER TABLE fact_user_cohorts"));
  });

  it("a campaign-scope build past its budget reports FAIL; the activated rebuild still answers", async () => {
    vi.useFakeTimers();
    try {
      const h = rebuildHarness({ state: OLD, campaignScopeHangs: true });
      let settled = false;
      const pending = rebuildCohortMembership({ authUserId: "user-1", supabase: h.supabase, clickhouse: h.clickhouse, mode: "tick" })
        .finally(() => {
          settled = true;
        });
      await vi.advanceTimersByTimeAsync(CAMPAIGN_SCOPE_BUDGET_MS - 1);
      expect(settled).toBe(false);
      expect(names(h.rpcCalls)).toContain("complete_clickhouse_cohort_snapshot_build");
      await vi.advanceTimersByTimeAsync(1);
      const result = await pending;
      expect(result).toMatchObject({ status: "completed", tick_status: "rebuilt" });
      expect(result.campaign_scope).toMatchObject({ version: CAMPAIGN_SCOPE_VERSION, status: "FAIL" });
      expect(result.campaign_scope?.error).toMatch(/exceeded 10000 ms/);
      expect(names(h.rpcCalls)).not.toContain("set_clickhouse_campaign_scope_version");
      expect(h.commands.filter((command) => command.query.startsWith("ALTER TABLE"))).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retention runs only after the complete CAS, for both tables, keeping the new and the previously active versions", async () => {
    const h = rebuildHarness({ state: OLD });
    const result = await rebuildCohortMembership({ authUserId: "user-1", supabase: h.supabase, clickhouse: h.clickhouse });
    const retention = h.commands.filter((command) => command.query.startsWith("ALTER TABLE"));
    expect(retention.map((command) => command.query)).toEqual([snapshotRetentionSql("fact_user_cohorts"), snapshotRetentionSql("fact_campaign_scope")]);
    for (const command of retention) {
      expect(command.params).toEqual({
        auth_user_id: "user-1",
        generated_at: result.generated_at,
        keep_wh_1: "wh_abc123",
        keep_cls_1: COHORT_CLASSIFICATION_VERSION,
        keep_wh_2: "wh_old",
        keep_cls_2: "cohort_classifier_v2",
      });
    }
    expect(h.events.indexOf("rpc:complete_clickhouse_cohort_snapshot_build")).toBeLessThan(h.events.indexOf("command:ALTER TABLE fact_user_cohorts"));
    expect(snapshotRetentionSql("fact_user_cohorts")).toBe(
      "ALTER TABLE fact_user_cohorts DELETE WHERE auth_user_id = {auth_user_id:String}\n" +
      "  AND generated_at < parseDateTime64BestEffort({generated_at:String}, 3, 'UTC')\n" +
      "  AND (warehouse_version, classification_version) NOT IN (({keep_wh_1:String}, {keep_cls_1:String}), ({keep_wh_2:String}, {keep_cls_2:String}))",
    );
  });

  it("retention keeps the new pair twice on a first build, skips a superseded build, and is best effort", async () => {
    const first = rebuildHarness({ state: null });
    await rebuildCohortMembership({ authUserId: "user-1", supabase: first.supabase, clickhouse: first.clickhouse });
    const params = first.commands.find((command) => command.query.startsWith("ALTER TABLE"))?.params;
    expect(params).toMatchObject({ keep_wh_1: "wh_abc123", keep_wh_2: "wh_abc123", keep_cls_2: COHORT_CLASSIFICATION_VERSION });

    const superseded = rebuildHarness({ state: OLD, rpcResult: { complete_clickhouse_cohort_snapshot_build: false } });
    await expect(rebuildCohortMembership({ authUserId: "user-1", supabase: superseded.supabase, clickhouse: superseded.clickhouse })).rejects.toThrow("superseded");
    expect(superseded.commands.some((command) => command.query.startsWith("ALTER TABLE"))).toBe(false);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const failing = rebuildHarness({ state: OLD, retentionError: () => new Error("mutation rejected") });
    await expect(rebuildCohortMembership({ authUserId: "user-1", supabase: failing.supabase, clickhouse: failing.clickhouse })).resolves.toMatchObject({ status: "completed" });
    expect(failing.commands.filter((command) => command.query.startsWith("ALTER TABLE"))).toHaveLength(2);
    warn.mockRestore();

    const violating = rebuildHarness({ state: OLD, retentionError: () => new ScopeViolation("restricted_write") });
    await expect(rebuildCohortMembership({ authUserId: "user-1", supabase: violating.supabase, clickhouse: violating.clickhouse })).rejects.toBeInstanceOf(ScopeViolation);
  });

  it("a claim lost to another build is a CohortRebuildBusyError (today's message)", async () => {
    const h = rebuildHarness({ state: OLD, rpcResult: { claim_clickhouse_cohort_snapshot_build: false } });
    const error = await rebuildCohortMembership({ authUserId: "user-1", supabase: h.supabase, clickhouse: h.clickhouse, mode: "tick" }).catch((caught) => caught);
    expect(error).toBeInstanceOf(CohortRebuildBusyError);
    expect(error.message).toBe("A cohort snapshot rebuild is already in progress for this account.");
  });

  it("tick backoff: an abandoned build of the same versions (lease expired, still building) waits like a failed one", async () => {
    const abandoned = {
      ...OLD, status: "building", building_warehouse_version: "wh_abc123", building_classification_version: COHORT_CLASSIFICATION_VERSION,
      started_at: ago(20), lease_expires_at: ago(15), diagnostics: { warehouse: {} },
    };
    const h = rebuildHarness({ state: abandoned });
    const result = await rebuildCohortMembership({ authUserId: "user-1", supabase: h.supabase, clickhouse: h.clickhouse, mode: "tick" });
    expect(result).toMatchObject({ tick_status: "backoff", rows_inserted: 0 });
    expect(names(h.rpcCalls)).toEqual(["observe_clickhouse_cohort_snapshot_fingerprint"]);

    // After the window it is claimed again as attempt 2 (recorded for the next backoff).
    const later = rebuildHarness({ state: { ...abandoned, started_at: ago(61), lease_expires_at: ago(56) } });
    await rebuildCohortMembership({ authUserId: "user-1", supabase: later.supabase, clickhouse: later.clickhouse, mode: "tick" });
    const claim = later.rpcCalls.find((call) => call.functionName === "claim_clickhouse_cohort_snapshot_build");
    expect((claim?.params.p_diagnostics as Record<string, unknown>).attempt).toBe(2);

    // A live lease is another build at work: no backoff, the claim decides (in_progress).
    const live = rebuildHarness({
      state: { ...abandoned, lease_expires_at: new Date(Date.now() + 60_000).toISOString() },
      rpcResult: { claim_clickhouse_cohort_snapshot_build: false },
    });
    await expect(rebuildCohortMembership({ authUserId: "user-1", supabase: live.supabase, clickhouse: live.clickhouse, mode: "tick" })).rejects.toBeInstanceOf(CohortRebuildBusyError);
    // An abandoned build of other versions does not hold the tick back.
    const other = rebuildHarness({ state: { ...abandoned, building_warehouse_version: "wh_other" } });
    await rebuildCohortMembership({ authUserId: "user-1", supabase: other.supabase, clickhouse: other.clickhouse, mode: "tick" });
    expect(names(other.rpcCalls)).toContain("claim_clickhouse_cohort_snapshot_build");
  });

  it("tick backoff doubles per consecutive attempt of the same versions, capped at 6 hours", async () => {
    const failed = (attempt: number, minutesAgo: number) => ({
      ...OLD, status: "failed", building_warehouse_version: "wh_abc123", building_classification_version: COHORT_CLASSIFICATION_VERSION,
      finished_at: ago(minutesAgo), diagnostics: { warehouse: {}, error: "validation failed", attempt },
    });
    const tickOn = async (state: Record<string, unknown>) => {
      const h = rebuildHarness({ state });
      const result = await rebuildCohortMembership({ authUserId: "user-1", supabase: h.supabase, clickhouse: h.clickhouse, mode: "tick" });
      return { result, h };
    };
    // attempt 3 → a 4 h window.
    expect((await tickOn(failed(3, 3 * 60))).result.tick_status).toBe("backoff");
    const retried = await tickOn(failed(3, 4 * 60 + 1));
    expect(retried.result.tick_status).toBe("rebuilt");
    const claim = retried.h.rpcCalls.find((call) => call.functionName === "claim_clickhouse_cohort_snapshot_build");
    expect((claim?.params.p_diagnostics as Record<string, unknown>).attempt).toBe(4);
    // The cap: attempt 10 waits 6 h, not 512.
    expect((await tickOn(failed(10, TICK_FAILURE_BACKOFF_MAX_MS / 60_000 - 1))).result.tick_status).toBe("backoff");
    expect((await tickOn(failed(10, TICK_FAILURE_BACKOFF_MAX_MS / 60_000 + 1))).result.tick_status).toBe("rebuilt");
    // A failed attempt > 1 records its number for the next tick.
    const failing = rebuildHarness({ state: failed(2, 3 * 60), insertFails: true });
    await expect(rebuildCohortMembership({ authUserId: "user-1", supabase: failing.supabase, clickhouse: failing.clickhouse, mode: "tick" })).rejects.toThrow("insert failed");
    const fail = failing.rpcCalls.find((call) => call.functionName === "fail_clickhouse_cohort_snapshot_build");
    expect(fail?.params.p_diagnostics).toMatchObject({ error: "insert failed", attempt: 3 });
  });

  it("tick backoff: no retry within 60 minutes of a failed build of the same versions", async () => {
    const failedNow = { ...OLD, status: "failed", building_warehouse_version: "wh_abc123", building_classification_version: COHORT_CLASSIFICATION_VERSION, finished_at: ago(10) };
    const backoff = rebuildHarness({ state: failedNow });
    const result = await rebuildCohortMembership({ authUserId: "user-1", supabase: backoff.supabase, clickhouse: backoff.clickhouse, mode: "tick" });
    expect(result).toMatchObject({ status: "failed", tick_status: "backoff", rows_inserted: 0 });
    expect(names(backoff.rpcCalls)).toEqual(["observe_clickhouse_cohort_snapshot_fingerprint"]);

    // The user action always retries; so does a tick after the window, or for other versions.
    for (const [state, mode] of [
      [failedNow, "user"],
      [{ ...failedNow, finished_at: ago(61) }, "tick"],
      [{ ...failedNow, building_warehouse_version: "wh_other" }, "tick"],
      [{ ...failedNow, building_classification_version: "cohort_classifier_v2" }, "tick"],
    ] as const) {
      const h = rebuildHarness({ state });
      await rebuildCohortMembership({ authUserId: "user-1", supabase: h.supabase, clickhouse: h.clickhouse, mode });
      expect(names(h.rpcCalls), `${mode} ${JSON.stringify(state)}`).toContain("claim_clickhouse_cohort_snapshot_build");
    }
  });
});
