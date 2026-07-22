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
  computeCohortsWithDiagnostics,
  formatCurrency,
  formatPct,
} from "@/services/analytics";
import { aggregateTokenPackBreakdowns, type TokenPackRow } from "@/services/monetization";
import { computeCohortMonetizationTotals, cohortMaturity, LTV_1M_MATURITY_DAYS } from "@/services/cohortReporting";
import { SUPPORTED_CURRENCIES } from "@/services/fxRates";
import {
  getFunnelFoxSubscriptionsSyncState,
  subscriptionSyncCompletenessWarning,
} from "@/services/funnelfoxSubscriptionsSync";
import { normalizeCampaignPath, type TrafficMetric } from "@/services/trafficImport";
import type { CardType, CohortRow, MediaBuyer, PlanBreakdownRow } from "@/services/types";
import { cohortsDataSourceMode } from "@/services/cohortsDataSource";
import { deriveCohortSnapshotHealth, ensureCohortSnapshotRebuild } from "@/services/cohortSnapshotHealth";
import {
  FB_COHORT_COLUMN_LABELS,
  FB_COHORT_COLUMNS,
  FB_COHORT_DEFAULT_COLUMNS,
  FB_COHORT_OPTIONAL_COLUMNS,
  fbCohortCellText,
  fbUnavailableReason,
  formatFbInt,
  formatFbPct,
  formatFbRoas,
  formatFbUsd,
} from "@/services/fbCohortFormatting";
import { useFbWarehouseStatus } from "@/hooks/useFbWarehouse";
import { buildCohortsExportTable, cohortsTableToCsv } from "@/services/cohortsExport";
import { pruneInvalidCohortSelections } from "@/services/cohortFilterSelection";
import type { CohortRequest } from "../../supabase/functions/_shared/clickhouse/cohortContract";
import type { FbAllocationStatus, FbTimezoneSource } from "../../supabase/functions/_shared/clickhouse/fbCohortStats";
import { useAuth } from "@/hooks/useAuth";
import { hashUserScope } from "@/services/cohortsCache";
import { useCohortsListQuery, useWarehouseVersion } from "@/hooks/useCohortsCache";
import { formatUpdatedAgo } from "@/services/analyticsProgress";
import { Progress } from "@/components/ui/progress";
import { useDataStore } from "@/store/dataStore";
import { usePersistedPageState } from "@/hooks/usePersistedPageState";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
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
  sanitizeColumnOrder,
  sanitizeColumnVisibility,
  sanitizeColumnWidths,
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
import { renewalUsersForColumn, renewalUsersForLevel, trialCostForCohort, trialCostFromSpend } from "@/services/cohortReporting";
import {
  MAX_RENEWAL_COLUMNS_CHANGED_EVENT,
  loadMaxRenewalColumns,
  renewalColumnIds,
  renewalLevelFromColumnId,
} from "@/services/dataSettings";
import { filterCohortsWithDiagnostics, filterTransactionsByTrialAttribution, normalizeCohortDateKey } from "@/services/cohortFiltering";
import { buildCohortGeoOptions } from "@/services/cohortGeo";
import { buildCampaignIdOptions, formatCampaignIdOptionLabel } from "@/services/cohortCampaignIds";
import { buildCohortCardTypeOptions } from "@/services/cohortCardTypes";
import { buildMediaBuyerOptions, buildUtmSourceOptions, formatMediaBuyerOptionLabel } from "@/services/cohortMediaBuyer";
import {
  UTM_OPTION_LABEL_PREFIX,
  formatUtmSourceOptionLabel,
  isMediaBuyerSelectionValue,
  isUtmMediaBuyerSelection,
  utmSelectionValue,
  utmValueFromSelection,
} from "@/services/mediaBuyerSelection";
import { normalizeCountryCode } from "@/services/userCountry";
import { CARD_TYPE_VALUES, cardTypeLabel } from "@/services/userCardType";
import { MEDIA_BUYER_VALUES, mediaBuyerLabel } from "@/services/userMediaBuyer";

/** Dropdown/summary label for one Media Buyer selection value. */
function mediaBuyerSelectionLabel(value: MediaBuyer | string): string {
  const utm = utmValueFromSelection(value);
  return utm ? `${UTM_OPTION_LABEL_PREFIX}${utm}` : mediaBuyerLabel(value as MediaBuyer);
}
import { backfillTransactionCardTypesFromRawRows } from "@/services/palmerTransform";
import { traceEvent, traceMark, traceMeasure } from "@/services/performanceTrace";
import {
  autoLoadWarehouseIntoStore,
  getLegacyWarehouseLoadProgress,
  subscribeLegacyWarehouseLoadProgress,
} from "@/services/analyticsAdapters";

// Visual-only helpers — no data/logic impact.
const HEAD_BASE =
  "sticky top-0 z-40 bg-card min-h-8 px-2 whitespace-nowrap border-b border-border shadow-[0_1px_0_0_hsl(var(--border))] text-xs font-semibold text-muted-foreground select-none";
const HEAD_NUM = `${HEAD_BASE} text-right`;
const CELL_BASE = "py-1 px-2 align-middle overflow-hidden text-ellipsis";
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
  currencyFilter: "all",
  selectedCampaignIds: [] as string[],
  // Backward compatibility for locally/cloud-persisted single-select settings.
  campaignIdFilter: "all",
  refundFilter: "all",
  selectedCountries: [] as string[],
  selectedCardTypes: [] as CardType[],
  selectedMediaBuyers: [] as Array<MediaBuyer | string>,
  cohortDateFrom: "",
  cohortDateTo: "",
  dateSort: "desc" as "desc" | "asc",
  sortColumn: null as string | null,
  sortDirection: null as CohortSortDirection | null,
  expandedCohortIds: [] as string[],
};

const COLUMN_ORDER_BEFORE_RENEWALS = [
  "cohort_date",
  "campaign_path",
  "funnel",
  // FB Analytics user-cost metrics: selected-period Campaign CPP is assigned by
  // campaign_id; Spend / matched FB Purchases / CPP lead the row.
  ...FB_COHORT_DEFAULT_COLUMNS,
  "trial_users",
  "support_users",
  "support_rate",
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
  "renewal_3_to_renewal_4_cr",
  "renewal_4_to_renewal_5_cr",
  "renewal_5_to_renewal_6_cr",
] as const;

// Multi-upsell + token/minute pack monetization columns (hidden by default,
// surfaced together by the built-in "Monetization" view).
const MONETIZATION_COLUMNS = [
  "trial_revenue",
  "upsell_1_users",
  "upsell_1_cr",
  "upsell_1_revenue",
  "upsell_2_users",
  "upsell_2_cr",
  "upsell_2_revenue",
  "upsell_3_users",
  "upsell_3_cr",
  "upsell_3_revenue",
  "upsell_extra_users",
  "upsell_extra_revenue",
  "funnel_upsell_users",
  "funnel_upsell_revenue",
  "token_buyers",
  "token_buyer_cr",
  "token_purchases",
  "token_gross_revenue",
  "token_net_revenue",
  "avg_token_revenue_per_trial",
  "avg_token_revenue_per_buyer",
  "addon_revenue",
] as const;

// FX / multi-currency columns (hidden by default). Main revenue columns are
// USD-normalized; these expose the original-currency mix and exclusions.
const FX_COLUMNS = ["currency_mix", "fx_missing_amount", "fx_missing_transactions"] as const;

const COLUMN_ORDER_AFTER_RENEWALS = [
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
  "ltv_1m_per_user",
  ...MONETIZATION_COLUMNS,
  ...FX_COLUMNS,
  ...FB_COHORT_OPTIONAL_COLUMNS,
  "traffic_spend",
  "trial_cost",
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

type CohortColumnId = string;

function buildDefaultColumnOrder(maxRenewalColumns: number): CohortColumnId[] {
  return [
    ...COLUMN_ORDER_BEFORE_RENEWALS,
    ...renewalColumnIds(maxRenewalColumns),
    ...COLUMN_ORDER_AFTER_RENEWALS,
  ];
}

const DEFAULT_COLUMN_ORDER = buildDefaultColumnOrder(6);

const STATIC_COLUMN_LABELS: Record<string, string> = {
  cohort_date: "Cohort date",
  campaign_path: "Campaign path",
  funnel: "Funnel",
  trial_users: "Trial",
  support_users: "Support Users",
  support_rate: "Support Rate",
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
  renewal_3_to_renewal_4_cr: "Renewal 3 → 4 CR",
  renewal_4_to_renewal_5_cr: "Renewal 4 → 5 CR",
  renewal_5_to_renewal_6_cr: "Renewal 5 → 6 CR",
  renewal_2_users: "Renewal 2",
  renewal_3_users: "Renewal 3",
  renewal_4_users: "Renewal 4",
  renewal_5_users: "Renewal 5",
  renewal_6_users: "Renewal 6",
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
  ltv_1m_per_user: "LTV 1M / User",
  trial_revenue: "Trial Revenue",
  upsell_1_users: "Upsell 1 Users",
  upsell_1_cr: "Upsell 1 CR",
  upsell_1_revenue: "Upsell 1 Gross Rev",
  upsell_2_users: "Upsell 2 Users",
  upsell_2_cr: "Upsell 2 CR",
  upsell_2_revenue: "Upsell 2 Gross Rev",
  upsell_3_users: "Upsell 3 Users",
  upsell_3_cr: "Upsell 3 CR",
  upsell_3_revenue: "Upsell 3 Gross Rev",
  upsell_extra_users: "Upsell Extra Users",
  upsell_extra_revenue: "Upsell Extra Rev",
  funnel_upsell_users: "Funnel Upsell Users",
  funnel_upsell_revenue: "Funnel Upsell Rev",
  token_buyers: "Token Buyers",
  token_buyer_cr: "Token Buyer CR",
  token_purchases: "Token Purchases",
  token_gross_revenue: "Token Gross Rev",
  token_net_revenue: "Token Net Rev",
  avg_token_revenue_per_trial: "Avg Token Rev / Trial",
  avg_token_revenue_per_buyer: "Avg Token Rev / Buyer",
  addon_revenue: "Total Add-on Rev",
  currency_mix: "Currency Mix",
  fx_missing_amount: "FX Missing Amount",
  fx_missing_transactions: "FX Missing Txs",
  traffic_spend: "Spend",
  trial_cost: "Trial Cost",
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
  // FB Analytics columns (aggregated from per-user Campaign CPP assignments).
  ...FB_COHORT_COLUMN_LABELS,
};

function columnLabel(id: CohortColumnId): string {
  const renewalLevel = renewalLevelFromColumnId(id);
  if (renewalLevel != null) return `Renewal ${renewalLevel}`;
  return STATIC_COLUMN_LABELS[id] ?? id;
}

const COLUMN_MIN_WIDTHS: Record<string, number> = {
  cohort_date: 120,
  campaign_path: 160,
  funnel: 110,
  trial_users: 76,
  support_users: 110,
  support_rate: 110,
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
  renewal_3_to_renewal_4_cr: 130,
  renewal_4_to_renewal_5_cr: 130,
  renewal_5_to_renewal_6_cr: 130,
  renewal_2_users: 90,
  renewal_3_users: 90,
  renewal_4_users: 90,
  renewal_5_users: 90,
  renewal_6_users: 90,
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
  ltv_1m_per_user: 120,
  trial_revenue: 110,
  upsell_1_users: 100,
  upsell_1_cr: 90,
  upsell_1_revenue: 120,
  upsell_2_users: 100,
  upsell_2_cr: 90,
  upsell_2_revenue: 120,
  upsell_3_users: 100,
  upsell_3_cr: 90,
  upsell_3_revenue: 120,
  upsell_extra_users: 120,
  upsell_extra_revenue: 120,
  funnel_upsell_users: 130,
  funnel_upsell_revenue: 130,
  token_buyers: 100,
  token_buyer_cr: 100,
  token_purchases: 110,
  token_gross_revenue: 110,
  token_net_revenue: 110,
  avg_token_revenue_per_trial: 130,
  avg_token_revenue_per_buyer: 130,
  addon_revenue: 120,
  currency_mix: 150,
  fx_missing_amount: 130,
  fx_missing_transactions: 120,
  fb_spend: 100,
  fb_purchases: 110,
  fb_cpp: 90,
  fb_impressions: 110,
  fb_reach: 90,
  fb_clicks: 90,
  fb_link_clicks: 100,
  fb_ctr: 90,
  fb_cpc: 90,
  fb_cpm: 90,
  fb_purchase_value: 130,
  fb_roas: 90,
  fb_cac: 110,
  fb_cost_per_trial: 120,
  fb_cost_per_upsell: 130,
  fb_gross_roas: 110,
  fb_net_roas: 110,
  fb_profit: 100,
  fb_margin: 100,
  traffic_spend: 90,
  trial_cost: 90,
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
function buildDefaultColumnWidths(defaultColumnOrder: readonly string[]): Record<string, number> {
  const out: Record<string, number> = { [COHORT_FIRST_COL_KEY]: 150 };
  for (const id of defaultColumnOrder) {
    const isText = id === "cohort_date" || id === "campaign_path" || id === "funnel";
    const minWidth = COLUMN_MIN_WIDTHS[id] ?? 90;
    out[id] = isText ? Math.max(130, minWidth) : Math.max(MIN_COLUMN_WIDTH, Math.min(100, minWidth));
  }
  return out;
}

const DEFAULT_COLUMN_WIDTHS = buildDefaultColumnWidths(DEFAULT_COLUMN_ORDER);

function loadInitialColumnWidths(defaultColumnWidths = DEFAULT_COLUMN_WIDTHS): Record<string, number> {
  try {
    const saved = localStorage.getItem(COLUMN_WIDTHS_STORAGE_KEY);
    if (!saved) return { ...defaultColumnWidths };
    const parsed = JSON.parse(saved);
    if (parsed && typeof parsed === "object") {
      return { ...defaultColumnWidths, ...parsed };
    }
  } catch {
    // fall through
  }
  return { ...defaultColumnWidths };
}

function persistColumnWidths(widths: Record<string, number>) {
  try {
    localStorage.setItem(COLUMN_WIDTHS_STORAGE_KEY, JSON.stringify(widths));
    markCohortsUiSettingsUpdated();
  } catch (error) {
    console.warn("Unable to persist cohort column widths", error);
  }
}

const TEXT_COLUMNS = new Set<CohortColumnId>(["cohort_date", "campaign_path", "funnel", "currency_mix"]);
const SECTION_DIVIDER_COLUMNS = new Set<CohortColumnId>([
  "trial_users",
  "trial_to_upsell_cr",
  "renewal_2_users",
  "refund_users",
  "gross_revenue",
  "revenue_d0",
  "trial_revenue",
  "token_buyers",
  "traffic_spend",
  "profit",
  "roas_d7",
]);

const USD_CONVERTED_NOTE = "Converted to USD when local currency is available.";

function formatRowsCount(value: number | null | undefined): string {
  return typeof value === "number" ? value.toLocaleString("en-US") : "?";
}

// Header tooltips for the monetization columns (native title attribute, same
// mechanism the traffic columns already use).
const COLUMN_HELP: Partial<Record<CohortColumnId, string>> = {
  active_users: "Unique cohort users with at least one currently active and renewing subscription.",
  active_subscriptions: "Unique subscriptions with period_ends_at in the future and renews=true.",
  gross_revenue: USD_CONVERTED_NOTE,
  net_revenue: USD_CONVERTED_NOTE,
  amount_refunded: USD_CONVERTED_NOTE,
  revenue_d0: USD_CONVERTED_NOTE,
  revenue_d7: USD_CONVERTED_NOTE,
  revenue_d30: USD_CONVERTED_NOTE,
  revenue_d60: USD_CONVERTED_NOTE,
  ltv_1m_per_user: "Net revenue generated within the first 30 days after cohort start divided by trial users. Converted to USD.",
  support_users: "Unique trial users in this cohort whose normalized email appears in ClickHouse Support Analytics.",
  support_rate: "Support Users / Trial Users.",
  currency_mix: "Trial users per original charge currency (e.g. USD 50 · MXN 120).",
  fx_missing_amount: "Successful gross in ORIGINAL currency units excluded from USD metrics (currency or FX rate missing). Do not sum across currencies.",
  fx_missing_transactions: "Transactions excluded from USD metrics because currency or FX rate is missing.",
  trial_revenue: "Net revenue from trial payments of this cohort.",
  upsell_1_users: "Unique users with a successful Upsell 1 purchase (detected from product/billing reason ordinal).",
  upsell_1_cr: "Upsell 1 Users / Trial Users.",
  upsell_1_revenue: "Sum of successful Upsell 1 gross amounts.",
  upsell_2_users: "Unique users with a successful Upsell 2 purchase (detected from product/billing reason ordinal).",
  upsell_2_cr: "Upsell 2 Users / Trial Users.",
  upsell_2_revenue: "Sum of successful Upsell 2 gross amounts.",
  upsell_3_users: "Unique users with a successful Upsell 3 purchase (detected from product/billing reason ordinal).",
  upsell_3_cr: "Upsell 3 Users / Trial Users.",
  upsell_3_revenue: "Sum of successful Upsell 3 gross amounts.",
  upsell_extra_users: "Users with a 4th or later successful funnel upsell purchase (slots are assigned by purchase order).",
  upsell_extra_revenue: "Gross revenue of 4th+ funnel upsell purchases.",
  funnel_upsell_users: "Unique users with at least one successful funnel upsell of any slot.",
  funnel_upsell_revenue: "Gross revenue of all successful funnel upsells (slots 1-3 + extra).",
  token_buyers: "Unique users with at least one successful web-app token/minute pack purchase.",
  token_buyer_cr: "Token Buyers / Trial Users.",
  token_purchases: "Count of successful token/minute pack purchases.",
  token_gross_revenue: "Sum of successful token purchase gross amounts.",
  token_net_revenue: "Token Gross Rev minus refunds detectably related to token purchases; equals gross when no token refund is detectable.",
  avg_token_revenue_per_trial: "Token Net Rev / Trial Users.",
  avg_token_revenue_per_buyer: "Token Net Rev / Token Buyers.",
  addon_revenue: "Add-on revenue: net upsell revenue + Token Net Rev (everything beyond the subscription lifecycle).",
};

function heatStyle(value: number, max: number): React.CSSProperties {
  if (max <= 0) return {};
  const intensity = Math.min(1, value / max);
  return {
    background: `hsl(var(--primary) / ${0.05 + intensity * 0.25})`,
    color: intensity > 0.5 ? "hsl(var(--primary))" : undefined,
    fontVariantNumeric: "tabular-nums",
  };
}

function isValidColumnOrder(value: unknown, defaultColumnOrder = DEFAULT_COLUMN_ORDER): value is CohortColumnId[] {
  if (!Array.isArray(value) || value.length !== defaultColumnOrder.length) return false;
  const ids = new Set(value);
  return ids.size === defaultColumnOrder.length && defaultColumnOrder.every((id) => ids.has(id));
}

function loadInitialColumnOrder(defaultColumnOrder = DEFAULT_COLUMN_ORDER): CohortColumnId[] {
  try {
    const saved = localStorage.getItem(COLUMN_ORDER_STORAGE_KEY);
    if (!saved) return [...defaultColumnOrder];
    const parsed = JSON.parse(saved);
    return sanitizeColumnOrder(isValidColumnOrder(parsed, defaultColumnOrder) ? parsed : parsed, defaultColumnOrder);
  } catch {
    return [...defaultColumnOrder];
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
// Monetization columns stay in the Columns selector but are hidden by default:
// the table is already wide, and the built-in "Monetization" view surfaces them.
const DEFAULT_HIDDEN: CohortColumnId[] = [...MONETIZATION_COLUMNS, ...FX_COLUMNS, ...FB_COHORT_OPTIONAL_COLUMNS];

function defaultColumnVisibility(defaultColumnOrder = DEFAULT_COLUMN_ORDER): Record<CohortColumnId, boolean> {
  return Object.fromEntries(defaultColumnOrder.map((id) => [id, !DEFAULT_HIDDEN.includes(id)])) as Record<
    CohortColumnId,
    boolean
  >;
}

function loadInitialVisibility(defaultColumnOrder = DEFAULT_COLUMN_ORDER): Record<CohortColumnId, boolean> {
  const base = defaultColumnVisibility(defaultColumnOrder);
  try {
    const saved = localStorage.getItem(COLUMN_VISIBILITY_STORAGE_KEY);
    if (!saved) return base;
    const parsed = JSON.parse(saved);
    if (parsed && typeof parsed === "object") {
      for (const id of defaultColumnOrder) {
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

const TRAFFIC_GEO_NOTE = "Traffic spend is not GEO-split";
const TRAFFIC_CARD_TYPE_NOTE = "Traffic spend is not split by card type.";
const TRAFFIC_CAMPAIGN_ID_NOTE = "Traffic spend is cohort-level and is not split by Campaign ID.";
const TRAFFIC_MEDIA_BUYER_NOTE = "Spend is not split by Media Buyer";
const TRAFFIC_DERIVED_COLUMN_PREFIXES = ["traffic_", "roas_", "profit"] as const;

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

function isTrafficDerivedColumn(id: string): boolean {
  return id === "trial_cost" || TRAFFIC_DERIVED_COLUMN_PREFIXES.some((prefix) => id.startsWith(prefix));
}

function buildVisibility(
  visibleIds: readonly CohortColumnId[],
  defaultColumnOrder: readonly CohortColumnId[] = DEFAULT_COLUMN_ORDER,
): Record<CohortColumnId, boolean> {
  const v = {} as Record<CohortColumnId, boolean>;
  for (const id of defaultColumnOrder) v[id] = visibleIds.includes(id);
  return v;
}

function buildBuiltinViews(defaultColumnOrder: readonly string[]): SavedView[] {
  return [
    {
      id: "default",
      name: "Default",
      order: [...defaultColumnOrder],
      visibility: Object.fromEntries(defaultColumnOrder.map((id) => [id, true])) as Record<CohortColumnId, boolean>,
      builtin: true,
    },
    {
      id: "revenue",
      name: "Revenue",
      order: [...defaultColumnOrder],
      visibility: buildVisibility(["gross_revenue", "net_revenue", "revenue_d0", "revenue_d7", "revenue_d30", "revenue_d60", "ltv_1m_per_user", "traffic_spend", "trial_cost", "profit", "profit_d7", "profit_1m", "profit_2m"], defaultColumnOrder),
      builtin: true,
    },
    {
      id: "monetization",
      name: "Monetization",
      order: [...defaultColumnOrder],
      visibility: buildVisibility(
        [
          "trial_users",
          "upsell_1_users",
          "upsell_1_cr",
          "upsell_1_revenue",
          "upsell_2_users",
          "upsell_2_cr",
          "upsell_2_revenue",
          "upsell_3_users",
          "upsell_3_cr",
          "upsell_3_revenue",
          "token_buyers",
          "token_buyer_cr",
          "token_purchases",
          "token_net_revenue",
          "avg_token_revenue_per_trial",
          "addon_revenue",
          "gross_revenue",
          "net_revenue",
          "ltv_1m_per_user",
        ],
        defaultColumnOrder,
      ),
      builtin: true,
    },
    {
      id: "cancellations",
      name: "Cancellations",
      order: [...defaultColumnOrder],
      visibility: buildVisibility(["cancelled_users", "user_cancelled_users", "auto_cancelled_users", "cancellation_rate"], defaultColumnOrder),
      builtin: true,
    },
    {
      id: "active_subs",
      name: "Active Subs",
      order: [...defaultColumnOrder],
      visibility: buildVisibility(["active_subscriptions", "active_subscriptions_rate"], defaultColumnOrder),
      builtin: true,
    },
  ];
}

const BUILTIN_VIEWS = buildBuiltinViews(DEFAULT_COLUMN_ORDER);

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

function TokenPackTable({ packs }: { packs: TokenPackRow[] }) {
  if (!packs.length) {
    return <div className="text-xs italic text-muted-foreground">No token purchases</div>;
  }
  return (
    <table className="text-xs tabular-nums">
      <thead>
        <tr className="text-muted-foreground">
          <th className="pr-4 pb-1 text-left font-medium">Product ID</th>
          <th className="pr-4 pb-1 text-left font-medium">Product / Pack</th>
          <th className="pr-4 pb-1 text-right font-medium">Price</th>
          <th className="pr-4 pb-1 text-right font-medium">Purchases</th>
          <th className="pr-4 pb-1 text-right font-medium">Buyers</th>
          <th className="pr-4 pb-1 text-right font-medium">Gross Rev</th>
          <th className="pb-1 text-right font-medium">Share</th>
        </tr>
      </thead>
      <tbody>
        {packs.map((pack) => (
          <tr key={`${pack.product}-${pack.price}`}>
            <td className="pr-4 py-0.5 text-muted-foreground">{pack.product_id ?? "—"}</td>
            <td className="pr-4 py-0.5">{pack.product}</td>
            <td className="pr-4 py-0.5 text-right">{formatCurrency(pack.price)}</td>
            <td className="pr-4 py-0.5 text-right">{pack.purchases}</td>
            <td className="pr-4 py-0.5 text-right">{pack.buyers}</td>
            <td className="pr-4 py-0.5 text-right">{formatCurrency(pack.gross_revenue)}</td>
            <td className="py-0.5 text-right">{formatPct(pack.revenue_share)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// Expanded-row monetization breakdown: upsell funnel + token pack analytics.
function CohortLtv1mDetails({ cohort, nowMs }: { cohort: CohortRow; nowMs: number }) {
  const maturity = cohortMaturity(cohort.cohort_date, nowMs);
  const netRevenue1m = cohort.net_revenue_1m ?? cohort.revenue_d30;
  const ltv = cohort.ltv_1m_per_user ?? (cohort.trial_users ? netRevenue1m / cohort.trial_users : 0);
  return (
    <div>
      <div className="mb-1 text-xs font-semibold text-muted-foreground">1M LTV Details</div>
      <div className="grid grid-cols-2 gap-x-6 gap-y-0.5 text-xs tabular-nums">
        <span className="text-muted-foreground">Trial Users</span>
        <span className="text-right">{cohort.trial_users}</span>
        <span className="text-muted-foreground">Net Revenue 1M USD</span>
        <span className="text-right">{formatCurrency(netRevenue1m)}</span>
        <span className="text-muted-foreground">LTV 1M / User</span>
        <span className="text-right font-medium">{formatCurrency(ltv)}</span>
        <span className="text-muted-foreground">Cohort Age Days</span>
        <span className="text-right">{maturity.age_days}</span>
        <span className="text-muted-foreground">1M Maturity Status</span>
        <span className={`text-right font-medium ${maturity.matured ? "text-success" : "text-warning"}`}>
          {maturity.matured ? "Matured" : "Not Matured"}
        </span>
      </div>
      {!maturity.matured && (
        <div className="mt-1 text-xs text-warning">
          Only {maturity.available_days} day{maturity.available_days === 1 ? "" : "s"} of revenue are currently available for this cohort. Cohort is not fully mature for 1M LTV (needs {LTV_1M_MATURITY_DAYS}).
        </div>
      )}
    </div>
  );
}

function CohortMonetizationDetails({ cohort, nowMs }: { cohort: CohortRow; nowMs: number }) {
  const upsellRows = [
    { label: "Upsell 1", users: cohort.upsell_1_users ?? 0, revenue: cohort.upsell_1_revenue ?? 0 },
    { label: "Upsell 2", users: cohort.upsell_2_users ?? 0, revenue: cohort.upsell_2_revenue ?? 0 },
    { label: "Upsell 3", users: cohort.upsell_3_users ?? 0, revenue: cohort.upsell_3_revenue ?? 0 },
    { label: "Extra / Unknown", users: cohort.upsell_extra_users ?? 0, revenue: cohort.upsell_extra_revenue ?? 0 },
    { label: "Any upsell (total)", users: cohort.funnel_upsell_users ?? 0, revenue: cohort.funnel_upsell_revenue ?? 0 },
  ];
  const tokenPurchases = cohort.token_purchases ?? 0;
  const tokenGross = cohort.token_gross_revenue ?? 0;
  return (
    <div className="flex flex-wrap gap-8 py-1">
      <CohortLtv1mDetails cohort={cohort} nowMs={nowMs} />
      <div>
        <div className="mb-1 text-xs font-semibold text-muted-foreground">Upsell funnel</div>
        <table className="text-xs tabular-nums">
          <thead>
            <tr className="text-muted-foreground">
              <th className="pr-4 pb-1 text-left font-medium">Step</th>
              <th className="pr-4 pb-1 text-right font-medium">Users</th>
              <th className="pr-4 pb-1 text-right font-medium">CR</th>
              <th className="pb-1 text-right font-medium">Gross Rev</th>
            </tr>
          </thead>
          <tbody>
            {upsellRows.map((row) => (
              <tr key={row.label}>
                <td className="pr-4 py-0.5">{row.label}</td>
                <td className="pr-4 py-0.5 text-right">{row.users}</td>
                <td className="pr-4 py-0.5 text-right">
                  {cohort.trial_users ? formatPct((row.users / cohort.trial_users) * 100) : "—"}
                </td>
                <td className="py-0.5 text-right">{formatCurrency(row.revenue)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div>
        <div className="mb-1 text-xs font-semibold text-muted-foreground">Token purchases</div>
        <div className="mb-2 grid grid-cols-2 gap-x-6 gap-y-0.5 text-xs tabular-nums">
          <span className="text-muted-foreground">Token buyers</span>
          <span className="text-right">{cohort.token_buyers ?? 0}</span>
          <span className="text-muted-foreground">Token purchases</span>
          <span className="text-right">{tokenPurchases}</span>
          <span className="text-muted-foreground">Gross revenue</span>
          <span className="text-right">{formatCurrency(tokenGross)}</span>
          <span className="text-muted-foreground">Net revenue</span>
          <span className="text-right">{formatCurrency(cohort.token_net_revenue ?? 0)}</span>
          <span className="text-muted-foreground">Avg purchase</span>
          <span className="text-right">{tokenPurchases ? formatCurrency(tokenGross / tokenPurchases) : "—"}</span>
        </div>
        <TokenPackTable packs={cohort.token_pack_breakdown ?? []} />
      </div>
      <div>
        <div className="mb-1 text-xs font-semibold text-muted-foreground">Currency Breakdown</div>
        {(cohort.currency_breakdown ?? []).length === 0 ? (
          <div className="text-xs italic text-muted-foreground">No successful transactions</div>
        ) : (
          <table className="text-xs tabular-nums">
            <thead>
              <tr className="text-muted-foreground">
                <th className="pr-4 pb-1 text-left font-medium">Currency</th>
                <th className="pr-4 pb-1 text-right font-medium">Trials</th>
                <th className="pr-4 pb-1 text-right font-medium">Txs</th>
                <th className="pr-4 pb-1 text-right font-medium">Gross Original</th>
                <th className="pr-4 pb-1 text-right font-medium">Gross USD</th>
                <th className="pr-4 pb-1 text-right font-medium">Net USD</th>
                <th className="pr-4 pb-1 text-right font-medium">Refunds USD</th>
                <th className="pr-4 pb-1 text-right font-medium">Avg Trial Orig</th>
                <th className="pb-1 text-right font-medium">Avg Trial USD</th>
              </tr>
            </thead>
            <tbody>
              {(cohort.currency_breakdown ?? []).map((row) => (
                <tr key={row.currency}>
                  <td className="pr-4 py-0.5 font-medium">{row.currency}</td>
                  <td className="pr-4 py-0.5 text-right">{row.trial_users}</td>
                  <td className="pr-4 py-0.5 text-right">{row.transactions}</td>
                  <td className="pr-4 py-0.5 text-right">{row.gross_original.toLocaleString("en-US", { maximumFractionDigits: 2 })} {row.currency}</td>
                  <td className="pr-4 py-0.5 text-right">{formatCurrency(row.gross_usd)}</td>
                  <td className="pr-4 py-0.5 text-right">{formatCurrency(row.net_usd)}</td>
                  <td className="pr-4 py-0.5 text-right">{formatCurrency(row.refunds_usd)}</td>
                  <td className="pr-4 py-0.5 text-right">
                    {row.avg_trial_price_original != null
                      ? `${row.avg_trial_price_original.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${row.currency}`
                      : "—"}
                  </td>
                  <td className="py-0.5 text-right">{row.avg_trial_price_usd != null ? formatCurrency(row.avg_trial_price_usd) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// Wait this long after the last multi-select change before re-running the cohort computations.
const COHORT_FILTER_DEBOUNCE_MS = 300;

const FB_ALLOCATION_STATUSES: FbAllocationStatus[] = [
  "fully_allocated",
  "underallocated",
  "overallocated",
  "no_fb_purchases",
  "no_matched_users",
  "campaign_unmatched",
  "timezone_unverified",
  "invalid_timezone",
  "invalid_metrics",
];
const FB_TIMEZONE_SOURCES: FbTimezoneSource[] = ["payload", "account_config", "default_config", "unverified"];

export default function CohortsPage() {
  const txs = useTransactions();
  const mountedRef = useRef(false);
  const firstRowsRef = useRef(false);
  if (!mountedRef.current) {
    mountedRef.current = true;
    traceMark("route.cohorts.mounted");
  }
  // Reference "now" for cohort 1M-LTV maturity, stamped once per mount so the
  // table does not re-render on every clock tick.
  const nowMs = useMemo(() => Date.now(), []);
  // Best-effort: warn above active-subscription columns if the FunnelFox sync is
  // known-partial. Silent when there is no sync-state row (legacy snapshot).
  const [subscriptionSyncWarning, setSubscriptionSyncWarning] = useState<string | null>(null);
  useEffect(() => {
    let mounted = true;
    getFunnelFoxSubscriptionsSyncState()
      .then((state) => { if (mounted) setSubscriptionSyncWarning(subscriptionSyncCompletenessWarning(state)); })
      .catch(() => { /* no sync-state table / not signed in → no warning */ });
    return () => { mounted = false; };
  }, []);
  const subscriptions = useDataStore((s) => s.subscriptions);
  const trafficMetrics = useDataStore((s) => s.trafficMetrics);
  const rawPalmerRows = useDataStore((s) => s.rawPalmerRows);
  const dataStoreSource = useDataStore((s) => s.meta.source);
  const [legacyWarehouseLoadState, setLegacyWarehouseLoadState] = useState<"idle" | "loading" | "settled">("idle");
  const [fbAllocationDiagnosticsUi, setFbAllocationDiagnosticsUi] = useState({
    page: 1,
    dateFrom: "",
    dateTo: "",
    campaignId: "",
    campaignName: "",
    adAccountId: "",
    allocationStatus: "all" as FbAllocationStatus | "all",
    timezoneSource: "all" as FbTimezoneSource | "all",
  });
  const [legacyWarehouseProgress, setLegacyWarehouseProgress] = useState(getLegacyWarehouseLoadProgress);
  useEffect(
    () => subscribeLegacyWarehouseLoadProgress(() => setLegacyWarehouseProgress(getLegacyWarehouseLoadProgress())),
    [],
  );
  // ClickHouse read path state is declared early so it can gate the legacy
  // client compute BELOW: in clickhouse mode, when ClickHouse is driving, the
  // page feeds an EMPTY transaction list to the legacy compute/option builders,
  // so the browser never scans warehouse transactions. Legacy still computes
  // (real transactions) only as the fallback when ClickHouse errors or a
  // not-yet-server-reproduced filter is active.
  const cohortsSource = useMemo(() => cohortsDataSourceMode(), []);
  const { user } = useAuth();
  // Non-reversible per-user scope for cache isolation; hashed warehouse version so
  // a warehouse advance busts stale cache. chResult / chStatus (+ progress) are
  // produced by the cached cohorts query defined just above `needLegacy` below.
  const userScopeHash = useMemo(() => hashUserScope(user?.id), [user?.id]);
  const { version: warehouseVersion, ready: warehouseVersionReady } = useWarehouseVersion(cohortsSource === "clickhouse");
  // FB warehouse fingerprint (separate lifecycle from the cohort snapshot): an
  // FB sync re-keys this report so cached Spend can never outlive the sync.
  const { version: fbWarehouseVersion } = useFbWarehouseStatus(cohortsSource === "clickhouse");
  const [uiState, setUiState, resetUiState] = usePersistedPageState("ui_state_cohorts", DEFAULT_COHORTS_UI_STATE);
  const {
    funnelFilter,
    campaignPathFilter,
    trafficSourceFilter,
    currencyFilter,
    selectedCampaignIds: rawSelectedCampaignIds,
    campaignIdFilter: legacyCampaignIdFilter,
    refundFilter,
    selectedCountries: rawSelectedCountries,
    selectedCardTypes: rawSelectedCardTypes,
    selectedMediaBuyers: rawSelectedMediaBuyers,
    cohortDateFrom,
    cohortDateTo,
    sortColumn,
    sortDirection,
    expandedCohortIds: expandedCohortIdList,
  } = uiState;
  const selectedCountries = useMemo(
    () => Array.isArray(rawSelectedCountries)
      ? rawSelectedCountries.flatMap((country) => {
        const normalized = normalizeCountryCode(country);
        return normalized ? [normalized] : [];
      })
      : [],
    [rawSelectedCountries],
  );
  const selectedCardTypes = useMemo(
    () =>
      Array.isArray(rawSelectedCardTypes)
        ? rawSelectedCardTypes.filter((value): value is CardType => CARD_TYPE_VALUES.includes(value as CardType))
        : [],
    [rawSelectedCardTypes],
  );
  const selectedMediaBuyers = useMemo(
    () =>
      Array.isArray(rawSelectedMediaBuyers)
        ? rawSelectedMediaBuyers.filter(isMediaBuyerSelectionValue)
        : [],
    [rawSelectedMediaBuyers],
  );
  const selectedCampaignIds = useMemo(() => {
    const ids = new Set<string>();
    if (Array.isArray(rawSelectedCampaignIds)) {
      rawSelectedCampaignIds.forEach((value) => {
        const id = String(value ?? "").trim();
        if (id && id !== "all") ids.add(id);
      });
    }
    if (legacyCampaignIdFilter && legacyCampaignIdFilter !== "all") ids.add(legacyCampaignIdFilter);
    return Array.from(ids).sort();
  }, [rawSelectedCampaignIds, legacyCampaignIdFilter]);
  const hasGeoFilter = selectedCountries.length > 0;
  const hasCardTypeFilter = selectedCardTypes.length > 0;
  const hasMediaBuyerFilter = selectedMediaBuyers.length > 0;
  const hasCampaignIdFilter = selectedCampaignIds.length > 0;

  // The filters above (country / card type / media buyer / campaign IDs / traffic
  // source) are the rapid-click controls: each click re-runs every computeCohorts pass on this page
  // (the cohort table plus each "available options" builder). Debounce them as one bundle so a burst
  // of clicks collapses into a single recompute. The checkbox UI keeps reading the live `selected*`
  // values (instant feedback); only the heavy memos read the `applied*` values below. `maxRenewalColumns`
  // is intentionally excluded — it is a rarely-changed setting that also drives the column layout, so
  // it must stay in lockstep with the live value. Settled applied values equal the live ones, so no
  // metric changes — only the timing of the recompute.
  const heavyFilters = useMemo(
    () => ({ trafficSourceFilter, selectedCampaignIds, selectedCountries, selectedCardTypes, selectedMediaBuyers }),
    [trafficSourceFilter, selectedCampaignIds, selectedCountries, selectedCardTypes, selectedMediaBuyers],
  );
  const [appliedHeavyFilters, isRecomputing] = useDebouncedValue(heavyFilters, COHORT_FILTER_DEBOUNCE_MS);
  const {
    trafficSourceFilter: appliedTrafficSourceFilter,
    selectedCampaignIds: appliedSelectedCampaignIds,
    selectedCountries: appliedSelectedCountries,
    selectedCardTypes: appliedSelectedCardTypes,
    selectedMediaBuyers: appliedSelectedMediaBuyers,
  } = appliedHeavyFilters;
  const effectiveSelectedCardTypes = useMemo(
    () => (appliedSelectedCardTypes.length === CARD_TYPE_VALUES.length ? [] : appliedSelectedCardTypes),
    [appliedSelectedCardTypes],
  );
  const effectiveSelectedMediaBuyers = useMemo(() => {
    const hasUtmSelection = appliedSelectedMediaBuyers.some((value) => isUtmMediaBuyerSelection(value));
    return !hasUtmSelection && appliedSelectedMediaBuyers.length === MEDIA_BUYER_VALUES.length ? [] : appliedSelectedMediaBuyers;
  }, [appliedSelectedMediaBuyers]);
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
  const [campaignIdSearch, setCampaignIdSearch] = useState("");
  const [maxRenewalColumns, setMaxRenewalColumns] = useState(loadMaxRenewalColumns);
  const defaultColumnOrder = useMemo(() => buildDefaultColumnOrder(maxRenewalColumns), [maxRenewalColumns]);
  const defaultColumnWidths = useMemo(() => buildDefaultColumnWidths(defaultColumnOrder), [defaultColumnOrder]);
  const defaultVisibility = useMemo(() => defaultColumnVisibility(defaultColumnOrder), [defaultColumnOrder]);
  const builtinViews = useMemo(() => buildBuiltinViews(defaultColumnOrder), [defaultColumnOrder]);
  const [columnOrder, setColumnOrder] = useState<CohortColumnId[]>(() => loadInitialColumnOrder(buildDefaultColumnOrder(loadMaxRenewalColumns())));
  const [columnVisibility, setColumnVisibility] = useState<Record<CohortColumnId, boolean>>(() => loadInitialVisibility(buildDefaultColumnOrder(loadMaxRenewalColumns())));
  const [customViews, setCustomViews] = useState<SavedView[]>(loadCustomViews);
  const [activeViewId, setActiveViewId] = useState<string | null>(() => {
    try { return localStorage.getItem(ACTIVE_VIEW_STORAGE_KEY); } catch { return null; }
  });
  const [newViewName, setNewViewName] = useState("");
  const dragColRef = useRef<CohortColumnId | null>(null);
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>(() => loadInitialColumnWidths(buildDefaultColumnWidths(buildDefaultColumnOrder(loadMaxRenewalColumns()))));
  const resizingRef = useRef<{ key: string; startX: number; startWidth: number } | null>(null);
  const [cohortsUiCloudReady, setCohortsUiCloudReady] = useState(false);
  const [cohortsUiCloudLoading, setCohortsUiCloudLoading] = useState(false);
  const [cohortsUiCloudMessage, setCohortsUiCloudMessage] = useState<string | null>(null);
  const [cohortsUiCloudError, setCohortsUiCloudError] = useState<string | null>(null);
  const skipNextCloudSaveRef = useRef(false);
  const didLoadCloudSettingsRef = useRef(false);

  const cohortsUiSettingsDefaults = useMemo<CohortsUiSettingsDefaults>(
    () => ({
      defaultColumnOrder,
      defaultColumnWidths,
      defaultColumnVisibility: defaultVisibility,
      defaultFilters: DEFAULT_COHORTS_UI_STATE,
      validWidthKeys: [COHORT_FIRST_COL_KEY, ...defaultColumnOrder],
      validSelectedViewIds: builtinViews.map((view) => view.id),
      defaultSelectedView: "default",
      validSortColumnIds: [COHORT_FIRST_COL_KEY, ...defaultColumnOrder],
    }),
    [builtinViews, defaultColumnOrder, defaultColumnWidths, defaultVisibility],
  );

  const startResize = useCallback((key: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startWidth = columnWidths[key] ?? defaultColumnWidths[key] ?? 100;
    resizingRef.current = { key, startX: e.clientX, startWidth };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, [columnWidths, defaultColumnWidths]);

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
      const next = { ...cur, [key]: defaultColumnWidths[key] ?? 100 };
      persistColumnWidths(next);
      return next;
    });
  }, [defaultColumnWidths]);

  const resetColumnWidths = useCallback(() => {
    setColumnWidths({ ...defaultColumnWidths });
    try {
      localStorage.removeItem(COLUMN_WIDTHS_STORAGE_KEY);
      markCohortsUiSettingsUpdated();
    } catch (error) {
      console.warn("Unable to reset cohort column widths", error);
    }
  }, [defaultColumnWidths]);

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

  useEffect(() => {
    const syncMaxRenewalColumns = () => setMaxRenewalColumns(loadMaxRenewalColumns());
    const onCustomEvent = (event: Event) => {
      const next = (event as CustomEvent).detail;
      setMaxRenewalColumns(loadMaxRenewalColumns() || next);
    };

    window.addEventListener("storage", syncMaxRenewalColumns);
    window.addEventListener(MAX_RENEWAL_COLUMNS_CHANGED_EVENT, onCustomEvent);
    return () => {
      window.removeEventListener("storage", syncMaxRenewalColumns);
      window.removeEventListener(MAX_RENEWAL_COLUMNS_CHANGED_EVENT, onCustomEvent);
    };
  }, []);

  useEffect(() => {
    setColumnOrder((current) => sanitizeColumnOrder(current, defaultColumnOrder));
    setColumnVisibility((current) => sanitizeColumnVisibility(current, defaultVisibility, defaultColumnOrder));
    setColumnWidths((current) =>
      sanitizeColumnWidths(current, defaultColumnWidths, [COHORT_FIRST_COL_KEY, ...defaultColumnOrder]),
    );
    if (sortColumn && !defaultColumnOrder.includes(sortColumn)) {
      markCohortsUiSettingsUpdated();
      setUiState((current) => ({ ...current, sortColumn: null, sortDirection: null }));
    }
  }, [defaultColumnOrder, defaultColumnWidths, defaultVisibility, setUiState, sortColumn]);

  // --- ClickHouse Cohorts read path (cached, stale-while-revalidate) ---------
  // Assembled BEFORE needLegacy because the fallback decision depends on the
  // query's status. The QueryClient lives above the router, so this cache
  // survives route unmount/remount — returning to Cohorts renders cached rows
  // immediately with no empty-table flash.
  const selectedCurrencies = useMemo(
    () => (currencyFilter && currencyFilter !== "all" ? [currencyFilter] : []),
    [currencyFilter],
  );
  const chRequest = useMemo<CohortRequest>(
    () => ({
      action: "list",
      date_from: cohortDateFrom || null,
      date_to: cohortDateTo || null,
      filters: {
        funnel: funnelFilter && funnelFilter !== "all" ? [funnelFilter] : [],
        campaign_path: campaignPathFilter && campaignPathFilter !== "all" ? [campaignPathFilter] : [],
        campaign_id: appliedSelectedCampaignIds ?? [],
        traffic_source: appliedTrafficSourceFilter && appliedTrafficSourceFilter !== "all" ? [appliedTrafficSourceFilter] : [],
        price_plan: [],
        media_buyer: effectiveSelectedMediaBuyers ?? [],
        country: appliedSelectedCountries ?? [],
        card_type: effectiveSelectedCardTypes ?? [],
        currency: selectedCurrencies ?? [],
        transaction_type: [],
        refund_status: refundFilter === "has" ? "has" : refundFilter === "none" ? "none" : "all",
      },
      max_renewal_depth: maxRenewalColumns,
      fb_allocation_diagnostics: {
        page: fbAllocationDiagnosticsUi.page,
        page_size: 100,
        filters: {
          date_from: fbAllocationDiagnosticsUi.dateFrom || null,
          date_to: fbAllocationDiagnosticsUi.dateTo || null,
          campaign_id: fbAllocationDiagnosticsUi.campaignId.trim() || null,
          campaign_name: fbAllocationDiagnosticsUi.campaignName.trim() || null,
          ad_account_id: fbAllocationDiagnosticsUi.adAccountId.trim() || null,
          allocation_status: fbAllocationDiagnosticsUi.allocationStatus,
          timezone_source: fbAllocationDiagnosticsUi.timezoneSource,
        },
      },
    }),
    [cohortDateFrom, cohortDateTo, funnelFilter, campaignPathFilter, appliedSelectedCampaignIds, appliedTrafficSourceFilter, effectiveSelectedMediaBuyers, appliedSelectedCountries, effectiveSelectedCardTypes, selectedCurrencies, refundFilter, maxRenewalColumns, fbAllocationDiagnosticsUi],
  );
  const {
    chResult,
    chStatus,
    isBackgroundRefreshing,
    isInitialLoading,
    progressPercent,
    dataUpdatedAt,
    isFilterScopeCurrent,
  } = useCohortsListQuery({
    request: chRequest,
    dataSource: cohortsSource,
    userScopeHash,
    warehouseVersion,
    fbWarehouseVersion,
    // Gate on the warehouse version being settled so the key is stable on the
    // first fetch (avoids a wasted re-key/double fetch on the first-ever visit).
    enabled: cohortsSource === "clickhouse" && warehouseVersionReady,
  });

  // Legacy is needed (and thus transactions are scanned) only when NOT driving
  // from ClickHouse: legacy mode, an active filter not reproduced server-side
  // or a ClickHouse error
  // WITH no cached result to fall back on. A failed BACKGROUND refresh (cached
  // rows present) keeps the previous ClickHouse rows visible instead of dropping
  // to legacy — the emergency legacy path still applies when there is no data.
  const needLegacy =
    cohortsSource !== "clickhouse" ||
    (chStatus.error !== null && chResult == null) ||
    !chStatus.applicable;
  const legacyWarehouseLoadInProgress =
    legacyWarehouseProgress.status === "counting" ||
    legacyWarehouseProgress.status === "loading" ||
    legacyWarehouseProgress.status === "publishing";
  const legacyWarehouseExpectedRows = legacyWarehouseProgress.total_rows_expected;
  const transactionWarehouseComplete =
    dataStoreSource !== "transaction_warehouse"
      ? true
      : legacyWarehouseProgress.status === "idle"
        ? txs.length > 0
        : legacyWarehouseProgress.source_complete &&
          (legacyWarehouseExpectedRows == null ||
            (legacyWarehouseProgress.rows_downloaded === legacyWarehouseExpectedRows &&
              legacyWarehouseProgress.rows_stored === legacyWarehouseExpectedRows));
  const legacyWarehousePending =
    needLegacy &&
    dataStoreSource === "mock" &&
    legacyWarehouseLoadState !== "settled" &&
    legacyWarehouseProgress.status !== "empty" &&
    legacyWarehouseProgress.status !== "failed";
  const legacyRowsReady = needLegacy && dataStoreSource !== "mock" && transactionWarehouseComplete;
  useEffect(() => {
    traceEvent("cohorts.legacy_state", {
      need_legacy: needLegacy,
      source: cohortsSource,
      has_clickhouse_result: chResult != null,
      has_error: chStatus.error != null,
      applicable: chStatus.applicable,
      unsupported_filters: chStatus.unsupportedFilters.join(","),
      fallback_reason: chStatus.fallbackReason,
      traffic_filter_active: appliedTrafficSourceFilter !== "all",
      data_store_source: dataStoreSource,
      legacy_warehouse_pending: legacyWarehousePending,
      legacy_source_complete: legacyWarehouseProgress.source_complete,
      legacy_rows_downloaded: legacyWarehouseProgress.rows_downloaded,
      legacy_rows_expected: legacyWarehouseProgress.total_rows_expected,
    });
    if (import.meta.env.DEV && !(typeof process !== "undefined" && process.env.VITEST)) {
      console.debug("[Cohorts fallback decision]", {
        needLegacy,
        reasons: [
          cohortsSource !== "clickhouse" ? "data_source_not_clickhouse" : null,
          chStatus.error !== null && chResult == null ? "clickhouse_error_without_cached_result" : null,
          !chStatus.applicable ? chStatus.fallbackReason : null,
        ].filter(Boolean),
        unsupported_filters: chStatus.unsupportedFilters,
        filters_applied: chStatus.filtersApplied,
        dataStoreSource,
        legacyWarehousePending,
        legacyWarehouseProgress,
        warehouseVersion,
      });
    }
  }, [needLegacy, cohortsSource, chResult, chStatus.error, chStatus.applicable, chStatus.unsupportedFilters, chStatus.fallbackReason, chStatus.filtersApplied, appliedTrafficSourceFilter, dataStoreSource, legacyWarehousePending, legacyWarehouseProgress, warehouseVersion]);
  useEffect(() => {
    if (!needLegacy || dataStoreSource !== "mock" || legacyWarehouseLoadState !== "idle") return;
    let mounted = true;
    setLegacyWarehouseLoadState("loading");
    traceEvent("cohorts.legacy_warehouse_load_started", {
      reason: chStatus.fallbackReason ?? "legacy fallback",
    });
    void autoLoadWarehouseIntoStore()
      .then((result) => {
        traceEvent("cohorts.legacy_warehouse_load_completed", {
          status: result.status,
          count: result.count,
        });
      })
      .catch((error) => {
        traceEvent("cohorts.legacy_warehouse_load_failed", {
          error_class: error instanceof Error ? error.name : typeof error,
        });
      })
      .finally(() => {
        if (mounted) setLegacyWarehouseLoadState("settled");
      });
    return () => {
      mounted = false;
    };
  }, [needLegacy, dataStoreSource, legacyWarehouseLoadState, chStatus.fallbackReason, appliedTrafficSourceFilter]);
  // True when ClickHouse aggregates drive the table, options and diagnostics
  // (so the legacy client compute below runs on an empty list).
  const clickHouseDriving = cohortsSource === "clickhouse" && chResult != null && !legacyRowsReady;
  const fbAllocationDiagnostics = clickHouseDriving ? chResult?.fbAllocationDiagnostics : undefined;
  // In ClickHouse mode with ClickHouse driving, feed an EMPTY list to the legacy
  // compute + option builders so the browser performs NO transaction scan.
  const analyticsTxs = useMemo(
    () => (legacyRowsReady ? backfillTransactionCardTypesFromRawRows(txs, rawPalmerRows) : []),
    [legacyRowsReady, txs, rawPalmerRows],
  );
  const trialAttributionTxs = useMemo(
    () => analyticsTxs.filter((t) => t.status === "success" && t.transaction_type === "trial"),
    [analyticsTxs],
  );
  const trafficSourceOptions = useMemo(
    () =>
      clickHouseDriving && chResult?.filterOptions
        ? chResult.filterOptions.traffic_source
        : Array.from(new Set(trialAttributionTxs.map((t) => t.traffic_source))).sort(),
    [clickHouseDriving, chResult, trialAttributionTxs],
  );
  const parentAttributionTxs = useMemo(
    () => filterTransactionsByTrialAttribution(analyticsTxs, { trafficSourceFilter: appliedTrafficSourceFilter }),
    [analyticsTxs, appliedTrafficSourceFilter],
  );
  const sourceFilteredTxs = useMemo(
    () => filterTransactionsByTrialAttribution(analyticsTxs, { trafficSourceFilter: appliedTrafficSourceFilter, selectedCampaignIds: appliedSelectedCampaignIds }),
    [analyticsTxs, appliedTrafficSourceFilter, appliedSelectedCampaignIds]
  );
  const parentCohortResult = useMemo(
    () => computeCohortsWithDiagnostics(parentAttributionTxs, subscriptions, { maxRenewalDepth: maxRenewalColumns, selectedCountries: appliedSelectedCountries, selectedCardTypes: effectiveSelectedCardTypes, selectedMediaBuyers: effectiveSelectedMediaBuyers, selectedCurrencies }),
    [parentAttributionTxs, subscriptions, maxRenewalColumns, appliedSelectedCountries, effectiveSelectedCardTypes, effectiveSelectedMediaBuyers, selectedCurrencies],
  );
  const parentCohorts = parentCohortResult.cohorts;
  // With no Campaign ID filter active, sourceFilteredTxs === parentAttributionTxs, so allCohorts is
  // identical to parentCohorts. Reuse it instead of recomputing the full cohort set a second time.
  const allCohortResult = useMemo(
    () =>
      (appliedSelectedCampaignIds?.length ?? 0) === 0
        ? parentCohortResult
        : computeCohortsWithDiagnostics(sourceFilteredTxs, subscriptions, { maxRenewalDepth: maxRenewalColumns, selectedCountries: appliedSelectedCountries, selectedCardTypes: effectiveSelectedCardTypes, selectedMediaBuyers: effectiveSelectedMediaBuyers, selectedCurrencies }),
    [appliedSelectedCampaignIds, parentCohortResult, sourceFilteredTxs, subscriptions, maxRenewalColumns, appliedSelectedCountries, effectiveSelectedCardTypes, effectiveSelectedMediaBuyers, selectedCurrencies],
  );
  const allCohorts = allCohortResult.cohorts;
  // Diagnostics panels use ClickHouse dataset-level diagnostics when driving,
  // else the legacy compute's diagnostics.
  const tokenDiagnostics = clickHouseDriving && chResult?.tokenDiagnostics ? chResult.tokenDiagnostics : allCohortResult.tokenDiagnostics;
  const fxDiagnostics = clickHouseDriving && chResult?.fxDiagnostics ? chResult.fxDiagnostics : allCohortResult.fxDiagnostics;
  // Snapshot freshness from ONE response bundle (never from a second cached
  // query): stale snapshots render as stale and kick off one background rebuild.
  const snapshotHealth = useMemo(
    () =>
      deriveCohortSnapshotHealth(chResult?.diagnostics, chResult?.fxDiagnostics, {
        mediaBuyerFilterActive: (effectiveSelectedMediaBuyers?.length ?? 0) > 0,
      }),
    [chResult, effectiveSelectedMediaBuyers],
  );
  useEffect(() => {
    if (!clickHouseDriving || snapshotHealth.status !== "stale") return;
    ensureCohortSnapshotRebuild(snapshotHealth);
  }, [clickHouseDriving, snapshotHealth]);
  const trafficByKey = useMemo(() => aggregateTrafficMetrics(trafficMetrics), [trafficMetrics]);
  // Funnel / campaign-path dropdowns: from server-built options when driving from
  // ClickHouse (unfiltered lists), else derived from the legacy cohorts.
  const funnelOptions = useMemo(
    () =>
      clickHouseDriving && chResult?.filterOptions
        ? chResult.filterOptions.funnel
        : Array.from(new Set(parentCohorts.map((c) => c.funnel))).sort(),
    [clickHouseDriving, chResult, parentCohorts],
  );
  const campaignPathOptions = useMemo(() => {
    if (clickHouseDriving && chResult?.filterOptions) return chResult.filterOptions.campaign_path;
    const optionCohorts = funnelFilter !== "all" ? parentCohorts.filter((c) => c.funnel === funnelFilter) : parentCohorts;
    return Array.from(new Set(optionCohorts.map((c) => c.campaign_path))).sort();
  }, [clickHouseDriving, chResult, parentCohorts, funnelFilter]);
  // Legacy path only: the ClickHouse path prunes every dimension together in the
  // cascading pruner below (which additionally waits for the CURRENT scope's
  // options, so a keepPreviousData list can never clear a valid selection).
  useEffect(() => {
    if (clickHouseDriving) return;
    if (campaignPathFilter === "all" || campaignPathOptions.includes(campaignPathFilter)) return;
    markCohortsUiSettingsUpdated();
    setUiState((current) => ({ ...current, campaignPathFilter: "all" }));
  }, [clickHouseDriving, campaignPathFilter, campaignPathOptions, setUiState]);
  const filteredCohortResult = useMemo(
    () =>
      filterCohortsWithDiagnostics(allCohorts, {
        funnelFilter,
        campaignPathFilter,
        refundFilter,
        cohortDateFrom,
        cohortDateTo,
      }),
    [allCohorts, funnelFilter, campaignPathFilter, refundFilter, cohortDateFrom, cohortDateTo],
  );
  const filteredCohorts = filteredCohortResult.cohorts;

  // ClickHouse drives the table when it is the active engine and no fallback is
  // needed (see clickHouseDriving); otherwise the legacy filtered cohorts are used.
  const effectiveFilteredCohorts = useMemo(
    () => (clickHouseDriving && chResult ? chResult.cohorts : filteredCohorts),
    [clickHouseDriving, chResult, filteredCohorts],
  );

  const cohortRowFilters = useMemo(
    () => ({
      funnelFilter,
      campaignPathFilter,
      refundFilter,
      cohortDateFrom,
      cohortDateTo,
    }),
    [funnelFilter, campaignPathFilter, refundFilter, cohortDateFrom, cohortDateTo],
  );
  const campaignIdOptions = useMemo(
    () =>
      clickHouseDriving && chResult?.filterOptions
        ? chResult.filterOptions.campaign_id
        : buildCampaignIdOptions({
            txs: analyticsTxs,
            subscriptions,
            filters: cohortRowFilters,
            trafficSourceFilter: appliedTrafficSourceFilter,
            selectedCountries: appliedSelectedCountries,
            selectedCardTypes: effectiveSelectedCardTypes,
            selectedMediaBuyers: effectiveSelectedMediaBuyers,
            maxRenewalDepth: maxRenewalColumns,
          }),
    [clickHouseDriving, chResult, analyticsTxs, subscriptions, cohortRowFilters, appliedTrafficSourceFilter, appliedSelectedCountries, effectiveSelectedCardTypes, effectiveSelectedMediaBuyers, maxRenewalColumns],
  );
  const campaignIdOptionIds = useMemo(() => new Set(campaignIdOptions.map((option) => option.campaign_id)), [campaignIdOptions]);
  useEffect(() => {
    if (!analyticsTxs.length) return;
    if (!selectedCampaignIds.length && (!legacyCampaignIdFilter || legacyCampaignIdFilter === "all")) return;
    const next = selectedCampaignIds.filter((id) => campaignIdOptionIds.has(id));
    if (next.length === selectedCampaignIds.length && (!legacyCampaignIdFilter || legacyCampaignIdFilter === "all")) return;
    markCohortsUiSettingsUpdated();
    setUiState((current) => ({ ...current, selectedCampaignIds: next, campaignIdFilter: "all" }));
  }, [analyticsTxs.length, campaignIdOptionIds, legacyCampaignIdFilter, selectedCampaignIds, setUiState]);
  const countryOptions = useMemo(
    () =>
      clickHouseDriving && chResult?.filterOptions
        ? chResult.filterOptions.country
        : buildCohortGeoOptions({
            txs: sourceFilteredTxs,
            subscriptions,
            filters: cohortRowFilters,
            selectedCardTypes: effectiveSelectedCardTypes,
            selectedMediaBuyers: effectiveSelectedMediaBuyers,
            maxRenewalDepth: maxRenewalColumns,
          }),
    [clickHouseDriving, chResult, sourceFilteredTxs, subscriptions, cohortRowFilters, effectiveSelectedCardTypes, effectiveSelectedMediaBuyers, maxRenewalColumns],
  );
  const cardTypeOptions = useMemo(
    () =>
      clickHouseDriving && chResult?.filterOptions
        ? chResult.filterOptions.card_type
        : buildCohortCardTypeOptions({
            txs: sourceFilteredTxs,
            subscriptions,
            filters: cohortRowFilters,
            selectedCountries: appliedSelectedCountries,
            selectedMediaBuyers: effectiveSelectedMediaBuyers,
            maxRenewalDepth: maxRenewalColumns,
          }),
    [clickHouseDriving, chResult, sourceFilteredTxs, subscriptions, cohortRowFilters, appliedSelectedCountries, effectiveSelectedMediaBuyers, maxRenewalColumns],
  );
  const mediaBuyerOptions = useMemo(
    () =>
      clickHouseDriving && chResult?.filterOptions
        ? chResult.filterOptions.media_buyer
        : buildMediaBuyerOptions({
            txs: analyticsTxs,
            subscriptions,
            filters: cohortRowFilters,
            trafficSourceFilter: appliedTrafficSourceFilter,
            selectedCampaignIds: appliedSelectedCampaignIds,
            selectedCountries: appliedSelectedCountries,
            selectedCardTypes: effectiveSelectedCardTypes,
            maxRenewalDepth: maxRenewalColumns,
          }),
    [clickHouseDriving, chResult, analyticsTxs, subscriptions, cohortRowFilters, appliedTrafficSourceFilter, appliedSelectedCampaignIds, appliedSelectedCountries, effectiveSelectedCardTypes, maxRenewalColumns],
  );
  const utmSourceOptions = useMemo(
    () =>
      clickHouseDriving && chResult?.filterOptions
        ? chResult.filterOptions.utm_source
        : buildUtmSourceOptions({
            txs: analyticsTxs,
            subscriptions,
            filters: cohortRowFilters,
            trafficSourceFilter: appliedTrafficSourceFilter,
            selectedCampaignIds: appliedSelectedCampaignIds,
            selectedCountries: appliedSelectedCountries,
            selectedCardTypes: effectiveSelectedCardTypes,
            maxRenewalDepth: maxRenewalColumns,
          }),
    [clickHouseDriving, chResult, analyticsTxs, subscriptions, cohortRowFilters, appliedTrafficSourceFilter, appliedSelectedCampaignIds, appliedSelectedCountries, effectiveSelectedCardTypes, maxRenewalColumns],
  );
  // ONE dropdown, three groups: media buyer names (existing order), then the
  // UTM entries, then Unknown pinned last. UTM entries are an additional filter
  // category (their users are a slice of Unknown), never a replacement.
  const mediaBuyerFilterItems = useMemo(() => {
    const buyers = mediaBuyerOptions.map((option) => ({ value: option.media_buyer as string, label: formatMediaBuyerOptionLabel(option) }));
    const utm = utmSourceOptions.map((option) => ({ value: utmSelectionValue(option.utm_source), label: formatUtmSourceOptionLabel(option) }));
    const named = buyers.filter((item) => item.value !== "Unknown");
    const unknown = buyers.filter((item) => item.value === "Unknown");
    return [...named, ...utm, ...unknown];
  }, [mediaBuyerOptions, utmSourceOptions]);
  const mediaBuyerOptionIds = useMemo(() => new Set(mediaBuyerFilterItems.map((item) => item.value)), [mediaBuyerFilterItems]);
  useEffect(() => {
    if (!analyticsTxs.length || !selectedMediaBuyers.length) return;
    const next = selectedMediaBuyers.filter((mediaBuyer) => mediaBuyerOptionIds.has(mediaBuyer));
    if (next.length === selectedMediaBuyers.length) return;
    markCohortsUiSettingsUpdated();
    setUiState((current) => ({ ...current, selectedMediaBuyers: next }));
  }, [analyticsTxs.length, mediaBuyerOptionIds, selectedMediaBuyers, setUiState]);
  // Currency: scoped to the current filters when ClickHouse drives (a currency with
  // no cohort users in scope is not offered); the static SUPPORTED_CURRENCIES list
  // remains the legacy/no-data fallback.
  const currencyOptions = useMemo<string[]>(
    () =>
      clickHouseDriving && chResult?.filterOptions?.currency?.length
        ? chResult.filterOptions.currency
        : [...SUPPORTED_CURRENCIES],
    [clickHouseDriving, chResult],
  );

  // --- Cascading filters: invalid downstream selection handling --------------
  // Changing an upstream filter can strand a downstream selection (Country=CA, then
  // Campaign Path switches to a path with no CA users). Each server option list is
  // computed with all active filters EXCEPT its own dimension, so a selected value
  // absent from its own list provably has zero cohort users under the other active
  // filters. pruneInvalidCohortSelections clears exactly those, nothing else — and
  // only ever removes, so it reaches a fixed point (no reset/refetch loop).
  //
  // Gated on isFilterScopeCurrent: while keepPreviousData is showing the PREVIOUS
  // scope's response, its option lists describe the old filters and must not be
  // treated as authoritative.
  const scopedOptions = clickHouseDriving && isFilterScopeCurrent ? chResult?.filterOptions : undefined;
  const liveSelection = useMemo(
    () => ({
      funnelFilter,
      campaignPathFilter,
      trafficSourceFilter,
      currencyFilter,
      selectedCountries,
      selectedCardTypes,
      selectedMediaBuyers,
      selectedCampaignIds,
    }),
    [funnelFilter, campaignPathFilter, trafficSourceFilter, currencyFilter, selectedCountries, selectedCardTypes, selectedMediaBuyers, selectedCampaignIds],
  );
  useEffect(() => {
    const patch = pruneInvalidCohortSelections(liveSelection, scopedOptions);
    if (!patch) return;
    traceEvent("cohorts.invalid_filters_cleared", { dimensions: Object.keys(patch).join(",") });
    markCohortsUiSettingsUpdated();
    setUiState((current) => ({ ...current, ...patch }));
  }, [liveSelection, scopedOptions, setUiState]);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    console.debug("[Cohorts filters]", filteredCohortResult.diagnostics);
  }, [filteredCohortResult.diagnostics]);
  useEffect(() => {
    // Phase 8 developer diagnostics: unmapped monetization products (no emails).
    if (!import.meta.env.DEV || !tokenDiagnostics.unknown_products.length) return;
    console.debug("[Cohorts] Unknown monetization products — add to monetizationProductMap.ts", tokenDiagnostics.unknown_products);
  }, [tokenDiagnostics]);
  const cohorts = useMemo(
    () => {
      if (sortColumn && sortDirection) {
        return sortCohortRows(
          effectiveFilteredCohorts,
          { sortColumn, sortDirection },
          (cohort) => trafficForCohort(cohort, trafficByKey),
        );
      }

      return [...effectiveFilteredCohorts].sort((a, b) => {
        const aDate = normalizeCohortDateKey(a.cohort_date);
        const bDate = normalizeCohortDateKey(b.cohort_date);
        if (aDate && bDate) return bDate.localeCompare(aDate);
        if (aDate) return -1;
        if (bDate) return 1;
        return b.cohort_date.localeCompare(a.cohort_date);
      });
    },
    [effectiveFilteredCohorts, sortColumn, sortDirection, trafficByKey]
  );
  const hasUsers = useMemo(() => new Set(txs.map((t) => t.user_id)).size > 0, [txs]);

  // Export the CURRENTLY visible table (visible columns, current order, current
  // sort/filters) to CSV or XLSX. Values resolve through the same field/traffic
  // resolver as sorting, so exports include every FB column automatically.
  const exportCohortsTable = async (format: "csv" | "xlsx") => {
    const exportColumns = columnOrder.filter((id) => columnVisibility[id] !== false);
    const table = buildCohortsExportTable({
      cohorts,
      columnOrder: exportColumns,
      columnLabel,
      trafficForCohort: (cohort) => trafficForCohort(cohort, trafficByKey),
    });
    const stamp = new Date().toISOString().slice(0, 10);
    if (format === "csv") {
      const blob = new Blob(["\uFEFF", cohortsTableToCsv(table)], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `cohorts-${stamp}.csv`;
      link.click();
      URL.revokeObjectURL(url);
      return;
    }
    const XLSX = await import("xlsx");
    const sheet = XLSX.utils.aoa_to_sheet([table.headers, ...table.rows]);
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, "Cohorts");
    XLSX.writeFile(book, `cohorts-${stamp}.xlsx`);
  };
  useEffect(() => {
    if (firstRowsRef.current || cohorts.length === 0) return;
    firstRowsRef.current = true;
    traceMark("cohorts.first_table_row_rendered", {
      row_count: cohorts.length,
      source: clickHouseDriving ? "clickhouse" : "legacy",
      cached_or_network: chResult != null && isBackgroundRefreshing ? "cached_refreshing" : chResult != null ? "query_data" : "legacy",
    });
    traceMeasure("cohorts.time_to_first_row", "route.cohorts.mounted", "cohorts.first_table_row_rendered", { row_count: cohorts.length });
  }, [cohorts.length, clickHouseDriving, chResult, isBackgroundRefreshing]);
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
    const next = [...defaultColumnOrder];
    setColumnOrder(next);
    try {
      localStorage.removeItem(COLUMN_ORDER_STORAGE_KEY);
    } catch (error) {
      console.warn("Unable to reset cohort column order", error);
    }
    resetColumnWidths();
  };

  const allViews = useMemo<SavedView[]>(() => [...builtinViews, ...customViews], [builtinViews, customViews]);
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
    const order = sanitizeColumnOrder(view.order, defaultColumnOrder);
    const visibility = sanitizeColumnVisibility(view.visibility, defaultVisibility, defaultColumnOrder);
    const widths = view.widths
      ? sanitizeColumnWidths(view.widths, defaultColumnWidths, [COHORT_FIRST_COL_KEY, ...defaultColumnOrder])
      : null;
    setColumnOrder(order);
    setColumnVisibility(visibility);
    persistColumnOrder(order);
    persistVisibility(visibility);
    if (view.widths) {
      setColumnWidths(widths ?? defaultColumnWidths);
      persistColumnWidths(widths ?? defaultColumnWidths);
    }
    setActiveViewId(view.id);
    try { localStorage.setItem(ACTIVE_VIEW_STORAGE_KEY, view.id); } catch { /* noop */ }
    markCohortsUiSettingsUpdated();
  };

  const resetToDefault = () => {
    applyView(builtinViews[0]);
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
  // table-layout:fixed needs an explicit total width — with table-layout:auto (the
  // default), the browser ignores a column's requested width whenever it's narrower
  // than the header/cell content, which silently breaks shrinking columns via drag.
  const tableTotalWidth = useMemo(() => {
    const firstColWidth = columnWidths[COHORT_FIRST_COL_KEY] ?? defaultColumnWidths[COHORT_FIRST_COL_KEY] ?? 150;
    return visibleColumnOrder.reduce(
      (sum, id) => sum + (columnWidths[id] ?? defaultColumnWidths[id] ?? MIN_COLUMN_WIDTH),
      firstColWidth,
    );
  }, [columnWidths, defaultColumnWidths, visibleColumnOrder]);

  const maxUpsellCR = Math.max(0, ...cohorts.map((c) => c.trial_to_upsell_cr));
  const maxSubCR = Math.max(0, ...cohorts.map((c) => c.trial_to_first_subscription_cr));
  const maxRenewal2CR = Math.max(0, ...cohorts.map((c) => c.first_subscription_to_renewal_2_cr));
  const maxRenewal3CR = Math.max(0, ...cohorts.map((c) => c.renewal_2_to_renewal_3_cr));
  const maxRenewal4CR = Math.max(0, ...cohorts.map((c) => c.renewal_3_to_renewal_4_cr ?? 0));
  const maxRenewal5CR = Math.max(0, ...cohorts.map((c) => c.renewal_4_to_renewal_5_cr ?? 0));
  const maxRenewal6CR = Math.max(0, ...cohorts.map((c) => c.renewal_5_to_renewal_6_cr ?? 0));
  const totals = useMemo(() => {
    const sum = (pick: (c: (typeof cohorts)[number]) => number) =>
      cohorts.reduce((total, cohort) => total + pick(cohort), 0);
    const totalTrialUsers = sum((c) => c.trial_users);
    const totalSupportUsers = sum((c) => c.support_users ?? 0);
    const totalUpsellUsers = sum((c) => c.upsell_users);
    const totalFirstSubscriptionUsers = sum((c) => c.first_subscription_users);
    const renewalTotalsByLevel = Object.fromEntries(
      renewalColumnIds(maxRenewalColumns).map((id) => {
        const level = renewalLevelFromColumnId(id) ?? 0;
        return [level, sum((c) => renewalUsersForLevel(c, level))];
      }),
    );
    const totalRenewal2Users = renewalTotalsByLevel[2] ?? 0;
    const totalRenewal3Users = renewalTotalsByLevel[3] ?? 0;
    const totalRenewal4Users = renewalTotalsByLevel[4] ?? 0;
    const totalRenewal5Users = renewalTotalsByLevel[5] ?? 0;
    const totalRenewal6Users = renewalTotalsByLevel[6] ?? 0;
    const totalRenewalUsers = sum((c) => c.renewal_users);
    const totalRefundUsers = new Set(cohorts.flatMap((c) => c.refunded_user_ids)).size;
    const totalActiveUsers = new Set(cohorts.flatMap((c) => c.active_user_ids)).size;
    // Dedup by active subscription_id across visible cohorts (not user ids).
    const totalActiveSubscriptions = new Set(cohorts.flatMap((c) => c.active_subscription_ids ?? [])).size;
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
      totalSupportUsers,
      totalSupportRate: totalTrialUsers ? (totalSupportUsers / totalTrialUsers) * 100 : 0,
      totalUpsellUsers,
      totalFirstSubscriptionUsers,
      totalRenewal2Users,
      totalRenewal3Users,
      totalRenewal4Users,
      totalRenewal5Users,
      totalRenewal6Users,
      renewalTotalsByLevel,
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
      // Weighted realized 1M LTV, NOT the average of per-cohort ltv_1m_per_user.
      ltv1mPerUser: totalTrialUsers ? totalRevenueD30 / totalTrialUsers : 0,
      trafficSpend: totalTrafficSpend,
      hasTrafficSpend,
      hasCompleteTrafficSpend,
      trialCost: trialCostFromSpend(hasTrafficSpend ? totalTrafficSpend : null, totalTrialUsers),
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
      // Renewal N → N+1 total CRs recomputed from summed level totals; null when
      // the denominator level is empty so the row renders "—", never NaN.
      renewal3ToRenewal4Cr: totalRenewal3Users ? (totalRenewal4Users / totalRenewal3Users) * 100 : null,
      renewal4ToRenewal5Cr: totalRenewal4Users ? (totalRenewal5Users / totalRenewal4Users) * 100 : null,
      renewal5ToRenewal6Cr: totalRenewal5Users ? (totalRenewal6Users / totalRenewal5Users) * 100 : null,
      // Monetization total CRs are recomputed from summed totals, not averaged.
      monetization: computeCohortMonetizationTotals(cohorts, totalTrialUsers),
      fxMissingTransactions: sum((c) => c.fx_missing_transactions ?? 0),
    };
  }, [cohorts, trafficByKey, maxRenewalColumns]);
  const aggregatedTokenPacks = useMemo<TokenPackRow[]>(
    () => aggregateTokenPackBreakdowns(cohorts.map((c) => c.token_pack_breakdown ?? [])),
    [cohorts],
  );

  const headerClassFor = (id: CohortColumnId) =>
    `${TEXT_COLUMNS.has(id) ? `${HEAD_BASE} text-left` : HEAD_NUM} ${SECTION_DIVIDER_COLUMNS.has(id) ? SECTION_DIVIDER : ""}`;
  const cellClassFor = (id: CohortColumnId, child = false) => {
    const base = child
      ? TEXT_COLUMNS.has(id)
        ? "py-1.5 px-3 text-xs text-muted-foreground/60 whitespace-nowrap overflow-hidden text-ellipsis"
        : "py-1.5 px-3 text-right text-xs text-muted-foreground tabular-nums whitespace-nowrap overflow-hidden text-ellipsis"
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
  const countrySummary = selectedCountries.length ? selectedCountries.join(", ") : "All countries";
  const cardTypeSummary = selectedCardTypes.length ? selectedCardTypes.map(cardTypeLabel).join(", ") : "All card types";
  const mediaBuyerSummary = selectedMediaBuyers.length ? selectedMediaBuyers.map(mediaBuyerSelectionLabel).join(", ") : "All media buyers";
  const toggleCountry = (country: string) => {
    const normalized = normalizeCountryCode(country);
    if (!normalized) return;
    const next = selectedCountries.includes(normalized)
      ? selectedCountries.filter((value) => value !== normalized)
      : [...selectedCountries, normalized].sort();
    updateUiState({ selectedCountries: next });
  };
  const clearCountries = () => updateUiState({ selectedCountries: [] });
  const toggleCardType = (cardType: CardType) => {
    const next = selectedCardTypes.includes(cardType)
      ? selectedCardTypes.filter((value) => value !== cardType)
      : [...selectedCardTypes, cardType];
    updateUiState({ selectedCardTypes: next });
  };
  const clearCardTypes = () => updateUiState({ selectedCardTypes: [] });
  const toggleMediaBuyer = (selectionValue: MediaBuyer | string) => {
    const next = selectedMediaBuyers.includes(selectionValue)
      ? selectedMediaBuyers.filter((value) => value !== selectionValue)
      : [...selectedMediaBuyers, selectionValue];
    updateUiState({ selectedMediaBuyers: next });
  };
  const clearMediaBuyers = () => updateUiState({ selectedMediaBuyers: [] });
  const toggleCampaignId = (campaignId: string) => {
    const next = selectedCampaignIds.includes(campaignId)
      ? selectedCampaignIds.filter((value) => value !== campaignId)
      : [...selectedCampaignIds, campaignId].sort();
    updateUiState({ selectedCampaignIds: next, campaignIdFilter: "all" });
  };
  const clearCampaignIds = () => updateUiState({ selectedCampaignIds: [], campaignIdFilter: "all" });
  const campaignIdOptionById = useMemo(
    () => new Map(campaignIdOptions.map((option) => [option.campaign_id, option])),
    [campaignIdOptions],
  );
  const campaignIdSummary = selectedCampaignIds.length === 0
    ? "All campaign IDs"
    : selectedCampaignIds.length === 1
      ? (campaignIdOptionById.get(selectedCampaignIds[0])?.campaign_name
          ? `${campaignIdOptionById.get(selectedCampaignIds[0])?.campaign_name} (${selectedCampaignIds[0]})`
          : selectedCampaignIds[0])
      : `${selectedCampaignIds.length} campaign IDs`;
  const visibleCampaignIdOptions = useMemo(() => {
    const query = campaignIdSearch.trim().toLowerCase();
    if (!query) return campaignIdOptions;
    return campaignIdOptions.filter((option) =>
      `${option.campaign_id} ${option.campaign_name ?? ""}`.toLowerCase().includes(query),
    );
  }, [campaignIdOptions, campaignIdSearch]);
  const trafficNotes = [
    hasGeoFilter ? TRAFFIC_GEO_NOTE : null,
    hasCardTypeFilter ? TRAFFIC_CARD_TYPE_NOTE : null,
    hasCampaignIdFilter ? TRAFFIC_CAMPAIGN_ID_NOTE : null,
    hasMediaBuyerFilter ? TRAFFIC_MEDIA_BUYER_NOTE : null,
  ].filter(Boolean);
  const trafficCellTitle = trafficNotes.length ? trafficNotes.join(" ") : undefined;

  const renderHeaderCell = (id: CohortColumnId) => (
    <TableHead
      key={id}
      className={headerClassFor(id)}
      style={{ width: columnWidths[id], minWidth: MIN_COLUMN_WIDTH }}
      title={trafficCellTitle && isTrafficDerivedColumn(id) ? trafficCellTitle : COLUMN_HELP[id]}
      draggable
      onDragStart={() => onHeaderDragStart(id)}
      onDragOver={onHeaderDragOver}
      onDrop={() => onHeaderDrop(id)}
    >
      <button
        type="button"
        onClick={() => onSortColumn(id)}
        className="inline-flex max-w-full items-center gap-1 hover:text-foreground"
        aria-label={`Sort by ${columnLabel(id)}`}
      >
        <GripVertical className="h-3 w-3 shrink-0 cursor-grab opacity-40 active:cursor-grabbing" />
        <span className="line-clamp-2 min-w-0 whitespace-normal break-words leading-tight">{columnLabel(id)}</span>
        <span className="shrink-0">{sortIcon(id)}</span>
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
    const renewalUsers = renewalUsersForColumn(c, id);
    if (renewalUsers != null) return <TableCell key={id} className={className}>{renewalUsers}</TableCell>;
    switch (id) {
      case "cohort_date":
        return <TableCell key={id} className={`${className} tabular-nums`}>{c.cohort_date}</TableCell>;
      case "campaign_path":
        return <TableCell key={id} className={className}>{c.campaign_path}</TableCell>;
      case "funnel":
        return <TableCell key={id} className={`${className} capitalize`}>{c.funnel.replace("_", " ")}</TableCell>;
      case "trial_users":
        return <TableCell key={id} className={className}>{c.trial_users}</TableCell>;
      case "support_users":
        return <TableCell key={id} className={className}>{c.support_users ?? 0}</TableCell>;
      case "support_rate":
        return <TableCell key={id} className={className}>{formatPct(c.support_rate ?? 0)}</TableCell>;
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
      case "fb_spend":
      case "fb_purchases":
      case "fb_cpp":
      case "fb_impressions":
      case "fb_reach":
      case "fb_clicks":
      case "fb_link_clicks":
      case "fb_ctr":
      case "fb_cpc":
      case "fb_cpm":
      case "fb_purchase_value":
      case "fb_roas":
      case "fb_cac":
      case "fb_cost_per_trial":
      case "fb_cost_per_upsell":
      case "fb_gross_roas":
      case "fb_net_roas":
      case "fb_profit":
      case "fb_margin": {
        const text = fbCohortCellText(c, id);
        const unavailableReason = fbUnavailableReason(c.fb_match_status);
        return <TableCell key={id} className={className} title={unavailableReason ?? undefined}>{text === "—" ? dash : text}</TableCell>;
      }
      case "renewal_2_to_renewal_3_cr":
        return <TableCell key={id} className={`${className} font-medium`} style={heatStyle(c.renewal_2_to_renewal_3_cr, maxRenewal3CR)}>{formatPct(c.renewal_2_to_renewal_3_cr)}</TableCell>;
      // Renewal N → N+1 CR: "—" when the denominator level has no users yet.
      // `?? 0` guards rows rehydrated from a pre-v3 cache that lacks the fields.
      case "renewal_3_to_renewal_4_cr":
        return <TableCell key={id} className={`${className} font-medium`} style={heatStyle(c.renewal_3_to_renewal_4_cr ?? 0, maxRenewal4CR)}>{renewalUsersForLevel(c, 3) > 0 ? formatPct(c.renewal_3_to_renewal_4_cr ?? 0) : dash}</TableCell>;
      case "renewal_4_to_renewal_5_cr":
        return <TableCell key={id} className={`${className} font-medium`} style={heatStyle(c.renewal_4_to_renewal_5_cr ?? 0, maxRenewal5CR)}>{renewalUsersForLevel(c, 4) > 0 ? formatPct(c.renewal_4_to_renewal_5_cr ?? 0) : dash}</TableCell>;
      case "renewal_5_to_renewal_6_cr":
        return <TableCell key={id} className={`${className} font-medium`} style={heatStyle(c.renewal_5_to_renewal_6_cr ?? 0, maxRenewal6CR)}>{renewalUsersForLevel(c, 5) > 0 ? formatPct(c.renewal_5_to_renewal_6_cr ?? 0) : dash}</TableCell>;
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
      case "ltv_1m_per_user":
        return <TableCell key={id} className={className} title={COLUMN_HELP.ltv_1m_per_user}>{formatCurrency(c.ltv_1m_per_user ?? 0)}</TableCell>;
      case "trial_revenue":
        return <TableCell key={id} className={className}>{formatCurrency(c.trial_revenue)}</TableCell>;
      case "upsell_1_users":
        return <TableCell key={id} className={className}>{c.upsell_1_users ?? 0}</TableCell>;
      case "upsell_1_cr":
        return <TableCell key={id} className={className}>{formatPct(c.upsell_1_cr ?? 0)}</TableCell>;
      case "upsell_1_revenue":
        return <TableCell key={id} className={className}>{formatCurrency(c.upsell_1_revenue ?? 0)}</TableCell>;
      case "upsell_2_users":
        return <TableCell key={id} className={className}>{c.upsell_2_users ?? 0}</TableCell>;
      case "upsell_2_cr":
        return <TableCell key={id} className={className}>{formatPct(c.upsell_2_cr ?? 0)}</TableCell>;
      case "upsell_2_revenue":
        return <TableCell key={id} className={className}>{formatCurrency(c.upsell_2_revenue ?? 0)}</TableCell>;
      case "upsell_3_users":
        return <TableCell key={id} className={className}>{c.upsell_3_users ?? 0}</TableCell>;
      case "upsell_3_cr":
        return <TableCell key={id} className={className}>{formatPct(c.upsell_3_cr ?? 0)}</TableCell>;
      case "upsell_3_revenue":
        return <TableCell key={id} className={className}>{formatCurrency(c.upsell_3_revenue ?? 0)}</TableCell>;
      case "upsell_extra_users":
        return <TableCell key={id} className={className}>{c.upsell_extra_users ?? 0}</TableCell>;
      case "upsell_extra_revenue":
        return <TableCell key={id} className={className}>{formatCurrency(c.upsell_extra_revenue ?? 0)}</TableCell>;
      case "funnel_upsell_users":
        return <TableCell key={id} className={className}>{c.funnel_upsell_users ?? 0}</TableCell>;
      case "funnel_upsell_revenue":
        return <TableCell key={id} className={className}>{formatCurrency(c.funnel_upsell_revenue ?? 0)}</TableCell>;
      case "token_buyers":
        return <TableCell key={id} className={className}>{c.token_buyers ?? 0}</TableCell>;
      case "token_buyer_cr":
        return <TableCell key={id} className={className}>{formatPct(c.token_buyer_cr ?? 0)}</TableCell>;
      case "token_purchases":
        return <TableCell key={id} className={className}>{c.token_purchases ?? 0}</TableCell>;
      case "token_gross_revenue":
        return <TableCell key={id} className={className}>{formatCurrency(c.token_gross_revenue ?? 0)}</TableCell>;
      case "token_net_revenue":
        return <TableCell key={id} className={className}>{formatCurrency(c.token_net_revenue ?? 0)}</TableCell>;
      case "avg_token_revenue_per_trial":
        return <TableCell key={id} className={className}>{formatCurrency(c.avg_token_revenue_per_trial ?? 0)}</TableCell>;
      case "avg_token_revenue_per_buyer":
        return <TableCell key={id} className={className}>{formatCurrency(c.avg_token_revenue_per_buyer ?? 0)}</TableCell>;
      case "addon_revenue":
        return <TableCell key={id} className={className}>{formatCurrency(c.addon_revenue ?? 0)}</TableCell>;
      case "currency_mix":
        return <TableCell key={id} className={className}>{c.currency_mix || dash}</TableCell>;
      case "fx_missing_amount":
        return <TableCell key={id} className={className}>{(c.fx_missing_amount ?? 0) > 0 ? (c.fx_missing_amount ?? 0).toFixed(2) : dash}</TableCell>;
      case "fx_missing_transactions":
        return <TableCell key={id} className={className}>{(c.fx_missing_transactions ?? 0) > 0 ? c.fx_missing_transactions : dash}</TableCell>;
      case "traffic_spend":
        return <TableCell key={id} className={className} title={trafficCellTitle}>{traffic ? formatCurrency(traffic.spend) : dash}</TableCell>;
      case "trial_cost": {
        const trialCost = trialCostForCohort(c, traffic);
        return <TableCell key={id} className={className} title={trafficCellTitle}>{trialCost != null ? formatCurrency(trialCost) : dash}</TableCell>;
      }
      case "profit":
        return <TableCell key={id} className={className} title={trafficCellTitle}>{traffic ? formatCurrency(c.net_revenue - traffic.spend) : dash}</TableCell>;
      case "profit_d7":
        return <TableCell key={id} className={className} title={trafficCellTitle}>{traffic ? formatCurrency(c.revenue_d7 - traffic.spend) : dash}</TableCell>;
      case "profit_1m":
        return <TableCell key={id} className={className} title={trafficCellTitle}>{traffic ? formatCurrency(c.revenue_d30 - traffic.spend) : dash}</TableCell>;
      case "profit_2m":
        return <TableCell key={id} className={className} title={trafficCellTitle}>{traffic ? formatCurrency(c.revenue_d60 - traffic.spend) : dash}</TableCell>;
      case "traffic_cac":
        return <TableCell key={id} className={className} title={trafficCellTitle}>{traffic ? formatCurrency(traffic.cac) : dash}</TableCell>;
      case "traffic_trial_count":
        return <TableCell key={id} className={className} title={trafficCellTitle}>{traffic ? traffic.trial_count : dash}</TableCell>;
      case "traffic_clicks":
        return <TableCell key={id} className={className} title={trafficCellTitle}>{traffic ? traffic.clicks : dash}</TableCell>;
      case "traffic_cpc":
        return <TableCell key={id} className={className} title={trafficCellTitle}>{traffic ? formatCurrency(traffic.cpc) : dash}</TableCell>;
      case "traffic_cpm":
        return <TableCell key={id} className={className} title={trafficCellTitle}>{traffic?.cpm != null ? formatCurrency(traffic.cpm) : dash}</TableCell>;
      case "traffic_ctr":
        return <TableCell key={id} className={className} title={trafficCellTitle}>{traffic?.ctr != null ? formatPct(traffic.ctr) : dash}</TableCell>;
      case "roas_d7":
        return <TableCell key={id} className={className} title={trafficCellTitle}>{traffic?.spend ? formatRoas(c.revenue_d7 / traffic.spend) : dash}</TableCell>;
      case "roas_1m":
        return <TableCell key={id} className={className} title={trafficCellTitle}>{traffic?.spend ? formatRoas(c.revenue_d30 / traffic.spend) : dash}</TableCell>;
      case "roas_2m":
        return <TableCell key={id} className={className} title={trafficCellTitle}>{traffic?.spend ? formatRoas(c.revenue_d60 / traffic.spend) : dash}</TableCell>;
    }
  };

  const renderPlanCell = (id: CohortColumnId, plan: PlanBreakdownRow, cohort: CohortRow) => {
    const className = cellClassFor(id, true);
    const traffic = trafficForCohort(cohort, trafficByKey);
    const renewalUsers = renewalUsersForColumn(plan, id);
    if (renewalUsers != null) return <TableCell key={id} className={className}>{renewalUsers}</TableCell>;
    switch (id) {
      case "cohort_date":
      case "campaign_path":
      case "funnel":
        return <TableCell key={id} className={className}>{dash}</TableCell>;
      case "trial_users":
        return <TableCell key={id} className={className}>{plan.trial_users}</TableCell>;
      case "support_users":
      case "support_rate":
        return <TableCell key={id} className={className}>{dash}</TableCell>;
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
      case "renewal_3_to_renewal_4_cr":
        return <TableCell key={id} className={className}>{plan.renewal_3_users > 0 ? formatPct(plan.renewal_3_to_renewal_4_cr ?? 0) : dash}</TableCell>;
      case "renewal_4_to_renewal_5_cr":
        return <TableCell key={id} className={className}>{plan.renewal_4_users > 0 ? formatPct(plan.renewal_4_to_renewal_5_cr ?? 0) : dash}</TableCell>;
      case "renewal_5_to_renewal_6_cr":
        return <TableCell key={id} className={className}>{plan.renewal_5_users > 0 ? formatPct(plan.renewal_5_to_renewal_6_cr ?? 0) : dash}</TableCell>;
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
      case "ltv_1m_per_user":
        return <TableCell key={id} className={className}>{formatCurrency(plan.trial_users ? plan.revenue_d30 / plan.trial_users : 0)}</TableCell>;
      case "trial_cost": {
        const trialCost = trialCostFromSpend(traffic?.spend, plan.trial_users);
        return <TableCell key={id} className={className} title={trafficCellTitle}>{trialCost != null ? formatCurrency(trialCost) : dash}</TableCell>;
      }
      // Monetization metrics are cohort-level (token purchases have no price
      // plan), so plan-breakdown rows show a dash.
      case "trial_revenue":
      case "upsell_1_users":
      case "upsell_1_cr":
      case "upsell_1_revenue":
      case "upsell_2_users":
      case "upsell_2_cr":
      case "upsell_2_revenue":
      case "upsell_3_users":
      case "upsell_3_cr":
      case "upsell_3_revenue":
      case "upsell_extra_users":
      case "upsell_extra_revenue":
      case "funnel_upsell_users":
      case "funnel_upsell_revenue":
      case "token_buyers":
      case "token_buyer_cr":
      case "token_purchases":
      case "token_gross_revenue":
      case "token_net_revenue":
      case "avg_token_revenue_per_trial":
      case "avg_token_revenue_per_buyer":
      case "addon_revenue":
      case "currency_mix":
      case "fx_missing_amount":
      case "fx_missing_transactions":
      case "fb_spend":
      case "fb_purchases":
      case "fb_cpp":
      case "fb_impressions":
      case "fb_reach":
      case "fb_clicks":
      case "fb_link_clicks":
      case "fb_ctr":
      case "fb_cpc":
      case "fb_cpm":
      case "fb_purchase_value":
      case "fb_roas":
      case "fb_cac":
      case "fb_cost_per_trial":
      case "fb_cost_per_upsell":
      case "fb_gross_roas":
      case "fb_net_roas":
      case "fb_profit":
      case "fb_margin":
        return <TableCell key={id} className={className}>{dash}</TableCell>;
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
        return <TableCell key={id} className={className} title={trafficCellTitle}>{dash}</TableCell>;
    }
  };

  const renderTotalCell = (id: CohortColumnId) => {
    const className = cellClassFor(id);
    const renewalLevel = renewalLevelFromColumnId(id);
    if (renewalLevel != null) {
      return <TableCell key={id} className={className}>{totals.renewalTotalsByLevel[renewalLevel] ?? 0}</TableCell>;
    }
    // FB totals come from the SERVER bundle: sums over deduplicated
    // (campaign_id, date) pairs of the visible rows — never row-sum here, or a
    // campaign feeding several funnels on one day would double-count.
    const fbT = clickHouseDriving ? chResult?.fbTotals : undefined;
    switch (id) {
      case "fb_spend":
        return <TableCell key={id} className={className}>{fbT ? formatFbUsd(fbT.fb_spend) : dash}</TableCell>;
      case "fb_purchases":
        return <TableCell key={id} className={className}>{fbT ? formatFbInt(fbT.fb_purchases) : dash}</TableCell>;
      case "fb_cpp":
        return <TableCell key={id} className={className}>{fbT?.fb_cpp != null ? formatFbUsd(fbT.fb_cpp) : dash}</TableCell>;
      case "fb_impressions":
        return <TableCell key={id} className={className}>{fbT ? formatFbInt(fbT.fb_impressions) : dash}</TableCell>;
      case "fb_reach":
        // Reach is not additive across campaigns/days — totals are unavailable.
        return <TableCell key={id} className={className}>{dash}</TableCell>;
      case "fb_clicks":
        return <TableCell key={id} className={className}>{fbT ? formatFbInt(fbT.fb_clicks) : dash}</TableCell>;
      case "fb_link_clicks":
        return <TableCell key={id} className={className}>{fbT?.fb_link_clicks ? formatFbInt(fbT.fb_link_clicks) : dash}</TableCell>;
      case "fb_ctr":
        return <TableCell key={id} className={className}>{fbT?.fb_ctr != null ? formatFbPct(fbT.fb_ctr) : dash}</TableCell>;
      case "fb_cpc":
        return <TableCell key={id} className={className}>{fbT?.fb_cpc != null ? formatFbUsd(fbT.fb_cpc) : dash}</TableCell>;
      case "fb_cpm":
        return <TableCell key={id} className={className}>{fbT?.fb_cpm != null ? formatFbUsd(fbT.fb_cpm) : dash}</TableCell>;
      case "fb_purchase_value":
        return <TableCell key={id} className={className}>{fbT?.fb_purchase_value ? formatFbUsd(fbT.fb_purchase_value) : dash}</TableCell>;
      case "fb_roas":
        return <TableCell key={id} className={className}>{fbT?.fb_roas != null ? formatFbRoas(fbT.fb_roas) : dash}</TableCell>;
      case "fb_cac":
        return <TableCell key={id} className={className}>{fbT?.fb_spend != null && totals.totalFirstSubscriptionUsers > 0 ? formatFbUsd(fbT.fb_spend / totals.totalFirstSubscriptionUsers) : dash}</TableCell>;
      case "fb_cost_per_trial":
        return <TableCell key={id} className={className}>{fbT?.fb_spend != null && totals.totalTrialUsers > 0 ? formatFbUsd(fbT.fb_spend / totals.totalTrialUsers) : dash}</TableCell>;
      case "fb_cost_per_upsell":
        return <TableCell key={id} className={className}>{fbT?.fb_spend != null && totals.totalUpsellUsers > 0 ? formatFbUsd(fbT.fb_spend / totals.totalUpsellUsers) : dash}</TableCell>;
      case "fb_gross_roas":
        return <TableCell key={id} className={className}>{fbT?.fb_spend != null && fbT.fb_spend > 0 ? formatFbRoas(totals.grossRevenue / fbT.fb_spend) : dash}</TableCell>;
      case "fb_net_roas":
        return <TableCell key={id} className={className}>{fbT?.fb_spend != null && fbT.fb_spend > 0 ? formatFbRoas(totals.netRevenue / fbT.fb_spend) : dash}</TableCell>;
      case "fb_profit":
        return <TableCell key={id} className={className}>{fbT?.fb_spend != null ? formatFbUsd(totals.netRevenue - fbT.fb_spend) : dash}</TableCell>;
      case "fb_margin":
        return <TableCell key={id} className={className}>{fbT?.fb_spend != null && totals.netRevenue > 0 ? formatFbPct(((totals.netRevenue - fbT.fb_spend) / totals.netRevenue) * 100) : dash}</TableCell>;
      case "cohort_date":
      case "campaign_path":
      case "funnel":
        return <TableCell key={id} className={className}>—</TableCell>;
      case "trial_users":
        return <TableCell key={id} className={className}>{totals.totalTrialUsers}</TableCell>;
      case "support_users":
        return <TableCell key={id} className={className}>{totals.totalSupportUsers}</TableCell>;
      case "support_rate":
        return <TableCell key={id} className={className}>{formatPct(totals.totalSupportRate)}</TableCell>;
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
      case "renewal_3_to_renewal_4_cr":
        return <TableCell key={id} className={className}>{totals.renewal3ToRenewal4Cr != null ? formatPct(totals.renewal3ToRenewal4Cr) : dash}</TableCell>;
      case "renewal_4_to_renewal_5_cr":
        return <TableCell key={id} className={className}>{totals.renewal4ToRenewal5Cr != null ? formatPct(totals.renewal4ToRenewal5Cr) : dash}</TableCell>;
      case "renewal_5_to_renewal_6_cr":
        return <TableCell key={id} className={className}>{totals.renewal5ToRenewal6Cr != null ? formatPct(totals.renewal5ToRenewal6Cr) : dash}</TableCell>;
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
      case "ltv_1m_per_user":
        return <TableCell key={id} className={className} title={COLUMN_HELP.ltv_1m_per_user}>{formatCurrency(totals.ltv1mPerUser)}</TableCell>;
      case "trial_revenue":
        return <TableCell key={id} className={className}>{formatCurrency(totals.trialRevenue)}</TableCell>;
      case "upsell_1_users":
        return <TableCell key={id} className={className}>{totals.monetization.upsell1Users}</TableCell>;
      case "upsell_1_cr":
        return <TableCell key={id} className={className}>{formatPct(totals.monetization.upsell1Cr)}</TableCell>;
      case "upsell_1_revenue":
        return <TableCell key={id} className={className}>{formatCurrency(totals.monetization.upsell1Revenue)}</TableCell>;
      case "upsell_2_users":
        return <TableCell key={id} className={className}>{totals.monetization.upsell2Users}</TableCell>;
      case "upsell_2_cr":
        return <TableCell key={id} className={className}>{formatPct(totals.monetization.upsell2Cr)}</TableCell>;
      case "upsell_2_revenue":
        return <TableCell key={id} className={className}>{formatCurrency(totals.monetization.upsell2Revenue)}</TableCell>;
      case "upsell_3_users":
        return <TableCell key={id} className={className}>{totals.monetization.upsell3Users}</TableCell>;
      case "upsell_3_cr":
        return <TableCell key={id} className={className}>{formatPct(totals.monetization.upsell3Cr)}</TableCell>;
      case "upsell_3_revenue":
        return <TableCell key={id} className={className}>{formatCurrency(totals.monetization.upsell3Revenue)}</TableCell>;
      case "upsell_extra_users":
        return <TableCell key={id} className={className}>{totals.monetization.upsellExtraUsers}</TableCell>;
      case "upsell_extra_revenue":
        return <TableCell key={id} className={className}>{formatCurrency(totals.monetization.upsellExtraRevenue)}</TableCell>;
      case "funnel_upsell_users":
        return <TableCell key={id} className={className}>{totals.monetization.funnelUpsellUsers}</TableCell>;
      case "funnel_upsell_revenue":
        return <TableCell key={id} className={className}>{formatCurrency(totals.monetization.funnelUpsellRevenue)}</TableCell>;
      case "token_buyers":
        return <TableCell key={id} className={className}>{totals.monetization.tokenBuyers}</TableCell>;
      case "token_buyer_cr":
        return <TableCell key={id} className={className}>{formatPct(totals.monetization.tokenBuyerCr)}</TableCell>;
      case "token_purchases":
        return <TableCell key={id} className={className}>{totals.monetization.tokenPurchases}</TableCell>;
      case "token_gross_revenue":
        return <TableCell key={id} className={className}>{formatCurrency(totals.monetization.tokenGrossRevenue)}</TableCell>;
      case "token_net_revenue":
        return <TableCell key={id} className={className}>{formatCurrency(totals.monetization.tokenNetRevenue)}</TableCell>;
      case "avg_token_revenue_per_trial":
        return <TableCell key={id} className={className}>{formatCurrency(totals.monetization.avgTokenRevenuePerTrial)}</TableCell>;
      case "avg_token_revenue_per_buyer":
        return <TableCell key={id} className={className}>{formatCurrency(totals.monetization.avgTokenRevenuePerBuyer)}</TableCell>;
      case "addon_revenue":
        return <TableCell key={id} className={className}>{formatCurrency(totals.monetization.addonRevenue)}</TableCell>;
      case "currency_mix":
        return <TableCell key={id} className={className}>—</TableCell>;
      case "fx_missing_amount":
        // Original-currency units cannot be summed across currencies.
        return <TableCell key={id} className={className} title={COLUMN_HELP.fx_missing_amount}>—</TableCell>;
      case "fx_missing_transactions":
        return <TableCell key={id} className={className}>{totals.fxMissingTransactions || dash}</TableCell>;
      case "traffic_spend":
        return <TableCell key={id} className={className} title={trafficCellTitle}>{totals.hasTrafficSpend ? formatCurrency(totals.trafficSpend) : dash}</TableCell>;
      case "trial_cost":
        return <TableCell key={id} className={className} title={trafficCellTitle}>{totals.trialCost != null ? formatCurrency(totals.trialCost) : dash}</TableCell>;
      case "profit":
        return <TableCell key={id} className={className} title={trafficCellTitle}>{totals.hasCompleteTrafficSpend ? formatCurrency(totals.profit) : dash}</TableCell>;
      case "profit_d7":
        return <TableCell key={id} className={className} title={trafficCellTitle}>{totals.hasCompleteTrafficSpend ? formatCurrency(totals.profitD7) : dash}</TableCell>;
      case "profit_1m":
        return <TableCell key={id} className={className} title={trafficCellTitle}>{totals.hasCompleteTrafficSpend ? formatCurrency(totals.profit1m) : dash}</TableCell>;
      case "profit_2m":
        return <TableCell key={id} className={className} title={trafficCellTitle}>{totals.hasCompleteTrafficSpend ? formatCurrency(totals.profit2m) : dash}</TableCell>;
      case "traffic_cac":
        return <TableCell key={id} className={className} title={trafficCellTitle}>{totals.trafficTrials ? formatCurrency(totals.trafficCac) : dash}</TableCell>;
      case "traffic_trial_count":
        return <TableCell key={id} className={className} title={trafficCellTitle}>{totals.trafficTrials || dash}</TableCell>;
      case "traffic_clicks":
        return <TableCell key={id} className={className} title={trafficCellTitle}>{totals.trafficClicks || dash}</TableCell>;
      case "traffic_cpc":
        return <TableCell key={id} className={className} title={trafficCellTitle}>{totals.trafficClicks ? formatCurrency(totals.trafficCpc) : dash}</TableCell>;
      case "traffic_cpm":
      case "traffic_ctr":
        return <TableCell key={id} className={className} title={trafficCellTitle}>{dash}</TableCell>;
      case "roas_d7":
        return <TableCell key={id} className={className} title={trafficCellTitle}>{totals.hasCompleteTrafficSpend && totals.trafficSpend ? formatRoas(totals.roasD7) : dash}</TableCell>;
      case "roas_1m":
        return <TableCell key={id} className={className} title={trafficCellTitle}>{totals.hasCompleteTrafficSpend && totals.trafficSpend ? formatRoas(totals.roas1m) : dash}</TableCell>;
      case "roas_2m":
        return <TableCell key={id} className={className} title={trafficCellTitle}>{totals.hasCompleteTrafficSpend && totals.trafficSpend ? formatRoas(totals.roas2m) : dash}</TableCell>;
    }
  };

  return (
    <AppLayout title="Cohorts" description="Grouped by trial date">
      <Card className="rounded-lg border bg-card text-card-foreground shadow-sm p-4 shadow-card py-[20px]">
        <div className="mb-3 flex flex-wrap items-center gap-2 pb-3 border-b border-border">
          {isRecomputing && (
            <span className="order-last ml-auto flex items-center gap-1 text-xs text-primary">
              <Loader2 className="h-3 w-3 animate-spin" />
              Updating results…
            </span>
          )}
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
          <Select value={currencyFilter} onValueChange={(value) => updateUiState({ currencyFilter: value })}>
            <SelectTrigger className="h-9 w-[150px]"><SelectValue placeholder="Currency" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All currencies</SelectItem>
              {currencyOptions.map((currency) => (
                <SelectItem key={currency} value={currency}>{currency}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Popover>
            <PopoverTrigger asChild>
              <Button type="button" variant="outline" size="sm" className="h-9 max-w-[280px] justify-between gap-2">
                <span className="text-xs text-muted-foreground">Campaign ID</span>
                <span className="truncate">{campaignIdSummary}</span>
                <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-80 p-0">
              <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
                <div>
                  <div className="text-xs font-medium text-muted-foreground">Campaign ID</div>
                  <div className="text-xs text-muted-foreground">Filtered by current cohorts</div>
                </div>
                <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={clearCampaignIds} disabled={!selectedCampaignIds.length}>
                  Clear
                </Button>
              </div>
              <div className="border-b border-border p-2">
                <Input
                  value={campaignIdSearch}
                  onChange={(event) => setCampaignIdSearch(event.target.value)}
                  placeholder="Search campaign ID"
                  className="h-8"
                />
              </div>
              <div className="max-h-72 overflow-auto py-1">
                {visibleCampaignIdOptions.length === 0 && (
                  <div className="px-3 py-3 text-sm text-muted-foreground">No Campaign IDs for current filters</div>
                )}
                {visibleCampaignIdOptions.map((option) => (
                  <label key={option.campaign_id} className="flex cursor-pointer items-start gap-2 px-3 py-1.5 text-sm hover:bg-muted/50">
                    <Checkbox
                      checked={selectedCampaignIds.includes(option.campaign_id)}
                      onCheckedChange={() => toggleCampaignId(option.campaign_id)}
                      className="mt-0.5"
                    />
                    <span className="min-w-0 flex-1 truncate">{formatCampaignIdOptionLabel(option)}</span>
                  </label>
                ))}
              </div>
            </PopoverContent>
          </Popover>
          <Select value={refundFilter} onValueChange={(value) => updateUiState({ refundFilter: value })}>
            <SelectTrigger className="h-9 w-[150px]"><SelectValue placeholder="Refund" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All refunds</SelectItem>
              <SelectItem value="has">Has refunds</SelectItem>
              <SelectItem value="none">No refunds</SelectItem>
            </SelectContent>
          </Select>
          <Popover>
            <PopoverTrigger asChild>
              <Button type="button" variant="outline" size="sm" className="h-9 max-w-[220px] justify-between gap-2">
                <span className="text-xs text-muted-foreground">GEO</span>
                <span className="truncate">{countrySummary}</span>
                <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-64 p-0">
              <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
                <div>
                  <div className="text-xs font-medium text-muted-foreground">GEO</div>
                  <div className="text-xs text-muted-foreground">All countries by default</div>
                </div>
                <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={clearCountries} disabled={!selectedCountries.length}>
                  Clear
                </Button>
              </div>
              <div className="max-h-72 overflow-auto py-1">
                {countryOptions.length === 0 && (
                  <div className="px-3 py-3 text-sm text-muted-foreground">No country data</div>
                )}
                {countryOptions.map((country) => (
                  <label key={country.country_code} className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-muted/50">
                    <Checkbox
                      checked={selectedCountries.includes(country.country_code)}
                      onCheckedChange={() => toggleCountry(country.country_code)}
                    />
                    <span className="font-medium tabular-nums">{country.country_code}</span>
                    <span className="ml-auto text-xs tabular-nums text-muted-foreground">{country.user_count}</span>
                  </label>
                ))}
              </div>
            </PopoverContent>
          </Popover>
          <Popover>
            <PopoverTrigger asChild>
              <Button type="button" variant="outline" size="sm" className="h-9 max-w-[230px] justify-between gap-2">
                <span className="text-xs text-muted-foreground">Card Type</span>
                <span className="truncate">{cardTypeSummary}</span>
                <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-60 p-0">
              <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
                <div>
                  <div className="text-xs font-medium text-muted-foreground">Card Type</div>
                  <div className="text-xs text-muted-foreground">All card types by default</div>
                </div>
                <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={clearCardTypes} disabled={!selectedCardTypes.length}>
                  Clear
                </Button>
              </div>
              <div className="py-1">
                {cardTypeOptions.length === 0 && (
                  <div className="px-3 py-3 text-sm text-muted-foreground">No card type data</div>
                )}
                {cardTypeOptions.map((option) => (
                  <label key={option.card_type} className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-muted/50">
                    <Checkbox
                      checked={selectedCardTypes.includes(option.card_type)}
                      onCheckedChange={() => toggleCardType(option.card_type)}
                    />
                    <span>{cardTypeLabel(option.card_type)}</span>
                    <span className="ml-auto text-xs tabular-nums text-muted-foreground">{option.trial_count}</span>
                  </label>
                ))}
              </div>
            </PopoverContent>
          </Popover>
          <Popover>
            <PopoverTrigger asChild>
              <Button type="button" variant="outline" size="sm" className="h-9 max-w-[250px] justify-between gap-2">
                <span className="text-xs text-muted-foreground">Media Buyer</span>
                <span className="truncate">{mediaBuyerSummary}</span>
                <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-64 p-0">
              <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
                <div>
                  <div className="text-xs font-medium text-muted-foreground">Media Buyer</div>
                  <div className="text-xs text-muted-foreground">All media buyers by default</div>
                </div>
                <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={clearMediaBuyers} disabled={!selectedMediaBuyers.length}>
                  Clear
                </Button>
              </div>
              <div className="max-h-72 overflow-auto py-1">
                {mediaBuyerFilterItems.length === 0 && (
                  <div className="px-3 py-3 text-sm text-muted-foreground">No media buyer data</div>
                )}
                {mediaBuyerFilterItems.map((item) => (
                  <label key={item.value} className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-muted/50">
                    <Checkbox
                      checked={selectedMediaBuyers.includes(item.value)}
                      onCheckedChange={() => toggleMediaBuyer(item.value)}
                    />
                    <span>{item.label}</span>
                  </label>
                ))}
              </div>
            </PopoverContent>
          </Popover>
          {(hasGeoFilter || hasCardTypeFilter || hasMediaBuyerFilter) && (
            <span className="text-xs text-muted-foreground" title={trafficCellTitle}>
              Spend is cohort-level
            </span>
          )}
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
            <Button type="button" variant="outline" size="sm" className="h-9" onClick={() => void exportCohortsTable("csv")}>
              Export CSV
            </Button>
            <Button type="button" variant="outline" size="sm" className="h-9" onClick={() => void exportCohortsTable("xlsx")}>
              Export XLSX
            </Button>
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
                      <span>{columnLabel(id)}</span>
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

        {cohortsSource === "clickhouse" && (
          <div className="mb-2 rounded-md border border-border bg-muted/20 px-3 py-2 text-xs">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <span className="font-medium text-foreground">Cohorts data source</span>
              <span>
                engine:{" "}
                <span className="font-mono text-foreground">
                  {clickHouseDriving ? "clickhouse" : needLegacy ? "legacy (fallback)" : "clickhouse"}
                </span>
              </span>
              {/* Honest staged progress — estimated (no server row-level progress),
                  labelled Loading/Updating, capped below 100 until rows are ready. */}
              {isInitialLoading && (
                <span className="flex items-center gap-2 text-muted-foreground">
                  Loading cohorts… {progressPercent}%
                  <Progress value={progressPercent} className="h-1.5 w-24" />
                </span>
              )}
              {isBackgroundRefreshing && (
                <span className="flex items-center gap-2 text-muted-foreground">
                  Updating… {progressPercent}%
                  <Progress value={progressPercent} className="h-1.5 w-24" />
                </span>
              )}
              {!isInitialLoading && !isBackgroundRefreshing && chStatus.error && chResult != null && (
                <span className="text-warning">refresh failed · showing cached data</span>
              )}
              {!isInitialLoading && !isBackgroundRefreshing && chResult != null && !chStatus.error && (
                <span className="text-muted-foreground">
                  updated {formatUpdatedAgo(dataUpdatedAt)}
                </span>
              )}
              {chStatus.durationMs != null && !chStatus.error && !isInitialLoading && !isBackgroundRefreshing && (
                <span>ClickHouse {chStatus.durationMs} ms</span>
              )}
              {clickHouseDriving && snapshotHealth.known && (
                <>
                  <span className={snapshotHealth.status === "stale" ? "text-warning" : undefined}>
                    snapshot:{" "}
                    <span className={snapshotHealth.status === "stale" ? "font-mono text-warning" : "font-mono text-foreground"}>
                      {snapshotHealth.status === "current" ? "current" : snapshotHealth.status === "stale" ? "stale" : "freshness unknown"}
                    </span>
                  </span>
                  {snapshotHealth.warehouseTransactions != null && (
                    <span>warehouse rows: {formatRowsCount(snapshotHealth.warehouseTransactions)}</span>
                  )}
                  <span>snapshot rows: {formatRowsCount(snapshotHealth.snapshotSourceTransactions)}</span>
                  <span>cohort users: {formatRowsCount(snapshotHealth.cohortUsers)}</span>
                  {snapshotHealth.status === "stale" && <span className="text-warning">rebuild pending</span>}
                  <span>
                    report:{" "}
                    <span className={snapshotHealth.reportComplete ? "font-mono text-foreground" : "font-mono text-warning"}>
                      {snapshotHealth.reportComplete ? "complete" : "incomplete"}
                    </span>
                  </span>
                  {snapshotHealth.snapshotGeneratedAt && (
                    <span>snapshot updated {formatUpdatedAgo(Date.parse(snapshotHealth.snapshotGeneratedAt))}</span>
                  )}
                </>
              )}
              {chStatus.error && chResult == null && (
                <span className="text-destructive">ClickHouse error — using legacy: {chStatus.error}</span>
              )}
              {!chStatus.applicable && !chStatus.error && (
                <span className="text-warning">active filter not reproduced server-side — using legacy for this view</span>
              )}
              {needLegacy && legacyWarehouseLoadInProgress && (
                <span className="flex items-center gap-2 text-muted-foreground">
                  Loading legacy warehouse: {formatRowsCount(legacyWarehouseProgress.rows_downloaded)}
                  {" / "}
                  {formatRowsCount(legacyWarehouseProgress.total_rows_expected)} rows
                  {legacyWarehouseProgress.progress_percent != null && ` · ${legacyWarehouseProgress.progress_percent}%`}
                  {legacyWarehouseProgress.current_page > 0 && ` · page ${legacyWarehouseProgress.current_page}`}
                  <Progress value={legacyWarehouseProgress.progress_percent ?? 0} className="h-1.5 w-24" />
                </span>
              )}
              {needLegacy && legacyWarehouseProgress.status === "completed" && (
                <span className="text-muted-foreground">
                  Legacy warehouse complete: {formatRowsCount(legacyWarehouseProgress.rows_stored)}
                  {" / "}
                  {formatRowsCount(legacyWarehouseProgress.total_rows_expected)} rows
                </span>
              )}
              {needLegacy && legacyWarehouseProgress.status === "failed" && (
                <span className="text-destructive">
                  Legacy warehouse load failed{legacyWarehouseProgress.error ? `: ${legacyWarehouseProgress.error}` : ""}
                </span>
              )}
              {chStatus.subStatus && (
                <span>subscriptions: <span className="font-mono text-foreground">{chStatus.subStatus}</span></span>
              )}
              {chResult?.diagnostics?.support_data_status && (
                <span>
                  support: <span className="font-mono text-foreground">{chResult.diagnostics.support_data_status}</span>
                  {typeof chResult.diagnostics.support_matched_cohort_users === "number" && (
                    <> · users {formatRowsCount(chResult.diagnostics.support_matched_cohort_users)}</>
                  )}
                </span>
              )}
              {clickHouseDriving && chResult?.fbDiagnostics && (
                <>
                  <span>
                    fb: <span className={chResult.fbDiagnostics.fb_data_status === "ready" ? "font-mono text-foreground" : "font-mono text-warning"}>{chResult.fbDiagnostics.fb_data_status}</span>
                    {" · rows "}{formatRowsCount(chResult.fbDiagnostics.fb_source_rows)}
                    {" · allocated purchases "}{formatRowsCount(chResult.fbDiagnostics.fb_allocated_purchases)}/{formatRowsCount(chResult.fbDiagnostics.fb_analytics_purchases)}
                    {chResult.fbDiagnostics.fb_last_sync_at && (
                      <> · sync {formatUpdatedAgo(Date.parse(chResult.fbDiagnostics.fb_last_sync_at))}</>
                    )}
                  </span>
                  {chResult.fbDiagnostics.fb_error_code && (
                    <span className="text-destructive" role="alert">
                      {chResult.fbDiagnostics.fb_error_code}: {chResult.fbDiagnostics.fb_error_message_safe}
                    </span>
                  )}
                  {chResult.fbDiagnostics.fb_attribution_source === "fact_user_cohorts" && (
                    <span>
                      attribution: campaigns {formatRowsCount(chResult.fbDiagnostics.fb_campaigns_in_scope)}
                      {" · campaign coverage "}{chResult.fbDiagnostics.fb_campaign_coverage == null ? dash : formatFbPct(chResult.fbDiagnostics.fb_campaign_coverage)}
                      {" · allocation coverage "}{chResult.fbDiagnostics.fb_allocation_coverage == null ? dash : formatFbPct(chResult.fbDiagnostics.fb_allocation_coverage)}
                    </span>
                  )}
                  {chResult.fbDiagnostics.fb_attribution_source === "fact_user_cohorts" && (
                    <span className={chResult.fbDiagnostics.fb_overallocated_campaigns > 0 ? "text-destructive" : "text-muted-foreground"}>
                      user cost: allocated {formatFbUsd(chResult.fbDiagnostics.fb_allocated_spend)}
                      {" · unallocated "}{formatFbUsd(chResult.fbDiagnostics.fb_unallocated_spend)}
                      {" · allocation gap "}{formatRowsCount(chResult.fbDiagnostics.fb_allocation_gap_purchases)}
                      {" · gross campaign unmatched "}{formatRowsCount(chResult.fbDiagnostics.fb_gross_unmatched_purchases)}
                      {" · campaigns without users "}{formatRowsCount(chResult.fbDiagnostics.fb_campaigns_without_cohort_users)}
                      {" · avg user CPP "}{formatFbUsd(chResult.fbDiagnostics.fb_user_cpp)}
                      {" · underallocated "}{formatRowsCount(chResult.fbDiagnostics.fb_underallocated_campaigns)}
                      {" · overallocated "}{formatRowsCount(chResult.fbDiagnostics.fb_overallocated_campaigns)}
                      {" · validation "}{formatRowsCount(chResult.fbDiagnostics.fb_validation_rows)}
                    </span>
                  )}
                  {chResult.fbDiagnostics.fb_attribution_source === "fact_user_cohorts" && (
                    <span className={chResult.fbDiagnostics.fb_timezone_unverified_users > 0 ? "text-warning" : "text-muted-foreground"}>
                      join: {chResult.fbDiagnostics.fb_join_key}
                      {" · FB period "}{chResult.fbDiagnostics.fb_period_date_from ?? dash}–{chResult.fbDiagnostics.fb_period_date_to ?? dash}
                      {" · timezone informational "}{chResult.fbDiagnostics.fb_timezone ?? "unverified"}
                      {" · snapshot "}{formatRowsCount(chResult.fbDiagnostics.fb_snapshot_rows)}/{formatRowsCount(chResult.fbDiagnostics.fb_snapshot_unique_users)} unique users
                    </span>
                  )}
                </>
              )}
            </div>
          </div>
        )}

        {clickHouseDriving && chResult?.fbDiagnostics && (
          <section
            className="mb-2 space-y-2 rounded-md border border-border/70 bg-muted/20 px-3 py-3 text-xs"
            aria-label="Facebook source reconciliation"
            data-testid="fb-source-reconciliation"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-medium text-foreground">Facebook source reconciliation</h3>
              <span className="text-muted-foreground">Source scope: authoritative first-trial users</span>
            </div>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8">
              <div title="All authoritative trial users in the currently selected Cohorts scope."><span className="text-muted-foreground">All Cohorts Users</span><div className="font-mono text-foreground">{formatRowsCount(chResult.fbDiagnostics.fb_all_cohorts_users)}</div></div>
              <div title="Users qualified as Meta by an explicit Meta source, exact FB Campaign ID, confirmed Campaign alias, or paid Campaign plus _fbc. _fbp alone is excluded."><span className="text-muted-foreground">Facebook-qualified Users</span><div className="font-mono text-foreground">{formatRowsCount(chResult.fbDiagnostics.fb_facebook_qualified_users)}</div></div>
              <div title="Authoritative users with explicit TikTok source evidence."><span className="text-muted-foreground">TikTok Users</span><div className="font-mono text-foreground">{formatRowsCount(chResult.fbDiagnostics.fb_tiktok_users)}</div></div>
              <div title="Users without sufficient source evidence. They are reported separately and are not Facebook allocation failures."><span className="text-muted-foreground">Unknown Source Users</span><div className="font-mono text-foreground">{formatRowsCount(chResult.fbDiagnostics.fb_unknown_source_users)}</div></div>
              <div title="Meta-attributed purchases reported by Facebook Analytics for the selected period."><span className="text-muted-foreground">FB Analytics Purchases</span><div className="font-mono text-foreground">{formatRowsCount(chResult.fbDiagnostics.fb_analytics_purchases)}</div></div>
              <div title="Facebook purchases assigned through the unchanged Campaign ID allocation."><span className="text-muted-foreground">Allocated FB Purchases</span><div className="font-mono text-foreground">{formatRowsCount(chResult.fbDiagnostics.fb_allocated_purchases)}</div></div>
              <div title="Allocation Gap shows Facebook purchases that could not be assigned to an existing Cohort campaign."><span className="text-muted-foreground">Unallocated FB Purchases</span><div className="font-mono text-foreground">{formatRowsCount(chResult.fbDiagnostics.fb_allocation_gap_purchases)}</div></div>
              <div title="Allocated FB Purchases divided by FB Analytics Purchases. Trial Count is never used as the denominator."><span className="text-muted-foreground">Allocation Coverage</span><div className="font-mono text-foreground">{chResult.fbDiagnostics.fb_allocation_coverage == null ? dash : formatFbPct(chResult.fbDiagnostics.fb_allocation_coverage)}</div></div>
            </div>
            {(chResult.fbDiagnostics.fb_google_users > 0 || chResult.fbDiagnostics.fb_organic_users > 0 || chResult.fbDiagnostics.fb_direct_users > 0 || chResult.fbDiagnostics.fb_other_source_users > 0) && (
              <div className="text-muted-foreground">
                Other classified sources: Google {formatRowsCount(chResult.fbDiagnostics.fb_google_users)}
                {" · Organic "}{formatRowsCount(chResult.fbDiagnostics.fb_organic_users)}
                {" · Direct "}{formatRowsCount(chResult.fbDiagnostics.fb_direct_users)}
                {" · Other "}{formatRowsCount(chResult.fbDiagnostics.fb_other_source_users)}
              </div>
            )}
            <div className="grid gap-2 sm:grid-cols-3">
              <div title="This is a traffic-source mix difference, not an allocation error." className="rounded border border-border/60 bg-background p-2"><span className="text-muted-foreground">A · All Cohorts − FB Analytics</span><div className="font-mono text-foreground">{formatRowsCount(chResult.fbDiagnostics.fb_source_mix_difference)}</div><div className="text-muted-foreground">Source-mix difference</div></div>
              <div title="Difference between Meta-qualified authoritative users and Meta-reported purchases." className="rounded border border-border/60 bg-background p-2"><span className="text-muted-foreground">B · Facebook-qualified − FB Analytics</span><div className="font-mono text-foreground">{formatRowsCount(chResult.fbDiagnostics.fb_meta_authoritative_difference)}</div><div className="text-muted-foreground">Meta vs authoritative users</div></div>
              <div title="Allocation Gap shows Facebook purchases that could not be assigned to an existing Cohort campaign." className="rounded border border-border/60 bg-background p-2"><span className="text-muted-foreground">C · FB Analytics − Allocated</span><div className="font-mono text-foreground">{formatRowsCount(chResult.fbDiagnostics.fb_allocation_gap_purchases)}</div><div className="text-muted-foreground">Real allocation gap</div></div>
            </div>
            <div className="space-y-1 rounded border border-border/60 bg-background p-2 text-muted-foreground">
              <p>Trial Count includes users from all traffic sources. Facebook Purchases includes only Meta-attributed purchases. Therefore these values are not expected to match.</p>
              <p>Allocation Gap shows Facebook purchases that could not be assigned to an existing Cohort campaign.</p>
            </div>
          </section>
        )}

        {fbAllocationDiagnostics && (
          <details className="mb-2 rounded-md border border-border/70 bg-muted/20 px-3 py-2 text-xs">
            <summary className="cursor-pointer font-medium text-foreground">
              FB runtime allocation diagnostics ({fbAllocationDiagnostics.total_rows} Campaign rows)
            </summary>
            <div className="mt-3 space-y-3">
              <div className="rounded border border-border/60 bg-background p-2 text-muted-foreground">
                Authenticated debug view · CPP is calculated per Campaign over the selected Cohorts period. Date filters below only filter Campaign activity-period rows; they do not recompute allocation.
              </div>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
                <Label className="space-y-1 text-[11px]">
                  <span>Campaign active from</span>
                  <Input type="date" value={fbAllocationDiagnosticsUi.dateFrom} onChange={(event) => setFbAllocationDiagnosticsUi((current) => ({ ...current, page: 1, dateFrom: event.target.value }))} className="h-8" />
                </Label>
                <Label className="space-y-1 text-[11px]">
                  <span>Campaign active to</span>
                  <Input type="date" value={fbAllocationDiagnosticsUi.dateTo} onChange={(event) => setFbAllocationDiagnosticsUi((current) => ({ ...current, page: 1, dateTo: event.target.value }))} className="h-8" />
                </Label>
                <Label className="space-y-1 text-[11px]">
                  <span>Campaign ID</span>
                  <Input value={fbAllocationDiagnosticsUi.campaignId} onChange={(event) => setFbAllocationDiagnosticsUi((current) => ({ ...current, page: 1, campaignId: event.target.value }))} className="h-8" placeholder="Exact ID" />
                </Label>
                <Label className="space-y-1 text-[11px]">
                  <span>Campaign name</span>
                  <Input value={fbAllocationDiagnosticsUi.campaignName} onChange={(event) => setFbAllocationDiagnosticsUi((current) => ({ ...current, page: 1, campaignName: event.target.value }))} className="h-8" placeholder="Contains" />
                </Label>
                <Label className="space-y-1 text-[11px]">
                  <span>Ad account ID</span>
                  <Input value={fbAllocationDiagnosticsUi.adAccountId} onChange={(event) => setFbAllocationDiagnosticsUi((current) => ({ ...current, page: 1, adAccountId: event.target.value }))} className="h-8" placeholder="Exact ID" />
                </Label>
                <Label className="space-y-1 text-[11px]">
                  <span>Allocation status</span>
                  <Select value={fbAllocationDiagnosticsUi.allocationStatus} onValueChange={(value) => setFbAllocationDiagnosticsUi((current) => ({ ...current, page: 1, allocationStatus: value as FbAllocationStatus | "all" }))}>
                    <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All statuses</SelectItem>
                      {FB_ALLOCATION_STATUSES.map((status) => <SelectItem key={status} value={status}>{status}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </Label>
                <Label className="space-y-1 text-[11px]">
                  <span>Timezone source</span>
                  <Select value={fbAllocationDiagnosticsUi.timezoneSource} onValueChange={(value) => setFbAllocationDiagnosticsUi((current) => ({ ...current, page: 1, timezoneSource: value as FbTimezoneSource | "all" }))}>
                    <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All sources</SelectItem>
                      {FB_TIMEZONE_SOURCES.map((source) => <SelectItem key={source} value={source}>{source}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </Label>
              </div>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-6">
                <div><span className="text-muted-foreground">Total FB Spend</span><div className="font-mono">{formatFbUsd(fbAllocationDiagnostics.summary.total_fb_spend)}</div></div>
                <div><span className="text-muted-foreground">Allocated</span><div className="font-mono">{formatFbUsd(fbAllocationDiagnostics.summary.total_allocated_spend)}</div></div>
                <div><span className="text-muted-foreground">Unallocated</span><div className="font-mono">{formatFbUsd(fbAllocationDiagnostics.summary.total_unallocated_spend)}</div></div>
                <div title="Gross unmatched purchases summed Campaign by Campaign; this is not the net Allocation Gap."><span className="text-muted-foreground">Gross campaign unmatched</span><div className="font-mono">{formatRowsCount(fbAllocationDiagnostics.summary.total_unallocated_purchases)}</div></div>
                <div><span className="text-muted-foreground">Allocation difference</span><div className="font-mono">{formatFbUsd(fbAllocationDiagnostics.summary.total_allocation_difference)}</div></div>
                <div><span className="text-muted-foreground">FB Purchases / matched</span><div className="font-mono">{formatRowsCount(fbAllocationDiagnostics.summary.total_fb_purchases)} / {formatRowsCount(fbAllocationDiagnostics.summary.total_matched_users)}</div></div>
                <div><span className="text-muted-foreground">Allocation coverage</span><div className="font-mono">{fbAllocationDiagnostics.summary.overall_coverage_rate == null ? dash : formatFbPct(fbAllocationDiagnostics.summary.overall_coverage_rate)}</div></div>
                <div><span className="text-muted-foreground">Fully / under / over</span><div className="font-mono">{fbAllocationDiagnostics.summary.fully_allocated_campaign_dates} / {fbAllocationDiagnostics.summary.underallocated_campaign_dates} / {fbAllocationDiagnostics.summary.overallocated_campaign_dates}</div></div>
                <div><span className="text-muted-foreground">Timezone unverified</span><div className="font-mono">{fbAllocationDiagnostics.summary.timezone_unverified_campaign_dates}</div></div>
                <div><span className="text-muted-foreground">Campaign IDs without users</span><div className="font-mono">{fbAllocationDiagnostics.summary.campaign_ids_without_cohort_users}</div></div>
                <div title="Only authoritative users that carry a Campaign ID are included; Unknown Source users without Campaign ID are not treated as Facebook failures."><span className="text-muted-foreground">Campaign users without FB metrics</span><div className="font-mono">{fbAllocationDiagnostics.summary.users_without_matching_fb_metrics}</div></div>
                <div><span className="text-muted-foreground">Visible Cohort Spend</span><div className="font-mono">{formatFbUsd(fbAllocationDiagnostics.summary.sum_visible_cohort_spend)}</div></div>
                <div><span className="text-muted-foreground">Visible − allocated</span><div className="font-mono">{formatFbUsd(fbAllocationDiagnostics.summary.visible_allocated_difference)}</div></div>
              </div>
              {(!fbAllocationDiagnostics.summary.reconciliation_ok || !fbAllocationDiagnostics.summary.visible_spend_reconciles) && (
                <div className="rounded border border-destructive/40 bg-destructive/5 p-2 text-destructive">
                  Allocation invariant failed beyond ±{formatFbUsd(fbAllocationDiagnostics.summary.money_tolerance)} tolerance. Do not proceed with rollout.
                </div>
              )}
              {fbAllocationDiagnostics.display_message && <div className="font-medium text-warning">{fbAllocationDiagnostics.display_message}</div>}
            <div className="max-h-[32rem] overflow-auto rounded border border-border/60 bg-background">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Campaign ID</TableHead>
                    <TableHead>Campaign Name</TableHead>
                    <TableHead>Ad Account</TableHead>
                    <TableHead>FB Activity Period</TableHead>
                    <TableHead>Meta Timezone</TableHead>
                    <TableHead>Timezone Source</TableHead>
                    <TableHead>FB Spend</TableHead>
                    <TableHead>FB Purchases</TableHead>
                    <TableHead>Matched Users</TableHead>
                    <TableHead>Unmatched Purchases</TableHead>
                    <TableHead>Excess Users</TableHead>
                    <TableHead>Coverage</TableHead>
                    <TableHead>CPP</TableHead>
                    <TableHead>Allocated</TableHead>
                    <TableHead>Unallocated</TableHead>
                    <TableHead>Difference</TableHead>
                    <TableHead>Difference %</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Cohort Rows</TableHead>
                    <TableHead>Funnels</TableHead>
                    <TableHead>Campaign Paths</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {fbAllocationDiagnostics.rows.map((row) => (
                    <TableRow key={`${row.campaign_id}|${row.ad_account_id ?? ""}`}>
                      <TableCell className="font-mono">{row.campaign_id}</TableCell>
                      <TableCell>{row.campaign_name ?? dash}</TableCell>
                      <TableCell className="font-mono">{row.ad_account_id ?? dash}</TableCell>
                      <TableCell className="whitespace-nowrap font-mono">{row.period_date_from ?? dash}–{row.period_date_to ?? dash}</TableCell>
                      <TableCell className="font-mono">{row.meta_timezone ?? dash}</TableCell>
                      <TableCell>{row.timezone_source}</TableCell>
                      <TableCell>{formatFbUsd(row.fb_spend)}</TableCell>
                      <TableCell>{formatRowsCount(row.fb_purchases)}</TableCell>
                      <TableCell>{formatRowsCount(row.matched_authoritative_users)}</TableCell>
                      <TableCell>{formatRowsCount(row.unmatched_fb_purchases)}</TableCell>
                      <TableCell>{formatRowsCount(row.excess_authoritative_users)}</TableCell>
                      <TableCell>{row.coverage_rate == null ? dash : formatFbPct(row.coverage_rate)}</TableCell>
                      <TableCell>{formatFbUsd(row.campaign_cpp)}</TableCell>
                      <TableCell>{formatFbUsd(row.allocated_spend)}</TableCell>
                      <TableCell>{formatFbUsd(row.unallocated_spend)}</TableCell>
                      <TableCell>{formatFbUsd(row.allocation_difference)}</TableCell>
                      <TableCell>{row.allocation_difference_percent == null ? dash : formatFbPct(row.allocation_difference_percent)}</TableCell>
                      <TableCell className={row.allocation_status === "overallocated" ? "text-destructive" : row.allocation_status === "underallocated" ? "text-warning" : ""}>{row.allocation_status}</TableCell>
                      <TableCell>{row.affected_cohort_rows}</TableCell>
                      <TableCell>{row.affected_funnels.join(", ") || dash}</TableCell>
                      <TableCell>{row.affected_campaign_paths.join(", ") || dash}</TableCell>
                    </TableRow>
                  ))}
                  {fbAllocationDiagnostics.rows.length === 0 && (
                    <TableRow><TableCell colSpan={21} className="py-6 text-center text-muted-foreground">No Campaign rows match the diagnostics filters.</TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">Page {fbAllocationDiagnostics.page}{fbAllocationDiagnostics.total_pages ? ` of ${fbAllocationDiagnostics.total_pages}` : ""} · summary is computed before pagination</span>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" disabled={!fbAllocationDiagnostics.has_previous_page} onClick={() => setFbAllocationDiagnosticsUi((current) => ({ ...current, page: Math.max(1, current.page - 1) }))}>Previous</Button>
                  <Button size="sm" variant="outline" disabled={!fbAllocationDiagnostics.has_next_page} onClick={() => setFbAllocationDiagnosticsUi((current) => ({ ...current, page: current.page + 1 }))}>Next</Button>
                </div>
              </div>
            </div>
          </details>
        )}

        {(fxDiagnostics.transactions_converted > 0 || fxDiagnostics.excluded_transactions > 0) && (
          <div className="mb-2 space-y-1 text-xs text-muted-foreground">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <span className="font-medium text-foreground">FX conversion</span>
              <span>{fxDiagnostics.transactions_with_currency} with currency</span>
              {fxDiagnostics.transactions_without_currency > 0 && (
                <span className="text-destructive">{fxDiagnostics.transactions_without_currency} without currency</span>
              )}
              <span>{fxDiagnostics.transactions_native_usd} native USD</span>
              <span>{fxDiagnostics.transactions_converted} converted to USD</span>
              {fxDiagnostics.transactions_missing_fx_rate > 0 && (
                <span className="text-destructive">{fxDiagnostics.transactions_missing_fx_rate} missing FX rate</span>
              )}
              {fxDiagnostics.excluded_transactions > 0 && (
                <span className="text-destructive">
                  {fxDiagnostics.excluded_transactions} txs · {fxDiagnostics.excluded_amount_original.toLocaleString("en-US", { maximumFractionDigits: 2 })} (original units) excluded from USD metrics
                </span>
              )}
            </div>
            {fxDiagnostics.excluded_transactions > 0 && (
              <div className="text-warning">
                Some revenue is excluded from USD metrics because currency or FX rate is missing.
              </div>
            )}
          </div>
        )}
        {subscriptionSyncWarning && (
          <div className="mb-3 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
            {subscriptionSyncWarning}
          </div>
        )}
        {(tokenDiagnostics.token_purchases_total > 0 || tokenDiagnostics.unknown_products.length > 0) && (
          <div className="mb-3 space-y-1 text-xs text-muted-foreground">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <span className="font-medium text-foreground">Token purchases</span>
              <span>{tokenDiagnostics.token_purchases_total} total</span>
              <span>
                {tokenDiagnostics.token_purchases_matched} matched to cohorts
                {tokenDiagnostics.token_purchases_matched_by_email > 0 &&
                  ` (${tokenDiagnostics.token_purchases_matched_by_email} by email)`}
              </span>
              <span className={tokenDiagnostics.token_purchases_unmatched > 0 ? "text-destructive" : undefined}>
                {tokenDiagnostics.token_purchases_unmatched} unmatched · {formatCurrency(tokenDiagnostics.token_unmatched_amount)} excluded from cohort metrics
              </span>
              {tokenDiagnostics.unknown_addon_revenue > 0 && (
                <span className="text-warning">
                  Unknown add-on revenue: {formatCurrency(tokenDiagnostics.unknown_addon_revenue)}
                </span>
              )}
            </div>
            {aggregatedTokenPacks.length > 0 && (
              <details>
                <summary className="cursor-pointer select-none hover:text-foreground">
                  Token packs across selected cohorts ({aggregatedTokenPacks.length})
                </summary>
                <div className="mt-2">
                  <TokenPackTable packs={aggregatedTokenPacks} />
                </div>
              </details>
            )}
            {tokenDiagnostics.unknown_products.length > 0 && (
              <details>
                <summary className="cursor-pointer select-none text-warning hover:text-foreground">
                  Unknown monetization products — need mapping ({tokenDiagnostics.unknown_products.length})
                </summary>
                <table className="mt-2 text-xs tabular-nums">
                  <thead>
                    <tr className="text-muted-foreground">
                      <th className="pr-4 pb-1 text-left font-medium">Product ID</th>
                      <th className="pr-4 pb-1 text-left font-medium">Product Name</th>
                      <th className="pr-4 pb-1 text-right font-medium">Amount</th>
                      <th className="pr-4 pb-1 text-right font-medium">Count</th>
                      <th className="pr-4 pb-1 text-right font-medium">Users</th>
                      <th className="pr-4 pb-1 text-left font-medium">Example TX</th>
                      <th className="pb-1 text-left font-medium">Suggested</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tokenDiagnostics.unknown_products.map((p) => (
                      <tr key={`${p.product_name}-${p.amount}-${p.currency}`}>
                        <td className="pr-4 py-0.5">{p.product_id ?? "—"}</td>
                        <td className="pr-4 py-0.5">{p.product_name}</td>
                        <td className="pr-4 py-0.5 text-right">{p.amount.toFixed(2)} {p.currency}</td>
                        <td className="pr-4 py-0.5 text-right">{p.count}</td>
                        <td className="pr-4 py-0.5 text-right">{p.users}</td>
                        <td className="pr-4 py-0.5 font-mono">{p.example_transaction_id.slice(0, 14)}</td>
                        <td className="py-0.5">{p.suggested_category}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="mt-1">
                  Add matching entries to <span className="font-mono">src/services/monetizationProductMap.ts</span> to classify these.
                </div>
              </details>
            )}
          </div>
        )}
        <div className="rounded-lg border border-border [&>div]:max-h-[calc(100vh-220px)] [&>div]:overflow-auto [&>div]:rounded-lg [&>div]:scroll-smooth">
          <Table
            className="border-separate border-spacing-0 w-auto"
            style={{ tableLayout: "fixed", width: tableTotalWidth }}
          >
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
                    <span className="line-clamp-2 min-w-0 whitespace-normal break-words leading-tight">Cohort</span>
                    <span className="shrink-0">{sortIcon(COHORT_FIRST_COL_KEY)}</span>
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
                        <div className="flex min-w-0 items-center gap-2">
                          <button
                            type="button"
                            onClick={() => toggleExpanded(c.cohort_id)}
                            className="inline-flex min-w-0 items-center gap-1.5 hover:text-primary"
                            aria-expanded={expanded}
                          >
                            {expanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
                            <span className="truncate">{c.cohort_id}</span>
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
                          {visibleColumnOrder.map((id) => renderPlanCell(id, plan, c))}
                        </TableRow>
                      ))}
                    {expanded && (
                      <TableRow
                        key={`${c.cohort_id}-monetization`}
                        className="bg-muted/10 hover:bg-muted/10 [&>td.sticky]:bg-muted/10"
                      >
                        <TableCell
                          className={`${CELL_BASE} sticky left-0 z-10 shadow-[1px_0_0_0_hsl(var(--border))] text-xs font-medium text-muted-foreground whitespace-nowrap pl-8 align-top`}
                        >
                          Monetization
                        </TableCell>
                        <TableCell colSpan={visibleColumnOrder.length} className="py-2 px-3">
                          <CohortMonetizationDetails cohort={c} nowMs={nowMs} />
                        </TableCell>
                      </TableRow>
                    )}
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
              {/* Initial load (no cached rows yet): show a progress row, never the
                  empty-state — the true empty-state is only for a successful zero-row
                  response. A background refresh keeps the existing rows (cohorts.length>0),
                  so neither branch fires and the table never blanks. */}
              {isInitialLoading && cohorts.length === 0 && (
                <TableRow>
                  <TableCell colSpan={visibleColumnOrder.length + 1} className="py-10">
                    <div className="flex flex-col items-center gap-3 text-muted-foreground">
                      <Progress value={progressPercent} className="h-2 w-full max-w-xs" />
                      <span className="text-sm">Loading cohorts… {progressPercent}%</span>
                    </div>
                  </TableCell>
                </TableRow>
              )}
              {cohorts.length === 0 && !isInitialLoading && (
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
