// Payment System Health P2: the runner's SQL (recorded through a real
// ScopedReader) and its arithmetic, proven against the fixture rows
// independently (plan Z #16, #25 on fixtures):
//   * request normalization (defaults, the 400-day cap, the equal-length
//     comparison window, filter shapes, PSP dimensions behind the key);
//   * the recorded statements: tenant-bound, FINAL, the Payment Pass attempt
//     denominator (ATTEMPT_RAW_STATUS_EXCLUSION), the anchor snapshot bound as
//     parameters, raw MIDs / descriptors bound as parameters and never
//     returned, no scratch tables, no writes, no SETTINGS, no system tables;
//   * parity: attempts / successes / amounts by processor and by day equal the
//     Payment Pass totals computed straight from the fixture rows with the
//     same exclusion; decline classes equal classifyDecline per row; the
//     comparison blocks equal comparePeriods on the raw counts;
//   * retries (chains, post-ban attempts, rolling windows, the memo), refunds
//     (timing buckets), complaints (attribution rule, version breaks),
//     sources (coverage, lifecycle-only state) and options.
import { beforeEach, describe, expect, it } from "vitest";
import { createScopedReader } from "../../supabase/functions/_shared/clickhouse/scopedClient.ts";
import { ATTEMPT_RAW_STATUS_EXCLUSION } from "../../supabase/functions/_shared/clickhouse/paymentAnalytics.ts";
import { classifyDecline, type DeclineClass } from "../../supabase/functions/_shared/clickhouse/declineTaxonomy.ts";
import { comparePeriods } from "../../supabase/functions/_shared/clickhouse/paymentHealthMetrics.ts";
import { buildAttemptChains, type AttemptRow } from "../../supabase/functions/_shared/clickhouse/attemptChains.ts";
import {
  CODE_MIX_LIMIT,
  DEFAULT_RANGE_DAYS,
  MAX_RANGE_DAYS,
  POST_BAN_ATTEMPT_LIMIT,
  REFUND_MATURITY_DAYS,
  ROLLING_WINDOW_LIMIT,
  PaymentHealthPermissionError,
  PaymentHealthRequestError,
  normalizePaymentHealthRequest,
  shiftDay,
  windowsFor,
  type DeclinesResponse,
  type OptionsResponse,
  type OverviewResponse,
  type RefundsSupportResponse,
  type RetriesResponse,
  type SourcesResponse,
} from "../../supabase/functions/_shared/clickhouse/paymentHealthContract.ts";
import { resetPaymentHealthMemo, runPaymentHealth } from "../../supabase/functions/_shared/clickhouse/paymentHealth.ts";
import { PERSONAS, contextFor } from "./support/accessFixtures";
import { createRecordingClickHouse, type RecordedStatement } from "./support/recordingClickHouse";
import { scanForLeaks } from "./support/leakScan";
import { FIXTURE_ANCHORS, PH_DATA_KEY, PH_SENTINELS, T, asPg, fixturePg, fixtureRows, fixtureWarehouse, tx, type FixtureTx } from "./support/paymentHealthFixtures";

const NOW = Date.parse("2026-10-06T12:00:00.000Z");
const RANGE = { date_from: "2026-09-01", date_to: "2026-09-30" };
const SENTINELS = Object.values(PH_SENTINELS);

function harness(options: { rows?: FixtureTx[]; snapshot?: boolean; pspVisible?: boolean } = {}) {
  const rows = options.rows ?? fixtureRows();
  const warehouse = fixtureWarehouse({ rows });
  const recording = createRecordingClickHouse(warehouse.respond);
  const ctx = contextFor(PERSONAS.owner);
  const clickhouse = createScopedReader(ctx, recording);
  const pg = asPg(fixturePg({ snapshot: options.snapshot }));
  const run = <T>(request: Record<string, unknown>) =>
    runPaymentHealth({ tenantKey: PH_DATA_KEY, clickhouse, pg, request: { ...RANGE, ...request }, pspVisible: options.pspVisible ?? true, clock: () => NOW }) as Promise<T>;
  return { rows, warehouse, recording, ctx, pg, run };
}

/** Payment Pass semantics straight from the fixture: attempts = rows not CANCELLED / PENDING, successes = is_success. */
function passTotals(rows: FixtureTx[], from: string, to: string, pick: (row: FixtureTx) => boolean = () => true) {
  const inWindow = rows.filter((row) => row.raw_status !== "CANCELLED" && row.raw_status !== "PENDING" && row.event_time.slice(0, 10) >= from && row.event_time.slice(0, 10) <= to && pick(row));
  return {
    attempts: inWindow.length,
    successes: inWindow.filter((row) => row.is_success).length,
    settled_amount_usd: Math.round(inWindow.filter((row) => row.is_success).reduce((sum, row) => sum + row.amount_usd, 0) * 100) / 100,
    rows: inWindow,
  };
}

beforeEach(() => resetPaymentHealthMemo());

describe("request normalization", () => {
  const today = "2026-10-06";

  it("defaults to the last 30 days up to today, with an equal-length window before it", () => {
    const nreq = normalizePaymentHealthRequest({ action: "overview" }, { today, pspVisible: true });
    expect(nreq.range).toEqual({ from: "2026-09-07", to: "2026-10-06", days: DEFAULT_RANGE_DAYS });
    expect(nreq.compare).toEqual({ from: "2026-08-08", to: "2026-09-06", days: DEFAULT_RANGE_DAYS });
    expect(nreq.dimension).toBe("processor");
    expect(nreq.filters).toEqual({ processor: [], merchant_account: [], descriptor: [], funnel: [], country: [], card_network: [], payment_method: [], initiation: [], transaction_type: [] });
  });

  it("builds adjacent windows of the same length across a month boundary", () => {
    expect(windowsFor("2026-09-01", "2026-09-30")).toEqual({
      range: { from: "2026-09-01", to: "2026-09-30", days: 30 },
      compare: { from: "2026-08-02", to: "2026-08-31", days: 30 },
    });
    expect(windowsFor("2026-03-01", "2026-03-01").compare).toEqual({ from: "2026-02-28", to: "2026-02-28", days: 1 });
  });

  it("rejects unknown actions, malformed dates, inverted and oversized windows, non-array filters and unknown dimensions", () => {
    expect(() => normalizePaymentHealthRequest({ action: "bundle" }, { today, pspVisible: true })).toThrow(PaymentHealthRequestError);
    expect(() => normalizePaymentHealthRequest({ action: "overview", date_from: "2026/09/01" }, { today, pspVisible: true })).toThrow(/Invalid date_from/);
    expect(() => normalizePaymentHealthRequest({ action: "overview", date_from: "2026-09-10", date_to: "2026-09-01" }, { today, pspVisible: true })).toThrow(/after/);
    expect(() => normalizePaymentHealthRequest({ action: "overview", date_from: "2025-01-01", date_to: "2026-10-06" }, { today, pspVisible: true })).toThrow(new RegExp(`maximum is ${MAX_RANGE_DAYS}`));
    expect(normalizePaymentHealthRequest({ action: "overview", date_from: "2025-09-02", date_to: "2026-10-06" }, { today, pspVisible: true }).range.days).toBe(MAX_RANGE_DAYS);
    expect(() => normalizePaymentHealthRequest({ action: "overview", filters: { funnel: "soulmate" } }, { today, pspVisible: true })).toThrow(/must be an array/);
    expect(() => normalizePaymentHealthRequest({ action: "overview", filters: { initiation: ["cit", "bot"] } }, { today, pspVisible: true })).toThrow(/initiation/);
    expect(() => normalizePaymentHealthRequest({ action: "overview", dimension: "raw_payload" }, { today, pspVisible: true })).toThrow(/Unknown dimension/);
  });

  it("upper-cases the network / method / country keys, keeps the sentinel keys, de-duplicates", () => {
    const nreq = normalizePaymentHealthRequest(
      { action: "declines", filters: { card_network: ["visa", "VISA"], country: ["de", "unknown"], processor: ["stripe", "unrouted"], initiation: ["CIT"] } },
      { today, pspVisible: true },
    );
    expect(nreq.filters.card_network).toEqual(["VISA"]);
    expect(nreq.filters.country).toEqual(["DE", "unknown"]);
    expect(nreq.filters.processor).toEqual(["STRIPE", "unrouted"]);
    expect(nreq.filters.initiation).toEqual(["cit"]);
    // The options action hands out the lowercase 'unknown' key for an empty network / method: it is
    // preserved exactly (upper-casing it would never match a row). Only the exact key is the sentinel.
    const unknown = normalizePaymentHealthRequest(
      { action: "overview", filters: { card_network: ["unknown", "visa", "Unknown"], payment_method: ["unknown", "apple_pay"] } },
      { today, pspVisible: true },
    );
    expect(unknown.filters.card_network).toEqual(["unknown", "VISA", "UNKNOWN"]);
    expect(unknown.filters.payment_method).toEqual(["unknown", "APPLE_PAY"]);
  });

  it("without the PSP key: PSP filters and dimensions are refused (never dropped), the default dimension is funnel", () => {
    expect(normalizePaymentHealthRequest({ action: "declines" }, { today, pspVisible: false }).dimension).toBe("funnel");
    for (const filters of [{ processor: ["STRIPE"] }, { merchant_account: ["x"] }, { descriptor: ["d:1"] }]) {
      expect(() => normalizePaymentHealthRequest({ action: "declines", filters }, { today, pspVisible: false })).toThrow(PaymentHealthPermissionError);
    }
    for (const dimension of ["processor", "merchant_account", "descriptor"]) {
      expect(() => normalizePaymentHealthRequest({ action: "declines", dimension }, { today, pspVisible: false })).toThrow(PaymentHealthPermissionError);
    }
    expect(normalizePaymentHealthRequest({ action: "declines", dimension: "country", filters: { funnel: ["a"] } }, { today, pspVisible: false }).dimension).toBe("country");
  });
});

describe("recorded SQL", () => {
  const forbidden = (statement: RecordedStatement) => /CREATE TABLE|INSERT INTO|DROP TABLE|ALTER TABLE|\bSETTINGS\b|system\.|raw_payload|normalized_payload|INTO OUTFILE/i.test(statement.query);

  it("every action: tenant-bound, FINAL, the Payment Pass denominator, no writes, no scratch tables, no payload columns", async () => {
    for (const action of ["overview", "declines", "retries", "refunds_support", "sources", "options"] as const) {
      const h = harness();
      await h.run({ action });
      expect(h.recording.statements.length, action).toBeGreaterThan(0);
      expect(h.recording.boundTenants(), action).toEqual([PH_DATA_KEY]);
      for (const statement of h.recording.statements) {
        expect(statement.kind, action).toBe("query");
        expect(statement.query, action).toContain("auth_user_id = {auth_user_id:String}");
        expect(statement.query, action).toMatch(/\bFINAL\b/);
        expect(forbidden(statement), `${action}: ${statement.query.slice(0, 100)}`).toBe(false);
      }
      const attemptReads = h.recording.statements.filter((statement) => /analytics_transactions/.test(statement.query) && !/ph:complaints/.test(statement.query));
      for (const statement of attemptReads) expect(statement.query, action).toContain(ATTEMPT_RAW_STATUS_EXCLUSION);
      expect(h.ctx.violations, action).toEqual([]);
    }
  });

  it("binds the validated snapshot versions for the anchor join and the window pair as parameters", async () => {
    const h = harness();
    await h.run({ action: "declines" });
    const groups = h.recording.statements.find((statement) => statement.query.includes("ph:declines_groups"))!;
    expect(groups.query).toContain("fact_user_cohorts FINAL");
    expect(groups.query).toContain("warehouse_version = {snapshot_warehouse_version:String}");
    expect(groups.params).toMatchObject({
      auth_user_id: PH_DATA_KEY,
      snapshot_warehouse_version: "wh_fixture",
      window_from: "2026-08-02",
      window_to: "2026-09-30",
      range_from: "2026-09-01",
    });
    expect(groups.query).toContain("LEFT JOIN anchors");
    expect(groups.query).not.toContain("JOIN analytics_transactions");
  });

  it("without a validated snapshot the anchor join binds empty versions and every row is unattributed", async () => {
    const h = harness({ snapshot: false });
    const response = await h.run<DeclinesResponse>({ action: "declines", dimension: "funnel" });
    const groups = h.recording.statements.find((statement) => statement.query.includes("ph:declines_groups"))!;
    expect(groups.params.snapshot_warehouse_version).toBe("");
    expect(response.meta.funnel_attribution.status).toBe("no_snapshot");
    expect(response.by_dimension.map((row) => row.value.key)).toEqual(["unattributed"]);
  });

  it("merchant-account and descriptor filters bind the RAW values as parameters; the response never carries them", async () => {
    const h = harness();
    const options = await h.run<OptionsResponse>({ action: "options" });
    const stripe = options.options.merchant_account.find((entry) => entry.label === "Stripe MID #1")!;
    const unlabelled = options.options.merchant_account.find((entry) => !entry.labelled && entry.processor === "STRIPE")!;
    const descriptor = options.options.descriptor.find((entry) => entry.processor === "STRIPE" && !entry.key.startsWith("none:"))!;
    expect(stripe.key).toBe("aaaa0000-0000-4000-8000-00000000a001");
    expect(unlabelled.key).toMatch(/^unlabelled:[0-9a-f]{16}$/);
    expect(unlabelled.label).toBe("Unlabelled MID");
    expect(descriptor.key).toMatch(/^d:[0-9a-f]{16}$/);
    // The registry prefix names the descriptor; the raw descriptor text is not the label.
    expect(descriptor.label).toBe("SENTINEL* (Stripe MID #1)");

    h.recording.reset();
    const response = await h.run<DeclinesResponse>({ action: "declines", dimension: "merchant_account", filters: { merchant_account: [stripe.key, unlabelled.key], descriptor: [descriptor.key] } });
    const groups = h.recording.statements.find((statement) => statement.query.includes("ph:declines_groups"))!;
    expect(groups.query).toContain("(processor, processor_merchant_id) IN (({p_ma_0_p:String}, {p_ma_0_v:String}), ({p_ma_1_p:String}, {p_ma_1_v:String}))");
    expect(groups.query).toContain("(processor, statement_descriptor) IN (({p_desc_0_p:String}, {p_desc_0_v:String}))");
    expect(Object.values(groups.params)).toContain(PH_SENTINELS.rawMidRegistered);
    expect(Object.values(groups.params)).toContain(PH_SENTINELS.rawMidUnlabelled);
    expect(Object.values(groups.params)).toContain(PH_SENTINELS.descriptor);
    expect(scanForLeaks(response, { extra: SENTINELS })).toEqual([]);
    // Both Stripe MIDs carry the Stripe descriptor: 9 + 2 attempts.
    expect(response.by_dimension.map((row) => row.value.label).sort()).toEqual(["Stripe MID #1", "Unlabelled MID"]);
    expect(response.totals.current.attempts).toBe(11);
    // An unknown opaque id is a 400, not a silent empty filter.
    await expect(h.run({ action: "declines", filters: { merchant_account: ["aaaa0000-0000-4000-8000-00000000beef"] } })).rejects.toThrow(PaymentHealthRequestError);
  });

  it("a funnel filter applies to the anchor column", async () => {
    const h = harness();
    const response = await h.run<DeclinesResponse>({ action: "declines", dimension: "funnel", filters: { funnel: ["soulmate-sketch"] } });
    const groups = h.recording.statements.find((statement) => statement.query.includes("ph:declines_groups"))!;
    expect(groups.query).toContain("funnel IN ({p_fn_0:String})");
    expect(groups.params.p_fn_0).toBe("soulmate-sketch");
    const expected = passTotals(h.rows, RANGE.date_from, RANGE.date_to, (row) => FIXTURE_ANCHORS.get(row.user_id) === "soulmate-sketch");
    expect(response.totals.current).toMatchObject({ attempts: expected.attempts, successes: expected.successes });
    expect(expected.attempts).toBe(4);
    expect(response.by_dimension).toHaveLength(1);
    expect(response.by_dimension[0].value).toEqual({ key: "soulmate-sketch", label: "soulmate-sketch" });
  });
});

describe("parity with Payment Pass on the fixture rows", () => {
  it("overview totals: attempts / successes / settled amount of both windows, CANCELLED / PENDING excluded, raw_status '' kept", async () => {
    const h = harness();
    const response = await h.run<OverviewResponse>({ action: "overview" });
    const current = passTotals(h.rows, RANGE.date_from, RANGE.date_to);
    const baseline = passTotals(h.rows, "2026-08-02", "2026-08-31");
    expect(current).toMatchObject({ attempts: 16, successes: 6, settled_amount_usd: 138.95 });
    expect(baseline).toMatchObject({ attempts: 5, successes: 3 });
    expect(response.totals.current).toMatchObject({ attempts: 16, successes: 6, declines: 10, settled_amount_usd: 138.95, refunded: 1, refund_amount_usd: 49, cascade_rows: 1, three_ds_attempts: 1 });
    expect(response.totals.baseline).toMatchObject({ attempts: 5, successes: 3, declines: 2, refunded: 1, issuer_fraud_declines: 1 });
    // A complete window (data through 2026-10-03 covers it): the approval comparison is mature. The refund
    // rate is not — payments of the window have had only 3 days to be refunded, fewer than REFUND_MATURITY_DAYS.
    expect(response.totals.approval).toEqual(comparePeriods({ numerator: 6, denominator: 16 }, { numerator: 3, denominator: 5 }));
    expect(response.totals.approval.immature_period).toBe(false);
    expect(response.totals.refund_rate).toEqual(comparePeriods({ numerator: 1, denominator: 6 }, { numerator: 1, denominator: 3 }, { immature: true }));
    expect(response.meta).toMatchObject({ data_through: "2026-10-03", incomplete: false, lag_days: 3, psp_global_visible: true, funnel_attribution: { status: "active" } });
    expect(response.meta.range).toEqual({ from: "2026-09-01", to: "2026-09-30", days: 30 });
  });

  it("PSP × MID rows: per-processor sums equal the Payment Pass totals per processor; labels come from the registry", async () => {
    const h = harness();
    const response = await h.run<OverviewResponse>({ action: "overview" });
    const byProcessor = new Map<string, { attempts: number; successes: number }>();
    for (const row of response.psp_mid_rows) {
      const entry = byProcessor.get(row.processor.key) ?? { attempts: 0, successes: 0 };
      entry.attempts += row.current.attempts;
      entry.successes += row.current.successes;
      byProcessor.set(row.processor.key, entry);
    }
    for (const [key, pick] of [["STRIPE", (row: FixtureTx) => row.processor === "STRIPE"], ["ADYEN", (row: FixtureTx) => row.processor === "ADYEN"], ["unrouted", (row: FixtureTx) => row.processor === ""]] as const) {
      const expected = passTotals(h.rows, RANGE.date_from, RANGE.date_to, pick);
      expect(byProcessor.get(key), key).toEqual({ attempts: expected.attempts, successes: expected.successes });
    }
    expect(byProcessor.get("STRIPE")).toEqual({ attempts: 11, successes: 3 });
    expect(byProcessor.get("ADYEN")).toEqual({ attempts: 4, successes: 3 });
    expect(byProcessor.get("unrouted")).toEqual({ attempts: 1, successes: 0 });
    const labels = response.psp_mid_rows.map((row) => `${row.processor.label} / ${row.merchant_account.label}`);
    expect(labels).toEqual(["Stripe / Stripe MID #1", "Adyen / Adyen MID #1", "Stripe / Unlabelled MID", "No processor (declined before routing) / No MID"]);
    const stripe1 = response.psp_mid_rows[0];
    expect(stripe1.current).toMatchObject({ attempts: 9, successes: 2, issuer_fraud_declines: 1, lost_stolen_declines: 1, authentication_declines: 1, psp_integration_declines: 1 });
    expect(stripe1.complaints_unauthorized).toEqual({ current: 1, baseline: 1 });
    // The account's complaint rate is server-computed over ITS unfiltered settled payments (current: 09-02, 09-22; baseline: 08-05, 08-20).
    expect(stripe1.complaint_rate).toEqual(comparePeriods({ numerator: 1, denominator: 2 }, { numerator: 1, denominator: 2 }, { immature: true }));
    // The per-account trend is filled over the whole window: 30 daily points, zero where the account had no attempts.
    expect(stripe1.trend).toHaveLength(30);
    expect(stripe1.trend.filter((point) => point.attempts > 0).map((point) => point.bucket)).toEqual(["2026-09-02", "2026-09-10", "2026-09-12", "2026-09-13", "2026-09-15", "2026-09-18", "2026-09-19", "2026-09-22"]);
    expect(stripe1.trend.every((point) => !point.incomplete)).toBe(true);
    expect(scanForLeaks(response, { extra: SENTINELS })).toEqual([]);
  });

  it("the daily trend equals the per-day Payment Pass totals of the current window", async () => {
    const h = harness();
    const response = await h.run<OverviewResponse>({ action: "overview" });
    const current = passTotals(h.rows, RANGE.date_from, RANGE.date_to);
    const byDay = new Map<string, { attempts: number; successes: number }>();
    for (const row of current.rows) {
      const day = row.event_time.slice(0, 10);
      const entry = byDay.get(day) ?? { attempts: 0, successes: 0 };
      entry.attempts += 1;
      entry.successes += row.is_success;
      byDay.set(day, entry);
    }
    expect(response.meta.trend_granularity).toBe("day");
    // One point per day of the window: a day without attempts is a zero point (never a missing bar).
    const days = Array.from({ length: 30 }, (_, index) => shiftDay(RANGE.date_from, index));
    expect(response.trend.map((point) => [point.bucket, point.attempts, point.successes])).toEqual(days.map((day) => [day, byDay.get(day)?.attempts ?? 0, byDay.get(day)?.successes ?? 0]));
    expect(response.trend).toHaveLength(30);
    expect(byDay.size).toBe(15);
    expect(response.trend.find((point) => point.bucket === "2026-09-01")).toMatchObject({ attempts: 0, successes: 0, declines: 0, approval_rate: null, settled_amount_usd: 0, incomplete: false });
    expect(response.trend.find((point) => point.bucket === "2026-09-10")).toMatchObject({ issuer_fraud_declines: 1, approval_rate: 0, incomplete: false });
    expect(response.trend.find((point) => point.bucket === "2026-09-02")).toMatchObject({ attempts: 2, successes: 1, approval_rate: 0.5, settled_amount_usd: 19.99 });
  });

  it("decline classes equal classifyDecline applied to every decline row (mutually exclusive, they add up)", async () => {
    const h = harness();
    const [overview, declines] = await Promise.all([h.run<OverviewResponse>({ action: "overview" }), h.run<DeclinesResponse>({ action: "declines" })]);
    const expected: Partial<Record<DeclineClass, number>> = {};
    for (const row of passTotals(h.rows, RANGE.date_from, RANGE.date_to).rows.filter((candidate) => !candidate.is_success)) {
      const declineClass = classifyDecline(row).decline_class;
      expected[declineClass] = (expected[declineClass] ?? 0) + 1;
    }
    expect(expected).toEqual({ insufficient_funds: 4, issuer_suspected_fraud: 1, authentication: 1, psp_integration: 1, cause_unverified: 1, lost_stolen: 1, closed_account: 1 });
    expect(overview.totals.decline_classes).toEqual(expected);
    expect(Object.fromEntries(declines.by_class.map((row) => [row.decline_class, row.current]))).toEqual(expected);
    expect(declines.by_class.reduce((sum, row) => sum + row.current, 0)).toBe(10);
    expect(declines.by_class[0]).toMatchObject({ decline_class: "insufficient_funds", current: 4, baseline: 1, share_of_declines: 0.4, label: "Insufficient funds" });
    expect(declines.by_class.find((row) => row.decline_class === "issuer_suspected_fraud")?.label).toBe("Issuer suspected fraud (decline, not fraud)");
    // The breakdown by processor carries the same per-processor Payment Pass totals.
    expect(declines.by_dimension.map((row) => [row.value.key, row.current.attempts, row.current.successes])).toEqual([["STRIPE", 11, 3], ["ADYEN", 4, 3], ["unrouted", 1, 0]]);
    // RETRY_LATER ×4 soft; DO_NOT_RETRY ×2, UPDATE_DATA, the Visa category-1 advice code hard; AUTHORIZATION_FAILED and the unrouted row unknown.
    expect(declines.severity.current).toEqual({ soft: 4, hard: 4, unknown: 2 });
    const mix = declines.code_mix.find((row) => row.issuer_result_code === "59");
    expect(mix).toMatchObject({ decline_class: "issuer_suspected_fraud", advised_action: "DO_NOT_RETRY", severity: "hard", retry_ban: true, current: 1, baseline: 1 });
    expect(scanForLeaks(declines, { extra: SENTINELS })).toEqual([]);
  });

  it("the what-changed decomposition names the movers of the decline count per dimension", async () => {
    const h = harness();
    const response = await h.run<OverviewResponse>({ action: "overview" });
    const processor = response.what_changed.filter((row) => row.dimension === "processor");
    expect(processor.map((row) => row.value.key)).toContain("STRIPE");
    const stripe = processor.find((row) => row.value.key === "STRIPE")!;
    expect(stripe.decomposition).toMatchObject({ volume_before: 4, count_before: 2, volume_after: 11, count_after: 8, delta_count: 6 });
    expect(stripe.decomposition.volume_effect + stripe.decomposition.rate_effect).toBeCloseTo(6, 9);
    expect(response.what_changed.some((row) => row.dimension === "merchant_account")).toBe(true);
  });
});

describe("retries", () => {
  it("chains and compliance equal attemptChains over the window rows plus the 30-day lookback; summaries are window-bound", async () => {
    const h = harness();
    const response = await h.run<RetriesResponse>({ action: "retries" });
    expect(response.meta.rows_window).toEqual({ from: "2026-08-02", to: "2026-09-30", days: 60 });
    expect(response.meta).toMatchObject({ rows_read: 21, memo: "miss" });
    expect(response.meta.limited).toEqual({ attempt_rows: false, post_ban_attempts: false, rolling_windows: false });
    const rowsStatement = h.recording.statements.find((statement) => statement.query.includes("ph:attempt_rows"))!;
    expect(rowsStatement.query).toContain("LIMIT {row_cap:UInt32}");
    expect(rowsStatement.params.row_cap).toBe(300_001);

    // Independent: the same chain build over the same rows, restricted to chains that started in September.
    const attemptRows: AttemptRow[] = passTotals(h.rows, "2026-08-02", "2026-09-30").rows.map((row) => ({
      ...row,
      user_id: row.user_id,
      processor: row.processor || null,
      initiation_type: row.initiation_type || null,
      is_success: row.is_success === 1,
      raw_status: row.raw_status || null,
    }));
    const chains = buildAttemptChains(attemptRows).chains.filter((chain) => chain.started_at >= "2026-09-01");
    expect(chains).toHaveLength(14);
    expect(response.chains).toMatchObject({
      chains: 14,
      chains_with_decline: chains.filter((chain) => chain.had_decline).length,
      chains_recovered: chains.filter((chain) => chain.recovered).length,
      chains_final_success: chains.filter((chain) => chain.final_success).length,
      chains_first_try_success: chains.filter((chain) => chain.first_try_success).length,
      chains_post_ban_success: chains.filter((chain) => chain.post_ban_success).length,
      chains_cascade: 0,
      attempts: 16,
    });
    expect(response.chains).toMatchObject({ chains_with_decline: 10, chains_recovered: 2, chains_final_success: 6, chains_first_try_success: 4, chains_post_ban_success: 1 });
    expect(response.chains.retry_recovery_rate).toMatchObject({ numerator: 2, denominator: 10, rate: 0.2, small_sample: true });
    expect(response.chains.attempt_approval_rate).toMatchObject({ numerator: 6, denominator: 16 });

    expect(response.post_ban).toMatchObject({ banned_instruments: 4, retried_instruments: 2, attempts: 2, within_window: 2, cit: 2, mit: 0, same_processor: 1, switched_processor: 1, succeeded: 1, succeeded_switched_processor: 1, within_one_hour: 0 });
    // Per initiation over every post-ban attempt (the alert engine's fact; post_ban_attempts is capped and mixed).
    expect(response.post_ban.by_initiation).toEqual({ cit: { attempts: 2, succeeded: 1, switched_processor: 1 }, mit: { attempts: 0, succeeded: 0, switched_processor: 0 } });
    expect(response.post_ban_attempts.map((row) => [row.event_time.slice(0, 10), row.processor_relation, row.succeeded, row.ban_decline_class, row.ban_sources])).toEqual([
      ["2026-09-19", "same", false, "closed_account", ["visa_category_1"]],
      ["2026-09-11", "switched", true, "issuer_suspected_fraud", ["advised_action"]],
    ]);
    expect(response.post_ban_attempts[1].processor).toEqual({ key: "ADYEN", label: "Adyen" });
    expect(response.post_ban_attempts[1].merchant_account?.label).toBe("Adyen MID #1");
    for (const row of response.post_ban_attempts) expect(row.instrument).toMatch(/^[0-9a-f]{16}$/);
    expect(response.rolling).toMatchObject({ pairs: 9, violations: 0, windows: [], newest_violation_end: null });
    expect(response.cascade_rows).toBe(1);
    expect(scanForLeaks(response, { extra: SENTINELS })).toEqual([]);
    expect(JSON.stringify(response)).not.toContain("tx-");
  });

  it("is memoized per workspace + request for 60 s: a repeat runs no attempt-rows read, a different filter or an expired memo does", async () => {
    const h = harness();
    let now = NOW;
    const run = (request: Record<string, unknown>) =>
      runPaymentHealth({ tenantKey: PH_DATA_KEY, clickhouse: createScopedReader(h.ctx, h.recording), pg: h.pg, request: { ...RANGE, action: "retries", ...request }, pspVisible: true, clock: () => now }) as Promise<RetriesResponse>;
    const reads = () => h.recording.statements.filter((statement) => statement.query.includes("ph:attempt_rows")).length;
    expect((await run({})).meta.memo).toBe("miss");
    expect(reads()).toBe(1);
    now += 30_000;
    expect((await run({})).meta.memo).toBe("hit");
    expect(reads()).toBe(1);
    expect((await run({ filters: { card_network: ["VISA"] } })).meta.memo).toBe("miss");
    expect(reads()).toBe(2);
    now += 61_000;
    expect((await run({})).meta.memo).toBe("miss");
    expect(reads()).toBe(3);
    // Concurrent requests share one load.
    resetPaymentHealthMemo();
    h.recording.reset();
    const [a, b] = await Promise.all([run({}), run({})]);
    expect([a.meta.memo, b.meta.memo].sort()).toEqual(["coalesced", "miss"]);
    expect(reads()).toBe(1);
  });

  it("a caller without the PSP key gets the same figures with the account references stripped", async () => {
    const owner = harness();
    const viewer = harness({ pspVisible: false });
    const full = await owner.run<RetriesResponse>({ action: "retries" });
    const stripped = await viewer.run<RetriesResponse>({ action: "retries" });
    expect(stripped.chains).toEqual(full.chains);
    expect(stripped.post_ban).toEqual(full.post_ban);
    expect(stripped.post_ban_attempts.map((row) => [row.processor, row.merchant_account])).toEqual([[null, null], [null, null]]);
    expect(stripped.meta.psp_global_visible).toBe(false);
  });
});

describe("refunds and complaints", () => {
  it("refund rate by original payment date, by month, with observed-timing buckets", async () => {
    const h = harness();
    const response = await h.run<RefundsSupportResponse>({ action: "refunds_support", dimension: "funnel" });
    expect(response.refunds.totals.current).toMatchObject({ successes: 6, refunded: 1, refund_amount_usd: 49 });
    // Immature: data through 2026-10-03 is only 3 days past the window (REFUND_MATURITY_DAYS = 30), so the newest window's refunds are still arriving.
    expect(response.refunds.totals.refund_rate).toEqual(comparePeriods({ numerator: 1, denominator: 6 }, { numerator: 1, denominator: 3 }, { immature: true }));
    expect(response.refunds.totals.refund_rate.significance_reason).toBe("immature_period");
    expect(response.refunds.by_month).toEqual([{ month: "2026-09-01", settled: 6, refunded: 1, refund_amount_usd: 49, refund_rate: expect.objectContaining({ numerator: 1, denominator: 6 }) }]);
    expect(response.refunds.timing).toEqual({ observed: 1, unobserved: 0, within_7_days: 0, within_30_days: 1, within_90_days: 0, beyond_90_days: 0 });
    const pastLife = response.refunds.by_dimension.find((row) => row.value.key === "past-life")!;
    expect(pastLife.current).toMatchObject({ attempts: 2, successes: 2, refunded: 1 });
    // Rows grouped without the code columns never pretend to carry decline classes.
    expect(pastLife.decline_classes).toEqual({});
    expect(response.refunds.by_dimension.find((row) => row.value.key === "unattributed")?.current.cause_unverified_declines).toBe(0);
  });

  it("complaints: attributed to the last settled payment of the matched user within 30 days, else unattributed; versions mark a break", async () => {
    const h = harness();
    const response = await h.run<RefundsSupportResponse>({ action: "refunds_support" });
    const complaints = h.recording.statements.find((statement) => statement.query.includes("ph:complaints"))!;
    expect(complaints.query).toContain("fact_support_requests FINAL");
    expect(complaints.query).toContain("toIntervalDay({attribution_days:UInt32})");
    expect(complaints.params).toMatchObject({ attribution_days: 30, lookback_from: "2026-07-03", compare_from: "2026-08-02", range_to: "2026-09-30" });
    expect(response.complaints.attribution_days).toBe(30);
    expect(response.complaints.current).toEqual({ total: 4, possible_unauthorized_charge: 3, requires_refund: 2, duplicate_charge: 1, unattributed: 2 });
    expect(response.complaints.baseline).toEqual({ total: 1, possible_unauthorized_charge: 1, requires_refund: 0, duplicate_charge: 0, unattributed: 0 });
    expect(response.complaints.by_account.map((row) => [row.merchant_account.label, row.possible_unauthorized_charge, row.total])).toEqual([["Adyen MID #1", 1, 1], ["Stripe MID #1", 1, 1]]);
    // Over the window's settled payments (6 / 3), flagged immature like the refund rate (complaints about the newest window keep arriving).
    expect(response.complaints.support_unauthorized_rate).toEqual(comparePeriods({ numerator: 3, denominator: 6 }, { numerator: 1, denominator: 3 }, { immature: true }));
    expect(h.recording.statements.some((statement) => statement.query.includes("ph:settled_counts"))).toBe(true);
    expect(response.complaints.by_month.map((row) => [row.month, row.total, row.classification_versions, row.version_break])).toEqual([
      ["2026-08-01", 1, ["v1"], false],
      ["2026-09-01", 4, ["v2"], true],
    ]);
    expect(response.complaints.by_month[1].by_category).toEqual([
      { category: "Unauthorized or unexpected charge", count: 2 },
      { category: "Duplicate charge", count: 1 },
      { category: "Refund", count: 1 },
    ]);
    expect(scanForLeaks(response, { extra: SENTINELS })).toEqual([]);
  });
});

describe("sources and options", () => {
  it("sources: coverage per column, warehouse bounds, the last import and a lifecycle-only sync state", async () => {
    const h = harness();
    const response = await h.run<SourcesResponse>({ action: "sources" });
    // last_synced_at is ISO with a zone (from toUnixTimestamp64Milli), never a zone-less ClickHouse text the browser would parse as local time.
    expect(response.warehouse).toEqual({ attempt_rows: 22, first_day: "2026-08-05", last_day: "2026-10-03", last_synced_at: "2026-10-06T08:00:00.000Z", rows_without_raw_status: 1 });
    expect(h.recording.statements.find((statement) => statement.query.includes("ph:coverage"))?.query).toContain("toUnixTimestamp64Milli(max(clickhouse_synced_at))");
    const coverage = Object.fromEntries(response.coverage.map((row) => [row.column, row]));
    expect(coverage.raw_status).toEqual({ column: "raw_status", filled: 21, rows: 22, share: 21 / 22 });
    expect(coverage.processor_merchant_id.filled).toBe(21);
    expect(coverage.three_ds_response.filled).toBe(1);
    expect(coverage["refund_observed_at (of refunded)"]).toEqual({ column: "refund_observed_at (of refunded)", filled: 2, rows: 2, share: 1 });
    expect(coverage["decline_record (of declines)"]).toMatchObject({ rows: 12 });
    expect(response.last_import).toEqual({ imported_at: "2026-10-05T07:00:00.000Z", status: "completed", rows_total: 1200, rows_inserted: 1100, rows_updated: 100, source: "primer_csv" });
    expect(response.sync_state).toEqual({ status: "completed", updated_at: "2026-10-05T07:30:00.000Z", last_run_at: null });
    expect(response.support.by_month).toEqual([
      { month: "2026-08-01", requests: 1, classification_versions: ["v1"], version_break: false },
      { month: "2026-09-01", requests: 4, classification_versions: ["v2"], version_break: true },
    ]);
    // How far the support data reaches (newest received day, newest ClickHouse sync of a support row): its own pipeline.
    expect(response.support).toMatchObject({ last_day: "2026-09-25", last_synced_at: "2026-10-06T08:00:00.000Z" });
    expect(h.recording.statements.find((statement) => statement.query.includes("ph:support_versions"))?.query).toMatch(/max\(request_date\)[\s\S]*toUnixTimestamp64Milli\(max\(clickhouse_synced_at\)\)/);
    expect(response.metrics.find((metric) => metric.key === "disputes")).toMatchObject({ phase: "P3", available: false });
    expect(response.metrics.find((metric) => metric.key === "attempt_approval_rate")).toMatchObject({ phase: "P1", available: true });
    // The filename, the cursor and the error text of the Postgres rows stay out.
    expect(scanForLeaks(response, { extra: [...SENTINELS, "secret-cursor", "boom"] })).toEqual([]);
    expect(h.recording.statements.map((statement) => /ph:(\w+)/.exec(statement.query)?.[1])).toEqual(["registry", "coverage", "support_versions"]);
  });

  it("options: every non-PSP list over the whole tenant, the registry lists only with the PSP key, bounds from the registry", async () => {
    const h = harness();
    const response = await h.run<OptionsResponse>({ action: "options" });
    expect(response.options.funnel.map((entry) => entry.key).sort()).toEqual(["past-life", "soulmate-sketch", "unattributed"]);
    expect(response.options.country.map((entry) => entry.key).sort()).toEqual(["DE", "US", "unknown"]);
    // The unrouted decline has no card data: its network / method are the 'unknown' option (the same lowercase key the filter preserves).
    expect(response.options.card_network.map((entry) => entry.key).sort()).toEqual(["MASTERCARD", "VISA", "unknown"]);
    expect(response.options.payment_method.map((entry) => entry.key).sort()).toEqual(["APPLE_PAY", "PAYMENT_CARD", "unknown"]);
    expect(response.options.card_network.find((entry) => entry.key === "unknown")?.label).toBe("Unknown");
    expect(response.options.initiation.map((entry) => entry.key).sort()).toEqual(["cit", "mit"]);
    expect(response.options.transaction_type.map((entry) => entry.key).sort()).toEqual(["failed_payment", "first_subscription", "renewal_2", "trial", "upsell"]);
    expect(response.options.processor.map((entry) => entry.key)).toEqual(["ADYEN", "STRIPE", "unrouted"]);
    // Sorted by processor then label; 'unrouted' sorts after the upper-case processors.
    expect(response.options.merchant_account.map((entry) => entry.label)).toEqual(["Adyen MID #1", "Stripe MID #1", "Unlabelled MID", "No MID"]);
    // Adyen relays two descriptors (numbered by first seen); Stripe's one matches the registry prefix; the unrouted rows have none.
    expect(response.options.descriptor.map((entry) => entry.label)).toEqual(["Adyen descriptor #1", "Adyen descriptor #2", "SENTINEL* (Stripe MID #1)", "No descriptor"]);
    expect(response.options.dimensions.map((entry) => entry.key)).toHaveLength(9);
    expect(response.bounds).toEqual({ first_day: "2026-08-05", last_day: "2026-10-03" });
    const statement = h.recording.statements.find((candidate) => candidate.query.includes("ph:options"))!;
    expect(statement.params).toMatchObject({ window_from: "1970-01-02", window_to: "2100-12-31" });
    expect(statement.query).toContain("ARRAY JOIN");

    const viewer = harness({ pspVisible: false });
    const hidden = await viewer.run<OptionsResponse>({ action: "options" });
    expect(hidden.options.processor).toEqual([]);
    expect(hidden.options.merchant_account).toEqual([]);
    expect(hidden.options.descriptor).toEqual([]);
    expect(hidden.options.funnel).toEqual(response.options.funnel);
    expect(hidden.options.dimensions.map((entry) => entry.key)).toEqual(["funnel", "country", "card_network", "payment_method", "initiation", "stage"]);
    expect(scanForLeaks(response, { extra: SENTINELS })).toEqual([]);
  });

  it("the 'unknown' network / method key filters to the rows without one (it is never upper-cased away)", async () => {
    const h = harness();
    const network = await h.run<OverviewResponse>({ action: "overview", filters: { card_network: ["unknown"] } });
    const statement = h.recording.statements.find((candidate) => candidate.query.includes("ph:overview_groups"))!;
    expect(statement.query).toContain("card_network IN ({p_cn_0:String})");
    expect(statement.params.p_cn_0).toBe("unknown");
    // Exactly the unrouted decline (no card data), not zero rows.
    expect(network.totals.current).toMatchObject({ attempts: 1, successes: 0, declines: 1 });
    expect(network.totals.decline_classes).toEqual({ cause_unverified: 1 });
    const method = await h.run<DeclinesResponse>({ action: "declines", dimension: "payment_method", filters: { payment_method: ["unknown"] } });
    expect(method.totals.current.attempts).toBe(1);
    expect(method.by_dimension.map((row) => row.value)).toEqual([{ key: "unknown", label: "Unknown" }]);
  });

  it("the overview without the PSP key keeps the totals and empties the PSP × MID table and the account movers", async () => {
    const owner = harness();
    const viewer = harness({ pspVisible: false });
    const full = await owner.run<OverviewResponse>({ action: "overview" });
    const stripped = await viewer.run<OverviewResponse>({ action: "overview" });
    expect(stripped.totals).toEqual(full.totals);
    expect(stripped.trend).toEqual(full.trend);
    expect(stripped.psp_mid_rows).toEqual([]);
    expect(stripped.what_changed.map((row) => row.dimension)).not.toContain("processor");
    expect(stripped.what_changed.map((row) => row.dimension)).not.toContain("merchant_account");
    expect(stripped.meta.psp_global_visible).toBe(false);
  });
});

describe("maturity, caps, cascade rows and the complaint denominator", () => {
  it("an incomplete window (range.to after data_through) marks every comparison immature and the trailing trend buckets incomplete", async () => {
    const h = harness();
    const window = { date_from: "2026-09-07", date_to: "2026-10-06" }; // up to today; data through 2026-10-03
    const overview = await h.run<OverviewResponse>({ action: "overview", ...window });
    expect(overview.meta).toMatchObject({ incomplete: true, data_through: "2026-10-03" });
    for (const comparison of [overview.totals.approval, overview.totals.issuer_fraud_share, overview.totals.refund_rate, overview.totals.support_unauthorized_rate]) {
      expect(comparison).toMatchObject({ significant: false, significance_reason: "immature_period", immature_period: true });
      expect(comparison.delta_points).not.toBeNull();
    }
    for (const row of overview.psp_mid_rows) expect(row.approval.immature_period).toBe(true);
    // The filled series shows the lag: zero buckets after data_through, flagged incomplete.
    const after = overview.trend.filter((point) => point.bucket > "2026-10-03");
    expect(after.map((point) => point.bucket)).toEqual(["2026-10-04", "2026-10-05", "2026-10-06"]);
    for (const point of after) expect(point).toMatchObject({ attempts: 0, incomplete: true });
    expect(overview.trend.find((point) => point.bucket === "2026-10-03")).toMatchObject({ attempts: 1, successes: 1, incomplete: false });
    expect(overview.trend).toHaveLength(30);

    const declines = await h.run<DeclinesResponse>({ action: "declines", ...window });
    expect(declines.meta.incomplete).toBe(true);
    for (const row of declines.by_class) expect(row.rate).toMatchObject({ significant: false, immature_period: true });
    for (const row of declines.by_dimension) expect(row.approval.immature_period).toBe(true);

    // A window data_through covers by REFUND_MATURITY_DAYS: the refund and complaint comparisons are mature again.
    const mature = await h.run<RefundsSupportResponse>({ action: "refunds_support", date_from: "2026-08-02", date_to: "2026-08-31" });
    expect(shiftDay("2026-08-31", REFUND_MATURITY_DAYS) <= "2026-10-03").toBe(true);
    expect(mature.meta.incomplete).toBe(false);
    expect(mature.refunds.totals.refund_rate.immature_period).toBe(false);
    expect(mature.complaints.support_unauthorized_rate.immature_period).toBe(false);
    expect(mature.meta.estimates.some((note) => note.includes(`${REFUND_MATURITY_DAYS} days past the window`))).toBe(true);
    expect(overview.meta.estimates.some((note) => note.includes(`${REFUND_MATURITY_DAYS} days past the window`))).toBe(true);
  });

  it("cascade_rows counts every row with more than one decline record — a payment settled after an in-payment cascade included — the same in every tab", async () => {
    const rows: FixtureTx[] = [
      // The tx() helper zeroes decline_record_count for a success: this is the settled-after-cascade shape production holds.
      { ...tx({ t: T("2026-09-05"), status: "SETTLED", user_id: "c1", payment_instrument_key: "pi-c1" }), decline_record_count: 2 },
      tx({ t: T("2026-09-06"), user_id: "c2", decline_record_count: 3, payment_instrument_key: "pi-c2" }),
      tx({ t: T("2026-09-07"), user_id: "c3", payment_instrument_key: "pi-c3" }),
    ];
    const h = harness({ rows });
    const [overview, declines, retries] = await Promise.all([
      h.run<OverviewResponse>({ action: "overview" }),
      h.run<DeclinesResponse>({ action: "declines" }),
      h.run<RetriesResponse>({ action: "retries" }),
    ]);
    expect(overview.totals.current).toMatchObject({ attempts: 3, successes: 1, declines: 2, cascade_rows: 2 });
    expect(overview.psp_mid_rows[0].current.cascade_rows).toBe(2);
    expect(declines.totals.current.cascade_rows).toBe(2);
    expect(retries.cascade_rows).toBe(2);
  });

  it("the complaint rate keeps the window's UNFILTERED settled payments as denominator under a filter (support requests are not filterable)", async () => {
    const h = harness();
    const overview = await h.run<OverviewResponse>({ action: "overview", filters: { country: ["DE"] } });
    // The attempt figures are filtered (one DE row), the complaint rate is not: 3 flagged over the 6 settled of the window (1 / 3 before).
    expect(overview.totals.current).toMatchObject({ attempts: 1, successes: 1 });
    expect(overview.totals.support_unauthorized_rate.current).toMatchObject({ numerator: 3, denominator: 6 });
    expect(overview.totals.support_unauthorized_rate.baseline).toMatchObject({ numerator: 1, denominator: 3 });
    const settled = h.recording.statements.find((statement) => statement.query.includes("ph:settled_counts"))!;
    expect(settled.query).not.toContain("p_co_0");
    expect(settled.params).not.toHaveProperty("p_co_0");
    expect(settled.query).toContain(ATTEMPT_RAW_STATUS_EXCLUSION);
    // Per account too: Adyen MID #1 settled 3 payments in the window (one of them DE), one complaint is attributed to it.
    const adyen = overview.psp_mid_rows.find((row) => row.merchant_account.label === "Adyen MID #1")!;
    expect(adyen.current.successes).toBe(1);
    expect(adyen.complaint_rate.current).toMatchObject({ numerator: 1, denominator: 3 });
    expect(adyen.complaint_rate.baseline).toMatchObject({ numerator: 0, denominator: 1 });
    const refunds = await h.run<RefundsSupportResponse>({ action: "refunds_support", filters: { country: ["DE"] } });
    expect(refunds.refunds.totals.current.successes).toBe(1);
    expect(refunds.complaints.support_unauthorized_rate.current).toMatchObject({ numerator: 3, denominator: 6 });
  });

  it("the code-mix and post-ban caps are reported in meta.limited, never passed off as the whole list", async () => {
    const codes = Array.from({ length: CODE_MIX_LIMIT + 1 }, (_, index) => tx({ t: T("2026-09-10"), user_id: `k${index}`, issuer_result_code: String(200 + index), payment_instrument_key: `pi-k${index}` }));
    const capped = await harness({ rows: codes }).run<DeclinesResponse>({ action: "declines" });
    expect(capped.code_mix).toHaveLength(CODE_MIX_LIMIT);
    expect(capped.meta.limited).toEqual({ code_mix: true });
    const plain = await harness().run<DeclinesResponse>({ action: "declines" });
    expect(plain.meta.limited).toEqual({ code_mix: false });

    // POST_BAN_ATTEMPT_LIMIT + 1 instruments banned (issuer code 59, DO_NOT_RETRY) and re-attempted the next day: every attempt is counted, the newest 200 are returned.
    const banned = Array.from({ length: POST_BAN_ATTEMPT_LIMIT + 1 }, (_, index) => [
      tx({ t: T("2026-09-10", "09:00"), user_id: `b${index}`, issuer_result_code: "59", advised_action: "DO_NOT_RETRY", primer_decline_code: "DO_NOT_HONOR", decline_type: "hard", payment_instrument_key: `pi-b${index}` }),
      tx({ t: T("2026-09-11", "09:00"), user_id: `b${index}`, payment_instrument_key: `pi-b${index}` }),
    ]).flat();
    const retries = await harness({ rows: banned }).run<RetriesResponse>({ action: "retries" });
    expect(retries.post_ban.attempts).toBe(POST_BAN_ATTEMPT_LIMIT + 1);
    expect(retries.post_ban_attempts).toHaveLength(POST_BAN_ATTEMPT_LIMIT);
    expect(retries.meta.limited).toEqual({ attempt_rows: false, post_ban_attempts: true, rolling_windows: false });
    // The per-initiation split counts every attempt, not the capped list.
    expect(retries.post_ban.by_initiation.cit).toEqual({ attempts: POST_BAN_ATTEMPT_LIMIT + 1, succeeded: 0, switched_processor: 0 });
  });

  it("the rolling-window list is cut at ROLLING_WINDOW_LIMIT by max_declines; newest_violation_end still covers every violation", async () => {
    resetPaymentHealthMemo();
    // ROLLING_WINDOW_LIMIT pairs with 17 declines ending 2026-09-17, and one new pair with 16 ending 2026-09-27:
    // the newest violation has the fewest declines, so it is the one the cut drops.
    const day = (offset: number) => shiftDay("2026-09-01", offset);
    const heavy = Array.from({ length: ROLLING_WINDOW_LIMIT }, (_, pair) =>
      Array.from({ length: 17 }, (_, index) => tx({ t: T(day(index), "06:00"), user_id: `r${pair}`, payment_instrument_key: `pi-r${pair}`, transaction_id: `r-${pair}-${index}` }))).flat();
    const fresh = Array.from({ length: 16 }, (_, index) => tx({ t: T(day(11 + index), "06:30"), user_id: "r-new", payment_instrument_key: "pi-r-new", transaction_id: `r-new-${index}` }));
    const retries = await harness({ rows: [...heavy, ...fresh] }).run<RetriesResponse>({ action: "retries" });
    expect(retries.rolling.violations).toBe(ROLLING_WINDOW_LIMIT + 1);
    expect(retries.rolling.windows).toHaveLength(ROLLING_WINDOW_LIMIT);
    expect(retries.meta.limited.rolling_windows).toBe(true);
    expect(retries.rolling.windows.every((entry) => entry.max_declines === 17)).toBe(true);
    expect(retries.rolling.windows.map((entry) => entry.window_end.slice(0, 10)).sort().at(-1)).toBe("2026-09-17");
    expect(retries.rolling.newest_violation_end?.slice(0, 10)).toBe("2026-09-27");
  });
});
