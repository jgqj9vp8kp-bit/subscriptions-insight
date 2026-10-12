// Refunds & Complaints tab (plan M): refunds by original payment date (rate,
// timing buckets from refund_observed_at, by month, by dimension) and the
// support complaints flagged possible_unauthorized_charge / requires_refund /
// duplicate_charge, attributed to the last settled payment of the matched user
// within N days (else "unattributed"). A classification-version change in a
// month is a trend break and is marked as such. Disputes are a later source.

import { KpiCard } from "@/components/KpiCard";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { usePaymentHealthQuery } from "@/hooks/usePaymentHealth";
import type { RefundsSupportResponse } from "@/services/paymentHealthDataSource";
import { DIMENSION_LABELS } from "../../../supabase/functions/_shared/clickhouse/paymentHealthContract";
import { fmtCountDelta, fmtMonth, fmtNum, fmtUsd } from "./format";
import {
  ComparisonCell,
  ComparisonKpiCard,
  DisputesPlaceholderCard,
  EmptyNote,
  MetaNotes,
  PairCell,
  QueryFrame,
  RateCell,
  SectionCard,
  type PaymentHealthTabProps,
} from "./shared";
import { DimensionSelect, type DimensionSelectProps } from "./DimensionSelect";

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md border border-border bg-muted/30 px-3 py-2">
      <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-base font-semibold tabular-nums text-foreground">{value}</p>
      {hint && <p className="text-[10px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

function RefundsBody({ data, dimensionSelect, pspVisible }: { data: RefundsSupportResponse; dimensionSelect: DimensionSelectProps; pspVisible: boolean }) {
  const { refunds, complaints, meta } = data;
  const totals = refunds.totals;
  const timing = refunds.timing;
  const dimensionLabel = DIMENSION_LABELS[data.dimension] ?? data.dimension;
  const showAccounts = pspVisible && meta.psp_global_visible;

  return (
    <>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <KpiCard label="Settled payments" value={fmtNum(totals.current.successes)} delta={`${fmtNum(totals.baseline.successes)} before`} hint={fmtUsd(totals.current.settled_amount_usd)} />
        <KpiCard
          label="Refunded"
          value={fmtNum(totals.current.refunded)}
          delta={`${fmtCountDelta(totals.current.refunded - totals.baseline.refunded)} vs ${fmtNum(totals.baseline.refunded)} before`}
          hint={`${fmtUsd(totals.current.refund_amount_usd)} refunded`}
          accent="warning"
        />
        <ComparisonKpiCard label="Refund rate" comparison={totals.refund_rate} higherIsBetter={false} hint="refunded over settled, by original payment date" />
        <ComparisonKpiCard
          label="Unauthorized-charge complaints"
          comparison={complaints.support_unauthorized_rate}
          higherIsBetter={false}
          digits={2}
          hint={`${fmtNum(complaints.current.possible_unauthorized_charge)} flagged requests over the window's settled payments (unfiltered: support requests carry no funnel / country / network)`}
        />
        <KpiCard
          label="Complaints (support)"
          value={fmtNum(complaints.current.total)}
          delta={`${fmtNum(complaints.baseline.total)} before`}
          hint={`${fmtNum(complaints.current.unattributed)} unattributed (no settled payment within ${complaints.attribution_days} days)`}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <SectionCard title="Refund timing" description="Days from the original payment to the import that first saw the refund (refund_observed_at); approximate until a settlement report or webhook." testId="refund-timing">
          <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
            <Stat label="Observed" value={fmtNum(timing.observed)} hint={`${fmtNum(timing.unobserved)} without a date (synced before P0)`} />
            <Stat label="≤ 7 days" value={fmtNum(timing.within_7_days)} />
            <Stat label="≤ 30 days" value={fmtNum(timing.within_30_days)} />
            <Stat label="≤ 90 days" value={fmtNum(timing.within_90_days)} />
            <Stat label="> 90 days" value={fmtNum(timing.beyond_90_days)} />
          </div>
        </SectionCard>

        <SectionCard title="Refunds by payment month" description="Current window, by the month of the original payment." testId="refunds-by-month">
          {refunds.by_month.length === 0 ? (
            <EmptyNote>No settled payments in this window.</EmptyNote>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Month</TableHead>
                    <TableHead className="text-right">Settled</TableHead>
                    <TableHead className="text-right">Refunded</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead className="text-right">Refund rate</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {refunds.by_month.map((row) => (
                    <TableRow key={row.month}>
                      <TableCell className="font-mono text-xs">{fmtMonth(row.month)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtNum(row.settled)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtNum(row.refunded)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtUsd(row.refund_amount_usd)}</TableCell>
                      <TableCell className="text-right"><RateCell estimate={row.refund_rate} /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </SectionCard>
      </div>

      <SectionCard title={`Refunds by ${dimensionLabel.toLowerCase()}`} description="Refunded over settled per value, current vs previous period." actions={<DimensionSelect {...dimensionSelect} />} testId="refunds-by-dimension">
        {refunds.by_dimension.length === 0 ? (
          <EmptyNote>No settled payments in this window.</EmptyNote>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{dimensionLabel}</TableHead>
                  <TableHead className="text-right">Settled</TableHead>
                  <TableHead className="text-right">Refunded</TableHead>
                  <TableHead className="text-right">Refund amount</TableHead>
                  <TableHead className="text-right">Refund rate</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {refunds.by_dimension.map((row) => (
                  <TableRow key={row.value.key}>
                    <TableCell className="font-medium">{row.value.label}</TableCell>
                    <TableCell className="text-right"><PairCell current={row.current.successes} baseline={row.baseline.successes} /></TableCell>
                    <TableCell className="text-right"><PairCell current={row.current.refunded} baseline={row.baseline.refunded} /></TableCell>
                    <TableCell className="text-right tabular-nums">{fmtUsd(row.current.refund_amount_usd)}</TableCell>
                    <TableCell className="text-right"><ComparisonCell comparison={row.refund_rate} higherIsBetter={false} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </SectionCard>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <SectionCard title="Complaints: current vs previous period" description={`Support requests by received date; attribution to the last settled payment of the matched user within ${complaints.attribution_days} days, else unattributed.`} testId="complaints-totals">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Flag</TableHead>
                <TableHead className="text-right">Current</TableHead>
                <TableHead className="text-right">Previous</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {([
                ["All requests", complaints.current.total, complaints.baseline.total],
                ["Possible unauthorized charge", complaints.current.possible_unauthorized_charge, complaints.baseline.possible_unauthorized_charge],
                ["Requires refund", complaints.current.requires_refund, complaints.baseline.requires_refund],
                ["Duplicate charge", complaints.current.duplicate_charge, complaints.baseline.duplicate_charge],
                ["Unattributed to an account", complaints.current.unattributed, complaints.baseline.unattributed],
              ] as Array<[string, number, number]>).map(([label, current, baseline]) => (
                <TableRow key={label}>
                  <TableCell>{label}</TableCell>
                  <TableCell className="text-right tabular-nums font-medium">{fmtNum(current)}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{fmtNum(baseline)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </SectionCard>

        <SectionCard title="Complaints by month" description="Both windows. A month whose classification versions differ from the previous month's is a trend break (the classifier changed), marked below." testId="complaints-by-month">
          {complaints.by_month.length === 0 ? (
            <EmptyNote>No support requests in these windows.</EmptyNote>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Month</TableHead>
                    <TableHead className="text-right">Requests</TableHead>
                    <TableHead className="text-right">Unauthorized</TableHead>
                    <TableHead className="text-right">Refund</TableHead>
                    <TableHead className="text-right">Duplicate</TableHead>
                    <TableHead>Classifier</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {complaints.by_month.map((row) => (
                    <TableRow key={row.month}>
                      <TableCell className="font-mono text-xs">{fmtMonth(row.month)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtNum(row.total)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtNum(row.possible_unauthorized_charge)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtNum(row.requires_refund)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtNum(row.duplicate_charge)}</TableCell>
                      <TableCell className="text-xs">
                        <span className="flex flex-wrap items-center gap-1">
                          <span className="font-mono text-muted-foreground">{row.classification_versions.join(", ") || "—"}</span>
                          {row.version_break && <Badge variant="outline" className="border-warning/50 px-1.5 py-0 text-[10px] text-warning">version break</Badge>}
                        </span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </SectionCard>
      </div>

      {showAccounts && (
        <SectionCard title="Complaints by PSP × merchant account" description="Current window; registry labels only." testId="complaints-by-account">
          {complaints.by_account.length === 0 ? (
            <EmptyNote>No attributed complaint in this window.</EmptyNote>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Processor</TableHead>
                    <TableHead>Merchant account</TableHead>
                    <TableHead className="text-right">Requests</TableHead>
                    <TableHead className="text-right">Unauthorized</TableHead>
                    <TableHead className="text-right">Refund</TableHead>
                    <TableHead className="text-right">Duplicate</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {complaints.by_account.map((row) => (
                    <TableRow key={`${row.processor.key}|${row.merchant_account.key}`}>
                      <TableCell className="font-medium">{row.processor.label}</TableCell>
                      <TableCell>{row.merchant_account.label}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtNum(row.total)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtNum(row.possible_unauthorized_charge)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtNum(row.requires_refund)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtNum(row.duplicate_charge)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </SectionCard>
      )}

      <DisputesPlaceholderCard />
      <MetaNotes meta={meta} />
    </>
  );
}

export function RefundsComplaintsTab(props: PaymentHealthTabProps & { dimensionSelect: DimensionSelectProps }) {
  const result = usePaymentHealthQuery({
    action: "refunds_support",
    query: props.query,
    userScopeHash: props.userScopeHash,
    warehouseVersion: props.warehouseVersion,
    enabled: props.enabled,
  });
  return (
    <QueryFrame result={result} label="refunds and complaints" idleNote={props.idleNote}>
      {(data) => <RefundsBody data={data} dimensionSelect={props.dimensionSelect} pspVisible={props.pspVisible} />}
    </QueryFrame>
  );
}
