// Bank / issuer analytics over the SAME staged attempt table Payment Pass uses.
//
// Everything here reuses paymentAnalytics' machinery through its _-prefixed
// exports: the scratch table (pp_staged_<uuid> — the sweeper's regex only
// reaches that prefix), attemptWhere with bound parameters, METRIC_COLS and
// toMetrics. The one thing deliberately NOT reused is groupBy(): it coalesces
// empty keys into "unknown", which would merge "the provider said UNKNOWN"
// (issuer_key = 'unknown') with "the provider said nothing" (issuer_key = '') —
// the exact distinction the coverage block exists to report.
//
// Attribution is PER-TRANSACTION (the staged projection reads allrows, not
// uattr): a user can pay with several cards, and a user-level attribution would
// credit a successful card with the declines of the card it replaced.
import type { ClickHouseClientLike } from "./types.ts";
import {
  PaymentAnalyticsRequestError,
  normalizePaymentAnalyticsRequest,
  type PassMetrics,
  type PaymentAnalyticsFilters,
  _METRIC_COLS,
  _attachTopDecline,
  _attemptWhere,
  _dayCol,
  _dropStagedTable,
  _json,
  _materializeStaged,
  _stagedTableName,
  _sweepStaleTables,
  _toMetrics,
  _ungrouped,
} from "./paymentAnalytics.ts";
import {
  DEFAULT_TREND_TOP_N,
  MAX_ISSUER_ROWS,
  MAX_TREND_TOP_N,
  type BankAnalyticsBundle,
  type BankDetailBundle,
  type IssuerCoverage,
  type IssuerGroupRow,
  type IssuerRow,
  type IssuerTrendPoint,
} from "./bankContract.ts";

const s = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
const n = (v: unknown): number => { const p = Number(v ?? 0); return Number.isFinite(p) ? p : 0; };

export function normalizeBankRequest(req: { issuer_key?: unknown; trend_top_n?: unknown }): {
  issuerKey: string; trendTopN: number;
} {
  const issuerKey = s(req.issuer_key).trim();
  if (issuerKey && !/^[a-z0-9_]{1,64}$/.test(issuerKey)) {
    throw new PaymentAnalyticsRequestError(`Invalid issuer_key: ${issuerKey.slice(0, 80)}`);
  }
  const raw = Number(req.trend_top_n ?? DEFAULT_TREND_TOP_N);
  const trendTopN = Number.isFinite(raw) ? Math.max(1, Math.min(MAX_TREND_TOP_N, Math.floor(raw))) : DEFAULT_TREND_TOP_N;
  return { issuerKey, trendTopN };
}

async function issuerRows(
  client: ClickHouseClientLike, table: string, filters: PaymentAnalyticsFilters,
): Promise<{ rows: IssuerRow[]; truncated: boolean }> {
  const params: Record<string, unknown> = {};
  const where = _attemptWhere(filters, params);
  // min(), not any(): key→name is a pure function by construction, so the value
  // is identical either way — min() makes that non-negotiable rather than
  // dependent on scan order (the same reasoning as modeOf vs topK(1)).
  params.row_cap = MAX_ISSUER_ROWS + 1;
  const res = await _json(client,
    `SELECT issuer_key k, min(issuer_name) name, min(issuer_group) grp, ${_METRIC_COLS}
     FROM ${table} ${where}
     GROUP BY issuer_key
     ORDER BY attempts DESC, issuer_key ASC
     LIMIT {row_cap:UInt32}`,
    params);
  const truncated = res.length > MAX_ISSUER_ROWS;
  const rows: IssuerRow[] = res.slice(0, MAX_ISSUER_ROWS).map((r) => ({
    issuer_key: s(r.k),
    issuer_name: s(r.name),
    issuer_group: s(r.grp),
    ..._toMetrics(r),
  }));
  const keyed = rows.map((row) => ({ key: row.issuer_key, ...row }));
  await _attachTopDecline(client, table, filters, "issuer_key", keyed);
  for (let i = 0; i < rows.length; i += 1) {
    rows[i].top_decline_reason = keyed[i].top_decline_reason;
    rows[i].top_decline_reason_users = keyed[i].top_decline_reason_users;
  }
  return { rows, truncated };
}

async function issuerGroupRows(
  client: ClickHouseClientLike, table: string, filters: PaymentAnalyticsFilters,
): Promise<IssuerGroupRow[]> {
  // A separate aggregation rather than a TS roll-up of issuer_rows: attempts
  // are additive across sub-brands, but uniqExact(uid) is NOT — a user who paid
  // with both a Bancolombia and a Nequi card must count once in the group.
  const params: Record<string, unknown> = {};
  const where = _attemptWhere(filters, params);
  const res = await _json(client,
    `SELECT issuer_group gk, uniqExact(issuer_key) member_count, ${_METRIC_COLS}
     FROM ${table} ${where}
     GROUP BY issuer_group
     ORDER BY attempts DESC, issuer_group ASC`,
    params);
  return res.map((r) => ({
    issuer_group: s(r.gk),
    member_count: n(r.member_count),
    ..._toMetrics(r),
  }));
}

async function coverage(
  client: ClickHouseClientLike, table: string, filters: PaymentAnalyticsFilters,
): Promise<IssuerCoverage> {
  const params: Record<string, unknown> = {};
  const where = _attemptWhere(filters, params);
  const [r] = await _json(client,
    `SELECT count() total,
       countIf(issuer_key NOT IN ('', 'unknown')) identified,
       countIf(issuer_key = 'unknown') reported_unknown,
       countIf(issuer_key = '') missing,
       countIf(is_success = 1 AND issuer_key NOT IN ('', 'unknown')) id_ok,
       countIf(is_failed = 1 AND issuer_key NOT IN ('', 'unknown')) id_fail,
       countIf(is_success = 1 AND issuer_key IN ('', 'unknown')) unid_ok,
       countIf(is_failed = 1 AND issuer_key IN ('', 'unknown')) unid_fail,
       countIf(is_success = 0 AND is_failed = 0) non_attempt
     FROM ${table} ${where}`,
    params);
  return {
    total_attempts: n(r?.total),
    identified_attempts: n(r?.identified),
    reported_unknown_attempts: n(r?.reported_unknown),
    missing_attempts: n(r?.missing),
    identified_success: n(r?.id_ok),
    identified_failed: n(r?.id_fail),
    unidentified_success: n(r?.unid_ok),
    unidentified_failed: n(r?.unid_fail),
    non_attempt_rows: n(r?.non_attempt),
  };
}

/** identified + reported_unknown + missing must equal total. A violation means
 * two queries disagreed about the filter — refuse to answer rather than ship a
 * table that does not add up. */
export function assertCoverageReconciles(c: IssuerCoverage): void {
  const sum = c.identified_attempts + c.reported_unknown_attempts + c.missing_attempts;
  if (sum !== c.total_attempts) {
    throw new Error(`Issuer coverage does not reconcile: ${c.identified_attempts} + ${c.reported_unknown_attempts} + ${c.missing_attempts} != ${c.total_attempts}`);
  }
}

async function trendPoints(
  client: ClickHouseClientLike, table: string, filters: PaymentAnalyticsFilters, topN: number,
): Promise<IssuerTrendPoint[]> {
  const params: Record<string, unknown> = {};
  const where = _attemptWhere(filters, params);
  const dc = _dayCol(filters);
  params.top_n = topN;
  // Top-N issuers by attempts under the same filter, then their daily series.
  const res = await _json(client,
    `SELECT ${dc} d, issuer_key k, count() attempts, sum(is_success) successful
     FROM ${table} ${where ? where + " AND" : "WHERE"} issuer_key IN (
       SELECT issuer_key FROM ${table} ${where ? where + " AND" : "WHERE"} issuer_key NOT IN ('', 'unknown')
       GROUP BY issuer_key ORDER BY count() DESC, issuer_key ASC LIMIT {top_n:UInt32}
     )
     GROUP BY d, k ORDER BY d ASC, k ASC`,
    params);
  return res.map((r) => ({
    date: s(r.d), issuer_key: s(r.k), attempts: n(r.attempts), successful: n(r.successful),
  }));
}

async function bankFilterOptions(
  client: ClickHouseClientLike, table: string,
): Promise<BankAnalyticsBundle["filter_options"]> {
  // Global (unfiltered) options with attempt counts, matching the Payment Pass
  // convention that option lists reflect the full dataset.
  const [issuers, groups, networks, methods, countries] = await Promise.all([
    _json(client, `SELECT issuer_key k, min(issuer_name) name, count() a FROM ${table} WHERE issuer_key NOT IN ('', 'unknown') GROUP BY issuer_key ORDER BY a DESC LIMIT 2000`, {}),
    _json(client, `SELECT issuer_group g, count() a FROM ${table} WHERE issuer_group NOT IN ('', 'unknown') GROUP BY issuer_group ORDER BY a DESC LIMIT 2000`, {}),
    _json(client, `SELECT card_network v FROM ${table} WHERE card_network != '' GROUP BY card_network ORDER BY count() DESC`, {}),
    _json(client, `SELECT payment_method v FROM ${table} WHERE payment_method != '' GROUP BY payment_method ORDER BY count() DESC`, {}),
    _json(client, `SELECT issuer_country v FROM ${table} WHERE issuer_country != '' GROUP BY issuer_country ORDER BY count() DESC`, {}),
  ]);
  return {
    issuer: issuers.map((r) => ({ issuer_key: s(r.k), issuer_name: s(r.name), attempts: n(r.a) })),
    issuer_group: groups.map((r) => ({ issuer_group: s(r.g), attempts: n(r.a) })),
    card_network: networks.map((r) => s(r.v)),
    payment_method: methods.map((r) => s(r.v)),
    issuer_country: countries.map((r) => s(r.v)),
  };
}

export async function runBankAnalytics(input: {
  authUserId: string; clickhouse: ClickHouseClientLike;
  request: { filters?: Partial<PaymentAnalyticsFilters>; trend_top_n?: unknown };
}): Promise<BankAnalyticsBundle> {
  const started = Date.now();
  const { filters } = normalizePaymentAnalyticsRequest({ filters: input.request.filters, action: "banks" });
  const { trendTopN } = normalizeBankRequest(input.request);
  const c = input.clickhouse;
  const table = _stagedTableName();
  await Promise.all([_materializeStaged(c, input.authUserId, table), _sweepStaleTables(c)]);
  try {
    const [totals, cov, issuers, groups, trend, options] = await Promise.all([
      _ungrouped(c, table, filters, ""),
      coverage(c, table, filters),
      issuerRows(c, table, filters),
      issuerGroupRows(c, table, filters),
      trendPoints(c, table, filters, trendTopN),
      bankFilterOptions(c, table),
    ]);
    assertCoverageReconciles(cov);
    return {
      ok: true, source: "clickhouse", action: "banks",
      generated_at: new Date().toISOString(), query_duration_ms: Date.now() - started,
      totals, coverage: cov,
      issuer_rows: issuers.rows, issuer_group_rows: groups,
      trend_points: trend, truncated: issuers.truncated,
      filter_options: options,
    };
  } finally {
    await _dropStagedTable(c, table);
  }
}

async function groupedMetrics(
  client: ClickHouseClientLike, table: string, filters: PaymentAnalyticsFilters, col: string,
): Promise<Array<Record<string, string> & PassMetrics>> {
  const params: Record<string, unknown> = {};
  const where = _attemptWhere(filters, params);
  const res = await _json(client,
    `SELECT ${col} k, ${_METRIC_COLS} FROM ${table} ${where} GROUP BY ${col} ORDER BY attempts DESC, k ASC`,
    params);
  return res.map((r) => ({ [col]: s(r.k), ..._toMetrics(r) } as Record<string, string> & PassMetrics));
}

export async function runBankDetail(input: {
  authUserId: string; clickhouse: ClickHouseClientLike;
  request: { filters?: Partial<PaymentAnalyticsFilters>; issuer_key?: unknown };
}): Promise<BankDetailBundle> {
  const started = Date.now();
  const { issuerKey } = normalizeBankRequest(input.request);
  if (!issuerKey) throw new PaymentAnalyticsRequestError("issuer_key is required for bank_detail.");
  const { filters } = normalizePaymentAnalyticsRequest({ filters: input.request.filters, action: "bank_detail" });
  // The issuer under inspection becomes a filter for every panel below.
  const scoped: PaymentAnalyticsFilters = { ...filters, issuer: [issuerKey] };
  const c = input.clickhouse;
  const table = _stagedTableName();
  await Promise.all([_materializeStaged(c, input.authUserId, table), _sweepStaleTables(c)]);
  try {
    const nameParams: Record<string, unknown> = { ik: issuerKey };
    const declineParams: Record<string, unknown> = {};
    const declineWhere = _attemptWhere(scoped, declineParams);
    const dayParams: Record<string, unknown> = {};
    const dayWhere = _attemptWhere(scoped, dayParams);
    const dc = _dayCol(scoped);
    const groupParams: Record<string, unknown> = {};
    const groupWhere = _attemptWhere(filters, groupParams);

    const [nameRow, stages, declines, countries, networks, methods, cardTypes, days, members] = await Promise.all([
      _json(c, `SELECT min(issuer_name) name, min(issuer_group) grp FROM ${table} WHERE issuer_key = {ik:String}`, nameParams),
      groupedMetrics(c, table, scoped, "stage"),
      _json(c,
        `SELECT decline_key reason, count() failed_attempts, uniqExact(uid) failed_users
         FROM ${table} ${declineWhere ? declineWhere + " AND" : "WHERE"} is_failed = 1 AND decline_key != ''
         GROUP BY decline_key ORDER BY failed_attempts DESC, reason ASC`,
        declineParams),
      groupedMetrics(c, table, scoped, "country"),
      groupedMetrics(c, table, scoped, "card_network"),
      groupedMetrics(c, table, scoped, "payment_method"),
      groupedMetrics(c, table, scoped, "card_type_tx"),
      _json(c,
        `SELECT ${dc} d, count() attempts, sum(is_success) successful
         FROM ${table} ${dayWhere} GROUP BY d ORDER BY d ASC`,
        dayParams),
      _json(c,
        `SELECT issuer_key k, min(issuer_name) name, count() a
         FROM ${table} ${groupWhere ? groupWhere + " AND" : "WHERE"} issuer_group = (
           SELECT min(issuer_group) FROM ${table} WHERE issuer_key = {gm_ik:String}
         )
         GROUP BY issuer_key ORDER BY a DESC`,
        { ...groupParams, gm_ik: issuerKey }),
    ]);

    const totalFailed = declines.reduce((acc, r) => acc + n(r.failed_attempts), 0);
    return {
      ok: true, source: "clickhouse", action: "bank_detail",
      generated_at: new Date().toISOString(), query_duration_ms: Date.now() - started,
      issuer_key: issuerKey,
      issuer_name: s(nameRow[0]?.name) || issuerKey,
      stage_rows: stages.map((r) => ({ ...r, stage: s((r as Record<string, unknown>).stage) })),
      decline_rows: declines.map((r) => ({
        reason: s(r.reason), failed_attempts: n(r.failed_attempts), failed_users: n(r.failed_users),
        share_of_failed: totalFailed > 0 ? n(r.failed_attempts) / totalFailed : 0,
      })),
      country_rows: countries.map((r) => ({ ...r, country: s((r as Record<string, unknown>).country) })),
      network_rows: networks.map((r) => ({ ...r, card_network: s((r as Record<string, unknown>).card_network) })),
      method_rows: methods.map((r) => ({ ...r, payment_method: s((r as Record<string, unknown>).payment_method) })),
      card_type_rows: cardTypes.map((r) => ({ ...r, card_type: s((r as Record<string, unknown>).card_type_tx) })),
      time_points: days.map((r) => ({ date: s(r.d), attempts: n(r.attempts), successful: n(r.successful) })),
      group_members: members.map((r) => ({ issuer_key: s(r.k), issuer_name: s(r.name), attempts: n(r.a) })),
    };
  } finally {
    await _dropStagedTable(c, table);
  }
}
