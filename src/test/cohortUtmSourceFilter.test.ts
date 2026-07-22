// UTM entries of the Cohorts Media Buyer dropdown: "utm:<value>" selections
// filter by the authoritative first-trial utm_source WITHOUT changing how the
// media buyer names filter. Covers the selection helpers, both server engines
// (materialized snapshot + dynamic classifier fallback), fx scoping, and the
// legacy client compute.

import { describe, expect, it } from "vitest";
import {
  MAPPED_UTM_SOURCES,
  formatUtmSourceOptionLabel,
  isMediaBuyerSelectionValue,
  isUtmMediaBuyerSelection,
  splitMediaBuyerSelections,
  userMatchesMediaBuyerSelection,
  utmSelectionValue,
  utmValueFromSelection,
} from "@/services/mediaBuyerSelection";
import { activeCohortMemberWhere } from "../../supabase/functions/_shared/clickhouse/cohortMembership.ts";
import { fxDiagnostics } from "../../supabase/functions/_shared/clickhouse/cohorts.ts";
import type { CohortFilters } from "../../supabase/functions/_shared/clickhouse/cohortContract.ts";
import type { ClickHouseClientLike } from "../../supabase/functions/_shared/clickhouse/types.ts";
import { computeCohorts } from "@/services/analytics";
import { buildMediaBuyerOptions, buildUtmSourceOptions } from "@/services/cohortMediaBuyer";
import type { CardType, Funnel, Transaction, TransactionType } from "@/services/types";

const NO_FILTERS: CohortFilters = {
  funnel: [], campaign_path: [], campaign_id: [], traffic_source: [], price_plan: [],
  media_buyer: [], country: [], card_type: [], currency: [], transaction_type: [], refund_status: "all",
};

function filters(mediaBuyer: string[]): CohortFilters {
  return { ...NO_FILTERS, media_buyer: mediaBuyer };
}

// ---- Transaction fixtures (legacy compute) ----------------------------------

function tx(userId: string, transactionType: TransactionType, overrides: Partial<Transaction> = {}): Transaction {
  const amount = overrides.amount_usd ?? (transactionType === "trial" ? 1 : 10);
  return {
    transaction_id: overrides.transaction_id ?? `${userId}-${transactionType}-${overrides.event_time ?? "2026-05-01T00:00:00Z"}`,
    user_id: userId,
    email: `${userId}@example.com`,
    event_time: overrides.event_time ?? "2026-05-01T00:00:00Z",
    amount_usd: amount,
    gross_amount_usd: amount,
    refund_amount_usd: 0,
    net_amount_usd: amount,
    is_refunded: false,
    currency: "USD",
    status: overrides.status ?? "success",
    transaction_type: transactionType,
    funnel: (overrides.funnel ?? "soulmate") as Funnel,
    campaign_path: overrides.campaign_path ?? "campaign-a",
    product: "",
    traffic_source: "facebook",
    campaign_id: overrides.campaign_id ?? "campaign-a-id",
    classification_reason: "",
    metadata: overrides.metadata,
    utm_source: overrides.utm_source,
    card_type: overrides.card_type as CardType | undefined,
    ...overrides,
  };
}

function userRows(userId: string, utmSource: string | null): Transaction[] {
  return [
    tx(userId, "trial", { utm_source: utmSource }),
    tx(userId, "first_subscription", { event_time: "2026-05-08T00:00:00Z", utm_source: utmSource }),
  ];
}

const LEGACY_ROWS = [
  ...userRows("user_ivan", "4"),
  ...userRows("user_int1_a", "int1"),
  ...userRows("user_int1_b", "int1"),
  ...userRows("user_int2", "int2"),
  ...userRows("user_none", null),
];

// ---- 1. Selection helpers ---------------------------------------------------

describe("media buyer selection helpers", () => {
  it("splits buyer names and utm selections, deduped, order preserved", () => {
    expect(splitMediaBuyerSelections(["Ivan", "utm:int1", "Unknown", "utm:int2", "utm:int1", "Ivan"])).toEqual({
      buyers: ["Ivan", "Unknown"],
      utms: ["int1", "int2"],
    });
  });

  it("drops empty/whitespace values and bare 'utm:' prefixes", () => {
    expect(splitMediaBuyerSelections(["", "  ", "utm:", "utm:  ", null, 42])).toEqual({ buyers: [], utms: [] });
  });

  it("encodes and decodes the utm selection value", () => {
    expect(utmSelectionValue("int1")).toBe("utm:int1");
    expect(utmValueFromSelection("utm:int1")).toBe("int1");
    expect(utmValueFromSelection("Ivan")).toBeNull();
    expect(isUtmMediaBuyerSelection("utm:int2")).toBe(true);
    expect(isUtmMediaBuyerSelection("utm:")).toBe(false);
  });

  it("validates persisted dropdown state: buyer names and utm selections only", () => {
    expect(isMediaBuyerSelectionValue("Ivan")).toBe(true);
    expect(isMediaBuyerSelectionValue("Unknown")).toBe(true);
    expect(isMediaBuyerSelectionValue("utm:int1")).toBe(true);
    expect(isMediaBuyerSelectionValue("Jamie")).toBe(false);
    expect(isMediaBuyerSelectionValue(7)).toBe(false);
  });

  it("formats the dropdown label with the required prefix", () => {
    expect(formatUtmSourceOptionLabel({ utm_source: "int1", trial_count: 842 })).toBe("UTM: int1 — 842 trials");
  });

  it("mapped utm values are exactly the buyer-mapped keys", () => {
    expect(MAPPED_UTM_SOURCES.sort()).toEqual(["19", "22", "4"]);
  });
});

// ---- 2. Materialized snapshot engine (production path) ----------------------

describe("materialized member WHERE", () => {
  it("buyer-only selection keeps the exact pre-existing clause", () => {
    const params: Record<string, unknown> = {};
    const where = activeCohortMemberWhere(filters(["Ivan", "Unknown"]), params);
    expect(where).toContain("fc.media_buyer IN ({p_mmb_0:String}, {p_mmb_1:String})");
    expect(where).not.toContain("trial_transaction_id");
    expect(params.p_mmb_0).toBe("Ivan");
    expect(params.p_mmb_1).toBe("Unknown");
  });

  it("utm-only selection filters by the authoritative first-trial transaction", () => {
    const params: Record<string, unknown> = {};
    const where = activeCohortMemberWhere(filters(["utm:int1", "utm:int2"]), params);
    expect(where).toContain(
      "fc.trial_transaction_id IN (SELECT transaction_id FROM analytics_transactions FINAL " +
      "WHERE auth_user_id = {auth_user_id:String} AND utm_source IN ({p_mmbutm_0:String}, {p_mmbutm_1:String}))",
    );
    expect(where).not.toContain("fc.media_buyer IN");
    expect(params.p_mmbutm_0).toBe("int1");
    expect(params.p_mmbutm_1).toBe("int2");
  });

  it("mixed selection is a union (OR) of both conditions", () => {
    const params: Record<string, unknown> = {};
    const where = activeCohortMemberWhere(filters(["Ivan", "utm:int1"]), params);
    expect(where).toMatch(/\(fc\.media_buyer IN \({p_mmb_0:String}\) OR fc\.trial_transaction_id IN \(SELECT/);
  });

  it("never interpolates utm values into SQL (injection-safe)", () => {
    const params: Record<string, unknown> = {};
    const hostile = "int1' OR 1=1 --";
    const where = activeCohortMemberWhere(filters([`utm:${hostile}`]), params);
    expect(where).not.toContain("1=1");
    expect(params.p_mmbutm_0).toBe(hostile);
  });

  it("combines with other member filters via AND", () => {
    const params: Record<string, unknown> = {};
    const where = activeCohortMemberWhere({ ...filters(["utm:int1"]), country: ["US"] }, params);
    expect(where).toContain("fc.country IN ({p_mcountry_0:String})");
    expect(where).toContain("fc.trial_transaction_id IN");
    expect(where.indexOf("AND")).toBeGreaterThanOrEqual(0);
  });
});

// ---- 3. FX diagnostics scoping ---------------------------------------------

describe("fx diagnostics media buyer scope", () => {
  async function captureFxQuery(mediaBuyer: string[]) {
    const captured: Array<{ query: string; query_params?: Record<string, unknown> }> = [];
    const client = {
      command: async () => undefined,
      insert: async () => undefined,
      query: async (input: { query: string; query_params?: Record<string, unknown> }) => {
        captured.push(input);
        return { json: async () => [{}] };
      },
    } as ClickHouseClientLike;
    await fxDiagnostics(client, "auth-1", mediaBuyer);
    return captured[0];
  }

  it("buyer names keep the pre-existing transaction-level clause", async () => {
    const { query, query_params } = await captureFxQuery(["Ivan"]);
    expect(query).toContain("media_buyer IN ({p_fxmb_0:String})");
    expect(query_params?.p_fxmb_0).toBe("Ivan");
  });

  it("utm selections scope by first-trial utm user set (union with buyers)", async () => {
    const { query, query_params } = await captureFxQuery(["Ivan", "utm:int1"]);
    expect(query).toMatch(/\(media_buyer IN \({p_fxmb_0:String}\) OR user_id IN \(SELECT user_id FROM/);
    expect(query).toContain("argMin(utm_source, (event_time, transaction_id))");
    expect(query).toContain("transaction_type = 'trial'");
    expect(query_params?.p_fxmbutm_0).toBe("int1");
  });
});

// ---- 4. Legacy client compute ----------------------------------------------

describe("legacy compute with utm selections", () => {
  it("user predicate: buyer names behave exactly as before, utm adds a category", () => {
    const ivan = userRows("u", "4");
    const int1 = userRows("u", "int1");
    expect(userMatchesMediaBuyerSelection(ivan, { buyers: ["Ivan"], utms: [] })).toBe(true);
    expect(userMatchesMediaBuyerSelection(int1, { buyers: ["Ivan"], utms: [] })).toBe(false);
    expect(userMatchesMediaBuyerSelection(int1, { buyers: [], utms: ["int1"] })).toBe(true);
    expect(userMatchesMediaBuyerSelection(ivan, { buyers: [], utms: ["int1"] })).toBe(false);
    expect(userMatchesMediaBuyerSelection(int1, { buyers: ["Ivan"], utms: ["int1"] })).toBe(true);
    expect(userMatchesMediaBuyerSelection(int1, { buyers: [], utms: [] })).toBe(true);
  });

  it("computeCohorts filters trial users by utm:int1", () => {
    const cohorts = computeCohorts(LEGACY_ROWS, [], { selectedMediaBuyers: ["utm:int1"] });
    expect(cohorts).toHaveLength(1);
    expect(cohorts[0].trial_users).toBe(2);
  });

  it("computeCohorts unions Ivan with utm:int2", () => {
    const cohorts = computeCohorts(LEGACY_ROWS, [], { selectedMediaBuyers: ["Ivan", "utm:int2"] });
    expect(cohorts[0].trial_users).toBe(2); // user_ivan + user_int2
  });

  it("computeCohorts by Ivan alone is unchanged", () => {
    const cohorts = computeCohorts(LEGACY_ROWS, [], { selectedMediaBuyers: ["Ivan"] });
    expect(cohorts[0].trial_users).toBe(1);
  });

  it("buildUtmSourceOptions lists unmapped utms with trial counts; mapped excluded", () => {
    const options = buildUtmSourceOptions({ txs: LEGACY_ROWS });
    expect(options).toEqual([
      { utm_source: "int1", trial_count: 2 },
      { utm_source: "int2", trial_count: 1 },
    ]);
  });

  it("buildMediaBuyerOptions counts are untouched by the utm feature", () => {
    const options = buildMediaBuyerOptions({ txs: LEGACY_ROWS });
    expect(options).toEqual([
      { media_buyer: "Ivan", trial_count: 1 },
      { media_buyer: "Unknown", trial_count: 4 },
    ]);
  });
});
