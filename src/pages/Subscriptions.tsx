import { useMemo, useState } from "react";
import { ChevronDown, KeyRound, RefreshCw, Search, ShieldAlert, Users, XCircle, CheckCircle2, RotateCw, Clock } from "lucide-react";
import { AppLayout } from "@/components/AppLayout";
import { KpiCard } from "@/components/KpiCard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
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
import { fetchProfileDebug, syncAllSubscriptionsWithDiagnostics, testFunnelFoxConnection } from "@/services/funnelfoxApi";
import type { FunnelFoxProfileDebugResponse } from "@/services/funnelfoxApi";
import { formatCurrency, formatPct } from "@/services/analytics";
import { useDataStore } from "@/store/dataStore";

type CancellationFilter = "all" | "cancelled" | "not_cancelled";
type ActiveFilter = "all" | "active" | "expired";

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

export default function SubscriptionsPage() {
  const subscriptions = useDataStore((s) => s.subscriptions);
  const setSubscriptions = useDataStore((s) => s.setSubscriptions);
  const lastSubscriptionSyncAt = useDataStore((s) => s.lastSubscriptionSyncAt);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [cancellationFilter, setCancellationFilter] = useState<CancellationFilter>("all");
  const [activeFilter, setActiveFilter] = useState<ActiveFilter>("all");
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

  const statusOptions = useMemo(
    () => Array.from(new Set(subscriptions.map((s) => s.status || "unknown"))).sort(),
    [subscriptions]
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return subscriptions.filter((sub) => {
      if (q && !(sub.email ?? "").toLowerCase().includes(q)) return false;
      if (statusFilter !== "all" && (sub.status || "unknown") !== statusFilter) return false;
      if (cancellationFilter === "cancelled" && !sub.is_cancelled) return false;
      if (cancellationFilter === "not_cancelled" && sub.is_cancelled) return false;
      if (activeFilter === "active" && !sub.is_active_now) return false;
      if (activeFilter === "expired" && sub.is_active_now) return false;
      const cancelledAt = dateKey(sub.cancelled_at);
      if (cancelledFrom && (!cancelledAt || cancelledAt < cancelledFrom)) return false;
      if (cancelledTo && (!cancelledAt || cancelledAt > cancelledTo)) return false;
      return true;
    });
  }, [subscriptions, search, statusFilter, cancellationFilter, activeFilter, cancelledFrom, cancelledTo]);

  const kpis = useMemo(() => {
    const total = subscriptions.length;
    const activeNow = subscriptions.filter((s) => s.is_active_now).length;
    const cancelled = subscriptions.filter((s) => s.is_cancelled).length;
    const renewing = subscriptions.filter((s) => s.renews === true).length;
    const cancelledButActive = subscriptions.filter((s) => s.is_cancelled && s.is_active_now).length;
    const cancellationRate = total ? (cancelled / total) * 100 : 0;
    return { total, activeNow, cancelled, renewing, cancelledButActive, cancellationRate };
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
      const coverage = diagnostics.total_subscriptions
        ? ((diagnostics.total_subscriptions - diagnostics.missing_email_after_details) / diagnostics.total_subscriptions) * 100
        : 0;
      setSyncNote(
        rows.length
          ? `Loaded ${diagnostics.total_subscriptions} FunnelFox subscriptions. With profile ID: ${diagnostics.subscriptions_with_profile_id}, missing profile ID: ${diagnostics.subscriptions_missing_profile_id}. Missing email before details: ${diagnostics.missing_email_before_details}. Details attempted: ${diagnostics.detail_requests_attempted}, fetched: ${diagnostics.details_fetched}. Skipped complete: ${diagnostics.detail_requests_skipped_due_to_complete_data}, cache: ${diagnostics.detail_requests_skipped_due_to_cache}. Emails enriched: ${diagnostics.emails_enriched_from_details}. Missing email after details: ${diagnostics.missing_email_after_details} (${formatPct(coverage)} coverage).${diagnostics.warnings.length ? ` ${diagnostics.warnings.length} detail warnings.` : ""}`
          : "Mock mode is active or the backend proxy returned no subscriptions."
      );
    } catch (error) {
      setSyncError(error instanceof Error ? error.message : String(error));
    } finally {
      setSyncing(false);
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

      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <KpiCard label="Total subscriptions" value={String(kpis.total)} icon={<Users className="h-4 w-4" />} />
        <KpiCard label="Active now" value={String(kpis.activeNow)} icon={<CheckCircle2 className="h-4 w-4" />} accent="success" />
        <KpiCard label="Cancelled" value={String(kpis.cancelled)} icon={<XCircle className="h-4 w-4" />} accent="warning" />
        <KpiCard label="Renewing" value={String(kpis.renewing)} icon={<RotateCw className="h-4 w-4" />} accent="accent" />
        <KpiCard label="Cancelled active" value={String(kpis.cancelledButActive)} icon={<Clock className="h-4 w-4" />} accent="warning" />
        <KpiCard label="Cancellation rate" value={formatPct(kpis.cancellationRate)} icon={<XCircle className="h-4 w-4" />} />
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
                <TableHead>Status</TableHead>
                <TableHead>Renews</TableHead>
                <TableHead>Cancelled</TableHead>
                <TableHead>Cancelled at</TableHead>
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
                  <TableCell><Badge variant="secondary">{sub.status || "unknown"}</Badge></TableCell>
                  <TableCell className="text-sm">{boolLabel(sub.renews)}</TableCell>
                  <TableCell className="text-sm">{sub.is_cancelled ? "Yes" : "No"}</TableCell>
                  <TableCell className="text-xs text-muted-foreground tabular-nums">{formatDateTime(sub.cancelled_at)}</TableCell>
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
                  <TableCell colSpan={10} className="py-10 text-center text-sm text-muted-foreground">
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
