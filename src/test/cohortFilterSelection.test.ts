// Invalid-selection handling for the cascading Cohorts filters, plus the cache-key
// and scope-freshness guarantees the pruner depends on.

import { describe, expect, it } from "vitest";
import { pruneInvalidCohortSelections, type CohortFilterSelection } from "@/services/cohortFilterSelection";
import { cohortsListKey, normalizeCohortRequest } from "@/services/cohortsCache";
import type { CohortFilterOptionsView } from "@/services/cohortsDataSource";
import type { CardType, MediaBuyer } from "@/services/types";
import type { CohortRequest } from "../../supabase/functions/_shared/clickhouse/cohortContract";

function selection(over: Partial<CohortFilterSelection> = {}): CohortFilterSelection {
  return {
    funnelFilter: "all",
    campaignPathFilter: "all",
    trafficSourceFilter: "all",
    currencyFilter: "all",
    selectedCountries: [],
    selectedCardTypes: [],
    selectedMediaBuyers: [],
    selectedCampaignIds: [],
    ...over,
  };
}

function options(over: Partial<CohortFilterOptionsView> = {}): CohortFilterOptionsView {
  return {
    funnel: ["soulmate", "astro"],
    campaign_path: ["soulmate-sketch", "soulmate-quiz"],
    traffic_source: ["facebook"],
    price_plan: [],
    currency: ["USD", "EUR"],
    campaign_id: [{ campaign_id: "cid_1", campaign_name: null, trial_count: 4 }],
    country: [{ country_code: "US", user_count: 10 }, { country_code: "CA", user_count: 2 }],
    card_type: [{ card_type: "visa" as CardType, trial_count: 6 }],
    media_buyer: [{ media_buyer: "Alex" as MediaBuyer, trial_count: 8 }],
    ...over,
  };
}

describe("pruneInvalidCohortSelections", () => {
  it("clears a downstream selection that no longer exists in the new scope", () => {
    // Campaign Path switched to a path with no CA users.
    const patch = pruneInvalidCohortSelections(
      selection({ campaignPathFilter: "soulmate-sketch", selectedCountries: ["US", "CA"] }),
      options({ country: [{ country_code: "US", user_count: 10 }] }),
    );
    expect(patch).toEqual({ selectedCountries: ["US"] });
  });

  it("keeps valid selections untouched (returns null at the fixed point)", () => {
    expect(
      pruneInvalidCohortSelections(
        selection({ campaignPathFilter: "soulmate-sketch", selectedCountries: ["US"], selectedCardTypes: ["visa" as CardType] }),
        options(),
      ),
    ).toBeNull();
  });

  it("clears ONLY the invalid dimension and leaves unrelated filters alone", () => {
    const patch = pruneInvalidCohortSelections(
      selection({
        funnelFilter: "soulmate",
        campaignPathFilter: "soulmate-sketch",
        selectedCountries: ["CA"],
        selectedCardTypes: ["visa" as CardType],
        selectedMediaBuyers: ["Alex" as MediaBuyer],
      }),
      options({ country: [{ country_code: "US", user_count: 10 }] }),
    );
    expect(patch).toEqual({ selectedCountries: [] });
    expect(patch).not.toHaveProperty("funnelFilter");
    expect(patch).not.toHaveProperty("campaignPathFilter");
    expect(patch).not.toHaveProperty("selectedCardTypes");
    expect(patch).not.toHaveProperty("selectedMediaBuyers");
  });

  it("resets a single-select to 'all' when its value left the scope", () => {
    const patch = pruneInvalidCohortSelections(
      selection({ funnelFilter: "soulmate", campaignPathFilter: "astro-natal" }),
      options(),
    );
    expect(patch).toEqual({ campaignPathFilter: "all" });
  });

  it("prunes campaign ids and clears the legacy single-select mirror", () => {
    const patch = pruneInvalidCohortSelections(
      selection({ selectedCampaignIds: ["cid_1", "cid_gone"] }),
      options(),
    );
    expect(patch).toEqual({ selectedCampaignIds: ["cid_1"], campaignIdFilter: "all" });
  });

  it("prunes an out-of-scope currency", () => {
    expect(pruneInvalidCohortSelections(selection({ currencyFilter: "COP" }), options())).toEqual({ currencyFilter: "all" });
    expect(pruneInvalidCohortSelections(selection({ currencyFilter: "EUR" }), options())).toBeNull();
  });

  it("never wipes filters when a dimension's option list is empty (no data != all invalid)", () => {
    const empty = options({ country: [], card_type: [], media_buyer: [], campaign_id: [], funnel: [], campaign_path: [], currency: [] });
    expect(
      pruneInvalidCohortSelections(
        selection({
          funnelFilter: "soulmate",
          campaignPathFilter: "soulmate-sketch",
          currencyFilter: "USD",
          selectedCountries: ["US"],
          selectedCardTypes: ["visa" as CardType],
        }),
        empty,
      ),
    ).toBeNull();
  });

  it("does nothing without options for the CURRENT scope (stale keepPreviousData is not authoritative)", () => {
    expect(pruneInvalidCohortSelections(selection({ selectedCountries: ["ZZ"] }), undefined)).toBeNull();
  });

  it("reaches a fixed point in one pass — no infinite filter-reset loop", () => {
    const scoped = options({ country: [{ country_code: "US", user_count: 10 }], campaign_path: ["soulmate-quiz"] });
    const initial = selection({ campaignPathFilter: "soulmate-sketch", selectedCountries: ["CA", "US"], selectedCampaignIds: ["cid_gone"] });

    const first = pruneInvalidCohortSelections(initial, scoped);
    expect(first).not.toBeNull();
    const settled = { ...initial, ...first } as CohortFilterSelection;
    // Applying the patch yields a selection the same options no longer prune.
    expect(pruneInvalidCohortSelections(settled, scoped)).toBeNull();
    // And it only ever removed values.
    expect(settled.selectedCountries.length).toBeLessThan(initial.selectedCountries.length);
    expect(settled.selectedCountries.every((c) => initial.selectedCountries.includes(c))).toBe(true);
  });
});

describe("cohorts options cache key", () => {
  const base = { userScopeHash: "u1", dataSource: "clickhouse" as const, warehouseVersion: "whv_1" };
  const req = (filters: Partial<CohortRequest["filters"]>): CohortRequest => ({
    action: "list",
    date_from: null,
    date_to: null,
    filters: {
      funnel: [], campaign_path: [], campaign_id: [], traffic_source: [], price_plan: [],
      media_buyer: [], country: [], card_type: [], currency: [], transaction_type: [], refund_status: "all",
      ...filters,
    },
    max_renewal_depth: 6,
  });

  // Options ride on the list response, so the list key IS the options key.
  it("includes the normalized active filters (a filter change cannot reuse global options)", () => {
    const unfiltered = JSON.stringify(cohortsListKey({ ...base, request: req({}) }));
    const filtered = JSON.stringify(cohortsListKey({ ...base, request: req({ campaign_path: ["soulmate-sketch"] }) }));
    expect(filtered).not.toEqual(unfiltered);
    expect(filtered).toContain("soulmate-sketch");
  });

  it("is stable across filter order and duplicates (same logical scope reuses one entry)", () => {
    const a = cohortsListKey({ ...base, request: req({ country: ["US", "CA", "US"] }) });
    const b = cohortsListKey({ ...base, request: req({ country: ["CA", "US"] }) });
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
    expect(normalizeCohortRequest(req({ country: ["US", "CA", "US"] })).country).toEqual(["CA", "US"]);
  });

  it("separates scopes that differ only in one dimension", () => {
    const us = JSON.stringify(cohortsListKey({ ...base, request: req({ campaign_path: ["soulmate-sketch"], country: ["US"] }) }));
    const ca = JSON.stringify(cohortsListKey({ ...base, request: req({ campaign_path: ["soulmate-sketch"], country: ["CA"] }) }));
    expect(us).not.toEqual(ca);
  });
});
