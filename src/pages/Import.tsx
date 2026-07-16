import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { invalidateWarehouseAnalyticsCache } from "@/hooks/useCohortsCache";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Database,
  FileSpreadsheet,
  KeyRound,
  Link as LinkIcon,
  Loader2,
  MoreHorizontal,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Trash2,
  Undo2,
  Upload,
} from "lucide-react";
import { AppLayout } from "@/components/AppLayout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { usePersistedPageState } from "@/hooks/usePersistedPageState";
import { useDataStore } from "@/store/dataStore";
import {
  applyMapping,
  autoMap,
  fetchGoogleSheetCsv,
  parseCSVFile,
  TARGET_FIELDS,
  type ColumnMapping,
  type ParsedSheet,
} from "@/services/import";
import {
  getPalmerImportDiagnostics,
  transformPalmerRows,
  type PalmerImportDiagnostics,
  type RawPalmerRow,
} from "@/services/palmerTransform";
import {
  buildPalmerCloudMetadata,
  buildPalmerCloudPayload,
  normalizePalmerCloudPayload,
  type PalmerCloudPayload,
} from "@/services/palmerCloudSnapshot";
import {
  clearPalmerDatasetCache,
  getPalmerCacheInfo,
  loadLastPalmerDatasetFromCache,
  savePalmerDatasetToCache,
  type PalmerCacheMetadata,
} from "@/services/palmerCache";
import {
  isFunnelFoxTemporaryKeyInputEnabled,
  syncAllSubscriptionsWithDiagnostics,
  testFunnelFoxConnection,
} from "@/services/funnelfoxApi";
import {
  getFunnelFoxSubscriptionsSyncState,
  loadFunnelFoxSubscriptions,
  runFunnelFoxSubscriptionsSync,
  shouldShowPartialWarning,
  subscriptionSyncUiStatus,
  subscriptionSyncReport,
  SUBSCRIPTION_SYNC_VERSION,
  syncFunnelFoxSubscriptions,
  type FunnelFoxSubscriptionsSyncResponse,
  type FunnelFoxSubscriptionsSyncState,
} from "@/services/funnelfoxSubscriptionsSync";
import {
  clearSubscriptionsCache,
  getSubscriptionsCacheInfo,
  loadSubscriptionsFromCache,
  saveSubscriptionsToCache,
  type SubscriptionCacheMetadata,
} from "@/services/subscriptionCache";
import { formatPct } from "@/services/analytics";
import {
  fetchFacebookTrafficImportFromGoogleSheet,
  fetchGoogleSheetTrafficTabs,
  parseGoogleSheetReference,
  type GoogleSheetTab,
} from "@/services/trafficImport";
import {
  clearTrafficDataCache,
  getTrafficCacheInfo,
  loadLastTrafficDataFromCache,
  saveTrafficDataToCache,
  type TrafficCacheMetadata,
} from "@/services/trafficCache";
import {
  BUILTIN_DEFAULT_RETENTION_CURVE,
  loadDefaultRetentionCurve,
  saveDefaultRetentionCurve,
  resetDefaultRetentionCurve,
} from "@/services/forecastingSettings";
import {
  MAX_RENEWAL_COLUMN_OPTIONS,
  loadMaxRenewalColumns,
  saveMaxRenewalColumns,
  sanitizeMaxRenewalColumns,
} from "@/services/dataSettings";
import {
  getCloudSnapshotInfos,
  loadLatestCloudSnapshot,
  saveCloudSnapshot,
  type CloudSnapshotInfo,
  type DatasetType,
} from "@/services/dataSnapshots";
import {
  getImportBatchTransactionCounts,
  getWarehouseTransactionCount,
  importTransactionsToWarehouse,
  isTransactionWarehouseEnabled,
  listImportBatches,
  previewDuplicateCleanup,
  type DuplicateCleanupResult,
  type ImportBatchInfo,
  type ImportBatchStatus,
  type WarehouseImportSummary,
} from "@/services/transactionWarehouse";
import {
  cleanupDuplicateImportsAndRefresh,
  deleteImportBatchAndRefresh,
  refreshLocalAnalyticsCacheFromWarehouse,
  rollbackImportBatchAndRefresh,
} from "@/services/analyticsAdapters";
import { autoSyncClickHouseAfterImport } from "@/services/clickhouse";
import type { Transaction } from "@/services/types";
import type { SubscriptionClean } from "@/types/subscriptions";
import type { TrafficMetric } from "@/services/trafficImport";

const NONE = "__none__";

const DEFAULT_IMPORT_UI_STATE = {
  tab: "csv" as "csv" | "google",
  importMode: "clean_template" as "clean_template" | "palmer_raw",
  sheetUrl: "",
  trafficSheetUrl: "",
  trafficYear: String(new Date().getFullYear()),
  trafficGid: "",
};

const CLOUD_DATASET_TYPES: DatasetType[] = [
  "palmer",
  "funnelfox_subscriptions",
  "facebook_traffic",
  "forecasting_settings",
  "cohorts_ui_settings",
];

const DIAGNOSTIC_LABELS: { key: keyof PalmerImportDiagnostics; label: string }[] = [
  { key: "totalRows", label: "Total rows" },
  { key: "rowsWithAmountUsd", label: "Rows with amount_usd" },
  { key: "successRows", label: "Status = success" },
  { key: "trialRows", label: "Type = trial" },
  { key: "upsellRows", label: "Type = upsell" },
  { key: "firstSubscriptionRows", label: "Type = first_subscription" },
  { key: "rowsWithCohortId", label: "Rows with cohort_id" },
  { key: "unknownFunnelRows", label: "Funnel = unknown" },
  { key: "unclassifiedSuccessfulSubscriptionRows", label: "Unclassified success $29.99" },
  { key: "uniqueUserIdCount", label: "Unique user_id count" },
  { key: "missingEmailCount", label: "Missing email count" },
  { key: "missingCustomerIdCount", label: "Missing customerId count" },
  { key: "fallbackUnknownUserCount", label: "Fallback unknown_user count" },
];

function importBatchDateRange(batch: ImportBatchInfo): string {
  const metadata = batch.metadata;
  const dateRange = metadata && typeof metadata.date_range === "object" && metadata.date_range !== null
    ? metadata.date_range as Record<string, unknown>
    : null;
  const from = typeof dateRange?.from === "string" ? dateRange.from : null;
  const to = typeof dateRange?.to === "string" ? dateRange.to : null;
  if (!from || !to) return "—";
  return from === to ? from : `${from} → ${to}`;
}

const STATUS_BADGE_CLASSES: Record<ImportBatchStatus, string> = {
  completed: "bg-success/15 text-success",
  failed: "bg-destructive/15 text-destructive",
  cancelled: "bg-destructive/15 text-destructive",
  rolled_back: "bg-muted text-muted-foreground",
  processing: "bg-primary/15 text-primary",
};

function ImportStatusBadge({ status, isDuplicate }: { status: ImportBatchStatus; isDuplicate: boolean }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <span
        className={cn(
          "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium capitalize",
          STATUS_BADGE_CLASSES[status] ?? "bg-muted text-muted-foreground",
        )}
      >
        {status.replace("_", " ")}
      </span>
      {isDuplicate && (
        <span className="inline-flex items-center rounded-full bg-warning/20 px-2 py-0.5 text-[11px] font-medium text-warning">
          Duplicate
        </span>
      )}
    </span>
  );
}

/** Older completed batches sharing a checksum with a newer completed batch (yellow "Duplicate" badge). */
function duplicateBatchIds(batches: ImportBatchInfo[]): Set<string> {
  const newestByChecksum = new Map<string, ImportBatchInfo>();
  for (const batch of batches) {
    if (batch.status !== "completed" || !batch.checksum) continue;
    const current = newestByChecksum.get(batch.checksum);
    if (!current || batch.imported_at > current.imported_at) newestByChecksum.set(batch.checksum, batch);
  }
  const ids = new Set<string>();
  for (const batch of batches) {
    if (batch.status !== "completed" || !batch.checksum) continue;
    const newest = newestByChecksum.get(batch.checksum);
    if (newest && newest.id !== batch.id) ids.add(batch.id);
  }
  return ids;
}

export default function ImportPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const meta = useDataStore((s) => s.meta);
  const transactions = useDataStore((s) => s.transactions);
  const rawPalmerRows = useDataStore((s) => s.rawPalmerRows);
  const trafficMetrics = useDataStore((s) => s.trafficMetrics);
  const trafficMeta = useDataStore((s) => s.trafficMeta);
  const subscriptions = useDataStore((s) => s.subscriptions);
  const setImported = useDataStore((s) => s.setImported);
  const setTrafficMetrics = useDataStore((s) => s.setTrafficMetrics);
  const setSubscriptions = useDataStore((s) => s.setSubscriptions);
  const resetToMock = useDataStore((s) => s.resetToMock);

  const [uiState, setUiState] = usePersistedPageState("ui_state_import_data", DEFAULT_IMPORT_UI_STATE);
  const { tab, importMode, sheetUrl, trafficSheetUrl, trafficYear, trafficGid } = uiState;
  const updateUiState = (patch: Partial<typeof DEFAULT_IMPORT_UI_STATE>) => setUiState((current) => ({ ...current, ...patch }));
  const [parsed, setParsed] = useState<ParsedSheet | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping>({});
  const [sourceLabel, setSourceLabel] = useState<string>("");
  const [sourceFileSize, setSourceFileSize] = useState<number | undefined>(undefined);
  const [sourceKind, setSourceKind] = useState<"csv" | "google_sheet">("csv");
  const [loading, setLoading] = useState(false);
  const [cacheSavedMessage, setCacheSavedMessage] = useState<string | null>(null);
  const [trafficLoading, setTrafficLoading] = useState(false);
  const [palmerCacheInfo, setPalmerCacheInfo] = useState<PalmerCacheMetadata | null>(null);
  const [palmerCacheLoading, setPalmerCacheLoading] = useState(false);
  const [palmerCacheMessage, setPalmerCacheMessage] = useState<string | null>(null);
  const [palmerCacheError, setPalmerCacheError] = useState<string | null>(null);
  const [subscriptionCacheInfo, setSubscriptionCacheInfo] = useState<SubscriptionCacheMetadata | null>(null);
  const [subscriptionCacheLoading, setSubscriptionCacheLoading] = useState(false);
  const [trafficCacheInfo, setTrafficCacheInfo] = useState<TrafficCacheMetadata | null>(null);
  const [trafficCacheLoading, setTrafficCacheLoading] = useState(false);
  const [trafficCacheMessage, setTrafficCacheMessage] = useState<string | null>(null);
  const [trafficCacheError, setTrafficCacheError] = useState<string | null>(null);
  const [trafficTabs, setTrafficTabs] = useState<GoogleSheetTab[]>([]);
  const [trafficTabsLoading, setTrafficTabsLoading] = useState(false);
  const [trafficTabsError, setTrafficTabsError] = useState<string | null>(null);
  const [cloudSnapshots, setCloudSnapshots] = useState<Record<DatasetType, CloudSnapshotInfo | null>>({
    palmer: null,
    funnelfox_subscriptions: null,
    facebook_traffic: null,
    forecasting_settings: null,
    cohorts_ui_settings: null,
  });
  const [cloudLoading, setCloudLoading] = useState<DatasetType | null>(null);
  const [cloudMessage, setCloudMessage] = useState<string | null>(null);
  const [cloudError, setCloudError] = useState<string | null>(null);
  const [funnelFoxSecret, setFunnelFoxSecret] = useState("");
  const [testingFunnelFox, setTestingFunnelFox] = useState(false);
  const [syncingFunnelFox, setSyncingFunnelFox] = useState(false);
  const [funnelFoxConnectionMessage, setFunnelFoxConnectionMessage] = useState<string | null>(null);
  const [funnelFoxConnectionError, setFunnelFoxConnectionError] = useState<string | null>(null);
  const [funnelFoxSyncMessage, setFunnelFoxSyncMessage] = useState<string | null>(null);
  const [funnelFoxSyncError, setFunnelFoxSyncError] = useState<string | null>(null);
  // Staged, resumable FunnelFox subscriptions sync.
  const [stagedSyncing, setStagedSyncing] = useState(false);
  const [stagedSyncState, setStagedSyncState] = useState<FunnelFoxSubscriptionsSyncState | null>(null);
  const [stagedSyncStep, setStagedSyncStep] = useState<FunnelFoxSubscriptionsSyncResponse | null>(null);
  const [stagedSyncError, setStagedSyncError] = useState<string | null>(null);
  const [stagedSyncMessage, setStagedSyncMessage] = useState<string | null>(null);
  const cancelStagedSyncRef = useRef(false);
  const [retentionCurveDraft, setRetentionCurveDraft] = useState<string[]>(() => loadDefaultRetentionCurve().map(String));
  const [retentionCurveMessage, setRetentionCurveMessage] = useState<string | null>(null);
  const [maxRenewalColumns, setMaxRenewalColumns] = useState(loadMaxRenewalColumns);
  const [dataSettingsMessage, setDataSettingsMessage] = useState<string | null>(null);
  const [warehouseHistory, setWarehouseHistory] = useState<ImportBatchInfo[]>([]);
  const [warehouseLoading, setWarehouseLoading] = useState(false);
  const [warehouseMessage, setWarehouseMessage] = useState<string | null>(null);
  const [warehouseError, setWarehouseError] = useState<string | null>(null);
  const [warehouseSummary, setWarehouseSummary] = useState<WarehouseImportSummary | null>(null);
  const [warehouseTransactionCount, setWarehouseTransactionCount] = useState<number | null>(null);
  // Automatic post-import ClickHouse sync (reuses the Continue Backfill path).
  const [clickHouseSyncPhase, setClickHouseSyncPhase] =
    useState<"idle" | "syncing" | "done" | "skipped" | "failed">("idle");
  const [clickHouseSyncMessage, setClickHouseSyncMessage] = useState<string | null>(null);
  // Guards background setState after the page unmounts (the sync keeps running).
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);
  const [batchTransactionCounts, setBatchTransactionCounts] = useState<Map<string, number>>(new Map());
  const [expandedBatchId, setExpandedBatchId] = useState<string | null>(null);
  const [managementBusy, setManagementBusy] = useState(false);
  const [pendingImportAction, setPendingImportAction] = useState<{ type: "delete" | "rollback"; batch: ImportBatchInfo } | null>(null);
  const [cleanupPreview, setCleanupPreview] = useState<DuplicateCleanupResult | null>(null);

  const temporaryKeyInputEnabled = isFunnelFoxTemporaryKeyInputEnabled();
  const warehouseEnabled = isTransactionWarehouseEnabled();

  const refreshLocalCacheInfo = useCallback(async () => {
    const [palmerInfo, funnelFoxInfo, trafficInfo, cloudInfo, importBatches, warehouseCount, batchCounts] = await Promise.all([
      getPalmerCacheInfo().catch(() => null),
      getSubscriptionsCacheInfo().catch(() => null),
      getTrafficCacheInfo().catch(() => null),
      getCloudSnapshotInfos(CLOUD_DATASET_TYPES).catch(() => null),
      warehouseEnabled ? listImportBatches(10).catch(() => null) : Promise.resolve(null),
      warehouseEnabled ? getWarehouseTransactionCount().catch(() => null) : Promise.resolve(null),
      warehouseEnabled ? getImportBatchTransactionCounts().catch(() => null) : Promise.resolve(null),
    ]);
    setPalmerCacheInfo(palmerInfo);
    setSubscriptionCacheInfo(funnelFoxInfo);
    setTrafficCacheInfo(trafficInfo);
    if (cloudInfo) setCloudSnapshots(cloudInfo);
    if (importBatches) setWarehouseHistory(importBatches);
    setWarehouseTransactionCount(warehouseCount);
    if (batchCounts) setBatchTransactionCounts(batchCounts);
  }, [warehouseEnabled]);

  useEffect(() => {
    void refreshLocalCacheInfo();
  }, [refreshLocalCacheInfo]);

  const requiredMissing = useMemo(
    () =>
      importMode === "palmer_raw"
        ? []
        : TARGET_FIELDS.filter((f) => f.required && !mapping[f.key]),
    [importMode, mapping]
  );

  const previewRows: Transaction[] = useMemo(() => {
    if (!parsed) return [];
    if (importMode === "palmer_raw") return transformPalmerRows(parsed.rows as RawPalmerRow[]).slice(0, 5);
    return applyMapping({ headers: parsed.headers, rows: parsed.rows.slice(0, 5) }, mapping).rows;
  }, [parsed, importMode, mapping]);

  const subscriptionEmailDiagnostics = useMemo(() => {
    const total = subscriptions.length;
    const withEmail = subscriptions.filter((sub) => Boolean(sub.email)).length;
    const missingEmail = total - withEmail;
    const coverage = total ? (withEmail / total) * 100 : 0;
    return { total, withEmail, missingEmail, coverage };
  }, [subscriptions]);

  const currentDatasetSource = warehouseTransactionCount != null && warehouseTransactionCount > 0
    ? "Transaction warehouse"
    : meta.source.replace("_", " ");
  const currentDatasetRows = warehouseTransactionCount ?? meta.rowCount;
  const analyticsCacheIsWarehouse = meta.source === "transaction_warehouse";

  const trafficSheetRef = useMemo(() => parseGoogleSheetReference(trafficSheetUrl), [trafficSheetUrl]);
  const effectiveTrafficGid = trafficGid.trim() || trafficSheetRef?.gid || "0";
  const selectedTrafficTab = useMemo(
    () => trafficTabs.find((sheetTab) => sheetTab.gid === effectiveTrafficGid),
    [trafficTabs, effectiveTrafficGid],
  );

  function funnelFoxSecretOptions() {
    if (!temporaryKeyInputEnabled) return undefined;
    const secret = funnelFoxSecret.trim();
    return secret ? { secret } : undefined;
  }

  function handleParsed(p: ParsedSheet, label: string, kind: "csv" | "google_sheet", fileSize?: number) {
    if (!p.headers.length || !p.rows.length) {
      toast({
        title: "Empty file",
        description: "No rows were detected in the source.",
        variant: "destructive",
      });
      return;
    }
    setParsed(p);
    setMapping(autoMap(p.headers));
    setSourceLabel(label);
    setSourceFileSize(fileSize);
    setSourceKind(kind);
  }

  async function onFile(file: File) {
    try {
      setLoading(true);
      const p = await parseCSVFile(file);
      handleParsed(p, file.name, "csv", file.size);
    } catch (e) {
      toast({
        title: "Could not parse CSV",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }

  async function onLoadSheet() {
    if (!sheetUrl.trim()) return;
    try {
      setLoading(true);
      const p = await fetchGoogleSheetCsv(sheetUrl);
      handleParsed(p, sheetUrl, "google_sheet");
    } catch (e) {
      toast({
        title: "Could not load Google Sheet",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }

  function onTrafficSheetUrlChange(value: string) {
    const ref = parseGoogleSheetReference(value);
    updateUiState({ trafficSheetUrl: value, trafficGid: ref?.gid ?? "" });
    setTrafficTabs([]);
    setTrafficTabsError(null);
  }

  async function onLoadTrafficTabs() {
    if (!trafficSheetUrl.trim()) return;
    try {
      setTrafficTabsLoading(true);
      setTrafficTabsError(null);
      const tabs = await fetchGoogleSheetTrafficTabs(trafficSheetUrl);
      setTrafficTabs(tabs);
      const selected = tabs.find((sheetTab) => sheetTab.gid === effectiveTrafficGid);
      if (!selected && tabs[0]) {
        updateUiState({ trafficGid: tabs[0].gid });
      }
    } catch (error) {
      setTrafficTabs([]);
      setTrafficTabsError(error instanceof Error ? error.message : "Could not load Google Sheet tabs.");
    } finally {
      setTrafficTabsLoading(false);
    }
  }

  async function onImportFacebookTraffic() {
    if (!trafficSheetUrl.trim()) return;
    try {
      setTrafficLoading(true);
      setTrafficCacheMessage(null);
      setTrafficCacheError(null);
      const year = Number(trafficYear) || new Date().getFullYear();
      const importResult = await fetchFacebookTrafficImportFromGoogleSheet(trafficSheetUrl, year, {
        gid: effectiveTrafficGid,
        tabName: selectedTrafficTab?.name,
      });
      const rows = importResult.rows;
      setTrafficMetrics(rows);
      const cacheMetadata = await saveTrafficDataToCache(rows, {
        google_sheet_url: trafficSheetUrl.trim(),
        sheet_id: importResult.sheetId,
        gid: importResult.gid,
        tab_name: importResult.tabName,
        year,
      });
      setTrafficCacheInfo(cacheMetadata);
      setTrafficCacheMessage("Saved imported Facebook traffic data locally.");
      try {
        const cloudInfo = await saveCloudSnapshot({
          datasetType: "facebook_traffic",
          name: "Facebook traffic",
          payload: { trafficMetrics: rows },
          metadata: cacheMetadata,
        });
        if (cloudInfo) {
          setCloudSnapshots((current) => ({ ...current, facebook_traffic: cloudInfo }));
        }
      } catch (error) {
        setTrafficCacheMessage(
          `Saved imported Facebook traffic data locally. Cloud save failed: ${
            error instanceof Error ? error.message : "Unknown error"
          }`,
        );
      }
      toast({
        title: "Facebook traffic imported",
        description: `Loaded ${rows.length} traffic rows from Google Sheets and saved them locally.`,
      });
    } catch (error) {
      toast({
        title: "Could not import Facebook traffic",
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      });
    } finally {
      setTrafficLoading(false);
    }
  }

  async function onLoadSavedTrafficData() {
    try {
      setTrafficCacheLoading(true);
      setTrafficCacheMessage(null);
      setTrafficCacheError(null);
      const cached = await loadLastTrafficDataFromCache();
      if (!cached) {
        setTrafficCacheInfo(null);
        setTrafficCacheMessage("No saved Facebook traffic data found.");
        return;
      }

      setTrafficMetrics(cached.trafficMetrics);
      setTrafficCacheInfo(cached.metadata);
      setTrafficCacheMessage("Loaded saved Facebook traffic data");
      toast({
        title: "Loaded saved Facebook traffic data",
        description: `Loaded ${cached.trafficMetrics.length} traffic rows from local cache.`,
      });
    } catch (error) {
      setTrafficCacheError(error instanceof Error ? error.message : "Could not load saved Facebook traffic data.");
    } finally {
      setTrafficCacheLoading(false);
    }
  }

  async function onClearSavedTrafficData() {
    try {
      setTrafficCacheLoading(true);
      setTrafficCacheMessage(null);
      setTrafficCacheError(null);
      await clearTrafficDataCache();
      setTrafficCacheInfo(null);
      setTrafficCacheMessage("Saved Facebook traffic cache cleared. Current data remains loaded.");
    } catch (error) {
      setTrafficCacheError(error instanceof Error ? error.message : "Could not clear saved Facebook traffic data.");
    } finally {
      setTrafficCacheLoading(false);
    }
  }

  // Automatically synchronize the just-imported transactions into ClickHouse by
  // reusing the exact "Continue Backfill" code path. Runs in the background so
  // the import completes instantly; never throws (import stays successful).
  async function triggerAutoClickHouseSync() {
    if (!warehouseEnabled) return;
    const setPhase = (phase: typeof clickHouseSyncPhase, message: string | null) => {
      if (!isMountedRef.current) return;
      setClickHouseSyncPhase(phase);
      setClickHouseSyncMessage(message);
    };
    console.info("[auto-sync] Import completed → starting automatic ClickHouse synchronization");
    setPhase("syncing", "Synchronizing ClickHouse…");
    try {
      const outcome = await autoSyncClickHouseAfterImport();
      if (outcome.skipped) {
        console.info("Auto sync skipped: synchronization already running");
        setPhase("skipped", "ClickHouse sync already running — it will include these rows.");
        return;
      }
      console.info(
        `[auto-sync] rows processed: scanned ${outcome.rows_scanned}, inserted ${outcome.rows_inserted}; ` +
          `cursor ${outcome.cursor_transaction_id ?? "—"}; status ${outcome.status}/${outcome.stopped_reason}; ` +
          `${outcome.duration_ms}ms; completed`,
      );
      if (outcome.status === "failed") {
        setPhase("failed", "ClickHouse sync failed. Transactions are saved — use Continue Backfill to retry.");
        toast({
          title: "ClickHouse sync failed",
          description: "Import is saved in Supabase. Press Continue Backfill on Integrations to retry.",
          variant: "destructive",
        });
        return;
      }
      setPhase("done", `Analytics updated — synced ${outcome.rows_inserted.toLocaleString("en-US")} new rows into ClickHouse.`);
      // ClickHouse auto-sync completed successfully → advance the warehouse version
      // and invalidate warehouse-dependent analytics caches (Cohorts, details,
      // Users, Payment Analytics). Active pages refetch the new warehouse state;
      // inactive pages refresh on next visit. Only runs AFTER sync completes, so a
      // refetch never reads the pre-sync ClickHouse state.
      void invalidateWarehouseAnalyticsCache(queryClient);
      toast({
        title: "Analytics updated",
        description: `ClickHouse synchronized (+${outcome.rows_inserted.toLocaleString("en-US")} rows) in ${(outcome.duration_ms / 1000).toFixed(1)}s.`,
      });
    } catch (error) {
      console.error("[auto-sync] automatic ClickHouse synchronization failed", error);
      setPhase("failed", "ClickHouse sync failed. Transactions are saved — use Continue Backfill to retry.");
      toast({
        title: "ClickHouse sync failed",
        description: "Import is saved in Supabase. Press Continue Backfill on Integrations to retry.",
        variant: "destructive",
      });
    }
  }

  async function confirmImport() {
    if (!parsed) return;
    if (requiredMissing.length) {
      toast({
        title: "Missing required mappings",
        description: requiredMissing.map((f) => f.label).join(", "),
        variant: "destructive",
      });
      return;
    }
    const rawRows = parsed.rows as RawPalmerRow[];
    const rows = importMode === "palmer_raw" ? transformPalmerRows(rawRows) : applyMapping(parsed, mapping).rows;
    const diagnostics =
      importMode === "palmer_raw" ? getPalmerImportDiagnostics(rows, rawRows.length, rawRows) : undefined;
    const importedAt = new Date().toISOString();

    setImported(rows, {
      source: importMode === "palmer_raw" ? "palmer_raw" : sourceKind,
      importMode,
      fileName: sourceKind === "csv" ? sourceLabel : undefined,
      sheetUrl: sourceKind === "google_sheet" ? sourceLabel : undefined,
      diagnostics,
    }, importMode === "palmer_raw" ? rawRows : undefined);

    if (importMode === "palmer_raw") {
      try {
        const cacheMetadata = await savePalmerDatasetToCache(
          {
            transactions: rows,
            rawPalmerRows: rawRows,
          },
          {
            file_name: sourceKind === "csv" ? sourceLabel : "Palmer import",
            imported_at: importedAt,
            rows_count: rawRows.length,
            transactions_count: rows.length,
          },
        );
        setCacheSavedMessage(
          `Saved imported dataset locally: ${cacheMetadata.file_name}, ${cacheMetadata.rows_count} rows.`,
        );
        setPalmerCacheInfo(cacheMetadata);
        try {
          const cloudInfo = await saveCloudSnapshot({
            datasetType: "palmer",
            name: cacheMetadata.file_name,
            payload: buildPalmerCloudPayload(rows, rawRows),
            metadata: {
              ...cacheMetadata,
              ...buildPalmerCloudMetadata({
                transactions: rows,
                rawPalmerRows: rawRows,
                fileName: cacheMetadata.file_name,
                importedAt: cacheMetadata.imported_at,
              }),
            },
          });
          if (cloudInfo) {
            setCloudSnapshots((current) => ({ ...current, palmer: cloudInfo }));
          }
        } catch (error) {
          setCacheSavedMessage(
            `Saved imported dataset locally. Cloud save failed: ${
              error instanceof Error ? error.message : "Unknown error"
            }`,
          );
        }
      } catch (error) {
        setCacheSavedMessage(null);
        toast({
          title: "Import complete, local save failed",
          description: error instanceof Error ? error.message : "Could not save imported dataset locally.",
          variant: "destructive",
        });
      }
    } else {
      setCacheSavedMessage(null);
    }

    if (warehouseEnabled) {
      try {
        setWarehouseLoading(true);
        setWarehouseMessage(null);
        setWarehouseError(null);
        const summary = await importTransactionsToWarehouse({
          rows,
          rawRows: importMode === "palmer_raw" ? rawRows : parsed.rows,
          filename: sourceKind === "csv" ? sourceLabel : undefined,
          fileSize: sourceFileSize,
          source: importMode === "palmer_raw" ? "palmer_csv" : "primer_csv",
          sourceKind,
          importedFrom: sourceLabel,
          importMode,
        });
        setWarehouseSummary(summary);
        // Import is committed to Supabase — kick off the automatic ClickHouse
        // sync now (background). Placed before the local-cache refresh so a
        // local-cache hiccup can never block warehouse synchronization, and it
        // never blocks the import from completing (fire-and-forget).
        void triggerAutoClickHouseSync();
        const warehouseRows = await refreshLocalAnalyticsCacheFromWarehouse();
        setWarehouseMessage(
          `Warehouse updated: ${summary.inserted} inserted, ${summary.updated} updated, ${summary.skipped} skipped, ${summary.failed} failed. Analytics now use ${warehouseRows.length} merged DB transactions.`,
        );
        await refreshLocalCacheInfo();
      } catch (error) {
        setWarehouseError(error instanceof Error ? error.message : "Could not save transactions to warehouse.");
      } finally {
        setWarehouseLoading(false);
      }
    } else {
      setWarehouseMessage("Transaction warehouse is disabled or Supabase is not configured. Local import completed.");
    }

    toast({
      title: "Import complete",
      description: `Loaded ${rows.length} transactions from ${
        importMode === "palmer_raw" ? "Palmer raw export" : sourceKind === "csv" ? "CSV" : "Google Sheet"
      }.${importMode === "palmer_raw" ? " Saved imported dataset locally." : ""}`,
    });
    setParsed(null);
    setMapping({});
    setSourceFileSize(undefined);
  }

  async function onRefreshWarehouseHistory() {
    if (!warehouseEnabled) return;
    try {
      setWarehouseLoading(true);
      setWarehouseError(null);
      const batches = await listImportBatches(10);
      setWarehouseHistory(batches);
      setWarehouseMessage("Import history refreshed.");
    } catch (error) {
      setWarehouseError(error instanceof Error ? error.message : "Could not refresh import history.");
    } finally {
      setWarehouseLoading(false);
    }
  }

  async function onConfirmImportAction() {
    if (!pendingImportAction) return;
    const { type, batch } = pendingImportAction;
    try {
      setManagementBusy(true);
      setWarehouseError(null);
      const { result, transactions } =
        type === "delete"
          ? await deleteImportBatchAndRefresh(batch.id)
          : await rollbackImportBatchAndRefresh(batch.id);
      await refreshLocalCacheInfo();
      const label = type === "delete" ? "Import deleted" : "Import rolled back";
      setWarehouseMessage(
        `${label}: ${result.deletedTransactions} transactions removed. Analytics now use ${transactions} merged DB transactions.`,
      );
      toast({ title: label, description: `${result.deletedTransactions} transactions removed; analytics refreshed.` });
    } catch (error) {
      setWarehouseError(error instanceof Error ? error.message : "Could not complete the import action.");
    } finally {
      setManagementBusy(false);
      setPendingImportAction(null);
    }
  }

  async function onPreviewCleanup() {
    if (!warehouseEnabled) return;
    try {
      setManagementBusy(true);
      setWarehouseError(null);
      const preview = await previewDuplicateCleanup();
      setCleanupPreview(preview);
    } catch (error) {
      setWarehouseError(error instanceof Error ? error.message : "Could not analyze duplicate imports.");
    } finally {
      setManagementBusy(false);
    }
  }

  async function onConfirmCleanup() {
    try {
      setManagementBusy(true);
      setWarehouseError(null);
      const { result, transactions } = await cleanupDuplicateImportsAndRefresh();
      await refreshLocalCacheInfo();
      setWarehouseMessage(
        `Cleanup removed ${result.duplicateImports} duplicate and ${result.failedImports} failed/cancelled imports (${result.transactionsRemoved} transactions). Analytics now use ${transactions} merged DB transactions.`,
      );
      toast({
        title: "Duplicate imports cleaned up",
        description: `${result.duplicateImports + result.failedImports} imports and ${result.transactionsRemoved} transactions removed.`,
      });
    } catch (error) {
      setWarehouseError(error instanceof Error ? error.message : "Could not clean up duplicate imports.");
    } finally {
      setManagementBusy(false);
      setCleanupPreview(null);
    }
  }

  async function onRefreshLocalCacheFromWarehouse() {
    try {
      setWarehouseLoading(true);
      setWarehouseError(null);
      const rows = await refreshLocalAnalyticsCacheFromWarehouse();
      setWarehouseMessage(`Loaded ${rows.length} transactions from Supabase into the local analytics cache.`);
      toast({
        title: "Local cache refreshed",
        description: `Analytics now use ${rows.length} transactions loaded from the transaction warehouse.`,
      });
    } catch (error) {
      setWarehouseError(error instanceof Error ? error.message : "Could not refresh local cache from warehouse.");
    } finally {
      setWarehouseLoading(false);
    }
  }

  async function onRecalculateAnalyticsFromDb() {
    await onRefreshLocalCacheFromWarehouse();
  }

  async function onTestFunnelFoxConnection() {
    try {
      setTestingFunnelFox(true);
      setFunnelFoxConnectionMessage(null);
      setFunnelFoxConnectionError(null);
      const result = await testFunnelFoxConnection(funnelFoxSecretOptions());
      if (!result.secret_exists) {
        setFunnelFoxConnectionError("Add FunnelFox Secret Key or configure FUNNELFOX_SECRET on the server.");
        return;
      }
      if (!result.can_call_funnelfox) {
        setFunnelFoxConnectionError("Could not connect to FunnelFox. Check the key and try again.");
        return;
      }
      setFunnelFoxConnectionMessage(`Connection successful. Returned ${result.subscription_count} subscriptions.`);
    } catch (error) {
      setFunnelFoxConnectionError(error instanceof Error ? error.message : "Could not test FunnelFox connection.");
    } finally {
      setTestingFunnelFox(false);
    }
  }

  async function onSyncFunnelFoxSubscriptions() {
    try {
      setSyncingFunnelFox(true);
      setFunnelFoxSyncError(null);
      setFunnelFoxSyncMessage(null);
      const result = await syncAllSubscriptionsWithDiagnostics(funnelFoxSecretOptions());
      const { rows, diagnostics } = result;
      console.info("FunnelFox sync result count before store update", { count: rows.length });
      setSubscriptions(rows);
      console.info("FunnelFox store subscriptions count after setSubscriptions", {
        count: useDataStore.getState().subscriptions.length,
      });
      const cacheMetadata = await saveSubscriptionsToCache(rows, {
        last_sync_at: new Date().toISOString(),
      });
      setSubscriptionCacheInfo(cacheMetadata);
      let cloudWarning: string | null = null;
      try {
        const cloudInfo = await saveCloudSnapshot({
          datasetType: "funnelfox_subscriptions",
          name: "FunnelFox subscriptions",
          payload: { subscriptions: rows },
          metadata: cacheMetadata,
        });
        if (cloudInfo) {
          setCloudSnapshots((current) => ({ ...current, funnelfox_subscriptions: cloudInfo }));
        }
      } catch (error) {
        cloudWarning = ` Cloud save failed: ${error instanceof Error ? error.message : "Unknown error"}.`;
      }
      const coverage = diagnostics.total_subscriptions
        ? ((diagnostics.total_subscriptions - diagnostics.missing_email_after_details) / diagnostics.total_subscriptions) * 100
        : 0;
      const failedDetailRequests = diagnostics.warnings.length;
      setFunnelFoxSyncMessage(
        rows.length
          ? `${failedDetailRequests ? "Sync completed with partial enrichment warnings" : "Sync completed"}. Total subscriptions loaded: ${diagnostics.total_subscriptions}. Raw subscriptions: ${diagnostics.raw_subscriptions_count}. Duplicates removed: ${diagnostics.duplicates_removed}. Email coverage: ${diagnostics.total_subscriptions - diagnostics.missing_email_after_details}/${diagnostics.total_subscriptions} (${formatPct(coverage)}). Missing emails: ${diagnostics.missing_email_after_details}. Failed detail/profile requests: ${failedDetailRequests}.${cloudWarning ?? ""}`
          : "Mock mode is active or the backend proxy returned no subscriptions.",
      );
      toast({
        title: "FunnelFox sync complete",
        description: `Loaded ${rows.length} subscriptions.`,
      });
    } catch (error) {
      if (useDataStore.getState().subscriptions.length > 0) {
        setFunnelFoxSyncMessage("Sync failed before new data loaded. Keeping existing subscriptions visible.");
      } else {
        setFunnelFoxSyncError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      setSyncingFunnelFox(false);
    }
  }

  const refreshStagedSyncState = useCallback(async () => {
    try {
      const state = await getFunnelFoxSubscriptionsSyncState();
      setStagedSyncState(state);
    } catch (error) {
      console.warn("Could not load FunnelFox subscriptions sync state.", error);
    }
  }, []);

  // Load durable sync state + restore subscriptions from the durable table on mount.
  const stagedSyncLoadedRef = useRef(false);
  useEffect(() => {
    if (stagedSyncLoadedRef.current) return;
    stagedSyncLoadedRef.current = true;
    void refreshStagedSyncState();
  }, [refreshStagedSyncState]);

  // Reload the store's subscriptions from the durable table after a sync (no manual "refresh cache").
  const reloadSubscriptionsFromDurable = useCallback(async () => {
    try {
      const rows = await loadFunnelFoxSubscriptions();
      if (rows.length) {
        setSubscriptions(rows);
        const cacheMetadata = await saveSubscriptionsToCache(rows, { last_sync_at: new Date().toISOString() });
        setSubscriptionCacheInfo(cacheMetadata);
      }
      return rows.length;
    } catch (error) {
      // Do not silently fall back to stale/mock data — surface it.
      setStagedSyncError(
        `Sync saved to the server, but reloading it into the app failed: ${error instanceof Error ? error.message : "Unknown error"}.`,
      );
      return null;
    }
  }, [setSubscriptions]);

  const runStagedSync = useCallback(
    async (options: { fullReset?: boolean; dryRun?: boolean }) => {
      setStagedSyncing(true);
      setStagedSyncError(null);
      setStagedSyncMessage(null);
      setStagedSyncStep(null);
      cancelStagedSyncRef.current = false;
      try {
        if (options.dryRun) {
          const dry = await syncFunnelFoxSubscriptions({ dryRun: true });
          setStagedSyncStep(dry);
          const d = dry.diagnostics ?? {};
          setStagedSyncMessage(
            `Dry run: probed ${d.subscriptions_pages_probed ?? 0} page(s), ${d.subscriptions_rows_probed ?? 0} subscriptions, ${d.rows_with_email ?? 0} with email, ${d.rows_needing_detail ?? 0} need detail. No data written.`,
          );
          return;
        }
        const final = await runFunnelFoxSubscriptionsSync({
          fullReset: options.fullReset,
          onProgress: (res) => setStagedSyncStep(res),
          shouldCancel: () => cancelStagedSyncRef.current,
        });
        await refreshStagedSyncState();
        const restored = await reloadSubscriptionsFromDurable();
        const summary = final.summary;
        if (cancelStagedSyncRef.current) {
          setStagedSyncMessage("Sync cancelled. Progress was saved — click Continue Sync to resume.");
        } else if (final.all_stages_completed) {
          setStagedSyncMessage(
            `All FunnelFox subscriptions were synced. Saved ${summary?.subscriptions_saved ?? restored ?? 0}, email coverage ${summary?.subscriptions_with_email ?? 0}/${summary?.subscriptions_saved ?? 0}.`,
          );
        } else {
          setStagedSyncMessage(
            `Sync is partial (${final.stopped_reason ?? "stopped"}). Click Continue Sync to resume from the last cursor.`,
          );
        }
      } catch (error) {
        setStagedSyncError(error instanceof Error ? error.message : String(error));
      } finally {
        cancelStagedSyncRef.current = false;
        setStagedSyncing(false);
      }
    },
    [refreshStagedSyncState, reloadSubscriptionsFromDurable],
  );

  const onStartFullStagedSync = useCallback(() => runStagedSync({ fullReset: false }), [runStagedSync]);
  const onContinueStagedSync = useCallback(() => runStagedSync({ fullReset: false }), [runStagedSync]);
  const onForceFullResync = useCallback(() => runStagedSync({ fullReset: true }), [runStagedSync]);
  const onDryRunStagedSync = useCallback(() => runStagedSync({ dryRun: true }), [runStagedSync]);
  const onCancelStagedSync = useCallback(() => {
    cancelStagedSyncRef.current = true;
    setStagedSyncMessage("Cancelling after the current stage…");
  }, []);

  async function onLoadSavedPalmerDataset() {
    try {
      setPalmerCacheLoading(true);
      setPalmerCacheError(null);
      setPalmerCacheMessage(null);
      const cached = await loadLastPalmerDatasetFromCache();
      if (!cached) {
        setPalmerCacheInfo(null);
        setPalmerCacheMessage("No saved Palmer dataset found.");
        return;
      }
      setImported(
        cached.transactions,
        {
          source: "palmer_raw",
          importMode: "palmer_raw",
          fileName: cached.metadata.file_name,
        },
        cached.rawPalmerRows ?? [],
      );
      setPalmerCacheInfo(cached.metadata);
      setPalmerCacheMessage("Loaded saved Palmer dataset");
      try {
        const cloudInfo = await saveCloudSnapshot({
          datasetType: "palmer",
          name: cached.metadata.file_name,
          payload: buildPalmerCloudPayload(cached.transactions, cached.rawPalmerRows),
          metadata: cached.metadata,
        });
        if (cloudInfo) setCloudSnapshots((current) => ({ ...current, palmer: cloudInfo }));
      } catch (error) {
        setPalmerCacheMessage(
          `Loaded saved Palmer dataset. Cloud save failed: ${error instanceof Error ? error.message : "Unknown error"}`,
        );
      }
      toast({ title: "Loaded saved Palmer dataset", description: `${cached.metadata.rows_count} rows restored.` });
    } catch (error) {
      setPalmerCacheError(error instanceof Error ? error.message : "Could not load saved Palmer dataset.");
    } finally {
      setPalmerCacheLoading(false);
    }
  }

  async function onClearSavedPalmerDataset() {
    try {
      setPalmerCacheLoading(true);
      setPalmerCacheError(null);
      setPalmerCacheMessage(null);
      await clearPalmerDatasetCache();
      setPalmerCacheInfo(null);
      setPalmerCacheMessage("Saved Palmer dataset cache cleared. Current data remains loaded.");
    } catch (error) {
      setPalmerCacheError(error instanceof Error ? error.message : "Could not clear saved Palmer dataset.");
    } finally {
      setPalmerCacheLoading(false);
    }
  }

  async function onLoadSavedSubscriptions() {
    try {
      setSubscriptionCacheLoading(true);
      setFunnelFoxSyncError(null);
      const cached = await loadSubscriptionsFromCache();
      if (!cached) {
        setFunnelFoxSyncMessage("No saved FunnelFox subscriptions found.");
        setSubscriptionCacheInfo(null);
        return;
      }
      setSubscriptions(cached.subscriptions);
      setSubscriptionCacheInfo(cached.metadata);
      setFunnelFoxSyncMessage(`Loaded saved FunnelFox subscriptions. Total subscriptions loaded: ${cached.metadata.count}. Email coverage: ${formatPct(cached.metadata.email_coverage)}.`);
      toast({ title: "Loaded saved FunnelFox subscriptions", description: `${cached.metadata.count} subscriptions restored.` });
    } catch (error) {
      setFunnelFoxSyncError(error instanceof Error ? error.message : "Could not load saved FunnelFox subscriptions.");
    } finally {
      setSubscriptionCacheLoading(false);
    }
  }

  async function onClearSavedSubscriptions() {
    try {
      setSubscriptionCacheLoading(true);
      setFunnelFoxSyncError(null);
      await clearSubscriptionsCache();
      setSubscriptionCacheInfo(null);
      setFunnelFoxSyncMessage("Saved FunnelFox subscriptions cache cleared. Current table remains loaded.");
    } catch (error) {
      setFunnelFoxSyncError(error instanceof Error ? error.message : "Could not clear saved FunnelFox subscriptions.");
    } finally {
      setSubscriptionCacheLoading(false);
    }
  }

  async function onSavePalmerToCloud() {
    try {
      if (meta.source !== "palmer_raw") {
        setCloudMessage("Import a Palmer dataset before saving it to cloud.");
        return;
      }
      setCloudLoading("palmer");
      setCloudMessage(null);
      setCloudError(null);
      const metadata = buildPalmerCloudMetadata({
        transactions,
        rawPalmerRows,
        fileName: meta.fileName || "Palmer import",
        importedAt: meta.importedAt ?? new Date().toISOString(),
      });
      const cloudInfo = await saveCloudSnapshot({
        datasetType: "palmer",
        name: meta.fileName || "Palmer import",
        payload: buildPalmerCloudPayload(transactions, rawPalmerRows),
        metadata: {
          ...metadata,
          rows_count: meta.rawRowCount ?? metadata.rows_count,
        },
      });
      if (!cloudInfo) {
        setCloudMessage("Sign in with Supabase to save Palmer data to cloud.");
        return;
      }
      setCloudSnapshots((current) => ({ ...current, palmer: cloudInfo }));
      setCloudMessage("Palmer dataset saved to cloud.");
    } catch (error) {
      setCloudError(error instanceof Error ? error.message : "Could not save Palmer dataset to cloud.");
    } finally {
      setCloudLoading(null);
    }
  }

  async function onLoadPalmerFromCloud() {
    try {
      setCloudLoading("palmer");
      setCloudMessage(null);
      setCloudError(null);
      const snapshot = await loadLatestCloudSnapshot<PalmerCloudPayload>("palmer");
      const payload = normalizePalmerCloudPayload(snapshot?.payload);
      const cloudTransactions = payload?.transactions;
      if (!snapshot || !payload || !cloudTransactions.length) {
        setCloudMessage("No Palmer cloud snapshot found.");
        return;
      }

      setImported(
        cloudTransactions,
        {
          source: "palmer_raw",
          importMode: "palmer_raw",
          fileName: String(snapshot.metadata.file_name ?? snapshot.name ?? "Palmer import"),
        },
        payload.rawPalmerRows ?? [],
      );
      const cacheMetadata = await savePalmerDatasetToCache(
        {
          transactions: cloudTransactions,
          rawPalmerRows: payload.rawPalmerRows ?? [],
        },
        {
          file_name: String(snapshot.metadata.file_name ?? snapshot.name ?? "Palmer import"),
          imported_at: String(snapshot.metadata.imported_at ?? snapshot.updated_at),
          rows_count: Number(snapshot.metadata.rows_count ?? payload.rawPalmerRows?.length ?? cloudTransactions.length),
          transactions_count: Number(snapshot.metadata.transactions_count ?? cloudTransactions.length),
        },
      );
      setPalmerCacheInfo(cacheMetadata);
      setCloudSnapshots((current) => ({ ...current, palmer: snapshot }));
      setCloudMessage("Palmer dataset loaded from cloud.");
    } catch (error) {
      setCloudError(error instanceof Error ? error.message : "Could not load Palmer dataset from cloud.");
    } finally {
      setCloudLoading(null);
    }
  }

  async function onSaveSubscriptionsToCloud() {
    try {
      setCloudLoading("funnelfox_subscriptions");
      setCloudMessage(null);
      setCloudError(null);
      const cacheMetadata = subscriptionCacheInfo ?? {
        saved_at: new Date().toISOString(),
        count: subscriptions.length,
        source: "funnelfox" as const,
        email_coverage: subscriptions.length
          ? (subscriptions.filter((subscription) => Boolean(subscription.email)).length / subscriptions.length) * 100
          : 0,
        last_sync_at: new Date().toISOString(),
      };
      const cloudInfo = await saveCloudSnapshot({
        datasetType: "funnelfox_subscriptions",
        name: "FunnelFox subscriptions",
        payload: { subscriptions },
        metadata: cacheMetadata,
      });
      if (!cloudInfo) {
        setCloudMessage("Sign in with Supabase to save FunnelFox subscriptions to cloud.");
        return;
      }
      setCloudSnapshots((current) => ({ ...current, funnelfox_subscriptions: cloudInfo }));
      setCloudMessage("FunnelFox subscriptions saved to cloud.");
    } catch (error) {
      setCloudError(error instanceof Error ? error.message : "Could not save FunnelFox subscriptions to cloud.");
    } finally {
      setCloudLoading(null);
    }
  }

  async function onLoadSubscriptionsFromCloud() {
    try {
      setCloudLoading("funnelfox_subscriptions");
      setCloudMessage(null);
      setCloudError(null);
      const snapshot = await loadLatestCloudSnapshot<{ subscriptions?: SubscriptionClean[] }>("funnelfox_subscriptions");
      const cloudSubscriptions = snapshot?.payload.subscriptions;
      if (!snapshot || !cloudSubscriptions?.length) {
        setCloudMessage("No FunnelFox subscriptions cloud snapshot found.");
        return;
      }

      setSubscriptions(cloudSubscriptions);
      const cacheMetadata = await saveSubscriptionsToCache(cloudSubscriptions, {
        saved_at: String(snapshot.metadata.saved_at ?? snapshot.updated_at),
        last_sync_at: String(snapshot.metadata.last_sync_at ?? snapshot.updated_at),
      });
      setSubscriptionCacheInfo(cacheMetadata);
      setCloudSnapshots((current) => ({ ...current, funnelfox_subscriptions: snapshot }));
      setCloudMessage("FunnelFox subscriptions loaded from cloud.");
    } catch (error) {
      setCloudError(error instanceof Error ? error.message : "Could not load FunnelFox subscriptions from cloud.");
    } finally {
      setCloudLoading(null);
    }
  }

  async function onSaveTrafficToCloud() {
    try {
      setCloudLoading("facebook_traffic");
      setCloudMessage(null);
      setCloudError(null);
      const metadata = trafficCacheInfo ?? {
        source: "facebook_traffic" as const,
        imported_at: trafficMeta.importedAt ?? new Date().toISOString(),
        rows_count: trafficMetrics.length,
      };
      const cloudInfo = await saveCloudSnapshot({
        datasetType: "facebook_traffic",
        name: "Facebook traffic",
        payload: { trafficMetrics },
        metadata,
      });
      if (!cloudInfo) {
        setCloudMessage("Sign in with Supabase to save Facebook traffic data to cloud.");
        return;
      }
      setCloudSnapshots((current) => ({ ...current, facebook_traffic: cloudInfo }));
      setCloudMessage("Facebook traffic data saved to cloud.");
    } catch (error) {
      setCloudError(error instanceof Error ? error.message : "Could not save Facebook traffic data to cloud.");
    } finally {
      setCloudLoading(null);
    }
  }

  async function onLoadTrafficFromCloud() {
    try {
      setCloudLoading("facebook_traffic");
      setCloudMessage(null);
      setCloudError(null);
      const snapshot = await loadLatestCloudSnapshot<{ trafficMetrics?: TrafficMetric[] }>("facebook_traffic");
      const cloudTrafficMetrics = snapshot?.payload.trafficMetrics;
      if (!snapshot || !cloudTrafficMetrics?.length) {
        setCloudMessage("No Facebook traffic cloud snapshot found.");
        return;
      }

      setTrafficMetrics(cloudTrafficMetrics);
      const cacheMetadata = await saveTrafficDataToCache(cloudTrafficMetrics, {
        source: "facebook_traffic",
        google_sheet_url: typeof snapshot.metadata.google_sheet_url === "string" ? snapshot.metadata.google_sheet_url : undefined,
        sheet_id: typeof snapshot.metadata.sheet_id === "string" ? snapshot.metadata.sheet_id : undefined,
        gid: typeof snapshot.metadata.gid === "string" ? snapshot.metadata.gid : undefined,
        tab_name: typeof snapshot.metadata.tab_name === "string" ? snapshot.metadata.tab_name : undefined,
        imported_at: String(snapshot.metadata.imported_at ?? snapshot.updated_at),
        rows_count: Number(snapshot.metadata.rows_count ?? cloudTrafficMetrics.length),
        year: typeof snapshot.metadata.year === "number" ? snapshot.metadata.year : undefined,
      });
      setTrafficCacheInfo(cacheMetadata);
      setCloudSnapshots((current) => ({ ...current, facebook_traffic: snapshot }));
      setCloudMessage("Facebook traffic data loaded from cloud.");
    } catch (error) {
      setCloudError(error instanceof Error ? error.message : "Could not load Facebook traffic data from cloud.");
    } finally {
      setCloudLoading(null);
    }
  }

  async function onSaveForecastingSettingsToCloud() {
    try {
      setCloudLoading("forecasting_settings");
      setCloudMessage(null);
      setCloudError(null);
      const retentionCurve = loadDefaultRetentionCurve();
      const sanitizedMaxRenewalColumns = saveMaxRenewalColumns(maxRenewalColumns);
      const cloudInfo = await saveCloudSnapshot({
        datasetType: "forecasting_settings",
        name: "Forecasting and data settings",
        payload: { retention_curve: retentionCurve, max_renewal_columns: sanitizedMaxRenewalColumns },
        metadata: { retention_months: retentionCurve.length, max_renewal_columns: sanitizedMaxRenewalColumns },
      });
      if (!cloudInfo) {
        setCloudMessage("Sign in with Supabase to save forecasting settings to cloud.");
        return;
      }
      setCloudSnapshots((current) => ({ ...current, forecasting_settings: cloudInfo }));
      setCloudMessage("Forecasting and data settings saved to cloud.");
    } catch (error) {
      setCloudError(error instanceof Error ? error.message : "Could not save forecasting settings to cloud.");
    } finally {
      setCloudLoading(null);
    }
  }

  async function onLoadForecastingSettingsFromCloud() {
    try {
      setCloudLoading("forecasting_settings");
      setCloudMessage(null);
      setCloudError(null);
      const snapshot = await loadLatestCloudSnapshot<{ retention_curve?: number[]; max_renewal_columns?: number }>("forecasting_settings");
      if (!snapshot?.payload.retention_curve && snapshot?.payload.max_renewal_columns == null) {
        setCloudMessage("No forecasting or data settings cloud snapshot found.");
        return;
      }
      if (snapshot.payload.retention_curve) {
        const saved = saveDefaultRetentionCurve(snapshot.payload.retention_curve);
        setRetentionCurveDraft(saved.map(String));
      }
      if (snapshot.payload.max_renewal_columns != null) {
        const savedMax = saveMaxRenewalColumns(snapshot.payload.max_renewal_columns);
        setMaxRenewalColumns(savedMax);
      }
      setCloudSnapshots((current) => ({ ...current, forecasting_settings: snapshot }));
      setCloudMessage("Forecasting and data settings loaded from cloud.");
    } catch (error) {
      setCloudError(error instanceof Error ? error.message : "Could not load forecasting settings from cloud.");
    } finally {
      setCloudLoading(null);
    }
  }

  function onLoadLocalForecastingSettings() {
    const curve = loadDefaultRetentionCurve();
    setRetentionCurveDraft(curve.map(String));
    setMaxRenewalColumns(loadMaxRenewalColumns());
    setCloudError(null);
    setCloudMessage("Loaded local Forecasting and data settings.");
  }

  function onClearLocalForecastingSettings() {
    const curve = resetDefaultRetentionCurve();
    setRetentionCurveDraft(curve.map(String));
    setCloudError(null);
    setCloudMessage("Local Forecasting settings cleared. Built-in default curve is active.");
  }

  async function saveDataSettingsToCloud(nextMaxRenewalColumns = maxRenewalColumns) {
    const retentionCurve = loadDefaultRetentionCurve();
    const sanitizedMaxRenewalColumns = saveMaxRenewalColumns(nextMaxRenewalColumns);
    setMaxRenewalColumns(sanitizedMaxRenewalColumns);
    const cloudInfo = await saveCloudSnapshot({
      datasetType: "forecasting_settings",
      name: "Forecasting and data settings",
      payload: { retention_curve: retentionCurve, max_renewal_columns: sanitizedMaxRenewalColumns },
      metadata: {
        retention_months: retentionCurve.length,
        max_renewal_columns: sanitizedMaxRenewalColumns,
      },
    });
    if (cloudInfo) setCloudSnapshots((current) => ({ ...current, forecasting_settings: cloudInfo }));
    return cloudInfo;
  }

  async function onChangeMaxRenewalColumns(value: string) {
    const next = saveMaxRenewalColumns(value);
    setMaxRenewalColumns(next);
    setDataSettingsMessage("Max Renewal Columns saved locally.");
    try {
      const cloudInfo = await saveDataSettingsToCloud(next);
      setDataSettingsMessage(
        cloudInfo
          ? "Max Renewal Columns saved locally and to cloud."
          : "Max Renewal Columns saved locally. Sign in with Supabase to save it to cloud.",
      );
    } catch (error) {
      setDataSettingsMessage(
        `Max Renewal Columns saved locally. Cloud save failed: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      );
    }
  }

  function parseRetentionCurveDraftValue(value: string): number | null {
    const normalized = value.trim().replace(",", ".");
    if (!normalized) return null;
    const parsed = Number(normalized);
    if (!Number.isFinite(parsed)) return null;
    return Math.min(100, Math.max(0, parsed));
  }

  function updateRetentionCurveMonth(index: number, value: string) {
    setRetentionCurveDraft((current) =>
      current.map((item, itemIndex) =>
        itemIndex === index ? value : item,
      ),
    );
    setRetentionCurveMessage(null);
  }

  function commitRetentionCurveMonth(index: number) {
    const parsed = parseRetentionCurveDraftValue(retentionCurveDraft[index] ?? "");
    if (parsed == null) {
      setRetentionCurveMessage("Enter valid retention values from 0 to 100 before saving.");
      return;
    }
    setRetentionCurveDraft((current) => current.map((item, itemIndex) => (itemIndex === index ? String(parsed) : item)));
  }

  async function onSaveForecastingSettings() {
    const parsed = retentionCurveDraft.map(parseRetentionCurveDraftValue);
    if (parsed.some((value) => value == null)) {
      setRetentionCurveMessage("Enter valid retention values from 0 to 100 before saving.");
      return;
    }
    const saved = saveDefaultRetentionCurve(parsed as number[]);
    setRetentionCurveDraft(saved.map(String));
    const sanitizedMaxRenewalColumns = saveMaxRenewalColumns(maxRenewalColumns);
    setMaxRenewalColumns(sanitizedMaxRenewalColumns);
    try {
      const cloudInfo = await saveCloudSnapshot({
        datasetType: "forecasting_settings",
        name: "Forecasting and data settings",
        payload: { retention_curve: saved, max_renewal_columns: sanitizedMaxRenewalColumns },
        metadata: {
          retention_months: saved.length,
          max_renewal_columns: sanitizedMaxRenewalColumns,
        },
      });
      if (!cloudInfo) {
        setRetentionCurveMessage("Forecasting default retention curve saved locally. Sign in with Supabase to save it to cloud.");
        return;
      }
      setCloudSnapshots((current) => ({ ...current, forecasting_settings: cloudInfo }));
      setRetentionCurveMessage("Forecasting default retention curve and data settings saved.");
    } catch (error) {
      setRetentionCurveMessage(
        `Forecasting settings saved locally. Cloud save failed: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      );
    }
  }

  async function onResetForecastingSettings() {
    const reset = resetDefaultRetentionCurve();
    setRetentionCurveDraft(reset.map(String));
    const sanitizedMaxRenewalColumns = saveMaxRenewalColumns(maxRenewalColumns);
    setMaxRenewalColumns(sanitizedMaxRenewalColumns);
    try {
      const cloudInfo = await saveCloudSnapshot({
        datasetType: "forecasting_settings",
        name: "Forecasting and data settings",
        payload: { retention_curve: reset, max_renewal_columns: sanitizedMaxRenewalColumns },
        metadata: {
          retention_months: reset.length,
          max_renewal_columns: sanitizedMaxRenewalColumns,
          reset_to_builtin: true,
        },
      });
      if (!cloudInfo) {
        setRetentionCurveMessage("Forecasting default retention curve reset locally. Sign in with Supabase to save it to cloud.");
        return;
      }
      setCloudSnapshots((current) => ({ ...current, forecasting_settings: cloudInfo }));
      setRetentionCurveMessage("Forecasting default retention curve reset to default values.");
    } catch (error) {
      setRetentionCurveMessage(
        `Forecasting settings reset locally. Cloud save failed: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      );
    }
  }

  function renderCloudSnapshotInfo(datasetType: DatasetType, emptyLabel: string) {
    const info = cloudSnapshots[datasetType];
    if (!info) return emptyLabel;

    const size = typeof info.metadata.payload_size_kb === "number" ? info.metadata.payload_size_kb : null;
    const count =
      typeof info.metadata.rows_count === "number"
        ? info.metadata.rows_count
        : typeof info.metadata.count === "number"
          ? info.metadata.count
          : null;

    return (
      <>
        Last cloud snapshot:{" "}
        <span className="tabular-nums text-foreground">{new Date(info.updated_at).toLocaleString()}</span>
        {count != null ? (
          <>
            , <span className="tabular-nums text-foreground">{count}</span> rows
          </>
        ) : null}
        {size != null ? (
          <>
            , <span className="tabular-nums text-foreground">{size} KB</span>
          </>
        ) : null}
      </>
    );
  }

  function renderSavedDataCard({
    title,
    localStatus,
    cloudStatus,
    messages,
    actions,
  }: {
    title: string;
    localStatus: ReactNode;
    cloudStatus: ReactNode;
    messages?: ReactNode;
    actions: ReactNode;
  }) {
    return (
      <div className="rounded-md border border-border bg-card/50 p-3">
        <div className="space-y-3">
          <div>
            <div className="text-sm font-medium text-foreground">{title}</div>
            <div className="mt-2 grid gap-2 text-xs text-muted-foreground">
              <div className="rounded-md bg-muted/30 px-2.5 py-2">
                <div className="mb-0.5 font-medium text-foreground">Local cache</div>
                <div className="min-w-0">{localStatus}</div>
              </div>
              <div className="rounded-md bg-muted/30 px-2.5 py-2">
                <div className="mb-0.5 font-medium text-foreground">Cloud snapshot</div>
                <div className="min-w-0">{cloudStatus}</div>
              </div>
            </div>
            {messages}
          </div>
          <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">{actions}</div>
        </div>
      </div>
    );
  }

  return (
    <AppLayout title="Import data" description="Data sources, sync, and local cache controls">
      <div className="grid gap-3 lg:grid-cols-3">
        <Card className="p-4 shadow-card lg:col-span-2">
          <div className="mb-3 flex items-center gap-2">
            <Upload className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold text-foreground">Palmer Transactions Import</h3>
          </div>
          <Tabs value={tab} onValueChange={(v) => updateUiState({ tab: v as "csv" | "google" })}>
            <TabsList className="mb-3">
              <TabsTrigger value="csv">
                <Upload className="mr-1.5 h-3.5 w-3.5" /> CSV file
              </TabsTrigger>
              <TabsTrigger value="google">
                <FileSpreadsheet className="mr-1.5 h-3.5 w-3.5" /> Google Sheet
              </TabsTrigger>
            </TabsList>

            <TabsContent value="csv" className="space-y-3">
              <div
                className="rounded-lg border border-dashed border-border bg-muted/30 p-6 text-center transition-colors hover:bg-muted/60"
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  const file = e.dataTransfer.files?.[0];
                  if (file) onFile(file);
                }}
              >
                <Upload className="mx-auto mb-2 h-6 w-6 text-muted-foreground" />
                <p className="text-sm text-foreground">Drag a CSV file here, or</p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  onClick={() => fileRef.current?.click()}
                  disabled={loading}
                >
                  Choose file
                </Button>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".csv,text/csv"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) onFile(f);
                    e.target.value = "";
                  }}
                />
                <p className="mt-2 text-xs text-muted-foreground">
                  First row must contain column headers.
                </p>
              </div>
            </TabsContent>

            <TabsContent value="google" className="space-y-3">
              <div className="space-y-2">
                <Label htmlFor="sheet-url" className="text-xs">Google Sheet URL</Label>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <LinkIcon className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      id="sheet-url"
                      placeholder="https://docs.google.com/spreadsheets/d/…"
                      value={sheetUrl}
                      onChange={(e) => updateUiState({ sheetUrl: e.target.value })}
                      className="pl-8 h-9"
                    />
                  </div>
                  <Button onClick={onLoadSheet} disabled={loading || !sheetUrl.trim()} className="h-9">
                    {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Load"}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  The sheet must be shared as <span className="font-medium text-foreground">Anyone with the link can view</span>.
                  We read the first tab via the public CSV export.
                </p>
              </div>
            </TabsContent>
          </Tabs>

          <div className="mt-4 flex flex-wrap items-end gap-3 border-t border-border pt-4">
            <div className="space-y-1.5">
              <Label className="text-xs">Import mode</Label>
              <Select
                value={importMode}
                onValueChange={(v) => {
                  updateUiState({ importMode: v as "clean_template" | "palmer_raw" });
                  if (parsed && v === "clean_template") setMapping(autoMap(parsed.headers));
                }}
              >
                <SelectTrigger className="h-9 w-[220px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="clean_template">Clean template</SelectItem>
                  <SelectItem value="palmer_raw">Palmer raw export</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <p className="max-w-xl text-xs text-muted-foreground">
              Palmer mode preserves the raw rows, converts cents to dollars, maps Palmer statuses, detects funnel metadata,
              and classifies each user's transactions before analytics run.
            </p>
          </div>

          {parsed && (
            <div className="mt-4 space-y-4">
              <div className="flex items-baseline justify-between border-t border-border pt-4">
                <h3 className="text-sm font-semibold text-foreground">
                  {importMode === "clean_template" ? "Map columns" : "Preview Palmer transform"}
                </h3>
                <span className="text-xs text-muted-foreground">
                  {parsed.rows.length} rows · {parsed.headers.length} columns detected
                </span>
              </div>

              {importMode === "clean_template" && (
                <div className="grid gap-2 sm:grid-cols-2">
                  {TARGET_FIELDS.map((f) => (
                    <div key={f.key} className="flex items-center justify-between gap-2 rounded-md border border-border p-2">
                      <div className="min-w-0">
                        <div className="truncate text-sm text-foreground">
                          {f.label}
                          {f.required && <span className="ml-1 text-destructive">*</span>}
                        </div>
                        <div className="truncate text-[10px] uppercase tracking-wide text-muted-foreground">
                          {String(f.key)}
                        </div>
                      </div>
                      <Select
                        value={mapping[f.key] ?? NONE}
                        onValueChange={(v) =>
                          setMapping((m) => ({ ...m, [f.key]: v === NONE ? undefined : v }))
                        }
                      >
                        <SelectTrigger className="h-8 w-[160px]">
                          <SelectValue placeholder="—" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NONE}>— skip —</SelectItem>
                          {parsed.headers.map((h) => (
                            <SelectItem key={h} value={h}>{h}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  ))}
                </div>
              )}

              {requiredMissing.length > 0 && (
                <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    Required: {requiredMissing.map((f) => f.label).join(", ")}
                  </span>
                </div>
              )}

              <div>
                <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Preview (first 5 rows)
                </h4>
                <div className="overflow-x-auto rounded-md border border-border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Email</TableHead>
                        <TableHead>Type</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Funnel</TableHead>
                        <TableHead className="text-right">Amount</TableHead>
                        <TableHead>Event time</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {previewRows.map((r, i) => (
                        <TableRow key={i}>
                          <TableCell className="text-xs">{r.email}</TableCell>
                          <TableCell className="text-xs">{r.transaction_type}</TableCell>
                          <TableCell className="text-xs">{r.status}</TableCell>
                          <TableCell className="text-xs">{r.funnel}</TableCell>
                          <TableCell className="text-right text-xs tabular-nums">
                            ${r.amount_usd.toFixed(2)}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {new Date(r.event_time).toLocaleString()}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>

              <div className="flex items-center justify-end gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setParsed(null);
                    setMapping({});
                    setSourceFileSize(undefined);
                  }}
                >
                  Cancel
                </Button>
                <Button onClick={confirmImport} disabled={requiredMissing.length > 0}>
                  <CheckCircle2 className="mr-1.5 h-4 w-4" />
                  Import {parsed.rows.length} rows
                </Button>
              </div>
            </div>
          )}
        </Card>

        <Card className="p-4 shadow-card">
          <div className="mb-2 flex items-center gap-2">
            <Database className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold text-foreground">Current dataset</h3>
          </div>
          <dl className="space-y-2 text-xs">
            <div className="flex items-center justify-between">
              <dt className="text-muted-foreground">Source</dt>
              <dd className="font-medium capitalize text-foreground">{currentDatasetSource}</dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-muted-foreground">Rows</dt>
              <dd className="font-medium tabular-nums text-foreground">{currentDatasetRows}</dd>
            </div>
            {warehouseTransactionCount != null && warehouseTransactionCount > 0 && (
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">Analytics cache</dt>
                <dd className="font-medium tabular-nums text-foreground">
                  {analyticsCacheIsWarehouse ? meta.rowCount : `${meta.rowCount} local`}
                </dd>
              </div>
            )}
            {meta.fileName && (
              <div className="flex items-center justify-between gap-2">
                <dt className="text-muted-foreground">File</dt>
                <dd className="truncate font-medium text-foreground" title={meta.fileName}>
                  {meta.fileName}
                </dd>
              </div>
            )}
            {meta.rawRowCount !== undefined && (
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">Raw rows</dt>
                <dd className="font-medium tabular-nums text-foreground">{meta.rawRowCount}</dd>
              </div>
            )}
            {meta.sheetUrl && (
              <div className="space-y-0.5">
                <dt className="text-muted-foreground">Sheet URL</dt>
                <dd className="break-all font-medium text-foreground">{meta.sheetUrl}</dd>
              </div>
            )}
            {meta.importedAt && (
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">Imported at</dt>
                <dd className="tabular-nums text-foreground">
                  {new Date(meta.importedAt).toLocaleString()}
                </dd>
              </div>
            )}
          </dl>

          {meta.diagnostics && (
            <div className="mt-4 border-t border-border pt-3">
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Palmer diagnostics
              </h4>
              <dl className="space-y-2 text-xs">
                {DIAGNOSTIC_LABELS.map((item) => (
                  <div key={item.key} className="flex items-center justify-between gap-2">
                    <dt className="text-muted-foreground">{item.label}</dt>
                    <dd className="font-medium tabular-nums text-foreground">
                      {meta.diagnostics?.[item.key]}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          )}

          {cacheSavedMessage && (
            <div className="mt-4 rounded-md border border-primary/20 bg-primary/5 p-3 text-xs text-primary">
              Saved imported dataset locally
              <div className="mt-1 text-muted-foreground">{cacheSavedMessage}</div>
            </div>
          )}

          <Button
            variant="outline"
            size="sm"
            className="mt-4 w-full"
            onClick={() => {
              resetToMock();
              toast({ title: "Reset", description: "Restored bundled mock dataset." });
            }}
          >
            <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
            Reset to mock data
          </Button>
        </Card>
      </div>

      <Card className="mt-3 p-4 shadow-card">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Database className="h-4 w-4 text-muted-foreground" />
            <div>
              <h3 className="text-sm font-semibold text-foreground">Transaction Warehouse</h3>
              <p className="mt-0.5 text-xs text-muted-foreground">
                New CSV uploads extend the database and do not replace previous imports.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onPreviewCleanup}
              disabled={managementBusy || warehouseLoading || !warehouseEnabled}
            >
              {managementBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
              Cleanup Duplicate Imports
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onRefreshWarehouseHistory}
              disabled={warehouseLoading || !warehouseEnabled}
            >
              {warehouseLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              Refresh history
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onRefreshLocalCacheFromWarehouse}
              disabled={warehouseLoading || !warehouseEnabled}
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Refresh local cache from DB
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={onRecalculateAnalyticsFromDb}
              disabled={warehouseLoading || !warehouseEnabled}
            >
              <Database className="h-3.5 w-3.5" />
              Refresh local analytics cache from DB
            </Button>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            This only updates the analytics shown in this browser. The Export API reads directly from Supabase and
            does not require this button — imported data is available to integrations immediately.
          </p>
        </div>

        {!warehouseEnabled && (
          <div className="rounded-md border border-warning/30 bg-warning/5 p-3 text-xs text-muted-foreground">
            Transaction warehouse is unavailable. Check Supabase configuration or VITE_USE_TRANSACTION_WAREHOUSE.
          </div>
        )}

        {warehouseSummary && (
          <div className="mb-3 grid gap-2 text-xs sm:grid-cols-4 lg:grid-cols-7">
            {[
              ["Total", warehouseSummary.totalRows],
              ["Estimated new", warehouseSummary.inserted],
              ["Potential duplicates", warehouseSummary.potentialDuplicates],
              ["Inserted", warehouseSummary.inserted],
              ["Updated", warehouseSummary.updated],
              ["Skipped", warehouseSummary.skipped],
              ["Failed", warehouseSummary.failed],
            ].map(([label, value]) => (
              <div key={label} className="rounded-md border border-border bg-muted/20 p-2">
                <div className="text-muted-foreground">{label}</div>
                <div className="mt-1 font-mono text-sm font-semibold text-foreground">{value}</div>
              </div>
            ))}
            <div className="sm:col-span-4 lg:col-span-7 space-y-1 text-muted-foreground">
              <div>
                Last imported date range:{" "}
                <span className="font-mono text-foreground">
                  {warehouseSummary.dateRange
                    ? warehouseSummary.dateRange.from === warehouseSummary.dateRange.to
                      ? warehouseSummary.dateRange.from
                      : `${warehouseSummary.dateRange.from} → ${warehouseSummary.dateRange.to}`
                    : "—"}
                </span>
              </div>
              <div>
                Checksum <span className="font-mono text-foreground">{warehouseSummary.checksum.slice(0, 16)}</span>
                {warehouseSummary.duplicateFile ? " matched a previous import." : " recorded for this import."}
              </div>
              {warehouseSummary.overlapsExisting && (
                <div className="font-medium text-warning">Import overlaps with existing transactions.</div>
              )}
            </div>
          </div>
        )}

        {(warehouseMessage || warehouseError) && (
          <div className="mb-3 rounded-md border border-border bg-muted/20 p-3 text-xs">
            {warehouseMessage && <div className="text-primary">{warehouseMessage}</div>}
            {warehouseError && <div className="text-destructive">{warehouseError}</div>}
          </div>
        )}

        {clickHouseSyncPhase !== "idle" && clickHouseSyncMessage && (
          <div
            className={cn(
              "mb-3 flex items-center gap-2 rounded-md border p-3 text-xs",
              clickHouseSyncPhase === "syncing" && "border-primary/30 bg-primary/5 text-primary",
              clickHouseSyncPhase === "done" && "border-success/30 bg-success/5 text-success",
              clickHouseSyncPhase === "skipped" && "border-warning/30 bg-warning/5 text-muted-foreground",
              clickHouseSyncPhase === "failed" && "border-destructive/30 bg-destructive/5 text-destructive",
            )}
          >
            {clickHouseSyncPhase === "syncing" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {clickHouseSyncPhase === "done" && <CheckCircle2 className="h-3.5 w-3.5" />}
            <span>{clickHouseSyncMessage}</span>
          </div>
        )}

        <div className="overflow-x-auto rounded-md border border-border">
          {(() => {
            const dupIds = duplicateBatchIds(warehouseHistory);
            return (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8" />
                <TableHead>Imported at</TableHead>
                <TableHead>Filename</TableHead>
                <TableHead>Date range</TableHead>
                <TableHead>Source</TableHead>
                <TableHead className="text-right">Inserted</TableHead>
                <TableHead className="text-right">Updated</TableHead>
                <TableHead className="text-right">Skipped</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Checksum</TableHead>
                <TableHead className="w-10 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {warehouseHistory.map((batch) => {
                const expanded = expandedBatchId === batch.id;
                const txCount = batchTransactionCounts.get(batch.id) ?? 0;
                return (
                <Fragment key={batch.id}>
                <TableRow>
                  <TableCell className="px-2">
                    <button
                      type="button"
                      aria-label={expanded ? "Collapse details" : "Expand details"}
                      className="text-muted-foreground hover:text-foreground"
                      onClick={() => setExpandedBatchId(expanded ? null : batch.id)}
                    >
                      {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                    </button>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs tabular-nums">
                    {new Date(batch.imported_at).toLocaleString()}
                  </TableCell>
                  <TableCell className="max-w-[180px] truncate text-xs" title={batch.filename ?? undefined}>
                    {batch.filename ?? "Import"}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs tabular-nums">
                    {importBatchDateRange(batch)}
                  </TableCell>
                  <TableCell className="text-xs">{batch.source}</TableCell>
                  <TableCell className="text-right text-xs tabular-nums">{batch.rows_inserted}</TableCell>
                  <TableCell className="text-right text-xs tabular-nums">{batch.rows_updated}</TableCell>
                  <TableCell className="text-right text-xs tabular-nums">{batch.rows_skipped}</TableCell>
                  <TableCell className="text-xs">
                    <ImportStatusBadge status={batch.status} isDuplicate={dupIds.has(batch.id)} />
                  </TableCell>
                  <TableCell className="max-w-[140px] truncate font-mono text-[11px]" title={batch.checksum ?? undefined}>
                    {batch.checksum ? batch.checksum.slice(0, 16) : "—"}
                  </TableCell>
                  <TableCell className="text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          disabled={managementBusy || !warehouseEnabled}
                          aria-label="Import actions"
                        >
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => setExpandedBatchId(expanded ? null : batch.id)}>
                          {expanded ? "Hide details" : "View details"}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onSelect={() => setPendingImportAction({ type: "rollback", batch })}>
                          <Undo2 className="mr-2 h-4 w-4" /> Rollback
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="text-destructive focus:text-destructive"
                          onSelect={() => setPendingImportAction({ type: "delete", batch })}
                        >
                          <Trash2 className="mr-2 h-4 w-4" /> Delete Import
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
                {expanded && (
                  <TableRow className="bg-muted/20">
                    <TableCell colSpan={11} className="p-4">
                      <div className="grid gap-x-6 gap-y-2 text-xs sm:grid-cols-2 lg:grid-cols-3">
                        {[
                          ["Import Batch ID", <span className="font-mono">{batch.id}</span>],
                          ["Checksum", <span className="font-mono break-all">{batch.checksum ?? "—"}</span>],
                          ["Inserted", batch.rows_inserted],
                          ["Updated", batch.rows_updated],
                          ["Skipped", batch.rows_skipped],
                          ["Total rows", batch.rows_total],
                          ["Filename", batch.filename ?? "—"],
                          ["Source", batch.source],
                          ["Status", batch.status.replace("_", " ")],
                          ["Created At", new Date(batch.imported_at).toLocaleString()],
                          ["Transaction count", txCount],
                        ].map(([label, value], index) => (
                          <div key={index} className="flex justify-between gap-3 border-b border-border/60 py-1">
                            <span className="text-muted-foreground">{label}</span>
                            <span className="text-right font-medium text-foreground">{value}</span>
                          </div>
                        ))}
                      </div>
                      {batch.notes && (
                        <div className="mt-2 rounded-md border border-border bg-background p-2 text-[11px] text-muted-foreground">
                          {batch.notes}
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                )}
                </Fragment>
                );
              })}
              {!warehouseHistory.length && (
                <TableRow>
                  <TableCell colSpan={11} className="py-6 text-center text-xs text-muted-foreground">
                    No warehouse imports recorded yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
            );
          })()}
        </div>

        <AlertDialog open={pendingImportAction !== null} onOpenChange={(open) => !open && setPendingImportAction(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {pendingImportAction?.type === "delete" ? "Delete import?" : "Rollback import?"}
              </AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div className="space-y-2">
                  {pendingImportAction?.type === "delete" ? (
                    <>
                      <p>This will permanently remove:</p>
                      <ul className="list-disc pl-5">
                        <li>import history</li>
                        <li>imported transactions ({batchTransactionCounts.get(pendingImportAction.batch.id) ?? 0})</li>
                        <li>snapshots created by this import (if applicable)</li>
                      </ul>
                      <p className="font-medium text-destructive">This action cannot be undone.</p>
                    </>
                  ) : (
                    <>
                      <p>
                        This removes only the {batchTransactionCounts.get(pendingImportAction?.batch.id ?? "") ?? 0}{" "}
                        transactions inserted by this import. Older imports remain untouched and analytics rebuild
                        immediately. The import is kept in history as <span className="font-medium">rolled back</span>.
                      </p>
                    </>
                  )}
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={managementBusy}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={(event) => {
                  event.preventDefault();
                  void onConfirmImportAction();
                }}
                disabled={managementBusy}
                className={pendingImportAction?.type === "delete" ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : undefined}
              >
                {managementBusy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                {pendingImportAction?.type === "delete" ? "Delete" : "Rollback"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <AlertDialog open={cleanupPreview !== null} onOpenChange={(open) => !open && setCleanupPreview(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Cleanup duplicate imports?</AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div className="space-y-2">
                  <p>Found:</p>
                  <ul className="list-disc pl-5">
                    <li>{cleanupPreview?.duplicateImports ?? 0} duplicate imports</li>
                    <li>{cleanupPreview?.failedImports ?? 0} failed imports</li>
                    <li>{cleanupPreview?.transactionsRemoved ?? 0} transactions will be removed</li>
                  </ul>
                  <p>The newest completed import for each checksum is kept. This cannot be undone.</p>
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={managementBusy}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={(event) => {
                  event.preventDefault();
                  void onConfirmCleanup();
                }}
                disabled={managementBusy}
              >
                {managementBusy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Cleanup
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </Card>

      <Card className="mt-3 p-4 shadow-card">
        <div className="mb-3 flex items-center gap-2">
          <FileSpreadsheet className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold text-foreground">Facebook Traffic Import</h3>
        </div>
        <div className="grid gap-3 lg:grid-cols-[minmax(260px,1fr)_110px_180px_120px_auto_auto]">
          <div className="space-y-1.5">
            <Label htmlFor="facebook-traffic-url" className="text-xs text-muted-foreground">
              Google Sheet URL
            </Label>
            <Input
              id="facebook-traffic-url"
              value={trafficSheetUrl}
              onChange={(e) => onTrafficSheetUrlChange(e.target.value)}
              placeholder="https://docs.google.com/spreadsheets/d/..."
              className="h-9"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="facebook-traffic-year" className="text-xs text-muted-foreground">
              Year
            </Label>
            <Input
              id="facebook-traffic-year"
              type="number"
              value={trafficYear}
              onChange={(e) => updateUiState({ trafficYear: e.target.value })}
              className="h-9"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="facebook-traffic-tab" className="text-xs text-muted-foreground">
              Sheet tab
            </Label>
            <Select value={effectiveTrafficGid} onValueChange={(value) => updateUiState({ trafficGid: value })}>
              <SelectTrigger id="facebook-traffic-tab" className="h-9">
                <SelectValue placeholder="gid 0" />
              </SelectTrigger>
              <SelectContent>
                {trafficTabs.length ? (
                  <>
                    {!trafficTabs.some((sheetTab) => sheetTab.gid === effectiveTrafficGid) && (
                      <SelectItem value={effectiveTrafficGid}>gid {effectiveTrafficGid}</SelectItem>
                    )}
                    {trafficTabs.map((sheetTab) => (
                      <SelectItem key={sheetTab.gid} value={sheetTab.gid}>
                        {sheetTab.name} · gid {sheetTab.gid}
                      </SelectItem>
                    ))}
                  </>
                ) : (
                  <SelectItem value={effectiveTrafficGid}>gid {effectiveTrafficGid}</SelectItem>
                )}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="facebook-traffic-gid" className="text-xs text-muted-foreground">
              gid
            </Label>
            <Input
              id="facebook-traffic-gid"
              value={trafficGid || trafficSheetRef?.gid || ""}
              onChange={(e) => updateUiState({ trafficGid: e.target.value })}
              placeholder="0"
              inputMode="numeric"
              className="h-9"
            />
          </div>
          <div className="flex items-end">
            <Button
              type="button"
              variant="outline"
              className="h-9"
              onClick={onLoadTrafficTabs}
              disabled={trafficTabsLoading || !trafficSheetUrl.trim()}
            >
              {trafficTabsLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              Load tabs
            </Button>
          </div>
          <div className="flex items-end">
            <Button
              type="button"
              className="h-9"
              onClick={onImportFacebookTraffic}
              disabled={trafficLoading || !trafficSheetUrl.trim()}
            >
              {trafficLoading && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              Import Facebook traffic
            </Button>
          </div>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Date values like DD.MM use the selected year. Campaign paths are matched after lowercasing and removing a leading slash.
        </p>
        {trafficTabsError && <div className="mt-2 text-xs text-destructive">{trafficTabsError}</div>}
        {trafficTabs.length > 0 && (
          <div className="mt-2 text-xs text-muted-foreground">
            Loaded {trafficTabs.length} tabs. Selected{" "}
            <span className="font-medium text-foreground">
              {selectedTrafficTab ? `${selectedTrafficTab.name} · gid ${selectedTrafficTab.gid}` : `gid ${effectiveTrafficGid}`}
            </span>.
          </div>
        )}
        {trafficMeta.importedAt && (
          <div className="mt-3 text-xs text-muted-foreground">
            Current Facebook traffic data:{" "}
            <span className="font-medium text-foreground">{trafficMeta.rowCount}</span> rows imported at{" "}
            <span className="tabular-nums text-foreground">{new Date(trafficMeta.importedAt).toLocaleString()}</span>
          </div>
        )}
      </Card>

      <Card className="mt-3 p-4 shadow-card">
        <div className="mb-3 flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold text-foreground">FunnelFox Subscriptions Sync</h3>
        </div>
        <div
          className={
            temporaryKeyInputEnabled
              ? "grid gap-3 md:grid-cols-[minmax(240px,1fr)_auto_auto] md:items-end"
              : "flex flex-wrap items-center gap-3"
          }
        >
          {temporaryKeyInputEnabled ? (
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
                  setFunnelFoxConnectionMessage(null);
                  setFunnelFoxConnectionError(null);
                }}
                placeholder="Paste key for this session"
                autoComplete="off"
                className="h-9"
              />
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">
              Configure <span className="font-mono text-foreground">FUNNELFOX_SECRET</span> on the server.
            </div>
          )}
          <Button
            type="button"
            variant="outline"
            onClick={onTestFunnelFoxConnection}
            disabled={testingFunnelFox || syncingFunnelFox}
          >
            <RefreshCw className={testingFunnelFox ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
            Test connection
          </Button>
          <Button
            type="button"
            onClick={onSyncFunnelFoxSubscriptions}
            disabled={syncingFunnelFox || testingFunnelFox}
          >
            <RefreshCw className={syncingFunnelFox ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
            Sync subscriptions
          </Button>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {temporaryKeyInputEnabled
            ? "This key is used only for the current browser session and is sent to the server proxy. For production, configure "
            : "Production sync uses only the server-side "}
          <span className="font-mono text-foreground">FUNNELFOX_SECRET</span>
          {temporaryKeyInputEnabled ? " on the server." : "."}
        </p>
        {(funnelFoxConnectionMessage || funnelFoxConnectionError || funnelFoxSyncMessage || funnelFoxSyncError) && (
          <div className="mt-3 rounded-md border border-border bg-muted/20 p-3 text-xs">
            {funnelFoxConnectionMessage && <div className="text-success">{funnelFoxConnectionMessage}</div>}
            {funnelFoxConnectionError && <div className="text-destructive">{funnelFoxConnectionError}</div>}
            {funnelFoxSyncMessage && <div className="mt-1 text-muted-foreground">{funnelFoxSyncMessage}</div>}
            {funnelFoxSyncError && <div className="mt-1 text-destructive">{funnelFoxSyncError}</div>}
          </div>
        )}
        {subscriptions.length > 0 && (
          <div className="mt-3 text-xs text-muted-foreground">
            Loaded subscriptions:{" "}
            <span className="font-medium tabular-nums text-foreground">{subscriptionEmailDiagnostics.total}</span>.
            Email coverage:{" "}
            <span className="font-medium tabular-nums text-foreground">
              {subscriptionEmailDiagnostics.withEmail}/{subscriptionEmailDiagnostics.total}
            </span>{" "}
            ({formatPct(subscriptionEmailDiagnostics.coverage)}), missing{" "}
            <span className="font-medium tabular-nums text-foreground">{subscriptionEmailDiagnostics.missingEmail}</span>.
          </div>
        )}

        {/* Staged, resumable sync — server-side, diagnosable. */}
        {(() => {
          const uiStatus = subscriptionSyncUiStatus(stagedSyncState, stagedSyncing);
          const summary = stagedSyncStep?.summary ?? stagedSyncState?.stats ?? null;
          const currentStage = stagedSyncStep?.stage ?? stagedSyncState?.current_stage ?? null;
          const statusLabel: Record<typeof uiStatus, string> = {
            never_synced: "Never synced",
            syncing: "Syncing…",
            partial: "Partial",
            completed: "Completed",
            inconsistent: "Completed with inconsistencies",
            failed: "Failed",
          };
          const statusColor: Record<typeof uiStatus, string> = {
            never_synced: "text-muted-foreground",
            syncing: "text-primary",
            partial: "text-warning",
            completed: "text-success",
            inconsistent: "text-destructive",
            failed: "text-destructive",
          };
          const report = subscriptionSyncReport(stagedSyncState);
          const num = (v: unknown) => (typeof v === "number" ? v.toLocaleString("en-US") : "—");
          const str = (v: unknown) => (v == null || v === "" ? "—" : String(v));
          const hasMore = summary?.list_has_more_on_last_page;
          const coveragePct = summary?.subscriptions_coverage_percent;
          // "Complete" ⇒ all stages done, stopped cleanly, and nothing still has more pages.
          const isComplete =
            stagedSyncState?.last_status === "completed" &&
            (summary?.all_stages_completed ?? false) &&
            (summary?.sync_stopped_reason === "completed" || summary?.sync_stopped_reason == null) &&
            hasMore !== true;
          const cards: Array<{ label: string; value: string }> = [
            { label: "Subscriptions downloaded", value: num(summary?.subscriptions_scanned_total) },
            { label: "Stored", value: num(summary?.subscriptions_saved) },
            { label: "Saved this run", value: num(summary?.subscriptions_saved_this_run) },
            { label: "Pages processed", value: num(summary?.list_pages_processed) },
            { label: "Has more pages", value: hasMore == null ? "—" : hasMore ? "YES" : "no" },
            { label: "Stop reason", value: str(summary?.sync_stopped_reason) },
            { label: "Coverage", value: typeof coveragePct === "number" ? `${coveragePct}%` : "—" },
            { label: "Details pending", value: num(summary?.details_pending) },
            { label: "Profiles pending", value: num(summary?.profiles_pending) },
            { label: "Emails found", value: num(summary?.subscriptions_with_email) },
            { label: "Missing emails", value: num(summary?.missing_email_after_enrichment) },
            { label: "Duration", value: summary?.duration_ms != null ? `${Math.round((summary.duration_ms as number) / 1000)}s` : "—" },
          ];
          return (
            <div className="mt-4 rounded-md border border-border p-3">
              <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="text-xs font-semibold text-foreground">Staged sync (resumable)</span>
                <span className={cn("text-xs font-medium", statusColor[uiStatus])}>{statusLabel[uiStatus]}</span>
                <span className="text-xs text-muted-foreground">
                  version: <span className="font-mono text-foreground">{SUBSCRIPTION_SYNC_VERSION}</span>
                </span>
                {currentStage && (
                  <span className="text-xs text-muted-foreground">
                    stage: <span className="font-mono text-foreground">{currentStage}</span>
                  </span>
                )}
                {stagedSyncState?.last_full_sync_at && (
                  <span className="text-xs text-muted-foreground">
                    last full sync: {new Date(stagedSyncState.last_full_sync_at).toLocaleString()}
                  </span>
                )}
                {summary?.list_last_cursor ? (
                  <span className="text-xs text-muted-foreground">
                    last cursor: <span className="font-mono text-foreground">{String(summary.list_last_cursor).slice(0, 12)}…</span>
                  </span>
                ) : null}
              </div>

              {uiStatus === "inconsistent" && (
                <div className="mb-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  Synchronization completed with inconsistencies — stored {num(report?.total_stored)} but FunnelFox reports {num(report?.total_in_funnelfox)}. Click Force Full Resync.
                </div>
              )}
              {summary && !isComplete && uiStatus !== "syncing" && uiStatus !== "never_synced" && uiStatus !== "inconsistent" && (
                <div className="mb-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
                  Subscription data may be incomplete. Click Continue Sync to finish, or Force Full Resync to rebuild.
                </div>
              )}

              {report && (
                <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                  <span className="text-muted-foreground">
                    Integrity: <span className={cn("font-semibold", report.parity_check === "PASS" ? "text-success" : report.parity_check === "FAIL" ? "text-destructive" : "text-muted-foreground")}>{report.parity_check ?? "—"}</span>
                  </span>
                  <span className="text-muted-foreground">FunnelFox total: <span className="font-medium tabular-nums text-foreground">{num(report.total_in_funnelfox)}</span></span>
                  <span className="text-muted-foreground">Stored: <span className="font-medium tabular-nums text-foreground">{num(report.total_stored)}</span></span>
                  <span className="text-muted-foreground">Inserted: <span className="tabular-nums text-foreground">{num(report.inserted)}</span></span>
                  <span className="text-muted-foreground">Updated: <span className="tabular-nums text-foreground">{num(report.updated)}</span></span>
                  <span className="text-muted-foreground">Skipped: <span className="tabular-nums text-foreground">{num(report.skipped)}</span></span>
                </div>
              )}

              {summary && (
                <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {cards.map((card) => (
                    <div key={card.label} className="rounded border border-border/60 bg-muted/20 p-2">
                      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{card.label}</div>
                      <div className="text-sm font-semibold tabular-nums text-foreground">{card.value}</div>
                    </div>
                  ))}
                </div>
              )}

              <div className="flex flex-wrap gap-2">
                <Button type="button" size="sm" onClick={onStartFullStagedSync} disabled={stagedSyncing || syncingFunnelFox}>
                  {stagedSyncing && <RefreshCw className="h-4 w-4 animate-spin" />}
                  Start Full Sync
                </Button>
                <Button type="button" size="sm" variant="outline" onClick={onContinueStagedSync} disabled={stagedSyncing || syncingFunnelFox}>
                  Continue Sync
                </Button>
                <Button type="button" size="sm" variant="outline" onClick={onForceFullResync} disabled={stagedSyncing || syncingFunnelFox}>
                  Force Full Resync
                </Button>
                <Button type="button" size="sm" variant="outline" onClick={onDryRunStagedSync} disabled={stagedSyncing || syncingFunnelFox}>
                  Dry Run
                </Button>
                {stagedSyncing && (
                  <Button type="button" size="sm" variant="ghost" onClick={onCancelStagedSync}>
                    Cancel Sync
                  </Button>
                )}
              </div>

              {uiStatus === "partial" && (
                <div className="mt-2 text-xs text-warning">
                  Sync is partial. Click Continue Sync to resume from the last cursor.
                </div>
              )}
              {uiStatus === "completed" && !shouldShowPartialWarning(stagedSyncState) && (
                <div className="mt-2 text-xs text-success">All FunnelFox subscriptions were synced.</div>
              )}
              {summary?.coverage_warning_message ? (
                <div className="mt-2 text-xs text-warning">{summary.coverage_warning_message}</div>
              ) : null}
              {stagedSyncMessage && <div className="mt-2 text-xs text-muted-foreground">{stagedSyncMessage}</div>}
              {(stagedSyncError || stagedSyncState?.last_error) && (
                <div className="mt-2 flex items-center gap-2 text-xs text-destructive">
                  <span>{stagedSyncError ?? stagedSyncState?.last_error}</span>
                  <Button type="button" size="sm" variant="outline" className="h-6" onClick={onContinueStagedSync} disabled={stagedSyncing}>
                    Retry
                  </Button>
                </div>
              )}
            </div>
          );
        })()}
      </Card>

      <Card className="mt-3 p-4 shadow-card">
        <div className="mb-3">
          <h3 className="text-sm font-semibold text-foreground">Data Settings</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Controls how many ordered subscription renewal levels Cohorts calculates and displays.
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-[220px_minmax(260px,1fr)] sm:items-end">
          <div className="space-y-1.5">
            <Label htmlFor="max-renewal-columns" className="text-xs text-muted-foreground">
              Max Renewal Columns
            </Label>
            <Select value={String(maxRenewalColumns)} onValueChange={onChangeMaxRenewalColumns}>
              <SelectTrigger id="max-renewal-columns" className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MAX_RENEWAL_COLUMN_OPTIONS.map((option) => (
                  <SelectItem key={option} value={String(option)}>
                    {option}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="text-xs text-muted-foreground">
            Current Cohorts columns: Renewal 2
            {maxRenewalColumns > 2 ? ` through Renewal ${maxRenewalColumns}` : ""}.
            Invalid saved values fall back to {sanitizeMaxRenewalColumns(null)}.
          </div>
        </div>
        {dataSettingsMessage && (
          <div className="mt-3 text-xs text-primary">{dataSettingsMessage}</div>
        )}
      </Card>

      <Card className="mt-3 p-4 shadow-card">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-foreground">Forecasting Settings</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              These values are used only when actual or historical retention is unavailable.
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button type="button" variant="outline" size="sm" onClick={onResetForecastingSettings}>
              Reset to default
            </Button>
            <Button type="button" size="sm" onClick={onSaveForecastingSettings}>
              Save settings
            </Button>
          </div>
        </div>
        <div className="mb-2 text-xs font-medium text-muted-foreground">Default Retention Curve</div>
        <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {retentionCurveDraft.map((value, index) => (
            <div key={index} className="space-y-1.5">
              <Label htmlFor={`default-retention-m${index + 1}`} className="text-xs text-muted-foreground">
                M{index + 1} %
              </Label>
              <Input
                id={`default-retention-m${index + 1}`}
                type="text"
                inputMode="decimal"
                value={value}
                onChange={(event) => updateRetentionCurveMonth(index, event.target.value)}
                onBlur={() => commitRetentionCurveMonth(index)}
                className="h-9"
              />
            </div>
          ))}
        </div>
        {retentionCurveMessage && (
          <div className="mt-3 text-xs text-primary">{retentionCurveMessage}</div>
        )}
        <p className="mt-3 text-xs text-muted-foreground">
          Built-in defaults: {BUILTIN_DEFAULT_RETENTION_CURVE.map((value, index) => `M${index + 1} ${value}%`).join(", ")}.
        </p>
      </Card>

      <Card className="mt-3 p-4 shadow-card">
        <div className="mb-3 flex items-center gap-2">
          <Database className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold text-foreground">Local Saved Data</h3>
        </div>
        <div className="grid gap-3 lg:grid-cols-2">
          {renderSavedDataCard({
            title: "Palmer dataset",
            localStatus: palmerCacheInfo ? (
              <>
                <span className="font-medium text-foreground">{palmerCacheInfo.file_name}</span>
                <span>, </span>
                <span className="tabular-nums text-foreground">{palmerCacheInfo.rows_count}</span>
                <span> rows, imported </span>
                <span className="tabular-nums text-foreground">
                  {new Date(palmerCacheInfo.imported_at).toLocaleString()}
                </span>
              </>
            ) : (
              "No local cache found."
            ),
            cloudStatus: renderCloudSnapshotInfo("palmer", "No cloud snapshot found."),
            messages: (
              <>
                {palmerCacheMessage && <div className="mt-2 text-xs text-primary">{palmerCacheMessage}</div>}
                {palmerCacheError && <div className="mt-2 text-xs text-destructive">{palmerCacheError}</div>}
              </>
            ),
            actions: (
              <>
                <Button type="button" variant="outline" size="sm" onClick={onLoadSavedPalmerDataset} disabled={palmerCacheLoading || !palmerCacheInfo}>
                  Load local
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={onLoadPalmerFromCloud} disabled={cloudLoading === "palmer" || !cloudSnapshots.palmer}>
                  Load cloud
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={onSavePalmerToCloud} disabled={cloudLoading === "palmer" || meta.source !== "palmer_raw" || !transactions.length}>
                  {cloudLoading === "palmer" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  Save cloud
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={onClearSavedPalmerDataset} disabled={palmerCacheLoading || !palmerCacheInfo}>
                  <Trash2 className="h-3.5 w-3.5" />
                  Clear local
                </Button>
              </>
            ),
          })}

          {renderSavedDataCard({
            title: "FunnelFox subscriptions",
            localStatus: subscriptionCacheInfo ? (
              <>
                <span className="tabular-nums text-foreground">{subscriptionCacheInfo.count}</span>
                <span> subscriptions, saved </span>
                <span className="tabular-nums text-foreground">
                  {new Date(subscriptionCacheInfo.saved_at).toLocaleString()}
                </span>
              </>
            ) : (
              "No local cache found."
            ),
            cloudStatus: renderCloudSnapshotInfo("funnelfox_subscriptions", "No cloud snapshot found."),
            actions: (
              <>
                <Button type="button" variant="outline" size="sm" onClick={onLoadSavedSubscriptions} disabled={subscriptionCacheLoading || !subscriptionCacheInfo}>
                  Load local
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={onLoadSubscriptionsFromCloud} disabled={cloudLoading === "funnelfox_subscriptions" || !cloudSnapshots.funnelfox_subscriptions}>
                  Load cloud
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={onSaveSubscriptionsToCloud} disabled={cloudLoading === "funnelfox_subscriptions" || !subscriptions.length}>
                  {cloudLoading === "funnelfox_subscriptions" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  Save cloud
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={onClearSavedSubscriptions} disabled={subscriptionCacheLoading || !subscriptionCacheInfo}>
                  <Trash2 className="h-3.5 w-3.5" />
                  Clear local
                </Button>
              </>
            ),
          })}

          {renderSavedDataCard({
            title: "Facebook traffic",
            localStatus: trafficCacheInfo ? (
              <>
                <span className="tabular-nums text-foreground">{trafficCacheInfo.rows_count}</span>
                <span> rows, imported </span>
                <span className="tabular-nums text-foreground">
                  {new Date(trafficCacheInfo.imported_at).toLocaleString()}
                </span>
                {trafficCacheInfo.year ? (
                  <>
                    <span>, year </span>
                    <span className="tabular-nums text-foreground">{trafficCacheInfo.year}</span>
                  </>
                ) : null}
                {(trafficCacheInfo.tab_name || trafficCacheInfo.gid) ? (
                  <div className="mt-1 truncate">
                    Tab:{" "}
                    <span className="text-foreground">
                      {trafficCacheInfo.tab_name ?? "Selected tab"}
                      {trafficCacheInfo.gid ? ` · gid ${trafficCacheInfo.gid}` : ""}
                    </span>
                  </div>
                ) : null}
                {trafficCacheInfo.google_sheet_url ? (
                  <div className="mt-1 truncate">
                    Source: <span className="text-foreground">{trafficCacheInfo.google_sheet_url}</span>
                  </div>
                ) : null}
              </>
            ) : (
              "No local cache found."
            ),
            cloudStatus: renderCloudSnapshotInfo("facebook_traffic", "No cloud snapshot found."),
            messages: (
              <>
                {trafficCacheMessage && <div className="mt-2 text-xs text-primary">{trafficCacheMessage}</div>}
                {trafficCacheError && <div className="mt-2 text-xs text-destructive">{trafficCacheError}</div>}
              </>
            ),
            actions: (
              <>
                <Button type="button" variant="outline" size="sm" onClick={onLoadSavedTrafficData} disabled={trafficCacheLoading || !trafficCacheInfo}>
                  {trafficCacheLoading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  Load local
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={onLoadTrafficFromCloud} disabled={cloudLoading === "facebook_traffic" || !cloudSnapshots.facebook_traffic}>
                  Load cloud
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={onSaveTrafficToCloud} disabled={cloudLoading === "facebook_traffic" || !trafficMetrics.length}>
                  {cloudLoading === "facebook_traffic" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  Save cloud
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={onClearSavedTrafficData} disabled={trafficCacheLoading || !trafficCacheInfo}>
                  <Trash2 className="h-3.5 w-3.5" />
                  Clear local
                </Button>
              </>
            ),
          })}

          {renderSavedDataCard({
            title: "Forecasting settings",
            localStatus: (
              <>
                Default curve loaded in this browser. M1{" "}
                <span className="tabular-nums text-foreground">{retentionCurveDraft[0] ?? "35"}%</span>, M12{" "}
                <span className="tabular-nums text-foreground">{retentionCurveDraft[11] ?? "2"}%</span>, max renewal{" "}
                <span className="tabular-nums text-foreground">{maxRenewalColumns}</span>
              </>
            ),
            cloudStatus: renderCloudSnapshotInfo("forecasting_settings", "No cloud snapshot found."),
            actions: (
              <>
                <Button type="button" variant="outline" size="sm" onClick={onLoadLocalForecastingSettings}>
                  Load local
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={onLoadForecastingSettingsFromCloud} disabled={cloudLoading === "forecasting_settings" || !cloudSnapshots.forecasting_settings}>
                  Load cloud
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={onSaveForecastingSettingsToCloud} disabled={cloudLoading === "forecasting_settings"}>
                  {cloudLoading === "forecasting_settings" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  Save cloud
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={onClearLocalForecastingSettings}>
                  <Trash2 className="h-3.5 w-3.5" />
                  Clear local
                </Button>
              </>
            ),
          })}
        </div>
        {(cloudMessage || cloudError) && (
          <div className="mt-3 rounded-md border border-border bg-muted/20 p-3 text-xs">
            {cloudMessage && <div className="text-primary">{cloudMessage}</div>}
            {cloudError && <div className="text-destructive">{cloudError}</div>}
          </div>
        )}
      </Card>
    </AppLayout>
  );
}
