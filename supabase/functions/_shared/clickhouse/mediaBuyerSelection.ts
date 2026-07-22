// The Media Buyer dropdown on Cohorts carries TWO kinds of values in one
// `filters.media_buyer` list: media buyer names ("Ivan", "Unknown", …) and
// UTM-source selections encoded as "utm:<value>" (e.g. "utm:int1"). UTM
// selections are an ADDITIONAL filter category over the authoritative
// first-trial utm_source — they never change how media buyer names filter.
//
// Semantics of a mixed selection follow multi-select-within-one-dropdown:
// (media_buyer IN names) OR (first-trial utm_source IN utms).

import { MEDIA_BUYER_BY_UTM_SOURCE, MEDIA_BUYER_VALUES, mediaBuyerForUserTransactions } from "./userMediaBuyer.ts";
import type { MediaBuyer, Transaction } from "./serviceTypes.ts";

export const UTM_MEDIA_BUYER_SELECTION_PREFIX = "utm:";
export const UTM_OPTION_LABEL_PREFIX = "UTM: ";

/** utm_source values already represented by a media buyer name ("4" → Ivan, …).
 * They are excluded from the UTM option list so the dropdown never shows the
 * same audience twice under two entries. */
export const MAPPED_UTM_SOURCES: string[] = Object.keys(MEDIA_BUYER_BY_UTM_SOURCE);

export function isUtmMediaBuyerSelection(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(UTM_MEDIA_BUYER_SELECTION_PREFIX) &&
    value.slice(UTM_MEDIA_BUYER_SELECTION_PREFIX.length).trim().length > 0;
}

/** "utm:int1" → "int1"; null for anything else. */
export function utmValueFromSelection(value: unknown): string | null {
  return isUtmMediaBuyerSelection(value) ? value.slice(UTM_MEDIA_BUYER_SELECTION_PREFIX.length).trim() : null;
}

/** "int1" → "utm:int1" (dropdown/request value for a UTM option). */
export function utmSelectionValue(utmSource: string): string {
  return `${UTM_MEDIA_BUYER_SELECTION_PREFIX}${utmSource.trim()}`;
}

export interface MediaBuyerSelectionSplit {
  buyers: string[];
  utms: string[];
}

/** Split a media_buyer filter list into buyer names and UTM values.
 * Buyer names are kept VERBATIM (the pre-existing server behaviour: an unknown
 * name matches nothing rather than being silently ignored); UI-side validation
 * of persisted state stays in isMediaBuyerSelectionValue. Order is preserved. */
export function splitMediaBuyerSelections(values: readonly unknown[] | null | undefined): MediaBuyerSelectionSplit {
  const buyers: string[] = [];
  const utms: string[] = [];
  for (const value of values ?? []) {
    if (typeof value !== "string") continue;
    if (value.startsWith(UTM_MEDIA_BUYER_SELECTION_PREFIX)) {
      const utm = utmValueFromSelection(value);
      if (utm && !utms.includes(utm)) utms.push(utm);
      continue;
    }
    if (value.trim() && !buyers.includes(value)) buyers.push(value);
  }
  return { buyers, utms };
}

/** True when the value is EITHER a valid buyer name or a UTM selection —
 * the widened validity check for persisted dropdown state. */
export function isMediaBuyerSelectionValue(value: unknown): value is string {
  return isUtmMediaBuyerSelection(value) ||
    (typeof value === "string" && (MEDIA_BUYER_VALUES as string[]).includes(value));
}

export function formatUtmSourceOptionLabel(option: { utm_source: string; trial_count: number }): string {
  return `${UTM_OPTION_LABEL_PREFIX}${option.utm_source} — ${option.trial_count} trials`;
}

/** Legacy (client-compute) predicate for one user's transaction list:
 * media buyer name match keeps its exact pre-existing behaviour; UTM
 * selections additionally match the user's attributed utm_source (the same
 * value legacy media-buyer attribution derives). Union semantics. */
export function userMatchesMediaBuyerSelection(txs: Transaction[], split: MediaBuyerSelectionSplit): boolean {
  if (!split.buyers.length && !split.utms.length) return true;
  const { media_buyer, utm_source } = mediaBuyerForUserTransactions(txs);
  if (split.buyers.includes(media_buyer)) return true;
  return utm_source != null && split.utms.includes(utm_source);
}
