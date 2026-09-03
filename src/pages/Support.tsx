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
import { AlertCircle, Download, FileSpreadsheet, Inbox, Loader2, MailCheck, RefreshCw, Search, Sparkles } from "lucide-react";
import { Progress } from "@/components/ui/progress";
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
  isTerminalClassificationState,
  runSupportClassification,
  type SupportClassificationProgress,
} from "@/services/supportClassification";
import {
  SUPPORT_CATEGORIES,
  SUPPORT_URGENCIES,
  getAnsweredReplyForRequest,
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
  loadSupportExportPage,
  loadSupportSyncStatus,
  syncSupportToClickHouse,
  type SupportQuery,
} from "@/services/supportDataSource";
import {
  buildSupportExportTable,
  collectSupportExportRows,
  downloadSupportCsv,
  downloadSupportXlsx,
  MAX_EXPORT_ROWS,
  type SupportExportMeta,
} from "@/services/supportExport";

const PAGE_SIZE = 50;
const CATEGORY_COLORS = ["#2563eb", "#dc2626", "#f59e0b", "#059669", "#7c3aed", "#0891b2", "#be123c", "#64748b"];

/** How we know the request was answered (supportReplyMatching tiers). */
const ANSWER_SOURCE_LABELS: Record<string, string> = {
  thread: "reply in thread",
  recipient: "mail to customer",
  contact: "we've written to this address earlier",
  imap_flag: "IMAP \\Answered flag",
  customer_reply: "customer replied to our answer",
};

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
    answeredContacts: 0,
    unansweredContacts: 0,
    answerableContacts: 0,
    answerRatePct: 0,
    medianFirstResponseMinutes: null as number | null,
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
  answered: "all",
  search: "",
  importBatchId: "",
  funnel: [],
  campaignPath: [],
};

/** Human-readable list of the filters that are actually narrowing the view.
 * Stamped into the export so a file found later still says what it covers. */
function describeSupportFilters(filters: SupportAnalyticsFilters): string[] {
  const out: string[] = [];
  const push = (label: string, value: unknown) => {
    if (value === undefined || value === null) return;
    if (value === "" || value === "all") return;
    if (Array.isArray(value)) {
      if (value.length) out.push(`${label}: ${value.join(", ")}`);
      return;
    }
    out.push(`${label}: ${String(value)}`);
  };
  push("Дата с", filters.dateFrom);
  push("Дата по", filters.dateTo);
  push("Категория", filters.category);
  push("Подкатегория", filters.subcategory);
  push("Язык", filters.language);
  push("Приоритет", filters.urgency);
  push("Сопоставление", filters.matchStatus);
  push("Отмена", filters.requiresCancellation);
  push("Возврат", filters.requiresRefund);
  push("Платёж", filters.paymentRelated);
  push("Доставка", filters.deliveryRelated);
  push("Правки", filters.manualStatus);
  push("Ответ", filters.answered);
  push("Поиск", filters.search);
  push("Батч", filters.importBatchId);
  push("Воронка", filters.funnel);
  push("Campaign path", filters.campaignPath);
  return out;
}

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

/** 42м / 3.5ч / 2.1д; "—" while no timed answer exists in the range. */
function formatResponseMinutes(minutes: number | null | undefined): string {
  if (minutes == null || !Number.isFinite(minutes)) return "—";
  if (minutes < 60) return `${Math.round(minutes)}м`;
  if (minutes < 48 * 60) return `${(minutes / 60).toFixed(1)}ч`;
  return `${(minutes / (24 * 60)).toFixed(1)}д`;
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
  /** Off by default: a normal run only touches emails that are not yet on the
   * current taxonomy, so re-running it is cheap and idempotent. */
  const [classifyAll, setClassifyAll] = useState(false);
  /** Rules by default: it needs no API key and no budget, so the button always
   * does something. Switch to the model for the harder long tail. */
  const [classifyEngine, setClassifyEngine] = useState<"rules" | "model">("rules");
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
  // --- export -------------------------------------------------------------
  // Exports what the filter panel currently selects, which with no filters set
  // is every email. The request is assembled by the same buildSupportRequest the
  // table uses, so the file cannot cover a different set than the screen.
  const [exportState, setExportState] = useState<{ busy: "csv" | "xlsx" | null; loaded: number; total: number }>(
    { busy: null, loaded: 0, total: 0 });

  async function onExport(format: "csv" | "xlsx") {
    setExportState({ busy: format, loaded: 0, total: 0 });
    try {
      // How far the mirror lags Postgres. Read first so the file can say it,
      // rather than presenting a snapshot as the whole mailbox.
      const pendingSync = await loadSupportSyncStatus()
        .then((status) => Math.max(0, status.source_total - status.clickhouse_total))
        .catch(() => null);

      const collected = await collectSupportExportRows(
        (pageNumber) => loadSupportExportPage(supportQuery, pageNumber),
        (progress) => setExportState({ busy: format, loaded: progress.loaded, total: progress.total }),
      );
      const table = buildSupportExportTable(collected.rows);
      const meta: SupportExportMeta = {
        generatedAt: collected.generatedAt,
        totalRows: collected.totalRows,
        exportedRows: collected.rows.length,
        truncatedCells: table.truncatedCells,
        filterSummary: describeSupportFilters(filters).join("; ") || "без фильтров — все письма",
        sortSummary: `${sortState.sortBy} ${sortState.sortDir}`,
        pendingSync,
      };

      if (format === "csv") downloadSupportCsv(table, meta);
      else await downloadSupportXlsx(table, meta);

      // Everything the file is NOT is said out loud: a short file, cells cut to
      // Excel's limit, or a mirror that has not caught up.
      const notes: string[] = [];
      if (collected.hitCeiling) notes.push(`выгрузка ограничена ${MAX_EXPORT_ROWS} письмами`);
      else if (collected.rows.length < collected.totalRows) {
        notes.push(`под фильтром ${collected.totalRows}, выгружено ${collected.rows.length} — склад менялся во время выгрузки`);
      }
      if (table.truncatedCells > 0) notes.push(`${table.truncatedCells} ячеек обрезано под лимит Excel`);
      if (pendingSync) notes.push(`${pendingSync} писем ещё не доехали из Postgres`);

      toast({
        title: `Выгружено писем: ${collected.rows.length}`,
        description: notes.length ? notes.join(". ") : "Файл содержит все письма под текущим фильтром.",
        variant: notes.length ? "destructive" : undefined,
      });
    } catch (error) {
      toast({
        title: "Выгрузка не удалась",
        description: error instanceof Error ? error.message : "Неизвестная ошибка",
        variant: "destructive",
      });
    } finally {
      setExportState({ busy: null, loaded: 0, total: 0 });
    }
  }

  const dashboard = supportData.bundle?.summary ?? EMPTY_DASHBOARD;
  // Rate over ANSWERABLE mail only (spam/auto excluded server-side); days with
  // nothing answerable carry null so the line skips them instead of dropping to 0.
  const answerRateByDay = useMemo(
    () =>
      dashboard.byDay.map((day) => ({
        date: day.date,
        rate: day.answerable > 0 ? Math.round((day.answered / day.answerable) * 1000) / 10 : null,
      })),
    [dashboard.byDay],
  );
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
  // The matched Sent reply (subject) — lazy, only for an answered open dialog.
  const answeredReplyQuery = useQuery({
    queryKey: ["support", "answered-reply", selectedId],
    queryFn: () => getAnsweredReplyForRequest(selectedId as string),
    enabled: Boolean(selectedId) && Boolean(detailQuery.data?.answered),
    staleTime: 5 * 60 * 1000,
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

  // Resume until the mailbox is drained. "sync_new" used to be excluded here, and its
  // leftover was reported through history_remaining_messages (which is the HISTORY
  // remainder, always 0 for that action) — so a "Sync Now" that hit the per-invocation
  // batch limit stopped half-way, still toasted success, and the newest messages never
  // reached the warehouse. Each action now resumes on its own remaining-counter.
  const runMailWorkflow = async (action: SupportMailSyncAction, options: Record<string, unknown> = {}) => {
    const RESUMABLE: SupportMailSyncAction[] = ["initial_sync", "continue_sync", "sync_new"];
    if (!RESUMABLE.includes(action)) return syncSupportMail(action, options);
    const remainingOf = (summary: SyncSupportMailSummary): number =>
      action === "sync_new"
        ? summary.pending_new_messages ?? 0
        : summary.state?.history_remaining_messages ?? summary.history_remaining_messages ?? 0;

    let currentAction: SupportMailSyncAction = action;
    let summary: SyncSupportMailSummary | null = null;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      summary = await syncSupportMail(currentAction, options);
      setLastSync(summary);
      queryClient.setQueryData(["support-mail-sync-status", userScopeHash], summary);
      if (summary.status !== "partial" || remainingOf(summary) <= 0) return summary;
      // History resumes through a dedicated action; new mail keeps calling sync_new.
      if (action !== "sync_new") currentAction = "continue_sync";
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
      const pending = summary.status === "partial"
        ? (variables.action === "sync_new"
          ? summary.pending_new_messages ?? 0
          : summary.state?.history_remaining_messages ?? summary.history_remaining_messages ?? 0)
        : 0;
      const title = variables.action === "test_connection"
        ? "Support mail connection checked"
        : variables.action === "stop"
          ? "Support mail sync stopped"
          : pending > 0
            ? "Support mail sync incomplete"
            : "Support mail sync finished";
      const base = `${summary.synced} messages processed · ${summary.inserted} inserted · ${summary.skipped} skipped.`;
      toast({
        title,
        // A partial run left mail unimported: say so instead of reporting success.
        description: pending > 0 ? `${base} ${pending} still pending — run it again to finish.` : base,
        variant: pending > 0 ? "destructive" : undefined,
      });
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

  // Re-classification runner. One Edge call handles a bounded chunk and returns
  // "partial"; the loop keeps calling until the job reports it is done, so a
  // 2 700-email backfill is not bound by the Edge Function time limit.
  const [classification, setClassification] = useState<SupportClassificationProgress | null>(null);
  const [classifying, setClassifying] = useState(false);
  const classifyStopRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void runSupportClassification("status")
      .then((progress) => {
        if (!cancelled) setClassification(progress);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  async function runClassification(initial: "start" | "continue") {
    if (classifying) return;
    classifyStopRef.current = false;
    setClassifying(true);
    let action: "start" | "continue" = initial;
    try {
      for (;;) {
        // reclassify_all must ride on EVERY call, not just the first: each
        // invocation re-derives "what is still pending", so dropping the flag
        // on the continues makes the run stop as soon as the first chunk is
        // on the current version.
        const progress = await runSupportClassification(action, {
          engine: classifyEngine,
          reclassify_all: classifyAll,
        });
        setClassification(progress);
        if (progress.status === "completed") {
          toast({
            title: "Classification finished",
            description: `${progress.rows_classified.toLocaleString()} classified · ${progress.rows_failed.toLocaleString()} left on the previous result.`,
          });
          break;
        }
        if (progress.status === "failed") {
          toast({
            title: "Classification stopped",
            description: progress.last_error ?? progress.stopped_reason ?? "Unknown error",
            variant: "destructive",
          });
          break;
        }
        if (classifyStopRef.current) {
          toast({ title: "Classification paused", description: "Progress is saved — press Continue to resume." });
          break;
        }
        action = "continue";
      }
      invalidateSupport();
      await syncSupportToClickHouse(false).catch(() => undefined);
      invalidateSupport();
    } catch (error) {
      toast({
        title: "Classification failed",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setClassifying(false);
    }
  }

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
  // Sent-folder (answered analytics) backfill state.
  const sentState = mailStatus?.sent_state ?? null;
  const sentStarted = Boolean(sentState);
  const sentHistoryComplete = Boolean(sentState?.history_completed_at);

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
        {/* A failed read used to render exactly like "no rows": empty KPIs, empty table,
            no message. Surface it — an unreachable warehouse must not look like an
            empty inbox. */}
        {supportData.status.error && (
          <Card className="border-destructive/50 bg-destructive/5 p-4 shadow-card">
            <div className="flex items-start gap-3">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              <div className="text-sm">
                <p className="font-medium text-destructive">Could not load support data</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {supportData.status.error} — the figures below may be stale or empty. Try Refresh; if it persists, run a sync.
                </p>
              </div>
            </div>
          </Card>
        )}
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
              {sentHistoryComplete ? (
                <Button type="button" variant="outline" size="sm" onClick={() => syncMutation.mutate({ action: "sent_sync_new" })} disabled={mailActive}>
                  Sync Sent
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => syncMutation.mutate({ action: sentStarted ? "sent_continue_sync" : "sent_initial_sync" })}
                  disabled={mailActive}
                  title="Import the Sent folder history — the source of truth for answered/unanswered analytics. Resumable, 150 headers per run."
                >
                  {sentStarted ? "Continue Sent Import" : "Import Sent History"}
                </Button>
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
            <div>
              <span className="text-muted-foreground">Sent history</span>
              <div className="font-medium">
                {sentState
                  ? sentHistoryComplete
                    ? `complete (${mailCount(sentState.history_imported_messages)} replies)`
                    : `${mailCount(sentState.history_imported_messages)} / ${mailCount(sentState.history_total_messages)}`
                  : "not imported"}
              </div>
            </div>
          </div>
        </Card>

        <Card className="p-4 shadow-card">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-md bg-primary/10 text-primary">
                <Sparkles className="h-5 w-5" />
              </div>
              <div>
                <h2 className="text-sm font-semibold text-foreground">Classification</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Reads each email and assigns a primary intent plus the other intents it expresses. Only emails not yet on the current
                  taxonomy are processed, so re-running costs nothing.
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Select value={classifyEngine} onValueChange={(value) => setClassifyEngine(value as "rules" | "model")} disabled={classifying}>
                <SelectTrigger className="h-9 w-[190px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="rules">Rules (free)</SelectItem>
                  <SelectItem value="model">Claude (needs API credit)</SelectItem>
                </SelectContent>
              </Select>
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5"
                  checked={classifyAll}
                  disabled={classifying}
                  onChange={(event) => setClassifyAll(event.target.checked)}
                />
                Re-classify everything
              </label>
              <Button type="button" onClick={() => void runClassification("start")} disabled={classifying}>
                {classifying && <Loader2 className="h-4 w-4 animate-spin" />}
                {classification?.status === "partial" ? "Restart" : "Classify"}
              </Button>
              {classification?.status === "partial" && !classifying && (
                <Button type="button" variant="outline" onClick={() => void runClassification("continue")}>
                  Continue
                </Button>
              )}
              {classifying && (
                <Button type="button" variant="outline" onClick={() => { classifyStopRef.current = true; }}>
                  Stop
                </Button>
              )}
            </div>
          </div>
          {classification && (
            <>
              {classification.rows_expected != null && classification.rows_expected > 0 && (
                <Progress value={classification.progress_percent} className="mt-4 h-2" />
              )}
              <div className="mt-3 grid gap-3 text-xs sm:grid-cols-3 lg:grid-cols-6">
                <div><span className="text-muted-foreground">Status</span><div className="font-medium">{classification.status}</div></div>
                <div><span className="text-muted-foreground">Classified</span><div className="font-medium">{classification.rows_classified.toLocaleString()}</div></div>
                <div><span className="text-muted-foreground">Remaining</span><div className="font-medium">{classification.rows_remaining?.toLocaleString() ?? "-"}</div></div>
                <div><span className="text-muted-foreground">Kept previous</span><div className="font-medium">{classification.rows_failed.toLocaleString()}</div></div>
                <div><span className="text-muted-foreground">Model</span><div className="font-medium truncate">{classification.model ?? "-"}</div></div>
                <div><span className="text-muted-foreground">Tokens in/out</span><div className="font-medium">{classification.input_tokens.toLocaleString()} / {classification.output_tokens.toLocaleString()}</div></div>
              </div>
              {classification.last_error && (
                <p className="mt-2 text-xs text-warning">
                  {classification.stopped_reason === "no_api_key"
                    ? "ANTHROPIC_API_KEY is not set for this project — emails keep their rule-based classification until it is."
                    : classification.last_error}
                </p>
              )}
            </>
          )}
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
          <StatCard
            label="Contacts Answered"
            value={dashboard.kpis.answeredContacts}
            caption={`${formatPct(dashboard.kpis.answerRatePct)} of ${dashboard.kpis.answerableContacts} answerable contacts`}
          />
          <StatCard label="Contacts Unanswered" value={dashboard.kpis.unansweredContacts} caption="unique addresses, not messages" />
          <StatCard
            label="Median Response"
            value={formatResponseMinutes(dashboard.kpis.medianFirstResponseMinutes)}
            caption="received → first reply"
          />
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
              <Label>Answered</Label>
              <Select value={filters.answered ?? "all"} onValueChange={(value) => updateFilter("answered", value as "all" | "answered" | "unanswered")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="answered">Answered</SelectItem>
                  <SelectItem value="unanswered">Unanswered</SelectItem>
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
          <ChartCard title="Answer Rate by Day">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={answerRateByDay}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="date" tick={{ fontSize: 10 }} />
                <YAxis domain={[0, 100]} tickFormatter={(value) => `${value}%`} />
                <Tooltip formatter={(value: number) => [`${Number(value).toFixed(1)}%`, "answer rate"]} />
                <Line type="monotone" dataKey="rate" stroke="#059669" strokeWidth={2} dot={false} connectNulls />
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
                    <TableHead className="text-right">Answered</TableHead>
                    <TableHead className="text-right">Unanswered</TableHead>
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
                      <TableCell className="text-right font-mono text-xs">{row.answered}</TableCell>
                      <TableCell className={`text-right font-mono text-xs ${row.unanswered > 0 ? "text-destructive" : ""}`}>{row.unanswered}</TableCell>
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
            <div className="flex flex-wrap items-center gap-2">
              {exportState.busy && (
                <span className="text-xs text-muted-foreground">
                  {exportState.loaded}{exportState.total ? ` / ${exportState.total}` : ""} писем…
                </span>
              )}
              <Button type="button" variant="outline" size="sm"
                onClick={() => void onExport("xlsx")} disabled={exportState.busy !== null || totalRows === 0}
                title="Все письма под текущим фильтром, вместе с текстом. XLSX — читаемее для длинных писем.">
                {exportState.busy === "xlsx" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                Выгрузить XLSX
              </Button>
              <Button type="button" variant="outline" size="sm"
                onClick={() => void onExport("csv")} disabled={exportState.busy !== null || totalRows === 0}
                title="Тот же набор писем в CSV (RFC 4180, разделитель — запятая).">
                {exportState.busy === "csv" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                CSV
              </Button>
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
                  <TableHead>Answered</TableHead>
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
                    <TableCell className="whitespace-nowrap text-xs" title={request.answered ? `source: ${request.answer_source}` : undefined}>
                      {request.answered
                        ? <span className="text-success">✓{request.first_response_minutes != null ? ` ${formatResponseMinutes(request.first_response_minutes)}` : ""}</span>
                        : <span className="text-destructive">—</span>}
                    </TableCell>
                    <TableCell className="text-xs">{request.attribution_status}</TableCell>
                    <TableCell className="max-w-[220px] truncate text-xs">{flagsFor(request).join(", ") || "-"}</TableCell>
                  </TableRow>
                ))}
                {!rows.length && (
                  <TableRow>
                    <TableCell colSpan={14} className="h-28 text-center text-muted-foreground">
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
                  <div>
                    <span className="text-muted-foreground">Answered</span>
                    <div>
                      {selected.answered ? (
                        <>
                          <span className="text-success">Yes</span>
                          {selected.answered_at ? ` · ${formatDate(selected.answered_at)}` : ""}
                          {selected.first_response_minutes != null ? ` · ${formatResponseMinutes(selected.first_response_minutes)}` : ""}
                          <span className="ml-2 text-xs text-muted-foreground">{ANSWER_SOURCE_LABELS[selected.answer_source] ?? selected.answer_source}</span>
                          {answeredReplyQuery.data?.subject && (
                            <div className="text-xs text-muted-foreground">Reply: {answeredReplyQuery.data.subject}</div>
                          )}
                        </>
                      ) : (
                        <span className="text-destructive">No reply found</span>
                      )}
                    </div>
                  </div>
                  <div><span className="text-muted-foreground">Automatic category</span><div>{selected.automatic_category ?? selected.category} / {selected.automatic_subcategory ?? selected.subcategory}</div></div>
                  <div>
                    <span className="text-muted-foreground">Confidence</span>
                    <div>
                      {Math.round(Number(selected.classification_confidence ?? 0) * 100)}%
                      <span className="ml-2 text-xs text-muted-foreground">
                        {selected.classification_source === "llm" ? selected.classification_model || "model" : "keyword rules"}
                      </span>
                    </div>
                  </div>
                </div>
                {(selected.secondary_categories?.length ?? 0) > 0 && (
                  <div className="flex flex-wrap items-center gap-2">
                    {/* The intents the email also expresses. A single category
                        used to hide these — "cancel and refund me" counted once. */}
                    <span className="text-xs text-muted-foreground">Also asks about</span>
                    {selected.secondary_categories.map((category) => (
                      <span key={category} className="rounded-full border border-border px-2 py-0.5 text-xs text-foreground">
                        {category}
                      </span>
                    ))}
                  </div>
                )}
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
