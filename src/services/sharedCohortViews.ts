// Shared Cohorts views (migration 202610180002): workspace-wide column layouts
// the Owner publishes from a personal saved view. Every member with
// cohorts.view reads them (RLS); only the Owner writes. A shared view is a
// layout only — applying it never changes filters or what data is visible.
// A shared view can be the default for access roles (migration 202610180003).
import { supabase } from "@/services/supabaseClient";
import { principalHash } from "@/services/sessionPurge";

export const SHARED_VIEW_ID_PREFIX = "shared:";

export interface SharedCohortView {
  /** Page-level view id: SHARED_VIEW_ID_PREFIX + the row uuid. */
  id: string;
  rowId: string;
  name: string;
  columnOrder: string[];
  columnVisibility: Record<string, boolean>;
  columnWidths?: Record<string, number>;
  /** access_roles.key values this view is the default for. */
  defaultRoleKeys: string[];
  updatedAt: string;
}

export interface SharedCohortViewInput {
  name: string;
  columnOrder: readonly string[];
  columnVisibility: Record<string, boolean>;
  columnWidths?: Record<string, number>;
}

const COLUMNS = "id, name, column_order, column_visibility, column_widths, default_role_keys, updated_at";

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
    defaultRoleKeys: Array.isArray(row.default_role_keys)
      ? [...new Set(row.default_role_keys.filter((key): key is string => typeof key === "string" && key.trim() !== ""))].sort()
      : [],
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

/** Owner only (RLS): the roles this view is the default for. */
export async function setSharedCohortViewDefaultRoles(
  view: Pick<SharedCohortView, "rowId">,
  roleKeys: readonly string[],
): Promise<SharedCohortView> {
  const keys = [...new Set(roleKeys.map((key) => key.trim()).filter(Boolean))].sort();
  const { data, error } = await client()
    .from("shared_cohort_views")
    .update({ default_role_keys: keys })
    .eq("id", view.rowId)
    .select(COLUMNS)
    .single();
  if (error) throw new Error(`Could not set the default roles: ${error.message}`);
  const updated = sharedViewFromRow(data as Record<string, unknown>);
  if (!updated) throw new Error("Could not set the default roles: unexpected response.");
  return updated;
}

/** The default view of `roleKey`: the most recently updated shared view
 * naming it (null without a role or a match). */
export function defaultSharedViewForRole(
  views: readonly SharedCohortView[],
  roleKey: string | null | undefined,
): SharedCohortView | null {
  if (!roleKey) return null;
  const matches = views.filter((view) => view.defaultRoleKeys.includes(roleKey));
  if (!matches.length) return null;
  return [...matches].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.rowId.localeCompare(b.rowId))[0];
}

// A role default lands ONCE per member and view, so a member who then edits
// their columns keeps their layout on the next visit. Per browser (members
// have no cloud copy of their Cohorts settings), stamped with the member.
const ROLE_DEFAULT_APPLIED_KEY_PREFIX = "cohorts_role_default_applied:";

function appliedKey(userId: string): string {
  return `${ROLE_DEFAULT_APPLIED_KEY_PREFIX}${principalHash(userId.toLowerCase())}`;
}

function appliedRowIds(userId: string): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(appliedKey(userId)) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export function roleDefaultApplied(userId: string | null | undefined, view: Pick<SharedCohortView, "rowId">): boolean {
  return Boolean(userId) && appliedRowIds(userId!).includes(view.rowId);
}

export function markRoleDefaultApplied(userId: string | null | undefined, view: Pick<SharedCohortView, "rowId">): void {
  if (!userId) return;
  const ids = appliedRowIds(userId);
  if (ids.includes(view.rowId)) return;
  try {
    localStorage.setItem(appliedKey(userId), JSON.stringify([...ids, view.rowId].slice(-50)));
  } catch {
    /* storage full / blocked: the default may land again next visit */
  }
}
