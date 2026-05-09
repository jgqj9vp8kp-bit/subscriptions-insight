import {
  loadLatestCloudSnapshot,
  saveCloudSnapshot,
} from "@/services/dataSnapshots";

export const COHORTS_UI_SETTINGS_DATASET_TYPE = "cohorts_ui_settings";
export const COHORTS_UI_STATE_STORAGE_KEY = "ui_state_cohorts";
export const COLUMN_ORDER_STORAGE_KEY = "cohorts_column_order";
export const COLUMN_WIDTHS_STORAGE_KEY = "cohorts_column_widths_v1";
export const COLUMN_VISIBILITY_STORAGE_KEY = "cohorts_column_visibility_v1";
export const SAVED_VIEWS_STORAGE_KEY = "cohorts_saved_views_v1";
export const ACTIVE_VIEW_STORAGE_KEY = "cohorts_active_view_v1";
export const COHORTS_UI_SETTINGS_UPDATED_AT_KEY = "cohorts_ui_settings_updated_at";

export type CohortsUiSavedView = {
  id: string;
  name: string;
  columnOrder: string[];
  columnVisibility: Record<string, boolean>;
  columnWidths?: Record<string, number>;
};

export type CohortsUiSettingsPayload = {
  version: 1;
  columnOrder: string[];
  columnWidths: Record<string, number>;
  columnVisibility: Record<string, boolean>;
  selectedView: string | null;
  savedViews: CohortsUiSavedView[];
  filters: Record<string, unknown>;
  sortColumn: string | null;
  sortDirection: "asc" | "desc" | null;
  updatedAt: string;
};

export type CohortsUiSettingsDefaults = {
  defaultColumnOrder: readonly string[];
  defaultColumnWidths: Record<string, number>;
  defaultColumnVisibility: Record<string, boolean>;
  defaultFilters: Record<string, unknown>;
  validWidthKeys?: readonly string[];
  validSelectedViewIds?: readonly string[];
  defaultSelectedView?: string | null;
  validSortColumnIds?: readonly string[];
};

export type CohortsUiSettingsMergeResult = {
  settings: CohortsUiSettingsPayload | null;
  source: "local" | "cloud" | "none";
};

export function sanitizeColumnOrder(input: unknown, defaultOrder: readonly string[]): string[] {
  const valid = new Set(defaultOrder);
  const seen = new Set<string>();
  const next: string[] = [];

  if (Array.isArray(input)) {
    for (const value of input) {
      if (typeof value !== "string") continue;
      if (!valid.has(value) || seen.has(value)) continue;
      seen.add(value);
      next.push(value);
    }
  }

  for (const id of defaultOrder) {
    if (!seen.has(id)) next.push(id);
  }

  return next;
}

export function sanitizeColumnVisibility(
  input: unknown,
  defaultVisibility: Record<string, boolean>,
  defaultOrder: readonly string[],
): Record<string, boolean> {
  const source = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const next: Record<string, boolean> = {};

  for (const id of defaultOrder) {
    next[id] = typeof source[id] === "boolean" ? source[id] : defaultVisibility[id] !== false;
  }

  return next;
}

export function sanitizeColumnWidths(
  input: unknown,
  defaultWidths: Record<string, number>,
  validWidthKeys: readonly string[],
): Record<string, number> {
  const source = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const valid = new Set(validWidthKeys);
  const next = { ...defaultWidths };

  for (const [key, value] of Object.entries(source)) {
    if (!valid.has(key)) continue;
    const width = Number(value);
    if (Number.isFinite(width) && width > 0) next[key] = width;
  }

  return next;
}

export function sanitizeSavedViews(
  input: unknown,
  defaults: CohortsUiSettingsDefaults,
): CohortsUiSavedView[] {
  if (!Array.isArray(input)) return [];

  return input.flatMap((view) => {
    if (!view || typeof view !== "object" || Array.isArray(view)) return [];
    const source = view as Record<string, unknown>;
    const id = typeof source.id === "string" ? source.id.trim() : "";
    const name = typeof source.name === "string" ? source.name.trim() : "";
    if (!id || !name) return [];

    const columnOrder = sanitizeColumnOrder(source.columnOrder ?? source.order, defaults.defaultColumnOrder);
    const columnVisibility = sanitizeColumnVisibility(
      source.columnVisibility ?? source.visibility,
      defaults.defaultColumnVisibility,
      defaults.defaultColumnOrder,
    );
    const rawWidths = source.columnWidths ?? source.widths;
    const columnWidths = rawWidths
      ? sanitizeColumnWidths(
          rawWidths,
          {},
          defaults.validWidthKeys ?? Object.keys(defaults.defaultColumnWidths),
        )
      : undefined;

    return [{ id, name, columnOrder, columnVisibility, columnWidths }];
  });
}

export function sanitizeCohortsUiSettingsPayload(
  value: unknown,
  defaults: CohortsUiSettingsDefaults,
): CohortsUiSettingsPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const updatedAt = typeof source.updatedAt === "string" ? source.updatedAt : "";
  if (!updatedAt || Number.isNaN(new Date(updatedAt).getTime())) return null;
  const savedViews = sanitizeSavedViews(source.savedViews, defaults);
  const selectedView = typeof source.selectedView === "string" && source.selectedView ? source.selectedView : null;
  const validViewIds = new Set([...(defaults.validSelectedViewIds ?? []), ...savedViews.map((view) => view.id)]);
  const sortColumn = typeof source.sortColumn === "string" && source.sortColumn ? source.sortColumn : null;
  const validSortColumns = new Set(defaults.validSortColumnIds ?? defaults.defaultColumnOrder);
  const sortDirection = source.sortDirection === "asc" || source.sortDirection === "desc" ? source.sortDirection : null;
  const normalizedSortColumn = sortColumn && validSortColumns.has(sortColumn) && sortDirection ? sortColumn : null;

  return {
    version: 1,
    columnOrder: sanitizeColumnOrder(source.columnOrder, defaults.defaultColumnOrder),
    columnWidths: sanitizeColumnWidths(
      source.columnWidths,
      defaults.defaultColumnWidths,
      defaults.validWidthKeys ?? Object.keys(defaults.defaultColumnWidths),
    ),
    columnVisibility: sanitizeColumnVisibility(
      source.columnVisibility,
      defaults.defaultColumnVisibility,
      defaults.defaultColumnOrder,
    ),
    selectedView:
      selectedView && validViewIds.size > 0 && !validViewIds.has(selectedView)
        ? defaults.defaultSelectedView ?? null
        : selectedView,
    savedViews,
    filters:
      source.filters && typeof source.filters === "object" && !Array.isArray(source.filters)
        ? { ...defaults.defaultFilters, ...(source.filters as Record<string, unknown>) }
        : { ...defaults.defaultFilters },
    sortColumn: normalizedSortColumn,
    sortDirection: normalizedSortColumn ? sortDirection : null,
    updatedAt,
  };
}

export function newerCohortsUiSettings(
  local: CohortsUiSettingsPayload | null,
  cloud: CohortsUiSettingsPayload | null,
): "local" | "cloud" | "none" {
  if (!local && !cloud) return "none";
  if (!local) return "cloud";
  if (!cloud) return "local";
  return new Date(cloud.updatedAt).getTime() > new Date(local.updatedAt).getTime() ? "cloud" : "local";
}

export function buildCohortsUiSettingsPayload(
  input: Omit<CohortsUiSettingsPayload, "version" | "updatedAt" | "sortColumn" | "sortDirection"> & {
    updatedAt?: string;
    sortColumn?: string | null;
    sortDirection?: "asc" | "desc" | null;
  },
  defaults: CohortsUiSettingsDefaults,
): CohortsUiSettingsPayload {
  const updatedAt = input.updatedAt ?? new Date().toISOString();
  return sanitizeCohortsUiSettingsPayload(
    {
      version: 1,
      columnOrder: input.columnOrder,
      columnWidths: input.columnWidths,
      columnVisibility: input.columnVisibility,
      selectedView: input.selectedView,
      savedViews: input.savedViews,
      filters: input.filters,
      sortColumn: input.sortColumn,
      sortDirection: input.sortDirection,
      updatedAt,
    },
    defaults,
  ) ?? {
    version: 1,
    columnOrder: sanitizeColumnOrder(input.columnOrder, defaults.defaultColumnOrder),
    columnWidths: sanitizeColumnWidths(input.columnWidths, defaults.defaultColumnWidths, defaults.validWidthKeys ?? Object.keys(defaults.defaultColumnWidths)),
    columnVisibility: sanitizeColumnVisibility(input.columnVisibility, defaults.defaultColumnVisibility, defaults.defaultColumnOrder),
    selectedView: input.selectedView,
    savedViews: sanitizeSavedViews(input.savedViews, defaults),
    filters: { ...defaults.defaultFilters, ...input.filters },
    sortColumn: input.sortColumn ?? null,
    sortDirection: input.sortDirection ?? null,
    updatedAt,
  };
}

export function loadCohortsUiSettingsLocal(defaults: CohortsUiSettingsDefaults): CohortsUiSettingsPayload | null {
  try {
    const updatedAt = localStorage.getItem(COHORTS_UI_SETTINGS_UPDATED_AT_KEY);
    if (!updatedAt) return null;

    const readJson = (key: string) => {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    };
    const rawFilters = readJson(COHORTS_UI_STATE_STORAGE_KEY);
    const filters =
      rawFilters && typeof rawFilters === "object" && !Array.isArray(rawFilters)
        ? (rawFilters as Record<string, unknown>)
        : {};

    return sanitizeCohortsUiSettingsPayload(
      {
        columnOrder: readJson(COLUMN_ORDER_STORAGE_KEY),
        columnWidths: readJson(COLUMN_WIDTHS_STORAGE_KEY),
        columnVisibility: readJson(COLUMN_VISIBILITY_STORAGE_KEY),
        selectedView: localStorage.getItem(ACTIVE_VIEW_STORAGE_KEY),
        savedViews: readJson(SAVED_VIEWS_STORAGE_KEY),
        filters,
        sortColumn: filters?.sortColumn,
        sortDirection: filters?.sortDirection,
        updatedAt,
      },
      defaults,
    );
  } catch (error) {
    console.warn("Could not read local Cohorts UI settings.", error);
    return null;
  }
}

export function saveCohortsUiSettingsLocal(payload: CohortsUiSettingsPayload) {
  try {
    localStorage.setItem(COLUMN_ORDER_STORAGE_KEY, JSON.stringify(payload.columnOrder));
    localStorage.setItem(COLUMN_WIDTHS_STORAGE_KEY, JSON.stringify(payload.columnWidths));
    localStorage.setItem(COLUMN_VISIBILITY_STORAGE_KEY, JSON.stringify(payload.columnVisibility));
    localStorage.setItem(SAVED_VIEWS_STORAGE_KEY, JSON.stringify(payload.savedViews));
    localStorage.setItem(
      COHORTS_UI_STATE_STORAGE_KEY,
      JSON.stringify({
        ...payload.filters,
        sortColumn: payload.sortColumn,
        sortDirection: payload.sortDirection,
      }),
    );
    localStorage.setItem(COHORTS_UI_SETTINGS_UPDATED_AT_KEY, payload.updatedAt);
    if (payload.selectedView) localStorage.setItem(ACTIVE_VIEW_STORAGE_KEY, payload.selectedView);
    else localStorage.removeItem(ACTIVE_VIEW_STORAGE_KEY);
  } catch (error) {
    console.warn("Could not write local Cohorts UI settings.", error);
  }
}

export const readLocalCohortsUiSettings = loadCohortsUiSettingsLocal;
export const writeLocalCohortsUiSettings = saveCohortsUiSettingsLocal;

export async function saveCohortsUiSettingsCloud(payload: CohortsUiSettingsPayload) {
  return saveCloudSnapshot({
    datasetType: COHORTS_UI_SETTINGS_DATASET_TYPE,
    name: "Cohorts UI settings",
    payload,
    metadata: {
      updated_at: payload.updatedAt,
      column_count: payload.columnOrder.length,
      saved_views_count: payload.savedViews.length,
    },
  });
}

export async function loadCohortsUiSettingsCloud(
  defaults: CohortsUiSettingsDefaults,
): Promise<CohortsUiSettingsPayload | null> {
  const snapshot = await loadLatestCloudSnapshot<CohortsUiSettingsPayload>(COHORTS_UI_SETTINGS_DATASET_TYPE);
  return sanitizeCohortsUiSettingsPayload(snapshot?.payload, defaults);
}

export function mergeCohortsUiSettings(
  local: CohortsUiSettingsPayload | null,
  cloud: CohortsUiSettingsPayload | null,
): CohortsUiSettingsMergeResult {
  const source = newerCohortsUiSettings(local, cloud);
  return {
    source,
    settings: source === "cloud" ? cloud : source === "local" ? local : null,
  };
}

export function markCohortsUiSettingsUpdated(updatedAt = new Date().toISOString()) {
  try {
    localStorage.setItem(COHORTS_UI_SETTINGS_UPDATED_AT_KEY, updatedAt);
  } catch (error) {
    console.warn("Could not mark Cohorts UI settings as updated.", error);
  }
}
