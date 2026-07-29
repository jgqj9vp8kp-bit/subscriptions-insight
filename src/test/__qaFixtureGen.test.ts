// TEMPORARY QA fixture generator (deleted after the QA session). Runs the REAL
// runMaterializedCohortList / runMaterializedCohortOptions / assembleFbUserCosts
// against routed fakes and dumps contract-true response fixtures for browser QA.
// Also asserts DST/timezone conversion and allocation invariants at runtime.
import { mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it, afterAll } from "vitest";
import {
  runMaterializedCohortList,
  runMaterializedCohortOptions,
} from "../../supabase/functions/_shared/clickhouse/cohortMembership.ts";
import {
  assembleFbUserCosts,
  fbCohortRowKey,
  type FbAuthoritativeUserRow,
  type FbCampaignMetricRow,
} from "../../supabase/functions/_shared/clickhouse/fbCohortStats.ts";
import type { ClickHouseClientLike, SupabaseLikeClient } from "../../supabase/functions/_shared/clickhouse/types.ts";
import type { CohortRequest } from "../../supabase/functions/_shared/clickhouse/cohortContract.ts";

const OUT = "/private/tmp/claude-502/-Users-user-1-Documents------------subscriptions-insight/c206df7d-6b53-497e-87eb-be2556bfd59a/scratchpad/fixtures";
mkdirSync(OUT, { recursive: true });

const LONG_ID = "120249115818080040123456789012345678901234567890123456789012";
const LONG_NAME = "🚀 Соулмейт | Broad | Advantage+ | 2026-07 | extremely long campaign name to test truncation behaviour in the diagnostics table 0123456789 0123456789 0123456789";

// ---- Env control (runtimeTimezoneConfig reads globalThis.Deno.env.get) ------
const globalAny = globalThis as Record<string, unknown>;
const originalDeno = globalAny.Deno;
function setEnv(env: Record<string, string>) {
  globalAny.Deno = { env: { get: (key: string) => env[key] } };
}
afterAll(() => { globalAny.Deno = originalDeno; });

// ---- Routed fakes (mirrors fbCohortCohortsUi.test.tsx) ----------------------
const SNAPSHOT_STATE = {
  status: "completed",
  active_warehouse_version: "wh_live",
  active_classification_version: "cohort_classifier_v1_dynamic_sql",
  active_generated_at: "2026-07-16T00:00:00Z",
  users_classified: 26,
  duplicate_users: 0,
  source_transactions: 100,
  source_unique_users: 26,
  diagnostics: { validation: { status: "PASS" } },
};
const FB_SYNC_STATE = {
  status: "completed",
  finished_at: "2026-07-16T09:00:00Z",
  cursor_transaction_id: "2026-07-16",
  cursor_updated_at: "2026-07-16T08:59:00Z",
  diagnostics: { mode: "full", fb_stats_to: "2026-07-15" },
};

function fakeSupabase(): SupabaseLikeClient {
  const tables: Record<string, unknown> = {
    clickhouse_cohort_snapshot_state: SNAPSHOT_STATE,
    clickhouse_transaction_sync_state: FB_SYNC_STATE,
  };
  return {
    from(table: string) {
      const builder = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => ({ data: tables[table] ?? null, error: null }),
        upsert: async (value: unknown) => ({ data: value, error: null }),
      };
      return builder as never;
    },
  };
}

interface WarehouseOptions {
  listRows?: Array<Record<string, unknown>>;
  fbUsers?: FbAuthoritativeUserRow[];
  fbMetrics?: FbCampaignMetricRow[];
  fbSourceStats?: Record<string, unknown>;
  fbJoinFails?: boolean;
  optionRows?: Array<Record<string, unknown>>;
}

function fakeWarehouse(options: WarehouseOptions): ClickHouseClientLike {
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  return {
    command: async () => undefined,
    insert: async () => undefined,
    query: async ({ query }) => ({
      json: async () => {
        if (query.includes("' dim, ")) return options.optionRows ?? [];
        if (query.includes("authoritative_users") && query.includes("utc_date_from")) {
          if (options.fbJoinFails) throw new Error("fb join unavailable");
          const grouped = new Map<string, { campaign_id: string; authoritative_users: number; utc_date_from: string; utc_date_to: string }>();
          for (const user of options.fbUsers ?? []) {
            const date = user.trial_timestamp_utc.slice(0, 10);
            const current = grouped.get(user.campaign_id) ?? { campaign_id: user.campaign_id, authoritative_users: 0, utc_date_from: date, utc_date_to: date };
            current.authoritative_users += 1;
            if (date < current.utc_date_from) current.utc_date_from = date;
            if (date > current.utc_date_to) current.utc_date_to = date;
            grouped.set(user.campaign_id, current);
          }
          return [...grouped.values()];
        }
        if (query.includes("authoritative_user_count")) {
          if (options.fbJoinFails) throw new Error("fb user aggregation unavailable");
          const selected = options.fbUsers ?? [];
          const grouped = new Map<string, Record<string, unknown>>();
          for (const user of selected) {
            const key = JSON.stringify([user.cohort_date, user.funnel, user.campaign_path, user.campaign_id]);
            const current = grouped.get(key) ?? {
              cohort_date: user.cohort_date,
              funnel: user.funnel,
              campaign_path: user.campaign_path,
              campaign_id: user.campaign_id,
              authoritative_user_count: 0,
            };
            current.authoritative_user_count = Number(current.authoritative_user_count) + 1;
            grouped.set(key, current);
          }
          return [...grouped.values()];
        }
        if (query.includes("GROUP BY campaign_id")) {
          if (options.fbJoinFails) throw new Error("fb metrics unavailable");
          return options.fbMetrics ?? [];
        }
        if (query.includes("raw_rows")) {
          if (options.fbJoinFails) throw new Error("fb stats unavailable");
          return [options.fbSourceStats ?? { raw_rows: 1065, campaign_day_rows: 1065, last_stat_date: yesterday }];
        }
        if (query.includes("snapshot_duplicate_users")) return [{ snapshot_rows: 26, snapshot_unique_users: 26, snapshot_duplicate_users: 0 }];
        if (query.includes("warehouse_hash")) {
          return [{ transaction_count: 100, unique_users: 26, max_row_version: "9", max_source_updated_at: "2026-07-16 00:00:00", warehouse_hash: "live" }];
        }
        if (query.includes("system.tables")) return [{ c: 1 }];
        if (query.includes("INNER JOIN fact_user_cohorts")) return options.listRows ?? [];
        if (query.includes("AS support_requests")) return [{ support_requests: 3, support_unique_emails: 3 }];
        if (query.includes("fact_subscriptions")) return [{ c: 0 }];
        if (query.includes("transactions_with_currency")) {
          return [{ transactions_total: 100, transactions_with_currency: 100, transactions_without_currency: 0, transactions_native_usd: 90, transactions_converted: 10, transactions_missing_fx_rate: 0, transactions_invalid_amount: 0, excluded_amount_original: 0, excluded_transactions: 0 }];
        }
        if (query.includes("count() AS c")) return [{ c: 0 }];
        return [];
      },
    }),
  };
}

// ---- Scenario data ----------------------------------------------------------
const ROW_A = { cohort_date: "2026-07-14", funnel: "soulmate", campaign_path: "soulmate-sketch" };
const ROW_B = { cohort_date: "2026-07-14", funnel: "starseed", campaign_path: "starseed-path" };
const ROW_C = { cohort_date: "2026-07-15", funnel: "soulmate", campaign_path: "soulmate-alt" };

const LIST_ROWS = [
  { ...ROW_A, trial_users: 24, gross_raw: 1200, refund_raw: 50, r2: 5, r3: 4, first_subscription_users: 12, support_users: 2 },
  { ...ROW_B, trial_users: 1, gross_raw: 90, refund_raw: 0, r2: 0, r3: 0, first_subscription_users: 1, support_users: 0 },
  { ...ROW_C, trial_users: 1, gross_raw: 40, refund_raw: 0, r2: 0, r3: 0, first_subscription_users: 0, support_users: 0 },
];

let seq = 0;
function user(campaignId: string, trialUtc: string, row: { cohort_date: string; funnel: string; campaign_path: string } = ROW_A): FbAuthoritativeUserRow {
  seq += 1;
  return {
    canonical_user_id: `qa-user-${String(seq).padStart(3, "0")}`,
    cohort_date: row.cohort_date,
    trial_timestamp_utc: trialUtc,
    funnel: row.funnel,
    campaign_path: row.campaign_path,
    campaign_id: campaignId,
  };
}

function metric(over: Partial<FbCampaignMetricRow> & { fb_reporting_date: string; campaign_id: string }): FbCampaignMetricRow {
  return {
    ad_account_id: "act-1", currency: "USD", reporting_timezones: "UTC",
    spend: 0, purchases: 0, impressions: 100, reach: 0, clicks: 10, link_clicks: 2, purchase_value: 0,
    campaign_name: `Campaign ${over.campaign_id}`,
    ...over,
  };
}

const NOON = "2026-07-14T12:00:00.000Z";
const FB_USERS: FbAuthoritativeUserRow[] = [
  // C1: fully allocated, fractional CPP (100/3)
  user(LONG_ID, NOON), user(LONG_ID, NOON), user(LONG_ID, NOON),
  // C2: underallocated (1 of 4 purchases)
  user("C2UNDER", NOON),
  // C3: overallocated (3 users, 2 purchases)
  user("C3OVER", NOON), user("C3OVER", NOON), user("C3OVER", NOON),
  // C4: no_fb_purchases
  user("C4ZEROP", NOON),
  // C6: reporting date differs, but Campaign-period matching still succeeds
  user("C6UNMATCH", NOON), user("C6UNMATCH", NOON),
  // C7: campaign_unmatched (no FB metrics)
  user("C7NOTZ", NOON),
  // C8: invalid timezone remains informational and does not block allocation
  user("C8BADTZ", NOON),
  // C9: invalid_metrics (two ad accounts same campaign/date)
  user("C9TWOACC", NOON),
  // C10: shared campaign across two funnels
  user("C10SHARED", NOON, ROW_A), user("C10SHARED", NOON, ROW_B),
  // C11: shared campaign across two campaign paths (same fb date)
  user("C11PATHS", NOON, ROW_A), user("C11PATHS", "2026-07-14T20:00:00.000Z", ROW_C),
  // C12: zero spend
  user("C12FREE", NOON), user("C12FREE", NOON),
  // C13: account_config timezone (LA) + prev-day shift 02:00Z -> 07-14
  user("C13ACC", "2026-07-15T02:00:00.000Z"),
  // C14: DST + midnight boundaries in America/Los_Angeles (payload)
  user("C14DST", "2026-03-08T09:30:00.000Z"), // 01:30 PST -> 2026-03-08
  user("C14DST", "2026-03-08T10:30:00.000Z"), // 03:30 PDT -> 2026-03-08 (spring forward)
  user("C14DST", "2026-11-01T08:30:00.000Z"), // 01:30 PDT -> 2026-11-01 (fall back, first pass)
  user("C14DST", "2026-11-01T09:30:00.000Z"), // 01:30 PST -> 2026-11-01 (second pass)
  user("C14DST", "2026-07-15T06:59:00.000Z"), // 23:59 PDT -> 2026-07-14 (prev day)
  user("C14DST", "2026-07-15T07:00:00.000Z"), // 00:00 PDT -> 2026-07-15 (same day)
];

const FB_METRICS: FbCampaignMetricRow[] = [
  metric({ fb_reporting_date: "2026-07-14", campaign_id: LONG_ID, campaign_name: LONG_NAME, spend: 100, purchases: 3 }),
  metric({ fb_reporting_date: "2026-07-14", campaign_id: "C2UNDER", ad_account_id: "act-2", spend: 200, purchases: 4 }),
  metric({ fb_reporting_date: "2026-07-14", campaign_id: "C3OVER", spend: 50, purchases: 2 }),
  metric({ fb_reporting_date: "2026-07-14", campaign_id: "C4ZEROP", spend: 75, purchases: 0 }),
  metric({ fb_reporting_date: "2026-07-14", campaign_id: "C5NOUSERS", spend: 60, purchases: 2 }),
  metric({ fb_reporting_date: "2026-07-13", campaign_id: "C6UNMATCH", spend: 10, purchases: 1 }),
  metric({ fb_reporting_date: "2026-07-14", campaign_id: "C8BADTZ", reporting_timezones: "Mars/Olympus", spend: 15, purchases: 1 }),
  metric({ fb_reporting_date: "2026-07-14", campaign_id: "C9TWOACC", ad_account_id: "act-8", spend: 30, purchases: 1 }),
  metric({ fb_reporting_date: "2026-07-14", campaign_id: "C9TWOACC", ad_account_id: "act-9", spend: 30, purchases: 1, clicks: 11 }),
  metric({ fb_reporting_date: "2026-07-14", campaign_id: "C10SHARED", spend: 80, purchases: 2 }),
  metric({ fb_reporting_date: "2026-07-14", campaign_id: "C11PATHS", spend: 40, purchases: 2 }),
  metric({ fb_reporting_date: "2026-07-14", campaign_id: "C12FREE", spend: 0, purchases: 2 }),
  metric({ fb_reporting_date: "2026-07-14", campaign_id: "C13ACC", ad_account_id: "act-cfg", reporting_timezones: "", spend: 25, purchases: 1 }),
  metric({ fb_reporting_date: "2026-03-08", campaign_id: "C14DST", reporting_timezones: "America/Los_Angeles", spend: 20, purchases: 2 }),
  metric({ fb_reporting_date: "2026-11-01", campaign_id: "C14DST", reporting_timezones: "America/Los_Angeles", spend: 20, purchases: 2 }),
  metric({ fb_reporting_date: "2026-07-14", campaign_id: "C14DST", reporting_timezones: "America/Los_Angeles", spend: 10, purchases: 1 }),
  metric({ fb_reporting_date: "2026-07-15", campaign_id: "C14DST", reporting_timezones: "America/Los_Angeles", spend: 10, purchases: 1 }),
  // 120 metric-only campaign/dates for pagination (all no_matched_users)
  ...Array.from({ length: 120 }, (_, index) => metric({
    fb_reporting_date: `2026-06-${String(1 + (index % 30)).padStart(2, "0")}`,
    campaign_id: `P${String(index).padStart(3, "0")}`,
    ad_account_id: "act-page",
    spend: 5, purchases: 1,
  })),
];

const RICH_ENV = { FB_META_ACCOUNT_TIMEZONES_JSON: '{"act-cfg":"America/Los_Angeles"}' };

const OPTION_ROWS = [
  { dim: "media_buyer", value: "Unknown", cnt: 4914 },
  { dim: "media_buyer", value: "Ivan", cnt: 1355 },
  { dim: "media_buyer", value: "Artem D", cnt: 1332 },
  { dim: "media_buyer", value: "Artem A", cnt: 174 },
  { dim: "utm_source", value: "int1", cnt: 842 },
  { dim: "utm_source", value: "int2", cnt: 317 },
  { dim: "funnel", value: "soulmate", cnt: 24 },
  { dim: "funnel", value: "starseed", cnt: 1 },
  { dim: "campaign_path", value: "soulmate-sketch", cnt: 24 },
  { dim: "campaign_path", value: "starseed-path", cnt: 1 },
  { dim: "campaign_path", value: "soulmate-alt", cnt: 1 },
  { dim: "campaign_id", value: LONG_ID, cnt: 3 },
  { dim: "country", value: "US", cnt: 20 },
  { dim: "country", value: "MX", cnt: 6 },
  { dim: "currency", value: "USD", cnt: 26 },
];

const RICH: WarehouseOptions = { listRows: LIST_ROWS, fbUsers: FB_USERS, fbMetrics: FB_METRICS, optionRows: OPTION_ROWS };

async function runList(options: WarehouseOptions, enabled: boolean, request: CohortRequest = { action: "list", fb_allocation_diagnostics: { page: 1 } }) {
  const response = await runMaterializedCohortList({
    authUserId: "qa-auth-user",
    supabase: fakeSupabase(),
    clickhouse: fakeWarehouse(options),
    request,
    allocationDiagnosticsEnabled: enabled,
  });
  if (!response) throw new Error("materialized path unavailable");
  return response;
}

function save(name: string, value: unknown) {
  writeFileSync(`${OUT}/${name}.json`, JSON.stringify(value, null, 1));
}

describe("QA fixture generation via the real server path", () => {
  it("rich scenario: campaign-period statuses, shared campaigns, DST evidence, >100 rows", async () => {
    setEnv(RICH_ENV);
    const response = await runList(RICH, true);
    save("rich.response", response);

    // Full validation rows (pre-pagination) for the dynamic browser harness.
    const visibleKeys = new Set(LIST_ROWS.map((row) => fbCohortRowKey(String(row.cohort_date), String(row.funnel), String(row.campaign_path))));
    const assembly = assembleFbUserCosts(FB_USERS, FB_METRICS, visibleKeys, { defaultTimezone: null, accountTimezones: { "act-cfg": "America/Los_Angeles" } });
    save("rich.validation", assembly.validation);

    // --- QA invariants asserted at runtime -----------------------------------
    const byKey = new Map(assembly.validation.map((row) => [row.campaign_id, row]));
    // Reporting dates aggregate into one Campaign metric; timezone is evidence only.
    expect(byKey.get("C14DST")?.matched_authoritative_users).toBe(6);
    expect(byKey.get("C14DST")?.fb_purchases).toBe(6);
    expect(byKey.get("C14DST")?.allocated_spend).toBe(60);
    const c13 = byKey.get("C13ACC");
    expect(c13?.timezone_source).toBe("account_config");
    expect(c13?.allocation_status).toBe("fully_allocated");
    // Shared campaign across funnels: allocated once, both funnels affected.
    const c10 = byKey.get("C10SHARED");
    expect(c10?.allocated_spend).toBe(80);
    expect(c10?.affected_funnels).toEqual(["soulmate", "starseed"]);
    const c11 = byKey.get("C11PATHS");
    expect(c11?.affected_campaign_paths).toEqual(["soulmate-alt", "soulmate-sketch"]);
    // Fractional CPP retains sub-cent precision and reconciles.
    expect(byKey.get(LONG_ID)?.campaign_cpp).toBeCloseTo(33.333333, 5);
    expect(byKey.get(LONG_ID)?.allocated_spend).toBe(100);
    expect(byKey.get("C3OVER")?.allocated_spend).toBe(75);
    // Zero-purchase and invalid metrics allocate nothing.
    for (const key of ["C4ZEROP", "C9TWOACC", "C7NOTZ"]) {
      const row = byKey.get(key);
      if (row) expect(row.allocated_spend).toBe(0);
    }
    // Date/timezone statuses no longer participate in allocation.
    const statuses = new Set(assembly.validation.map((row) => row.allocation_status));
    for (const status of ["fully_allocated", "underallocated", "overallocated", "no_fb_purchases", "no_matched_users", "campaign_unmatched", "invalid_metrics"]) {
      expect(statuses.has(status as never), `status ${status} present`).toBe(true);
    }
    // Response-level diagnostics contract.
    const diag = response.fb_allocation_diagnostics;
    expect(diag?.total_rows).toBeGreaterThan(100);
    expect(diag?.rows).toHaveLength(100);
    expect(diag?.summary.reconciliation_ok).toBe(false);
    expect(diag?.summary.visible_spend_reconciles).toBe(true);
    expect(diag?.display_message).toContain("Показаны первые 100 из");
  });

  it("flag OFF scenario", async () => {
    setEnv(RICH_ENV);
    const response = await runList(RICH, false);
    expect(response.fb_allocation_diagnostics).toBeUndefined();
    expect(response.fb_diagnostics?.fb_allocation_diagnostics_enabled).toBe(false);
    save("rich_flag_off.response", response);
  });

  it("default_config timezone scenario", async () => {
    setEnv({ FB_META_DEFAULT_TIMEZONE: "America/New_York" });
    const users = [user("D1DEF", "2026-07-15T03:30:00.000Z")]; // 23:30 NY 07-14
    const metrics = [metric({ fb_reporting_date: "2026-07-14", campaign_id: "D1DEF", ad_account_id: "act-unmapped", reporting_timezones: "", spend: 12, purchases: 1 })];
    const response = await runList({ listRows: LIST_ROWS, fbUsers: users, fbMetrics: metrics }, true);
    const row = response.fb_allocation_diagnostics?.rows.find((r) => r.campaign_id === "D1DEF");
    expect(row?.timezone_source).toBe("default_config");
    expect(row?.fb_reporting_date).toBeNull();
    expect(row?.period_date_from).toBe("2026-07-14");
    expect(row?.allocation_status).toBe("fully_allocated");
    save("tz_default.response", response);
  });

  it("empty FB export scenario", async () => {
    setEnv({});
    const response = await runList({ listRows: LIST_ROWS, fbUsers: [], fbMetrics: [], fbSourceStats: { raw_rows: 0, campaign_day_rows: 0, last_stat_date: null } }, true);
    save("fb_empty.response", response);
    save("fb_empty.validation", []);
    expect(response.fb_allocation_diagnostics?.total_rows).toBe(0);
  });

  it("empty cohorts scenario", async () => {
    setEnv({});
    const response = await runList({ listRows: [], fbUsers: [], fbMetrics: [] }, true);
    save("cohorts_empty.response", response);
    expect(response.rows).toHaveLength(0);
  });

  it("fb join failure scenario (fb columns degrade, cohorts survive)", async () => {
    setEnv(RICH_ENV);
    const response = await runList({ listRows: LIST_ROWS, fbJoinFails: true }, true);
    expect(response.rows.length).toBeGreaterThan(0);
    save("fb_join_fails.response", response);
  });

  it("options scenario", async () => {
    setEnv({});
    const response = await runMaterializedCohortOptions({
      authUserId: "qa-auth-user",
      supabase: fakeSupabase(),
      clickhouse: fakeWarehouse({ optionRows: OPTION_ROWS }),
      request: { action: "options" } as CohortRequest,
    });
    expect(response).not.toBeNull();
    save("options.response", response);
  });

  it("fb status scenario", async () => {
    save("fbstatus.response", {
      ok: true,
      state: FB_SYNC_STATE,
      diagnostics: {
        fb_source_rows: 1065, fb_campaign_day_rows: 1065,
        fb_last_sync_at: FB_SYNC_STATE.finished_at,
        fb_data_status: "ready",
      },
    });
  });
});
