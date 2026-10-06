// Access policy of the `access` Edge function, the access admin API (plan §7 row
// "Access admin (new)", §15-§17, §24; SHARED CONTRACT A). POST only, JSON
// { action, ... }; the canonical action is the body `action`, named by the
// Admin → Access pages on every call, so a missing or unknown action is a 400
// (rule R3: no default).
//
// Every action is workspace administration and needs an admin.* permission or,
// for the funnel-path registry (access Phase 2, spec §6 contract 8),
// funnels.manage. Every admin.* key and funnels.manage is requiresFullScope, so
// a funnel-restricted member never holds one (effectivePermissions drops it)
// and the gate refuses the request before the handler runs; the two path
// writes are also fullScopeOnly. No action is scopeReady and none is open to
// "any member": a caller's OWN access comes from public.my_access() through
// PostgREST, not from here.
//
// The handler reads the member / role / scope / audit tables, the funnel
// registry (funnel_paths of every status) and the cohort snapshot state with
// the service-role client (it bypasses RLS), so this table IS the read
// authorization. The mutation RPCs re-check permission and anti-escalation
// inside their own transaction under the workspace lock (defence in depth).
//
// Pure module (no Deno, no remote imports): vitest imports it directly.

import type { FunctionPolicy, NormalizeActionInput } from "../gate.ts";
import { ActionNormalizeError } from "../errors.ts";

export type AccessAdminAction =
  | "catalog"
  | "members.list"
  | "members.add"
  | "members.update"
  | "members.set_scope"
  | "members.effective"
  | "roles.list"
  | "roles.create"
  | "roles.update"
  | "roles.delete"
  | "roles.seed_templates"
  | "audit.list"
  | "funnels.list"
  | "paths.coverage"
  | "paths.attach"
  | "paths.set_status";

export const ACCESS_ADMIN_ACTIONS: readonly AccessAdminAction[] = Object.freeze([
  "catalog",
  "members.list",
  "members.add",
  "members.update",
  "members.set_scope",
  "members.effective",
  "roles.list",
  "roles.create",
  "roles.update",
  "roles.delete",
  "roles.seed_templates",
  "audit.list",
  "funnels.list",
  "paths.coverage",
  "paths.attach",
  "paths.set_status",
]);

/** Canonical action from the body `action` (exact, case-sensitive). */
export function normalizeAccessAdminAction({ body }: NormalizeActionInput): AccessAdminAction {
  const action = body.action;
  if (typeof action === "string" && (ACCESS_ADMIN_ACTIONS as readonly string[]).includes(action)) return action as AccessAdminAction;
  throw new ActionNormalizeError();
}

export const ACCESS_POLICY: FunctionPolicy<AccessAdminAction> = {
  fn: "access",
  methods: ["POST"],
  normalizeAction: normalizeAccessAdminAction,
  actions: {
    // The permission catalog and role templates: shared by the three admin
    // pages (/admin/members, /admin/roles, /admin/audit render permission
    // labels), so any of their view permissions.
    catalog: { anyOf: ["admin.users.view", "admin.roles.view", "admin.audit.view"] },

    // /admin/members.
    "members.list": { anyOf: ["admin.users.view"] },
    "members.effective": { anyOf: ["admin.users.view"] },
    // The funnel picker of the member sheet (registry names + tags only).
    "funnels.list": { anyOf: ["admin.users.view"] },
    "members.add": { allOf: ["admin.users.manage"], write: true },
    "members.update": { allOf: ["admin.users.manage"], write: true },
    "members.set_scope": { allOf: ["admin.users.manage"], write: true },

    // /admin/roles, plus the role picker of /admin/members (the same read the
    // access_roles RLS policy grants to admin.users.view).
    "roles.list": { anyOf: ["admin.roles.view", "admin.users.view"] },
    "roles.create": { allOf: ["admin.roles.manage"], write: true },
    "roles.update": { allOf: ["admin.roles.manage"], write: true },
    "roles.delete": { allOf: ["admin.roles.manage"], write: true },
    // access_seed_role_templates is Owner-only in SQL too.
    "roles.seed_templates": { ownerOnly: true, allOf: ["admin.roles.manage"], write: true },

    // /admin/audit.
    "audit.list": { anyOf: ["admin.audit.view"] },

    // /admin/funnels (Funnel coverage). The coverage read runs one all-scope
    // ClickHouse statement over the active cohort snapshot; the path writes go
    // through access_attach_funnel_path / access_set_funnel_path_status, which
    // re-check funnels.manage in SQL and audit registry.path_*.
    "paths.coverage": { anyOf: ["admin.users.view", "funnels.manage"] },
    "paths.attach": { allOf: ["funnels.manage"], fullScopeOnly: true, write: true },
    "paths.set_status": { allOf: ["funnels.manage"], fullScopeOnly: true, write: true },
  },
};
