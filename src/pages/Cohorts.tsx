import { Fragment, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight } from "lucide-react";
import { AppLayout } from "@/components/AppLayout";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  calculateManualLtvModel,
  computeAbsoluteRetention,
  computeCohorts,
  forecastLtv,
  formatCurrency,
  formatPct,
} from "@/services/analytics";
import type { CohortRow, PlanBreakdownRow } from "@/services/types";
import { useDataStore } from "@/store/dataStore";

// Visual-only helpers — no data/logic impact.
const HEAD_BASE =
  "sticky top-0 z-20 bg-card h-10 px-3 whitespace-nowrap border-b border-border text-xs font-semibold text-muted-foreground";
const HEAD_NUM = `${HEAD_BASE} text-right`;
const CELL_BASE = "py-2 px-3 align-middle";
const CELL_NUM = `${CELL_BASE} text-right tabular-nums whitespace-nowrap text-sm`;
const CELL_TXT = `${CELL_BASE} text-xs text-muted-foreground whitespace-nowrap`;
// Left border marks the start of a logical section.
const SECTION_DIVIDER = "border-l border-border/60";
const COLUMN_ORDER_STORAGE_KEY = "cohorts_column_order";

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
  "gross_ltv",
  "net_ltv",
  "ltv_actual",
  "ltv_3m",
  "ltv_6m",
  "ltv_12m",
  "revenue_d0",
  "revenue_d7",
  "revenue_d14",
  "revenue_d30",
  "revenue_d37",
  "revenue_d67",
  "revenue_total",
  "ltv_d7",
  "ltv_d14",
  "ltv_d30",
  "ltv_total",
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
  gross_revenue: "Gross Revenue",
  net_revenue: "Net Revenue",
  gross_ltv: "Gross LTV",
  net_ltv: "Net LTV",
  ltv_actual: "LTV (Actual)",
  ltv_3m: "LTV 3M",
  ltv_6m: "LTV 6M",
  ltv_12m: "LTV 12M",
  revenue_d0: "Rev D0",
  revenue_d7: "Rev D7",
  revenue_d14: "Rev D14",
  revenue_d30: "Rev D30",
  revenue_d37: "Rev D37",
  revenue_d67: "Rev D67",
  revenue_total: "Rev Total",
  ltv_d7: "LTV D7",
  ltv_d14: "LTV D14",
  ltv_d30: "LTV D30",
  ltv_total: "LTV Total",
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
  gross_ltv: 100,
  net_ltv: 100,
  ltv_actual: 110,
  ltv_3m: 100,
  ltv_6m: 100,
  ltv_12m: 100,
  revenue_d0: 90,
  revenue_d7: 90,
  revenue_d14: 90,
  revenue_d30: 90,
  revenue_d37: 90,
  revenue_d67: 90,
  revenue_total: 100,
  ltv_d7: 90,
  ltv_d14: 90,
  ltv_d30: 90,
  ltv_total: 100,
};

const TEXT_COLUMNS = new Set<CohortColumnId>(["cohort_date", "campaign_path", "funnel"]);
const SECTION_DIVIDER_COLUMNS = new Set<CohortColumnId>([
  "trial_users",
  "trial_to_upsell_cr",
  "renewal_2_users",
  "refund_users",
  "gross_revenue",
  "revenue_d0",
  "ltv_d7",
]);

const DEFAULT_MANUAL_RETENTION = [45, 30, 22, 17, 14, 12, 10, 9, 8, 7, 6, 5];

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
  } catch (error) {
    console.warn("Unable to persist cohort column order", error);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function forecastDetailsFor(cohort: CohortRow | null) {
  if (!cohort) return null;
  const firstSubCr = cohort.trial_users ? cohort.first_subscription_users / cohort.trial_users : 0;
  const renewal2Cr = cohort.first_subscription_users ? cohort.renewal_2_users / cohort.first_subscription_users : 0;
  const renewal3Cr = cohort.renewal_2_users ? cohort.renewal_3_users / cohort.renewal_2_users : 0;
  const rawDecay = renewal2Cr > 0 && renewal3Cr > 0 ? renewal3Cr / renewal2Cr : 0.7;
  const decay = clamp(rawDecay, 0.3, 0.95);
  const avgSubscriptionPrice = cohort.first_subscription_users
    ? cohort.first_subscription_revenue / cohort.first_subscription_users
    : 0;
  const confidence =
    cohort.trial_users >= 100 && cohort.renewal_3_users >= 20
      ? "High"
      : cohort.trial_users >= 50 && cohort.renewal_2_users >= 10
        ? "Medium"
        : "Low";

  return {
    firstSubCr,
    renewal2Cr,
    renewal3Cr,
    decay,
    rawDecay,
    avgSubscriptionPrice,
    confidence,
  };
}

export default function CohortsPage() {
  const txs = useTransactions();
  const subscriptions = useDataStore((s) => s.subscriptions);
  const [expandedCohortIds, setExpandedCohortIds] = useState<Set<string>>(() => new Set());
  const [funnelFilter, setFunnelFilter] = useState("all");
  const [campaignPathFilter, setCampaignPathFilter] = useState("all");
  const [trafficSourceFilter, setTrafficSourceFilter] = useState("all");
  const [campaignIdFilter, setCampaignIdFilter] = useState("all");
  const [refundFilter, setRefundFilter] = useState("all");
  const [cohortDateFrom, setCohortDateFrom] = useState("");
  const [cohortDateTo, setCohortDateTo] = useState("");
  const [dateSort, setDateSort] = useState<"desc" | "asc">("desc");
  const [columnSettingsOpen, setColumnSettingsOpen] = useState(false);
  const [columnOrder, setColumnOrder] = useState<CohortColumnId[]>(loadInitialColumnOrder);
  const [forecastDetailsCohort, setForecastDetailsCohort] = useState<CohortRow | null>(null);
  const [manualTrialUsers, setManualTrialUsers] = useState("1000");
  const [manualTrialPrice, setManualTrialPrice] = useState("1");
  const [manualSubscriptionPrice, setManualSubscriptionPrice] = useState("29.99");
  const [manualUpsellRate, setManualUpsellRate] = useState("20");
  const [manualUpsellValue, setManualUpsellValue] = useState("14.98");
  const [manualStripeCommission, setManualStripeCommission] = useState("3");
  const [manualFbCommission, setManualFbCommission] = useState("0");
  const [manualRetention, setManualRetention] = useState<string[]>(() => DEFAULT_MANUAL_RETENTION.map(String));

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
  const absoluteRetentionRows = useMemo(
    () =>
      computeAbsoluteRetention(sourceFilteredTxs).filter((row) => {
        if (cohortDateFrom && row.cohort_date < cohortDateFrom) return false;
        if (cohortDateTo && row.cohort_date > cohortDateTo) return false;
        return true;
      }),
    [sourceFilteredTxs, cohortDateFrom, cohortDateTo]
  );
  const funnelOptions = useMemo(() => Array.from(new Set(allCohorts.map((c) => c.funnel))).sort(), [allCohorts]);
  const campaignPathOptions = useMemo(() => Array.from(new Set(allCohorts.map((c) => c.campaign_path))).sort(), [allCohorts]);
  const cohorts = useMemo(
    () =>
      allCohorts.filter((c) => {
        if (funnelFilter !== "all" && c.funnel !== funnelFilter) return false;
        if (campaignPathFilter !== "all" && c.campaign_path !== campaignPathFilter) return false;
        if (refundFilter === "has" && c.refund_users === 0) return false;
        if (refundFilter === "none" && c.refund_users > 0) return false;
        if (cohortDateFrom && c.cohort_date < cohortDateFrom) return false;
        if (cohortDateTo && c.cohort_date > cohortDateTo) return false;
        return true;
      }).sort((a, b) => {
        const cmp = a.cohort_date < b.cohort_date ? -1 : a.cohort_date > b.cohort_date ? 1 : 0;
        return dateSort === "asc" ? cmp : -cmp;
      }),
    [allCohorts, funnelFilter, campaignPathFilter, refundFilter, cohortDateFrom, cohortDateTo, dateSort]
  );
  const hasUsers = useMemo(() => new Set(txs.map((t) => t.user_id)).size > 0, [txs]);
  const toggleExpanded = (cohortId: string) => {
    setExpandedCohortIds((current) => {
      const next = new Set(current);
      if (next.has(cohortId)) next.delete(cohortId);
      else next.add(cohortId);
      return next;
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
  };

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
    const totalRevenue = sum((c) => c.revenue_total);
    const amountRefunded = sum((c) => c.amount_refunded);
    const grossRevenue = sum((c) => c.gross_revenue);
    const netRevenue = sum((c) => c.net_revenue);
    const revenueD7 = sum((c) => c.revenue_d7);
    const revenueD14 = sum((c) => c.revenue_d14);
    const revenueD30 = sum((c) => c.revenue_d30);
    const totalForecast = forecastLtv({
      trialUsers: totalTrialUsers,
      firstSubscriptionUsers: totalFirstSubscriptionUsers,
      renewal2Users: totalRenewal2Users,
      renewal3Users: totalRenewal3Users,
      netRevenue,
      firstSubscriptionRevenue: sum((c) => c.first_subscription_revenue),
    });
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
      grossLtv: totalTrialUsers ? grossRevenue / totalTrialUsers : 0,
      netLtv: totalTrialUsers ? netRevenue / totalTrialUsers : 0,
      ltvActual: totalForecast.ltv_actual,
      ltv3m: totalForecast.ltv_3m,
      ltv6m: totalForecast.ltv_6m,
      ltv12m: totalForecast.ltv_12m,
      revenueD0: sum((c) => c.revenue_d0),
      revenueD7,
      revenueD14,
      revenueD30,
      revenueD37: sum((c) => c.revenue_d37),
      revenueD67: sum((c) => c.revenue_d67),
      totalRevenue,
      averageLtv: totalTrialUsers ? totalRevenue / totalTrialUsers : 0,
      ltvD7: totalTrialUsers ? revenueD7 / totalTrialUsers : 0,
      ltvD14: totalTrialUsers ? revenueD14 / totalTrialUsers : 0,
      ltvD30: totalTrialUsers ? revenueD30 / totalTrialUsers : 0,
      trialToUpsellCr: totalTrialUsers ? (totalUpsellUsers / totalTrialUsers) * 100 : 0,
      trialToFirstSubscriptionCr: totalTrialUsers ? (totalFirstSubscriptionUsers / totalTrialUsers) * 100 : 0,
      firstSubscriptionToRenewal2Cr: totalFirstSubscriptionUsers ? (totalRenewal2Users / totalFirstSubscriptionUsers) * 100 : 0,
      renewal2ToRenewal3Cr: totalRenewal2Users ? (totalRenewal3Users / totalRenewal2Users) * 100 : 0,
    };
  }, [cohorts]);
  const forecastDetails = forecastDetailsFor(forecastDetailsCohort);
  const manualLtvRows = useMemo(
    () =>
      calculateManualLtvModel({
        trialUsers: Number(manualTrialUsers) || 0,
        trialPrice: Number(manualTrialPrice) || 0,
        subscriptionPrice: Number(manualSubscriptionPrice) || 0,
        upsellRatePct: Number(manualUpsellRate) || 0,
        upsellValue: Number(manualUpsellValue) || 0,
        retentionPctByMonth: manualRetention.map((value) => Number(value) || 0),
        stripeCommissionPct: Number(manualStripeCommission) || 0,
        fbCommissionPct: Number(manualFbCommission) || 0,
      }),
    [
      manualTrialUsers,
      manualTrialPrice,
      manualSubscriptionPrice,
      manualUpsellRate,
      manualUpsellValue,
      manualRetention,
      manualStripeCommission,
      manualFbCommission,
    ]
  );
  const updateManualRetention = (index: number, value: string) => {
    setManualRetention((current) => current.map((entry, entryIndex) => (entryIndex === index ? value : entry)));
  };

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

  const renderHeaderCell = (id: CohortColumnId) => (
    <TableHead key={id} className={headerClassFor(id)} style={{ minWidth: COLUMN_MIN_WIDTHS[id] }}>
      {id === "cohort_date" ? (
        <button
          onClick={() => setDateSort((s) => (s === "desc" ? "asc" : "desc"))}
          className="inline-flex items-center gap-1 hover:text-foreground"
        >
          {COLUMN_LABELS[id]} {dateSort === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />}
        </button>
      ) : (
        COLUMN_LABELS[id]
      )}
    </TableHead>
  );

  const renderCohortCell = (id: CohortColumnId, c: CohortRow) => {
    const className = cellClassFor(id);
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
      case "gross_ltv":
        return <TableCell key={id} className={className}>{formatCurrency(c.gross_ltv)}</TableCell>;
      case "net_ltv":
        return <TableCell key={id} className={className}>{formatCurrency(c.net_ltv)}</TableCell>;
      case "ltv_actual":
        return <TableCell key={id} className={className}>{formatCurrency(c.ltv_actual)}</TableCell>;
      case "ltv_3m":
        return <TableCell key={id} className={className}>{formatCurrency(c.ltv_3m)}</TableCell>;
      case "ltv_6m":
        return <TableCell key={id} className={className}>{formatCurrency(c.ltv_6m)}</TableCell>;
      case "ltv_12m":
        return <TableCell key={id} className={className}>{formatCurrency(c.ltv_12m)}</TableCell>;
      case "revenue_d0":
        return <TableCell key={id} className={className}>{formatCurrency(c.revenue_d0)}</TableCell>;
      case "revenue_d7":
        return <TableCell key={id} className={className}>{formatCurrency(c.revenue_d7)}</TableCell>;
      case "revenue_d14":
        return <TableCell key={id} className={className}>{formatCurrency(c.revenue_d14)}</TableCell>;
      case "revenue_d30":
        return <TableCell key={id} className={className}>{formatCurrency(c.revenue_d30)}</TableCell>;
      case "revenue_d37":
        return <TableCell key={id} className={className}>{formatCurrency(c.revenue_d37)}</TableCell>;
      case "revenue_d67":
        return <TableCell key={id} className={className}>{formatCurrency(c.revenue_d67)}</TableCell>;
      case "revenue_total":
        return <TableCell key={id} className={className}>{formatCurrency(c.revenue_total)}</TableCell>;
      case "ltv_d7":
        return <TableCell key={id} className={className}>{formatCurrency(c.ltv_d7)}</TableCell>;
      case "ltv_d14":
        return <TableCell key={id} className={className}>{formatCurrency(c.ltv_d14)}</TableCell>;
      case "ltv_d30":
        return <TableCell key={id} className={className}>{formatCurrency(c.ltv_d30)}</TableCell>;
      case "ltv_total":
        return <TableCell key={id} className={className}>{formatCurrency(c.trial_users ? c.revenue_total / c.trial_users : 0)}</TableCell>;
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
      case "net_ltv":
        return <TableCell key={id} className={className}>{formatCurrency(plan.net_ltv)}</TableCell>;
      case "ltv_actual":
        return <TableCell key={id} className={className}>{formatCurrency(plan.ltv_actual)}</TableCell>;
      case "ltv_3m":
        return <TableCell key={id} className={className}>{formatCurrency(plan.ltv_3m)}</TableCell>;
      case "ltv_6m":
        return <TableCell key={id} className={className}>{formatCurrency(plan.ltv_6m)}</TableCell>;
      case "ltv_12m":
        return <TableCell key={id} className={className}>{formatCurrency(plan.ltv_12m)}</TableCell>;
      case "gross_ltv":
      case "revenue_d0":
      case "revenue_d7":
      case "revenue_d14":
      case "revenue_d30":
      case "revenue_d37":
      case "revenue_d67":
      case "revenue_total":
      case "ltv_d7":
      case "ltv_d14":
      case "ltv_d30":
      case "ltv_total":
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
      case "gross_ltv":
        return <TableCell key={id} className={className}>{formatCurrency(totals.grossLtv)}</TableCell>;
      case "net_ltv":
        return <TableCell key={id} className={className}>{formatCurrency(totals.netLtv)}</TableCell>;
      case "ltv_actual":
        return <TableCell key={id} className={className}>{formatCurrency(totals.ltvActual)}</TableCell>;
      case "ltv_3m":
        return <TableCell key={id} className={className}>{formatCurrency(totals.ltv3m)}</TableCell>;
      case "ltv_6m":
        return <TableCell key={id} className={className}>{formatCurrency(totals.ltv6m)}</TableCell>;
      case "ltv_12m":
        return <TableCell key={id} className={className}>{formatCurrency(totals.ltv12m)}</TableCell>;
      case "revenue_d0":
        return <TableCell key={id} className={className}>{formatCurrency(totals.revenueD0)}</TableCell>;
      case "revenue_d7":
        return <TableCell key={id} className={className}>{formatCurrency(totals.revenueD7)}</TableCell>;
      case "revenue_d14":
        return <TableCell key={id} className={className}>{formatCurrency(totals.revenueD14)}</TableCell>;
      case "revenue_d30":
        return <TableCell key={id} className={className}>{formatCurrency(totals.revenueD30)}</TableCell>;
      case "revenue_d37":
        return <TableCell key={id} className={className}>{formatCurrency(totals.revenueD37)}</TableCell>;
      case "revenue_d67":
        return <TableCell key={id} className={className}>{formatCurrency(totals.revenueD67)}</TableCell>;
      case "revenue_total":
        return <TableCell key={id} className={className}>{formatCurrency(totals.totalRevenue)}</TableCell>;
      case "ltv_d7":
        return <TableCell key={id} className={className}>{formatCurrency(totals.ltvD7)}</TableCell>;
      case "ltv_d14":
        return <TableCell key={id} className={className}>{formatCurrency(totals.ltvD14)}</TableCell>;
      case "ltv_d30":
        return <TableCell key={id} className={className}>{formatCurrency(totals.ltvD30)}</TableCell>;
      case "ltv_total":
        return <TableCell key={id} className={className}>{formatCurrency(totals.averageLtv)}</TableCell>;
    }
  };

  return (
    <AppLayout title="Cohorts" description="Grouped by trial date">
      <Card className="rounded-lg border bg-card text-card-foreground shadow-sm p-4 shadow-card py-[20px]">
        <div className="mb-3 flex flex-wrap items-center gap-2 pb-3 border-b border-border">
          <Select value={funnelFilter} onValueChange={setFunnelFilter}>
            <SelectTrigger className="h-9 w-[160px]"><SelectValue placeholder="Funnel" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All funnels</SelectItem>
              {funnelOptions.map((f) => (
                <SelectItem key={f} value={f}>{f.replace("_", " ")}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={campaignPathFilter} onValueChange={setCampaignPathFilter}>
            <SelectTrigger className="h-9 w-[220px]"><SelectValue placeholder="Campaign path" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All campaign paths</SelectItem>
              {campaignPathOptions.map((path) => (
                <SelectItem key={path} value={path}>{path}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={trafficSourceFilter} onValueChange={setTrafficSourceFilter}>
            <SelectTrigger className="h-9 w-[160px]"><SelectValue placeholder="Traffic source" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All traffic</SelectItem>
              {trafficSourceOptions.map((source) => (
                <SelectItem key={source} value={source}>{source}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={campaignIdFilter} onValueChange={setCampaignIdFilter}>
            <SelectTrigger className="h-9 w-[190px]"><SelectValue placeholder="Campaign ID" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All campaign IDs</SelectItem>
              {campaignIdOptions.map((id) => (
                <SelectItem key={id} value={id}>{id}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={refundFilter} onValueChange={setRefundFilter}>
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
              onChange={(e) => setCohortDateFrom(e.target.value)}
              className="h-9 w-[150px]"
            />
          </div>
          <div className="flex items-center gap-2">
            <Label htmlFor="cohort-date-to" className="text-xs text-muted-foreground">Cohort date to</Label>
            <Input
              id="cohort-date-to"
              type="date"
              value={cohortDateTo}
              onChange={(e) => setCohortDateTo(e.target.value)}
              className="h-9 w-[150px]"
            />
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-9"
            onClick={() => setColumnSettingsOpen((open) => !open)}
          >
            Columns
          </Button>
        </div>

        {columnSettingsOpen && (
          <div className="mb-3 rounded-md border border-border bg-muted/20 p-3">
            <div className="mb-2 flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium">Column settings</div>
                <div className="text-xs text-muted-foreground">Expand arrow and Cohort are locked first.</div>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={resetColumnOrder}>
                Reset columns
              </Button>
            </div>
            <div className="max-h-72 overflow-auto rounded-md border border-border bg-card">
              <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2 text-sm">
                <span className="font-medium">Cohort</span>
                <span className="text-xs text-muted-foreground">Locked</span>
              </div>
              {columnOrder.map((id, index) => (
                <div key={id} className="flex items-center justify-between gap-3 border-b border-border px-3 py-2 last:border-b-0">
                  <span className="text-sm">{COLUMN_LABELS[id]}</span>
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={index === 0}
                      onClick={() => moveColumn(index, -1)}
                    >
                      Move up
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={index === columnOrder.length - 1}
                      onClick={() => moveColumn(index, 1)}
                    >
                      Move down
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="rounded-lg border border-border [&>div]:max-h-[calc(100vh-280px)] [&>div]:overflow-auto [&>div]:rounded-lg">
          <Table className="border-separate border-spacing-0">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead
                  className={`${HEAD_BASE} sticky left-0 z-30 shadow-[1px_0_0_0_hsl(var(--border))] text-left`}
                  style={{ minWidth: 140 }}
                >
                  Cohort
                </TableHead>
                {columnOrder.map(renderHeaderCell)}
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
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs"
                            onClick={() => setForecastDetailsCohort(c)}
                          >
                            Forecast details
                          </Button>
                        </div>
                      </TableCell>
                      {columnOrder.map((id) => renderCohortCell(id, c))}
                    </TableRow>
                    {expanded && c.plan_breakdown.length === 0 && (
                      <TableRow className="bg-muted/10 hover:bg-muted/10 [&>td.sticky]:bg-muted/10">
                        <TableCell
                          className={`${CELL_BASE} sticky left-0 z-10 shadow-[1px_0_0_0_hsl(var(--border))] text-xs italic text-muted-foreground whitespace-nowrap pl-8`}
                        >
                          No price breakdown
                        </TableCell>
                        {columnOrder.map((id) => (
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
                          {columnOrder.map((id) => renderPlanCell(id, plan))}
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
                  {columnOrder.map(renderTotalCell)}
                </TableRow>
              )}
              {cohorts.length === 0 && (
                <TableRow>
                  <TableCell colSpan={columnOrder.length + 1} className="text-center text-sm text-muted-foreground py-10">
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
      <Dialog open={Boolean(forecastDetailsCohort)} onOpenChange={(open) => !open && setForecastDetailsCohort(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Forecast Details</DialogTitle>
            <DialogDescription>
              Forecast is based on observed subscription conversion and renewal retention. Future months are projected using retention decay.
            </DialogDescription>
          </DialogHeader>
          {forecastDetailsCohort && forecastDetails && (
            <div className="space-y-4">
              <div className="rounded-md border border-border p-3">
                <div className="text-sm font-medium">{forecastDetailsCohort.cohort_id}</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {forecastDetailsCohort.cohort_date} · {forecastDetailsCohort.campaign_path} · {forecastDetailsCohort.funnel.replace("_", " ")}
                </div>
              </div>

              <div className="grid gap-3 md:grid-cols-3">
                <div className="rounded-md border border-border p-3">
                  <div className="mb-2 text-xs font-medium uppercase text-muted-foreground">Base data</div>
                  <dl className="space-y-1 text-sm">
                    <div className="flex justify-between gap-3"><dt>Trial Users</dt><dd className="tabular-nums">{forecastDetailsCohort.trial_users}</dd></div>
                    <div className="flex justify-between gap-3"><dt>First Sub Users</dt><dd className="tabular-nums">{forecastDetailsCohort.first_subscription_users}</dd></div>
                    <div className="flex justify-between gap-3"><dt>Renewal 2 Users</dt><dd className="tabular-nums">{forecastDetailsCohort.renewal_2_users}</dd></div>
                    <div className="flex justify-between gap-3"><dt>Renewal 3 Users</dt><dd className="tabular-nums">{forecastDetailsCohort.renewal_3_users}</dd></div>
                    <div className="flex justify-between gap-3"><dt>Net Revenue</dt><dd className="tabular-nums">{formatCurrency(forecastDetailsCohort.net_revenue)}</dd></div>
                    <div className="flex justify-between gap-3"><dt>Actual Net LTV</dt><dd className="tabular-nums">{formatCurrency(forecastDetailsCohort.net_ltv)}</dd></div>
                  </dl>
                </div>

                <div className="rounded-md border border-border p-3">
                  <div className="mb-2 text-xs font-medium uppercase text-muted-foreground">Model parameters</div>
                  <dl className="space-y-1 text-sm">
                    <div className="flex justify-between gap-3"><dt>First Sub CR</dt><dd className="tabular-nums">{formatPct(forecastDetails.firstSubCr * 100)}</dd></div>
                    <div className="flex justify-between gap-3"><dt>Renewal 2 CR</dt><dd className="tabular-nums">{formatPct(forecastDetails.renewal2Cr * 100)}</dd></div>
                    <div className="flex justify-between gap-3"><dt>Renewal 3 CR</dt><dd className="tabular-nums">{formatPct(forecastDetails.renewal3Cr * 100)}</dd></div>
                    <div className="flex justify-between gap-3"><dt>Decay</dt><dd className="tabular-nums">{forecastDetails.decay.toFixed(2)}</dd></div>
                    <div className="flex justify-between gap-3"><dt>Avg Subscription Price</dt><dd className="tabular-nums">{formatCurrency(forecastDetails.avgSubscriptionPrice)}</dd></div>
                    <div className="flex justify-between gap-3"><dt>Forecast Horizon</dt><dd>3M / 6M / 12M</dd></div>
                    <div className="flex justify-between gap-3"><dt>Confidence</dt><dd>{forecastDetails.confidence}</dd></div>
                  </dl>
                </div>

                <div className="rounded-md border border-border p-3">
                  <div className="mb-2 text-xs font-medium uppercase text-muted-foreground">Forecast output</div>
                  <dl className="space-y-1 text-sm">
                    <div className="flex justify-between gap-3"><dt>Forecast LTV 3M</dt><dd className="tabular-nums">{formatCurrency(forecastDetailsCohort.ltv_3m)}</dd></div>
                    <div className="flex justify-between gap-3"><dt>Forecast LTV 6M</dt><dd className="tabular-nums">{formatCurrency(forecastDetailsCohort.ltv_6m)}</dd></div>
                    <div className="flex justify-between gap-3"><dt>Forecast LTV 12M</dt><dd className="tabular-nums">{formatCurrency(forecastDetailsCohort.ltv_12m)}</dd></div>
                  </dl>
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
      <Card className="mt-4 rounded-lg border bg-card text-card-foreground shadow-sm p-4 shadow-card">
        <div className="mb-3 flex items-center justify-between gap-3 border-b border-border pb-3">
          <div>
            <h2 className="text-sm font-semibold">Manual LTV Model</h2>
            <p className="text-xs text-muted-foreground">
              Spreadsheet-style model using direct absolute retention inputs. No decay or renewal ratios are applied.
            </p>
          </div>
        </div>
        <div className="grid gap-3 md:grid-cols-4 xl:grid-cols-7">
          <div className="space-y-1.5">
            <Label htmlFor="manual-trial-users" className="text-xs text-muted-foreground">Trial Users</Label>
            <Input id="manual-trial-users" type="number" min="0" value={manualTrialUsers} onChange={(e) => setManualTrialUsers(e.target.value)} className="h-9" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="manual-trial-price" className="text-xs text-muted-foreground">Trial Price</Label>
            <Input id="manual-trial-price" type="number" min="0" step="0.01" value={manualTrialPrice} onChange={(e) => setManualTrialPrice(e.target.value)} className="h-9" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="manual-sub-price" className="text-xs text-muted-foreground">Subscription Price</Label>
            <Input id="manual-sub-price" type="number" min="0" step="0.01" value={manualSubscriptionPrice} onChange={(e) => setManualSubscriptionPrice(e.target.value)} className="h-9" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="manual-upsell-rate" className="text-xs text-muted-foreground">Upsell Rate (%)</Label>
            <Input id="manual-upsell-rate" type="number" min="0" step="0.1" value={manualUpsellRate} onChange={(e) => setManualUpsellRate(e.target.value)} className="h-9" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="manual-upsell-value" className="text-xs text-muted-foreground">Upsell Value</Label>
            <Input id="manual-upsell-value" type="number" min="0" step="0.01" value={manualUpsellValue} onChange={(e) => setManualUpsellValue(e.target.value)} className="h-9" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="manual-stripe" className="text-xs text-muted-foreground">Stripe Commission (%)</Label>
            <Input id="manual-stripe" type="number" min="0" step="0.1" value={manualStripeCommission} onChange={(e) => setManualStripeCommission(e.target.value)} className="h-9" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="manual-fb" className="text-xs text-muted-foreground">FB Commission (%)</Label>
            <Input id="manual-fb" type="number" min="0" step="0.1" value={manualFbCommission} onChange={(e) => setManualFbCommission(e.target.value)} className="h-9" />
          </div>
        </div>

        <div className="mt-4 grid gap-2 md:grid-cols-6 xl:grid-cols-12">
          {manualRetention.map((value, index) => (
            <div key={index + 1} className="space-y-1.5">
              <Label htmlFor={`manual-retention-${index + 1}`} className="text-xs text-muted-foreground">M{index + 1} (%)</Label>
              <Input
                id={`manual-retention-${index + 1}`}
                type="number"
                min="0"
                step="0.1"
                value={value}
                onChange={(e) => updateManualRetention(index, e.target.value)}
                className="h-9"
              />
            </div>
          ))}
        </div>

        <div className="mt-4 overflow-x-auto rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Month</TableHead>
                <TableHead className="text-right">Users</TableHead>
                <TableHead className="text-right">Revenue</TableHead>
                <TableHead className="text-right">Cumulative Revenue</TableHead>
                <TableHead className="text-right">LTV</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {manualLtvRows.map((row) => (
                <TableRow key={row.month}>
                  <TableCell className="font-medium">M{row.month}</TableCell>
                  <TableCell className="text-right tabular-nums">{row.users.toLocaleString(undefined, { maximumFractionDigits: 2 })}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCurrency(row.revenue)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCurrency(row.cumulative_revenue)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCurrency(row.ltv)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Card>

      <Card className="mt-4 rounded-lg border bg-card text-card-foreground shadow-sm p-4 shadow-card">
        <div className="mb-3 flex items-center justify-between gap-3 border-b border-border pb-3">
          <div>
            <h2 className="text-sm font-semibold">Absolute Retention</h2>
            <p className="text-xs text-muted-foreground">
              Unique users with at least one successful subscription transaction in each 30-day month, divided by original cohort size.
            </p>
          </div>
        </div>
        <div className="overflow-x-auto rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="whitespace-nowrap">Cohort</TableHead>
                <TableHead className="whitespace-nowrap text-right">Users</TableHead>
                {Array.from({ length: 12 }, (_, index) => (
                  <TableHead key={index + 1} className="whitespace-nowrap text-right">
                    M{index + 1}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {absoluteRetentionRows.map((row) => (
                <TableRow key={row.cohort}>
                  <TableCell className="whitespace-nowrap text-sm font-medium">{row.cohort}</TableCell>
                  <TableCell className="text-right text-sm tabular-nums">{row.total_users}</TableCell>
                  {row.retention_by_month.map((retention, index) => (
                    <TableCell key={index + 1} className="text-right text-sm tabular-nums">
                      <div>{formatPct(retention)}</div>
                      <div className="text-[11px] text-muted-foreground">{row.users_by_month[index]}</div>
                    </TableCell>
                  ))}
                </TableRow>
              ))}
              {absoluteRetentionRows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={14} className="py-8 text-center text-sm text-muted-foreground">
                    No absolute retention cohorts to display.
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
