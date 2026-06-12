import type { CohortRow, Transaction } from "@/services/types";
import { buildCohortId } from "@/services/cohortIdentity";

export type PriceSelection = "weighted_average" | "custom" | "default" | `price:${number}`;
export type PriceSourceLabel = "Auto selected" | "Selected price" | "Weighted average" | "Manual custom" | "Default";

export interface ForecastPriceOption {
  price: number;
  users: number;
  transactions?: number;
  percentage: number;
}

export interface ForecastPriceOptions {
  trialOptions: ForecastPriceOption[];
  subscriptionOptions: ForecastPriceOption[];
  upsellOptions: ForecastPriceOption[];
  selectedUserCount: number;
  firstSubscriptionUserCount: number;
  upsellUserCount: number;
  upsellTransactionCount: number;
}

const round2 = (value: number) => Math.round(value * 100) / 100;

export type ForecastCacSource = "actual" | "manual" | "missing";

export function actualCacFromSpend(spend: number | null | undefined, trialUsers: number): number | null {
  if (spend == null || !Number.isFinite(spend) || !Number.isFinite(trialUsers) || trialUsers <= 0) return null;
  const value = spend / trialUsers;
  return Number.isFinite(value) ? value : null;
}

export function resolveForecastCac(params: {
  actualSpend: number | null | undefined;
  trialUsers: number;
  manualCac: unknown;
  manualOverride: boolean;
}): { actualCac: number | null; cac: number | null; source: ForecastCacSource } {
  const actualCac = actualCacFromSpend(params.actualSpend, params.trialUsers);
  if (params.manualOverride) {
    const manual = Number(String(params.manualCac ?? "").trim().replace(",", "."));
    if (Number.isFinite(manual) && manual >= 0) return { actualCac, cac: manual, source: "manual" };
  }
  if (actualCac == null) return { actualCac, cac: null, source: "missing" };
  return { actualCac, cac: actualCac, source: "actual" };
}

export function projectedSpendFromCac(trialUsers: number, cac: number | null | undefined): number | null {
  if (cac == null || !Number.isFinite(cac) || !Number.isFinite(trialUsers) || trialUsers < 0) return null;
  return trialUsers * cac;
}

export function forecastProfit(netRevenue: number, projectedSpend: number | null | undefined): number {
  return netRevenue - (projectedSpend ?? 0);
}

export function forecastRoas(netRevenue: number, projectedSpend: number | null | undefined): number | null {
  return projectedSpend && projectedSpend > 0 ? netRevenue / projectedSpend : null;
}

function grossAmount(tx: Transaction): number {
  return Number.isFinite(tx.gross_amount_usd) ? tx.gross_amount_usd : tx.amount_usd;
}

// Shared cohort-id derivation for a trial transaction. MUST stay identical to the key
// computeCohorts (analytics.ts) and palmerTransform build, otherwise selected cohorts will
// never match the underlying transactions. Always re-derives via buildCohortId(funnel, path,
// date) — including the funnel segment — rather than trusting a possibly-absent trial.cohort_id
// (P0-1: the page previously used `${path}_${date}` with no funnel and silently never matched).
export function cohortIdForTrial(trial: Transaction): string {
  const date = trial.cohort_date ?? trial.event_time.slice(0, 10);
  const path = trial.campaign_path || "unknown";
  return buildCohortId(trial.funnel, path, date);
}

function firstTrialByUser(txs: Transaction[]): Map<string, Transaction> {
  const map = new Map<string, Transaction>();
  const trials = txs
    .filter((tx) => tx.status === "success" && tx.transaction_type === "trial")
    .sort((a, b) => (a.event_time < b.event_time ? -1 : 1));
  for (const trial of trials) {
    if (!map.has(trial.user_id)) map.set(trial.user_id, trial);
  }
  return map;
}

function groupPriceOptions(prices: number[], denominator: number): ForecastPriceOption[] {
  const counts = new Map<number, number>();
  for (const rawPrice of prices) {
    const price = round2(rawPrice);
    if (price <= 0) continue;
    counts.set(price, (counts.get(price) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .sort(([a], [b]) => a - b)
    .map(([price, users]) => ({
      price,
      users,
      percentage: denominator ? (users / denominator) * 100 : 0,
    }));
}

function groupUpsellValueOptions(
  rows: Array<{ price: number; userId: string }>,
  denominatorUsers: number,
): ForecastPriceOption[] {
  const counts = new Map<number, { transactions: number; users: Set<string> }>();
  for (const row of rows) {
    const price = round2(row.price);
    if (price <= 0) continue;
    const current = counts.get(price) ?? { transactions: 0, users: new Set<string>() };
    current.transactions += 1;
    current.users.add(row.userId);
    counts.set(price, current);
  }
  return Array.from(counts.entries())
    .sort(([a], [b]) => a - b)
    .map(([price, value]) => ({
      price,
      users: value.users.size,
      transactions: value.transactions,
      percentage: denominatorUsers ? (value.users.size / denominatorUsers) * 100 : 0,
    }));
}

export function weightedAveragePrice(
  options: ForecastPriceOption[],
  weightBy: "users" | "transactions" = "users",
): number {
  const weightFor = (option: ForecastPriceOption) =>
    weightBy === "transactions" ? option.transactions ?? option.users : option.users;
  const weight = options.reduce((total, option) => total + weightFor(option), 0);
  if (!weight) return 0;
  return round2(options.reduce((total, option) => total + option.price * weightFor(option), 0) / weight);
}

export function buildForecastPriceOptions(txs: Transaction[], selectedCohortIds: Set<string>): ForecastPriceOptions {
  const trials = firstTrialByUser(txs);
  const txsByUser = new Map<string, Transaction[]>();
  for (const tx of txs) {
    const list = txsByUser.get(tx.user_id) ?? [];
    list.push(tx);
    txsByUser.set(tx.user_id, list);
  }

  const selectedUsers = new Set<string>();
  trials.forEach((trial, userId) => {
    if (selectedCohortIds.has(cohortIdForTrial(trial))) selectedUsers.add(userId);
  });

  const trialPrices: number[] = [];
  const subscriptionPrices: number[] = [];
  const upsellRows: Array<{ price: number; userId: string }> = [];
  const upsellUsers = new Set<string>();

  for (const userId of selectedUsers) {
    const sorted = [...(txsByUser.get(userId) ?? [])].sort((a, b) => (a.event_time < b.event_time ? -1 : 1));
    const initial = sorted.find((tx) => tx.status === "success" && tx.transaction_type !== "upsell");
    if (initial) trialPrices.push(grossAmount(initial));

    const firstSubscription = sorted.find((tx) => tx.status === "success" && tx.transaction_type === "first_subscription");
    if (firstSubscription) subscriptionPrices.push(grossAmount(firstSubscription));

    const upsells = sorted.filter((tx) => tx.status === "success" && tx.transaction_type === "upsell");
    for (const upsell of upsells) {
      upsellRows.push({ price: grossAmount(upsell), userId });
      upsellUsers.add(userId);
    }
  }

  return {
    trialOptions: groupPriceOptions(trialPrices, selectedUsers.size),
    subscriptionOptions: groupPriceOptions(subscriptionPrices, subscriptionPrices.length),
    upsellOptions: groupUpsellValueOptions(upsellRows, upsellUsers.size),
    selectedUserCount: selectedUsers.size,
    firstSubscriptionUserCount: subscriptionPrices.length,
    upsellUserCount: upsellUsers.size,
    upsellTransactionCount: upsellRows.length,
  };
}

export function defaultPriceSelection(options: ForecastPriceOption[]): PriceSelection {
  if (options.length === 0) return "default";
  if (options.length === 1) return `price:${options[0].price}`;
  return "weighted_average";
}

export function resolveSelectedPrice(
  options: ForecastPriceOption[],
  selection: PriceSelection,
  customValue: number,
  fallbackPrice: number,
  weightBy: "users" | "transactions" = "users",
): number {
  if (selection === "custom") return customValue;
  if (selection === "weighted_average") return weightedAveragePrice(options, weightBy);
  if (selection === "default") return fallbackPrice;
  const price = Number(selection.slice("price:".length));
  return Number.isFinite(price) ? price : fallbackPrice;
}

export function priceSourceLabel(selection: PriceSelection, options: ForecastPriceOption[]): PriceSourceLabel {
  if (selection === "custom") return "Manual custom";
  if (selection === "weighted_average") return "Weighted average";
  if (selection === "default") return "Default";
  return options.length === 1 ? "Auto selected" : "Selected price";
}

export function reconcilePriceSelection(
  previousCohortKey: string,
  nextCohortKey: string,
  currentSelection: PriceSelection,
  options: ForecastPriceOption[],
): PriceSelection {
  if (previousCohortKey === nextCohortKey) return currentSelection;
  return defaultPriceSelection(options);
}

// ---------------------------------------------------------------------------
// Retention (actual vs fallback) — P0-1
// Centralized here so the Forecasting page reuses the SAME cohortIdForTrial as
// the price-option path, and so the actual-vs-fallback logic is unit-testable.
// ---------------------------------------------------------------------------

const RETENTION_MONTHS = Array.from({ length: 12 }, (_, index) => index + 1);
const RETENTION_DAY_MS = 24 * 60 * 60 * 1000;

function isSubscriptionRetentionType(tx: Transaction): boolean {
  return ["first_subscription", "renewal_2", "renewal_3", "renewal"].includes(tx.transaction_type);
}

function retentionCountsForCohortIds(
  txs: Transaction[],
  selectedCohortIds: Set<string>,
): { trialUsers: Set<string>; monthUsers: Map<number, Set<string>> } {
  const firstTrials = firstTrialByUser(txs);
  const trialUsers = new Set<string>();
  const monthUsers = new Map<number, Set<string>>();

  firstTrials.forEach((trial, userId) => {
    if (selectedCohortIds.has(cohortIdForTrial(trial))) trialUsers.add(userId);
  });

  for (const tx of txs) {
    if (tx.status !== "success" || !isSubscriptionRetentionType(tx)) continue;
    if (!trialUsers.has(tx.user_id)) continue;
    const trial = firstTrials.get(tx.user_id);
    if (!trial) continue;
    const diff = new Date(tx.event_time).getTime() - new Date(trial.event_time).getTime();
    if (diff < 0) continue;
    const month = Math.floor(diff / (30 * RETENTION_DAY_MS)) + 1;
    if (month < 1 || month > 12) continue;
    const set = monthUsers.get(month) ?? new Set<string>();
    set.add(tx.user_id);
    monthUsers.set(month, set);
  }

  return { trialUsers, monthUsers };
}

// One entry per forecast month (1..12):
//   null    => the cohort set has NO trial users => no actual data => caller should fall back.
//   0..100  => the cohort set HAS trial users. A genuine 0% month stays 0 and MUST NOT be
//              replaced by the fallback curve (P0-1 / audit CALC-7).
export function retentionPercentagesForCohorts(
  txs: Transaction[],
  cohortIds: string[],
): Array<number | null> {
  const selected = new Set(cohortIds);
  const { trialUsers, monthUsers } = retentionCountsForCohortIds(txs, selected);
  if (trialUsers.size === 0) return RETENTION_MONTHS.map(() => null);
  return RETENTION_MONTHS.map((month) => {
    const users = monthUsers.get(month)?.size ?? 0;
    return (users / trialUsers.size) * 100;
  });
}

// Fallback cascade for a month with no actual data on the selected cohorts:
// same-campaign-path cohorts -> all other cohorts -> static default curve.
// Because retentionPercentagesForCohorts now returns 0 (not null) when a cohort set has trial
// users, the default curve is only reached when NO cohort with trial data exists for that path
// or globally — i.e. "fallback only when no cohort trial data exists".
export function fallbackRetentionForMonth(
  monthIndex: number,
  txs: Transaction[],
  allCohorts: CohortRow[],
  selectedIds: Set<string>,
  selectedCampaignPaths: Set<string>,
  defaultRetentionCurve: number[],
): number {
  const samePathIds = allCohorts
    .filter((cohort) => !selectedIds.has(cohort.cohort_id) && selectedCampaignPaths.has(cohort.campaign_path))
    .map((cohort) => cohort.cohort_id);
  const samePathRetention = retentionPercentagesForCohorts(txs, samePathIds)[monthIndex];
  if (samePathRetention != null) return samePathRetention;

  const globalIds = allCohorts
    .filter((cohort) => !selectedIds.has(cohort.cohort_id))
    .map((cohort) => cohort.cohort_id);
  const globalRetention = retentionPercentagesForCohorts(txs, globalIds)[monthIndex];
  if (globalRetention != null) return globalRetention;

  return defaultRetentionCurve[monthIndex];
}
