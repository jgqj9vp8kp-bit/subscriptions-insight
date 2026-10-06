// "Add member" dialog of Admin → Members (plan §15): the email of an EXISTING,
// confirmed Subengine account (v1 has no invites; open question 11), a role and
// a funnel scope. The server looks the account up, requires a confirmed email
// and applies the anti-escalation rules.

import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { FunnelScopePicker } from "@/components/admin/FunnelScopePicker";
import { RoleSelect } from "@/components/admin/RoleSelect";
import { useAccessAdminMutation, usePathCoverage } from "@/components/admin/useAccessAdmin";
import { defaultRoleId, isPrivilegedRole, type AdminActor } from "@/components/admin/accessAdminModel";
import {
  addAccessMember,
  describeAccessAdminError,
  type AdminFunnelOption,
  type AdminFunnelScope,
  type AdminMember,
  type AdminRole,
} from "@/services/accessAdminClient";

export interface AddMemberDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  roles: readonly AdminRole[];
  funnels: readonly AdminFunnelOption[];
  funnelsLoading?: boolean;
  actor: AdminActor;
  onAdded?: (member: AdminMember) => void;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;

export function AddMemberDialog({ open, onOpenChange, roles, funnels, funnelsLoading = false, actor, onAdded }: AddMemberDialogProps) {
  const { toast } = useToast();
  const { run } = useAccessAdminMutation();
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [roleId, setRoleId] = useState("");
  const [scope, setScope] = useState<AdminFunnelScope>({ mode: "all", funnel_ids: [] });
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setEmail("");
    setDisplayName("");
    setRoleId(defaultRoleId(roles, actor));
    setScope({ mode: "all", funnel_ids: [] });
    // Reset only when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const role = useMemo(() => roles.find((entry) => entry.id === roleId), [roles, roleId]);
  const requireAll = isPrivilegedRole(role);
  // The impact preview of the scope picker (selected funnels only).
  const coverage = usePathCoverage(open && !requireAll && scope.mode === "selected");
  const trimmedEmail = email.trim();
  const emailValid = EMAIL_RE.test(trimmedEmail);
  const canSubmit = emailValid && Boolean(role) && !submitting;

  function onRoleChange(next: string) {
    setRoleId(next);
    if (isPrivilegedRole(roles.find((entry) => entry.id === next))) setScope({ mode: "all", funnel_ids: [] });
  }

  async function onSubmit() {
    if (!canSubmit || !role) return;
    setSubmitting(true);
    try {
      const member = await run(() =>
        addAccessMember({
          email: trimmedEmail,
          role_id: role.id,
          scope: requireAll ? { mode: "all", funnel_ids: [] } : scope,
          display_name: displayName.trim() || undefined,
        }),
      );
      toast({ title: "Member added", description: `${member.email || trimmedEmail} can now sign in with the ${role.name} role.` });
      onAdded?.(member);
      onOpenChange(false);
    } catch (error) {
      toast({ title: "Could not add member", description: describeAccessAdminError(error), variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !submitting && onOpenChange(next)}>
      <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add member</DialogTitle>
          <DialogDescription>
            Give an existing Subengine account access to this workspace. The person must already have signed up and
            confirmed their email; access applies on their next request.
          </DialogDescription>
        </DialogHeader>

        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void onSubmit();
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="add-member-email" className="text-xs text-muted-foreground">
              Email
            </Label>
            <Input
              id="add-member-email"
              type="email"
              autoComplete="off"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="name@company.com"
              className="h-9"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="add-member-name" className="text-xs text-muted-foreground">
              Display name (optional)
            </Label>
            <Input
              id="add-member-name"
              value={displayName}
              maxLength={120}
              onChange={(event) => setDisplayName(event.target.value)}
              className="h-9"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="add-member-role" className="text-xs text-muted-foreground">
              Role
            </Label>
            <RoleSelect id="add-member-role" roles={roles} value={roleId} onChange={onRoleChange} actor={actor} />
          </div>
          <div className="grid gap-1.5">
            <span className="text-xs text-muted-foreground">Data access</span>
            <FunnelScopePicker
              idPrefix="add-member-scope"
              value={requireAll ? { mode: "all", funnel_ids: [] } : scope}
              onChange={setScope}
              funnels={funnels}
              loading={funnelsLoading}
              requireAll={requireAll}
              coverage={coverage.data}
              coverageLoading={coverage.isLoading}
              coverageError={coverage.error}
            />
          </div>
          {/* Lets Enter submit from the text inputs. */}
          <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
        </form>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void onSubmit()} disabled={!canSubmit}>
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
            Add member
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
