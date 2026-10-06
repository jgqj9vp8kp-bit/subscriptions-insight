// funnelfox-funnels access policy (plan §7 row "FunnelFox funnel list").
//
// The function lists every FunnelFox funnel (id, title, alias, tags, publish
// state) for the Funnels page's "Import from FunnelFox" dialog — the first step
// of a registry write, so it needs funnels.manage (privileged: funnel scope
// `all`, Owner-granted). Before access control it had NO in-function check:
// any JWT the gateway accepted could list every funnel.
//
// The page POSTs `{}` — no action — and that default is mapped explicitly
// (rule R3):
//   list     — the normalized funnel list.
//   inspect  — the `inspect` flag ("1" / "true", query or body): the raw first
//              upstream row plus key listings. A raw-payload diagnostic, so it
//              also needs admin.diagnostics.view.
// A body `action` may only repeat the derived name; anything else is a 400.
// No action is scopeReady (Milestone A). Pure module: vitest imports it.

import type { FunctionPolicy, NormalizeActionInput } from "../gate.ts";
import { funnelFoxDerivedAction, funnelFoxRequestParams } from "../../funnelfox.ts";

export type FunnelFoxFunnelsAction = "list" | "inspect";

/** The diagnostic flag as the function has always read it. */
export function funnelFoxFunnelsInspectRequested(params: URLSearchParams): boolean {
  const inspect = params.get("inspect");
  return inspect === "1" || inspect === "true";
}

export function normalizeFunnelFoxFunnelsAction({ body, url }: NormalizeActionInput): FunnelFoxFunnelsAction {
  const inspect = funnelFoxFunnelsInspectRequested(funnelFoxRequestParams(url, body));
  return funnelFoxDerivedAction<FunnelFoxFunnelsAction>(body, inspect ? "inspect" : "list");
}

export const FUNNELFOX_FUNNELS_POLICY: FunctionPolicy<FunnelFoxFunnelsAction> = {
  fn: "funnelfox-funnels",
  methods: ["GET", "POST"],
  normalizeAction: normalizeFunnelFoxFunnelsAction,
  actions: {
    list: { allOf: ["funnels.manage"] },
    inspect: { allOf: ["funnels.manage", "admin.diagnostics.view"] },
  },
};
