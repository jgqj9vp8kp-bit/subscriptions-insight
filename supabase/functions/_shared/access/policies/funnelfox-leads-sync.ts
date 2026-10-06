// funnelfox-leads-sync access policy (plan §7 row "Capsuled / FunnelFox syncs":
// "leads sync rawAccess only"; D8).
//
// The function crawls FunnelFox profiles / sessions into funnelfox_leads (emails,
// geo, attribution) and its sync state. Its reconcile stage marks who converted
// from a conversion context the BROWSER computes out of its in-memory
// transaction warehouse and subscriptions (src/services/funnelfoxLeads.ts
// buildConversionContext) — browser-side raw data, meaningful only for the data
// owner's own loaded dataset. So every action is rawOnly AND admin.sync.run
// (the /leads page, itself raw-only, is the one caller). Rows always land under
// ctx.tenantKey; before access control any signed-in account could self-provision
// its own copy (G1).
//
// The page sends flags, never an action name; the default is mapped explicitly
// (rule R3), exactly as for the subscriptions sync:
//   dry_run          — `dry_run`: probes upstream, writes nothing (wins over
//                      full_reset, as before).
//   sync_full_reset  — `full_reset`: re-opens the email enrichment, then runs the
//                      first stage.
//   sync             — anything else: the requested `stage` or the next one.
// A body `action` may only repeat the derived name; anything else is a 400.
//
// There is no cron (no migration schedules it), so the policy has no cron
// branch: a scheduler header opens nothing. No action is scopeReady
// (Milestone A). Pure module: vitest imports it.

import type { FunctionPolicy, NormalizeActionInput } from "../gate.ts";
import { funnelFoxDerivedAction, funnelFoxSyncFlags } from "../../funnelfox.ts";

export type FunnelFoxLeadsSyncAction = "sync" | "sync_full_reset" | "dry_run";

const SYNC_RUN = ["admin.sync.run"];

export function normalizeFunnelFoxLeadsSyncAction({ body, url }: NormalizeActionInput): FunnelFoxLeadsSyncAction {
  const { dryRun, fullReset } = funnelFoxSyncFlags(body, url);
  return funnelFoxDerivedAction<FunnelFoxLeadsSyncAction>(body, dryRun ? "dry_run" : fullReset ? "sync_full_reset" : "sync");
}

export const FUNNELFOX_LEADS_SYNC_POLICY: FunctionPolicy<FunnelFoxLeadsSyncAction> = {
  fn: "funnelfox-leads-sync",
  // GET with the same query parameters has always been accepted.
  methods: ["GET", "POST"],
  normalizeAction: normalizeFunnelFoxLeadsSyncAction,
  actions: {
    sync: { rawOnly: true, allOf: SYNC_RUN, write: true },
    sync_full_reset: { rawOnly: true, allOf: SYNC_RUN, write: true },
    dry_run: { rawOnly: true, allOf: SYNC_RUN },
  },
};
