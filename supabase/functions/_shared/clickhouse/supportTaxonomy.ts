// Support classification taxonomy v2 — one definition shared by the Edge
// classification job, the ClickHouse sync and the browser UI.
//
// v1 classified by keyword lists and kept ONE category per email. Measured over
// the whole archive that left 60% of rows in "Other/unclear": the misses are
// phrasings, not meanings ("Stop billing" is a cancellation, "no he contratado
// nada" is an unauthorized charge), and 324 emails ask for a cancellation AND a
// refund in the same sentence, so whichever rule sat higher in the list won and
// the second intent vanished from the reports.
//
// v2 therefore: (a) keeps every v1 category so history and saved reports stay
// valid, (b) adds the six categories the corpus actually needs, (c) records a
// primary intent plus the secondary intents the email also expresses.
//
// This module is pure data + pure functions: no network, no Deno/browser APIs,
// so both runtimes and the unit tests import the same file.

export const SUPPORT_CLASSIFICATION_VERSION_V2 = "support_llm_v2";

/** Categories carried over from v1 — unchanged strings on purpose: they are the
 * stored values, the display labels and the filter values all at once. */
export const SUPPORT_CATEGORIES_V1 = [
  "Cancellation",
  "Refund",
  "Unauthorized or unexpected charge",
  "Payment issue",
  "Product/report not received",
  "Product/report question",
  "Technical issue",
  "Subscription question",
  "Duplicate charge",
  "Account/access issue",
  "Complaint",
  "Positive feedback",
  "Spam/unrelated",
  "Other/unclear",
] as const;

/** Added in v2. Each one was read out of the archive, not invented. */
export const SUPPORT_CATEGORIES_ADDED_V2 = [
  "Billing inquiry",
  "Accidental signup",
  "Mailing list unsubscribe",
  "Wrong or unsatisfactory product",
  "Not our customer",
  "Automated notification",
] as const;

export const SUPPORT_CATEGORIES_V2 = [
  ...SUPPORT_CATEGORIES_V1,
  ...SUPPORT_CATEGORIES_ADDED_V2,
] as const;

export type SupportCategoryV2 = (typeof SUPPORT_CATEGORIES_V2)[number];
export type SupportUrgency = "low" | "medium" | "high";
export type SupportSentiment = "negative" | "neutral" | "positive";

export const FALLBACK_CATEGORY: SupportCategoryV2 = "Other/unclear";

/** Machine key stored alongside the category. v1 keys are preserved exactly so
 * existing rows, filters and exports keep matching. */
export const SUBCATEGORY_BY_CATEGORY: Record<SupportCategoryV2, string> = {
  "Cancellation": "cancel_subscription",
  "Refund": "refund_request",
  "Unauthorized or unexpected charge": "unknown_charge",
  "Payment issue": "charged_but_order_failed",
  "Product/report not received": "delayed_delivery",
  "Product/report question": "delivery_timing_question",
  "Technical issue": "other_technical",
  "Subscription question": "subscription_question",
  "Duplicate charge": "duplicate_charge",
  "Account/access issue": "access_problem",
  "Complaint": "general_complaint",
  "Positive feedback": "positive_feedback",
  "Spam/unrelated": "spam",
  "Other/unclear": "other_unclear",
  "Billing inquiry": "billing_inquiry",
  "Accidental signup": "accidental_signup",
  "Mailing list unsubscribe": "mailing_list_unsubscribe",
  "Wrong or unsatisfactory product": "wrong_product",
  "Not our customer": "not_our_customer",
  "Automated notification": "automated_notification",
};

/** One line per category, used both as the model's instructions and as the
 * documentation of what each bucket means. Kept in the same order as the
 * category list so the prompt reads top-down. */
export const CATEGORY_GUIDE: Record<SupportCategoryV2, string> = {
  "Cancellation": "wants the subscription/recurring billing stopped — including \"stop charging me\", \"stop billing\", \"dar de baja mi suscripción\"",
  "Refund": "wants money already taken to be given back",
  "Unauthorized or unexpected charge": "asserts they never authorized or never ordered this — \"I did not sign up\", \"no he contratado nada\", \"no autoricé\"",
  "Payment issue": "a payment failed, was declined, or went through without the order completing",
  "Product/report not received": "paid but the reading/portrait/report never arrived",
  "Product/report question": "asks about the product itself or when it will arrive, without a complaint",
  "Technical issue": "site, app, link or download does not work",
  "Subscription question": "asks how the subscription/plan/renewal works, without asking to cancel",
  "Duplicate charge": "charged twice for the same thing",
  "Account/access issue": "cannot log in, access the account, or reset a password",
  "Complaint": "expresses anger or calls it a scam without a concrete actionable request",
  "Positive feedback": "thanks or praise",
  "Spam/unrelated": "marketing, SEO offers, crypto, phishing — unrelated to the product",
  "Other/unclear": "no discernible intent — use ONLY when nothing else fits",
  "Billing inquiry": "does not dispute the charge, asks what it was or why it happened — \"why was I billed?\", \"what did I purchase?\", a bare amount like \"$29.99\"",
  "Accidental signup": "says they signed up or ordered by mistake — \"I didn't mean to sign up\", \"realicé la encuesta mal\"",
  "Mailing list unsubscribe": "wants to stop receiving EMAILS, not to cancel a paid subscription — \"quiero dar de baja mi correo electrónico\", \"remove me from your list\"",
  "Wrong or unsatisfactory product": "received the product but it is wrong or unsatisfying — wrong gender, \"doesn't look like anyone\"",
  "Not our customer": "the email is about someone else's merchant or order and reached us by mistake",
  "Automated notification": "machine-generated — delivery failure notices, mailer-daemon bounces, out-of-office autoreplies",
};

const CATEGORY_SET = new Set<string>(SUPPORT_CATEGORIES_V2);

/** Tolerant lookup for a category string coming back from the model or from a
 * legacy row: exact match first, then case/spacing-insensitive, then a small
 * alias table. Anything unrecognized returns null so the caller can fall back
 * rather than writing an invented category into the warehouse. */
const CATEGORY_ALIASES: Record<string, SupportCategoryV2> = {
  "unauthorized charge": "Unauthorized or unexpected charge",
  "unauthorized or unexpected charge": "Unauthorized or unexpected charge",
  "unknown charge": "Unauthorized or unexpected charge",
  "product not received": "Product/report not received",
  "report not received": "Product/report not received",
  "product question": "Product/report question",
  "report question": "Product/report question",
  "spam": "Spam/unrelated",
  "spam or unrelated": "Spam/unrelated",
  "other": "Other/unclear",
  "unclear": "Other/unclear",
  "unknown": "Other/unclear",
  "account issue": "Account/access issue",
  "access issue": "Account/access issue",
  "wrong product": "Wrong or unsatisfactory product",
  "unsubscribe": "Mailing list unsubscribe",
  "bounce": "Automated notification",
  "misdirected": "Not our customer",
};

export function normalizeCategory(value: string | null | undefined): SupportCategoryV2 | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (CATEGORY_SET.has(trimmed)) return trimmed as SupportCategoryV2;
  const loose = trimmed.toLowerCase().replace(/\s+/g, " ");
  for (const category of SUPPORT_CATEGORIES_V2) {
    if (category.toLowerCase() === loose) return category;
  }
  return CATEGORY_ALIASES[loose] ?? null;
}

// ---------------------------------------------------------------------------
// Derived flags — computed from the categories, never taken from the model
// ---------------------------------------------------------------------------

const has = (categories: SupportCategoryV2[], ...wanted: SupportCategoryV2[]) =>
  categories.some((category) => wanted.includes(category));

export interface SupportClassificationFlags {
  requires_refund: boolean;
  requires_cancellation: boolean;
  payment_related: boolean;
  delivery_related: boolean;
  possible_unauthorized_charge: boolean;
  duplicate_charge: boolean;
  urgent: boolean;
}

/** The boolean columns stay derivable from the taxonomy so they can never
 * disagree with the categories — a filter on "requires refund" and a filter on
 * the Refund category must select the same rows. */
export function deriveFlags(all: SupportCategoryV2[], urgency: SupportUrgency): SupportClassificationFlags {
  const possible_unauthorized_charge = has(all, "Unauthorized or unexpected charge");
  const duplicate_charge = has(all, "Duplicate charge");
  const requires_refund = has(all, "Refund");
  const requires_cancellation = has(all, "Cancellation", "Accidental signup");
  return {
    requires_refund,
    requires_cancellation,
    possible_unauthorized_charge,
    duplicate_charge,
    payment_related:
      possible_unauthorized_charge || duplicate_charge || requires_refund ||
      has(all, "Payment issue", "Billing inquiry"),
    delivery_related: has(all, "Product/report not received", "Wrong or unsatisfactory product"),
    urgent: urgency === "high",
  };
}

const URGENCY_RANK: Record<SupportUrgency, number> = { low: 0, medium: 1, high: 2 };

/** Money already disputed outranks whatever the model felt about tone: a
 * chargeback-shaped email is high priority even when politely worded. This is
 * the same floor the v1 rules applied, kept so the "High" column stays
 * comparable across the re-classification. */
export function applyUrgencyFloor(urgency: SupportUrgency, all: SupportCategoryV2[]): SupportUrgency {
  const floor: SupportUrgency = has(all, "Unauthorized or unexpected charge", "Duplicate charge")
    ? "high"
    : has(all, "Refund", "Cancellation", "Product/report not received", "Payment issue")
      ? "medium"
      : "low";
  return URGENCY_RANK[floor] > URGENCY_RANK[urgency] ? floor : urgency;
}

// ---------------------------------------------------------------------------
// Model contract
// ---------------------------------------------------------------------------

export interface SupportEmailToClassify {
  id: string;
  subject: string | null;
  body: string | null;
}

export interface SupportClassificationResult {
  id: string;
  category: SupportCategoryV2;
  subcategory: string;
  secondary_categories: SupportCategoryV2[];
  language: string;
  sentiment: SupportSentiment;
  urgency: SupportUrgency;
  confidence: number;
  reason: string;
  flags: SupportClassificationFlags;
}

/** Emails are pasted into the prompt verbatim. Truncation keeps a runaway
 * forwarded thread from blowing up one batch; the intent is always in the first
 * lines (measured: average body is 308 characters). */
export const MAX_SUBJECT_CHARS = 300;
export const MAX_BODY_CHARS = 1500;

export function buildSystemPrompt(): string {
  const categories = SUPPORT_CATEGORIES_V2
    .map((category) => `- ${category}: ${CATEGORY_GUIDE[category]}`)
    .join("\n");
  return [
    "You classify customer support emails for a consumer subscription product (astrology/soulmate readings sold through paid funnels).",
    "",
    "Most emails are short, many are Spanish, and they are full of typos, missing accents and mojibake (�). Some have an empty subject or an empty body — classify from whatever text exists. Judge the meaning, never the presence of a keyword.",
    "",
    "CATEGORIES:",
    categories,
    "",
    "RULES:",
    "1. `category` is the single intent the customer most wants acted on. If they ask to cancel AND to be refunded, the money request is primary (Refund) and Cancellation goes in `secondary_categories`.",
    "2. `secondary_categories` lists other intents the email genuinely expresses. Usually empty. Never repeat the primary category.",
    "3. \"Unauthorized or unexpected charge\" means the customer denies authorizing it. If they merely do not recognize or understand a charge and are asking what it was, that is \"Billing inquiry\".",
    "4. \"Mailing list unsubscribe\" is about receiving emails. Cancelling a paid subscription is \"Cancellation\". Do not confuse them.",
    "5. \"Other/unclear\" is a last resort. Use it only when no intent can be read at all.",
    "6. `language` is the ISO 639-1 code of the customer's own text (\"en\", \"es\", \"pt\", \"ru\", …), or \"unknown\" if there is not enough text.",
    "7. `urgency`: high = money disputed, chargeback/legal/police threatened, or repeated failed attempts to get help; medium = wants money back or wants to cancel; low = questions, praise, noise.",
    "8. `confidence` is 0..1 for the primary category. Be honest: short or ambiguous emails deserve low confidence.",
    "9. `reason` is one short English clause quoting the decisive words, e.g. `\"stop billing\" = wants recurring charges stopped`.",
    "",
    "Return one object per input email, in the same order, echoing each `id` exactly.",
  ].join("\n");
}

export function buildUserPrompt(emails: SupportEmailToClassify[]): string {
  const blocks = emails.map((email, index) => {
    const subject = (email.subject ?? "").slice(0, MAX_SUBJECT_CHARS).trim() || "(no subject)";
    const body = (email.body ?? "").slice(0, MAX_BODY_CHARS).trim() || "(no body)";
    return `### Email ${index + 1}\nid: ${email.id}\nsubject: ${subject}\nbody:\n${body}`;
  });
  return `Classify these ${emails.length} emails.\n\n${blocks.join("\n\n")}`;
}

/** JSON Schema for structured outputs. `additionalProperties: false` plus a
 * full `required` list is what makes the response shape guaranteed. */
export function buildResponseSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["results"],
    properties: {
      results: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "category", "secondary_categories", "language", "sentiment", "urgency", "confidence", "reason"],
          properties: {
            id: { type: "string" },
            category: { type: "string", enum: [...SUPPORT_CATEGORIES_V2] },
            secondary_categories: {
              type: "array",
              items: { type: "string", enum: [...SUPPORT_CATEGORIES_V2] },
            },
            language: { type: "string" },
            sentiment: { type: "string", enum: ["negative", "neutral", "positive"] },
            urgency: { type: "string", enum: ["low", "medium", "high"] },
            confidence: { type: "number" },
            reason: { type: "string" },
          },
        },
      },
    },
  };
}

const SENTIMENTS = new Set(["negative", "neutral", "positive"]);
const URGENCIES = new Set(["low", "medium", "high"]);

function normalizeLanguage(value: unknown): string {
  if (typeof value !== "string") return "unknown";
  const code = value.trim().toLowerCase().slice(0, 5);
  if (!code || code === "und" || code === "unk") return "unknown";
  return /^[a-z]{2}(-[a-z]{2})?$/.test(code) || code === "unknown" ? code : "unknown";
}

function clampConfidence(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.min(1, Math.max(0, Math.round(numeric * 10000) / 10000));
}

/** Turn one raw model object into a stored result, or null when it cannot be
 * trusted. Schema-valid output still goes through this: an unknown category
 * string or a missing id must degrade to the rules result, never be persisted
 * as an invented value (nothing in Postgres or ClickHouse constrains these
 * columns, so this function IS the constraint). */
export function normalizeClassificationEntry(entry: unknown): SupportClassificationResult | null {
  if (!entry || typeof entry !== "object") return null;
  const raw = entry as Record<string, unknown>;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!id) return null;
  const category = normalizeCategory(raw.category as string);
  if (!category) return null;

  const secondarySource = Array.isArray(raw.secondary_categories) ? raw.secondary_categories : [];
  const secondary: SupportCategoryV2[] = [];
  for (const candidate of secondarySource) {
    const normalized = normalizeCategory(candidate as string);
    // A secondary that repeats the primary, is unrecognized, or is the
    // catch-all adds nothing — drop it instead of storing noise.
    if (!normalized || normalized === category || normalized === FALLBACK_CATEGORY) continue;
    if (!secondary.includes(normalized)) secondary.push(normalized);
  }

  const all = [category, ...secondary];
  const sentiment = SENTIMENTS.has(String(raw.sentiment)) ? (raw.sentiment as SupportSentiment) : "neutral";
  const modelUrgency = URGENCIES.has(String(raw.urgency)) ? (raw.urgency as SupportUrgency) : "low";
  const urgency = applyUrgencyFloor(modelUrgency, all);

  return {
    id,
    category,
    subcategory: SUBCATEGORY_BY_CATEGORY[category],
    secondary_categories: secondary,
    language: normalizeLanguage(raw.language),
    sentiment,
    urgency,
    confidence: clampConfidence(raw.confidence),
    reason: typeof raw.reason === "string" ? raw.reason.trim().slice(0, 500) : "",
    flags: deriveFlags(all, urgency),
  };
}

/** Parse a whole model response into a map keyed by email id. Entries for ids
 * that were not requested are dropped: the caller writes only rows it asked
 * about, so a hallucinated id cannot touch an unrelated email. */
export function parseClassificationResponse(
  payload: unknown,
  requestedIds: string[],
): Map<string, SupportClassificationResult> {
  const wanted = new Set(requestedIds);
  const results = new Map<string, SupportClassificationResult>();
  const container = payload && typeof payload === "object" ? (payload as Record<string, unknown>).results : null;
  if (!Array.isArray(container)) return results;
  for (const entry of container) {
    const normalized = normalizeClassificationEntry(entry);
    if (!normalized || !wanted.has(normalized.id) || results.has(normalized.id)) continue;
    results.set(normalized.id, normalized);
  }
  return results;
}
