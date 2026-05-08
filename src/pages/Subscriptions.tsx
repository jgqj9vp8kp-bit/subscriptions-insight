import { useMemo } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, Search, ShieldAlert, Users, XCircle, CheckCircle2, RotateCw, Clock } from "lucide-react";
import { AppLayout } from "@/components/AppLayout";
import { KpiCard } from "@/components/KpiCard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
import { computeUsers, formatCurrency, formatPct } from "@/services/analytics";
import { useTransactions } from "@/services/sheets";
import { useDataStore } from "@/store/dataStore";
import { usePersistedPageState } from "@/hooks/usePersistedPageState";
import type { SubscriptionClean } from "@/types/subscriptions";
import type { Transaction, UserAggregate } from "@/services/types";

type CancellationFilter = "all" | "cancelled" | "not_cancelled";
type ActiveFilter = "all" | "active" | "expired";
type CancelTypeFilter = "all" | SubscriptionClean["cancellation_type"];
type CancelTimingFilter = "all" | SubscriptionClean["cancellation_timing_bucket"];
type SubscriptionSortKey = "cohort_date" | "cohort_id" | "campaign_path";

const DEFAULT_SUBSCRIPTIONS_UI_STATE = {
  search: "",
  statusFilter: "all",
  cancellationFilter: "all" as CancellationFilter,
  activeFilter: "all" as ActiveFilter,
  cancelTypeFilter: "all" as CancelTypeFilter,
  cancelTimingFilter: "all" as CancelTimingFilter,
  cohortFilter: "all",
  campaignPathFilter: "all",
  cohortDateFrom: "",
  cohortDateTo: "",
  sortKey: "cohort_date" as SubscriptionSortKey,
  sortDir: "desc" as "asc" | "desc",
  cancelledFrom: "",
  cancelledTo: "",
};

type PalmerUserLookupRow = {
  cohort_id: string | null;
  cohort_date: string | null;
  campaign_path: string | null;
  entry_price: number | null;
};

type SubscriptionDisplayRow = SubscriptionClean & PalmerUserLookupRow;

function dateKey(value: string | null): string {
  return value ? value.slice(0, 10) : "";
}

function formatDateTime(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "—";
}

function boolLabel(value: boolean | null): string {
  if (value == null) return "—";
  return value ? "Yes" : "No";
}

function readableValue(value: string): string {
  return value.split("_").join(" ");
}

function normalizeEmailForMatch(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

function normalizeCampaignPathLabel(path: string | undefined): string {
  const value = String(path ?? "").trim();
  return value || "unknown";
}

function campaignPathFromCohortId(cohortId: string | undefined): string {
  const match = String(cohortId ?? "").match(/^(.*)_\d{4}-\d{2}-\d{2}$/);
  return normalizeCampaignPathLabel(match?.[1]);
}

function buildPalmerUserLookup(txs: Transaction[], users: UserAggregate[]): Map<string, PalmerUserLookupRow> {
  const txsByUser = new Map<string, Transaction[]>();
  for (const tx of txs) {
    const list = txsByUser.get(tx.user_id) ?? [];
    list.push(tx);
    txsByUser.set(tx.user_id, list);
  }

  const lookup = new Map<string, PalmerUserLookupRow>();
  for (const user of users) {
    const email = normalizeEmailForMatch(user.email);
    if (!email) continue;

    const sorted = [...(txsByUser.get(user.user_id) ?? [])].sort((a, b) => (a.event_time < b.event_time ? -1 : 1));
    const trial = sorted.find((tx) => tx.transaction_type === "trial" && tx.status === "success")
      ?? sorted.find((tx) => tx.transaction_type === "trial")
      ?? sorted[0];
    const cohortId = trial?.cohort_id || null;
    const cohortDate = trial?.cohort_date || user.first_trial_date?.slice(0, 10) || null;
    const campaignPath = normalizeCampaignPathLabel(trial?.campaign_path || campaignPathFromCohortId(cohortId ?? undefined));

    lookup.set(email, {
      cohort_id: cohortId,
      cohort_date: cohortDate,
      campaign_path: campaignPath,
      entry_price: user.plan_price,
    });
  }

  return lookup;
}

function cancelTypeOf(sub: SubscriptionClean): SubscriptionClean["cancellation_type"] {
  return sub.cancellation_type ?? (sub.is_cancelled ? "cancelled_unknown_reason" : "not_cancelled");
}

function cancelTimingOf(sub: SubscriptionClean): SubscriptionClean["cancellation_timing_bucket"] {
  return sub.cancellation_timing_bucket ?? (sub.is_cancelled ? "later" : "not_cancelled");
}

export default function SubscriptionsPage() {
  const txs = useTransactions();
  const subscriptions = useDataStore((s) => s.subscriptions);
  const [uiState, setUiState, resetUiState] = usePersistedPageState("ui_state_subscriptions", DEFAULT_SUBSCRIPTIONS_UI_STATE);
  const {
    search,
    statusFilter,
    cancellationFilter,
    activeFilter,
    cancelTypeFilter,
    cancelTimingFilter,
    cohortFilter,
    campaignPathFilter,
    cohortDateFrom,
    cohortDateTo,
    sortKey,
    sortDir,
    cancelledFrom,
    cancelledTo,
  } = uiState;
  const updateUiState = (patch: Partial<typeof DEFAULT_SUBSCRIPTIONS_UI_STATE>) => setUiState((current) => ({ ...current, ...patch }));

  const palmerUsers = useMemo(() => computeUsers(txs), [txs]);
  const palmerUserByEmail = useMemo(() => buildPalmerUserLookup(txs, palmerUsers), [txs, palmerUsers]);
  const displayRows: SubscriptionDisplayRow[] = useMemo(
    () =>
      subscriptions.map((sub) => {
        const palmerUser = palmerUserByEmail.get(normalizeEmailForMatch(sub.email));
        return {
          ...sub,
          cohort_id: palmerUser?.cohort_id ?? null,
          cohort_date: palmerUser?.cohort_date ?? null,
          campaign_path: palmerUser?.campaign_path ?? null,
          entry_price: palmerUser?.entry_price ?? null,
        };
      }),
    [subscriptions, palmerUserByEmail]
  );

  const statusOptions = useMemo(
    () => Array.from(new Set(displayRows.map((s) => s.status || "unknown"))).sort(),
    [displayRows]
  );
  const cancelTypeOptions = useMemo(
    () => Array.from(new Set(displayRows.map(cancelTypeOf))).sort(),
    [displayRows]
  );
  const cancelTimingOptions = useMemo(
    () => Array.from(new Set(displayRows.map(cancelTimingOf))).sort(),
    [displayRows]
  );
  const cohortOptions = useMemo(
    () => Array.from(new Set(displayRows.map((s) => s.cohort_id).filter(Boolean))).sort() as string[],
    [displayRows]
  );
  const campaignPathOptions = useMemo(
    () => Array.from(new Set(displayRows.map((s) => s.campaign_path).filter(Boolean))).sort() as string[],
    [displayRows]
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = displayRows.filter((sub) => {
      if (q && !(sub.email ?? "").toLowerCase().includes(q)) return false;
      if (statusFilter !== "all" && (sub.status || "unknown") !== statusFilter) return false;
      if (cancellationFilter === "cancelled" && !sub.is_cancelled) return false;
      if (cancellationFilter === "not_cancelled" && sub.is_cancelled) return false;
      if (activeFilter === "active" && !sub.is_active_now) return false;
      if (activeFilter === "expired" && sub.is_active_now) return false;
      if (cancelTypeFilter !== "all" && cancelTypeOf(sub) !== cancelTypeFilter) return false;
      if (cancelTimingFilter !== "all" && cancelTimingOf(sub) !== cancelTimingFilter) return false;
      if (cohortFilter !== "all" && sub.cohort_id !== cohortFilter) return false;
      if (campaignPathFilter !== "all" && sub.campaign_path !== campaignPathFilter) return false;
      if (cohortDateFrom && (!sub.cohort_date || sub.cohort_date < cohortDateFrom)) return false;
      if (cohortDateTo && (!sub.cohort_date || sub.cohort_date > cohortDateTo)) return false;
      const cancelledAt = dateKey(sub.cancelled_at);
      if (cancelledFrom && (!cancelledAt || cancelledAt < cancelledFrom)) return false;
      if (cancelledTo && (!cancelledAt || cancelledAt > cancelledTo)) return false;
      return true;
    });
    list.sort((a, b) => {
      const av = a[sortKey] ?? "";
      const bv = b[sortKey] ?? "";
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return sortDir === "asc" ? cmp : -cmp;
    });
    return list;
  }, [
    displayRows,
    search,
    statusFilter,
    cancellationFilter,
    activeFilter,
    cancelTypeFilter,
    cancelTimingFilter,
    cohortFilter,
    campaignPathFilter,
    cohortDateFrom,
    cohortDateTo,
    cancelledFrom,
    cancelledTo,
    sortKey,
    sortDir,
  ]);

  const kpis = useMemo(() => {
    const total = subscriptions.length;
    const activeNow = subscriptions.filter((s) => s.is_active_now).length;
    const cancelled = subscriptions.filter((s) => s.is_cancelled).length;
    const renewing = subscriptions.filter((s) => s.renews === true).length;
    const cancelledButActive = subscriptions.filter((s) => s.is_cancelled && s.is_active_now).length;
    const cancelledUnknownReason = subscriptions.filter((s) => cancelTypeOf(s) === "cancelled_unknown_reason").length;
    const paymentRelatedCancellations = subscriptions.filter((s) => cancelTypeOf(s) === "auto_payment_related").length;
    const cancelledBeforeRenewal48h = subscriptions.filter((s) => cancelTimingOf(s) === "before_renewal_48h").length;
    const cancelledAfterPeriodEnd = subscriptions.filter((s) => cancelTimingOf(s) === "after_period_end").length;
    const cancellationRate = total ? (cancelled / total) * 100 : 0;
    return {
      total,
      activeNow,
      cancelled,
      renewing,
      cancelledButActive,
      cancelledUnknownReason,
      paymentRelatedCancellations,
      cancelledBeforeRenewal48h,
      cancelledAfterPeriodEnd,
      cancellationRate,
    };
  }, [subscriptions]);

  const toggleSort = (key: SubscriptionSortKey) => {
    if (sortKey === key) updateUiState({ sortDir: sortDir === "asc" ? "desc" : "asc" });
    else updateUiState({ sortKey: key, sortDir: "desc" });
  };

  const sortIcon = (key: SubscriptionSortKey) =>
    sortKey !== key ? <ArrowUpDown className="h-3 w-3 opacity-40" /> :
    sortDir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />;

  return (
    <AppLayout
      title="Subscriptions"
      description="FunnelFox subscription cancellation monitoring"
    >
      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <KpiCard label="Total subscriptions" value={String(kpis.total)} icon={<Users className="h-4 w-4" />} />
        <KpiCard label="Active now" value={String(kpis.activeNow)} icon={<CheckCircle2 className="h-4 w-4" />} accent="success" />
        <KpiCard label="Cancelled" value={String(kpis.cancelled)} icon={<XCircle className="h-4 w-4" />} accent="warning" />
        <KpiCard label="Renewing" value={String(kpis.renewing)} icon={<RotateCw className="h-4 w-4" />} accent="accent" />
        <KpiCard label="Cancelled active" value={String(kpis.cancelledButActive)} icon={<Clock className="h-4 w-4" />} accent="warning" />
        <KpiCard label="Cancellation rate" value={formatPct(kpis.cancellationRate)} icon={<XCircle className="h-4 w-4" />} />
        <KpiCard label="Cancelled unknown reason" value={String(kpis.cancelledUnknownReason)} icon={<ShieldAlert className="h-4 w-4" />} accent="warning" />
        <KpiCard label="Payment-related cancellations" value={String(kpis.paymentRelatedCancellations)} icon={<XCircle className="h-4 w-4" />} />
        <KpiCard label="Cancelled before renewal 48h" value={String(kpis.cancelledBeforeRenewal48h)} icon={<Clock className="h-4 w-4" />} />
        <KpiCard label="Cancelled after period end" value={String(kpis.cancelledAfterPeriodEnd)} icon={<Clock className="h-4 w-4" />} accent="warning" />
      </div>

      <Card className="mt-4 p-4 shadow-card">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <div className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search by email..."
              value={search}
              onChange={(e) => updateUiState({ search: e.target.value })}
              className="h-9 pl-8"
            />
          </div>
          <Select value={statusFilter} onValueChange={(value) => updateUiState({ statusFilter: value })}>
            <SelectTrigger className="h-9 w-[160px]"><SelectValue placeholder="Status" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {statusOptions.map((status) => (
                <SelectItem key={status} value={status}>{status}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={cancellationFilter} onValueChange={(v: CancellationFilter) => updateUiState({ cancellationFilter: v })}>
            <SelectTrigger className="h-9 w-[170px]"><SelectValue placeholder="Cancellation" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All cancellations</SelectItem>
              <SelectItem value="cancelled">Cancelled</SelectItem>
              <SelectItem value="not_cancelled">Not cancelled</SelectItem>
            </SelectContent>
          </Select>
          <Select value={activeFilter} onValueChange={(v: ActiveFilter) => updateUiState({ activeFilter: v })}>
            <SelectTrigger className="h-9 w-[150px]"><SelectValue placeholder="Active" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All activity</SelectItem>
              <SelectItem value="active">Active now</SelectItem>
              <SelectItem value="expired">Expired</SelectItem>
            </SelectContent>
          </Select>
          <Select value={cancelTypeFilter} onValueChange={(v: CancelTypeFilter) => updateUiState({ cancelTypeFilter: v })}>
            <SelectTrigger className="h-9 w-[210px]"><SelectValue placeholder="Cancel type" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All cancel types</SelectItem>
              {cancelTypeOptions.map((type) => (
                <SelectItem key={type} value={type}>{readableValue(type)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={cancelTimingFilter} onValueChange={(v: CancelTimingFilter) => updateUiState({ cancelTimingFilter: v })}>
            <SelectTrigger className="h-9 w-[220px]"><SelectValue placeholder="Cancel timing" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All cancel timings</SelectItem>
              {cancelTimingOptions.map((timing) => (
                <SelectItem key={timing} value={timing}>{readableValue(timing)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={cohortFilter} onValueChange={(value) => updateUiState({ cohortFilter: value })}>
            <SelectTrigger className="h-9 w-[220px]"><SelectValue placeholder="Cohort" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All cohorts</SelectItem>
              {cohortOptions.map((cohort) => (
                <SelectItem key={cohort} value={cohort}>{cohort}</SelectItem>
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
          <div className="flex items-center gap-2">
            <Label htmlFor="cohort-from" className="text-xs text-muted-foreground">Cohort from</Label>
            <Input id="cohort-from" type="date" value={cohortDateFrom} onChange={(e) => updateUiState({ cohortDateFrom: e.target.value })} className="h-9 w-[150px]" />
          </div>
          <div className="flex items-center gap-2">
            <Label htmlFor="cohort-to" className="text-xs text-muted-foreground">Cohort to</Label>
            <Input id="cohort-to" type="date" value={cohortDateTo} onChange={(e) => updateUiState({ cohortDateTo: e.target.value })} className="h-9 w-[150px]" />
          </div>
          <div className="flex items-center gap-2">
            <Label htmlFor="cancelled-from" className="text-xs text-muted-foreground">Cancelled from</Label>
            <Input id="cancelled-from" type="date" value={cancelledFrom} onChange={(e) => updateUiState({ cancelledFrom: e.target.value })} className="h-9 w-[150px]" />
          </div>
          <div className="flex items-center gap-2">
            <Label htmlFor="cancelled-to" className="text-xs text-muted-foreground">Cancelled to</Label>
            <Input id="cancelled-to" type="date" value={cancelledTo} onChange={(e) => updateUiState({ cancelledTo: e.target.value })} className="h-9 w-[150px]" />
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={resetUiState}>
            Reset filters
          </Button>
          <span className="text-xs text-muted-foreground">{filtered.length} of {subscriptions.length} subscriptions</span>
        </div>

        <div className="overflow-x-auto rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Email</TableHead>
                <TableHead>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 hover:text-foreground"
                    onClick={() => toggleSort("cohort_id")}
                  >
                    Cohort {sortIcon("cohort_id")}
                  </button>
                </TableHead>
                <TableHead>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 hover:text-foreground"
                    onClick={() => toggleSort("cohort_date")}
                  >
                    Cohort Date {sortIcon("cohort_date")}
                  </button>
                </TableHead>
                <TableHead>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 hover:text-foreground"
                    onClick={() => toggleSort("campaign_path")}
                  >
                    Campaign Path {sortIcon("campaign_path")}
                  </button>
                </TableHead>
                <TableHead className="text-right">Entry Price</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Renews</TableHead>
                <TableHead>Cancelled</TableHead>
                <TableHead>Cancelled at</TableHead>
                <TableHead>Cancel Type</TableHead>
                <TableHead>Cancel Timing</TableHead>
                <TableHead className="text-right">Days to Cancel</TableHead>
                <TableHead className="text-right">Hours Before Period End</TableHead>
                <TableHead>Cancellation Reason</TableHead>
                <TableHead>Period ends</TableHead>
                <TableHead className="text-right">Price</TableHead>
                <TableHead>Billing</TableHead>
                <TableHead>Product</TableHead>
                <TableHead>Provider</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((sub) => (
                <TableRow key={sub.subscription_id || sub.psp_id || `${sub.email}-${sub.created_at}`}>
                  <TableCell className="text-sm">{sub.email || "—"}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{sub.cohort_id || "—"}</TableCell>
                  <TableCell className="text-xs text-muted-foreground tabular-nums">{sub.cohort_date || "—"}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{sub.campaign_path || "—"}</TableCell>
                  <TableCell className="text-right text-sm tabular-nums">
                    {sub.entry_price == null ? "—" : formatCurrency(sub.entry_price)}
                  </TableCell>
                  <TableCell><Badge variant="secondary">{sub.status || "unknown"}</Badge></TableCell>
                  <TableCell className="text-sm">{boolLabel(sub.renews)}</TableCell>
                  <TableCell className="text-sm">{sub.is_cancelled ? "Yes" : "No"}</TableCell>
                  <TableCell className="text-xs text-muted-foreground tabular-nums">{formatDateTime(sub.cancelled_at)}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{readableValue(cancelTypeOf(sub))}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{readableValue(cancelTimingOf(sub))}</TableCell>
                  <TableCell className="text-right text-sm tabular-nums">{sub.days_to_cancel ?? "—"}</TableCell>
                  <TableCell className="text-right text-sm tabular-nums">{sub.hours_before_period_end ?? "—"}</TableCell>
                  <TableCell className="max-w-[220px] truncate text-xs text-muted-foreground">{sub.cancellation_reason || "—"}</TableCell>
                  <TableCell className="text-xs text-muted-foreground tabular-nums">{formatDateTime(sub.period_ends_at)}</TableCell>
                  <TableCell className="text-right text-sm tabular-nums">{formatCurrency(sub.price_usd)}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {sub.billing_interval_count ?? "—"} {sub.billing_interval || ""}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{sub.product_name || "—"}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{sub.payment_provider || "—"}</TableCell>
                </TableRow>
              ))}
              {filtered.length === 0 && (
                <TableRow>
                  <TableCell colSpan={19} className="py-10 text-center text-sm text-muted-foreground">
                    No FunnelFox subscriptions loaded.
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
