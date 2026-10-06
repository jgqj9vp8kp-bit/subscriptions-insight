// funnelfox-profile access policy (plan §7 row "FunnelFox proxies"; §28
// "Unauthenticated FunnelFox proxies"; D8).
//
// A proxy of FunnelFox GET /profiles/{id}: by default it returns only the
// profile id and the resolved email (P0-5); the rich sanitized profile dump is
// served only when the server-side FUNNELFOX_DEBUG flag is on AND the caller
// asks for it. Before access control it had NO in-function check (gateway JWT
// only). Its remaining caller is the data owner's Import tooling
// (src/services/funnelfoxApi.ts fetchProfileDebug), so it is rawOnly AND
// admin.sync.run.
//
// The browser sends `?id=` (and optionally `debug`) and no action; the default
// is mapped explicitly (rule R3):
//   profile        — the minimal body.
//   profile_debug  — `debug` ("1" / "true", any case, trimmed): the raw-profile
//                    diagnostic, so it also needs admin.diagnostics.view. With
//                    FUNNELFOX_DEBUG unset it still returns the minimal body.
// A body `action` may only repeat the derived name; anything else is a 400.
// Not scopeReady (Milestone A). Pure module: vitest imports it.

import type { FunctionPolicy, NormalizeActionInput } from "../gate.ts";
import { funnelFoxDerivedAction, funnelFoxRequestParams } from "../../funnelfox.ts";

export type FunnelFoxProfileAction = "profile" | "profile_debug";

/** The debug flag as the function has always read it. */
export function funnelFoxProfileDebugRequested(params: URLSearchParams): boolean {
  return ["1", "true"].includes((params.get("debug") ?? "").trim().toLowerCase());
}

export function normalizeFunnelFoxProfileAction({ body, url }: NormalizeActionInput): FunnelFoxProfileAction {
  const debug = funnelFoxProfileDebugRequested(funnelFoxRequestParams(url, body));
  return funnelFoxDerivedAction<FunnelFoxProfileAction>(body, debug ? "profile_debug" : "profile");
}

export const FUNNELFOX_PROFILE_POLICY: FunctionPolicy<FunnelFoxProfileAction> = {
  fn: "funnelfox-profile",
  methods: ["GET", "POST"],
  normalizeAction: normalizeFunnelFoxProfileAction,
  actions: {
    profile: { rawOnly: true, allOf: ["admin.sync.run"] },
    profile_debug: { rawOnly: true, allOf: ["admin.sync.run", "admin.diagnostics.view"] },
  },
};
