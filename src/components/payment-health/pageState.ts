// Payment System Health page state: what usePersistedPageState keeps for the
// person ("ui_state_payment_health"), and the pure mapping from that state to
// the request query. Pure module so the tests can pin the two rules that
// matter for access: a persisted PSP selection is dropped from the request
// (never sent) when the server says the PSP dimensions are not visible, and a
// preset window is re-resolved against today's UTC day on every render, so
// "last 30 days" stays rolling instead of freezing on the day it was chosen.
// The Alerts tab adds its own two filters and the mapping from an alert's
// evidence.reproduce to the page state that shows its numbers.

import {
  DIMENSION_ACTIONS,
  EMPTY_PAYMENT_HEALTH_FILTERS,
  PAYMENT_HEALTH_FILTER_KEYS,
  PSP_FILTER_KEYS,
  WINDOWED_ACTIONS,
  normalizeAlertsFilters,
  type PaymentAlertsFilters,
  type PaymentHealthAction,
  type PaymentHealthDimension,
  type PaymentHealthFilters,
  type PaymentHealthQuery,
} from "@/services/paymentHealthDataSource";
import {
  MAX_RANGE_DAYS,
  PSP_DIMENSIONS,
  daysInclusive,
  isPaymentHealthAction,
  isPaymentHealthDimension,
  type InitiationFilter,
} from "../../../supabase/functions/_shared/clickhouse/paymentHealthContract";
import { OPEN_ALERT_STATUSES, type AlertSeverity, type AlertStatus } from "../../../supabase/functions/_shared/clickhouse/paymentRiskAlertsContract";
import { shiftDay } from "./format";

export const PAYMENT_HEALTH_UI_STATE_KEY = "ui_state_payment_health";

export type PaymentHealthTab = "overview" | "declines" | "retries" | "refunds" | "alerts" | "sources";
// Alerts sit before Data Sources (plan R's tab order: the alert list, then the sources).
export const PAYMENT_HEALTH_TABS: readonly PaymentHealthTab[] = ["overview", "declines", "retries", "refunds", "alerts", "sources"];

export const TAB_LABELS: Readonly<Record<PaymentHealthTab, string>> = {
  overview: "Overview",
  declines: "Approvals & Declines",
  retries: "Retries & Network Rules",
  refunds: "Refunds & Complaints",
  alerts: "Alerts",
  sources: "Data Sources",
};

export type RangePreset = "7d" | "14d" | "30d" | "90d" | "custom";
export const RANGE_PRESETS: ReadonlyArray<{ key: RangePreset; label: string; days: number | null }> = [
  { key: "7d", label: "Last 7 days", days: 7 },
  { key: "14d", label: "Last 14 days", days: 14 },
  { key: "30d", label: "Last 30 days", days: 30 },
  { key: "90d", label: "Last 90 days", days: 90 },
  { key: "custom", label: "Custom", days: null },
];

/** The sentinel of an unselected filter (every option key is a real value). */
export const ALL = "all";

export interface PaymentHealthUiState {
  tab: PaymentHealthTab;
  rangePreset: RangePreset;
  /** Used only with rangePreset "custom". */
  dateFrom: string;
  dateTo: string;
  processor: string;
  merchantAccount: string;
  descriptor: string;
  funnel: string;
  country: string;
  cardNetwork: string;
  paymentMethod: string;
  initiation: string;
  transactionType: string;
  /** "" = the server default (processor with the PSP key, funnel without). */
  dimension: "" | PaymentHealthDimension;
  /** The Alerts tab's own filters (the window and the filter bar do not apply to alerts). */
  alertStatus: AlertStatusFilter;
  alertSeverity: AlertSeverityFilter;
}

export const DEFAULT_PAYMENT_HEALTH_UI_STATE: PaymentHealthUiState = {
  tab: "overview",
  rangePreset: "30d",
  dateFrom: "",
  dateTo: "",
  processor: ALL,
  merchantAccount: ALL,
  descriptor: ALL,
  funnel: ALL,
  country: ALL,
  cardNetwork: ALL,
  paymentMethod: ALL,
  initiation: ALL,
  transactionType: ALL,
  dimension: "",
  alertStatus: "open",
  alertSeverity: ALL,
};

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The window of the state: a preset ending today (UTC), or the custom days
 * (a half-filled custom window sends only the side that is set; the server
 * defaults the other). */
export function resolveRange(state: Pick<PaymentHealthUiState, "rangePreset" | "dateFrom" | "dateTo">, today: string): { from: string | null; to: string | null } {
  const preset = RANGE_PRESETS.find((entry) => entry.key === state.rangePreset) ?? RANGE_PRESETS[2];
  if (preset.days != null) return { from: shiftDay(today, -(preset.days - 1)), to: today };
  return {
    from: DAY_RE.test(state.dateFrom) ? state.dateFrom : null,
    to: DAY_RE.test(state.dateTo) ? state.dateTo : null,
  };
}

/** Why a custom window cannot be sent as typed (the server would answer 400
 * invalid_request), or null. A half-filled window is fine: the server defaults
 * the missing side. Checked in the browser so the page holds the request and
 * says what to fix, instead of showing an error card for every keystroke. */
export function customRangeProblem(state: Pick<PaymentHealthUiState, "rangePreset" | "dateFrom" | "dateTo">): string | null {
  if (state.rangePreset !== "custom") return null;
  const from = DAY_RE.test(state.dateFrom) ? state.dateFrom : null;
  const to = DAY_RE.test(state.dateTo) ? state.dateTo : null;
  if (!from || !to) return null;
  if (from > to) return `"From" (${from}) is after "To" (${to}).`;
  const days = daysInclusive(from, to);
  if (days > MAX_RANGE_DAYS) return `The window spans ${days} days; the maximum is ${MAX_RANGE_DAYS}.`;
  return null;
}

const one = (value: string): string[] => (value && value !== ALL ? [value] : []);

/** True when the persisted state names a PSP filter or a PSP dimension: the
 * request must then wait for the options action to say whether they may be sent. */
export function hasPspSelection(state: PaymentHealthUiState): boolean {
  return (
    state.processor !== ALL ||
    state.merchantAccount !== ALL ||
    state.descriptor !== ALL ||
    (state.dimension !== "" && PSP_DIMENSIONS.has(state.dimension))
  );
}

export function hasActiveFilters(state: PaymentHealthUiState): boolean {
  return (
    state.rangePreset !== DEFAULT_PAYMENT_HEALTH_UI_STATE.rangePreset ||
    [state.processor, state.merchantAccount, state.descriptor, state.funnel, state.country, state.cardNetwork, state.paymentMethod, state.initiation, state.transactionType].some((value) => value !== ALL)
  );
}

/** The request query of the state. PSP filters and a PSP dimension are dropped
 * when the server did not grant them: a request that names them is refused
 * with 403, and a dropped filter here is what the UI already shows as hidden. */
export function effectiveQuery(state: PaymentHealthUiState, pspVisible: boolean, today: string): PaymentHealthQuery {
  const range = resolveRange(state, today);
  const initiation = one(state.initiation).filter((value): value is InitiationFilter => value === "cit" || value === "mit" || value === "unknown");
  const filters: PaymentHealthFilters = {
    ...EMPTY_PAYMENT_HEALTH_FILTERS,
    processor: pspVisible ? one(state.processor) : [],
    merchant_account: pspVisible ? one(state.merchantAccount) : [],
    descriptor: pspVisible ? one(state.descriptor) : [],
    funnel: one(state.funnel),
    country: one(state.country),
    card_network: one(state.cardNetwork),
    payment_method: one(state.paymentMethod),
    initiation,
    transaction_type: one(state.transactionType),
  };
  const dimension = isPaymentHealthDimension(state.dimension) && (pspVisible || !PSP_DIMENSIONS.has(state.dimension)) ? state.dimension : null;
  return { dateFrom: range.from, dateTo: range.to, filters, dimension };
}

/** A persisted tab value that is still a tab (older builds may have stored another id). */
export function coerceTab(value: unknown): PaymentHealthTab {
  return PAYMENT_HEALTH_TABS.includes(value as PaymentHealthTab) ? (value as PaymentHealthTab) : "overview";
}

// ---- Alerts tab (P2.5) --------------------------------------------------------

/** "open" = new + investigating (the default view and the tab badge's query). */
export type AlertStatusFilter = "open" | typeof ALL | AlertStatus;
export type AlertSeverityFilter = typeof ALL | AlertSeverity;

export const ALERT_STATUS_FILTERS: ReadonlyArray<{ key: AlertStatusFilter; label: string }> = [
  { key: "open", label: "Open (new + investigating)" },
  { key: ALL, label: "All statuses" },
  { key: "new", label: "New" },
  { key: "investigating", label: "Investigating" },
  { key: "resolved", label: "Resolved" },
  { key: "dismissed", label: "Dismissed" },
];

export const ALERT_SEVERITY_FILTERS: ReadonlyArray<{ key: AlertSeverityFilter; label: string }> = [
  { key: ALL, label: "All severities" },
  { key: "critical", label: "Critical" },
  { key: "warning", label: "Warning" },
  { key: "info", label: "Info" },
];

/** A persisted value from an older build (or a hand edit) falls back to the default. */
export function coerceAlertStatusFilter(value: unknown): AlertStatusFilter {
  return ALERT_STATUS_FILTERS.some((entry) => entry.key === value) ? (value as AlertStatusFilter) : "open";
}

export function coerceAlertSeverityFilter(value: unknown): AlertSeverityFilter {
  return ALERT_SEVERITY_FILTERS.some((entry) => entry.key === value) ? (value as AlertSeverityFilter) : ALL;
}

/** The alerts_list filters of the state (canonical, so the default equals OPEN_ALERTS_FILTERS: one cache entry for the tab and its badge). */
export function alertsFilters(state: Partial<Pick<PaymentHealthUiState, "alertStatus" | "alertSeverity">>): PaymentAlertsFilters {
  const status = coerceAlertStatusFilter(state.alertStatus);
  const severity = coerceAlertSeverityFilter(state.alertSeverity);
  return normalizeAlertsFilters({
    status: status === "open" ? [...OPEN_ALERT_STATUSES] : status === ALL ? [] : [status],
    severity: severity === ALL ? [] : [severity],
  });
}

/** evidence.reproduce of an alert, validated: the page request whose answer shows the alert's numbers. */
export interface AlertReproduce {
  action: PaymentHealthAction;
  dateFrom: string | null;
  dateTo: string | null;
  filters: Partial<Record<keyof PaymentHealthFilters, string[]>>;
  dimension: PaymentHealthDimension | null;
}

/** The tab that answers each action (options has none). */
export const ACTION_TABS: Readonly<Record<PaymentHealthAction, PaymentHealthTab | null>> = {
  overview: "overview",
  declines: "declines",
  retries: "retries",
  refunds_support: "refunds",
  sources: "sources",
  options: null,
};

const FILTER_STATE_FIELDS: Readonly<Record<keyof PaymentHealthFilters, keyof PaymentHealthUiState>> = {
  processor: "processor",
  merchant_account: "merchantAccount",
  descriptor: "descriptor",
  funnel: "funnel",
  country: "country",
  card_network: "cardNetwork",
  payment_method: "paymentMethod",
  initiation: "initiation",
  transaction_type: "transactionType",
};

/** Reads evidence.reproduce defensively (it is stored JSON): null when it does not name a page request this build can open. */
export function parseAlertReproduce(value: unknown): AlertReproduce | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!isPaymentHealthAction(raw.action) || ACTION_TABS[raw.action] == null) return null;
  const day = (input: unknown) => (typeof input === "string" && DAY_RE.test(input) ? input : null);
  const filters: AlertReproduce["filters"] = {};
  const rawFilters = raw.filters && typeof raw.filters === "object" && !Array.isArray(raw.filters) ? (raw.filters as Record<string, unknown>) : {};
  for (const key of PAYMENT_HEALTH_FILTER_KEYS) {
    const list = rawFilters[key];
    if (!Array.isArray(list)) continue;
    const values = list.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
    if (values.length) filters[key] = values;
  }
  return {
    action: raw.action,
    dateFrom: day(raw.date_from),
    dateTo: day(raw.date_to),
    filters,
    dimension: isPaymentHealthDimension(raw.dimension) ? raw.dimension : null,
  };
}

/**
 * The page-state patch that reproduces an alert: its tab, its window as a
 * custom range, exactly its filters (every other filter cleared, so the
 * numbers match) and, where the tab breaks down by one, its dimension. null
 * when this page cannot show it: a request that needs a PSP filter or
 * dimension the caller may not send (it would be a 403), or more than one
 * value for a filter (the bar is single-select).
 */
export function reproduceState(reproduce: AlertReproduce, pspVisible: boolean): Partial<PaymentHealthUiState> | null {
  const tab = ACTION_TABS[reproduce.action];
  if (!tab) return null;
  // Sources is tenant-wide: the window and the filters stay as they are.
  if (!WINDOWED_ACTIONS.has(reproduce.action)) return { tab };
  const needsPsp = PSP_FILTER_KEYS.some((key) => (reproduce.filters[key]?.length ?? 0) > 0) || (reproduce.dimension != null && PSP_DIMENSIONS.has(reproduce.dimension));
  if (needsPsp && !pspVisible) return null;
  if (Object.values(reproduce.filters).some((values) => (values?.length ?? 0) > 1)) return null;
  const patch: Partial<PaymentHealthUiState> = { tab };
  const fields = patch as Record<string, unknown>;
  for (const key of PAYMENT_HEALTH_FILTER_KEYS) fields[FILTER_STATE_FIELDS[key]] = reproduce.filters[key]?.[0] ?? ALL;
  if (reproduce.dateFrom && reproduce.dateTo) {
    patch.rangePreset = "custom";
    patch.dateFrom = reproduce.dateFrom;
    patch.dateTo = reproduce.dateTo;
  }
  if (DIMENSION_ACTIONS.has(reproduce.action)) patch.dimension = reproduce.dimension ?? "";
  return patch;
}
