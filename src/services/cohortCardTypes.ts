import { computeCohorts } from "@/services/analytics";
import { filterCohortsWithDiagnostics, type CohortFilters } from "@/services/cohortFiltering";
import { CARD_TYPE_VALUES } from "@/services/userCardType";
import type { SubscriptionClean } from "@/types/subscriptions";
import type { CardType, MediaBuyer, Transaction } from "@/services/types";

export interface CohortCardTypeOption {
  card_type: CardType;
  trial_count: number;
}

export interface CohortCardTypeOptionInput {
  txs: Transaction[];
  subscriptions?: SubscriptionClean[];
  filters?: CohortFilters;
  selectedCountries?: readonly string[];
  selectedMediaBuyers?: readonly MediaBuyer[];
  maxRenewalDepth?: number;
}

export function buildCohortCardTypeOptions({
  txs,
  subscriptions = [],
  filters = {},
  selectedCountries = [],
  selectedMediaBuyers = [],
  maxRenewalDepth,
}: CohortCardTypeOptionInput): CohortCardTypeOption[] {
  return CARD_TYPE_VALUES
    .map((cardType) => {
      const cohorts = filterCohortsWithDiagnostics(
        computeCohorts(txs, subscriptions, {
          maxRenewalDepth,
          selectedCountries: [...selectedCountries],
          selectedCardTypes: [cardType],
          selectedMediaBuyers: [...selectedMediaBuyers],
        }),
        filters,
      ).cohorts;
      return {
        card_type: cardType,
        trial_count: cohorts.reduce((total, cohort) => total + cohort.trial_users, 0),
      };
    })
    .filter((option) => option.trial_count > 0);
}
