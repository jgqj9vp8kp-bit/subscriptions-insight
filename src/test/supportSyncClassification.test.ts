// What the ClickHouse sync shows for a request.
//
// Precedence is manual > stored > rules, and it was untested before this file
// even though it decides every number on the Support page. The sync used to
// re-run the keyword rules on every pass, which is why Postgres and the
// warehouse disagreed — and why a model classification would have been
// overwritten on the very next sync.
import { describe, expect, it } from "vitest";
import { automaticClassificationFor } from "../../supabase/functions/_shared/clickhouse/support.ts";

type Row = Parameters<typeof automaticClassificationFor>[0];

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: "req-1",
    auth_user_id: "user-1",
    import_batch_id: null,
    source_row_number: 1,
    sender_name: null,
    subject: "Please cancel my subscription",
    message_body: "I want to cancel",
    received_at: "2026-07-20T10:00:00+00:00",
    received_date_raw: null,
    customer_email: null,
    normalized_email: null,
    matched_contact_name: null,
    manual_category: null,
    manual_subcategory: null,
    manual_urgency: null,
    manual_changed_at: null,
    source_hash: "hash",
    imported_at: null,
    updated_at: null,
    category: null,
    subcategory: null,
    secondary_categories: null,
    language: null,
    sentiment: null,
    urgency: null,
    requires_refund: null,
    requires_cancellation: null,
    payment_related: null,
    delivery_related: null,
    possible_unauthorized_charge: null,
    duplicate_charge: null,
    classification_source: null,
    classification_version: null,
    classification_model: null,
    classification_confidence: null,
    classification_reason: null,
    ...overrides,
  } as Row;
}

const stored = {
  category: "Refund",
  subcategory: "refund_request",
  secondary_categories: ["Cancellation"],
  language: "es",
  sentiment: "negative",
  urgency: "medium",
  requires_refund: true,
  requires_cancellation: true,
  payment_related: true,
  delivery_related: false,
  possible_unauthorized_charge: false,
  duplicate_charge: false,
  classification_source: "llm",
  classification_version: "support_llm_v2",
  classification_model: "claude-opus-4-8",
  classification_confidence: 0.93,
  classification_reason: "\"devuelvan mi dinero\" = wants money back",
};

describe("automaticClassificationFor", () => {
  it("copies the stored classification instead of re-deriving it from the text", () => {
    // The email text says "cancel"; the stored model verdict says Refund.
    // Copying is the whole point — re-running the rules here would silently
    // overwrite the model on every sync.
    const result = automaticClassificationFor(row(stored));
    expect(result.category).toBe("Refund");
    expect(result.subcategory).toBe("refund_request");
    expect(result.secondary_categories).toEqual(["Cancellation"]);
    expect(result.language).toBe("es");
    expect(result.source).toBe("llm");
    expect(result.model).toBe("claude-opus-4-8");
    expect(result.version).toBe("support_llm_v2");
    expect(result.classification_confidence).toBe(0.93);
  });

  it("falls back to the rules for a row that has never been classified", () => {
    // A brand-new email between ingest and the next job tick must still land in
    // a category rather than showing up blank.
    const result = automaticClassificationFor(row({ category: null }));
    expect(result.category).toBe("Cancellation");
    expect(result.source).toBe("rule");
    expect(result.secondary_categories).toEqual([]);
    expect(result.model).toBe("");
  });

  it("treats an empty stored category as not classified", () => {
    expect(automaticClassificationFor(row({ category: "   " })).source).toBe("rule");
  });

  it("derives urgent from urgency and tolerates missing optional fields", () => {
    const high = automaticClassificationFor(row({ ...stored, urgency: "high" }));
    expect(high.urgent).toBe(true);
    const sparse = automaticClassificationFor(row({ category: "Complaint" }));
    expect(sparse.subcategory).toBe("");
    expect(sparse.sentiment).toBe("neutral");
    expect(sparse.classification_confidence).toBe(0);
  });

  it("ignores a malformed secondary list rather than propagating junk", () => {
    expect(automaticClassificationFor(row({ ...stored, secondary_categories: "Cancellation" })).secondary_categories).toEqual([]);
    expect(automaticClassificationFor(row({ ...stored, secondary_categories: [1, "", "Cancellation"] })).secondary_categories).toEqual(["Cancellation"]);
  });
});
