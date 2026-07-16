// Invalid-selection handling for the Cohorts cascading filters.
//
// Changing an upstream filter can strand a downstream selection: Country=CA, then
// Campaign Path switches to a path that has no CA users. The server computes each
// option list with all active filters EXCEPT that list's own dimension, so a
// selected value that is ABSENT from its own list provably has zero cohort users
// under the other active filters — it is impossible, not merely unselected.
//
// Rules (see pruneInvalidCohortSelections):
//  - clear ONLY the invalid selections; never touch unrelated filters;
//  - only ever REMOVE values, so repeated application strictly shrinks the
//    selection set and reaches a fixed point — no reset/refetch loop;
//  - skip a dimension whose option list is EMPTY: empty means "nothing known for
//    this scope", not "every selection is invalid" — so an empty response can
//    never wipe the user's filters.
//
// The caller must only feed this option lists fetched for the CURRENT filter scope
// (never React Query's keepPreviousData), or a stale broader list would look
// authoritative and a just-narrowed selection could be cleared.

import type { CohortFilterOptionsView } from "@/services/cohortsDataSource";
import type { CardType, MediaBuyer } from "@/services/types";

export interface CohortFilterSelection {
  funnelFilter: string;
  campaignPathFilter: string;
  trafficSourceFilter: string;
  currencyFilter: string;
  selectedCountries: string[];
  selectedCardTypes: CardType[];
  selectedMediaBuyers: MediaBuyer[];
  selectedCampaignIds: string[];
}

export interface CohortFilterSelectionPatch {
  funnelFilter?: string;
  campaignPathFilter?: string;
  trafficSourceFilter?: string;
  currencyFilter?: string;
  selectedCountries?: string[];
  selectedCardTypes?: CardType[];
  selectedMediaBuyers?: MediaBuyer[];
  selectedCampaignIds?: string[];
  /** Legacy single-select mirror, reset whenever the multi-select is pruned. */
  campaignIdFilter?: string;
}

const ALL = "all";

function pruneSingle(value: string, options: string[]): string | null {
  if (!value || value === ALL) return null;
  if (!options.length || options.includes(value)) return null;
  return ALL;
}

function pruneMulti<T extends string>(selected: T[], valid: Set<string>): T[] | null {
  if (!selected.length || valid.size === 0) return null;
  const next = selected.filter((value) => valid.has(value));
  return next.length === selected.length ? null : next;
}

/**
 * The patch that removes every now-impossible selection, or null when the current
 * selection is fully valid for `options` (the fixed point).
 */
export function pruneInvalidCohortSelections(
  selection: CohortFilterSelection,
  options: CohortFilterOptionsView | undefined,
): CohortFilterSelectionPatch | null {
  if (!options) return null;
  const patch: CohortFilterSelectionPatch = {};

  const funnel = pruneSingle(selection.funnelFilter, options.funnel);
  if (funnel !== null) patch.funnelFilter = funnel;
  const campaignPath = pruneSingle(selection.campaignPathFilter, options.campaign_path);
  if (campaignPath !== null) patch.campaignPathFilter = campaignPath;
  const trafficSource = pruneSingle(selection.trafficSourceFilter, options.traffic_source);
  if (trafficSource !== null) patch.trafficSourceFilter = trafficSource;
  const currency = pruneSingle(selection.currencyFilter, options.currency);
  if (currency !== null) patch.currencyFilter = currency;

  const countries = pruneMulti(selection.selectedCountries, new Set(options.country.map((o) => o.country_code)));
  if (countries) patch.selectedCountries = countries;
  const cardTypes = pruneMulti(selection.selectedCardTypes, new Set(options.card_type.map((o) => o.card_type)));
  if (cardTypes) patch.selectedCardTypes = cardTypes;
  const mediaBuyers = pruneMulti(selection.selectedMediaBuyers, new Set(options.media_buyer.map((o) => o.media_buyer)));
  if (mediaBuyers) patch.selectedMediaBuyers = mediaBuyers;
  const campaignIds = pruneMulti(selection.selectedCampaignIds, new Set(options.campaign_id.map((o) => o.campaign_id)));
  if (campaignIds) {
    patch.selectedCampaignIds = campaignIds;
    patch.campaignIdFilter = ALL;
  }

  return Object.keys(patch).length ? patch : null;
}
