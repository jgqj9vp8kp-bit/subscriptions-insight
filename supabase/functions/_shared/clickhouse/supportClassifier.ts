// Support classification engine: batches emails, asks the model, validates the
// answer, and turns it into a Postgres patch.
//
// Deliberately transport-free — the caller injects the model call. That keeps
// this module runnable in the unit tests (which must never touch the network)
// and keeps the Anthropic SDK import confined to the Edge Function.
//
// Failure policy: an email whose classification cannot be trusted keeps whatever
// the rules already gave it. Nothing here ever blanks a row, and nothing ever
// writes a manual correction — a human decision outranks every engine.
import {
  SUPPORT_CLASSIFICATION_VERSION_V2,
  buildResponseSchema,
  buildSystemPrompt,
  buildUserPrompt,
  parseClassificationResponse,
  type SupportClassificationResult,
  type SupportEmailToClassify,
} from "./supportTaxonomy.ts";

/** Opus 4.8: the archive is mostly short Spanish with typos and broken
 * encoding, where reading the meaning is the whole job. */
export const CLASSIFICATION_MODEL = "claude-opus-4-8";

/** Emails per model request. 20 keeps one request well inside max_tokens while
 * amortizing the taxonomy prompt across the batch. */
export const DEFAULT_BATCH_SIZE = 20;

export interface ModelCallRequest {
  system: string;
  user: string;
  schema: Record<string, unknown>;
  maxTokens: number;
}

export interface ModelCallResult {
  payload: unknown;
  input_tokens: number;
  output_tokens: number;
}

export type ModelCaller = (request: ModelCallRequest) => Promise<ModelCallResult>;

export interface ClassificationUsage {
  api_requests: number;
  input_tokens: number;
  output_tokens: number;
}

export interface ClassifyEmailsResult {
  results: Map<string, SupportClassificationResult>;
  usage: ClassificationUsage;
  batches: number;
  /** Ids the model did not return a usable answer for. They keep their previous
   * classification and are picked up again on the next run. */
  unresolvedIds: string[];
  errors: string[];
}

export function chunk<T>(items: T[], size: number): T[][] {
  const limit = Math.max(1, Math.floor(size));
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += limit) {
    out.push(items.slice(index, index + limit));
  }
  return out;
}

/** Output budget for one batch: ~120 tokens per email plus slack, so a batch can
 * never be truncated mid-JSON (a truncated response parses to nothing and would
 * waste the whole call). */
export function maxTokensForBatch(batchSize: number): number {
  return Math.min(16000, 1000 + batchSize * 200);
}

export async function classifyEmails(
  emails: SupportEmailToClassify[],
  callModel: ModelCaller,
  options: { batchSize?: number } = {},
): Promise<ClassifyEmailsResult> {
  const results = new Map<string, SupportClassificationResult>();
  const usage: ClassificationUsage = { api_requests: 0, input_tokens: 0, output_tokens: 0 };
  const errors: string[] = [];
  if (!emails.length) return { results, usage, batches: 0, unresolvedIds: [], errors };

  const system = buildSystemPrompt();
  const schema = buildResponseSchema();
  const batches = chunk(emails, options.batchSize ?? DEFAULT_BATCH_SIZE);

  for (const batch of batches) {
    const ids = batch.map((email) => email.id);
    try {
      const response = await callModel({
        system,
        user: buildUserPrompt(batch),
        schema,
        maxTokens: maxTokensForBatch(batch.length),
      });
      usage.api_requests += 1;
      usage.input_tokens += Number(response.input_tokens) || 0;
      usage.output_tokens += Number(response.output_tokens) || 0;
      for (const [id, result] of parseClassificationResponse(response.payload, ids)) {
        results.set(id, result);
      }
    } catch (error) {
      // One failed batch must not lose the batches around it: record and move on.
      usage.api_requests += 1;
      errors.push(error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300));
    }
  }

  const unresolvedIds = emails.map((email) => email.id).filter((id) => !results.has(id));
  return { results, usage, batches: batches.length, unresolvedIds, errors };
}

/** The columns the classification job writes. `manual_*` is absent on purpose:
 * a human correction is never overwritten by re-classification. */
export function buildSupportRequestPatch(
  result: SupportClassificationResult,
  model: string = CLASSIFICATION_MODEL,
): Record<string, unknown> {
  return {
    category: result.category,
    subcategory: result.subcategory,
    secondary_categories: result.secondary_categories,
    language: result.language,
    sentiment: result.sentiment,
    urgency: result.urgency,
    requires_refund: result.flags.requires_refund,
    requires_cancellation: result.flags.requires_cancellation,
    payment_related: result.flags.payment_related,
    delivery_related: result.flags.delivery_related,
    possible_unauthorized_charge: result.flags.possible_unauthorized_charge,
    duplicate_charge: result.flags.duplicate_charge,
    urgent: result.flags.urgent,
    classification_source: "llm",
    classification_version: SUPPORT_CLASSIFICATION_VERSION_V2,
    classification_model: model,
    classification_confidence: result.confidence,
    classification_reason: result.reason,
  };
}

/** Emails as the model sees them. Rows with no text at all are skipped —
 * there is nothing to read, and spending an API call to learn that is waste. */
export function toClassifiableEmails(
  rows: Array<{ id: string; subject: string | null; message_body: string | null }>,
): SupportEmailToClassify[] {
  return rows
    .filter((row) => `${row.subject ?? ""}${row.message_body ?? ""}`.trim().length > 0)
    .map((row) => ({ id: row.id, subject: row.subject, body: row.message_body }));
}
