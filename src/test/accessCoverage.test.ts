// Whole-repo access coverage (plan §13 layer 1 "T01/T04", §27 R3/R4/R6).
//
// Static checks over every Edge function folder and every policy file, so a new
// or half-migrated function cannot ship outside the gate:
//   * every function folder has a policy file whose constant is named after it,
//     whose `fn` is the folder name and which passes assertValidPolicy;
//   * every index.ts goes through serveWithAccess (export-campaign-performance:
//     its API-key path builds the context itself) and none uses the deprecated
//     "any signed-in user" helpers or the caller's id as the data tenant;
//   * every permission key a policy names exists in the catalog and is enforced;
//   * Phase 2: exactly the 12 media-buyer actions are scopeReady, so a
//     funnel-restricted context is refused (403 scope_not_supported) everywhere
//     else;
//   * no action is open to every member by accident;
//   * the deleted funnelfox-endpoint-probe stays deleted.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { assertValidPolicy, type FunctionPolicy } from "../../supabase/functions/_shared/access/gate.ts";
import { getPermission, isKnownPermission } from "../../supabase/functions/_shared/access/permissions.ts";

const FUNCTIONS_DIR = resolve(process.cwd(), "supabase/functions");
const POLICY_MODULES = import.meta.glob<Record<string, unknown>>("../../supabase/functions/_shared/access/policies/*.ts", { eager: true });

/** Functions that do not use the JWT gate, with the reason. */
const NOT_GATED: Record<string, string> = {
  // API-key auth (verify_jwt=false): resolves the key creator's access itself
  // (resolve_access + decideApiKeyAccess) and reads through createScopedReader.
  "export-campaign-performance": "api_key",
};

/** Access Phase 2 (spec §6 contract 2): the only actions that serve a
 * funnel-restricted context. Kept literal here so a policy edit cannot move
 * the allowlist and its check together. */
const SCOPE_READY_ACTIONS: readonly string[] = [
  "clickhouse-cohorts.details", "clickhouse-cohorts.list", "clickhouse-cohorts.options",
  "clickhouse-facebook.charts", "clickhouse-facebook.filters", "clickhouse-facebook.list", "clickhouse-facebook.report",
  "clickhouse-facebook.status", "clickhouse-facebook.summary",
  "clickhouse-revenue.bundle", "clickhouse-revenue.day_breakdown",
  "clickhouse-summary.summary",
];

/** Actions reachable only through the policy's cron branch (no user permission). */
function cronOnly(policy: FunctionPolicy<string>, action: string): boolean {
  return Boolean(policy.cron?.actions.includes(action));
}

function functionFolders(): string[] {
  return readdirSync(FUNCTIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
    .map((entry) => entry.name)
    .sort();
}

function policyConstName(fn: string): string {
  return `${fn.replace(/-/g, "_").toUpperCase()}_POLICY`;
}

function policyFor(fn: string): FunctionPolicy<string> | undefined {
  const module = POLICY_MODULES[`../../supabase/functions/_shared/access/policies/${fn}.ts`];
  return module?.[policyConstName(fn)] as FunctionPolicy<string> | undefined;
}

function indexSource(fn: string): string {
  return readFileSync(resolve(FUNCTIONS_DIR, fn, "index.ts"), "utf8");
}

const FOLDERS = functionFolders();

describe("Edge access coverage", () => {
  it("finds the function folders", () => {
    expect(FOLDERS.length).toBeGreaterThanOrEqual(27);
    expect(FOLDERS).toContain("access");
  });

  it.each(FOLDERS)("%s has a valid policy named after the function", (fn) => {
    const policy = policyFor(fn);
    expect(policy, `${policyConstName(fn)} in policies/${fn}.ts`).toBeDefined();
    expect(policy?.fn).toBe(fn);
    expect(() => assertValidPolicy(policy as FunctionPolicy<string>)).not.toThrow();
  });

  it("every policy file belongs to an existing function", () => {
    const files = Object.keys(POLICY_MODULES).map((path) => path.split("/").pop()?.replace(/\.ts$/, ""));
    for (const file of files) expect(FOLDERS, `policies/${file}.ts`).toContain(file);
  });

  it.each(FOLDERS)("%s/index.ts goes through the gate and never uses the caller as tenant", (fn) => {
    const source = indexSource(fn);
    for (const banned of ["requireSupabaseUser", "requireCronSecret", "createClickHouseClient", "parseJsonBody"]) {
      expect(source, `${fn}: ${banned}`).not.toContain(banned);
    }
    expect(source, `${fn}: bare auth.id`).not.toMatch(/\bauth\.id\b/);
    expect(source).toContain(`_shared/access/policies/${fn}.ts`);
    if (NOT_GATED[fn]) {
      expect(source).toContain("assertValidPolicy(");
      expect(source).toContain("createScopedReader(");
      expect(source).not.toContain("serveWithAccess(");
    } else {
      expect(source).toContain("serveWithAccess(");
      expect(source).not.toContain("Deno.serve(");
    }
  });

  it.each(FOLDERS)("%s: every permission key is a known, enforced catalog key", (fn) => {
    const policy = policyFor(fn) as FunctionPolicy<string>;
    for (const [action, rule] of Object.entries(policy.actions)) {
      for (const key of [...(rule.anyOf ?? []), ...(rule.allOf ?? [])]) {
        expect(isKnownPermission(key), `${fn}.${action}: ${key}`).toBe(true);
        expect(getPermission(key)?.status, `${fn}.${action}: ${key}`).toBe("enforced");
      }
    }
  });

  it.each(FOLDERS)("%s: Phase 2 — exactly the allowlisted actions are scopeReady", (fn) => {
    const policy = policyFor(fn) as FunctionPolicy<string>;
    for (const [action, rule] of Object.entries(policy.actions)) {
      expect(rule.scopeReady === true, `${fn}.${action}`).toBe(SCOPE_READY_ACTIONS.includes(`${fn}.${action}`));
    }
  });

  it("Phase 2 — the scopeReady allowlist is exactly the 12 media-buyer actions, each in a real policy", () => {
    const ready = FOLDERS.flatMap((fn) =>
      Object.entries((policyFor(fn) as FunctionPolicy<string>).actions)
        .filter(([, rule]) => rule.scopeReady === true)
        .map(([action]) => `${fn}.${action}`),
    );
    expect(ready.sort()).toEqual([...SCOPE_READY_ACTIONS].sort());
    expect(SCOPE_READY_ACTIONS).toHaveLength(12);
  });

  it.each(FOLDERS)("%s: no action is open to every member", (fn) => {
    const policy = policyFor(fn) as FunctionPolicy<string>;
    for (const [action, rule] of Object.entries(policy.actions)) {
      if (cronOnly(policy, action) && !rule.anyOf?.length && !rule.allOf?.length) continue;
      const guarded = Boolean(rule.anyOf || rule.allOf?.length || rule.rawOnly || rule.ownerOnly);
      expect(guarded, `${fn}.${action}`).toBe(true);
    }
  });

  it("funnelfox-endpoint-probe is deleted and nothing deployable references it", () => {
    expect(existsSync(resolve(FUNCTIONS_DIR, "funnelfox-endpoint-probe"))).toBe(false);
    expect(readFileSync(resolve(process.cwd(), "supabase/config.toml"), "utf8")).not.toContain("funnelfox-endpoint-probe");
    for (const fn of FOLDERS) expect(indexSource(fn)).not.toContain("endpoint-probe");
  });
});
