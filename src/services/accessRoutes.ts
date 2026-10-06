// Route → permission map for the SPA (plan §14). One table drives the route
// guards (RequirePermission route=...), the sidebar filter and the "/" redirect
// to the first page the user may open.
//
// UX only: every action behind these pages is re-checked by the Edge gate. The
// rules here mirror the Phase-1 server policies:
//   * Leads, Subscriptions and Import download raw tables to the browser, so
//     they are data-owner only (rawOnly, D8);
//   * /users needs users.pii.view until the server-side redaction ships;
//   * /transactions opens for any of its tabs (the list tab itself is raw-only;
//     the page coerces tabs).
// Order matters: firstAllowedRoute() walks this list in sidebar order.

import type { AccessContextValue } from "@/contexts/accessContext";

export interface RouteAccessRule {
  path: string;
  /** At least one must pass can(). */
  anyOf: string[];
  /** All must pass can(). */
  allOf?: string[];
  /** Data owner only. */
  rawOnly?: boolean;
}

/** A guard requirement (route rule or RequirePermission props). Absent fields
 * are not checked; an EMPTY anyOf denies (same as the server ActionPolicy). */
export interface AccessRequirement {
  anyOf?: readonly string[];
  allOf?: readonly string[];
  rawOnly?: boolean;
}

/** The part of the access value the checks need (a full AccessContextValue fits). */
export type AccessSubject = Pick<AccessContextValue, "status" | "legacy" | "rawAccess" | "can" | "canAny">;

export const ROUTE_ACCESS: readonly RouteAccessRule[] = Object.freeze<RouteAccessRule[]>([
  { path: "/", anyOf: ["dashboard.view"] },
  { path: "/transactions", anyOf: ["transactions.view", "payment_pass.view", "payment_pass.banks.view"] },
  { path: "/users", anyOf: ["users.view"], allOf: ["users.view", "users.pii.view"] },
  { path: "/leads", anyOf: ["leads.view"], rawOnly: true },
  { path: "/cohorts", anyOf: ["cohorts.view"] },
  { path: "/funnels", anyOf: ["funnels.view"] },
  { path: "/reports", anyOf: ["reports.view"] },
  { path: "/fb-analytics", anyOf: ["facebook_analytics.view"] },
  { path: "/integrations", anyOf: ["admin.integrations.view"] },
  { path: "/support", anyOf: ["support.view"] },
  { path: "/forecasting", anyOf: ["forecasting.view"] },
  { path: "/subscriptions", anyOf: ["subscriptions.view"], rawOnly: true },
  { path: "/import", anyOf: ["admin.data.import"], rawOnly: true },
  { path: "/admin/members", anyOf: ["admin.users.view"] },
  { path: "/admin/roles", anyOf: ["admin.roles.view"] },
  { path: "/admin/audit", anyOf: ["admin.audit.view"] },
]);

/** Lower-cased pathname without query, hash or trailing slash ("/" stays "/"). */
export function normalizeRoutePath(path: string): string {
  const bare = String(path ?? "").split(/[?#]/, 1)[0].trim().toLowerCase();
  const withSlash = bare.startsWith("/") ? bare : `/${bare}`;
  const trimmed = withSlash.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

/** The rule for a pathname: exact match, else the longest rule that is a
 * segment prefix ("/admin/members/42" → "/admin/members"). "/" only matches
 * exactly, so unknown paths are NOT treated as the Dashboard. */
export function findRouteAccess(path: string): RouteAccessRule | null {
  const normalized = normalizeRoutePath(path);
  let best: RouteAccessRule | null = null;
  for (const rule of ROUTE_ACCESS) {
    if (rule.path === normalized) return rule;
    if (rule.path !== "/" && normalized.startsWith(`${rule.path}/`) && (!best || rule.path.length > best.path.length)) {
      best = rule;
    }
  }
  return best;
}

/** Evaluates one requirement. Legacy ⇒ allowed (today's behaviour); any status
 * other than "ok" ⇒ denied (loading, signed out, no membership, disabled, error). */
export function checkAccessRule(rule: AccessRequirement, access: AccessSubject | null | undefined): boolean {
  if (!access) return false;
  if (access.legacy) return true;
  if (access.status !== "ok") return false;
  if (rule.rawOnly && !access.rawAccess) return false;
  if (rule.allOf && !rule.allOf.every((key) => access.can(key))) return false;
  if (rule.anyOf && !access.canAny(rule.anyOf)) return false;
  return true;
}

/** Whether `path` may be opened. A path without a rule is denied unless legacy
 * (default deny: a new page must be added to ROUTE_ACCESS to be reachable). */
export function canAccessRoute(path: string, access: AccessSubject | null | undefined): boolean {
  if (access?.legacy) return true;
  const rule = findRouteAccess(path);
  return rule ? checkAccessRule(rule, access) : false;
}

/** The first route (in sidebar order) the user may open, or null when none —
 * the "/" redirect target and the NoAccess "go to" link. */
export function firstAllowedRoute(access: AccessSubject | null | undefined): string | null {
  for (const rule of ROUTE_ACCESS) {
    if (checkAccessRule(rule, access)) return rule.path;
  }
  return null;
}
