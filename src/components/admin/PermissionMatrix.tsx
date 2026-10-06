// Permission matrix of the role editor (plan §16): catalog keys grouped by
// area, one checkbox per key, badges for sensitive keys and for keys that only
// work with "All funnels". Checking a key auto-checks what it requires;
// unchecking cascades to its dependants (togglePermission). Keys the acting
// admin may not grant are locked with the reason as a tooltip. UX only: the
// server validates and re-checks every save.

import { useMemo } from "react";
import { Lock, Minus, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import {
  dependantsOf,
  groupPermissions,
  inCatalogOrder,
  requirementClosure,
  togglePermission,
} from "@/components/admin/accessAdminModel";
import type { PermissionDef } from "../../../supabase/functions/_shared/access/permissions.ts";

const SENSITIVE_BADGES: Record<NonNullable<PermissionDef["sensitive"]>, { label: string; className: string }> = {
  pii: { label: "PII", className: "border-warning/50 text-warning" },
  export: { label: "Export", className: "border-primary/40 text-primary" },
  admin: { label: "Admin", className: "border-destructive/40 text-destructive" },
  cost: { label: "Cost", className: "border-border text-muted-foreground" },
};

export interface PermissionMatrixProps {
  catalog: readonly PermissionDef[];
  /** Granted keys. */
  value: readonly string[];
  onChange?: (next: string[]) => void;
  /** Everything locked (Owner role, no manage permission, ...). */
  readOnly?: boolean;
  /** Per-key grant lock (anti-escalation UX); null = grantable. */
  blockReason?: (def: PermissionDef) => string | null;
  /** The saved set: rows that differ are marked +/−. */
  baseline?: readonly string[];
  /** Keys to tag "New" (template permissions the role does not hold yet). */
  highlight?: ReadonlySet<string>;
}

export function PermissionMatrix({ catalog, value, onChange, readOnly = false, blockReason, baseline, highlight }: PermissionMatrixProps) {
  const groups = useMemo(() => groupPermissions(catalog), [catalog]);
  const granted = useMemo(() => new Set(value), [value]);
  const saved = useMemo(() => (baseline ? new Set(baseline) : null), [baseline]);
  const labels = useMemo(() => new Map(catalog.map((def) => [def.key, def.label])), [catalog]);

  // A key is lockable on its own (blockReason) or because checking it would
  // also have to grant a requirement the admin cannot grant.
  const lockOf = useMemo(() => {
    const own = new Map<string, string | null>();
    for (const def of catalog) own.set(def.key, blockReason ? blockReason(def) : def.status === "enforced" ? null : "Coming soon: not enforced yet.");
    return (def: PermissionDef): string | null => {
      const reason = own.get(def.key) ?? null;
      if (reason) return reason;
      for (const required of requirementClosure(catalog, [def.key])) {
        if (required === def.key || granted.has(required)) continue;
        if (own.get(required)) return `Requires ${labels.get(required) ?? required}, which you cannot grant.`;
      }
      return null;
    };
  }, [catalog, blockReason, granted, labels]);

  const editable = !readOnly && Boolean(onChange);

  function setKey(def: PermissionDef, checked: boolean) {
    if (!editable) return;
    // Unchecking is always allowed for unlocked keys; dependants that are
    // locked would be removed too, so refuse when one of them is locked.
    if (!checked) {
      const lockedDependant = [...dependantsOf(catalog, def.key)].find((key) => granted.has(key) && lockOf(catalog.find((entry) => entry.key === key) as PermissionDef));
      if (lockedDependant) return;
    } else if (lockOf(def)) {
      return;
    }
    onChange?.(togglePermission(catalog, value, def.key, checked));
  }

  function setGroup(defs: PermissionDef[], checked: boolean) {
    if (!editable) return;
    let next = [...value];
    for (const def of defs) {
      if (lockOf(def)) continue;
      if (checked && !next.includes(def.key)) next = togglePermission(catalog, next, def.key, true);
      if (!checked && next.includes(def.key)) {
        const lockedDependant = [...dependantsOf(catalog, def.key)].some((key) => next.includes(key) && lockOf(catalog.find((entry) => entry.key === key) as PermissionDef));
        if (!lockedDependant) next = togglePermission(catalog, next, def.key, false);
      }
    }
    onChange?.(inCatalogOrder(catalog, next));
  }

  return (
    <div className="space-y-4" data-testid="permission-matrix">
      {groups.map((group) => {
        const offered = group.permissions.filter((def) => def.status === "enforced");
        const count = offered.filter((def) => granted.has(def.key)).length;
        const groupState: boolean | "indeterminate" = count === 0 ? false : count === offered.length ? true : "indeterminate";
        const groupLocked = !editable || offered.every((def) => Boolean(lockOf(def)));
        return (
          <section key={group.area} className="rounded-md border border-border">
            <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-3 py-2">
              <Checkbox
                checked={groupState}
                disabled={groupLocked || offered.length === 0}
                onCheckedChange={(checked) => setGroup(offered, checked === true)}
                aria-label={`All ${group.label} permissions`}
              />
              <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{group.label}</h4>
              <span className="ml-auto text-xs text-muted-foreground">
                {count}/{offered.length}
              </span>
            </div>
            <ul className="divide-y divide-border">
              {group.permissions.map((def) => {
                const checked = granted.has(def.key);
                const lock = editable ? lockOf(def) : null;
                const disabled = !editable || Boolean(lock) || def.status !== "enforced";
                const changed = saved ? saved.has(def.key) !== checked : false;
                const requires = def.requires.map((key) => labels.get(key) ?? key);
                return (
                  <li
                    key={def.key}
                    className={cn("flex items-start gap-3 px-3 py-2", changed && "bg-primary/5", def.status !== "enforced" && "opacity-60")}
                    title={lock ?? undefined}
                    data-permission={def.key}
                  >
                    <Checkbox
                      id={`perm-${def.key}`}
                      className="mt-0.5"
                      checked={checked}
                      disabled={disabled}
                      onCheckedChange={(next) => setKey(def, next === true)}
                      aria-label={def.label}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <label htmlFor={`perm-${def.key}`} className={cn("text-sm font-medium", !disabled && "cursor-pointer")}>
                          {def.label}
                        </label>
                        <span className="font-mono text-[11px] text-muted-foreground">{def.key}</span>
                        {def.sensitive && (
                          <Badge variant="outline" className={cn("text-[10px] font-normal", SENSITIVE_BADGES[def.sensitive].className)}>
                            {SENSITIVE_BADGES[def.sensitive].label}
                          </Badge>
                        )}
                        {def.requiresFullScope && (
                          <Badge
                            variant="outline"
                            className="text-[10px] font-normal text-muted-foreground"
                            title="Only effective for members with access to All funnels."
                          >
                            Requires all funnels
                          </Badge>
                        )}
                        {def.status !== "enforced" && (
                          <Badge variant="outline" className="text-[10px] font-normal text-muted-foreground">
                            Coming soon
                          </Badge>
                        )}
                        {highlight?.has(def.key) && !checked && (
                          <Badge variant="secondary" className="text-[10px] font-normal">
                            New
                          </Badge>
                        )}
                        {changed && (
                          <span className={cn("inline-flex items-center text-[11px]", checked ? "text-success" : "text-destructive")}>
                            {checked ? <Plus className="h-3 w-3" /> : <Minus className="h-3 w-3" />}
                            {checked ? "added" : "removed"}
                          </span>
                        )}
                        {lock && def.status === "enforced" && <Lock className="h-3 w-3 text-muted-foreground" aria-label={lock} />}
                      </div>
                      {def.description && <p className="text-xs text-muted-foreground">{def.description}</p>}
                      {requires.length > 0 && <p className="text-[11px] text-muted-foreground">Requires: {requires.join(", ")}</p>}
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
