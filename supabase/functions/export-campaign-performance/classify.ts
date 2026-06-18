// Dependency-free port of the dashboard's user-scoped transaction classifier
// (src/services/palmerTransform.ts classifyUserTransactions + addCohortFields).
//
// This module is imported by BOTH the Deno edge function (index.ts via "./classify.ts") and the
// vitest unit tests. The edge function MUST re-derive transaction_type the same way the in-app
// analytics do, because the warehouse stores per-import-batch classification: a subscription
// imported in a later CSV (with no trial in that file) is stored as "trial". Re-classifying over the
// user's FULL history makes the Export API authoritative and independent of any frontend recalc.

export interface ClassifiableTxn {
  user_id: string;
  transaction_id: string;
  event_time: string;
  status: string;
  transaction_type: string;
  amount_usd?: number;
  gross_amount_usd?: number;
  billing_reason?: string;
  classification_reason?: string;
  campaign_path?: string;
  funnel?: string;
  cohort_date?: string;
  cohort_id?: string;
  transaction_day?: number | null;
}

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const COMMON_UPSELL_AMOUNTS = [14.98];

function near(amount: number, target: number): boolean {
  return Math.abs(amount - target) < 0.01;
}

function failedType(status: string): string | null {
  if (status === "failed") return "failed_payment";
  if (status === "refunded") return "refund";
  if (status === "chargeback") return "chargeback";
  return null;
}

function hasUpsellBillingReason(tx: ClassifiableTxn): boolean {
  return String(tx.billing_reason ?? "").toLowerCase().includes("upsell");
}

function isCommonUpsellAmount(amount: number): boolean {
  return COMMON_UPSELL_AMOUNTS.some((upsellAmount) => near(amount, upsellAmount));
}

function transactionTypePriority(type: string): number {
  if (type === "trial") return 0;
  if (type === "upsell") return 1;
  if (type === "first_subscription") return 2;
  if (type === "renewal_2" || type === "renewal_3" || type === "renewal") return 3;
  return 4;
}

function transactionLifecycleSort(a: ClassifiableTxn, b: ClassifiableTxn): number {
  const byTime = new Date(a.event_time).getTime() - new Date(b.event_time).getTime();
  if (byTime !== 0) return byTime;
  const byType = transactionTypePriority(a.transaction_type) - transactionTypePriority(b.transaction_type);
  if (byType !== 0) return byType;
  return a.transaction_id.localeCompare(b.transaction_id);
}

export function buildCohortId(
  funnel: string | null | undefined,
  campaignPath: string | null | undefined,
  date: string,
): string {
  const normalizedFunnel = String(funnel ?? "").trim() || "unknown";
  const normalizedPath = String(campaignPath ?? "").trim() || "unknown";
  return `${normalizedFunnel}_${normalizedPath}_${date}`;
}

export function addCohortFields<T extends ClassifiableTxn>(rows: T[]): T[] {
  const trialByUser = new Map<string, T>();
  // Cohorts must be anchored to the user's first successful trial timestamp, not each row's own date.
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
    const transactionDay = Math.floor((eventTs - trialTs) / DAY);
    const cohortDate = trial.event_time.slice(0, 10);
    const campaignPath = trial.campaign_path || "unknown";
    return {
      ...tx,
      cohort_date: cohortDate,
      cohort_id: buildCohortId(trial.funnel, campaignPath, cohortDate),
      transaction_day: transactionDay,
    };
  });
}

// User-scoped: the same amount means different things depending on whether the user already had a
// trial or first subscription. Mirrors palmerTransform.classifyUserTransactions exactly.
export function classifyUserTransactions<T extends ClassifiableTxn>(rows: T[]): T[] {
  const byUser = new Map<string, T[]>();
  for (const row of rows) {
    const list = byUser.get(row.user_id) ?? [];
    list.push(row);
    byUser.set(row.user_id, list);
  }

  const classified: T[] = [];
  byUser.forEach((list) => {
    const sorted = [...list].sort(transactionLifecycleSort);
    let trialTs: number | null = null;
    let firstSubscriptionTs: number | null = null;
    let renewal2Ts: number | null = null;
    let renewal3Ts: number | null = null;

    for (const tx of sorted) {
      const eventTs = new Date(tx.event_time).getTime();
      const statusType = failedType(tx.status);
      const isUpsellByMetadata = hasUpsellBillingReason(tx);
      const isUpsellByAmount = isCommonUpsellAmount(tx.amount_usd ?? 0);
      let transaction_type: string = tx.transaction_type;
      let classification_reason = tx.classification_reason ?? "";

      if (statusType) {
        transaction_type = statusType;
        classification_reason = `${tx.status} Palmer status`;
      } else if (trialTs === null && isUpsellByMetadata) {
        transaction_type = "upsell";
        classification_reason = "Metadata ff_billing_reason contains upsell";
      } else if (trialTs === null) {
        trialTs = eventTs;
        transaction_type = "trial";
        classification_reason = "First successful non-upsell payment → trial";
      } else if (
        trialTs !== null &&
        eventTs >= trialTs &&
        eventTs - trialTs <= HOUR &&
        (isUpsellByMetadata || isUpsellByAmount)
      ) {
        transaction_type = "upsell";
        classification_reason = isUpsellByMetadata
          ? "Metadata ff_billing_reason contains upsell"
          : "Common upsell amount within 0–60 minutes after trial";
      } else if (firstSubscriptionTs === null && !isUpsellByMetadata) {
        firstSubscriptionTs = eventTs;
        transaction_type = "first_subscription";
        classification_reason = "Next successful non-upsell payment after trial → first_subscription";
      } else if (renewal2Ts === null && !isUpsellByMetadata) {
        renewal2Ts = eventTs;
        transaction_type = "renewal_2";
        classification_reason = "Second lifecycle payment after first_subscription → renewal_2";
      } else if (renewal3Ts === null && !isUpsellByMetadata) {
        renewal3Ts = eventTs;
        transaction_type = "renewal_3";
        classification_reason = "Third lifecycle payment after first_subscription → renewal_3";
      } else if (!isUpsellByMetadata) {
        transaction_type = "renewal";
        classification_reason = "Later lifecycle payment → renewal";
      } else {
        transaction_type = "upsell";
        classification_reason = "Metadata ff_billing_reason contains upsell";
      }

      classified.push({ ...tx, transaction_type, classification_reason });
    }
  });

  return addCohortFields(classified);
}

// Mirrors src/services/transactionWarehouse.ts hydrateWarehouseTransactionsForAnalytics: only
// palmer_csv rows are re-classified; rows from sources with authoritative transaction_type columns
// (e.g. primer_csv / clean templates) are trusted as-is.
export function classifyWarehouseTransactions<T extends ClassifiableTxn & { source?: string | null }>(
  rows: T[],
): T[] {
  const palmerRows = rows.filter((row) => row.source === "palmer_csv");
  const otherRows = rows.filter((row) => row.source !== "palmer_csv");
  return [...classifyUserTransactions(palmerRows), ...addCohortFields(otherRows)];
}
