// The ai_recommendations writer's pure core: content dedup must survive the
// Postgres jsonb round-trip (key order is NOT preserved), the context hash is
// the persisted identity of a filter context, and feedback subject ids must be
// byte-for-byte AiOpportunity ids.
import { describe, expect, it } from "vitest";
import {
  aiRecommendationsUnchanged,
  computeAiContextHash,
  stableJson,
} from "@/services/aiRecommendationLog";
import { aiScopeKey } from "@/services/aiSignals";

describe("stableJson", () => {
  it("is key-order independent, recursively", () => {
    const a = { b: 1, a: { d: [1, { z: 2, y: 3 }], c: null } };
    const b = { a: { c: null, d: [1, { y: 3, z: 2 }] }, b: 1 };
    expect(stableJson(a)).toBe(stableJson(b));
  });

  it("keeps array order significant and drops undefined properties like JSON does", () => {
    expect(stableJson([1, 2])).not.toBe(stableJson([2, 1]));
    expect(stableJson({ a: 1, gone: undefined })).toBe(stableJson({ a: 1 }));
  });
});

describe("computeAiContextHash", () => {
  it("is stable for equal parts and distinct per surface/dates/contextKey", () => {
    const base = { surface: "cohort" as const, dateFrom: "2026-08-01", dateTo: "2026-08-16", contextKey: "k1" };
    expect(computeAiContextHash(base)).toBe(computeAiContextHash({ ...base }));
    expect(computeAiContextHash(base)).toMatch(/^c_[a-z0-9]+$/);
    expect(computeAiContextHash({ ...base, surface: "campaign" })).not.toBe(computeAiContextHash(base));
    expect(computeAiContextHash({ ...base, dateTo: "2026-08-17" })).not.toBe(computeAiContextHash(base));
    expect(computeAiContextHash({ ...base, contextKey: "k2" })).not.toBe(computeAiContextHash(base));
  });

  it("treats null and empty dates identically (open ranges)", () => {
    expect(computeAiContextHash({ surface: "cohort", dateFrom: null, dateTo: null, contextKey: "k" }))
      .toBe(computeAiContextHash({ surface: "cohort", dateFrom: "", dateTo: "", contextKey: "k" } as never));
  });
});

describe("aiRecommendationsUnchanged (writer dedup)", () => {
  const current = [
    { action: "scale", scope: { kind: "path", campaignPath: "soulmate" }, ruleId: "scale_strong", confidenceScore: 0.82 },
  ] as never;

  it("identical content back from jsonb (reordered keys) → unchanged, no second insert", () => {
    const roundTripped = [
      { ruleId: "scale_strong", confidenceScore: 0.82, scope: { campaignPath: "soulmate", kind: "path" }, action: "scale" },
    ];
    expect(aiRecommendationsUnchanged(roundTripped, current)).toBe(true);
  });

  it("a changed action or a missing row → changed", () => {
    expect(aiRecommendationsUnchanged([{ ...((current as unknown as Record<string, unknown>[])[0]), action: "hold" }], current)).toBe(false);
    expect(aiRecommendationsUnchanged([], current)).toBe(false);
    expect(aiRecommendationsUnchanged(null, [] as never)).toBe(true); // no history, no output
  });
});

describe("feedback subject key format", () => {
  it("aiScopeKey is display-name independent and matches the opportunity id shape", () => {
    expect(aiScopeKey({ kind: "cohort", cohortDate: "2026-07-01", funnel: "soulmate", campaignPath: "soulmate-web" }))
      .toBe("cohort|2026-07-01|soulmate|soulmate-web");
    expect(aiScopeKey({ kind: "path", campaignPath: "soulmate-web" })).toBe("path|soulmate-web");
    expect(aiScopeKey({ kind: "campaign", campaignId: "123", campaignName: "Renamed later" })).toBe("campaign|123");
  });
});
