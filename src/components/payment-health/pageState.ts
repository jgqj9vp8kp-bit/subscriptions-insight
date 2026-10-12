// Payment System Health page state: what usePersistedPageState keeps for the
// person ("ui_state_payment_health"), and the pure mapping from that state to
// the request query. Pure module so the tests can pin the two rules that
// matter for access: a persisted PSP selection is dropped from the request
// (never sent) when the server says the PSP dimensions are not visible, and a
// preset window is re-resolved against today's UTC day on every render, so
// "last 30 days" stays rolling instead of freezing on the day it was chosen.

import {
  EMPTY_PAYMENT_HEALTH_FILTERS,
  type PaymentHealthDimension,
  type PaymentHealthFilters,
  type PaymentHealthQuery,
} from "@/services/paymentHealthDataSource";
import { MAX_RANGE_DAYS, PSP_DIMENSIONS, daysInclusive, isPaymentHealthDimension, type InitiationFilter } from "../../../supabase/functions/_shared/clickhouse/paymentHealthContract";
import { shiftDay } from "./format";

export const PAYMENT_HEALTH_UI_STATE_KEY = "ui_state_payment_health";

export type PaymentHealthTab = "overview" | "declines" | "retries" | "refunds" | "sources";
export const PAYMENT_HEALTH_TABS: readonly PaymentHealthTab[] = ["overview", "declines", "retries", "refunds", "sources"];

export const TAB_LABELS: Readonly<Record<PaymentHealthTab, string>> = {
  overview: "Overview",
  declines: "Approvals & Declines",
  retries: "Retries & Network Rules",
  refunds: "Refunds & Complaints",
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
