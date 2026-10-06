// Admin → Funnel coverage (access Phase 2, spec §5.4): which anchor campaign
// paths of the active cohort snapshot belong to a funnel. A funnel-restricted
// member sees only users anchored to a granted (active or retired) path of
// their funnels, so every path no funnel holds is invisible to all of them.
//
//   * summary: users, registered %, synthetic users, net revenue share and the
//     snapshot the numbers come from (paths.coverage);
//   * alerts: retired paths that still collect users (possible reuse) and
//     funnels whose granted paths hold no user;
//   * the paths table, busiest first, with the registry state of each path.
//
// Writes need funnels.manage (hidden otherwise): attach a path to a funnel,
// confirm / reject a seeded proposal, retire / reactivate / revoke a grant.
// Each is re-checked by the `access` function and the funnel_paths RPCs
// (anti-escalation, transitions, "one funnel per path") and audited there.

import { useMemo, useState } from "react";
import { Filter, Loader2, Lock, RefreshCw, TriangleAlert } from "lucide-react";
import { AppLayout } from "@/components/AppLayout";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { useAccess } from "@/hooks/useAccess";
import { AccessNotSetUpNotice } from "@/components/admin/AdminNotices";
import { AttachPathDialog } from "@/components/admin/AttachPathDialog";
import {
  useAccessAdminErrorToast,
  useAccessAdminMutation,
  useAccessMembers,
  useCoverageFunnels,
  usePathCoverage,
} from "@/components/admin/useAccessAdmin";
import {
  COVERAGE_STATE_LABELS,
  coveragePathActions,
  formatCount,
  formatPct,
  formatUsd,
  funnelOptionLabel,
  listText,
  membersHoldingFunnel,
  pathImpactText,
} from "@/components/admin/accessAdminModel";
import {
  AccessAdminRequestError,
  describeAccessAdminError,
  setFunnelPathStatus,
  type FunnelCoveragePath,
  type PathCoverageState,
} from "@/services/accessAdminClient";

const DESCRIPTION =
  "Which campaign paths of the cohort snapshot belong to a funnel. Members with selected funnels see only users anchored to their funnels' paths.";
const ALL = "all";
const PAGE_SIZE = 200;

type StateFilter = typeof ALL | PathCoverageState;

type StatusChange = "confirm" | "reject" | "retire" | "reactivate" | "revoke";

interface StatusTarget {
  kind: StatusChange;
  row: FunnelCoveragePath;
  pathId: string;
  funnelId: string;
}

const STATUS_FOR: Readonly<Record<StatusChange, "active" | "retired" | "revoked">> = {
  confirm: "active",
  reject: "revoked",
  retire: "retired",
  reactivate: "active",
  revoke: "revoked",
};

const STATUS_DONE: Readonly<Record<StatusChange, string>> = {
  confirm: "Path confirmed",
  reject: "Proposal rejected",
  retire: "Path retired",
  reactivate: "Path reactivated",
  revoke: "Path revoked",
};

const STATUS_BUTTON: Readonly<Record<StatusChange, string>> = {
  confirm: "Confirm",
  reject: "Reject",
  retire: "Retire",
  reactivate: "Reactivate",
  revoke: "Revoke",
};

function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
}

function isNotReady(error: unknown): boolean {
  return error instanceof AccessAdminRequestError && (error.status === 409 || error.errorCode === "conflict");
}

function StateBadge({ row }: { row: FunnelCoveragePath }) {
  const className =
    row.state === "granted"
      ? "text-success"
      : row.state === "proposed"
        ? "border-primary/40 text-primary"
        : row.state === "unregistered"
          ? "border-warning/50 text-warning"
          : "text-muted-foreground";
  const title =
    row.state === "unscopable"
      ? "Not a canonical campaign path (or 'unknown'): it can never be granted, so only members with All funnels see these users."
      : row.state === "unregistered"
        ? "No funnel holds this path: members with selected funnels never see these users."
        : undefined;
  return (
    <div className="flex flex-col items-start gap-0.5">
      <Badge variant="outline" className={`text-xs font-normal ${className}`} title={title}>
        {COVERAGE_STATE_LABELS[row.state]}
      </Badge>
      {row.state === "granted" && row.path_status === "retired" && <span className="text-[10px] text-muted-foreground">retired</span>}
      {row.state === "unregistered" && row.path_status === "revoked" && <span className="text-[10px] text-muted-foreground">revoked</span>}
    </div>
  );
}

function Stat({ label, value, hint, testId }: { label: string; value: string; hint?: string; testId: string }) {
  return (
    <Card className="p-3 shadow-card" data-testid={testId}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-semibold text-foreground">{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-muted-foreground">{hint}</div>}
    </Card>
  );
}

export default function AdminFunnelCoveragePage() {
  const access = useAccess();
  const { toast } = useToast();
  const enabled = !access.legacy;
  const canManage = access.can("funnels.manage");
  const canListMembers = access.can("admin.users.view");

  const coverage = usePathCoverage(enabled);
  const funnels = useCoverageFunnels(enabled);
  const members = useAccessMembers(enabled && canListMembers);
  const { run } = useAccessAdminMutation({ refreshCoverage: true });
  // "No validated snapshot yet" (409) is shown inline, not toasted.
  useAccessAdminErrorToast("Could not load funnel coverage", isNotReady(coverage.error) ? null : coverage.error);

  const [search, setSearch] = useState("");
  const [stateFilter, setStateFilter] = useState<StateFilter>(ALL);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [attachRow, setAttachRow] = useState<{ row: FunnelCoveragePath; funnelId: string | null } | null>(null);
  const [statusTarget, setStatusTarget] = useState<StatusTarget | null>(null);
  const [statusSaving, setStatusSaving] = useState(false);

  const funnelRows = useMemo(() => funnels.data ?? [], [funnels.data]);
  const funnelsById = useMemo(() => new Map(funnelRows.map((funnel) => [funnel.id.toLowerCase(), funnel])), [funnelRows]);
  const funnelLabel = (id: string) => funnelOptionLabel(funnelsById.get(id.toLowerCase()), id);
  const membersHolding = (funnelId: string): number | null => (members.data ? membersHoldingFunnel(members.data, funnelId) : null);

  const data = coverage.data;
  const rows = useMemo(() => {
    const query = search.trim().toLowerCase();
    return (data?.paths ?? []).filter((row) => {
      if (stateFilter !== ALL && row.state !== stateFilter) return false;
      if (query && !row.path.toLowerCase().includes(query)) return false;
      return true;
    });
  }, [data, search, stateFilter]);
  const shown = rows.slice(0, limit);
  const hasFilters = Boolean(search.trim()) || stateFilter !== ALL;

  async function onConfirmStatus() {
    if (!statusTarget) return;
    const { kind, row, pathId, funnelId } = statusTarget;
    setStatusSaving(true);
    try {
      const result = await run(() => setFunnelPathStatus({ path_id: pathId, status: STATUS_FOR[kind] }));
      toast({
        title: result.changed ? STATUS_DONE[kind] : "Nothing changed",
        description: `${row.path} · ${funnelLabel(funnelId)}. ${result.affected_members} member${result.affected_members === 1 ? "" : "s"} affected.`,
      });
      setStatusTarget(null);
    } catch (error) {
      toast({ title: `Could not ${STATUS_BUTTON[kind].toLowerCase()} the path`, description: describeAccessAdminError(error), variant: "destructive" });
    } finally {
      setStatusSaving(false);
    }
  }

  function statusDialogText(target: StatusTarget): { title: string; body: string } {
    const funnel = funnelLabel(target.funnelId);
    const holders = membersHolding(target.funnelId);
    switch (target.kind) {
      case "confirm":
        return { title: `Confirm ${target.row.path} for ${funnel}?`, body: `${pathImpactText("add", target.row, funnel, holders)}.` };
      case "reject":
        return { title: `Reject the proposal ${target.row.path} → ${funnel}?`, body: "Nobody gains access through this proposal. The path itself is not changed." };
      case "retire":
        return {
          title: `Retire ${target.row.path}?`,
          body: `It stays granted to ${funnel}: members holding it keep seeing the users already anchored to it. New users on this path raise a reuse alert.`,
        };
      case "reactivate":
        return { title: `Reactivate ${target.row.path}?`, body: `It becomes an active path of ${funnel} again.` };
      case "revoke":
        return { title: `Revoke ${target.row.path} from ${funnel}?`, body: `${pathImpactText("remove", target.row, funnel, holders)}.` };
    }
  }

  if (access.legacy) {
    return (
      <AppLayout title="Funnel coverage" description={DESCRIPTION}>
        <AccessNotSetUpNotice />
      </AppLayout>
    );
  }

  const totals = data?.totals;
  const dialog = statusTarget ? statusDialogText(statusTarget) : null;
  const columns = canManage ? 8 : 7;

  return (
    <AppLayout
      title="Funnel coverage"
      description={DESCRIPTION}
      actions={
        <Button type="button" variant="outline" size="sm" onClick={() => void coverage.refetch()} disabled={coverage.isFetching}>
          {coverage.isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          <span className="hidden sm:inline">Refresh</span>
        </Button>
      }
    >
      {!data ? (
        <Card className="p-6 text-center text-sm text-muted-foreground shadow-card" data-testid="coverage-empty">
          {coverage.isLoading ? (
            <span className="inline-flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              Measuring coverage on the cohort snapshot…
            </span>
          ) : coverage.error ? (
            <span className="inline-flex flex-wrap items-center justify-center gap-2">
              {isNotReady(coverage.error) ? describeAccessAdminError(coverage.error) : `Could not load funnel coverage: ${describeAccessAdminError(coverage.error)}`}
              <Button type="button" variant="outline" size="sm" onClick={() => void coverage.refetch()}>
                Retry
              </Button>
            </span>
          ) : (
            "No coverage yet."
          )}
        </Card>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5" data-testid="coverage-summary">
            <Stat testId="coverage-users" label="Users" value={formatCount(totals?.users ?? 0)} hint="Real users of the snapshot" />
            <Stat
              testId="coverage-registered"
              label="In a funnel"
              value={`${totals?.registered_pct ?? 0}%`}
              hint={`${formatCount(totals?.registered_users ?? 0)} users on granted paths`}
            />
            <Stat
              testId="coverage-synthetic"
              label="Synthetic users"
              value={formatCount(totals?.synthetic_users ?? 0)}
              hint="Never visible with selected funnels"
            />
            <Stat
              testId="coverage-net"
              label="Net revenue in a funnel"
              value={formatPct(totals?.registered_net_revenue ?? 0, totals?.net_revenue ?? 0)}
              hint={`${formatUsd(totals?.registered_net_revenue ?? 0)} of ${formatUsd(totals?.net_revenue ?? 0)}`}
            />
            <Stat
              testId="coverage-snapshot"
              label="Snapshot"
              value={data.snapshot.status === "current" ? "Current" : "Stale"}
              hint={`${data.snapshot.warehouse_version.slice(0, 12) || "—"}${data.snapshot.generated_at ? ` · ${new Date(data.snapshot.generated_at).toLocaleString()}` : ""}`}
            />
          </div>

          {(data.reuse_alerts.length > 0 || data.registry_without_data.length > 0) && (
            <Card className="space-y-2 p-4 shadow-card" data-testid="coverage-alerts">
              {data.reuse_alerts.map((alert) => (
                <div key={alert.path_id} className="flex items-start gap-2 text-xs text-warning" data-testid={`reuse-alert-${alert.path_id}`}>
                  <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    <span className="font-mono">{alert.path}</span> was retired from {funnelLabel(alert.funnel_id)} on {formatDate(alert.retired_at)}, but{" "}
                    {formatCount(alert.users_since_retired)} user{alert.users_since_retired === 1 ? " was" : "s were"} anchored to it since: the
                    path may have been reused for another funnel. Members holding {funnelLabel(alert.funnel_id)} still see them.
                  </span>
                </div>
              ))}
              {data.registry_without_data.length > 0 && (
                <div className="flex items-start gap-2 text-xs text-muted-foreground" data-testid="funnels-without-data">
                  <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    {data.registry_without_data.length} funnel{data.registry_without_data.length === 1 ? " has" : "s have"} no users in the snapshot
                    (members holding only these see no data): {listText(data.registry_without_data.map(funnelLabel), 8)}
                  </span>
                </div>
              )}
            </Card>
          )}

          <Card className="p-4 shadow-card">
            <div className="flex flex-wrap items-center gap-2 border-b border-border pb-3">
              <Input
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setLimit(PAGE_SIZE);
                }}
                placeholder="Search paths…"
                className="h-9 w-[240px]"
                aria-label="Search paths"
              />
              <Select
                value={stateFilter}
                onValueChange={(value) => {
                  setStateFilter(value as StateFilter);
                  setLimit(PAGE_SIZE);
                }}
              >
                <SelectTrigger className="h-9 w-[170px]" aria-label="Filter by state">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All states</SelectItem>
                  {(Object.keys(COVERAGE_STATE_LABELS) as PathCoverageState[]).map((state) => (
                    <SelectItem key={state} value={state}>
                      {COVERAGE_STATE_LABELS[state]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="ml-auto text-xs text-muted-foreground">
                {rows.length} of {data.paths.length} paths
              </span>
            </div>

            <div className="mt-4 overflow-auto rounded-md border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Path</TableHead>
                    <TableHead className="w-[100px] text-right">Users</TableHead>
                    <TableHead className="w-[80px] text-right">%</TableHead>
                    <TableHead className="w-[110px] text-right">Net</TableHead>
                    <TableHead className="w-[170px]">First / last cohort</TableHead>
                    <TableHead className="w-[120px]">State</TableHead>
                    <TableHead className="w-[200px]">Funnel / proposals</TableHead>
                    {canManage && <TableHead className="w-[220px]">Actions</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {shown.length ? (
                    shown.map((row) => {
                      const actions = coveragePathActions(row, funnelRows);
                      return (
                        <TableRow key={row.path} data-testid={`coverage-row-${row.path}`}>
                          <TableCell className="max-w-[260px] truncate font-mono text-xs" title={row.path}>
                            {row.path || "(empty)"}
                          </TableCell>
                          <TableCell className="text-right text-sm tabular-nums">
                            {formatCount(row.users)}
                            {row.synthetic_users > 0 && (
                              <div className="text-[10px] text-muted-foreground" title="Synthetic unknown_user_* ids">
                                +{formatCount(row.synthetic_users)} synthetic
                              </div>
                            )}
                          </TableCell>
                          <TableCell className="text-right text-xs tabular-nums text-muted-foreground">{formatPct(row.users, totals?.users ?? 0)}</TableCell>
                          <TableCell className="text-right text-sm tabular-nums">{formatUsd(row.net_revenue)}</TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {row.first_cohort_date ?? "—"} → {row.last_cohort_date ?? "—"}
                          </TableCell>
                          <TableCell>
                            <StateBadge row={row} />
                          </TableCell>
                          <TableCell className="text-xs">
                            {row.funnel_id && <div className="truncate font-medium">{funnelLabel(row.funnel_id)}</div>}
                            {row.proposals.length > 0 && (
                              <div className="text-muted-foreground">Proposed: {listText(row.proposals.map((proposal) => funnelLabel(proposal.funnel_id)), 3)}</div>
                            )}
                            {!row.funnel_id && !row.proposals.length && <span className="text-muted-foreground">—</span>}
                          </TableCell>
                          {canManage && (
                            <TableCell>
                              <div className="flex flex-wrap items-center gap-1">
                                {actions.proposals.map((proposal) => (
                                  <div key={proposal.path_id} className="flex flex-wrap items-center gap-1">
                                    {proposal.canConfirm && (
                                      <Button
                                        type="button"
                                        size="sm"
                                        className="h-7 px-2 text-xs"
                                        onClick={() => setStatusTarget({ kind: "confirm", row, pathId: proposal.path_id, funnelId: proposal.funnel_id })}
                                        aria-label={`Confirm ${row.path} for ${funnelLabel(proposal.funnel_id)}`}
                                      >
                                        Confirm
                                      </Button>
                                    )}
                                    <Button
                                      type="button"
                                      variant="outline"
                                      size="sm"
                                      className="h-7 px-2 text-xs"
                                      onClick={() => setStatusTarget({ kind: "reject", row, pathId: proposal.path_id, funnelId: proposal.funnel_id })}
                                      aria-label={`Reject ${row.path} for ${funnelLabel(proposal.funnel_id)}`}
                                    >
                                      Reject
                                    </Button>
                                  </div>
                                ))}
                                {actions.attach && (
                                  <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    className="h-7 px-2 text-xs"
                                    onClick={() => setAttachRow({ row, funnelId: row.proposals[0]?.funnel_id ?? null })}
                                    aria-label={`Attach ${row.path}`}
                                  >
                                    Attach…
                                  </Button>
                                )}
                                {row.path_id && row.funnel_id && (["retire", "reactivate", "revoke"] as const)
                                  .filter((kind) => actions[kind])
                                  .map((kind) => (
                                    <Button
                                      key={kind}
                                      type="button"
                                      variant="outline"
                                      size="sm"
                                      className={`h-7 px-2 text-xs ${kind === "revoke" ? "text-destructive" : ""}`}
                                      onClick={() => setStatusTarget({ kind, row, pathId: row.path_id as string, funnelId: row.funnel_id as string })}
                                      aria-label={`${STATUS_BUTTON[kind]} ${row.path}`}
                                    >
                                      {STATUS_BUTTON[kind]}
                                    </Button>
                                  ))}
                                {actions.lockedReason && (
                                  <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground" title={actions.lockedReason}>
                                    <Lock className="h-3 w-3" />
                                    Funnel's own path
                                  </span>
                                )}
                              </div>
                            </TableCell>
                          )}
                        </TableRow>
                      );
                    })
                  ) : (
                    <TableRow>
                      <TableCell colSpan={columns} className="h-24 text-center text-muted-foreground">
                        {hasFilters ? (
                          "No paths match the current filters"
                        ) : (
                          <span className="inline-flex items-center gap-2">
                            <Filter className="h-4 w-4" />
                            The snapshot has no anchored users
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>

            {rows.length > shown.length && (
              <div className="mt-3 flex justify-center">
                <Button type="button" variant="outline" size="sm" onClick={() => setLimit((current) => current + PAGE_SIZE)}>
                  Show {Math.min(PAGE_SIZE, rows.length - shown.length)} more
                </Button>
              </div>
            )}
          </Card>
        </div>
      )}

      {canManage && (
        <AttachPathDialog
          open={attachRow !== null}
          onOpenChange={(open) => {
            if (!open) setAttachRow(null);
          }}
          row={attachRow?.row ?? null}
          defaultFunnelId={attachRow?.funnelId ?? null}
          funnels={funnelRows}
          funnelsLoading={funnels.isLoading}
          membersHolding={membersHolding}
        />
      )}

      <AlertDialog open={statusTarget !== null} onOpenChange={(open) => !open && !statusSaving && setStatusTarget(null)}>
        <AlertDialogContent data-testid="path-status-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>{dialog?.title}</AlertDialogTitle>
            <AlertDialogDescription>{dialog?.body}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={statusSaving}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                // Keep the dialog open until the call settles.
                event.preventDefault();
                void onConfirmStatus();
              }}
              disabled={statusSaving}
              className={
                statusTarget?.kind === "revoke" || statusTarget?.kind === "reject"
                  ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  : undefined
              }
            >
              {statusSaving && <Loader2 className="h-4 w-4 animate-spin" />}
              {statusTarget ? STATUS_BUTTON[statusTarget.kind] : ""}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppLayout>
  );
}
