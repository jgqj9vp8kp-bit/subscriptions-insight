// Cohorts payment-failure metrics (2026-10-18): declined charges of a cohort's
// users after their trial, for the Cohorts "Users" view.
//
// Same classification as the Users page Decline Analytics (users.ts
// action=decline, paymentFailures.ts classifyDeclineStagesForTransactions) —
// no new classifier:
//   * a failed attempt is a warehouse row with status 'failed' (statusType
//     'failed_payment' in the cohort CTEs), counted from the trial on (d >= 0);
//   * stage = the user's lifecycle level before the attempt (`pre_lvl`): none →
//     after trial (the first subscription charge, or an upsell, failed),
//     1 → after the first subscription, >= 2 → after a renewal;
//   * reason = the stored normalized decline_reason ('' → unknown), grouped
//     below.
// Counts are distinct cohort users. A user with declines of several groups is
// counted in each group — as Decline Analytics counts users per reason — so the
// groups can add up to more than failed_payment_users.
//
// The cohort CTEs expose `dr` (reason of a failed row, '' otherwise) and
// `pre_lvl` on every finx row (cohorts.ts classifierSQL / emailTokenSQL,
// cohortMembership.ts materializedFinxCtes).

export interface CohortPaymentFailureCounts {
  failed_payment_users: number;
  failed_after_trial_users: number;
  failed_after_first_subscription_users: number;
  failed_after_renewal_users: number;
  decline_insufficient_funds_users: number;
  decline_fraud_users: number;
  decline_card_not_supported_users: number;
  decline_do_not_honor_users: number;
  decline_3ds_users: number;
  decline_card_lost_users: number;
  decline_other_users: number;
}

export type CohortPaymentFailureField = keyof CohortPaymentFailureCounts;

export interface CohortDeclineGroup {
  column: CohortPaymentFailureField;
  label: string;
  /** Normalized reasons of the group; null = every reason not listed elsewhere. */
  reasons: readonly string[] | null;
}

export const COHORT_DECLINE_GROUPS: readonly CohortDeclineGroup[] = Object.freeze([
  { column: "decline_insufficient_funds_users", label: "Insufficient Funds", reasons: ["insufficient_funds"] },
  { column: "decline_fraud_users", label: "Fraud Suspected", reasons: ["fraud_suspected"] },
  { column: "decline_card_not_supported_users", label: "Card Not Supported", reasons: ["card_not_supported"] },
  { column: "decline_do_not_honor_users", label: "Do Not Honor / Generic", reasons: ["do_not_honor", "generic_decline"] },
  { column: "decline_3ds_users", label: "3DS Failed", reasons: ["authentication_failed"] },
  { column: "decline_card_lost_users", label: "Card Lost / Stolen / Expired", reasons: ["lost_card", "stolen_card", "expired_card"] },
  { column: "decline_other_users", label: "Other Decline", reasons: null },
]);

export const COHORT_PAYMENT_FAILURE_FIELDS: readonly CohortPaymentFailureField[] = Object.freeze([
  "failed_payment_users",
  "failed_after_trial_users",
  "failed_after_first_subscription_users",
  "failed_after_renewal_users",
  ...COHORT_DECLINE_GROUPS.map((group) => group.column),
]);

const FAILED = "statusType = 'failed_payment'";

function sqlList(values: readonly string[]): string {
  return values.map((value) => `'${value.replace(/'/g, "''")}'`).join(", ");
}

/** Measures appended to AGGREGATE_MEASURES (finx columns uid/statusType/dr/pre_lvl). */
export function paymentFailureMeasuresSQL(): string {
  const listed = COHORT_DECLINE_GROUPS.flatMap((group) => group.reasons ?? []);
  return [
    `uniqExactIf(uid, ${FAILED}) failed_payment_users`,
    `uniqExactIf(uid, ${FAILED} AND pre_lvl = 0) failed_after_trial_users`,
    `uniqExactIf(uid, ${FAILED} AND pre_lvl = 1) failed_after_first_subscription_users`,
    `uniqExactIf(uid, ${FAILED} AND pre_lvl >= 2) failed_after_renewal_users`,
    ...COHORT_DECLINE_GROUPS.map((group) =>
      group.reasons
        ? `uniqExactIf(uid, ${FAILED} AND dr IN (${sqlList(group.reasons)})) ${group.column}`
        : `uniqExactIf(uid, ${FAILED} AND dr NOT IN (${sqlList(listed)})) ${group.column}`,
    ),
  ].join(",\n  ");
}

/** The lifecycle level a row's user had reached BEFORE the row (0 = none),
 * over a CTE carrying uid/ets/tprio/tid/is_success and `lvlExpr`. */
export function preLevelSQL(alias: string, lvlExpr: string): string {
  return `ifNull(max(if(${alias}.is_success = 1, ${lvlExpr}, 0)) OVER (PARTITION BY ${alias}.uid ORDER BY ${alias}.ets, ${alias}.tprio, ${alias}.tid ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0)`;
}

function num(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function paymentFailureCountsFromRaw(row: Record<string, unknown>): CohortPaymentFailureCounts {
  return Object.fromEntries(COHORT_PAYMENT_FAILURE_FIELDS.map((field) => [field, num(row[field])])) as unknown as CohortPaymentFailureCounts;
}

export function sumPaymentFailureCounts(rows: readonly Record<string, unknown>[]): CohortPaymentFailureCounts {
  return Object.fromEntries(
    COHORT_PAYMENT_FAILURE_FIELDS.map((field) => [field, rows.reduce((total, row) => total + num(row[field]), 0)]),
  ) as unknown as CohortPaymentFailureCounts;
}

/** Only the counts a row actually carries (a response cached before these
 * columns shipped has none: the page shows "—", never a false 0). */
export function presentPaymentFailureCounts(row: Partial<Record<string, unknown>>): Partial<CohortPaymentFailureCounts> {
  const out: Partial<CohortPaymentFailureCounts> = {};
  for (const field of COHORT_PAYMENT_FAILURE_FIELDS) {
    const value = row[field];
    if (typeof value === "number" && Number.isFinite(value)) out[field] = value;
  }
  return out;
}

/** Per-field sum over the rows that carry the field; a field no row carries
 * stays absent (Total / funnel rows then show "—" like their cohort rows). */
export function sumPresentPaymentFailureCounts(rows: readonly Partial<CohortPaymentFailureCounts>[]): Partial<CohortPaymentFailureCounts> {
  const out: Partial<CohortPaymentFailureCounts> = {};
  for (const field of COHORT_PAYMENT_FAILURE_FIELDS) {
    let seen = false;
    let total = 0;
    for (const row of rows) {
      const value = row[field];
      if (typeof value === "number" && Number.isFinite(value)) {
        seen = true;
        total += value;
      }
    }
    if (seen) out[field] = total;
  }
  return out;
}
