// Payment System Health P1: the metric dictionary (plan G) and the trend
// statistics (plan P, H; plan Z #10, 11): Wilson intervals, rates with a
// sample-size flag, period comparisons that are significant only when the
// intervals do not overlap, the "immature period" flag, and the
// Δcount = Δvolume × rate + volume × Δrate decomposition.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MIN_SAMPLE,
  DISPUTE_MATURITY_DAYS,
  METRIC_KEYS,
  PAYMENT_HEALTH_METRICS,
  comparePeriods,
  decomposeCountChange,
  metricDefinition,
  metricsByPhase,
  periodFlags,
  rateWithSample,
  wilsonInterval,
  type MetricKey,
} from "../../supabase/functions/_shared/clickhouse/paymentHealthMetrics.ts";

/** Every key of the plan G table, verbatim. */
const PLAN_G_KEYS = [
  "attempts", "attempt_approval_rate", "payment_intent", "final_success_rate", "chain_first_try_approval_rate",
  "retry_recovery_rate", "cascade_recovery", "decline_class", "decline_mix", "issuer_fraud_declines", "psp_blocked",
  "fraud_reports", "disputes", "fraud_disputes", "fraud_disputes_lost_or_accepted", "confirmed_fraud", "dispute_win_rate",
  "refund_rate", "support_unauthorized_rate", "vamp_estimate", "mc_ecp_estimate", "retry_compliance", "cascade_rows",
  "three_ds_rate",
];

describe("the metric dictionary (plan G) as data", () => {
  it("covers every key of plan G exactly once, in the plan's order", () => {
    expect([...METRIC_KEYS]).toEqual(PLAN_G_KEYS);
    expect(PAYMENT_HEALTH_METRICS.map((metric) => metric.key)).toEqual(PLAN_G_KEYS);
    expect(new Set(PAYMENT_HEALTH_METRICS.map((metric) => metric.key)).size).toBe(PLAN_G_KEYS.length);
  });

  it("every entry states title, definition, numerator, denominator, unit, date basis, phase and notes", () => {
    for (const metric of PAYMENT_HEALTH_METRICS) {
      for (const field of ["title", "definition", "numerator", "denominator", "notes"] as const) {
        expect(metric[field].trim().length, `${metric.key}.${field}`).toBeGreaterThan(0);
      }
      expect(["count", "rate", "usd", "class", "distribution", "flag"]).toContain(metric.unit);
      expect(["event_time", "original_payment", "received_at", "received_at_and_original_payment", "rolling_window", "not_applicable"]).toContain(metric.date_basis);
      expect(["P1", "P2", "P2.5", "P3", "P4", "P5", "P6"]).toContain(metric.phase);
      if (metric.unit === "rate") {
        expect(metric.min_sample, metric.key).toBeGreaterThan(0);
        expect(metric.denominator, metric.key).not.toBe("—");
      } else {
        expect(metric.min_sample, metric.key).toBeNull();
      }
    }
  });

  it("keeps the plan's phases, heuristics and estimates", () => {
    const phase = (key: MetricKey) => metricDefinition(key).phase;
    for (const key of ["attempts", "attempt_approval_rate", "decline_class", "issuer_fraud_declines", "refund_rate", "retry_compliance", "cascade_rows", "three_ds_rate"] as const) {
      expect(phase(key), key).toBe("P1");
    }
    for (const key of ["fraud_reports", "disputes", "fraud_disputes", "fraud_disputes_lost_or_accepted", "dispute_win_rate"] as const) expect(phase(key), key).toBe("P3");
    for (const key of ["vamp_estimate", "mc_ecp_estimate"] as const) {
      expect(phase(key), key).toBe("P4");
      expect(metricDefinition(key).estimate, key).toBe(true);
    }
    expect(phase("psp_blocked")).toBe("P5");
    expect(phase("confirmed_fraud")).toBe("P6");
    for (const key of ["payment_intent", "final_success_rate", "chain_first_try_approval_rate", "retry_recovery_rate", "cascade_recovery", "support_unauthorized_rate"] as const) {
      expect(metricDefinition(key).heuristic, key).toBe(true);
    }
    expect(metricsByPhase("P1").length).toBeGreaterThanOrEqual(12);
    expect(metricsByPhase("P3").map((metric) => metric.key)).toContain("disputes");
  });

  it("states the plan's definitions where they are easy to get wrong", () => {
    expect(metricDefinition("attempts").numerator).toMatch(/SETTLED, DECLINED, FAILED/);
    expect(metricDefinition("attempts").notes).toMatch(/status column is NOT changed/);
    expect(metricDefinition("payment_intent").definition).toMatch(/CIT 60 minutes, MIT 72 hours/);
    expect(metricDefinition("payment_intent").notes).toMatch(/transaction type is NOT part of the key/);
    expect(metricDefinition("retry_recovery_rate").notes).toMatch(/never count as recovery/);
    expect(metricDefinition("cascade_recovery").notes).toMatch(/UNVERIFIED/);
    expect(metricDefinition("issuer_fraud_declines").notes).toMatch(/NOT fraud/);
    expect(metricDefinition("issuer_fraud_declines").numerator).toMatch(/59, 63, 83/);
    expect(metricDefinition("fraud_disputes_lost_or_accepted").notes).toMatch(/not confirmed fraud/);
    expect(metricDefinition("vamp_estimate").definition).toMatch(/SAME month/);
    expect(metricDefinition("vamp_estimate").definition).toMatch(/descriptor part × acquirer country/);
    expect(metricDefinition("mc_ecp_estimate").definition).toMatch(/PREVIOUS month/);
    expect(metricDefinition("retry_compliance").notes).toMatch(/UNVERIFIED/);
    expect(metricDefinition("retry_compliance").definition).toMatch(/15 declines in a rolling 30 days/);
    expect(metricDefinition("disputes").date_basis).toBe("received_at_and_original_payment");
    expect(metricDefinition("refund_rate").date_basis).toBe("original_payment");
    expect(metricDefinition("three_ds_rate").notes).toMatch(/never around SCA/);
    expect(() => metricDefinition("nope" as MetricKey)).toThrow(/unknown payment health metric/);
  });

  it("never says 'unavailable' (the frontend breaker matches that word)", () => {
    expect(JSON.stringify(PAYMENT_HEALTH_METRICS)).not.toMatch(/unavailable/i);
  });
});

describe("Wilson interval and rates with a sample-size flag", () => {
  it("matches the textbook values and stays inside [0, 1]", () => {
    expect(wilsonInterval(0, 0)).toBeNull();
    expect(wilsonInterval(5, Number.NaN)).toBeNull();
    const none = wilsonInterval(0, 10)!;
    expect(none.low).toBe(0);
    expect(none.high).toBeCloseTo(0.2775, 3);
    const all = wilsonInterval(10, 10)!;
    expect(all.low).toBeCloseTo(0.7225, 3);
    expect(all.high).toBe(1);
    const half = wilsonInterval(50, 100)!;
    expect(half.low).toBeCloseTo(0.4038, 3);
    expect(half.high).toBeCloseTo(0.5962, 3);
    // Wider for a smaller sample, narrower with a smaller z.
    const small = wilsonInterval(5, 10)!;
    expect(small.high - small.low).toBeGreaterThan(half.high - half.low);
    const z90 = wilsonInterval(50, 100, 1.6449)!;
    expect(z90.high - z90.low).toBeLessThan(half.high - half.low);
  });

  it("flags a small sample and never reports a rate without a denominator (no data ≠ zero)", () => {
    expect(DEFAULT_MIN_SAMPLE).toBe(200);
    const empty = rateWithSample(0, 0);
    expect(empty).toMatchObject({ rate: null, interval: null, sample_size: 0, small_sample: true, min_sample: 200 });
    const small = rateWithSample(50, 100);
    expect(small.rate).toBe(0.5);
    expect(small.small_sample).toBe(true);
    const enough = rateWithSample(150, 300);
    expect(enough.small_sample).toBe(false);
    expect(rateWithSample(150, 300, { minSample: 500 }).small_sample).toBe(true);
    // Defensive: a numerator above the denominator is capped, negatives are floored.
    expect(rateWithSample(10, 5).rate).toBe(1);
    expect(rateWithSample(-3, 5).rate).toBe(0);
  });
});

describe("period comparison (plan P): delta in points, direction, significance only when intervals do not overlap", () => {
  it("is significant when both samples are large and the intervals do not overlap", () => {
    const result = comparePeriods({ numerator: 90, denominator: 1000 }, { numerator: 50, denominator: 1000 });
    expect(result.delta_points).toBeCloseTo(4, 6);
    expect(result.direction).toBe("up");
    expect(result.significant).toBe(true);
    expect(result.significance_reason).toBe("intervals_do_not_overlap");
    expect(result.immature_period).toBe(false);
    const down = comparePeriods({ numerator: 50, denominator: 1000 }, { numerator: 90, denominator: 1000 });
    expect(down.direction).toBe("down");
    expect(down.delta_points).toBeCloseTo(-4, 6);
    expect(down.significant).toBe(true);
  });

  it("is not significant when the intervals overlap, the sample is small, or the period is immature", () => {
    const overlap = comparePeriods({ numerator: 52, denominator: 1000 }, { numerator: 50, denominator: 1000 });
    expect(overlap.direction).toBe("up");
    expect(overlap.significant).toBe(false);
    expect(overlap.significance_reason).toBe("intervals_overlap");

    const small = comparePeriods({ numerator: 40, denominator: 100 }, { numerator: 5, denominator: 100 });
    expect(small.significant).toBe(false);
    expect(small.significance_reason).toBe("small_sample");
    // The same numbers clear a lower threshold.
    expect(comparePeriods({ numerator: 40, denominator: 100 }, { numerator: 5, denominator: 100 }, { minSample: 50 }).significant).toBe(true);

    const immature = comparePeriods({ numerator: 90, denominator: 1000 }, { numerator: 50, denominator: 1000 }, { immature: true });
    expect(immature.significant).toBe(false);
    expect(immature.significance_reason).toBe("immature_period");
    expect(immature.immature_period).toBe(true);
    expect(immature.delta_points).toBeCloseTo(4, 6);
  });

  it("reports no data instead of a zero change when a period is empty, and flat within the threshold", () => {
    const empty = comparePeriods({ numerator: 0, denominator: 0 }, { numerator: 50, denominator: 1000 });
    expect(empty).toMatchObject({ delta_points: null, direction: "unknown", significant: false, significance_reason: "no_data" });
    expect(empty.current.rate).toBeNull();
    const flat = comparePeriods({ numerator: 501, denominator: 1000 }, { numerator: 500, denominator: 1000 }, { flatThresholdPoints: 0.5 });
    expect(flat.direction).toBe("flat");
    expect(flat.significant).toBe(false);
    const same = comparePeriods({ numerator: 500, denominator: 1000 }, { numerator: 500, denominator: 1000 });
    expect(same.direction).toBe("flat");
    expect(same.delta_points).toBe(0);
  });
});

describe("Δcount = Δvolume × rate + volume × Δrate (plan H)", () => {
  it("splits a count change into the volume and the rate effect exactly", () => {
    const result = decomposeCountChange({ volume: 1000, count: 50 }, { volume: 1500, count: 90 });
    expect(result.delta_count).toBe(40);
    expect(result.rate_before).toBeCloseTo(0.05, 12);
    expect(result.rate_after).toBeCloseTo(0.06, 12);
    expect(result.volume_effect).toBeCloseTo(25, 9); // 500 × 0.05
    expect(result.rate_effect).toBeCloseTo(15, 9); // 1500 × 0.01
    expect(result.volume_effect + result.rate_effect).toBeCloseTo(result.delta_count, 9);
    expect(result.volume_share).toBeCloseTo(0.625, 9);
  });

  it("attributes a pure volume change to volume and a pure rate change to the rate", () => {
    const volume = decomposeCountChange({ volume: 1000, count: 50 }, { volume: 2000, count: 100 });
    expect(volume.volume_effect).toBeCloseTo(50, 9);
    expect(volume.rate_effect).toBeCloseTo(0, 9);
    expect(volume.volume_share).toBeCloseTo(1, 9);
    const rate = decomposeCountChange({ volume: 1000, count: 50 }, { volume: 1000, count: 80 });
    expect(rate.volume_effect).toBeCloseTo(0, 9);
    expect(rate.rate_effect).toBeCloseTo(30, 9);
    expect(rate.volume_share).toBeCloseTo(0, 9);
  });

  it("handles an empty period: no rate to compare, the whole change is volume", () => {
    const fromNothing = decomposeCountChange({ volume: 0, count: 0 }, { volume: 500, count: 20 });
    expect(fromNothing).toMatchObject({ rate_before: null, delta_count: 20, volume_effect: 20, rate_effect: 0, volume_share: 1 });
    const unchanged = decomposeCountChange({ volume: 0, count: 0 }, { volume: 0, count: 0 });
    expect(unchanged.volume_share).toBeNull();
    expect(unchanged.delta_count).toBe(0);
  });
});

describe("period flags: incomplete (import lag) and immature (dispute maturity)", () => {
  it("marks a period past the last imported day as incomplete and a recent one as immature", () => {
    expect(DISPUTE_MATURITY_DAYS).toBe(120);
    const now = "2026-10-11T00:00:00Z";
    expect(periodFlags({ periodEnd: "2026-10-10", lastImportedDay: "2026-10-05", now })).toMatchObject({ incomplete: true, immature: true });
    expect(periodFlags({ periodEnd: "2026-10-05", lastImportedDay: "2026-10-05", now })).toMatchObject({ incomplete: false, immature: true });
    const old = periodFlags({ periodEnd: "2026-05-31", lastImportedDay: "2026-10-05", now });
    expect(old.incomplete).toBe(false);
    expect(old.immature).toBe(false);
    expect(old.days_since_period_end).toBeGreaterThan(120);
    expect(periodFlags({ periodEnd: "2026-08-01", now, maturityDays: 30 }).immature).toBe(false);
    expect(periodFlags({ periodEnd: "2026-08-01", now }).incomplete).toBe(false);
  });
});
