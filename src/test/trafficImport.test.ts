import { describe, expect, it } from "vitest";
import { normalizeCampaignPath, normalizeTrafficDate, parseTrafficMetrics, parseTrafficNumber } from "@/services/trafficImport";

describe("traffic import", () => {
  it("parses comma decimal and spaced numbers", () => {
    expect(parseTrafficNumber("87,37")).toBe(87.37);
    expect(parseTrafficNumber("1 355,49")).toBe(1355.49);
  });

  it("normalizes DD.MM dates with selected year and campaign paths", () => {
    expect(normalizeTrafficDate("05.04", 2026)).toBe("2026-04-05");
    expect(normalizeCampaignPath("/Soulmate-Reading ")).toBe("soulmate-reading");
    expect(normalizeTrafficDate("18.03", 2026)).toBe("2026-03-18");
    expect(normalizeCampaignPath('"/soulmate-reading"')).toBe("soulmate-reading");
    expect(normalizeCampaignPath("'/soulmate-reading'")).toBe("soulmate-reading");
    expect(normalizeCampaignPath('"soulmate-reading"')).toBe("soulmate-reading");
  });

  it("parses Facebook traffic rows", () => {
    const rows = parseTrafficMetrics(
      {
        headers: ["Date", "ff_campaign_path", "Trial count", "CAC", "Spend", "Clicks", "CPC", "CPM", "CTR"],
        rows: [
          {
            Date: "05.04",
            ff_campaign_path: "/soulmate-reading",
            "Trial count": "10",
            CAC: "87,37",
            Spend: "873,70",
            Clicks: "100",
            CPC: "8,74",
            CPM: "120,50",
            CTR: "1,2",
          },
        ],
      },
      2026,
    );

    expect(rows[0]).toMatchObject({
      date: "2026-04-05",
      campaign_path: "soulmate-reading",
      trial_count: 10,
      cac: 87.37,
      spend: 873.7,
      clicks: 100,
      cpc: 8.74,
      cpm: 120.5,
      ctr: 1.2,
      source: "facebook",
    });
  });
});
