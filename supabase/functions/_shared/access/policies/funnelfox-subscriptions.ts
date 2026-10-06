// funnelfox-subscriptions access policy (plan §7 row "FunnelFox proxies"; §28
// "Unauthenticated FunnelFox proxies"; D8).
//
// A pass-through proxy of FunnelFox GET /subscriptions: it returns the RAW
// upstream page, customer emails included. Before access control it had NO
// in-function check (gateway JWT only). Its remaining caller is the data
// owner's Import page (src/services/funnelfoxApi.ts: testFunnelFoxConnection,
// syncAllSubscriptionsWithDiagnostics — the legacy browser-side sync), so every
// action is rawOnly AND admin.sync.run.
//
// The browser sends GET query parameters, never an action; the default is
// mapped explicitly (rule R3):
//   connection_test — `debug` ("1" / "true"): counts and reachability only.
//   list            — anything else: the raw upstream page (`cursor` pages it).
// A body `action` may only repeat the derived name; anything else is a 400.
// No action is scopeReady (Milestone A). Pure module: vitest imports it.

import type { FunctionPolicy, NormalizeActionInput } from "../gate.ts";
import { funnelFoxDerivedAction, funnelFoxRequestParams } from "../../funnelfox.ts";

export type FunnelFoxSubscriptionsAction = "list" | "connection_test";

const OWNER_SYNC = { rawOnly: true, allOf: ["admin.sync.run"] };

/** The debug flag as the function has always read it. */
export function funnelFoxSubscriptionsDebugRequested(params: URLSearchParams): boolean {
  const debug = params.get("debug");
  return debug === "1" || debug === "true";
}

export function normalizeFunnelFoxSubscriptionsAction({ body, url }: NormalizeActionInput): FunnelFoxSubscriptionsAction {
  const debug = funnelFoxSubscriptionsDebugRequested(funnelFoxRequestParams(url, body));
  return funnelFoxDerivedAction<FunnelFoxSubscriptionsAction>(body, debug ? "connection_test" : "list");
}

export const FUNNELFOX_SUBSCRIPTIONS_POLICY: FunctionPolicy<FunnelFoxSubscriptionsAction> = {
  fn: "funnelfox-subscriptions",
  methods: ["GET", "POST"],
  normalizeAction: normalizeFunnelFoxSubscriptionsAction,
  actions: {
    list: { ...OWNER_SYNC },
    connection_test: { ...OWNER_SYNC },
  },
};
