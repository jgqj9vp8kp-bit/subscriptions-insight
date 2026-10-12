// Payment System Health P2 test fixtures: a synthetic attempt warehouse, the
// cohort anchors, support requests, the PSP account registry — and a
// ClickHouse responder that answers the runner's statements FROM those rows
// with the SQL's own semantics (window, period, filters, group by), dispatched
// on the `/* ph:<name> */` marker each statement carries.
//
// Why a semantic responder and not canned rows: the parity tests compute the
// Payment Pass totals and the decline classes straight from the fixture rows
// and compare them with what the runner answers, so a drift between the SQL
// the runner writes and the rollup the Edge does shows up here, not live.
// Every email, id, MID, descriptor and token is synthetic; the sentinels are
// what the leak scans look for.

import type { RecordedStatement } from "./recordingClickHouse";
import { createStrictFakeSupabase, type StrictFakeSupabase } from "./strictFakeSupabase";
import type { SupabaseLikeClient } from "../../../supabase/functions/_shared/clickhouse/types.ts";
import { SENTINEL_EMAILS } from "./leakScan";
import { COHORT_CLASSIFICATION_VERSION } from "../../../supabase/functions/_shared/clickhouse/cohortSnapshotState.ts";

export const PH_DATA_KEY = "11111111-1111-4111-8111-111111111111";

/** Values that must never reach a response (scanForLeaks `extra`). */
export const PH_SENTINELS = {
  rawMidRegistered: "MID-SENTINEL-RAW-0001",
  rawMidUnlabelled: "MID-SENTINEL-RAW-9876",
  rawMidAdyen: "MID-SENTINEL-ADYEN-0001",
  descriptor: "SENTINEL*DESCRIPTOR*LLC",
  instrument: "pi-sentinel-token-abc",
  userEmail: SENTINEL_EMAILS[0],
  transactionId: "tx-sentinel-0099",
} as const;

export const PH_SNAPSHOT = { warehouse_version: "wh_fixture", classification_version: COHORT_CLASSIFICATION_VERSION };

/** One analytics_transactions row (the columns the runner reads). */
export interface FixtureTx {
  transaction_id: string;
  user_id: string;
  event_time: string;
  raw_status: "SETTLED" | "DECLINED" | "FAILED" | "CANCELLED" | "PENDING" | "";
  is_success: 0 | 1;
  is_refund: 0 | 1;
  amount_usd: number;
  refund_amount_usd: number;
  refund_observed_at: string | null;
  processor: string;
  processor_merchant_id: string;
  statement_descriptor: string;
  initiation_type: "cit" | "mit" | "";
  ff_billing_reason: string;
  transaction_type: string;
  card_network: string;
  payment_method: string;
  issuer_country: string;
  currency: string;
  original_amount: number;
  price_point: string;
  payment_instrument_key: string;
  advised_action: string;
  advice_code: string;
  issuer_result_code: string;
  primer_decline_code: string;
  lifecycle_event: string;
  decline_record_count: number;
  decline_type: string;
  three_ds_response: string;
  clickhouse_synced_at: string;
}

export interface FixtureSupport {
  request_id: string;
  received_at: string;
  matched_user_id: string;
  possible_unauthorized_charge: 0 | 1;
  requires_refund: 0 | 1;
  duplicate_charge: 0 | 1;
  category: string;
  classification_version: string;
}

type Spec = Partial<FixtureTx> & { t: string; status?: FixtureTx["raw_status"]; amount?: number };

let seq = 0;

/** A decline by default (Stripe, MID #1, Visa card, issuer code 51 RETRY_LATER); `status: "SETTLED"` makes a success. */
export function tx(spec: Spec): FixtureTx {
  seq += 1;
  const status = spec.status ?? "DECLINED";
  const success = status === "SETTLED";
  const amount = spec.amount ?? 19.99;
  return {
    transaction_id: spec.transaction_id ?? `tx-${String(seq).padStart(3, "0")}`,
    user_id: spec.user_id ?? "u1",
    event_time: spec.t,
    raw_status: status,
    is_success: success ? 1 : 0,
    is_refund: spec.is_refund ?? 0,
    amount_usd: success ? amount : 0,
    refund_amount_usd: spec.is_refund ? amount : 0,
    refund_observed_at: spec.refund_observed_at ?? null,
    processor: spec.processor === undefined ? "STRIPE" : spec.processor,
    processor_merchant_id: spec.processor_merchant_id === undefined ? PH_SENTINELS.rawMidRegistered : spec.processor_merchant_id,
    statement_descriptor: spec.statement_descriptor === undefined ? PH_SENTINELS.descriptor : spec.statement_descriptor,
    initiation_type: spec.initiation_type === undefined ? "cit" : spec.initiation_type,
    ff_billing_reason: spec.ff_billing_reason ?? "",
    transaction_type: spec.transaction_type ?? (success ? "trial" : "failed_payment"),
    card_network: spec.card_network === undefined ? "VISA" : spec.card_network,
    payment_method: spec.payment_method === undefined ? "PAYMENT_CARD" : spec.payment_method,
    issuer_country: spec.issuer_country === undefined ? "US" : spec.issuer_country,
    currency: spec.currency ?? "USD",
    original_amount: spec.original_amount ?? amount,
    price_point: spec.price_point ?? "pp-1",
    payment_instrument_key: spec.payment_instrument_key === undefined ? "pi-a" : spec.payment_instrument_key,
    advised_action: success ? "" : spec.advised_action === undefined ? "RETRY_LATER" : spec.advised_action,
    advice_code: success ? "" : spec.advice_code ?? "",
    issuer_result_code: success ? "" : spec.issuer_result_code === undefined ? "51" : spec.issuer_result_code,
    primer_decline_code: success ? "" : spec.primer_decline_code === undefined ? "INSUFFICIENT_FUNDS" : spec.primer_decline_code,
    lifecycle_event: success ? "AUTHORIZATION_SUCCESS" : spec.lifecycle_event === undefined ? "AUTHORIZATION_DECLINED" : spec.lifecycle_event,
    decline_record_count: success ? 0 : spec.decline_record_count ?? 1,
    decline_type: success ? "" : spec.decline_type ?? "soft",
    three_ds_response: spec.three_ds_response ?? "",
    clickhouse_synced_at: "2026-10-06 08:00:00.000",
  };
}

export const T = (day: string, hhmm = "10:00") => `${day}T${hhmm}:00.000Z`;

/** Current window 2026-09-01..2026-09-30 (the tests pass it explicitly), baseline 2026-08-02..2026-08-31. */
export function fixtureRows(): FixtureTx[] {
  seq = 0;
  return [
    // ---- baseline (August); every user has its own instrument so a ban never crosses users ----
    tx({ t: T("2026-08-05"), status: "SETTLED", user_id: "u1", payment_instrument_key: "pi-u1" }),
    tx({ t: T("2026-08-06"), status: "SETTLED", user_id: "u2", processor: "ADYEN", processor_merchant_id: PH_SENTINELS.rawMidAdyen, payment_instrument_key: "pi-u2" }),
    tx({ t: T("2026-08-07"), user_id: "u3", payment_instrument_key: "pi-u3" }),
    tx({ t: T("2026-08-08"), user_id: "u3", issuer_result_code: "59", advised_action: "DO_NOT_RETRY", primer_decline_code: "DO_NOT_HONOR", payment_instrument_key: "pi-u3" }),
    tx({ t: T("2026-08-20"), status: "SETTLED", user_id: "u3", is_refund: 1, refund_observed_at: "2026-08-25 12:00:00.000", transaction_type: "first_subscription", payment_instrument_key: "pi-u3b" }),
    // ---- current (September) ----
    // u1: a CIT chain — decline then success 20 minutes later (recovered), soulmate anchor
    tx({ t: T("2026-09-02", "10:00"), user_id: "u1", payment_instrument_key: "pi-u1" }),
    tx({ t: T("2026-09-02", "10:20"), status: "SETTLED", user_id: "u1", transaction_type: "first_subscription", payment_instrument_key: "pi-u1" }),
    // u2: Adyen success + a refunded one observed 10 days later (past-life anchor)
    tx({ t: T("2026-09-03"), status: "SETTLED", user_id: "u2", processor: "ADYEN", processor_merchant_id: PH_SENTINELS.rawMidAdyen, statement_descriptor: "ADYEN*SENTINEL", card_network: "MASTERCARD", issuer_country: "DE", payment_instrument_key: "pi-u2" }),
    tx({ t: T("2026-09-04"), status: "SETTLED", user_id: "u2", processor: "ADYEN", processor_merchant_id: PH_SENTINELS.rawMidAdyen, statement_descriptor: "ADYEN*SENTINEL", is_refund: 1, refund_observed_at: "2026-09-14 09:00:00.000", transaction_type: "upsell", amount: 49, payment_instrument_key: "pi-u2" }),
    // u3: an MIT renewal decline (insufficient funds) on an unlabelled Stripe MID, then a success 2 days later (new chain: 72h window keeps it in one chain)
    tx({ t: T("2026-09-05"), user_id: "u3", initiation_type: "mit", ff_billing_reason: "renewal", processor_merchant_id: PH_SENTINELS.rawMidUnlabelled, payment_instrument_key: "pi-c" }),
    tx({ t: T("2026-09-07"), status: "SETTLED", user_id: "u3", initiation_type: "mit", processor_merchant_id: PH_SENTINELS.rawMidUnlabelled, payment_instrument_key: "pi-c", transaction_type: "renewal_2" }),
    // u4: issuer fraud-suspicion decline (59, DO_NOT_RETRY) then a post-ban retry on the same instrument that succeeded on another processor
    tx({ t: T("2026-09-10", "09:00"), user_id: "u4", issuer_result_code: "59", advised_action: "DO_NOT_RETRY", primer_decline_code: "DO_NOT_HONOR", decline_type: "hard", payment_instrument_key: "pi-b" }),
    tx({ t: T("2026-09-11", "09:30"), status: "SETTLED", user_id: "u4", processor: "ADYEN", processor_merchant_id: PH_SENTINELS.rawMidAdyen, payment_instrument_key: "pi-b" }),
    // u5 (sentinel email as user id): authentication required, no issuer code; Apple Pay
    tx({ t: T("2026-09-12"), user_id: PH_SENTINELS.userEmail, issuer_result_code: "", primer_decline_code: "AUTHENTICATION_REQUIRED", advised_action: "UPDATE_DATA", decline_type: "update", payment_method: "APPLE_PAY", payment_instrument_key: PH_SENTINELS.instrument, transaction_id: PH_SENTINELS.transactionId }),
    // u6: PSP / integration (AUTHORIZATION_FAILED without an issuer code); unknown country
    tx({ t: T("2026-09-13"), user_id: "u6", issuer_result_code: "", primer_decline_code: "ERROR", lifecycle_event: "AUTHORIZATION_FAILED", advised_action: "", decline_type: "", issuer_country: "", payment_instrument_key: "pi-d" }),
    // u6: unrouted decline (no processor, no codes, no card data): cause not verified; its network / method are the 'unknown' option
    tx({ t: T("2026-09-14"), user_id: "u6", processor: "", processor_merchant_id: "", statement_descriptor: "", issuer_result_code: "", primer_decline_code: "", lifecycle_event: "", advised_action: "", decline_type: "", card_network: "", payment_method: "", payment_instrument_key: "pi-d" }),
    // u7: lost / stolen (41) and a cascade row (two decline records) with 3DS performed
    tx({ t: T("2026-09-15"), user_id: "u7", issuer_result_code: "41", primer_decline_code: "LOST_OR_STOLEN_CARD", advised_action: "DO_NOT_RETRY", decline_type: "hard", payment_instrument_key: "pi-e" }),
    tx({ t: T("2026-09-16"), user_id: "u7", processor: "ADYEN", processor_merchant_id: PH_SENTINELS.rawMidAdyen, decline_record_count: 2, three_ds_response: "AUTH_FAILED", payment_instrument_key: "pi-f", card_network: "MASTERCARD" }),
    // u8: a Visa category-1 ban through the advice code (Visa relays the category as one digit)
    tx({ t: T("2026-09-18"), user_id: "u8", issuer_result_code: "46", primer_decline_code: "DO_NOT_HONOR", advised_action: "", advice_code: "1", decline_type: "", payment_instrument_key: "pi-g" }),
    tx({ t: T("2026-09-19"), user_id: "u8", payment_instrument_key: "pi-g" }),
    // CANCELLED and PENDING rows: never attempts (Payment Pass parity through raw_status)
    tx({ t: T("2026-09-20"), status: "CANCELLED", user_id: "u1", issuer_result_code: "", primer_decline_code: "", lifecycle_event: "" }),
    tx({ t: T("2026-09-21"), status: "PENDING", user_id: "u2", issuer_result_code: "", primer_decline_code: "", lifecycle_event: "" }),
    // a success with no raw_status (synced before the P0 backfill) still counts, exactly as in Payment Pass
    { ...tx({ t: T("2026-09-22"), status: "SETTLED", user_id: "u9", transaction_type: "trial", amount: 9.99, payment_instrument_key: "pi-u9" }), raw_status: "" },
    // ---- after the window (data_through = 2026-10-03) ----
    tx({ t: T("2026-10-03"), status: "SETTLED", user_id: "u1", transaction_type: "renewal_2", payment_instrument_key: "pi-u1" }),
  ];
}

/** user → acquisition anchor path (the validated snapshot's fact_user_cohorts rows). */
export const FIXTURE_ANCHORS: ReadonlyMap<string, string> = new Map([
  ["u1", "soulmate-sketch"],
  ["u2", "past-life"],
  ["u4", "soulmate-sketch"],
]);

export function fixtureSupport(): FixtureSupport[] {
  return [
    // u1 complained 5 days after a settled Stripe payment → attributed to Stripe MID #1
    { request_id: "sr-1", received_at: "2026-09-07T12:00:00.000Z", matched_user_id: "u1", possible_unauthorized_charge: 1, requires_refund: 0, duplicate_charge: 0, category: "Unauthorized or unexpected charge", classification_version: "v2" },
    // unmatched e-mail → unattributed
    { request_id: "sr-2", received_at: "2026-09-08T12:00:00.000Z", matched_user_id: "", possible_unauthorized_charge: 1, requires_refund: 1, duplicate_charge: 0, category: "Refund", classification_version: "v2" },
    // u7 never settled a payment → matched, but unattributed
    { request_id: "sr-3", received_at: "2026-09-25T12:00:00.000Z", matched_user_id: "u7", possible_unauthorized_charge: 0, requires_refund: 0, duplicate_charge: 1, category: "Duplicate charge", classification_version: "v2" },
    // u2 complained 20 days after the Adyen upsell → attributed to Adyen MID #1
    { request_id: "sr-4", received_at: "2026-09-24T12:00:00.000Z", matched_user_id: "u2", possible_unauthorized_charge: 1, requires_refund: 1, duplicate_charge: 0, category: "Unauthorized or unexpected charge", classification_version: "v2" },
    // baseline month (August, classifier v1): the version changes in September (a trend break)
    { request_id: "sr-5", received_at: "2026-08-10T12:00:00.000Z", matched_user_id: "u1", possible_unauthorized_charge: 1, requires_refund: 0, duplicate_charge: 0, category: "Unauthorized or unexpected charge", classification_version: "v1" },
  ];
}

/** psp_accounts rows: Stripe MID #1 and Adyen MID #1 registered, the second Stripe MID not. */
export function fixtureAccounts(): Array<Record<string, unknown>> {
  return [
    { id: "aaaa0000-0000-4000-8000-00000000a001", auth_user_id: PH_DATA_KEY, processor: "STRIPE", processor_merchant_id: PH_SENTINELS.rawMidRegistered, label: "Stripe MID #1", descriptor_prefix: "SENTINEL*" },
    { id: "aaaa0000-0000-4000-8000-00000000a002", auth_user_id: PH_DATA_KEY, processor: "ADYEN", processor_merchant_id: PH_SENTINELS.rawMidAdyen, label: "Adyen MID #1", descriptor_prefix: null },
  ];
}

/** The strict fake as the runner's client type (its builder returns itself where the real one returns a promise; same calls). */
export const asPg = (fake: StrictFakeSupabase): SupabaseLikeClient => fake as unknown as SupabaseLikeClient;

/** The service-role Postgres the runner reads: registry, snapshot state, import batches, sync state. */
export function fixturePg(options: { snapshot?: boolean; accounts?: Array<Record<string, unknown>> } = {}): StrictFakeSupabase {
  const snapshotRows = options.snapshot === false
    ? []
    : [{
      auth_user_id: PH_DATA_KEY,
      snapshot_name: "fact_user_cohorts",
      status: "completed",
      active_warehouse_version: PH_SNAPSHOT.warehouse_version,
      active_classification_version: PH_SNAPSHOT.classification_version,
      duplicate_users: 0,
      diagnostics: { validation: { status: "PASS", duplicate_users: 0 } },
    }];
  return createStrictFakeSupabase({
    tenantKey: PH_DATA_KEY,
    tables: {
      psp_accounts: { scope: "tenant", owner: "auth_user_id", rows: options.accounts ?? fixtureAccounts() },
      clickhouse_cohort_snapshot_state: { scope: "tenant", owner: "auth_user_id", rows: snapshotRows },
      import_batches: {
        scope: "tenant",
        owner: "user_id",
        rows: [{ user_id: PH_DATA_KEY, imported_at: "2026-10-05T07:00:00.000Z", status: "completed", rows_total: 1200, rows_inserted: 1100, rows_updated: 100, source: "primer_csv", filename: `export-${SENTINEL_EMAILS[1]}.csv` }],
      },
      clickhouse_transaction_sync_state: {
        scope: "tenant",
        owner: "auth_user_id",
        rows: [{ auth_user_id: PH_DATA_KEY, sync_name: "analytics_transactions_backfill", status: "completed", updated_at: "2026-10-05T07:30:00.000Z", last_error: `boom ${SENTINEL_EMAILS[1]}`, cursor: "secret-cursor" }],
      },
    },
  });
}

// ---------------------------------------------------------------------------
// The semantic responder
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const dayOf = (iso: string) => iso.slice(0, 10);
const upper = (value: string) => value.toUpperCase();

interface BaseRow extends FixtureTx {
  day: string;
  period: "current" | "baseline";
  processor_key: string;
  initiation: string;
  stage: string;
  card_network_key: string;
  payment_method_key: string;
  country: string;
  funnel: string;
}

function mondayOf(day: string): string {
  const at = Date.parse(`${day}T00:00:00.000Z`);
  const weekday = new Date(at).getUTCDay(); // 0 = Sunday
  const back = (weekday + 6) % 7;
  return new Date(at - back * DAY_MS).toISOString().slice(0, 10);
}

function monthOf(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

function dateDiffDays(from: string, to: string): number {
  return Math.round((Date.parse(`${dayOf(to.replace(" ", "T"))}T00:00:00.000Z`) - Date.parse(`${dayOf(from)}T00:00:00.000Z`)) / DAY_MS);
}

export interface FixtureWarehouse {
  respond(statement: RecordedStatement): unknown[];
  /** Statement markers seen, in order. */
  markers: string[];
}

export function fixtureWarehouse(input: { rows: FixtureTx[]; anchors?: ReadonlyMap<string, string>; support?: FixtureSupport[] }): FixtureWarehouse {
  const anchors = input.anchors ?? FIXTURE_ANCHORS;
  const support = input.support ?? fixtureSupport();
  const markers: string[] = [];
  const attempts = () => input.rows.filter((row) => row.raw_status !== "CANCELLED" && row.raw_status !== "PENDING");

  const derive = (row: FixtureTx, params: Record<string, unknown>): BaseRow => {
    const snapshotMatches = params.snapshot_warehouse_version === PH_SNAPSHOT.warehouse_version && params.snapshot_classification_version === PH_SNAPSHOT.classification_version;
    const anchor = snapshotMatches ? anchors.get(row.user_id) ?? "" : "";
    const day = dayOf(row.event_time);
    return {
      ...row,
      day,
      period: day >= String(params.range_from) ? "current" : "baseline",
      processor_key: row.processor ? upper(row.processor) : "unrouted",
      initiation: row.initiation_type || "unknown",
      stage: row.is_success ? row.transaction_type : row.ff_billing_reason ? `declined_${row.ff_billing_reason.toLowerCase()}` : row.initiation_type === "mit" ? "declined_mit" : row.initiation_type === "cit" ? "declined_cit" : "declined_unknown",
      card_network_key: row.card_network ? upper(row.card_network) : "unknown",
      payment_method_key: row.payment_method ? upper(row.payment_method) : "unknown",
      country: row.issuer_country ? upper(row.issuer_country) : "unknown",
      funnel: anchor || "unattributed",
    };
  };

  const listParam = (params: Record<string, unknown>, prefix: string): string[] => {
    const out: string[] = [];
    for (let index = 0; `p_${prefix}_${index}` in params; index += 1) out.push(String(params[`p_${prefix}_${index}`]));
    return out;
  };
  const pairParams = (params: Record<string, unknown>, prefix: string): { pairs: Array<[string, string]>; nones: string[] } => {
    const pairs: Array<[string, string]> = [];
    const nones: string[] = [];
    for (const [key, value] of Object.entries(params)) {
      const pair = new RegExp(`^p_${prefix}_(\\d+)_p$`).exec(key);
      if (pair) pairs.push([String(value), String(params[`p_${prefix}_${pair[1]}_v`])]);
      if (new RegExp(`^p_${prefix}_none_\\d+$`).test(key)) nones.push(String(value));
    }
    return { pairs, nones };
  };

  const att = (params: Record<string, unknown>, filtered: boolean): BaseRow[] => {
    const from = String(params.window_from);
    const to = String(params.window_to);
    let rows = attempts().map((row) => derive(row, params)).filter((row) => row.day >= from && row.day <= to);
    if (!filtered) return rows;
    const inList = (prefix: string, pick: (row: BaseRow) => string) => {
      const values = listParam(params, prefix);
      if (values.length) rows = rows.filter((row) => values.includes(pick(row)));
    };
    inList("proc", (row) => row.processor_key);
    inList("fn", (row) => row.funnel);
    inList("co", (row) => row.country);
    inList("cn", (row) => row.card_network_key);
    inList("pm", (row) => row.payment_method_key);
    inList("init", (row) => row.initiation);
    inList("tt", (row) => row.transaction_type);
    const ma = pairParams(params, "ma");
    if (ma.pairs.length || ma.nones.length) {
      rows = rows.filter((row) => ma.pairs.some(([processor, mid]) => row.processor_key === processor && row.processor_merchant_id === mid) || (ma.nones.includes(row.processor_key) && row.processor_merchant_id === ""));
    }
    const desc = pairParams(params, "desc");
    if (desc.pairs.length || desc.nones.length) {
      rows = rows.filter((row) => desc.pairs.some(([processor, value]) => row.processor_key === processor && row.statement_descriptor === value) || (desc.nones.includes(row.processor_key) && row.statement_descriptor === ""));
    }
    return rows;
  };

  const groupBy = <K extends Record<string, unknown>>(rows: BaseRow[], keyOf: (row: BaseRow) => K): Array<{ key: K; rows: BaseRow[] }> => {
    const groups = new Map<string, { key: K; rows: BaseRow[] }>();
    for (const row of rows) {
      const key = keyOf(row);
      const id = JSON.stringify(key);
      const group = groups.get(id) ?? { key, rows: [] };
      group.rows.push(row);
      groups.set(id, group);
    }
    return [...groups.values()];
  };

  const codeKey = (row: BaseRow) => ({
    is_success: row.is_success,
    lifecycle_event: row.lifecycle_event,
    issuer_result_code: row.issuer_result_code,
    primer_decline_code: row.primer_decline_code,
    advice_code: row.advice_code,
    advised_action: row.advised_action,
    decline_type: row.decline_type,
    card_network_raw: row.card_network,
    proc: row.processor_key,
    cascade_row: row.decline_record_count > 1 ? 1 : 0,
    three_ds: row.three_ds_response ? 1 : 0,
  });
  const metrics = (rows: BaseRow[]) => ({
    attempts: String(rows.length),
    successes: String(rows.filter((row) => row.is_success).length),
    settled_amount_usd: rows.filter((row) => row.is_success).reduce((sum, row) => sum + row.amount_usd, 0),
    refunded: String(rows.filter((row) => row.is_success && row.is_refund).length),
    refund_amount_usd: rows.filter((row) => row.is_success && row.is_refund).reduce((sum, row) => sum + row.refund_amount_usd, 0),
  });
  const dimensionColumns = (sql: string): string[] => {
    const match = /SELECT period, (.+?), (?:is_success,|toString\(toStartOfMonth\(day\)\))/.exec(sql);
    return match ? match[1].split(", ").map((entry) => entry.trim()) : [];
  };
  const columnValue = (row: BaseRow, column: string): unknown => {
    switch (column) {
      case "processor":
        return row.processor_key;
      case "card_network":
        return row.card_network_key;
      case "payment_method":
        return row.payment_method_key;
      default:
        return (row as unknown as Record<string, unknown>)[column];
    }
  };

  const respond = (statement: RecordedStatement): unknown[] => {
    const marker = /\/\* ph:(\w+) \*\//.exec(statement.query)?.[1] ?? "unknown";
    markers.push(marker);
    const params = statement.params;
    switch (marker) {
      case "registry": {
        const groups = groupBy(attempts().map((row) => derive(row, { ...params, range_from: "1970-01-01" })), (row) => ({ proc: row.processor_key, mid: row.processor_merchant_id, descriptor: row.statement_descriptor }));
        return groups
          .map((group) => ({
            ...group.key,
            first_seen: group.rows.map((row) => row.day).sort()[0],
            last_seen: group.rows.map((row) => row.day).sort().at(-1),
            rows: String(group.rows.length),
          }))
          .sort((a, b) => a.proc.localeCompare(b.proc) || a.first_seen.localeCompare(b.first_seen) || a.mid.localeCompare(b.mid) || a.descriptor.localeCompare(b.descriptor));
      }
      case "overview_groups":
        return groupBy(att(params, true), (row) => ({ period: row.period, processor: row.processor_key, processor_merchant_id: row.processor_merchant_id, ...codeKey(row) })).map((group) => ({ ...group.key, ...metrics(group.rows) }));
      case "overview_trend": {
        const week = statement.query.includes("toStartOfWeek(day, 1)");
        return groupBy(att(params, true).filter((row) => row.period === "current"), (row) => ({ bucket: week ? mondayOf(row.day) : row.day, processor: row.processor_key, processor_merchant_id: row.processor_merchant_id, ...codeKey(row) })).map((group) => ({ ...group.key, ...metrics(group.rows) }));
      }
      case "overview_change":
        return groupBy(att(params, true), (row) => ({ period: row.period, processor: row.processor_key, processor_merchant_id: row.processor_merchant_id, initiation: row.initiation, card_network: row.card_network_key, country: row.country, funnel: row.funnel })).map((group) => ({ ...group.key, attempts: String(group.rows.length), successes: String(group.rows.filter((row) => row.is_success).length) }));
      case "declines_groups": {
        const columns = dimensionColumns(statement.query);
        return groupBy(att(params, true), (row) => ({ period: row.period, ...Object.fromEntries(columns.map((column) => [column, columnValue(row, column)])), ...codeKey(row) })).map((group) => ({ ...group.key, ...metrics(group.rows) }));
      }
      case "refunds_groups": {
        const columns = dimensionColumns(statement.query);
        return groupBy(att(params, true), (row) => ({ period: row.period, ...Object.fromEntries(columns.map((column) => [column, columnValue(row, column)])), month: monthOf(row.day) })).map((group) => {
          const refunded = group.rows.filter((row) => row.is_success && row.is_refund);
          const observed = refunded.filter((row) => row.refund_observed_at);
          const within = (days: number) => observed.filter((row) => dateDiffDays(row.event_time, row.refund_observed_at as string) <= days).length;
          return { ...group.key, ...metrics(group.rows), refund_observed: observed.length, refund_within_7: within(7), refund_within_30: within(30), refund_within_90: within(90) };
        });
      }
      case "attempt_rows": {
        const cap = Number(params.row_cap);
        return att(params, true)
          .sort((a, b) => a.event_time.localeCompare(b.event_time) || a.transaction_id.localeCompare(b.transaction_id))
          .slice(0, cap)
          .map((row) => ({
            transaction_id: row.transaction_id,
            user_id: row.user_id,
            event_ms: String(Date.parse(row.event_time)),
            raw_status: row.raw_status,
            is_success: row.is_success,
            currency: row.currency,
            original_amount: row.original_amount,
            price_point: row.price_point,
            initiation: row.initiation,
            processor: row.processor_key,
            processor_merchant_id: row.processor_merchant_id,
            payment_instrument_key: row.payment_instrument_key,
            card_network_raw: row.card_network,
            advised_action: row.advised_action,
            advice_code: row.advice_code,
            issuer_result_code: row.issuer_result_code,
            primer_decline_code: row.primer_decline_code,
            lifecycle_event: row.lifecycle_event,
            decline_record_count: row.decline_record_count,
          }));
      }
      case "complaints": {
        const compareFrom = String(params.compare_from);
        const rangeFrom = String(params.range_from);
        const rangeTo = String(params.range_to);
        const lookbackFrom = String(params.lookback_from);
        const days = Number(params.attribution_days);
        const settled = attempts().filter((row) => row.is_success && dayOf(row.event_time) >= lookbackFrom && dayOf(row.event_time) <= rangeTo);
        const complaints = support.filter((request) => dayOf(request.received_at) >= compareFrom && dayOf(request.received_at) <= rangeTo);
        const groups = new Map<string, Record<string, unknown> & { total: number; unauthorized: number; refund_requests: number; duplicate: number }>();
        for (const request of complaints) {
          let processor = "unattributed";
          let mid = "";
          if (request.matched_user_id) {
            const receivedMs = Date.parse(request.received_at);
            const candidates = settled
              .filter((row) => row.user_id === request.matched_user_id && Date.parse(row.event_time) <= receivedMs && Date.parse(row.event_time) > receivedMs - days * DAY_MS)
              .sort((a, b) => b.event_time.localeCompare(a.event_time));
            if (candidates.length) {
              processor = candidates[0].processor ? upper(candidates[0].processor) : "unrouted";
              mid = candidates[0].processor_merchant_id;
            }
          }
          const key = { period: dayOf(request.received_at) >= rangeFrom ? "current" : "baseline", month: monthOf(dayOf(request.received_at)), classification_version: request.classification_version, category: request.category, processor, processor_merchant_id: mid };
          const id = JSON.stringify(key);
          const entry = groups.get(id) ?? { ...key, total: 0, unauthorized: 0, refund_requests: 0, duplicate: 0 };
          entry.total += 1;
          entry.unauthorized += request.possible_unauthorized_charge;
          entry.refund_requests += request.requires_refund;
          entry.duplicate += request.duplicate_charge;
          groups.set(id, entry);
        }
        return [...groups.values()];
      }
      case "settled_counts": {
        // Filter-free on purpose: the complaint rate's denominator is the window's settled payments whatever the request filters.
        const compareFrom = String(params.compare_from);
        const rangeFrom = String(params.range_from);
        const rangeTo = String(params.range_to);
        const settled = attempts().filter((row) => row.is_success && dayOf(row.event_time) >= compareFrom && dayOf(row.event_time) <= rangeTo);
        const groups = new Map<string, { period: string; proc: string; mid: string; settled: number }>();
        for (const row of settled) {
          const key = { period: dayOf(row.event_time) >= rangeFrom ? "current" : "baseline", proc: row.processor ? upper(row.processor) : "unrouted", mid: row.processor_merchant_id };
          const id = JSON.stringify(key);
          const entry = groups.get(id) ?? { ...key, settled: 0 };
          entry.settled += 1;
          groups.set(id, entry);
        }
        return [...groups.values()].map((entry) => ({ ...entry, settled: String(entry.settled) }));
      }
      case "coverage": {
        const rows = attempts();
        const out: Record<string, unknown> = {
          rows: String(rows.length),
          rows_without_raw_status: String(rows.filter((row) => row.raw_status === "").length),
          successes: String(rows.filter((row) => row.is_success).length),
          refunded: String(rows.filter((row) => row.is_success && row.is_refund).length),
          refund_observed: String(rows.filter((row) => row.is_success && row.is_refund && row.refund_observed_at).length),
          declines: String(rows.filter((row) => !row.is_success).length),
          declines_with_record: String(rows.filter((row) => !row.is_success && row.decline_record_count > 0).length),
          first_day: rows.map((row) => dayOf(row.event_time)).sort()[0],
          last_day: rows.map((row) => dayOf(row.event_time)).sort().at(-1),
          // toUnixTimestamp64Milli of a DateTime64(3, 'UTC') text: the same Int64-as-text shape the runner parses.
          last_synced_ms: String(Date.parse(`${(rows.map((row) => row.clickhouse_synced_at).sort().at(-1) ?? "1970-01-01 00:00:00.000").replace(" ", "T")}Z`)),
        };
        for (const match of statement.query.matchAll(/countIf\((\w+) (!= ''|> 0)\) AS c_(\w+)/g)) {
          const [, column, test, alias] = match;
          out[`c_${alias}`] = String(rows.filter((row) => {
            const value = (row as unknown as Record<string, unknown>)[column];
            return test === "> 0" ? Number(value ?? 0) > 0 : String(value ?? "") !== "";
          }).length);
        }
        return [out];
      }
      case "support_versions": {
        const groups = new Map<string, { month: string; classification_version: string; requests: number }>();
        for (const request of support) {
          const key = `${monthOf(dayOf(request.received_at))}|${request.classification_version}`;
          const entry = groups.get(key) ?? { month: monthOf(dayOf(request.received_at)), classification_version: request.classification_version, requests: 0 };
          entry.requests += 1;
          groups.set(key, entry);
        }
        return [...groups.values()].sort((a, b) => a.month.localeCompare(b.month) || a.classification_version.localeCompare(b.classification_version));
      }
      case "options": {
        const rows = att(params, false);
        const dims: Array<[string, (row: BaseRow) => string]> = [
          ["funnel", (row) => row.funnel],
          ["country", (row) => row.country],
          ["card_network", (row) => row.card_network_key],
          ["payment_method", (row) => row.payment_method_key],
          ["initiation", (row) => row.initiation],
          ["transaction_type", (row) => row.transaction_type],
        ];
        const out = new Map<string, { d: string; v: string; n: number }>();
        for (const row of rows) {
          for (const [d, pick] of dims) {
            const v = pick(row);
            const entry = out.get(`${d}|${v}`) ?? { d, v, n: 0 };
            entry.n += 1;
            out.set(`${d}|${v}`, entry);
          }
        }
        return [...out.values()];
      }
      default:
        throw new Error(`fixtureWarehouse: unexpected statement ${marker}: ${statement.query.slice(0, 120)}`);
    }
  };

  return { respond, markers };
}
