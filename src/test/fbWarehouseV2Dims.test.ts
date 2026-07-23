import { describe, expect, it } from "vitest";
import {
  deriveDimCandidatesFromRows,
  syncFbV2Dims,
} from "../../supabase/functions/_shared/clickhouse/fbWarehouseV2Dims.ts";
import type { ClickHouseClientLike } from "../../supabase/functions/_shared/clickhouse/types.ts";

const row = (overrides: Partial<Parameters<typeof deriveDimCandidatesFromRows>[0][number]> = {}) => ({
  level: "campaign",
  stat_date: "2026-07-01",
  ad_account_id: "act_1",
  ad_account_name: "Acc One",
  buyer: "Ivan",
  currency: "USD",
  campaign_id: "c1",
  campaign_name: "Alpha",
  ...overrides,
});

describe("deriveDimCandidatesFromRows", () => {
  it("takes the latest attributes per entity and tracks first/last seen", () => {
    const { accounts, campaigns, adsets, ads } = deriveDimCandidatesFromRows([
      row({ stat_date: "2026-07-01", campaign_name: "Alpha (old)" }),
      row({ stat_date: "2026-07-05", campaign_name: "Alpha (new)" }),
      row({ stat_date: "2026-07-03", level: "day", ad_account_id: "", campaign_id: "" }),
      row({ stat_date: "2026-07-02", level: "adset", campaign_id: "ignored-for-campaign-dim", adset_id: "s1", adset_name: "Set One" }),
      row({ stat_date: "2026-07-04", level: "ad", campaign_id: "c1", adset_id: "s1", ad_id: "a1", ad_name: "Creative One" }),
    ]);
    expect(accounts).toEqual([
      { ad_account_id: "act_1", account_name: "Acc One", buyer: "Ivan", currency: "USD" },
    ]);
    expect(campaigns).toEqual([
      {
        campaign_id: "c1",
        ad_account_id: "act_1",
        campaign_name: "Alpha (new)",
        first_seen_date: "2026-07-01",
        last_seen_date: "2026-07-05",
      },
    ]);
    expect(adsets).toEqual([
      { adset_id: "s1", campaign_id: "ignored-for-campaign-dim", ad_account_id: "act_1", adset_name: "Set One" },
    ]);
    expect(ads).toEqual([
      { ad_id: "a1", adset_id: "s1", campaign_id: "c1", ad_account_id: "act_1", ad_name: "Creative One" },
    ]);
  });
});

function fakeCh(currentByQuery: { accounts?: unknown[]; campaigns?: unknown[] }, inserts: Array<{ table: string; values: Record<string, unknown>[] }>): ClickHouseClientLike {
  return {
    command: async () => undefined,
    insert: async (input: { table: string; values: unknown[] }) => {
      inserts.push({ table: input.table, values: input.values as Record<string, unknown>[] });
    },
    query: async ({ query }: { query: string }) => ({
      json: async () => (query.includes("dim_facebook_account") ? currentByQuery.accounts ?? [] : currentByQuery.campaigns ?? []),
    }),
  } as unknown as ClickHouseClientLike;
}

describe("syncFbV2Dims (SCD2)", () => {
  const account = { ad_account_id: "act_1", account_name: "Acc One", buyer: "Ivan", currency: "USD" };
  const campaign = { campaign_id: "c1", ad_account_id: "act_1", campaign_name: "Alpha", first_seen_date: "2026-07-01", last_seen_date: "2026-07-05" };

  it("opens versions for brand-new entities without closing anything", async () => {
    const inserts: Array<{ table: string; values: Record<string, unknown>[] }> = [];
    const result = await syncFbV2Dims({
      clickhouse: fakeCh({}, inserts),
      authUserId: "u1",
      importBatchId: "b1",
      nowIso: "2026-07-23T10:00:00.000Z",
      accounts: [account],
      campaigns: [campaign],
    });
    expect(result).toEqual({ accounts_opened: 1, accounts_closed: 0, campaigns_opened: 1, campaigns_closed: 0, adsets_opened: 0, adsets_closed: 0, ads_opened: 0, ads_closed: 0 });
    const opened = inserts.flatMap((entry) => entry.values);
    expect(opened.every((version) => version.is_current === 1 && version.valid_to === null)).toBe(true);
  });

  it("closes and reopens ONLY when identity attributes change; last_seen alone never versions", async () => {
    const inserts: Array<{ table: string; values: Record<string, unknown>[] }> = [];
    const result = await syncFbV2Dims({
      clickhouse: fakeCh(
        {
          accounts: [{ ad_account_id: "act_1", account_name: "Acc One", buyer: "Ivan", currency: "USD", valid_from: "2026-07-01 00:00:00" }],
          campaigns: [{ campaign_id: "c1", ad_account_id: "act_1", campaign_name: "Alpha RENAMED", first_seen_date: "2026-06-01", valid_from: "2026-07-01 00:00:00" }],
        },
        inserts,
      ),
      authUserId: "u1",
      importBatchId: "b2",
      nowIso: "2026-07-23T10:00:00.000Z",
      accounts: [account], // unchanged -> no writes
      campaigns: [campaign], // name differs from current -> close + open
    });
    expect(result).toEqual({ accounts_opened: 0, accounts_closed: 0, campaigns_opened: 1, campaigns_closed: 1, adsets_opened: 0, adsets_closed: 0, ads_opened: 0, ads_closed: 0 });
    const campaignWrites = inserts.filter((entry) => entry.table === "dim_facebook_campaign").flatMap((entry) => entry.values);
    const closed = campaignWrites.find((version) => version.is_current === 0)!;
    const opened = campaignWrites.find((version) => version.is_current === 1)!;
    expect(closed.campaign_name).toBe("Alpha RENAMED"); // the closed row preserves the OLD attributes
    expect(closed.valid_to).toBe("2026-07-23T10:00:00.000Z");
    expect(opened.campaign_name).toBe("Alpha");
    // first_seen survives from the earlier version (the earliest wins).
    expect(opened.first_seen_date).toBe("2026-06-01");
  });
});
