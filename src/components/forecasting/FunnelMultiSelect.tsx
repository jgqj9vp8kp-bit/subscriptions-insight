// Generic funnel multi-select popover (Project tab, P5).
//
// The reuse audit found Cohorts has SIX hand-rolled filter popovers and no
// shared component — this is the generic one, built here first so a later
// Cohorts cleanup can adopt it. Checkbox list + select-all + clear, nothing
// funnel-specific beyond the prop names.
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export interface FunnelMultiSelectOption {
  id: string;
  label: string;
  /** Small muted suffix (e.g. "spend only", "blocked"). */
  hint?: string;
}

export function FunnelMultiSelect({ label, options, selected, onToggle, onSelectAll, onClear }: {
  label: string;
  options: FunnelMultiSelectOption[];
  selected: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onSelectAll: () => void;
  onClear: () => void;
}) {
  const summary = selected.size === options.length
    ? `All (${options.length})`
    : `${selected.size} of ${options.length}`;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" className="h-9 justify-between gap-2 font-normal">
          <span className="text-muted-foreground">{label}</span>
          <span className="truncate">{summary}</span>
          <ChevronDown className="h-4 w-4 shrink-0 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-0">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-sm font-medium">{label}</span>
          <div className="flex gap-1">
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={onSelectAll}>Select all</Button>
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={onClear}>Clear</Button>
          </div>
        </div>
        <div className="max-h-72 overflow-auto py-1">
          {options.map((option) => (
            <label key={option.id} className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-muted/60">
              <Checkbox checked={selected.has(option.id)} onCheckedChange={() => onToggle(option.id)} />
              <span className="truncate">{option.label}</span>
              {option.hint && <span className="ml-auto shrink-0 text-xs text-muted-foreground">{option.hint}</span>}
            </label>
          ))}
          {options.length === 0 && <p className="px-3 py-2 text-xs text-muted-foreground">No funnels in this window.</p>}
        </div>
      </PopoverContent>
    </Popover>
  );
}
