// Compact multi-select filter of the Dashboard sections (Revenue Intelligence,
// Daily trials): an outline trigger that counts the selection and a checkbox
// list with Clear. `formatOption` changes only the label shown for an option
// (e.g. "MX · Mexico"); the values stay raw.
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export function FilterMultiSelect({ label, values, options, onChange, formatOption }: {
  label: string; values: string[]; options: string[]; onChange: (values: string[]) => void;
  formatOption?: (value: string) => string;
}): JSX.Element {
  const selected = new Set(values);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="h-8 justify-between px-3 text-xs font-normal">
          <span className={cn("truncate", values.length ? "text-foreground" : "text-muted-foreground")}>
            {values.length ? `${label}: ${values.length}` : label}
          </span>
          <ChevronDown className="ml-1 h-3.5 w-3.5 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-0">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <span className="text-xs font-medium text-muted-foreground">{label}</span>
          {values.length > 0 && (
            <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => onChange([])}>
              Clear
            </Button>
          )}
        </div>
        <div className="max-h-72 overflow-auto p-1">
          {options.length ? options.map((option) => {
            const checked = selected.has(option);
            return (
              <button
                type="button"
                key={option}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted"
                onClick={() => onChange(checked ? values.filter((value) => value !== option) : [...values, option])}
              >
                <Checkbox checked={checked} className="pointer-events-none" />
                <span className="min-w-0 flex-1 truncate">{formatOption ? formatOption(option) : option}</span>
              </button>
            );
          }) : (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">No options yet</div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
