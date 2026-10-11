// Payment System Health P1: attempt chains (plan G payment_intent,
// final_success_rate, chain_first_try_approval_rate, retry_recovery_rate,
// cascade_recovery; plan Z #4, 8, 15). Edge cases: ties at one timestamp,
// nulls (user, instrument, processor, time), a switched processor, a success
// after a ban that is a violation and never a recovery, windows per CIT / MIT,
// a success closing the intent, cascade rows. Every value is synthetic.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHAIN_OPTIONS,
  buildAttemptChains,
  normalizeInitiationType,
  resolveChainOptions,
  type AttemptRow,
} from "../../supabase/functions/_shared/clickhouse/attemptChains.ts";

let seq = 0;

interface RowSpec {
  id?: string;
  t: string;
  user?: string | null;
  status?: "SETTLED" | "DECLINED" | "FAILED" | "CANCELLED" | "PENDING" | null;
  instrument?: string | null;
  processor?: string | null;
  mid?: string | null;
  init?: "cit" | "mit" | null;
  price?: string | null;
  currency?: string | null;
  amount?: number | null;
  advised?: string | null;
  issuer?: string | null;
  advice?: string | null;
  network?: string | null;
  records?: number | null;
  isSuccess?: boolean | null;
}

function row(spec: RowSpec): AttemptRow {
  seq += 1;
  const success = spec.status === "SETTLED";
  return {
    transaction_id: spec.id ?? `tx-${String(seq).padStart(3, "0")}`,
    user_id: spec.user === undefined ? "user-a" : spec.user,
    event_time: spec.t,
    raw_status: spec.status === undefined ? "DECLINED" : spec.status,
    is_success: spec.isSuccess === undefined ? success : spec.isSuccess,
    processor: spec.processor === undefined ? "STRIPE" : spec.processor,
    processor_merchant_id: spec.mid === undefined ? "mid-1" : spec.mid,
    payment_instrument_key: spec.instrument === undefined ? "pi-a" : spec.instrument,
    currency: spec.currency === undefined ? "USD" : spec.currency,
    original_amount: spec.amount === undefined ? 1999 : spec.amount,
    price_point: spec.price === undefined ? "pp-1" : spec.price,
    initiation_type: spec.init === undefined ? "cit" : spec.init,
    card_network: spec.network === undefined ? "VISA" : spec.network,
    primer_decline_code: success ? null : "INSUFFICIENT_FUNDS",
    issuer_result_code: success ? null : spec.issuer === undefined ? "51" : spec.issuer,
    advice_code: spec.advice ?? null,
    advised_action: success ? null : spec.advised === undefined ? "RETRY_LATER" : spec.advised,
    lifecycle_event: success ? "AUTHORIZATION_SUCCESS" : "AUTHORIZATION_DECLINED",
    decline_record_count: success ? 0 : spec.records === undefined ? 1 : spec.records,
  };
}

const T = (hhmm: string, day = "2026-09-01") => `${day}T${hhmm}:00.000Z`;

describe("chain building: key, window, ties and the success that closes an intent", () => {
  it("links a CIT decline, a retry and the success within 60 minutes into one recovered chain", () => {
    const { chains, summary } = buildAttemptChains([
      row({ t: T("10:00") }),
      row({ t: T("10:20") }),
      row({ t: T("10:40"), status: "SETTLED" }),
    ]);
    expect(chains).toHaveLength(1);
    const [chain] = chains;
    expect(chain).toMatchObject({
      key_kind: "instrument",
      initiation_type: "cit",
      attempt_count: 3,
      decline_count: 2,
      first_try_success: false,
      final_success: true,
      had_decline: true,
      recovered: true,
      post_ban_success: false,
      cascade: false,
      cascade_recovered: false,
      first_ban_index: null,
      window_ms: 3_600_000,
    });
    expect(chain.attempts.map((attempt) => attempt.success)).toEqual([false, false, true]);
    expect(chain.attempts[0].decline?.decline_class).toBe("insufficient_funds");
    expect(chain.attempts[2].decline).toBeNull();
    expect(summary).toMatchObject({ rows: 3, attempts: 3, chains: 1, chains_with_decline: 1, chains_recovered: 1, chains_final_success: 1, chains_first_try_success: 0 });
  });

  it("splits chains at the window: CIT 60 minutes, MIT 72 hours, both configurable", () => {
    const cit = buildAttemptChains([row({ t: T("10:00") }), row({ t: T("11:30"), status: "SETTLED" })]);
    expect(cit.chains).toHaveLength(2);
    expect(cit.chains.map((chain) => chain.recovered)).toEqual([false, false]);
    const citWide = buildAttemptChains([row({ t: T("10:00") }), row({ t: T("11:30"), status: "SETTLED" })], { citWindowMinutes: 120 });
    expect(citWide.chains).toHaveLength(1);
    expect(citWide.chains[0].recovered).toBe(true);

    const mit = buildAttemptChains([
      row({ t: T("10:00", "2026-09-01"), init: "mit" }),
      row({ t: T("10:00", "2026-09-03"), init: "mit" }),
      row({ t: T("09:00", "2026-09-06"), init: "mit", status: "SETTLED" }),
    ]);
    expect(mit.chains).toHaveLength(1);
    expect(mit.chains[0]).toMatchObject({ initiation_type: "mit", attempt_count: 3, recovered: true, window_ms: 259_200_000 });
    const mitSplit = buildAttemptChains([row({ t: T("10:00", "2026-09-01"), init: "mit" }), row({ t: T("10:01", "2026-09-04"), init: "mit", status: "SETTLED" })]);
    expect(mitSplit.chains).toHaveLength(2);
    // Exactly at the window edge still links (gap <= window).
    const edge = buildAttemptChains([row({ t: T("10:00") }), row({ t: T("11:00"), status: "SETTLED" })]);
    expect(edge.chains).toHaveLength(1);
    expect(resolveChainOptions()).toEqual({ citWindowMs: 3_600_000, mitWindowMs: 259_200_000, rollingWindowMs: 2_592_000_000, rollingDeclineLimit: 15 });
    expect(DEFAULT_CHAIN_OPTIONS).toEqual({ citWindowMinutes: 60, mitWindowHours: 72, rollingWindowDays: 30, rollingDeclineLimit: 15 });
  });

  it("a settled attempt ends the intent: a later attempt with the same key is a new chain", () => {
    const { chains, summary } = buildAttemptChains([
      row({ t: T("10:00"), status: "SETTLED" }),
      row({ t: T("10:10") }),
      row({ t: T("10:15"), status: "SETTLED" }),
    ]);
    expect(chains).toHaveLength(2);
    expect(chains[0]).toMatchObject({ attempt_count: 1, first_try_success: true, final_success: true, had_decline: false, recovered: false });
    expect(chains[1]).toMatchObject({ attempt_count: 2, first_try_success: false, recovered: true });
    expect(summary).toMatchObject({ chains: 2, chains_first_try_success: 1, chains_final_success: 2, chains_with_decline: 1, chains_recovered: 1 });
  });

  it("keys on user, instrument (or currency + amount), price point and initiation; the transaction type is not in the key", () => {
    const { chains } = buildAttemptChains([
      row({ t: T("10:00") }),
      row({ t: T("10:01"), price: "pp-2" }), // another price point
      row({ t: T("10:02"), init: "mit" }), // another initiation
      row({ t: T("10:03"), instrument: "pi-b" }), // another instrument
      row({ t: T("10:04"), user: "user-b" }), // another user
      row({ t: T("10:05"), status: "SETTLED" }), // same key as the first
    ]);
    expect(chains).toHaveLength(5);
    const main = chains.find((chain) => chain.attempt_count === 2)!;
    expect(main.recovered).toBe(true);
    expect(main.attempts.map((attempt) => attempt.event_time)).toEqual([T("10:00"), T("10:05")]);

    // No instrument key: currency + amount stand in; a different amount is a different intent.
    const fallback = buildAttemptChains([
      row({ t: T("10:00"), instrument: null, amount: 1999 }),
      row({ t: T("10:05"), instrument: null, amount: 1999, status: "SETTLED" }),
      row({ t: T("10:06"), instrument: null, amount: 4999 }),
    ]);
    expect(fallback.chains.map((chain) => [chain.key_kind, chain.attempt_count])).toEqual([["currency_amount", 2], ["currency_amount", 1]]);
    expect(fallback.chains[0].recovered).toBe(true);
  });

  it("orders ties: a decline before a success at the same instant is a recovery; two declines by transaction id", () => {
    const tie = buildAttemptChains([
      row({ id: "tx-zz", t: T("10:00"), status: "SETTLED" }),
      row({ id: "tx-aa", t: T("10:00") }),
    ]);
    expect(tie.chains).toHaveLength(1);
    expect(tie.chains[0].attempts.map((attempt) => attempt.transaction_id)).toEqual(["tx-aa", "tx-zz"]);
    expect(tie.chains[0].recovered).toBe(true);

    const declines = buildAttemptChains([row({ id: "tx-b", t: T("10:00") }), row({ id: "tx-a", t: T("10:00") })]);
    expect(declines.chains[0].attempts.map((attempt) => attempt.transaction_id)).toEqual(["tx-a", "tx-b"]);
    expect(declines.chains[0].final_success).toBe(false);
  });

  it("handles nulls: no user -> singleton chains, no time or a non-attempt status -> excluded, unknown initiation -> CIT window", () => {
    const { chains, summary } = buildAttemptChains([
      row({ t: T("10:00"), user: null }),
      row({ t: T("10:01"), user: "" , status: "SETTLED" }),
      row({ t: "not a date" }),
      row({ t: T("10:02"), status: "CANCELLED" }),
      row({ t: T("10:03"), status: "PENDING" }),
      row({ t: T("10:04"), status: null, isSuccess: null }),
      row({ t: T("10:05"), init: null }),
      row({ t: T("10:30"), init: null, status: "SETTLED" }),
    ]);
    expect(summary.not_attempts).toBe(4);
    expect(summary.attempts).toBe(4);
    expect(summary.chains_singleton).toBe(2);
    const unknown = chains.find((chain) => chain.initiation_type === "unknown")!;
    expect(unknown).toMatchObject({ attempt_count: 2, recovered: true, window_ms: 3_600_000 });
    expect(normalizeInitiationType("CIT")).toBe("cit");
    expect(normalizeInitiationType("merchant_initiated")).toBe("mit");
    expect(normalizeInitiationType(null)).toBe("unknown");
    // A row without raw_status but with is_success still counts (pre-P0 rows).
    const legacy = buildAttemptChains([row({ t: T("10:00"), status: null, isSuccess: false }), row({ t: T("10:05"), status: null, isSuccess: true })]);
    expect(legacy.chains[0]).toMatchObject({ attempt_count: 2, recovered: true });
  });

  it("sorts chains by start time and keeps a stable id", () => {
    const { chains } = buildAttemptChains([row({ t: T("12:00"), user: "user-z" }), row({ t: T("09:00"), user: "user-a" })]);
    expect(chains.map((chain) => chain.user_id)).toEqual(["user-a", "user-z"]);
    expect(chains[0].chain_id).toMatch(/^u:user-a\|i:pi-a\|p:pp-1\|cit@tx-/);
  });
});

describe("bans: a success after DO_NOT_RETRY / STOP_ALL_PAYMENTS / Visa category 1 / MAC 03, 21 is a violation, never a recovery", () => {
  it("excludes the post-ban success from recovery inside the chain", () => {
    const { chains, summary } = buildAttemptChains([
      row({ t: T("10:00"), advised: "DO_NOT_RETRY" }),
      row({ t: T("10:05"), status: "SETTLED" }),
    ]);
    const [chain] = chains;
    expect(chain).toMatchObject({
      final_success: true,
      had_decline: true,
      recovered: false,
      post_ban_success: true,
      first_ban_index: 0,
      post_ban_attempt_count: 1,
    });
    expect(chain.attempts[0]).toMatchObject({ ban: true, ban_sources: ["advised_action"], post_ban: false });
    expect(chain.attempts[1]).toMatchObject({ ban: false, post_ban: true, success: true });
    expect(summary).toMatchObject({ chains_final_success: 1, chains_recovered: 0, chains_post_ban_success: 1 });
  });

  it("applies the ban across chains on the same instrument: a later intent on a banned card is post-ban", () => {
    const { chains } = buildAttemptChains([
      row({ t: T("10:00", "2026-09-01"), advised: "STOP_ALL_PAYMENTS", price: "pp-1", init: "mit" }),
      row({ t: T("10:00", "2026-09-10"), price: "pp-2" }),
      row({ t: T("10:05", "2026-09-10"), price: "pp-2", status: "SETTLED" }),
    ]);
    expect(chains).toHaveLength(2);
    const later = chains[1];
    expect(later.price_point).toBe("pp-2");
    expect(later.attempts.every((attempt) => attempt.post_ban)).toBe(true);
    expect(later).toMatchObject({ final_success: true, recovered: false, post_ban_success: true, first_ban_index: null, post_ban_attempt_count: 2 });
    // The same intent on ANOTHER instrument is untouched.
    const other = buildAttemptChains([
      row({ t: T("10:00", "2026-09-01"), advised: "STOP_ALL_PAYMENTS", instrument: "pi-a" }),
      row({ t: T("10:00", "2026-09-10"), instrument: "pi-b" }),
      row({ t: T("10:05", "2026-09-10"), instrument: "pi-b", status: "SETTLED" }),
    ]);
    expect(other.chains[1]).toMatchObject({ recovered: true, post_ban_success: false, post_ban_attempt_count: 0 });
  });

  it("bans through a Visa category 1 code and through Mastercard MAC 03 / 21, not through a category 2 code", () => {
    const visa = buildAttemptChains([
      row({ t: T("10:00"), issuer: "41", advised: "RETRY_LATER", network: "VISA" }),
      row({ t: T("10:05"), status: "SETTLED" }),
    ]);
    expect(visa.chains[0].attempts[0].ban_sources).toEqual(["visa_category_1"]);
    expect(visa.chains[0]).toMatchObject({ recovered: false, post_ban_success: true });

    const mac = buildAttemptChains([
      row({ t: T("10:00"), network: "MASTERCARD", issuer: "05", advice: "21", advised: "RETRY_LATER" }),
      row({ t: T("10:05"), network: "MASTERCARD", status: "SETTLED" }),
    ]);
    expect(mac.chains[0].attempts[0].ban_sources).toEqual(["mc_mac_03_21"]);
    expect(mac.chains[0].recovered).toBe(false);

    const soft = buildAttemptChains([
      row({ t: T("10:00"), issuer: "51", advised: "RETRY_LATER" }),
      row({ t: T("10:05"), status: "SETTLED" }),
    ]);
    expect(soft.chains[0]).toMatchObject({ recovered: true, post_ban_success: false });
    // 41 on a Mastercard is not a Visa category 1 ban.
    const mcLost = buildAttemptChains([
      row({ t: T("10:00"), network: "MASTERCARD", issuer: "41", advised: "RETRY_LATER" }),
      row({ t: T("10:05"), network: "MASTERCARD", status: "SETTLED" }),
    ]);
    expect(mcLost.chains[0].recovered).toBe(true);
  });

  it("a Visa category 3 decline (advice code 3, UPDATE_DATA) is not MAC 03: the retry after new data is a recovery, not a violation", () => {
    const { chains, summary } = buildAttemptChains([
      row({ t: T("10:00"), network: "VISA", issuer: "N7", advice: "3", advised: "UPDATE_DATA" }),
      row({ t: T("10:05"), network: "VISA", status: "SETTLED" }),
    ]);
    expect(chains).toHaveLength(1);
    expect(chains[0].attempts[0]).toMatchObject({ ban: false, ban_sources: [], post_ban: false });
    expect(chains[0].attempts[0].decline).toMatchObject({ visa_category: 3, merchant_advice: null, retry_ban: false });
    expect(chains[0]).toMatchObject({ recovered: true, post_ban_success: false, first_ban_index: null, post_ban_attempt_count: 0 });
    expect(summary).toMatchObject({ chains_recovered: 1, chains_post_ban_success: 0 });
    // The same digits on a Mastercard row are MAC 03: a ban.
    const mac = buildAttemptChains([
      row({ t: T("10:00"), network: "MASTERCARD", issuer: "05", advice: "03", advised: "RETRY_LATER" }),
      row({ t: T("10:05"), network: "MASTERCARD", status: "SETTLED" }),
    ]);
    expect(mac.chains[0].attempts[0].ban_sources).toEqual(["mc_mac_03_21"]);
    expect(mac.chains[0]).toMatchObject({ recovered: false, post_ban_success: true });
  });

  it("a chain without an instrument key: a ban inside it still excludes the later success (conservative), bans elsewhere do not reach it", () => {
    const inside = buildAttemptChains([
      row({ t: T("10:00"), instrument: null, advised: "DO_NOT_RETRY" }),
      row({ t: T("10:05"), instrument: null, status: "SETTLED" }),
    ]);
    expect(inside.chains[0]).toMatchObject({ key_kind: "currency_amount", recovered: false, post_ban_success: true });
    const elsewhere = buildAttemptChains([
      row({ t: T("10:00", "2026-09-01"), instrument: null, amount: 4999, advised: "DO_NOT_RETRY" }),
      row({ t: T("10:00", "2026-09-02"), instrument: null, amount: 1999 }),
      row({ t: T("10:05", "2026-09-02"), instrument: null, amount: 1999, status: "SETTLED" }),
    ]);
    expect(elsewhere.chains[1]).toMatchObject({ recovered: true, post_ban_success: false });
  });
});

describe("cascade (a processor switch inside a chain)", () => {
  it("counts a success after a switch as cascade recovery, unless it came after a ban", () => {
    const recovered = buildAttemptChains([
      row({ t: T("10:00"), processor: "STRIPE" }),
      row({ t: T("10:01"), processor: "ADYEN", status: "SETTLED" }),
    ]);
    expect(recovered.chains[0]).toMatchObject({ cascade: true, recovered: true, cascade_recovered: true });
    expect(recovered.chains[0].attempts.map((attempt) => attempt.processor_switched)).toEqual([false, true]);
    expect(recovered.summary).toMatchObject({ chains_cascade: 1, chains_cascade_recovered: 1 });

    const banned = buildAttemptChains([
      row({ t: T("10:00"), processor: "STRIPE", advised: "DO_NOT_RETRY" }),
      row({ t: T("10:01"), processor: "ADYEN", status: "SETTLED" }),
    ]);
    expect(banned.chains[0]).toMatchObject({ cascade: true, final_success: true, recovered: false, cascade_recovered: false, post_ban_success: true });
    expect(banned.summary).toMatchObject({ chains_cascade: 1, chains_cascade_recovered: 0, chains_post_ban_success: 1 });
  });

  it("an unrouted decline (no processor) followed by a routed attempt is not a switch; a cascade without success is not a recovery", () => {
    const unrouted = buildAttemptChains([
      row({ t: T("10:00"), processor: null, issuer: null, advised: null }),
      row({ t: T("10:01"), processor: "STRIPE", status: "SETTLED" }),
    ]);
    expect(unrouted.chains[0]).toMatchObject({ cascade: false, recovered: true });
    expect(unrouted.chains[0].attempts[0].decline?.decline_class).toBe("cause_unverified");
    const failed = buildAttemptChains([row({ t: T("10:00"), processor: "STRIPE" }), row({ t: T("10:01"), processor: "ADYEN" })]);
    expect(failed.chains[0]).toMatchObject({ cascade: true, final_success: false, recovered: false, cascade_recovered: false });
  });

  it("flags cascade rows (decline_record_count > 1) on the attempt and in the summary", () => {
    const { chains, summary } = buildAttemptChains([row({ t: T("10:00"), records: 2 }), row({ t: T("10:01"), records: 1, status: "SETTLED" })]);
    expect(chains[0].attempts.map((attempt) => attempt.cascade_row)).toEqual([true, false]);
    expect(chains[0].cascade_row_count).toBe(1);
    expect(summary.cascade_rows).toBe(1);
  });
});

describe("a plan-shaped fixture (shapes of plan F, synthetic): the summary adds up", () => {
  it("counts chains, recoveries, post-ban successes and cascades consistently", () => {
    const rows: AttemptRow[] = [
      // Stripe CIT: decline then success (recovered).
      row({ t: T("09:00"), user: "u1", instrument: "pi-1" }),
      row({ t: T("09:03"), user: "u1", instrument: "pi-1", status: "SETTLED" }),
      // Adyen MIT renewal: 59 as SUSPECTED_FRAUD, DO_NOT_RETRY, then a retry 2 days later that succeeds (violation).
      row({ t: T("03:00", "2026-09-02"), user: "u2", instrument: "pi-2", init: "mit", processor: "ADYEN", issuer: "59", advised: "DO_NOT_RETRY" }),
      row({ t: T("03:00", "2026-09-04"), user: "u2", instrument: "pi-2", init: "mit", processor: "ADYEN", status: "SETTLED" }),
      // Stripe -> Adyen cascade that recovered.
      row({ t: T("12:00"), user: "u3", instrument: "pi-3", processor: "STRIPE", issuer: "05" }),
      row({ t: T("12:00"), user: "u3", instrument: "pi-3", processor: "ADYEN", status: "SETTLED" }),
      // Unrouted decline, nothing after it.
      row({ t: T("13:00"), user: "u4", instrument: "pi-4", processor: null, issuer: null, advised: null }),
      // A first-try success.
      row({ t: T("14:00"), user: "u5", instrument: "pi-5", status: "SETTLED" }),
      // CANCELLED / PENDING are not attempts.
      row({ t: T("15:00"), user: "u6", instrument: "pi-6", status: "CANCELLED" }),
      row({ t: T("15:01"), user: "u6", instrument: "pi-6", status: "PENDING" }),
      // Insufficient funds MIT dunning without success, two records on one row.
      row({ t: T("04:00", "2026-09-05"), user: "u7", instrument: "pi-7", init: "mit", records: 2 }),
      row({ t: T("04:00", "2026-09-07"), user: "u7", instrument: "pi-7", init: "mit" }),
    ];
    const { chains, summary } = buildAttemptChains(rows);
    expect(summary).toEqual({
      rows: 12,
      attempts: 10,
      not_attempts: 2,
      chains: 6,
      chains_first_try_success: 1,
      chains_final_success: 4,
      chains_with_decline: 5,
      chains_recovered: 2,
      chains_post_ban_success: 1,
      chains_cascade: 1,
      chains_cascade_recovered: 1,
      chains_singleton: 0,
      cascade_rows: 1,
    });
    // The two recoveries are u1 and u3; u2's success is a violation.
    expect(chains.filter((chain) => chain.recovered).map((chain) => chain.user_id).sort()).toEqual(["u1", "u3"]);
    expect(chains.find((chain) => chain.user_id === "u2")!.post_ban_success).toBe(true);
    expect(chains.find((chain) => chain.user_id === "u2")!.attempts[0].decline?.decline_class).toBe("issuer_suspected_fraud");
    expect(chains.find((chain) => chain.user_id === "u7")!).toMatchObject({ attempt_count: 2, final_success: false, cascade_row_count: 1 });
  });
});
