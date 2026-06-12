import { computeCohorts } from "@/services/analytics";
import { buildCohortId } from "@/services/cohortIdentity";
import {
  filterCohortsWithDiagnostics,
  filterTransactionsByTrialAttribution,
  type CohortFilters,
} from "@/services/cohortFiltering";
import { CARD_TYPE_VALUES, cardTypeForUserTransactions } from "@/services/userCardType";
import { countryCodeForUserTransactions, normalizeCountryCode } from "@/services/userCountry";
import { MEDIA_BUYER_VALUES, mediaBuyerForUserTransactions } from "@/services/userMediaBuyer";
import type { SubscriptionClean } from "@/types/subscriptions";
import type { CardType, MediaBuyer, Transaction } from "@/services/types";

export interface MediaBuyerOption {
  media_buyer: MediaBuyer;
  trial_count: number;
}

export interface MediaBuyerOptionInput {
  txs: Transaction[];
  subscriptions?: SubscriptionClean[];
  filters?: CohortFilters;
  trafficSourceFilter?: string;
  selectedCampaignIds?: readonly string[];
  selectedCountries?: readonly string[];
  selectedCardTypes?: readonly CardType[];
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

function transactionsByUser(txs: Transaction[]): Map<string, Transaction[]> {
  const result = new Map<string, Transaction[]>();
  for (const tx of txs) {
    const list = result.get(tx.user_id) ?? [];
    list.push(tx);
    result.set(tx.user_id, list);
  }
  return result;
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

function userMatchesFilters(list: Transaction[], countries: Set<string>, cardTypes: Set<CardType>): boolean {
  if (countries.size > 0) {
    const country = countryCodeForUserTransactions(list);
    if (!country || !countries.has(country)) return false;
  }
  if (cardTypes.size > 0 && !cardTypes.has(cardTypeForUserTransactions(list))) return false;
  return true;
}

export function formatMediaBuyerOptionLabel(option: MediaBuyerOption): string {
  return `${option.media_buyer} — ${option.trial_count} trials`;
}

export function buildMediaBuyerOptions({
  txs,
  subscriptions = [],
  filters = {},
  trafficSourceFilter = "all",
  selectedCampaignIds = [],
  selectedCountries = [],
  selectedCardTypes = [],
  maxRenewalDepth,
}: MediaBuyerOptionInput): MediaBuyerOption[] {
  const attributionTxs = filterTransactionsByTrialAttribution(txs, { trafficSourceFilter, selectedCampaignIds }) as Transaction[];
  const contextCohorts = filterCohortsWithDiagnostics(
    computeCohorts(attributionTxs, subscriptions, {
      maxRenewalDepth,
      selectedCountries: [...selectedCountries],
      selectedCardTypes: [...selectedCardTypes],
    }),
    filters,
  ).cohorts;
  const contextCohortIds = new Set(contextCohorts.map((cohort) => cohort.cohort_id));
  if (!contextCohortIds.size) return [];

  const countries = normalizeCountryFilter(selectedCountries);
  const cardTypes = normalizeCardTypeFilter(selectedCardTypes);
  const byUser = transactionsByUser(attributionTxs);
  const trialByUser = firstSuccessfulTrialByUser(attributionTxs);
  const counts = new Map<MediaBuyer, number>();

  trialByUser.forEach((trial, userId) => {
    const list = byUser.get(userId) ?? [];
    if (!userMatchesFilters(list, countries, cardTypes)) return;

    const cohortDate = trial.cohort_date ?? trial.event_time.slice(0, 10);
    const campaignPath = trial.campaign_path || "unknown";
    const cohortId = buildCohortId(trial.funnel, campaignPath, cohortDate);
    if (!contextCohortIds.has(cohortId)) return;

    const mediaBuyer = mediaBuyerForUserTransactions(list).media_buyer;
    counts.set(mediaBuyer, (counts.get(mediaBuyer) ?? 0) + 1);
  });

  return MEDIA_BUYER_VALUES
    .map((media_buyer) => ({
      media_buyer,
      trial_count: counts.get(media_buyer) ?? 0,
    }))
    .filter((option) => option.trial_count > 0);
}
