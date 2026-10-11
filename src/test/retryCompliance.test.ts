// Payment System Health P1: retry compliance (plan G retry_compliance, L, Q;
// plan Z #10, 20): attempts after a ban on the same instrument split CIT / MIT
// and same / switched processor, and the rolling 30-day decline count per
// (payment_instrument_key, processor_merchant_id) with the > 15 flag, counted
// by decline records. Every value is synthetic.
import { describe, expect, it } from "vitest";
import { UNKNOWN_MID, retryCompliance, type AttemptRow } from "../../supabase/functions/_shared/clickhouse/attemptChains.ts";

let seq = 0;

interface RowSpec {
  id?: string;
  t: string;
  user?: string | null;
  status?: "SETTLED" | "DECLINED" | "FAILED" | "CANCELLED" | "PENDING";
  instrument?: string | null;
  processor?: string | null;
  mid?: string | null;
  init?: "cit" | "mit" | null;
  advised?: string | null;
  issuer?: string | null;
  advice?: string | null;
  network?: string | null;
  records?: number | null;
}

function row(spec: RowSpec): AttemptRow {
  seq += 1;
  const success = spec.status === "SETTLED";
  return {
    transaction_id: spec.id ?? `tx-${String(seq).padStart(3, "0")}`,
    user_id: spec.user === undefined ? "user-a" : spec.user,
    event_time: spec.t,
    raw_status: spec.status ?? "DECLINED",
    processor: spec.processor === undefined ? "STRIPE" : spec.processor,
    processor_merchant_id: spec.mid === undefined ? "mid-1" : spec.mid,
    payment_instrument_key: spec.instrument === undefined ? "pi-a" : spec.instrument,
    currency: "USD",
    original_amount: 1999,
    price_point: "pp-1",
    initiation_type: spec.init === undefined ? "mit" : spec.init,
    card_network: spec.network === undefined ? "VISA" : spec.network,
    primer_decline_code: success ? null : "INSUFFICIENT_FUNDS",
    issuer_result_code: success ? null : spec.issuer === undefined ? "51" : spec.issuer,
    advice_code: spec.advice ?? null,
    advised_action: success ? null : spec.advised === undefined ? "RETRY_LATER" : spec.advised,
    lifecycle_event: success ? "AUTHORIZATION_SUCCESS" : "AUTHORIZATION_DECLINED",
    decline_record_count: success ? 0 : spec.records === undefined ? 1 : spec.records,
  };
}

const at = (day: number, hhmm = "10:00") => `2026-09-${String(day).padStart(2, "0")}T${hhmm}:00.000Z`;

describe("(a) attempts after a ban on the same instrument, split CIT / MIT and same / switched processor", () => {
  it("lists every later attempt on the banned instrument with its split, and nothing before the ban", () => {
    const report = retryCompliance([
      row({ id: "before", t: at(1), instrument: "pi-a" }),
      row({ id: "ban", t: at(2), instrument: "pi-a", advised: "DO_NOT_RETRY", processor: "STRIPE", init: "mit" }),
      row({ id: "mit-same", t: at(2, "10:30"), instrument: "pi-a", processor: "STRIPE", init: "mit" }),
      row({ id: "cit-switched", t: at(4), instrument: "pi-a", processor: "ADYEN", init: "cit", status: "SETTLED" }),
      row({ id: "unrouted", t: at(5), instrument: "pi-a", processor: null, issuer: null, advised: null, init: "cit" }),
      // Another instrument, banned and never retried.
      row({ id: "ban-b", t: at(3), instrument: "pi-b", advised: "STOP_ALL_PAYMENTS" }),
      // A clean instrument.
      row({ id: "clean", t: at(3), instrument: "pi-c" }),
    ]);
    expect(report.post_ban_attempts.map((attempt) => attempt.transaction_id)).toEqual(["mit-same", "cit-switched", "unrouted"]);
    expect(report.post_ban_attempts[0]).toMatchObject({
      payment_instrument_key: "pi-a",
      ban_transaction_id: "ban",
      ban_sources: ["advised_action"],
      ban_processor: "STRIPE",
      initiation_type: "mit",
      processor_relation: "same",
      same_processor: true,
      succeeded: false,
      banned_again: false,
      minutes_since_ban: 30,
    });
    expect(report.post_ban_attempts[1]).toMatchObject({ initiation_type: "cit", processor_relation: "switched", same_processor: false, succeeded: true, minutes_since_ban: 2 * 24 * 60 });
    expect(report.post_ban_attempts[2]).toMatchObject({ processor_relation: "unknown", succeeded: false });
    expect(report.post_ban_summary).toEqual({
      banned_instruments: 2,
      retried_instruments: 1,
      attempts: 3,
      cit: 2,
      mit: 1,
      unknown_initiation: 0,
      same_processor: 1,
      switched_processor: 1,
      unknown_processor: 1,
      succeeded: 1,
      succeeded_switched_processor: 1,
      within_one_hour: 1,
    });
  });

  it("bans through Visa category 1 and MAC 03 / 21; a second banning decline is flagged banned_again", () => {
    const report = retryCompliance([
      row({ id: "visa-ban", t: at(1), instrument: "pi-v", issuer: "43", network: "VISA" }),
      row({ id: "visa-retry", t: at(2), instrument: "pi-v", advised: "DO_NOT_RETRY" }),
      row({ id: "mac-ban", t: at(1), instrument: "pi-m", network: "MASTERCARD", issuer: "05", advice: "03" }),
      row({ id: "mac-retry", t: at(1, "10:10"), instrument: "pi-m", network: "MASTERCARD", status: "SETTLED" }),
      // 41 on a Mastercard without a MAC is not a ban under plan G.
      row({ id: "mc-lost", t: at(1), instrument: "pi-x", network: "MASTERCARD", issuer: "41" }),
      row({ id: "mc-lost-retry", t: at(2), instrument: "pi-x", network: "MASTERCARD" }),
      // Visa category 3 relayed as advice code "3" is not MAC 03: no ban, the retry after new data is not a post-ban attempt.
      row({ id: "visa3", t: at(1), instrument: "pi-3", network: "VISA", issuer: "N7", advice: "3", advised: "UPDATE_DATA" }),
      row({ id: "visa3-retry", t: at(1, "10:10"), instrument: "pi-3", network: "VISA", status: "SETTLED" }),
    ]);
    const byId = new Map(report.post_ban_attempts.map((attempt) => [attempt.transaction_id, attempt]));
    expect([...byId.keys()].sort()).toEqual(["mac-retry", "visa-retry"]);
    expect(byId.get("visa-retry")).toMatchObject({ ban_sources: ["visa_category_1"], banned_again: true });
    expect(byId.get("mac-retry")).toMatchObject({ ban_sources: ["mc_mac_03_21"], succeeded: true, minutes_since_ban: 10 });
    expect(report.post_ban_summary).toMatchObject({ banned_instruments: 2, retried_instruments: 2, attempts: 2, within_one_hour: 1 });
  });

  it("ignores rows without an instrument key and rows that are not attempts", () => {
    const report = retryCompliance([
      row({ t: at(1), instrument: null, advised: "DO_NOT_RETRY" }),
      row({ t: at(2), instrument: null, status: "SETTLED" }),
      row({ t: at(1), instrument: "pi-a", advised: "DO_NOT_RETRY" }),
      row({ t: at(2), instrument: "pi-a", status: "CANCELLED" }),
      row({ t: at(3), instrument: "pi-a", status: "PENDING" }),
    ]);
    expect(report.post_ban_attempts).toEqual([]);
    expect(report.post_ban_summary).toMatchObject({ banned_instruments: 1, retried_instruments: 0, attempts: 0 });
  });
});

describe("(b) rolling 30-day declines per instrument and MID, by decline records", () => {
  it("flags more than 15 decline records in any 30-day window and reports the window", () => {
    const sixteen = Array.from({ length: 16 }, (_, index) => row({ t: at(index + 1), instrument: "pi-a", mid: "mid-1" }));
    const report = retryCompliance(sixteen);
    expect(report.rolling_windows).toEqual([
      expect.objectContaining({
        payment_instrument_key: "pi-a",
        processor_merchant_id: "mid-1",
        max_declines: 16,
        window_start: at(1),
        window_end: at(16),
        decline_records_total: 16,
        decline_rows_total: 16,
        exceeds_limit: true,
        limit: 15,
      }),
    ]);
    expect(report.rolling_violations).toBe(1);

    const fifteen = retryCompliance(sixteen.slice(0, 15));
    expect(fifteen.rolling_windows[0]).toMatchObject({ max_declines: 15, exceeds_limit: false });
    expect(fifteen.rolling_violations).toBe(0);
    expect(retryCompliance(sixteen.slice(0, 15), { rollingDeclineLimit: 10 }).rolling_violations).toBe(1);
  });

  it("slides: declines spread over more than 30 days are not one window; exactly 30 days apart is a new window", () => {
    // 16 declines every 3 days (Sep 1 ... Oct 16): any 30-day window holds at most 10.
    const days = Array.from({ length: 16 }, (_, index) => new Date(Date.UTC(2026, 8, 1 + index * 3, 10)).toISOString());
    const report = retryCompliance(days.map((t) => row({ t, instrument: "pi-a" })));
    expect(report.rolling_windows[0]).toMatchObject({ max_declines: 10, exceeds_limit: false, decline_rows_total: 16 });

    const boundary = retryCompliance([
      row({ t: "2026-09-01T10:00:00.000Z", instrument: "pi-a" }),
      row({ t: "2026-10-01T09:59:59.000Z", instrument: "pi-a" }), // inside (29 days 23:59:59)
      row({ t: "2026-10-01T10:00:00.000Z", instrument: "pi-a" }), // exactly 30 days: outside the first window
    ]);
    expect(boundary.rolling_windows[0].max_declines).toBe(2);
  });

  it("counts decline RECORDS (decline_record_count), not rows", () => {
    const eightRowsSixteenRecords = Array.from({ length: 8 }, (_, index) => row({ t: at(index + 1), instrument: "pi-a", records: 2 }));
    const report = retryCompliance(eightRowsSixteenRecords);
    expect(report.rolling_windows[0]).toMatchObject({ max_declines: 16, decline_records_total: 16, decline_rows_total: 8, exceeds_limit: true });
    expect(report.cascade_rows).toHaveLength(8);
    // A null / zero record count still counts as one decline.
    const nulls = retryCompliance([row({ t: at(1), instrument: "pi-a", records: null }), row({ t: at(2), instrument: "pi-a", records: 0 })]);
    expect(nulls.rolling_windows[0]).toMatchObject({ max_declines: 2, decline_records_total: 2 });
    expect(nulls.cascade_rows).toEqual([]);
  });

  it("keeps instrument × MID pairs apart, buckets a missing MID as unknown_mid, skips successes and rows without an instrument", () => {
    const report = retryCompliance([
      ...Array.from({ length: 9 }, (_, index) => row({ t: at(index + 1), instrument: "pi-a", mid: "mid-1" })),
      ...Array.from({ length: 9 }, (_, index) => row({ t: at(index + 1, "11:00"), instrument: "pi-a", mid: "mid-2" })),
      row({ t: at(1, "12:00"), instrument: "pi-a", mid: null }),
      row({ t: at(2, "12:00"), instrument: "pi-a", mid: "mid-1", status: "SETTLED" }),
      row({ t: at(3, "12:00"), instrument: null, mid: "mid-1" }),
    ]);
    expect(report.rolling_windows.map((window) => [window.processor_merchant_id, window.max_declines])).toEqual([
      ["mid-1", 9],
      ["mid-2", 9],
      [UNKNOWN_MID, 1],
    ]);
    expect(report.rolling_violations).toBe(0);
    expect(UNKNOWN_MID).toBe("unknown_mid");
  });

  it("lists cascade rows (decline_record_count > 1) and echoes the resolved options", () => {
    const report = retryCompliance([row({ id: "c1", t: at(1), records: 3 }), row({ id: "c2", t: at(2), records: 1 }), row({ id: "c3", t: at(3), records: 2, status: "SETTLED" })], {
      rollingWindowDays: 7,
    });
    expect(report.cascade_rows).toEqual(["c1"]);
    expect(report.options).toMatchObject({ rollingWindowMs: 7 * 86_400_000, rollingDeclineLimit: 15 });
  });
});
