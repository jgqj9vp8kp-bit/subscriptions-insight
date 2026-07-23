// Warehouse Health (Wave 4/5): the stored reconciliation history rendered live —
// current health, the six spend buckets (partition + Model 1 beside it, never
// forced equal) and the 7-green-days parity gate that authorizes the
// FB_WAREHOUSE_V2_READS flip.

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { loadFbReconHistory } from "@/services/fbWarehouse";
import { buildWarehouseHealthView, PARITY_GATE_REQUIRED_DAYS } from "@/services/fbWarehouseHealth";

const HEALTH_STYLES: Record<string, string> = {
  green: "bg-emerald-100 text-emerald-800",
  yellow: "bg-amber-100 text-amber-800",
  red: "bg-red-100 text-red-800",
};

const VERDICT_STYLES: Record<string, string> = {
  parity: "bg-emerald-100 text-emerald-800",
  mismatch: "bg-red-100 text-red-800",
  no_overlap: "bg-slate-100 text-slate-600",
  none: "bg-slate-100 text-slate-400",
};

const money = (value: number) => `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function Bucket({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="font-semibold tabular-nums" title={hint}>{value}</div>
    </div>
  );
}

export function FbWarehouseHealth() {
  const historyQuery = useQuery({
    queryKey: ["fb-recon-history"],
    queryFn: () => loadFbReconHistory(60),
    staleTime: 60_000,
  });

  const view = useMemo(
    () => buildWarehouseHealthView(historyQuery.data?.ok ? historyQuery.data.snapshots : []),
    [historyQuery.data],
  );

  if (!view.latest) {
    return (
      <Card className="p-4 shadow-card">
        <div className="mb-1 text-sm font-semibold">Warehouse Health</div>
        <p className="text-sm text-muted-foreground">
          {historyQuery.isLoading ? "Loading reconciliation history…" : "No reconciliation snapshots yet — run an FB sync (a snapshot is stored automatically after every sync)."}
        </p>
      </Card>
    );
  }

  const latest = view.latest;
  return (
    <Card className="p-4 shadow-card">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="text-sm font-semibold">Warehouse Health</div>
        <span className={`rounded px-2 py-0.5 text-xs font-medium uppercase ${HEALTH_STYLES[latest.health]}`}>{latest.health}</span>
        <span className="text-xs text-muted-foreground">
          {latest.window_from} → {latest.window_to} · coverage {(latest.coverage_pct * 100).toFixed(1)}%
          {latest.known_gap_days > 0 ? ` · known gaps ${latest.known_gap_days}d` : ""}
          {" · DQ "}{latest.dq_fail_count} fail / {latest.dq_warn_count} warn
        </span>
      </div>

      <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-7">
        <Bucket label="Source spend" value={money(latest.source_spend)} />
        <Bucket label="Allocated (funnel+users)" value={money(latest.allocated_campaign_spend)} hint={`${latest.campaigns_allocated} campaigns`} />
        <Bucket label="No-user (funnel only)" value={money(latest.no_user_spend)} hint={`${latest.campaigns_no_user} campaigns`} />
        <Bucket label="Unknown funnel" value={money(latest.unknown_funnel_spend)} hint={`${latest.campaigns_unknown_funnel} campaigns`} />
        <Bucket label="Unknown campaign" value={money(latest.unknown_campaign_spend)} hint={`${latest.campaigns_unknown} campaigns`} />
        <Bucket label="Funnel-resolved (M2)" value={money(latest.funnel_resolved_spend)} hint={`suggested share ${latest.suggested_share_pct.toFixed(1)}%`} />
        <Bucket label="User-allocated (M1)" value={money(latest.user_allocated_spend)} hint="Reported beside the partition — never forced to match" />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">
          V2 cutover gate: {view.consecutiveGreenDays}/{PARITY_GATE_REQUIRED_DAYS} green days
          {view.gateSatisfied ? " — READY to flip FB_WAREHOUSE_V2_READS" : ""}
        </span>
        {view.gateDays.map((day) => (
          <span key={day.date} className={`rounded px-1.5 py-0.5 text-[11px] tabular-nums ${VERDICT_STYLES[day.verdict]}`} title={day.verdict}>
            {day.date.slice(5)}
          </span>
        ))}
      </div>
    </Card>
  );
}
