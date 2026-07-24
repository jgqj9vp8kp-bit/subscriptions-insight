// Funnels admin registry. Config management, NOT analytics — no spend, CPA,
// conversion or trial metrics belong on this page (see the plan's out-of-scope
// list). Data comes from Postgres via @/services/funnels; ClickHouse is only
// consulted by the "Import from warehouse" bootstrap action (Phase 6).
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronDown, Loader2, RefreshCw, Route } from "lucide-react";
import { AppLayout } from "@/components/AppLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import {
  listFunnels,
  listTags,
  setFunnelActive,
  type FunnelRecord,
  type TagRecord,
} from "@/services/funnels";

type StatusFilter = "all" | "active" | "inactive";
type SortColumn = "display_name" | "funnel_path" | "created_at" | "updated_at";
type SortDirection = "asc" | "desc";

function formatDateTime(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
}

export default function FunnelsPage() {
  const { toast } = useToast();
  const [funnels, setFunnels] = useState<FunnelRecord[]>([]);
  const [tags, setTags] = useState<TagRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [sortColumn, setSortColumn] = useState<SortColumn>("created_at");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [funnelRows, tagRows] = await Promise.all([listFunnels(), listTags()]);
      setFunnels(funnelRows);
      setTags(tagRows);
    } catch (error) {
      toast({
        title: "Could not load funnels",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function onToggleActive(funnel: FunnelRecord) {
    const next = !funnel.is_active;
    setTogglingId(funnel.id);
    // Optimistic: the switch is the primary interaction on this page, so it
    // must feel instant; the row is rolled back if the write fails.
    setFunnels((current) => current.map((row) => (row.id === funnel.id ? { ...row, is_active: next } : row)));
    try {
      await setFunnelActive(funnel.id, next);
      toast({
        title: next ? "Funnel activated" : "Funnel deactivated",
        description: funnel.display_name || funnel.funnel_path,
      });
    } catch (error) {
      setFunnels((current) => current.map((row) => (row.id === funnel.id ? { ...row, is_active: !next } : row)));
      toast({
        title: "Could not update funnel status",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setTogglingId(null);
    }
  }

  const toggleTagFilter = (tagId: string) => {
    setSelectedTagIds((current) =>
      current.includes(tagId) ? current.filter((id) => id !== tagId) : [...current, tagId],
    );
  };

  const tagFilterSummary =
    selectedTagIds.length === 0
      ? "All tags"
      : selectedTagIds.length === 1
        ? tags.find((tag) => tag.id === selectedTagIds[0])?.name ?? "1 tag"
        : `${selectedTagIds.length} tags`;

  const statusSummary =
    statusFilter === "all" ? "All statuses" : statusFilter === "active" ? "Active only" : "Inactive only";

  function onSortColumn(column: SortColumn) {
    if (sortColumn === column) {
      setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
      return;
    }
    setSortColumn(column);
    setSortDirection(column === "created_at" || column === "updated_at" ? "desc" : "asc");
  }

  function sortIcon(column: SortColumn) {
    if (sortColumn !== column) return <ArrowUpDown className="h-3 w-3 opacity-40" />;
    return sortDirection === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />;
  }

  // All filtering is client-side: this table is a few dozen config rows, so a
  // server round-trip per keystroke would be pure latency for no benefit.
  const visibleFunnels = useMemo(() => {
    const query = search.trim().toLowerCase();
    const filtered = funnels.filter((funnel) => {
      if (statusFilter === "active" && !funnel.is_active) return false;
      if (statusFilter === "inactive" && funnel.is_active) return false;
      if (selectedTagIds.length) {
        const funnelTagIds = new Set(funnel.tags.map((tag) => tag.id));
        // OR semantics, matching every other multi-select filter in this app.
        if (!selectedTagIds.some((id) => funnelTagIds.has(id))) return false;
      }
      if (query) {
        const haystack = `${funnel.display_name} ${funnel.funnel_path}`.toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    });

    const direction = sortDirection === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const left = String(a[sortColumn] ?? "");
      const right = String(b[sortColumn] ?? "");
      return left.localeCompare(right) * direction;
    });
  }, [funnels, search, statusFilter, selectedTagIds, sortColumn, sortDirection]);

  const hasFilters = Boolean(search.trim()) || statusFilter !== "all" || selectedTagIds.length > 0;

  return (
    <AppLayout title="Funnels" description="Manage funnel paths, status and tags">
      <Card className="p-4 shadow-card">
        <div className="flex flex-wrap items-center gap-2 border-b border-border pb-3">
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search name or path…"
            className="h-9 w-[240px]"
            aria-label="Search funnels"
          />

          <Popover>
            <PopoverTrigger asChild>
              <Button type="button" variant="outline" size="sm" className="h-9 w-[150px] justify-between gap-2">
                <span className="truncate">{statusSummary}</span>
                <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-48 p-1">
              {([
                ["all", "All statuses"],
                ["active", "Active only"],
                ["inactive", "Inactive only"],
              ] as Array<[StatusFilter, string]>).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setStatusFilter(value)}
                  className={`flex w-full items-center rounded-sm px-2 py-1.5 text-left text-sm hover:bg-muted/50 ${
                    statusFilter === value ? "bg-muted font-medium" : ""
                  }`}
                >
                  {label}
                </button>
              ))}
            </PopoverContent>
          </Popover>

          <Popover>
            <PopoverTrigger asChild>
              <Button type="button" variant="outline" size="sm" className="h-9 w-[170px] justify-between gap-2">
                <span className="truncate">{tagFilterSummary}</span>
                <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-64 p-0">
              <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
                <div>
                  <div className="text-xs font-medium text-muted-foreground">Tag</div>
                  <div className="text-xs text-muted-foreground">All tags by default</div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => setSelectedTagIds([])}
                  disabled={!selectedTagIds.length}
                >
                  Clear
                </Button>
              </div>
              <div className="max-h-72 overflow-auto py-1">
                {tags.length === 0 && <div className="px-3 py-3 text-sm text-muted-foreground">No tags yet</div>}
                {tags.map((tag) => (
                  <label
                    key={tag.id}
                    className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-muted/50"
                  >
                    <Checkbox
                      checked={selectedTagIds.includes(tag.id)}
                      onCheckedChange={() => toggleTagFilter(tag.id)}
                    />
                    <span className="truncate">{tag.name}</span>
                  </label>
                ))}
              </div>
            </PopoverContent>
          </Popover>

          <div className="ml-auto flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {visibleFunnels.length} of {funnels.length}
            </span>
            <Button type="button" variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Refresh
            </Button>
          </div>
        </div>

        <div className="mt-4 overflow-auto rounded-md border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[110px]">Status</TableHead>
                <TableHead>
                  <button
                    type="button"
                    onClick={() => onSortColumn("display_name")}
                    className="inline-flex items-center gap-1 hover:text-foreground"
                  >
                    Display Name {sortIcon("display_name")}
                  </button>
                </TableHead>
                <TableHead>
                  <button
                    type="button"
                    onClick={() => onSortColumn("funnel_path")}
                    className="inline-flex items-center gap-1 hover:text-foreground"
                  >
                    Funnel Path {sortIcon("funnel_path")}
                  </button>
                </TableHead>
                <TableHead>Tags</TableHead>
                <TableHead className="w-[120px]">
                  <button
                    type="button"
                    onClick={() => onSortColumn("created_at")}
                    className="inline-flex items-center gap-1 hover:text-foreground"
                  >
                    Created {sortIcon("created_at")}
                  </button>
                </TableHead>
                <TableHead className="w-[120px]">
                  <button
                    type="button"
                    onClick={() => onSortColumn("updated_at")}
                    className="inline-flex items-center gap-1 hover:text-foreground"
                  >
                    Updated {sortIcon("updated_at")}
                  </button>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleFunnels.length ? (
                visibleFunnels.map((funnel) => (
                  <TableRow key={funnel.id}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Switch
                          checked={funnel.is_active}
                          disabled={togglingId === funnel.id}
                          onCheckedChange={() => void onToggleActive(funnel)}
                          aria-label={`${funnel.is_active ? "Deactivate" : "Activate"} ${funnel.display_name || funnel.funnel_path}`}
                        />
                        <span className={`text-xs ${funnel.is_active ? "text-success" : "text-muted-foreground"}`}>
                          {funnel.is_active ? "Active" : "Inactive"}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="font-medium">
                      {funnel.display_name || <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{funnel.funnel_path}</TableCell>
                    <TableCell>
                      {funnel.tags.length ? (
                        <div className="flex flex-wrap gap-1">
                          {funnel.tags.slice(0, 3).map((tag) => (
                            <Badge key={tag.id} variant="secondary" className="text-xs font-normal">
                              {tag.name}
                            </Badge>
                          ))}
                          {funnel.tags.length > 3 && (
                            <Badge variant="outline" className="text-xs font-normal">
                              +{funnel.tags.length - 3}
                            </Badge>
                          )}
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{formatDateTime(funnel.created_at)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{formatDateTime(funnel.updated_at)}</TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
                    {loading ? (
                      <span className="inline-flex items-center gap-2">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Loading funnels…
                      </span>
                    ) : hasFilters ? (
                      "No funnels match the current filters"
                    ) : (
                      <span className="inline-flex items-center gap-2">
                        <Route className="h-4 w-4" />
                        No funnels registered yet
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </Card>
    </AppLayout>
  );
}
