import { useMemo } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, Check, ChevronDown, Search, X } from "lucide-react";
import { AppLayout } from "@/components/AppLayout";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
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
import { computeCohorts, computeUsers, formatCurrency } from "@/services/analytics";
import { formatDateKey, toDateKey } from "@/services/dateKeys";
import { usePersistedPageState } from "@/hooks/usePersistedPageState";
import { CARD_TYPE_VALUES, cardTypeLabel } from "@/services/userCardType";
import { backfillTransactionCardTypesFromRawRows } from "@/services/palmerTransform";
import { DECLINE_REASON_VALUES, enrichTransactionDeclinesFromRawRows } from "@/services/paymentFailures";
import { useDataStore } from "@/store/dataStore";
import { cn } from "@/lib/utils";
import type { CardType, CohortRow, DeclineReason, Transaction, UserAggregate } from "@/services/types";

type SortKey =
  | "card_type"
  | "country_code"
  | "first_trial_date"
  | "total_revenue"
  | "user_ltv"
  | "renewal_count"
  | "has_refund"
  | "total_refund_usd"
  | "has_failed_payment"
  | "latest_decline_reason"
  | "failed_payment_count"
  | "latest_decline_date";
type FirstSubFilter = "all" | "has" | "none";
type RefundFilter = "all" | "has" | "none";
type PaymentFailedFilter = "all" | "has" | "none";
type FailedAttemptsFilter = "all" | "gte1" | "gte3" | "gte5";
type CohortExplorerSortKey = "date" | "trial_users" | "net_revenue";
type UserExplorerRow = UserAggregate & {
  campaign_path: string;
  cohort_id: string | null;
  cohort_date: string | null;
  cohort_funnel: string;
  active_subscription: boolean;
  cancelled: boolean;
};

interface UserCohortInfo {
  cohort_id: string;
  cohort_date: string;
  campaign_path: string;
  funnel: string;
}

interface UserSubscriptionFlags {
  active_subscription: boolean;
  cancelled: boolean;
}

const DEFAULT_USERS_UI_STATE = {
  search: "",
  campaignPathFilter: "all",
  countryFilter: "all",
  selectedCardTypes: [] as CardType[],
  paymentFailedFilter: "all" as PaymentFailedFilter,
  selectedDeclineReasons: [] as DeclineReason[],
  failedAttemptsFilter: "all" as FailedAttemptsFilter,
  selectedCohortIds: [] as string[],
  cohortSearch: "",
  cohortDateFrom: "",
  cohortDateTo: "",
  cohortSortKey: "date" as CohortExplorerSortKey,
  cohortSortDir: "desc" as "asc" | "desc",
  firstSubFilter: "all" as FirstSubFilter,
  refundFilter: "all" as RefundFilter,
  firstTrialFrom: "",
  firstTrialTo: "",
  sortKey: "first_trial_date" as SortKey,
  sortDir: "desc" as "asc" | "desc",
};

function buildCampaignPathByUser(txs: Transaction[]): Map<string, string> {
  const byUser = new Map<string, Transaction[]>();
  for (const tx of txs) {
    const list = byUser.get(tx.user_id) ?? [];
    list.push(tx);
    byUser.set(tx.user_id, list);
  }

  const result = new Map<string, string>();
  byUser.forEach((list, userId) => {
    const sorted = [...list].sort((a, b) => (a.event_time < b.event_time ? -1 : 1));
    const trial = sorted.find((tx) => tx.transaction_type === "trial" && tx.status === "success")
      ?? sorted.find((tx) => tx.transaction_type === "trial");
    const trialCampaignPath = normalizeCampaignPathLabel(trial?.campaign_path);
    if (trialCampaignPath !== "unknown") {
      result.set(userId, trialCampaignPath);
      return;
    }

    const cohortCampaignPath = normalizeCampaignPathLabel(
      sorted.map((tx) => campaignPathFromCohortId(tx.cohort_id)).find((path) => path !== "unknown")
    );
    result.set(userId, cohortCampaignPath);
  });
  return result;
}

function campaignPathFromCohortId(cohortId: string | undefined): string {
  const match = String(cohortId ?? "").match(/^(.*)_\d{4}-\d{2}-\d{2}$/);
  return normalizeCampaignPathLabel(match?.[1]);
}

function normalizeCampaignPathLabel(path: string | undefined): string {
  const value = String(path ?? "").trim();
  return value || "unknown";
}

function buildCohortByUser(txs: Transaction[]): Map<string, UserCohortInfo> {
  const trials = txs.filter((tx) => tx.transaction_type === "trial" && tx.status === "success");
  const result = new Map<string, UserCohortInfo>();
  for (const tx of [...trials].sort((a, b) => (a.event_time < b.event_time ? -1 : 1))) {
    if (result.has(tx.user_id)) continue;
    const cohortDate = tx.cohort_date ?? tx.event_time.slice(0, 10);
    const campaignPath = tx.campaign_path || "unknown";
    result.set(tx.user_id, {
      cohort_id: tx.cohort_id ?? `${campaignPath}_${cohortDate}`,
      cohort_date: cohortDate,
      campaign_path: campaignPath,
      funnel: tx.funnel,
    });
  }
  return result;
}

function buildUserSubscriptionFlags(cohorts: CohortRow[]): Map<string, UserSubscriptionFlags> {
  const result = new Map<string, UserSubscriptionFlags>();
  for (const cohort of cohorts) {
    for (const userId of cohort.active_subscription_user_ids ?? []) {
      const flags = result.get(userId) ?? { active_subscription: false, cancelled: false };
      flags.active_subscription = true;
      result.set(userId, flags);
    }
    for (const userId of cohort.cancelled_user_ids ?? []) {
      const flags = result.get(userId) ?? { active_subscription: false, cancelled: false };
      flags.cancelled = true;
      result.set(userId, flags);
    }
  }
  return result;
}

function declineReasonBadgeClass(reason: DeclineReason): string {
  if (reason === "insufficient_funds") return "bg-warning/15 text-warning";
  if (reason === "fraud_suspected" || reason === "stolen_card" || reason === "lost_card") return "bg-destructive/10 text-destructive";
  if (reason === "authentication_failed") return "bg-primary/10 text-primary";
  if (reason === "generic_decline" || reason === "unknown") return "bg-muted text-muted-foreground";
  return "bg-secondary text-secondary-foreground";
}

export default function UsersPage() {
  const txs = useTransactions();
  const rawPalmerRows = useDataStore((s) => s.rawPalmerRows);
  const subscriptions = useDataStore((s) => s.subscriptions);
  const [uiState, setUiState, resetUiState] = usePersistedPageState("ui_state_users", DEFAULT_USERS_UI_STATE);
  const {
    search,
    campaignPathFilter,
    countryFilter,
    selectedCardTypes: rawSelectedCardTypes,
    paymentFailedFilter,
    selectedDeclineReasons: rawSelectedDeclineReasons,
    failedAttemptsFilter,
    selectedCohortIds: rawSelectedCohortIds,
    cohortSearch,
    cohortDateFrom,
    cohortDateTo,
    cohortSortKey,
    cohortSortDir,
    firstSubFilter,
    refundFilter,
    firstTrialFrom,
    firstTrialTo,
    sortKey,
    sortDir,
  } = uiState;
  const updateUiState = (patch: Partial<typeof DEFAULT_USERS_UI_STATE>) => setUiState((current) => ({ ...current, ...patch }));
  const selectedCardTypes = useMemo(
    () =>
      Array.isArray(rawSelectedCardTypes)
        ? rawSelectedCardTypes.filter((value): value is CardType => CARD_TYPE_VALUES.includes(value as CardType))
        : [],
    [rawSelectedCardTypes],
  );
  const selectedDeclineReasons = useMemo(
    () =>
      Array.isArray(rawSelectedDeclineReasons)
        ? rawSelectedDeclineReasons.filter((value): value is DeclineReason => DECLINE_REASON_VALUES.includes(value as DeclineReason))
        : [],
    [rawSelectedDeclineReasons],
  );
  const selectedCohortIds = useMemo(
    () => Array.isArray(rawSelectedCohortIds) ? rawSelectedCohortIds.filter((value): value is string => typeof value === "string") : [],
    [rawSelectedCohortIds],
  );

  const analyticsTxs = useMemo(
    () => enrichTransactionDeclinesFromRawRows(backfillTransactionCardTypesFromRawRows(txs, rawPalmerRows), rawPalmerRows),
    [txs, rawPalmerRows],
  );
  const cohorts = useMemo(() => computeCohorts(analyticsTxs, subscriptions), [analyticsTxs, subscriptions]);
  const users: UserAggregate[] = useMemo(() => computeUsers(analyticsTxs), [analyticsTxs]);
  const cohortByUser = useMemo(() => buildCohortByUser(analyticsTxs), [analyticsTxs]);
  const campaignPathByUser = useMemo(() => buildCampaignPathByUser(analyticsTxs), [analyticsTxs]);
  const userSubscriptionFlags = useMemo(() => buildUserSubscriptionFlags(cohorts), [cohorts]);
  const usersWithCampaignPath: UserExplorerRow[] = useMemo(
    () =>
      users.map((user) => {
        const cohort = cohortByUser.get(user.user_id);
        const subscriptionFlags = userSubscriptionFlags.get(user.user_id);
        return {
          ...user,
          campaign_path: cohort?.campaign_path ?? campaignPathByUser.get(user.user_id) ?? "unknown",
          cohort_id: cohort?.cohort_id ?? null,
          cohort_date: cohort?.cohort_date ?? null,
          cohort_funnel: cohort?.funnel ?? user.funnel,
          active_subscription: subscriptionFlags?.active_subscription ?? false,
          cancelled: subscriptionFlags?.cancelled ?? false,
        };
      }),
    [users, cohortByUser, campaignPathByUser, userSubscriptionFlags]
  );
  const campaignPathOptions = useMemo(
    () => Array.from(new Set(usersWithCampaignPath.map((user) => user.campaign_path || "unknown"))).sort(),
    [usersWithCampaignPath]
  );
  const countryOptions = useMemo(
    () => Array.from(new Set(usersWithCampaignPath.map((user) => user.country_code).filter(Boolean) as string[])).sort(),
    [usersWithCampaignPath]
  );
  const selectedCohortIdSet = useMemo(() => new Set(selectedCohortIds), [selectedCohortIds]);
  const visibleCohorts = useMemo(() => {
    const q = cohortSearch.trim().toLowerCase();
    const fromDateKey = toDateKey(cohortDateFrom);
    const toDateKeyValue = toDateKey(cohortDateTo);
    const list = cohorts.filter((cohort) => {
      if (q && !`${cohort.campaign_path} ${cohort.funnel}`.toLowerCase().includes(q)) return false;
      const cohortDateKey = toDateKey(cohort.cohort_date);
      if (fromDateKey && cohortDateKey < fromDateKey) return false;
      if (toDateKeyValue && cohortDateKey > toDateKeyValue) return false;
      return true;
    });
    list.sort((a, b) => {
      const av = cohortSortKey === "date" ? toDateKey(a.cohort_date) : a[cohortSortKey];
      const bv = cohortSortKey === "date" ? toDateKey(b.cohort_date) : b[cohortSortKey];
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return cohortSortDir === "asc" ? cmp : -cmp;
    });
    return list;
  }, [cohorts, cohortSearch, cohortDateFrom, cohortDateTo, cohortSortKey, cohortSortDir]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const fromDateKey = toDateKey(firstTrialFrom);
    const toDateKeyValue = toDateKey(firstTrialTo);
    const hasFirstTrialFilter = Boolean(fromDateKey || toDateKeyValue);
    const failedAttemptsThreshold = failedAttemptsFilter === "gte5" ? 5 : failedAttemptsFilter === "gte3" ? 3 : failedAttemptsFilter === "gte1" ? 1 : 0;
    const list = usersWithCampaignPath.filter((u) => {
      if (selectedCohortIdSet.size > 0 && (!u.cohort_id || !selectedCohortIdSet.has(u.cohort_id))) return false;
      if (q && !u.email.toLowerCase().includes(q) && !u.user_id.toLowerCase().includes(q)) return false;
      if (campaignPathFilter !== "all" && u.campaign_path !== campaignPathFilter) return false;
      if (countryFilter !== "all" && u.country_code !== countryFilter) return false;
      if (selectedCardTypes.length > 0 && !selectedCardTypes.includes(u.card_type)) return false;
      if (paymentFailedFilter === "has" && !u.has_failed_payment) return false;
      if (paymentFailedFilter === "none" && u.has_failed_payment) return false;
      if (selectedDeclineReasons.length > 0 && (!u.latest_decline_reason || !selectedDeclineReasons.includes(u.latest_decline_reason))) return false;
      if (failedAttemptsThreshold > 0 && u.failed_payment_count < failedAttemptsThreshold) return false;
      if (firstSubFilter === "has" && !u.has_first_subscription) return false;
      if (firstSubFilter === "none" && u.has_first_subscription) return false;
      if (refundFilter === "has" && !u.has_refund) return false;
      if (refundFilter === "none" && u.has_refund) return false;
      if (hasFirstTrialFilter) {
        // Date filters intentionally use the first trial date only, not latest transaction activity.
        const firstTrialDateKey = toDateKey(u.first_trial_date);
        if (!firstTrialDateKey) return false;
        if (fromDateKey && firstTrialDateKey < fromDateKey) return false;
        if (toDateKeyValue && firstTrialDateKey > toDateKeyValue) return false;
      }
      return true;
    });
    list.sort((a, b) => {
      const av = sortKey === "first_trial_date" ? toDateKey(a.first_trial_date) : a[sortKey] ?? "";
      const bv = sortKey === "first_trial_date" ? toDateKey(b.first_trial_date) : b[sortKey] ?? "";
      const aMissing = av === "" || av == null;
      const bMissing = bv === "" || bv == null;
      if (aMissing && bMissing) return 0;
      if (aMissing) return 1;
      if (bMissing) return -1;
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return sortDir === "asc" ? cmp : -cmp;
    });
    return list;
  }, [usersWithCampaignPath, selectedCohortIdSet, search, campaignPathFilter, countryFilter, selectedCardTypes, paymentFailedFilter, selectedDeclineReasons, failedAttemptsFilter, firstSubFilter, refundFilter, firstTrialFrom, firstTrialTo, sortKey, sortDir]);

  const summary = useMemo(() => {
    const userIds = new Set(filtered.map((user) => user.user_id));
    const grossRevenue = analyticsTxs
      .filter((tx) => userIds.has(tx.user_id) && tx.status !== "failed")
      .reduce((sum, tx) => sum + (tx.gross_amount_usd ?? (tx.amount_usd > 0 ? tx.amount_usd : 0)), 0);
    return {
      users: filtered.length,
      trial_users: filtered.filter((user) => Boolean(user.first_trial_date)).length,
      upsell_users: filtered.filter((user) => user.has_upsell).length,
      first_sub_users: filtered.filter((user) => user.has_first_subscription).length,
      active_subscriptions: filtered.filter((user) => user.active_subscription).length,
      cancelled_users: filtered.filter((user) => user.cancelled).length,
      refund_users: filtered.filter((user) => user.has_refund).length,
      gross_revenue: grossRevenue,
      net_revenue: filtered.reduce((sum, user) => sum + user.total_revenue, 0),
      failed_payment_users: filtered.filter((user) => user.has_failed_payment).length,
    };
  }, [filtered, analyticsTxs]);

  const hasFirstTrialFilter = Boolean(firstTrialFrom || firstTrialTo);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) updateUiState({ sortDir: sortDir === "asc" ? "desc" : "asc" });
    else updateUiState({ sortKey: key, sortDir: "desc" });
  };

  const icon = (key: SortKey) =>
    sortKey !== key ? <ArrowUpDown className="h-3 w-3 opacity-40" /> :
    sortDir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />;
  const cardTypeSummary = selectedCardTypes.length ? selectedCardTypes.map(cardTypeLabel).join(", ") : "All card types";
  const declineReasonSummary = selectedDeclineReasons.length ? selectedDeclineReasons.join(", ") : "All reasons";
  const toggleCardType = (cardType: CardType) => {
    const next = selectedCardTypes.includes(cardType)
      ? selectedCardTypes.filter((value) => value !== cardType)
      : [...selectedCardTypes, cardType];
    updateUiState({ selectedCardTypes: next });
  };
  const clearCardTypes = () => updateUiState({ selectedCardTypes: [] });
  const toggleDeclineReason = (reason: DeclineReason) => {
    const next = selectedDeclineReasons.includes(reason)
      ? selectedDeclineReasons.filter((value) => value !== reason)
      : [...selectedDeclineReasons, reason];
    updateUiState({ selectedDeclineReasons: next });
  };
  const clearDeclineReasons = () => updateUiState({ selectedDeclineReasons: [] });
  const toggleCohortSelection = (cohortId: string) => {
    const next = selectedCohortIds.includes(cohortId)
      ? selectedCohortIds.filter((value) => value !== cohortId)
      : [...selectedCohortIds, cohortId];
    updateUiState({ selectedCohortIds: next });
  };
  const selectOnlyCohort = (cohortId: string) => updateUiState({ selectedCohortIds: [cohortId] });
  const clearCohortSelection = () => updateUiState({ selectedCohortIds: [] });
  const toggleCohortSortDirection = () => updateUiState({ cohortSortDir: cohortSortDir === "asc" ? "desc" : "asc" });
  const summaryCards = [
    { label: "Users", value: String(summary.users) },
    { label: "Trial Users", value: String(summary.trial_users) },
    { label: "Upsell Users", value: String(summary.upsell_users) },
    { label: "First Sub Users", value: String(summary.first_sub_users) },
    { label: "Active Subscriptions", value: String(summary.active_subscriptions) },
    { label: "Cancelled Users", value: String(summary.cancelled_users) },
    { label: "Refund Users", value: String(summary.refund_users) },
    { label: "Gross Rev", value: formatCurrency(summary.gross_revenue) },
    { label: "Net Rev", value: formatCurrency(summary.net_revenue) },
    { label: "Failed Payment Users", value: String(summary.failed_payment_users) },
  ];

  return (
    <AppLayout title="Users" description={`${filtered.length} users`}>
      <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
        <Card className="p-4 shadow-card lg:sticky lg:top-4 lg:self-start">
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="text-sm font-medium">Cohorts</div>
                <div className="text-xs text-muted-foreground">{selectedCohortIds.length ? `${selectedCohortIds.length} selected` : "All cohorts"}</div>
              </div>
              <Button type="button" variant="ghost" size="sm" onClick={clearCohortSelection} disabled={!selectedCohortIds.length}>
                Clear
              </Button>
            </div>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search campaign…"
                value={cohortSearch}
                onChange={(e) => updateUiState({ cohortSearch: e.target.value })}
                className="h-9 pl-8"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Input
                type="date"
                value={cohortDateFrom}
                onChange={(e) => updateUiState({ cohortDateFrom: e.target.value })}
                className="h-9"
                aria-label="Cohort date from"
              />
              <Input
                type="date"
                value={cohortDateTo}
                onChange={(e) => updateUiState({ cohortDateTo: e.target.value })}
                className="h-9"
                aria-label="Cohort date to"
              />
            </div>
            <div className="flex items-center gap-2">
              <Select value={cohortSortKey} onValueChange={(value: CohortExplorerSortKey) => updateUiState({ cohortSortKey: value })}>
                <SelectTrigger className="h-9 flex-1"><SelectValue placeholder="Sort cohorts" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="date">Date</SelectItem>
                  <SelectItem value="trial_users">Trial users</SelectItem>
                  <SelectItem value="net_revenue">Net revenue</SelectItem>
                </SelectContent>
              </Select>
              <Button type="button" variant="outline" size="icon" className="h-9 w-9" onClick={toggleCohortSortDirection} aria-label="Toggle cohort sort direction">
                {cohortSortDir === "asc" ? <ArrowUp className="h-4 w-4" /> : <ArrowDown className="h-4 w-4" />}
              </Button>
            </div>
            <div className="max-h-[620px] space-y-1 overflow-y-auto pr-1">
              {visibleCohorts.map((cohort) => {
                const selected = selectedCohortIdSet.has(cohort.cohort_id);
                return (
                  <div
                    key={cohort.cohort_id}
                    role="button"
                    tabIndex={0}
                    onClick={(event) => {
                      if (event.metaKey || event.ctrlKey) toggleCohortSelection(cohort.cohort_id);
                      else selectOnlyCohort(cohort.cohort_id);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        if (event.metaKey || event.ctrlKey) toggleCohortSelection(cohort.cohort_id);
                        else selectOnlyCohort(cohort.cohort_id);
                      }
                    }}
                    className={cn(
                      "w-full cursor-pointer rounded-md border px-3 py-2 text-left transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      selected ? "border-primary bg-primary/10" : "border-border bg-background",
                    )}
                  >
                    <div className="flex items-start gap-2">
                      <Checkbox
                        checked={selected}
                        onClick={(event) => event.stopPropagation()}
                        onCheckedChange={() => toggleCohortSelection(cohort.cohort_id)}
                        aria-label={`Select cohort ${cohort.cohort_id}`}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-medium tabular-nums">{formatDateKey(cohort.cohort_date)}</span>
                          <span className="text-xs text-muted-foreground tabular-nums">{cohort.trial_users} trials</span>
                        </div>
                        <div className="mt-1 truncate text-xs text-muted-foreground">{cohort.campaign_path}</div>
                        <div className="mt-1 flex items-center justify-between gap-2 text-xs">
                          <span className="capitalize text-muted-foreground">{cohort.funnel.replace("_", " ")}</span>
                          <span className="font-medium tabular-nums">{formatCurrency(cohort.net_revenue)}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
              {visibleCohorts.length === 0 && (
                <div className="rounded-md border border-dashed border-border px-3 py-8 text-center text-sm text-muted-foreground">
                  No cohorts match your filters.
                </div>
              )}
            </div>
          </div>
        </Card>

        <Card className="min-w-0 p-4 shadow-card">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search by email…"
              value={search}
              onChange={(e) => updateUiState({ search: e.target.value })}
              className="pl-8 h-9"
            />
          </div>
          <Select value={campaignPathFilter} onValueChange={(value) => updateUiState({ campaignPathFilter: value })}>
            <SelectTrigger className="h-9 w-[220px]"><SelectValue placeholder="Campaign path" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All campaign paths</SelectItem>
              {campaignPathOptions.map((path) => (
                <SelectItem key={path} value={path}>{path}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={countryFilter} onValueChange={(value) => updateUiState({ countryFilter: value })}>
            <SelectTrigger className="h-9 w-[170px]"><SelectValue placeholder="Country" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All countries</SelectItem>
              {countryOptions.map((country) => (
                <SelectItem key={country} value={country}>{country}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Popover>
            <PopoverTrigger asChild>
              <Button type="button" variant="outline" size="sm" className="h-9 max-w-[220px] justify-between gap-2">
                <span className="text-xs text-muted-foreground">Card Type</span>
                <span className="truncate">{cardTypeSummary}</span>
                <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-60 p-0">
              <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
                <div className="text-xs font-medium text-muted-foreground">Card Type</div>
                <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={clearCardTypes} disabled={!selectedCardTypes.length}>
                  All card types
                </Button>
              </div>
              <div className="py-1">
                {CARD_TYPE_VALUES.map((cardType) => (
                  <label key={cardType} className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-muted/50">
                    <Checkbox
                      checked={selectedCardTypes.includes(cardType)}
                      onCheckedChange={() => toggleCardType(cardType)}
                    />
                    <span>{cardTypeLabel(cardType)}</span>
                  </label>
                ))}
              </div>
            </PopoverContent>
          </Popover>
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            Payment Failed
            <Select value={paymentFailedFilter} onValueChange={(value: PaymentFailedFilter) => updateUiState({ paymentFailedFilter: value })}>
              <SelectTrigger className="h-9 w-[170px]"><SelectValue placeholder="Payment Failed" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="has">Has failed payments</SelectItem>
                <SelectItem value="none">No failed payments</SelectItem>
              </SelectContent>
            </Select>
          </label>
          <Popover>
            <PopoverTrigger asChild>
              <Button type="button" variant="outline" size="sm" className="h-9 max-w-[260px] justify-between gap-2">
                <span className="text-xs text-muted-foreground">Decline Reason</span>
                <span className="truncate">{declineReasonSummary}</span>
                <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-72 p-0">
              <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
                <div className="text-xs font-medium text-muted-foreground">Decline Reason</div>
                <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={clearDeclineReasons} disabled={!selectedDeclineReasons.length}>
                  All reasons
                </Button>
              </div>
              <div className="max-h-72 overflow-y-auto py-1">
                {DECLINE_REASON_VALUES.map((reason) => (
                  <label key={reason} className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-muted/50">
                    <Checkbox
                      checked={selectedDeclineReasons.includes(reason)}
                      onCheckedChange={() => toggleDeclineReason(reason)}
                    />
                    <span>{reason}</span>
                  </label>
                ))}
              </div>
            </PopoverContent>
          </Popover>
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            Failed Attempts
            <Select value={failedAttemptsFilter} onValueChange={(value: FailedAttemptsFilter) => updateUiState({ failedAttemptsFilter: value })}>
              <SelectTrigger className="h-9 w-[130px]"><SelectValue placeholder="Attempts" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="gte1">&gt;= 1</SelectItem>
                <SelectItem value="gte3">&gt;= 3</SelectItem>
                <SelectItem value="gte5">&gt;= 5</SelectItem>
              </SelectContent>
            </Select>
          </label>
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            First sub
            <Select value={firstSubFilter} onValueChange={(value: FirstSubFilter) => updateUiState({ firstSubFilter: value })}>
              <SelectTrigger className="h-9 w-[150px]"><SelectValue placeholder="First sub" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="has">Has First Sub</SelectItem>
                <SelectItem value="none">No First Sub</SelectItem>
              </SelectContent>
            </Select>
          </label>
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            Refund
            <Select value={refundFilter} onValueChange={(value: RefundFilter) => updateUiState({ refundFilter: value })}>
              <SelectTrigger className="h-9 w-[140px]"><SelectValue placeholder="Refund" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="has">Has refund</SelectItem>
                <SelectItem value="none">No refund</SelectItem>
              </SelectContent>
            </Select>
          </label>
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            First trial from
            <Input
              type="date"
              value={firstTrialFrom}
              onChange={(e) => updateUiState({ firstTrialFrom: e.target.value })}
              className="h-9 w-[150px]"
            />
          </label>
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            First trial to
            <Input
              type="date"
              value={firstTrialTo}
              onChange={(e) => updateUiState({ firstTrialTo: e.target.value })}
              className="h-9 w-[150px]"
            />
          </label>
          {hasFirstTrialFilter && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => updateUiState({ firstTrialFrom: "", firstTrialTo: "" })}
            >
              Clear date filter
            </Button>
          )}
          <Button type="button" variant="ghost" size="sm" onClick={resetUiState}>
            Reset filters
          </Button>
        </div>

        <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
          {summaryCards.map((card) => (
            <div key={card.label} className="rounded-md border border-border bg-muted/20 px-3 py-2">
              <div className="text-xs text-muted-foreground">{card.label}</div>
              <div className="mt-1 text-sm font-semibold tabular-nums">{card.value}</div>
            </div>
          ))}
        </div>

        <div className="mt-4 overflow-x-auto rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Email</TableHead>
                <TableHead>Funnel / Campaign Path</TableHead>
                <TableHead>
                  <button onClick={() => toggleSort("country_code")} className="inline-flex items-center gap-1 hover:text-foreground">
                    Country {icon("country_code")}
                  </button>
                </TableHead>
                <TableHead>
                  <button onClick={() => toggleSort("card_type")} className="inline-flex items-center gap-1 hover:text-foreground">
                    Card Type {icon("card_type")}
                  </button>
                </TableHead>
                <TableHead className="text-center">
                  <button onClick={() => toggleSort("has_failed_payment")} className="inline-flex items-center gap-1 hover:text-foreground">
                    Payment Failed {icon("has_failed_payment")}
                  </button>
                </TableHead>
                <TableHead>
                  <button onClick={() => toggleSort("latest_decline_reason")} className="inline-flex items-center gap-1 hover:text-foreground">
                    Decline Reason {icon("latest_decline_reason")}
                  </button>
                </TableHead>
                <TableHead className="text-right">
                  <button onClick={() => toggleSort("failed_payment_count")} className="inline-flex items-center gap-1 hover:text-foreground">
                    Failed Attempts {icon("failed_payment_count")}
                  </button>
                </TableHead>
                <TableHead>
                  <button onClick={() => toggleSort("latest_decline_date")} className="inline-flex items-center gap-1 hover:text-foreground">
                    Last Failed Date {icon("latest_decline_date")}
                  </button>
                </TableHead>
                <TableHead className="text-center">Active Subscription</TableHead>
                <TableHead className="text-center">Cancelled</TableHead>
                <TableHead>First trial</TableHead>
                <TableHead className="text-right">
                  <button onClick={() => toggleSort("total_revenue")} className="inline-flex items-center gap-1 hover:text-foreground">
                    Total revenue {icon("total_revenue")}
                  </button>
                </TableHead>
                <TableHead className="text-center">Upsell</TableHead>
                <TableHead className="text-center">First sub</TableHead>
                <TableHead className="text-center">
                  <button onClick={() => toggleSort("has_refund")} className="inline-flex items-center gap-1 hover:text-foreground">
                    Refund {icon("has_refund")}
                  </button>
                </TableHead>
                <TableHead className="text-right">
                  <button onClick={() => toggleSort("total_refund_usd")} className="inline-flex items-center gap-1 hover:text-foreground">
                    Amount Refunded {icon("total_refund_usd")}
                  </button>
                </TableHead>
                <TableHead className="text-right">
                  <button onClick={() => toggleSort("renewal_count")} className="inline-flex items-center gap-1 hover:text-foreground">
                    Renewals {icon("renewal_count")}
                  </button>
                </TableHead>
                <TableHead className="text-right">
                  <button onClick={() => toggleSort("user_ltv")} className="inline-flex items-center gap-1 hover:text-foreground">
                    LTV {icon("user_ltv")}
                  </button>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((u) => (
                <TableRow key={u.user_id}>
                  <TableCell className="text-sm">{u.email || "—"}</TableCell>
                  <TableCell className="whitespace-nowrap">
                    <div className="text-xs capitalize">{u.cohort_funnel.replace("_", " ")}</div>
                    <div className="text-xs text-muted-foreground">{u.campaign_path || "unknown"}</div>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground tabular-nums">{u.country_code || "—"}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{cardTypeLabel(u.card_type)}</TableCell>
                  <TableCell className="text-center text-xs">{u.has_failed_payment ? "Yes" : "No"}</TableCell>
                  <TableCell className="text-xs">
                    {u.latest_decline_reason ? (
                      <span className={cn("inline-flex items-center rounded-md px-2 py-0.5 font-medium", declineReasonBadgeClass(u.latest_decline_reason))}>
                        {u.latest_decline_reason}
                      </span>
                    ) : "—"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{u.failed_payment_count}</TableCell>
                  <TableCell className="text-xs text-muted-foreground tabular-nums">
                    {u.latest_decline_date ? formatDateKey(u.latest_decline_date) : "—"}
                  </TableCell>
                  <TableCell className="text-center">
                    {u.active_subscription
                      ? <Check className="inline h-4 w-4 text-success" />
                      : <X className="inline h-4 w-4 text-muted-foreground/50" />}
                  </TableCell>
                  <TableCell className="text-center">
                    {u.cancelled
                      ? <Check className="inline h-4 w-4 text-success" />
                      : <X className="inline h-4 w-4 text-muted-foreground/50" />}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground tabular-nums">
                    {u.first_trial_date ? formatDateKey(u.first_trial_date) : "—"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{formatCurrency(u.total_revenue)}</TableCell>
                  <TableCell className="text-center">
                    {u.has_upsell
                      ? <Check className="inline h-4 w-4 text-success" />
                      : <X className="inline h-4 w-4 text-muted-foreground/50" />}
                  </TableCell>
                  <TableCell className="text-center">
                    {u.has_first_subscription
                      ? <Check className="inline h-4 w-4 text-success" />
                      : <X className="inline h-4 w-4 text-muted-foreground/50" />}
                  </TableCell>
                  <TableCell className="text-center">
                    {u.has_refund
                      ? <Check className="inline h-4 w-4 text-success" />
                      : <X className="inline h-4 w-4 text-muted-foreground/50" />}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{formatCurrency(u.total_refund_usd)}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{u.renewal_count}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm font-medium">{formatCurrency(u.user_ltv)}</TableCell>
                </TableRow>
              ))}
              {filtered.length === 0 && (
                <TableRow>
                  <TableCell colSpan={18} className="text-center text-sm text-muted-foreground py-10">
                    No users match your filters.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        </Card>
      </div>
    </AppLayout>
  );
}
