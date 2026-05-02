import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronDown, KeyRound, RefreshCw, Search, ShieldAlert, Users, XCircle, CheckCircle2, RotateCw, Clock } from "lucide-react";
import { AppLayout } from "@/components/AppLayout";
import { KpiCard } from "@/components/KpiCard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
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
import { fetchProfileDebug, fetchSubscriptionDebug, syncAllSubscriptionsWithDiagnostics, testFunnelFoxConnection } from "@/services/funnelfoxApi";
import type { FunnelFoxProfileDebugResponse } from "@/services/funnelfoxApi";
import {
  clearSubscriptionsCache,
  getSubscriptionsCacheInfo,
  loadSubscriptionsFromCache,
  saveSubscriptionsToCache,
  type SubscriptionCacheMetadata,
} from "@/services/subscriptionCache";
import { computeUsers, formatCurrency, formatPct } from "@/services/analytics";
import { useTransactions } from "@/services/sheets";
import { useDataStore } from "@/store/dataStore";
import type { SubscriptionClean } from "@/types/subscriptions";
import type { Transaction, UserAggregate } from "@/services/types";

type CancellationFilter = "all" | "cancelled" | "not_cancelled";
type ActiveFilter = "all" | "active" | "expired";
type CancelTypeFilter = "all" | SubscriptionClean["cancellation_type"];
type CancelTimingFilter = "all" | SubscriptionClean["cancellation_timing_bucket"];
type SubscriptionSortKey = "cohort_date" | "cohort_id" | "campaign_path";

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
  return value.replaceAll("_", " ");
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
  const setSubscriptions = useDataStore((s) => s.setSubscriptions);
  const lastSubscriptionSyncAt = useDataStore((s) => s.lastSubscriptionSyncAt);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [cancellationFilter, setCancellationFilter] = useState<CancellationFilter>("all");
  const [activeFilter, setActiveFilter] = useState<ActiveFilter>("all");
  const [cancelTypeFilter, setCancelTypeFilter] = useState<CancelTypeFilter>("all");
  const [cancelTimingFilter, setCancelTimingFilter] = useState<CancelTimingFilter>("all");
  const [cohortFilter, setCohortFilter] = useState("all");
  const [campaignPathFilter, setCampaignPathFilter] = useState("all");
  const [cohortDateFrom, setCohortDateFrom] = useState("");
  const [cohortDateTo, setCohortDateTo] = useState("");
  const [sortKey, setSortKey] = useState<SubscriptionSortKey>("cohort_date");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [cancelledFrom, setCancelledFrom] = useState("");
  const [cancelledTo, setCancelledTo] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncNote, setSyncNote] = useState<string | null>(null);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [funnelFoxSecret, setFunnelFoxSecret] = useState("");
  const [testingConnection, setTestingConnection] = useState(false);
  const [connectionMessage, setConnectionMessage] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [profileDebugOpen, setProfileDebugOpen] = useState(false);
  const [profileDebugJsonOpen, setProfileDebugJsonOpen] = useState(false);
  const [profileIdInput, setProfileIdInput] = useState("");
  const [profileDebugLoading, setProfileDebugLoading] = useState(false);
  const [profileDebugResult, setProfileDebugResult] = useState<FunnelFoxProfileDebugResponse | null>(null);
  const [profileDebugError, setProfileDebugError] = useState<string | null>(null);
  const [cacheInfo, setCacheInfo] = useState<SubscriptionCacheMetadata | null>(null);
  const [cacheLoading, setCacheLoading] = useState(false);
  const [subscriptionDebugOpen, setSubscriptionDebugOpen] = useState(false);
  const [subscriptionDebugLoading, setSubscriptionDebugLoading] = useState(false);
  const [subscriptionDebugJson, setSubscriptionDebugJson] = useState<unknown>(null);
  const [subscriptionDebugError, setSubscriptionDebugError] = useState<string | null>(null);
  const [subscriptionDebugCopied, setSubscriptionDebugCopied] = useState(false);

  useEffect(() => {
    getSubscriptionsCacheInfo()
      .then(setCacheInfo)
      .catch(() => setCacheInfo(null));
  }, []);

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

  const emailDiagnostics = useMemo(() => {
    const total = subscriptions.length;
    const withEmail = subscriptions.filter((s) => Boolean(s.email)).length;
    const missingEmail = total - withEmail;
    const coverage = total ? (withEmail / total) * 100 : 0;
    return { total, withEmail, missingEmail, coverage };
  }, [subscriptions]);

  const firstProfileId = useMemo(
    () => filtered.find((sub) => sub.profile_id)?.profile_id ?? "",
    [filtered]
  );

  function secretOptions() {
    const secret = funnelFoxSecret.trim();
    return secret ? { secret } : undefined;
  }

  async function onTestConnection() {
    try {
      setTestingConnection(true);
      setConnectionMessage(null);
      setConnectionError(null);
      const result = await testFunnelFoxConnection(secretOptions());
      if (!result.secret_exists) {
        setConnectionError("Add FunnelFox Secret Key or configure FUNNELFOX_SECRET on the server.");
        return;
      }
      if (!result.can_call_funnelfox) {
        setConnectionError("Could not connect to FunnelFox. Check the key and try again.");
        return;
      }
      setConnectionMessage(`Connection successful. Returned ${result.subscription_count} subscriptions.`);
    } catch (error) {
      setConnectionError(error instanceof Error ? error.message : "Could not test FunnelFox connection.");
    } finally {
      setTestingConnection(false);
    }
  }

  async function onSync() {
    try {
      setSyncing(true);
      setSyncError(null);
      setSyncNote(null);
      const result = await syncAllSubscriptionsWithDiagnostics(secretOptions());
      const { rows, diagnostics } = result;
      console.info("FunnelFox sync result count before store update", { count: rows.length });
      setSubscriptions(rows);
      console.info("FunnelFox store subscriptions count after setSubscriptions", {
        count: useDataStore.getState().subscriptions.length,
      });
      const cacheMetadata = await saveSubscriptionsToCache(rows, {
        last_sync_at: new Date().toISOString(),
      });
      setCacheInfo(cacheMetadata);
      const coverage = diagnostics.total_subscriptions
        ? ((diagnostics.total_subscriptions - diagnostics.missing_email_after_details) / diagnostics.total_subscriptions) * 100
        : 0;
      const failedDetailRequests = diagnostics.warnings.length;
      setSyncNote(
        rows.length
          ? `${failedDetailRequests ? "Sync completed with partial enrichment warnings" : "Sync completed"}. Total subscriptions loaded: ${diagnostics.total_subscriptions}. Email coverage: ${diagnostics.total_subscriptions - diagnostics.missing_email_after_details}/${diagnostics.total_subscriptions} (${formatPct(coverage)}). Missing emails: ${diagnostics.missing_email_after_details}. Failed detail/profile requests: ${failedDetailRequests}.`
          : "Mock mode is active or the backend proxy returned no subscriptions."
      );
    } catch (error) {
      if (useDataStore.getState().subscriptions.length > 0) {
        setSyncNote("Sync failed before new data loaded. Keeping existing subscriptions visible.");
      } else {
        setSyncError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      setSyncing(false);
    }
  }

  async function onLoadSavedSubscriptions() {
    try {
      setCacheLoading(true);
      setSyncError(null);
      const cached = await loadSubscriptionsFromCache();
      if (!cached) {
        setSyncNote("No saved FunnelFox subscriptions found.");
        setCacheInfo(null);
        return;
      }
      setSubscriptions(cached.subscriptions);
      setCacheInfo(cached.metadata);
      setSyncNote(`Loaded saved FunnelFox subscriptions. Total subscriptions loaded: ${cached.metadata.count}. Email coverage: ${formatPct(cached.metadata.email_coverage)}.`);
    } catch (error) {
      setSyncError(error instanceof Error ? error.message : "Could not load saved FunnelFox subscriptions.");
    } finally {
      setCacheLoading(false);
    }
  }

  async function onClearSavedSubscriptions() {
    try {
      setCacheLoading(true);
      setSyncError(null);
      await clearSubscriptionsCache();
      setCacheInfo(null);
      setSyncNote("Saved FunnelFox subscriptions cache cleared. Current table remains loaded.");
    } catch (error) {
      setSyncError(error instanceof Error ? error.message : "Could not clear saved FunnelFox subscriptions.");
    } finally {
      setCacheLoading(false);
    }
  }

  async function onFetchProfileDebug(profileId: string) {
    const trimmedProfileId = profileId.trim();
    if (!trimmedProfileId) {
      setProfileDebugError("Enter a profile ID first.");
      return;
    }

    try {
      setProfileDebugLoading(true);
      setProfileDebugError(null);
      setProfileDebugResult(null);
      const result = await fetchProfileDebug(trimmedProfileId, secretOptions());
      setProfileIdInput(trimmedProfileId);
      setProfileDebugResult(result);
      setProfileDebugJsonOpen(true);
    } catch (error) {
      setProfileDebugError(error instanceof Error ? error.message : "Could not fetch FunnelFox profile.");
    } finally {
      setProfileDebugLoading(false);
    }
  }

  async function onFetchSubscriptionDebug(subscriptionId: string) {
    if (!subscriptionId) {
      setSubscriptionDebugError("Subscription ID is missing.");
      setSubscriptionDebugOpen(true);
      return;
    }

    try {
      setSubscriptionDebugOpen(true);
      setSubscriptionDebugLoading(true);
      setSubscriptionDebugJson(null);
      setSubscriptionDebugError(null);
      setSubscriptionDebugCopied(false);
      const result = await fetchSubscriptionDebug(subscriptionId, secretOptions());
      setSubscriptionDebugJson(result);
    } catch (error) {
      setSubscriptionDebugError(error instanceof Error ? error.message : "Could not fetch FunnelFox subscription details.");
    } finally {
      setSubscriptionDebugLoading(false);
    }
  }

  async function onCopySubscriptionDebugJson() {
    if (!subscriptionDebugJson) return;
    await navigator.clipboard.writeText(JSON.stringify(subscriptionDebugJson, null, 2));
    setSubscriptionDebugCopied(true);
  }

  const toggleSort = (key: SubscriptionSortKey) => {
    if (sortKey === key) setSortDir((dir) => (dir === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  const sortIcon = (key: SubscriptionSortKey) =>
    sortKey !== key ? <ArrowUpDown className="h-3 w-3 opacity-40" /> :
    sortDir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />;

  return (
    <AppLayout
      title="Subscriptions"
      description="FunnelFox subscription cancellation monitoring"
      actions={
        <Button size="sm" onClick={onSync} disabled={syncing}>
          <RefreshCw className={syncing ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
          Sync FunnelFox subscriptions
        </Button>
      }
    >
      <Card className="mb-4 p-3 shadow-card">
        <div className="flex items-start gap-2 text-xs text-muted-foreground">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <p>
            FunnelFox sync is isolated from Palmer analytics. Browser code must not send `Fox-Secret`; configure a
            server-side proxy at <span className="font-mono text-foreground">/api/funnelfox/subscriptions</span>, then set
            <span className="font-mono text-foreground"> VITE_FUNNELFOX_MOCK=false</span>.
          </p>
        </div>
        {(syncNote || syncError || lastSubscriptionSyncAt) && (
          <div className="mt-2 text-xs text-muted-foreground">
            {syncNote && <span>{syncNote}</span>}
            {syncError && <span className="text-destructive">{syncError}</span>}
            {lastSubscriptionSyncAt && (
              <span className="ml-2">Last sync: {new Date(lastSubscriptionSyncAt).toLocaleString()}</span>
            )}
            {subscriptions.length > 0 && (
              <span className="ml-2">
                Email coverage: {emailDiagnostics.withEmail}/{emailDiagnostics.total} ({formatPct(emailDiagnostics.coverage)}),
                missing {emailDiagnostics.missingEmail}
              </span>
            )}
          </div>
        )}
      </Card>

      <Collapsible open={connectionOpen} onOpenChange={setConnectionOpen}>
        <Card className="mb-4 p-3 shadow-card">
          <CollapsibleTrigger asChild>
            <Button variant="ghost" className="h-8 w-full justify-between px-1">
              <span className="flex items-center gap-2 text-sm font-medium">
                <KeyRound className="h-4 w-4" />
                FunnelFox API connection
              </span>
              <ChevronDown className={connectionOpen ? "h-4 w-4 rotate-180 transition-transform" : "h-4 w-4 transition-transform"} />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="mt-3 grid gap-3 md:grid-cols-[minmax(240px,1fr)_auto_auto] md:items-end">
              <div className="space-y-1.5">
                <Label htmlFor="funnelfox-secret" className="text-xs text-muted-foreground">
                  FunnelFox Secret Key
                </Label>
                <Input
                  id="funnelfox-secret"
                  type="password"
                  value={funnelFoxSecret}
                  onChange={(e) => {
                    setFunnelFoxSecret(e.target.value);
                    setConnectionMessage(null);
                    setConnectionError(null);
                  }}
                  placeholder="Paste key for this session"
                  autoComplete="off"
                  className="h-9"
                />
              </div>
              <Button variant="outline" onClick={onTestConnection} disabled={testingConnection || syncing}>
                <RefreshCw className={testingConnection ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
                Test connection
              </Button>
              <Button onClick={onSync} disabled={syncing || testingConnection}>
                <RefreshCw className={syncing ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
                Sync subscriptions
              </Button>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              This key is used only for the current browser session and is sent to the server proxy. For production,
              configure <span className="font-mono text-foreground">FUNNELFOX_SECRET</span> on the server.
            </p>
            {(connectionMessage || connectionError) && (
              <div className="mt-2 text-xs">
                {connectionMessage && <span className="text-success">{connectionMessage}</span>}
                {connectionError && <span className="text-destructive">{connectionError}</span>}
              </div>
            )}
            <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
              <Button variant="outline" size="sm" onClick={onLoadSavedSubscriptions} disabled={cacheLoading}>
                Load saved subscriptions
              </Button>
              <Button variant="outline" size="sm" onClick={onClearSavedSubscriptions} disabled={cacheLoading || !cacheInfo}>
                Clear saved subscriptions
              </Button>
              <span className="text-xs text-muted-foreground">
                {cacheInfo
                  ? `Saved subscriptions available: ${cacheInfo.count}, saved at ${new Date(cacheInfo.saved_at).toLocaleString()}`
                  : "No saved subscriptions cache found."}
              </span>
            </div>
          </CollapsibleContent>
        </Card>
      </Collapsible>

      <Collapsible open={profileDebugOpen} onOpenChange={setProfileDebugOpen}>
        <Card className="mb-4 p-3 shadow-card">
          <CollapsibleTrigger asChild>
            <Button variant="ghost" className="h-8 w-full justify-between px-1">
              <span className="flex items-center gap-2 text-sm font-medium">
                <Search className="h-4 w-4" />
                Profile debug
              </span>
              <ChevronDown className={profileDebugOpen ? "h-4 w-4 rotate-180 transition-transform" : "h-4 w-4 transition-transform"} />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="mt-3 grid gap-3 md:grid-cols-[minmax(240px,1fr)_auto_auto] md:items-end">
              <div className="space-y-1.5">
                <Label htmlFor="profile-debug-id" className="text-xs text-muted-foreground">
                  Profile ID
                </Label>
                <Input
                  id="profile-debug-id"
                  value={profileIdInput}
                  onChange={(e) => {
                    setProfileIdInput(e.target.value);
                    setProfileDebugError(null);
                  }}
                  placeholder="Paste FunnelFox profile ID"
                  className="h-9"
                />
              </div>
              <Button variant="outline" onClick={() => onFetchProfileDebug(profileIdInput)} disabled={profileDebugLoading}>
                <RefreshCw className={profileDebugLoading ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
                Fetch profile
              </Button>
              <Button
                variant="outline"
                onClick={() => onFetchProfileDebug(firstProfileId)}
                disabled={profileDebugLoading || !firstProfileId}
              >
                Fetch first profile
              </Button>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Debug output is sanitized server-side and is for inspecting profile/email fields only.
            </p>
            {profileDebugError && <div className="mt-2 text-xs text-destructive">{profileDebugError}</div>}
            {profileDebugResult && (
              <div className="mt-3 rounded-md border border-border">
                <button
                  type="button"
                  className="flex w-full items-center justify-between px-3 py-2 text-left text-xs text-muted-foreground"
                  onClick={() => setProfileDebugJsonOpen((open) => !open)}
                >
                  <span>
                    detected_email: <span className="text-foreground">{profileDebugResult.detected_email || "—"}</span>
                  </span>
                  <ChevronDown className={profileDebugJsonOpen ? "h-4 w-4 rotate-180 transition-transform" : "h-4 w-4 transition-transform"} />
                </button>
                {profileDebugJsonOpen && (
                  <pre className="max-h-[360px] overflow-auto border-t border-border p-3 text-xs">
                    {JSON.stringify(profileDebugResult, null, 2)}
                  </pre>
                )}
              </div>
            )}
          </CollapsibleContent>
        </Card>
      </Collapsible>

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
              onChange={(e) => setSearch(e.target.value)}
              className="h-9 pl-8"
            />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="h-9 w-[160px]"><SelectValue placeholder="Status" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {statusOptions.map((status) => (
                <SelectItem key={status} value={status}>{status}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={cancellationFilter} onValueChange={(v: CancellationFilter) => setCancellationFilter(v)}>
            <SelectTrigger className="h-9 w-[170px]"><SelectValue placeholder="Cancellation" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All cancellations</SelectItem>
              <SelectItem value="cancelled">Cancelled</SelectItem>
              <SelectItem value="not_cancelled">Not cancelled</SelectItem>
            </SelectContent>
          </Select>
          <Select value={activeFilter} onValueChange={(v: ActiveFilter) => setActiveFilter(v)}>
            <SelectTrigger className="h-9 w-[150px]"><SelectValue placeholder="Active" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All activity</SelectItem>
              <SelectItem value="active">Active now</SelectItem>
              <SelectItem value="expired">Expired</SelectItem>
            </SelectContent>
          </Select>
          <Select value={cancelTypeFilter} onValueChange={(v: CancelTypeFilter) => setCancelTypeFilter(v)}>
            <SelectTrigger className="h-9 w-[210px]"><SelectValue placeholder="Cancel type" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All cancel types</SelectItem>
              {cancelTypeOptions.map((type) => (
                <SelectItem key={type} value={type}>{readableValue(type)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={cancelTimingFilter} onValueChange={(v: CancelTimingFilter) => setCancelTimingFilter(v)}>
            <SelectTrigger className="h-9 w-[220px]"><SelectValue placeholder="Cancel timing" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All cancel timings</SelectItem>
              {cancelTimingOptions.map((timing) => (
                <SelectItem key={timing} value={timing}>{readableValue(timing)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={cohortFilter} onValueChange={setCohortFilter}>
            <SelectTrigger className="h-9 w-[220px]"><SelectValue placeholder="Cohort" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All cohorts</SelectItem>
              {cohortOptions.map((cohort) => (
                <SelectItem key={cohort} value={cohort}>{cohort}</SelectItem>
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
          <div className="flex items-center gap-2">
            <Label htmlFor="cohort-from" className="text-xs text-muted-foreground">Cohort from</Label>
            <Input id="cohort-from" type="date" value={cohortDateFrom} onChange={(e) => setCohortDateFrom(e.target.value)} className="h-9 w-[150px]" />
          </div>
          <div className="flex items-center gap-2">
            <Label htmlFor="cohort-to" className="text-xs text-muted-foreground">Cohort to</Label>
            <Input id="cohort-to" type="date" value={cohortDateTo} onChange={(e) => setCohortDateTo(e.target.value)} className="h-9 w-[150px]" />
          </div>
          <div className="flex items-center gap-2">
            <Label htmlFor="cancelled-from" className="text-xs text-muted-foreground">Cancelled from</Label>
            <Input id="cancelled-from" type="date" value={cancelledFrom} onChange={(e) => setCancelledFrom(e.target.value)} className="h-9 w-[150px]" />
          </div>
          <div className="flex items-center gap-2">
            <Label htmlFor="cancelled-to" className="text-xs text-muted-foreground">Cancelled to</Label>
            <Input id="cancelled-to" type="date" value={cancelledTo} onChange={(e) => setCancelledTo(e.target.value)} className="h-9 w-[150px]" />
          </div>
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
                <TableHead className="text-right">Debug</TableHead>
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
                  <TableCell className="text-right">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={!sub.subscription_id || subscriptionDebugLoading}
                      onClick={() => onFetchSubscriptionDebug(sub.subscription_id)}
                    >
                      Debug
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {filtered.length === 0 && (
                <TableRow>
                  <TableCell colSpan={20} className="py-10 text-center text-sm text-muted-foreground">
                    No FunnelFox subscriptions loaded.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </Card>
      <Dialog open={subscriptionDebugOpen} onOpenChange={setSubscriptionDebugOpen}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>Subscription Debug</DialogTitle>
          </DialogHeader>
          <div className="flex items-center justify-between gap-3">
            <div className="text-xs text-muted-foreground">
              {subscriptionDebugLoading
                ? "Loading FunnelFox subscription payload..."
                : subscriptionDebugError
                  ? subscriptionDebugError
                  : "Raw FunnelFox subscription response"}
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!subscriptionDebugJson}
              onClick={onCopySubscriptionDebugJson}
            >
              {subscriptionDebugCopied ? "Copied" : "Copy JSON"}
            </Button>
          </div>
          <pre className="max-h-[70vh] overflow-auto rounded-md border border-border bg-muted/30 p-3 text-xs">
            {subscriptionDebugError
              ? subscriptionDebugError
              : subscriptionDebugLoading
                ? "Loading..."
                : JSON.stringify(subscriptionDebugJson, null, 2)}
          </pre>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
