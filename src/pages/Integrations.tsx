import { useCallback, useEffect, useMemo, useState } from "react";
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

const MEDIA_BUYERS = ["all", "Ivan", "Artem A", "Artem D", "Unknown"] as const;

const DEFAULT_TEST_FILTERS = {
  date_from: "",
  date_to: "",
  campaign_path: "",
  media_buyer: "all",
  campaign_id: "",
};

function formatDateTime(value: string | null): string {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
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
  const endpoint = useMemo(() => exportCampaignPerformanceEndpoint(), []);
  const [apiKeys, setApiKeys] = useState<ApiKeyRecord[]>([]);
  const [logs, setLogs] = useState<ApiExportLogRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [keyName, setKeyName] = useState("Campaign performance export");
  const [newRawKey, setNewRawKey] = useState<string | null>(null);
  const [testApiKey, setTestApiKey] = useState("");
  const [testFilters, setTestFilters] = useState(DEFAULT_TEST_FILTERS);
  const [testing, setTesting] = useState(false);
  const [testResponse, setTestResponse] = useState<string>("");

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [keys, exportLogs] = await Promise.all([
        listApiKeys(),
        listApiExportLogs(20),
      ]);
      setApiKeys(keys);
      setLogs(exportLogs);
    } catch (error) {
      toast({
        title: "Could not load integrations",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [toast]);

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

  return (
    <AppLayout title="Integrations" description="Secure export access for external platforms">
      <section className="mb-4">
        <ExportApiHealth />
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
