// clickhouse-support access policy (plan §7 rows "Support" and "Support admin";
// §18 search oracle; §21 exports).
//
// Canonical actions (body.action → policy key) and who may call them:
//   bundle, options  — support.view (the /support page: aggregates and filter
//                      options; no message content, no addresses).
//   status           — support.view: the export reads it to quote how far the
//                      ClickHouse mirror lags Postgres. The stored sync
//                      diagnostics (raw failure text, which can carry database /
//                      warehouse hosts) are stripped unless the caller has raw
//                      access or admin.sync.run.
//   list, details    — support.messages.view (senders, addresses, subjects,
//                      bodies).
//   export, unanswered_contacts
//                    — support.export: paged rows WITH message bodies, and the
//                      bulk list of unanswered contact addresses (plan §21
//                      "server bulk exports"; the page only calls it from the
//                      "E-mail без ответа" export button).
//   sync             — admin.sync.run (Postgres → ClickHouse mirror; DDL).
//
// Search: a non-empty `filters.search` matches sender, addresses, subject, body
// and contact name, so any read that applies it is a character-by-character
// content / PII oracle through the counts it returns. Such a request gets its
// own action — `<read>_search` — which always requires support.messages.view
// (bundle_search is the one where that is stricter than the read itself;
// export_search keeps support.export on top). The term is computed by the same
// supportSearchTerm() the SQL builder uses, so the two cannot disagree.
// details / options / status / sync never apply filters and keep their action.
//
// The browser always names its action (src/services/supportDataSource.ts), so a
// missing or unknown action is a 400 — the legacy "missing ⇒ bundle" default is
// not carried over (rule R3). No action is scopeReady (Milestone A): funnel-
// restricted members get 403 on every action. Pure module: vitest imports it.

import type { FunctionPolicy, NormalizeActionInput } from "../gate.ts";
import type { AccessContext } from "../accessContext.ts";
import { ActionNormalizeError } from "../errors.ts";
import { supportSearchTerm } from "../../clickhouse/supportContract.ts";

/** The runner each action dispatches to (search variants run their base read). */
export type SupportRead = "bundle" | "options" | "status" | "list" | "details" | "unanswered_contacts" | "export" | "sync";

/** Reads whose runner applies `filters` (and therefore the search term). */
export type SupportFilteredRead = "bundle" | "list" | "unanswered_contacts" | "export";

export type ClickHouseSupportAction = SupportRead | `${SupportFilteredRead}_search`;

const NAMED_ACTIONS: ReadonlySet<string> = new Set<SupportRead>(["bundle", "options", "status", "list", "details", "unanswered_contacts", "export", "sync"]);
const FILTERED_READS: ReadonlySet<string> = new Set<SupportFilteredRead>(["bundle", "list", "unanswered_contacts", "export"]);

export const SUPPORT_SEARCH_ACTIONS: ReadonlySet<ClickHouseSupportAction> = new Set<ClickHouseSupportAction>([
  "bundle_search",
  "list_search",
  "unanswered_contacts_search",
  "export_search",
]);

/** Canonical action. Only exact action names are accepted; a filtered read that
 * carries a non-empty search term becomes `<read>_search`. */
export function normalizeClickHouseSupportAction({ body }: NormalizeActionInput): ClickHouseSupportAction {
  const named = body.action;
  if (typeof named !== "string" || !NAMED_ACTIONS.has(named)) throw new ActionNormalizeError();
  if (FILTERED_READS.has(named) && supportSearchTerm(body.filters)) return `${named as SupportFilteredRead}_search`;
  return named as SupportRead;
}

/** The runner of a canonical action. */
export function supportReadOf(action: ClickHouseSupportAction): SupportRead {
  return (action.endsWith("_search") ? action.slice(0, -"_search".length) : action) as SupportRead;
}

const PAGE = ["support.view"];
const MESSAGES = ["support.messages.view"];

export const CLICKHOUSE_SUPPORT_POLICY: FunctionPolicy<ClickHouseSupportAction> = {
  fn: "clickhouse-support",
  methods: ["POST"],
  normalizeAction: normalizeClickHouseSupportAction,
  actions: {
    bundle: { anyOf: PAGE },
    bundle_search: { allOf: MESSAGES },
    options: { anyOf: PAGE },
    status: { anyOf: PAGE },
    list: { allOf: MESSAGES },
    list_search: { allOf: MESSAGES },
    details: { allOf: MESSAGES },
    unanswered_contacts: { allOf: ["support.export"] },
    unanswered_contacts_search: { allOf: ["support.export", "support.messages.view"] },
    export: { allOf: ["support.export"] },
    export_search: { allOf: ["support.export", "support.messages.view"] },
    sync: { allOf: ["admin.sync.run"], write: true },
  },
};

// ---- status redaction ----------------------------------------------------------

/** Full stored sync diagnostics: the data owner and whoever may run the sync. */
export function supportStatusDetailVisible(ctx: Pick<AccessContext, "rawAccess" | "permissions">): boolean {
  return ctx.rawAccess || ctx.permissions.has("admin.sync.run");
}

/** The status fields every reader gets: lifecycle, cursor and the Postgres /
 * ClickHouse totals the export quotes. Dropped: a top-level `error` and every
 * field not listed here. */
const VIEWER_STATUS_FIELDS = [
  "ok",
  "source",
  "action",
  "status",
  "stopped_reason",
  "rows_scanned",
  "rows_mapped",
  "rows_inserted",
  "rows_skipped",
  "batches_processed",
  "cursor_updated_at",
  "cursor_request_id",
  "source_total",
  "clickhouse_total",
  "duration_ms",
] as const;

/** Stored sync diagnostics kept for viewers: the attribution pass counters.
 * Dropped: `error` (the raw failure text of a failed sync — warehouse / database
 * messages that can name hosts, users and SQL), `failed_batches` and anything
 * not listed here. */
const VIEWER_STATUS_DIAGNOSTICS_FIELDS = ["browser_classification", "attribution"] as const;

function pick(source: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(source, field)) projected[field] = source[field];
  }
  return projected;
}

/** The status response for a support.view reader without sync rights. The
 * shape is unchanged (`diagnostics` is always an object), so the page keeps
 * working. */
export function projectSupportStatusForViewer<T extends object>(result: T): T {
  const source = result as Record<string, unknown>;
  const projected = pick(source, VIEWER_STATUS_FIELDS);
  const diagnostics = source.diagnostics;
  projected.diagnostics = diagnostics && typeof diagnostics === "object" && !Array.isArray(diagnostics)
    ? pick(diagnostics as Record<string, unknown>, VIEWER_STATUS_DIAGNOSTICS_FIELDS)
    : {};
  return projected as T;
}
