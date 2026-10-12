// Overview tab (plan R, "Обзор PSP × MID"): the period KPIs with their
// comparisons, the attempt / approval trend, the PSP × MID table (only when the
// server says the PSP dimensions are visible), the decline-class mix and the
// "what changed" decomposition (Δdeclines = Δvolume × rate + volume × Δrate).

import { useMemo } from "react";
import { Bar, CartesianGrid, Cell, ComposedChart, Line, XAxis, YAxis } from "recharts";
import { CreditCard, DollarSign } from "lucide-react";
import { KpiCard } from "@/components/KpiCard";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { usePaymentHealthQuery } from "@/hooks/usePaymentHealth";
import type { OverviewResponse } from "@/services/paymentHealthDataSource";
import { DIMENSION_LABELS } from "../../../supabase/functions/_shared/clickhouse/paymentHealthContract";
import { fmtCountDelta, fmtNum, fmtPct, fmtShare, fmtUsd } from "./format";
import { declineClassRows, groupWhatChanged } from "./model";
import {
  ComparisonCell,
  ComparisonKpiCard,
  DisputesPlaceholderCard,
  EmptyNote,
  MetaNotes,
  PairCell,
  QueryFrame,
  SectionCard,
  Sparkline,
  type PaymentHealthTabProps,
} from "./shared";

const trendConfig = {
  attempts: { label: "Attempts", color: "hsl(217 91% 60%)" },
  declines: { label: "Declines", color: "hsl(var(--chart-4))" },
  approval: { label: "Approval rate", color: "hsl(var(--chart-1))" },
} satisfies ChartConfig;

function OverviewBody({ data, pspVisible }: { data: OverviewResponse; pspVisible: boolean }) {
  const { totals, meta } = data;
  const classRows = useMemo(() => declineClassRows(totals.decline_classes, totals.current.declines), [totals]);
  const changed = useMemo(() => groupWhatChanged(data.what_changed), [data.what_changed]);
  const trend = useMemo(
    () => data.trend.map((point) => ({
      bucket: point.bucket,
      attempts: point.attempts,
      declines: point.declines,
      approval: point.approval_rate == null ? null : Number((point.approval_rate * 100).toFixed(1)),
      incomplete: point.incomplete,
    })),
    [data.trend],
  );
  const complaints = totals.complaints_unauthorized;
  const showPspTable = pspVisible && meta.psp_global_visible;

  return (
    <>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <KpiCard
          label="Attempts"
          value={fmtNum(totals.current.attempts)}
          delta={`${fmtCountDelta(totals.current.attempts - totals.baseline.attempts)} vs ${fmtNum(totals.baseline.attempts)} before`}
          hint={`${fmtNum(totals.current.successes)} settled · ${fmtNum(totals.current.declines)} declined`}
          icon={<CreditCard className="h-4 w-4" />}
        />
        <ComparisonKpiCard label="Approval rate" comparison={totals.approval} higherIsBetter hint="settled over attempts" />
        <ComparisonKpiCard
          label="Issuer-suspected-fraud declines"
          comparison={totals.issuer_fraud_share}
          higherIsBetter={false}
          hint="issuer suspicion codes over attempts — declines, not fraud"
        />
        <ComparisonKpiCard label="Refund rate" comparison={totals.refund_rate} higherIsBetter={false} hint="refunded over settled, by original payment date" />
        <ComparisonKpiCard
          label="Unauthorized-charge complaints"
          comparison={totals.support_unauthorized_rate}
          higherIsBetter={false}
          digits={2}
          hint={`${fmtNum(complaints.current)} requests (${fmtNum(complaints.unattributed_current)} unattributed) · ${fmtNum(complaints.baseline)} before`}
        />
        <KpiCard
          label="Settled amount"
          value={fmtUsd(totals.current.settled_amount_usd)}
          delta={`${fmtUsd(totals.baseline.settled_amount_usd)} before`}
          hint={`refunded ${fmtUsd(totals.current.refund_amount_usd)}`}
          accent="success"
          icon={<DollarSign className="h-4 w-4" />}
        />
      </div>

      <SectionCard
        title="Attempts and approval over time"
        description={`${meta.trend_granularity === "week" ? "Weekly (Monday) buckets" : "Daily buckets"} over the whole window (a bucket without attempts is zero); a lighter bar is a bucket after data_through (incomplete).`}
        testId="overview-trend"
      >
        {trend.length === 0 ? (
          <EmptyNote>No attempts in this window.</EmptyNote>
        ) : (
          <ChartContainer config={trendConfig} className="h-[280px] w-full">
            <ComposedChart data={trend} margin={{ left: 8, right: 16, top: 8, bottom: 8 }}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="bucket" tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} />
              <YAxis yAxisId="count" tickLine={false} axisLine={false} width={48} />
              <YAxis yAxisId="rate" orientation="right" tickLine={false} axisLine={false} width={44} domain={[0, 100]} tickFormatter={(value) => `${value}%`} />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Bar yAxisId="count" dataKey="attempts" fill="var(--color-attempts)" radius={[3, 3, 0, 0]}>
                {trend.map((point) => (
                  <Cell key={point.bucket} fillOpacity={point.incomplete ? 0.35 : 1} />
                ))}
              </Bar>
              <Bar yAxisId="count" dataKey="declines" fill="var(--color-declines)" radius={[3, 3, 0, 0]}>
                {trend.map((point) => (
                  <Cell key={point.bucket} fillOpacity={point.incomplete ? 0.35 : 1} />
                ))}
              </Bar>
              <Line yAxisId="rate" type="monotone" dataKey="approval" stroke="var(--color-approval)" strokeWidth={2} dot={false} connectNulls={false} />
            </ComposedChart>
          </ChartContainer>
        )}
      </SectionCard>

      {showPspTable && (
        <SectionCard
          title="PSP × merchant account"
          description="Registry labels only (psp_accounts); an unlabelled MID appeared after the last registry sync. Complaint rate = possible-unauthorized-charge requests attributed to the account over its settled payments of the window regardless of the active filters (support requests are not filterable); the attempt columns are filtered."
          testId="psp-mid-table"
        >
          {data.psp_mid_rows.length === 0 ? (
            <EmptyNote>No attempts by processor in this window.</EmptyNote>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Processor</TableHead>
                    <TableHead>Merchant account</TableHead>
                    <TableHead className="text-right">Attempts</TableHead>
                    <TableHead className="text-right">Approval</TableHead>
                    <TableHead className="text-right">Issuer-suspected-fraud rate</TableHead>
                    <TableHead className="text-right">Refund rate</TableHead>
                    <TableHead className="text-right">Unauthorized complaints</TableHead>
                    <TableHead className="text-right">Trend</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.psp_mid_rows.map((row) => {
                    // Server-computed over the account's UNFILTERED settled payments: the complaints cannot be
                    // filtered (no funnel / country / network on a support request), so dividing them by
                    // row.current.successes — which IS filtered — would inflate the rate under any filter.
                    const complaintRate = row.complaint_rate.current.rate;
                    return (
                      <TableRow key={`${row.processor.key}|${row.merchant_account.key}`}>
                        <TableCell className="font-medium">{row.processor.label}</TableCell>
                        <TableCell>
                          <span className="flex flex-wrap items-center gap-1">
                            {row.merchant_account.label}
                            {!row.merchant_account.labelled && <Badge variant="outline" className="px-1.5 py-0 text-[10px] text-muted-foreground">unlabelled</Badge>}
                          </span>
                        </TableCell>
                        <TableCell className="text-right"><PairCell current={row.current.attempts} baseline={row.baseline.attempts} /></TableCell>
                        <TableCell className="text-right"><ComparisonCell comparison={row.approval} higherIsBetter /></TableCell>
                        <TableCell className="text-right"><ComparisonCell comparison={row.issuer_fraud_share} higherIsBetter={false} /></TableCell>
                        <TableCell className="text-right"><ComparisonCell comparison={row.refund_rate} higherIsBetter={false} /></TableCell>
                        <TableCell className="text-right tabular-nums">
                          <span className="inline-flex flex-col items-end">
                            <span className="font-medium">{fmtPct(complaintRate, 2)}</span>
                            <span className="text-[10px] text-muted-foreground">{fmtNum(row.complaints_unauthorized.current)} · prev {fmtNum(row.complaints_unauthorized.baseline)}</span>
                          </span>
                        </TableCell>
                        <TableCell className="text-right"><Sparkline points={row.trend} /></TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </SectionCard>
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <SectionCard title="Decline classes (current period)" description="Mutually exclusive classes from the issuer code, the Primer code and the lifecycle event (declineTaxonomy)." testId="decline-class-mix">
          {classRows.length === 0 ? (
            <EmptyNote>No declines in this window.</EmptyNote>
          ) : (
            <ul className="space-y-2">
              {classRows.map((row) => (
                <li key={row.key} className="space-y-1">
                  <div className="flex items-center justify-between gap-2 text-sm">
                    <span className="truncate">{row.label}</span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">{fmtNum(row.count)} · {fmtShare(row.share)}</span>
                  </div>
                  <div className="h-1.5 w-full rounded-full bg-muted">
                    <div className="h-1.5 rounded-full bg-primary" style={{ width: `${Math.round((row.share ?? 0) * 100)}%` }} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
        <DisputesPlaceholderCard />
      </div>

      <SectionCard
        title="What changed"
        description="Δ declines = Δ volume × previous rate + current volume × Δ rate: whether a dimension's declines grew because it processed more or because it declined more often. Top movers per dimension."
        testId="what-changed"
      >
        {changed.length === 0 ? (
          <EmptyNote>No change to decompose (one of the periods has no attempts).</EmptyNote>
        ) : (
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            {changed.map((group) => (
              <div key={group.dimension} className="overflow-x-auto">
                <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{DIMENSION_LABELS[group.dimension] ?? group.dimension}</h4>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Value</TableHead>
                      <TableHead className="text-right">Declines</TableHead>
                      <TableHead className="text-right">Decline rate</TableHead>
                      <TableHead className="text-right">Volume effect</TableHead>
                      <TableHead className="text-right">Rate effect</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {group.rows.map((row) => {
                      const d = row.decomposition;
                      return (
                        <TableRow key={row.value.key}>
                          <TableCell className="font-medium">{row.value.label}</TableCell>
                          <TableCell className="text-right tabular-nums">
                            {fmtNum(d.count_before)} → {fmtNum(d.count_after)} <span className="text-muted-foreground">({fmtCountDelta(d.delta_count)})</span>
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{fmtPct(d.rate_before)} → {fmtPct(d.rate_after)}</TableCell>
                          <TableCell className="text-right tabular-nums">
                            {fmtCountDelta(d.volume_effect)}
                            {d.volume_share != null && <span className="text-muted-foreground"> ({fmtShare(d.volume_share)})</span>}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{fmtCountDelta(d.rate_effect)}</TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            ))}
          </div>
        )}
      </SectionCard>

      <MetaNotes meta={meta} />
    </>
  );
}

export function OverviewTab(props: PaymentHealthTabProps) {
  const result = usePaymentHealthQuery({
    action: "overview",
    query: props.query,
    userScopeHash: props.userScopeHash,
    warehouseVersion: props.warehouseVersion,
    enabled: props.enabled,
  });
  return (
    <QueryFrame result={result} label="the overview" idleNote={props.idleNote}>
      {(data) => <OverviewBody data={data} pspVisible={props.pspVisible} />}
    </QueryFrame>
  );
}
