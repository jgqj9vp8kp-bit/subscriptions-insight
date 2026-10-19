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
// The reason groups are computed for every stage (DECLINE_STAGES) and the page
// shows one stage at a time (a switch, default "after trial" — owner decision
// 2026-10-19), so switching never refetches.
// Counts are distinct cohort users. A user with declines of several groups is
// counted in each group — as Decline Analytics counts users per reason — so the
// groups can add up to more than the stage's failed users.
//
// The cohort CTEs expose `dr` (reason of a failed row, '' otherwise) and
// `pre_lvl` on every finx row (cohorts.ts emailTokenSQL,
// cohortMembership.ts materializedFinxCtes).

export type DeclineGroupColumn =
  | "decline_insufficient_funds_users"
  | "decline_fraud_users"
  | "decline_card_not_supported_users"
  | "decline_do_not_honor_users"
  | "decline_3ds_users"
  | "decline_card_lost_users"
  | "decline_other_users";

export type DeclineStage = "trial" | "first_sub" | "renewal" | "all";

/** Field suffix per stage: "after trial" keeps the bare column name. */
const STAGE_SUFFIX = { trial: "", first_sub: "_first_sub", renewal: "_renewal", all: "_all" } as const;
type DeclineStageSuffix = (typeof STAGE_SUFFIX)[DeclineStage];

export type DeclineGroupField = `${DeclineGroupColumn}${DeclineStageSuffix}`;

export type CohortPaymentFailureField =
  | "failed_payment_users"
  | "failed_after_trial_users"
  | "failed_after_first_subscription_users"
  | "failed_after_renewal_users"
  | DeclineGroupField;

export type CohortPaymentFailureCounts = Record<CohortPaymentFailureField, number>;

export interface CohortDeclineGroup {
  column: DeclineGroupColumn;
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

/** Stages the reason groups are split by, in switch order (labels for the page). */
export const DECLINE_STAGES: ReadonlyArray<{ stage: DeclineStage; label: string; condition: string | null }> = Object.freeze([
  { stage: "trial", label: "After trial", condition: "pre_lvl = 0" },
  { stage: "first_sub", label: "After first sub", condition: "pre_lvl = 1" },
  { stage: "renewal", label: "After renewal", condition: "pre_lvl >= 2" },
  { stage: "all", label: "All stages", condition: null },
]);

export const DEFAULT_DECLINE_STAGE: DeclineStage = "trial";

export function isDeclineStage(value: unknown): value is DeclineStage {
  return typeof value === "string" && DECLINE_STAGES.some((entry) => entry.stage === value);
}

/** The data field holding a reason group's count for a stage. */
export function declineGroupField(column: DeclineGroupColumn, stage: DeclineStage): DeclineGroupField {
  return `${column}${STAGE_SUFFIX[stage]}` as DeclineGroupField;
}

export const COHORT_PAYMENT_FAILURE_FIELDS: readonly CohortPaymentFailureField[] = Object.freeze([
  "failed_payment_users",
  "failed_after_trial_users",
  "failed_after_first_subscription_users",
  "failed_after_renewal_users",
  ...DECLINE_STAGES.flatMap(({ stage }) => COHORT_DECLINE_GROUPS.map((group) => declineGroupField(group.column, stage))),
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
    ...DECLINE_STAGES.flatMap(({ stage, condition }) =>
      COHORT_DECLINE_GROUPS.map((group) => {
        const scope = condition ? `${FAILED} AND ${condition}` : FAILED;
        const reason = group.reasons ? `dr IN (${sqlList(group.reasons)})` : `dr NOT IN (${sqlList(listed)})`;
        return `uniqExactIf(uid, ${scope} AND ${reason}) ${declineGroupField(group.column, stage)}`;
      })),
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

/** The row with each reason-group column holding the chosen stage's count —
 * the page projects its rows once, so cells, Total / Funnels sums, sorting and
 * exports all follow the stage switch. "After trial" is the stored shape; a
 * stage the row does not carry (older cache) leaves the column absent ("—"). */
export function projectDeclineStage<T extends Partial<CohortPaymentFailureCounts>>(row: T, stage: DeclineStage): T {
  if (stage === "trial") return row;
  const out: Partial<CohortPaymentFailureCounts> = { ...row };
  for (const group of COHORT_DECLINE_GROUPS) {
    const value = row[declineGroupField(group.column, stage)];
    if (typeof value === "number") out[group.column] = value;
    else delete out[group.column];
  }
  return out as T;
}
