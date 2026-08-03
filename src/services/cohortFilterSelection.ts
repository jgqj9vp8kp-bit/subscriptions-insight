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
import { utmSelectionValue } from "@/services/mediaBuyerSelection";

export interface CohortFilterSelection {
  selectedFunnels: string[];
  selectedCampaignPaths: string[];
  trafficSourceFilter: string;
  currencyFilter: string;
  selectedCountries: string[];
  selectedCardTypes: CardType[];
  selectedPlatforms: string[];
  selectedMediaBuyers: Array<MediaBuyer | string>;
  selectedCampaignIds: string[];
}

export interface CohortFilterSelectionPatch {
  selectedFunnels?: string[];
  selectedCampaignPaths?: string[];
  trafficSourceFilter?: string;
  currencyFilter?: string;
  selectedCountries?: string[];
  selectedCardTypes?: CardType[];
  selectedPlatforms?: string[];
  selectedMediaBuyers?: Array<MediaBuyer | string>;
  selectedCampaignIds?: string[];
  /** Legacy single-select mirrors, reset whenever their multi-select is pruned. */
  campaignIdFilter?: string;
  funnelFilter?: string;
  campaignPathFilter?: string;
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

  const funnels = pruneMulti(selection.selectedFunnels, new Set(options.funnel));
  if (funnels) {
    patch.selectedFunnels = funnels;
    patch.funnelFilter = ALL;
  }
  const campaignPaths = pruneMulti(selection.selectedCampaignPaths, new Set(options.campaign_path));
  if (campaignPaths) {
    patch.selectedCampaignPaths = campaignPaths;
    patch.campaignPathFilter = ALL;
  }
  const trafficSource = pruneSingle(selection.trafficSourceFilter, options.traffic_source);
  if (trafficSource !== null) patch.trafficSourceFilter = trafficSource;
  const currency = pruneSingle(selection.currencyFilter, options.currency);
  if (currency !== null) patch.currencyFilter = currency;

  const countries = pruneMulti(selection.selectedCountries, new Set(options.country.map((o) => o.country_code)));
  if (countries) patch.selectedCountries = countries;
  const cardTypes = pruneMulti(selection.selectedCardTypes, new Set(options.card_type.map((o) => o.card_type)));
  if (cardTypes) patch.selectedCardTypes = cardTypes;
  // `?? []` like utm_source below: responses cached before the platform
  // dimension shipped deserialize without the key, and an empty list must mean
  // "nothing known", never a crash or a wiped selection.
  const platforms = pruneMulti(selection.selectedPlatforms, new Set((options.platform ?? []).map((o) => o.platform)));
  if (platforms) patch.selectedPlatforms = platforms;
  // The Media Buyer dropdown carries buyer names AND "utm:<value>" entries;
  // both lists together define what is currently selectable.
  const mediaBuyers = pruneMulti(
    selection.selectedMediaBuyers as string[],
    new Set([
      ...options.media_buyer.map((o) => o.media_buyer),
      ...(options.utm_source ?? []).map((o) => utmSelectionValue(o.utm_source)),
    ]),
  );
  if (mediaBuyers) patch.selectedMediaBuyers = mediaBuyers;
  const campaignIds = pruneMulti(selection.selectedCampaignIds, new Set(options.campaign_id.map((o) => o.campaign_id)));
  if (campaignIds) {
    patch.selectedCampaignIds = campaignIds;
    patch.campaignIdFilter = ALL;
  }

  return Object.keys(patch).length ? patch : null;
}

/**
 * Legacy (client-compute) counterpart for the Campaign path dropdown.
 *
 * The legacy option list is derived from the in-memory cohorts, which are EMPTY
 * while the transaction store is still hydrating. Pruning against that empty list
 * cleared the user's selection the moment they picked a path, and the report then
 * silently showed every path instead of the chosen one. Same invariant as the
 * server pruner above: an empty option list means "not loaded yet", never
 * "every selection is invalid".
 *
 * Returns the surviving selection, or null when nothing should change.
 */
export function pruneLegacyCampaignPathSelection(
  selected: readonly string[],
  options: readonly string[],
): string[] | null {
  if (!selected.length) return null;
  if (!options.length) return null;
  const valid = new Set(options);
  const next = selected.filter((path) => valid.has(path));
  return next.length === selected.length ? null : next;
}
