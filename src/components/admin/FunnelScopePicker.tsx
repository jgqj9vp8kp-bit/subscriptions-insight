// Funnel data-scope picker (plan §17): All funnels / Selected funnels / No data
// access. "Selected" opens a searchable multi-select over the funnel registry
// (funnels.list) showing the display name, the granted path chips (active and
// retired) and tags. "Select by tag" expands a tag into the funnel ids that
// carry it NOW: tags are never dynamic grants. Roles with admin permissions
// require All funnels (D10), so the restricted modes are locked for them.
//
// Access Phase 2: restricted scopes are live on the media-buyer surfaces only
// (Dashboard Revenue Intelligence, Cohorts, Funnels, FB-Analytics); every other
// page refuses a member without All funnels. With `coverage` the picker shows
// what the selection covers in the active cohort snapshot (ScopeImpactPreview).

import { useMemo, useRef } from "react";
import { Check, Info, Tag, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { cn } from "@/lib/utils";
import { FunnelPathChips } from "@/components/access/FunnelPathChips";
import { ScopeImpactPreview } from "@/components/admin/ScopeImpactPreview";
import {
  formatCount,
  funnelIdsWithTag,
  funnelOptionLabel,
  funnelTagCounts,
  grantedPaths,
} from "@/components/admin/accessAdminModel";
import type { AdminFunnelOption, AdminFunnelScope, FunnelCoverage, FunnelScopeMode } from "@/services/accessAdminClient";

/** The pages a funnel-restricted member can open (RESTRICTED_READY_ROUTES). */
export const RESTRICTED_PAGES_NOTICE = "Restricted members can open: Dashboard (Revenue Intelligence), Cohorts, Funnels, FB-Analytics";

const MODES: Array<{ value: FunnelScopeMode; label: string; description: string }> = [
  {
    value: "all",
    label: "All funnels",
    description: "Every funnel, including funnels added later and unattributed data. Required for roles with admin permissions.",
  },
  { value: "selected", label: "Selected funnels", description: "Only the funnels picked below." },
  { value: "none", label: "No data access", description: "The member can sign in but sees no analytics data." },
];

export interface FunnelScopePickerProps {
  value: AdminFunnelScope;
  onChange: (next: AdminFunnelScope) => void;
  funnels: readonly AdminFunnelOption[];
  loading?: boolean;
  disabled?: boolean;
  /** The member's role holds admin permissions: only All funnels is allowed. */
  requireAll?: boolean;
  /** Prefix for the radio ids (two pickers can be mounted at once). */
  idPrefix?: string;
  /** Coverage of the active cohort snapshot (paths.coverage): impact preview
   * and per-funnel user counts. Optional; the picker works without it. */
  coverage?: FunnelCoverage;
  coverageLoading?: boolean;
  coverageError?: unknown;
}

export function FunnelScopePicker({
  value,
  onChange,
  funnels,
  loading = false,
  disabled = false,
  requireAll = false,
  idPrefix = "scope",
  coverage,
  coverageLoading = false,
  coverageError,
}: FunnelScopePickerProps) {
  // Remember the last selection so All → Selected restores it.
  const lastSelection = useRef<string[]>(value.mode === "selected" ? value.funnel_ids : []);
  if (value.mode === "selected") lastSelection.current = value.funnel_ids;

  const byId = useMemo(() => new Map(funnels.map((funnel) => [funnel.id.toLowerCase(), funnel])), [funnels]);
  const selected = useMemo(() => new Set(value.funnel_ids.map((id) => id.toLowerCase())), [value.funnel_ids]);
  const tags = useMemo(() => funnelTagCounts(funnels), [funnels]);
  // Granted paths (active ∪ retired) are what the member's scope resolves to;
  // a funnel_path without a granted row grants nothing.
  const selectedPaths = useMemo(() => {
    const paths = new Set<string>();
    for (const id of selected) {
      for (const entry of grantedPaths(byId.get(id))) paths.add(entry.path);
    }
    return paths.size;
  }, [byId, selected]);
  const usersByFunnel = useMemo(
    () => (coverage ? new Map(coverage.funnels.map((entry) => [entry.funnel_id.toLowerCase(), entry.users])) : null),
    [coverage],
  );

  function setMode(mode: FunnelScopeMode) {
    if (disabled) return;
    if (requireAll && mode !== "all") return;
    onChange({ mode, funnel_ids: mode === "selected" ? [...lastSelection.current] : [] });
  }

  function setIds(ids: Iterable<string>) {
    const unique = [...new Set([...ids].map((id) => id.toLowerCase()))];
    onChange({ mode: "selected", funnel_ids: unique });
  }

  function toggle(id: string) {
    if (disabled) return;
    const key = id.toLowerCase();
    setIds(selected.has(key) ? [...selected].filter((entry) => entry !== key) : [...selected, key]);
  }

  return (
    <div className="space-y-3" data-testid="funnel-scope-picker">
      <RadioGroup value={value.mode} onValueChange={(mode) => setMode(mode as FunnelScopeMode)} disabled={disabled} className="gap-2">
        {MODES.map((mode) => {
          const locked = requireAll && mode.value !== "all";
          return (
            <div key={mode.value} className={cn("flex items-start gap-2", locked && "opacity-50")}>
              <RadioGroupItem
                value={mode.value}
                id={`${idPrefix}-${mode.value}`}
                className="mt-0.5"
                disabled={disabled || locked}
                aria-label={mode.label}
              />
              <Label htmlFor={`${idPrefix}-${mode.value}`} className="grid gap-0.5 font-normal">
                <span className="text-sm font-medium">{mode.label}</span>
                <span className="text-xs text-muted-foreground">{mode.description}</span>
              </Label>
            </div>
          );
        })}
      </RadioGroup>

      {requireAll && (
        <p className="text-xs text-muted-foreground">This role includes admin permissions, so the member must have All funnels.</p>
      )}

      {value.mode !== "all" && (
        <div
          role="status"
          className="flex items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
          data-testid="scope-restricted-notice"
        >
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            {value.mode === "none" ? "This member will see no analytics data. " : ""}
            {RESTRICTED_PAGES_NOTICE}.
          </span>
        </div>
      )}

      {value.mode === "selected" && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span data-testid="scope-selection-count">
              {selected.size} of {funnels.length} funnels selected · {selectedPaths} path{selectedPaths === 1 ? "" : "s"}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="ml-auto h-7 text-xs"
              disabled={disabled || !selected.size}
              onClick={() => setIds([])}
            >
              Clear
            </Button>
          </div>

          {selected.size > 0 && (
            <div className="flex flex-wrap gap-1">
              {[...selected].map((id) => {
                const funnel = byId.get(id);
                return (
                  <Badge key={id} variant="secondary" className={cn("gap-1 pr-1 text-xs font-normal", !funnel && "text-warning")}>
                    <span className="max-w-[200px] truncate">{funnelOptionLabel(funnel, id)}</span>
                    {!disabled && (
                      <button
                        type="button"
                        className="rounded-sm opacity-60 hover:opacity-100"
                        onClick={() => toggle(id)}
                        aria-label={`Remove ${funnelOptionLabel(funnel, id)}`}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    )}
                  </Badge>
                );
              })}
            </div>
          )}

          {tags.length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              <span className="mr-1 inline-flex items-center gap-1 text-xs text-muted-foreground">
                <Tag className="h-3 w-3" />
                Select by tag:
              </span>
              {tags.map(({ tag, count }) => (
                <Button
                  key={tag}
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-6 px-2 text-xs font-normal"
                  disabled={disabled}
                  onClick={() => setIds([...selected, ...funnelIdsWithTag(funnels, tag)])}
                  title={`Adds the ${count} funnel${count === 1 ? "" : "s"} tagged "${tag}" now. Funnels tagged later are not added automatically.`}
                >
                  {tag}
                  <span className="text-muted-foreground">{count}</span>
                </Button>
              ))}
            </div>
          )}

          <ScopeImpactPreview scope={value} funnels={funnels} coverage={coverage} loading={coverageLoading} error={coverageError} />

          <Command className="rounded-md border border-border">
            <CommandInput placeholder="Search funnels…" disabled={disabled} />
            <CommandList className="max-h-64">
              <CommandEmpty>{loading ? "Loading funnels…" : "No funnels found."}</CommandEmpty>
              <CommandGroup>
                {funnels.map((funnel) => {
                  const isSelected = selected.has(funnel.id.toLowerCase());
                  const users = usersByFunnel ? usersByFunnel.get(funnel.id.toLowerCase()) ?? 0 : null;
                  return (
                    <CommandItem
                      key={funnel.id}
                      value={`${funnel.display_name} ${funnel.funnel_path} ${grantedPaths(funnel).map((entry) => entry.path).join(" ")} ${funnel.tags.join(" ")} ${funnel.id}`}
                      onSelect={() => toggle(funnel.id)}
                      disabled={disabled}
                      className={cn("items-start gap-2", !funnel.is_active && "text-muted-foreground")}
                      data-testid={`scope-funnel-${funnel.id}`}
                      data-checked={isSelected ? "true" : "false"}
                    >
                      <span
                        className={cn(
                          "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border border-primary",
                          isSelected ? "bg-primary text-primary-foreground" : "opacity-50",
                        )}
                      >
                        {isSelected && <Check className="h-3 w-3" />}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="truncate text-sm">{funnel.display_name || funnel.funnel_path}</span>
                          {!funnel.is_active && (
                            <Badge variant="outline" className="text-[10px] font-normal text-muted-foreground">
                              inactive
                            </Badge>
                          )}
                          {users !== null && (
                            <span className={cn("ml-auto text-[11px]", users > 0 ? "text-muted-foreground" : "text-warning")}>
                              {users > 0 ? `${formatCount(users)} users` : "no data"}
                            </span>
                          )}
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-1">
                          {grantedPaths(funnel).length > 0 ? (
                            <FunnelPathChips paths={funnel.paths} />
                          ) : (
                            <Badge variant="outline" className="text-[10px] font-normal text-warning" title={funnel.funnel_path || undefined}>
                              no granted path
                            </Badge>
                          )}
                          {funnel.tags.map((tag) => (
                            <Badge key={tag} variant="secondary" className="text-[10px] font-normal">
                              {tag}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            </CommandList>
          </Command>
          <p className="text-xs text-muted-foreground">
            Paths no funnel holds, unattributed data and campaigns shared with other funnels stay hidden for members with
            selected funnels.
          </p>
        </div>
      )}
    </div>
  );
}
