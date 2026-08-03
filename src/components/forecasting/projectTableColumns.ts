// Project table column registry + persisted preferences (P9).
//
// The pure sanitizers are REUSED from cohortsUiSettings — the audit confirmed
// they are dataset-agnostic (everything flows through the defaults parameter).
// Only the storage keys are project-local (`project_forecast_*`); Cohorts' keys
// are module-level constants there and must not be shared. No cloud sync in v1,
// so the closed DatasetType union stays untouched.
import {
  resolveLandingView,
  sanitizeColumnVisibility,
  sanitizeSavedViews,
  type CohortsUiSavedView,
  type CohortsUiSettingsDefaults,
} from "@/services/cohortsUiSettings";

export interface ProjectColumnSpec {
  id: string;
  label: string;
  title?: string;
}

/** Canonical order. Identity (checkbox + funnel name) is not configurable. */
export const PROJECT_COLUMNS: ProjectColumnSpec[] = [
  { id: "spend", label: "Spend" },
  { id: "coverage", label: "Cov.", title: "userAttributedSpend / funnelResolvedSpend — how much of this funnel's spend reached users" },
  { id: "trials", label: "Trials" },
  { id: "cpa", label: "CPA", title: "Seeded on the project's spend basis — waste included (§5a)" },
  { id: "outflow", label: "Outflow", title: "Budget grossed up by traffic commission" },
  { id: "gross", label: "Gross" },
  { id: "contribution", label: "Contribution" },
  { id: "overhead", label: "Overhead", title: "Prorated shared pool × this row's spend share" },
  { id: "net", label: "Net profit" },
  { id: "payback", label: "Payback", title: "Per-funnel traffic-only payback (engine semantics)" },
];

export const PROJECT_COLUMN_ORDER: string[] = PROJECT_COLUMNS.map((column) => column.id);

const VISIBILITY_KEY = "project_forecast_column_visibility_v1";
const SAVED_VIEWS_KEY = "project_forecast_saved_views_v1";
const ACTIVE_VIEW_KEY = "project_forecast_active_view_v1";

export const PROJECT_COLUMN_DEFAULTS: CohortsUiSettingsDefaults = {
  defaultColumnOrder: PROJECT_COLUMN_ORDER,
  defaultColumnWidths: {},
  defaultColumnVisibility: Object.fromEntries(PROJECT_COLUMN_ORDER.map((id) => [id, true])),
  defaultFilters: {},
};

function readJson(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export interface ProjectColumnPrefs {
  visibility: Record<string, boolean>;
  savedViews: CohortsUiSavedView[];
  activeViewId: string | null;
}

export function loadProjectColumnPrefs(): ProjectColumnPrefs {
  const visibility = sanitizeColumnVisibility(readJson(VISIBILITY_KEY), PROJECT_COLUMN_DEFAULTS.defaultColumnVisibility, PROJECT_COLUMN_ORDER);
  const savedViews = sanitizeSavedViews(readJson(SAVED_VIEWS_KEY), PROJECT_COLUMN_DEFAULTS);
  let active: string | null = null;
  try { active = localStorage.getItem(ACTIVE_VIEW_KEY); } catch { /* noop */ }
  const valid = new Set(savedViews.map((view) => view.id));
  // Same landing rule as Cohorts: an explicit choice wins; otherwise the newest
  // saved view; otherwise the default columns. Landing on a view APPLIES its
  // visibility — the label and the columns must never disagree.
  const activeViewId = resolveLandingView(active && valid.has(active) ? active : null, savedViews);
  const landedView = activeViewId ? savedViews.find((view) => view.id === activeViewId) : undefined;
  return {
    visibility: landedView ? landedView.columnVisibility : visibility,
    savedViews,
    activeViewId,
  };
}

export function persistProjectColumnPrefs(prefs: ProjectColumnPrefs): void {
  try {
    localStorage.setItem(VISIBILITY_KEY, JSON.stringify(prefs.visibility));
    localStorage.setItem(SAVED_VIEWS_KEY, JSON.stringify(prefs.savedViews));
    if (prefs.activeViewId) localStorage.setItem(ACTIVE_VIEW_KEY, prefs.activeViewId);
    else localStorage.removeItem(ACTIVE_VIEW_KEY);
  } catch {
    // Quota/priv errors degrade to session-only prefs — never break the page.
  }
}
