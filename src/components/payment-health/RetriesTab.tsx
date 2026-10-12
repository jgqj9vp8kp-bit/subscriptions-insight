// Retries & Network Rules tab (plan J, retry compliance): attempt chains (a
// labelled heuristic), post-ban re-attempts (CIT / MIT, same / switched
// processor), the rolling-30-day > 15 flags and the recovery / cascade rates.
// Every rule here comes from secondary sources: the tab says "rules
// unverified" and talks about potential violations, never fines.

import { useMemo, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { KpiCard } from "@/components/KpiCard";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { usePaymentHealthQuery } from "@/hooks/usePaymentHealth";
import type { RetriesResponse } from "@/services/paymentHealthDataSource";
import { DECLINE_CLASS_LABELS, type BanSource } from "../../../supabase/functions/_shared/clickhouse/declineTaxonomy";
import { fmtDateTime, fmtNum, shortHash } from "./format";
import { EmptyNote, HeuristicBadge, MetaNotes, QueryFrame, RateKpiCard, SectionCard, ShowAllToggle, type PaymentHealthTabProps } from "./shared";

const BAN_SOURCE_LABELS: Record<BanSource, string> = {
  advised_action: "advised action",
  visa_category_1: "Visa category 1",
  mc_mac_03_21: "MC MAC 03 / 21",
};

const POST_BAN_PREVIEW = 25;
const ROLLING_PREVIEW = 25;

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md border border-border bg-muted/30 px-3 py-2">
      <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-base font-semibold tabular-nums text-foreground">{value}</p>
      {hint && <p className="text-[10px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

function RetriesBody({ data, pspVisible }: { data: RetriesResponse; pspVisible: boolean }) {
  const [allPostBan, setAllPostBan] = useState(false);
  const [allRolling, setAllRolling] = useState(false);
  const { chains, post_ban: postBan, rolling, meta } = data;
  const postBanRows = useMemo(() => (allPostBan ? data.post_ban_attempts : data.post_ban_attempts.slice(0, POST_BAN_PREVIEW)), [allPostBan, data.post_ban_attempts]);
  const rollingRows = useMemo(() => (allRolling ? rolling.windows : rolling.windows.slice(0, ROLLING_PREVIEW)), [allRolling, rolling.windows]);
  const showAccounts = pspVisible && meta.psp_global_visible;
  const rowCapHit = meta.limited?.attempt_rows === true;
  const options = meta.chain_options;

  return (
    <>
      <div className="flex flex-wrap items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning" role="note" data-testid="rules-unverified">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          <span className="font-semibold">Rules unverified.</span> Network re-attempt rules come from secondary sources; the flags below are potential violations,
          not fines. Attempt chains are a heuristic: Primer gives every retry a new orderId, so chains link attempts by user, instrument (or currency + amount),
          price point and initiation within CIT {options.cit_window_minutes} min / MIT {options.mit_window_hours} h windows.
        </span>
      </div>

      {rowCapHit && (
        <p className="text-xs text-warning" role="status">
          Row cap hit: the report read {fmtNum(meta.rows_read)} attempt rows of {meta.rows_window.from} – {meta.rows_window.to} (window plus lookback) and stopped; the figures below are partial. Narrow the window or the filters.
        </p>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <KpiCard label="Chains started" value={fmtNum(chains.chains)} hint={`${fmtNum(chains.attempts)} attempts · ${fmtNum(chains.chains_singleton)} unlinked`} />
        <RateKpiCard label="First-try approval" estimate={chains.chain_first_try_approval_rate} badge={<HeuristicBadge />} hint="chains whose first attempt settled" />
        <RateKpiCard label="Final success" estimate={chains.final_success_rate} badge={<HeuristicBadge />} hint="chains that ended settled" />
        <RateKpiCard label="Retry recovery" estimate={chains.retry_recovery_rate} badge={<HeuristicBadge />} hint="declined chains later settled (post-ban successes excluded)" />
        <RateKpiCard label="Cascade recovery" estimate={chains.cascade_recovery} badge={<HeuristicBadge />} hint="chains with a cascade row that settled" />
        <RateKpiCard label="Attempt approval" estimate={chains.attempt_approval_rate} hint="settled over attempts in the chains" />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <SectionCard title="Chain counts" description={`Chains that started in the window; rows read ${meta.rows_window.from} – ${meta.rows_window.to} (${meta.rows_window.days} d, with the ${options.rolling_window_days}-day lookback).`} testId="chain-counts">
          <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
            <Stat label="Rows read" value={fmtNum(chains.rows)} hint={`${fmtNum(chains.not_attempts)} not attempts`} />
            <Stat label="Chains" value={fmtNum(chains.chains)} />
            <Stat label="With a decline" value={fmtNum(chains.chains_with_decline)} />
            <Stat label="Recovered" value={fmtNum(chains.chains_recovered)} hint="declined, later settled" />
            <Stat label="Settled after a ban" value={fmtNum(chains.chains_post_ban_success)} hint="never counted as recovery" />
            <Stat label="Cascades" value={fmtNum(chains.chains_cascade)} hint={`${fmtNum(chains.chains_cascade_recovered)} recovered · ${fmtNum(data.cascade_rows)} cascade rows`} />
          </div>
        </SectionCard>

        <SectionCard title="Post-ban re-attempts" description="Attempts on an instrument after a ban (advised action DO_NOT_RETRY / STOP_ALL_PAYMENTS, Visa category 1, Mastercard MAC 03 / 21) inside the window." testId="post-ban-summary">
          <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
            <Stat label="Banned instruments" value={fmtNum(postBan.banned_instruments)} hint={`${fmtNum(postBan.retried_instruments)} re-attempted`} />
            <Stat label="Re-attempts" value={fmtNum(postBan.attempts)} hint={`${fmtNum(postBan.within_window)} in the window`} />
            <Stat label="Within one hour" value={fmtNum(postBan.within_one_hour)} />
            <Stat label="CIT / MIT" value={`${fmtNum(postBan.cit)} / ${fmtNum(postBan.mit)}`} hint={`${fmtNum(postBan.unknown_initiation)} unknown`} />
            <Stat label="Same / switched PSP" value={`${fmtNum(postBan.same_processor)} / ${fmtNum(postBan.switched_processor)}`} hint={`${fmtNum(postBan.unknown_processor)} unknown`} />
            <Stat label="Succeeded" value={fmtNum(postBan.succeeded)} hint={`${fmtNum(postBan.succeeded_switched_processor)} after switching PSP`} />
          </div>
        </SectionCard>
      </div>

      <SectionCard title="Post-ban attempts" description={`Newest ${fmtNum(data.post_ban_attempts.length)} of ${fmtNum(postBan.attempts)} rows (the server returns at most 200; a 'cap hit: post_ban_attempts' badge below says when more were dropped); the instrument is an opaque hash, never a token or card fragment.`} testId="post-ban-attempts">
        {data.post_ban_attempts.length === 0 ? (
          <EmptyNote>No re-attempt after a ban in this window.</EmptyNote>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Instrument</TableHead>
                  <TableHead>Banned at</TableHead>
                  <TableHead>Ban source</TableHead>
                  <TableHead>Attempt at</TableHead>
                  <TableHead className="text-right">Min after ban</TableHead>
                  <TableHead>Initiation</TableHead>
                  <TableHead>Processor</TableHead>
                  {showAccounts && <TableHead>Account</TableHead>}
                  <TableHead>Result</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {postBanRows.map((row, index) => (
                  <TableRow key={`${row.instrument}|${row.event_time}|${index}`}>
                    <TableCell className="font-mono text-xs" title={row.instrument}>{shortHash(row.instrument)}</TableCell>
                    <TableCell className="text-xs tabular-nums">
                      {fmtDateTime(row.ban_event_time)}
                      {row.ban_decline_class && <span className="block text-[10px] text-muted-foreground">{DECLINE_CLASS_LABELS[row.ban_decline_class] ?? row.ban_decline_class}</span>}
                    </TableCell>
                    <TableCell className="text-xs">{row.ban_sources.map((source) => BAN_SOURCE_LABELS[source] ?? source).join(", ") || "—"}</TableCell>
                    <TableCell className="text-xs tabular-nums">{fmtDateTime(row.event_time)}</TableCell>
                    <TableCell className="text-right text-xs tabular-nums">{fmtNum(row.minutes_since_ban)}</TableCell>
                    <TableCell className="text-xs uppercase">{row.initiation_type}</TableCell>
                    <TableCell className="text-xs">
                      {row.processor_relation === "unknown" ? "unknown" : row.processor_relation}
                      {showAccounts && row.processor && <span className="block text-[10px] text-muted-foreground">{row.processor.label}</span>}
                    </TableCell>
                    {showAccounts && <TableCell className="text-xs">{row.merchant_account?.label ?? "—"}</TableCell>}
                    <TableCell>
                      <span className="flex flex-wrap gap-1">
                        {row.succeeded ? <Badge variant="outline" className="px-1.5 py-0 text-[10px] text-success">settled</Badge> : <Badge variant="outline" className="px-1.5 py-0 text-[10px] text-muted-foreground">declined</Badge>}
                        {row.banned_again && <Badge variant="destructive" className="px-1.5 py-0 text-[10px]">banned again</Badge>}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <ShowAllToggle total={data.post_ban_attempts.length} shown={POST_BAN_PREVIEW} expanded={allPostBan} onToggle={() => setAllPostBan((value) => !value)} />
          </div>
        )}
      </SectionCard>

      <SectionCard
        title={`Rolling ${options.rolling_window_days}-day re-attempt limit`}
        description={`Instrument × merchant account pairs with more than ${options.rolling_decline_limit} decline records in any rolling ${options.rolling_window_days}-day window ending in the period (Visa categories 2–4 limit; unverified). "Over the limit" counts every pair; the table lists at most 100 (a 'cap hit: rolling_windows' badge below says when more were dropped).`}
        testId="rolling-windows"
      >
        <div className="mb-3 grid grid-cols-2 gap-2 md:max-w-sm">
          <Stat label="Pairs checked" value={fmtNum(rolling.pairs)} />
          <Stat label="Over the limit" value={fmtNum(rolling.violations)} hint="potential violations" />
        </div>
        {rolling.windows.length === 0 ? (
          <EmptyNote>No pair over the limit in this window.</EmptyNote>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Instrument</TableHead>
                  {showAccounts && <TableHead>Account</TableHead>}
                  <TableHead className="text-right">Max declines / limit</TableHead>
                  <TableHead>Window</TableHead>
                  <TableHead className="text-right">Decline records</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rollingRows.map((row, index) => (
                  <TableRow key={`${row.instrument}|${row.window_start}|${index}`}>
                    <TableCell className="font-mono text-xs" title={row.instrument}>{shortHash(row.instrument)}</TableCell>
                    {showAccounts && <TableCell className="text-xs">{row.merchant_account?.label ?? "—"}</TableCell>}
                    <TableCell className="text-right text-xs tabular-nums">
                      <span className="font-semibold text-destructive">{fmtNum(row.max_declines)}</span> / {fmtNum(row.limit)}
                    </TableCell>
                    <TableCell className="text-xs tabular-nums">{fmtDateTime(row.window_start)} → {fmtDateTime(row.window_end)}</TableCell>
                    <TableCell className="text-right text-xs tabular-nums">{fmtNum(row.decline_records_total)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <ShowAllToggle total={rolling.windows.length} shown={ROLLING_PREVIEW} expanded={allRolling} onToggle={() => setAllRolling((value) => !value)} />
          </div>
        )}
      </SectionCard>

      <MetaNotes meta={meta} />
    </>
  );
}

export function RetriesTab(props: PaymentHealthTabProps) {
  const result = usePaymentHealthQuery({
    action: "retries",
    query: props.query,
    userScopeHash: props.userScopeHash,
    warehouseVersion: props.warehouseVersion,
    enabled: props.enabled,
  });
  return (
    <QueryFrame result={result} label="retries and network rules" idleNote={props.idleNote}>
      {(data) => <RetriesBody data={data} pspVisible={props.pspVisible} />}
    </QueryFrame>
  );
}
