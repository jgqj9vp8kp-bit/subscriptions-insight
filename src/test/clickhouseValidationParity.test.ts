import { describe, expect, it } from "vitest";
import { buildMetrics, emptySnapshot, type AggregateSnapshot } from "../../supabase/functions/_shared/clickhouse/validation.ts";

// Regression for the "everything matches but Validation = FAIL" bug. The source
// snapshot stringifies event_time with an ISO 'T' separator (mapper dateTimeKey)
// while the ClickHouse snapshot uses a space (toString(event_time)). The min/max
// event_time metric compared these with strict string equality, so it always
// reported FAIL in production even when the instants were identical, flipping the
// whole validation to FAIL. The metric must now be separator-insensitive.

function baseSnapshot(): AggregateSnapshot {
  return {
    ...emptySnapshot(),
    total_rows: 9000,
    unique_transaction_ids: 9000,
    unique_users: 3910,
    successful_payments: 3932,
    failed_payments: 5068,
    trials: 2604,
    first_subscriptions: 829,
    renewals: 162,
    upsells: 337,
    gross_revenue_usd: 121798.53,
    net_revenue_usd: 118485.48,
    refund_amount_usd: 3313.05,
    counts_by_currency: { USD: 9000 },
    counts_by_funnel: { soulmate: 3865, unknown: 4562, past_life: 502, starseed: 71 },
    counts_by_transaction_type: { failed_payment: 5068, trial: 2604, first_subscription: 829, upsell: 337, renewal_2: 78, renewal_3: 51, renewal: 33 },
  };
}

describe("ClickHouse validation parity — event_time format tolerance", () => {
  it("PASSES when min/max event_time differ ONLY by the ISO 'T' vs space separator (exact production values)", () => {
    const source: AggregateSnapshot = {
      ...baseSnapshot(),
      min_event_time: "2026-03-11T14:51:11.694", // mapper ISO format
      max_event_time: "2026-05-26T16:04:04.941",
    };
    const clickhouse: AggregateSnapshot = {
      ...baseSnapshot(),
      min_event_time: "2026-03-11 14:51:11.694", // ClickHouse toString format
      max_event_time: "2026-05-26 16:04:04.941",
    };
    const metrics = buildMetrics(source, clickhouse);
    const status = Object.fromEntries(metrics.map((m) => [m.metric, m.status]));

    expect(status.min_event_time).toBe("PASS"); // was FAIL under strict string equality
    expect(status.max_event_time).toBe("PASS");
    // With every other field identical, the whole validation now passes.
    expect(metrics.every((m) => m.status === "PASS")).toBe(true);
    // Raw values are preserved for diagnostics (only the comparison is tolerant).
    const min = metrics.find((m) => m.metric === "min_event_time");
    expect(min?.source_value).toBe("2026-03-11T14:51:11.694");
    expect(min?.clickhouse_value).toBe("2026-03-11 14:51:11.694");
  });

  it("still FAILS when the event_time instants genuinely differ (check not weakened)", () => {
    const source: AggregateSnapshot = { ...baseSnapshot(), min_event_time: "2026-03-11T14:51:11.694", max_event_time: "2026-05-26T16:04:04.941" };
    const clickhouse: AggregateSnapshot = { ...baseSnapshot(), min_event_time: "2026-03-11 14:51:11.695", max_event_time: "2026-05-26 16:04:04.941" };
    const metrics = buildMetrics(source, clickhouse);
    const status = Object.fromEntries(metrics.map((m) => [m.metric, m.status]));

    expect(status.min_event_time).toBe("FAIL"); // real 1ms difference is still caught
    expect(status.max_event_time).toBe("PASS");
    expect(metrics.every((m) => m.status === "PASS")).toBe(false);
  });
});
