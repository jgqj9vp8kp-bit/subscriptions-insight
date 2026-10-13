// Presentational building blocks the Payment System Health tabs share: the
// query frame (loading / typed error / NoAccess), comparison and rate cells
// with their sample and significance flags, the per-response meta notes
// (estimates shown verbatim, the grey "incomplete period" marker), a tiny
// sparkline, and the honest placeholder for sources that are not connected.
// Nothing here fetches; every figure comes in as a server aggregate.

import type { ReactNode } from "react";
import { AlertTriangle, ArrowDownRight, ArrowUpRight, Loader2, Minus, RefreshCw, ShieldQuestion } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { NoAccess } from "@/components/NoAccess";
import { cn } from "@/lib/utils";
import type { PaymentHealthQueryState } from "@/hooks/usePaymentHealth";
import type { PaymentHealthQuery } from "@/services/paymentHealthDataSource";
import type { PaymentHealthMeta, TrendPoint } from "../../../supabase/functions/_shared/clickhouse/paymentHealthContract";
import type { PeriodComparison, RateEstimate } from "../../../supabase/functions/_shared/clickhouse/paymentHealthMetrics";
import { fmtNum, summarizeComparison, summarizeRate, type ComparisonTone } from "./format";

/** What every tab receives from the page. */
export interface PaymentHealthTabProps {
  query: PaymentHealthQuery;
  userScopeHash: string;
  warehouseVersion: string;
  /** False until the page may send requests (warehouse version resolved, PSP selection settled). */
  enabled: boolean;
  /** meta.psp_global_visible of the options action: hides PSP columns before a response arrives. */
  pspVisible: boolean;
  /** Why the request is held back while `enabled` is false (shown in place of a progress bar). */
  idleNote?: string;
}

const TONE_CLASS: Record<ComparisonTone, string> = {
  good: "text-success",
  bad: "text-destructive",
  neutral: "text-muted-foreground",
};

export function DirectionIcon({ direction, tone, className }: { direction: PeriodComparison["direction"]; tone: ComparisonTone; className?: string }) {
  const cls = cn("h-3.5 w-3.5 shrink-0", TONE_CLASS[tone], className);
  if (direction === "up") return <ArrowUpRight className={cls} aria-label="up" />;
  if (direction === "down") return <ArrowDownRight className={cls} aria-label="down" />;
  return <Minus className={cn(cls, "text-muted-foreground")} aria-label={direction === "flat" ? "flat" : "unknown"} />;
}

export function FlagBadges({ flags, className }: { flags: string[]; className?: string }) {
  if (!flags.length) return null;
  return (
    <span className={cn("flex flex-wrap gap-1", className)}>
      {flags.map((flag) => (
        <Badge
          key={flag}
          variant={flag === "significant" ? "default" : "outline"}
          className={cn("px-1.5 py-0 text-[10px] font-medium", flag === "incomplete period" && "border-dashed text-muted-foreground", flag === "small sample" && "text-muted-foreground")}
        >
          {flag}
        </Badge>
      ))}
    </span>
  );
}

/** A period comparison in a table cell: current rate, arrow, delta, flags. */
export function ComparisonCell({ comparison, higherIsBetter, digits, compact }: { comparison: PeriodComparison | null | undefined; higherIsBetter: boolean; digits?: number; compact?: boolean }) {
  const s = summarizeComparison(comparison, { higherIsBetter, digits });
  return (
    <span className="inline-flex flex-col items-end gap-0.5 tabular-nums" title={`${s.reason}; previous period ${s.baseline}`}>
      <span className="flex items-center gap-1">
        <span className={cn("font-medium", s.current === "no data" && "font-normal text-muted-foreground")}>{s.current}</span>
        <DirectionIcon direction={s.direction} tone={s.tone} />
        <span className={cn("text-xs", TONE_CLASS[s.tone])}>{s.delta}</span>
      </span>
      {!compact && <FlagBadges flags={s.flags} className="justify-end" />}
    </span>
  );
}

/** A RateEstimate in a cell: the rate and, when flagged, "small sample". */
export function RateCell({ estimate, digits, showSample }: { estimate: RateEstimate | null | undefined; digits?: number; showSample?: boolean }) {
  const s = summarizeRate(estimate, digits);
  return (
    <span className="inline-flex flex-col items-end gap-0.5 tabular-nums" title={s.interval ? `95% interval ${s.interval} (${s.sample})` : s.sample || undefined}>
      <span className={cn("font-medium", s.text === "no data" && "font-normal text-muted-foreground")}>{s.text}</span>
      {(s.smallSample || showSample) && (
        <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
          {showSample && <span>{s.sample}</span>}
          {s.smallSample && <Badge variant="outline" className="px-1.5 py-0 text-[10px] font-medium text-muted-foreground">small sample</Badge>}
        </span>
      )}
    </span>
  );
}

/** A KPI card whose value is a period comparison (mirrors KpiCard's look). */
export function ComparisonKpiCard({ label, comparison, higherIsBetter, hint, digits, badge }: {
  label: string;
  comparison: PeriodComparison | null | undefined;
  higherIsBetter: boolean;
  hint?: string;
  digits?: number;
  badge?: ReactNode;
}) {
  const s = summarizeComparison(comparison, { higherIsBetter, digits });
  return (
    <Card className="p-4 shadow-card border-border" title={s.reason}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
        {badge}
      </div>
      <p className={cn("mt-2 text-2xl font-semibold tabular-nums text-foreground truncate", s.current === "no data" && "text-base font-medium text-muted-foreground")}>{s.current}</p>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span className={cn("flex items-center gap-1", TONE_CLASS[s.tone])}>
          <DirectionIcon direction={s.direction} tone={s.tone} />
          {s.delta}
        </span>
        <span className="text-muted-foreground">vs {s.baseline} before</span>
        <FlagBadges flags={s.flags} />
      </div>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </Card>
  );
}

/** A KPI card for a RateEstimate (chains, refunds by month, ...). */
export function RateKpiCard({ label, estimate, hint, badge }: { label: string; estimate: RateEstimate | null | undefined; hint?: string; badge?: ReactNode }) {
  const s = summarizeRate(estimate);
  return (
    <Card className="p-4 shadow-card border-border" title={s.interval ? `95% interval ${s.interval}` : undefined}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
        {badge}
      </div>
      <p className={cn("mt-2 text-2xl font-semibold tabular-nums text-foreground truncate", s.text === "no data" && "text-base font-medium text-muted-foreground")}>{s.text}</p>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        {s.sample && <span className="tabular-nums">{s.sample}</span>}
        {s.smallSample && <Badge variant="outline" className="px-1.5 py-0 text-[10px] font-medium text-muted-foreground">small sample</Badge>}
      </div>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </Card>
  );
}

export function HeuristicBadge({ label = "heuristic" }: { label?: string }) {
  return <Badge variant="outline" className="px-1.5 py-0 text-[10px] font-medium uppercase tracking-wide text-warning border-warning/50">{label}</Badge>;
}

export function SectionCard({ title, description, actions, children, className, testId }: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <Card className={cn("p-4 shadow-card", className)} data-testid={testId}>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
        </div>
        {actions}
      </div>
      {children}
    </Card>
  );
}

export function EmptyNote({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-sm text-muted-foreground">{children}</p>;
}

/** "Current / baseline" counts in one cell. */
export function PairCell({ current, baseline }: { current: number; baseline: number }) {
  return (
    <span className="inline-flex flex-col items-end tabular-nums">
      <span className="font-medium">{fmtNum(current)}</span>
      <span className="text-[10px] text-muted-foreground">prev {fmtNum(baseline)}</span>
    </span>
  );
}

/** The response-level notes every tab shows under its tables: the grey
 * incomplete marker, the funnel-attribution status, caps that were hit and the
 * server's estimate notes, verbatim (plan N, P). */
export function MetaNotes({ meta, className }: { meta: PaymentHealthMeta; className?: string }) {
  const limited = Object.entries(meta.limited ?? {}).filter(([, hit]) => hit).map(([cap]) => cap);
  return (
    <div className={cn("space-y-1 text-xs text-muted-foreground", className)} data-testid="meta-notes">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span>
          Window <span className="font-mono text-foreground">{meta.range.from} – {meta.range.to}</span> ({meta.range.days} d)
          {" "}vs <span className="font-mono">{meta.compare.from} – {meta.compare.to}</span>
        </span>
        {meta.incomplete && (
          <Badge variant="outline" className="border-dashed px-1.5 py-0 text-[10px] font-medium text-muted-foreground" data-testid="incomplete-period">
            incomplete period: data through {meta.data_through ?? "—"}
          </Badge>
        )}
        {meta.funnel_attribution.status === "no_snapshot" && (
          <Badge variant="outline" className="px-1.5 py-0 text-[10px] font-medium text-warning border-warning/50">funnel attribution: no snapshot</Badge>
        )}
        {limited.map((cap) => (
          <Badge key={cap} variant="outline" className="px-1.5 py-0 text-[10px] font-medium text-warning border-warning/50">cap hit: {cap}</Badge>
        ))}
        <span className="text-muted-foreground/70">{meta.query_duration_ms} ms</span>
      </div>
      {meta.estimates.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-4">
          {meta.estimates.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** An inline approval-rate sparkline over trend points (no axes, no labels). */
export function Sparkline({ points, width = 96, height = 24 }: { points: TrendPoint[]; width?: number; height?: number }) {
  const values = points.map((point) => point.approval_rate);
  const known = values.filter((value): value is number => value != null);
  if (known.length < 2) return <span className="text-[10px] text-muted-foreground">—</span>;
  const min = Math.min(...known);
  const max = Math.max(...known);
  const span = max - min || 1;
  const step = width / Math.max(values.length - 1, 1);
  const path = values
    .map((value, index) => (value == null ? null : `${(index * step).toFixed(1)},${(height - 2 - ((value - min) / span) * (height - 4)).toFixed(1)}`))
    .filter((point): point is string => point != null)
    .join(" ");
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="text-primary" role="img" aria-label="approval rate trend">
      <polyline fill="none" stroke="currentColor" strokeWidth={1.5} points={path} />
    </svg>
  );
}

/** Loading / typed error / data frame around one action's result. A 403 from
 * the gate renders the inline NoAccess shell (scope copy for a funnel-restricted
 * member); other failures show the message with a retry; a failed background
 * refresh keeps the last response visible with a warning line. */
export function QueryFrame<T>({ result, label, idleNote, children }: {
  result: PaymentHealthQueryState<T>;
  label: string;
  idleNote?: string;
  children: (data: T) => ReactNode;
}) {
  const { data, error } = result;
  if (result.isDisabled) {
    // Held back on purpose (an invalid custom window, a remembered PSP selection
    // waiting for the options answer): say why, not a progress bar stuck at 0%,
    // and not the previous window's figures under the new filters.
    return (
      <Card className="p-6 shadow-card" role="status" data-testid="payment-health-idle">
        <p className="text-sm text-muted-foreground">{idleNote ?? "Waiting for the filters to settle…"}</p>
      </Card>
    );
  }
  if (data == null) {
    if (error?.kind === "access" && (error.status === 403 || error.status === 401)) {
      return <NoAccess reason={error.errorCode === "scope_not_supported" ? "scope" : "permission"} />;
    }
    if (error) {
      return (
        <Card className="p-6 shadow-card" role="alert" data-testid="payment-health-error">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <div className="min-w-0 space-y-2">
              <p className="text-sm font-semibold text-foreground">Could not load {label}</p>
              <p className="break-words text-sm text-muted-foreground">{error.message}</p>
              {error.requestId && <p className="font-mono text-[10px] text-muted-foreground">request {error.requestId}</p>}
              <Button type="button" variant="outline" size="sm" onClick={result.refetch}>
                <RefreshCw className="h-4 w-4" /> Retry
              </Button>
            </div>
          </div>
        </Card>
      );
    }
    return (
      <Card className="p-6 shadow-card" role="status" data-testid="payment-health-loading">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading {label}… {result.progressPercent}%
        </div>
        <Progress value={result.progressPercent} className="mt-3 h-1.5 w-full max-w-xs" />
      </Card>
    );
  }
  return (
    <div className={cn("space-y-4", result.isBackgroundRefreshing && "opacity-80 transition-opacity")}>
      {error && (
        <p className="text-xs text-warning" role="status">refresh failed · showing the last response ({error.message})</p>
      )}
      {children(data)}
    </div>
  );
}

/** Plan R: disputes, fraud reports and 3DS are later phases; the page says so
 * instead of showing zeros. (Alerts have their own tab since P2.5.) */
export function DisputesPlaceholderCard({ className }: { className?: string }) {
  return (
    <Card className={cn("flex items-start gap-3 border-dashed p-4 shadow-none", className)} data-testid="disputes-placeholder">
      <ShieldQuestion className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">Disputes &amp; fraud reports: source not connected yet</p>
        <p className="text-xs text-muted-foreground">
          Chargebacks, TC40 / SAFE reports, dispute win rates and the official network ratios (VAMP, MC ECP) need the acquirer / PSP
          reports. Until they are connected the page shows no dispute figure at all, never a zero.
        </p>
      </div>
    </Card>
  );
}

/** "Show 25 · show all (N)" toggle for long tables. */
export function ShowAllToggle({ total, shown, expanded, onToggle }: { total: number; shown: number; expanded: boolean; onToggle: () => void }) {
  if (total <= shown && !expanded) return null;
  return (
    <div className="mt-2 flex justify-end">
      <Button type="button" variant="ghost" size="sm" onClick={onToggle} className="h-7 text-xs">
        {expanded ? `Show first ${shown}` : `Show all (${fmtNum(total)})`}
      </Button>
    </div>
  );
}
