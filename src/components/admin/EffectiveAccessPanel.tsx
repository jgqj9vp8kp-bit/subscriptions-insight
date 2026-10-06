// Effective access of one member (plan §15 "Access Preview (v1)"): what the
// server says the member can do right now (members.effective), rendered with
// the SAME route table the member's own app uses (ROUTE_ACCESS +
// accessRuleDenial), so "Pages 4/13" and the sidebar preview match what they
// will see. A funnel-restricted member (selected funnels / no data) also gets
// the granted paths their scope resolves to and the pages hidden only because
// of the restriction. Read-only; no impersonation.

import { useMemo } from "react";
import {
  BarChart3,
  Calculator,
  FileText,
  Filter,
  Headphones,
  Layers,
  LayoutDashboard,
  Loader2,
  Plug,
  Receipt,
  Repeat,
  Route,
  ScrollText,
  ShieldCheck,
  Upload,
  UserCog,
  UserPlus,
  Users,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { capabilitySummary, listText, previewPages, type PagePreview } from "@/components/admin/accessAdminModel";
import { describeAccessAdminError, type EffectiveAccess } from "@/services/accessAdminClient";
import type { PermissionDef } from "../../../supabase/functions/_shared/access/permissions.ts";

/** Same icons as the app sidebar (AppSidebar.tsx). */
const PAGE_ICONS: Readonly<Record<string, LucideIcon>> = {
  "/": LayoutDashboard,
  "/transactions": Receipt,
  "/users": Users,
  "/leads": UserPlus,
  "/cohorts": Layers,
  "/funnels": Route,
  "/reports": FileText,
  "/fb-analytics": BarChart3,
  "/integrations": Plug,
  "/support": Headphones,
  "/forecasting": Calculator,
  "/subscriptions": Repeat,
  "/import": Upload,
  "/admin/members": UserCog,
  "/admin/roles": ShieldCheck,
  "/admin/audit": ScrollText,
  "/admin/funnels": Filter,
};

export interface EffectiveAccessPanelProps {
  effective: EffectiveAccess | null | undefined;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  /** Size of the funnel registry, for "Funnels 3/42". */
  funnelsTotal?: number | null;
  catalog?: readonly PermissionDef[];
  /** The sheet holds unsaved edits: the panel still shows the saved state. */
  stale?: boolean;
}

function OnOff({ label, on, title }: { label: string; on: boolean; title?: string }) {
  return (
    <Badge
      variant={on ? "secondary" : "outline"}
      className={cn("text-xs font-normal", !on && "text-muted-foreground")}
      title={title}
      data-testid={`capability-${label.toLowerCase()}`}
    >
      {label} {on ? "on" : "off"}
    </Badge>
  );
}

function SidebarPreview({ pages }: { pages: PagePreview[] }) {
  const workspace = pages.filter((page) => page.group === "workspace" && page.allowed);
  const admin = pages.filter((page) => page.group === "admin" && page.allowed);
  const renderGroup = (label: string, items: PagePreview[]) =>
    items.length > 0 && (
      <div>
        <div className="px-2 pb-1 text-[11px] font-medium text-muted-foreground">{label}</div>
        <ul className="space-y-0.5">
          {items.map((page) => {
            const Icon = PAGE_ICONS[page.path] ?? LayoutDashboard;
            return (
              <li key={page.path} className="flex items-center gap-2 rounded-md px-2 py-1 text-xs text-foreground">
                <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                {page.title}
              </li>
            );
          })}
        </ul>
      </div>
    );
  return (
    <div className="space-y-2 rounded-md border border-border bg-muted/30 p-2" aria-label="Sidebar preview" data-testid="sidebar-preview">
      {workspace.length === 0 && admin.length === 0 ? (
        <p className="px-2 py-1 text-xs text-muted-foreground">No pages.</p>
      ) : (
        <>
          {renderGroup("Workspace", workspace)}
          {renderGroup("Administration", admin)}
        </>
      )}
    </div>
  );
}

export function EffectiveAccessPanel({ effective, loading = false, error, onRetry, funnelsTotal, catalog, stale = false }: EffectiveAccessPanelProps) {
  const pages = useMemo(() => (effective ? previewPages(effective) : []), [effective]);
  const capabilities = useMemo(() => capabilitySummary(effective?.permissions ?? [], catalog), [effective, catalog]);

  if (loading && !effective) {
    return (
      <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading effective access…
      </div>
    );
  }
  if (!effective) {
    return (
      <div className="flex flex-wrap items-center gap-2 py-2 text-sm text-muted-foreground">
        <span>{error ? `Could not load effective access: ${describeAccessAdminError(error)}` : "No effective access to show."}</span>
        {error && onRetry && (
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            Retry
          </Button>
        )}
      </div>
    );
  }

  const active = effective.status === "active";
  const allowedPages = pages.filter((page) => page.allowed);
  const scopeHiddenPages = pages.filter((page) => page.denial === "scope");
  const hiddenPages = pages.filter((page) => !page.allowed && page.denial !== "scope");
  const scope = effective.funnel_scope;
  const funnelsText =
    scope.mode === "all"
      ? "All funnels"
      : scope.mode === "none"
        ? "No data"
        : `Funnels ${scope.funnel_ids.length}${typeof funnelsTotal === "number" ? `/${funnelsTotal}` : ""}`;

  return (
    <div className="space-y-3" data-testid="effective-access">
      {stale && <p className="text-xs text-muted-foreground">Showing the saved access. Save to apply your changes.</p>}
      {!active && (
        <div role="status" className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          This membership is disabled: the member has no access at all.
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <Badge variant="outline" className="text-xs font-normal" data-testid="effective-pages">
          Pages {allowedPages.length}/{pages.length}
        </Badge>
        <Badge variant="outline" className="text-xs font-normal" data-testid="effective-funnels">
          {funnelsText}
        </Badge>
        <OnOff label="Export" on={capabilities.exports.length > 0} title={capabilities.exports.join(", ") || undefined} />
        <OnOff label="PII" on={capabilities.pii.length > 0} title={capabilities.pii.join(", ") || undefined} />
        <OnOff label="AI" on={capabilities.ai} />
        <OnOff label="Admin" on={capabilities.admin.length > 0} title={capabilities.admin.join(", ") || undefined} />
        {effective.raw_access && (
          <Badge variant="secondary" className="text-xs font-normal" title="Raw downloads and browser-computed pages (data owner only).">
            Data owner
          </Badge>
        )}
      </div>

      {scope.mode === "selected" && scope.names.length > 0 && (
        <p className="text-xs text-muted-foreground">Funnels: {listText(scope.names, 8)}</p>
      )}
      {scope.mode === "selected" && (
        <p className="text-xs text-muted-foreground" data-testid="effective-paths">
          {scope.paths.length
            ? `Paths: ${listText(scope.paths, 8)}`
            : "Paths: none granted. The selected funnels have no active or retired path, so this member sees no data."}
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-[minmax(0,180px)_1fr]">
        <SidebarPreview pages={pages} />
        <div className="space-y-1 text-xs">
          <div className="text-muted-foreground">Can open</div>
          <div className="text-foreground">{allowedPages.length ? allowedPages.map((page) => page.title).join(", ") : "Nothing"}</div>
          {scopeHiddenPages.length > 0 && (
            <>
              <div className="pt-1 text-muted-foreground">Hidden by funnel-restricted access</div>
              <div className="text-muted-foreground" data-testid="effective-scope-hidden">
                {scopeHiddenPages.map((page) => page.title).join(", ")}
              </div>
            </>
          )}
          {hiddenPages.length > 0 && (
            <>
              <div className="pt-1 text-muted-foreground">Hidden</div>
              <div className="text-muted-foreground">{hiddenPages.map((page) => page.title).join(", ")}</div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
