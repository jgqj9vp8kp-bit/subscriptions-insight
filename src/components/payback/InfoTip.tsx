// A small "i" that explains a number. A shadcn Tooltip on hover / focus, and a
// tap toggles it too, so the explanation also works on touch screens (a plain
// Radix tooltip never opens on touch, and a native title never shows there).
import { useRef, useState, type ReactNode } from "react";
import { Info } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export function InfoTip({ label, children, className }: {
  /** Accessible name of the trigger, e.g. "About cost per trial". */
  label: string;
  children: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  // Radix closes an open tip on the trigger's pointerdown, before the click
  // arrives; the click toggles from the state the tap started in, so a second
  // tap closes it. Keyboard clicks have no pointerdown: they toggle the current state.
  const openAtPointerDown = useRef<boolean | null>(null);
  return (
    // Its own provider: KpiCard (and anything else) may render it outside the app shell.
    <TooltipProvider delayDuration={150}>
      <Tooltip open={open} onOpenChange={setOpen}>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={label}
            className={cn(
              "inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full align-middle text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              className,
            )}
            // Runs before Radix's own pointerdown handler (asChild calls the child's first).
            onPointerDown={() => {
              openAtPointerDown.current = open;
            }}
            onClick={(event) => {
              // Radix closes a tooltip on trigger click; a tap must toggle it
              // instead, and must not reach a clickable row underneath.
              event.preventDefault();
              event.stopPropagation();
              const wasOpen = openAtPointerDown.current ?? open;
              openAtPointerDown.current = null;
              setOpen(!wasOpen);
            }}
          >
            <Info className="h-3 w-3" />
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-[280px] text-xs font-normal leading-relaxed">{children}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
