export const COHORTS_UI_SETTINGS_DATASET_TYPE = "cohorts_ui_settings";
export const COHORTS_UI_STATE_STORAGE_KEY = "ui_state_cohorts";
export const COLUMN_ORDER_STORAGE_KEY = "cohorts_column_order";
export const COLUMN_WIDTHS_STORAGE_KEY = "cohorts_column_widths_v1";
export const COLUMN_VISIBILITY_STORAGE_KEY = "cohorts_column_visibility_v1";
export const ACTIVE_VIEW_STORAGE_KEY = "cohorts_active_view_v1";
export const COHORTS_UI_SETTINGS_UPDATED_AT_KEY = "cohorts_ui_settings_updated_at";

export type CohortsUiSettingsPayload = {
  columnOrder: string[];
  columnWidths: Record<string, number>;
  columnVisibility: Record<string, boolean>;
  selectedView: string | null;
  filters: Record<string, unknown>;
  updatedAt: string;
};

export type CohortsUiSettingsDefaults = {
  defaultColumnOrder: readonly string[];
  defaultColumnWidths: Record<string, number>;
  defaultColumnVisibility: Record<string, boolean>;
  defaultFilters: Record<string, unknown>;
  validWidthKeys?: readonly string[];
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

export function sanitizeCohortsUiSettingsPayload(
  value: unknown,
  defaults: CohortsUiSettingsDefaults,
): CohortsUiSettingsPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const updatedAt = typeof source.updatedAt === "string" ? source.updatedAt : "";
  if (!updatedAt || Number.isNaN(new Date(updatedAt).getTime())) return null;

  return {
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
    selectedView: typeof source.selectedView === "string" && source.selectedView ? source.selectedView : null,
    filters:
      source.filters && typeof source.filters === "object" && !Array.isArray(source.filters)
        ? { ...defaults.defaultFilters, ...(source.filters as Record<string, unknown>) }
        : { ...defaults.defaultFilters },
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
  input: Omit<CohortsUiSettingsPayload, "updatedAt"> & { updatedAt?: string },
  defaults: CohortsUiSettingsDefaults,
): CohortsUiSettingsPayload {
  const updatedAt = input.updatedAt ?? new Date().toISOString();
  return {
    columnOrder: sanitizeColumnOrder(input.columnOrder, defaults.defaultColumnOrder),
    columnWidths: sanitizeColumnWidths(input.columnWidths, defaults.defaultColumnWidths, defaults.validWidthKeys ?? Object.keys(defaults.defaultColumnWidths)),
    columnVisibility: sanitizeColumnVisibility(input.columnVisibility, defaults.defaultColumnVisibility, defaults.defaultColumnOrder),
    selectedView: input.selectedView,
    filters: { ...defaults.defaultFilters, ...input.filters },
    updatedAt,
  };
}

export function readLocalCohortsUiSettings(defaults: CohortsUiSettingsDefaults): CohortsUiSettingsPayload | null {
  try {
    const updatedAt = localStorage.getItem(COHORTS_UI_SETTINGS_UPDATED_AT_KEY);
    if (!updatedAt) return null;

    const readJson = (key: string) => {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    };

    return sanitizeCohortsUiSettingsPayload(
      {
        columnOrder: readJson(COLUMN_ORDER_STORAGE_KEY),
        columnWidths: readJson(COLUMN_WIDTHS_STORAGE_KEY),
        columnVisibility: readJson(COLUMN_VISIBILITY_STORAGE_KEY),
        selectedView: localStorage.getItem(ACTIVE_VIEW_STORAGE_KEY),
        filters: readJson(COHORTS_UI_STATE_STORAGE_KEY),
        updatedAt,
      },
      defaults,
    );
  } catch (error) {
    console.warn("Could not read local Cohorts UI settings.", error);
    return null;
  }
}

export function writeLocalCohortsUiSettings(payload: CohortsUiSettingsPayload) {
  try {
    localStorage.setItem(COLUMN_ORDER_STORAGE_KEY, JSON.stringify(payload.columnOrder));
    localStorage.setItem(COLUMN_WIDTHS_STORAGE_KEY, JSON.stringify(payload.columnWidths));
    localStorage.setItem(COLUMN_VISIBILITY_STORAGE_KEY, JSON.stringify(payload.columnVisibility));
    localStorage.setItem(COHORTS_UI_STATE_STORAGE_KEY, JSON.stringify(payload.filters));
    localStorage.setItem(COHORTS_UI_SETTINGS_UPDATED_AT_KEY, payload.updatedAt);
    if (payload.selectedView) localStorage.setItem(ACTIVE_VIEW_STORAGE_KEY, payload.selectedView);
    else localStorage.removeItem(ACTIVE_VIEW_STORAGE_KEY);
  } catch (error) {
    console.warn("Could not write local Cohorts UI settings.", error);
  }
}

export function markCohortsUiSettingsUpdated(updatedAt = new Date().toISOString()) {
  try {
    localStorage.setItem(COHORTS_UI_SETTINGS_UPDATED_AT_KEY, updatedAt);
  } catch (error) {
    console.warn("Could not mark Cohorts UI settings as updated.", error);
  }
}
