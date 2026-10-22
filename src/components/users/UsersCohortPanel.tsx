// The Users page "Cohorts" side panel: product chips, a searchable funnel
// multi-select, one period (presets + custom range), the grouped cohort list
// and its selection. Presentational — the page owns every filter and the
// selection (filters.cohort_ids); the rules live in services/usersCohortPanel.
import { useMemo, useRef, useState } from "react";
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { ArrowDown, ArrowUp, Check, ChevronDown, ChevronRight, Minus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatCurrency } from "@/services/analytics";
import { productKey, type CohortProductOption } from "@/services/cohortProductFilter";
import {
  MAX_SELECTED_COHORTS,
  PERIOD_PRESETS,
  addCohorts,
  groupCohorts,
  groupSelectionState,
  periodProblem,
  removeCohorts,
  type CohortExplorerRow,
  type CohortExplorerSortKey,
  type CohortGroupBy,
  type FunnelOption,
  type PeriodRange,
  type PeriodSelection,
} from "@/services/usersCohortPanel";
import { cn } from "@/lib/utils";

export interface UsersCohortPanelProps {
  /** null hides the product row (map unavailable or not requested). */
  products: CohortProductOption[] | null;
  productCounts: { all: number; byKey: Map<string, number> } | null;
  selectedProducts: string[];
  onToggleProduct: (key: string) => void;
  onClearProducts: () => void;
  funnelOptions: FunnelOption[];
  selectedFunnels: string[];
  onToggleFunnel: (path: string) => void;
  onClearFunnels: () => void;
  periodSelection: PeriodSelection;
  periodRange: PeriodRange;
  onPeriod: (selection: PeriodSelection) => void;
  groupBy: CohortGroupBy;
  onGroupBy: (groupBy: CohortGroupBy) => void;
  sortKey: CohortExplorerSortKey;
  sortDir: "asc" | "desc";
  onSortKey: (key: CohortExplorerSortKey) => void;
  onToggleSortDir: () => void;
  /** The cohorts shown (every filter applied); grouped and sorted here. */
  rows: CohortExplorerRow[];
  selectedIds: Set<string>;
  selectedCount: number;
  hiddenSelectedCount: number;
  onSetCohorts: (ids: string[]) => void;
  onClearSelection: () => void;
  loading: boolean;
}

const count = (value: number) => value.toLocaleString("en-US");
// Whole dollars: cents would not fit the Net column (the exact value is the title).
const money = (value: number) =>
  value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const CAP_NOTE = `Up to ${MAX_SELECTED_COHORTS} cohorts can be selected — narrow the period or funnels.`;

// The shared Checkbox draws ✓ for "indeterminate" (and PermissionMatrix relies
// on that), so the group row draws its own tri-state box.
function TriStateCheckbox({ checked, onCheckedChange, label }: {
  checked: boolean | "indeterminate";
  onCheckedChange: () => void;
  label: string;
}) {
  return (
    <CheckboxPrimitive.Root
      checked={checked}
      onCheckedChange={onCheckedChange}
      aria-label={label}
      className="peer h-4 w-4 shrink-0 rounded-sm border border-primary text-primary-foreground ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 data-[state=checked]:bg-primary data-[state=indeterminate]:bg-primary"
    >
      <CheckboxPrimitive.Indicator className="flex items-center justify-center text-current">
        {checked === "indeterminate" ? <Minus className="h-3.5 w-3.5" /> : <Check className="h-4 w-4" />}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

function funnelSummary(selected: string[]): string {
  if (selected.length === 0) return "All funnels";
  if (selected.length === 1) return selected[0];
  return `${selected.length} funnels`;
}

export function UsersCohortPanel(props: UsersCohortPanelProps) {
  const {
    products, productCounts, selectedProducts, onToggleProduct, onClearProducts,
    funnelOptions, selectedFunnels, onToggleFunnel, onClearFunnels,
    periodSelection, periodRange, onPeriod,
    groupBy, onGroupBy, sortKey, sortDir, onSortKey, onToggleSortDir,
    rows, selectedIds, selectedCount, hiddenSelectedCount, onSetCohorts, onClearSelection, loading,
  } = props;
  const [funnelOpen, setFunnelOpen] = useState(false);
  const [funnelSearch, setFunnelSearch] = useState("");
  const funnelSearchRef = useRef<HTMLInputElement>(null);
  // Expansion overrides belong to one grouping: the keys of the other one
  // (paths vs days) mean nothing there, so switching starts from the defaults.
  const [expansion, setExpansion] = useState<{ groupBy: CohortGroupBy; overrides: Record<string, boolean> }>({ groupBy, overrides: {} });
  const [capHit, setCapHit] = useState(false);

  const groups = useMemo(() => groupCohorts(rows, groupBy, sortKey, sortDir), [rows, groupBy, sortKey, sortDir]);
  const selectedList = useMemo(() => [...selectedIds], [selectedIds]);
  const rowIds = useMemo(() => rows.map((row) => row.cohort_id), [rows]);
  const selectAll = useMemo(() => addCohorts(selectedList, rowIds), [selectedList, rowIds]);
  const allShownSelected = rowIds.length > 0 && rowIds.every((id) => selectedIds.has(id));
  const overrides = expansion.groupBy === groupBy ? expansion.overrides : {};
  const selectedProductSet = new Set(selectedProducts);
  const selectedFunnelSet = new Set(selectedFunnels);
  const problem = periodProblem(periodRange);

  const visibleFunnelOptions = useMemo(() => {
    const q = funnelSearch.trim().toLowerCase();
    return q ? funnelOptions.filter((option) => option.path.toLowerCase().includes(q)) : funnelOptions;
  }, [funnelOptions, funnelSearch]);

  const add = (ids: string[]) => {
    const next = addCohorts(selectedList, ids);
    if (next.capped) {
      setCapHit(true);
      return;
    }
    setCapHit(false);
    onSetCohorts(next.ids);
  };
  const remove = (ids: string[]) => {
    setCapHit(false);
    onSetCohorts(removeCohorts(selectedList, ids));
  };
  const toggleCohort = (id: string) => (selectedIds.has(id) ? remove([id]) : add([id]));
  const toggleExpanded = (key: string, expanded: boolean) =>
    setExpansion({ groupBy, overrides: { ...overrides, [key]: !expanded } });
  const editPeriod = (side: "from" | "to", value: string) =>
    onPeriod({
      preset: "custom",
      from: side === "from" ? value : periodRange.from ?? "",
      to: side === "to" ? value : periodRange.to ?? "",
    });

  const subtitle = selectedCount === 0
    ? "All cohorts"
    : hiddenSelectedCount > 0
      ? `${selectedCount} selected · ${hiddenSelectedCount} hidden by filters`
      : `${selectedCount} selected`;
  const summary = funnelSummary(selectedFunnels);

  return (
    <Card className="min-w-0 p-4 shadow-card lg:sticky lg:top-4 lg:self-start">
      <div className="min-w-0 space-y-3">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-sm font-medium">Cohorts</div>
            <div className="truncate text-xs text-muted-foreground">{subtitle}</div>
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={onClearSelection} disabled={selectedCount === 0}>
            Clear
          </Button>
        </div>

        {products && (
          <div role="group" aria-label="Product" className="min-w-0 space-y-1">
            <div className="text-xs text-muted-foreground">Product</div>
            <div className="flex flex-wrap gap-1">
              {[
                { key: null as string | null, label: "All", title: "Every product", count: productCounts?.all ?? null, pressed: selectedProducts.length === 0 },
                ...products.map((product) => {
                  const key = productKey(product);
                  const paths = new Set(product.campaign_paths).size;
                  return {
                    key,
                    label: product.label,
                    title: `${product.host || "No FunnelFox metadata"} · ${paths} campaign path${paths === 1 ? "" : "s"}`,
                    count: productCounts ? productCounts.byKey.get(key) ?? 0 : null,
                    pressed: selectedProductSet.has(key),
                  };
                }),
              ].map((chip) => (
                <button
                  key={chip.key ?? "__all__"}
                  type="button"
                  aria-pressed={chip.pressed}
                  title={chip.title}
                  onClick={() => (chip.key === null ? onClearProducts() : onToggleProduct(chip.key))}
                  className={cn(
                    "inline-flex h-6 max-w-full items-center gap-1 rounded-full border px-2 text-xs transition-colors hover:bg-muted/60",
                    chip.pressed ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground",
                  )}
                >
                  <span className="truncate">{chip.label}</span>
                  {chip.count !== null && (
                    <>
                      {" "}
                      <span className="tabular-nums text-muted-foreground">{count(chip.count)}</span>
                    </>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}

        <Popover
          open={funnelOpen}
          onOpenChange={(open) => {
            setFunnelOpen(open);
            if (!open) setFunnelSearch("");
          }}
        >
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 w-full min-w-0 justify-between gap-2"
              aria-label={`Funnel filter: ${summary}`}
            >
              <span className="text-xs text-muted-foreground">Funnel</span>
              <span className="min-w-0 flex-1 truncate text-left" title={summary}>{summary}</span>
              <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            className="w-[300px] p-0"
            // Radix focuses the first tabbable node, which is "All funnels" once
            // a funnel is picked: typing would go nowhere and Enter would clear.
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              funnelSearchRef.current?.focus();
            }}
          >
            <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
              <div className="text-xs font-medium text-muted-foreground">Funnel</div>
              <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={onClearFunnels} disabled={selectedFunnels.length === 0}>
                All funnels
              </Button>
            </div>
            <div className="border-b border-border p-2">
              <Input
                ref={funnelSearchRef}
                value={funnelSearch}
                onChange={(event) => setFunnelSearch(event.target.value)}
                placeholder="Search funnels…"
                aria-label="Search funnels"
                className="h-8"
              />
            </div>
            <div className="max-h-72 overflow-y-auto py-1">
              {visibleFunnelOptions.map((option) => (
                <label key={option.path} className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted/50">
                  <Checkbox
                    checked={selectedFunnelSet.has(option.path)}
                    onCheckedChange={() => onToggleFunnel(option.path)}
                    aria-label={option.path}
                  />
                  <span className="min-w-0 flex-1 truncate" title={option.path}>{option.path}</span>
                  <span className="tabular-nums text-muted-foreground">{count(option.trialUsers)}</span>
                </label>
              ))}
              {visibleFunnelOptions.length === 0 && (
                <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                  {funnelSearch.trim() ? "No funnels match." : "No funnels in this period."}
                </div>
              )}
            </div>
          </PopoverContent>
        </Popover>

        <div role="group" aria-label="Period" className="min-w-0 space-y-2">
          <div className="flex flex-wrap gap-1">
            {PERIOD_PRESETS.map((preset) => (
              <Button
                key={preset.key}
                type="button"
                variant={periodSelection.preset === preset.key ? "secondary" : "ghost"}
                size="sm"
                aria-pressed={periodSelection.preset === preset.key}
                // Every preset has a border, so the active one is no wider.
                className={cn("h-7 border px-2 text-xs", periodSelection.preset === preset.key ? "border-primary bg-primary/10" : "border-transparent")}
                onClick={() => onPeriod({ preset: preset.key, from: "", to: "" })}
              >
                {preset.button}
              </Button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Input
              type="date"
              value={periodRange.from ?? ""}
              max={periodRange.to ?? undefined}
              onChange={(event) => editPeriod("from", event.target.value)}
              className="h-8 min-w-0"
              aria-label="Period from"
            />
            <Input
              type="date"
              value={periodRange.to ?? ""}
              min={periodRange.from ?? undefined}
              onChange={(event) => editPeriod("to", event.target.value)}
              className="h-8 min-w-0"
              aria-label="Period to"
            />
          </div>
          {problem && <div className="text-xs text-warning">{problem}</div>}
        </div>

        <div className="flex min-w-0 items-center gap-2">
          <div role="group" aria-label="Group by" className="inline-flex shrink-0 rounded-md border border-border p-0.5">
            {(["funnel", "date"] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={groupBy === value}
                onClick={() => onGroupBy(value)}
                className={cn(
                  "h-7 rounded px-2 text-xs transition-colors",
                  groupBy === value ? "bg-primary/10 font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {value === "funnel" ? "Funnel" : "Date"}
              </button>
            ))}
          </div>
          <Select value={sortKey} onValueChange={(value: CohortExplorerSortKey) => onSortKey(value)}>
            <SelectTrigger className="h-8 min-w-0 flex-1 gap-2" aria-label="Sort cohorts">
              <span className="text-xs text-muted-foreground">Sort</span>
              <SelectValue className="min-w-0 flex-1 text-left" placeholder="Sort cohorts" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="date">Date</SelectItem>
              <SelectItem value="trial_users">Trial users</SelectItem>
              <SelectItem value="net_revenue">Net revenue</SelectItem>
            </SelectContent>
          </Select>
          <Button type="button" variant="outline" size="icon" className="h-8 w-8 shrink-0" onClick={onToggleSortDir} aria-label="Toggle cohort sort direction">
            {sortDir === "asc" ? <ArrowUp className="h-4 w-4" /> : <ArrowDown className="h-4 w-4" />}
          </Button>
        </div>

        <div className="space-y-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            disabled={rows.length === 0 || allShownSelected || selectAll.capped}
            onClick={() => add(rowIds)}
          >
            {`Select all shown (${count(rows.length)})`}
          </Button>
          {(selectAll.capped || capHit) && <div className="text-xs text-muted-foreground">{CAP_NOTE}</div>}
        </div>

        <div className="max-h-[560px] overflow-y-auto overflow-x-hidden pr-1">
          {groups.length > 0 && (
            <div className="sticky top-0 z-10 flex items-center gap-1.5 bg-card py-1 text-[11px] text-muted-foreground">
              <span className="min-w-0 flex-1 pl-[48px]">{groupBy === "funnel" ? "Funnel" : "Date"}</span>
              <span className="w-12 text-right">Trials</span>
              <span className="w-16 text-right">Net</span>
            </div>
          )}
          {groups.map((group) => {
            const state = groupSelectionState(group, selectedIds);
            const hasSelected = state !== false;
            const expanded = overrides[group.key] ?? (groups.length <= 3 || hasSelected);
            const childIds = group.children.map((child) => child.cohort.cohort_id);
            return (
              <div key={group.key} className="min-w-0">
                <div className="flex h-8 min-w-0 items-center gap-1.5">
                  <button
                    type="button"
                    className="flex h-6 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
                    onClick={() => toggleExpanded(group.key, expanded)}
                    aria-expanded={expanded}
                    aria-label={`${expanded ? "Collapse" : "Expand"} ${group.label}`}
                  >
                    {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                  </button>
                  <TriStateCheckbox
                    checked={state}
                    label={`Select all cohorts of ${group.label}`}
                    onCheckedChange={() => {
                      // Keep the group as it is: a tick would otherwise expand it
                      // (hasSelected) and push every group below it down.
                      setExpansion({ groupBy, overrides: { ...overrides, [group.key]: expanded } });
                      if (state === true) remove(childIds);
                      else add(childIds);
                    }}
                  />
                  <span
                    className="min-w-0 flex-1 cursor-pointer truncate text-sm font-medium"
                    title={group.label}
                    onClick={() => toggleExpanded(group.key, expanded)}
                  >
                    {group.label}
                  </span>
                  <span className="w-12 text-right text-xs tabular-nums">{count(group.trialUsers)}</span>
                  <span className="w-16 text-right text-xs tabular-nums" title={formatCurrency(group.netRevenue)}>{money(group.netRevenue)}</span>
                </div>
                {expanded && group.children.map((child) => {
                  const cohortId = child.cohort.cohort_id;
                  const selected = selectedIds.has(cohortId);
                  return (
                    <div
                      key={cohortId}
                      role="button"
                      tabIndex={0}
                      onClick={() => toggleCohort(cohortId)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          toggleCohort(cohortId);
                        }
                      }}
                      className={cn(
                        "flex h-7 min-w-0 cursor-pointer items-center gap-1.5 rounded pl-[48px] transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        selected && "bg-primary/10",
                      )}
                    >
                      <Checkbox
                        checked={selected}
                        onClick={(event) => event.stopPropagation()}
                        onCheckedChange={() => toggleCohort(cohortId)}
                        aria-label={`Select cohort ${cohortId}`}
                      />
                      <span className="flex min-w-0 flex-1 items-baseline gap-1" title={cohortId}>
                        <span className="truncate text-xs tabular-nums">{child.label}</span>
                        {child.note && <span className="shrink-0 text-[11px] capitalize text-muted-foreground">{child.note}</span>}
                      </span>
                      <span className="w-12 text-right text-xs tabular-nums text-muted-foreground">{count(child.cohort.trial_users)}</span>
                      <span className="w-16 text-right text-xs tabular-nums text-muted-foreground" title={formatCurrency(child.cohort.net_revenue)}>{money(child.cohort.net_revenue)}</span>
                    </div>
                  );
                })}
              </div>
            );
          })}
          {rows.length === 0 && (
            <div className="rounded-md border border-dashed border-border px-3 py-8 text-center text-sm text-muted-foreground">
              {loading ? "Loading cohorts…" : "No cohorts match your filters."}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
