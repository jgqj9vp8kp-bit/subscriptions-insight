import { computeCohorts } from "@/services/analytics";
import { filterCohortsWithDiagnostics, type CohortFilters } from "@/services/cohortFiltering";
import { countryUserCountsForTransactions, type CountryUserCount } from "@/services/userCountry";
import type { SubscriptionClean } from "@/types/subscriptions";
import type { CardType, MediaBuyer, Transaction } from "@/services/types";

export interface CohortGeoOptionInput {
  txs: Transaction[];
  subscriptions?: SubscriptionClean[];
  filters?: CohortFilters;
  selectedCardTypes?: readonly CardType[];
  selectedMediaBuyers?: readonly MediaBuyer[];
  maxRenewalDepth?: number;
}

export function buildCohortGeoOptions({
  txs,
  subscriptions = [],
  filters = {},
  selectedCardTypes = [],
  selectedMediaBuyers = [],
  maxRenewalDepth,
}: CohortGeoOptionInput): CountryUserCount[] {
  const countries = countryUserCountsForTransactions(txs).map((row) => row.country_code);

  return countries
    .map((country) => {
      const countryCohorts = computeCohorts(txs, subscriptions, {
        maxRenewalDepth,
        selectedCountries: [country],
        selectedCardTypes: [...selectedCardTypes],
        selectedMediaBuyers: [...selectedMediaBuyers],
      });
      const visibleCountryCohorts = filterCohortsWithDiagnostics(countryCohorts, filters).cohorts;
      const userCount = visibleCountryCohorts.reduce((total, cohort) => total + cohort.trial_users, 0);
      return {
        country_code: country,
        user_count: userCount,
      };
    })
    .filter((row) => row.user_count > 0)
    .sort((a, b) => a.country_code.localeCompare(b.country_code));
}
