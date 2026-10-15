// Row model of the Dashboard "Revenue by funnel" card: the top funnels by the
// sorted column, the long tail folded into one "Other" row until expanded, and
// the Unknown / Unattributed rows pinned below the funnels (they are
// populations, not funnels — never ranked or folded). The rows on screen always
// add up to the bundle totals.
import type { RevenueSliceRow } from "@/services/revenueIntelligence";

export const FUNNEL_TOP_N = 8;

const PINNED_KEYS = new Set(["Unknown", "Unattributed"]);

const SORT_ACCESSORS = {
  key: (row: RevenueSliceRow) => row.key,
  gross: (row: RevenueSliceRow) => row.gross,
  gross_new: (row: RevenueSliceRow) => row.gross_new,
  gross_existing: (row: RevenueSliceRow) => row.gross_existing,
  net: (row: RevenueSliceRow) => row.net,
} as const;
export type FunnelSortKey = keyof typeof SORT_ACCESSORS;
export type FunnelSort = { key: FunnelSortKey; dir: "asc" | "desc" };

export type FoldedFunnelRow = RevenueSliceRow & { count: number };

export interface FunnelListView {
  /** Funnels shown as their own rows, in sort order. */
  visible: RevenueSliceRow[];
  /** The folded long tail (null when nothing is folded). */
  other: FoldedFunnelRow | null;
  /** Unknown / Unattributed, always last, never folded. */
  pinned: RevenueSliceRow[];
  funnelCount: number;
  /** Largest gross among the rows on screen — the bar scale. */
  maxGross: number;
}

export function buildFunnelListView(
  rows: ReadonlyArray<RevenueSliceRow>,
  sort: FunnelSort,
  expanded: boolean,
  topN = FUNNEL_TOP_N,
): FunnelListView {
  const accessor = SORT_ACCESSORS[sort.key];
  const direction = sort.dir === "asc" ? 1 : -1;
  const funnels = rows
    .filter((row) => !PINNED_KEYS.has(row.key))
    .sort((a, b) => {
      const va = accessor(a);
      const vb = accessor(b);
      const order = typeof va === "string" ? va.localeCompare(vb as string) : (va as number) - (vb as number);
      return order * direction || a.key.localeCompare(b.key);
    });
  const pinned = rows.filter((row) => PINNED_KEYS.has(row.key));
  // Folding a single funnel into "Other · 1 funnel" saves nothing — show it.
  const fold = !expanded && funnels.length > topN + 1;
  const visible = fold ? funnels.slice(0, topN) : funnels;
  const tail = fold ? funnels.slice(topN) : [];
  const other = tail.length
    ? tail.reduce<FoldedFunnelRow>(
        (sum, row) => ({
          ...sum,
          gross: sum.gross + row.gross,
          net: sum.net + row.net,
          gross_new: sum.gross_new + row.gross_new,
          gross_existing: sum.gross_existing + row.gross_existing,
        }),
        { key: "Other", gross: 0, net: 0, gross_new: 0, gross_existing: 0, count: tail.length },
      )
    : null;
  const onScreen = [...visible, ...(other ? [other] : []), ...pinned];
  const maxGross = Math.max(0, ...onScreen.map((row) => row.gross));
  return { visible, other, pinned, funnelCount: funnels.length, maxGross };
}
