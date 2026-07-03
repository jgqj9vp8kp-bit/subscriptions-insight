import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Mail, RefreshCw, Users as UsersIcon, X } from "lucide-react";
import { AppLayout } from "@/components/AppLayout";
import { KpiCard } from "@/components/KpiCard";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { useDataStore } from "@/store/dataStore";
import { usePersistedPageState } from "@/hooks/usePersistedPageState";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { mediaBuyerLabel } from "@/services/userMediaBuyer";
import { backfillTransactionCardTypesFromRawRows } from "@/services/palmerTransform";
import { isSupabaseConfigured } from "@/services/supabaseClient";
import { computeLeads, type LeadRecord } from "@/services/leads";
import { selectLeadsSource } from "@/services/funnelfoxLeadsTransform";
import {
  getFunnelFoxLeadsStats,
  loadFunnelFoxLeads,
  runFunnelFoxLeadsSync,
  type FunnelFoxLeadRow,
  type FunnelFoxLeadsSyncState,
} from "@/services/funnelfoxLeads";
import type { MediaBuyer } from "@/services/types";

const FILTER_DEBOUNCE_MS = 300;
const PAGE_SIZE = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

const DEFAULT_LEADS_UI_STATE = {
  search: "",
  dateFrom: "",
  dateTo: "",
  funnel: "all",
  campaignPath: "all",
  campaignId: "all",
  mediaBuyer: "all",
  country: "all",
  hasEmail: "all" as "all" | "has" | "none",
};

interface LeadView {
  key: string;
  email: string | null;
  funnel: string;
  campaign_path: string;
  campaign_id: string;
  media_buyer: MediaBuyer;
  country: string | null;
  session_date: string | null;
  days_since_visit: number | null;
  customer_id: string;
  user_agent: string | null;
  origin: string | null;
}

function dayKey(value: string | null): string {
  return value ? value.slice(0, 10) : "";
}

function daysSince(value: string | null, now: number): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? Math.floor((now - ms) / DAY_MS) : null;
}

function funnelfoxToView(row: FunnelFoxLeadRow, now: number): LeadView {
  const session = row.session_created_at ?? row.created_at;
  return {
    key: `ff:${row.id}`,
    email: row.email,
    funnel: row.funnel || row.funnel_id || "unknown",
    campaign_path: row.campaign_path || "—",
    campaign_id: row.campaign_id || "—",
    media_buyer: (row.media_buyer as MediaBuyer) || "Unknown",
    country: row.country_code,
    session_date: session,
    days_since_visit: daysSince(session, now),
    customer_id: row.profile_id,
    user_agent: row.user_agent,
    origin: row.origin,
  };
}

function warehouseToView(lead: LeadRecord): LeadView {
  return {
    key: `wh:${lead.source}:${lead.customer_id}:${lead.email}`,
    email: lead.email,
    funnel: lead.funnel,
    campaign_path: lead.campaign_path || "—",
    campaign_id: lead.campaign_id || "—",
    media_buyer: lead.media_buyer,
    country: lead.country,
    session_date: lead.session_date,
    days_since_visit: lead.days_since_visit,
    customer_id: lead.customer_id,
    user_agent: lead.user_agent,
    origin: null,
  };
}

export default function LeadsPage() {
  const txs = useTransactions();
  const subscriptions = useDataStore((s) => s.subscriptions);
  const rawPalmerRows = useDataStore((s) => s.rawPalmerRows);

  const [uiState, setUiState, resetUiState] = usePersistedPageState("ui_state_leads", DEFAULT_LEADS_UI_STATE);

  const analyticsTxs = useMemo(
    () => backfillTransactionCardTypesFromRawRows(txs, rawPalmerRows),
    [txs, rawPalmerRows],
  );

  // Warehouse fallback (existing, synchronous, no network).
  const warehouseLeads = useMemo(() => computeLeads(analyticsTxs, subscriptions), [analyticsTxs, subscriptions]);

  // Synced FunnelFox leads from Supabase (preferred source when present).
  const [funnelfoxLeads, setFunnelfoxLeads] = useState<FunnelFoxLeadRow[]>([]);
  const [syncState, setSyncState] = useState<FunnelFoxLeadsSyncState | null>(null);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!isSupabaseConfigured) return;
    setLoading(true);
    try {
      const [leads, stats] = await Promise.all([
        loadFunnelFoxLeads().catch(() => [] as FunnelFoxLeadRow[]),
        getFunnelFoxLeadsStats().catch(() => null),
      ]);
      setFunnelfoxLeads(leads);
      setSyncState(stats);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const runSync = useCallback(
    async (fullReset: boolean) => {
      setSyncing(true);
      setError(null);
      try {
        await runFunnelFoxLeadsSync({ transactions: analyticsTxs, subscriptions, fullReset });
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Sync failed.");
      } finally {
        setSyncing(false);
      }
    },
    [analyticsTxs, subscriptions, refresh],
  );

  const handleContinue = useCallback(() => runSync(false), [runSync]);
  const handleFullResync = useCallback(() => runSync(true), [runSync]);

  const now = Date.now();
  const source = selectLeadsSource(funnelfoxLeads, warehouseLeads);
  const views = useMemo<LeadView[]>(
    () =>
      source.source === "funnelfox"
        ? source.funnelfox.map((row) => funnelfoxToView(row, now))
        : source.warehouse.map(warehouseToView),
    // `now` intentionally excluded — it must not retrigger on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [source.source, source.funnelfox, source.warehouse],
  );

  const options = useMemo(() => {
    const funnels = new Set<string>();
    const campaignPaths = new Set<string>();
    const campaignIds = new Set<string>();
    const mediaBuyers = new Set<string>();
    const countries = new Set<string>();
    for (const v of views) {
      funnels.add(v.funnel);
      if (v.campaign_path && v.campaign_path !== "—") campaignPaths.add(v.campaign_path);
      if (v.campaign_id && v.campaign_id !== "—") campaignIds.add(v.campaign_id);
      mediaBuyers.add(v.media_buyer);
      if (v.country) countries.add(v.country);
    }
    return {
      funnels: [...funnels].sort(),
      campaignPaths: [...campaignPaths].sort(),
      campaignIds: [...campaignIds].sort(),
      mediaBuyers: [...mediaBuyers].sort(),
      countries: [...countries].sort(),
    };
  }, [views]);

  const liveFilters = useMemo(() => ({ ...uiState }), [uiState]);
  const [applied, isFiltering] = useDebouncedValue(liveFilters, FILTER_DEBOUNCE_MS);

  const filtered = useMemo(() => {
    const q = applied.search.trim().toLowerCase();
    return views.filter((v) => {
      const key = dayKey(v.session_date);
      if (q && !(v.email ?? "").toLowerCase().includes(q)) return false;
      if (applied.dateFrom && (!key || key < applied.dateFrom)) return false;
      if (applied.dateTo && (!key || key > applied.dateTo)) return false;
      if (applied.funnel !== "all" && v.funnel !== applied.funnel) return false;
      if (applied.campaignPath !== "all" && v.campaign_path !== applied.campaignPath) return false;
      if (applied.campaignId !== "all" && v.campaign_id !== applied.campaignId) return false;
      if (applied.mediaBuyer !== "all" && v.media_buyer !== applied.mediaBuyer) return false;
      if (applied.country !== "all" && (v.country ?? "") !== applied.country) return false;
      if (applied.hasEmail === "has" && !v.email) return false;
      if (applied.hasEmail === "none" && v.email) return false;
      return true;
    });
  }, [views, applied]);

  const summaryCards = useMemo(() => {
    const todayKey = new Date(now).toISOString().slice(0, 10);
    const sevenAgo = now - 7 * DAY_MS;
    let today = 0;
    let last7 = 0;
    let withEmail = 0;
    for (const v of views) {
      if (dayKey(v.session_date) === todayKey) today += 1;
      const ms = new Date(v.session_date ?? "").getTime();
      if (Number.isFinite(ms) && ms >= sevenAgo && ms <= now) last7 += 1;
      if (v.email) withEmail += 1;
    }
    const stats = syncState?.stats;
    return {
      total_leads: views.length,
      emails_found: source.source === "funnelfox" && stats ? stats.emails_found ?? stats.profiles_with_email ?? withEmail : withEmail,
      converted_excluded: source.source === "funnelfox" && stats ? stats.converted_excluded ?? 0 : 0,
      active_subs_excluded: source.source === "funnelfox" && stats ? stats.active_sub_excluded ?? 0 : 0,
      leads_today: today,
      leads_last_7_days: last7,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [views, syncState, source.source]);

  const updateUiState = (patch: Partial<typeof DEFAULT_LEADS_UI_STATE>) => setUiState((current) => ({ ...current, ...patch }));

  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [filtered]);
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const paged = useMemo(() => filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE), [filtered, safePage]);

  const hasFilters =
    uiState.search || uiState.dateFrom || uiState.dateTo || uiState.funnel !== "all" || uiState.campaignPath !== "all" ||
    uiState.campaignId !== "all" || uiState.mediaBuyer !== "all" || uiState.country !== "all" || uiState.hasEmail !== "all";

  const lastSyncAt = syncState?.last_full_sync_at;
  const stats = syncState?.stats ?? null;
  const rawStatus = syncState?.last_status ?? null;
  const syncStatusLabel = rawStatus === "error" ? "failed" : rawStatus ?? (lastSyncAt ? "ok" : "never synced");
  const isPartial = rawStatus === "partial";
  const statusClass =
    rawStatus === "ok"
      ? "text-success"
      : rawStatus === "partial"
        ? "text-warning"
        : rawStatus === "error"
          ? "text-destructive"
          : "text-muted-foreground";
  const currentStageLabel = syncState?.current_stage ?? stats?.stage ?? null;
  const coverageWarningMessage = stats?.coverage_warning ? stats.coverage_warning_message ?? "" : "";
  const hasSavedCursor = Boolean(syncState?.last_profiles_cursor || syncState?.last_sessions_cursor);
  const remainingUnchecked = stats?.remaining_detail_unchecked ?? 0;
  const detailChecked = Math.max(0, (stats?.profiles_total_saved ?? 0) - remainingUnchecked);

  return (
    <AppLayout title="Leads" description="Emails captured with no successful payment and no active subscription">
      {/* Sync block */}
      <Card className="mb-4 p-4 shadow-card">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm">
            <div className="font-medium">FunnelFox Leads sync</div>
            <div className="text-xs text-muted-foreground">
              Source: {source.source === "funnelfox" ? "FunnelFox synced leads" : "Warehouse fallback"}
              {lastSyncAt ? ` · last sync ${new Date(lastSyncAt).toLocaleString()}` : " · never synced"}
              {" · status "}
              <span className={statusClass}>{syncStatusLabel}</span>
              {currentStageLabel ? ` · stage ${currentStageLabel}` : ""}
            </div>
          </div>
          <div className="flex gap-2">
            <Button onClick={handleContinue} disabled={syncing || !isSupabaseConfigured} size="sm">
              {syncing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
              Continue Sync
            </Button>
            <Button onClick={handleFullResync} disabled={syncing || !isSupabaseConfigured} size="sm" variant="outline">
              Full Resync
            </Button>
          </div>
        </div>

        {error && <div className="mt-2 text-xs text-destructive">{error}</div>}

        {isPartial && (
          <div className="mt-2 rounded-md border border-warning/40 bg-warning/10 p-2 text-xs text-foreground">
            Sync is partial. Click <b>Continue Sync</b> to continue from the last cursor.
            {coverageWarningMessage ? <div className="mt-1 text-muted-foreground">{coverageWarningMessage}</div> : null}
          </div>
        )}
        {!isPartial && coverageWarningMessage && (
          <div className="mt-2 text-xs text-warning">{coverageWarningMessage}</div>
        )}

        {remainingUnchecked > 0 && (
          <div className="mt-2 text-xs text-warning">
            Email enrichment is still in progress. Click <b>Continue Sync</b>.
            {" "}({remainingUnchecked.toLocaleString()} profiles not yet checked)
          </div>
        )}

        {stats && (
          <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-muted-foreground sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
            <span>Profiles scanned: <b className="text-foreground">{(stats.profiles_scanned_total ?? stats.profiles_scanned ?? 0).toLocaleString()}</b></span>
            <span>Profiles saved: <b className="text-foreground">{(stats.profiles_total_saved ?? 0).toLocaleString()}</b></span>
            <span>With email: <b className="text-foreground">{(stats.profiles_with_email ?? 0).toLocaleString()}</b></span>
            <span>Without email: <b className="text-foreground">{(stats.profiles_without_email ?? 0).toLocaleString()}</b></span>
            <span>Detail attempts: <b className="text-foreground">{(stats.profile_details_attempted ?? 0).toLocaleString()}</b></span>
            <span>Detail failures: <b className="text-foreground">{(stats.profile_details_failed ?? 0).toLocaleString()}</b></span>
            <span>Detail checked: <b className="text-foreground">{detailChecked.toLocaleString()}</b></span>
            <span>Detail remaining: <b className="text-foreground">{remainingUnchecked.toLocaleString()}</b></span>
            <span>No-email (checked): <b className="text-foreground">{(stats.remaining_without_email_after_checked ?? 0).toLocaleString()}</b></span>
            <span>Sessions scanned: <b className="text-foreground">{(stats.sessions_scanned_total ?? stats.sessions_scanned ?? 0).toLocaleString()}</b></span>
            <span>Sessions joined: <b className="text-foreground">{(stats.sessions_joined ?? 0).toLocaleString()}</b></span>
            <span>Leads found: <b className="text-foreground">{(stats.leads_found ?? 0).toLocaleString()}</b></span>
            <span>Last cursor exists: <b className="text-foreground">{hasSavedCursor ? "yes" : "no"}</b></span>
            <span>Stopped reason: <b className="text-foreground">{stats.sync_stopped_reason ?? "—"}</b></span>
            <span>Coverage: <b className="text-foreground">{stats.profiles_coverage_percent != null ? `${stats.profiles_coverage_percent}%` : "total profiles unknown"}</b></span>
          </div>
        )}
      </Card>

      {/* Summary cards */}
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <KpiCard label="Total Leads" value={summaryCards.total_leads.toLocaleString()} icon={<UsersIcon className="h-4 w-4" />} />
        <KpiCard label="Emails Found" value={summaryCards.emails_found.toLocaleString()} icon={<Mail className="h-4 w-4" />} accent="accent" />
        <KpiCard label="Converted Excluded" value={summaryCards.converted_excluded.toLocaleString()} accent="success" />
        <KpiCard label="Active Subs Excluded" value={summaryCards.active_subs_excluded.toLocaleString()} accent="warning" />
        <KpiCard label="Leads Today" value={summaryCards.leads_today.toLocaleString()} />
        <KpiCard label="Leads Last 7 Days" value={summaryCards.leads_last_7_days.toLocaleString()} />
      </div>

      <Card className="p-4 shadow-card">
        <div className="flex flex-wrap items-center gap-2">
          {(isFiltering || loading) && (
            <span className="order-last ml-auto flex items-center gap-1 text-xs text-primary">
              <Loader2 className="h-3 w-3 animate-spin" />
              Updating results…
            </span>
          )}
          <Input
            placeholder="Search email…"
            value={uiState.search}
            onChange={(e) => updateUiState({ search: e.target.value })}
            className="h-9 w-[200px]"
          />
          <Input type="date" value={uiState.dateFrom} onChange={(e) => updateUiState({ dateFrom: e.target.value })} className="h-9 w-[150px]" aria-label="Session date from" />
          <Input type="date" value={uiState.dateTo} onChange={(e) => updateUiState({ dateTo: e.target.value })} className="h-9 w-[150px]" aria-label="Session date to" />
          <Select value={uiState.funnel} onValueChange={(v) => updateUiState({ funnel: v })}>
            <SelectTrigger className="h-9 w-[150px]"><SelectValue placeholder="Funnel" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All funnels</SelectItem>
              {options.funnels.map((f) => (<SelectItem key={f} value={f}>{f}</SelectItem>))}
            </SelectContent>
          </Select>
          <Select value={uiState.campaignPath} onValueChange={(v) => updateUiState({ campaignPath: v })}>
            <SelectTrigger className="h-9 w-[170px]"><SelectValue placeholder="Campaign path" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All campaign paths</SelectItem>
              {options.campaignPaths.map((p) => (<SelectItem key={p} value={p}>{p}</SelectItem>))}
            </SelectContent>
          </Select>
          <Select value={uiState.campaignId} onValueChange={(v) => updateUiState({ campaignId: v })}>
            <SelectTrigger className="h-9 w-[150px]"><SelectValue placeholder="Campaign ID" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All campaign IDs</SelectItem>
              {options.campaignIds.map((id) => (<SelectItem key={id} value={id}>{id}</SelectItem>))}
            </SelectContent>
          </Select>
          <Select value={uiState.mediaBuyer} onValueChange={(v) => updateUiState({ mediaBuyer: v })}>
            <SelectTrigger className="h-9 w-[150px]"><SelectValue placeholder="Media buyer" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All media buyers</SelectItem>
              {options.mediaBuyers.map((m) => (<SelectItem key={m} value={m}>{mediaBuyerLabel(m as MediaBuyer)}</SelectItem>))}
            </SelectContent>
          </Select>
          <Select value={uiState.country} onValueChange={(v) => updateUiState({ country: v })}>
            <SelectTrigger className="h-9 w-[130px]"><SelectValue placeholder="Country" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All countries</SelectItem>
              {options.countries.map((c) => (<SelectItem key={c} value={c}>{c}</SelectItem>))}
            </SelectContent>
          </Select>
          <Select value={uiState.hasEmail} onValueChange={(v) => updateUiState({ hasEmail: v as "all" | "has" | "none" })}>
            <SelectTrigger className="h-9 w-[140px]"><SelectValue placeholder="Has email" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Email: any</SelectItem>
              <SelectItem value="has">Has email</SelectItem>
              <SelectItem value="none">No email</SelectItem>
            </SelectContent>
          </Select>
          {hasFilters && (
            <Button variant="ghost" size="sm" onClick={resetUiState} className="h-9">
              <X className="mr-1 h-4 w-4" /> Clear
            </Button>
          )}
        </div>

        <div className="mt-3 text-xs text-muted-foreground">
          {filtered.length.toLocaleString()} of {views.length.toLocaleString()} leads
        </div>

        <div className="mt-3 overflow-x-auto rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Email</TableHead>
                <TableHead>Funnel</TableHead>
                <TableHead>Campaign Path</TableHead>
                <TableHead>Campaign ID</TableHead>
                <TableHead>Media Buyer</TableHead>
                <TableHead>Country</TableHead>
                <TableHead className="whitespace-nowrap">Session Date</TableHead>
                <TableHead className="text-right whitespace-nowrap">Days Since Visit</TableHead>
                <TableHead>Customer/Profile ID</TableHead>
                <TableHead>User Agent</TableHead>
                <TableHead>Origin</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {paged.map((v) => (
                <TableRow key={v.key}>
                  <TableCell className="text-sm">{v.email || "—"}</TableCell>
                  <TableCell className="text-xs">{v.funnel}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{v.campaign_path}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{v.campaign_id}</TableCell>
                  <TableCell className="text-xs">{mediaBuyerLabel(v.media_buyer)}</TableCell>
                  <TableCell className="text-sm tabular-nums">{v.country || "—"}</TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground tabular-nums">{dayKey(v.session_date) || "—"}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{v.days_since_visit ?? "—"}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{v.customer_id}</TableCell>
                  <TableCell className="max-w-[220px] truncate text-xs text-muted-foreground" title={v.user_agent ?? undefined}>{v.user_agent || "—"}</TableCell>
                  <TableCell className="max-w-[220px] truncate text-xs text-muted-foreground" title={v.origin ?? undefined}>{v.origin || "—"}</TableCell>
                </TableRow>
              ))}
              {paged.length === 0 && (
                <TableRow>
                  <TableCell colSpan={11} className="py-10 text-center text-sm text-muted-foreground">
                    {views.length === 0
                      ? "No leads found. Sync FunnelFox leads, or every known contact has a successful payment / active subscription."
                      : "No leads match your filters."}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>

        {filtered.length > PAGE_SIZE && (
          <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
            <span>
              Showing {(safePage - 1) * PAGE_SIZE + 1}–{Math.min(safePage * PAGE_SIZE, filtered.length)} of {filtered.length}
            </span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={safePage <= 1} onClick={() => setPage(safePage - 1)}>Previous</Button>
              <Button variant="outline" size="sm" disabled={safePage >= totalPages} onClick={() => setPage(safePage + 1)}>Next</Button>
            </div>
          </div>
        )}
      </Card>
    </AppLayout>
  );
}
