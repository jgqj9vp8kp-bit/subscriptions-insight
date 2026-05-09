import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronDown, ChevronRight, GripVertical, Check, Loader2, Plus, Trash2 } from "lucide-react";
import { AppLayout } from "@/components/AppLayout";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useTransactions } from "@/services/sheets";
import {
  computeCohorts,
  formatCurrency,
  formatPct,
} from "@/services/analytics";
import { normalizeCampaignPath, type TrafficMetric } from "@/services/trafficImport";
import type { CohortRow, PlanBreakdownRow } from "@/services/types";
import { useDataStore } from "@/store/dataStore";
import { usePersistedPageState } from "@/hooks/usePersistedPageState";
import {
  ACTIVE_VIEW_STORAGE_KEY,
  COLUMN_ORDER_STORAGE_KEY,
  COLUMN_VISIBILITY_STORAGE_KEY,
  COLUMN_WIDTHS_STORAGE_KEY,
  SAVED_VIEWS_STORAGE_KEY,
  buildCohortsUiSettingsPayload,
  loadCohortsUiSettingsCloud,
  markCohortsUiSettingsUpdated,
  mergeCohortsUiSettings,
  readLocalCohortsUiSettings,
  saveCohortsUiSettingsCloud,
  sanitizeCohortsUiSettingsPayload,
  writeLocalCohortsUiSettings,
  type CohortsUiSavedView,
  type CohortsUiSettingsDefaults,
  type CohortsUiSettingsPayload,
} from "@/services/cohortsUiSettings";
import {
  nextCohortSortState,
  sortCohortRows,
  type CohortSortDirection,
} from "@/services/cohortSorting";

// Visual-only helpers — no data/logic impact.
const HEAD_BASE =
  "sticky top-0 z-40 bg-card h-8 px-2 whitespace-nowrap border-b border-border shadow-[0_1px_0_0_hsl(var(--border))] text-xs font-semibold text-muted-foreground select-none";
const HEAD_NUM = `${HEAD_BASE} text-right`;
const CELL_BASE = "py-1 px-2 align-middle";
const CELL_NUM = `${CELL_BASE} text-right tabular-nums whitespace-nowrap text-sm`;
const CELL_TXT = `${CELL_BASE} text-xs text-muted-foreground whitespace-nowrap`;
// Left border marks the start of a logical section.
const SECTION_DIVIDER = "border-l border-border/60";
const MIN_COLUMN_WIDTH = 80;
const COHORT_FIRST_COL_KEY = "__cohort__";

const DEFAULT_COHORTS_UI_STATE = {
  funnelFilter: "all",
  campaignPathFilter: "all",
  trafficSourceFilter: "all",
  campaignIdFilter: "all",
  refundFilter: "all",
  cohortDateFrom: "",
  cohortDateTo: "",
  dateSort: "desc" as "desc" | "asc",
  sortColumn: null as string | null,
  sortDirection: null as CohortSortDirection | null,
  expandedCohortIds: [] as string[],
};

const DEFAULT_COLUMN_ORDER = [
  "cohort_date",
  "campaign_path",
  "funnel",
  "trial_users",
  "active_users",
  "active_subscriptions",
  "active_subscriptions_rate",
  "active_rate",
  "cancelled_users",
  "user_cancelled_users",
  "user_cancel_rate",
  "auto_cancelled_users",
  "auto_cancel_rate",
  "cancellation_rate",
  "cancelled_active_users",
  "upsell_users",
  "first_subscription_users",
  "trial_to_upsell_cr",
  "trial_to_first_subscription_cr",
  "first_subscription_to_renewal_2_cr",
  "renewal_2_to_renewal_3_cr",
  "renewal_2_users",
  "renewal_3_users",
  "renewal_users",
  "refund_users",
  "amount_refunded",
  "refund_rate",
  "gross_revenue",
  "net_revenue",
  "revenue_d0",
  "revenue_d7",
  "revenue_d30",
  "revenue_d60",
  "traffic_spend",
  "profit",
  "profit_d7",
  "profit_1m",
  "profit_2m",
  "traffic_cac",
  "traffic_trial_count",
  "traffic_clicks",
  "traffic_cpc",
  "traffic_cpm",
  "traffic_ctr",
  "roas_d7",
  "roas_1m",
  "roas_2m",
] as const;

type CohortColumnId = (typeof DEFAULT_COLUMN_ORDER)[number];

const COLUMN_LABELS: Record<CohortColumnId, string> = {
  cohort_date: "Cohort date",
  campaign_path: "Campaign path",
  funnel: "Funnel",
  trial_users: "Trial",
  active_users: "Active Users",
  active_subscriptions: "Active Subscriptions",
  active_subscriptions_rate: "Active Subscriptions Rate",
  active_rate: "Active Rate",
  cancelled_users: "Cancelled Users",
  user_cancelled_users: "User Cancelled",
  user_cancel_rate: "User Cancel Rate",
  auto_cancelled_users: "Auto Cancelled",
  auto_cancel_rate: "Auto Cancel Rate",
  cancellation_rate: "Cancellation Rate",
  cancelled_active_users: "Cancelled Active",
  upsell_users: "Upsell",
  first_subscription_users: "First Sub",
  trial_to_upsell_cr: "→ Upsell CR",
  trial_to_first_subscription_cr: "→ Sub CR",
  first_subscription_to_renewal_2_cr: "Sub → Renewal 2 CR",
  renewal_2_to_renewal_3_cr: "Renewal 2 → 3 CR",
  renewal_2_users: "Renewal 2",
  renewal_3_users: "Renewal 3",
  renewal_users: "Total Renewals",
  refund_users: "Refund Users",
  amount_refunded: "Amount Refunded",
  refund_rate: "Refund Rate",
  gross_revenue: "Gross Rev",
  net_revenue: "Net Rev",
  revenue_d0: "Rev D0",
  revenue_d7: "Rev D7",
  revenue_d30: "Rev 1M",
  revenue_d60: "Rev 2M",
  traffic_spend: "Spend",
  profit: "Profit",
  profit_d7: "Profit D7",
  profit_1m: "Profit 1M",
  profit_2m: "Profit 2M",
  traffic_cac: "CAC",
  traffic_trial_count: "FB Trial Count",
  traffic_clicks: "Clicks",
  traffic_cpc: "CPC",
  traffic_cpm: "CPM",
  traffic_ctr: "CTR",
  roas_d7: "ROAS D7",
  roas_1m: "ROAS 1M",
  roas_2m: "ROAS 2M",
};

const COLUMN_MIN_WIDTHS: Record<CohortColumnId, number> = {
  cohort_date: 120,
  campaign_path: 160,
  funnel: 110,
  trial_users: 76,
  active_users: 110,
  active_subscriptions: 140,
  active_subscriptions_rate: 150,
  active_rate: 100,
  cancelled_users: 120,
  user_cancelled_users: 120,
  user_cancel_rate: 120,
  auto_cancelled_users: 120,
  auto_cancel_rate: 120,
  cancellation_rate: 120,
  cancelled_active_users: 120,
  upsell_users: 84,
  first_subscription_users: 90,
  trial_to_upsell_cr: 100,
  trial_to_first_subscription_cr: 90,
  first_subscription_to_renewal_2_cr: 140,
  renewal_2_to_renewal_3_cr: 130,
  renewal_2_users: 90,
  renewal_3_users: 90,
  renewal_users: 110,
  refund_users: 100,
  amount_refunded: 120,
  refund_rate: 100,
  gross_revenue: 110,
  net_revenue: 110,
  revenue_d0: 90,
  revenue_d7: 90,
  revenue_d30: 90,
  revenue_d60: 90,
  traffic_spend: 90,
  profit: 90,
  profit_d7: 100,
  profit_1m: 100,
  profit_2m: 100,
  traffic_cac: 90,
  traffic_trial_count: 120,
  traffic_clicks: 90,
  traffic_cpc: 90,
  traffic_cpm: 90,
  traffic_ctr: 90,
  roas_d7: 90,
  roas_1m: 90,
  roas_2m: 90,
};

// Compact defaults — tighter than before for higher data density.
const DEFAULT_COLUMN_WIDTHS: Record<string, number> = (() => {
  const out: Record<string, number> = { [COHORT_FIRST_COL_KEY]: 150 };
  for (const id of DEFAULT_COLUMN_ORDER) {
    const isText = id === "cohort_date" || id === "campaign_path" || id === "funnel";
    out[id] = isText ? Math.max(130, COLUMN_MIN_WIDTHS[id]) : Math.max(MIN_COLUMN_WIDTH, Math.min(100, COLUMN_MIN_WIDTHS[id]));
  }
  return out;
})();

function loadInitialColumnWidths(): Record<string, number> {
  try {
    const saved = localStorage.getItem(COLUMN_WIDTHS_STORAGE_KEY);
    if (!saved) return { ...DEFAULT_COLUMN_WIDTHS };
    const parsed = JSON.parse(saved);
    if (parsed && typeof parsed === "object") {
      return { ...DEFAULT_COLUMN_WIDTHS, ...parsed };
    }
  } catch {
    // fall through
  }
  return { ...DEFAULT_COLUMN_WIDTHS };
}

function persistColumnWidths(widths: Record<string, number>) {
  try {
    localStorage.setItem(COLUMN_WIDTHS_STORAGE_KEY, JSON.stringify(widths));
    markCohortsUiSettingsUpdated();
  } catch (error) {
    console.warn("Unable to persist cohort column widths", error);
  }
}

const TEXT_COLUMNS = new Set<CohortColumnId>(["cohort_date", "campaign_path", "funnel"]);
const SECTION_DIVIDER_COLUMNS = new Set<CohortColumnId>([
  "trial_users",
  "trial_to_upsell_cr",
  "renewal_2_users",
  "refund_users",
  "gross_revenue",
  "revenue_d0",
  "traffic_spend",
  "profit",
  "roas_d7",
]);

function heatStyle(value: number, max: number): React.CSSProperties {
  if (max <= 0) return {};
  const intensity = Math.min(1, value / max);
  return {
    background: `hsl(var(--primary) / ${0.05 + intensity * 0.25})`,
    color: intensity > 0.5 ? "hsl(var(--primary))" : undefined,
    fontVariantNumeric: "tabular-nums",
  };
}

function isValidColumnOrder(value: unknown): value is CohortColumnId[] {
  if (!Array.isArray(value) || value.length !== DEFAULT_COLUMN_ORDER.length) return false;
  const ids = new Set(value);
  return ids.size === DEFAULT_COLUMN_ORDER.length && DEFAULT_COLUMN_ORDER.every((id) => ids.has(id));
}

function loadInitialColumnOrder(): CohortColumnId[] {
  try {
    const saved = localStorage.getItem(COLUMN_ORDER_STORAGE_KEY);
    if (!saved) return [...DEFAULT_COLUMN_ORDER];
    const parsed = JSON.parse(saved);
    return isValidColumnOrder(parsed) ? parsed : [...DEFAULT_COLUMN_ORDER];
  } catch {
    return [...DEFAULT_COLUMN_ORDER];
  }
}

function persistColumnOrder(order: CohortColumnId[]) {
  try {
    localStorage.setItem(COLUMN_ORDER_STORAGE_KEY, JSON.stringify(order));
    markCohortsUiSettingsUpdated();
  } catch (error) {
    console.warn("Unable to persist cohort column order", error);
  }
}

// ---- Column visibility ----
const DEFAULT_HIDDEN: CohortColumnId[] = [];

function defaultColumnVisibility(): Record<CohortColumnId, boolean> {
  return Object.fromEntries(DEFAULT_COLUMN_ORDER.map((id) => [id, !DEFAULT_HIDDEN.includes(id)])) as Record<
    CohortColumnId,
    boolean
  >;
}

function loadInitialVisibility(): Record<CohortColumnId, boolean> {
  const base = defaultColumnVisibility();
  try {
    const saved = localStorage.getItem(COLUMN_VISIBILITY_STORAGE_KEY);
    if (!saved) return base;
    const parsed = JSON.parse(saved);
    if (parsed && typeof parsed === "object") {
      for (const id of DEFAULT_COLUMN_ORDER) {
        if (typeof parsed[id] === "boolean") base[id] = parsed[id];
      }
    }
  } catch {
    /* noop */
  }
  return base;
}

function persistVisibility(v: Record<CohortColumnId, boolean>) {
  try {
    localStorage.setItem(COLUMN_VISIBILITY_STORAGE_KEY, JSON.stringify(v));
    markCohortsUiSettingsUpdated();
  } catch (error) {
    console.warn("Unable to persist cohort column visibility", error);
  }
}

// ---- Saved views ----
interface SavedView {
  id: string;
  name: string;
  order: CohortColumnId[];
  visibility: Record<CohortColumnId, boolean>;
  widths?: Record<string, number>;
  builtin?: boolean;
}

type TrafficAggregate = TrafficMetric & {
  row_count: number;
};

type CohortTraffic = {
  spend: number;
  cac: number;
  trial_count: number;
  clicks: number;
  cpc: number;
  cpm: number | null;
  ctr: number | null;
};

function normalizeCohortDate(date: string): string {
  const trimmed = String(date ?? "").trim();
  const isoMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return trimmed;
  const yyyy = parsed.getFullYear();
  const mm = String(parsed.getMonth() + 1).padStart(2, "0");
  const dd = String(parsed.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function normalizeCohortCampaignPath(campaignPath: string): string {
  return String(campaignPath ?? "")
    .trim()
    .replace(/^["']+|["']+$/g, "")
    .trim()
    .replace(/^\/+/, "")
    .toLowerCase();
}

function trafficKey(date: string, campaignPath: string): string {
  return `${normalizeCohortDate(date)}__${normalizeCampaignPath(campaignPath)}`;
}

function cohortTrafficKey(row: CohortRow): string {
  return `${normalizeCohortDate(row.cohort_date)}__${normalizeCohortCampaignPath(row.campaign_path)}`;
}

function aggregateTrafficMetrics(rows: TrafficMetric[]): Map<string, TrafficAggregate> {
  const map = new Map<string, TrafficAggregate>();
  for (const row of rows) {
    const key = trafficKey(row.date, row.campaign_path);
    const current = map.get(key);
    if (!current) {
      map.set(key, { ...row, row_count: 1 });
      continue;
    }
    current.trial_count += row.trial_count;
    current.spend += row.spend;
    current.clicks += row.clicks;
    current.cac = current.trial_count ? current.spend / current.trial_count : 0;
    current.cpc = current.clicks ? current.spend / current.clicks : 0;
    current.cpm = 0;
    current.ctr = 0;
    current.row_count += 1;
  }
  return map;
}

function trafficForCohort(row: CohortRow, trafficByKey: Map<string, TrafficAggregate>): CohortTraffic | null {
  const traffic = trafficByKey.get(cohortTrafficKey(row));
  if (!traffic) return null;
  return {
    spend: traffic.spend,
    cac: traffic.trial_count ? traffic.spend / traffic.trial_count : traffic.cac,
    trial_count: traffic.trial_count,
    clicks: traffic.clicks,
    cpc: traffic.clicks ? traffic.spend / traffic.clicks : traffic.cpc,
    cpm: traffic.row_count === 1 ? traffic.cpm : null,
    ctr: traffic.row_count === 1 ? traffic.ctr : null,
  };
}

function buildVisibility(visibleIds: CohortColumnId[]): Record<CohortColumnId, boolean> {
  const v = {} as Record<CohortColumnId, boolean>;
  for (const id of DEFAULT_COLUMN_ORDER) v[id] = visibleIds.includes(id);
  return v;
}

const BUILTIN_VIEWS: SavedView[] = [
  {
    id: "default",
    name: "Default",
    order: [...DEFAULT_COLUMN_ORDER],
    visibility: Object.fromEntries(DEFAULT_COLUMN_ORDER.map((id) => [id, true])) as Record<CohortColumnId, boolean>,
    builtin: true,
  },
  {
    id: "revenue",
    name: "Revenue",
    order: [...DEFAULT_COLUMN_ORDER],
    visibility: buildVisibility(["gross_revenue", "net_revenue", "revenue_d0", "revenue_d7", "revenue_d30", "revenue_d60", "traffic_spend", "profit", "profit_d7", "profit_1m", "profit_2m"]),
    builtin: true,
  },
  {
    id: "cancellations",
    name: "Cancellations",
    order: [...DEFAULT_COLUMN_ORDER],
    visibility: buildVisibility(["cancelled_users", "user_cancelled_users", "auto_cancelled_users", "cancellation_rate"]),
    builtin: true,
  },
  {
    id: "active_subs",
    name: "Active Subs",
    order: [...DEFAULT_COLUMN_ORDER],
    visibility: buildVisibility(["active_subscriptions", "active_subscriptions_rate"]),
    builtin: true,
  },
];

function loadCustomViews(): SavedView[] {
  try {
    const raw = localStorage.getItem(SAVED_VIEWS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.flatMap((v) => {
        if (!v || !v.id || !v.name) return [];
        const order = Array.isArray(v.order) ? v.order : Array.isArray(v.columnOrder) ? v.columnOrder : null;
        const visibility = v.visibility ?? v.columnVisibility;
        if (!order || !visibility) return [];
        return [{
          id: v.id,
          name: v.name,
          order,
          visibility,
          widths: v.widths ?? v.columnWidths,
        } as SavedView];
      });
    }
  } catch {
    /* noop */
  }
  return [];
}

function persistCustomViews(views: SavedView[]) {
  try {
    localStorage.setItem(SAVED_VIEWS_STORAGE_KEY, JSON.stringify(views));
    markCohortsUiSettingsUpdated();
  } catch (error) {
    console.warn("Unable to persist cohort saved views", error);
  }
}

function toCloudSavedView(view: SavedView): CohortsUiSavedView {
  return {
    id: view.id,
    name: view.name,
    columnOrder: view.order,
    columnVisibility: view.visibility,
    columnWidths: view.widths,
  };
}

function fromCloudSavedView(view: CohortsUiSavedView): SavedView {
  return {
    id: view.id,
    name: view.name,
    order: view.columnOrder as CohortColumnId[],
    visibility: view.columnVisibility as Record<CohortColumnId, boolean>,
    widths: view.columnWidths,
  };
}

export default function CohortsPage() {
  const txs = useTransactions();
  const subscriptions = useDataStore((s) => s.subscriptions);
  const trafficMetrics = useDataStore((s) => s.trafficMetrics);
  const [uiState, setUiState, resetUiState] = usePersistedPageState("ui_state_cohorts", DEFAULT_COHORTS_UI_STATE);
  const {
    funnelFilter,
    campaignPathFilter,
    trafficSourceFilter,
    campaignIdFilter,
    refundFilter,
    cohortDateFrom,
    cohortDateTo,
    sortColumn,
    sortDirection,
    expandedCohortIds: expandedCohortIdList,
  } = uiState;
  const expandedCohortIds = useMemo(() => new Set(expandedCohortIdList), [expandedCohortIdList]);
  const updateUiState = (patch: Partial<typeof DEFAULT_COHORTS_UI_STATE>) => {
    markCohortsUiSettingsUpdated();
    setUiState((current) => ({ ...current, ...patch }));
  };
  const resetCohortFilters = () => {
    markCohortsUiSettingsUpdated();
    resetUiState();
  };
  const [columnsPopoverOpen, setColumnsPopoverOpen] = useState(false);
  const [viewsPopoverOpen, setViewsPopoverOpen] = useState(false);
  const [columnOrder, setColumnOrder] = useState<CohortColumnId[]>(loadInitialColumnOrder);
  const [columnVisibility, setColumnVisibility] = useState<Record<CohortColumnId, boolean>>(loadInitialVisibility);
  const [customViews, setCustomViews] = useState<SavedView[]>(loadCustomViews);
  const [activeViewId, setActiveViewId] = useState<string | null>(() => {
    try { return localStorage.getItem(ACTIVE_VIEW_STORAGE_KEY); } catch { return null; }
  });
  const [newViewName, setNewViewName] = useState("");
  const dragColRef = useRef<CohortColumnId | null>(null);
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>(loadInitialColumnWidths);
  const resizingRef = useRef<{ key: string; startX: number; startWidth: number } | null>(null);
  const [cohortsUiCloudReady, setCohortsUiCloudReady] = useState(false);
  const [cohortsUiCloudLoading, setCohortsUiCloudLoading] = useState(false);
  const [cohortsUiCloudMessage, setCohortsUiCloudMessage] = useState<string | null>(null);
  const [cohortsUiCloudError, setCohortsUiCloudError] = useState<string | null>(null);
  const skipNextCloudSaveRef = useRef(false);
  const didLoadCloudSettingsRef = useRef(false);

  const cohortsUiSettingsDefaults = useMemo<CohortsUiSettingsDefaults>(
    () => ({
      defaultColumnOrder: DEFAULT_COLUMN_ORDER,
      defaultColumnWidths: DEFAULT_COLUMN_WIDTHS,
      defaultColumnVisibility: defaultColumnVisibility(),
      defaultFilters: DEFAULT_COHORTS_UI_STATE,
      validWidthKeys: [COHORT_FIRST_COL_KEY, ...DEFAULT_COLUMN_ORDER],
      validSelectedViewIds: BUILTIN_VIEWS.map((view) => view.id),
      defaultSelectedView: "default",
      validSortColumnIds: [COHORT_FIRST_COL_KEY, ...DEFAULT_COLUMN_ORDER],
    }),
    [],
  );

  const startResize = useCallback((key: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startWidth = columnWidths[key] ?? DEFAULT_COLUMN_WIDTHS[key] ?? 100;
    resizingRef.current = { key, startX: e.clientX, startWidth };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, [columnWidths]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const r = resizingRef.current;
      if (!r) return;
      const next = Math.max(MIN_COLUMN_WIDTH, r.startWidth + (e.clientX - r.startX));
      setColumnWidths((cur) => (cur[r.key] === next ? cur : { ...cur, [r.key]: next }));
    };
    const onUp = () => {
      if (!resizingRef.current) return;
      resizingRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setColumnWidths((cur) => {
        persistColumnWidths(cur);
        return cur;
      });
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  const autoFitColumn = useCallback((key: string) => {
    setColumnWidths((cur) => {
      const next = { ...cur, [key]: DEFAULT_COLUMN_WIDTHS[key] ?? 100 };
      persistColumnWidths(next);
      return next;
    });
  }, []);

  const resetColumnWidths = useCallback(() => {
    setColumnWidths({ ...DEFAULT_COLUMN_WIDTHS });
    try {
      localStorage.removeItem(COLUMN_WIDTHS_STORAGE_KEY);
      markCohortsUiSettingsUpdated();
    } catch (error) {
      console.warn("Unable to reset cohort column widths", error);
    }
  }, []);

  const applyCohortsUiSettings = useCallback(
    (payload: CohortsUiSettingsPayload) => {
      const sanitized = sanitizeCohortsUiSettingsPayload(payload, cohortsUiSettingsDefaults);
      if (!sanitized) return false;

      skipNextCloudSaveRef.current = true;
      writeLocalCohortsUiSettings(sanitized);
      setColumnOrder(sanitized.columnOrder as CohortColumnId[]);
      setColumnVisibility(sanitized.columnVisibility as Record<CohortColumnId, boolean>);
      setColumnWidths(sanitized.columnWidths);
      const nextCustomViews = sanitized.savedViews.map(fromCloudSavedView);
      setCustomViews(nextCustomViews);
      setUiState({ ...DEFAULT_COHORTS_UI_STATE, ...sanitized.filters });
      setActiveViewId(sanitized.selectedView);
      return true;
    },
    [cohortsUiSettingsDefaults, setUiState],
  );

  const buildCurrentCohortsUiSettings = useCallback(
    (updatedAt = new Date().toISOString()) =>
      buildCohortsUiSettingsPayload(
        {
          columnOrder,
          columnWidths,
          columnVisibility,
          selectedView: activeViewId,
          savedViews: customViews.map(toCloudSavedView),
          filters: uiState,
          sortColumn: uiState.sortColumn,
          sortDirection: uiState.sortDirection,
          updatedAt,
        },
        cohortsUiSettingsDefaults,
      ),
    [activeViewId, cohortsUiSettingsDefaults, columnOrder, columnVisibility, columnWidths, customViews, uiState],
  );

  const saveCohortsUiSettingsToCloud = useCallback(
    async (payload = buildCurrentCohortsUiSettings()) => {
      return saveCohortsUiSettingsCloud(payload);
    },
    [buildCurrentCohortsUiSettings],
  );

  const onSaveCohortsViewToCloud = async () => {
    try {
      setCohortsUiCloudLoading(true);
      setCohortsUiCloudError(null);
      const payload = buildCurrentCohortsUiSettings();
      writeLocalCohortsUiSettings(payload);
      const info = await saveCohortsUiSettingsToCloud(payload);
      setCohortsUiCloudMessage(
        info ? "Cohorts view saved to cloud." : "Sign in with Supabase to save Cohorts view to cloud.",
      );
    } catch (error) {
      setCohortsUiCloudError(error instanceof Error ? error.message : "Could not save Cohorts view to cloud.");
    } finally {
      setCohortsUiCloudLoading(false);
    }
  };

  const onLoadCohortsViewFromCloud = async () => {
    try {
      setCohortsUiCloudLoading(true);
      setCohortsUiCloudError(null);
      const payload = await loadCohortsUiSettingsCloud(cohortsUiSettingsDefaults);
      if (!payload) {
        setCohortsUiCloudMessage("No valid Cohorts cloud view found.");
        return;
      }
      applyCohortsUiSettings(payload);
      setCohortsUiCloudMessage("Cohorts view loaded from cloud.");
    } catch (error) {
      setCohortsUiCloudError(error instanceof Error ? error.message : "Could not load Cohorts view from cloud.");
    } finally {
      setCohortsUiCloudLoading(false);
    }
  };

  useEffect(() => {
    if (didLoadCloudSettingsRef.current) return;
    didLoadCloudSettingsRef.current = true;

    let mounted = true;

    async function restoreCohortsUiSettings() {
      try {
        const local = readLocalCohortsUiSettings(cohortsUiSettingsDefaults);
        const cloud = await loadCohortsUiSettingsCloud(cohortsUiSettingsDefaults).catch((error) => {
          console.warn("Could not load Cohorts UI settings cloud snapshot.", error);
          return null;
        });
        if (!mounted) return;

        const merged = mergeCohortsUiSettings(local, cloud);
        if (merged.source === "cloud" && merged.settings) {
          applyCohortsUiSettings(merged.settings);
          setCohortsUiCloudMessage("Cohorts view loaded from cloud.");
        } else if (merged.source === "local" && merged.settings && cloud) {
          void saveCohortsUiSettingsToCloud(merged.settings).catch((error) =>
            console.warn("Could not sync local Cohorts UI settings to cloud.", error),
          );
        } else if (merged.source === "local" && merged.settings && !cloud) {
          void saveCohortsUiSettingsToCloud(merged.settings).catch((error) =>
            console.warn("Could not save local Cohorts UI settings to cloud.", error),
          );
        }
      } finally {
        if (mounted) {
          skipNextCloudSaveRef.current = true;
          setCohortsUiCloudReady(true);
        }
      }
    }

    void restoreCohortsUiSettings();

    return () => {
      mounted = false;
    };
  }, [applyCohortsUiSettings, cohortsUiSettingsDefaults, saveCohortsUiSettingsToCloud]);

  useEffect(() => {
    if (!cohortsUiCloudReady) return;
    if (skipNextCloudSaveRef.current) {
      skipNextCloudSaveRef.current = false;
      return;
    }

    const payload = buildCurrentCohortsUiSettings();
    writeLocalCohortsUiSettings(payload);
    setCohortsUiCloudMessage("Saved locally");
    setCohortsUiCloudError(null);

    const timer = window.setTimeout(() => {
      void saveCohortsUiSettingsToCloud(payload)
        .then((info) => {
          if (info) setCohortsUiCloudMessage("Synced to cloud");
        })
        .catch((error) => {
          console.warn("Could not debounce-save Cohorts UI settings to cloud.", error);
          setCohortsUiCloudError("Cloud sync failed");
        });
    }, 800);

    return () => window.clearTimeout(timer);
  }, [buildCurrentCohortsUiSettings, cohortsUiCloudReady, saveCohortsUiSettingsToCloud]);

  const trafficSourceOptions = useMemo(() => Array.from(new Set(txs.map((t) => t.traffic_source))).sort(), [txs]);
  const campaignIdOptions = useMemo(() => Array.from(new Set(txs.map((t) => t.campaign_id || "unknown"))).sort(), [txs]);
  const sourceFilteredTxs = useMemo(
    () =>
      txs.filter((t) => {
        if (trafficSourceFilter !== "all" && t.traffic_source !== trafficSourceFilter) return false;
        if (campaignIdFilter !== "all" && (t.campaign_id || "unknown") !== campaignIdFilter) return false;
        return true;
      }),
    [txs, trafficSourceFilter, campaignIdFilter]
  );
  const allCohorts = useMemo(() => computeCohorts(sourceFilteredTxs, subscriptions), [sourceFilteredTxs, subscriptions]);
  const trafficByKey = useMemo(() => aggregateTrafficMetrics(trafficMetrics), [trafficMetrics]);
  const funnelOptions = useMemo(() => Array.from(new Set(allCohorts.map((c) => c.funnel))).sort(), [allCohorts]);
  const campaignPathOptions = useMemo(() => Array.from(new Set(allCohorts.map((c) => c.campaign_path))).sort(), [allCohorts]);
  const filteredCohorts = useMemo(
    () =>
      allCohorts.filter((c) => {
        if (funnelFilter !== "all" && c.funnel !== funnelFilter) return false;
        if (campaignPathFilter !== "all" && c.campaign_path !== campaignPathFilter) return false;
        if (refundFilter === "has" && c.refund_users === 0) return false;
        if (refundFilter === "none" && c.refund_users > 0) return false;
        if (cohortDateFrom && c.cohort_date < cohortDateFrom) return false;
        if (cohortDateTo && c.cohort_date > cohortDateTo) return false;
        return true;
      }),
    [allCohorts, funnelFilter, campaignPathFilter, refundFilter, cohortDateFrom, cohortDateTo]
  );
  const cohorts = useMemo(
    () => {
      if (sortColumn && sortDirection) {
        return sortCohortRows(
          filteredCohorts,
          { sortColumn, sortDirection },
          (cohort) => trafficForCohort(cohort, trafficByKey),
        );
      }

      return [...filteredCohorts].sort((a, b) => {
        const cmp = a.cohort_date < b.cohort_date ? -1 : a.cohort_date > b.cohort_date ? 1 : 0;
        return -cmp;
      });
    },
    [filteredCohorts, sortColumn, sortDirection, trafficByKey]
  );
  const hasUsers = useMemo(() => new Set(txs.map((t) => t.user_id)).size > 0, [txs]);
  const toggleExpanded = (cohortId: string) => {
    markCohortsUiSettingsUpdated();
    setUiState((current) => {
      const next = new Set(current.expandedCohortIds);
      if (next.has(cohortId)) next.delete(cohortId);
      else next.add(cohortId);
      return { ...current, expandedCohortIds: Array.from(next) };
    });
  };
  const moveColumn = (index: number, direction: -1 | 1) => {
    setColumnOrder((current) => {
      const nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= current.length) return current;
      const next = [...current];
      [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
      persistColumnOrder(next);
      return next;
    });
  };
  const resetColumnOrder = () => {
    const next = [...DEFAULT_COLUMN_ORDER];
    setColumnOrder(next);
    try {
      localStorage.removeItem(COLUMN_ORDER_STORAGE_KEY);
    } catch (error) {
      console.warn("Unable to reset cohort column order", error);
    }
    resetColumnWidths();
  };

  const allViews = useMemo<SavedView[]>(() => [...BUILTIN_VIEWS, ...customViews], [customViews]);
  const activeView = useMemo(() => allViews.find((v) => v.id === activeViewId) ?? null, [allViews, activeViewId]);

  const setVisibility = (id: CohortColumnId, value: boolean) => {
    setColumnVisibility((cur) => {
      const next = { ...cur, [id]: value };
      persistVisibility(next);
      return next;
    });
    setActiveViewId(null);
    try { localStorage.removeItem(ACTIVE_VIEW_STORAGE_KEY); } catch { /* noop */ }
    markCohortsUiSettingsUpdated();
  };

  const applyView = (view: SavedView) => {
    setColumnOrder(view.order);
    setColumnVisibility(view.visibility);
    persistColumnOrder(view.order);
    persistVisibility(view.visibility);
    if (view.widths) {
      setColumnWidths(view.widths);
      persistColumnWidths(view.widths);
    }
    setActiveViewId(view.id);
    try { localStorage.setItem(ACTIVE_VIEW_STORAGE_KEY, view.id); } catch { /* noop */ }
    markCohortsUiSettingsUpdated();
  };

  const resetToDefault = () => {
    applyView(BUILTIN_VIEWS[0]);
    resetColumnWidths();
    updateUiState({ sortColumn: null, sortDirection: null });
    markCohortsUiSettingsUpdated();
  };

  const saveCurrentAsView = () => {
    const name = newViewName.trim();
    if (!name) return;
    const view: SavedView = {
      id: `custom_${Date.now()}`,
      name,
      order: [...columnOrder],
      visibility: { ...columnVisibility },
      widths: { ...columnWidths },
    };
    const next = [...customViews, view];
    setCustomViews(next);
    persistCustomViews(next);
    setActiveViewId(view.id);
    try { localStorage.setItem(ACTIVE_VIEW_STORAGE_KEY, view.id); } catch { /* noop */ }
    markCohortsUiSettingsUpdated();
    setNewViewName("");
  };

  const deleteView = (id: string) => {
    const next = customViews.filter((v) => v.id !== id);
    setCustomViews(next);
    persistCustomViews(next);
    if (activeViewId === id) {
      setActiveViewId(null);
      try { localStorage.removeItem(ACTIVE_VIEW_STORAGE_KEY); } catch { /* noop */ }
      markCohortsUiSettingsUpdated();
    }
  };

  const onHeaderDragStart = (id: CohortColumnId) => {
    dragColRef.current = id;
  };
  const onHeaderDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };
  const onHeaderDrop = (targetId: CohortColumnId) => {
    const src = dragColRef.current;
    dragColRef.current = null;
    if (!src || src === targetId) return;
    setColumnOrder((cur) => {
      const next = [...cur];
      const from = next.indexOf(src);
      const to = next.indexOf(targetId);
      if (from < 0 || to < 0) return cur;
      next.splice(from, 1);
      next.splice(to, 0, src);
      persistColumnOrder(next);
      return next;
    });
    setActiveViewId(null);
    try { localStorage.removeItem(ACTIVE_VIEW_STORAGE_KEY); } catch { /* noop */ }
    markCohortsUiSettingsUpdated();
  };

  const visibleColumnOrder = useMemo(
    () => columnOrder.filter((id) => columnVisibility[id] !== false),
    [columnOrder, columnVisibility],
  );

  const maxUpsellCR = Math.max(0, ...cohorts.map((c) => c.trial_to_upsell_cr));
  const maxSubCR = Math.max(0, ...cohorts.map((c) => c.trial_to_first_subscription_cr));
  const maxRenewal2CR = Math.max(0, ...cohorts.map((c) => c.first_subscription_to_renewal_2_cr));
  const maxRenewal3CR = Math.max(0, ...cohorts.map((c) => c.renewal_2_to_renewal_3_cr));
  const totals = useMemo(() => {
    const sum = (pick: (c: (typeof cohorts)[number]) => number) =>
      cohorts.reduce((total, cohort) => total + pick(cohort), 0);
    const totalTrialUsers = sum((c) => c.trial_users);
    const totalUpsellUsers = sum((c) => c.upsell_users);
    const totalFirstSubscriptionUsers = sum((c) => c.first_subscription_users);
    const totalRenewal2Users = sum((c) => c.renewal_2_users);
    const totalRenewal3Users = sum((c) => c.renewal_3_users);
    const totalRenewalUsers = sum((c) => c.renewal_users);
    const totalRefundUsers = new Set(cohorts.flatMap((c) => c.refunded_user_ids)).size;
    const totalActiveUsers = new Set(cohorts.flatMap((c) => c.active_user_ids)).size;
    const totalActiveSubscriptions = new Set(cohorts.flatMap((c) => c.active_subscription_user_ids)).size;
    const totalCancelledUsers = new Set(cohorts.flatMap((c) => c.cancelled_user_ids)).size;
    const totalUserCancelledUsers = new Set(cohorts.flatMap((c) => c.user_cancelled_user_ids)).size;
    const totalAutoCancelledUsers = new Set(cohorts.flatMap((c) => c.auto_cancelled_user_ids)).size;
    const totalCancelledActiveUsers = new Set(cohorts.flatMap((c) => c.cancelled_active_user_ids)).size;
    const amountRefunded = sum((c) => c.amount_refunded);
    const grossRevenue = sum((c) => c.gross_revenue);
    const netRevenue = sum((c) => c.net_revenue);
    const trafficRows = cohorts.map((c) => trafficForCohort(c, trafficByKey)).filter(Boolean) as CohortTraffic[];
    const hasTrafficSpend = trafficRows.length > 0;
    const hasCompleteTrafficSpend = cohorts.length > 0 && trafficRows.length === cohorts.length;
    const totalTrafficSpend = trafficRows.reduce((total, traffic) => total + traffic.spend, 0);
    const totalTrafficTrials = trafficRows.reduce((total, traffic) => total + traffic.trial_count, 0);
    const totalTrafficClicks = trafficRows.reduce((total, traffic) => total + traffic.clicks, 0);
    const totalRevenueD7 = sum((c) => c.revenue_d7);
    const totalRevenueD30 = sum((c) => c.revenue_d30);
    const totalRevenueD60 = sum((c) => c.revenue_d60);
    return {
      totalTrialUsers,
      totalUpsellUsers,
      totalFirstSubscriptionUsers,
      totalRenewal2Users,
      totalRenewal3Users,
      totalRenewalUsers,
      totalRefundUsers,
      totalActiveUsers,
      totalActiveSubscriptions,
      totalCancelledUsers,
      totalUserCancelledUsers,
      totalAutoCancelledUsers,
      totalCancelledActiveUsers,
      totalActiveRate: totalTrialUsers ? (totalActiveUsers / totalTrialUsers) * 100 : 0,
      totalActiveSubscriptionsRate: totalTrialUsers ? (totalActiveSubscriptions / totalTrialUsers) * 100 : 0,
      totalCancellationRate: totalTrialUsers ? (totalCancelledUsers / totalTrialUsers) * 100 : 0,
      totalUserCancelRate: totalTrialUsers ? (totalUserCancelledUsers / totalTrialUsers) * 100 : 0,
      totalAutoCancelRate: totalTrialUsers ? (totalAutoCancelledUsers / totalTrialUsers) * 100 : 0,
      trialRevenue: sum((c) => c.trial_revenue),
      upsellRevenue: sum((c) => c.upsell_revenue),
      firstSubscriptionRevenue: sum((c) => c.first_subscription_revenue),
      renewalRevenue: sum((c) => c.renewal_revenue),
      amountRefunded,
      refundRate: totalTrialUsers ? (totalRefundUsers / totalTrialUsers) * 100 : 0,
      grossRevenue,
      netRevenue,
      revenueD0: sum((c) => c.revenue_d0),
      revenueD7: totalRevenueD7,
      revenueD30: totalRevenueD30,
      revenueD60: totalRevenueD60,
      trafficSpend: totalTrafficSpend,
      hasTrafficSpend,
      hasCompleteTrafficSpend,
      profit: netRevenue - totalTrafficSpend,
      profitD7: totalRevenueD7 - totalTrafficSpend,
      profit1m: totalRevenueD30 - totalTrafficSpend,
      profit2m: totalRevenueD60 - totalTrafficSpend,
      trafficTrials: totalTrafficTrials,
      trafficClicks: totalTrafficClicks,
      trafficCac: totalTrafficTrials ? totalTrafficSpend / totalTrafficTrials : 0,
      trafficCpc: totalTrafficClicks ? totalTrafficSpend / totalTrafficClicks : 0,
      roasD7: totalTrafficSpend ? totalRevenueD7 / totalTrafficSpend : 0,
      roas1m: totalTrafficSpend ? totalRevenueD30 / totalTrafficSpend : 0,
      roas2m: totalTrafficSpend ? totalRevenueD60 / totalTrafficSpend : 0,
      trialToUpsellCr: totalTrialUsers ? (totalUpsellUsers / totalTrialUsers) * 100 : 0,
      trialToFirstSubscriptionCr: totalTrialUsers ? (totalFirstSubscriptionUsers / totalTrialUsers) * 100 : 0,
      firstSubscriptionToRenewal2Cr: totalFirstSubscriptionUsers ? (totalRenewal2Users / totalFirstSubscriptionUsers) * 100 : 0,
      renewal2ToRenewal3Cr: totalRenewal2Users ? (totalRenewal3Users / totalRenewal2Users) * 100 : 0,
    };
  }, [cohorts, trafficByKey]);

  const headerClassFor = (id: CohortColumnId) =>
    `${TEXT_COLUMNS.has(id) ? `${HEAD_BASE} text-left` : HEAD_NUM} ${SECTION_DIVIDER_COLUMNS.has(id) ? SECTION_DIVIDER : ""}`;
  const cellClassFor = (id: CohortColumnId, child = false) => {
    const base = child
      ? TEXT_COLUMNS.has(id)
        ? "py-1.5 px-3 text-xs text-muted-foreground/60 whitespace-nowrap"
        : "py-1.5 px-3 text-right text-xs text-muted-foreground tabular-nums whitespace-nowrap"
      : TEXT_COLUMNS.has(id)
        ? CELL_TXT
        : CELL_NUM;
    return `${base} ${SECTION_DIVIDER_COLUMNS.has(id) ? SECTION_DIVIDER : ""}`;
  };
  const dash = <span className="text-muted-foreground/40">—</span>;
  const formatRoas = (value: number) => `${value.toFixed(2)}x`;
  const sortState = useMemo(() => ({ sortColumn, sortDirection }), [sortColumn, sortDirection]);
  const onSortColumn = (id: string) => {
    updateUiState(nextCohortSortState(sortState, id));
  };
  const sortIcon = (id: string) => {
    if (sortColumn !== id || !sortDirection) return <ArrowUpDown className="h-3 w-3 opacity-35" />;
    return sortDirection === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />;
  };

  const renderHeaderCell = (id: CohortColumnId) => (
    <TableHead
      key={id}
      className={headerClassFor(id)}
      style={{ width: columnWidths[id], minWidth: MIN_COLUMN_WIDTH }}
      draggable
      onDragStart={() => onHeaderDragStart(id)}
      onDragOver={onHeaderDragOver}
      onDrop={() => onHeaderDrop(id)}
    >
      <button
        type="button"
        onClick={() => onSortColumn(id)}
        className="inline-flex max-w-full items-center gap-1 hover:text-foreground"
        aria-label={`Sort by ${COLUMN_LABELS[id]}`}
      >
        <GripVertical className="h-3 w-3 shrink-0 cursor-grab opacity-40 active:cursor-grabbing" />
        <span className="truncate">{COLUMN_LABELS[id]}</span>
        {sortIcon(id)}
      </button>
      <div
        role="separator"
        aria-orientation="vertical"
        onMouseDown={(e) => startResize(id, e)}
        onDoubleClick={() => autoFitColumn(id)}
        title="Drag to resize · double-click to reset"
        className="absolute top-0 right-0 h-full w-1.5 -mr-px cursor-col-resize hover:bg-primary/40 active:bg-primary"
      />
    </TableHead>
  );

  const renderCohortCell = (id: CohortColumnId, c: CohortRow) => {
    const className = cellClassFor(id);
    const traffic = trafficForCohort(c, trafficByKey);
    switch (id) {
      case "cohort_date":
        return <TableCell key={id} className={`${className} tabular-nums`}>{c.cohort_date}</TableCell>;
      case "campaign_path":
        return <TableCell key={id} className={className}>{c.campaign_path}</TableCell>;
      case "funnel":
        return <TableCell key={id} className={`${className} capitalize`}>{c.funnel.replace("_", " ")}</TableCell>;
      case "trial_users":
        return <TableCell key={id} className={className}>{c.trial_users}</TableCell>;
      case "active_users":
        return <TableCell key={id} className={className}>{c.active_users}</TableCell>;
      case "active_subscriptions":
        return <TableCell key={id} className={className}>{c.active_subscriptions}</TableCell>;
      case "active_subscriptions_rate":
        return <TableCell key={id} className={className}>{formatPct(c.active_subscriptions_rate)}</TableCell>;
      case "active_rate":
        return <TableCell key={id} className={className}>{formatPct(c.active_rate)}</TableCell>;
      case "cancelled_users":
        return <TableCell key={id} className={className}>{c.cancelled_users}</TableCell>;
      case "user_cancelled_users":
        return <TableCell key={id} className={className}>{c.user_cancelled_users}</TableCell>;
      case "user_cancel_rate":
        return <TableCell key={id} className={className}>{formatPct(c.user_cancel_rate)}</TableCell>;
      case "auto_cancelled_users":
        return <TableCell key={id} className={className}>{c.auto_cancelled_users}</TableCell>;
      case "auto_cancel_rate":
        return <TableCell key={id} className={className}>{formatPct(c.auto_cancel_rate)}</TableCell>;
      case "cancellation_rate":
        return <TableCell key={id} className={className}>{formatPct(c.cancellation_rate)}</TableCell>;
      case "cancelled_active_users":
        return <TableCell key={id} className={className}>{c.cancelled_active_users}</TableCell>;
      case "upsell_users":
        return <TableCell key={id} className={className}>{c.upsell_users}</TableCell>;
      case "first_subscription_users":
        return <TableCell key={id} className={className}>{c.first_subscription_users}</TableCell>;
      case "trial_to_upsell_cr":
        return <TableCell key={id} className={`${className} font-medium`} style={heatStyle(c.trial_to_upsell_cr, maxUpsellCR)}>{formatPct(c.trial_to_upsell_cr)}</TableCell>;
      case "trial_to_first_subscription_cr":
        return <TableCell key={id} className={`${className} font-medium`} style={heatStyle(c.trial_to_first_subscription_cr, maxSubCR)}>{formatPct(c.trial_to_first_subscription_cr)}</TableCell>;
      case "first_subscription_to_renewal_2_cr":
        return <TableCell key={id} className={`${className} font-medium`} style={heatStyle(c.first_subscription_to_renewal_2_cr, maxRenewal2CR)}>{formatPct(c.first_subscription_to_renewal_2_cr)}</TableCell>;
      case "renewal_2_to_renewal_3_cr":
        return <TableCell key={id} className={`${className} font-medium`} style={heatStyle(c.renewal_2_to_renewal_3_cr, maxRenewal3CR)}>{formatPct(c.renewal_2_to_renewal_3_cr)}</TableCell>;
      case "renewal_2_users":
        return <TableCell key={id} className={className}>{c.renewal_2_users}</TableCell>;
      case "renewal_3_users":
        return <TableCell key={id} className={className}>{c.renewal_3_users}</TableCell>;
      case "renewal_users":
        return <TableCell key={id} className={className}>{c.renewal_users}</TableCell>;
      case "refund_users":
        return <TableCell key={id} className={className}>{c.refund_users}</TableCell>;
      case "amount_refunded":
        return <TableCell key={id} className={className}>{formatCurrency(c.amount_refunded)}</TableCell>;
      case "refund_rate":
        return <TableCell key={id} className={className}>{formatPct(c.refund_rate)}</TableCell>;
      case "gross_revenue":
        return <TableCell key={id} className={className}>{formatCurrency(c.gross_revenue)}</TableCell>;
      case "net_revenue":
        return <TableCell key={id} className={className}>{formatCurrency(c.net_revenue)}</TableCell>;
      case "revenue_d0":
        return <TableCell key={id} className={className}>{formatCurrency(c.revenue_d0)}</TableCell>;
      case "revenue_d7":
        return <TableCell key={id} className={className}>{formatCurrency(c.revenue_d7)}</TableCell>;
      case "revenue_d30":
        return <TableCell key={id} className={className}>{formatCurrency(c.revenue_d30)}</TableCell>;
      case "revenue_d60":
        return <TableCell key={id} className={className}>{formatCurrency(c.revenue_d60)}</TableCell>;
      case "traffic_spend":
        return <TableCell key={id} className={className}>{traffic ? formatCurrency(traffic.spend) : dash}</TableCell>;
      case "profit":
        return <TableCell key={id} className={className}>{traffic ? formatCurrency(c.net_revenue - traffic.spend) : dash}</TableCell>;
      case "profit_d7":
        return <TableCell key={id} className={className}>{traffic ? formatCurrency(c.revenue_d7 - traffic.spend) : dash}</TableCell>;
      case "profit_1m":
        return <TableCell key={id} className={className}>{traffic ? formatCurrency(c.revenue_d30 - traffic.spend) : dash}</TableCell>;
      case "profit_2m":
        return <TableCell key={id} className={className}>{traffic ? formatCurrency(c.revenue_d60 - traffic.spend) : dash}</TableCell>;
      case "traffic_cac":
        return <TableCell key={id} className={className}>{traffic ? formatCurrency(traffic.cac) : dash}</TableCell>;
      case "traffic_trial_count":
        return <TableCell key={id} className={className}>{traffic ? traffic.trial_count : dash}</TableCell>;
      case "traffic_clicks":
        return <TableCell key={id} className={className}>{traffic ? traffic.clicks : dash}</TableCell>;
      case "traffic_cpc":
        return <TableCell key={id} className={className}>{traffic ? formatCurrency(traffic.cpc) : dash}</TableCell>;
      case "traffic_cpm":
        return <TableCell key={id} className={className}>{traffic?.cpm != null ? formatCurrency(traffic.cpm) : dash}</TableCell>;
      case "traffic_ctr":
        return <TableCell key={id} className={className}>{traffic?.ctr != null ? formatPct(traffic.ctr) : dash}</TableCell>;
      case "roas_d7":
        return <TableCell key={id} className={className}>{traffic?.spend ? formatRoas(c.revenue_d7 / traffic.spend) : dash}</TableCell>;
      case "roas_1m":
        return <TableCell key={id} className={className}>{traffic?.spend ? formatRoas(c.revenue_d30 / traffic.spend) : dash}</TableCell>;
      case "roas_2m":
        return <TableCell key={id} className={className}>{traffic?.spend ? formatRoas(c.revenue_d60 / traffic.spend) : dash}</TableCell>;
    }
  };

  const renderPlanCell = (id: CohortColumnId, plan: PlanBreakdownRow) => {
    const className = cellClassFor(id, true);
    switch (id) {
      case "cohort_date":
      case "campaign_path":
      case "funnel":
        return <TableCell key={id} className={className}>{dash}</TableCell>;
      case "trial_users":
        return <TableCell key={id} className={className}>{plan.trial_users}</TableCell>;
      case "active_users":
        return <TableCell key={id} className={className}>{plan.active_users}</TableCell>;
      case "active_subscriptions":
        return <TableCell key={id} className={className}>{plan.active_subscriptions}</TableCell>;
      case "active_subscriptions_rate":
        return <TableCell key={id} className={className}>{formatPct(plan.active_subscriptions_rate)}</TableCell>;
      case "active_rate":
        return <TableCell key={id} className={className}>{formatPct(plan.active_rate)}</TableCell>;
      case "cancelled_users":
        return <TableCell key={id} className={className}>{plan.cancelled_users}</TableCell>;
      case "user_cancelled_users":
        return <TableCell key={id} className={className}>{plan.user_cancelled_users}</TableCell>;
      case "user_cancel_rate":
        return <TableCell key={id} className={className}>{formatPct(plan.user_cancel_rate)}</TableCell>;
      case "auto_cancelled_users":
        return <TableCell key={id} className={className}>{plan.auto_cancelled_users}</TableCell>;
      case "auto_cancel_rate":
        return <TableCell key={id} className={className}>{formatPct(plan.auto_cancel_rate)}</TableCell>;
      case "cancellation_rate":
        return <TableCell key={id} className={className}>{formatPct(plan.cancellation_rate)}</TableCell>;
      case "cancelled_active_users":
        return <TableCell key={id} className={className}>{dash}</TableCell>;
      case "upsell_users":
        return <TableCell key={id} className={className}>{plan.upsell_users}</TableCell>;
      case "first_subscription_users":
        return <TableCell key={id} className={className}>{plan.first_subscription_users}</TableCell>;
      case "trial_to_upsell_cr":
        return <TableCell key={id} className={className}>{formatPct(plan.trial_to_upsell_cr)}</TableCell>;
      case "trial_to_first_subscription_cr":
        return <TableCell key={id} className={className}>{formatPct(plan.trial_to_first_subscription_cr)}</TableCell>;
      case "first_subscription_to_renewal_2_cr":
        return <TableCell key={id} className={className}>{formatPct(plan.first_subscription_to_renewal_2_cr)}</TableCell>;
      case "renewal_2_to_renewal_3_cr":
        return <TableCell key={id} className={className}>{formatPct(plan.renewal_2_to_renewal_3_cr)}</TableCell>;
      case "renewal_2_users":
        return <TableCell key={id} className={className}>{plan.renewal_2_users}</TableCell>;
      case "renewal_3_users":
        return <TableCell key={id} className={className}>{plan.renewal_3_users}</TableCell>;
      case "renewal_users":
        return <TableCell key={id} className={className}>{plan.renewal_users}</TableCell>;
      case "refund_users":
        return <TableCell key={id} className={className}>{plan.refund_users}</TableCell>;
      case "amount_refunded":
        return <TableCell key={id} className={className}>{formatCurrency(plan.amount_refunded)}</TableCell>;
      case "refund_rate":
        return <TableCell key={id} className={className}>{formatPct(plan.refund_rate)}</TableCell>;
      case "gross_revenue":
        return <TableCell key={id} className={className}>{formatCurrency(plan.gross_revenue)}</TableCell>;
      case "net_revenue":
        return <TableCell key={id} className={className}>{formatCurrency(plan.net_revenue)}</TableCell>;
      case "revenue_d0":
        return <TableCell key={id} className={className}>{formatCurrency(plan.revenue_d0)}</TableCell>;
      case "revenue_d7":
        return <TableCell key={id} className={className}>{formatCurrency(plan.revenue_d7)}</TableCell>;
      case "revenue_d30":
        return <TableCell key={id} className={className}>{formatCurrency(plan.revenue_d30)}</TableCell>;
      case "revenue_d60":
        return <TableCell key={id} className={className}>{formatCurrency(plan.revenue_d60)}</TableCell>;
      case "traffic_spend":
      case "profit":
      case "profit_d7":
      case "profit_1m":
      case "profit_2m":
      case "traffic_cac":
      case "traffic_trial_count":
      case "traffic_clicks":
      case "traffic_cpc":
      case "traffic_cpm":
      case "traffic_ctr":
      case "roas_d7":
      case "roas_1m":
      case "roas_2m":
        return <TableCell key={id} className={className}>{dash}</TableCell>;
    }
  };

  const renderTotalCell = (id: CohortColumnId) => {
    const className = cellClassFor(id);
    switch (id) {
      case "cohort_date":
      case "campaign_path":
      case "funnel":
        return <TableCell key={id} className={className}>—</TableCell>;
      case "trial_users":
        return <TableCell key={id} className={className}>{totals.totalTrialUsers}</TableCell>;
      case "active_users":
        return <TableCell key={id} className={className}>{totals.totalActiveUsers}</TableCell>;
      case "active_subscriptions":
        return <TableCell key={id} className={className}>{totals.totalActiveSubscriptions}</TableCell>;
      case "active_subscriptions_rate":
        return <TableCell key={id} className={className}>{formatPct(totals.totalActiveSubscriptionsRate)}</TableCell>;
      case "active_rate":
        return <TableCell key={id} className={className}>{formatPct(totals.totalActiveRate)}</TableCell>;
      case "cancelled_users":
        return <TableCell key={id} className={className}>{totals.totalCancelledUsers}</TableCell>;
      case "user_cancelled_users":
        return <TableCell key={id} className={className}>{totals.totalUserCancelledUsers}</TableCell>;
      case "user_cancel_rate":
        return <TableCell key={id} className={className}>{formatPct(totals.totalUserCancelRate)}</TableCell>;
      case "auto_cancelled_users":
        return <TableCell key={id} className={className}>{totals.totalAutoCancelledUsers}</TableCell>;
      case "auto_cancel_rate":
        return <TableCell key={id} className={className}>{formatPct(totals.totalAutoCancelRate)}</TableCell>;
      case "cancellation_rate":
        return <TableCell key={id} className={className}>{formatPct(totals.totalCancellationRate)}</TableCell>;
      case "cancelled_active_users":
        return <TableCell key={id} className={className}>{totals.totalCancelledActiveUsers}</TableCell>;
      case "upsell_users":
        return <TableCell key={id} className={className}>{totals.totalUpsellUsers}</TableCell>;
      case "first_subscription_users":
        return <TableCell key={id} className={className}>{totals.totalFirstSubscriptionUsers}</TableCell>;
      case "trial_to_upsell_cr":
        return <TableCell key={id} className={className}>{formatPct(totals.trialToUpsellCr)}</TableCell>;
      case "trial_to_first_subscription_cr":
        return <TableCell key={id} className={className}>{formatPct(totals.trialToFirstSubscriptionCr)}</TableCell>;
      case "first_subscription_to_renewal_2_cr":
        return <TableCell key={id} className={className}>{formatPct(totals.firstSubscriptionToRenewal2Cr)}</TableCell>;
      case "renewal_2_to_renewal_3_cr":
        return <TableCell key={id} className={className}>{formatPct(totals.renewal2ToRenewal3Cr)}</TableCell>;
      case "renewal_2_users":
        return <TableCell key={id} className={className}>{totals.totalRenewal2Users}</TableCell>;
      case "renewal_3_users":
        return <TableCell key={id} className={className}>{totals.totalRenewal3Users}</TableCell>;
      case "renewal_users":
        return <TableCell key={id} className={className}>{totals.totalRenewalUsers}</TableCell>;
      case "refund_users":
        return <TableCell key={id} className={className}>{totals.totalRefundUsers}</TableCell>;
      case "amount_refunded":
        return <TableCell key={id} className={className}>{formatCurrency(totals.amountRefunded)}</TableCell>;
      case "refund_rate":
        return <TableCell key={id} className={className}>{formatPct(totals.refundRate)}</TableCell>;
      case "gross_revenue":
        return <TableCell key={id} className={className}>{formatCurrency(totals.grossRevenue)}</TableCell>;
      case "net_revenue":
        return <TableCell key={id} className={className}>{formatCurrency(totals.netRevenue)}</TableCell>;
      case "revenue_d0":
        return <TableCell key={id} className={className}>{formatCurrency(totals.revenueD0)}</TableCell>;
      case "revenue_d7":
        return <TableCell key={id} className={className}>{formatCurrency(totals.revenueD7)}</TableCell>;
      case "revenue_d30":
        return <TableCell key={id} className={className}>{formatCurrency(totals.revenueD30)}</TableCell>;
      case "revenue_d60":
        return <TableCell key={id} className={className}>{formatCurrency(totals.revenueD60)}</TableCell>;
      case "traffic_spend":
        return <TableCell key={id} className={className}>{totals.hasTrafficSpend ? formatCurrency(totals.trafficSpend) : dash}</TableCell>;
      case "profit":
        return <TableCell key={id} className={className}>{totals.hasCompleteTrafficSpend ? formatCurrency(totals.profit) : dash}</TableCell>;
      case "profit_d7":
        return <TableCell key={id} className={className}>{totals.hasCompleteTrafficSpend ? formatCurrency(totals.profitD7) : dash}</TableCell>;
      case "profit_1m":
        return <TableCell key={id} className={className}>{totals.hasCompleteTrafficSpend ? formatCurrency(totals.profit1m) : dash}</TableCell>;
      case "profit_2m":
        return <TableCell key={id} className={className}>{totals.hasCompleteTrafficSpend ? formatCurrency(totals.profit2m) : dash}</TableCell>;
      case "traffic_cac":
        return <TableCell key={id} className={className}>{totals.trafficTrials ? formatCurrency(totals.trafficCac) : dash}</TableCell>;
      case "traffic_trial_count":
        return <TableCell key={id} className={className}>{totals.trafficTrials || dash}</TableCell>;
      case "traffic_clicks":
        return <TableCell key={id} className={className}>{totals.trafficClicks || dash}</TableCell>;
      case "traffic_cpc":
        return <TableCell key={id} className={className}>{totals.trafficClicks ? formatCurrency(totals.trafficCpc) : dash}</TableCell>;
      case "traffic_cpm":
      case "traffic_ctr":
        return <TableCell key={id} className={className}>{dash}</TableCell>;
      case "roas_d7":
        return <TableCell key={id} className={className}>{totals.hasCompleteTrafficSpend && totals.trafficSpend ? formatRoas(totals.roasD7) : dash}</TableCell>;
      case "roas_1m":
        return <TableCell key={id} className={className}>{totals.hasCompleteTrafficSpend && totals.trafficSpend ? formatRoas(totals.roas1m) : dash}</TableCell>;
      case "roas_2m":
        return <TableCell key={id} className={className}>{totals.hasCompleteTrafficSpend && totals.trafficSpend ? formatRoas(totals.roas2m) : dash}</TableCell>;
    }
  };

  return (
    <AppLayout title="Cohorts" description="Grouped by trial date">
      <Card className="rounded-lg border bg-card text-card-foreground shadow-sm p-4 shadow-card py-[20px]">
        <div className="mb-3 flex flex-wrap items-center gap-2 pb-3 border-b border-border">
          <Select value={funnelFilter} onValueChange={(value) => updateUiState({ funnelFilter: value })}>
            <SelectTrigger className="h-9 w-[160px]"><SelectValue placeholder="Funnel" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All funnels</SelectItem>
              {funnelOptions.map((f) => (
                <SelectItem key={f} value={f}>{f.replace("_", " ")}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={campaignPathFilter} onValueChange={(value) => updateUiState({ campaignPathFilter: value })}>
            <SelectTrigger className="h-9 w-[220px]"><SelectValue placeholder="Campaign path" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All campaign paths</SelectItem>
              {campaignPathOptions.map((path) => (
                <SelectItem key={path} value={path}>{path}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={trafficSourceFilter} onValueChange={(value) => updateUiState({ trafficSourceFilter: value })}>
            <SelectTrigger className="h-9 w-[160px]"><SelectValue placeholder="Traffic source" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All traffic</SelectItem>
              {trafficSourceOptions.map((source) => (
                <SelectItem key={source} value={source}>{source}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={campaignIdFilter} onValueChange={(value) => updateUiState({ campaignIdFilter: value })}>
            <SelectTrigger className="h-9 w-[190px]"><SelectValue placeholder="Campaign ID" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All campaign IDs</SelectItem>
              {campaignIdOptions.map((id) => (
                <SelectItem key={id} value={id}>{id}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={refundFilter} onValueChange={(value) => updateUiState({ refundFilter: value })}>
            <SelectTrigger className="h-9 w-[150px]"><SelectValue placeholder="Refund" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All refunds</SelectItem>
              <SelectItem value="has">Has refunds</SelectItem>
              <SelectItem value="none">No refunds</SelectItem>
            </SelectContent>
          </Select>
          <div className="flex items-center gap-2">
            <Label htmlFor="cohort-date-from" className="text-xs text-muted-foreground">Cohort date from</Label>
            <Input
              id="cohort-date-from"
              type="date"
              value={cohortDateFrom}
              onChange={(e) => updateUiState({ cohortDateFrom: e.target.value })}
              className="h-9 w-[150px]"
            />
          </div>
          <div className="flex items-center gap-2">
            <Label htmlFor="cohort-date-to" className="text-xs text-muted-foreground">Cohort date to</Label>
            <Input
              id="cohort-date-to"
              type="date"
              value={cohortDateTo}
              onChange={(e) => updateUiState({ cohortDateTo: e.target.value })}
              className="h-9 w-[150px]"
            />
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Button type="button" variant="ghost" size="sm" className="h-9" onClick={resetCohortFilters}>
              Reset filters
            </Button>
            {activeView && (
              <span className="text-xs text-muted-foreground">
                View: <span className="font-medium text-foreground">{activeView.name}</span>
              </span>
            )}
            <Popover open={viewsPopoverOpen} onOpenChange={setViewsPopoverOpen}>
              <PopoverTrigger asChild>
                <Button type="button" variant="outline" size="sm" className="h-9">Views</Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-72 p-0">
                <div className="px-3 py-2 border-b border-border text-xs font-medium text-muted-foreground">Saved views</div>
                <div className="max-h-64 overflow-auto">
                  {allViews.map((v) => (
                    <div key={v.id} className="flex items-center justify-between gap-2 px-3 py-1.5 hover:bg-muted/50">
                      <button
                        type="button"
                        onClick={() => applyView(v)}
                        className="flex-1 flex items-center gap-2 text-left text-sm"
                      >
                        <span className="w-4">{activeViewId === v.id && <Check className="h-3.5 w-3.5 text-primary" />}</span>
                        <span>{v.name}</span>
                        {v.builtin && <span className="text-[10px] uppercase text-muted-foreground">built-in</span>}
                      </button>
                      {!v.builtin && (
                        <button
                          type="button"
                          onClick={() => deleteView(v.id)}
                          className="text-muted-foreground hover:text-destructive"
                          aria-label="Delete view"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                <div className="border-t border-border p-2 flex items-center gap-2">
                  <Input
                    placeholder="View name…"
                    value={newViewName}
                    onChange={(e) => setNewViewName(e.target.value)}
                    className="h-8 text-xs"
                    onKeyDown={(e) => { if (e.key === "Enter") saveCurrentAsView(); }}
                  />
                  <Button type="button" size="sm" className="h-8" onClick={saveCurrentAsView} disabled={!newViewName.trim()}>
                    <Plus className="h-3.5 w-3.5" /> Save
                  </Button>
                </div>
                <div className="border-t border-border p-2">
                  <div className="grid grid-cols-2 gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 text-xs"
                      onClick={onSaveCohortsViewToCloud}
                      disabled={cohortsUiCloudLoading}
                    >
                      {cohortsUiCloudLoading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                      Save settings to cloud
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 text-xs"
                      onClick={onLoadCohortsViewFromCloud}
                      disabled={cohortsUiCloudLoading}
                    >
                      Load settings from cloud
                    </Button>
                  </div>
                  <Button type="button" variant="ghost" size="sm" className="mt-2 w-full h-8" onClick={resetToDefault}>
                    Reset to default
                  </Button>
                  {(cohortsUiCloudMessage || cohortsUiCloudError) && (
                    <div className="mt-2 text-xs">
                      {cohortsUiCloudMessage && <div className="text-primary">{cohortsUiCloudMessage}</div>}
                      {cohortsUiCloudError && <div className="text-destructive">{cohortsUiCloudError}</div>}
                    </div>
                  )}
                </div>
              </PopoverContent>
            </Popover>
            <Popover open={columnsPopoverOpen} onOpenChange={setColumnsPopoverOpen}>
              <PopoverTrigger asChild>
                <Button type="button" variant="outline" size="sm" className="h-9">Columns</Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-72 p-0">
                <div className="flex items-center justify-between px-3 py-2 border-b border-border">
                  <span className="text-xs font-medium text-muted-foreground">Toggle columns</span>
                  <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={resetColumnOrder}>
                    Reset
                  </Button>
                </div>
                <div className="max-h-80 overflow-auto py-1">
                  {columnOrder.map((id) => (
                    <label key={id} className="flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-muted/50 cursor-pointer">
                      <Checkbox
                        checked={columnVisibility[id] !== false}
                        onCheckedChange={(c) => setVisibility(id, c === true)}
                      />
                      <span>{COLUMN_LABELS[id]}</span>
                    </label>
                  ))}
                </div>
                <div className="border-t border-border p-2 space-y-2">
                  <div className="grid grid-cols-2 gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 text-xs"
                      onClick={onSaveCohortsViewToCloud}
                      disabled={cohortsUiCloudLoading}
                    >
                      {cohortsUiCloudLoading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                      Save settings to cloud
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 text-xs"
                      onClick={onLoadCohortsViewFromCloud}
                      disabled={cohortsUiCloudLoading}
                    >
                      Load settings from cloud
                    </Button>
                  </div>
                  <Button type="button" variant="ghost" size="sm" className="h-8 w-full text-xs" onClick={resetToDefault}>
                    Reset to default
                  </Button>
                  {(cohortsUiCloudMessage || cohortsUiCloudError) && (
                    <div className="text-xs">
                      {cohortsUiCloudMessage && <div className="text-primary">{cohortsUiCloudMessage}</div>}
                      {cohortsUiCloudError && <div className="text-destructive">{cohortsUiCloudError}</div>}
                    </div>
                  )}
                </div>
              </PopoverContent>
            </Popover>
          </div>
        </div>

        <div className="rounded-lg border border-border [&>div]:max-h-[calc(100vh-220px)] [&>div]:overflow-auto [&>div]:rounded-lg [&>div]:scroll-smooth">
          <Table className="border-separate border-spacing-0 w-auto">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead
                  className={`${HEAD_BASE} left-0 z-50 shadow-[1px_0_0_0_hsl(var(--border)),0_1px_0_0_hsl(var(--border))] text-left`}
                  style={{ width: columnWidths[COHORT_FIRST_COL_KEY], minWidth: MIN_COLUMN_WIDTH }}
                >
                  <button
                    type="button"
                    onClick={() => onSortColumn(COHORT_FIRST_COL_KEY)}
                    className="inline-flex max-w-full items-center gap-1 hover:text-foreground"
                    aria-label="Sort by Cohort"
                  >
                    <span className="truncate">Cohort</span>
                    {sortIcon(COHORT_FIRST_COL_KEY)}
                  </button>
                  <div
                    role="separator"
                    aria-orientation="vertical"
                    onMouseDown={(e) => startResize(COHORT_FIRST_COL_KEY, e)}
                    onDoubleClick={() => autoFitColumn(COHORT_FIRST_COL_KEY)}
                    title="Drag to resize · double-click to reset"
                    className="absolute top-0 right-0 h-full w-1.5 -mr-px cursor-col-resize hover:bg-primary/40 active:bg-primary"
                  />
                </TableHead>
                {visibleColumnOrder.map(renderHeaderCell)}
              </TableRow>
            </TableHeader>
            <TableBody>
              {cohorts.map((c) => {
                const expanded = expandedCohortIds.has(c.cohort_id);
                return (
                  <Fragment key={c.cohort_id}>
                    <TableRow
                      key={c.cohort_id}
                      className="even:bg-muted/20 hover:bg-muted/40 [&>td.sticky]:even:bg-[hsl(var(--card))] [&>td.sticky]:hover:bg-[hsl(var(--muted))]"
                    >
                      <TableCell
                        className={`${CELL_BASE} sticky left-0 bg-card z-10 font-medium text-sm whitespace-nowrap shadow-[1px_0_0_0_hsl(var(--border))]`}
                      >
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => toggleExpanded(c.cohort_id)}
                            className="inline-flex items-center gap-1.5 hover:text-primary"
                            aria-expanded={expanded}
                          >
                            {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                            {c.cohort_id}
                          </button>
                        </div>
                      </TableCell>
                      {visibleColumnOrder.map((id) => renderCohortCell(id, c))}
                    </TableRow>
                    {expanded && c.plan_breakdown.length === 0 && (
                      <TableRow className="bg-muted/10 hover:bg-muted/10 [&>td.sticky]:bg-muted/10">
                        <TableCell
                          className={`${CELL_BASE} sticky left-0 z-10 shadow-[1px_0_0_0_hsl(var(--border))] text-xs italic text-muted-foreground whitespace-nowrap pl-8`}
                        >
                          No price breakdown
                        </TableCell>
                        {visibleColumnOrder.map((id) => (
                          <TableCell key={id} className="py-1.5 px-3" />
                        ))}
                      </TableRow>
                    )}
                    {expanded &&
                      c.plan_breakdown.map((plan) => (
                        <TableRow
                          key={`${c.cohort_id}-plan-${plan.price}`}
                          className="bg-muted/10 hover:bg-muted/20 [&>td.sticky]:bg-muted/10 [&>td.sticky]:hover:bg-muted/20"
                        >
                          <TableCell
                            className={`${CELL_BASE} sticky left-0 z-10 shadow-[1px_0_0_0_hsl(var(--border))] text-xs font-medium text-muted-foreground whitespace-nowrap tabular-nums pl-8`}
                          >
                            {formatCurrency(plan.price)}
                          </TableCell>
                          {visibleColumnOrder.map((id) => renderPlanCell(id, plan))}
                        </TableRow>
                      ))}
                  </Fragment>
                );
              })}
              {cohorts.length > 0 && (
                <TableRow className="sticky bottom-0 z-10 border-t-2 border-border bg-muted font-semibold hover:bg-muted">
                  <TableCell
                    className={`${CELL_BASE} sticky left-0 bg-muted z-20 text-sm whitespace-nowrap shadow-[1px_0_0_0_hsl(var(--border))]`}
                  >
                    Total
                  </TableCell>
                  {visibleColumnOrder.map(renderTotalCell)}
                </TableRow>
              )}
              {cohorts.length === 0 && (
                <TableRow>
                  <TableCell colSpan={visibleColumnOrder.length + 1} className="text-center text-sm text-muted-foreground py-10">
                    {hasUsers && allCohorts.length === 0
                      ? "No cohorts found. Check whether trial transactions were detected."
                      : "No cohorts to display."}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </Card>
    </AppLayout>
  );
}
