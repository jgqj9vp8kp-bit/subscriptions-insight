import { useCallback, useEffect, useState } from "react";
import { Activity, AlertTriangle, CheckCircle2, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { getExportApiHealth, type ExportApiHealth as ExportApiHealthData } from "@/services/integrations";

function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function StatusCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md border border-border bg-background p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-semibold text-foreground">{value}</p>
      {hint && <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function ExportApiHealth() {
  const [health, setHealth] = useState<ExportApiHealthData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setHealth(await getExportApiHealth());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read API status.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const ready = health?.ready ?? false;

  return (
    <Card className="p-4 shadow-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-semibold text-foreground">Export API Data Status</h2>
        </div>
        <div className="flex items-center gap-2">
          {health && (
            <span
              className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${
                ready
                  ? "border-success/40 bg-success/10 text-success"
                  : "border-warning/40 bg-warning/10 text-warning"
              }`}
            >
              {ready ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
              {ready ? "API ready" : "Not ready"}
            </span>
          )}
          <Button type="button" variant="outline" size="sm" onClick={load} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Refresh
          </Button>
        </div>
      </div>

      <p className="mt-1 text-xs text-muted-foreground">
        Read directly from Supabase (warehouse + traffic snapshots) — the same data the server-side Export API
        serves. Independent of the local analytics cache.
      </p>

      {error ? (
        <div className="mt-4 rounded-md border border-warning/30 bg-warning/10 p-3 text-xs text-foreground">
          {error}
        </div>
      ) : (
        <>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatusCard
              label="Transactions in warehouse"
              value={health ? health.transactionsCount.toLocaleString("en-US") : "—"}
              hint={health && health.transactionsCount === 0 ? "Import data to enable the API" : "across all CSV parts"}
            />
            <StatusCard label="Import batches" value={health ? health.importBatches.toLocaleString("en-US") : "—"} hint="uploaded CSV parts" />
            <StatusCard label="Latest batch rows" value={health ? health.latestBatchRows.toLocaleString("en-US") : "—"} />
            <StatusCard
              label="Rows outside latest batch"
              value={health ? health.rowsOutsideLatestBatch.toLocaleString("en-US") : "—"}
              hint="from earlier CSV parts"
            />
            <StatusCard label="Latest transaction" value={formatDate(health?.latestTransactionAt ?? null)} />
            <StatusCard label="Latest traffic snapshot" value={formatDate(health?.latestTrafficSnapshotAt ?? null)} hint="spend / CAC / ROAS source" />
            <StatusCard
              label="Active API keys"
              value={health ? health.activeApiKeys.toLocaleString("en-US") : "—"}
              hint={health && health.activeApiKeys === 0 ? "Create a key below" : undefined}
            />
          </div>

          {health && (
            <div className="mt-3 rounded-md border border-success/30 bg-success/10 p-3 text-xs text-foreground">
              <span className="font-medium">API uses full warehouse: YES.</span>{" "}
              The Export API reads every import batch ({health.transactionsCount.toLocaleString("en-US")} rows;
              {" "}
              {health.rowsOutsideLatestBatch.toLocaleString("en-US")} from earlier CSV parts), not just the latest upload.
            </div>
          )}
        </>
      )}
    </Card>
  );
}
