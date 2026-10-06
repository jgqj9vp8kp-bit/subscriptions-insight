// Global AI Assistant state: which page context is active and whether the
// drawer is open. Pages PUBLISH their deterministic engine output here (an
// effect per page); the drawer only reads. Context deliberately carries the
// pre-rendered context pack — the assistant never sees raw rows.
import { create } from "zustand";
import type { AiContextPack } from "@/services/aiSignals";
import { registerPurgeHandler } from "@/services/sessionPurge";

export interface AiAssistantContext {
  surface: string;
  /** Human line shown in the drawer, e.g. "FB Analytics · 18 campaigns". */
  label: string;
  contextPack: AiContextPack;
  /** Pre-filled question when opened from a row's "Ask AI". */
  seedQuestion?: string;
}

interface AiAssistantState {
  open: boolean;
  context: AiAssistantContext | null;
  setOpen: (open: boolean) => void;
  /** Pages publish (or clear with null) their current context. */
  publishContext: (context: AiAssistantContext | null) => void;
  /** Row-level "Ask AI": focus the context and open the drawer. */
  openWith: (context: AiAssistantContext) => void;
}

export const useAiAssistantStore = create<AiAssistantState>((set) => ({
  open: false,
  context: null,
  setOpen: (open) => set({ open }),
  publishContext: (context) => set({ context }),
  openWith: (context) => set({ context, open: true }),
}));

// The published context pack was built from the previous principal's data.
// AiAssistantDrawer registers the same reset; registering it with the store too
// covers sessions in which the drawer module never loaded.
registerPurgeHandler("ai-assistant-store", () => {
  useAiAssistantStore.setState({ open: false, context: null });
});
