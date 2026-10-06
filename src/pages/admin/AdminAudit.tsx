// Admin → Audit log (plan §24): the append-only access audit trail, newest
// first, filtered by event namespace and outcome and paged with before_id.
// Before/after snapshots are rendered as readable change lines ("Funnels:
// + soulmate-sketch − past-life", "Permissions: + cohorts.export"). Read-only;
// needs admin.audit.view (route guard and the `access` Edge function).

import { useMemo, useState } from "react";
import { Loader2, RefreshCw, ScrollText } from "lucide-react";
import { AppLayout } from "@/components/AppLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAccess } from "@/hooks/useAccess";
import { AccessNotSetUpNotice } from "@/components/admin/AdminNotices";
import { useAccessAdminErrorToast, useAccessAudit, useAccessFunnels, useAccessRoles } from "@/components/admin/useAccessAdmin";
import {
  AUDIT_EVENT_FILTERS,
  auditActorLabel,
  auditEventLabel,
  auditTargetLabel,
  describeAuditChanges,
  funnelPathLabel,
  shortId,
  type AuditLookups,
} from "@/components/admin/accessAdminModel";
import { describeAccessAdminError, type AuditEvent, type AuditQuery } from "@/services/accessAdminClient";

const DESCRIPTION = "Who changed members, roles and funnel access, and which requests were refused.";
const ALL = "all";

type OutcomeFilter = typeof ALL | NonNullable<AuditQuery["outcome"]>;

function formatOccurredAt(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function OutcomeBadge({ event }: { event: AuditEvent }) {
  const outcome = event.outcome;
  const className =
    outcome === "success"
      ? "text-success"
      : outcome === "denied"
        ? "border-warning/50 text-warning"
        : outcome === "error"
          ? "border-destructive/40 text-destructive"
          : "text-muted-foreground";
  return (
    <div className="flex flex-col items-start gap-0.5">
      <Badge variant="outline" className={`text-xs font-normal ${className}`}>
        {outcome ? outcome.charAt(0).toUpperCase() + outcome.slice(1) : "—"}
      </Badge>
      {event.reason_code && <span className="font-mono text-[10px] text-muted-foreground">{event.reason_code}</span>}
    </div>
  );
}

export default function AdminAuditPage() {
  const access = useAccess();
  const enabled = !access.legacy;
  const [eventFilter, setEventFilter] = useState<string>(ALL);
  const [outcomeFilter, setOutcomeFilter] = useState<OutcomeFilter>(ALL);

  const audit = useAccessAudit(
    { event: eventFilter === ALL ? null : eventFilter, outcome: outcomeFilter === ALL ? null : outcomeFilter },
    enabled,
  );
  useAccessAdminErrorToast("Could not load the audit log", audit.error);

  // Names for ids in the snapshots. Both reads have their own permissions; an
  // auditor without them sees short ids instead.
  const canSeeMembers = access.can("admin.users.view");
  const canSeeRoles = canSeeMembers || access.can("admin.roles.view");
  const funnels = useAccessFunnels(enabled && canSeeMembers);
  const roles = useAccessRoles(enabled && canSeeRoles);

  const lookups = useMemo<AuditLookups>(() => {
    const funnelsById = new Map((funnels.data ?? []).map((funnel) => [funnel.id.toLowerCase(), funnel]));
    const rolesById = new Map((roles.data ?? []).map((role) => [role.id.toLowerCase(), role]));
    return {
      funnelLabel: (id) => funnelPathLabel(funnelsById.get(id.toLowerCase()), id),
      roleLabel: (id, key) => (id ? rolesById.get(id.toLowerCase())?.name : undefined) ?? key ?? (id ? shortId(id) : "—"),
    };
  }, [funnels.data, roles.data]);

  const events = useMemo(() => (audit.data?.pages ?? []).flatMap((page) => page.events), [audit.data]);
  const hasFilters = eventFilter !== ALL || outcomeFilter !== ALL;

  if (access.legacy) {
    return (
      <AppLayout title="Audit log" description={DESCRIPTION}>
        <AccessNotSetUpNotice />
      </AppLayout>
    );
  }

  return (
    <AppLayout title="Audit log" description={DESCRIPTION}>
      <Card className="p-4 shadow-card">
        <div className="flex flex-wrap items-center gap-2 border-b border-border pb-3">
          <Select value={eventFilter} onValueChange={setEventFilter}>
            <SelectTrigger className="h-9 w-[180px]" aria-label="Filter by event">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All events</SelectItem>
              {AUDIT_EVENT_FILTERS.map((filter) => (
                <SelectItem key={filter.value} value={filter.value}>
                  {filter.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={outcomeFilter} onValueChange={(value) => setOutcomeFilter(value as OutcomeFilter)}>
            <SelectTrigger className="h-9 w-[160px]" aria-label="Filter by outcome">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All outcomes</SelectItem>
              <SelectItem value="success">Success</SelectItem>
              <SelectItem value="denied">Denied</SelectItem>
              <SelectItem value="error">Error</SelectItem>
            </SelectContent>
          </Select>
          <div className="ml-auto flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {events.length} event{events.length === 1 ? "" : "s"}
              {audit.hasNextPage ? "+" : ""}
            </span>
            <Button type="button" variant="outline" size="sm" onClick={() => void audit.refetch()} disabled={audit.isFetching}>
              {audit.isFetching && !audit.isFetchingNextPage ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Refresh
            </Button>
          </div>
        </div>

        <div className="mt-4 overflow-auto rounded-md border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[170px]">When</TableHead>
                <TableHead className="w-[200px]">Actor</TableHead>
                <TableHead className="w-[190px]">Event</TableHead>
                <TableHead className="w-[180px]">Target</TableHead>
                <TableHead>Changes</TableHead>
                <TableHead className="w-[120px]">Outcome</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.length ? (
                events.map((event) => {
                  const changes = describeAuditChanges(event, lookups);
                  return (
                    <TableRow key={event.id} data-testid={`audit-row-${event.id}`}>
                      <TableCell className="text-xs text-muted-foreground">{formatOccurredAt(event.occurred_at)}</TableCell>
                      <TableCell className="max-w-[200px] truncate text-sm" title={event.actor_user_id ?? undefined}>
                        {auditActorLabel(event)}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col">
                          <span className="text-sm font-medium">{auditEventLabel(event.event)}</span>
                          <span className="font-mono text-[10px] text-muted-foreground">{event.event}</span>
                        </div>
                      </TableCell>
                      <TableCell className="max-w-[180px] truncate text-sm" title={event.target_id ?? undefined}>
                        {auditTargetLabel(event)}
                      </TableCell>
                      <TableCell className="text-xs">
                        {changes.length ? (
                          <ul className="space-y-0.5">
                            {changes.map((line, index) => (
                              <li key={index}>{line}</li>
                            ))}
                          </ul>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <OutcomeBadge event={event} />
                      </TableCell>
                    </TableRow>
                  );
                })
              ) : (
                <TableRow>
                  <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
                    {audit.isLoading ? (
                      <span className="inline-flex items-center gap-2">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Loading audit log…
                      </span>
                    ) : audit.error ? (
                      <span className="inline-flex flex-wrap items-center justify-center gap-2">
                        Could not load the audit log: {describeAccessAdminError(audit.error)}
                        <Button type="button" variant="outline" size="sm" onClick={() => void audit.refetch()}>
                          Retry
                        </Button>
                      </span>
                    ) : hasFilters ? (
                      "No events match the current filters"
                    ) : (
                      <span className="inline-flex items-center gap-2">
                        <ScrollText className="h-4 w-4" />
                        No audit events yet
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>

        {audit.hasNextPage && (
          <div className="mt-3 flex justify-center">
            <Button type="button" variant="outline" size="sm" onClick={() => void audit.fetchNextPage()} disabled={audit.isFetchingNextPage}>
              {audit.isFetchingNextPage && <Loader2 className="h-4 w-4 animate-spin" />}
              Load older events
            </Button>
          </div>
        )}
      </Card>
    </AppLayout>
  );
}
