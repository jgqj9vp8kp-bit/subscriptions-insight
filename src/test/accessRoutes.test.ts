import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  canAccessRoute,
  checkAccessRule,
  findRouteAccess,
  firstAllowedRoute,
  normalizeRoutePath,
  ROUTE_ACCESS,
} from "@/services/accessRoutes";
import { buildAccessValue, type AccessStatus } from "@/contexts/accessContext";
import type { MyAccess } from "@/services/accessClient";
import { isKnownPermission, PERMISSION_CATALOG } from "../../supabase/functions/_shared/access/permissions.ts";
import { ROLE_TEMPLATES } from "../../supabase/functions/_shared/access/roles.ts";

const USER = "8d1c2c51-0000-4000-8000-000000000003";

function okAccess(input: { permissions?: string[]; isOwner?: boolean; mode?: "all" | "selected" | "none"; rawAccess?: boolean }): MyAccess {
  return {
    status: "ok",
    workspace_id: "ws-1",
    member_id: "member-1",
    user_id: USER,
    email: "member@example.com",
    display_name: null,
    is_data_owner: input.rawAccess === true,
    raw_access: input.rawAccess === true,
    role: { id: "role-1", key: "custom", name: "Custom", is_owner: input.isOwner === true, permissions: input.permissions ?? [] },
    funnel_scope: { mode: input.mode ?? "all", funnel_ids: [], paths: [] },
    access_version: "1",
    partition: "p-1",
  };
}

function valueFor(access: MyAccess) {
  return buildAccessValue({ status: "ok", access, userId: USER });
}

function statusValue(status: AccessStatus) {
  return buildAccessValue({ status, access: null, userId: USER });
}

function templatePermissions(key: string): string[] {
  const template = ROLE_TEMPLATES.find((entry) => entry.key === key);
  if (!template) throw new Error(`missing role template ${key}`);
  return template.permissions;
}

const owner = valueFor(okAccess({ isOwner: true, rawAccess: true }));
const viewer = valueFor(okAccess({ permissions: templatePermissions("viewer") }));
const mediaBuyer = valueFor(okAccess({ permissions: templatePermissions("media_buyer") }));
const legacy = buildAccessValue({ status: "legacy", access: null, userId: USER });

describe("ROUTE_ACCESS", () => {
  it("covers every protected route in src/App.tsx plus the three admin routes", () => {
    const app = readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf8");
    const appRoutes = [...app.matchAll(/<Route\s+path="(\/[^"]*)"/g)].map((match) => match[1]).filter((path) => path !== "/login");
    expect(appRoutes.length).toBeGreaterThanOrEqual(13);

    const covered = new Set(ROUTE_ACCESS.map((rule) => rule.path));
    for (const path of [...appRoutes, "/admin/members", "/admin/roles", "/admin/audit"]) {
      expect(covered.has(path), `ROUTE_ACCESS is missing ${path}`).toBe(true);
    }
  });

  it("references only known, enforced catalog permissions", () => {
    for (const rule of ROUTE_ACCESS) {
      expect(rule.anyOf.length, rule.path).toBeGreaterThan(0);
      for (const key of [...rule.anyOf, ...(rule.allOf ?? [])]) {
        expect(isKnownPermission(key), `${rule.path}: ${key}`).toBe(true);
        expect(PERMISSION_CATALOG.find((entry) => entry.key === key)?.status, `${rule.path}: ${key}`).toBe("enforced");
      }
    }
  });

  it("has unique paths and pins the Phase-1 rules", () => {
    expect(new Set(ROUTE_ACCESS.map((rule) => rule.path)).size).toBe(ROUTE_ACCESS.length);
    expect(findRouteAccess("/users")?.allOf).toEqual(["users.view", "users.pii.view"]);
    expect(findRouteAccess("/transactions")?.anyOf).toEqual(["transactions.view", "payment_pass.view", "payment_pass.banks.view"]);
    for (const path of ["/leads", "/subscriptions", "/import"]) expect(findRouteAccess(path)?.rawOnly, path).toBe(true);
  });
});

describe("findRouteAccess / normalizeRoutePath", () => {
  it("normalizes query, hash, trailing slash and case", () => {
    expect(normalizeRoutePath("/Cohorts/?tab=x#top")).toBe("/cohorts");
    expect(normalizeRoutePath("")).toBe("/");
    expect(normalizeRoutePath("/")).toBe("/");
  });

  it("matches nested paths by segment prefix but never falls back to the Dashboard", () => {
    expect(findRouteAccess("/admin/members/42")?.path).toBe("/admin/members");
    expect(findRouteAccess("/cohorts-old")).toBeNull();
    expect(findRouteAccess("/unknown")).toBeNull();
    expect(findRouteAccess("/")?.path).toBe("/");
  });
});

describe("canAccessRoute", () => {
  it("owner opens every route", () => {
    for (const rule of ROUTE_ACCESS) expect(canAccessRoute(rule.path, owner), rule.path).toBe(true);
  });

  it("legacy opens every route, including unknown ones (today's behaviour)", () => {
    for (const rule of ROUTE_ACCESS) expect(canAccessRoute(rule.path, legacy), rule.path).toBe(true);
    expect(canAccessRoute("/something-new", legacy)).toBe(true);
  });

  it("viewer opens only its template pages", () => {
    const allowed = ROUTE_ACCESS.filter((rule) => canAccessRoute(rule.path, viewer)).map((rule) => rule.path);
    expect(allowed).toEqual(["/", "/cohorts", "/funnels", "/reports"]);
  });

  it("media buyer adds FB analytics but no admin, PII or raw pages", () => {
    const allowed = ROUTE_ACCESS.filter((rule) => canAccessRoute(rule.path, mediaBuyer)).map((rule) => rule.path);
    expect(allowed).toEqual(["/", "/cohorts", "/funnels", "/fb-analytics"]);
  });

  it("users page needs users.pii.view on top of users.view", () => {
    expect(canAccessRoute("/users", valueFor(okAccess({ permissions: ["users.view"] })))).toBe(false);
    expect(canAccessRoute("/users", valueFor(okAccess({ permissions: ["users.view", "users.pii.view"] })))).toBe(true);
  });

  it("raw-only routes stay closed for a non-owner even with the permission", () => {
    const nonRaw = valueFor(okAccess({ permissions: ["leads.view", "subscriptions.view"] }));
    expect(canAccessRoute("/leads", nonRaw)).toBe(false);
    expect(canAccessRoute("/subscriptions", nonRaw)).toBe(false);
    const raw = valueFor(okAccess({ permissions: ["leads.view"], rawAccess: true }));
    expect(canAccessRoute("/leads", raw)).toBe(true);
  });

  it("transactions opens for any of its tabs", () => {
    expect(canAccessRoute("/transactions", valueFor(okAccess({ permissions: ["payment_pass.view"] })))).toBe(true);
    expect(canAccessRoute("/transactions", valueFor(okAccess({ permissions: ["cohorts.view"] })))).toBe(false);
  });

  it("admin routes need full scope (privileged keys are not effective under a restricted scope)", () => {
    const keys = ["admin.users.view", "admin.roles.view", "admin.audit.view"];
    expect(canAccessRoute("/admin/members", valueFor(okAccess({ permissions: keys, mode: "all" })))).toBe(true);
    expect(canAccessRoute("/admin/members", valueFor(okAccess({ permissions: keys, mode: "selected" })))).toBe(false);
  });

  it("denies unknown paths and every non-ok status", () => {
    expect(canAccessRoute("/something-new", owner)).toBe(false);
    for (const status of ["loading", "signed_out", "no_membership", "disabled", "error"] as const) {
      expect(canAccessRoute("/", statusValue(status)), status).toBe(false);
    }
    expect(canAccessRoute("/", null)).toBe(false);
  });
});

describe("checkAccessRule", () => {
  it("an empty anyOf denies; no requirement allows any ok member", () => {
    expect(checkAccessRule({ anyOf: [] }, owner)).toBe(false);
    expect(checkAccessRule({}, viewer)).toBe(true);
    expect(checkAccessRule({}, statusValue("no_membership"))).toBe(false);
  });

  it("allOf requires every key", () => {
    expect(checkAccessRule({ allOf: ["cohorts.view", "funnels.view"] }, viewer)).toBe(true);
    expect(checkAccessRule({ allOf: ["cohorts.view", "cohorts.export"] }, viewer)).toBe(false);
  });
});

describe("firstAllowedRoute", () => {
  it("returns the first allowed route in sidebar order", () => {
    expect(firstAllowedRoute(owner)).toBe("/");
    expect(firstAllowedRoute(viewer)).toBe("/");
    expect(firstAllowedRoute(valueFor(okAccess({ permissions: ["forecasting.view", "cohorts.view"] })))).toBe("/cohorts");
    expect(firstAllowedRoute(valueFor(okAccess({ permissions: ["support.view"] })))).toBe("/support");
  });

  it("returns null when nothing is allowed", () => {
    expect(firstAllowedRoute(valueFor(okAccess({ permissions: [] })))).toBeNull();
    expect(firstAllowedRoute(valueFor(okAccess({ permissions: ["ai.use"] })))).toBeNull();
    expect(firstAllowedRoute(statusValue("loading"))).toBeNull();
    expect(firstAllowedRoute(null)).toBeNull();
  });

  it("legacy lands on the Dashboard", () => {
    expect(firstAllowedRoute(legacy)).toBe("/");
  });
});
