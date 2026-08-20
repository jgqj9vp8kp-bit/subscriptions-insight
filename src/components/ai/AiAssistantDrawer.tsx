// Global AI Assistant: a right-side sheet over the current page. The table
// stays visible (480px, no full-screen takeover). Answers are STRUCTURED —
// conclusion, sections of metric-grounded items, cautions — rendered with the
// same dense text styles as the analytics tables, never chat bubbles.
//
// The assistant is strictly downstream of the deterministic layer: it answers
// from the page's published context pack. No context -> it says so instead of
// guessing. Unavailable (no key) is a calm state; only transport failures are
// loud (reportAi outcome discipline).
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Loader2, Send, Sparkles, X } from "lucide-react";
import { AiFeedback } from "@/components/ai/AiFeedback";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { askAssistant, type AssistantOutcome } from "@/services/aiAssistantClient";
import { useAiAssistantStore } from "@/store/aiAssistantStore";
import { cn } from "@/lib/utils";

const SUGGESTED_QUESTIONS = [
  "What should I scale?",
  "What should I stop or reduce?",
  "Where are the payment issues?",
  "What changed and what should I investigate today?",
];

interface Exchange {
  question: string;
  outcome: AssistantOutcome | null; // null while in flight
}

export function AiAssistantDrawer() {
  const { open, setOpen, context } = useAiAssistantStore();
  const [question, setQuestion] = useState("");
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (open && context?.seedQuestion) setQuestion(context.seedQuestion);
  }, [open, context?.seedQuestion]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [exchanges]);

  const ask = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || busy || !context) return;
    setQuestion("");
    setBusy(true);
    setExchanges((current) => [...current, { question: trimmed, outcome: null }]);
    const outcome = await askAssistant({
      question: trimmed,
      surface: context.surface,
      contextLabel: context.label,
      contextPack: context.contextPack,
    });
    setExchanges((current) =>
      current.map((exchange, index) =>
        index === current.length - 1 ? { ...exchange, outcome } : exchange,
      ),
    );
    setBusy(false);
  };

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent side="right" className="flex w-[480px] flex-col gap-0 p-0 sm:max-w-[480px]">
        <SheetHeader className="border-b border-border px-4 py-3">
          <SheetTitle className="flex items-center gap-2 text-sm font-semibold">
            <Sparkles className="h-4 w-4 text-primary" /> AI Assistant
          </SheetTitle>
          {context ? (
            <div className="flex items-start justify-between gap-2 rounded-md border border-border bg-muted/20 px-2.5 py-1.5">
              <div className="min-w-0 text-xs">
                <div className="text-muted-foreground">Current context</div>
                <div className="truncate font-medium text-foreground" title={context.label}>{context.label}</div>
                <div className="text-muted-foreground">{context.contextPack.items.length} rows analyzed</div>
              </div>
              <button
                type="button"
                className="mt-0.5 shrink-0 text-muted-foreground hover:text-foreground"
                title="Clear context"
                onClick={() => useAiAssistantStore.getState().publishContext(null)}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              No analytics context on this page yet. Open Cohorts or FB Analytics — the assistant answers from the
              same deterministic signals those tables show.
            </p>
          )}
        </SheetHeader>

        <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto px-4 py-3">
          {exchanges.length === 0 && (
            <div className="space-y-2">
              <div className="text-xs font-medium text-muted-foreground">Suggested questions</div>
              <div className="flex flex-wrap gap-1.5">
                {SUGGESTED_QUESTIONS.map((suggested) => (
                  <button
                    key={suggested}
                    type="button"
                    disabled={!context || busy}
                    onClick={() => void ask(suggested)}
                    className={cn(
                      "rounded-md border border-border bg-muted/20 px-2 py-1 text-xs hover:bg-muted/50",
                      (!context || busy) && "cursor-not-allowed opacity-50",
                    )}
                  >
                    {suggested}
                  </button>
                ))}
              </div>
            </div>
          )}

          {exchanges.map((exchange, index) => (
            <div key={index} className="space-y-2">
              <div className="rounded-md bg-primary/10 px-2.5 py-1.5 text-xs font-medium text-foreground">
                {exchange.question}
              </div>
              {exchange.outcome === null && (
                <div className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Analyzing the current context…
                </div>
              )}
              {exchange.outcome?.kind === "unavailable" && (
                <p className="px-1 text-xs text-muted-foreground">
                  Assistant unavailable: {exchange.outcome.reason} The tables, chips and opportunities keep working.
                </p>
              )}
              {exchange.outcome?.kind === "error" && (
                <p className="px-1 text-xs text-destructive">{exchange.outcome.message}</p>
              )}
              {(exchange.outcome?.kind === "ok" || exchange.outcome?.kind === "partial") && (
                <div className="space-y-3 px-1">
                  {exchange.outcome.answer.conclusion && (
                    <p className="text-xs font-medium text-foreground">{exchange.outcome.answer.conclusion}</p>
                  )}
                  {exchange.outcome.answer.sections.map((section, sectionIndex) => (
                    <div key={sectionIndex}>
                      <div className="mb-1 text-xs font-semibold text-muted-foreground">{section.title}</div>
                      <div className="space-y-1.5">
                        {section.items.map((item, itemIndex) => (
                          <div key={itemIndex} className="rounded-md border border-border bg-muted/10 px-2.5 py-1.5">
                            {item.scopeLabel && (
                              <div className="truncate text-xs font-medium text-foreground" title={item.scopeLabel}>
                                {item.scopeLabel}
                              </div>
                            )}
                            <div className="text-xs text-muted-foreground">{item.text}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                  {exchange.outcome.answer.cautions.length > 0 && (
                    <div className="rounded-md border border-warning/40 bg-warning/10 px-2.5 py-1.5">
                      {exchange.outcome.answer.cautions.map((caution, cautionIndex) => (
                        <div key={cautionIndex} className="text-xs text-warning">{caution}</div>
                      ))}
                    </div>
                  )}
                  {exchange.outcome.kind === "partial" && (
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <AlertTriangle className="h-3 w-3" />
                      {exchange.outcome.violations.length} fragment(s) removed by number validation.
                    </div>
                  )}
                  <AiFeedback
                    subjectKind="assistant_answer"
                    subjectId={exchange.question.slice(0, 120)}
                    payload={{ model: exchange.outcome.model, surface: context?.surface ?? "global" }}
                  />
                </div>
              )}
            </div>
          ))}
        </div>

        <form
          className="flex items-center gap-2 border-t border-border px-4 py-3"
          onSubmit={(event) => {
            event.preventDefault();
            void ask(question);
          }}
        >
          <Input
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder={context ? "Ask about your data…" : "Open an analytics page first"}
            disabled={!context || busy}
            className="h-9 text-sm"
            maxLength={600}
          />
          <Button type="submit" size="sm" className="h-9" disabled={!context || busy || !question.trim()}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </Button>
        </form>
      </SheetContent>
    </Sheet>
  );
}
