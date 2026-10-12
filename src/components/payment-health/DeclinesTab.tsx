// Approvals & Declines tab (plan J): approval by a chosen dimension, the
// decline-class mix with class rates over attempts, the issuer / Primer /
// advice code mix with soft / hard severity and the retry guidance each code
// carries. Declines are classified, never called fraud: the issuer's suspicion
// code is "issuer suspected fraud (decline, not fraud)".

import { useMemo, useState } from "react";
import { KpiCard } from "@/components/KpiCard";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { usePaymentHealthQuery } from "@/hooks/usePaymentHealth";
import type { DeclinesResponse } from "@/services/paymentHealthDataSource";
import { DECLINE_CLASS_LABELS, type DeclineSeverity, type RetryGuidance } from "../../../supabase/functions/_shared/clickhouse/declineTaxonomy";
import { DIMENSION_LABELS } from "../../../supabase/functions/_shared/clickhouse/paymentHealthContract";
import { fmtCountDelta, fmtNum, fmtShare } from "./format";
import { topDeclineClass } from "./model";
import { ComparisonCell, ComparisonKpiCard, EmptyNote, MetaNotes, PairCell, QueryFrame, SectionCard, ShowAllToggle, type PaymentHealthTabProps } from "./shared";
import { DimensionSelect, type DimensionSelectProps } from "./DimensionSelect";

const SEVERITY_LABELS: Record<DeclineSeverity, string> = { soft: "Soft", hard: "Hard", unknown: "Unknown" };
const SEVERITY_CLASS: Record<DeclineSeverity, string> = {
  soft: "bg-warning/15 text-warning",
  hard: "bg-destructive/10 text-destructive",
  unknown: "bg-muted text-muted-foreground",
};
const GUIDANCE_LABELS: Record<RetryGuidance, string> = {
  retry_later: "retry later",
  update_data: "update data first",
  do_not_retry: "do not retry",
  stop_all_payments: "stop all payments",
  unknown: "unknown",
};

const CODE_MIX_PREVIEW = 25;

function SeverityBadge({ severity }: { severity: DeclineSeverity }) {
  return <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ${SEVERITY_CLASS[severity]}`}>{SEVERITY_LABELS[severity]}</span>;
}

function DeclinesBody({ data, dimensionSelect }: { data: DeclinesResponse; dimensionSelect: DimensionSelectProps }) {
  const [allCodes, setAllCodes] = useState(false);
  const { totals, meta } = data;
  const dimensionLabel = DIMENSION_LABELS[data.dimension] ?? data.dimension;
  const codeRows = useMemo(() => (allCodes ? data.code_mix : data.code_mix.slice(0, CODE_MIX_PREVIEW)), [allCodes, data.code_mix]);
  const severity = data.severity;

  return (
    <>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <KpiCard label="Attempts" value={fmtNum(totals.current.attempts)} delta={`${fmtNum(totals.baseline.attempts)} before`} />
        <KpiCard
          label="Declines"
          value={fmtNum(totals.current.declines)}
          delta={`${fmtCountDelta(totals.current.declines - totals.baseline.declines)} vs ${fmtNum(totals.baseline.declines)} before`}
          accent="warning"
        />
        <ComparisonKpiCard label="Approval rate" comparison={totals.approval} higherIsBetter />
        <ComparisonKpiCard label="Issuer-suspected-fraud share" comparison={totals.issuer_fraud_share} higherIsBetter={false} hint="issuer suspicion codes over attempts — declines, not fraud" />
        <KpiCard
          label="Soft / hard declines"
          value={`${fmtNum(severity.current.soft)} / ${fmtNum(severity.current.hard)}`}
          delta={`${fmtNum(severity.baseline.soft)} / ${fmtNum(severity.baseline.hard)} before`}
          hint={`${fmtNum(severity.current.unknown)} with unknown severity`}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <SectionCard title="Decline classes" description="Share of the current period's declines; the rate is the class over attempts, current vs previous period." testId="decline-classes">
          {data.by_class.length === 0 ? (
            <EmptyNote>No declines in this window.</EmptyNote>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Class</TableHead>
                    <TableHead className="text-right">Declines</TableHead>
                    <TableHead className="text-right">Share</TableHead>
                    <TableHead className="text-right">Rate over attempts</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.by_class.map((row) => (
                    <TableRow key={row.decline_class}>
                      <TableCell className="font-medium">{row.label}</TableCell>
                      <TableCell className="text-right"><PairCell current={row.current} baseline={row.baseline} /></TableCell>
                      <TableCell className="text-right tabular-nums">{fmtShare(row.share_of_declines)}</TableCell>
                      <TableCell className="text-right"><ComparisonCell comparison={row.rate} higherIsBetter={false} digits={2} /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </SectionCard>

        <SectionCard
          title={`Approval by ${dimensionLabel.toLowerCase()}`}
          description="Sorted by current attempts. The funnel is the user's acquisition anchor; the country is the issuer (BIN) country."
          actions={<DimensionSelect {...dimensionSelect} />}
          testId="declines-by-dimension"
        >
          {data.by_dimension.length === 0 ? (
            <EmptyNote>No attempts in this window.</EmptyNote>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{dimensionLabel}</TableHead>
                    <TableHead className="text-right">Attempts</TableHead>
                    <TableHead className="text-right">Approval</TableHead>
                    <TableHead className="text-right">Issuer-suspected-fraud</TableHead>
                    <TableHead>Top decline class</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.by_dimension.map((row) => {
                    const top = topDeclineClass(row);
                    return (
                      <TableRow key={row.value.key}>
                        <TableCell className="font-medium">{row.value.label}</TableCell>
                        <TableCell className="text-right"><PairCell current={row.current.attempts} baseline={row.baseline.attempts} /></TableCell>
                        <TableCell className="text-right"><ComparisonCell comparison={row.approval} higherIsBetter /></TableCell>
                        <TableCell className="text-right"><ComparisonCell comparison={row.issuer_fraud_share} higherIsBetter={false} compact /></TableCell>
                        <TableCell className="text-xs text-muted-foreground">{top ? `${top.label} (${fmtNum(top.count)})` : "—"}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </SectionCard>
      </div>

      <SectionCard
        title="Issuer code / Primer code / advice mix"
        description="The codes behind the classes, with the network re-attempt guidance each one carries (secondary sources, unverified). A ban row (DO_NOT_RETRY, STOP_ALL_PAYMENTS, Visa category 1, Mastercard MAC 03 / 21) forbids re-attempts on the instrument. The server returns at most 100 code rows by count; a 'cap hit: code_mix' badge below says when more were dropped."
        testId="code-mix"
      >
        {data.code_mix.length === 0 ? (
          <EmptyNote>No declines in this window.</EmptyNote>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Class</TableHead>
                  <TableHead>Issuer code</TableHead>
                  <TableHead>Primer code</TableHead>
                  <TableHead>Advised action</TableHead>
                  <TableHead>Advice code</TableHead>
                  <TableHead>Severity</TableHead>
                  <TableHead>Retry guidance</TableHead>
                  <TableHead className="text-right">Declines</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {codeRows.map((row, index) => (
                  <TableRow key={`${row.decline_class}|${row.issuer_result_code ?? ""}|${row.primer_decline_code ?? ""}|${row.advised_action ?? ""}|${row.advice_code ?? ""}|${index}`}>
                    <TableCell className="text-xs">{DECLINE_CLASS_LABELS[row.decline_class] ?? row.decline_class}</TableCell>
                    <TableCell className="font-mono text-xs">{row.issuer_result_code ?? "—"}</TableCell>
                    <TableCell className="font-mono text-xs">{row.primer_decline_code ?? "—"}</TableCell>
                    <TableCell className="font-mono text-xs">{row.advised_action ?? "—"}</TableCell>
                    <TableCell className="font-mono text-xs">{row.advice_code ?? "—"}</TableCell>
                    <TableCell><SeverityBadge severity={row.severity} /></TableCell>
                    <TableCell className="text-xs">
                      <span className="flex flex-wrap items-center gap-1">
                        {GUIDANCE_LABELS[row.retry_guidance] ?? row.retry_guidance}
                        {row.retry_ban && <Badge variant="destructive" className="px-1.5 py-0 text-[10px]">ban</Badge>}
                      </span>
                    </TableCell>
                    <TableCell className="text-right"><PairCell current={row.current} baseline={row.baseline} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <ShowAllToggle total={data.code_mix.length} shown={CODE_MIX_PREVIEW} expanded={allCodes} onToggle={() => setAllCodes((value) => !value)} />
          </div>
        )}
      </SectionCard>

      <MetaNotes meta={meta} />
    </>
  );
}

export function DeclinesTab(props: PaymentHealthTabProps & { dimensionSelect: DimensionSelectProps }) {
  const result = usePaymentHealthQuery({
    action: "declines",
    query: props.query,
    userScopeHash: props.userScopeHash,
    warehouseVersion: props.warehouseVersion,
    enabled: props.enabled,
  });
  return (
    <QueryFrame result={result} label="approvals and declines" idleNote={props.idleNote}>
      {(data) => <DeclinesBody data={data} dimensionSelect={props.dimensionSelect} />}
    </QueryFrame>
  );
}
