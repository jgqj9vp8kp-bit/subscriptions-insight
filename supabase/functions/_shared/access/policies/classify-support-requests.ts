// classify-support-requests access policy (plan §7 row "Support admin"; §23).
//
// The resumable classification job reads every support email of the workspace
// and sends its subject and body to the model on the owner's Anthropic key (or
// re-runs the deterministic rules), then rewrites the stored classification.
// That is an ingest / enrichment trigger, so every action — including the
// read-only `status` of the job — requires admin.sync.run (privileged: funnel
// scope `all`, Owner-granted). The job state and every row it touches are keyed
// by ctx.tenantKey, never the caller. The model is a server decision
// (resolveAllowedModel in the entrypoint), not the request's.
//
// The hourly pg_cron tick authenticates with the support-mail internal secret
// (policy.cron; constant-time compare before the body is read) and may only
// `continue` the job — exactly what migration 202607300002 sends. Its tenant is
// the workspace data key; the old unordered `support_mail_sync_state …
// limit(1)` owner lookup is gone.
//
// Both callers always name the action (src/services/supportClassification.ts,
// the cron body), so a missing or unknown action is a 400 — the job's legacy
// "missing ⇒ status" default and its case-folding are not carried over (rule
// R3); the entrypoint hands the job the canonical action. No action is
// scopeReady (Milestone A). Pure module: vitest imports it.

import type { FunctionPolicy, NormalizeActionInput } from "../gate.ts";
import { ActionNormalizeError } from "../errors.ts";
import { SUPPORT_MAIL_INTERNAL_SECRET_ENV, SUPPORT_MAIL_INTERNAL_SECRET_HEADER } from "./sync-support-mail.ts";

export type ClassifySupportRequestsAction = "start" | "continue" | "status" | "reset";

const SYNC_RUN = ["admin.sync.run"];

export const CLASSIFY_SUPPORT_REQUESTS_POLICY: FunctionPolicy<ClassifySupportRequestsAction> = {
  fn: "classify-support-requests",
  methods: ["POST"],
  normalizeAction: normalizeClassifySupportRequestsAction,
  actions: {
    status: { allOf: SYNC_RUN },
    start: { allOf: SYNC_RUN, write: true },
    continue: { allOf: SYNC_RUN, write: true },
    reset: { allOf: SYNC_RUN, write: true },
  },
  cron: { header: SUPPORT_MAIL_INTERNAL_SECRET_HEADER, secretEnv: SUPPORT_MAIL_INTERNAL_SECRET_ENV, actions: ["continue"] },
};

export function normalizeClassifySupportRequestsAction({ body }: NormalizeActionInput): ClassifySupportRequestsAction {
  const action = body.action;
  if (typeof action === "string" && Object.prototype.hasOwnProperty.call(CLASSIFY_SUPPORT_REQUESTS_POLICY.actions, action)) {
    return action as ClassifySupportRequestsAction;
  }
  throw new ActionNormalizeError();
}

/** onError: every failure of the job is the 400 { ok: false, error } the
 * function has always returned (the gate sanitizes the body for everyone but
 * the data owner). */
export function classifySupportRequestsErrorResponse(error: unknown): { status: number; body: Record<string, unknown> } {
  return { status: 400, body: { ok: false, error: error instanceof Error ? error.message : "Support classification failed." } };
}
