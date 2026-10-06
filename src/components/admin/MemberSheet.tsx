// Member detail sheet of Admin → Members (plan §15): General (role, name,
// status), Page / feature access (read-only preview of the role, with an "Edit
// role" link), Data access (FunnelScopePicker) and Effective access (what the
// server resolves for the member right now). There are no per-user overrides
// in v1: capabilities come from the role.
//
// Role / name / scope edits are saved together (planMemberSave orders the
// calls so the server's "admin roles require All funnels" rule never trips).
// Status changes go through the parent's confirm dialog. Locked memberships
// (yourself, the data owner, admin members unless you are the Owner) are
// read-only with the reason shown; the server enforces the same rules.

import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Loader2, Lock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { EffectiveAccessPanel } from "@/components/admin/EffectiveAccessPanel";
import { FunnelScopePicker } from "@/components/admin/FunnelScopePicker";
import { RoleSelect } from "@/components/admin/RoleSelect";
import { useAccessAdminMutation, useMemberEffectiveAccess } from "@/components/admin/useAccessAdmin";
import {
  groupPermissions,
  isPrivilegedRole,
  isSelfMember,
  memberDisplayName,
  memberEditBlockReason,
  planMemberSave,
  type AdminActor,
  type MemberDraft,
} from "@/components/admin/accessAdminModel";
import {
  describeAccessAdminError,
  setAccessMemberScope,
  updateAccessMember,
  type AdminFunnelOption,
  type AdminFunnelScope,
  type AdminMember,
  type AdminRole,
} from "@/services/accessAdminClient";
import type { PermissionDef } from "../../../supabase/functions/_shared/access/permissions.ts";

export interface MemberSheetProps {
  member: AdminMember | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  roles: readonly AdminRole[];
  funnels: readonly AdminFunnelOption[];
  funnelsLoading?: boolean;
  catalog?: readonly PermissionDef[];
  actor: AdminActor;
  canManage: boolean;
  canViewRoles: boolean;
  onRequestStatusChange: (member: AdminMember, next: "active" | "disabled") => void;
}

function draftOf(member: AdminMember): MemberDraft {
  return {
    roleId: member.role.id,
    displayName: member.display_name,
    scope: { mode: member.funnel_scope.mode, funnel_ids: [...member.funnel_scope.funnel_ids] },
  };
}

function scopeKey(scope: AdminFunnelScope): string {
  return `${scope.mode}:${[...scope.funnel_ids].sort().join(",")}`;
}

function SectionTitle({ children, hint }: { children: string; hint?: string }) {
  return (
    <div className="mb-2">
      <h3 className="text-sm font-semibold text-foreground">{children}</h3>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function RoleGrants({ role, catalog }: { role: AdminRole | undefined; catalog?: readonly PermissionDef[] }) {
  const groups = useMemo(() => {
    if (!role || !catalog?.length) return [];
    const granted = new Set(role.permissions);
    return groupPermissions(catalog)
      .map((group) => ({ ...group, permissions: group.permissions.filter((def) => granted.has(def.key)) }))
      .filter((group) => group.permissions.length > 0);
  }, [role, catalog]);
  if (!role) return <p className="text-xs text-muted-foreground">Pick a role to see what it grants.</p>;
  if (role.is_owner) return <p className="text-xs text-muted-foreground">The Owner role has every permission.</p>;
  if (!catalog?.length) return <p className="text-xs text-muted-foreground">{role.permissions.length} permissions.</p>;
  if (!groups.length) return <p className="text-xs text-muted-foreground">This role grants no permissions.</p>;
  return (
    <div className="space-y-2">
      {groups.map((group) => (
        <div key={group.area}>
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{group.label}</div>
          <div className="mt-1 flex flex-wrap gap-1">
            {group.permissions.map((def) => (
              <Badge key={def.key} variant="secondary" className="text-xs font-normal" title={def.key}>
                {def.label}
              </Badge>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function MemberSheet({
  member,
  open,
  onOpenChange,
  roles,
  funnels,
  funnelsLoading = false,
  catalog,
  actor,
  canManage,
  canViewRoles,
  onRequestStatusChange,
}: MemberSheetProps) {
  const { toast } = useToast();
  const { run } = useAccessAdminMutation();
  const [draft, setDraft] = useState<MemberDraft | null>(member ? draftOf(member) : null);
  const [saving, setSaving] = useState(false);
  const effective = useMemberEffectiveAccess(member?.id ?? null, open && Boolean(member));

  // Re-seed the draft whenever the saved member changes (another member, or
  // this one after a save / refetch).
  const memberKey = member
    ? `${member.id}|${member.access_version}|${member.display_name}|${member.role.id}|${member.status}|${scopeKey(member.funnel_scope)}`
    : "";
  useEffect(() => {
    setDraft(member ? draftOf(member) : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memberKey]);

  const memberRole = member ? roles.find((role) => role.id === member.role.id) : undefined;
  const lockReason = member
    ? !canManage
      ? "You can view members but not change them."
      : memberEditBlockReason(member, memberRole, actor)
    : null;
  // The data owner may still be renamed (by the Owner, never by themselves);
  // role, status and scope are fixed.
  const nameEditable =
    Boolean(member) && canManage && (!lockReason || (member?.is_data_owner === true && actor.isOwner && !isSelfMember(member, actor)));
  const accessEditable = !lockReason;

  const current = draft ?? (member ? draftOf(member) : null);
  const draftRole = current ? roles.find((role) => role.id === current.roleId) : undefined;
  const requireAll = isPrivilegedRole(draftRole);
  const steps = member && current ? planMemberSave(member, current) : [];
  const dirty = steps.length > 0;

  function setRole(roleId: string) {
    setDraft((previous) => {
      if (!previous) return previous;
      const role = roles.find((entry) => entry.id === roleId);
      // Admin roles need All funnels: switch the draft scope with the role.
      const scope = isPrivilegedRole(role) ? { mode: "all" as const, funnel_ids: [] } : previous.scope;
      return { ...previous, roleId, scope };
    });
  }

  async function onSave() {
    if (!member || !current || !dirty || saving) return;
    setSaving(true);
    const warnings: string[] = [];
    try {
      for (const step of planMemberSave(member, current)) {
        if (step.kind === "update") {
          const result = await run(() =>
            updateAccessMember({
              member_id: member.id,
              ...(step.role_id !== undefined ? { role_id: step.role_id } : {}),
              ...(step.display_name !== undefined ? { display_name: step.display_name } : {}),
            }),
          );
          warnings.push(...result.warnings);
        } else {
          await run(() => setAccessMemberScope({ member_id: member.id, mode: step.mode, funnel_ids: step.funnel_ids }));
        }
      }
      toast({
        title: "Member updated",
        description: warnings.length ? `${memberDisplayName(member)}. Warning: ${warnings.join(", ")}` : memberDisplayName(member),
      });
    } catch (error) {
      toast({ title: "Could not update member", description: describeAccessAdminError(error), variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet open={open && Boolean(member)} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-xl" data-testid="member-sheet">
        {member && current && (
          <>
            <SheetHeader className="space-y-1 border-b border-border px-6 py-4 pr-12 text-left">
              <SheetTitle className="truncate text-base">{memberDisplayName(member)}</SheetTitle>
              <SheetDescription className="truncate">{member.email || "No email on record"}</SheetDescription>
              <div className="flex flex-wrap gap-1 pt-1">
                <Badge variant={member.role.is_owner ? "default" : "secondary"} className="text-xs font-normal">
                  {member.role.name || "Unknown role"}
                </Badge>
                {member.is_data_owner && (
                  <Badge variant="outline" className="text-xs font-normal">
                    Data owner
                  </Badge>
                )}
                <Badge variant="outline" className={`text-xs font-normal ${member.status === "active" ? "text-success" : "text-muted-foreground"}`}>
                  {member.status === "active" ? "Active" : "Disabled"}
                </Badge>
              </div>
            </SheetHeader>

            <div className="flex-1 space-y-5 overflow-y-auto px-6 py-4">
              {lockReason && (
                <div role="status" className="flex items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                  <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{lockReason}</span>
                </div>
              )}

              <section>
                <SectionTitle>General</SectionTitle>
                <div className="grid gap-3">
                  <div className="grid gap-1.5">
                    <Label htmlFor="member-role" className="text-xs text-muted-foreground">
                      Role
                    </Label>
                    <RoleSelect id="member-role" roles={roles} value={current.roleId} onChange={setRole} actor={actor} disabled={!accessEditable || saving} />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="member-name" className="text-xs text-muted-foreground">
                      Display name
                    </Label>
                    <Input
                      id="member-name"
                      value={current.displayName}
                      maxLength={120}
                      disabled={!nameEditable || saving}
                      onChange={(event) => setDraft((previous) => (previous ? { ...previous, displayName: event.target.value } : previous))}
                      placeholder="Optional"
                      className="h-9"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={member.status === "active"}
                      disabled={!accessEditable || saving}
                      onCheckedChange={(checked) => onRequestStatusChange(member, checked ? "active" : "disabled")}
                      aria-label={member.status === "active" ? "Disable member" : "Enable member"}
                    />
                    <span className="text-sm">{member.status === "active" ? "Active" : "Disabled"}</span>
                    <span className="text-xs text-muted-foreground">Disabling blocks every request right away.</span>
                  </div>
                </div>
              </section>

              <Separator />

              <section>
                <div className="mb-2 flex items-start justify-between gap-2">
                  <SectionTitle hint="Comes from the role; there are no per-member overrides.">Page / feature access</SectionTitle>
                  {canViewRoles && draftRole && (
                    <Button asChild variant="link" size="sm" className="h-auto px-0 text-xs">
                      <Link to={`/admin/roles?role=${encodeURIComponent(draftRole.id)}`}>Edit role</Link>
                    </Button>
                  )}
                </div>
                <RoleGrants role={draftRole} catalog={catalog} />
              </section>

              <Separator />

              <section>
                <SectionTitle hint="Which funnels' data this member can retrieve.">Data access</SectionTitle>
                <FunnelScopePicker
                  idPrefix={`member-${member.id}`}
                  value={current.scope}
                  onChange={(scope) => setDraft((previous) => (previous ? { ...previous, scope } : previous))}
                  funnels={funnels}
                  loading={funnelsLoading}
                  disabled={!accessEditable || saving}
                  requireAll={requireAll}
                />
              </section>

              <Separator />

              <section>
                <SectionTitle hint="What the server resolves for this member right now.">Effective access</SectionTitle>
                <EffectiveAccessPanel
                  effective={effective.data}
                  loading={effective.isLoading}
                  error={effective.error}
                  onRetry={() => void effective.refetch()}
                  funnelsTotal={funnels.length || null}
                  catalog={catalog}
                  stale={dirty}
                />
              </section>
            </div>

            <SheetFooter className="gap-2 border-t border-border px-6 py-3">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
                Close
              </Button>
              {canManage && (
                <Button type="button" onClick={() => void onSave()} disabled={!dirty || saving || (!accessEditable && !nameEditable)}>
                  {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                  Save changes
                </Button>
              )}
            </SheetFooter>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
