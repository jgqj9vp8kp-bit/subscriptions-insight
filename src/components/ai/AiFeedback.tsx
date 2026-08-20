// Lightweight 👍/👎 on AI recommendations and assistant answers. One row per
// click into ai_feedback; the payload snapshot lets later evaluation compare
// what the engine said with what the operator thought of it. No undo UI —
// clicking the other thumb records a second row (history, not state).
import { useState } from "react";
import { ThumbsDown, ThumbsUp } from "lucide-react";
import { supabase } from "@/services/supabaseClient";
import { cn } from "@/lib/utils";

export function AiFeedback({ subjectKind, subjectId, payload }: {
  subjectKind: "recommendation" | "assistant_answer";
  subjectId: string;
  payload?: Record<string, unknown>;
}) {
  const [sent, setSent] = useState<"up" | "down" | null>(null);

  const send = async (verdict: "up" | "down") => {
    setSent(verdict);
    if (!supabase) return;
    try {
      await supabase.from("ai_feedback").insert({
        subject_kind: subjectKind,
        subject_id: subjectId,
        verdict,
        payload: payload ?? {},
      });
    } catch {
      // Feedback is best-effort; never interrupt the operator over it.
    }
  };

  return (
    <span className="inline-flex items-center gap-1 text-muted-foreground">
      <span className="text-xs">Was this useful?</span>
      <button
        type="button"
        title="Useful"
        onClick={() => void send("up")}
        className={cn("rounded p-0.5 hover:text-success", sent === "up" && "text-success")}
      >
        <ThumbsUp className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        title="Not useful"
        onClick={() => void send("down")}
        className={cn("rounded p-0.5 hover:text-destructive", sent === "down" && "text-destructive")}
      >
        <ThumbsDown className="h-3.5 w-3.5" />
      </button>
    </span>
  );
}
