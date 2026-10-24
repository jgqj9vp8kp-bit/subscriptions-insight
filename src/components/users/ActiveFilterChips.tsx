// The Users page's active filters as removable chips (above the users table
// and Decline Analytics): one chip per filter, ✕ clears just that filter.
import { X } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export interface ActiveFilterChip {
  id: string;
  label: string;
  onRemove: () => void;
}

export function ActiveFilterChips({ chips }: { chips: ActiveFilterChip[] }) {
  if (chips.length === 0) return null;
  return (
    <div role="list" aria-label="Active filters" className="flex flex-wrap gap-1">
      {chips.map((chip) => (
        <div key={chip.id} role="listitem" className="min-w-0">
          <Badge variant="secondary" className="max-w-full gap-1 pr-1 text-xs font-normal">
            <span className="max-w-[260px] truncate" title={chip.label}>{chip.label}</span>
            <button
              type="button"
              className="shrink-0 rounded-sm opacity-60 hover:opacity-100"
              onClick={chip.onRemove}
              aria-label={`Remove filter ${chip.label}`}
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        </div>
      ))}
    </div>
  );
}
