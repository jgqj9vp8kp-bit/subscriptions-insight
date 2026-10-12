// Data Sources tab (plan N: observed freshness only): what the warehouse holds
// (bounds, last sync, rows synced before the P0 backfill), the coverage of every
// P0 column, the last import and the sync state reduced to lifecycle fields,
// support requests by month with classification breaks, and the metric
// dictionary saying what is and is not measured in this phase.

import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { usePaymentHealthQuery } from "@/hooks/usePaymentHealth";
import { EMPTY_PAYMENT_HEALTH_QUERY, type SourcesResponse } from "@/services/paymentHealthDataSource";
import { fmtDateTime, fmtDay, fmtMonth, fmtNum, fmtShare } from "./format";
import { EmptyNote, MetaNotes, QueryFrame, SectionCard, type PaymentHealthTabProps } from "./shared";

function Fact({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md border border-border bg-muted/30 px-3 py-2">
      <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-sm font-semibold tabular-nums text-foreground">{value}</p>
      {hint && <p className="text-[10px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

function SourcesBody({ data }: { data: SourcesResponse }) {
  const { warehouse, meta } = data;
  return (
    <>
      <SectionCard title="Warehouse (analytics_transactions)" description="Tenant-wide figures; the window filter does not apply here." testId="sources-warehouse">
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          <Fact label="Attempt rows" value={fmtNum(warehouse.attempt_rows)} hint={`${fmtNum(warehouse.rows_without_raw_status)} synced before the P0 backfill (no raw_status)`} />
          <Fact label="First / last attempt day" value={`${fmtDay(warehouse.first_day)} → ${fmtDay(warehouse.last_day)}`} />
          <Fact label="Data through" value={fmtDay(meta.data_through)} hint={meta.lag_days == null ? "no data" : `${fmtNum(meta.lag_days)} day(s) behind today${meta.incomplete ? " · the chosen window is incomplete" : ""}`} />
          <Fact label="Last ClickHouse sync" value={fmtDateTime(warehouse.last_synced_at)} />
        </div>
      </SectionCard>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <SectionCard title="Column coverage" description="Rows with a value over attempt rows (decline-record columns over declines, refund_observed_at over refunded payments)." testId="sources-coverage">
          {data.coverage.length === 0 ? (
            <EmptyNote>No attempt rows yet.</EmptyNote>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Column</TableHead>
                    <TableHead className="text-right">Filled</TableHead>
                    <TableHead className="text-right">Rows</TableHead>
                    <TableHead className="w-[160px]">Share</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.coverage.map((row) => (
                    <TableRow key={row.column}>
                      <TableCell className="font-mono text-xs">{row.column}</TableCell>
                      <TableCell className="text-right text-xs tabular-nums">{fmtNum(row.filled)}</TableCell>
                      <TableCell className="text-right text-xs tabular-nums">{fmtNum(row.rows)}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 w-full rounded-full bg-muted">
                            <div className="h-1.5 rounded-full bg-primary" style={{ width: `${Math.round((row.share ?? 0) * 100)}%` }} />
                          </div>
                          <span className="w-14 text-right text-xs tabular-nums text-muted-foreground">{fmtShare(row.share)}</span>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </SectionCard>

        <div className="space-y-4">
          <SectionCard title="Last import" description="The newest import batch of the workspace (counts and status, not the file)." testId="sources-last-import">
            {data.last_import ? (
              <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
                <Fact label="Imported at" value={fmtDateTime(data.last_import.imported_at)} />
                <Fact label="Status" value={data.last_import.status ?? "—"} hint={data.last_import.source ?? undefined} />
                <Fact label="Rows" value={fmtNum(data.last_import.rows_total)} hint={`${fmtNum(data.last_import.rows_inserted)} inserted · ${fmtNum(data.last_import.rows_updated)} updated`} />
              </div>
            ) : (
              <EmptyNote>No import recorded.</EmptyNote>
            )}
          </SectionCard>

          <SectionCard title="ClickHouse sync state" description="Lifecycle fields only." testId="sources-sync-state">
            {data.sync_state ? (
              <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
                <Fact label="Status" value={data.sync_state.status ?? "—"} />
                <Fact label="Last run" value={fmtDateTime(data.sync_state.last_run_at)} />
                <Fact label="Updated" value={fmtDateTime(data.sync_state.updated_at)} />
              </div>
            ) : (
              <EmptyNote>No sync state recorded.</EmptyNote>
            )}
          </SectionCard>

          <SectionCard title="Support requests by month" description="Classification versions seen per month; a change against the previous month is a trend break." testId="sources-support">
            {data.support.by_month.length === 0 ? (
              <EmptyNote>No support requests synced.</EmptyNote>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Month</TableHead>
                      <TableHead className="text-right">Requests</TableHead>
                      <TableHead>Classifier</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.support.by_month.map((row) => (
                      <TableRow key={row.month}>
                        <TableCell className="font-mono text-xs">{fmtMonth(row.month)}</TableCell>
                        <TableCell className="text-right text-xs tabular-nums">{fmtNum(row.requests)}</TableCell>
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
      </div>

      <SectionCard title="Metric dictionary" description="What this page measures and what it does not yet (plan section G). A metric whose source is not connected is listed, not shown as zero." testId="sources-metrics">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Metric</TableHead>
                <TableHead>Phase</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Notes</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.metrics.map((metric) => (
                <TableRow key={metric.key} className={metric.available ? undefined : "text-muted-foreground"}>
                  <TableCell>
                    <span className="block text-sm font-medium">{metric.title}</span>
                    <span className="font-mono text-[10px] text-muted-foreground">{metric.key}</span>
                  </TableCell>
                  <TableCell className="text-xs">{metric.phase}</TableCell>
                  <TableCell>
                    <span className="flex flex-wrap gap-1">
                      {metric.available ? <Badge variant="outline" className="px-1.5 py-0 text-[10px] text-success">measured</Badge> : <Badge variant="outline" className="px-1.5 py-0 text-[10px] text-muted-foreground">not connected</Badge>}
                      {metric.heuristic && <Badge variant="outline" className="border-warning/50 px-1.5 py-0 text-[10px] text-warning">heuristic</Badge>}
                      {metric.estimate && <Badge variant="outline" className="border-warning/50 px-1.5 py-0 text-[10px] text-warning">estimate</Badge>}
                    </span>
                  </TableCell>
                  <TableCell className="max-w-[520px] text-xs">{metric.notes}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </SectionCard>

      <MetaNotes meta={meta} />
    </>
  );
}

export function SourcesTab(props: Pick<PaymentHealthTabProps, "userScopeHash" | "warehouseVersion" | "enabled">) {
  // Tenant-wide: the window and the filters do not apply, so the key is stable
  // across filter changes and the tab never refetches on them.
  const result = usePaymentHealthQuery({
    action: "sources",
    query: EMPTY_PAYMENT_HEALTH_QUERY,
    userScopeHash: props.userScopeHash,
    warehouseVersion: props.warehouseVersion,
    enabled: props.enabled,
  });
  return (
    <QueryFrame result={result} label="data sources">
      {(data) => <SourcesBody data={data} />}
    </QueryFrame>
  );
}
