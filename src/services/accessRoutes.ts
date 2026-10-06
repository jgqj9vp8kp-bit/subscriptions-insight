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
// Phase 2: a funnel-restricted member (funnel scope other than "all") opens
// only the rules marked restrictedReady — exactly RESTRICTED_READY_ROUTES, the
// pages whose every Edge action is scopeReady. Every rule states the flag, so a
// new page is closed to restricted members until someone decides otherwise.
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
  /** Open to a funnel-restricted member. True exactly for RESTRICTED_READY_ROUTES
   * (supabase/functions/_shared/access/scopeReadiness.ts). */
  restrictedReady: boolean;
}

/** A guard requirement (route rule or RequirePermission props). Absent fields
 * are not checked; an EMPTY anyOf denies (same as the server ActionPolicy). */
export interface AccessRequirement {
  anyOf?: readonly string[];
  allOf?: readonly string[];
  rawOnly?: boolean;
  /** false ⇒ denied to a funnel-restricted member. */
  restrictedReady?: boolean;
}

/** Why a requirement is denied: the role lacks a key (or access is not
 * resolved), the page is data-owner only, or the member's funnel-restricted
 * access does not include the page. */
export type AccessDenialReason = "permission" | "raw" | "scope";

/** The part of the access value the checks need (a full AccessContextValue fits). */
export type AccessSubject = Pick<AccessContextValue, "status" | "legacy" | "rawAccess" | "restricted" | "can" | "canAny">;

export const ROUTE_ACCESS: readonly RouteAccessRule[] = Object.freeze<RouteAccessRule[]>([
  { path: "/", anyOf: ["dashboard.view"], restrictedReady: true },
  { path: "/transactions", anyOf: ["transactions.view", "payment_pass.view", "payment_pass.banks.view"], restrictedReady: false },
  { path: "/users", anyOf: ["users.view"], allOf: ["users.view", "users.pii.view"], restrictedReady: false },
  { path: "/leads", anyOf: ["leads.view"], rawOnly: true, restrictedReady: false },
  { path: "/cohorts", anyOf: ["cohorts.view"], restrictedReady: true },
  { path: "/funnels", anyOf: ["funnels.view"], restrictedReady: true },
  { path: "/reports", anyOf: ["reports.view"], restrictedReady: false },
  { path: "/fb-analytics", anyOf: ["facebook_analytics.view"], restrictedReady: true },
  { path: "/integrations", anyOf: ["admin.integrations.view"], restrictedReady: false },
  { path: "/support", anyOf: ["support.view"], restrictedReady: false },
  { path: "/forecasting", anyOf: ["forecasting.view"], restrictedReady: false },
  { path: "/subscriptions", anyOf: ["subscriptions.view"], rawOnly: true, restrictedReady: false },
  { path: "/import", anyOf: ["admin.data.import"], rawOnly: true, restrictedReady: false },
  { path: "/admin/members", anyOf: ["admin.users.view"], restrictedReady: false },
  { path: "/admin/roles", anyOf: ["admin.roles.view"], restrictedReady: false },
  { path: "/admin/audit", anyOf: ["admin.audit.view"], restrictedReady: false },
  { path: "/admin/funnels", anyOf: ["admin.users.view", "funnels.manage"], restrictedReady: false },
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

/** Why one requirement is denied, or null when it passes. Legacy ⇒ null
 * (today's behaviour); any status other than "ok" ⇒ "permission" (loading,
 * signed out, no membership, disabled, error). The role is checked first, so
 * "scope" means the role grants the page but the funnel-restricted access
 * does not include it. */
export function accessRuleDenial(rule: AccessRequirement, access: AccessSubject | null | undefined): AccessDenialReason | null {
  if (!access) return "permission";
  if (access.legacy) return null;
  if (access.status !== "ok") return "permission";
  if (rule.allOf && !rule.allOf.every((key) => access.can(key))) return "permission";
  if (rule.anyOf && !access.canAny(rule.anyOf)) return "permission";
  if (rule.rawOnly && !access.rawAccess) return "raw";
  if (access.restricted && rule.restrictedReady === false) return "scope";
  return null;
}

/** Evaluates one requirement (see accessRuleDenial). */
export function checkAccessRule(rule: AccessRequirement, access: AccessSubject | null | undefined): boolean {
  return accessRuleDenial(rule, access) === null;
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
