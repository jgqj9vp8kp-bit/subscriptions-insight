// Pure view-model helpers of the Payment System Health tabs (no React): the
// decline-class share list, the what-changed grouping, the top class of a
// breakdown row and the dimension list a caller may pick from. Kept out of
// the component files so fast refresh keeps working and tests import them
// without rendering.

import { DECLINE_CLASS_LABELS, type DeclineClass } from "../../../supabase/functions/_shared/clickhouse/declineTaxonomy";
import {
  PAYMENT_HEALTH_DIMENSIONS,
  PSP_DIMENSIONS,
  type BreakdownRow,
  type PaymentHealthDimension,
  type WhatChangedRow,
} from "../../../supabase/functions/_shared/clickhouse/paymentHealthContract";
import { ratio } from "./format";

/** Decline classes of the current period ordered by count, with their share of declines. */
export function declineClassRows(classes: Partial<Record<DeclineClass, number>>, declines: number): Array<{ key: DeclineClass; label: string; count: number; share: number | null }> {
  return (Object.entries(classes) as Array<[DeclineClass, number]>)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => ({ key, label: DECLINE_CLASS_LABELS[key] ?? key, count, share: ratio(count, declines) }));
}

/** what_changed grouped by dimension (server order), each group by |Δ declines| descending. */
export function groupWhatChanged(rows: WhatChangedRow[]): Array<{ dimension: PaymentHealthDimension; rows: WhatChangedRow[] }> {
  const groups = new Map<PaymentHealthDimension, WhatChangedRow[]>();
  for (const row of rows) {
    const list = groups.get(row.dimension) ?? [];
    list.push(row);
    groups.set(row.dimension, list);
  }
  return [...groups.entries()].map(([dimension, list]) => ({
    dimension,
    rows: list.slice().sort((a, b) => Math.abs(b.decomposition.delta_count) - Math.abs(a.decomposition.delta_count)),
  }));
}

/** The largest decline class of a breakdown row (label + count), or null without declines. */
export function topDeclineClass(row: Pick<BreakdownRow, "decline_classes">): { label: string; count: number } | null {
  let best: [DeclineClass, number] | null = null;
  for (const [key, count] of Object.entries(row.decline_classes) as Array<[DeclineClass, number]>) {
    if (count > 0 && (!best || count > best[1])) best = [key, count];
  }
  return best ? { label: DECLINE_CLASS_LABELS[best[0]] ?? best[0], count: best[1] } : null;
}

/** The dimensions a caller may break down by: the PSP ones only when visible. */
export function dimensionOptions(pspVisible: boolean): PaymentHealthDimension[] {
  return PAYMENT_HEALTH_DIMENSIONS.filter((dimension) => pspVisible || !PSP_DIMENSIONS.has(dimension));
}
