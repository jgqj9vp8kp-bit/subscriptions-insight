// Admin → Members (plan §15): who can sign in to this workspace, their role,
// funnel scope, status and last activity. A row opens the member sheet; "Add
// member" grants an existing account access. Reads need admin.users.view (the
// route guard); every change needs admin.users.manage and is re-checked by the
// `access` Edge function and the SQL mutation RPCs (UX only here).

import { useMemo, useState } from "react";
import { Loader2, RefreshCw, UserCog, UserPlus } from "lucide-react";
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
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { useAccess } from "@/hooks/useAccess";
import { AddMemberDialog } from "@/components/admin/AddMemberDialog";
import { AccessNotSetUpNotice } from "@/components/admin/AdminNotices";
import { MemberSheet } from "@/components/admin/MemberSheet";
import {
  useAccessAdminErrorToast,
  useAccessAdminMutation,
  useAccessCatalog,
  useAccessFunnels,
  useAccessMembers,
  useAccessRoles,
} from "@/components/admin/useAccessAdmin";
import {
  actorFromAccess,
  formatLastActive,
  funnelScopeLabel,
  isSelfMember,
  memberDisplayName,
  memberEditBlockReason,
} from "@/components/admin/accessAdminModel";
import { describeAccessAdminError, updateAccessMember, type AdminMember } from "@/services/accessAdminClient";

type StatusFilter = "all" | "active" | "disabled";

const DESCRIPTION = "Who can sign in to this workspace, their role and which funnels' data they can see.";

/** Human text of the ban warnings members.update may return. */
function warningText(warnings: string[]): string | null {
  if (!warnings.length) return null;
  return "The membership change is saved, but updating the sign-in block failed. The membership already blocks every request; repeat the change to retry.";
}

export default function AdminMembersPage() {
  const access = useAccess();
  const { toast } = useToast();
  const { run } = useAccessAdminMutation();
  const canManage = access.can("admin.users.manage");
  const canViewRoles = access.can("admin.roles.view");
  const actor = useMemo(() => actorFromAccess(access), [access]);
  const enabled = !access.legacy;

  const members = useAccessMembers(enabled);
  const roles = useAccessRoles(enabled);
  const funnels = useAccessFunnels(enabled);
  const catalog = useAccessCatalog(enabled);
  useAccessAdminErrorToast("Could not load members", members.error);
  useAccessAdminErrorToast("Could not load roles", roles.error);

  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [statusTarget, setStatusTarget] = useState<{ member: AdminMember; next: "active" | "disabled" } | null>(null);
  const [statusSaving, setStatusSaving] = useState(false);

  const memberRows = useMemo(() => members.data ?? [], [members.data]);
  const roleRows = useMemo(() => roles.data ?? [], [roles.data]);
  const rolesById = useMemo(() => new Map(roleRows.map((role) => [role.id, role])), [roleRows]);
  const selected = useMemo(() => memberRows.find((member) => member.id === selectedId) ?? null, [memberRows, selectedId]);

  const visibleMembers = useMemo(() => {
    const query = search.trim().toLowerCase();
    return memberRows.filter((member) => {
      if (statusFilter !== "all" && member.status !== statusFilter) return false;
      if (roleFilter !== "all" && member.role.id !== roleFilter) return false;
      if (query && !`${member.display_name} ${member.email}`.toLowerCase().includes(query)) return false;
      return true;
    });
  }, [memberRows, search, roleFilter, statusFilter]);

  const hasFilters = Boolean(search.trim()) || roleFilter !== "all" || statusFilter !== "all";
  const loading = members.isLoading;

  function statusLockReason(member: AdminMember): string | null {
    if (!canManage) return "You can view members but not change them.";
    return memberEditBlockReason(member, rolesById.get(member.role.id), actor);
  }

  async function onConfirmStatus() {
    if (!statusTarget) return;
    const { member, next } = statusTarget;
    setStatusSaving(true);
    try {
      const result = await run(() => updateAccessMember({ member_id: member.id, status: next }));
      const warning = warningText(result.warnings);
      toast({
        title: next === "disabled" ? "Member disabled" : "Member enabled",
        description: warning ?? memberDisplayName(member),
        variant: warning ? "destructive" : undefined,
      });
      setStatusTarget(null);
    } catch (error) {
      toast({
        title: next === "disabled" ? "Could not disable member" : "Could not enable member",
        description: describeAccessAdminError(error),
        variant: "destructive",
      });
    } finally {
      setStatusSaving(false);
    }
  }

  if (access.legacy) {
    return (
      <AppLayout title="Members" description={DESCRIPTION}>
        <AccessNotSetUpNotice />
      </AppLayout>
    );
  }

  return (
    <AppLayout
      title="Members"
      description={DESCRIPTION}
      actions={
        canManage ? (
          <Button type="button" size="sm" onClick={() => setAddOpen(true)} disabled={!roles.data}>
            <UserPlus className="h-4 w-4" />
            <span className="hidden sm:inline">Add member</span>
          </Button>
        ) : undefined
      }
    >
      <Card className="p-4 shadow-card">
        <div className="flex flex-wrap items-center gap-2 border-b border-border pb-3">
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search name or email…"
            className="h-9 w-[240px]"
            aria-label="Search members"
          />
          <Select value={roleFilter} onValueChange={setRoleFilter}>
            <SelectTrigger className="h-9 w-[170px]" aria-label="Filter by role">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All roles</SelectItem>
              {roleRows.map((role) => (
                <SelectItem key={role.id} value={role.id}>
                  {role.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={statusFilter} onValueChange={(value) => setStatusFilter(value as StatusFilter)}>
            <SelectTrigger className="h-9 w-[150px]" aria-label="Filter by status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="active">Active only</SelectItem>
              <SelectItem value="disabled">Disabled only</SelectItem>
            </SelectContent>
          </Select>
          <div className="ml-auto flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {visibleMembers.length} of {memberRows.length}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                void members.refetch();
                void roles.refetch();
              }}
              disabled={members.isFetching}
            >
              {members.isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Refresh
            </Button>
          </div>
        </div>

        <div className="mt-4 overflow-auto rounded-md border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead className="w-[180px]">Role</TableHead>
                <TableHead className="w-[140px]">Funnels</TableHead>
                <TableHead className="w-[140px]">Status</TableHead>
                <TableHead className="w-[140px]">Last active</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleMembers.length ? (
                visibleMembers.map((member) => {
                  const lock = statusLockReason(member);
                  const active = member.status === "active";
                  return (
                    <TableRow
                      key={member.id}
                      className="cursor-pointer"
                      tabIndex={0}
                      onClick={() => setSelectedId(member.id)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          setSelectedId(member.id);
                        }
                      }}
                      data-testid={`member-row-${member.id}`}
                    >
                      <TableCell>
                        <div className="flex min-w-0 flex-col">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="truncate font-medium">{memberDisplayName(member)}</span>
                            {isSelfMember(member, actor) && (
                              <Badge variant="outline" className="text-[10px] font-normal">
                                You
                              </Badge>
                            )}
                            {member.is_data_owner && (
                              <Badge variant="outline" className="text-[10px] font-normal">
                                Data owner
                              </Badge>
                            )}
                          </div>
                          {member.display_name.trim() && member.email && (
                            <span className="truncate text-xs text-muted-foreground">{member.email}</span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant={member.role.is_owner ? "default" : "secondary"} className="text-xs font-normal">
                          {member.role.name || "Unknown role"}
                        </Badge>
                      </TableCell>
                      <TableCell className={`text-sm ${member.funnel_scope.mode === "none" ? "text-warning" : ""}`}>
                        {funnelScopeLabel(member.funnel_scope)}
                      </TableCell>
                      <TableCell onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
                        <div className="flex items-center gap-2" title={lock ?? undefined}>
                          <Switch
                            checked={active}
                            disabled={Boolean(lock)}
                            onCheckedChange={(checked) => setStatusTarget({ member, next: checked ? "active" : "disabled" })}
                            aria-label={`${active ? "Disable" : "Enable"} ${memberDisplayName(member)}`}
                          />
                          <span className={`text-xs ${active ? "text-success" : "text-muted-foreground"}`}>{active ? "Active" : "Disabled"}</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground" title={member.last_seen_at ? new Date(member.last_seen_at).toLocaleString() : undefined}>
                        {formatLastActive(member.last_seen_at)}
                      </TableCell>
                    </TableRow>
                  );
                })
              ) : (
                <TableRow>
                  <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                    {loading ? (
                      <span className="inline-flex items-center gap-2">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Loading members…
                      </span>
                    ) : members.error ? (
                      <span className="inline-flex flex-wrap items-center justify-center gap-2">
                        Could not load members: {describeAccessAdminError(members.error)}
                        <Button type="button" variant="outline" size="sm" onClick={() => void members.refetch()}>
                          Retry
                        </Button>
                      </span>
                    ) : hasFilters ? (
                      "No members match the current filters"
                    ) : (
                      <span className="inline-flex items-center gap-2">
                        <UserCog className="h-4 w-4" />
                        No members yet
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </Card>

      <MemberSheet
        member={selected}
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedId(null);
        }}
        roles={roleRows}
        funnels={funnels.data ?? []}
        funnelsLoading={funnels.isLoading}
        catalog={catalog.data?.permissions}
        actor={actor}
        canManage={canManage}
        canViewRoles={canViewRoles}
        onRequestStatusChange={(member, next) => setStatusTarget({ member, next })}
      />

      <AddMemberDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        roles={roleRows}
        funnels={funnels.data ?? []}
        funnelsLoading={funnels.isLoading}
        actor={actor}
      />

      <AlertDialog open={statusTarget !== null} onOpenChange={(open) => !open && !statusSaving && setStatusTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {statusTarget?.next === "disabled" ? "Disable" : "Enable"} {statusTarget ? memberDisplayName(statusTarget.member) : ""}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {statusTarget?.next === "disabled"
                ? "They lose access right away: every request is refused and their sessions stop refreshing. You can enable them again later."
                : "They get back the access of their role and funnel scope. They may need to sign in again."}
            </AlertDialogDescription>
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
              className={statusTarget?.next === "disabled" ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : undefined}
            >
              {statusSaving && <Loader2 className="h-4 w-4 animate-spin" />}
              {statusTarget?.next === "disabled" ? "Disable" : "Enable"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppLayout>
  );
}
