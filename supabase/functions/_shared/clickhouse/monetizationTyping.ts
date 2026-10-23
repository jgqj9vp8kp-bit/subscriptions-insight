// Post-trial one-off typing: token packs vs in-product upsells vs funnel upsells
// (owner-approved 2026-10-23, DEVELOPER_NOTES "Token / in-product / funnel
// upsell split").
//
// Every successful unmarked payment within APP_ADDON_WINDOW_HOURS of the trial
// used to be a token purchase. Since the in-product upsells (offered in the
// product right after the funnel checkout, never marked) that over-counted
// tokens. The FunnelFox price id each Primer row carries (price_point =
// metadata.ff_price_point) separates the three one-off kinds; timing separates
// what the config does not list.
//
// ONE ordered rule table drives both the ClickHouse rendering (oneOffTypingSql)
// and a TS evaluator (classifyOneOff), so the precedence cannot drift between
// the two and Vitest can check it without a ClickHouse engine:
//
//   0. status (failed / refunded / chargeback) — pretype only; ocat is still
//      computed so a refund is attributed to its category
//   1. upmark        billing_reason contains "upsell"                → upsell
//   2. trial         the cohort anchor                               → trial
//   3. app_id        ≤ 48 h and a listed in-product upsell id        → app_upsell
//   4. token_id      ≤ 48 h and a listed token id / price_web_tokens* → token_purchase
//   5. price_marked  ≤ 48 h and an id the tenant ever saw marked     → upsell
//   6. token_amount  a known token amount (any age, legacy)          → token_purchase
//   7. common_up     ≤ 1 h and the common upsell amount (legacy)     → upsell
//   8. fallback_app_2m    ≤ 2 min and a price id (unknown id)        → app_upsell
//   9. fallback_token_48h ≤ 48 h                                     → token_purchase
//   —  lifecycle (first_subscription / renewals)
//
// Anchor safety: the trial test runs before the price-id rules and every new
// rule is bounded by the 48 h window, so the anchor, lifecycle rows and their
// levels are exactly the legacy ones; only the one-off rows (legacy upsell /
// token_purchase) are re-typed among {upsell, app_upsell, token_purchase}. The
// snapshot INSERT and its validation keep the legacy typing (classifierSQL
// "legacy" in cohorts.ts), so no classification_version bump is needed.

import {
  AMOUNT_TOLERANCE,
  APP_ADDON_WINDOW_HOURS,
  APP_UPSELL_FALLBACK_MINUTES,
  COMMON_UPSELL_WINDOW_MINUTES,
  knownAppUpsellPriceIds,
  knownFunnelUpsellPriceIds,
  knownTokenAmounts,
  knownTokenPriceIds,
  knownTokenPricePointPrefixes,
} from "./monetizationProductMap.ts";
import { ALL_SCOPE_SQL, txFrom, type ScopeSql } from "./scopeSql.ts";
import type { Transaction } from "./serviceTypes.ts";

/** "legacy": today's typing (snapshot INSERT, validation, filter options, the
 * dynamic email overlay). "price_point": the split below. */
export type ClassifierTyping = "legacy" | "price_point";
/** What the price id alone says ('' = unknown or absent). */
export type PriceSignal = "" | "app_upsell" | "token_purchase" | "upsell";
export type OneOffCategory = "trial" | "upsell" | "app_upsell" | "token_purchase" | "lifecycle";
export type OneOffRule =
  | "upmark"
  | "trial"
  | "app_id"
  | "token_id"
  | "price_marked"
  | "token_amount"
  | "common_up"
  | "fallback_app_2m"
  | "fallback_token_48h"
  | "lifecycle"
  | "email_token";

/** The successful one-off lifecycle types (everything that is not trial / lifecycle). */
export const ONE_OFF_TYPES = ["upsell", "app_upsell", "token_purchase"] as const;

export const ONE_OFF_WINDOW_MS = APP_ADDON_WINDOW_HOURS * 3_600_000;
export const COMMON_UPSELL_WINDOW_MS = COMMON_UPSELL_WINDOW_MINUTES * 60_000;
export const APP_UPSELL_FALLBACK_MS = APP_UPSELL_FALLBACK_MINUTES * 60_000;

/** The facts one rule decides on. ageMs = event time − trial anchor time. */
export interface OneOffFacts {
  upmark: boolean;
  isAnchor: boolean;
  ageMs: number;
  pricePoint: string;
  psig: PriceSignal;
  tokenAmt: boolean;
  commonUp: boolean;
}

/** SQL age of a row of the classifier chain (ets / trial_ts are epoch ms). */
const AGE = "(ets - trial_ts)";

export const ONE_OFF_RULES: ReadonlyArray<{
  rule: Exclude<OneOffRule, "lifecycle" | "email_token">;
  category: OneOffCategory;
  sql: (trialTest: string) => string;
  holds: (f: OneOffFacts) => boolean;
}> = Object.freeze([
  { rule: "upmark", category: "upsell", sql: () => "upmark", holds: (f) => f.upmark },
  { rule: "trial", category: "trial", sql: (trialTest) => trialTest, holds: (f) => f.isAnchor },
  {
    rule: "app_id",
    category: "app_upsell",
    sql: () => `${AGE} <= ${ONE_OFF_WINDOW_MS} AND psig = 'app_upsell'`,
    holds: (f) => f.ageMs <= ONE_OFF_WINDOW_MS && f.psig === "app_upsell",
  },
  {
    rule: "token_id",
    category: "token_purchase",
    sql: () => `${AGE} <= ${ONE_OFF_WINDOW_MS} AND psig = 'token_purchase'`,
    holds: (f) => f.ageMs <= ONE_OFF_WINDOW_MS && f.psig === "token_purchase",
  },
  {
    rule: "price_marked",
    category: "upsell",
    sql: () => `${AGE} <= ${ONE_OFF_WINDOW_MS} AND psig = 'upsell'`,
    holds: (f) => f.ageMs <= ONE_OFF_WINDOW_MS && f.psig === "upsell",
  },
  { rule: "token_amount", category: "token_purchase", sql: () => "tokenAmt", holds: (f) => f.tokenAmt },
  {
    rule: "common_up",
    category: "upsell",
    sql: () => `${AGE} <= ${COMMON_UPSELL_WINDOW_MS} AND commonUp`,
    holds: (f) => f.ageMs <= COMMON_UPSELL_WINDOW_MS && f.commonUp,
  },
  {
    rule: "fallback_app_2m",
    category: "app_upsell",
    sql: () => `${AGE} <= ${APP_UPSELL_FALLBACK_MS} AND pp != ''`,
    holds: (f) => f.ageMs <= APP_UPSELL_FALLBACK_MS && f.pricePoint !== "",
  },
  {
    rule: "fallback_token_48h",
    category: "token_purchase",
    sql: () => `${AGE} <= ${ONE_OFF_WINDOW_MS}`,
    holds: (f) => f.ageMs <= ONE_OFF_WINDOW_MS,
  },
]);

/** The TS twin of oneOffTypingSql's ocat / orule (status is applied on top). */
export function classifyOneOff(f: OneOffFacts): { category: OneOffCategory; rule: OneOffRule } {
  for (const rule of ONE_OFF_RULES) {
    if (rule.holds(f)) return { category: rule.category, rule: rule.rule };
  }
  return { category: "lifecycle", rule: "lifecycle" };
}

/** Config beats the inferred mark: app id > token id / prefix > funnel list or
 * an id the tenant ever saw with the upsell mark. */
export function priceSignal(pricePoint: string, marked: ReadonlySet<string>): PriceSignal {
  if (!pricePoint) return "";
  if (knownAppUpsellPriceIds.includes(pricePoint)) return "app_upsell";
  if (knownTokenPriceIds.includes(pricePoint) || knownTokenPricePointPrefixes.some((prefix) => pricePoint.startsWith(prefix))) {
    return "token_purchase";
  }
  if (knownFunnelUpsellPriceIds.includes(pricePoint) || marked.has(pricePoint)) return "upsell";
  return "";
}

// ---- SQL rendering ---------------------------------------------------------
// The ids are inlined as literals: monetizationProductMap validates every one
// against PRICE_ID_RE at module load, so no quote can reach the SQL. An empty
// list renders no clause (ClickHouse rejects `IN ()`).

function sqlList(ids: readonly string[]): string {
  return ids.map((id) => `'${id}'`).join(", ");
}

function inList(column: string, ids: readonly string[]): string[] {
  return ids.length ? [`${column} IN (${sqlList(ids)})`] : [];
}

/** The price-signal columns of a base CTE: `pp` (the raw price id) and `psig`.
 * Reads `upp` (upsellPricePointsCte), which must be in the WITH chain. */
export function priceSignalSql(alias: string): string {
  const column = `${alias}.price_point`;
  const branches: string[] = [];
  const app = inList(column, knownAppUpsellPriceIds);
  if (app.length) branches.push(`${app[0]}, 'app_upsell'`);
  const token = [
    ...inList(column, knownTokenPriceIds),
    ...knownTokenPricePointPrefixes.map((prefix) => `startsWith(${column}, '${prefix}')`),
  ];
  if (token.length) branches.push(`${token.join(" OR ")}, 'token_purchase'`);
  const funnel = [...inList(column, knownFunnelUpsellPriceIds), `(${column} != '' AND ${column} IN (SELECT price_point FROM upp))`];
  branches.push(`${funnel.join(" OR ")}, 'upsell'`);
  return `${column} pp,
    multiIf(${branches.join(",\n      ")},
      '') psig`;
}

/** `column` is a listed app-upsell or token price id (the config the inferred
 * "ever marked" rule must never contradict — the overlap diagnostic). */
export function configListedPriceSql(column: string): string {
  const parts = [
    ...inList(column, knownAppUpsellPriceIds),
    ...inList(column, knownTokenPriceIds),
    ...knownTokenPricePointPrefixes.map((prefix) => `startsWith(${column}, '${prefix}')`),
  ];
  return parts.length ? parts.join(" OR ") : "0";
}

/** `upp`: every price id the tenant has EVER seen with the upsell mark (any
 * status, any user). Read from the table — never from `base`, which the
 * dynamic engine narrows by the currency keep-set, the Users details by one
 * user and the materialized engine by the member filters: a filter must not
 * change typing. Restricted scope reads txFrom(scope): only the marks of the
 * member's scoped users (documented divergence). */
export function upsellPricePointsCte(scope: ScopeSql = ALL_SCOPE_SQL): string {
  return `upp AS (
  SELECT DISTINCT price_point FROM ${txFrom(scope)}
  WHERE auth_user_id = {auth_user_id:String} AND price_point != '' AND positionCaseInsensitive(billing_reason, 'upsell') > 0
)`;
}

/** The trial test of the dynamic classifiers (cohorts.ts / classifier.ts). */
export const DYNAMIC_TRIAL_TEST = "lifeelig AND (ets, tprio, tid) = trial_key";
/** The trial test of the snapshot-anchored chains (cohortMembership.ts, RI). */
export const SNAPSHOT_TRIAL_TEST = "(NOT tokenAmt) AND tid = trial_transaction_id";

/** The typing columns of a `pretyped` CTE: ocat (one-off category), orule (the
 * rule that decided it) and pretype. ClickHouse resolves `ocat` inside the same
 * SELECT (alias reuse). Needs upmark / tokenAmt / commonUp / statusType / pp /
 * psig / ets / trial_ts and whatever `trialTest` reads. */
export function oneOffTypingSql(trialTest: string): string {
  const ocat = ONE_OFF_RULES.map((rule) => `${rule.sql(trialTest)}, '${rule.category}'`);
  const orule = ONE_OFF_RULES.map((rule) => `${rule.sql(trialTest)}, '${rule.rule}'`);
  return `multiIf(${ocat.join(",\n      ")},
      'lifecycle') ocat,
    multiIf(${orule.join(",\n      ")},
      'lifecycle') orule,
    if(statusType != '', statusType, ocat) pretype`;
}

function sqlNumber(value: number): string {
  return String(value);
}

/** The tokenAmt column of a base CTE, rendered from knownTokenAmounts. For the
 * current config it is byte-identical to the literal the classifiers carried
 * before (pinned by monetizationTyping.test.ts and the owner rebuild golden). */
export function tokenAmountSql(alias: string): string {
  const amount = `abs(toFloat64(${alias}.original_amount) - `;
  const byCurrency = new Map<string, number[]>();
  for (const rule of knownTokenAmounts) {
    const key = (rule.currency ?? "").toUpperCase();
    byCurrency.set(key, [...(byCurrency.get(key) ?? []), rule.amount]);
  }
  const groups = [...byCurrency.entries()].map(([currency, amounts]) => {
    const tests = amounts.map((value) => `${amount}${sqlNumber(value)}) < ${sqlNumber(AMOUNT_TOLERANCE)}`);
    const test = tests.length === 1 ? tests[0] : `(${tests.join(" OR ")})`;
    return currency ? `(${alias}.currency = '${currency}' AND ${test})` : `(${test})`;
  });
  return `(${groups.join("\n      OR ")}) tokenAmt`;
}

// ---- TS read-time support (Slice D) ----------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function objectFrom(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) return value;
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** The row's FunnelFox price id — the same read as transactionMapper
 * paymentHealthColumns (raw.metadata JSON first, then the parsed tx.metadata). */
export function pricePointForTransaction(tx: Pick<Transaction, "raw" | "metadata">): string {
  const raw = isRecord(tx.raw) ? tx.raw : {};
  const metadata = objectFrom(raw.metadata) ?? objectFrom(tx.metadata) ?? {};
  return String(metadata.ff_price_point ?? "").trim();
}
