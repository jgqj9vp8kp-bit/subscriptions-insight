/* global Deno */

// Anthropic transport for the support classification job.
//
// Isolated in its own file for one reason: it is the only place that imports the
// SDK over the network. The classification logic in
// _shared/clickhouse/supportClassifier.ts stays transport-free so the unit tests
// can exercise it without an API key or a network call.
import Anthropic from "https://esm.sh/@anthropic-ai/sdk@0.115.0";
import type { ModelCaller, ModelCallRequest, ModelCallResult } from "./clickhouse/supportClassifier.ts";
import { stripUnsupportedSchemaKeywords } from "./clickhouse/structuredOutputSchema.ts";

export function anthropicApiKey(): string | null {
  const key = Deno.env.get("ANTHROPIC_API_KEY")?.trim();
  return key ? key : null;
}

/** Structured outputs make the response shape guaranteed, so the only parsing
 * risk left is a truncated body — which surfaces as a JSON error and is handled
 * by the caller as a failed batch (the affected rows keep their previous
 * classification and are retried on the next run).
 *
 * No `thinking` and `effort: "low"`: deciding whether "stop billing" is a
 * cancellation does not need deliberation, and thinking tokens would dominate
 * the cost of a 2 700-email backfill. */
export function createAnthropicModelCaller(apiKey: string, model: string): ModelCaller {
  const client = new Anthropic({ apiKey });

  return async (request: ModelCallRequest): Promise<ModelCallResult> => {
    const response = await client.messages.create({
      model,
      max_tokens: request.maxTokens,
      system: request.system,
      output_config: {
        effort: "low",
        // The structured-outputs API rejects size/range keywords (maxItems,
        // maxLength, ...) with a 400; builders keep them as documentation and
        // this boundary strips them, mirroring the official SDK helpers.
        format: { type: "json_schema", schema: stripUnsupportedSchemaKeywords(request.schema) },
      },
      messages: [{ role: "user", content: request.user }],
    });

    if (response.stop_reason === "refusal") {
      throw new Error("Model declined to classify this batch.");
    }
    if (response.stop_reason === "max_tokens") {
      throw new Error("Classification response was truncated (max_tokens).");
    }

    const text = response.content
      .filter((block: { type: string }) => block.type === "text")
      .map((block: { text?: string }) => block.text ?? "")
      .join("");
    if (!text.trim()) throw new Error("Model returned an empty classification response.");

    return {
      payload: JSON.parse(text),
      input_tokens: response.usage?.input_tokens ?? 0,
      output_tokens: response.usage?.output_tokens ?? 0,
    };
  };
}
