// "Attach path" dialog of Admin → Funnel coverage (access Phase 2): grants an
// unregistered (or proposed) campaign path of the active cohort snapshot to one
// funnel. Members whose selected scope holds that funnel start seeing every
// user anchored to the path, with their lifetime revenue, so the dialog states
// the impact ("+N users / +$X into {funnel}; M members holding it will see
// this data") before the call.
//
// paths.attach sends the path exactly as the snapshot holds it; the server
// (funnels.manage, access_attach_funnel_path) refuses a path another funnel
// holds and audits registry.path_attached. UX only here.

import { useEffect, useMemo, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { FunnelPathChips } from "@/components/access/FunnelPathChips";
import { useAccessAdminMutation } from "@/components/admin/useAccessAdmin";
import { funnelOptionLabel, pathImpactText } from "@/components/admin/accessAdminModel";
import {
  attachFunnelPath,
  describeAccessAdminError,
  type AdminFunnelOption,
  type FunnelCoveragePath,
  type PathMutationResult,
} from "@/services/accessAdminClient";

const MAX_NOTE = 500;

export interface AttachPathDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The coverage row being attached (path, users, net revenue). */
  row: FunnelCoveragePath | null;
  funnels: readonly AdminFunnelOption[];
  funnelsLoading?: boolean;
  /** Pre-selected funnel (e.g. the funnel a proposal names). */
  defaultFunnelId?: string | null;
  /** Active members holding a funnel, or null when members cannot be listed. */
  membersHolding: (funnelId: string) => number | null;
  onAttached?: (result: PathMutationResult) => void;
}

export function AttachPathDialog({
  open,
  onOpenChange,
  row,
  funnels,
  funnelsLoading = false,
  defaultFunnelId = null,
  membersHolding,
  onAttached,
}: AttachPathDialogProps) {
  const { toast } = useToast();
  const { run } = useAccessAdminMutation({ refreshCoverage: true });
  const [funnelId, setFunnelId] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setFunnelId(defaultFunnelId);
    setNote("");
    // Reset only when the dialog opens (or switches to another path).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, row?.path]);

  const funnel = useMemo(
    () => (funnelId ? funnels.find((entry) => entry.id.toLowerCase() === funnelId.toLowerCase()) : undefined),
    [funnels, funnelId],
  );
  const funnelLabel = funnelId ? funnelOptionLabel(funnel, funnelId) : "";
  const canSubmit = Boolean(row && funnelId) && !submitting;

  async function onSubmit() {
    if (!row || !funnelId || submitting) return;
    setSubmitting(true);
    try {
      const result = await run(() => attachFunnelPath({ funnel_id: funnelId, path: row.path, note: note.trim() || undefined }));
      toast({
        title: result.changed ? "Path attached" : "Path already attached",
        description: `${row.path} → ${funnelLabel}. ${result.affected_members} member${result.affected_members === 1 ? "" : "s"} affected.`,
      });
      onAttached?.(result);
      onOpenChange(false);
    } catch (error) {
      toast({ title: "Could not attach the path", description: describeAccessAdminError(error), variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open && Boolean(row)} onOpenChange={(next) => !submitting && onOpenChange(next)}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto" data-testid="attach-path-dialog">
        <DialogHeader>
          <DialogTitle>Attach path</DialogTitle>
          <DialogDescription>
            Grant <span className="font-mono text-foreground">{row?.path}</span> to a funnel. Members with that funnel in their
            scope see every user anchored to this path, including their lifetime revenue.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <span className="text-xs text-muted-foreground">Funnel</span>
            <Command className="rounded-md border border-border">
              <CommandInput placeholder="Search funnels…" disabled={submitting} />
              <CommandList className="max-h-56">
                <CommandEmpty>{funnelsLoading ? "Loading funnels…" : "No funnels found."}</CommandEmpty>
                <CommandGroup>
                  {funnels.map((option) => {
                    const isSelected = funnelId !== null && option.id.toLowerCase() === funnelId.toLowerCase();
                    return (
                      <CommandItem
                        key={option.id}
                        value={`${option.display_name} ${option.funnel_path} ${option.id}`}
                        onSelect={() => setFunnelId(option.id)}
                        disabled={submitting}
                        className={cn("items-start gap-2", !option.is_active && "text-muted-foreground")}
                        data-testid={`attach-funnel-${option.id}`}
                        data-checked={isSelected ? "true" : "false"}
                      >
                        <span
                          className={cn(
                            "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-primary",
                            isSelected ? "bg-primary text-primary-foreground" : "opacity-50",
                          )}
                        >
                          {isSelected && <Check className="h-3 w-3" />}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="truncate text-sm">{option.display_name || option.funnel_path}</span>
                            {!option.is_active && (
                              <Badge variant="outline" className="text-[10px] font-normal text-muted-foreground">
                                inactive
                              </Badge>
                            )}
                          </div>
                          <div className="mt-0.5">
                            <FunnelPathChips paths={option.paths} />
                          </div>
                        </div>
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              </CommandList>
            </Command>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="attach-path-note" className="text-xs text-muted-foreground">
              Note (optional)
            </Label>
            <Input
              id="attach-path-note"
              value={note}
              maxLength={MAX_NOTE}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Why this path belongs to the funnel"
              className="h-9"
              disabled={submitting}
            />
          </div>

          {row && funnelId && (
            <p role="status" className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-foreground" data-testid="attach-impact">
              {pathImpactText("add", row, funnelLabel, membersHolding(funnelId))}.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void onSubmit()} disabled={!canSubmit}>
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
            Attach path
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
