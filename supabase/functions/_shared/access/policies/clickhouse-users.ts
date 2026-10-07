// Access policy of the clickhouse-users Edge function (plan §7 rows "Users
// list/summary", "Users options", "Users details"; §10 dispatch table).
//
// Phase 1 (Milestone A): every action needs users.view AND users.pii.view.
// List rows, the decline tab and the email search carry customer emails until
// the server-side redaction ships (Phase 4), and the /users route guard
// (src/services/accessRoutes.ts) demands the same pair. The drilldown also
// needs users.details.view. No action is scopeReady, so funnel-restricted
// members get 403 scope_not_supported from the gate on every action.
//
// Leads tab (leads plan §3, owner decision 4): leads_list / leads_overview
// serve the server-side lead set — customer emails of people who never paid.
// They need users.view + users.pii.view + leads.view AND raw access, so for the
// first release only the data owner reaches them, like the /leads route guard
// (accessRoutes.ts, rawOnly) and the browser-computed tab they replace.
// Dropping rawOnly later opens them to members holding the three keys.
//
// Pure module (no Deno, no remote imports): vitest imports it directly.

import type { FunctionPolicy } from "../gate.ts";
import { ActionNormalizeError } from "../errors.ts";

export type ClickHouseUsersAction = "list" | "summary" | "options" | "decline" | "details" | "leads_list" | "leads_overview";

const USERS_ACTIONS: readonly ClickHouseUsersAction[] = ["list", "summary", "options", "decline", "details", "leads_list", "leads_overview"];

/** The Users page (list, summary, options, decline tab) — see the header. */
const USERS_PAGE = ["users.view", "users.pii.view"];

/** The Leads tab of the Users page — see the header. */
const LEADS_TAB = [...USERS_PAGE, "leads.view"];

/** Canonical action from the body. The browser always names its action
 * (src/services/usersDataSource.ts), so a missing or unknown action is a 400 —
 * the legacy "missing ⇒ list" default is not carried over (rule R3). */
export function normalizeClickHouseUsersAction(body: Record<string, unknown>): ClickHouseUsersAction {
  const action = body.action;
  if (typeof action === "string" && (USERS_ACTIONS as readonly string[]).includes(action)) return action as ClickHouseUsersAction;
  throw new ActionNormalizeError();
}

export const CLICKHOUSE_USERS_POLICY: FunctionPolicy<ClickHouseUsersAction> = {
  fn: "clickhouse-users",
  normalizeAction: ({ body }) => normalizeClickHouseUsersAction(body),
  actions: {
    list: { allOf: USERS_PAGE },
    summary: { allOf: USERS_PAGE },
    options: { allOf: USERS_PAGE },
    decline: { allOf: USERS_PAGE },
    details: { allOf: [...USERS_PAGE, "users.details.view"] },
    leads_list: { allOf: LEADS_TAB, rawOnly: true },
    leads_overview: { allOf: LEADS_TAB, rawOnly: true },
  },
};
