// Payment System Health data source (plan sections J, M, N, R, S, X; P2 frontend;
// the alert actions of P2.5, plan Q, at the end).
//
// The browser side of the clickhouse-payment-health Edge function: the UI's
// filter state → one request body per action, the typed response back, and a
// shape check so a half-answered body never reaches the tables as "zeros".
// The request / response shapes are the contract module the Edge imports
// (supabase/functions/_shared/clickhouse/paymentHealthContract.ts), so a filter
// the page sends and a filter the SQL binds cannot drift apart. There is no
// legacy in-browser engine here: the warehouse is the only source, and every
// value is an aggregate (no emails, ids, card fragments, raw MIDs or
// descriptors — the server labels them).

import { ClickHouseRequestError, isAccessError, runClickHousePaymentHealth, runClickHousePaymentHealthAlerts } from "@/services/clickhouse";
import type {
  DeclinesResponse,
  OptionsResponse,
  OverviewResponse,
  PaymentHealthAction,
  PaymentHealthDimension,
  PaymentHealthFilters,
  PaymentHealthResponse,
  RefundsSupportResponse,
  RetriesResponse,
  SourcesResponse,
} from "../../supabase/functions/_shared/clickhouse/paymentHealthContract";
import {
  ALERT_RULE_KEYS,
  ALERT_SEVERITIES,
  ALERT_STATUSES,
  normalizeAlertUpdateRequest,
  type AlertRuleKey,
  type AlertSeverity,
  type AlertStatus,
  type AlertUpdateResponse,
  type AlertsListResponse,
  type AlertsRunResponse,
  type PaymentRiskAlert,
} from "../../supabase/functions/_shared/clickhouse/paymentRiskAlertsContract";

export type {
  PaymentHealthAction,
  PaymentHealthDimension,
  PaymentHealthFilters,
  PaymentHealthResponse,
  OverviewResponse,
  DeclinesResponse,
  RetriesResponse,
  RefundsSupportResponse,
  SourcesResponse,
  OptionsResponse,
  AlertsListResponse,
  AlertUpdateResponse,
  AlertsRunResponse,
  PaymentRiskAlert,
};

/** The response of one action. */
export type PaymentHealthResponseFor<A extends PaymentHealthAction> =
  A extends "overview" ? OverviewResponse
  : A extends "declines" ? DeclinesResponse
  : A extends "retries" ? RetriesResponse
  : A extends "refunds_support" ? RefundsSupportResponse
  : A extends "sources" ? SourcesResponse
  : OptionsResponse;

export const PAYMENT_HEALTH_FILTER_KEYS: readonly (keyof PaymentHealthFilters)[] = [
  "processor",
  "merchant_account",
  "descriptor",
  "funnel",
  "country",
  "card_network",
  "payment_method",
  "initiation",
  "transaction_type",
];

/** The three filters / dimensions that need payment_health.psp_global.view. */
export const PSP_FILTER_KEYS: readonly (keyof PaymentHealthFilters)[] = ["processor", "merchant_account", "descriptor"];

/** What the page holds: a window (null = the server default, last 30 days),
 * the filter lists (empty = no filter) and the breakdown dimension (null = the
 * server default: processor with the PSP key, funnel without). */
export interface PaymentHealthQuery {
  dateFrom: string | null;
  dateTo: string | null;
  filters: PaymentHealthFilters;
  dimension: PaymentHealthDimension | null;
}

export const EMPTY_PAYMENT_HEALTH_FILTERS: PaymentHealthFilters = Object.freeze({
  processor: [],
  merchant_account: [],
  descriptor: [],
  funnel: [],
  country: [],
  card_network: [],
  payment_method: [],
  initiation: [],
  transaction_type: [],
}) as PaymentHealthFilters;

/** The query the window-free actions (options, sources) are keyed on. */
export const EMPTY_PAYMENT_HEALTH_QUERY: PaymentHealthQuery = Object.freeze({
  dateFrom: null,
  dateTo: null,
  filters: EMPTY_PAYMENT_HEALTH_FILTERS,
  dimension: null,
}) as PaymentHealthQuery;

/** Actions whose answer depends on the window and the filters. */
export const WINDOWED_ACTIONS: ReadonlySet<PaymentHealthAction> = new Set(["overview", "declines", "retries", "refunds_support"]);
/** Actions that break the figures down by `dimension`. */
export const DIMENSION_ACTIONS: ReadonlySet<PaymentHealthAction> = new Set(["declines", "refunds_support"]);

/** De-duplicated, trimmed, sorted copy of a filter list (so two spellings of
 * the same selection build one request and one cache entry). */
function cleanList(values: readonly string[] | undefined): string[] {
  return Array.from(new Set((values ?? []).map((value) => String(value ?? "").trim()).filter(Boolean))).sort();
}

/** Only the filters that carry values, each list cleaned. */
export function activeFilters(filters: Partial<PaymentHealthFilters> | null | undefined): Partial<PaymentHealthFilters> {
  const out: Partial<PaymentHealthFilters> = {};
  for (const key of PAYMENT_HEALTH_FILTER_KEYS) {
    const list = cleanList(filters?.[key] as readonly string[] | undefined);
    if (list.length) (out as Record<string, string[]>)[key] = list;
  }
  return out;
}

/** The request body of one action. Window-free actions send the action alone
 * (options and sources are tenant-wide), the dimension goes only where the
 * server reads it, and empty filter lists are left out. */
export function buildPaymentHealthRequest(action: PaymentHealthAction, query: PaymentHealthQuery): Record<string, unknown> {
  const body: Record<string, unknown> = { action };
  if (!WINDOWED_ACTIONS.has(action)) return body;
  if (query.dateFrom) body.date_from = query.dateFrom;
  if (query.dateTo) body.date_to = query.dateTo;
  const filters = activeFilters(query.filters);
  if (Object.keys(filters).length) body.filters = filters;
  if (DIMENSION_ACTIONS.has(action) && query.dimension) body.dimension = query.dimension;
  return body;
}

// ---- response shape check -----------------------------------------------------

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const isArray = (value: unknown): value is unknown[] => Array.isArray(value);

/** Top-level fields every response of an action must carry (the contract). */
const REQUIRED_FIELDS: Readonly<Record<PaymentHealthAction, ReadonlyArray<[field: string, check: (value: unknown) => boolean]>>> = {
  overview: [["totals", isObject], ["trend", isArray], ["psp_mid_rows", isArray], ["what_changed", isArray]],
  declines: [["totals", isObject], ["by_class", isArray], ["by_dimension", isArray], ["code_mix", isArray], ["severity", isObject]],
  retries: [["chains", isObject], ["post_ban", isObject], ["post_ban_attempts", isArray], ["rolling", isObject]],
  refunds_support: [["refunds", isObject], ["complaints", isObject]],
  sources: [["warehouse", isObject], ["coverage", isArray], ["metrics", isArray], ["support", isObject]],
  options: [["options", isObject], ["bounds", isObject]],
};

/** True when `value` is a complete response of `action` (ok, same action, meta
 * with a range, every required field of the right kind). */
export function isCompletePaymentHealthResponse<A extends PaymentHealthAction>(action: A, value: unknown): value is PaymentHealthResponseFor<A> {
  if (!isObject(value) || value.ok !== true || value.action !== action) return false;
  if (!isObject(value.meta) || !isObject(value.meta.range) || !isObject(value.meta.compare)) return false;
  return REQUIRED_FIELDS[action].every(([field, check]) => check(value[field]));
}

/** Names the missing / malformed fields of an incomplete response. */
export function missingPaymentHealthFields(action: PaymentHealthAction, value: unknown): string[] {
  if (!isObject(value)) return ["body"];
  const missing: string[] = [];
  if (value.ok !== true) missing.push("ok");
  if (value.action !== action) missing.push("action");
  if (!isObject(value.meta) || !isObject(value.meta.range) || !isObject(value.meta.compare)) missing.push("meta");
  for (const [field, check] of REQUIRED_FIELDS[action]) if (!check(value[field])) missing.push(field);
  return missing;
}

/** Calls the Edge function for one action and returns its typed response. A
 * 200 with ok:false (an embedded error) and an incomplete body both throw: the
 * page shows an error, never a table of zeros. Transport and gate errors are
 * rethrown as the typed ClickHouseRequestError the invoke layer builds. */
export async function loadPaymentHealth<A extends PaymentHealthAction>(action: A, query: PaymentHealthQuery): Promise<PaymentHealthResponseFor<A>> {
  const raw = await runClickHousePaymentHealth<unknown>(buildPaymentHealthRequest(action, query));
  if (isObject(raw) && raw.ok === false) {
    const message = typeof raw.error === "string" && raw.error ? raw.error : "ClickHouse payment health request failed.";
    throw new Error(message);
  }
  if (!isCompletePaymentHealthResponse(action, raw)) {
    throw new Error(`Incomplete ClickHouse payment health response (${action}): missing ${missingPaymentHealthFields(action, raw).join(", ")}.`);
  }
  return raw;
}

// ---- typed errors for the page ----------------------------------------------

/** How the page should treat a failure:
 *   access    — the gate refused this principal (401/403/404/409 with an access
 *               code): render NoAccess, never retry;
 *   request   — the server rejected the request itself (400 invalid_request /
 *               unknown_action): a UI bug or a stale persisted filter;
 *   upstream  — the warehouse or the runner failed (500 / 502 / 504, the
 *               breaker): retry later;
 *   transport — no HTTP response at all (network, CORS, signed out);
 *   shape     — a 200 whose body was not a complete response. */
export type PaymentHealthErrorKind = "access" | "request" | "upstream" | "transport" | "shape";

export interface PaymentHealthError {
  kind: PaymentHealthErrorKind;
  message: string;
  status: number | null;
  errorCode: string | null;
  requestId: string | null;
}

export function describePaymentHealthError(error: unknown): PaymentHealthError {
  if (error instanceof ClickHouseRequestError) {
    const base = { message: error.message, status: error.status, errorCode: error.errorCode, requestId: error.requestId };
    // The predicate narrows its argument; passed as unknown it only answers.
    if (isAccessError(error as unknown)) return { kind: "access", ...base };
    if (base.status >= 400 && base.status < 500) return { kind: "request", ...base };
    return { kind: "upstream", ...base };
  }
  const message = error instanceof Error ? error.message : String(error ?? "Payment health request failed.");
  if (/^Incomplete ClickHouse payment health response/.test(message)) return { kind: "shape", message, status: null, errorCode: null, requestId: null };
  return { kind: "transport", message, status: null, errorCode: null, requestId: null };
}

// ---- payment risk alerts (P2.5, plan Q) ------------------------------------------
// Same function, the alert actions of paymentRiskAlertsContract.ts. The list is
// read through runClickHousePaymentHealthAlerts (Postgres-only on the server:
// not breaker-gated); the shape check refuses a half answer like the page's
// actions do, with the same "Incomplete …" message so describePaymentHealthError
// classifies it as `shape`.

/** The alerts_list filters the page sends (empty = no filter). Canonical: each
 * list de-duplicated, unknown values dropped, in the contract's order — so two
 * spellings of one selection build one request and one cache entry. */
export interface PaymentAlertsFilters {
  status: AlertStatus[];
  severity: AlertSeverity[];
  rule: AlertRuleKey[];
}

function canonicalList<T extends string>(values: readonly unknown[] | undefined, allowed: readonly T[]): T[] {
  const wanted = new Set((values ?? []).map((value) => String(value ?? "").trim()));
  return allowed.filter((value) => wanted.has(value));
}

export function normalizeAlertsFilters(filters: Partial<PaymentAlertsFilters> | null | undefined): PaymentAlertsFilters {
  return {
    status: canonicalList(filters?.status, ALERT_STATUSES),
    severity: canonicalList(filters?.severity, ALERT_SEVERITIES),
    rule: canonicalList(filters?.rule, ALERT_RULE_KEYS),
  };
}

/** The open alerts (new + investigating): the tab's default view and the tab badge's query (one cache entry). */
export const OPEN_ALERTS_FILTERS: PaymentAlertsFilters = Object.freeze(normalizeAlertsFilters({ status: ["new", "investigating"] })) as PaymentAlertsFilters;

/** alerts_list body: the action and the non-empty filter lists (the server's default limit, 100). */
export function buildAlertsListRequest(filters: Partial<PaymentAlertsFilters>): Record<string, unknown> {
  const clean = normalizeAlertsFilters(filters);
  const body: Record<string, unknown> = { action: "alerts_list" };
  if (clean.status.length) body.status = clean.status;
  if (clean.severity.length) body.severity = clean.severity;
  if (clean.rule.length) body.rule = clean.rule;
  return body;
}

export interface AlertStatusChange {
  alertId: string;
  status: AlertStatus;
  note?: string | null;
}

/** alert_update body, validated by the contract's own normalizer first: a note
 * over the limit or a malformed id fails here, before anything is sent. */
export function buildAlertUpdateRequest(change: AlertStatusChange): Record<string, unknown> {
  const req = normalizeAlertUpdateRequest({ alert_id: change.alertId, status: change.status, note: change.note ?? null });
  const body: Record<string, unknown> = { action: "alert_update", alert_id: req.alert_id, status: req.status };
  if (req.note) body.note = req.note;
  return body;
}

const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isObjectOrNull = (value: unknown) => value === null || isObject(value);

type AlertActionName = "alerts_list" | "alert_update" | "alerts_run";

const ALERT_REQUIRED_FIELDS: Readonly<Record<AlertActionName, ReadonlyArray<[field: string, check: (value: unknown) => boolean]>>> = {
  alerts_list: [
    ["alerts", (value) => isArray(value) && value.every(isObject)],
    ["counts", (value) => isObject(value) && isNumber(value.open) && isObject(value.by_status) && isObject(value.open_by_severity)],
    ["hidden_psp_scoped", isNumber],
    ["last_run", isObjectOrNull],
    ["rules", isArray],
    ["meta", (value) => isObject(value) && typeof value.psp_global_visible === "boolean" && typeof value.can_manage === "boolean"],
  ],
  alert_update: [["alert", (value) => isObject(value) && typeof value.id === "string"]],
  alerts_run: [["run", isObjectOrNull]],
};

/** Names the missing / malformed fields of an alert action's response ([] = complete). */
export function missingAlertsFields(action: AlertActionName, value: unknown): string[] {
  if (!isObject(value)) return ["body"];
  const missing: string[] = [];
  if (value.ok !== true) missing.push("ok");
  if (value.action !== action) missing.push("action");
  for (const [field, check] of ALERT_REQUIRED_FIELDS[action]) if (!check(value[field])) missing.push(field);
  return missing;
}

export function isCompleteAlertsListResponse(value: unknown): value is AlertsListResponse {
  return missingAlertsFields("alerts_list", value).length === 0;
}

async function callAlerts<T>(action: AlertActionName, body: Record<string, unknown>): Promise<T> {
  const raw = await runClickHousePaymentHealthAlerts<unknown>(body);
  if (isObject(raw) && raw.ok === false) {
    const message = typeof raw.error === "string" && raw.error ? raw.error : "Payment alerts request failed.";
    throw new Error(message);
  }
  const missing = missingAlertsFields(action, raw);
  if (missing.length) throw new Error(`Incomplete ClickHouse payment health response (${action}): missing ${missing.join(", ")}.`);
  return raw as T;
}

/** alerts_list (payment_health.view). */
export async function loadPaymentAlerts(filters: Partial<PaymentAlertsFilters>): Promise<AlertsListResponse> {
  return callAlerts<AlertsListResponse>("alerts_list", buildAlertsListRequest(filters));
}

/** alert_update (payment_health.manage_alerts): the alert as stored after the change. */
export async function updatePaymentAlert(change: AlertStatusChange): Promise<AlertUpdateResponse> {
  // async: an invalid change (the contract normalizer throws) rejects instead of throwing synchronously.
  return callAlerts<AlertUpdateResponse>("alert_update", buildAlertUpdateRequest(change));
}

/** alerts_run (payment_health.manage_alerts): evaluates every rule now; can take a couple of minutes. */
export async function runPaymentAlerts(): Promise<AlertsRunResponse> {
  return callAlerts<AlertsRunResponse>("alerts_run", { action: "alerts_run" });
}
