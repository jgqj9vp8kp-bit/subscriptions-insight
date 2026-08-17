// The geo-daily breakdown of the campaign-performance export.
//
// The contract the consuming platform holds us to, item by item: daily
// granularity (date_from === date_to), ISO alpha-2 uppercase countries, an
// explicit ZZ bucket instead of silently dissolved unknowns, campaign_id as a
// string — and above all THE invariant: geo rows summed over countries
// reproduce the legacy campaign totals for the same campaign+day exactly.
import { describe, expect, it } from "vitest";
import {
  buildCampaignGeoDailyRows,
  buildCampaignPerformanceRows,
  geoCountryForUser,
  GEO_UNKNOWN_COUNTRY,
  type ComputeTxn,
} from "../../supabase/functions/export-campaign-performance/compute.ts";

let txSeq = 0;
function tx(over: Partial<ComputeTxn>): ComputeTxn {
  txSeq += 1;
  return {
    transaction_id: `t${txSeq}`,
    user_id: over.user_id ?? `u${txSeq}`,
    event_time: "2026-08-13T10:00:00.000Z",
    amount_usd: 10,
    status: "success",
    transaction_type: "trial",
    funnel: "soulmate",
    campaign_path: "soulmate-reading",
    campaign_id: "120214512345670123",
    classification_reason: "test",
    country: "US",
    utm_source: "4",
    ...over,
  } as ComputeTxn;
}

/** One user = a trial plus optional follow-ups, all sharing user_id/attribution. */
function user(id: string, country: string, day: string, extras: Array<Partial<ComputeTxn>> = [], base: Partial<ComputeTxn> = {}): ComputeTxn[] {
  const stamp = `${day}T10:00:00.000Z`;
  return [
    tx({ user_id: id, event_time: stamp, country, ...base }),
    ...extras.map((extra, i) => tx({
      user_id: id, country,
      event_time: `${day}T1${i + 1}:00:00.000Z`,
      ...base,
      ...extra,
    })),
  ];
}

describe("THE invariant: geo rows partition the legacy campaign+day totals", () => {
  it("summing over countries reproduces the legacy row exactly", () => {
    const txs = [
      // Day 1: 2 US users (one converts to first sub, one refunds), 1 CO user (upsell), 1 user without geo.
      ...user("us1", "US", "2026-08-13", [{ transaction_type: "first_subscription" }]),
      ...user("us2", "US", "2026-08-13", [{ transaction_type: "refund", status: "refunded", refund_amount_usd: 10 }]),
      ...user("co1", "CO", "2026-08-13", [{ transaction_type: "upsell" }]),
      ...user("zz1", "", "2026-08-13", [{ transaction_type: "failed_payment", status: "failed" }]),
      // Day 2: 1 US user.
      ...user("us3", "US", "2026-08-14"),
    ];

    // Legacy totals, day by day — exactly how the consumer's sync queries them.
    for (const day of ["2026-08-13", "2026-08-14"]) {
      const params = { date_from: day, date_to: day };
      const legacy = buildCampaignPerformanceRows({ txs, params });
      const geo = buildCampaignGeoDailyRows({ txs, params });

      for (const legacyRow of legacy) {
        const slice = geo.filter((r) =>
          r.campaign_id === legacyRow.campaign_id &&
          r.campaign_path === legacyRow.campaign_path &&
          r.funnel === legacyRow.funnel);
        const sum = (pick: (r: (typeof geo)[number]) => number) => slice.reduce((acc, r) => acc + pick(r), 0);
        expect(sum((r) => r.trial_users)).toBe(legacyRow.trial_users);
        expect(sum((r) => r.first_sub_users)).toBe(legacyRow.first_sub_users);
        expect(sum((r) => r.upsell_users)).toBe(legacyRow.upsell_users);
        expect(sum((r) => r.refund_users)).toBe(legacyRow.refund_users);
      }
    }
  });

  it("the unknown-geo user is an explicit ZZ row, not dissolved and not dropped", () => {
    const txs = [
      ...user("us1", "US", "2026-08-13"),
      ...user("no_geo", "", "2026-08-13"),
    ];
    const rows = buildCampaignGeoDailyRows({ txs });
    const zz = rows.find((r) => r.country === GEO_UNKNOWN_COUNTRY);
    expect(zz).toBeTruthy();
    expect(zz?.trial_users).toBe(1);
    // And the US row did not absorb it.
    expect(rows.find((r) => r.country === "US")?.trial_users).toBe(1);
  });
});

describe("row shape per the consumer's hard requirements", () => {
  it("daily granularity: date_from === date_to on every row, split across days", () => {
    const rows = buildCampaignGeoDailyRows({
      txs: [...user("a", "US", "2026-08-13"), ...user("b", "US", "2026-08-14")],
    });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.date_from).toBe(row.date_to);
      expect(row.date_from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("campaign_id is a string of digits, never a number", () => {
    const rows = buildCampaignGeoDailyRows({ txs: user("a", "US", "2026-08-13") });
    expect(typeof rows[0].campaign_id).toBe("string");
    expect(rows[0].campaign_id).toBe("120214512345670123");
    // JSON.stringify must keep it quoted — a 17-digit Meta ID loses precision
    // as a JSON number, which is exactly why the consumer rejects numbers.
    expect(JSON.stringify(rows[0])).toContain('"campaign_id":"120214512345670123"');
  });

  it("country is uppercase alpha-2 even when the source stored lowercase", () => {
    const rows = buildCampaignGeoDailyRows({ txs: user("a", "us" as string, "2026-08-13") });
    expect(rows[0].country).toBe("US");
  });

  it("a non-alpha-2 country value lands in ZZ, not in the output as-is", () => {
    const rows = buildCampaignGeoDailyRows({ txs: user("a", "United States", "2026-08-13") });
    expect(rows[0].country).toBe(GEO_UNKNOWN_COUNTRY);
  });

  it("carries media_buyer, utm_source and campaign_name; no CR fields", () => {
    const names = new Map([["120214512345670123", "US | Trial | v3"]]);
    const rows = buildCampaignGeoDailyRows({ txs: user("a", "US", "2026-08-13"), campaignNames: names });
    expect(rows[0].media_buyer).toBe("Ivan"); // utm_source "4"
    expect(rows[0].utm_source).toBe("4");
    expect(rows[0].campaign_name).toBe("US | Trial | v3");
    expect("upsell_cr" in rows[0]).toBe(false);
    expect("trial_to_first_sub_cr" in rows[0]).toBe(false);
  });

  it("campaign_name is null when the FB warehouse has never seen the campaign", () => {
    const rows = buildCampaignGeoDailyRows({ txs: user("a", "US", "2026-08-13") });
    expect(rows[0].campaign_name).toBeNull();
  });

  it("counts failed_payment_users as distinct users with a failed attempt", () => {
    const txs = [
      ...user("ok", "US", "2026-08-13"),
      ...user("fail1", "US", "2026-08-13", [
        { transaction_type: "failed_payment", status: "failed" },
        { transaction_type: "failed_payment", status: "failed" }, // second failure, same user
      ]),
    ];
    const rows = buildCampaignGeoDailyRows({ txs });
    expect(rows[0].failed_payment_users).toBe(1);
  });
});

describe("geoCountryForUser fallbacks", () => {
  it("prefers the trial's country, then the first successful transaction's", () => {
    const trial = tx({ user_id: "u", country: "", transaction_type: "trial" });
    const sub = tx({ user_id: "u", country: "BR", transaction_type: "first_subscription", event_time: "2026-08-13T12:00:00.000Z" });
    expect(geoCountryForUser({ trial, txs: [trial, sub] })).toBe("BR");
  });

  it("falls through to ZZ when no transaction carries a country", () => {
    const trial = tx({ user_id: "u", country: "" });
    expect(geoCountryForUser({ trial, txs: [trial] })).toBe(GEO_UNKNOWN_COUNTRY);
  });
});

describe("filters still apply in geo mode", () => {
  it("media_buyer and campaign_path narrow the geo rows the same way", () => {
    const txs = [
      ...user("ivan_user", "US", "2026-08-13"),                            // utm 4 → Ivan
      ...user("artem_user", "US", "2026-08-13", [], { utm_source: "19" }), // → Artem A
    ];
    const ivanOnly = buildCampaignGeoDailyRows({ txs, params: { media_buyer: "Ivan" } });
    expect(ivanOnly.reduce((acc, r) => acc + r.trial_users, 0)).toBe(1);

    const wrongPath = buildCampaignGeoDailyRows({ txs, params: { campaign_path: "other-path" } });
    expect(wrongPath).toHaveLength(0);
  });
});
