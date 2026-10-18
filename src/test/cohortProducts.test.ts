import { describe, expect, it } from "vitest";
import {
  buildCohortProductPathsQuery,
  productLabelFromHost,
  productsFromRows,
  runCohortProducts,
} from "../../supabase/functions/_shared/clickhouse/cohortProducts.ts";
import { ALL_SCOPE_SQL } from "../../supabase/functions/_shared/clickhouse/scopeSql.ts";
import {
  CLICKHOUSE_COHORTS_POLICY,
  normalizeClickHouseCohortsAction,
} from "../../supabase/functions/_shared/access/policies/clickhouse-cohorts.ts";
import {
  NO_PRODUCT_PATH,
  UNKNOWN_PRODUCT_KEY,
  effectiveCampaignPaths,
  productKey,
  productPathSet,
  productSummary,
} from "@/services/cohortProductFilter";
import type { ClickHouseClientLike } from "../../supabase/functions/_shared/clickhouse/types.ts";

const AZORA = "01KJQKSJ0H4EBZQ9SGVAQ1BNSB";
const BRAINZA = "01KKEGM9PVW291BKJKYNC7QPSV";
const FOXIQ = "01M36MDN39CQYEKTPZ92PN2R33";

const ROWS = [
  { path: "palm-reading-month-web", project_id: AZORA, host: "f.azora-astro.com", trial_users: 900, tx_rows: 2000 },
  { path: "soulmate-month-web-es", project_id: AZORA, host: "f.azora-astro.com", trial_users: 60, tx_rows: 120 },
  // A metadata-less success on a real path (MIT renewal): must not create an Unknown entry for it.
  { path: "soulmate-month-web-es", project_id: "", host: "", trial_users: 0, tx_rows: 40 },
  { path: "brainza-test-iq", project_id: BRAINZA, host: "quiz.brainza.app", trial_users: 109, tx_rows: 150 },
  { path: "brainza-test-iq", project_id: BRAINZA, host: "bell-them-complex.fnlfx.com", trial_users: 0, tx_rows: 300 },
  { path: "test-iq", project_id: FOXIQ, host: "f.foxiq.app", trial_users: 53, tx_rows: "60" },
  { path: "unknown", project_id: "", host: "", trial_users: 8227, tx_rows: 9000 },
];

describe("cohort products (server)", () => {
  it("groups paths by FunnelFox project, labels them by landing domain, Unknown last", () => {
    const products = productsFromRows(ROWS);
    expect(products.map((p) => [p.label, p.trial_count, p.campaign_paths])).toEqual([
      ["azora-astro.com", 960, ["palm-reading-month-web", "soulmate-month-web-es"]],
      ["brainza.app", 109, ["brainza-test-iq"]],
      ["foxiq.app", 53, ["test-iq"]],
      ["Unknown", 8227, ["unknown"]],
    ]);
    // The custom domain wins over the busier default FunnelFox domain.
    expect(products[1]).toMatchObject({ project_id: BRAINZA, host: "quiz.brainza.app" });
    expect(products[3]).toMatchObject({ project_id: "", host: "" });
  });

  it("lists a path seen under two projects under both", () => {
    const products = productsFromRows([
      { path: "shared", project_id: AZORA, host: "f.azora-astro.com", trial_users: 2, tx_rows: 2 },
      { path: "shared", project_id: FOXIQ, host: "f.foxiq.app", trial_users: 1, tx_rows: 1 },
    ]);
    expect(products.map((p) => p.campaign_paths)).toEqual([["shared"], ["shared"]]);
  });

  it("derives labels from hosts", () => {
    expect(productLabelFromHost("f.azora-astro.com")).toBe("azora-astro.com");
    expect(productLabelFromHost("quiz.brainza.app")).toBe("brainza.app");
    expect(productLabelFromHost("brainza.app")).toBe("brainza.app");
    expect(productLabelFromHost("bell-them-complex.fnlfx.com")).toBe("bell-them-complex.fnlfx.com");
    expect(productLabelFromHost("")).toBe("");
    expect(productsFromRows([{ path: "x", project_id: "01ABCDEF123456", host: "", trial_users: 1, tx_rows: 1 }])[0].label)
      .toBe("Project 123456");
  });

  it("queries successful transactions of the tenant and refuses a restricted scope", () => {
    const sql = buildCohortProductPathsQuery(ALL_SCOPE_SQL);
    expect(sql).toContain("FROM analytics_transactions FINAL");
    expect(sql).toContain("auth_user_id = {auth_user_id:String} AND is_success = 1");
    expect(sql).toContain("JSONExtractString(normalized_payload, 'metadata', 'ff_project_id')");
    const restricted = Object.freeze({ ...ALL_SCOPE_SQL, restricted: true }) as typeof ALL_SCOPE_SQL;
    expect(() => buildCohortProductPathsQuery(restricted)).toThrow(/full scope only/);
  });

  it("runs one query bound to the tenant", async () => {
    const calls: Array<{ query: string; query_params?: Record<string, unknown> }> = [];
    const client = {
      query: async (input: { query: string; query_params?: Record<string, unknown> }) => {
        calls.push(input);
        return { json: async () => ROWS };
      },
    } as unknown as ClickHouseClientLike;
    const response = await runCohortProducts({ authUserId: "tenant-1", clickhouse: client, scope: ALL_SCOPE_SQL });
    expect(calls).toHaveLength(1);
    expect(calls[0].query_params).toEqual({ auth_user_id: "tenant-1" });
    expect(response.ok).toBe(true);
    expect(response.products).toHaveLength(4);
  });
});

describe("cohort products (access policy)", () => {
  it("is its own action, open to Cohorts viewers and never scopeReady", () => {
    expect(normalizeClickHouseCohortsAction({ body: { action: "product_paths" } } as never)).toBe("product_paths");
    expect(CLICKHOUSE_COHORTS_POLICY.actions.product_paths).toEqual({ anyOf: ["cohorts.view"] });
  });
});

describe("cohort product filter (browser)", () => {
  const products = productsFromRows(ROWS);

  it("resolves selected products to their campaign paths", () => {
    expect(productKey(products[3])).toBe(UNKNOWN_PRODUCT_KEY);
    expect(productPathSet(products, [])).toBeNull();
    expect(productPathSet(null, [FOXIQ])).toBeNull();
    expect([...productPathSet(products, [FOXIQ, BRAINZA])!].sort()).toEqual(["brainza-test-iq", "test-iq"]);
    expect([...productPathSet(products, [UNKNOWN_PRODUCT_KEY])!]).toEqual(["unknown"]);
  });

  it("narrows picked paths to the products and never widens to every path", () => {
    const foxiq = productPathSet(products, [FOXIQ]);
    expect(effectiveCampaignPaths(["a", "b"], null)).toEqual(["a", "b"]);
    expect(effectiveCampaignPaths([], foxiq)).toEqual(["test-iq"]);
    expect(effectiveCampaignPaths(["test-iq", "brainza-test-iq"], foxiq)).toEqual(["test-iq"]);
    expect(effectiveCampaignPaths(["brainza-test-iq"], foxiq)).toEqual([NO_PRODUCT_PATH]);
    expect(effectiveCampaignPaths([], new Set())).toEqual([NO_PRODUCT_PATH]);
    // Survives the server's stringArray normalization (trim + non-empty).
    expect(NO_PRODUCT_PATH.trim()).toBe(NO_PRODUCT_PATH);
  });

  it("summarizes the selection", () => {
    expect(productSummary(products, [])).toBe("All products");
    expect(productSummary(products, [FOXIQ])).toBe("foxiq.app");
    expect(productSummary(products, [FOXIQ, AZORA])).toBe("2 products");
    expect(productSummary(null, [FOXIQ])).toBe(FOXIQ);
  });
});
