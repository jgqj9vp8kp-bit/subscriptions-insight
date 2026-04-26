import type {
  Funnel,
  TrafficSource,
  Transaction,
  TransactionStatus,
  TransactionType,
} from "./types";

export type RawPalmerRow = Record<string, unknown>;

export interface PalmerMetadata {
  ff_funnel_id?: string;
  ff_campaign_path?: string;
  utm_campaign?: string;
  utm_content?: string;
  utm_source?: string;
  [key: string]: unknown;
}

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const AMOUNTS = {
  trial: 1,
  upsell: 14.98,
  subscription: 29.99,
};

// Palmer exports can use slightly different header names depending on source.
// These aliases keep import tolerant without changing the normalized schema.
const FIELD_ALIASES = {
  transaction_id: ["transaction_id", "transactionid", "transaction id", "id", "payment_id", "charge_id"],
  user_id: ["user_id", "userid", "user id", "customer_id", "customerid", "client_id", "member_id"],
  email: ["email", "user_email", "customer_email", "customer email"],
  event_time: ["event_time", "event time", "created_at", "createdat", "created", "timestamp", "paid_at"],
  amount: ["amount", "amount_cents", "amount in cents", "amount_in_cents", "price", "total"],
  currency: ["currency", "ccy"],
  status: ["status", "state", "result"],
  product: ["product", "product_name", "product name", "plan", "sku"],
  metadata: ["metadata", "meta", "custom_fields", "custom fields", "payload"],
  campaign_id: ["campaign_id", "campaignid", "campaign id", "utm_campaign"],
  traffic_source: ["traffic_source", "traffic source", "utm_source", "source", "channel"],
} as const;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function valueFrom(row: RawPalmerRow, aliases: readonly string[]): string {
  const byKey = new Map(Object.keys(row).map((key) => [normalizeKey(key), key]));
  for (const alias of aliases) {
    const actual = byKey.get(normalizeKey(alias));
    if (actual) {
      const value = row[actual];
      if (value !== undefined && value !== null && String(value).trim() !== "") return String(value);
    }
  }
  return "";
}

function parseEventTime(raw: string): string {
  if (!raw) return new Date(0).toISOString();
  const direct = new Date(raw);
  if (!Number.isNaN(direct.getTime())) return direct.toISOString();
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric > 0) {
    const ms = numeric < 1e12 ? numeric * 1000 : numeric;
    return new Date(ms).toISOString();
  }
  return new Date(0).toISOString();
}

function near(amount: number, target: number): boolean {
  return Math.abs(amount - target) < 0.01;
}

export function normalizeAmount(raw: unknown): number {
  const cleaned = String(raw ?? "").replace(/[^0-9.-]/g, "");
  const cents = Number(cleaned);
  if (!Number.isFinite(cents)) return 0;
  // Palmer exports monetary values in cents: 100 -> 1.00, 1498 -> 14.98.
  return Math.round((cents / 100) * 100) / 100;
}

export function normalizeStatus(raw: unknown): TransactionStatus {
  const value = String(raw ?? "").trim().toUpperCase();
  // Keep Palmer payment states explicit so failed/refund/chargeback analytics
  // do not get mixed into successful subscription revenue.
  if (value === "SETTLED") return "success";
  if (value === "DECLINED") return "failed";
  if (value === "REFUNDED") return "refunded";
  if (value === "CHARGEBACK") return "chargeback";
  if (["SUCCESS", "SUCCEEDED", "PAID", "OK"].includes(value)) return "success";
  if (["FAILED", "FAILURE", "ERROR"].includes(value)) return "failed";
  return "failed";
}

export function parseMetadata(rowOrMetadata: RawPalmerRow | unknown): PalmerMetadata {
  const source =
    typeof rowOrMetadata === "object" && rowOrMetadata !== null && !Array.isArray(rowOrMetadata)
      ? (rowOrMetadata as RawPalmerRow)
      : {};
  const rawMetadata =
    typeof rowOrMetadata === "string"
      ? rowOrMetadata
      : valueFrom(source, FIELD_ALIASES.metadata);

  let parsed: PalmerMetadata = {};
  if (rawMetadata) {
    try {
      const json = JSON.parse(rawMetadata);
      if (json && typeof json === "object" && !Array.isArray(json)) parsed = json as PalmerMetadata;
    } catch {
      parsed = {};
    }
  }

  const merged: PalmerMetadata = { ...parsed };
  // Direct columns win alongside JSON metadata because Palmer exports may
  // flatten marketing fields instead of nesting them under `metadata`.
  for (const key of ["ff_funnel_id", "ff_campaign_path", "utm_campaign", "utm_content", "utm_source"]) {
    const direct = valueFrom(source, [key]);
    if (direct) merged[key] = direct;
  }
  return merged;
}

function detectFunnel(metadata: PalmerMetadata): Funnel {
  const haystack = [
    metadata.ff_funnel_id,
    metadata.ff_campaign_path,
    metadata.utm_campaign,
    metadata.utm_content,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (haystack.includes("soulmate") || haystack.includes("soul_mate")) return "soulmate";
  if (haystack.includes("past_life") || haystack.includes("past-life") || haystack.includes("pastlife")) return "past_life";
  if (haystack.includes("starseed") || haystack.includes("star_seed")) return "starseed";
  // Unknown is intentional. Do not default to past_life; that would pollute cohorts.
  return "unknown";
}

function detectTrafficSource(row: RawPalmerRow, metadata: PalmerMetadata): TrafficSource {
  const raw = `${valueFrom(row, FIELD_ALIASES.traffic_source)} ${metadata.utm_source ?? ""}`.toLowerCase();
  if (raw.includes("facebook") || raw === "fb" || raw.includes("meta")) return "facebook";
  if (raw.includes("tiktok") || raw.includes("tik_tok")) return "tiktok";
  if (raw.includes("google") || raw.includes("adwords")) return "google";
  return "unknown";
}

function failedType(status: TransactionStatus): TransactionType | null {
  if (status === "failed") return "failed_payment";
  if (status === "refunded") return "refund";
  if (status === "chargeback") return "chargeback";
  return null;
}

export function normalizePalmerRows(rows: RawPalmerRow[]): Transaction[] {
  return rows.map((row, index) => {
    const metadata = parseMetadata(row);
    const status = normalizeStatus(valueFrom(row, FIELD_ALIASES.status));
    const normalizedAmount = normalizeAmount(valueFrom(row, FIELD_ALIASES.amount));
    // Refunds and chargebacks reduce collected revenue, so store them as
    // negative money movement after status normalization.
    const amount =
      status === "refunded" || status === "chargeback" ? -Math.abs(normalizedAmount) : normalizedAmount;
    const fallbackType = failedType(status);

    return {
      transaction_id: valueFrom(row, FIELD_ALIASES.transaction_id) || `palmer-row-${index + 1}`,
      user_id: valueFrom(row, FIELD_ALIASES.user_id) || `unknown-user-${index + 1}`,
      email: valueFrom(row, FIELD_ALIASES.email) || "unknown@example.com",
      event_time: parseEventTime(valueFrom(row, FIELD_ALIASES.event_time)),
      amount_usd: amount,
      currency: valueFrom(row, FIELD_ALIASES.currency) || "USD",
      status,
      transaction_type: fallbackType ?? "unknown",
      funnel: detectFunnel(metadata),
      product: valueFrom(row, FIELD_ALIASES.product) || productFromAmount(amount),
      traffic_source: detectTrafficSource(row, metadata),
      campaign_id: valueFrom(row, FIELD_ALIASES.campaign_id) || String(metadata.utm_campaign ?? ""),
      classification_reason: fallbackType ? `${status} Palmer status` : "awaiting user-level classification",
    };
  });
}

export function classifyUserTransactions(rows: Transaction[]): Transaction[] {
  // Classification is user-scoped: the same amount can mean different things
  // depending on whether the user already had a trial or first subscription.
  const byUser = new Map<string, Transaction[]>();
  for (const row of rows) {
    const list = byUser.get(row.user_id) ?? [];
    list.push(row);
    byUser.set(row.user_id, list);
  }

  const classified: Transaction[] = [];
  byUser.forEach((list) => {
    const sorted = [...list].sort((a, b) => new Date(a.event_time).getTime() - new Date(b.event_time).getTime());
    let trialTs: number | null = null;
    let firstSubscriptionSeen = false;

    for (const tx of sorted) {
      const eventTs = new Date(tx.event_time).getTime();
      const statusType = failedType(tx.status);
      let transaction_type: TransactionType = tx.transaction_type;
      let classification_reason = tx.classification_reason;

      if (statusType) {
        transaction_type = statusType;
        classification_reason = `${tx.status} Palmer status`;
      } else if (near(tx.amount_usd, AMOUNTS.trial) && trialTs === null) {
        // First successful $1 payment is considered trial.
        // This is based on current product pricing logic.
        trialTs = eventTs;
        transaction_type = "trial";
        classification_reason = "$1 successful charge is the user's trial";
      } else if (
        trialTs !== null &&
        near(tx.amount_usd, AMOUNTS.upsell) &&
        eventTs >= trialTs &&
        eventTs - trialTs <= HOUR
      ) {
        // Upsell is detected by amount and timing:
        // amount = 14.98 and within 60 minutes after trial.
        transaction_type = "upsell";
        classification_reason = "$14.98 successful charge within 60 minutes of trial";
      } else if (
        trialTs !== null &&
        near(tx.amount_usd, AMOUNTS.subscription) &&
        eventTs - trialTs >= 7 * DAY &&
        !firstSubscriptionSeen
      ) {
        // The first $29.99 charge at least 7 days after trial is the conversion
        // from trial into paid subscription.
        firstSubscriptionSeen = true;
        transaction_type = "first_subscription";
        classification_reason = "$29.99 first successful charge at least 7 days after trial";
      } else if (trialTs !== null && near(tx.amount_usd, AMOUNTS.subscription) && firstSubscriptionSeen) {
        // Later successful $29.99 charges are renewals after the first subscription.
        transaction_type = "renewal";
        classification_reason = "$29.99 successful charge after first subscription";
      } else {
        transaction_type = "unknown";
        classification_reason = "no explicit Palmer classification rule matched";
      }

      classified.push({
        ...tx,
        transaction_type,
        classification_reason,
      });
    }
  });

  return addCohortFields(classified).sort((a, b) => (a.event_time < b.event_time ? 1 : -1));
}

export function addCohortFields(rows: Transaction[]): Transaction[] {
  const trialByUser = new Map<string, Transaction>();
  // Cohorts must be anchored to the user's first successful trial timestamp,
  // not to each transaction's own calendar date.
  for (const tx of [...rows].sort((a, b) => (a.event_time < b.event_time ? -1 : 1))) {
    if (tx.transaction_type === "trial" && tx.status === "success" && !trialByUser.has(tx.user_id)) {
      trialByUser.set(tx.user_id, tx);
    }
  }

  return rows.map((tx) => {
    const trial = trialByUser.get(tx.user_id);
    if (!trial) return { ...tx, transaction_day: null };
    const trialTs = new Date(trial.event_time).getTime();
    const eventTs = new Date(tx.event_time).getTime();
    // Whole days since trial support lifecycle analysis and cohort windows.
    const transactionDay = Math.floor((eventTs - trialTs) / DAY);
    const cohortDate = trial.event_time.slice(0, 10);
    return {
      ...tx,
      cohort_date: cohortDate,
      cohort_id: `${trial.funnel}_${cohortDate}`,
      transaction_day: transactionDay,
    };
  });
}

export function transformPalmerRows(rows: RawPalmerRow[]): Transaction[] {
  return classifyUserTransactions(normalizePalmerRows(rows));
}

function productFromAmount(amount: number): string {
  if (near(amount, AMOUNTS.trial)) return "Trial 7-day";
  if (near(amount, AMOUNTS.upsell)) return "Premium Reading Upsell";
  if (near(amount, AMOUNTS.subscription)) return "Monthly Subscription";
  return "Palmer transaction";
}
