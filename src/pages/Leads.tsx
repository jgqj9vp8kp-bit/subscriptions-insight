import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, ArrowUpDown, Loader2, Mail, RefreshCw, Stethoscope, Users as UsersIcon, X } from "lucide-react";
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
import { usePersistedPageState } from "@/hooks/usePersistedPageState";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { useAccess } from "@/hooks/useAccess";
import {
  invalidateLeadsQueries,
  invalidateLeadsSyncState,
  leadsSyncStateKey,
  useLeadsList,
  useLeadsOverview,
  useLeadsSyncState,
  type LeadsListQuery,
} from "@/hooks/useLeadsData";
import { mediaBuyerLabel } from "@/services/userMediaBuyer";
import { isSupabaseConfigured } from "@/services/supabaseClient";
import {
  diagnoseFunnelFoxLeadsSync,
  futureMs,
  runFunnelFoxLeadsSync,
  LEADS_SYNC_LIMIT,
  LEADS_SYNC_MAX_PAGES,
  MANUAL_SYNC_MAX_STEPS,
  type FunnelFoxLeadsSyncResponse,
  type FunnelFoxLeadsSyncState,
  type FunnelFoxLeadsSyncSummary,
} from "@/services/funnelfoxLeads";
import type { MediaBuyer } from "@/services/types";
import type {
  LeadRow,
  LeadSource,
  LeadsDeclineFilter,
  LeadsFilterOption,
  LeadsSortDirection,
  LeadsSortKey,
} from "../../supabase/functions/_shared/clickhouse/leadsContract";

const FILTER_DEBOUNCE_MS = 300;
const PAGE_SIZE = 50;

const SOURCE_LABELS: Record<LeadSource, string> = {
  warehouse: "Warehouse",
  funnelfox_profile: "FunnelFox profile",
  both: "Warehouse + FunnelFox",
  funnelfox_subscription: "FunnelFox subscription",
};
const SOURCE_ORDER = Object.keys(SOURCE_LABELS) as LeadSource[];

type SourceFilter = "all" | LeadSource;

/** Columns the server may sort by (subset of the contract's allowlist). */
const SORTABLE_KEYS: readonly LeadsSortKey[] = [
  "email",
  "lead_date",
  "funnel",
  "campaign_path",
  "campaign_id",
  "media_buyer",
  "country",
  "session_date",
  "days_since_visit",
  "customer_id",
  "source",
  "decline_reason",
];
/** Text columns start A→Z; dates and numbers start newest / largest first. */
const ASC_FIRST_KEYS: ReadonlySet<LeadsSortKey> = new Set<LeadsSortKey>([
  "email",
  "funnel",
  "campaign_path",
  "campaign_id",
  "media_buyer",
  "country",
  "customer_id",
  "source",
  "decline_reason",
]);

const DEFAULT_LEADS_UI_STATE = {
  search: "",
  dateFrom: "",
  dateTo: "",
  funnel: "all",
  campaignPath: "all",
  campaignId: "all",
  mediaBuyer: "all",
  country: "all",
  source: "all" as SourceFilter,
  declines: "all" as LeadsDeclineFilter,
  sortKey: "lead_date" as LeadsSortKey,
  sortDir: "desc" as LeadsSortDirection,
};

export type LeadsUiState = typeof DEFAULT_LEADS_UI_STATE;

function dayKey(value: string | null): string {
  return value ? value.slice(0, 10) : "";
}

/** "YYYY-MM-DD HH:mm" in the viewer's local time, or "" for a missing/invalid value. */
export function formatLeadDateTime(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** "Updated N min ago." for the lead set's candidates (computed on the server,
 * refreshed every 5 minutes); "" when the time is unknown. Pure + exported for tests. */
export function candidatesUpdatedText(computedAt: string | null, now: number): string {
  const ms = computedAt ? Date.parse(computedAt) : Number.NaN;
  if (!Number.isFinite(ms) || !Number.isFinite(now)) return "";
  const minutes = Math.max(0, Math.floor((now - ms) / 60_000));
  return minutes < 1 ? "Updated just now." : `Updated ${minutes.toLocaleString()} min ago.`;
}

function isLeadSource(value: unknown): value is LeadSource {
  return typeof value === "string" && value in SOURCE_LABELS;
}

/** The leads_list request for the (debounced) UI state + page. Persisted values
 * from an older build (e.g. the removed Email any/has/none filter, an unknown
 * source or sort key) are ignored rather than sent. Pure + exported for tests. */
export function leadsQueryFromUi(ui: LeadsUiState, page: number, pageSize: number = PAGE_SIZE): LeadsListQuery {
  const one = (value: string | undefined) => (value && value !== "all" ? [value] : []);
  const sortKey = SORTABLE_KEYS.includes(ui.sortKey) ? ui.sortKey : "lead_date";
  return {
    filters: {
      search: ui.search ?? "",
      date_from: ui.dateFrom || null,
      date_to: ui.dateTo || null,
      funnel: one(ui.funnel),
      campaign_path: one(ui.campaignPath),
      campaign_id: one(ui.campaignId),
      media_buyer: one(ui.mediaBuyer),
      country: one(ui.country),
      source: isLeadSource(ui.source) ? ui.source : "all",
      has_declines: ui.declines === "has" || ui.declines === "none" ? ui.declines : "all",
    },
    sort: { key: sortKey, dir: ui.sortDir === "asc" ? "asc" : "desc" },
    page,
    page_size: pageSize,
  };
}

/** Warehouse decline codes (insufficient_funds) → "Insufficient Funds". */
function declineLabel(reason: string | null): string {
  if (!reason) return "";
  return reason
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatCount(value: number | null | undefined): string {
  return (typeof value === "number" && Number.isFinite(value) ? value : 0).toLocaleString();
}

/** The options of one filter, keeping a persisted selection that the current set no longer has. */
function optionsWithSelection(options: LeadsFilterOption[] | undefined, selected: string): LeadsFilterOption[] {
  const list = options ?? [];
  if (selected && selected !== "all" && !list.some((option) => option.value === selected)) return [...list, { value: selected, count: 0 }];
  return list;
}

function optionText(label: string, count: number): string {
  return count > 0 ? `${label} (${count.toLocaleString()})` : label;
}

/** One line under the sync card after a manual Continue / Full Resync. */
function describeSyncOutcome(last: FunnelFoxLeadsSyncResponse, steps: number): string {
  if (last.status === "busy" || last.busy) {
    return "Another sync call is running right now (usually the background tick); it continues on its own.";
  }
  if (last.rate_limited) {
    const until = formatLeadDateTime(last.rate_limited_until ?? null);
    return `FunnelFox rate-limited the sync${until ? ` until ${until}` : ""}; it resumes automatically.`;
  }
  if (last.idle) return "Everything is already synced; the daily refresh re-crawls FunnelFox.";
  if (last.all_stages_completed) return "Sync completed.";
  if (steps >= MANUAL_SYNC_MAX_STEPS) {
    return `Stopped after ${MANUAL_SYNC_MAX_STEPS} steps; the background sync continues every minute.`;
  }
  if (last.made_progress === false) return "The last call advanced nothing; the background sync retries every minute.";
  return "Sync is partial; the background sync continues every minute.";
}

function SortHead({
  label,
  column,
  sortKey,
  sortDir,
  onSort,
  className,
}: {
  label: string;
  column: LeadsSortKey;
  sortKey: LeadsSortKey;
  sortDir: LeadsSortDirection;
  onSort: (column: LeadsSortKey) => void;
  className?: string;
}) {
  const active = sortKey === column;
  const icon = !active ? <ArrowUpDown className="h-3 w-3 opacity-40" /> : sortDir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />;
  return (
    <TableHead className={className} aria-sort={active ? (sortDir === "asc" ? "ascending" : "descending") : undefined}>
      <button type="button" onClick={() => onSort(column)} className="inline-flex items-center gap-1 whitespace-nowrap hover:text-foreground">
        {label}
        {icon}
      </button>
    </TableHead>
  );
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span>
      {label} <b className="text-foreground">{children}</b>
    </span>
  );
}

/** The Leads content (sync block, KPI cards, filterable table). Rendered as the
 * "Leads" tab of the Users page; `embedded` drops the card shadows so it sits
 * flush inside that page's card. The standalone page below wraps it in AppLayout
 * (the /leads route itself now redirects to /users?tab=leads).
 *
 * The lead set is merged on the server (clickhouse-users leads_list /
 * leads_overview): filters, sort and pagination run there, so opening the tab
 * no longer hydrates the raw warehouse into the browser. */
export function LeadsPanel({ embedded = false }: { embedded?: boolean }) {
  const cardShadow = embedded ? "shadow-none" : "shadow-card";
  const queryClient = useQueryClient();
  // The tab is data-owner only (the leads actions are rawOnly + users.view +
  // users.pii.view + leads.view). The sync buttons and the Diagnose dry run need
  // admin.sync.run on top (funnelfox-leads-sync policy). Owner / legacy: all true.
  const access = useAccess();
  const canSync = access.rawAccess && access.can("admin.sync.run");
  const canReadLeads =
    access.rawAccess && access.can("leads.view") && access.can("users.view") && access.can("users.pii.view");

  const [uiState, setUiState, resetUiState] = usePersistedPageState("ui_state_leads", DEFAULT_LEADS_UI_STATE);
  const [applied, isFiltering] = useDebouncedValue(uiState, FILTER_DEBOUNCE_MS);

  // The page belongs to one applied filter/sort set: any change starts again at page 1
  // (derived, so the new filters never go out with the old page first).
  const [pageState, setPageState] = useState<{ scope: LeadsUiState; page: number }>({ scope: applied, page: 1 });
  const page = pageState.scope === applied ? pageState.page : 1;
  const setPage = (next: number) => setPageState({ scope: applied, page: next });

  const listQuery = useMemo(() => leadsQueryFromUi(applied, page), [applied, page]);
  const list = useLeadsList(listQuery, { enabled: canReadLeads });
  const overview = useLeadsOverview({ enabled: canReadLeads });
  const syncStateQuery = useLeadsSyncState({ enabled: isSupabaseConfigured && access.rawAccess });

  const [syncing, setSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState<{ step: number; stage: string | null; status: string } | null>(null);
  const [syncNote, setSyncNote] = useState<string | null>(null);
  const [diagnosing, setDiagnosing] = useState(false);
  const [diagnostics, setDiagnostics] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const syncingRef = useRef(false);
  // last_full_sync_at last seen by this panel (undefined until the state row first loads).
  const lastFullSyncRef = useRef<string | null | undefined>(undefined);

  const runSync = useCallback(
    async (fullReset: boolean) => {
      if (!canSync) return;
      syncingRef.current = true;
      setSyncing(true);
      setError(null);
      setSyncNote(null);
      setSyncProgress(null);
      let steps = 0;
      try {
        const last = await runFunnelFoxLeadsSync({
          fullReset,
          limit: LEADS_SYNC_LIMIT,
          maxPages: LEADS_SYNC_MAX_PAGES,
          maxSteps: MANUAL_SYNC_MAX_STEPS,
          onProgress: (res, step) => {
            steps = step;
            setSyncProgress({ step, stage: res.stage ?? null, status: res.status });
            void invalidateLeadsSyncState(queryClient);
          },
        });
        setSyncNote(describeSyncOutcome(last, steps));
      } catch (e) {
        setError(e instanceof Error ? e.message : "Sync failed.");
      } finally {
        setSyncing(false);
        setSyncProgress(null);
        // New profiles / reconciled conversion: refetch the list, KPIs and state
        // (the next list / overview request also rebuilds the server's merged set,
        // and recomputes its Postgres candidates unless they are under a minute old).
        await invalidateLeadsQueries(queryClient);
        // This click already refreshed everything: the pass it may have completed
        // must not trigger the "background pass finished" refresh below again.
        const fresh = queryClient.getQueryData<FunnelFoxLeadsSyncState | null>(leadsSyncStateKey(access.partition));
        if (fresh !== undefined) lastFullSyncRef.current = fresh?.last_full_sync_at ?? null;
        syncingRef.current = false;
      }
    },
    [canSync, queryClient, access.partition],
  );

  const handleContinue = useCallback(() => runSync(false), [runSync]);
  const handleFullResync = useCallback(() => runSync(true), [runSync]);

  const handleDiagnose = useCallback(async () => {
    if (!canSync) return;
    setDiagnosing(true);
    setError(null);
    try {
      const res = await diagnoseFunnelFoxLeadsSync();
      setDiagnostics(res.diagnostics ?? { note: "The dry run returned no diagnostics." });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Diagnose failed.");
    } finally {
      setDiagnosing(false);
    }
  }, [canSync]);

  const handleRefresh = useCallback(() => {
    void invalidateLeadsQueries(queryClient);
  }, [queryClient]);

  // ---- sync state: the polled state row, the overview's sanitized copy as fallback ----
  const syncRow = syncStateQuery.data ?? null;
  const serverSync = overview.data?.sync_state ?? null;
  const stats: FunnelFoxLeadsSyncSummary | null = syncRow?.stats ?? (serverSync ? (serverSync.stats as FunnelFoxLeadsSyncSummary) : null);
  const lastSyncAt = syncRow ? syncRow.last_full_sync_at : serverSync?.last_full_sync_at ?? null;
  const rawStatus = syncRow ? syncRow.last_status : serverSync?.status ?? null;

  // The background tick finished a full pass while the tab is open: the lead set changed.
  const observedLastFullSync = syncStateQuery.isSuccess ? syncRow?.last_full_sync_at ?? null : undefined;
  useEffect(() => {
    if (observedLastFullSync === undefined) return;
    const previous = lastFullSyncRef.current;
    lastFullSyncRef.current = observedLastFullSync;
    if (previous !== undefined && previous !== observedLastFullSync && !syncingRef.current) {
      void invalidateLeadsQueries(queryClient);
    }
  }, [observedLastFullSync, queryClient]);

  const now = Date.now();
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
  const currentStageLabel = syncRow?.current_stage ?? serverSync?.current_stage ?? stats?.stage ?? null;
  const coverageWarningMessage = stats?.coverage_warning ? stats.coverage_warning_message ?? "" : "";
  const hasSavedCursor = Boolean(syncRow?.last_profiles_cursor || syncRow?.last_sessions_cursor);
  const rateLimitedUntilMs = futureMs((syncRow ? stats?.rate_limited_until : serverSync?.rate_limited_until) ?? null, now);
  // After FunnelFox errors the background tick backs off (a click still runs at once).
  const errorBackoffUntilMs = rawStatus === "error" ? futureMs(stats?.error_backoff_until ?? null, now) : null;
  // The polled row is fresher than the overview's copy (cached up to 5 minutes).
  const running = syncRow ? futureMs(syncRow.lease_until ?? null, now) != null : serverSync?.running === true;
  // The overview may be minutes old: a hint already in the past says nothing.
  const nextTickMs = futureMs(serverSync?.next_tick_hint ?? null, now);

  // ---- KPIs, options, rows ----
  const summary = overview.data?.summary ?? null;
  const filterOptions = overview.data?.filter_options ?? null;
  const kpi = (value: number | undefined) => (value == null ? "—" : value.toLocaleString());
  const rows: LeadRow[] = list.data?.rows ?? [];
  const pagination = list.data?.pagination ?? null;
  const totalRows = pagination?.total_rows ?? 0;
  const totalPages = Math.max(1, pagination?.total_pages ?? 1);
  const currentPage = Math.min(pagination?.page ?? page, totalPages);
  const pageSize = pagination?.page_size ?? PAGE_SIZE;
  const listError = list.error instanceof Error ? list.error.message : list.error ? "Leads request failed." : null;
  const overviewError = overview.error instanceof Error ? overview.error.message : overview.error ? "Leads overview request failed." : null;
  // The server keeps only the newest N leads (by lead date); when older ones were left out, say so.
  const leadSetDiagnostics = overview.data?.diagnostics ?? list.data?.diagnostics ?? null;
  const recentLimit = leadSetDiagnostics?.lead_set_limited
    ? {
        limit: leadSetDiagnostics.lead_set_limit ?? summary?.total_leads ?? 0,
        since: formatLeadDateTime(leadSetDiagnostics.lead_set_oldest_date ?? null),
        updated: candidatesUpdatedText(leadSetDiagnostics.candidates_computed_at ?? null, now),
      }
    : null;
  const initialLoading = canReadLeads && list.data == null && list.isFetching;

  const updateUiState = (patch: Partial<LeadsUiState>) => setUiState((current) => ({ ...current, ...patch }));
  const toggleSort = (column: LeadsSortKey) => {
    if (uiState.sortKey === column) updateUiState({ sortDir: uiState.sortDir === "asc" ? "desc" : "asc" });
    else updateUiState({ sortKey: column, sortDir: ASC_FIRST_KEYS.has(column) ? "asc" : "desc" });
  };
  const sortProps = { sortKey: uiState.sortKey, sortDir: uiState.sortDir, onSort: toggleSort };

  const hasFilters =
    uiState.search || uiState.dateFrom || uiState.dateTo || uiState.funnel !== "all" || uiState.campaignPath !== "all" ||
    uiState.campaignId !== "all" || uiState.mediaBuyer !== "all" || uiState.country !== "all" || uiState.source !== "all" ||
    uiState.declines !== "all";

  const funnelOptions = optionsWithSelection(filterOptions?.funnel, uiState.funnel);
  const campaignPathOptions = optionsWithSelection(filterOptions?.campaign_path, uiState.campaignPath);
  const campaignIdOptions = optionsWithSelection(filterOptions?.campaign_id, uiState.campaignId);
  const mediaBuyerOptions = optionsWithSelection(filterOptions?.media_buyer, uiState.mediaBuyer);
  const countryOptions = optionsWithSelection(filterOptions?.country, uiState.country);
  const sourceCounts = new Map((filterOptions?.source ?? []).map((option) => [option.value, option.count]));
  const busy = syncing || diagnosing;
  const columnCount = 14;

  return (
    <>
      {/* Sync block */}
      <Card className={`mb-4 p-4 ${cardShadow}`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm">
            <div className="font-medium">FunnelFox Leads sync</div>
            <div className="text-xs text-muted-foreground">
              {lastSyncAt ? `Last full sync ${new Date(lastSyncAt).toLocaleString()}` : "Never fully synced"}
              {" · status "}
              <span className={statusClass}>{syncStatusLabel}</span>
              {currentStageLabel ? ` · stage ${currentStageLabel}` : ""}
              {running ? " · running now" : ""}
            </div>
            <div className="text-xs text-muted-foreground">
              Background sync runs every minute; a full refresh runs daily.
              {nextTickMs != null ? ` Next background tick ≈ ${formatLeadDateTime(new Date(nextTickMs).toISOString())}.` : ""}
            </div>
          </div>
          {canSync && (
            <div className="flex flex-wrap gap-2">
              <Button onClick={handleContinue} disabled={busy || !isSupabaseConfigured} size="sm">
                {syncing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                Continue Sync
              </Button>
              <Button onClick={handleFullResync} disabled={busy || !isSupabaseConfigured} size="sm" variant="outline">
                Full Resync
              </Button>
              <Button onClick={handleDiagnose} disabled={busy || !isSupabaseConfigured} size="sm" variant="ghost">
                {diagnosing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Stethoscope className="mr-2 h-4 w-4" />}
                Diagnose
              </Button>
            </div>
          )}
        </div>

        {error && <div className="mt-2 text-xs text-destructive">{error}</div>}
        {syncProgress && (
          <div className="mt-2 text-xs text-muted-foreground">
            Step {syncProgress.step}/{MANUAL_SYNC_MAX_STEPS}
            {syncProgress.stage ? ` · stage ${syncProgress.stage}` : ""} · status {syncProgress.status}
          </div>
        )}
        {syncNote && !syncing && <div className="mt-2 text-xs text-muted-foreground">{syncNote}</div>}

        {rateLimitedUntilMs != null && (
          <div className="mt-2 text-xs text-warning">
            FunnelFox rate-limited the sync until {formatLeadDateTime(new Date(rateLimitedUntilMs).toISOString())}; it resumes automatically.
          </div>
        )}
        {errorBackoffUntilMs != null && (
          <div className="mt-2 text-xs text-destructive">
            The last sync call failed{syncRow?.last_error ? `: ${syncRow.last_error}` : "."} The background sync retries after{" "}
            {formatLeadDateTime(new Date(errorBackoffUntilMs).toISOString())}; the daily refresh restarts the pipeline.
          </div>
        )}

        {isPartial && (
          <div className="mt-2 rounded-md border border-warning/40 bg-warning/10 p-2 text-xs text-foreground">
            Sync is partial. The background sync continues from the last cursor every minute
            {canSync ? (
              <>
                ; click <b>Continue Sync</b> to run up to {MANUAL_SYNC_MAX_STEPS} steps now.
              </>
            ) : (
              "."
            )}
            {coverageWarningMessage ? <div className="mt-1 text-muted-foreground">{coverageWarningMessage}</div> : null}
          </div>
        )}
        {!isPartial && coverageWarningMessage && (
          <div className="mt-2 text-xs text-warning">{coverageWarningMessage}</div>
        )}

        {stats && (
          <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-muted-foreground sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
            <Stat label="Profiles scanned:">{formatCount(stats.profiles_scanned_total ?? stats.profiles_scanned)}</Stat>
            <Stat label="Profiles saved:">{formatCount(stats.profiles_total_saved)}</Stat>
            <Stat label="With email:">{formatCount(stats.profiles_with_email)}</Stat>
            <Stat label="Without email:">{formatCount(stats.profiles_without_email)}</Stat>
            <Stat label="Preview excluded:">{formatCount(stats.preview_excluded)}</Stat>
            <Stat label="Sessions scanned:">{formatCount(stats.sessions_scanned_total ?? stats.sessions_scanned)}</Stat>
            <Stat label="Sessions joined:">{formatCount(stats.sessions_joined)}</Stat>
            <Stat label="Leads found:">{formatCount(stats.leads_found)}</Stat>
            {syncRow && <Stat label="Last cursor exists:">{hasSavedCursor ? "yes" : "no"}</Stat>}
            <Stat label="Stopped reason:">{stats.sync_stopped_reason ?? "—"}</Stat>
            <Stat label="Coverage:">{stats.profiles_coverage_percent != null ? `${stats.profiles_coverage_percent}%` : "total profiles unknown"}</Stat>
          </div>
        )}

        {diagnostics && (
          <div className="mt-3 rounded-md border border-border bg-muted/40 p-2">
            <div className="flex items-center justify-between gap-2 text-xs font-medium">
              <span>Diagnose (dry run: key names and counts only, nothing written)</span>
              <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => setDiagnostics(null)} aria-label="Close diagnostics">
                <X className="h-4 w-4" />
              </Button>
            </div>
            <pre data-testid="leads-diagnose-output" className="mt-1 max-h-80 overflow-auto whitespace-pre-wrap break-all text-[11px] leading-snug text-muted-foreground">
              {JSON.stringify(diagnostics, null, 2)}
            </pre>
          </div>
        )}
      </Card>

      {/* Summary cards */}
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <KpiCard label="Total Leads" value={kpi(summary?.total_leads)} icon={<UsersIcon className="h-4 w-4" />} />
        <KpiCard label="Emails Found" value={kpi(summary?.emails_found)} icon={<Mail className="h-4 w-4" />} accent="accent" />
        <KpiCard label="Converted Excluded" value={kpi(summary?.converted_excluded)} accent="success" />
        <KpiCard label="Active Subs Excluded" value={kpi(summary?.active_subs_excluded)} accent="warning" />
        <KpiCard label="Leads Today" value={kpi(summary?.leads_today)} />
        <KpiCard label="Leads Last 7 Days" value={kpi(summary?.leads_last_7_days)} />
      </div>

      <Card className={`p-4 ${cardShadow}`}>
        {!canReadLeads ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            The lead list is available to the data owner with the Users, User personal data and Leads permissions.
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              {(isFiltering || list.isFetching || overview.isFetching) && (
                <span className="order-last ml-auto flex items-center gap-1 text-xs text-primary">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Updating results…
                </span>
              )}
              <Input
                placeholder="Search email or ID…"
                value={uiState.search}
                onChange={(e) => updateUiState({ search: e.target.value })}
                className="h-9 w-[200px]"
              />
              <Input type="date" value={uiState.dateFrom} onChange={(e) => updateUiState({ dateFrom: e.target.value })} className="h-9 w-[150px]" aria-label="Lead date from" />
              <Input type="date" value={uiState.dateTo} onChange={(e) => updateUiState({ dateTo: e.target.value })} className="h-9 w-[150px]" aria-label="Lead date to" />
              <Select value={uiState.funnel} onValueChange={(v) => updateUiState({ funnel: v })}>
                <SelectTrigger className="h-9 w-[150px]" aria-label="Funnel"><SelectValue placeholder="Funnel" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All funnels</SelectItem>
                  {funnelOptions.map((o) => (<SelectItem key={o.value} value={o.value}>{optionText(o.value, o.count)}</SelectItem>))}
                </SelectContent>
              </Select>
              <Select value={uiState.campaignPath} onValueChange={(v) => updateUiState({ campaignPath: v })}>
                <SelectTrigger className="h-9 w-[170px]" aria-label="Campaign path"><SelectValue placeholder="Campaign path" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All campaign paths</SelectItem>
                  {campaignPathOptions.map((o) => (<SelectItem key={o.value} value={o.value}>{optionText(o.value, o.count)}</SelectItem>))}
                </SelectContent>
              </Select>
              <Select value={uiState.campaignId} onValueChange={(v) => updateUiState({ campaignId: v })}>
                <SelectTrigger className="h-9 w-[150px]" aria-label="Campaign ID"><SelectValue placeholder="Campaign ID" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All campaign IDs</SelectItem>
                  {campaignIdOptions.map((o) => (<SelectItem key={o.value} value={o.value}>{optionText(o.value, o.count)}</SelectItem>))}
                </SelectContent>
              </Select>
              <Select value={uiState.mediaBuyer} onValueChange={(v) => updateUiState({ mediaBuyer: v })}>
                <SelectTrigger className="h-9 w-[150px]" aria-label="Media buyer"><SelectValue placeholder="Media buyer" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All media buyers</SelectItem>
                  {mediaBuyerOptions.map((o) => (<SelectItem key={o.value} value={o.value}>{optionText(mediaBuyerLabel(o.value as MediaBuyer), o.count)}</SelectItem>))}
                </SelectContent>
              </Select>
              <Select value={uiState.country} onValueChange={(v) => updateUiState({ country: v })}>
                <SelectTrigger className="h-9 w-[130px]" aria-label="Country"><SelectValue placeholder="Country" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All countries</SelectItem>
                  {countryOptions.map((o) => (<SelectItem key={o.value} value={o.value}>{optionText(o.value, o.count)}</SelectItem>))}
                </SelectContent>
              </Select>
              <Select value={isLeadSource(uiState.source) ? uiState.source : "all"} onValueChange={(v) => updateUiState({ source: v as SourceFilter })}>
                <SelectTrigger className="h-9 w-[190px]" aria-label="Source"><SelectValue placeholder="Source" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Source: any</SelectItem>
                  {SOURCE_ORDER.map((source) => (
                    <SelectItem key={source} value={source}>{optionText(SOURCE_LABELS[source], sourceCounts.get(source) ?? 0)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={uiState.declines} onValueChange={(v) => updateUiState({ declines: v as LeadsDeclineFilter })}>
                <SelectTrigger className="h-9 w-[150px]" aria-label="Declines"><SelectValue placeholder="Declines" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Declines: any</SelectItem>
                  <SelectItem value="has">Has declines</SelectItem>
                  <SelectItem value="none">No declines</SelectItem>
                </SelectContent>
              </Select>
              {hasFilters && (
                <Button variant="ghost" size="sm" onClick={resetUiState} className="h-9">
                  <X className="mr-1 h-4 w-4" /> Clear
                </Button>
              )}
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>
                {summary
                  ? `${totalRows.toLocaleString()} of ${summary.total_leads.toLocaleString()} leads`
                  : `${totalRows.toLocaleString()} leads`}
              </span>
              <Button variant="ghost" size="sm" className="h-7 px-2" onClick={handleRefresh} disabled={list.isFetching} aria-label="Refresh leads">
                <RefreshCw className="h-3 w-3" />
              </Button>
            </div>

            {(listError || overviewError) && (
              <div className="mt-2 text-xs text-destructive">
                {listError ? `Could not load leads: ${listError}` : `Could not load the leads overview: ${overviewError}`}
              </div>
            )}

            {recentLimit && (
              <div data-testid="leads-recent-limit" className="mt-2 rounded-md border border-border bg-muted/40 p-2 text-xs text-muted-foreground">
                Showing the latest {recentLimit.limit.toLocaleString()} leads{recentLimit.since ? ` (since ${recentLimit.since})` : ""}.
                {" "}Search, filters and the lead counts cover these leads only.
                {recentLimit.updated ? ` ${recentLimit.updated}` : ""}
              </div>
            )}

            <div className="mt-3 overflow-x-auto rounded-lg border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <SortHead label="Email" column="email" {...sortProps} />
                    <SortHead label="Lead Date" column="lead_date" className="whitespace-nowrap" {...sortProps} />
                    <SortHead label="Funnel" column="funnel" {...sortProps} />
                    <SortHead label="Campaign Path" column="campaign_path" {...sortProps} />
                    <SortHead label="Campaign ID" column="campaign_id" {...sortProps} />
                    <SortHead label="Media Buyer" column="media_buyer" {...sortProps} />
                    <SortHead label="Country" column="country" {...sortProps} />
                    <SortHead label="Session Date" column="session_date" className="whitespace-nowrap" {...sortProps} />
                    <SortHead label="Days Since Visit" column="days_since_visit" className="text-right whitespace-nowrap" {...sortProps} />
                    <SortHead label="Customer/Profile ID" column="customer_id" {...sortProps} />
                    <TableHead>User Agent</TableHead>
                    <TableHead>Origin</TableHead>
                    <SortHead label="Source" column="source" {...sortProps} />
                    <SortHead label="Decline" column="decline_reason" {...sortProps} />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => (
                    <TableRow key={row.key}>
                      <TableCell className="text-sm">{row.email || "—"}</TableCell>
                      <TableCell className="whitespace-nowrap text-xs tabular-nums">{formatLeadDateTime(row.lead_date) || "—"}</TableCell>
                      <TableCell className="text-xs">{row.funnel || "—"}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{row.campaign_path || "—"}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{row.campaign_id || "—"}</TableCell>
                      <TableCell className="text-xs">{row.media_buyer ? mediaBuyerLabel(row.media_buyer as MediaBuyer) : "—"}</TableCell>
                      <TableCell className="text-sm tabular-nums">{row.country || "—"}</TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground tabular-nums">{dayKey(row.session_date) || "—"}</TableCell>
                      <TableCell className="text-right tabular-nums text-sm">{row.days_since_visit ?? "—"}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{row.customer_id || "—"}</TableCell>
                      <TableCell className="max-w-[220px] truncate text-xs text-muted-foreground" title={row.user_agent ?? undefined}>{row.user_agent || "—"}</TableCell>
                      <TableCell className="max-w-[220px] truncate text-xs text-muted-foreground" title={row.origin ?? undefined}>{row.origin || "—"}</TableCell>
                      <TableCell className="whitespace-nowrap text-xs">{isLeadSource(row.source) ? SOURCE_LABELS[row.source] : row.source}</TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{row.has_declines ? declineLabel(row.decline_reason) || "Yes" : "—"}</TableCell>
                    </TableRow>
                  ))}
                  {rows.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={columnCount} className="py-10 text-center text-sm text-muted-foreground">
                        {initialLoading
                          ? "Loading leads…"
                          : listError
                            ? "Leads could not be loaded."
                            : summary && summary.total_leads === 0
                              ? "No leads found. Every known contact has a successful payment / active subscription, or FunnelFox is not synced yet."
                              : "No leads match your filters."}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>

            {totalPages > 1 && (
              <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  Showing {((currentPage - 1) * pageSize + 1).toLocaleString()}–{Math.min(currentPage * pageSize, totalRows).toLocaleString()} of {totalRows.toLocaleString()}
                </span>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" disabled={currentPage <= 1 || list.isFetching} onClick={() => setPage(currentPage - 1)}>Previous</Button>
                  <Button variant="outline" size="sm" disabled={currentPage >= totalPages || list.isFetching} onClick={() => setPage(currentPage + 1)}>Next</Button>
                </div>
              </div>
            )}
          </>
        )}
      </Card>
    </>
  );
}

export default function LeadsPage() {
  return (
    <AppLayout title="Leads" description="Emails captured with no successful payment and no active subscription">
      <LeadsPanel />
    </AppLayout>
  );
}
