import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { AlertCircle, FileSpreadsheet, Inbox, Loader2, MailCheck, RefreshCw, Search } from "lucide-react";
import { AppLayout } from "@/components/AppLayout";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
import { useToast } from "@/hooks/use-toast";
import { usePersistedPageState } from "@/hooks/usePersistedPageState";
import { useAuth } from "@/hooks/useAuth";
import { invalidateSupportAnalyticsCache, useSupportWarehouseVersion } from "@/hooks/useAnalyticsCache";
import { useSupportData } from "@/hooks/useSupportCache";
import { hashUserScope } from "@/services/analyticsCache";
import {
  getSupportMailStatus,
  syncSupportMail,
  type SupportMailSyncAction,
  type SyncSupportMailSummary,
} from "@/services/supportInbox";
import {
  SUPPORT_CATEGORIES,
  SUPPORT_URGENCIES,
  importSupportFile,
  listSupportImportBatches,
  parseSupportFile,
  resetSupportRequestManualClassification,
  updateSupportRequestManualClassification,
  type SupportAnalyticsFilters,
  type SupportCategory,
  type SupportImportSummary,
  type SupportLanguage,
  type SupportParseResult,
  type SupportRequestDetailRow,
  type SupportRequestSummaryRow,
  type SupportUrgency,
} from "@/services/supportAnalytics";
import {
  EMPTY_CAMPAIGN_PATH,
  loadSupportDetails,
  syncSupportToClickHouse,
  type SupportQuery,
} from "@/services/supportDataSource";

const PAGE_SIZE = 50;
const CATEGORY_COLORS = ["#2563eb", "#dc2626", "#f59e0b", "#059669", "#7c3aed", "#0891b2", "#be123c", "#64748b"];

const EMPTY_DASHBOARD = {
  rows: [],
  kpis: {
    totalRequests: 0,
    uniqueSenders: 0,
    matchedCustomers: 0,
    unmatchedRequests: 0,
    cancellationRequests: 0,
    refundRequests: 0,
    unauthorizedChargeRequests: 0,
    productNotReceivedRequests: 0,
    paymentIssues: 0,
    highPriorityRequests: 0,
    requestsPerDay: 0,
    matchedPct: 0,
    cancellationPct: 0,
    refundPct: 0,
    paymentRelatedPct: 0,
  },
  byDay: [],
  funnelTrend: [],
  categoryTrend: [],
  operationalTrend: [],
  languageDistribution: [],
  matchDistribution: [],
  priorityDistribution: [],
  categoryRanking: [],
  subcategoryRanking: [],
  funnelRanking: [],
  campaignPathRanking: [],
  matching: {
    matchedByEmail: 0,
    matchedByName: 0,
    unmatched: 0,
    emailPresentNoMatchedContact: 0,
    matchedContactNoEmail: 0,
    duplicateNormalizedEmails: 0,
    multipleSenderNamesForOneEmail: 0,
  },
  insights: [],
};

const DEFAULT_FILTERS: SupportAnalyticsFilters = {
  dateFrom: "",
  dateTo: "",
  category: "all",
  subcategory: "",
  language: "all",
  urgency: "all",
  matchStatus: "all",
  requiresCancellation: "all",
  requiresRefund: "all",
  paymentRelated: "all",
  deliveryRelated: "all",
  manualStatus: "all",
  search: "",
  importBatchId: "",
  funnel: [],
  campaignPath: [],
};

type SupportSortState = Pick<SupportQuery, "sortBy" | "sortDir">;

function formatDate(value: string | null | undefined): string {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatDateOnly(value: string | null | undefined): string {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString().slice(0, 10);
}

function formatPct(value: number): string {
  return `${value.toFixed(1)}%`;
}

function boolFilterValue(value: boolean | "all" | undefined): string {
  return value === true ? "true" : value === false ? "false" : "all";
}

function parseBoolFilter(value: string): boolean | "all" {
  if (value === "true") return true;
  if (value === "false") return false;
  return "all";
}

type SupportDisplayRow = {
  manual_category?: string | null;
  manual_subcategory?: string | null;
  manual_urgency?: string | null;
  category: string;
  subcategory: string;
  urgency: string;
  requires_cancellation?: boolean;
  requires_refund?: boolean;
  payment_related?: boolean;
  delivery_related?: boolean;
  possible_unauthorized_charge?: boolean;
  duplicate_charge?: boolean;
};

function effectiveCategory(row: SupportDisplayRow): SupportCategory {
  return (row.manual_category ?? row.category) as SupportCategory;
}

function effectiveSubcategory(row: SupportDisplayRow): string {
  return row.manual_subcategory ?? row.subcategory;
}

function effectiveUrgency(row: SupportDisplayRow): SupportUrgency {
  return (row.manual_urgency ?? row.urgency) as SupportUrgency;
}

function flagsFor(row: SupportDisplayRow): string[] {
  return [
    row.requires_cancellation ? "Cancel" : null,
    row.requires_refund ? "Refund" : null,
    row.payment_related ? "Payment" : null,
    row.delivery_related ? "Delivery" : null,
    row.possible_unauthorized_charge ? "Charge" : null,
    row.duplicate_charge ? "Duplicate" : null,
  ].filter((value): value is string => Boolean(value));
}

function StatCard({ label, value, caption }: { label: string; value: string | number; caption?: string }) {
  return (
    <Card className="p-4 shadow-card">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-foreground">{value}</p>
      {caption && <p className="mt-1 text-xs text-muted-foreground">{caption}</p>}
    </Card>
  );
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card className="p-4 shadow-card">
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      <div className="mt-3 h-64">{children}</div>
    </Card>
  );
}

function ImportSummary({ summary }: { summary: SupportImportSummary | null }) {
  if (!summary) return null;
  return (
    <div className="grid gap-2 rounded-md border border-border bg-muted/30 p-3 text-xs sm:grid-cols-2 lg:grid-cols-6">
      <div><span className="text-muted-foreground">Rows</span><div className="font-medium">{summary.total_rows}</div></div>
      <div><span className="text-muted-foreground">Inserted</span><div className="font-medium">{summary.inserted_rows}</div></div>
      <div><span className="text-muted-foreground">Skipped</span><div className="font-medium">{summary.skipped_rows}</div></div>
      <div><span className="text-muted-foreground">Invalid</span><div className="font-medium">{summary.invalid_rows}</div></div>
      <div><span className="text-muted-foreground">Matched</span><div className="font-medium">{summary.matched_rows}</div></div>
      <div><span className="text-muted-foreground">Date range</span><div className="font-medium">{summary.date_range.from ?? "-"}{" -> "}{summary.date_range.to ?? "-"}</div></div>
    </div>
  );
}

function formatDuration(ms: number | null | undefined): string {
  if (!ms || !Number.isFinite(ms)) return "-";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${Math.round((ms / 1000) * 10) / 10}s`;
}

function statusLabel(status: string | null | undefined): string {
  return status ? status.replace(/_/g, " ") : "unknown";
}

function mailActiveStatusLabel(status: string | null | undefined, historyComplete: boolean, isPending: boolean): string {
  if (isPending && !historyComplete) return "Importing history";
  if (historyComplete && (!status || ["idle", "completed"].includes(status))) return "Watching for new mail";
  return statusLabel(status);
}

function mailCount(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "-";
}

function formatRate(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? `${Math.round(value * 10) / 10} msg/sec` : "-";
}

function formatEta(remaining: number, speed: number | null | undefined): string {
  if (!speed || speed <= 0 || remaining <= 0) return "-";
  return formatDuration((remaining / speed) * 1000);
}

export default function SupportPage() {
  const { toast } = useToast();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [filters, setFilters, resetFilters] = usePersistedPageState<SupportAnalyticsFilters>("ui_state_support_analytics", DEFAULT_FILTERS);
  const [sortState, setSortState] = usePersistedPageState<SupportSortState>("ui_state_support_sort", { sortBy: "received_at", sortDir: "desc" });
  const [page, setPage] = useState(1);
  const [lastSync, setLastSync] = useState<SyncSupportMailSummary | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [importYear, setImportYear] = useState(() => new Date().getFullYear());
  const [preview, setPreview] = useState<SupportParseResult | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [lastImport, setLastImport] = useState<SupportImportSummary | null>(null);
  const [manualCategory, setManualCategory] = useState<SupportCategory>("Other/unclear");
  const [manualSubcategory, setManualSubcategory] = useState("other_unclear");
  const [manualUrgency, setManualUrgency] = useState<SupportUrgency>("low");
  const lastObservedMailSuccess = useRef<string | null | undefined>(undefined);

  useEffect(() => setPage(1), [filters]);

  const userScopeHash = useMemo(() => hashUserScope(user?.id), [user?.id]);
  const { version: warehouseVersion, ready: warehouseVersionReady } = useSupportWarehouseVersion(Boolean(user?.id));
  const supportQuery = useMemo<SupportQuery>(() => ({
    filters,
    page,
    pageSize: PAGE_SIZE,
    sortBy: sortState.sortBy,
    sortDir: sortState.sortDir,
  }), [filters, page, sortState.sortBy, sortState.sortDir]);
  const supportData = useSupportData({
    query: supportQuery,
    userScopeHash,
    warehouseVersion,
    enabled: Boolean(user?.id) && warehouseVersionReady,
  });
  const dashboard = supportData.bundle?.summary ?? EMPTY_DASHBOARD;
  const pageData = supportData.page;
  const batchesQuery = useQuery({
    queryKey: ["support-import-batches"],
    queryFn: listSupportImportBatches,
    staleTime: 5 * 60 * 1000,
  });
  const mailStatusQuery = useQuery({
    queryKey: ["support-mail-sync-status", userScopeHash],
    queryFn: getSupportMailStatus,
    enabled: Boolean(user?.id),
    staleTime: 30 * 1000,
    refetchInterval: (query) => {
      const status = query.state.data?.state?.status ?? query.state.data?.status;
      return ["connecting", "discovering", "syncing"].includes(String(status)) ? 5000 : 60_000;
    },
  });
  const mailSuccessAt = mailStatusQuery.data?.state?.last_success_at ?? null;
  useEffect(() => {
    if (lastObservedMailSuccess.current === undefined) {
      lastObservedMailSuccess.current = mailSuccessAt;
      return;
    }
    if (!mailSuccessAt || mailSuccessAt === lastObservedMailSuccess.current) return;
    lastObservedMailSuccess.current = mailSuccessAt;
    void invalidateSupportAnalyticsCache(queryClient);
  }, [mailSuccessAt, queryClient]);
  const detailQuery = useQuery({
    queryKey: ["support", "details", userScopeHash, warehouseVersion, selectedId],
    queryFn: async () => (await loadSupportDetails(selectedId as string)).row,
    enabled: Boolean(selectedId) && warehouseVersionReady,
  });

  useEffect(() => {
    const row = detailQuery.data;
    if (!row) return;
    setManualCategory(effectiveCategory(row));
    setManualSubcategory(effectiveSubcategory(row));
    setManualUrgency(effectiveUrgency(row));
  }, [detailQuery.data]);

  const invalidateSupport = () => {
    void invalidateSupportAnalyticsCache(queryClient);
    void queryClient.invalidateQueries({ queryKey: ["support-import-batches"] });
    void queryClient.invalidateQueries({ queryKey: ["support-mail-sync-status"] });
  };

  const runMailWorkflow = async (action: SupportMailSyncAction, options: Record<string, unknown> = {}) => {
    if (action !== "initial_sync" && action !== "continue_sync") return syncSupportMail(action, options);
    let currentAction: SupportMailSyncAction = action;
    let summary: SyncSupportMailSummary | null = null;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      summary = await syncSupportMail(currentAction, options);
      setLastSync(summary);
      queryClient.setQueryData(["support-mail-sync-status", userScopeHash], summary);
      const remaining = summary.state?.history_remaining_messages ?? summary.history_remaining_messages ?? 0;
      if (summary.status !== "partial" || remaining <= 0) return summary;
      currentAction = "continue_sync";
    }
    if (!summary) throw new Error("Support mail import did not start.");
    return summary;
  };

  const syncMutation = useMutation({
    mutationFn: ({ action, options }: { action: SupportMailSyncAction; options?: Record<string, unknown> }) =>
      runMailWorkflow(action, options ?? {}),
    onSuccess: (summary, variables) => {
      setLastSync(summary);
      invalidateSupport();
      const title = variables.action === "test_connection"
        ? "Support mail connection checked"
        : variables.action === "stop"
          ? "Support mail sync stopped"
          : "Support mail sync finished";
      toast({ title, description: `${summary.synced} messages processed · ${summary.inserted} inserted · ${summary.skipped} skipped.` });
    },
    onError: (error) => {
      toast({
        title: "Support sync failed",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    },
  });

  const stopMutation = useMutation({
    mutationFn: () => syncSupportMail("stop"),
    onSuccess: (summary) => {
      setLastSync(summary);
      invalidateSupport();
      toast({ title: "Support mail sync stopped" });
    },
    onError: (error) => {
      toast({
        title: "Could not stop support sync",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    },
  });

  const importMutation = useMutation({
    mutationFn: async () => {
      if (!selectedFile) throw new Error("Choose a support spreadsheet before importing.");
      const summary = await importSupportFile(selectedFile, { importYear });
      const sync = await syncSupportToClickHouse(false);
      return { summary, sync };
    },
    onSuccess: ({ summary, sync }) => {
      setLastImport(summary);
      invalidateSupport();
      toast({ title: "Support requests imported", description: `${summary.inserted_rows} inserted, ${summary.skipped_rows} skipped. ClickHouse synced ${sync.rows_inserted} rows.` });
    },
    onError: (error) => {
      toast({
        title: "Support import failed",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    },
  });

  const manualMutation = useMutation({
    mutationFn: async () => {
      if (!selectedId) throw new Error("No selected support request.");
      await updateSupportRequestManualClassification(selectedId, {
        category: manualCategory,
        subcategory: manualSubcategory.trim() || "other_unclear",
        urgency: manualUrgency,
      });
      return syncSupportToClickHouse(false);
    },
    onSuccess: () => {
      invalidateSupport();
      toast({ title: "Classification updated" });
    },
  });

  const resetManualMutation = useMutation({
    mutationFn: async () => {
      if (!selectedId) throw new Error("No selected support request.");
      await resetSupportRequestManualClassification(selectedId);
      return syncSupportToClickHouse(false);
    },
    onSuccess: () => {
      invalidateSupport();
      toast({ title: "Automatic classification restored" });
    },
  });

  async function onChooseFile(file: File | null) {
    setSelectedFile(file);
    setPreview(null);
    setPreviewError(null);
    setLastImport(null);
    if (!file) return;
    try {
      const result = await parseSupportFile(file, { importYear });
      setPreview(result);
    } catch (error) {
      setPreviewError(error instanceof Error ? error.message : "Could not parse support file.");
    }
  }

  async function refreshPreviewForYear(year: number) {
    setImportYear(year);
    if (!selectedFile) return;
    try {
      setPreview(await parseSupportFile(selectedFile, { importYear: year }));
      setPreviewError(null);
    } catch (error) {
      setPreviewError(error instanceof Error ? error.message : "Could not parse support file.");
    }
  }

  const updateFilter = <K extends keyof SupportAnalyticsFilters>(key: K, value: SupportAnalyticsFilters[K]) => {
    setFilters((current) => ({ ...current, [key]: value }));
  };

  const rows = pageData?.rows ?? [];
  const totalRows = pageData?.pagination.total_rows ?? 0;
  const totalPages = pageData?.pagination.total_pages ?? Math.max(1, Math.ceil(totalRows / PAGE_SIZE));
  const selected = detailQuery.data;
  const topCategories = (dashboard?.categoryRanking ?? []).slice(0, 8);
  const funnelOptions = supportData.bundle?.filter_options.funnels ?? [];
  const campaignPathOptions = supportData.bundle?.filter_options.campaign_paths ?? [];
  const funnelRanking = dashboard?.funnelRanking ?? [];
  const campaignPathRanking = dashboard?.campaignPathRanking ?? [];
  const attributionDiagnostics = supportData.bundle?.diagnostics;
  const mailStatus = mailStatusQuery.data ?? lastSync;
  const mailState = mailStatus?.state ?? null;
  const historyTotal = mailState?.history_total_messages ?? mailStatus?.history_total_messages ?? mailState?.mailbox_messages ?? mailStatus?.mailbox_messages ?? null;
  const historyImported = mailState?.history_imported_messages ?? mailStatus?.history_imported_messages ?? 0;
  const historyRemaining = mailState?.history_remaining_messages ?? mailStatus?.history_remaining_messages ?? (typeof historyTotal === "number" ? Math.max(0, historyTotal - historyImported) : 0);
  const historyComplete = Boolean(mailState?.history_completed_at ?? mailStatus?.history_completed_at) || (typeof historyTotal === "number" && historyTotal > 0 && historyImported >= historyTotal);
  const mailActive = syncMutation.isPending || ["connecting", "discovering", "syncing"].includes(String(mailState?.status ?? mailStatus?.status ?? ""));
  const mailStatusText = mailActiveStatusLabel(mailState?.status ?? mailStatus?.status, historyComplete, syncMutation.isPending);
  const mailboxMessages = mailState?.mailbox_messages ?? mailStatus?.mailbox_messages ?? historyTotal;
  const currentBatch = mailState?.current_batch ?? 0;
  const currentBatchTotal = mailState?.current_batch_total ?? mailStatus?.current_batch_total ?? 0;
  const lastImportedUid = mailState?.last_imported_uid ?? mailStatus?.last_imported_uid ?? mailState?.last_seen_uid ?? lastSync?.last_seen_uid ?? null;
  const speed = mailState?.last_batch_messages_per_second ?? mailStatus?.last_batch_messages_per_second ?? null;
  const mailProgress = typeof historyTotal === "number" && historyTotal > 0
    ? `${historyImported} / ${historyTotal}`
    : `${mailCount(mailState?.messages_processed ?? mailStatus?.messages_processed ?? lastSync?.synced)} processed`;

  const openRequest = (request: SupportRequestSummaryRow) => {
    setManualCategory(effectiveCategory(request));
    setManualSubcategory(effectiveSubcategory(request));
    setManualUrgency(effectiveUrgency(request));
    setSelectedId(request.id);
  };

  const toggleSort = (sortBy: SupportQuery["sortBy"], initialDirection: SupportQuery["sortDir"]) => {
    setSortState((current) => ({
      sortBy,
      sortDir: current.sortBy === sortBy ? (current.sortDir === "asc" ? "desc" : "asc") : initialDirection,
    }));
  };

  return (
    <AppLayout
      title="Support Inbox"
      description="Support requests, spreadsheet imports, matching quality, and customer issue analytics."
      actions={
        <Button type="button" variant="outline" size="sm" onClick={() => invalidateSupport()} disabled={supportData.status.loading}>
          {supportData.status.loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          Refresh
        </Button>
      }
    >
      <div className="space-y-4">
        <Card className="p-4 shadow-card">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-md bg-primary/10 text-primary">
                <Inbox className="h-5 w-5" />
              </div>
              <div>
                <h2 className="text-sm font-semibold text-foreground">SpaceMail Support Sync</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Automatic inbox sync writes to the same Support raw tables; spreadsheet import remains available for manual backfill.
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => syncMutation.mutate({ action: "test_connection" })} disabled={mailActive}>
                {syncMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <MailCheck className="h-4 w-4" />}
                Test Connection
              </Button>
              {historyComplete ? (
                <Button type="button" size="sm" onClick={() => syncMutation.mutate({ action: "sync_new" })} disabled={mailActive}>
                  {mailActive ? <Loader2 className="h-4 w-4 animate-spin" /> : <MailCheck className="h-4 w-4" />}
                  Sync Now
                </Button>
              ) : (
                <>
                  <Button type="button" size="sm" onClick={() => syncMutation.mutate({ action: "initial_sync", options: { batch_size: 50, max_batches_per_invocation: 3 } })} disabled={mailActive}>
                    {mailActive ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                    Start Import
                  </Button>
                  <Button type="button" variant="outline" size="sm" onClick={() => syncMutation.mutate({ action: "continue_sync", options: { batch_size: 50, max_batches_per_invocation: 3 } })} disabled={mailActive || historyImported <= 0}>
                    Continue Import
                  </Button>
                </>
              )}
              <Button type="button" variant="outline" size="sm" onClick={() => stopMutation.mutate()} disabled={stopMutation.isPending}>
                Stop
              </Button>
            </div>
          </div>
          <div className="mt-4 grid gap-3 text-xs sm:grid-cols-3 lg:grid-cols-6">
            <div><span className="text-muted-foreground">Mailbox</span><div className="font-medium">{mailStatus?.mailbox ?? "support@azora-astro.com"}</div></div>
            <div><span className="text-muted-foreground">Mailbox messages</span><div className="font-medium">{mailCount(mailboxMessages)}</div></div>
            <div><span className="text-muted-foreground">Folder</span><div className="font-medium">{mailStatus?.folder ?? "INBOX"}</div></div>
            <div><span className="text-muted-foreground">Connection</span><div className="font-medium">{mailStatus?.connection ?? "Unknown"}</div></div>
            <div><span className="text-muted-foreground">Status</span><div className="font-medium capitalize">{mailStatusText}</div></div>
            <div><span className="text-muted-foreground">Last success</span><div className="font-medium">{formatDate(mailState?.last_success_at ?? lastSync?.latest_received_at)}</div></div>
            <div><span className="text-muted-foreground">Imported</span><div className="font-medium">{mailProgress}</div></div>
            <div><span className="text-muted-foreground">Remaining</span><div className="font-medium">{mailCount(historyRemaining)}</div></div>
            <div><span className="text-muted-foreground">Current batch</span><div className="font-medium">{currentBatch && currentBatchTotal ? `${currentBatch} / ${currentBatchTotal}` : "-"}</div></div>
            <div><span className="text-muted-foreground">Current UID</span><div className="font-medium">{mailState?.current_uid ?? "-"}</div></div>
            <div><span className="text-muted-foreground">Last Imported UID</span><div className="font-medium">{lastImportedUid ?? "-"}</div></div>
            <div><span className="text-muted-foreground">Imported now</span><div className="font-medium">{mailCount(mailState?.last_sync_imported ?? lastSync?.last_sync_imported)}</div></div>
            <div><span className="text-muted-foreground">New messages</span><div className="font-medium">{mailCount(mailState?.last_sync_new_messages ?? lastSync?.last_sync_new_messages)}</div></div>
            <div><span className="text-muted-foreground">Speed</span><div className="font-medium">{formatRate(speed)}</div></div>
            <div><span className="text-muted-foreground">ETA</span><div className="font-medium">{formatEta(historyRemaining, speed)}</div></div>
            <div><span className="text-muted-foreground">Duration</span><div className="font-medium">{formatDuration(lastSync?.duration_ms)}</div></div>
            <div><span className="text-muted-foreground">Password secret</span><div className="font-medium">{mailStatus?.config?.password ? "Configured" : "Missing"}</div></div>
            <div><span className="text-muted-foreground">Last error</span><div className="font-medium truncate">{mailState?.last_error_code ?? lastSync?.error_code ?? "-"}</div></div>
          </div>
        </Card>

        <Card className="p-4 shadow-card">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-md bg-primary/10 text-primary">
                <FileSpreadsheet className="h-5 w-5" />
              </div>
              <div>
                <h2 className="text-sm font-semibold text-foreground">Support Requests Import</h2>
                <p className="mt-1 text-xs text-muted-foreground">Accepted: .xlsm, .xlsx, .csv. Default sheet: Unified data.</p>
              </div>
            </div>
            <Button type="button" onClick={() => importMutation.mutate()} disabled={!selectedFile || !preview || importMutation.isPending}>
              {importMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              Import Support File
            </Button>
          </div>
          <div className="mt-4 grid gap-3 lg:grid-cols-[1.4fr_0.6fr]">
            <div className="space-y-1">
              <Label htmlFor="support-file">File</Label>
              <Input
                id="support-file"
                type="file"
                accept=".xlsm,.xlsx,.csv"
                onChange={(event) => void onChooseFile(event.target.files?.[0] ?? null)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="support-import-year">Import year</Label>
              <Input
                id="support-import-year"
                type="number"
                min={2000}
                max={2100}
                value={importYear}
                onChange={(event) => void refreshPreviewForYear(Number(event.target.value || new Date().getFullYear()))}
              />
            </div>
          </div>
          {previewError && (
            <div className="mt-3 flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
              <AlertCircle className="h-4 w-4" />
              {previewError}
            </div>
          )}
          {preview && (
            <div className="mt-4 space-y-3">
              <div className="grid gap-2 rounded-md border border-border bg-muted/30 p-3 text-xs sm:grid-cols-2 lg:grid-cols-6">
                <div><span className="text-muted-foreground">Sheet</span><div className="font-medium">{preview.diagnostics.sheet_name}</div></div>
                <div><span className="text-muted-foreground">Rows detected</span><div className="font-medium">{preview.diagnostics.total_rows}</div></div>
                <div><span className="text-muted-foreground">Valid</span><div className="font-medium">{preview.diagnostics.valid_rows}</div></div>
                <div><span className="text-muted-foreground">Invalid dates</span><div className="font-medium">{preview.diagnostics.invalid_date_rows}</div></div>
                <div><span className="text-muted-foreground">Assumed year</span><div className="font-medium">{preview.diagnostics.assumed_year_rows}</div></div>
                <div><span className="text-muted-foreground">Headers</span><div className="font-medium">{preview.diagnostics.detected_headers.length}</div></div>
              </div>
              <div className="overflow-auto rounded-md border border-border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Row</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead>Sender</TableHead>
                      <TableHead>Subject</TableHead>
                      <TableHead>Category</TableHead>
                      <TableHead>Language</TableHead>
                      <TableHead>Priority</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {preview.sample.map((row) => (
                      <TableRow key={row.source_hash}>
                        <TableCell className="text-xs">{row.source_row_number}</TableCell>
                        <TableCell className="text-xs">{formatDateOnly(row.received_at)}</TableCell>
                        <TableCell className="max-w-[180px] truncate text-xs">{row.sender_name || "-"}</TableCell>
                        <TableCell className="max-w-[280px] truncate text-xs">{row.subject || "-"}</TableCell>
                        <TableCell className="text-xs">{row.category}</TableCell>
                        <TableCell className="text-xs">{row.language}</TableCell>
                        <TableCell className="text-xs">{row.urgency}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}
          <div className="mt-3">
            <ImportSummary summary={lastImport} />
          </div>
        </Card>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <StatCard label="Total Requests" value={dashboard.kpis.totalRequests} caption={`${dashboard.kpis.requestsPerDay} / day`} />
          <StatCard label="Unique Senders" value={dashboard.kpis.uniqueSenders} />
          <StatCard label="Matched Customers" value={dashboard.kpis.matchedCustomers} caption={formatPct(dashboard.kpis.matchedPct)} />
          <StatCard label="Unmatched Requests" value={dashboard.kpis.unmatchedRequests} />
          <StatCard label="High Priority" value={dashboard.kpis.highPriorityRequests} />
          <StatCard label="Cancellation Requests" value={dashboard.kpis.cancellationRequests} caption={formatPct(dashboard.kpis.cancellationPct)} />
          <StatCard label="Refund Requests" value={dashboard.kpis.refundRequests} caption={formatPct(dashboard.kpis.refundPct)} />
          <StatCard label="Unexpected Charges" value={dashboard.kpis.unauthorizedChargeRequests} />
          <StatCard label="Product Not Received" value={dashboard.kpis.productNotReceivedRequests} />
          <StatCard label="Payment Issues" value={dashboard.kpis.paymentIssues} caption={`${formatPct(dashboard.kpis.paymentRelatedPct)} payment-related`} />
        </div>

        <Card className="p-4 shadow-card">
          <h2 className="text-sm font-semibold text-foreground">Insights</h2>
          <div className="mt-3 grid gap-2 md:grid-cols-2">
            {dashboard.insights.map((insight) => (
              <div key={insight} className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-foreground">{insight}</div>
            ))}
          </div>
        </Card>

        <Card className="p-4 shadow-card">
          <div className="mb-3 flex items-center gap-2">
            <Search className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold text-foreground">Filters</h2>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
            <div className="space-y-1">
              <Label>Date from</Label>
              <Input type="date" value={filters.dateFrom ?? ""} onChange={(event) => updateFilter("dateFrom", event.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>Date to</Label>
              <Input type="date" value={filters.dateTo ?? ""} onChange={(event) => updateFilter("dateTo", event.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>Category</Label>
              <Select value={filters.category ?? "all"} onValueChange={(value) => updateFilter("category", value as SupportCategory | "all")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All categories</SelectItem>
                  {SUPPORT_CATEGORIES.map((category) => <SelectItem key={category} value={category}>{category}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Funnel</Label>
              <Select
                value={filters.funnel?.[0] ?? "all"}
                onValueChange={(value) => updateFilter("funnel", value === "all" ? [] : [value])}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All funnels</SelectItem>
                  {funnelOptions.map((option) => (
                    <SelectItem key={option.funnel} value={option.funnel}>{option.funnel} ({option.requests})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Campaign Path</Label>
              <Select
                value={filters.campaignPath?.[0] ?? "all"}
                onValueChange={(value) => updateFilter("campaignPath", value === "all" ? [] : [value])}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  {campaignPathOptions.map((option) => (
                    <SelectItem key={option.campaign_path} value={option.campaign_path}>{option.campaign_path} ({option.requests})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Language</Label>
              <Select value={filters.language ?? "all"} onValueChange={(value) => updateFilter("language", value as SupportLanguage | "all")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All languages</SelectItem>
                  <SelectItem value="en">English</SelectItem>
                  <SelectItem value="es">Spanish</SelectItem>
                  <SelectItem value="ru">Russian</SelectItem>
                  <SelectItem value="unknown">Unknown</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Priority</Label>
              <Select value={filters.urgency ?? "all"} onValueChange={(value) => updateFilter("urgency", value as SupportUrgency | "all")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All priorities</SelectItem>
                  {SUPPORT_URGENCIES.map((urgency) => <SelectItem key={urgency} value={urgency}>{urgency}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Matched</Label>
              <Select value={filters.matchStatus ?? "all"} onValueChange={(value) => updateFilter("matchStatus", value as "all" | "matched" | "unmatched")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="matched">Matched</SelectItem>
                  <SelectItem value="unmatched">Unmatched</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Search</Label>
              <Input value={filters.search ?? ""} onChange={(event) => updateFilter("search", event.target.value)} placeholder="Sender, email, subject, message" />
            </div>
            <div className="space-y-1">
              <Label>Import batch</Label>
              <Select value={filters.importBatchId || "all"} onValueChange={(value) => updateFilter("importBatchId", value === "all" ? "" : value)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All batches</SelectItem>
                  {(batchesQuery.data ?? []).map((batch) => <SelectItem key={batch.id} value={batch.id}>{batch.filename}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            {[
              ["requiresCancellation", "Requires cancellation"],
              ["requiresRefund", "Requires refund"],
              ["paymentRelated", "Payment-related"],
              ["deliveryRelated", "Delivery-related"],
            ].map(([key, label]) => (
              <div key={key} className="space-y-1">
                <Label>{label}</Label>
                <Select value={boolFilterValue(filters[key as keyof SupportAnalyticsFilters] as boolean | "all")} onValueChange={(value) => updateFilter(key as keyof SupportAnalyticsFilters, parseBoolFilter(value) as never)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All</SelectItem>
                    <SelectItem value="true">Yes</SelectItem>
                    <SelectItem value="false">No</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            ))}
            <div className="space-y-1">
              <Label>Corrections</Label>
              <Select value={filters.manualStatus ?? "all"} onValueChange={(value) => updateFilter("manualStatus", value as "all" | "manual" | "automatic")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="manual">Manual</SelectItem>
                  <SelectItem value="automatic">Automatic</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="mt-3 flex justify-end">
            <Button type="button" variant="outline" size="sm" onClick={resetFilters}>Reset filters</Button>
          </div>
        </Card>

        <div className="grid gap-4 xl:grid-cols-2">
          <ChartCard title="Requests by Day">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={dashboard.byDay}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="date" tick={{ fontSize: 10 }} />
                <YAxis allowDecimals={false} />
                <Tooltip />
                <Line type="monotone" dataKey="requests" stroke="#2563eb" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </ChartCard>
          <ChartCard title="Cancellation / Refund / Charge Trend">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={dashboard.operationalTrend}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="date" tick={{ fontSize: 10 }} />
                <YAxis allowDecimals={false} />
                <Tooltip />
                <Legend />
                <Line type="monotone" dataKey="cancellation" stroke="#f59e0b" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="refund" stroke="#dc2626" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="charge" stroke="#7c3aed" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </ChartCard>
          <ChartCard title="Top Categories">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={topCategories}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="category" tick={{ fontSize: 10 }} interval={0} angle={-25} textAnchor="end" height={80} />
                <YAxis allowDecimals={false} />
                <Tooltip />
                <Bar dataKey="requests" fill="#2563eb" />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
          <ChartCard title="Requests by Funnel">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={funnelRanking}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="funnel" tick={{ fontSize: 10 }} interval={0} angle={-25} textAnchor="end" height={80} />
                <YAxis allowDecimals={false} />
                <Tooltip />
                <Bar dataKey="requests" fill="#0891b2" />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
          <ChartCard title="Language / Match / Priority">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Tooltip />
                <Legend />
                <Pie data={dashboard.languageDistribution} dataKey="requests" nameKey="language" outerRadius={72}>
                  {dashboard.languageDistribution.map((entry, index) => <Cell key={entry.language} fill={CATEGORY_COLORS[index % CATEGORY_COLORS.length]} />)}
                </Pie>
              </PieChart>
            </ResponsiveContainer>
          </ChartCard>
        </div>

        <Card className="p-4 shadow-card">
          <h2 className="text-sm font-semibold text-foreground">Support by Funnel</h2>
          <div className="mt-3 overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Funnel</TableHead>
                  <TableHead className="text-right">Support Requests</TableHead>
                  <TableHead className="text-right">Unique Support Users</TableHead>
                  <TableHead className="text-right">Share</TableHead>
                  <TableHead className="text-right">Cancellation</TableHead>
                  <TableHead className="text-right">Refund</TableHead>
                  <TableHead className="text-right">Unauthorized Charge</TableHead>
                  <TableHead className="text-right">High Priority</TableHead>
                  <TableHead className="text-right">Matched Users</TableHead>
                  <TableHead className="text-right">Support Rate</TableHead>
                  <TableHead>Latest Request</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {funnelRanking.map((item) => (
                  <TableRow key={item.funnel}>
                    <TableCell className="whitespace-nowrap text-xs">{item.funnel}</TableCell>
                    <TableCell className="text-right font-mono text-xs">{item.requests}</TableCell>
                    <TableCell className="text-right font-mono text-xs">{item.uniqueSupportUsers}</TableCell>
                    <TableCell className="text-right text-xs">{formatPct(item.share)}</TableCell>
                    <TableCell className="text-right font-mono text-xs">{item.cancellationRequests}</TableCell>
                    <TableCell className="text-right font-mono text-xs">{item.refundRequests}</TableCell>
                    <TableCell className="text-right font-mono text-xs">{item.unauthorizedChargeRequests}</TableCell>
                    <TableCell className="text-right font-mono text-xs">{item.highPriority}</TableCell>
                    <TableCell className="text-right font-mono text-xs">{item.matchedUsers}</TableCell>
                    <TableCell className="text-right text-xs">{item.supportRate == null ? "—" : formatPct(item.supportRate)}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs">{formatDateOnly(item.latestRequest)}</TableCell>
                  </TableRow>
                ))}
                {!funnelRanking.length && (
                  <TableRow><TableCell colSpan={11} className="h-20 text-center text-muted-foreground">No funnel data</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </Card>

        <Card className="p-4 shadow-card">
          <h2 className="text-sm font-semibold text-foreground">Support by Campaign Path</h2>
          <div className="mt-3 overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Campaign Path</TableHead>
                  <TableHead className="text-right">Support Requests</TableHead>
                  <TableHead className="text-right">Unique Support Users</TableHead>
                  <TableHead className="text-right">Support Rate</TableHead>
                  <TableHead className="text-right">Cancellation</TableHead>
                  <TableHead className="text-right">Refund</TableHead>
                  <TableHead className="text-right">High Priority</TableHead>
                  <TableHead>Latest Request</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {campaignPathRanking.map((item) => (
                  <TableRow key={item.campaignPath}>
                    <TableCell className="whitespace-nowrap text-xs">{item.campaignPath || EMPTY_CAMPAIGN_PATH}</TableCell>
                    <TableCell className="text-right font-mono text-xs">{item.requests}</TableCell>
                    <TableCell className="text-right font-mono text-xs">{item.uniqueSupportUsers}</TableCell>
                    <TableCell className="text-right text-xs">{item.supportRate == null ? EMPTY_CAMPAIGN_PATH : formatPct(item.supportRate)}</TableCell>
                    <TableCell className="text-right font-mono text-xs">{item.cancellationRequests}</TableCell>
                    <TableCell className="text-right font-mono text-xs">{item.refundRequests}</TableCell>
                    <TableCell className="text-right font-mono text-xs">{item.highPriority}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs">{formatDateOnly(item.latestRequest)}</TableCell>
                  </TableRow>
                ))}
                {!campaignPathRanking.length && (
                  <TableRow><TableCell colSpan={8} className="h-20 text-center text-muted-foreground">No campaign path data</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </Card>

        <div className="grid gap-4 xl:grid-cols-2">
          <Card className="p-4 shadow-card">
            <h2 className="text-sm font-semibold text-foreground">Category Ranking</h2>
            <div className="mt-3 overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Category</TableHead>
                    <TableHead className="text-right">Requests</TableHead>
                    <TableHead className="text-right">Share</TableHead>
                    <TableHead className="text-right">Unique senders</TableHead>
                    <TableHead className="text-right">Matched</TableHead>
                    <TableHead className="text-right">High</TableHead>
                    <TableHead>Latest</TableHead>
                    <TableHead className="text-right">Trend</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {dashboard.categoryRanking.map((row) => (
                    <TableRow key={row.category}>
                      <TableCell className="text-xs">{row.category}</TableCell>
                      <TableCell className="text-right font-mono text-xs">{row.requests}</TableCell>
                      <TableCell className="text-right text-xs">{formatPct(row.share)}</TableCell>
                      <TableCell className="text-right font-mono text-xs">{row.uniqueSenders}</TableCell>
                      <TableCell className="text-right font-mono text-xs">{row.matchedCustomers}</TableCell>
                      <TableCell className="text-right font-mono text-xs">{row.highPriority}</TableCell>
                      <TableCell className="whitespace-nowrap text-xs">{formatDateOnly(row.latestRequest)}</TableCell>
                      <TableCell className="text-right text-xs">{row.trendVsPrevious == null ? "-" : `${row.trendVsPrevious > 0 ? "+" : ""}${row.trendVsPrevious}%`}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </Card>
          <Card className="p-4 shadow-card">
            <h2 className="text-sm font-semibold text-foreground">Subcategory Ranking</h2>
            <div className="mt-3 overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Subcategory</TableHead>
                    <TableHead className="text-right">Requests</TableHead>
                    <TableHead className="text-right">Share</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {dashboard.subcategoryRanking.map((row) => (
                    <TableRow key={row.subcategory}>
                      <TableCell className="text-xs">{row.subcategory}</TableCell>
                      <TableCell className="text-right font-mono text-xs">{row.requests}</TableCell>
                      <TableCell className="text-right text-xs">{formatPct(row.share)}</TableCell>
                    </TableRow>
                  ))}
                  {!dashboard.subcategoryRanking.length && (
                    <TableRow><TableCell colSpan={3} className="h-20 text-center text-muted-foreground">No data</TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </Card>
        </div>

        <Card className="p-4 shadow-card">
          <h2 className="text-sm font-semibold text-foreground">Matching Quality</h2>
          <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-4">
            <div><span className="text-muted-foreground">Matched by email</span><div className="font-medium">{dashboard.matching.matchedByEmail}</div></div>
            <div><span className="text-muted-foreground">Matched by name</span><div className="font-medium">{dashboard.matching.matchedByName}</div></div>
            <div><span className="text-muted-foreground">Unmatched</span><div className="font-medium">{dashboard.matching.unmatched}</div></div>
            <div><span className="text-muted-foreground">Email without matched contact</span><div className="font-medium">{dashboard.matching.emailPresentNoMatchedContact}</div></div>
            <div><span className="text-muted-foreground">Matched contact without email</span><div className="font-medium">{dashboard.matching.matchedContactNoEmail}</div></div>
            <div><span className="text-muted-foreground">Duplicate emails</span><div className="font-medium">{dashboard.matching.duplicateNormalizedEmails}</div></div>
            <div><span className="text-muted-foreground">Multiple names per email</span><div className="font-medium">{dashboard.matching.multipleSenderNamesForOneEmail}</div></div>
            <div><span className="text-muted-foreground">Requests with funnel</span><div className="font-medium">{attributionDiagnostics?.requests_with_funnel ?? 0}</div></div>
            <div><span className="text-muted-foreground">Requests without funnel</span><div className="font-medium">{attributionDiagnostics?.requests_without_funnel ?? 0}</div></div>
            <div><span className="text-muted-foreground">Unique matched support users</span><div className="font-medium">{attributionDiagnostics?.unique_matched_support_users ?? 0}</div></div>
            <div><span className="text-muted-foreground">Unmatched emails</span><div className="font-medium">{attributionDiagnostics?.unmatched_emails ?? 0}</div></div>
            <div><span className="text-muted-foreground">Users without trial</span><div className="font-medium">{attributionDiagnostics?.users_without_trial ?? 0}</div></div>
          </div>
          {attributionDiagnostics?.support_rate_diagnostic && <p className="mt-3 text-xs text-muted-foreground">{attributionDiagnostics.support_rate_diagnostic}</p>}
        </Card>

        <Card className="shadow-card">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-4">
            <div>
              <h2 className="text-sm font-semibold text-foreground">Support Requests</h2>
              <p className="mt-1 text-xs text-muted-foreground">{totalRows} requests · page {page} of {totalPages}</p>
            </div>
            <div className="flex gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={page <= 1}>Previous</Button>
              <Button type="button" variant="outline" size="sm" onClick={() => setPage((value) => Math.min(totalPages, value + 1))} disabled={page >= totalPages}>Next</Button>
            </div>
          </div>
          <div className="overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead><button type="button" className="font-medium" onClick={() => toggleSort("received_at", "desc")}>Date{sortState.sortBy === "received_at" ? (sortState.sortDir === "asc" ? " ↑" : " ↓") : ""}</button></TableHead>
                  <TableHead>Sender</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead><button type="button" className="font-medium" onClick={() => toggleSort("funnel", "asc")}>Funnel{sortState.sortBy === "funnel" ? (sortState.sortDir === "asc" ? " A→Z" : " Z→A") : ""}</button></TableHead>
                  <TableHead><button type="button" className="font-medium" onClick={() => toggleSort("campaign_path", "asc")}>Campaign Path{sortState.sortBy === "campaign_path" ? (sortState.sortDir === "asc" ? " A→Z" : " Z→A") : ""}</button></TableHead>
                  <TableHead>Matched contact</TableHead>
                  <TableHead>Subject</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Subcategory</TableHead>
                  <TableHead>Language</TableHead>
                  <TableHead>Priority</TableHead>
                  <TableHead>Match</TableHead>
                  <TableHead>Flags</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((request) => (
                  <TableRow key={request.id} className="cursor-pointer" onClick={() => openRequest(request)}>
                    <TableCell className="whitespace-nowrap text-xs">{formatDateOnly(request.received_at)}</TableCell>
                    <TableCell className="max-w-[160px] truncate text-xs">{request.sender_name ?? "-"}</TableCell>
                    <TableCell className="max-w-[180px] truncate text-xs">{request.customer_email ?? "-"}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs" title={[request.campaign_path, request.cohort_date].filter(Boolean).join(" · ") || undefined}>{request.funnel || "Unknown"}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs">{request.campaign_path || EMPTY_CAMPAIGN_PATH}</TableCell>
                    <TableCell className="max-w-[160px] truncate text-xs">{request.matched_contact_name ?? "-"}</TableCell>
                    <TableCell className="max-w-[260px] truncate text-xs">{request.subject ?? "-"}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs">{effectiveCategory(request)}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs">{effectiveSubcategory(request)}</TableCell>
                    <TableCell className="text-xs">{request.language}</TableCell>
                    <TableCell className="text-xs">{effectiveUrgency(request)}</TableCell>
                    <TableCell className="text-xs">{request.attribution_status}</TableCell>
                    <TableCell className="max-w-[220px] truncate text-xs">{flagsFor(request).join(", ") || "-"}</TableCell>
                  </TableRow>
                ))}
                {!rows.length && (
                  <TableRow>
                    <TableCell colSpan={13} className="h-28 text-center text-muted-foreground">
                      {supportData.isInitialLoading ? "Loading support requests..." : "No support requests match the current filters"}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </Card>
      </div>

      <Dialog open={Boolean(selectedId)} onOpenChange={(open) => !open && setSelectedId(null)}>
        <DialogContent className="max-h-[85vh] max-w-4xl overflow-auto">
          <DialogHeader>
            <DialogTitle>{selected?.subject || "Support request"}</DialogTitle>
            <DialogDescription>
              Request details, matching context, and classification controls.
            </DialogDescription>
          </DialogHeader>
          {detailQuery.isFetching && !selected && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading request...</div>}
          {selected && (
            <>
              <div className="grid gap-4 text-sm">
                <div className="grid gap-2 sm:grid-cols-2">
                  <div><span className="text-muted-foreground">Sender</span><div>{selected.sender_name ?? "-"}</div></div>
                  <div><span className="text-muted-foreground">Email</span><div>{selected.customer_email ?? "-"}</div></div>
                  <div><span className="text-muted-foreground">Received</span><div>{formatDate(selected.received_at)}</div></div>
                  <div><span className="text-muted-foreground">Matched contact</span><div>{selected.matched_contact_name ?? "Unmatched"}</div></div>
                  <div><span className="text-muted-foreground">Funnel</span><div title={[selected.campaign_path, selected.cohort_date].filter(Boolean).join(" · ") || undefined}>{selected.funnel || "Unknown"}</div></div>
                  <div><span className="text-muted-foreground">Campaign Path</span><div>{selected.campaign_path || EMPTY_CAMPAIGN_PATH}</div></div>
                  <div><span className="text-muted-foreground">Attribution status</span><div>{selected.attribution_status}</div></div>
                  <div><span className="text-muted-foreground">Automatic category</span><div>{selected.automatic_category ?? selected.category} / {selected.automatic_subcategory ?? selected.subcategory}</div></div>
                  <div><span className="text-muted-foreground">Confidence</span><div>{Math.round(Number(selected.classification_confidence ?? 0) * 100)}%</div></div>
                </div>
                <div className="rounded-md border border-border p-3">
                  <h3 className="text-xs font-semibold text-muted-foreground">Message Body</h3>
                  <p className="mt-2 whitespace-pre-wrap text-sm text-foreground">{selected.message_body || "No message body available."}</p>
                </div>
                <div className="rounded-md border border-border p-3">
                  <h3 className="text-xs font-semibold text-muted-foreground">Classification Explanation</h3>
                  <p className="mt-2 text-sm text-foreground">{selected.classification_reason ?? "-"}</p>
                  <div className="mt-3 grid gap-3 sm:grid-cols-3">
                    <div className="space-y-1">
                      <Label>Category</Label>
                      <Select value={manualCategory} onValueChange={(value) => setManualCategory(value as SupportCategory)}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {SUPPORT_CATEGORIES.map((category) => <SelectItem key={category} value={category}>{category}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1">
                      <Label>Subcategory</Label>
                      <Input value={manualSubcategory} onChange={(event) => setManualSubcategory(event.target.value)} />
                    </div>
                    <div className="space-y-1">
                      <Label>Priority</Label>
                      <Select value={manualUrgency} onValueChange={(value) => setManualUrgency(value as SupportUrgency)}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {SUPPORT_URGENCIES.map((urgency) => <SelectItem key={urgency} value={urgency}>{urgency}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button type="button" size="sm" onClick={() => manualMutation.mutate()} disabled={manualMutation.isPending}>
                      {manualMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                      Save correction
                    </Button>
                    <Button type="button" variant="outline" size="sm" onClick={() => resetManualMutation.mutate()} disabled={resetManualMutation.isPending}>
                      Reset to automatic classification
                    </Button>
                  </div>
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
