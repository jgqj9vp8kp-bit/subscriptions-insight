// Role picker of the member sheet and the "Add member" dialog. Roles the acting
// admin may not assign (admin roles unless Owner, roles beyond their own
// permissions) are listed but disabled with a short reason; the server
// enforces the same rules (assert_can_assign_role).

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { isPrivilegedRole, roleAssignBlockReason, type AdminActor } from "@/components/admin/accessAdminModel";
import type { AdminRole } from "@/services/accessAdminClient";

export interface RoleSelectProps {
  roles: readonly AdminRole[];
  value: string;
  onChange: (roleId: string) => void;
  actor: AdminActor;
  disabled?: boolean;
  id?: string;
  placeholder?: string;
}

export function RoleSelect({ roles, value, onChange, actor, disabled = false, id, placeholder = "Select a role" }: RoleSelectProps) {
  return (
    <Select value={value || undefined} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger id={id} className="h-9" aria-label="Role">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {roles.map((role) => {
          // The current value stays selectable so the trigger can render it.
          const reason = role.id === value ? null : roleAssignBlockReason(role, actor);
          return (
            <SelectItem key={role.id} value={role.id} disabled={Boolean(reason)} title={reason ?? undefined}>
              {role.name}
              {!role.is_owner && isPrivilegedRole(role) ? " · admin" : ""}
              {reason ? " (not allowed)" : ""}
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}
