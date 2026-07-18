import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, Check, ChevronDown, Search, X } from "lucide-react";
import { AppLayout } from "@/components/AppLayout";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import { UNKNOWN_COUNTRY, buildLegacyCountryOptions, usersDataSourceMode, type UsersDeclineQuery, type UsersQuery } from "@/services/usersDataSource";
import { useAuth } from "@/hooks/useAuth";
import { hashUserScope } from "@/services/analyticsCache";
import { useWarehouseVersion } from "@/hooks/useAnalyticsCache";
import { useUsersData, useUsersDeclineData } from "@/hooks/useUsersCache";
import { formatUpdatedAgo } from "@/services/analyticsProgress";
import { Progress } from "@/components/ui/progress";
import { formatDateKey, toDateKey } from "@/services/dateKeys";
import { usePersistedPageState } from "@/hooks/usePersistedPageState";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { CARD_TYPE_VALUES, cardTypeLabel } from "@/services/userCardType";
import { backfillTransactionCardTypesFromRawRows } from "@/services/palmerTransform";
import {
  DECLINE_REASON_VALUES,
  DECLINE_STAGE_VALUES,
  classifyDeclineStagesForTransactions,
  declineBreakdownMessageForTransaction,
  declineDetailsForTransaction,
  declineStageLabel,
  enrichTransactionDeclinesFromRawRows,
  isFailedPaymentTransaction,
} from "@/services/paymentFailures";
import { useDataStore } from "@/store/dataStore";
import { cn } from "@/lib/utils";
import type { CardType, CohortRow, DeclineReason, DeclineStage, Transaction, UserAggregate } from "@/services/types";
import { buildCohortId } from "@/services/cohortIdentity";
import { traceEvent, traceMark, traceMeasure } from "@/services/performanceTrace";

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
  | "latest_decline_stage"
  | "failed_payment_count"
  | "latest_decline_date";
type FirstSubFilter = "all" | "has" | "none";
type RefundFilter = "all" | "has" | "none";
type PaymentFailedFilter = "all" | "has" | "none";
type FailedAttemptsFilter = "all" | "gte1" | "gte3" | "gte5";
type CohortExplorerSortKey = "date" | "trial_users" | "net_revenue";
type UsersPageMode = "users_table" | "decline_analytics";
type DeclineSortKey = "reason" | "failed_users" | "failed_transactions" | "share" | "avg_attempts" | "latest_failed_date";
// Sort fields of the server-computed Decline Analytics country breakdown
// (mirrors the Edge Function allowlist; sorting runs over the FULL country set).
type DeclineCountrySortKey =
  | "country"
  | "total_attempts"
  | "successful"
  | "failed"
  | "pass_rate"
  | "pass_rate_ex_if"
  | "insufficient_funds"
  | "users_with_attempts"
  | "users_with_success"
  | "user_pass_rate"
  | "first_attempt_pass_rate"
  | "first_sub_pass_rate"
  | "renewal_pass_rate";
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

interface CohortMembershipLookup {
  byUserId: Map<string, Set<string>>;
  byEmail: Map<string, Set<string>>;
}

// Raw-processor-message drill-down of one reason row ("fraud_suspected" →
// "Suspected fraud" / "Fraud/Security (Mastercard use only)" / "fraudulent" /
// "Security violation" …); share is % within the parent reason.
interface DeclineMessageBreakdownRow {
  message: string;
  failed_users: number;
  failed_transactions: number;
  share: number;
}

interface DeclineBreakdownRow {
  reason: DeclineReason;
  failed_users: number;
  failed_transactions: number;
  share: number;
  avg_attempts: number;
  latest_failed_date: string | null;
  stage_counts: Record<DeclineStage, number>;
  top_stage: DeclineStage;
  messages: DeclineMessageBreakdownRow[];
}

interface DeclineStageBreakdownRow {
  stage: DeclineStage;
  failed_users: number;
  failed_transactions: number;
  share: number;
  top_reason: DeclineReason | null;
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
  mode: "users_table" as UsersPageMode,
  declineAnalyticsReasons: [] as DeclineReason[],
  declineAnalyticsStages: [] as DeclineStage[],
  declineSortKey: "failed_transactions" as DeclineSortKey,
  declineSortDir: "desc" as "asc" | "desc",
  declineCountrySortKey: "total_attempts" as DeclineCountrySortKey,
  declineCountrySortDir: "desc" as "asc" | "desc",
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
  let stem = match?.[1] ?? "";
  for (const prefix of ["past_life_", "soulmate_", "starseed_", "unknown_"]) {
    if (stem.startsWith(prefix)) {
      stem = stem.slice(prefix.length);
      break;
    }
  }
  return normalizeCampaignPathLabel(stem);
}

function dateFromCohortId(cohortId: string | undefined): string | null {
  return String(cohortId ?? "").match(/_(\d{4}-\d{2}-\d{2})$/)?.[1] ?? null;
}

function legacyCohortId(campaignPath: string, cohortDate: string): string {
  return `${campaignPath}_${cohortDate}`;
}

function legacyCohortIdFromAny(cohortId: string): string | null {
  const cohortDate = dateFromCohortId(cohortId);
  if (!cohortDate) return null;
  const campaignPath = campaignPathFromCohortId(cohortId);
  if (campaignPath === "unknown") return null;
  return legacyCohortId(campaignPath, cohortDate);
}

function cohortSelectionMatchIds(cohortIds: string[]): Set<string> {
  const ids = new Set<string>();
  for (const cohortId of cohortIds) {
    ids.add(cohortId);
    const legacyId = legacyCohortIdFromAny(cohortId);
    if (legacyId) ids.add(legacyId);
  }
  return ids;
}

function cohortIdsForTransaction(tx: Transaction): string[] {
  const ids = new Set<string>();
  if (tx.cohort_id) ids.add(tx.cohort_id);

  const cohortDate =
    tx.cohort_date ??
    dateFromCohortId(tx.cohort_id) ??
    (tx.transaction_type === "trial" ? tx.event_time.slice(0, 10) : null);
  if (!cohortDate) return Array.from(ids);

  const campaignPath = tx.campaign_path || campaignPathFromCohortId(tx.cohort_id) || "unknown";
  ids.add(buildCohortId(tx.funnel, campaignPath, cohortDate));
  ids.add(legacyCohortId(campaignPath, cohortDate));
  return Array.from(ids);
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
      cohort_id: buildCohortId(tx.funnel, campaignPath, cohortDate),
      cohort_date: cohortDate,
      campaign_path: campaignPath,
      funnel: tx.funnel,
    });
  }
  return result;
}

function addCohortMembership(
  lookup: CohortMembershipLookup,
  tx: Pick<Transaction, "user_id" | "email">,
  cohortId: string | null | undefined,
) {
  if (!cohortId) return;
  if (tx.user_id) {
    const ids = lookup.byUserId.get(tx.user_id) ?? new Set<string>();
    ids.add(cohortId);
    lookup.byUserId.set(tx.user_id, ids);
  }
  const email = emailKey(tx.email);
  if (email) {
    const ids = lookup.byEmail.get(email) ?? new Set<string>();
    ids.add(cohortId);
    lookup.byEmail.set(email, ids);
  }
}

function buildCohortMembershipLookup(txs: Transaction[]): CohortMembershipLookup {
  const lookup: CohortMembershipLookup = { byUserId: new Map(), byEmail: new Map() };

  for (const tx of txs) {
    for (const cohortId of cohortIdsForTransaction(tx)) addCohortMembership(lookup, tx, cohortId);
  }

  return lookup;
}

function userMatchesSelectedCohorts(
  user: UserExplorerRow,
  selectedCohortIdSet: Set<string>,
  membership: CohortMembershipLookup,
): boolean {
  if (selectedCohortIdSet.size === 0) return true;
  if (user.cohort_id && selectedCohortIdSet.has(user.cohort_id)) return true;
  const userIds = membership.byUserId.get(user.user_id);
  if (userIds && [...selectedCohortIdSet].some((cohortId) => userIds.has(cohortId))) return true;
  const emailIds = membership.byEmail.get(emailKey(user.email));
  return Boolean(emailIds && [...selectedCohortIdSet].some((cohortId) => emailIds.has(cohortId)));
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

function emailKey(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

function formatPct(value: number, digits = 1): string {
  return `${value.toFixed(digits)}%`;
}

function createDeclineStageCounts(): Record<DeclineStage, number> {
  return {
    after_trial: 0,
    after_first_subscription: 0,
    after_renewal: 0,
    unknown: 0,
  };
}

function topStageFromCounts(counts: Record<DeclineStage, number>): DeclineStage {
  return [...DECLINE_STAGE_VALUES].sort((a, b) => counts[b] - counts[a] || DECLINE_STAGE_VALUES.indexOf(a) - DECLINE_STAGE_VALUES.indexOf(b))[0] ?? "unknown";
}

function declineStageBadgeClass(stage: DeclineStage): string {
  if (stage === "after_trial") return "bg-primary/10 text-primary";
  if (stage === "after_first_subscription") return "bg-warning/15 text-warning";
  if (stage === "after_renewal") return "bg-success/10 text-success";
  return "bg-muted text-muted-foreground";
}

function declineStageBarClass(stage: DeclineStage): string {
  if (stage === "after_trial") return "bg-primary";
  if (stage === "after_first_subscription") return "bg-warning";
  if (stage === "after_renewal") return "bg-success";
  return "bg-muted-foreground/50";
}

// Render the user table one page at a time so the DOM stays bounded for large
// accounts. Summary/decline/totals are still computed over the full set.
const USERS_PAGE_SIZE = 50;

export default function UsersPage() {
  const txs = useTransactions();
  const mountedRef = useRef(false);
  const firstRowsRef = useRef(false);
  if (!mountedRef.current) {
    mountedRef.current = true;
    traceMark("route.users.mounted");
  }
  const rawPalmerRows = useDataStore((s) => s.rawPalmerRows);
  const subscriptions = useDataStore((s) => s.subscriptions);
  const [uiState, setUiState] = usePersistedPageState("ui_state_users", DEFAULT_USERS_UI_STATE);
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
    mode,
    declineAnalyticsReasons: rawDeclineAnalyticsReasons,
    declineAnalyticsStages: rawDeclineAnalyticsStages,
    declineSortKey,
    declineSortDir,
    declineCountrySortKey,
    declineCountrySortDir,
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
  const declineAnalyticsReasons = useMemo(
    () =>
      Array.isArray(rawDeclineAnalyticsReasons)
        ? rawDeclineAnalyticsReasons.filter((value): value is DeclineReason => DECLINE_REASON_VALUES.includes(value as DeclineReason))
        : [],
    [rawDeclineAnalyticsReasons],
  );
  const declineAnalyticsStages = useMemo(
    () =>
      Array.isArray(rawDeclineAnalyticsStages)
        ? rawDeclineAnalyticsStages.filter((value): value is DeclineStage => DECLINE_STAGE_VALUES.includes(value as DeclineStage))
        : [],
    [rawDeclineAnalyticsStages],
  );

  // --- ClickHouse Users read path (Phase 9-11) --------------------------
  // clickhouse (default): the Edge Function drives the table AND the Decline
  // Analytics tab with server-side filtering/sorting/aggregation; the browser
  // performs NO transaction scan. Legacy is the fallback when: the flag is
  // legacy, ClickHouse errors, or a cohort selection is active (not reproduced
  // server-side).
  const usersSource = useMemo(() => usersDataSourceMode(), []);
  const { user } = useAuth();
  const userScopeHash = useMemo(() => hashUserScope(user?.id), [user?.id]);
  const { version: warehouseVersion, ready: warehouseVersionReady } = useWarehouseVersion(usersSource === "clickhouse");
  const [appliedSearch] = useDebouncedValue(search, 300);
  const [page, setPage] = useState(1);
  // Which decline reasons are expanded to their raw-message breakdown.
  // Transient exploration state — intentionally not persisted.
  const [expandedDeclineReasons, setExpandedDeclineReasons] = useState<string[]>([]);
  const toggleDeclineReasonExpanded = (reason: string) =>
    setExpandedDeclineReasons((current) =>
      current.includes(reason) ? current.filter((value) => value !== reason) : [...current, reason]);
  // ClickHouse server-side query: filters + sort + pagination. Assembled here
  // (before the fallback decision) so the cached list/summary status drives
  // needLegacy. The QueryClient lives above the router, so this cache survives
  // route unmount/remount — returning to Users renders cached rows instantly.
  const usersQuery = useMemo<UsersQuery>(
    () => ({
      search: appliedSearch,
      firstTrialFrom,
      firstTrialTo,
      firstSub: firstSubFilter,
      refund: refundFilter,
      paymentFailed: paymentFailedFilter,
      failedAttempts: failedAttemptsFilter,
      campaignPath: campaignPathFilter,
      country: countryFilter,
      cardTypes: selectedCardTypes,
      declineReasons: selectedDeclineReasons,
      sortField: sortKey,
      sortDir,
      page,
      pageSize: USERS_PAGE_SIZE,
    }),
    [appliedSearch, firstTrialFrom, firstTrialTo, firstSubFilter, refundFilter, paymentFailedFilter, failedAttemptsFilter, campaignPathFilter, countryFilter, selectedCardTypes, selectedDeclineReasons, sortKey, sortDir, page],
  );
  const hasSelectedCohortsRaw = Array.isArray(rawSelectedCohortIds) && rawSelectedCohortIds.length > 0;
  const usersServerEligible = usersSource === "clickhouse" && !hasSelectedCohortsRaw && mode !== "decline_analytics";
  // Decline Analytics ClickHouse path: the bundle (totals + reason/stage rows +
  // country breakdown) is computed server-side over the SAME filtered user set.
  // Cohort selections are still a legacy boundary (not reproduced server-side).
  const declineServerEligible = usersSource === "clickhouse" && !hasSelectedCohortsRaw && mode === "decline_analytics";
  const declineQuery = useMemo<UsersDeclineQuery>(
    () => ({
      search: appliedSearch,
      firstTrialFrom,
      firstTrialTo,
      firstSub: firstSubFilter,
      refund: refundFilter,
      paymentFailed: paymentFailedFilter,
      failedAttempts: failedAttemptsFilter,
      campaignPath: campaignPathFilter,
      country: countryFilter,
      cardTypes: selectedCardTypes,
      declineReasons: selectedDeclineReasons,
      analyticsReasons: declineAnalyticsReasons,
      analyticsStages: declineAnalyticsStages,
      countrySortField: declineCountrySortKey,
      countrySortDir: declineCountrySortDir,
    }),
    [appliedSearch, firstTrialFrom, firstTrialTo, firstSubFilter, refundFilter, paymentFailedFilter, failedAttemptsFilter, campaignPathFilter, countryFilter, selectedCardTypes, selectedDeclineReasons, declineAnalyticsReasons, declineAnalyticsStages, declineCountrySortKey, declineCountrySortDir],
  );
  const {
    chUsers,
    chSummary,
    chOptions,
    chStatus,
    isBackgroundRefreshing,
    isInitialLoading,
    progressPercent,
    dataUpdatedAt,
  } = useUsersData({
    query: usersQuery,
    userScopeHash,
    warehouseVersion,
    enabled: usersServerEligible && warehouseVersionReady,
    // Filter options (incl. the dependent country list) stay live on the
    // Decline tab, where list/summary queries are not needed.
    optionsEnabled: (usersServerEligible || declineServerEligible) && warehouseVersionReady,
  });
  const {
    chDecline,
    chDeclineStatus,
    isBackgroundRefreshing: isDeclineBackgroundRefreshing,
    isInitialLoading: isDeclineInitialLoading,
    progressPercent: declineProgressPercent,
  } = useUsersDeclineData({
    query: declineQuery,
    userScopeHash,
    warehouseVersion,
    enabled: declineServerEligible && warehouseVersionReady,
  });
  // Legacy fallback (unchanged emergency path): legacy flag, a cohort selection
  // (not reproduced server-side), or a ClickHouse error WITH no cached data to
  // keep showing. A failed background refresh keeps the cached rows.
  const usersNeedLegacy =
    (!usersServerEligible && !declineServerEligible) ||
    (usersServerEligible && chStatus.error !== null && chUsers == null) ||
    (declineServerEligible && chDeclineStatus.error !== null && chDecline == null);
  const usersClickHouseDriving = usersServerEligible && chUsers != null;
  const declineClickHouseDriving = declineServerEligible && chDecline != null;
  useEffect(() => {
    traceEvent("users.legacy_state", {
      need_legacy: usersNeedLegacy,
      server_eligible: usersServerEligible,
      decline_server_eligible: declineServerEligible,
      has_clickhouse_result: chUsers != null,
      has_decline_result: chDecline != null,
      has_error: chStatus.error != null,
      has_decline_error: chDeclineStatus.error != null,
      mode,
      cohort_filter_active: hasSelectedCohortsRaw,
    });
  }, [usersNeedLegacy, usersServerEligible, declineServerEligible, chUsers, chDecline, chStatus.error, chDeclineStatus.error, mode, hasSelectedCohortsRaw]);

  // In ClickHouse mode the legacy compute + all transaction-derived memos run on
  // an EMPTY list, so the Users route performs no warehouse scan (on either
  // tab). Real transactions are only used for the legacy fallback.
  const analyticsTxs = useMemo(
    () => (usersNeedLegacy ? enrichTransactionDeclinesFromRawRows(backfillTransactionCardTypesFromRawRows(txs, rawPalmerRows), rawPalmerRows) : []),
    [usersNeedLegacy, txs, rawPalmerRows],
  );
  const declineStagesByTransaction = useMemo(() => classifyDeclineStagesForTransactions(analyticsTxs), [analyticsTxs]);
  const cohorts = useMemo(() => computeCohorts(analyticsTxs, subscriptions), [analyticsTxs, subscriptions]);
  const users: UserAggregate[] = useMemo(() => computeUsers(analyticsTxs), [analyticsTxs]);
  const cohortByUser = useMemo(() => buildCohortByUser(analyticsTxs), [analyticsTxs]);
  const cohortMembership = useMemo(() => buildCohortMembershipLookup(analyticsTxs), [analyticsTxs]);
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
  const usersAnyServerDriving = usersClickHouseDriving || declineClickHouseDriving;
  const campaignPathOptions = useMemo(
    () =>
      usersAnyServerDriving && chOptions
        ? chOptions.campaign_path
        : Array.from(new Set(usersWithCampaignPath.map((user) => user.campaign_path || "unknown"))).sort(),
    [usersAnyServerDriving, chOptions, usersWithCampaignPath]
  );
  // Country options: server mode returns the dependent list (scoped by every
  // active filter except Country) WITH unique-user counts and the Unknown
  // bucket; the legacy fallback derives codes client-side and appends Unknown
  // when uncountried users exist (counts unavailable there).
  const selectedCohortIdSet = useMemo(() => new Set(selectedCohortIds), [selectedCohortIds]);
  const selectedCohortMatchIdSet = useMemo(() => cohortSelectionMatchIds(selectedCohortIds), [selectedCohortIds]);
  const hasSelectedCohorts = selectedCohortIds.length > 0;
  const visibleCohorts = useMemo(() => {
    const q = cohortSearch.trim().toLowerCase();
    const fromDateKey = toDateKey(cohortDateFrom);
    const toDateKeyValue = toDateKey(cohortDateTo);
    const list = cohorts.filter((cohort) => {
      if (campaignPathFilter !== "all" && cohort.campaign_path !== campaignPathFilter) return false;
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
  }, [cohorts, campaignPathFilter, cohortSearch, cohortDateFrom, cohortDateTo, cohortSortKey, cohortSortDir]);

  const cohortScopedUserCount = useMemo(
    () => usersWithCampaignPath.filter((user) => userMatchesSelectedCohorts(user, selectedCohortMatchIdSet, cohortMembership)).length,
    [usersWithCampaignPath, selectedCohortMatchIdSet, cohortMembership],
  );

  // The search box is the only free-text (per-keystroke) filter here, so debounce just it: the input
  // keeps showing `search` instantly while the O(users) filter pass keys off the debounced value.
  // Every other Users filter stays synchronous because its heavy inputs (cohorts/users) are derived
  // from the dataset, not the filters — those memos do not re-run on a filter click.
  //
  // Split on the Country dimension: `filteredExceptCountry` applies every filter
  // EXCEPT Country (this scope also feeds the dependent country options, like
  // the Cohorts page country filter), and `filtered` applies Country + sort.
  const filteredExceptCountry = useMemo(() => {
    const q = appliedSearch.trim().toLowerCase();
    const fromDateKey = toDateKey(firstTrialFrom);
    const toDateKeyValue = toDateKey(firstTrialTo);
    const hasFirstTrialFilter = Boolean(fromDateKey || toDateKeyValue);
    const failedAttemptsThreshold = failedAttemptsFilter === "gte5" ? 5 : failedAttemptsFilter === "gte3" ? 3 : failedAttemptsFilter === "gte1" ? 1 : 0;
    return usersWithCampaignPath.filter((u) => {
      if (!userMatchesSelectedCohorts(u, selectedCohortMatchIdSet, cohortMembership)) return false;
      if (q && !u.email.toLowerCase().includes(q) && !u.user_id.toLowerCase().includes(q)) return false;
      if (!hasSelectedCohorts && campaignPathFilter !== "all" && u.campaign_path !== campaignPathFilter) return false;
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
  }, [usersWithCampaignPath, hasSelectedCohorts, selectedCohortMatchIdSet, cohortMembership, appliedSearch, campaignPathFilter, selectedCardTypes, paymentFailedFilter, selectedDeclineReasons, failedAttemptsFilter, firstSubFilter, refundFilter, firstTrialFrom, firstTrialTo]);

  const filtered = useMemo(() => {
    const list = filteredExceptCountry.filter((u) => {
      if (countryFilter !== "all") {
        // Unknown selects users with no attributed country (parity with server).
        if (countryFilter === UNKNOWN_COUNTRY) { if (u.country_code) return false; }
        else if (u.country_code !== countryFilter) return false;
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
  }, [filteredExceptCountry, countryFilter, sortKey, sortDir]);

  // Country options (both tabs): only countries of the CURRENTLY SCOPED users
  // (every active filter except Country — including a cohort selection), with
  // TRIAL-user counts, exactly like the Cohorts page country filter. The server
  // path returns the same shape from the dependent options action; the legacy
  // path derives it from the scoped client set.
  const countryOptions = useMemo(
    () =>
      usersAnyServerDriving && chOptions
        ? chOptions.country
        : buildLegacyCountryOptions(filteredExceptCountry),
    [usersAnyServerDriving, chOptions, filteredExceptCountry],
  );

  // Render the user table one page at a time so the DOM stays bounded for large accounts. Summary,
  // decline analytics and every total below are still computed from the full `filtered` set, so
  // pagination changes only what is rendered — never any metric.
  useEffect(() => {
    // `filtered` is memoized, so this fires only when the filter/sort set actually changes.
    setPage(1);
  }, [filtered]);
  const totalPages = Math.max(1, Math.ceil(filtered.length / USERS_PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pagedUsers = useMemo(
    () => filtered.slice((safePage - 1) * USERS_PAGE_SIZE, safePage * USERS_PAGE_SIZE),
    [filtered, safePage],
  );

  // Reset to page 1 when the filter/sort set (excluding page) changes server-side.
  const usersFilterKey = useMemo(() => JSON.stringify({ ...usersQuery, page: 0 }), [usersQuery]);
  useEffect(() => {
    if (!usersServerEligible) return;
    setPage(1);
  }, [usersFilterKey, usersServerEligible]);
  // ClickHouse drives the rendered table + pagination when active; else legacy.
  const tableRows = usersClickHouseDriving && chUsers ? chUsers.rows : pagedUsers;
  const displayTotal = usersClickHouseDriving && chUsers ? chUsers.total : filtered.length;
  const displayTotalPages = usersClickHouseDriving && chUsers ? chUsers.totalPages : totalPages;
  const displaySafePage = usersClickHouseDriving && chUsers ? Math.min(page, displayTotalPages) : safePage;
  useEffect(() => {
    if (firstRowsRef.current || tableRows.length === 0) return;
    firstRowsRef.current = true;
    traceMark("users.first_table_row_rendered", {
      row_count: tableRows.length,
      source: usersClickHouseDriving ? "clickhouse" : "legacy",
      cached_or_network: chUsers != null && isBackgroundRefreshing ? "cached_refreshing" : chUsers != null ? "query_data" : "legacy",
    });
    traceMeasure("users.time_to_first_row", "route.users.mounted", "users.first_table_row_rendered", { row_count: tableRows.length });
  }, [tableRows.length, usersClickHouseDriving, chUsers, isBackgroundRefreshing]);

  const summary = useMemo(() => {
    // ClickHouse mode: summary cards come from the server (over the full filtered
    // set, not just the rendered page) — no browser transaction scan.
    if (usersClickHouseDriving && chSummary) {
      return {
        users: chSummary.total_users,
        trial_users: chSummary.trial_users,
        upsell_users: chSummary.upsell_users,
        first_sub_users: chSummary.first_subscription_users,
        active_subscriptions: chSummary.active_subscription_users,
        cancelled_users: chSummary.cancelled_users,
        refund_users: chSummary.refund_users,
        gross_revenue: chSummary.gross_revenue_usd,
        net_revenue: chSummary.net_revenue_usd,
        failed_payment_users: chSummary.failed_payment_users,
      };
    }
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
  }, [usersClickHouseDriving, chSummary, filtered, analyticsTxs]);

  // Server-side Decline Analytics: map the ClickHouse bundle onto the exact
  // view-model the tab renders. The reason-table sort still runs over the FULL
  // reason set (bounded by the reason taxonomy, returned entirely by the
  // server) with the same comparator as the legacy path.
  const declineServerAnalytics = useMemo(() => {
    if (!declineClickHouseDriving || !chDecline) return null;
    const rows: DeclineBreakdownRow[] = chDecline.reason_rows.map((row) => ({
      reason: row.reason as DeclineReason,
      failed_users: row.failed_users,
      failed_transactions: row.failed_transactions,
      share: row.share * 100,
      avg_attempts: row.avg_attempts,
      latest_failed_date: row.latest_failed_date,
      stage_counts: { ...createDeclineStageCounts(), ...row.stage_counts },
      top_stage: row.top_stage as DeclineStage,
      // ?? [] guards cached bundles produced before the drill-down existed.
      messages: (row.messages ?? []).map((m) => ({ ...m, share: m.share * 100 })),
    }));
    rows.sort((a, b) => {
      const av = a[declineSortKey];
      const bv = b[declineSortKey];
      const cmp = av == null && bv == null ? 0 : av == null ? 1 : bv == null ? -1 : av < bv ? -1 : av > bv ? 1 : 0;
      return declineSortDir === "asc" ? cmp : -cmp;
    });
    const stageRows: DeclineStageBreakdownRow[] = chDecline.stage_rows.map((row) => ({
      stage: row.stage as DeclineStage,
      failed_users: row.failed_users,
      failed_transactions: row.failed_transactions,
      share: row.share * 100,
      top_reason: (row.top_reason as DeclineReason | null) ?? null,
    }));
    return {
      selectedUsers: chDecline.totals.selected_users,
      failedUsers: chDecline.totals.failed_users,
      failedTransactions: chDecline.totals.failed_transactions,
      // ?? 0 guards cached bundles produced before these totals existed.
      successfulTransactions: chDecline.totals.successful_transactions ?? 0,
      totalTransactions: chDecline.totals.total_transactions ?? 0,
      declineRate: (chDecline.totals.decline_rate ?? 0) * 100,
      topReason: (chDecline.totals.top_reason as DeclineReason | null) ?? null,
      avgAttempts: chDecline.totals.avg_attempts ?? 0,
      rows,
      stageRows,
      stageTotals: { ...createDeclineStageCounts(), ...chDecline.totals.stage_totals },
    };
  }, [declineClickHouseDriving, chDecline, declineSortKey, declineSortDir]);

  const legacyDeclineAnalytics = useMemo(() => {
    const selectedUserIds = new Set(filtered.map((user) => user.user_id));
    const selectedEmails = new Set(filtered.map((user) => emailKey(user.email)).filter(Boolean));
    const selectedReasonSet = new Set(declineAnalyticsReasons);
    const selectedStageSet = new Set(declineAnalyticsStages);
    const byReason = new Map<DeclineReason, { users: Set<string>; transactions: number; latest: string | null; stageCounts: Record<DeclineStage, number>; messages: Map<string, { users: Set<string>; transactions: number }> }>();
    const byStage = new Map<DeclineStage, { users: Set<string>; transactions: number; reasons: Map<DeclineReason, number> }>();
    const failedUsers = new Set<string>();
    const stageTotals = createDeclineStageCounts();
    let failedTransactions = 0;
    // Share-of-all denominator: successful + ALL failed transactions of the
    // scoped users; the reason/stage display filters never narrow it.
    let successfulTransactions = 0;
    let failedTransactionsAll = 0;

    if (!filtered.length) {
      return {
        selectedUsers: 0,
        failedUsers: 0,
        failedTransactions: 0,
        successfulTransactions: 0,
        totalTransactions: 0,
        declineRate: 0,
        topReason: null as DeclineReason | null,
        avgAttempts: 0,
        rows: [] as DeclineBreakdownRow[],
        stageRows: [] as DeclineStageBreakdownRow[],
        stageTotals,
      };
    }

    for (const tx of analyticsTxs) {
      const userMatches = selectedUserIds.has(tx.user_id) || selectedEmails.has(emailKey(tx.email));
      if (!userMatches) continue;
      if (tx.status === "success") successfulTransactions += 1;
      if (!isFailedPaymentTransaction(tx)) continue;
      failedTransactionsAll += 1;
      const details = declineDetailsForTransaction(tx);
      const reason = details?.reason ?? "unknown";
      const stage = declineStagesByTransaction.get(tx.transaction_id) ?? tx.normalized_decline_stage ?? "unknown";
      if (selectedReasonSet.size > 0 && !selectedReasonSet.has(reason)) continue;
      if (selectedStageSet.size > 0 && !selectedStageSet.has(stage)) continue;
      const userKey = tx.user_id || emailKey(tx.email);
      failedUsers.add(userKey);
      failedTransactions += 1;
      stageTotals[stage] += 1;

      const row = byReason.get(reason) ?? { users: new Set<string>(), transactions: 0, latest: null, stageCounts: createDeclineStageCounts(), messages: new Map<string, { users: Set<string>; transactions: number }>() };
      row.users.add(userKey);
      row.transactions += 1;
      row.stageCounts[stage] += 1;
      const eventTime = details?.date ?? tx.event_time;
      if (!row.latest || eventTime > row.latest) row.latest = eventTime;
      const messageLabel = declineBreakdownMessageForTransaction(tx);
      const messageRow = row.messages.get(messageLabel) ?? { users: new Set<string>(), transactions: 0 };
      messageRow.users.add(userKey);
      messageRow.transactions += 1;
      row.messages.set(messageLabel, messageRow);
      byReason.set(reason, row);

      const stageRow = byStage.get(stage) ?? { users: new Set<string>(), transactions: 0, reasons: new Map<DeclineReason, number>() };
      stageRow.users.add(userKey);
      stageRow.transactions += 1;
      stageRow.reasons.set(reason, (stageRow.reasons.get(reason) ?? 0) + 1);
      byStage.set(stage, stageRow);
    }

    const rows = Array.from(byReason.entries()).map(([reason, row]) => ({
      reason,
      failed_users: row.users.size,
      failed_transactions: row.transactions,
      share: failedTransactions ? (row.transactions / failedTransactions) * 100 : 0,
      avg_attempts: row.users.size ? row.transactions / row.users.size : 0,
      latest_failed_date: row.latest,
      stage_counts: row.stageCounts,
      top_stage: topStageFromCounts(row.stageCounts),
      messages: Array.from(row.messages.entries())
        .map(([message, m]) => ({
          message,
          failed_users: m.users.size,
          failed_transactions: m.transactions,
          share: row.transactions ? (m.transactions / row.transactions) * 100 : 0,
        }))
        .sort((a, b) => b.failed_transactions - a.failed_transactions || a.message.localeCompare(b.message)),
    }));

    const stageRows = DECLINE_STAGE_VALUES
      .map((stage) => {
        const row = byStage.get(stage);
        const topReason = row
          ? Array.from(row.reasons.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null
          : null;
        return {
          stage,
          failed_users: row?.users.size ?? 0,
          failed_transactions: row?.transactions ?? 0,
          share: failedTransactions && row ? (row.transactions / failedTransactions) * 100 : 0,
          top_reason: topReason,
        };
      })
      .filter((row) => row.failed_transactions > 0);

    rows.sort((a, b) => {
      const av = a[declineSortKey];
      const bv = b[declineSortKey];
      const cmp = av == null && bv == null ? 0 : av == null ? 1 : bv == null ? -1 : av < bv ? -1 : av > bv ? 1 : 0;
      return declineSortDir === "asc" ? cmp : -cmp;
    });

    const topReason = [...rows].sort((a, b) => b.failed_transactions - a.failed_transactions || a.reason.localeCompare(b.reason))[0]?.reason ?? null;

    return {
      selectedUsers: filtered.length,
      failedUsers: failedUsers.size,
      failedTransactions,
      successfulTransactions,
      totalTransactions: successfulTransactions + failedTransactionsAll,
      declineRate: filtered.length ? (failedUsers.size / filtered.length) * 100 : 0,
      topReason,
      avgAttempts: failedUsers.size ? failedTransactions / failedUsers.size : 0,
      rows,
      stageRows,
      stageTotals,
    };
  }, [filtered, analyticsTxs, declineAnalyticsReasons, declineAnalyticsStages, declineStagesByTransaction, declineSortKey, declineSortDir]);
  // ClickHouse drives the Decline tab when available; legacy remains the
  // unchanged fallback (cohort selections, legacy flag, or a server error).
  const declineAnalytics = declineServerAnalytics ?? legacyDeclineAnalytics;

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
  const declineAnalyticsReasonSummary = declineAnalyticsReasons.length ? declineAnalyticsReasons.join(", ") : "All reasons";
  const declineAnalyticsStageSummary = declineAnalyticsStages.length ? declineAnalyticsStages.map(declineStageLabel).join(", ") : "All stages";
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
  const toggleDeclineAnalyticsReason = (reason: DeclineReason) => {
    const next = declineAnalyticsReasons.includes(reason)
      ? declineAnalyticsReasons.filter((value) => value !== reason)
      : [...declineAnalyticsReasons, reason];
    updateUiState({ declineAnalyticsReasons: next });
  };
  const clearDeclineAnalyticsReasons = () => updateUiState({ declineAnalyticsReasons: [] });
  const toggleDeclineAnalyticsStage = (stage: DeclineStage) => {
    const next = declineAnalyticsStages.includes(stage)
      ? declineAnalyticsStages.filter((value) => value !== stage)
      : [...declineAnalyticsStages, stage];
    updateUiState({ declineAnalyticsStages: next });
  };
  const clearDeclineAnalyticsStages = () => updateUiState({ declineAnalyticsStages: [] });
  const toggleDeclineSort = (key: DeclineSortKey) => {
    if (declineSortKey === key) updateUiState({ declineSortDir: declineSortDir === "asc" ? "desc" : "asc" });
    else updateUiState({ declineSortKey: key, declineSortDir: key === "reason" ? "asc" : "desc" });
  };
  const declineIcon = (key: DeclineSortKey) =>
    declineSortKey !== key ? <ArrowUpDown className="h-3 w-3 opacity-40" /> :
    declineSortDir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />;
  // Country breakdown sort is SERVER-side: changing it changes the decline
  // bundle query key; the Edge Function sorts the full country set.
  const toggleDeclineCountrySort = (key: DeclineCountrySortKey) => {
    if (declineCountrySortKey === key) updateUiState({ declineCountrySortDir: declineCountrySortDir === "asc" ? "desc" : "asc" });
    else updateUiState({ declineCountrySortKey: key, declineCountrySortDir: key === "country" ? "asc" : "desc" });
  };
  const declineCountryIcon = (key: DeclineCountrySortKey) =>
    declineCountrySortKey !== key ? <ArrowUpDown className="h-3 w-3 opacity-40" /> :
    declineCountrySortDir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />;
  // Rates are fractions (0..1) or null when the denominator is 0 — never NaN.
  const formatRate = (value: number | null) => (value == null ? "—" : formatPct(value * 100));
  const toggleCohortSelection = (cohortId: string) => {
    const next = selectedCohortIds.includes(cohortId)
      ? selectedCohortIds.filter((value) => value !== cohortId)
      : [...selectedCohortIds, cohortId];
    updateUiState({ selectedCohortIds: next });
  };
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
  // Share-of-all denominator + success counter for the decline section.
  const declineSuccessShare = declineAnalytics.totalTransactions
    ? (declineAnalytics.successfulTransactions / declineAnalytics.totalTransactions) * 100
    : 0;
  const declineShareOfAll = (failedTransactions: number) =>
    declineAnalytics.totalTransactions ? (failedTransactions / declineAnalytics.totalTransactions) * 100 : 0;
  const declineSummaryCards = [
    { label: "Failed Users", value: String(declineAnalytics.failedUsers) },
    { label: "Failed Transactions", value: String(declineAnalytics.failedTransactions) },
    { label: "Total Transactions", value: String(declineAnalytics.totalTransactions) },
    { label: "Successful Transactions", value: `${declineAnalytics.successfulTransactions} · ${formatPct(declineSuccessShare)}` },
    { label: "Decline Rate", value: formatPct(declineAnalytics.declineRate) },
    { label: "Top Decline Reason", value: declineAnalytics.topReason ?? "—" },
    { label: "Avg Failed Attempts", value: declineAnalytics.avgAttempts.toFixed(2) },
    { label: "Declines After Trial", value: String(declineAnalytics.stageTotals.after_trial) },
    { label: "Declines After First Sub", value: String(declineAnalytics.stageTotals.after_first_subscription) },
    { label: "Declines After Renewal", value: String(declineAnalytics.stageTotals.after_renewal) },
  ];
  const maxDeclineReasonTransactions = Math.max(1, ...declineAnalytics.rows.map((row) => row.failed_transactions));
  const activeUserFilterLabels = [
    search.trim() ? `Search: ${search.trim()}` : null,
    selectedCohortIdSet.size === 0 && campaignPathFilter !== "all" ? `Campaign: ${campaignPathFilter}` : null,
    countryFilter !== "all" ? `Country: ${countryFilter}` : null,
    selectedCardTypes.length ? `Card Type: ${selectedCardTypes.map(cardTypeLabel).join(", ")}` : null,
    paymentFailedFilter !== "all" ? `Payment Failed: ${paymentFailedFilter === "has" ? "Has failed payments" : "No failed payments"}` : null,
    selectedDeclineReasons.length ? `Decline Reason: ${selectedDeclineReasons.join(", ")}` : null,
    failedAttemptsFilter !== "all" ? `Failed Attempts: ${failedAttemptsFilter.replace("gte", ">= ")}` : null,
    firstSubFilter !== "all" ? `First sub: ${firstSubFilter === "has" ? "Has First Sub" : "No First Sub"}` : null,
    refundFilter !== "all" ? `Refund: ${refundFilter === "has" ? "Has refund" : "No refund"}` : null,
    firstTrialFrom ? `First trial from: ${formatDateKey(firstTrialFrom)}` : null,
    firstTrialTo ? `First trial to: ${formatDateKey(firstTrialTo)}` : null,
    declineAnalyticsReasons.length ? `Analytics Decline Reason: ${declineAnalyticsReasons.join(", ")}` : null,
    declineAnalyticsStages.length ? `Analytics Decline Stage: ${declineAnalyticsStages.map(declineStageLabel).join(", ")}` : null,
  ].filter((label): label is string => Boolean(label));
  const clearUserFilters = () => updateUiState({
    search: "",
    countryFilter: "all",
    selectedCardTypes: [],
    paymentFailedFilter: "all",
    selectedDeclineReasons: [],
    failedAttemptsFilter: "all",
    firstSubFilter: "all",
    refundFilter: "all",
    firstTrialFrom: "",
    firstTrialTo: "",
    declineAnalyticsReasons: [],
    declineAnalyticsStages: [],
  });

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
            <Select value={campaignPathFilter} onValueChange={(value) => updateUiState({ campaignPathFilter: value })}>
              <SelectTrigger className="h-9 w-full"><SelectValue placeholder="Campaign path" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All campaign paths</SelectItem>
                {campaignPathOptions.map((path) => (
                  <SelectItem key={path} value={path}>{path}</SelectItem>
                ))}
              </SelectContent>
            </Select>
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
                    onClick={() => toggleCohortSelection(cohort.cohort_id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        toggleCohortSelection(cohort.cohort_id);
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
        <Tabs value={mode} onValueChange={(value) => updateUiState({ mode: value as UsersPageMode })}>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <TabsList>
              <TabsTrigger value="users_table">Users Table</TabsTrigger>
              <TabsTrigger value="decline_analytics">Decline Analytics</TabsTrigger>
            </TabsList>
            <div className="text-xs text-muted-foreground">
              {selectedCohortIds.length ? `${selectedCohortIds.length} cohort${selectedCohortIds.length === 1 ? "" : "s"} selected` : "All visible users"}
            </div>
          </div>

          <TabsContent value="users_table" className="mt-0">
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
          <Select value={countryFilter} onValueChange={(value) => updateUiState({ countryFilter: value })}>
            <SelectTrigger className="h-9 w-[170px]"><SelectValue placeholder="Country" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All countries</SelectItem>
              {countryOptions.map((option) => (
                <SelectItem key={option.country_code} value={option.country_code}>
                  {option.country_code}
                  {option.user_count > 0 ? ` · ${option.user_count}` : ""}
                </SelectItem>
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
          <Button type="button" variant="ghost" size="sm" onClick={clearUserFilters}>
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

        {usersSource === "clickhouse" && (
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-border bg-muted/20 px-3 py-2 text-xs">
            <span className="font-medium text-foreground">Users data source</span>
            <span>
              engine:{" "}
              <span className="font-mono text-foreground">{usersClickHouseDriving ? "clickhouse" : "legacy (fallback)"}</span>
            </span>
            {/* Honest staged progress (estimated; no server row-level progress). */}
            {isInitialLoading && (
              <span className="flex items-center gap-2 text-muted-foreground">
                Loading users… {progressPercent}%
                <Progress value={progressPercent} className="h-1.5 w-24" />
              </span>
            )}
            {isBackgroundRefreshing && (
              <span className="flex items-center gap-2 text-muted-foreground">
                Updating… {progressPercent}%
                <Progress value={progressPercent} className="h-1.5 w-24" />
              </span>
            )}
            {!isInitialLoading && !isBackgroundRefreshing && chStatus.error && chUsers != null && (
              <span className="text-warning">refresh failed · showing cached data</span>
            )}
            {!isInitialLoading && !isBackgroundRefreshing && usersClickHouseDriving && chUsers?.durationMs != null && !chStatus.error && (
              <span>ClickHouse {chUsers.durationMs} ms{dataUpdatedAt ? ` · updated ${formatUpdatedAgo(dataUpdatedAt)}` : ""}</span>
            )}
            <span>total users: <span className="font-mono text-foreground">{displayTotal.toLocaleString("en-US")}</span></span>
            {chUsers?.subscriptionDataStatus && (
              <span>subscriptions: <span className="font-mono text-foreground">{chUsers.subscriptionDataStatus}</span></span>
            )}
            {chStatus.error && chUsers == null && <span className="text-destructive">ClickHouse error — using legacy: {chStatus.error}</span>}
            {!usersClickHouseDriving && !chStatus.error && hasSelectedCohortsRaw && (
              <span className="text-warning">cohort selection uses the client dataset</span>
            )}
          </div>
        )}

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
                <TableHead>
                  <button onClick={() => toggleSort("latest_decline_stage")} className="inline-flex items-center gap-1 hover:text-foreground">
                    Decline Stage {icon("latest_decline_stage")}
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
              {tableRows.map((u) => (
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
                  <TableCell className="text-xs">
                    {u.latest_decline_stage ? (
                      <span className={cn("inline-flex items-center rounded-md px-2 py-0.5 font-medium", declineStageBadgeClass(u.latest_decline_stage))}>
                        {declineStageLabel(u.latest_decline_stage)}
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
              {/* Initial load (no cached rows yet): progress row, never the empty-state. */}
              {isInitialLoading && tableRows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={19} className="py-10">
                    <div className="flex flex-col items-center gap-3 text-muted-foreground">
                      <Progress value={progressPercent} className="h-2 w-full max-w-xs" />
                      <span className="text-sm">Loading users… {progressPercent}%</span>
                    </div>
                  </TableCell>
                </TableRow>
              )}
              {tableRows.length === 0 && !isInitialLoading && (
                <TableRow>
                  <TableCell colSpan={19} className="text-center text-sm text-muted-foreground py-10">
                    <div className="space-y-3">
                      <div>{selectedCohortIds.length ? "No users match selected cohorts and filters." : "No users match your filters."}</div>
                      {activeUserFilterLabels.length > 0 && (
                        <div className="mx-auto max-w-2xl text-xs">
                          Active filters: {activeUserFilterLabels.join("; ")}
                        </div>
                      )}
                      {activeUserFilterLabels.length > 0 && (
                        <Button type="button" variant="outline" size="sm" onClick={clearUserFilters}>
                          Reset user filters
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        {displayTotal > USERS_PAGE_SIZE && (
          <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
            <span>
              Showing {(displaySafePage - 1) * USERS_PAGE_SIZE + 1}–{Math.min(displaySafePage * USERS_PAGE_SIZE, displayTotal)} of {displayTotal}
            </span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={displaySafePage <= 1} onClick={() => setPage(displaySafePage - 1)}>
                Previous
              </Button>
              <Button variant="outline" size="sm" disabled={displaySafePage >= displayTotalPages} onClick={() => setPage(displaySafePage + 1)}>
                Next
              </Button>
            </div>
          </div>
        )}
          </TabsContent>

          <TabsContent value="decline_analytics" className="mt-0 space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <Popover>
                <PopoverTrigger asChild>
                  <Button type="button" variant="outline" size="sm" className="h-9 max-w-[300px] justify-between gap-2">
                    <span className="text-xs text-muted-foreground">Decline Reason</span>
                    <span className="truncate">{declineAnalyticsReasonSummary}</span>
                    <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-72 p-0">
                  <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
                    <div className="text-xs font-medium text-muted-foreground">Decline Reason</div>
                    <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={clearDeclineAnalyticsReasons} disabled={!declineAnalyticsReasons.length}>
                      All reasons
                    </Button>
                  </div>
                  <div className="max-h-72 overflow-y-auto py-1">
                    {DECLINE_REASON_VALUES.map((reason) => (
                      <label key={reason} className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-muted/50">
                        <Checkbox
                          checked={declineAnalyticsReasons.includes(reason)}
                          onCheckedChange={() => toggleDeclineAnalyticsReason(reason)}
                        />
                        <span>{reason}</span>
                      </label>
                    ))}
                  </div>
                </PopoverContent>
              </Popover>
              <Popover>
                <PopoverTrigger asChild>
                  <Button type="button" variant="outline" size="sm" className="h-9 max-w-[320px] justify-between gap-2">
                    <span className="text-xs text-muted-foreground">Decline Stage</span>
                    <span className="truncate">{declineAnalyticsStageSummary}</span>
                    <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-72 p-0">
                  <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
                    <div className="text-xs font-medium text-muted-foreground">Decline Stage</div>
                    <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={clearDeclineAnalyticsStages} disabled={!declineAnalyticsStages.length}>
                      All stages
                    </Button>
                  </div>
                  <div className="py-1">
                    {DECLINE_STAGE_VALUES.map((stage) => (
                      <label key={stage} className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-muted/50">
                        <Checkbox
                          checked={declineAnalyticsStages.includes(stage)}
                          onCheckedChange={() => toggleDeclineAnalyticsStage(stage)}
                        />
                        <span>{declineStageLabel(stage)}</span>
                      </label>
                    ))}
                  </div>
                </PopoverContent>
              </Popover>
              {/* Same shared Country filter as the Users Table (one user-level
                  country attribution scopes both sections). */}
              <Select value={countryFilter} onValueChange={(value) => updateUiState({ countryFilter: value })}>
                <SelectTrigger className="h-9 w-[170px]"><SelectValue placeholder="Country" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All countries</SelectItem>
                  {countryOptions.map((option) => (
                    <SelectItem key={option.country_code} value={option.country_code}>
                      {option.country_code}
                      {option.user_count > 0 ? ` · ${option.user_count}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {usersSource === "clickhouse" && (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-border bg-muted/20 px-3 py-2 text-xs">
                <span className="font-medium text-foreground">Decline data source</span>
                <span>
                  engine:{" "}
                  <span className="font-mono text-foreground">{declineClickHouseDriving ? "clickhouse" : "legacy (fallback)"}</span>
                </span>
                {isDeclineInitialLoading && (
                  <span className="flex items-center gap-2 text-muted-foreground">
                    Loading decline analytics… {declineProgressPercent}%
                    <Progress value={declineProgressPercent} className="h-1.5 w-24" />
                  </span>
                )}
                {isDeclineBackgroundRefreshing && (
                  <span className="flex items-center gap-2 text-muted-foreground">
                    Updating… {declineProgressPercent}%
                    <Progress value={declineProgressPercent} className="h-1.5 w-24" />
                  </span>
                )}
                {!isDeclineInitialLoading && !isDeclineBackgroundRefreshing && chDeclineStatus.error && chDecline != null && (
                  <span className="text-warning">refresh failed · showing cached data</span>
                )}
                {!isDeclineInitialLoading && !isDeclineBackgroundRefreshing && declineClickHouseDriving && chDecline && !chDeclineStatus.error && (
                  <span>ClickHouse {chDecline.query_duration_ms} ms</span>
                )}
                {declineClickHouseDriving && chDecline && (
                  <span>
                    users with country: <span className="font-mono text-foreground">{chDecline.diagnostics.users_with_country.toLocaleString("en-US")}</span>
                    {" · "}unknown: <span className="font-mono text-foreground">{chDecline.diagnostics.users_without_country.toLocaleString("en-US")}</span>
                    {" · "}countries: <span className="font-mono text-foreground">{chDecline.diagnostics.unique_countries.toLocaleString("en-US")}</span>
                  </span>
                )}
                {chDeclineStatus.error && chDecline == null && (
                  <span className="text-destructive">ClickHouse error — using legacy: {chDeclineStatus.error}</span>
                )}
                {!declineClickHouseDriving && !chDeclineStatus.error && hasSelectedCohortsRaw && (
                  <span className="text-warning">cohort selection uses the client dataset</span>
                )}
              </div>
            )}

            {declineServerEligible && isDeclineInitialLoading && chDecline == null ? (
              <div className="rounded-md border border-dashed border-border px-4 py-10">
                <div className="flex flex-col items-center gap-3 text-muted-foreground">
                  <Progress value={declineProgressPercent} className="h-2 w-full max-w-xs" />
                  <span className="text-sm">Loading decline analytics… {declineProgressPercent}%</span>
                </div>
              </div>
            ) : declineAnalytics.selectedUsers === 0 ? (
              <div className="rounded-md border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
                <div className="space-y-3">
                  <div>
                    {selectedCohortIds.length && cohortScopedUserCount > 0
                      ? "No users match selected cohorts and filters."
                      : "No users selected."}
                  </div>
                  {activeUserFilterLabels.length > 0 && (
                    <div className="mx-auto max-w-2xl text-xs">
                      Active filters: {activeUserFilterLabels.join("; ")}
                    </div>
                  )}
                  {activeUserFilterLabels.length > 0 && (
                    <Button type="button" variant="outline" size="sm" onClick={clearUserFilters}>
                      Reset user filters
                    </Button>
                  )}
                </div>
              </div>
            ) : declineAnalytics.failedTransactions === 0 ? (
              <div className="rounded-md border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
                No declined payments found for selected users.
              </div>
            ) : (
              <>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                  {declineSummaryCards.map((card) => (
                    <div key={card.label} className="rounded-md border border-border bg-muted/20 px-3 py-2">
                      <div className="text-xs text-muted-foreground">{card.label}</div>
                      <div className="mt-1 truncate text-sm font-semibold tabular-nums">{card.value}</div>
                    </div>
                  ))}
                </div>

                <div className="rounded-lg border border-border p-4">
                  <div className="mb-3 text-sm font-medium">Decline reasons by stage</div>
                  <div className="space-y-3">
                    {declineAnalytics.rows.slice(0, 8).map((row) => (
                      <div key={row.reason} className="grid grid-cols-[minmax(150px,240px)_1fr_auto] items-center gap-3 text-sm">
                        <span className="truncate text-xs text-muted-foreground">{row.reason}</span>
                        <div
                          className="h-2 overflow-hidden rounded-full bg-muted"
                          aria-label={`${row.reason} decline stages`}
                          title={`${row.reason}: ${row.failed_transactions} failed transactions`}
                        >
                          <div
                            aria-label={`${row.reason} total decline volume`}
                            className="flex h-full overflow-hidden rounded-full"
                            style={{ width: `${(row.failed_transactions / maxDeclineReasonTransactions) * 100}%` }}
                          >
                            {DECLINE_STAGE_VALUES.map((stage) => {
                              const count = row.stage_counts[stage];
                              if (!count) return null;
                              return (
                                <div
                                  key={stage}
                                  className={declineStageBarClass(stage)}
                                  title={`${declineStageLabel(stage)}: ${count}`}
                                  style={{ width: `${(count / row.failed_transactions) * 100}%` }}
                                />
                              );
                            })}
                          </div>
                        </div>
                        <span className="text-xs font-medium tabular-nums">{row.failed_transactions}</span>
                      </div>
                    ))}
                  </div>
                  <div className="mt-3 flex flex-wrap gap-3 text-xs text-muted-foreground">
                    {DECLINE_STAGE_VALUES.map((stage) => (
                      <span key={stage} className="inline-flex items-center gap-1">
                        <span className={cn("h-2 w-2 rounded-full", declineStageBarClass(stage))} />
                        {declineStageLabel(stage)}
                      </span>
                    ))}
                  </div>
                </div>

                <div className="overflow-x-auto rounded-lg border border-border">
                  <Table aria-label="Decline stage breakdown">
                    <TableHeader>
                      <TableRow>
                        <TableHead>Decline Stage</TableHead>
                        <TableHead className="text-right">Failed Users</TableHead>
                        <TableHead className="text-right">Failed Transactions</TableHead>
                        <TableHead className="text-right">Share</TableHead>
                        <TableHead>Top Decline Reason</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {declineAnalytics.stageRows.map((row) => (
                        <TableRow key={row.stage}>
                          <TableCell>
                            <span className={cn("inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium", declineStageBadgeClass(row.stage))}>
                              {declineStageLabel(row.stage)}
                            </span>
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{row.failed_users}</TableCell>
                          <TableCell className="text-right tabular-nums">{row.failed_transactions}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatPct(row.share)}</TableCell>
                          <TableCell className="text-xs text-muted-foreground">{row.top_reason ?? "—"}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>

                <div className="overflow-x-auto rounded-lg border border-border">
                  <Table aria-label="Decline reason breakdown">
                    <TableHeader>
                      <TableRow>
                        <TableHead>
                          <button onClick={() => toggleDeclineSort("reason")} className="inline-flex items-center gap-1 hover:text-foreground">
                            Decline Reason {declineIcon("reason")}
                          </button>
                        </TableHead>
                        <TableHead className="text-right">
                          <button onClick={() => toggleDeclineSort("failed_users")} className="inline-flex items-center gap-1 hover:text-foreground">
                            Failed Users {declineIcon("failed_users")}
                          </button>
                        </TableHead>
                        <TableHead className="text-right">
                          <button onClick={() => toggleDeclineSort("failed_transactions")} className="inline-flex items-center gap-1 hover:text-foreground">
                            Failed Transactions {declineIcon("failed_transactions")}
                          </button>
                        </TableHead>
                        <TableHead className="text-right">
                          <button onClick={() => toggleDeclineSort("share")} className="inline-flex items-center gap-1 hover:text-foreground">
                            Share of All Tx {declineIcon("share")}
                          </button>
                        </TableHead>
                        <TableHead className="text-right">
                          <button onClick={() => toggleDeclineSort("avg_attempts")} className="inline-flex items-center gap-1 hover:text-foreground">
                            Avg Attempts {declineIcon("avg_attempts")}
                          </button>
                        </TableHead>
                        <TableHead>Decline Stage</TableHead>
                        <TableHead>
                          <button onClick={() => toggleDeclineSort("latest_failed_date")} className="inline-flex items-center gap-1 hover:text-foreground">
                            Latest Failed Date {declineIcon("latest_failed_date")}
                          </button>
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {declineAnalytics.rows.map((row) => {
                        const expanded = expandedDeclineReasons.includes(row.reason);
                        return (
                          <Fragment key={row.reason}>
                            <TableRow>
                              <TableCell>
                                {/* Click the reason to drill into the raw processor
                                    messages behind it (e.g. fraud_suspected →
                                    "Suspected fraud" / "Fraud/Security" / …). */}
                                <button
                                  type="button"
                                  onClick={() => toggleDeclineReasonExpanded(row.reason)}
                                  aria-expanded={expanded}
                                  aria-label={`Toggle ${row.reason} message breakdown`}
                                  className="inline-flex items-center gap-1 hover:opacity-80"
                                >
                                  <ChevronDown className={cn("h-3.5 w-3.5 text-muted-foreground transition-transform", !expanded && "-rotate-90")} />
                                  <span className={cn("inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium", declineReasonBadgeClass(row.reason))}>
                                    {row.reason}
                                  </span>
                                </button>
                              </TableCell>
                              <TableCell className="text-right tabular-nums">{row.failed_users}</TableCell>
                              <TableCell className="text-right tabular-nums">{row.failed_transactions}</TableCell>
                              {/* % of ALL scoped transactions (successful + failed), not of
                                  failed only. Sorting still keys off row.share — the ordering
                                  is identical (same numerator, constant denominator). */}
                              <TableCell className="text-right tabular-nums">{formatPct(declineShareOfAll(row.failed_transactions))}</TableCell>
                              <TableCell className="text-right tabular-nums">{row.avg_attempts.toFixed(2)}</TableCell>
                              <TableCell>
                                <div className="flex flex-wrap gap-1">
                                  {DECLINE_STAGE_VALUES.filter((stage) => row.stage_counts[stage] > 0).map((stage) => (
                                    <span key={stage} className={cn("inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium", declineStageBadgeClass(stage))}>
                                      {declineStageLabel(stage)} · {row.stage_counts[stage]}
                                    </span>
                                  ))}
                                </div>
                              </TableCell>
                              <TableCell className="text-xs text-muted-foreground tabular-nums">
                                {row.latest_failed_date ? formatDateKey(row.latest_failed_date) : "—"}
                              </TableCell>
                            </TableRow>
                            {expanded && (
                              <TableRow className="bg-muted/20 hover:bg-muted/20">
                                <TableCell colSpan={7} className="py-2">
                                  {row.messages.length === 0 ? (
                                    <div className="px-6 text-xs text-muted-foreground">No raw decline message data for this reason.</div>
                                  ) : (
                                    <div className="space-y-1 px-6" aria-label={`${row.reason} message breakdown`}>
                                      <div className="grid grid-cols-[minmax(220px,1fr)_100px_140px_80px] gap-2 text-[11px] uppercase tracking-wide text-muted-foreground">
                                        <span>Raw Message</span>
                                        <span className="text-right">Failed Users</span>
                                        <span className="text-right">Failed Transactions</span>
                                        <span className="text-right">Share</span>
                                      </div>
                                      {row.messages.map((messageRow) => (
                                        <div key={messageRow.message} className="grid grid-cols-[minmax(220px,1fr)_100px_140px_80px] gap-2 text-xs">
                                          <span className="truncate" title={messageRow.message}>{messageRow.message}</span>
                                          <span className="text-right tabular-nums">{messageRow.failed_users}</span>
                                          <span className="text-right tabular-nums">{messageRow.failed_transactions}</span>
                                          <span className="text-right tabular-nums">{formatPct(messageRow.share)}</span>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </TableCell>
                              </TableRow>
                            )}
                          </Fragment>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              </>
            )}

            {/* Decline Analytics by Country: server-computed over the user-level
                authoritative country (same attribution as the User Table).
                Sorting is server-side over the full country set; Unknown is
                always last on country sorts. Rendered whenever the ClickHouse
                bundle drives the tab — pass rates are meaningful even when the
                current scope has zero failed transactions. */}
            {declineClickHouseDriving && chDecline && declineAnalytics.selectedUsers > 0 && (
              <div className="overflow-x-auto rounded-lg border border-border">
                <Table aria-label="Decline analytics by country">
                  <TableHeader>
                    <TableRow>
                      <TableHead>
                        <button onClick={() => toggleDeclineCountrySort("country")} className="inline-flex items-center gap-1 hover:text-foreground">
                          Country {declineCountryIcon("country")}
                        </button>
                      </TableHead>
                      <TableHead className="text-right">
                        <button onClick={() => toggleDeclineCountrySort("total_attempts")} className="inline-flex items-center gap-1 hover:text-foreground">
                          Total Attempts {declineCountryIcon("total_attempts")}
                        </button>
                      </TableHead>
                      <TableHead className="text-right">
                        <button onClick={() => toggleDeclineCountrySort("successful")} className="inline-flex items-center gap-1 hover:text-foreground">
                          Successful {declineCountryIcon("successful")}
                        </button>
                      </TableHead>
                      <TableHead className="text-right">
                        <button onClick={() => toggleDeclineCountrySort("failed")} className="inline-flex items-center gap-1 hover:text-foreground">
                          Failed {declineCountryIcon("failed")}
                        </button>
                      </TableHead>
                      <TableHead className="text-right">
                        <button onClick={() => toggleDeclineCountrySort("pass_rate")} className="inline-flex items-center gap-1 hover:text-foreground">
                          Overall Pass Rate {declineCountryIcon("pass_rate")}
                        </button>
                      </TableHead>
                      <TableHead className="text-right">
                        <button onClick={() => toggleDeclineCountrySort("pass_rate_ex_if")} className="inline-flex items-center gap-1 hover:text-foreground">
                          Pass Rate Excl. IF {declineCountryIcon("pass_rate_ex_if")}
                        </button>
                      </TableHead>
                      <TableHead className="text-right">
                        <button onClick={() => toggleDeclineCountrySort("insufficient_funds")} className="inline-flex items-center gap-1 hover:text-foreground">
                          Insufficient Funds {declineCountryIcon("insufficient_funds")}
                        </button>
                      </TableHead>
                      <TableHead>Top Decline Reason</TableHead>
                      <TableHead className="text-right">
                        <button onClick={() => toggleDeclineCountrySort("users_with_attempts")} className="inline-flex items-center gap-1 hover:text-foreground">
                          Users w/ Attempts {declineCountryIcon("users_with_attempts")}
                        </button>
                      </TableHead>
                      <TableHead className="text-right">
                        <button onClick={() => toggleDeclineCountrySort("users_with_success")} className="inline-flex items-center gap-1 hover:text-foreground">
                          Users w/ Success {declineCountryIcon("users_with_success")}
                        </button>
                      </TableHead>
                      <TableHead className="text-right">
                        <button onClick={() => toggleDeclineCountrySort("user_pass_rate")} className="inline-flex items-center gap-1 hover:text-foreground">
                          User Pass Rate {declineCountryIcon("user_pass_rate")}
                        </button>
                      </TableHead>
                      <TableHead className="text-right">
                        <button onClick={() => toggleDeclineCountrySort("first_attempt_pass_rate")} className="inline-flex items-center gap-1 hover:text-foreground">
                          First Attempt PR {declineCountryIcon("first_attempt_pass_rate")}
                        </button>
                      </TableHead>
                      <TableHead className="text-right">
                        <button onClick={() => toggleDeclineCountrySort("first_sub_pass_rate")} className="inline-flex items-center gap-1 hover:text-foreground">
                          First Sub PR {declineCountryIcon("first_sub_pass_rate")}
                        </button>
                      </TableHead>
                      <TableHead className="text-right">
                        <button onClick={() => toggleDeclineCountrySort("renewal_pass_rate")} className="inline-flex items-center gap-1 hover:text-foreground">
                          Renewal PR {declineCountryIcon("renewal_pass_rate")}
                        </button>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {chDecline.country_rows.map((row) => (
                      <TableRow key={row.country}>
                        <TableCell className="text-sm tabular-nums">{row.country}</TableCell>
                        <TableCell className="text-right tabular-nums">{row.total_attempts}</TableCell>
                        <TableCell className="text-right tabular-nums">{row.successful}</TableCell>
                        <TableCell className="text-right tabular-nums">{row.failed}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatRate(row.pass_rate)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatRate(row.pass_rate_ex_if)}</TableCell>
                        <TableCell className="text-right tabular-nums">{row.insufficient_funds}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">{row.top_decline_reason ?? "—"}</TableCell>
                        <TableCell className="text-right tabular-nums">{row.users_with_attempts}</TableCell>
                        <TableCell className="text-right tabular-nums">{row.users_with_success}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatRate(row.user_pass_rate)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatRate(row.first_attempt_pass_rate)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatRate(row.first_sub_pass_rate)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatRate(row.renewal_pass_rate)}</TableCell>
                      </TableRow>
                    ))}
                    {/* Additive totals (rates recomputed from summed components —
                        never an average of country rates). */}
                    <TableRow className="bg-muted/30 font-medium">
                      <TableCell className="text-sm">All countries</TableCell>
                      <TableCell className="text-right tabular-nums">{chDecline.country_totals.total_attempts}</TableCell>
                      <TableCell className="text-right tabular-nums">{chDecline.country_totals.successful}</TableCell>
                      <TableCell className="text-right tabular-nums">{chDecline.country_totals.failed}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatRate(chDecline.country_totals.pass_rate)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatRate(chDecline.country_totals.pass_rate_ex_if)}</TableCell>
                      <TableCell className="text-right tabular-nums">{chDecline.country_totals.insufficient_funds}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">—</TableCell>
                      <TableCell className="text-right tabular-nums">{chDecline.country_totals.users_with_attempts}</TableCell>
                      <TableCell className="text-right tabular-nums">{chDecline.country_totals.users_with_success}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatRate(chDecline.country_totals.user_pass_rate)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatRate(chDecline.country_totals.first_attempt_pass_rate)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatRate(chDecline.country_totals.first_sub_pass_rate)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatRate(chDecline.country_totals.renewal_pass_rate)}</TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </div>
            )}
          </TabsContent>
        </Tabs>
        </Card>
      </div>
    </AppLayout>
  );
}
