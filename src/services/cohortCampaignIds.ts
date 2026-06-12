import { computeCohorts } from "@/services/analytics";
import { buildCohortId } from "@/services/cohortIdentity";
import {
  campaignIdForTransaction,
  campaignIdLabel,
  campaignNameForTransaction,
  filterCohortsWithDiagnostics,
  filterTransactionsByTrialAttribution,
  type CohortFilters,
} from "@/services/cohortFiltering";
import { CARD_TYPE_VALUES, cardTypeForUserTransactions } from "@/services/userCardType";
import { countryCodeForUserTransactions, normalizeCountryCode } from "@/services/userCountry";
import { MEDIA_BUYER_VALUES, mediaBuyerForUserTransactions } from "@/services/userMediaBuyer";
import type { SubscriptionClean } from "@/types/subscriptions";
import type { CardType, MediaBuyer, Transaction } from "@/services/types";

export interface CampaignIdOption {
  campaign_id: string;
  campaign_name: string | null;
  trial_count: number;
}

export interface CampaignIdOptionInput {
  txs: Transaction[];
  subscriptions?: SubscriptionClean[];
  filters?: CohortFilters;
  trafficSourceFilter?: string;
  selectedCountries?: readonly string[];
  selectedCardTypes?: readonly CardType[];
  selectedMediaBuyers?: readonly MediaBuyer[];
  maxRenewalDepth?: number;
}

function normalizeCountryFilter(countries: readonly string[] = []): Set<string> {
  return new Set(countries.flatMap((country) => {
    const normalized = normalizeCountryCode(country);
    return normalized ? [normalized] : [];
  }));
}

function normalizeCardTypeFilter(cardTypes: readonly CardType[] = []): Set<CardType> {
  return new Set(cardTypes.filter((value): value is CardType => CARD_TYPE_VALUES.includes(value)));
}

function normalizeMediaBuyerFilter(mediaBuyers: readonly MediaBuyer[] = []): Set<MediaBuyer> {
  return new Set(mediaBuyers.filter((value): value is MediaBuyer => MEDIA_BUYER_VALUES.includes(value)));
}

function userMatchesFilters(
  list: Transaction[],
  countries: Set<string>,
  cardTypes: Set<CardType>,
  mediaBuyers: Set<MediaBuyer>,
): boolean {
  if (countries.size > 0) {
    const country = countryCodeForUserTransactions(list);
    if (!country || !countries.has(country)) return false;
  }
  if (cardTypes.size > 0 && !cardTypes.has(cardTypeForUserTransactions(list))) return false;
  if (mediaBuyers.size > 0 && !mediaBuyers.has(mediaBuyerForUserTransactions(list).media_buyer)) return false;
  return true;
}

function firstSuccessfulTrialByUser(txs: Transaction[]): Map<string, Transaction> {
  const trials = txs
    .filter((tx) => tx.status === "success" && tx.transaction_type === "trial")
    .sort((a, b) => (a.event_time < b.event_time ? -1 : a.event_time > b.event_time ? 1 : 0));
  const result = new Map<string, Transaction>();
  for (const trial of trials) {
    if (!result.has(trial.user_id)) result.set(trial.user_id, trial);
  }
  return result;
}

function transactionsByUser(txs: Transaction[]): Map<string, Transaction[]> {
  const result = new Map<string, Transaction[]>();
  for (const tx of txs) {
    const list = result.get(tx.user_id) ?? [];
    list.push(tx);
    result.set(tx.user_id, list);
  }
  return result;
}

function campaignNameForUser(trial: Transaction, list: Transaction[]): string | null {
  return campaignNameForTransaction(trial) ?? list.map(campaignNameForTransaction).find(Boolean) ?? null;
}

export function formatCampaignIdOptionLabel(option: Pick<CampaignIdOption, "campaign_id" | "campaign_name" | "trial_count">): string {
  const base = option.campaign_name
    ? `${option.campaign_name} (${campaignIdLabel(option.campaign_id)})`
    : campaignIdLabel(option.campaign_id);
  return `${base} — ${option.trial_count} trials`;
}

export function buildCampaignIdOptions({
  txs,
  subscriptions = [],
  filters = {},
  trafficSourceFilter = "all",
  selectedCountries = [],
  selectedCardTypes = [],
  selectedMediaBuyers = [],
  maxRenewalDepth,
}: CampaignIdOptionInput): CampaignIdOption[] {
  const attributionTxs = filterTransactionsByTrialAttribution(txs, { trafficSourceFilter }) as Transaction[];
  const contextCohorts = filterCohortsWithDiagnostics(
    computeCohorts(attributionTxs, subscriptions, {
      maxRenewalDepth,
      selectedCountries: [...selectedCountries],
      selectedCardTypes: [...selectedCardTypes],
      selectedMediaBuyers: [...selectedMediaBuyers],
    }),
    filters,
  ).cohorts;
  const contextCohortIds = new Set(contextCohorts.map((cohort) => cohort.cohort_id));
  if (!contextCohortIds.size) return [];

  const countries = normalizeCountryFilter(selectedCountries);
  const cardTypes = normalizeCardTypeFilter(selectedCardTypes);
  const mediaBuyers = normalizeMediaBuyerFilter(selectedMediaBuyers);
  const byUser = transactionsByUser(attributionTxs);
  const trialByUser = firstSuccessfulTrialByUser(attributionTxs);
  const counts = new Map<string, { trial_count: number; campaign_name: string | null }>();

  trialByUser.forEach((trial, userId) => {
    const list = byUser.get(userId) ?? [];
    if (!userMatchesFilters(list, countries, cardTypes, mediaBuyers)) return;

    const cohortDate = trial.cohort_date ?? trial.event_time.slice(0, 10);
    const campaignPath = trial.campaign_path || "unknown";
    const cohortId = buildCohortId(trial.funnel, campaignPath, cohortDate);
    if (!contextCohortIds.has(cohortId)) return;

    const campaignId = campaignIdForTransaction(trial);
    const current = counts.get(campaignId) ?? { trial_count: 0, campaign_name: null };
    current.trial_count += 1;
    current.campaign_name = current.campaign_name ?? campaignNameForUser(trial, list);
    counts.set(campaignId, current);
  });

  return Array.from(counts.entries())
    .map(([campaign_id, value]) => ({
      campaign_id,
      campaign_name: value.campaign_name,
      trial_count: value.trial_count,
    }))
    .filter((option) => option.trial_count > 0)
    .sort((a, b) => b.trial_count - a.trial_count || campaignIdLabel(a.campaign_id).localeCompare(campaignIdLabel(b.campaign_id)));
}
