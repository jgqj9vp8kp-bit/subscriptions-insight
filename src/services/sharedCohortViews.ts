// Shared Cohorts views (migration 202610180002): workspace-wide column layouts
// the Owner publishes from a personal saved view. Every member with
// cohorts.view reads them (RLS); only the Owner writes. A shared view is a
// layout only — applying it never changes filters or what data is visible.
import { supabase } from "@/services/supabaseClient";

export const SHARED_VIEW_ID_PREFIX = "shared:";

export interface SharedCohortView {
  /** Page-level view id: SHARED_VIEW_ID_PREFIX + the row uuid. */
  id: string;
  rowId: string;
  name: string;
  columnOrder: string[];
  columnVisibility: Record<string, boolean>;
  columnWidths?: Record<string, number>;
  updatedAt: string;
}

export interface SharedCohortViewInput {
  name: string;
  columnOrder: readonly string[];
  columnVisibility: Record<string, boolean>;
  columnWidths?: Record<string, number>;
}

const COLUMNS = "id, name, column_order, column_visibility, column_widths, updated_at";

export function isSharedViewId(id: string | null | undefined): boolean {
  return typeof id === "string" && id.startsWith(SHARED_VIEW_ID_PREFIX);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function sharedViewFromRow(row: Record<string, unknown>): SharedCohortView | null {
  const rowId = typeof row.id === "string" ? row.id : "";
  const name = typeof row.name === "string" ? row.name.trim() : "";
  if (!rowId || !name) return null;
  const visibility: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(record(row.column_visibility))) {
    if (typeof value === "boolean") visibility[key] = value;
  }
  const widthsSource = row.column_widths == null ? null : record(row.column_widths);
  const widths: Record<string, number> = {};
  for (const [key, value] of Object.entries(widthsSource ?? {})) {
    const width = Number(value);
    if (Number.isFinite(width) && width > 0) widths[key] = width;
  }
  return {
    id: `${SHARED_VIEW_ID_PREFIX}${rowId}`,
    rowId,
    name,
    columnOrder: Array.isArray(row.column_order) ? row.column_order.filter((id): id is string => typeof id === "string") : [],
    columnVisibility: visibility,
    columnWidths: widthsSource ? widths : undefined,
    updatedAt: typeof row.updated_at === "string" ? row.updated_at : "",
  };
}

function client() {
  if (!supabase) throw new Error("Supabase is not configured.");
  return supabase;
}

export async function listSharedCohortViews(): Promise<SharedCohortView[]> {
  if (!supabase) return [];
  const { data, error } = await supabase.from("shared_cohort_views").select(COLUMNS).order("name", { ascending: true });
  if (error) throw new Error(`Could not load shared views: ${error.message}`);
  return ((data ?? []) as Record<string, unknown>[]).flatMap((row) => sharedViewFromRow(row) ?? []);
}

/** Publishes `input` as a shared view; a shared view with the same name (any
 * case) is replaced in place, so re-sharing an edited view updates it. */
export async function publishSharedCohortView(
  input: SharedCohortViewInput,
  existing: readonly SharedCohortView[],
): Promise<SharedCohortView> {
  const name = input.name.trim().slice(0, 80);
  if (!name) throw new Error("A shared view needs a name.");
  const values = {
    name,
    column_order: [...input.columnOrder],
    column_visibility: input.columnVisibility,
    column_widths: input.columnWidths ?? null,
  };
  const same = existing.find((view) => view.name.toLowerCase() === name.toLowerCase());
  const query = same
    ? client().from("shared_cohort_views").update(values).eq("id", same.rowId)
    : client().from("shared_cohort_views").insert(values);
  const { data, error } = await query.select(COLUMNS).single();
  if (error) throw new Error(`Could not share the view: ${error.message}`);
  const view = sharedViewFromRow(data as Record<string, unknown>);
  if (!view) throw new Error("Could not share the view: unexpected response.");
  return view;
}

export async function deleteSharedCohortView(view: Pick<SharedCohortView, "rowId">): Promise<void> {
  const { error } = await client().from("shared_cohort_views").delete().eq("id", view.rowId);
  if (error) throw new Error(`Could not remove the shared view: ${error.message}`);
}
