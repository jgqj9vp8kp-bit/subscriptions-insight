// Payment System Health: the canonical metric dictionary (plan section G) as
// data, plus the pure statistics every tab and alert rule shares (plan P, H):
// Wilson intervals, rates with a sample-size flag, period comparisons and the
// Δcount = Δvolume × rate + volume × Δrate decomposition.
//
// Why data and not prose: the UI's "Data sources" tab, the SQL builders (P2),
// the alert engine (P2.5) and the tests all read the same rows, so a metric
// cannot be defined one way in a tooltip and another way in a query. Every
// entry carries its numerator, denominator, unit, date basis, minimum sample
// and the phase its data arrives in; a metric whose source is not connected
// yet is still listed, because "no data" must be shown as no data, never as
// zero (plan O, Z #11).
//
// Pure module: no Deno globals, no ClickHouse, imported by tests directly.

export const METRIC_KEYS = [
  "attempts",
  "attempt_approval_rate",
  "payment_intent",
  "final_success_rate",
  "chain_first_try_approval_rate",
  "retry_recovery_rate",
  "cascade_recovery",
  "decline_class",
  "decline_mix",
  "issuer_fraud_declines",
  "psp_blocked",
  "fraud_reports",
  "disputes",
  "fraud_disputes",
  "fraud_disputes_lost_or_accepted",
  "confirmed_fraud",
  "dispute_win_rate",
  "refund_rate",
  "support_unauthorized_rate",
  "vamp_estimate",
  "mc_ecp_estimate",
  "retry_compliance",
  "cascade_rows",
  "three_ds_rate",
] as const;

export type MetricKey = (typeof METRIC_KEYS)[number];

export type MetricUnit = "count" | "rate" | "usd" | "class" | "distribution" | "flag";

/** Which date a value is attributed to. Disputes carry two (plan I "double attribution"). */
export type DateBasis =
  | "event_time"
  | "original_payment"
  | "received_at"
  | "received_at_and_original_payment"
  | "rolling_window"
  | "not_applicable";

export type MetricPhase = "P1" | "P2" | "P2.5" | "P3" | "P4" | "P5" | "P6";

export interface MetricDefinition {
  key: MetricKey;
  title: string;
  definition: string;
  numerator: string;
  denominator: string;
  unit: MetricUnit;
  date_basis: DateBasis;
  /** Attempts (or chains, settled payments, ...) below which the rate is flagged "small sample"; null for counts and classes. */
  min_sample: number | null;
  /** The phase whose data makes the metric computable (plan AA). */
  phase: MetricPhase;
  /** A heuristic (chains, estimates) is labelled as such in the UI. */
  heuristic: boolean;
  /** An estimate of a network figure, never the official rate. */
  estimate: boolean;
  notes: string;
}

/** Plan P: significance needs at least this many attempts per period (a parameter). */
export const DEFAULT_MIN_SAMPLE = 200;

/** Plan I: disputes keep arriving for about 120 days after the original payment. */
export const DISPUTE_MATURITY_DAYS = 120;

const RETRY_BAN_NOTE =
  "Attempts after a ban (Visa category 1, Mastercard MAC 03/21, DO_NOT_RETRY, STOP_ALL_PAYMENTS) on the same instrument never count as recovery: they count only as violations (retry_compliance).";

export const PAYMENT_HEALTH_METRICS: readonly MetricDefinition[] = [
  {
    key: "attempts",
    title: "Attempts",
    definition: "Primer rows whose raw_status is SETTLED, DECLINED or FAILED.",
    numerator: "count(rows where raw_status in (SETTLED, DECLINED, FAILED))",
    denominator: "—",
    unit: "count",
    date_basis: "event_time",
    min_sample: null,
    phase: "P1",
    heuristic: false,
    estimate: false,
    notes: "CANCELLED and PENDING are excluded through the raw_status column; the status column is NOT changed (it would turn those rows into cohort anchors).",
  },
  {
    key: "attempt_approval_rate",
    title: "Attempt approval rate",
    definition: "Share of attempts that settled.",
    numerator: "count(raw_status = SETTLED)",
    denominator: "attempts",
    unit: "rate",
    date_basis: "event_time",
    min_sample: DEFAULT_MIN_SAMPLE,
    phase: "P1",
    heuristic: false,
    estimate: false,
    notes: "Attempt level. Payment Pass moves to the same denominator in one release, with a before / after comparison.",
  },
  {
    key: "payment_intent",
    title: "Payment intent (attempt chain)",
    definition: "A chain of attempts with the same key (user_id, payment_instrument_key or currency + amount, price_point, initiation_type) inside a window: CIT 60 minutes, MIT 72 hours (parameters).",
    numerator: "count(chains)",
    denominator: "—",
    unit: "count",
    date_basis: "event_time",
    min_sample: null,
    phase: "P1",
    heuristic: true,
    estimate: false,
    notes: "A heuristic, labelled as such: Primer gives every retry a new orderId. The transaction type is NOT part of the key (it is not recovered for declines).",
  },
  {
    key: "final_success_rate",
    title: "Final success rate",
    definition: "Chains that ended in SETTLED over all chains: the outcome after retries.",
    numerator: "count(chains whose last attempt settled)",
    denominator: "chains",
    unit: "rate",
    date_basis: "event_time",
    min_sample: DEFAULT_MIN_SAMPLE,
    phase: "P1",
    heuristic: true,
    estimate: false,
    notes: "Chain level; compare with attempt_approval_rate to see what retries add.",
  },
  {
    key: "chain_first_try_approval_rate",
    title: "First-try approval rate (chains)",
    definition: "Chains whose first attempt settled over all chains.",
    numerator: "count(chains whose first attempt settled)",
    denominator: "chains",
    unit: "rate",
    date_basis: "event_time",
    min_sample: DEFAULT_MIN_SAMPLE,
    phase: "P1",
    heuristic: true,
    estimate: false,
    notes: "Not the Payment Pass first_attempt_pass_rate (the user's first attempt ever).",
  },
  {
    key: "retry_recovery_rate",
    title: "Retry recovery rate",
    definition: "Chains with a decline that still ended in success, over chains with a decline.",
    numerator: "count(chains with a decline that ended settled, the success not after a ban)",
    denominator: "chains with a decline",
    unit: "rate",
    date_basis: "event_time",
    min_sample: DEFAULT_MIN_SAMPLE,
    phase: "P1",
    heuristic: true,
    estimate: false,
    notes: RETRY_BAN_NOTE,
  },
  {
    key: "cascade_recovery",
    title: "Cascade recovery",
    definition: "Success after the processor changed inside a chain.",
    numerator: "count(chains with a processor switch that ended settled, the success not after a ban)",
    denominator: "chains with a processor switch",
    unit: "rate",
    date_basis: "event_time",
    min_sample: DEFAULT_MIN_SAMPLE,
    phase: "P1",
    heuristic: true,
    estimate: false,
    notes: `UNVERIFIED whether a switch is a Primer cascade or a new customer attempt. ${RETRY_BAN_NOTE}`,
  },
  {
    key: "decline_class",
    title: "Decline class",
    definition: "Mutually exclusive classes in order: issuer result code -> issuer classes; AUTHENTICATION_REQUIRED / 1A -> authentication; AUTHORIZATION_FAILED without an issuer code -> PSP / integration; no processor -> cause not verified.",
    numerator: "one class per decline (declineTaxonomy.ts)",
    denominator: "declines",
    unit: "class",
    date_basis: "event_time",
    min_sample: null,
    phase: "P1",
    heuristic: false,
    estimate: false,
    notes: "The Primer code is used only when no issuer code was relayed; Primer ERROR with an issuer code is an issuer decline.",
  },
  {
    key: "decline_mix",
    title: "Decline mix",
    definition: "Distribution of declines by decline_class, issuer code, Primer code, soft / hard and advised_action.",
    numerator: "count(declines) per bucket",
    denominator: "declines",
    unit: "distribution",
    date_basis: "event_time",
    min_sample: null,
    phase: "P1",
    heuristic: false,
    estimate: false,
    notes: "Soft / hard comes from advised_action, then the advice code, then Primer's declineType.",
  },
  {
    key: "issuer_fraud_declines",
    title: "Issuer fraud-suspicion declines",
    definition: "Declines with issuer code 59, 63 or 83; without an issuer code, Primer SUSPECTED_FRAUD.",
    numerator: "count(declines with issuer code in (59, 63, 83) or, lacking one, Primer SUSPECTED_FRAUD)",
    denominator: "attempts",
    unit: "rate",
    date_basis: "event_time",
    min_sample: DEFAULT_MIN_SAMPLE,
    phase: "P1",
    heuristic: false,
    estimate: false,
    notes: "Declines on the issuer's suspicion, NOT fraud. Lost / stolen (41, 43, Primer LOST_OR_STOLEN_CARD) is a separate line. One code set (declineTaxonomy.ts) for G, H, J and Q. Shown as a count AND a share.",
  },
  {
    key: "psp_blocked",
    title: "PSP blocks",
    definition: "Blocks by PSP rules (Stripe Radar, Adyen Revenue Protect, Primer riskData).",
    numerator: "count(attempts blocked by PSP risk rules)",
    denominator: "attempts",
    unit: "rate",
    date_basis: "event_time",
    min_sample: DEFAULT_MIN_SAMPLE,
    phase: "P5",
    heuristic: false,
    estimate: false,
    notes: "No data before P5 (only a Radar session id reaches us through Primer). Shown as 'source not connected'.",
  },
  {
    key: "fraud_reports",
    title: "Fraud reports (TC40 / SAFE)",
    definition: "Stripe Early Fraud Warnings plus Adyen NOTIFICATION_OF_FRAUD, unique by report key, linked to the payment through the P3a crosswalk.",
    numerator: "count(distinct fraud reports)",
    denominator: "settled payments",
    unit: "rate",
    date_basis: "received_at_and_original_payment",
    min_sample: DEFAULT_MIN_SAMPLE,
    phase: "P3",
    heuristic: false,
    estimate: false,
    notes: "They enter VAMP. Primer does not relay TC40.",
  },
  {
    key: "disputes",
    title: "Disputes",
    definition: "Disputes of type DISPUTE (not RETRIEVAL), unique by the canonical dispute key (plan I).",
    numerator: "count(distinct disputes)",
    denominator: "settled payments",
    unit: "rate",
    date_basis: "received_at_and_original_payment",
    min_sample: DEFAULT_MIN_SAMPLE,
    phase: "P3",
    heuristic: false,
    estimate: false,
    notes: "Counted from Primer DISPUTE.* webhooks only; Stripe and Adyen feeds enrich and reconcile. Reported by receipt date and by original-payment date.",
  },
  {
    key: "fraud_disputes",
    title: "Fraud-coded disputes",
    definition: "Disputes whose reason code is a fraud category (Visa 10.x, Mastercard 4837 / 4863).",
    numerator: "count(disputes with a fraud reason code)",
    denominator: "settled payments",
    unit: "rate",
    date_basis: "received_at_and_original_payment",
    min_sample: DEFAULT_MIN_SAMPLE,
    phase: "P3",
    heuristic: false,
    estimate: false,
    notes: "Reason codes mapped through a reference table.",
  },
  {
    key: "fraud_disputes_lost_or_accepted",
    title: "Fraud disputes lost or accepted",
    definition: "Fraud-coded disputes whose status is LOST or ACCEPTED.",
    numerator: "count(fraud disputes with status in (LOST, ACCEPTED))",
    denominator: "settled payments",
    unit: "rate",
    date_basis: "received_at_and_original_payment",
    min_sample: DEFAULT_MIN_SAMPLE,
    phase: "P3",
    heuristic: false,
    estimate: false,
    notes: "A dispute outcome, not confirmed fraud: friendly fraud or a decision not to contest look the same.",
  },
  {
    key: "confirmed_fraud",
    title: "Confirmed fraud",
    definition: "Cases confirmed manually or by investigation, with author and date.",
    numerator: "count(manually confirmed cases)",
    denominator: "—",
    unit: "count",
    date_basis: "original_payment",
    min_sample: null,
    phase: "P6",
    heuristic: false,
    estimate: false,
    notes: "Manual mark only; never derived from declines or dispute outcomes.",
  },
  {
    key: "dispute_win_rate",
    title: "Dispute win rate",
    definition: "WON over WON + LOST among closed disputes.",
    numerator: "count(disputes WON)",
    denominator: "closed disputes (WON + LOST)",
    unit: "rate",
    date_basis: "received_at",
    min_sample: 30,
    phase: "P3",
    heuristic: false,
    estimate: false,
    notes: "Closed disputes only; ACCEPTED and EXPIRED are reported separately.",
  },
  {
    key: "refund_rate",
    title: "Refund rate",
    definition: "Settled payments with amount_refunded > 0 over settled payments, by the original payment date.",
    numerator: "count(settled payments with amount_refunded > 0)",
    denominator: "settled payments",
    unit: "rate",
    date_basis: "original_payment",
    min_sample: DEFAULT_MIN_SAMPLE,
    phase: "P1",
    heuristic: false,
    estimate: false,
    notes: "All refunds are full today. The refund date is approximated by refund_observed_at (P0 trigger) until the settlement report or the FunnelFox refund webhook (P3 / P6).",
  },
  {
    key: "support_unauthorized_rate",
    title: "Support 'unauthorized charge' rate",
    definition: "Support requests flagged possible_unauthorized_charge over settled payments.",
    numerator: "count(support requests with possible_unauthorized_charge)",
    denominator: "settled payments",
    unit: "rate",
    date_basis: "received_at",
    min_sample: DEFAULT_MIN_SAMPLE,
    phase: "P1",
    heuristic: true,
    estimate: false,
    notes: "An early indicator, not a dispute. PSP / MID attribution: the last SETTLED payment of matched_user_id within N days before received_at (parameter); none -> 'not attributed'. A classification_version change is drawn as a trend break.",
  },
  {
    key: "vamp_estimate",
    title: "VAMP estimate (Visa)",
    definition: "(fraud reports + disputes on Visa) over settled Visa card-not-present payments of the SAME month, keyed by the Visa account: static descriptor part × acquirer country (psp_accounts).",
    numerator: "count(TC40 fraud reports) + count(TC15 disputes), Visa, received in the month",
    denominator: "settled Visa card-not-present payments of the same month",
    unit: "rate",
    date_basis: "received_at",
    min_sample: 1,
    phase: "P4",
    heuristic: false,
    estimate: true,
    notes: "An estimate, not the official rate. A transaction in both TC40 and TC15 counts twice (reproduced on purpose). RDR / pre-dispute and CE 3.0 exclusions cannot be applied without their feeds. Processor breakdown is only a detail.",
  },
  {
    key: "mc_ecp_estimate",
    title: "Mastercard ECP estimate",
    definition: "Mastercard chargebacks of the month over settled Mastercard payments of the PREVIOUS month, per MID.",
    numerator: "count(Mastercard chargebacks received in the month)",
    denominator: "settled Mastercard payments of the previous month",
    unit: "rate",
    date_basis: "received_at",
    min_sample: 1,
    phase: "P4",
    heuristic: false,
    estimate: true,
    notes: "An estimate. Thresholds (ECM / HECM / EFM) come from network_program_thresholds, never hard-coded.",
  },
  {
    key: "retry_compliance",
    title: "Retry compliance",
    definition: "(a) Attempts after Visa category 1 / Mastercard MAC 03, 21 / DO_NOT_RETRY / STOP_ALL_PAYMENTS on the same payment_instrument_key; (b) more than 15 declines in a rolling 30 days per card and MID.",
    numerator: "count(post-ban attempts); count(instrument × MID pairs over the rolling limit)",
    denominator: "instruments",
    unit: "count",
    date_basis: "rolling_window",
    min_sample: null,
    phase: "P1",
    heuristic: false,
    estimate: false,
    notes: "Potential violations, the rules are UNVERIFIED against the network rule books. Split CIT / MIT and same / switched processor. Counted by decline records, not rows. MIT leads to FunnelFox dunning, CIT to the checkout.",
  },
  {
    key: "cascade_rows",
    title: "Cascade rows",
    definition: "Rows with decline_record_count > 1: several decline records inside one Primer payment.",
    numerator: "count(rows with decline_record_count > 1)",
    denominator: "—",
    unit: "count",
    date_basis: "event_time",
    min_sample: null,
    phase: "P1",
    heuristic: false,
    estimate: false,
    notes: "A separate 'cascade / undetermined' bucket in per-PSP rates until Primer's transactions[] is available (P5).",
  },
  {
    key: "three_ds_rate",
    title: "3DS coverage",
    definition: "Attempts where 3DS was performed over attempts, per processor.",
    numerator: "count(attempts with a 3DS result)",
    denominator: "attempts",
    unit: "rate",
    date_basis: "event_time",
    min_sample: DEFAULT_MIN_SAMPLE,
    phase: "P1",
    heuristic: false,
    estimate: false,
    notes: "Coverage is 0.19% (Adyen only). Stripe AUTHENTICATION_REQUIRED declines are shown as missed approvals. Recommendations only towards correct authentication, never around SCA.",
  },
];

const METRICS_BY_KEY: ReadonlyMap<MetricKey, MetricDefinition> = new Map(PAYMENT_HEALTH_METRICS.map((metric) => [metric.key, metric]));

export function metricDefinition(key: MetricKey): MetricDefinition {
  const metric = METRICS_BY_KEY.get(key);
  if (!metric) throw new Error(`unknown payment health metric: ${key}`);
  return metric;
}

export function metricsByPhase(phase: MetricPhase): MetricDefinition[] {
  return PAYMENT_HEALTH_METRICS.filter((metric) => metric.phase === phase);
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

export interface WilsonInterval {
  low: number;
  high: number;
}

const Z_95 = 1.959963984540054;

/** Wilson score interval for a binomial proportion; null without trials. z defaults to the 95% level. */
export function wilsonInterval(successes: number, trials: number, z = Z_95): WilsonInterval | null {
  if (!(trials > 0) || !Number.isFinite(successes) || !Number.isFinite(trials)) return null;
  const n = trials;
  const p = Math.min(Math.max(successes / n, 0), 1);
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denominator;
  const halfWidth = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator;
  // At p = 0 / p = 1 the bound is exactly the edge; the float arithmetic lands a ulp inside it.
  return { low: p === 0 ? 0 : Math.max(0, centre - halfWidth), high: p === 1 ? 1 : Math.min(1, centre + halfWidth) };
}

export interface RateEstimate {
  numerator: number;
  denominator: number;
  /** numerator / denominator in [0, 1]; null when the denominator is 0 (no data, never zero). */
  rate: number | null;
  interval: WilsonInterval | null;
  sample_size: number;
  min_sample: number;
  /** Fewer observations than min_sample: the value is shown, but never called significant. */
  small_sample: boolean;
}

export interface RateOptions {
  minSample?: number;
  z?: number;
}

export function rateWithSample(numerator: number, denominator: number, options: RateOptions = {}): RateEstimate {
  const minSample = options.minSample ?? DEFAULT_MIN_SAMPLE;
  const n = Number.isFinite(denominator) && denominator > 0 ? denominator : 0;
  const k = Number.isFinite(numerator) ? Math.max(0, numerator) : 0;
  return {
    numerator: k,
    denominator: n,
    rate: n > 0 ? Math.min(k / n, 1) : null,
    interval: wilsonInterval(k, n, options.z),
    sample_size: n,
    min_sample: minSample,
    small_sample: n < minSample,
  };
}

export type ChangeDirection = "up" | "down" | "flat" | "unknown";

export type SignificanceReason =
  | "intervals_do_not_overlap"
  | "intervals_overlap"
  | "small_sample"
  | "immature_period"
  | "no_data";

export interface PeriodComparison {
  current: RateEstimate;
  baseline: RateEstimate;
  /** current - baseline, in percentage points; null when either side has no data. */
  delta_points: number | null;
  direction: ChangeDirection;
  /** Both periods reach min_sample, the intervals do not overlap and the period is mature. */
  significant: boolean;
  significance_reason: SignificanceReason;
  immature_period: boolean;
}

export interface ComparisonOptions extends RateOptions {
  /** The current period is still receiving data (manual import lag, dispute maturity): never significant. */
  immature?: boolean;
  /** |delta| at or below this many points is "flat" (default 0). */
  flatThresholdPoints?: number;
}

export interface Fraction {
  numerator: number;
  denominator: number;
}

export function comparePeriods(current: Fraction, baseline: Fraction, options: ComparisonOptions = {}): PeriodComparison {
  const now = rateWithSample(current.numerator, current.denominator, options);
  const then = rateWithSample(baseline.numerator, baseline.denominator, options);
  const immature = options.immature === true;
  const flatThreshold = options.flatThresholdPoints ?? 0;

  let delta: number | null = null;
  let direction: ChangeDirection = "unknown";
  if (now.rate != null && then.rate != null) {
    delta = (now.rate - then.rate) * 100;
    direction = Math.abs(delta) <= flatThreshold ? "flat" : delta > 0 ? "up" : "down";
  }

  let reason: SignificanceReason;
  if (delta == null || !now.interval || !then.interval) reason = "no_data";
  else if (immature) reason = "immature_period";
  else if (now.small_sample || then.small_sample) reason = "small_sample";
  else if (now.interval.low > then.interval.high || then.interval.low > now.interval.high) reason = "intervals_do_not_overlap";
  else reason = "intervals_overlap";

  return {
    current: now,
    baseline: then,
    delta_points: delta,
    direction,
    significant: reason === "intervals_do_not_overlap",
    significance_reason: reason,
    immature_period: immature,
  };
}

export interface VolumeRate {
  /** Volume: attempts, settled payments, ... (the denominator of the rate). */
  volume: number;
  /** The count the rate produces: declines, fraud-coded declines, disputes, ... */
  count: number;
}

export interface CountDecomposition {
  volume_before: number;
  volume_after: number;
  rate_before: number | null;
  rate_after: number | null;
  count_before: number;
  count_after: number;
  delta_count: number;
  /** Δvolume × rate_before: what the volume change alone would have added. */
  volume_effect: number;
  /** volume_after × Δrate: what the rate change added on the new volume. */
  rate_effect: number;
  /** Share of |volume_effect| in |volume_effect| + |rate_effect|; null when both are zero. */
  volume_share: number | null;
}

/**
 * Plan H: Δcount = Δvolume × rate + volume × Δrate, answering "did fraud codes
 * grow because of volume or because of the rate". With rate_before on the
 * volume term and volume_after on the rate term the identity is exact:
 * c_a - c_b = (v_a - v_b) r_b + v_a (r_a - r_b).
 */
export function decomposeCountChange(before: VolumeRate, after: VolumeRate): CountDecomposition {
  const rateBefore = before.volume > 0 ? before.count / before.volume : null;
  const rateAfter = after.volume > 0 ? after.count / after.volume : null;
  const deltaCount = after.count - before.count;
  // Without a rate on either side the whole change is attributed to volume (no rate to compare).
  const volumeEffect = rateBefore != null && rateAfter != null ? (after.volume - before.volume) * rateBefore : deltaCount;
  const rateEffect = rateBefore != null && rateAfter != null ? after.volume * (rateAfter - rateBefore) : 0;
  const magnitude = Math.abs(volumeEffect) + Math.abs(rateEffect);
  return {
    volume_before: before.volume,
    volume_after: after.volume,
    rate_before: rateBefore,
    rate_after: rateAfter,
    count_before: before.count,
    count_after: after.count,
    delta_count: deltaCount,
    volume_effect: volumeEffect,
    rate_effect: rateEffect,
    volume_share: magnitude > 0 ? Math.abs(volumeEffect) / magnitude : null,
  };
}

export interface PeriodFlags {
  /** The period ends after the last imported day: the manual CSV import has not covered it (grey marker). */
  incomplete: boolean;
  /** Disputes / fraud reports for payments in this period are still arriving (maturity marker). */
  immature: boolean;
  days_since_period_end: number;
}

/** Plan P: the last days are incomplete (manual import) and recent payment periods are immature for disputes. */
export function periodFlags(input: { periodEnd: string | Date; lastImportedDay?: string | Date | null; now?: string | Date; maturityDays?: number }): PeriodFlags {
  const end = new Date(input.periodEnd).getTime();
  const now = new Date(input.now ?? Date.now()).getTime();
  const lastImported = input.lastImportedDay == null ? null : new Date(input.lastImportedDay).getTime();
  const maturityDays = input.maturityDays ?? DISPUTE_MATURITY_DAYS;
  const daysSinceEnd = (now - end) / 86_400_000;
  return {
    incomplete: lastImported != null ? end > lastImported : false,
    immature: daysSinceEnd < maturityDays,
    days_since_period_end: daysSinceEnd,
  };
}
