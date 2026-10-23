// The token / in-product / funnel upsell split (monetizationTyping.ts): the
// precedence of the TS evaluator, the structure of the SQL it shares its rule
// table with, and a parity fixture against today's legacy typing (anchors,
// status rows, lifecycle rows and levels identical; one-offs only re-typed).
import { describe, expect, it } from "vitest";
import {
  APP_UPSELL_FALLBACK_MS,
  COMMON_UPSELL_WINDOW_MS,
  DYNAMIC_TRIAL_TEST,
  ONE_OFF_RULES,
  ONE_OFF_TYPES,
  ONE_OFF_WINDOW_MS,
  SNAPSHOT_TRIAL_TEST,
  classifyOneOff,
  configListedPriceSql,
  oneOffTypingSql,
  priceSignal,
  priceSignalSql,
  pricePointForTransaction,
  tokenAmountSql,
  upsellPricePointsCte,
  type OneOffCategory,
  type OneOffFacts,
  type OneOffRule,
} from "../../supabase/functions/_shared/clickhouse/monetizationTyping.ts";
import {
  isKnownTokenAmount,
  knownAppUpsellPriceIds,
  knownTokenPriceIds,
} from "../../supabase/functions/_shared/clickhouse/monetizationProductMap.ts";
import { ALL_SCOPE_SQL, createRestrictedScopeSql, txFrom } from "../../supabase/functions/_shared/clickhouse/scopeSql.ts";
import { COHORT_CLASSIFICATION_VERSION, type CohortSnapshotState } from "../../supabase/functions/_shared/clickhouse/cohortSnapshotState.ts";
import { buildAccessContext, parseResolveAccessRow } from "../../supabase/functions/_shared/access/accessContext.ts";
import type { Transaction } from "../../supabase/functions/_shared/clickhouse/serviceTypes.ts";

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

const APP_ID = knownAppUpsellPriceIds[0];
const TOKEN_ID = knownTokenPriceIds[0];
/** The JPY 2400 funnel upsell, 2 of 26 rows unmarked. */
const MARKED_ID = "price_01M3BW7TT3TXZRHCRY4BFGS8M7";
const UNKNOWN_ID = "price_01UNKNOWN0000000000000000";
const MARKED = new Set([MARKED_ID]);

function facts(overrides: Partial<OneOffFacts> & { pricePoint?: string; marked?: ReadonlySet<string> } = {}): OneOffFacts {
  const pricePoint = overrides.pricePoint ?? "";
  return {
    upmark: false,
    isAnchor: false,
    ageMs: MIN,
    tokenAmt: false,
    commonUp: false,
    ...overrides,
    pricePoint,
    psig: overrides.psig ?? priceSignal(pricePoint, overrides.marked ?? MARKED),
  };
}

const typed = (f: OneOffFacts) => classifyOneOff(f);
const expectTyped = (f: OneOffFacts, category: OneOffCategory, rule: OneOffRule) => expect(typed(f)).toEqual({ category, rule });

describe("priceSignal", () => {
  it("config beats the inferred mark: app id > token id / prefix > ever marked", () => {
    expect(priceSignal(APP_ID, new Set([APP_ID]))).toBe("app_upsell");
    expect(priceSignal(TOKEN_ID, new Set([TOKEN_ID]))).toBe("token_purchase");
    expect(priceSignal("price_web_tokens_100", MARKED)).toBe("token_purchase");
    expect(priceSignal(MARKED_ID, MARKED)).toBe("upsell");
    expect(priceSignal(UNKNOWN_ID, MARKED)).toBe("");
    expect(priceSignal("", new Set([""]))).toBe("");
  });
});

describe("classifyOneOff precedence", () => {
  it("1. an upsell-marked row is a funnel upsell at any age", () => {
    expectTyped(facts({ upmark: true, ageMs: 5 * MIN, pricePoint: APP_ID }), "upsell", "upmark");
    expectTyped(facts({ upmark: true, ageMs: 10 * DAY, tokenAmt: true }), "upsell", "upmark");
  });

  it("2. the anchor stays the trial whatever price id it carries", () => {
    for (const pricePoint of [TOKEN_ID, APP_ID, MARKED_ID, "price_web_tokens_x"]) {
      expectTyped(facts({ isAnchor: true, ageMs: 0, pricePoint }), "trial", "trial");
    }
  });

  it("3. an in-product upsell id within 48 h, whatever its amount or timing", () => {
    expectTyped(facts({ pricePoint: APP_ID, ageMs: MIN }), "app_upsell", "app_id");
    expectTyped(facts({ pricePoint: APP_ID, ageMs: 8 * MIN }), "app_upsell", "app_id");
    expectTyped(facts({ pricePoint: APP_ID, ageMs: 49 * HOUR }), "lifecycle", "lifecycle");
  });

  it("4. a token id (or price_web_tokens*) is a token, never the 2-minute app fallback", () => {
    expectTyped(facts({ pricePoint: TOKEN_ID, ageMs: MIN }), "token_purchase", "token_id");
    expectTyped(facts({ pricePoint: "price_web_tokens_x", ageMs: MIN }), "token_purchase", "token_id");
  });

  it("5. an unmarked row whose price id was ever marked is a funnel upsell within 48 h (JPY 2400)", () => {
    expectTyped(facts({ pricePoint: MARKED_ID, ageMs: MIN }), "upsell", "price_marked");
    expectTyped(facts({ pricePoint: MARKED_ID, ageMs: 30 * HOUR }), "upsell", "price_marked");
    expectTyped(facts({ pricePoint: MARKED_ID, ageMs: 49 * HOUR }), "lifecycle", "lifecycle");
  });

  it("D4: an app id that is also ever marked stays an in-product upsell", () => {
    expectTyped(facts({ pricePoint: APP_ID, marked: new Set([APP_ID]), ageMs: MIN }), "app_upsell", "app_id");
  });

  it("6. a known token amount with an unknown id is a token at any age", () => {
    expectTyped(facts({ pricePoint: UNKNOWN_ID, tokenAmt: true, ageMs: MIN }), "token_purchase", "token_amount");
    expectTyped(facts({ pricePoint: UNKNOWN_ID, tokenAmt: true, ageMs: 10 * DAY }), "token_purchase", "token_amount");
  });

  it("ids beat the amount inside the window; outside it the amount rule is today's", () => {
    expectTyped(facts({ pricePoint: APP_ID, tokenAmt: true, ageMs: MIN }), "app_upsell", "app_id");
    expectTyped(facts({ pricePoint: APP_ID, tokenAmt: true, ageMs: 10 * DAY }), "token_purchase", "token_amount");
  });

  it("7. the common upsell amount within 1 h (legacy rule)", () => {
    expectTyped(facts({ pricePoint: UNKNOWN_ID, commonUp: true, ageMs: MIN }), "upsell", "common_up");
    expectTyped(facts({ pricePoint: UNKNOWN_ID, commonUp: true, ageMs: 61 * MIN }), "token_purchase", "fallback_token_48h");
  });

  it("8/9. an unknown unmarked id: ≤ 2:00 in-product upsell, later a token, beyond 48 h lifecycle", () => {
    expectTyped(facts({ pricePoint: UNKNOWN_ID, ageMs: MIN }), "app_upsell", "fallback_app_2m");
    expectTyped(facts({ pricePoint: UNKNOWN_ID, ageMs: 2 * MIN }), "app_upsell", "fallback_app_2m");
    expectTyped(facts({ pricePoint: UNKNOWN_ID, ageMs: 2 * MIN + 1000 }), "token_purchase", "fallback_token_48h");
    expectTyped(facts({ pricePoint: UNKNOWN_ID, ageMs: 5 * MIN }), "token_purchase", "fallback_token_48h");
    expectTyped(facts({ pricePoint: UNKNOWN_ID, ageMs: 48 * HOUR + 1 }), "lifecycle", "lifecycle");
  });

  it("D5: a row without a price id keeps today's typing (token within 48 h)", () => {
    expectTyped(facts({ pricePoint: "", ageMs: MIN }), "token_purchase", "fallback_token_48h");
  });

  it("0. a failed / refunded row keeps its status type, and ocat still names the category its payment had", () => {
    // pretype = if(statusType != '', statusType, ocat) (pinned on the SQL below);
    // ocat ignores the status, so the refund of an in-product upsell is an
    // in-product upsell refund, the refund of a token-amount row a token refund.
    expectTyped(facts({ pricePoint: knownAppUpsellPriceIds[1], ageMs: 2 * MIN }), "app_upsell", "app_id");
    expectTyped(facts({ pricePoint: UNKNOWN_ID, tokenAmt: true, ageMs: 10 * DAY }), "token_purchase", "token_amount");
    expectTyped(facts({ pricePoint: "price_sub", ageMs: 11 * DAY }), "lifecycle", "lifecycle");
    // A status row is never lifeelig, so it is never the anchor (dynamic trial test).
    expect(DYNAMIC_TRIAL_TEST.startsWith("lifeelig AND ")).toBe(true);
  });

  it("the windows are the config's", () => {
    expect(ONE_OFF_WINDOW_MS).toBe(172_800_000);
    expect(COMMON_UPSELL_WINDOW_MS).toBe(3_600_000);
    expect(APP_UPSELL_FALLBACK_MS).toBe(120_000);
  });
});

// ---- SQL structure ----------------------------------------------------------

interface Branch { cond: string | null; value: string }

function multiIfBranches(part: string): Branch[] {
  const body = part.replace(/^\s*multiIf\(/, "");
  return body.split(",\n      ").map((branch) => {
    const match = /^([\s\S]*), '([a-z_0-9]+)'$/.exec(branch);
    return match ? { cond: match[1], value: match[2] } : { cond: null, value: branch.replace(/'/g, "") };
  });
}

describe("oneOffTypingSql", () => {
  const sql = oneOffTypingSql("TRIAL_TEST");
  const [ocatPart, afterOcat] = sql.split(") ocat,\n");
  const [orulePart, pretypePart] = afterOcat.split(") orule,\n");
  const ocat = multiIfBranches(ocatPart);
  const orule = multiIfBranches(orulePart);

  it("renders the rule table in order, ocat and orule on the same conditions", () => {
    expect(ocat.map((b) => b.cond)).toEqual([...ONE_OFF_RULES.map((rule) => rule.sql("TRIAL_TEST")), null]);
    expect(orule.map((b) => b.cond)).toEqual(ocat.map((b) => b.cond));
    expect(ocat.map((b) => b.value)).toEqual([...ONE_OFF_RULES.map((rule) => rule.category), "lifecycle"]);
    expect(orule.map((b) => b.value)).toEqual([...ONE_OFF_RULES.map((rule) => rule.rule), "lifecycle"]);
    expect(pretypePart.trim()).toBe("if(statusType != '', statusType, ocat) pretype");
  });

  it("puts the trial test second, before every price-id rule", () => {
    expect(ocat[0]).toEqual({ cond: "upmark", value: "upsell" });
    expect(ocat[1]).toEqual({ cond: "TRIAL_TEST", value: "trial" });
    expect(ocat.slice(2, 5).map((b) => b.cond)).toEqual([
      "(ets - trial_ts) <= 172800000 AND psig = 'app_upsell'",
      "(ets - trial_ts) <= 172800000 AND psig = 'token_purchase'",
      "(ets - trial_ts) <= 172800000 AND psig = 'upsell'",
    ]);
    expect(ocat[5].cond).toBe("tokenAmt");
    expect(ocat[6].cond).toBe("(ets - trial_ts) <= 3600000 AND commonUp");
    expect(ocat[7].cond).toBe("(ets - trial_ts) <= 120000 AND pp != ''");
    expect(ocat[8].cond).toBe("(ets - trial_ts) <= 172800000");
  });

  it("the trial tests are the anchors of each chain", () => {
    expect(DYNAMIC_TRIAL_TEST).toBe("lifeelig AND (ets, tprio, tid) = trial_key");
    expect(SNAPSHOT_TRIAL_TEST).toBe("(NOT tokenAmt) AND tid = trial_transaction_id");
    expect(oneOffTypingSql(DYNAMIC_TRIAL_TEST)).toContain("lifeelig AND (ets, tprio, tid) = trial_key, 'trial'");
  });
});

describe("tokenAmountSql", () => {
  it("is byte-identical to the literal the classifiers carried before the split", () => {
    expect(tokenAmountSql("a")).toBe(
      "((a.currency = 'USD' AND (abs(toFloat64(a.original_amount) - 4.99) < 0.005 OR abs(toFloat64(a.original_amount) - 9.99) < 0.005 OR abs(toFloat64(a.original_amount) - 24.99) < 0.005))\n" +
        "      OR (a.currency = 'EUR' AND abs(toFloat64(a.original_amount) - 4.99) < 0.005)\n" +
        "      OR (a.currency = 'COP' AND abs(toFloat64(a.original_amount) - 17199) < 0.005)) tokenAmt",
    );
  });
});

describe("priceSignalSql", () => {
  const sql = priceSignalSql("a");

  it("lists every configured id exactly once and never an empty IN ()", () => {
    for (const id of [...knownTokenPriceIds, ...knownAppUpsellPriceIds]) {
      expect(sql.split(`'${id}'`).length - 1, id).toBe(1);
    }
    expect(sql).not.toMatch(/IN \(\s*\)/);
  });

  it("orders app > token > ever marked and reads upp, never base", () => {
    expect(sql.startsWith("a.price_point pp,\n    multiIf(a.price_point IN (")).toBe(true);
    const app = sql.indexOf("'app_upsell'");
    const token = sql.indexOf("'token_purchase'");
    const upsell = sql.indexOf("'upsell'");
    expect(app).toBeGreaterThan(0);
    expect(token).toBeGreaterThan(app);
    expect(upsell).toBeGreaterThan(token);
    expect(sql).toContain("startsWith(a.price_point, 'price_web_tokens'), 'token_purchase'");
    expect(sql).toContain("(a.price_point != '' AND a.price_point IN (SELECT price_point FROM upp)), 'upsell'");
    expect(sql.endsWith("'') psig")).toBe(true);
  });

  it("configListedPriceSql covers the app and token lists and the prefix", () => {
    const listed = configListedPriceSql("price_point");
    for (const id of [...knownTokenPriceIds, ...knownAppUpsellPriceIds]) expect(listed).toContain(`'${id}'`);
    expect(listed).toContain("startsWith(price_point, 'price_web_tokens')");
  });
});

describe("upsellPricePointsCte", () => {
  it("all scope reads the whole tenant's transactions", () => {
    expect(upsellPricePointsCte(ALL_SCOPE_SQL)).toBe(`upp AS (
  SELECT DISTINCT price_point FROM analytics_transactions FINAL
  WHERE auth_user_id = {auth_user_id:String} AND price_point != '' AND positionCaseInsensitive(billing_reason, 'upsell') > 0
)`);
    expect(upsellPricePointsCte()).toBe(upsellPricePointsCte(ALL_SCOPE_SQL));
  });

  it("a restricted member reads their scoped users' transactions only", () => {
    const row = parseResolveAccessRow({
      status: "ok",
      workspace_id: "33333333-3333-4333-8333-333333333333",
      data_key: "11111111-1111-4111-8111-111111111111",
      member_id: "44444444-4444-4444-8444-444444444444",
      user_id: "22222222-2222-4222-8222-222222222222",
      email: "buyer@example.com",
      display_name: "Buyer",
      is_data_owner: false,
      raw_access: false,
      role: { id: "r1", key: "media_buyer", name: "Media Buyer", is_owner: false, permissions: ["cohorts.view"] },
      funnel_scope: { mode: "selected", funnel_ids: ["f1"], paths: ["soulmate-sketch"] },
      access_version: "1",
      partition: "p",
    });
    if (!row) throw new Error("fixture row did not parse");
    const ctx = buildAccessContext(row, { kind: "user", userId: "22222222-2222-4222-8222-222222222222", email: "buyer@example.com" }, "req-typing");
    const scope = createRestrictedScopeSql(ctx, {
      warehouseVersion: "wh_typing",
      classificationVersion: COHORT_CLASSIFICATION_VERSION,
      campaignScopeReady: true,
      freshVerifiedAt: "2026-10-06T00:00:00.000Z",
      staleSince: null,
      state: {} as CohortSnapshotState,
    });
    const cte = upsellPricePointsCte(scope);
    expect(cte).toContain(`SELECT DISTINCT price_point FROM ${txFrom(scope)}\n`);
    expect(cte).not.toContain("FROM analytics_transactions FINAL\n");
  });
});

describe("pricePointForTransaction", () => {
  it("reads ff_price_point from the raw metadata JSON first, then the parsed metadata", () => {
    expect(pricePointForTransaction({ raw: { metadata: JSON.stringify({ ff_price_point: ` ${APP_ID} ` }) }, metadata: { ff_price_point: "price_other" } } as Pick<Transaction, "raw" | "metadata">)).toBe(APP_ID);
    expect(pricePointForTransaction({ raw: {}, metadata: { ff_price_point: TOKEN_ID } })).toBe(TOKEN_ID);
    expect(pricePointForTransaction({ raw: { metadata: "not json" }, metadata: undefined })).toBe("");
    expect(pricePointForTransaction({ raw: undefined, metadata: undefined })).toBe("");
  });
});

// ---- Parity with today's typing ----------------------------------------------
// A test-local twin of the legacy multiIf (cohorts.ts classifierSQL "legacy")
// and of the anchor / lifecycle-level CTEs, run over one fixture with both
// typings. The tests have no ClickHouse engine; the SQL renders from the same
// table the TS evaluator walks (checked above).

interface FixtureRow {
  uid: string;
  tid: string;
  at: number;
  amount: number;
  currency: string;
  status?: "success" | "failed" | "refunded" | "chargeback";
  billing?: string;
  pp?: string;
  /** Stored-type tie-break of the anchor key (0 trial … 4 other). */
  tprio?: number;
}

const T0 = Date.parse("2026-09-29T10:00:00.000Z");
const FIXTURE: FixtureRow[] = [
  // A: funnel buyer — marked upsell, in-product upsell, token packs, subscription.
  { uid: "A", tid: "a01", at: T0, amount: 1, currency: "USD", pp: "price_trial_a", tprio: 0 },
  { uid: "A", tid: "a02", at: T0 + 30_000, amount: 2400, currency: "JPY", billing: "upsell", pp: MARKED_ID, tprio: 1 },
  { uid: "A", tid: "a03", at: T0 + MIN, amount: 2.99, currency: "USD", pp: APP_ID, tprio: 4 },
  { uid: "A", tid: "a04", at: T0 + 5 * MIN, amount: 4.99, currency: "USD", pp: TOKEN_ID, tprio: 4 },
  { uid: "A", tid: "a05", at: T0 + 8 * MIN, amount: 3.49, currency: "USD", pp: UNKNOWN_ID, tprio: 4 },
  { uid: "A", tid: "a06", at: T0 + 70 * HOUR, amount: 29.99, currency: "USD", pp: "price_sub", tprio: 2 },
  { uid: "A", tid: "a07", at: T0 + 94 * HOUR, amount: 29.99, currency: "USD", status: "failed", pp: "price_sub", tprio: 3 },
  { uid: "A", tid: "a08", at: T0 + 238 * HOUR, amount: 29.99, currency: "USD", pp: "price_sub", tprio: 3 },
  // B: unmarked rows of the ever-marked id, an unknown id at 1 min, a refund.
  { uid: "B", tid: "b01", at: T0, amount: 0.99, currency: "EUR", pp: "price_trial_b", tprio: 0 },
  { uid: "B", tid: "b02", at: T0 + MIN, amount: 1.99, currency: "EUR", pp: UNKNOWN_ID, tprio: 4 },
  { uid: "B", tid: "b03", at: T0 + 90_000, amount: 2400, currency: "JPY", pp: MARKED_ID, tprio: 4 },
  { uid: "B", tid: "b04", at: T0 + 2 * MIN, amount: 2.99, currency: "EUR", status: "refunded", pp: knownAppUpsellPriceIds[1], tprio: 4 },
  { uid: "B", tid: "b05", at: T0 + 30 * HOUR, amount: 2400, currency: "JPY", pp: MARKED_ID, tprio: 4 },
  { uid: "B", tid: "b06", at: T0 + 49 * HOUR, amount: 2400, currency: "JPY", pp: MARKED_ID, tprio: 4 },
  { uid: "B", tid: "b07", at: T0 + 70 * HOUR, amount: 19.99, currency: "EUR", pp: "price_sub", tprio: 2 },
  // C: the common upsell amount, token amounts with and without an app id, a chargeback.
  { uid: "C", tid: "c01", at: T0, amount: 0.5, currency: "USD", pp: "price_trial_c", tprio: 0 },
  { uid: "C", tid: "c02", at: T0 + 3 * MIN, amount: 4.99, currency: "USD", pp: APP_ID, tprio: 4 },
  { uid: "C", tid: "c03", at: T0 + 10 * MIN, amount: 14.98, currency: "USD", pp: UNKNOWN_ID, tprio: 4 },
  { uid: "C", tid: "c04", at: T0 + 61 * MIN, amount: 14.98, currency: "USD", pp: UNKNOWN_ID, tprio: 4 },
  { uid: "C", tid: "c05", at: T0 + 71 * HOUR, amount: 29.99, currency: "USD", pp: "price_sub", tprio: 2 },
  { uid: "C", tid: "c06", at: T0 + 10 * DAY, amount: 4.99, currency: "USD", tprio: 4 },
  { uid: "C", tid: "c07", at: T0 + 10 * DAY + HOUR, amount: 4.99, currency: "USD", pp: APP_ID, tprio: 4 },
  { uid: "C", tid: "c08", at: T0 + 11 * DAY, amount: 29.99, currency: "USD", status: "chargeback", pp: "price_sub", tprio: 3 },
  // D: an anchor carrying a token id, no price id, the 2:00 boundary, the prefix.
  { uid: "D", tid: "d00", at: T0 - HOUR, amount: 3.99, currency: "EUR", status: "failed", pp: TOKEN_ID, tprio: 0 },
  { uid: "D", tid: "d01", at: T0, amount: 3.99, currency: "EUR", pp: TOKEN_ID, tprio: 0 },
  { uid: "D", tid: "d02", at: T0 + MIN, amount: 1.5, currency: "USD", tprio: 4 },
  { uid: "D", tid: "d03", at: T0 + 2 * MIN, amount: 1.25, currency: "USD", pp: UNKNOWN_ID, tprio: 4 },
  { uid: "D", tid: "d04", at: T0 + 2 * MIN + 1000, amount: 1.25, currency: "USD", pp: UNKNOWN_ID, tprio: 4 },
  { uid: "D", tid: "d05", at: T0 + 5 * MIN, amount: 6.99, currency: "USD", pp: "price_web_tokens_100", tprio: 4 },
  { uid: "D", tid: "d06", at: T0 + 48 * HOUR + 1, amount: 1.25, currency: "USD", pp: UNKNOWN_ID, tprio: 4 },
  { uid: "D", tid: "d07", at: T0 + 70 * HOUR, amount: 29.99, currency: "EUR", pp: "price_sub", tprio: 2 },
];

interface TypedRow { tid: string; uid: string; type: string; lvl: number }

function statusType(row: FixtureRow): string {
  if (row.status === "failed") return "failed_payment";
  if (row.status === "refunded") return "refund";
  if (row.status === "chargeback") return "chargeback";
  return "";
}

/** base / elig / tr / cl / pretyped / lifeidx of the dynamic classifier. */
function classify(rows: readonly FixtureRow[], typing: "legacy" | "price_point"): TypedRow[] {
  const marked = new Set(rows.filter((r) => /upsell/i.test(r.billing ?? "") && r.pp).map((r) => r.pp!));
  const key = (r: FixtureRow) => [r.at, r.tprio ?? 4, r.tid] as const;
  const cmp = (a: FixtureRow, b: FixtureRow) => {
    const [x, y] = [key(a), key(b)];
    return x[0] - y[0] || x[1] - y[1] || (x[2] < y[2] ? -1 : x[2] > y[2] ? 1 : 0);
  };
  const out: TypedRow[] = [];
  for (const uid of [...new Set(rows.map((r) => r.uid))]) {
    const own = rows.filter((r) => r.uid === uid);
    const enriched = own.map((r) => {
      const upmark = /upsell/i.test(r.billing ?? "");
      const tokenAmt = isKnownTokenAmount(r.amount, r.currency);
      const st = statusType(r);
      return { r, upmark, tokenAmt, st, commonUp: Math.abs(r.amount - 14.98) < 0.01, lifeelig: st === "" && !upmark && !tokenAmt };
    });
    const anchor = enriched.filter((e) => e.lifeelig).map((e) => e.r).sort(cmp)[0];
    if (!anchor) continue;
    const pretyped = enriched
      .filter((e) => e.r.at - anchor.at >= 0)
      .map((e) => {
        const age = e.r.at - anchor.at;
        const isAnchor = e.lifeelig && e.r.tid === anchor.tid;
        let type: string;
        if (typing === "legacy") {
          if (e.st) type = e.st;
          else if (e.upmark) type = "upsell";
          else if (e.tokenAmt) type = "token_purchase";
          else if (isAnchor) type = "trial";
          else if (age <= HOUR && e.commonUp) type = "upsell";
          else if (age <= 48 * HOUR) type = "token_purchase";
          else type = "lifecycle";
        } else {
          const pricePoint = e.r.pp ?? "";
          const category = classifyOneOff({
            upmark: e.upmark, isAnchor, ageMs: age, pricePoint, psig: priceSignal(pricePoint, marked), tokenAmt: e.tokenAmt, commonUp: e.commonUp,
          }).category;
          type = e.st || category;
        }
        return { r: e.r, type };
      });
    const lifecycle = pretyped.filter((p) => p.type === "lifecycle" && (p.r.status ?? "success") === "success").map((p) => p.r).sort(cmp);
    for (const p of pretyped) {
      const lvl = lifecycle.findIndex((r) => r.tid === p.r.tid) + 1;
      out.push({ tid: p.r.tid, uid, type: p.type, lvl });
    }
  }
  return out;
}

describe("parity with the legacy typing (anchors and lifecycle never move)", () => {
  const legacy = classify(FIXTURE, "legacy");
  const split = classify(FIXTURE, "price_point");
  const byTid = new Map(split.map((row) => [row.tid, row]));
  const ONE_OFF = new Set<string>(ONE_OFF_TYPES);
  const KEPT = new Set(["trial", "failed_payment", "refund", "chargeback", "lifecycle"]);

  it("types the same rows (the pre-anchor row is cut in both)", () => {
    expect(split.map((row) => row.tid)).toEqual(legacy.map((row) => row.tid));
    expect(legacy.map((row) => row.tid)).not.toContain("d00");
  });

  it("keeps every trial / status / lifecycle row and its level", () => {
    for (const row of legacy.filter((r) => KEPT.has(r.type))) {
      expect(byTid.get(row.tid), row.tid).toEqual(row);
    }
  });

  it("re-types legacy one-offs only among upsell / app_upsell / token_purchase", () => {
    for (const row of legacy.filter((r) => ONE_OFF.has(r.type))) {
      expect(ONE_OFF.has(byTid.get(row.tid)!.type), row.tid).toBe(true);
    }
  });

  it("one-off and lifecycle counts are each unchanged, so their sum is too", () => {
    const count = (rows: TypedRow[], pick: (r: TypedRow) => boolean) => rows.filter(pick).length;
    expect(count(split, (r) => ONE_OFF.has(r.type))).toBe(count(legacy, (r) => ONE_OFF.has(r.type)));
    expect(count(split, (r) => r.type === "lifecycle")).toBe(count(legacy, (r) => r.type === "lifecycle"));
  });

  it("re-types the fixture's one-offs as specified", () => {
    const types = Object.fromEntries(split.map((row) => [row.tid, row.type]));
    expect(types).toMatchObject({
      a02: "upsell", a03: "app_upsell", a04: "token_purchase", a05: "token_purchase",
      b02: "app_upsell", b03: "upsell", b04: "refund", b05: "upsell", b06: "lifecycle",
      c02: "app_upsell", c03: "upsell", c04: "token_purchase", c06: "token_purchase", c07: "token_purchase",
      d01: "trial", d02: "token_purchase", d03: "app_upsell", d04: "token_purchase", d05: "token_purchase", d06: "lifecycle",
    });
    const legacyTypes = Object.fromEntries(legacy.map((row) => [row.tid, row.type]));
    // What moved: in-product upsells and ever-marked funnel upsells left the tokens.
    expect(Object.keys(types).filter((tid) => types[tid] !== legacyTypes[tid]).sort()).toEqual(["a03", "b02", "b03", "b05", "c02", "d03"]);
  });
});
