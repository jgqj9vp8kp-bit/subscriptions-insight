// Taxonomy v2 contract. Nothing constrains category/subcategory in Postgres or
// ClickHouse (both are free text), so the normalizer in this module IS the
// constraint — these tests are what stops an invented category from reaching
// the warehouse.
import { describe, expect, it } from "vitest";
import {
  SUPPORT_CATEGORIES_V1,
  SUPPORT_CATEGORIES_V2,
  SUBCATEGORY_BY_CATEGORY,
  applyUrgencyFloor,
  buildResponseSchema,
  buildSystemPrompt,
  buildUserPrompt,
  deriveFlags,
  normalizeCategory,
  normalizeClassificationEntry,
  parseClassificationResponse,
  type SupportCategoryV2,
} from "@/services/supportTaxonomy";

function entry(overrides: Record<string, unknown> = {}) {
  return {
    id: "row-1",
    category: "Refund",
    secondary_categories: [],
    language: "es",
    sentiment: "negative",
    urgency: "medium",
    confidence: 0.9,
    reason: "asks for money back",
    ...overrides,
  };
}

describe("taxonomy shape", () => {
  it("keeps every v1 category so saved reports and stored rows stay valid", () => {
    for (const category of SUPPORT_CATEGORIES_V1) {
      expect(SUPPORT_CATEGORIES_V2).toContain(category);
    }
    expect(SUPPORT_CATEGORIES_V2).toHaveLength(SUPPORT_CATEGORIES_V1.length + 6);
  });

  it("gives every category a machine subcategory, and keeps the v1 keys unchanged", () => {
    for (const category of SUPPORT_CATEGORIES_V2) {
      expect(SUBCATEGORY_BY_CATEGORY[category]).toMatch(/^[a-z_]+$/);
    }
    // Stored v1 rows carry these exact keys — renaming one would orphan them.
    expect(SUBCATEGORY_BY_CATEGORY["Refund"]).toBe("refund_request");
    expect(SUBCATEGORY_BY_CATEGORY["Cancellation"]).toBe("cancel_subscription");
    expect(SUBCATEGORY_BY_CATEGORY["Unauthorized or unexpected charge"]).toBe("unknown_charge");
    expect(SUBCATEGORY_BY_CATEGORY["Other/unclear"]).toBe("other_unclear");
  });
});

describe("normalizeCategory", () => {
  it("accepts exact, case-loose and aliased names", () => {
    expect(normalizeCategory("Refund")).toBe("Refund");
    expect(normalizeCategory("  refund ")).toBe("Refund");
    expect(normalizeCategory("unauthorized charge")).toBe("Unauthorized or unexpected charge");
    expect(normalizeCategory("wrong product")).toBe("Wrong or unsatisfactory product");
    expect(normalizeCategory("bounce")).toBe("Automated notification");
  });

  it("returns null for anything it does not recognize", () => {
    for (const value of ["Reembolso", "totally made up", "", "   ", null, undefined, 42 as unknown as string]) {
      expect(normalizeCategory(value)).toBeNull();
    }
  });
});

describe("normalizeClassificationEntry", () => {
  it("normalizes a well-formed entry and derives the subcategory itself", () => {
    const result = normalizeClassificationEntry(entry())!;
    expect(result.category).toBe("Refund");
    expect(result.subcategory).toBe("refund_request");
    expect(result.confidence).toBe(0.9);
    expect(result.flags.requires_refund).toBe(true);
    expect(result.flags.payment_related).toBe(true);
  });

  it("rejects an unknown category instead of persisting it", () => {
    expect(normalizeClassificationEntry(entry({ category: "Refund Pending Review" }))).toBeNull();
    expect(normalizeClassificationEntry(entry({ category: "" }))).toBeNull();
    expect(normalizeClassificationEntry(entry({ id: "" }))).toBeNull();
    expect(normalizeClassificationEntry(null)).toBeNull();
    expect(normalizeClassificationEntry("nope")).toBeNull();
  });

  it("keeps the second intent that the single-category model used to lose", () => {
    const result = normalizeClassificationEntry(
      entry({ category: "Refund", secondary_categories: ["Cancellation"] }),
    )!;
    expect(result.secondary_categories).toEqual(["Cancellation"]);
    expect(result.flags.requires_refund).toBe(true);
    expect(result.flags.requires_cancellation).toBe(true);
  });

  it("drops secondary entries that are noise: unknown, duplicated, self-referential or the catch-all", () => {
    const result = normalizeClassificationEntry(
      entry({
        category: "Refund",
        secondary_categories: ["Refund", "Other/unclear", "made up", "Cancellation", "Cancellation"],
      }),
    )!;
    expect(result.secondary_categories).toEqual(["Cancellation"]);
  });

  it("clamps confidence and falls back on invalid sentiment/urgency/language", () => {
    const result = normalizeClassificationEntry(
      entry({ confidence: 4.2, sentiment: "furious", urgency: "critical", language: "Spanish", category: "Positive feedback" }),
    )!;
    expect(result.confidence).toBe(1);
    expect(result.sentiment).toBe("neutral");
    expect(result.urgency).toBe("low");
    expect(result.language).toBe("unknown");
    expect(normalizeClassificationEntry(entry({ confidence: -3 }))!.confidence).toBe(0);
    expect(normalizeClassificationEntry(entry({ confidence: "0.5" }))!.confidence).toBe(0.5);
  });
});

describe("urgency floor", () => {
  it("raises disputed-money emails to high even when the model reads them as calm", () => {
    expect(applyUrgencyFloor("low", ["Unauthorized or unexpected charge"])).toBe("high");
    expect(applyUrgencyFloor("low", ["Duplicate charge"])).toBe("high");
    expect(applyUrgencyFloor("low", ["Billing inquiry", "Unauthorized or unexpected charge"])).toBe("high");
  });

  it("floors money/delivery requests at medium and leaves quiet categories alone", () => {
    expect(applyUrgencyFloor("low", ["Refund"])).toBe("medium");
    expect(applyUrgencyFloor("low", ["Cancellation"])).toBe("medium");
    expect(applyUrgencyFloor("low", ["Positive feedback"])).toBe("low");
    expect(applyUrgencyFloor("low", ["Automated notification"])).toBe("low");
  });

  it("never lowers what the model already judged urgent", () => {
    expect(applyUrgencyFloor("high", ["Positive feedback"])).toBe("high");
    expect(applyUrgencyFloor("medium", ["Product/report question"])).toBe("medium");
  });
});

describe("deriveFlags", () => {
  it("keeps the boolean columns consistent with the categories", () => {
    // A filter on "requires refund" and a filter on the Refund category must
    // select the same rows — the flags are derived, never model-supplied.
    expect(deriveFlags(["Refund"], "medium").requires_refund).toBe(true);
    expect(deriveFlags(["Cancellation"], "medium").requires_cancellation).toBe(true);
    expect(deriveFlags(["Accidental signup"], "low").requires_cancellation).toBe(true);
    expect(deriveFlags(["Billing inquiry"], "low").payment_related).toBe(true);
    expect(deriveFlags(["Wrong or unsatisfactory product"], "low").delivery_related).toBe(true);
    expect(deriveFlags(["Product/report not received"], "medium").delivery_related).toBe(true);
    expect(deriveFlags(["Positive feedback"], "low")).toMatchObject({
      requires_refund: false,
      requires_cancellation: false,
      payment_related: false,
      delivery_related: false,
      urgent: false,
    });
    expect(deriveFlags(["Refund"], "high").urgent).toBe(true);
  });
});

describe("parseClassificationResponse", () => {
  it("keys results by id and ignores ids that were never sent", () => {
    const parsed = parseClassificationResponse(
      { results: [entry({ id: "a" }), entry({ id: "ghost" }), entry({ id: "b", category: "Cancellation" })] },
      ["a", "b"],
    );
    expect([...parsed.keys()].sort()).toEqual(["a", "b"]);
    expect(parsed.get("b")!.category).toBe("Cancellation");
  });

  it("keeps the good entries when one is malformed, so one bad row cannot lose a whole batch", () => {
    const parsed = parseClassificationResponse(
      { results: [entry({ id: "a" }), { id: "b", category: "invented" }] },
      ["a", "b"],
    );
    expect(parsed.has("a")).toBe(true);
    expect(parsed.has("b")).toBe(false); // caller keeps the rules result for b
  });

  it("returns nothing for a shapeless payload", () => {
    for (const payload of [null, {}, { results: "nope" }, [], "text"]) {
      expect(parseClassificationResponse(payload, ["a"]).size).toBe(0);
    }
  });

  it("keeps the first entry when the model repeats an id", () => {
    const parsed = parseClassificationResponse(
      { results: [entry({ id: "a", category: "Refund" }), entry({ id: "a", category: "Complaint" })] },
      ["a"],
    );
    expect(parsed.get("a")!.category).toBe("Refund");
  });
});

describe("prompt", () => {
  it("lists every category with its guide so the model sees the full taxonomy", () => {
    const system = buildSystemPrompt();
    for (const category of SUPPORT_CATEGORIES_V2) {
      expect(system).toContain(category);
    }
    // The two distinctions the corpus keeps getting wrong must be stated.
    expect(system).toContain("Billing inquiry");
    expect(system).toMatch(/Mailing list unsubscribe/);
  });

  it("labels each email with its id and survives empty subject/body", () => {
    const prompt = buildUserPrompt([
      { id: "row-1", subject: "Cobro inadecuado", body: null },
      { id: "row-2", subject: null, body: "Yo no he comprado nada" },
    ]);
    expect(prompt).toContain("id: row-1");
    expect(prompt).toContain("(no body)");
    expect(prompt).toContain("id: row-2");
    expect(prompt).toContain("(no subject)");
  });

  it("truncates a runaway forwarded thread instead of blowing up the batch", () => {
    const prompt = buildUserPrompt([{ id: "row-1", subject: "s".repeat(5000), body: "b".repeat(50000) }]);
    expect(prompt.length).toBeLessThan(3000);
  });

  it("constrains the response schema to the known categories", () => {
    const schema = buildResponseSchema() as Record<string, never>;
    const serialized = JSON.stringify(schema);
    expect(serialized).toContain("Wrong or unsatisfactory product");
    expect(serialized).toContain("additionalProperties");
    const results = (schema.properties as Record<string, Record<string, Record<string, Record<string, unknown>>>>).results;
    const categoryEnum = results.items.properties.category as { enum: SupportCategoryV2[] };
    expect(categoryEnum.enum).toHaveLength(SUPPORT_CATEGORIES_V2.length);
  });
});
