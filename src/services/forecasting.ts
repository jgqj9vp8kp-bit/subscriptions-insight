import type { Transaction } from "@/services/types";

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

function cohortIdForTrial(trial: Transaction): string {
  const date = trial.cohort_date ?? trial.event_time.slice(0, 10);
  const path = trial.campaign_path || "unknown";
  return trial.cohort_id ?? `${path}_${date}`;
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
