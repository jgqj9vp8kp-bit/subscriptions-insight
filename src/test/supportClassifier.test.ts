// Classification engine. The model call is injected, so these tests never touch
// the network — what they pin down is the failure policy: a bad batch, a
// hallucinated id or a dropped email must never corrupt a row, and must never
// silently lose the emails around it.
import { describe, expect, it, vi } from "vitest";
import {
  CLASSIFICATION_MODEL,
  buildSupportRequestPatch,
  chunk,
  classifyEmails,
  maxTokensForBatch,
  toClassifiableEmails,
  type ModelCallRequest,
} from "../../supabase/functions/_shared/clickhouse/supportClassifier.ts";
import { normalizeClassificationEntry } from "@/services/supportTaxonomy";

const emails = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    id: `row-${index + 1}`,
    subject: `subject ${index + 1}`,
    body: "cancel my subscription and refund me",
  }));

function answer(ids: string[], overrides: Record<string, unknown> = {}) {
  return {
    results: ids.map((id) => ({
      id,
      category: "Refund",
      secondary_categories: ["Cancellation"],
      language: "en",
      sentiment: "negative",
      urgency: "medium",
      confidence: 0.88,
      reason: "asks for money back",
      ...overrides,
    })),
  };
}

const usage = { input_tokens: 100, output_tokens: 50 };

describe("chunk / maxTokensForBatch", () => {
  it("splits into whole batches and never returns an empty batch", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 20)).toEqual([]);
    expect(chunk([1, 2], 0)).toEqual([[1], [2]]);
  });

  it("scales the output budget with the batch and stays under the streaming threshold", () => {
    expect(maxTokensForBatch(20)).toBe(5000);
    expect(maxTokensForBatch(1)).toBe(1200);
    expect(maxTokensForBatch(1000)).toBeLessThanOrEqual(16000);
  });
});

describe("classifyEmails", () => {
  it("batches the emails and returns one result per id", async () => {
    const seen: ModelCallRequest[] = [];
    const callModel = vi.fn(async (request: ModelCallRequest) => {
      seen.push(request);
      const ids = [...request.user.matchAll(/^id: (\S+)$/gm)].map((match) => match[1]);
      return { payload: answer(ids), ...usage };
    });

    const result = await classifyEmails(emails(45), callModel, { batchSize: 20 });

    expect(result.batches).toBe(3);
    expect(callModel).toHaveBeenCalledTimes(3);
    expect(result.results.size).toBe(45);
    expect(result.unresolvedIds).toEqual([]);
    expect(result.usage).toEqual({ api_requests: 3, input_tokens: 300, output_tokens: 150 });
    // The taxonomy travels in the system prompt, the emails in the user prompt.
    expect(seen[0].system).toContain("Mailing list unsubscribe");
    expect(seen[0].user).toContain("id: row-1");
  });

  it("keeps the other batches when one call throws", async () => {
    let call = 0;
    const callModel = vi.fn(async (request: ModelCallRequest) => {
      call += 1;
      if (call === 1) throw new Error("upstream 529 overloaded");
      const ids = [...request.user.matchAll(/^id: (\S+)$/gm)].map((match) => match[1]);
      return { payload: answer(ids), ...usage };
    });

    const result = await classifyEmails(emails(4), callModel, { batchSize: 2 });

    expect(result.results.size).toBe(2);
    expect(result.unresolvedIds).toEqual(["row-1", "row-2"]);
    expect(result.errors[0]).toContain("529");
    // Failed calls still count against usage — they were billed round-trips.
    expect(result.usage.api_requests).toBe(2);
  });

  it("reports emails the model skipped instead of pretending they were classified", async () => {
    const callModel = vi.fn(async () => ({ payload: answer(["row-1"]), ...usage }));
    const result = await classifyEmails(emails(3), callModel, { batchSize: 3 });
    expect(result.results.size).toBe(1);
    expect(result.unresolvedIds).toEqual(["row-2", "row-3"]);
  });

  it("ignores an id the model invented", async () => {
    const callModel = vi.fn(async () => ({ payload: answer(["row-1", "not-requested"]), ...usage }));
    const result = await classifyEmails(emails(1), callModel, { batchSize: 5 });
    expect([...result.results.keys()]).toEqual(["row-1"]);
  });

  it("drops a row whose category is not in the taxonomy rather than storing it", async () => {
    const callModel = vi.fn(async () => ({
      payload: {
        results: [
          { ...answer(["row-1"]).results[0] },
          { ...answer(["row-2"]).results[0], category: "Chargeback pending" },
        ],
      },
      ...usage,
    }));
    const result = await classifyEmails(emails(2), callModel, { batchSize: 5 });
    expect(result.results.has("row-1")).toBe(true);
    expect(result.unresolvedIds).toEqual(["row-2"]);
  });

  it("makes no call at all for an empty input", async () => {
    const callModel = vi.fn();
    const result = await classifyEmails([], callModel);
    expect(callModel).not.toHaveBeenCalled();
    expect(result).toMatchObject({ batches: 0, unresolvedIds: [] });
  });
});

describe("buildSupportRequestPatch", () => {
  const result = normalizeClassificationEntry({
    id: "row-1",
    category: "Refund",
    secondary_categories: ["Cancellation"],
    language: "es",
    sentiment: "negative",
    urgency: "low",
    confidence: 0.91,
    reason: "\"devuelvan mi dinero\" = wants money back",
  })!;

  it("writes the classification columns and stamps source/version/model", () => {
    const patch = buildSupportRequestPatch(result);
    expect(patch).toMatchObject({
      category: "Refund",
      subcategory: "refund_request",
      secondary_categories: ["Cancellation"],
      language: "es",
      classification_source: "llm",
      classification_version: "support_llm_v2",
      classification_model: CLASSIFICATION_MODEL,
      classification_confidence: 0.91,
    });
    // Urgency floor applied on the way in: a refund is at least medium.
    expect(patch.urgency).toBe("medium");
    expect(patch.requires_refund).toBe(true);
    expect(patch.requires_cancellation).toBe(true);
  });

  it("never touches a manual correction", () => {
    const patch = buildSupportRequestPatch(result);
    for (const column of ["manual_category", "manual_subcategory", "manual_urgency", "manual_changed_at", "manual_changed_by"]) {
      expect(patch).not.toHaveProperty(column);
    }
  });
});

describe("toClassifiableEmails", () => {
  it("skips rows with no text at all — there is nothing to read", () => {
    const out = toClassifiableEmails([
      { id: "a", subject: "Cobro inadecuado", message_body: null },
      { id: "b", subject: null, message_body: "  " },
      { id: "c", subject: "", message_body: "" },
      { id: "d", subject: null, message_body: "Yo no he comprado nada" },
    ]);
    expect(out.map((email) => email.id)).toEqual(["a", "d"]);
  });
});
