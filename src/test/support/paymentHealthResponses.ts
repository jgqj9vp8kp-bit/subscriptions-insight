// Synthetic clickhouse-payment-health responses for the frontend tests (the
// page, the data source, the hooks). Shapes follow paymentHealthContract.ts;
// the numbers are small and distinctive so an assertion names what it reads.
// The sentinels are what the page must never show: a raw MID, a raw
// descriptor, an instrument token, a transaction id and an e-mail — they are
// planted in fields the page is not supposed to read (extra keys) so the leak
// scan proves the tables render labels only.

import type {
  AttemptTotals,
  BreakdownRow,
  DeclinesResponse,
  MerchantAccountRef,
  OptionsResponse,
  OverviewResponse,
  PaymentHealthMeta,
  PspMidRow,
  RefundsSupportResponse,
  RetriesResponse,
  SourcesResponse,
  TrendPoint,
} from "../../../supabase/functions/_shared/clickhouse/paymentHealthContract";
import type { PeriodComparison, RateEstimate } from "../../../supabase/functions/_shared/clickhouse/paymentHealthMetrics";
import { SENTINEL_EMAILS } from "./leakScan";

export const UI_SENTINELS = {
  rawMid: "MID-RAW-SENTINEL-4471",
  rawDescriptor: "SENTINEL*RAW*DESCRIPTOR",
  instrumentToken: "pi-sentinel-token-9f8e",
  transactionId: "tx-sentinel-0042",
  email: SENTINEL_EMAILS[0],
} as const;

export function rate(numerator: number, denominator: number, minSample = 200): RateEstimate {
  const r = denominator > 0 ? numerator / denominator : null;
  return {
    numerator,
    denominator,
    rate: r,
    interval: r == null ? null : { low: Math.max(0, r - 0.05), high: Math.min(1, r + 0.05) },
    sample_size: denominator,
    min_sample: minSample,
    small_sample: denominator < minSample,
  };
}

/** Like comparePeriods: an immature comparison is never significant, whatever `significant` says. */
export function comparison(current: [number, number], baseline: [number, number], options: { significant?: boolean; immature?: boolean } = {}): PeriodComparison {
  const now = rate(current[0], current[1]);
  const then = rate(baseline[0], baseline[1]);
  const delta = now.rate != null && then.rate != null ? (now.rate - then.rate) * 100 : null;
  const direction = delta == null ? "unknown" : delta === 0 ? "flat" : delta > 0 ? "up" : "down";
  const significant = options.significant === true && options.immature !== true;
  return {
    current: now,
    baseline: then,
    delta_points: delta,
    direction,
    significant,
    significance_reason: delta == null ? "no_data" : options.immature ? "immature_period" : significant ? "intervals_do_not_overlap" : now.small_sample || then.small_sample ? "small_sample" : "intervals_overlap",
    immature_period: options.immature === true,
  };
}

export function totals(over: Partial<AttemptTotals> = {}): AttemptTotals {
  return {
    attempts: 1000,
    successes: 820,
    declines: 180,
    settled_amount_usd: 41000,
    refunded: 24,
    refund_amount_usd: 1200,
    issuer_fraud_declines: 12,
    lost_stolen_declines: 3,
    authentication_declines: 5,
    psp_integration_declines: 2,
    cause_unverified_declines: 7,
    cascade_rows: 4,
    three_ds_attempts: 150,
    ...over,
  };
}

export function meta(action: PaymentHealthMeta["action"], over: Partial<PaymentHealthMeta> = {}): PaymentHealthMeta {
  return {
    action,
    generated_at: "2026-10-12T10:00:00.000Z",
    range: { from: "2026-09-13", to: "2026-10-12", days: 30 },
    compare: { from: "2026-08-14", to: "2026-09-12", days: 30 },
    data_through: "2026-10-10",
    incomplete: true,
    lag_days: 2,
    funnel_attribution: { status: "active", basis: "cohort_anchor", note: "Funnel is the user's acquisition anchor." },
    country_basis: "issuer_country",
    country_basis_label: "Issuer country (BIN)",
    psp_global_visible: true,
    limited: {},
    estimates: ["Attempt chains are a heuristic (Primer gives every retry a new orderId).", "Network re-attempt rules come from secondary sources (UNVERIFIED): potential violations, not fines."],
    definitions: ["attempts", "attempt_approval_rate"],
    query_duration_ms: 42,
    ...over,
  };
}

const STRIPE_MID: MerchantAccountRef = { key: "11111111-2222-4333-8444-555555555555", label: "Stripe MID #1", processor: "STRIPE", labelled: true };
const ADYEN_MID_UNLABELLED: MerchantAccountRef = { key: "unlabelled:0123456789abcdef", label: "Unlabelled MID", processor: "ADYEN", labelled: false };

function trend(): TrendPoint[] {
  return [
    { bucket: "2026-10-08", attempts: 40, successes: 33, declines: 7, approval_rate: 0.825, issuer_fraud_declines: 1, settled_amount_usd: 1600, incomplete: false },
    { bucket: "2026-10-09", attempts: 44, successes: 35, declines: 9, approval_rate: 0.795, issuer_fraud_declines: 0, settled_amount_usd: 1700, incomplete: false },
    { bucket: "2026-10-10", attempts: 38, successes: 31, declines: 7, approval_rate: 0.816, issuer_fraud_declines: 2, settled_amount_usd: 1500, incomplete: false },
    { bucket: "2026-10-11", attempts: 0, successes: 0, declines: 0, approval_rate: null, issuer_fraud_declines: 0, settled_amount_usd: 0, incomplete: true },
  ];
}

// The fixture window is incomplete (meta.incomplete: data through 2026-10-10,
// range to 2026-10-12), so every comparison of the overview is immature: the
// server never calls such a comparison significant, and neither does this.
function pspRow(processor: string, account: MerchantAccountRef, over: Partial<PspMidRow> = {}): PspMidRow {
  return {
    processor: { key: processor, label: processor === "STRIPE" ? "Stripe" : "Adyen" },
    merchant_account: account,
    current: totals(),
    baseline: totals({ attempts: 900, successes: 760, declines: 140 }),
    approval: comparison([820, 1000], [760, 900], { immature: true }),
    issuer_fraud_share: comparison([12, 1000], [9, 900], { immature: true }),
    refund_rate: comparison([24, 820], [20, 760], { immature: true }),
    decline_classes: { insufficient_funds: 90, issuer_suspected_fraud: 12, cause_unverified: 7 },
    complaints_unauthorized: { current: 3, baseline: 1 },
    // Over the account's UNFILTERED settled payments (820 / 760), server-computed.
    complaint_rate: comparison([3, 820], [1, 760], { immature: true }),
    trend: trend(),
    ...over,
  };
}

export function overviewResponse(over: { pspVisible?: boolean } = {}): OverviewResponse {
  const pspVisible = over.pspVisible ?? true;
  return {
    ok: true,
    action: "overview",
    meta: { ...meta("overview", { psp_global_visible: pspVisible }), trend_granularity: "day" },
    totals: {
      current: totals(),
      baseline: totals({ attempts: 900, successes: 760, declines: 140, refunded: 20 }),
      approval: comparison([820, 1000], [760, 900], { immature: true }),
      issuer_fraud_share: comparison([12, 1000], [9, 900], { immature: true }),
      refund_rate: comparison([24, 820], [20, 760], { immature: true }),
      decline_classes: { insufficient_funds: 90, issuer_suspected_fraud: 12, lost_stolen: 3, authentication: 5, psp_integration: 2, cause_unverified: 7, other_issuer: 61 },
      complaints_unauthorized: { current: 5, baseline: 2, unattributed_current: 1, unattributed_baseline: 0 },
      support_unauthorized_rate: comparison([5, 820], [2, 760], { immature: true }),
    },
    trend: trend(),
    psp_mid_rows: pspVisible
      ? [
          pspRow("STRIPE", STRIPE_MID),
          // A row whose baseline has no attempts: its rates must read "no data".
          pspRow("ADYEN", ADYEN_MID_UNLABELLED, {
            current: totals({ attempts: 0, successes: 0, declines: 0, settled_amount_usd: 0, refunded: 0, refund_amount_usd: 0 }),
            baseline: totals({ attempts: 0, successes: 0, declines: 0 }),
            approval: comparison([0, 0], [0, 0]),
            issuer_fraud_share: comparison([0, 0], [0, 0]),
            refund_rate: comparison([0, 0], [0, 0]),
            decline_classes: {},
            complaints_unauthorized: { current: 0, baseline: 0 },
            complaint_rate: comparison([0, 0], [0, 0]),
            trend: [],
          }),
        ]
      : [],
    what_changed: [
      {
        dimension: "country",
        value: { key: "DE", label: "DE" },
        decomposition: { volume_before: 300, volume_after: 400, rate_before: 0.1, rate_after: 0.2, count_before: 30, count_after: 80, delta_count: 50, volume_effect: 10, rate_effect: 40, volume_share: 0.2 },
      },
      ...(pspVisible
        ? [{
            dimension: "processor" as const,
            value: { key: "STRIPE", label: "Stripe" },
            decomposition: { volume_before: 900, volume_after: 1000, rate_before: 0.155, rate_after: 0.18, count_before: 140, count_after: 180, delta_count: 40, volume_effect: 15.5, rate_effect: 24.5, volume_share: 0.39 },
          }]
        : []),
    ],
  };
}

function breakdown(dimension: BreakdownRow["dimension"], key: string, label: string, over: Partial<BreakdownRow> = {}): BreakdownRow {
  return {
    dimension,
    value: { key, label },
    current: totals(),
    baseline: totals({ attempts: 900, successes: 760, declines: 140 }),
    approval: comparison([820, 1000], [760, 900]),
    issuer_fraud_share: comparison([12, 1000], [9, 900]),
    refund_rate: comparison([24, 820], [20, 760]),
    decline_classes: { insufficient_funds: 90, issuer_suspected_fraud: 12 },
    ...over,
  };
}

export function declinesResponse(over: { dimension?: DeclinesResponse["dimension"]; pspVisible?: boolean } = {}): DeclinesResponse {
  const dimension = over.dimension ?? "processor";
  return {
    ok: true,
    action: "declines",
    meta: meta("declines", { psp_global_visible: over.pspVisible ?? true }),
    dimension,
    totals: {
      current: totals(),
      baseline: totals({ attempts: 900, successes: 760, declines: 140 }),
      approval: comparison([820, 1000], [760, 900]),
      issuer_fraud_share: comparison([12, 1000], [9, 900]),
      refund_rate: comparison([24, 820], [20, 760]),
    },
    by_class: [
      { decline_class: "insufficient_funds", label: "Insufficient funds", current: 90, baseline: 70, share_of_declines: 0.5, rate: comparison([90, 1000], [70, 900]) },
      { decline_class: "issuer_suspected_fraud", label: "Issuer suspected fraud (decline, not fraud)", current: 12, baseline: 9, share_of_declines: 12 / 180, rate: comparison([12, 1000], [9, 900]) },
    ],
    by_dimension:
      dimension === "processor"
        ? [breakdown("processor", "STRIPE", "Stripe"), breakdown("processor", "unrouted", "Unrouted")]
        : [breakdown(dimension, "soulmate-sketch", "soulmate-sketch"), breakdown(dimension, "unattributed", "Unattributed")],
    code_mix: [
      { decline_class: "insufficient_funds", issuer_result_code: "51", primer_decline_code: "INSUFFICIENT_FUNDS", advised_action: "RETRY_LATER", advice_code: "02", severity: "soft", retry_guidance: "retry_later", retry_ban: false, current: 90, baseline: 70 },
      { decline_class: "issuer_suspected_fraud", issuer_result_code: "59", primer_decline_code: "SUSPECTED_FRAUD", advised_action: "DO_NOT_RETRY", advice_code: "03", severity: "hard", retry_guidance: "do_not_retry", retry_ban: true, current: 12, baseline: 9 },
    ],
    severity: { current: { soft: 120, hard: 40, unknown: 20 }, baseline: { soft: 100, hard: 30, unknown: 10 } },
  };
}

export function retriesResponse(over: { pspVisible?: boolean; limited?: boolean } = {}): RetriesResponse {
  const pspVisible = over.pspVisible ?? true;
  return {
    ok: true,
    action: "retries",
    meta: {
      ...meta("retries", { psp_global_visible: pspVisible, limited: over.limited ? { attempt_rows: true } : {} }),
      rows_window: { from: "2026-08-14", to: "2026-10-12", days: 60 },
      rows_read: 2400,
      memo: "miss",
      chain_options: { cit_window_minutes: 60, mit_window_hours: 72, rolling_window_days: 30, rolling_decline_limit: 15 },
    },
    chains: {
      rows: 2400,
      attempts: 2300,
      not_attempts: 100,
      chains: 1800,
      chains_first_try_success: 1500,
      chains_final_success: 1620,
      chains_with_decline: 300,
      chains_recovered: 120,
      chains_post_ban_success: 4,
      chains_cascade: 20,
      chains_cascade_recovered: 8,
      chains_singleton: 15,
      cascade_rows: 22,
      final_success_rate: rate(1620, 1800),
      chain_first_try_approval_rate: rate(1500, 1800),
      retry_recovery_rate: rate(120, 300),
      cascade_recovery: rate(8, 20),
      attempt_approval_rate: rate(1900, 2300),
    },
    post_ban: {
      banned_instruments: 40,
      retried_instruments: 9,
      attempts: 14,
      cit: 5,
      mit: 8,
      unknown_initiation: 1,
      same_processor: 10,
      switched_processor: 3,
      unknown_processor: 1,
      succeeded: 2,
      succeeded_switched_processor: 1,
      within_one_hour: 6,
      within_window: 12,
    },
    post_ban_attempts: [
      {
        instrument: "a1b2c3d4e5f60718",
        ban_event_time: "2026-10-01T08:00:00.000Z",
        ban_sources: ["advised_action", "visa_category_1"],
        ban_decline_class: "issuer_suspected_fraud",
        event_time: "2026-10-01T09:30:00.000Z",
        minutes_since_ban: 90,
        initiation_type: "mit",
        processor_relation: "same",
        succeeded: false,
        banned_again: true,
        processor: pspVisible ? { key: "STRIPE", label: "Stripe" } : null,
        merchant_account: pspVisible ? STRIPE_MID : null,
      },
      {
        instrument: "ffee00112233aabb",
        ban_event_time: "2026-10-03T10:00:00.000Z",
        ban_sources: ["mc_mac_03_21"],
        ban_decline_class: "lost_stolen",
        event_time: "2026-10-05T10:00:00.000Z",
        minutes_since_ban: 2880,
        initiation_type: "cit",
        processor_relation: "switched",
        succeeded: true,
        banned_again: false,
        processor: pspVisible ? { key: "ADYEN", label: "Adyen" } : null,
        merchant_account: pspVisible ? ADYEN_MID_UNLABELLED : null,
      },
    ],
    rolling: {
      pairs: 1200,
      violations: 1,
      windows: [
        { instrument: "0a0b0c0d0e0f1011", merchant_account: pspVisible ? STRIPE_MID : null, max_declines: 17, limit: 15, window_start: "2026-09-15T00:00:00.000Z", window_end: "2026-10-10T00:00:00.000Z", decline_records_total: 21 },
      ],
    },
    cascade_rows: 22,
  };
}

export function refundsSupportResponse(over: { dimension?: RefundsSupportResponse["dimension"]; pspVisible?: boolean } = {}): RefundsSupportResponse {
  const dimension = over.dimension ?? "processor";
  const pspVisible = over.pspVisible ?? true;
  return {
    ok: true,
    action: "refunds_support",
    meta: meta("refunds_support", { psp_global_visible: pspVisible }),
    dimension,
    refunds: {
      totals: {
        current: totals(),
        baseline: totals({ attempts: 900, successes: 760, declines: 140, refunded: 20 }),
        approval: comparison([820, 1000], [760, 900]),
        issuer_fraud_share: comparison([12, 1000], [9, 900]),
        refund_rate: comparison([24, 820], [20, 760]),
      },
      by_dimension: dimension === "processor" ? [breakdown("processor", "STRIPE", "Stripe", { decline_classes: {} })] : [breakdown(dimension, "soulmate-sketch", "soulmate-sketch", { decline_classes: {} })],
      by_month: [
        { month: "2026-09-01", settled: 500, refunded: 15, refund_amount_usd: 750, refund_rate: rate(15, 500) },
        { month: "2026-10-01", settled: 320, refunded: 9, refund_amount_usd: 450, refund_rate: rate(9, 320) },
      ],
      timing: { observed: 20, unobserved: 4, within_7_days: 9, within_30_days: 7, within_90_days: 3, beyond_90_days: 1 },
    },
    complaints: {
      by_month: [
        { month: "2026-09-01", total: 30, possible_unauthorized_charge: 3, requires_refund: 10, duplicate_charge: 1, classification_versions: ["v2"], version_break: false, by_category: [{ category: "refund", count: 10 }] },
        { month: "2026-10-01", total: 18, possible_unauthorized_charge: 2, requires_refund: 6, duplicate_charge: 0, classification_versions: ["v3"], version_break: true, by_category: [{ category: "refund", count: 6 }] },
      ],
      current: { total: 48, possible_unauthorized_charge: 5, requires_refund: 16, duplicate_charge: 1, unattributed: 7 },
      baseline: { total: 40, possible_unauthorized_charge: 2, requires_refund: 12, duplicate_charge: 2, unattributed: 5 },
      support_unauthorized_rate: comparison([5, 820], [2, 760]),
      by_account: pspVisible ? [{ processor: { key: "STRIPE", label: "Stripe" }, merchant_account: STRIPE_MID, total: 20, possible_unauthorized_charge: 3, requires_refund: 8, duplicate_charge: 1 }] : [],
      attribution_days: 30,
    },
  };
}

export function sourcesResponse(): SourcesResponse {
  return {
    ok: true,
    action: "sources",
    meta: meta("sources"),
    warehouse: { attempt_rows: 48210, first_day: "2025-01-03", last_day: "2026-10-10", last_synced_at: "2026-10-10T21:15:00.000Z", rows_without_raw_status: 120 },
    coverage: [
      { column: "raw_status", filled: 48090, rows: 48210, share: 0.9975 },
      { column: "issuer_country", filled: 47400, rows: 48210, share: 0.984 },
      { column: "decline_record (of declines)", filled: 6100, rows: 6400, share: 0.953 },
      { column: "refund_observed_at (of refunded)", filled: 300, rows: 420, share: 0.714 },
    ],
    last_import: { imported_at: "2026-10-10T20:00:00.000Z", status: "completed", rows_total: 1200, rows_inserted: 1150, rows_updated: 50, source: "primer_csv" },
    sync_state: { status: "completed", updated_at: "2026-10-10T21:15:00.000Z", last_run_at: "2026-10-10T21:10:00.000Z" },
    support: {
      by_month: [
        { month: "2026-09-01", requests: 30, classification_versions: ["v2"], version_break: false },
        { month: "2026-10-01", requests: 18, classification_versions: ["v3"], version_break: true },
      ],
    },
    metrics: [
      { key: "attempt_approval_rate", title: "Attempt approval rate", phase: "P1", available: true, heuristic: false, estimate: false, notes: "Attempt level." },
      { key: "retry_recovery_rate", title: "Retry recovery rate", phase: "P1", available: true, heuristic: true, estimate: false, notes: "Chains are a heuristic." },
      { key: "disputes", title: "Disputes", phase: "P3", available: false, heuristic: false, estimate: false, notes: "Needs the dispute source." },
    ],
  };
}

export function optionsResponse(over: { pspVisible?: boolean } = {}): OptionsResponse {
  const pspVisible = over.pspVisible ?? true;
  return {
    ok: true,
    action: "options",
    meta: meta("options", { psp_global_visible: pspVisible }),
    options: {
      processor: pspVisible ? [{ key: "STRIPE", label: "Stripe" }, { key: "ADYEN", label: "Adyen" }, { key: "unrouted", label: "Unrouted" }] : [],
      merchant_account: pspVisible ? [STRIPE_MID, ADYEN_MID_UNLABELLED] : [],
      descriptor: pspVisible ? [{ key: "d:9f8e7d6c5b4a3210", label: "Stripe descriptor #1", processor: "STRIPE" }] : [],
      funnel: [{ key: "soulmate-sketch", label: "soulmate-sketch" }, { key: "unattributed", label: "Unattributed" }],
      country: [{ key: "US", label: "US" }, { key: "DE", label: "DE" }, { key: "unknown", label: "Unknown" }],
      card_network: [{ key: "VISA", label: "Visa" }, { key: "MASTERCARD", label: "Mastercard" }],
      payment_method: [{ key: "PAYMENT_CARD", label: "Card" }],
      initiation: [{ key: "cit", label: "CIT" }, { key: "mit", label: "MIT" }, { key: "unknown", label: "Unknown" }],
      transaction_type: [{ key: "trial", label: "trial" }, { key: "renewal", label: "renewal" }],
      dimensions: [
        ...(pspVisible ? [{ key: "processor", label: "Processor (PSP)", psp: true }, { key: "merchant_account", label: "Merchant account (MID)", psp: true }, { key: "descriptor", label: "Statement descriptor", psp: true }] : []),
        { key: "funnel", label: "Funnel (acquisition anchor)", psp: false },
        { key: "country", label: "Issuer country (BIN)", psp: false },
      ],
    },
    bounds: { first_day: "2025-01-03", last_day: "2026-10-10" },
  };
}

/** Every action's response, with the sentinels planted in fields the page never reads. */
export function responseFor(action: string, options: { pspVisible?: boolean; dimension?: string } = {}): Record<string, unknown> {
  const pspVisible = options.pspVisible ?? true;
  const dimension = (options.dimension ?? (pspVisible ? "processor" : "funnel")) as DeclinesResponse["dimension"];
  const planted = {
    _raw_mid: UI_SENTINELS.rawMid,
    _raw_descriptor: UI_SENTINELS.rawDescriptor,
    _instrument_token: UI_SENTINELS.instrumentToken,
    _transaction_id: UI_SENTINELS.transactionId,
    _email: UI_SENTINELS.email,
  };
  switch (action) {
    case "overview":
      return { ...overviewResponse({ pspVisible }), ...planted };
    case "declines":
      return { ...declinesResponse({ pspVisible, dimension }), ...planted };
    case "retries":
      return { ...retriesResponse({ pspVisible }), ...planted };
    case "refunds_support":
      return { ...refundsSupportResponse({ pspVisible, dimension }), ...planted };
    case "sources":
      return { ...sourcesResponse(), ...planted };
    case "options":
      return { ...optionsResponse({ pspVisible }), ...planted };
    default:
      throw new Error(`unknown action ${action}`);
  }
}
