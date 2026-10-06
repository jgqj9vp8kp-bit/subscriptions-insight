// Role editor of Admin → Roles (plan §16): name, description and the
// permission matrix. Saving an existing role first shows a diff summary and how
// many members it affects; the server re-validates (catalog, requires-closure,
// anti-escalation) and writes the role.updated audit row. The Owner role is
// locked. Duplicate seeds a new role; Delete is offered only for an unused,
// non-system role.

import { useEffect, useMemo, useState } from "react";
import { Copy, Loader2, Lock, Sparkles, Trash2 } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { PermissionMatrix } from "@/components/admin/PermissionMatrix";
import { useAccessAdminMutation } from "@/components/admin/useAccessAdmin";
import {
  diffKeys,
  grantableSubset,
  inCatalogOrder,
  permissionGrantBlockReason,
  permissionLabel,
  roleDeleteBlockReason,
  roleEditBlockReason,
  togglePermission,
  type AdminActor,
} from "@/components/admin/accessAdminModel";
import {
  createAccessRole,
  deleteAccessRole,
  describeAccessAdminError,
  updateAccessRole,
  type AccessRoleTemplate,
  type AdminRole,
} from "@/services/accessAdminClient";
import { isPrivilegedPermission, type PermissionDef } from "../../../supabase/functions/_shared/access/permissions.ts";

export type RoleEditorTarget =
  | { mode: "edit"; role: AdminRole }
  | { mode: "create"; seed?: { name: string; description: string; permissions: string[] } };

export interface RoleEditorSheetProps {
  target: RoleEditorTarget | null;
  onOpenChange: (open: boolean) => void;
  catalog: readonly PermissionDef[];
  templates: readonly AccessRoleTemplate[];
  actor: AdminActor;
  canManage: boolean;
  onDuplicate: (role: AdminRole) => void;
  onCreated?: (role: AdminRole) => void;
  onDeleted?: () => void;
}

const BLANK_TEMPLATE = "blank";

export function RoleEditorSheet({ target, onOpenChange, catalog, templates, actor, canManage, onDuplicate, onCreated, onDeleted }: RoleEditorSheetProps) {
  const { toast } = useToast();
  const { run } = useAccessAdminMutation();
  const role = target?.mode === "edit" ? target.role : null;
  const creating = target?.mode === "create";

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [permissions, setPermissions] = useState<string[]>([]);
  const [templateKey, setTemplateKey] = useState(BLANK_TEMPLATE);
  const [confirmSave, setConfirmSave] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState<"save" | "delete" | null>(null);

  // Saved permission set of the edited role, in catalog order (unknown keys
  // dropped: the server would reject them on save).
  const baseline = useMemo(() => (role ? inCatalogOrder(catalog, role.permissions) : []), [catalog, role]);

  const targetKey = target
    ? target.mode === "edit"
      ? `edit|${target.role.id}|${target.role.name}|${target.role.description}|${target.role.permissions.join(",")}`
      : `create|${target.seed?.name ?? ""}|${(target.seed?.permissions ?? []).join(",")}`
    : "";
  useEffect(() => {
    if (!target) return;
    if (target.mode === "edit") {
      setName(target.role.name);
      setDescription(target.role.description);
      setPermissions(inCatalogOrder(catalog, target.role.permissions));
    } else {
      setName(target.seed?.name ?? "");
      setDescription(target.seed?.description ?? "");
      setPermissions(grantableSubset(catalog, target.seed?.permissions ?? [], actor));
    }
    setTemplateKey(BLANK_TEMPLATE);
    setConfirmSave(false);
    setConfirmDelete(false);
    // Re-seed only when the target (or its saved state) changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey, catalog]);

  const lockReason = !target
    ? null
    : !canManage
      ? "You can view roles but not change them."
      : role
        ? roleEditBlockReason(role, actor)
        : null;
  const readOnly = Boolean(lockReason);
  const deleteBlock = role ? (canManage ? roleDeleteBlockReason(role, actor) : "You can view roles but not change them.") : null;

  const diff = useMemo(() => diffKeys(baseline, permissions), [baseline, permissions]);
  const trimmedName = name.trim();
  const nameChanged = Boolean(role) && trimmedName !== role?.name.trim();
  const descriptionChanged = Boolean(role) && description.trim() !== (role?.description ?? "").trim();
  const dirty = creating ? true : nameChanged || descriptionChanged || diff.added.length > 0 || diff.removed.length > 0;
  const addsPrivileged = diff.added.some((key) => isPrivilegedPermission(key));
  const freshKeys = useMemo(() => new Set(role?.new_permission_keys ?? []), [role]);
  const freshMissing = [...freshKeys].filter((key) => !permissions.includes(key));
  const grantBlock = (def: PermissionDef) => permissionGrantBlockReason(def, actor);

  function applyTemplate(key: string) {
    setTemplateKey(key);
    if (key === BLANK_TEMPLATE) return;
    const template = templates.find((entry) => entry.key === key);
    if (!template) return;
    setPermissions(grantableSubset(catalog, template.permissions, actor));
    if (!description.trim()) setDescription(template.description);
    if (!trimmedName) setName(`${template.name} (custom)`);
  }

  function addFreshPermissions() {
    let next = permissions;
    for (const key of freshMissing) {
      const def = catalog.find((entry) => entry.key === key);
      if (def && !grantBlock(def)) next = togglePermission(catalog, next, key, true);
    }
    setPermissions(next);
  }

  async function onCreate() {
    if (!trimmedName) return;
    setBusy("save");
    try {
      const created = await run(() => createAccessRole({ name: trimmedName, description: description.trim(), permissions }));
      toast({ title: "Role created", description: created.name });
      onCreated?.(created);
    } catch (error) {
      toast({ title: "Could not create role", description: describeAccessAdminError(error), variant: "destructive" });
    } finally {
      setBusy(null);
    }
  }

  async function onSave() {
    if (!role) return;
    setBusy("save");
    try {
      const result = await run(() =>
        updateAccessRole({
          role_id: role.id,
          ...(nameChanged ? { name: trimmedName } : {}),
          ...(descriptionChanged ? { description: description.trim() } : {}),
          ...(diff.added.length || diff.removed.length ? { permissions } : {}),
        }),
      );
      toast({ title: result.changed ? "Role saved" : "No changes to save", description: result.role.name });
      setConfirmSave(false);
    } catch (error) {
      toast({ title: "Could not save role", description: describeAccessAdminError(error), variant: "destructive" });
    } finally {
      setBusy(null);
    }
  }

  async function onDelete() {
    if (!role) return;
    setBusy("delete");
    try {
      await run(() => deleteAccessRole(role.id));
      toast({ title: "Role deleted", description: role.name });
      setConfirmDelete(false);
      onDeleted?.();
    } catch (error) {
      toast({ title: "Could not delete role", description: describeAccessAdminError(error), variant: "destructive" });
    } finally {
      setBusy(null);
    }
  }

  const affected = role?.member_count ?? null;

  return (
    <Sheet open={Boolean(target)} onOpenChange={(open) => !busy && onOpenChange(open)}>
      <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-2xl" data-testid="role-editor">
        {target && (
          <>
            <SheetHeader className="space-y-1 border-b border-border px-6 py-4 pr-12 text-left">
              <SheetTitle className="text-base">{creating ? "New role" : role?.name}</SheetTitle>
              <SheetDescription>
                {creating
                  ? "Pick what this role can open and do. Funnel access is set per member."
                  : role?.is_owner
                    ? "The workspace Owner role."
                    : `${affected ?? "?"} member${affected === 1 ? "" : "s"} with this role.`}
              </SheetDescription>
              {role && (
                <div className="flex flex-wrap gap-1 pt-1">
                  {role.is_owner && <Badge className="text-xs font-normal">Owner</Badge>}
                  <Badge variant={role.is_system ? "secondary" : "outline"} className="text-xs font-normal">
                    {role.is_system ? "System" : "Custom"}
                  </Badge>
                  {role.template_key && (
                    <Badge variant="outline" className="text-xs font-normal text-muted-foreground">
                      From template: {templates.find((entry) => entry.key === role.template_key)?.name ?? role.template_key}
                    </Badge>
                  )}
                </div>
              )}
            </SheetHeader>

            <div className="flex-1 space-y-4 overflow-y-auto px-6 py-4">
              {lockReason && (
                <div role="status" className="flex items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                  <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{lockReason}</span>
                </div>
              )}

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label htmlFor="role-name" className="text-xs text-muted-foreground">
                    Name
                  </Label>
                  <Input id="role-name" value={name} maxLength={80} disabled={readOnly || busy !== null} onChange={(event) => setName(event.target.value)} className="h-9" />
                </div>
                {creating && templates.length > 0 && (
                  <div className="grid gap-1.5">
                    <Label htmlFor="role-template" className="text-xs text-muted-foreground">
                      Start from
                    </Label>
                    <Select value={templateKey} onValueChange={applyTemplate} disabled={busy !== null}>
                      <SelectTrigger id="role-template" className="h-9">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={BLANK_TEMPLATE}>Blank role</SelectItem>
                        {templates.map((template) => (
                          <SelectItem key={template.key} value={template.key}>
                            {template.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="role-description" className="text-xs text-muted-foreground">
                  Description
                </Label>
                <Textarea
                  id="role-description"
                  value={description}
                  maxLength={500}
                  rows={2}
                  disabled={readOnly || busy !== null}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </div>

              {!readOnly && freshMissing.length > 0 && (
                <div role="status" className="flex flex-wrap items-center gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs">
                  <Sparkles className="h-3.5 w-3.5 text-primary" />
                  <span>
                    {freshMissing.length} new permission{freshMissing.length === 1 ? "" : "s"} available from the template:{" "}
                    {freshMissing.map((key) => permissionLabel(key, catalog)).join(", ")}. They are never added automatically.
                  </span>
                  <Button type="button" variant="outline" size="sm" className="ml-auto h-7 text-xs" onClick={addFreshPermissions}>
                    Add them
                  </Button>
                </div>
              )}

              <PermissionMatrix
                catalog={catalog}
                value={permissions}
                onChange={setPermissions}
                readOnly={readOnly || busy !== null}
                blockReason={grantBlock}
                baseline={role ? baseline : undefined}
                highlight={freshKeys}
              />
            </div>

            <SheetFooter className="gap-2 border-t border-border px-6 py-3 sm:justify-between">
              <div className="flex flex-wrap gap-2">
                {role && canManage && (
                  <Button type="button" variant="outline" size="sm" onClick={() => onDuplicate(role)} disabled={busy !== null}>
                    <Copy className="h-4 w-4" />
                    Duplicate
                  </Button>
                )}
                {role && canManage && !role.is_owner && (
                  <span title={deleteBlock ?? undefined}>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="text-destructive hover:text-destructive"
                      onClick={() => setConfirmDelete(true)}
                      disabled={Boolean(deleteBlock) || busy !== null}
                    >
                      <Trash2 className="h-4 w-4" />
                      Delete
                    </Button>
                  </span>
                )}
              </div>
              <div className="flex flex-wrap justify-end gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={busy !== null}>
                  Close
                </Button>
                {canManage && !readOnly && (
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => (creating ? void onCreate() : setConfirmSave(true))}
                    disabled={!dirty || !trimmedName || busy !== null}
                  >
                    {busy === "save" && <Loader2 className="h-4 w-4 animate-spin" />}
                    {creating ? "Create role" : "Save changes"}
                  </Button>
                )}
              </div>
            </SheetFooter>
          </>
        )}
      </SheetContent>

      <AlertDialog open={confirmSave} onOpenChange={(open) => !busy && setConfirmSave(open)}>
        <AlertDialogContent data-testid="role-save-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>Save changes to {role?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {affected === null
                ? "Every member with this role is affected on their next request."
                : `Affects ${affected} member${affected === 1 ? "" : "s"} on their next request.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="max-h-[40vh] space-y-1 overflow-y-auto text-sm">
            {nameChanged && (
              <div>
                Name: {role?.name} → {trimmedName}
              </div>
            )}
            {descriptionChanged && <div>Description updated</div>}
            {diff.added.map((key) => (
              <div key={`+${key}`} className="text-success">
                + {permissionLabel(key, catalog)} <span className="font-mono text-xs text-muted-foreground">{key}</span>
              </div>
            ))}
            {diff.removed.map((key) => (
              <div key={`-${key}`} className="text-destructive">
                − {permissionLabel(key, catalog)} <span className="font-mono text-xs text-muted-foreground">{key}</span>
              </div>
            ))}
            {addsPrivileged && (
              <p className="pt-1 text-xs text-muted-foreground">
                Admin permissions require every member of this role to have All funnels; otherwise the save is refused.
              </p>
            )}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy !== null}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                void onSave();
              }}
              disabled={busy !== null}
            >
              {busy === "save" && <Loader2 className="h-4 w-4 animate-spin" />}
              Save role
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmDelete} onOpenChange={(open) => !busy && setConfirmDelete(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {role?.name}?</AlertDialogTitle>
            <AlertDialogDescription>The role is removed for good. No member uses it.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy !== null}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                void onDelete();
              }}
              disabled={busy !== null}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {busy === "delete" && <Loader2 className="h-4 w-4 animate-spin" />}
              Delete role
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Sheet>
  );
}
