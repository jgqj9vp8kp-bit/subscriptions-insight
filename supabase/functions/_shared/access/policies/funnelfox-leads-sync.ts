// funnelfox-leads-sync access policy (plan §7 row "Capsuled / FunnelFox syncs":
// "leads sync rawAccess only"; D8; §12.7–12.8 timing-safe cron secret, cron
// owner = data key; threat G1/V6).
//
// The function crawls FunnelFox profiles / sessions into funnelfox_leads (emails,
// geo, attribution) and its sync state, and reconciles conversion server-side
// (SQL funnelfox_leads_reconcile — it no longer needs a browser-computed
// context). The Leads data stays the data owner's for now (owner decision 4), so
// every USER action is rawOnly AND admin.sync.run (the Leads sync card is the
// one session caller). Rows always land under ctx.tenantKey; before access
// control any signed-in account could self-provision its own copy (G1).
//
// The page sends flags, never an action name; the default is mapped explicitly
// (rule R3), exactly as for the subscriptions sync:
//   dry_run          — `dry_run`: the PII-free diagnose — probes upstream, writes
//                      nothing (wins over full_reset, as before). Key names and
//                      counts only.
//   sync_full_reset  — `full_reset`: restarts the pipeline (every stage flag
//                      false, both cursors null), then runs the first stage.
//   sync             — anything else: the requested `stage` or the next one.
// A body `action` may only repeat the derived name; anything else is a 400.
//
// pg_cron (migration 202610060011: the minute advance tick and the daily
// refresh, which sends full_reset) authenticates with x-cron-secret =
// FB_CRON_SECRET through policy.cron: the gate compares it in constant time
// BEFORE the body is read and binds the tenant to workspace_data_key() — the body
// auth_user_id may only repeat it. The cron branch does not check rawOnly (its
// cron.actions list IS the authorization); the scheduler may run sync and
// sync_full_reset, never the dry run. No action is scopeReady (Milestone A).
// Pure module: vitest imports it.

import type { FunctionPolicy, NormalizeActionInput } from "../gate.ts";
import { funnelFoxDerivedAction, funnelFoxSyncFlags } from "../../funnelfox.ts";

export type FunnelFoxLeadsSyncAction = "sync" | "sync_full_reset" | "dry_run";

/** What the pg_cron ticks send: { auth_user_id, full_reset: true | false, limit, max_pages }. */
export const FUNNELFOX_LEADS_SYNC_CRON_ACTIONS: readonly FunnelFoxLeadsSyncAction[] = ["sync", "sync_full_reset"];

const SYNC_RUN = ["admin.sync.run"];

/** Canonical action from the flags, on both branches (the gate then limits the
 * cron branch to FUNNELFOX_LEADS_SYNC_CRON_ACTIONS). */
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
    // Spends upstream calls but writes nothing.
    dry_run: { rawOnly: true, allOf: SYNC_RUN },
  },
  cron: { header: "x-cron-secret", secretEnv: "FB_CRON_SECRET", actions: [...FUNNELFOX_LEADS_SYNC_CRON_ACTIONS] },
};
