import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FB_WAREHOUSE_V2_DDL,
  ensureFbWarehouseV2Schema,
  FACT_FB_ACCOUNT_DAILY_TABLE,
  FACT_FB_AD_DAILY_TABLE,
  FACT_FB_ADSET_DAILY_TABLE,
  FACT_FB_CAMPAIGN_DAILY_TABLE,
  FB_BATCH_REGISTRY_TABLE,
  RAW_FACEBOOK_API_RESPONSES_TABLE,
  V_CHANNEL_CAMPAIGN_DAILY,
  V_FB_CAMPAIGN_DAILY_CURRENT,
} from "../../supabase/functions/_shared/clickhouse/fbWarehouseV2Schema.ts";
import type { ClickHouseClientLike } from "../../supabase/functions/_shared/clickhouse/types.ts";

const MIGRATION = readFileSync(
  resolve(__dirname, "../../supabase/migrations/202607230001_create_facebook_warehouse_v2_mappings.sql"),
  "utf-8",
);

describe("Warehouse V2 Phase 0 — ClickHouse DDL", () => {
  const ddl = FB_WAREHOUSE_V2_DDL.join("\n");

  it("creates channel-specific per-grain daily facts, never a generic mega-table", () => {
    for (const table of [FACT_FB_ACCOUNT_DAILY_TABLE, FACT_FB_CAMPAIGN_DAILY_TABLE, FACT_FB_ADSET_DAILY_TABLE, FACT_FB_AD_DAILY_TABLE]) {
      expect(ddl).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    // The mixed-grain `level` column is the V1 foot-gun V2 exists to remove — no
    // fact table may carry it (the raw layer legitimately records the request level).
    const factDdls = FB_WAREHOUSE_V2_DDL.filter((query) => query.includes("fact_facebook_") && query.includes("CREATE TABLE"));
    for (const query of factDdls) {
      expect(query).not.toMatch(/\blevel\b/);
    }
  });

  it("facts are append-only MergeTree with lineage, tenant scope and NO stored ratios", () => {
    const factDdls = FB_WAREHOUSE_V2_DDL.filter((query) => query.includes("fact_facebook_") && query.includes("CREATE TABLE"));
    expect(factDdls).toHaveLength(4);
    for (const query of factDdls) {
      expect(query).toContain("ENGINE = MergeTree");
      expect(query).not.toContain("ReplacingMergeTree");
      expect(query).toContain("import_batch_id UUID");
      expect(query).toContain("row_hash UInt64");
      expect(query).toMatch(/ORDER BY \(auth_user_id, /);
      for (const ratio of ["cpp", "cpc", "cpm", "ctr", "roas"]) {
        expect(query).not.toMatch(new RegExp(`\\b${ratio}\\b`));
      }
    }
  });

  it("raw layer keeps verbatim bodies with no TTL", () => {
    const raw = FB_WAREHOUSE_V2_DDL.find((query) => query.includes(RAW_FACEBOOK_API_RESPONSES_TABLE))!;
    expect(raw).toContain("response_body String CODEC(ZSTD(6))");
    expect(raw).not.toContain("TTL");
  });

  it("_current views read only published batches and resolve versions by latest ingest", () => {
    const view = FB_WAREHOUSE_V2_DDL.find((query) => query.includes(`CREATE VIEW IF NOT EXISTS ${V_FB_CAMPAIGN_DAILY_CURRENT}`))!;
    expect(view).toContain(`FROM ${FB_BATCH_REGISTRY_TABLE} FINAL WHERE status = 'published'`);
    expect(view).toContain("argMax(spend, ingested_at) AS spend");
    expect(view).toContain("GROUP BY auth_user_id, ad_account_id, campaign_id, stat_date");
  });

  it("cross-channel contract view exposes the channel dimension over the FB current view", () => {
    const contract = FB_WAREHOUSE_V2_DDL.find((query) => query.includes(V_CHANNEL_CAMPAIGN_DAILY))!;
    expect(contract).toContain("'facebook' AS traffic_channel");
    expect(contract).toContain(`FROM ${V_FB_CAMPAIGN_DAILY_CURRENT}`);
    expect(contract).toContain("fb_purchases AS channel_purchases");
  });

  it("ensureFbWarehouseV2Schema executes every DDL statement in order", async () => {
    const executed: string[] = [];
    const client = {
      command: ({ query }: { query: string }) => {
        executed.push(query);
        return Promise.resolve();
      },
      query: () => Promise.reject(new Error("not used")),
    } as unknown as ClickHouseClientLike;
    await ensureFbWarehouseV2Schema(client);
    expect(executed).toEqual([...FB_WAREHOUSE_V2_DDL]);
  });
});

describe("Warehouse V2 Phase 0 — Postgres mappings migration", () => {
  it("creates the two mapping layers, buyer map, known gaps and request telemetry", () => {
    for (const table of [
      "facebook_campaign_mapping",
      "facebook_campaign_funnel_map",
      "facebook_buyer_mapping",
      "facebook_known_gaps",
      "facebook_sync_run_requests",
    ]) {
      expect(MIGRATION).toContain(`create table if not exists public.${table}`);
      expect(MIGRATION).toContain(`alter table public.${table} enable row level security`);
    }
  });

  it("enforces the rev.2 funnel-mapping rules", () => {
    // name_rule can only ever suggest, never confirm.
    expect(MIGRATION).toContain("evidence_source <> 'name_rule' or match_kind = 'suggested'");
    // one ACTIVE CONFIRMED funnel per campaign.
    expect(MIGRATION).toMatch(/facebook_campaign_funnel_map_active_confirmed_idx[\s\S]*where status = 'active' and match_kind = 'confirmed'/);
    // full evidence ladder is encoded.
    for (const source of ["destination_url", "campaign_path", "copy_relation", "manual", "name_rule"]) {
      expect(MIGRATION).toContain(`'${source}'`);
    }
  });

  it("mapping tables are retire-only with frozen identity; gaps and telemetry are append-only", () => {
    expect(MIGRATION).toContain("create or replace function public.facebook_mapping_guard()");
    expect(MIGRATION).toMatch(/retire-only: set status=retired instead of DELETE/);
    for (const trigger of ["facebook_campaign_mapping_guard", "facebook_campaign_funnel_map_guard", "facebook_buyer_mapping_guard"]) {
      expect(MIGRATION).toMatch(new RegExp(`create trigger ${trigger}\\s+before update or delete`));
    }
    for (const trigger of ["facebook_known_gaps_append_only", "facebook_sync_run_requests_append_only"]) {
      expect(MIGRATION).toMatch(new RegExp(`create trigger ${trigger}\\s+before update or delete`));
    }
    expect(MIGRATION).toContain("execute function public.facebook_history_block_mutation()");
  });

  it("scopes every policy to the owner and gives telemetry no client write path", () => {
    // 3 mapping tables x (select+insert+update) + known_gaps (select+insert) + telemetry (select).
    const policyCount = (MIGRATION.match(/create policy/g) ?? []).length;
    expect(policyCount).toBe(12);
    const checks = (MIGRATION.match(/auth\.uid\(\) = auth_user_id/g) ?? []).length;
    expect(checks).toBeGreaterThanOrEqual(policyCount);
    // sync_run_requests: select-only policy — the service-role recorder is the only writer.
    expect(MIGRATION).not.toMatch(/facebook_sync_run_requests_insert/);
  });
});
