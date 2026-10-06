// funnelfox-subscriptions-sync access policy (plan §7 row "Capsuled / FunnelFox
// syncs"; §12.7–12.8 timing-safe cron secret, cron owner = data key; threat G1/V6).
//
// The function crawls FunnelFox into funnelfox_subscriptions and its sync state.
// Every user call is a sync trigger or a sync probe → admin.sync.run (the Import
// page's staged-sync buttons; privileged: funnel scope `all`, Owner-granted).
// Before access control any signed-in account could call it and got its OWN
// private copy of the deployment-wide subscriptions, emails included (G1); rows
// now always land under ctx.tenantKey. The sync state is read through PostgREST,
// so there is no status action here.
//
// Neither the browser nor pg_cron names an action — they send flags, and that
// default is mapped explicitly (rule R3):
//   dry_run          — `dry_run`: probes two upstream pages, writes nothing (it
//                      wins over full_reset, as before). Returns counts and key
//                      names only.
//   sync_full_reset  — `full_reset`: re-opens every stage and the enrichment
//                      markers, then runs the first stage.
//   sync             — anything else: the requested `stage` or the next
//                      incomplete one.
// A body `action` may only repeat the derived name; anything else is a 400.
//
// pg_cron (migration 202607250001: the 05:45 full_reset refresh and the 15-min
// advance tick) authenticates with x-cron-secret = FB_CRON_SECRET through
// policy.cron: the gate compares it in constant time BEFORE the body is read and
// binds the tenant to workspace_data_key() — the body auth_user_id may only
// repeat it (it used to be trusted after a plain !== compare). The scheduler may
// run sync and sync_full_reset, never the dry run. No action is scopeReady
// (Milestone A). Pure module: vitest imports it.

import type { FunctionPolicy, NormalizeActionInput } from "../gate.ts";
import { funnelFoxDerivedAction, funnelFoxSyncFlags } from "../../funnelfox.ts";

export type FunnelFoxSubscriptionsSyncAction = "sync" | "sync_full_reset" | "dry_run";

/** What the pg_cron ticks send: { auth_user_id, full_reset: true | false }. */
export const FUNNELFOX_SUBSCRIPTIONS_SYNC_CRON_ACTIONS: readonly FunnelFoxSubscriptionsSyncAction[] = ["sync", "sync_full_reset"];

const SYNC_RUN = ["admin.sync.run"];

/** Canonical action from the flags, on both branches (the gate then limits the
 * cron branch to FUNNELFOX_SUBSCRIPTIONS_SYNC_CRON_ACTIONS). */
export function normalizeFunnelFoxSubscriptionsSyncAction({ body, url }: NormalizeActionInput): FunnelFoxSubscriptionsSyncAction {
  const { dryRun, fullReset } = funnelFoxSyncFlags(body, url);
  return funnelFoxDerivedAction<FunnelFoxSubscriptionsSyncAction>(body, dryRun ? "dry_run" : fullReset ? "sync_full_reset" : "sync");
}

export const FUNNELFOX_SUBSCRIPTIONS_SYNC_POLICY: FunctionPolicy<FunnelFoxSubscriptionsSyncAction> = {
  fn: "funnelfox-subscriptions-sync",
  // GET with the same query parameters has always been accepted.
  methods: ["GET", "POST"],
  normalizeAction: normalizeFunnelFoxSubscriptionsSyncAction,
  actions: {
    sync: { allOf: SYNC_RUN, write: true },
    sync_full_reset: { allOf: SYNC_RUN, write: true },
    // Spends upstream calls but writes nothing.
    dry_run: { allOf: SYNC_RUN },
  },
  cron: { header: "x-cron-secret", secretEnv: "FB_CRON_SECRET", actions: [...FUNNELFOX_SUBSCRIPTIONS_SYNC_CRON_ACTIONS] },
};
