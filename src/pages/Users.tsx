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
import { computeUsers, formatCurrency } from "@/services/analytics";
import { formatDateKey, toDateKey } from "@/services/dateKeys";
import { usePersistedPageState } from "@/hooks/usePersistedPageState";
import { CARD_TYPE_VALUES, cardTypeLabel } from "@/services/userCardType";
import { backfillTransactionCardTypesFromRawRows } from "@/services/palmerTransform";
import { DECLINE_REASON_VALUES, enrichTransactionDeclinesFromRawRows } from "@/services/paymentFailures";
import { useDataStore } from "@/store/dataStore";
import { cn } from "@/lib/utils";
import type { CardType, DeclineReason, Transaction, UserAggregate } from "@/services/types";

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
type UserWithCampaignPath = UserAggregate & { campaign_path: string };

const DEFAULT_USERS_UI_STATE = {
  search: "",
  campaignPathFilter: "all",
  countryFilter: "all",
  selectedCardTypes: [] as CardType[],
  paymentFailedFilter: "all" as PaymentFailedFilter,
  selectedDeclineReasons: [] as DeclineReason[],
  failedAttemptsFilter: "all" as FailedAttemptsFilter,
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
  const [uiState, setUiState, resetUiState] = usePersistedPageState("ui_state_users", DEFAULT_USERS_UI_STATE);
  const {
    search,
    campaignPathFilter,
    countryFilter,
    selectedCardTypes: rawSelectedCardTypes,
    paymentFailedFilter,
    selectedDeclineReasons: rawSelectedDeclineReasons,
    failedAttemptsFilter,
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

  const analyticsTxs = useMemo(
    () => enrichTransactionDeclinesFromRawRows(backfillTransactionCardTypesFromRawRows(txs, rawPalmerRows), rawPalmerRows),
    [txs, rawPalmerRows],
  );
  const users: UserAggregate[] = useMemo(() => computeUsers(analyticsTxs), [analyticsTxs]);
  const campaignPathByUser = useMemo(() => buildCampaignPathByUser(analyticsTxs), [analyticsTxs]);
  const usersWithCampaignPath: UserWithCampaignPath[] = useMemo(
    () =>
      users.map((user) => ({
        ...user,
        campaign_path: campaignPathByUser.get(user.user_id) ?? "unknown",
      })),
    [users, campaignPathByUser]
  );
  const campaignPathOptions = useMemo(
    () => Array.from(new Set(usersWithCampaignPath.map((user) => user.campaign_path || "unknown"))).sort(),
    [usersWithCampaignPath]
  );
  const countryOptions = useMemo(
    () => Array.from(new Set(usersWithCampaignPath.map((user) => user.country_code).filter(Boolean) as string[])).sort(),
    [usersWithCampaignPath]
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const fromDateKey = toDateKey(firstTrialFrom);
    const toDateKeyValue = toDateKey(firstTrialTo);
    const hasFirstTrialFilter = Boolean(fromDateKey || toDateKeyValue);
    const failedAttemptsThreshold = failedAttemptsFilter === "gte5" ? 5 : failedAttemptsFilter === "gte3" ? 3 : failedAttemptsFilter === "gte1" ? 1 : 0;
    const list = usersWithCampaignPath.filter((u) => {
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
  }, [usersWithCampaignPath, search, campaignPathFilter, countryFilter, selectedCardTypes, paymentFailedFilter, selectedDeclineReasons, failedAttemptsFilter, firstSubFilter, refundFilter, firstTrialFrom, firstTrialTo, sortKey, sortDir]);

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

  return (
    <AppLayout title="Users" description={`${filtered.length} users`}>
      <Card className="p-4 shadow-card">
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

        <div className="mt-4 overflow-x-auto rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Email</TableHead>
                <TableHead>Campaign path</TableHead>
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
                  <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{u.campaign_path || "unknown"}</TableCell>
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
                  <TableCell colSpan={16} className="text-center text-sm text-muted-foreground py-10">
                    No users match your filters.
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
