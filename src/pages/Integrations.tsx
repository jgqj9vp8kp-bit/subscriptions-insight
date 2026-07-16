import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, KeyRound, Loader2, Plug, RefreshCw, ShieldOff, Terminal } from "lucide-react";
import { AppLayout } from "@/components/AppLayout";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
import { CampaignIdSplitDiagnostics } from "@/components/CampaignIdSplitDiagnostics";
import { ExportApiHealth } from "@/components/ExportApiHealth";
import {
  createApiKey,
  exportCampaignPerformanceEndpoint,
  listApiExportLogs,
  listApiKeys,
  revokeApiKey,
  type ApiExportLogRecord,
  type ApiKeyRecord,
} from "@/services/integrations";
import {
  CAPSULED_FACEBOOK_LEVELS,
  getCapsuledFacebookStatus,
  listCapsuledFacebookRows,
  syncCapsuledFacebookStats,
  type CapsuledFacebookLevel,
  type CapsuledFacebookSyncMetadata,
} from "@/services/capsuledFacebook";
import {
  clickHouseStatusLabel,
  getClickHouseSummary,
  initializeClickHouseSchema,
  runClickHouseBackfill,
  runClickHouseValidation,
  testClickHouseConnection,
  type ClickHouseBackfillResult,
  type ClickHouseHealth,
  type ClickHouseSummary,
  type ClickHouseValidationProgress,
} from "@/services/clickhouse";
import { campaignIdForTransaction, UNKNOWN_CAMPAIGN_ID } from "@/services/cohortFiltering";
import { buildFbTrafficDiagnostics, type FbTrafficDiagnosticsResult } from "@/services/fbTrafficDiagnostics";
import { useTransactions } from "@/services/sheets";

const MEDIA_BUYERS = ["all", "Ivan", "Artem A", "Artem D", "Unknown"] as const;

const DEFAULT_TEST_FILTERS = {
  date_from: "",
  date_to: "",
  campaign_path: "",
  media_buyer: "all",
  campaign_id: "",
};

const DEFAULT_CAPSULED_FILTERS = {
  dateFrom: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
  dateTo: new Date().toISOString().slice(0, 10),
  level: "campaign" as CapsuledFacebookLevel,
};

function formatDateTime(value: string | null): string {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatNumber(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("en-US") : "-";
}

function formatMoney(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? `$${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}` : "-";
}

function buildExampleRequest(endpoint: string): string {
  return `curl -G "${endpoint}" \\
  -H "Authorization: Bearer subengine_live_xxxxx" \\
  --data-urlencode "date_from=2026-05-01" \\
  --data-urlencode "date_to=2026-05-08" \\
  --data-urlencode "media_buyer=Ivan"`;
}

const exampleResponse = JSON.stringify(
  {
    data: [
      {
        campaign_id: "123",
        campaign_path: "past-life-astrology",
        funnel: "past_life",
        date_from: "2026-05-01",
        date_to: "2026-05-08",
        trial_users: 100,
        upsell_users: 20,
        upsell_cr: 0.2,
        first_sub_users: 35,
        trial_to_first_sub_cr: 0.35,
        refund_users: 3,
        net_revenue: 1180.5,
        spend: 400,
        cac: 4,
        roas: 2.95,
      },
    ],
    meta: {
      date_from: "2026-05-01",
      date_to: "2026-05-08",
      rows: 1,
      traffic_rows: 12,
      generated_at: "2026-06-11T00:00:00.000Z",
    },
  },
  null,
  2,
);

function CodeBlock({ value }: { value: string }) {
  return (
    <pre className="overflow-auto rounded-md bg-muted p-3 text-xs text-muted-foreground">
      <code>{value}</code>
    </pre>
  );
}

export default function IntegrationsPage() {
  const { toast } = useToast();
  const txs = useTransactions();
  const endpoint = useMemo(() => exportCampaignPerformanceEndpoint(), []);
  const [apiKeys, setApiKeys] = useState<ApiKeyRecord[]>([]);
  const [logs, setLogs] = useState<ApiExportLogRecord[]>([]);
  const [capsuledStatus, setCapsuledStatus] = useState<CapsuledFacebookSyncMetadata | null>(null);
  const [capsuledDiagnostics, setCapsuledDiagnostics] = useState<FbTrafficDiagnosticsResult | null>(null);
  const [capsuledFilters, setCapsuledFilters] = useState(DEFAULT_CAPSULED_FILTERS);
  const [capsuledSyncing, setCapsuledSyncing] = useState<"sync" | "force" | null>(null);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [keyName, setKeyName] = useState("Campaign performance export");
  const [newRawKey, setNewRawKey] = useState<string | null>(null);
  const [testApiKey, setTestApiKey] = useState("");
  const [testFilters, setTestFilters] = useState(DEFAULT_TEST_FILTERS);
  const [testing, setTesting] = useState(false);
  const [testResponse, setTestResponse] = useState<string>("");
  const [clickHouseHealth, setClickHouseHealth] = useState<ClickHouseHealth | null>(null);
  const [clickHouseSummary, setClickHouseSummary] = useState<ClickHouseSummary | null>(null);
  const [clickHouseLastBackfill, setClickHouseLastBackfill] = useState<ClickHouseBackfillResult | null>(null);
  const [clickHouseValidation, setClickHouseValidation] = useState<ClickHouseValidationProgress | null>(null);
  const [clickHouseValidationRunning, setClickHouseValidationRunning] = useState(false);
  const clickHouseValidationStopRef = useRef(false);
  const clickHouseValidationInFlightRef = useRef(false);
  const [clickHouseTesting, setClickHouseTesting] = useState(false);
  const [clickHouseAction, setClickHouseAction] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [keys, exportLogs, status, rows, chSummary] = await Promise.all([
        listApiKeys(),
        listApiExportLogs(20),
        getCapsuledFacebookStatus().catch(() => null),
        listCapsuledFacebookRows().catch(() => []),
        getClickHouseSummary().catch(() => null),
      ]);
      setApiKeys(keys);
      setLogs(exportLogs);
      setCapsuledStatus(status);
      setClickHouseSummary(chSummary);
      const warehouseCampaignIds = txs
        .filter((tx) => tx.status === "success" && tx.transaction_type === "trial")
        .map(campaignIdForTransaction)
        .filter((id) => id !== UNKNOWN_CAMPAIGN_ID);
      setCapsuledDiagnostics(buildFbTrafficDiagnostics({ warehouseCampaignIds, capsuledRows: rows, selectedLevel: "campaign", latestSyncMetadata: status }));
    } catch (error) {
      toast({
        title: "Could not load integrations",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [toast, txs]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function onCreateKey() {
    setCreating(true);
    try {
      const result = await createApiKey(keyName);
      setNewRawKey(result.rawKey);
      setTestApiKey(result.rawKey);
      setApiKeys((current) => [result.record, ...current]);
      toast({ title: "API key created", description: "The key is shown once. Store it before leaving this page." });
    } catch (error) {
      toast({
        title: "Could not create API key",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setCreating(false);
    }
  }

  async function onRevokeKey(id: string) {
    setRevokingId(id);
    try {
      await revokeApiKey(id);
      setApiKeys((current) => current.map((key) => key.id === id ? { ...key, is_active: false, revoked_at: new Date().toISOString() } : key));
      toast({ title: "API key revoked" });
    } catch (error) {
      toast({
        title: "Could not revoke API key",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setRevokingId(null);
    }
  }

  async function copyText(value: string) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        // navigator.clipboard exists only in secure contexts (HTTPS or localhost); over plain-HTTP
        // LAN access fall back to a hidden textarea + execCommand.
        const textarea = document.createElement("textarea");
        textarea.value = value;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        textarea.remove();
      }
      toast({ title: "Copied" });
    } catch (error) {
      toast({
        title: "Could not copy",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    }
  }

  async function onTestExport() {
    setTesting(true);
    setTestResponse("");
    try {
      const url = new URL(endpoint);
      Object.entries(testFilters).forEach(([key, value]) => {
        if (!value || value === "all") return;
        url.searchParams.set(key, value);
      });
      const response = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${testApiKey.trim()}` },
      });
      const payload = await response.json().catch(() => ({ error: "Invalid JSON response" }));
      setTestResponse(JSON.stringify(payload, null, 2));
      await refresh();
      if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
    } catch (error) {
      toast({
        title: "Export test failed",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setTesting(false);
    }
  }

  async function onTestClickHouse() {
    setClickHouseTesting(true);
    try {
      const health = await testClickHouseConnection();
      setClickHouseHealth(health);
      toast({
        title: health.connected ? "ClickHouse connected" : "ClickHouse not connected",
        description: health.connected
          ? `SELECT 1 succeeded${health.latency_ms != null ? ` in ${health.latency_ms} ms` : ""}.`
          : health.error ?? "Connection could not be verified.",
        variant: health.connected ? undefined : "destructive",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      setClickHouseHealth({ connected: false, error: message });
      toast({ title: "ClickHouse test failed", description: message, variant: "destructive" });
    } finally {
      setClickHouseTesting(false);
    }
  }

  async function runClickHouseAction<T>(action: string, work: () => Promise<T>, success: (result: T) => string) {
    setClickHouseAction(action);
    try {
      const result = await work();
      toast({ title: "ClickHouse updated", description: success(result) });
      const [health, summary] = await Promise.all([
        testClickHouseConnection().catch(() => null),
        getClickHouseSummary().catch(() => null),
      ]);
      if (health) setClickHouseHealth(health);
      setClickHouseSummary(summary);
      return result;
    } catch (error) {
      toast({
        title: "ClickHouse action failed",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
      return null;
    } finally {
      setClickHouseAction(null);
    }
  }

  async function onInitializeClickHouse() {
    await runClickHouseAction("init", initializeClickHouseSchema, (result) =>
      `Schema ready: ${result.columns_count} columns, ${result.current_row_count.toLocaleString("en-US")} rows.`,
    );
  }

  async function onBackfillClickHouse(mode: "continue" | "full_backfill", controlled = false) {
    if (mode === "full_backfill" && !window.confirm("Run a full ClickHouse backfill from the beginning? This will not truncate ClickHouse or delete Supabase data.")) {
      return;
    }
    const result = await runClickHouseAction(
      controlled ? "controlled_backfill" : mode,
      () => runClickHouseBackfill({
        mode,
        batch_size: controlled ? 1000 : 2000,
        max_batches: controlled ? 2 : 10,
        dry_run: false,
        full_reset_cursor: mode === "full_backfill",
      }),
      (backfill) => `${backfill.status}: inserted ${backfill.rows_inserted.toLocaleString("en-US")} rows, stopped: ${backfill.stopped_reason}.`,
    );
    if (result) setClickHouseLastBackfill(result);
  }

  // Resumable validation: one Edge call processes a bounded chunk; the client
  // loops start -> continue -> ... until completed/failed/stopped. Requests are
  // strictly sequential (each awaited before the next) so they never overlap.
  async function runValidationLoop(initialAction: "start" | "continue") {
    if (clickHouseValidationInFlightRef.current || clickHouseValidationRunning) return;
    clickHouseValidationStopRef.current = false;
    setClickHouseValidationRunning(true);
    let action: "start" | "continue" = initialAction;
    try {
      for (;;) {
        clickHouseValidationInFlightRef.current = true;
        let progress: ClickHouseValidationProgress;
        try {
          progress = await runClickHouseValidation({
            action,
            validation_scope: "imported_cursor_range",
            page_size: 500,
            max_pages: 3,
          });
        } finally {
          clickHouseValidationInFlightRef.current = false;
        }
        setClickHouseValidation(progress);

        if (progress.completed || progress.status === "completed") {
          toast({
            title: `Validation ${progress.parity_status ?? "completed"}`,
            description: `${formatNumber(progress.source_rows)} source rows · missing ${progress.missing_ids ?? 0} · extra ${progress.extra_ids ?? 0} · duplicates ${progress.duplicate_ids ?? 0}.`,
            variant: progress.parity_status === "PASS" ? undefined : "destructive",
          });
          break;
        }
        if (progress.status === "failed" || progress.stopped_reason === "source_error" || progress.stopped_reason === "clickhouse_error") {
          toast({
            title: "Validation paused",
            description: `Stopped: ${progress.stopped_reason ?? "error"}. Progress saved — press Continue to resume.`,
            variant: "destructive",
          });
          break;
        }
        if (clickHouseValidationStopRef.current) {
          toast({ title: "Validation paused", description: "Stopped by user — press Continue to resume." });
          break;
        }
        action = "continue";
      }
    } catch (error) {
      toast({ title: "Validation failed", description: error instanceof Error ? error.message : "Unknown error", variant: "destructive" });
    } finally {
      clickHouseValidationInFlightRef.current = false;
      setClickHouseValidationRunning(false);
      getClickHouseSummary().then((summary) => setClickHouseSummary(summary)).catch(() => undefined);
    }
  }

  function onStartValidation() {
    void runValidationLoop("start");
  }
  function onContinueValidation() {
    void runValidationLoop("continue");
  }
  function onStopValidation() {
    clickHouseValidationStopRef.current = true;
  }
  async function onResetValidation() {
    clickHouseValidationStopRef.current = true;
    if (clickHouseValidationInFlightRef.current) return;
    try {
      const progress = await runClickHouseValidation({ action: "reset", validation_scope: "imported_cursor_range" });
      setClickHouseValidation(progress);
      toast({ title: "Validation reset", description: "Validation progress cleared. ClickHouse and warehouse data untouched." });
    } catch (error) {
      toast({ title: "Reset failed", description: error instanceof Error ? error.message : "Unknown error", variant: "destructive" });
    }
  }

  async function onCapsuledSync(force: boolean) {
    setCapsuledSyncing(force ? "force" : "sync");
    try {
      const result = await syncCapsuledFacebookStats({ ...capsuledFilters, force });
      setCapsuledStatus(result.metadata);
      const warehouseCampaignIds = txs
        .filter((tx) => tx.status === "success" && tx.transaction_type === "trial")
        .map(campaignIdForTransaction)
        .filter((id) => id !== UNKNOWN_CAMPAIGN_ID);
      const diagnostics = buildFbTrafficDiagnostics({ warehouseCampaignIds, capsuledRows: result.rows, selectedLevel: "campaign", latestSyncMetadata: result.metadata });
      setCapsuledDiagnostics(diagnostics);
      toast({
        title: force ? "Capsuled force resync complete" : "Capsuled sync complete",
        description: `Imported ${result.metadata.rowsImported} rows. Matched ${diagnostics.summary.matched_campaign_ids_count} Campaign IDs.`,
      });
      void refresh();
    } catch (error) {
      toast({
        title: "Capsuled sync failed",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setCapsuledSyncing(null);
    }
  }

  return (
    <AppLayout title="Integrations" description="Secure export access for external platforms">
      <section className="mb-4">
        <ExportApiHealth />
      </section>

      <section className="mb-4">
        <Card className="p-4 shadow-card">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <Plug className="h-4 w-4 text-primary" />
                <h2 className="text-sm font-semibold text-foreground">Capsuled Facebook</h2>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">Facebook metrics sync through the Supabase Edge Function only.</p>
            </div>
            <div className="text-right text-xs">
              <div className="text-muted-foreground">Status</div>
              <div className="mt-1 font-medium text-foreground">
                {capsuledStatus?.connected ? "Connected" : capsuledStatus?.status === "failed" ? "Failed" : "Not synced"}
              </div>
            </div>
          </div>

          <div className="mt-4 grid gap-3 md:grid-cols-3 xl:grid-cols-6">
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">dateFrom</Label>
              <Input
                type="date"
                value={capsuledFilters.dateFrom}
                onChange={(event) => setCapsuledFilters((current) => ({ ...current, dateFrom: event.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">dateTo</Label>
              <Input
                type="date"
                value={capsuledFilters.dateTo}
                onChange={(event) => setCapsuledFilters((current) => ({ ...current, dateTo: event.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">level</Label>
              <Select
                value={capsuledFilters.level}
                onValueChange={(value) => setCapsuledFilters((current) => ({ ...current, level: value as CapsuledFacebookLevel }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CAPSULED_FACEBOOK_LEVELS.map((level) => (
                    <SelectItem key={level} value={level}>{level}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-end">
              <Button type="button" className="w-full" onClick={() => onCapsuledSync(false)} disabled={Boolean(capsuledSyncing)}>
                {capsuledSyncing === "sync" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                Sync
              </Button>
            </div>
            <div className="flex items-end">
              <Button type="button" variant="outline" className="w-full" onClick={() => onCapsuledSync(true)} disabled={Boolean(capsuledSyncing)}>
                {capsuledSyncing === "force" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                Force Resync
              </Button>
            </div>
            <div className="flex items-end">
              <Button type="button" variant="outline" className="w-full" onClick={refresh} disabled={loading || Boolean(capsuledSyncing)}>
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                Refresh
              </Button>
            </div>
          </div>

          <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <div><span className="text-xs text-muted-foreground">Last Sync</span><div className="text-sm font-medium">{formatDateTime(capsuledStatus?.lastSync ?? null)}</div></div>
            <div><span className="text-xs text-muted-foreground">Last Status</span><div className="text-sm font-medium">{capsuledStatus?.status ?? "unknown"}</div></div>
            <div><span className="text-xs text-muted-foreground">Last Level</span><div className="text-sm font-medium">{capsuledStatus?.level ?? "-"}</div></div>
            <div><span className="text-xs text-muted-foreground">Last Date Range</span><div className="text-sm font-medium">{capsuledStatus?.dateFrom ?? "-"} to {capsuledStatus?.dateTo ?? "-"}</div></div>
            <div><span className="text-xs text-muted-foreground">Rows Imported</span><div className="text-sm font-medium">{capsuledStatus?.rowsImported?.toLocaleString("en-US") ?? "0"}</div></div>
            <div><span className="text-xs text-muted-foreground">API Freshness</span><div className="text-sm font-medium">{capsuledStatus?.apiFreshness ?? "-"}</div></div>
            <div><span className="text-xs text-muted-foreground">Facebook Stats Date</span><div className="text-sm font-medium">{capsuledStatus?.facebookStatsDate ?? "-"}</div></div>
            <div><span className="text-xs text-muted-foreground">Sync Duration</span><div className="text-sm font-medium">{capsuledStatus?.syncDurationMs == null ? "-" : `${capsuledStatus.syncDurationMs} ms`}</div></div>
            <div><span className="text-xs text-muted-foreground">Unique Campaign IDs</span><div className="text-sm font-medium">{capsuledDiagnostics?.summary.capsuled_unique_campaign_ids_count.toLocaleString("en-US") ?? "0"}</div></div>
            <div><span className="text-xs text-muted-foreground">Rows without Campaign ID</span><div className="text-sm font-medium">{capsuledDiagnostics?.summary.missing_campaign_id_rows_count.toLocaleString("en-US") ?? "0"}</div></div>
            <div><span className="text-xs text-muted-foreground">Rows without Spend</span><div className="text-sm font-medium">{capsuledDiagnostics?.summary.rows_without_spend_count.toLocaleString("en-US") ?? "0"}</div></div>
            <div><span className="text-xs text-muted-foreground">Duplicate Campaign IDs</span><div className="text-sm font-medium">{capsuledDiagnostics?.summary.duplicate_capsuled_campaign_ids_count.toLocaleString("en-US") ?? "0"}</div></div>
            <div><span className="text-xs text-muted-foreground">Total Spend</span><div className="text-sm font-medium">${(capsuledDiagnostics?.summary.total_spend ?? 0).toLocaleString("en-US")}</div></div>
            <div><span className="text-xs text-muted-foreground">FB Purchases</span><div className="text-sm font-medium">{(capsuledDiagnostics?.summary.total_fb_purchases ?? 0).toLocaleString("en-US")}</div></div>
            <div><span className="text-xs text-muted-foreground">Failed Requests</span><div className="text-sm font-medium">{capsuledStatus?.failedRequests.length ?? 0}</div></div>
            <div><span className="text-xs text-muted-foreground">Last API response</span><div className="truncate text-sm font-medium">{capsuledStatus?.lastApiResponse ?? "-"}</div></div>
          </div>
        </Card>
      </section>

      <section className="mb-4">
        <Card className="p-4 shadow-card">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <Plug className="h-4 w-4 text-primary" />
                <h2 className="text-sm font-semibold text-foreground">ClickHouse Analytics Warehouse</h2>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Server-side connection only. Credentials are read from Supabase Edge Function Secrets and never exposed to the browser.
              </p>
            </div>
            <div className="text-right text-xs">
              <div className="text-muted-foreground">Status</div>
              <div
                className={`mt-1 font-medium ${
                  clickHouseHealth?.connected
                    ? "text-success"
                    : clickHouseHealth
                      ? "text-destructive"
                      : "text-muted-foreground"
                }`}
              >
                {clickHouseStatusLabel(clickHouseHealth)}
              </div>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button type="button" onClick={onTestClickHouse} disabled={clickHouseTesting}>
              {clickHouseTesting ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Test Connection
            </Button>
            <Button type="button" variant="outline" onClick={onInitializeClickHouse} disabled={Boolean(clickHouseAction)}>
              {clickHouseAction === "init" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              Initialize Schema
            </Button>
            <Button type="button" variant="outline" onClick={() => onBackfillClickHouse("continue", true)} disabled={Boolean(clickHouseAction)}>
              {clickHouseAction === "controlled_backfill" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Run Controlled Backfill
            </Button>
            <Button type="button" variant="outline" onClick={() => onBackfillClickHouse("continue")} disabled={Boolean(clickHouseAction)}>
              {clickHouseAction === "continue" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Continue Backfill
            </Button>
            <Button type="button" variant="outline" onClick={() => onBackfillClickHouse("full_backfill")} disabled={Boolean(clickHouseAction)}>
              {clickHouseAction === "full_backfill" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Run Full Backfill
            </Button>
            <Button type="button" variant="outline" onClick={onStartValidation} disabled={clickHouseValidationRunning || Boolean(clickHouseAction)}>
              {clickHouseValidationRunning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              Start Validation
            </Button>
            <Button type="button" variant="outline" onClick={onContinueValidation} disabled={clickHouseValidationRunning || Boolean(clickHouseAction)}>
              <RefreshCw className="h-4 w-4" />
              Continue Validation
            </Button>
            {clickHouseValidationRunning && (
              <Button type="button" variant="outline" onClick={onStopValidation}>
                Stop Validation
              </Button>
            )}
            <Button type="button" variant="outline" onClick={onResetValidation} disabled={clickHouseValidationRunning}>
              <ShieldOff className="h-4 w-4" />
              Reset Validation
            </Button>
            <Button type="button" variant="outline" onClick={refresh} disabled={loading || Boolean(clickHouseAction)}>
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Refresh Status
            </Button>
            {clickHouseHealth && (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                {clickHouseHealth.database && (
                  <span>
                    database: <span className="font-mono text-foreground">{clickHouseHealth.database}</span>
                  </span>
                )}
                {clickHouseHealth.latency_ms != null && (
                  <span>
                    latency: <span className="font-medium text-foreground">{clickHouseHealth.latency_ms} ms</span>
                  </span>
                )}
                {clickHouseHealth.connected && (
                  <span className="text-success">SELECT 1 OK</span>
                )}
              </div>
            )}
          </div>

          <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <div><span className="text-xs text-muted-foreground">Connection</span><div className="text-sm font-medium">{clickHouseStatusLabel(clickHouseHealth)}</div></div>
            <div><span className="text-xs text-muted-foreground">Database</span><div className="text-sm font-medium">{clickHouseHealth?.database ?? "-"}</div></div>
            <div><span className="text-xs text-muted-foreground">Latency</span><div className="text-sm font-medium">{clickHouseHealth?.latency_ms == null ? "-" : `${clickHouseHealth.latency_ms} ms`}</div></div>
            <div><span className="text-xs text-muted-foreground">Table exists</span><div className="text-sm font-medium">{clickHouseSummary?.error ? "Unknown" : clickHouseSummary ? "Yes" : "-"}</div></div>
            <div><span className="text-xs text-muted-foreground">Current ClickHouse rows</span><div className="text-sm font-medium">{formatNumber(clickHouseSummary?.transaction_count ?? clickHouseSummary?.sync_state?.clickhouse_total ?? null)}</div></div>
            <div><span className="text-xs text-muted-foreground">Status</span><div className="text-sm font-medium">{clickHouseSummary?.sync_state?.status ?? "never_started"}</div></div>
            <div><span className="text-xs text-muted-foreground">Current stage</span><div className="text-sm font-medium">{clickHouseSummary?.sync_state?.current_stage ?? "-"}</div></div>
            <div><span className="text-xs text-muted-foreground">Rows scanned</span><div className="text-sm font-medium">{formatNumber(clickHouseSummary?.sync_state?.rows_scanned)}</div></div>
            <div><span className="text-xs text-muted-foreground">Rows inserted</span><div className="text-sm font-medium">{formatNumber(clickHouseSummary?.sync_state?.rows_inserted)}</div></div>
            <div><span className="text-xs text-muted-foreground">Rows skipped</span><div className="text-sm font-medium">{formatNumber(clickHouseSummary?.sync_state?.rows_skipped)}</div></div>
            <div><span className="text-xs text-muted-foreground">Batches processed</span><div className="text-sm font-medium">{formatNumber(clickHouseSummary?.sync_state?.batches_processed)}</div></div>
            <div><span className="text-xs text-muted-foreground">Last cursor</span><div className="truncate text-sm font-medium">{clickHouseSummary?.sync_state?.cursor_updated_at ?? "-"}</div></div>
            <div><span className="text-xs text-muted-foreground">Stopped reason</span><div className="text-sm font-medium">{clickHouseLastBackfill?.stopped_reason ?? clickHouseSummary?.sync_state?.stopped_reason ?? "-"}</div></div>
            <div><span className="text-xs text-muted-foreground">Last sync</span><div className="text-sm font-medium">{formatDateTime(clickHouseSummary?.sync_state?.finished_at ?? null)}</div></div>
            <div><span className="text-xs text-muted-foreground">Duration</span><div className="text-sm font-medium">{clickHouseSummary?.sync_state?.duration_ms == null ? "-" : `${clickHouseSummary.sync_state.duration_ms} ms`}</div></div>
            <div><span className="text-xs text-muted-foreground">Validation</span><div className="text-sm font-medium">{clickHouseValidation?.parity_status ?? clickHouseSummary?.sync_state?.parity_status ?? "Never run"}</div></div>
            <div><span className="text-xs text-muted-foreground">Validation status</span><div className="text-sm font-medium">{clickHouseValidation?.status ?? "-"}</div></div>
            <div><span className="text-xs text-muted-foreground">Validation stage</span><div className="text-sm font-medium">{clickHouseValidation?.stage ?? "-"}</div></div>
            <div><span className="text-xs text-muted-foreground">Rows processed / expected</span><div className="text-sm font-medium">{formatNumber(clickHouseValidation?.rows_processed)} / {formatNumber(clickHouseValidation?.source_rows_expected ?? null)}</div></div>
            <div><span className="text-xs text-muted-foreground">Progress</span><div className="text-sm font-medium">{clickHouseValidation ? `${clickHouseValidation.progress_percent}%` : "-"}</div></div>
            <div><span className="text-xs text-muted-foreground">Pages processed</span><div className="text-sm font-medium">{formatNumber(clickHouseValidation?.pages_processed)}</div></div>
            <div><span className="text-xs text-muted-foreground">Validation cursor</span><div className="truncate text-sm font-medium">{clickHouseValidation?.current_cursor?.updated_at ?? "-"}</div></div>
            <div><span className="text-xs text-muted-foreground">Validation stopped reason</span><div className="text-sm font-medium">{clickHouseValidation?.stopped_reason ?? "-"}</div></div>
            <div><span className="text-xs text-muted-foreground">Source rows</span><div className="text-sm font-medium">{formatNumber(clickHouseValidation?.source_rows ?? clickHouseSummary?.sync_state?.source_total ?? null)}</div></div>
            <div><span className="text-xs text-muted-foreground">Missing IDs</span><div className="text-sm font-medium">{formatNumber(clickHouseValidation?.missing_ids ?? null)}</div></div>
            <div><span className="text-xs text-muted-foreground">Extra IDs</span><div className="text-sm font-medium">{formatNumber(clickHouseValidation?.extra_ids ?? null)}</div></div>
            <div><span className="text-xs text-muted-foreground">Duplicate IDs</span><div className="text-sm font-medium">{formatNumber(clickHouseValidation?.duplicate_ids ?? null)}</div></div>
            <div><span className="text-xs text-muted-foreground">Gross difference</span><div className="text-sm font-medium">{formatMoney(clickHouseValidation?.gross_difference ?? null)}</div></div>
            <div><span className="text-xs text-muted-foreground">Net difference</span><div className="text-sm font-medium">{formatMoney(clickHouseValidation?.net_difference ?? null)}</div></div>
            <div><span className="text-xs text-muted-foreground">Refund difference</span><div className="text-sm font-medium">{formatMoney(clickHouseValidation?.refund_difference ?? null)}</div></div>
          </div>

          {(clickHouseHealth?.error || clickHouseSummary?.error || clickHouseSummary?.sync_state?.last_error) && (
            <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
              {clickHouseHealth?.error ?? clickHouseSummary?.error ?? clickHouseSummary?.sync_state?.last_error}
            </div>
          )}
          <p className="mt-3 text-xs text-muted-foreground">
            Phase 2 only initializes, backfills, and validates the warehouse. Analytics pages still read their existing sources.
          </p>
        </Card>
      </section>

      <section className="grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(360px,0.9fr)]">
        <div className="space-y-4">
          <Card className="p-4 shadow-card">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-foreground">API Keys</h2>
                <p className="mt-1 text-xs text-muted-foreground">Keys are hashed before storage. Raw keys are shown only once.</p>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={refresh} disabled={loading}>
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                Refresh
              </Button>
            </div>

            <div className="mt-4 grid gap-3 md:grid-cols-[minmax(220px,1fr)_auto]">
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">Key name</Label>
                <Input value={keyName} onChange={(event) => setKeyName(event.target.value)} />
              </div>
              <div className="flex items-end">
                <Button type="button" className="w-full md:w-auto" onClick={onCreateKey} disabled={creating}>
                  {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
                  Create key
                </Button>
              </div>
            </div>

            {newRawKey && (
              <div className="mt-4 rounded-md border border-success/30 bg-success/10 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-medium text-foreground">New API key</span>
                  <Button type="button" variant="outline" size="sm" onClick={() => copyText(newRawKey)}>
                    <Copy className="h-3.5 w-3.5" />
                    Copy
                  </Button>
                </div>
                <div className="mt-2 overflow-auto rounded-md bg-background p-2 font-mono text-xs">{newRawKey}</div>
              </div>
            )}

            <div className="mt-4 overflow-auto rounded-md border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Prefix</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead>Last used</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {apiKeys.length ? apiKeys.map((key) => (
                    <TableRow key={key.id}>
                      <TableCell className="font-medium">{key.name}</TableCell>
                      <TableCell className="font-mono text-xs">{key.prefix}</TableCell>
                      <TableCell>{key.is_active && !key.revoked_at ? "Active" : "Revoked"}</TableCell>
                      <TableCell>{formatDateTime(key.created_at)}</TableCell>
                      <TableCell>{formatDateTime(key.last_used_at)}</TableCell>
                      <TableCell className="text-right">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={!key.is_active || Boolean(key.revoked_at) || revokingId === key.id}
                          onClick={() => onRevokeKey(key.id)}
                        >
                          {revokingId === key.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldOff className="h-3.5 w-3.5" />}
                          Revoke
                        </Button>
                      </TableCell>
                    </TableRow>
                  )) : (
                    <TableRow>
                      <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">No API keys yet</TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </Card>

          <Card className="p-4 shadow-card">
            <div className="flex items-center gap-2">
              <Terminal className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-semibold text-foreground">Export Endpoint</h2>
            </div>
            <div className="mt-3 space-y-3">
              <div>
                <Label className="text-xs text-muted-foreground">Endpoint URL</Label>
                <div className="mt-2 flex gap-2">
                  <Input readOnly value={endpoint} className="font-mono text-xs" />
                  <Button type="button" variant="outline" size="icon" onClick={() => copyText(endpoint)}>
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <CodeBlock value={buildExampleRequest(endpoint)} />
              <CodeBlock value={exampleResponse} />
            </div>
          </Card>
        </div>

        <div className="space-y-4">
          <Card className="p-4 shadow-card">
            <div className="flex items-center gap-2">
              <Plug className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-semibold text-foreground">Test Export</h2>
            </div>
            <div className="mt-4 space-y-3">
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">API key</Label>
                <Input value={testApiKey} onChange={(event) => setTestApiKey(event.target.value)} placeholder="subengine_live_xxxxx" />
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <div className="space-y-2">
                  <Label className="text-xs text-muted-foreground">date_from</Label>
                  <Input type="date" value={testFilters.date_from} onChange={(event) => setTestFilters((current) => ({ ...current, date_from: event.target.value }))} />
                </div>
                <div className="space-y-2">
                  <Label className="text-xs text-muted-foreground">date_to</Label>
                  <Input type="date" value={testFilters.date_to} onChange={(event) => setTestFilters((current) => ({ ...current, date_to: event.target.value }))} />
                </div>
              </div>
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">funnel / campaign_path</Label>
                <Input value={testFilters.campaign_path} onChange={(event) => setTestFilters((current) => ({ ...current, campaign_path: event.target.value }))} />
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <div className="space-y-2">
                  <Label className="text-xs text-muted-foreground">media_buyer</Label>
                  <Select value={testFilters.media_buyer} onValueChange={(value) => setTestFilters((current) => ({ ...current, media_buyer: value }))}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {MEDIA_BUYERS.map((buyer) => (
                        <SelectItem key={buyer} value={buyer}>{buyer === "all" ? "All" : buyer}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label className="text-xs text-muted-foreground">campaign_id</Label>
                  <Input value={testFilters.campaign_id} onChange={(event) => setTestFilters((current) => ({ ...current, campaign_id: event.target.value }))} />
                </div>
              </div>
              <Button type="button" className="w-full" onClick={onTestExport} disabled={testing || !testApiKey.trim()}>
                {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                Test API response
              </Button>
              {testResponse && <CodeBlock value={testResponse} />}
            </div>
          </Card>

          <Card className="p-4 shadow-card">
            <h2 className="text-sm font-semibold text-foreground">Export Logs</h2>
            <div className="mt-4 overflow-auto rounded-md border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Time</TableHead>
                    <TableHead>Key</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Rows</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {logs.length ? logs.map((log) => (
                    <TableRow key={log.id}>
                      <TableCell>{formatDateTime(log.created_at)}</TableCell>
                      <TableCell className="font-mono text-xs">{log.key_prefix ?? "-"}</TableCell>
                      <TableCell>{log.status_code}</TableCell>
                      <TableCell className="text-right">{log.rows_returned}</TableCell>
                    </TableRow>
                  )) : (
                    <TableRow>
                      <TableCell colSpan={4} className="h-24 text-center text-muted-foreground">No export calls yet</TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </Card>
        </div>
      </section>

      <section className="mt-4">
        <CampaignIdSplitDiagnostics />
      </section>
    </AppLayout>
  );
}
