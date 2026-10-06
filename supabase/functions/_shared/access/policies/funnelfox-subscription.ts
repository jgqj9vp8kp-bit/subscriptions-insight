// funnelfox-subscription access policy (plan §7 row "FunnelFox proxies"; §28
// "Unauthenticated FunnelFox proxies"; D8).
//
// A pass-through proxy of FunnelFox GET /subscriptions/{id}: it returns the RAW
// upstream detail, customer email included. Before access control it had NO
// in-function check (gateway JWT only). Its remaining caller is the data
// owner's Import page (src/services/funnelfoxApi.ts: the detail enrichment of
// syncAllSubscriptionsWithDiagnostics), so it is rawOnly AND admin.sync.run.
//
// One action: `details` (the browser sends `?id=` and no action — that default
// is mapped explicitly, rule R3; a body `action` other than "details" is a 400).
// The id itself is validated by the handler (400 as before). Not scopeReady
// (Milestone A). Pure module: vitest imports it.

import type { FunctionPolicy, NormalizeActionInput } from "../gate.ts";
import { funnelFoxDerivedAction } from "../../funnelfox.ts";

export type FunnelFoxSubscriptionAction = "details";

export function normalizeFunnelFoxSubscriptionAction({ body }: NormalizeActionInput): FunnelFoxSubscriptionAction {
  return funnelFoxDerivedAction<FunnelFoxSubscriptionAction>(body, "details");
}

export const FUNNELFOX_SUBSCRIPTION_POLICY: FunctionPolicy<FunnelFoxSubscriptionAction> = {
  fn: "funnelfox-subscription",
  methods: ["GET", "POST"],
  normalizeAction: normalizeFunnelFoxSubscriptionAction,
  actions: {
    details: { rawOnly: true, allOf: ["admin.sync.run"] },
  },
};
