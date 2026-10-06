// Access control permission catalog, role templates and scope primitives
// (plan §8, §9). The catalog is the one namespace Edge, SQL validation and the
// browser share, so its exact key set, requires graph and privileged set are
// pinned here: a silent rename would orphan every stored role.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ENFORCED_PERMISSION_KEYS,
  PERMISSION_CATALOG,
  PRIVILEGED_PERMISSION_KEYS,
  closeUnderRequires,
  effectivePermissions,
  isKnownPermission,
  isPrivilegedPermission,
  validateRolePermissions,
} from "../../supabase/functions/_shared/access/permissions.ts";
import { ROLE_TEMPLATES } from "../../supabase/functions/_shared/access/roles.ts";
import {
  accessPartitionInput,
  canonicalPathForScope,
  canonicalScopePaths,
  computeAccessPartition,
  scopeFingerprint,
  scopeHash,
  sha256Hex,
} from "../../supabase/functions/_shared/access/scope.ts";

/** key → requires, exactly as the shared contract lists them. */
const EXPECTED_REQUIRES: Record<string, string[]> = {
  "dashboard.view": [],
  "cohorts.view": [],
  "cohorts.export": ["cohorts.view"],
  "funnels.view": [],
  "funnels.manage": ["funnels.view"],
  "facebook_analytics.view": [],
  "facebook_analytics.export": ["facebook_analytics.view"],
  "forecasting.view": [],
  "forecasting.create": ["forecasting.view"],
  "forecasting.edit": ["forecasting.view"],
  "forecasting.delete": ["forecasting.view"],
  "transactions.view": [],
  "transactions.export": ["transactions.view"],
  "transactions.details.view": ["transactions.view"],
  "payment_pass.view": [],
  "payment_pass.banks.view": ["payment_pass.view"],
  "users.view": [],
  "users.details.view": ["users.view"],
  "users.pii.view": ["users.view"],
  "leads.view": [],
  "subscriptions.view": [],
  "support.view": [],
  "support.messages.view": ["support.view"],
  "support.export": ["support.messages.view"],
  "support.classification.edit": ["support.messages.view"],
  "reports.view": [],
  "reports.create": ["reports.view"],
  "reports.edit": ["reports.view"],
  "reports.publish": ["reports.edit"],
  "reports.export": ["reports.view"],
  "ai.use": [],
  "ai.history.view": ["ai.use"],
  "admin.users.view": [],
  "admin.users.manage": ["admin.users.view"],
  "admin.roles.view": [],
  "admin.roles.manage": ["admin.roles.view"],
  "admin.audit.view": [],
  "admin.integrations.view": [],
  "admin.api_keys.manage": ["admin.integrations.view"],
  "admin.sync.run": [],
  "admin.warehouse.manage": [],
  "admin.data.import": [],
  "admin.diagnostics.view": [],
  "api_export.use": [],
  "financials.revenue.view": [],
  "financials.spend.view": [],
  "financials.profit.view": ["financials.spend.view"],
  "financials.costs.view": [],
};

const PLANNED = ["financials.revenue.view", "financials.spend.view", "financials.profit.view", "financials.costs.view"];
const PII = ["transactions.details.view", "users.pii.view", "support.messages.view"];
const isPrivilegedKey = (key: string) => key.startsWith("admin.") || key === "funnels.manage" || key === "api_export.use";

describe("permission catalog", () => {
  it("contains exactly the contract keys, each once", () => {
    const keys = PERMISSION_CATALOG.map((entry) => entry.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect([...keys].sort()).toEqual(Object.keys(EXPECTED_REQUIRES).sort());
  });

  it("has the contract requires graph, with every prerequisite in the catalog", () => {
    for (const entry of PERMISSION_CATALOG) {
      expect(entry.requires, entry.key).toEqual(EXPECTED_REQUIRES[entry.key]);
      for (const required of entry.requires) expect(isKnownPermission(required), `${entry.key} → ${required}`).toBe(true);
    }
  });

  it("marks only the financials keys as planned", () => {
    const planned = PERMISSION_CATALOG.filter((entry) => entry.status === "planned").map((entry) => entry.key);
    expect(planned.sort()).toEqual([...PLANNED].sort());
    for (const key of PLANNED) expect(ENFORCED_PERMISSION_KEYS.includes(key), key).toBe(false);
    expect(ENFORCED_PERMISSION_KEYS.length).toBe(PERMISSION_CATALOG.length - PLANNED.length);
  });

  it("makes admin.*, funnels.manage and api_export.use full-scope + admin-sensitive, and nothing else", () => {
    for (const entry of PERMISSION_CATALOG) {
      expect(entry.requiresFullScope, entry.key).toBe(isPrivilegedKey(entry.key));
      if (isPrivilegedKey(entry.key)) expect(entry.sensitive, entry.key).toBe("admin");
    }
    expect([...PRIVILEGED_PERMISSION_KEYS].sort()).toEqual(Object.keys(EXPECTED_REQUIRES).filter(isPrivilegedKey).sort());
    expect(isPrivilegedPermission("admin.roles.manage")).toBe(true);
    expect(isPrivilegedPermission("dashboard.view")).toBe(false);
  });

  it("tags the PII keys", () => {
    const pii = PERMISSION_CATALOG.filter((entry) => entry.sensitive === "pii").map((entry) => entry.key);
    expect(pii.sort()).toEqual([...PII].sort());
  });

  it("has labels, descriptions and valid areas everywhere", () => {
    const areas = new Set(["pages", "exports", "details", "forecasting", "reports", "ai", "admin"]);
    for (const entry of PERMISSION_CATALOG) {
      expect(entry.label.trim(), entry.key).not.toBe("");
      expect(entry.description.trim(), entry.key).not.toBe("");
      expect(areas.has(entry.area), entry.key).toBe(true);
    }
  });

  it("recognizes only catalog keys", () => {
    expect(isKnownPermission("cohorts.view")).toBe(true);
    expect(isKnownPermission("cohorts.*")).toBe(false);
    expect(isKnownPermission("admin")).toBe(false);
    expect(isKnownPermission(undefined)).toBe(false);
  });
});

describe("closeUnderRequires / validateRolePermissions", () => {
  it("adds transitive prerequisites, in catalog order, dropping unknown keys", () => {
    expect(closeUnderRequires(["support.export", "nope.view"])).toEqual(["support.view", "support.messages.view", "support.export"]);
    expect(closeUnderRequires(["reports.publish"])).toEqual(["reports.view", "reports.edit", "reports.publish"]);
    expect(closeUnderRequires([])).toEqual([]);
  });

  it("accepts a closed set unchanged", () => {
    expect(validateRolePermissions(["dashboard.view", "cohorts.view"])).toEqual({ ok: true, errors: [], normalized: ["dashboard.view", "cohorts.view"] });
  });

  it("normalizes a set that is not closed under requires without failing it", () => {
    const result = validateRolePermissions(["ai.history.view", "ai.history.view"]);
    expect(result.ok).toBe(true);
    expect(result.normalized).toEqual(["ai.use", "ai.history.view"]);
  });

  it("rejects unknown and planned keys", () => {
    const result = validateRolePermissions(["dashboard.view", "admin.everything", "financials.profit.view", 7 as unknown as string]);
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      "unknown_permission: admin.everything",
      "planned_permission: financials.profit.view",
      "invalid_permission: 7",
    ]);
    expect(result.normalized).toEqual(["dashboard.view"]);
  });
});

describe("effectivePermissions", () => {
  it("gives the Owner every enforced key and no planned key", () => {
    const owner = effectivePermissions({ granted: [], isOwner: true, funnelScopeAll: false });
    expect([...owner].sort()).toEqual([...ENFORCED_PERMISSION_KEYS].sort());
    for (const key of PLANNED) expect(owner.has(key)).toBe(false);
  });

  it("drops unknown and planned grants", () => {
    const set = effectivePermissions({ granted: ["dashboard.view", "made.up", "financials.revenue.view"], isOwner: false, funnelScopeAll: true });
    expect([...set]).toEqual(["dashboard.view"]);
  });

  it("drops a key whose prerequisite is missing, transitively", () => {
    const set = effectivePermissions({
      granted: ["reports.publish", "support.messages.view", "support.export", "cohorts.view", "cohorts.export"],
      isOwner: false,
      funnelScopeAll: true,
    });
    // reports.publish needs reports.edit; support.* chain lacks support.view.
    expect([...set].sort()).toEqual(["cohorts.export", "cohorts.view"]);
  });

  it("drops privileged keys (and their dependents) unless the funnel scope is all", () => {
    const granted = ["dashboard.view", "admin.users.view", "admin.users.manage", "funnels.view", "funnels.manage", "api_export.use"];
    const restricted = effectivePermissions({ granted, isOwner: false, funnelScopeAll: false });
    expect([...restricted].sort()).toEqual(["dashboard.view", "funnels.view"]);
    const full = effectivePermissions({ granted, isOwner: false, funnelScopeAll: true });
    expect([...full].sort()).toEqual([...granted].sort());
  });
});

describe("role templates", () => {
  const byKey = Object.fromEntries(ROLE_TEMPLATES.map((template) => [template.key, template]));

  it("ships exactly the six templates and no Owner template", () => {
    expect(ROLE_TEMPLATES.map((template) => template.key)).toEqual(["admin", "head_of_marketing", "media_buyer", "product_manager", "analyst", "viewer"]);
    expect(byKey.owner).toBeUndefined();
  });

  it("pins the media buyer and viewer sets", () => {
    expect([...byKey.media_buyer.permissions].sort()).toEqual(["ai.use", "cohorts.view", "dashboard.view", "facebook_analytics.view", "funnels.view"]);
    expect([...byKey.viewer.permissions].sort()).toEqual(["cohorts.view", "dashboard.view", "funnels.view", "reports.view"]);
  });

  it("gives admin every enforced key", () => {
    expect([...byKey.admin.permissions].sort()).toEqual([...ENFORCED_PERMISSION_KEYS].sort());
  });

  it("keeps every template valid and closed under requires", () => {
    for (const template of ROLE_TEMPLATES) {
      const result = validateRolePermissions(template.permissions);
      expect(result.ok, template.key).toBe(true);
      expect([...result.normalized].sort(), template.key).toEqual([...template.permissions].sort());
      expect(template.name.trim(), template.key).not.toBe("");
      expect(template.description.trim(), template.key).not.toBe("");
    }
  });

  it("keeps PII and privileged keys out of every non-admin template", () => {
    for (const template of ROLE_TEMPLATES.filter((entry) => entry.key !== "admin")) {
      for (const key of template.permissions) {
        expect(PII.includes(key), `${template.key}: ${key}`).toBe(false);
        expect(isPrivilegedKey(key), `${template.key}: ${key}`).toBe(false);
        expect(PRIVILEGED_PERMISSION_KEYS.has(key), `${template.key}: ${key}`).toBe(false);
      }
    }
  });
});

describe("funnel scope primitives", () => {
  it("canonicalizes paths like the registry (trim, strip leading slash, lowercase)", () => {
    expect(canonicalPathForScope("  /Soulmate-Quiz/V2 ")).toBe("soulmate-quiz/v2");
    expect(canonicalPathForScope("//palm")).toBe("palm");
    expect(canonicalPathForScope(null)).toBe("");
    expect(canonicalScopePaths(["/B", "a", "b", " ", "/"])).toEqual(["a", "b"]);
  });

  it("fingerprints scopes independent of funnel order and case", async () => {
    const a = { mode: "selected" as const, funnelIds: ["B-ID", "a-id"], paths: [] };
    const b = { mode: "selected" as const, funnelIds: ["a-id", "b-id", "a-id"], paths: ["x"] };
    expect(scopeFingerprint(a)).toBe("selected:a-id,b-id");
    expect(await scopeHash(a)).toBe(await scopeHash(b));
    expect(await scopeHash({ mode: "all" })).not.toBe(await scopeHash({ mode: "none" }));
    expect(await scopeHash({ mode: "selected", funnelIds: [], paths: [] })).not.toBe(await scopeHash({ mode: "all" }));
  });

  it("hashes with SHA-256 hex", async () => {
    expect(await sha256Hex("abc")).toBe(createHash("sha256").update("abc").digest("hex"));
  });

  it("mirrors the resolve_access partition input", async () => {
    const input = { workspaceId: "w", userId: "u", accessVersion: "3", mode: "selected" as const, funnelIds: ["f2", "f1"] };
    expect(accessPartitionInput(input)).toBe("w|u|3|selected|f1,f2");
    expect(await computeAccessPartition(input)).toBe(createHash("sha256").update("w|u|3|selected|f1,f2").digest("hex"));
  });
});
