// Admin → Roles (plan §16): every role with its type, member count and how
// many new catalog permissions its template offers (never auto-added, §8). A
// row opens the role editor; "New role" and "Duplicate" create custom roles;
// "Create default roles" seeds the templates when only the Owner role exists.
// Reads need admin.roles.view (route guard); changes need admin.roles.manage,
// seeding needs the Owner. The `access` Edge function and the SQL RPCs re-check
// everything (UX only here).

import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Loader2, Plus, RefreshCw, ShieldCheck, Wand2 } from "lucide-react";
import { AppLayout } from "@/components/AppLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { useAccess } from "@/hooks/useAccess";
import { AccessNotSetUpNotice } from "@/components/admin/AdminNotices";
import { RoleEditorSheet, type RoleEditorTarget } from "@/components/admin/RoleEditorSheet";
import {
  useAccessAdminErrorToast,
  useAccessAdminMutation,
  useAccessCatalog,
  useAccessRoles,
} from "@/components/admin/useAccessAdmin";
import { actorFromAccess, isPrivilegedRole } from "@/components/admin/accessAdminModel";
import { describeAccessAdminError, seedAccessRoleTemplates, type AdminRole } from "@/services/accessAdminClient";

const DESCRIPTION = "Roles bundle the pages, exports, AI and admin features a member can use. Funnel access is set per member.";

type EditorState =
  /** `fallback`: the role returned by roles.create, shown until the list refetch includes it. */
  | { mode: "edit"; roleId: string; fallback?: AdminRole }
  | { mode: "create"; seed?: { name: string; description: string; permissions: string[] } }
  | null;

export default function AdminRolesPage() {
  const access = useAccess();
  const { toast } = useToast();
  const { run } = useAccessAdminMutation();
  const canManage = access.can("admin.roles.manage");
  const actor = useMemo(() => actorFromAccess(access), [access]);
  const enabled = !access.legacy;

  const roles = useAccessRoles(enabled);
  const catalog = useAccessCatalog(enabled);
  useAccessAdminErrorToast("Could not load roles", roles.error);
  useAccessAdminErrorToast("Could not load the permission catalog", catalog.error);

  const [searchParams, setSearchParams] = useSearchParams();
  const [editor, setEditor] = useState<EditorState>(null);
  const [seeding, setSeeding] = useState(false);

  const roleRows = useMemo(() => roles.data ?? [], [roles.data]);

  // Deep link from the member sheet: /admin/roles?role=<id>.
  // Applied once per link, so a later refetch does not reopen it.
  const linkedRoleId = searchParams.get("role");
  const appliedLink = useRef<string | null>(null);
  useEffect(() => {
    if (!linkedRoleId || !roles.data || appliedLink.current === linkedRoleId) return;
    appliedLink.current = linkedRoleId;
    if (roles.data.some((role) => role.id === linkedRoleId)) setEditor({ mode: "edit", roleId: linkedRoleId });
  }, [linkedRoleId, roles.data]);

  const editedRole = editor?.mode === "edit" ? roleRows.find((role) => role.id === editor.roleId) ?? editor.fallback ?? null : null;
  const target: RoleEditorTarget | null =
    editor?.mode === "edit" ? (editedRole ? { mode: "edit", role: editedRole } : null) : editor?.mode === "create" ? { mode: "create", seed: editor.seed } : null;

  const onlyOwner = roles.data !== undefined && roleRows.every((role) => role.is_owner);
  const canSeed = canManage && actor.isOwner && onlyOwner;

  function closeEditor() {
    setEditor(null);
    if (linkedRoleId) {
      const next = new URLSearchParams(searchParams);
      next.delete("role");
      setSearchParams(next, { replace: true });
      appliedLink.current = null;
    }
  }

  function onDuplicate(role: AdminRole) {
    setEditor({
      mode: "create",
      seed: { name: `${role.name} copy`, description: role.description, permissions: role.permissions },
    });
  }

  async function onSeed() {
    setSeeding(true);
    try {
      const result = await run(() => seedAccessRoleTemplates());
      toast({
        title: result.created.length ? `Created ${result.created.length} default role${result.created.length === 1 ? "" : "s"}` : "Default roles already exist",
        description: result.created.length ? "Review each role before assigning it." : undefined,
      });
    } catch (error) {
      toast({ title: "Could not create default roles", description: describeAccessAdminError(error), variant: "destructive" });
    } finally {
      setSeeding(false);
    }
  }

  if (access.legacy) {
    return (
      <AppLayout title="Roles" description={DESCRIPTION}>
        <AccessNotSetUpNotice />
      </AppLayout>
    );
  }

  return (
    <AppLayout
      title="Roles"
      description={DESCRIPTION}
      actions={
        <>
          {canSeed && (
            <Button type="button" variant="outline" size="sm" onClick={() => void onSeed()} disabled={seeding}>
              {seeding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
              <span className="hidden sm:inline">Create default roles</span>
            </Button>
          )}
          {canManage && (
            <Button type="button" size="sm" onClick={() => setEditor({ mode: "create" })} disabled={!catalog.data}>
              <Plus className="h-4 w-4" />
              <span className="hidden sm:inline">New role</span>
            </Button>
          )}
        </>
      }
    >
      <Card className="p-4 shadow-card">
        <div className="flex flex-wrap items-center gap-2 border-b border-border pb-3">
          <p className="text-xs text-muted-foreground">
            New permissions are never added to existing roles automatically: a role shows when its template offers more.
          </p>
          <div className="ml-auto flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{roleRows.length} roles</span>
            <Button type="button" variant="outline" size="sm" onClick={() => void roles.refetch()} disabled={roles.isFetching}>
              {roles.isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Refresh
            </Button>
          </div>
        </div>

        <div className="mt-4 overflow-auto rounded-md border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Role</TableHead>
                <TableHead className="w-[140px]">Type</TableHead>
                <TableHead className="w-[100px]">Members</TableHead>
                <TableHead className="w-[120px]">Permissions</TableHead>
                <TableHead className="w-[230px]">Updates</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {roleRows.length ? (
                roleRows.map((role) => (
                  <TableRow
                    key={role.id}
                    className="cursor-pointer"
                    tabIndex={0}
                    onClick={() => setEditor({ mode: "edit", roleId: role.id })}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setEditor({ mode: "edit", roleId: role.id });
                      }
                    }}
                    data-testid={`role-row-${role.id}`}
                  >
                    <TableCell>
                      <div className="flex min-w-0 flex-col">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="font-medium">{role.name}</span>
                          {!role.is_owner && isPrivilegedRole(role) && (
                            <Badge variant="outline" className="text-[10px] font-normal text-destructive">
                              admin
                            </Badge>
                          )}
                        </div>
                        {role.description && <span className="line-clamp-1 text-xs text-muted-foreground">{role.description}</span>}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {role.is_owner && <Badge className="text-xs font-normal">Owner</Badge>}
                        <Badge variant={role.is_system ? "secondary" : "outline"} className="text-xs font-normal">
                          {role.is_system ? "System" : "Custom"}
                        </Badge>
                      </div>
                    </TableCell>
                    <TableCell className="text-sm">{role.member_count ?? "—"}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{role.is_owner ? "All" : role.permissions.length}</TableCell>
                    <TableCell>
                      {role.new_permissions_available > 0 ? (
                        <Badge variant="outline" className="border-primary/40 text-xs font-normal text-primary">
                          {role.new_permissions_available} new permission{role.new_permissions_available === 1 ? "" : "s"} available
                        </Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                    {roles.isLoading ? (
                      <span className="inline-flex items-center gap-2">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Loading roles…
                      </span>
                    ) : roles.error ? (
                      <span className="inline-flex flex-wrap items-center justify-center gap-2">
                        Could not load roles: {describeAccessAdminError(roles.error)}
                        <Button type="button" variant="outline" size="sm" onClick={() => void roles.refetch()}>
                          Retry
                        </Button>
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-2">
                        <ShieldCheck className="h-4 w-4" />
                        No roles yet
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>

        {onlyOwner && roleRows.length > 0 && (
          <p className="mt-3 text-xs text-muted-foreground">
            Only the Owner role exists.{" "}
            {canSeed
              ? "Create the default roles (Admin, Head of Marketing, Media Buyer, Product Manager, Analyst, Viewer) or a custom one."
              : "Ask the workspace Owner to create the default roles."}
          </p>
        )}
      </Card>

      <RoleEditorSheet
        target={catalog.data ? target : null}
        onOpenChange={(open) => {
          if (!open) closeEditor();
        }}
        catalog={catalog.data?.permissions ?? []}
        templates={catalog.data?.templates ?? []}
        actor={actor}
        canManage={canManage}
        onDuplicate={onDuplicate}
        onCreated={(role) => setEditor({ mode: "edit", roleId: role.id, fallback: role })}
        onDeleted={closeEditor}
      />
    </AppLayout>
  );
}
