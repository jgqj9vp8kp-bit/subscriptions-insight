// The price-id config of the token / in-product / funnel upsell split
// (monetizationProductMap.ts, owner screenshots + analysis of 2026-10-22).
import { describe, expect, it } from "vitest";
import {
  PRICE_ID_RE,
  assertValidPriceIdLists,
  isKnownTokenAmount,
  knownAppUpsellPriceIds,
  knownFunnelUpsellPriceIds,
  knownTokenAmounts,
  knownTokenPriceIds,
  knownTokenPricePointPrefixes,
} from "@/services/monetizationProductMap";

/** The JPY 2400 funnel upsell sent unmarked on 2 of 26 rows: the "ever marked"
 * rule, never a list, must type it. */
const JPY_2400_FUNNEL_UPSELL = "price_01M3BW7TT3TXZRHCRY4BFGS8M7";

describe("price-id lists", () => {
  it("holds 74 token ids, 87 in-product ids (7 upsell + 80 paid reports) and no funnel-upsell id", () => {
    expect(knownTokenPriceIds).toHaveLength(74);
    expect(knownAppUpsellPriceIds).toHaveLength(87);
    expect(knownFunnelUpsellPriceIds).toHaveLength(0);
    expect(knownTokenPricePointPrefixes).toEqual(["price_web_tokens"]);
  });

  it("every id is a plain price id, listed once, in one list only", () => {
    const all = [...knownTokenPriceIds, ...knownAppUpsellPriceIds, ...knownFunnelUpsellPriceIds];
    for (const id of all) expect(id, id).toMatch(PRICE_ID_RE);
    expect(new Set(all).size).toBe(all.length);
    expect(knownAppUpsellPriceIds.filter((id) => knownTokenPriceIds.includes(id))).toEqual([]);
  });

  it("no listed id matches the token prefix (the prefix rule is for future web-app packs)", () => {
    const all = [...knownTokenPriceIds, ...knownAppUpsellPriceIds];
    expect(all.filter((id) => knownTokenPricePointPrefixes.some((prefix) => id.startsWith(prefix)))).toEqual([]);
  });

  it("the paid reports of the 09-10 / 09-18 batches are in-product purchases, not tokens (FunnelFox, 2026-10-25)", () => {
    const reports = {
      wealthLineJpy799: "price_01M2SSJP60614ZNS4FXBE277J5",
      mysteriousSignJpy480: "price_01M2SSMGQPM0D80Q5WHQZAEG4H",
      secondHandJpy1499: "price_01M2SSM9YEY6KFKCPPF6Q8AZ51",
      yearByHandJpy1559: "price_01M2SSM2ZTFYCXT1EH2KQ20XN7",
      unlockAllDaysJpy480: "price_01M2632WE6284ZZJWFZ5EPG6BT",
      unlockAllDaysUsd299: "price_01M260883ZSH31PKMB75KD3QJH",
    };
    for (const [name, id] of Object.entries(reports)) {
      expect(knownAppUpsellPriceIds, name).toContain(id);
      expect(knownTokenPriceIds, name).not.toContain(id);
    }
    // No price of the two batches is left among the tokens.
    expect(knownTokenPriceIds.filter((id) => id.startsWith("price_01M2SS") || id.startsWith("price_01M26"))).toEqual([]);
    // The real JPY token pack (200+50 Web tokens, ¥649) is untouched by the move.
    expect(knownAppUpsellPriceIds).not.toContain("price_01M3YB4RGX9KMNWCSRHQXK2NHT");
  });

  it("the unmarked JPY 2400 funnel upsell is in no list", () => {
    expect(knownTokenPriceIds).not.toContain(JPY_2400_FUNNEL_UPSELL);
    expect(knownAppUpsellPriceIds).not.toContain(JPY_2400_FUNNEL_UPSELL);
    expect(knownFunnelUpsellPriceIds).not.toContain(JPY_2400_FUNNEL_UPSELL);
  });
});

describe("module-load validation (assertValidPriceIdLists)", () => {
  it("accepts the shipped lists", () => {
    expect(() =>
      assertValidPriceIdLists(
        [["token", knownTokenPriceIds], ["app", knownAppUpsellPriceIds], ["funnel", knownFunnelUpsellPriceIds]],
        knownTokenPricePointPrefixes,
      ),
    ).not.toThrow();
  });

  it("names an id that would break the inline SQL literal", () => {
    expect(() => assertValidPriceIdLists([["token", ["price_ok", "price_x') OR 1 --"]]])).toThrow(/invalid price id in token: price_x'\) OR 1 --/);
    expect(() => assertValidPriceIdLists([["app", ["not_a_price"]]])).toThrow(/invalid price id in app: not_a_price/);
    expect(() => assertValidPriceIdLists([], ["price web"])).toThrow(/invalid price-point prefix/);
  });

  it("names an id listed in two lists", () => {
    expect(() => assertValidPriceIdLists([["token", ["price_A"]], ["app", ["price_A"]]])).toThrow(/price_A is listed in both token and app/);
  });
});

describe("anchor protection: knownTokenAmounts is not extended", () => {
  // tokenAmt is part of the cohort-anchor eligibility (lifeelig). 6 of the 7
  // in-product upsell amounts equal token-pack amounts, so only ids separate
  // them; adding any of these amounts would move cohort anchors.
  it.each([
    [2.99, "USD"],
    [2.99, "EUR"],
    [5.99, "NZD"],
    [480, "JPY"],
    [15.99, "BRL"],
    [9879, "COP"],
    [179, "PHP"],
  ])("%s %s is not a known token amount", (amount, currency) => {
    expect(isKnownTokenAmount(amount, currency)).toBe(false);
  });

  it("is exactly the July 2026 audit list", () => {
    expect(knownTokenAmounts).toEqual([
      { amount: 4.99, currency: "USD" },
      { amount: 9.99, currency: "USD" },
      { amount: 24.99, currency: "USD" },
      { amount: 4.99, currency: "EUR" },
      { amount: 17199, currency: "COP" },
    ]);
  });
});
