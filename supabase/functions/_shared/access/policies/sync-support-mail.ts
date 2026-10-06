// sync-support-mail access policy (plan §7 row "Support admin"; §12.7–12.8).
//
// Every action drives or inspects the SpaceMail IMAP ingestion of the workspace
// support mailbox — sync triggers (initial / continue / new, the Sent-folder
// imports, reply re-matching), their controls (stop, reset_cursor) and the
// mailbox diagnostics (status: sync-state rows with the IMAP host / username;
// test_connection; list_folders) — so every user call requires admin.sync.run
// (privileged: funnel scope `all`, Owner-granted). Rows always land under
// ctx.tenantKey: before access control any signed-in account could import the
// deployment-wide mailbox into its OWN namespace (G1).
//
// The pg_cron / pg_net ticks authenticate with the internal secret header, not a
// session (policy.cron: the gate compares it in constant time BEFORE the body is
// read). The tenant is the workspace data key — the old unordered
// `support_mail_sync_state … limit(1)` owner lookup is gone. The ticks may run
// exactly what the migrations send: sync_new (hourly), sent_initial_sync /
// sent_continue_sync / rematch_replies (the Sent backfill driver and the one-off
// full rematch).
//
// Every caller names its action (the Support page and every cron body), so a
// missing or unknown action is a 400 — the legacy "missing ⇒ sync_new" default
// is not carried over (rule R3). No action is scopeReady (Milestone A). Pure
// module: vitest imports it.

import type { FunctionPolicy, NormalizeActionInput } from "../gate.ts";
import { ActionNormalizeError } from "../errors.ts";

/** The pg_net ticks' shared-secret header and the Edge secret it must match
 * (unchanged names: support_mail_cron_config holds the same value). */
export const SUPPORT_MAIL_INTERNAL_SECRET_HEADER = "x-support-mail-internal-secret";
export const SUPPORT_MAIL_INTERNAL_SECRET_ENV = "SUPPORT_MAIL_SYNC_INTERNAL_SECRET";

export type SyncSupportMailAction =
  | "test_connection"
  | "status"
  | "list_folders"
  | "initial_sync"
  | "continue_sync"
  | "sync_new"
  | "stop"
  | "reset_cursor"
  | "sent_initial_sync"
  | "sent_continue_sync"
  | "sent_sync_new"
  | "rematch_replies";

/** What the pg_cron ticks send (supabase/migrations/202607290002, 202609030002,
 * 202609030004). */
export const SUPPORT_MAIL_CRON_ACTIONS: readonly SyncSupportMailAction[] = ["sync_new", "sent_initial_sync", "sent_continue_sync", "rematch_replies"];

const SYNC_RUN = ["admin.sync.run"];

export const SYNC_SUPPORT_MAIL_POLICY: FunctionPolicy<SyncSupportMailAction> = {
  fn: "sync-support-mail",
  methods: ["POST"],
  normalizeAction: normalizeSyncSupportMailAction,
  actions: {
    status: { allOf: SYNC_RUN },
    list_folders: { allOf: SYNC_RUN },
    // test_connection records the mailbox UIDVALIDITY / counters in the sync state.
    test_connection: { allOf: SYNC_RUN, write: true },
    initial_sync: { allOf: SYNC_RUN, write: true },
    continue_sync: { allOf: SYNC_RUN, write: true },
    sync_new: { allOf: SYNC_RUN, write: true },
    stop: { allOf: SYNC_RUN, write: true },
    reset_cursor: { allOf: SYNC_RUN, write: true },
    sent_initial_sync: { allOf: SYNC_RUN, write: true },
    sent_continue_sync: { allOf: SYNC_RUN, write: true },
    sent_sync_new: { allOf: SYNC_RUN, write: true },
    rematch_replies: { allOf: SYNC_RUN, write: true },
  },
  cron: { header: SUPPORT_MAIL_INTERNAL_SECRET_HEADER, secretEnv: SUPPORT_MAIL_INTERNAL_SECRET_ENV, actions: [...SUPPORT_MAIL_CRON_ACTIONS] },
};

/** Canonical action: the exact body action, on both branches (the gate then
 * limits the cron branch to SUPPORT_MAIL_CRON_ACTIONS). */
export function normalizeSyncSupportMailAction({ body }: NormalizeActionInput): SyncSupportMailAction {
  const action = body.action;
  if (typeof action === "string" && Object.prototype.hasOwnProperty.call(SYNC_SUPPORT_MAIL_POLICY.actions, action)) {
    return action as SyncSupportMailAction;
  }
  throw new ActionNormalizeError();
}
