// Access control permission catalog (plan §8, D6).
//
// The catalog is CODE, not data: a permission means nothing without the check
// that enforces it, so the set of keys lives next to the enforcement and roles
// (DB rows) only hold `text[]` of these keys. Adding a permission therefore
// never needs a migration, and a key the code does not know is never effective.
//
// This module is pure TypeScript with no Deno globals and no remote imports:
// Edge functions, the Postgres-facing validators and the browser (via a relative
// import, like the other _shared contracts) all evaluate the SAME rules.
//
// Effective permission (§8) = granted
//   ∧ every `requires` key is effective too (transitively)
//   ∧ (`requiresFullScope` ⇒ funnel scope = all)
//   ∧ status = "enforced".
// Unknown and planned keys are never effective (fail-closed rule R4).

export type PermissionArea = "pages" | "exports" | "details" | "forecasting" | "reports" | "ai" | "admin";

export interface PermissionDef {
  key: string;
  area: PermissionArea;
  label: string;
  description: string;
  /** Keys that must also be granted for this one to be effective. */
  requires: string[];
  /** Only effective for members whose funnel scope is `all` (anti-escalation D10). */
  requiresFullScope: boolean;
  sensitive: "pii" | "export" | "admin" | "cost" | null;
  /** "planned" keys are shown as "coming" in the roles UI and are never effective. */
  status: "enforced" | "planned";
}

type Sensitive = PermissionDef["sensitive"];

function def(
  key: string,
  area: PermissionArea,
  label: string,
  description: string,
  options: { requires?: string[]; requiresFullScope?: boolean; sensitive?: Sensitive; status?: PermissionDef["status"] } = {},
): PermissionDef {
  return {
    key,
    area,
    label,
    description,
    requires: options.requires ?? [],
    requiresFullScope: options.requiresFullScope ?? false,
    sensitive: options.sensitive ?? null,
    status: options.status ?? "enforced",
  };
}

/** Privileged keys: full scope only, and only the Owner may grant them (SQL
 * enforces the same rule by `like 'admin.%' or in ('funnels.manage','api_export.use')`). */
function privileged(key: string, area: PermissionArea, label: string, description: string, requires: string[] = []): PermissionDef {
  return def(key, area, label, description, { requires, requiresFullScope: true, sensitive: "admin" });
}

export const PERMISSION_CATALOG: readonly PermissionDef[] = Object.freeze([
  // ---- pages and features ----------------------------------------------------
  def("dashboard.view", "pages", "Dashboard", "Open the Dashboard page."),
  def("cohorts.view", "pages", "Cohorts", "Open the Cohorts page and its cohort tables."),
  def("cohorts.export", "exports", "Export cohorts", "Download cohort tables as CSV/XLSX.", { requires: ["cohorts.view"], sensitive: "export" }),
  def("funnels.view", "pages", "Funnels", "Open the Funnels page and the funnel registry."),
  privileged("funnels.manage", "pages", "Manage funnels", "Create, edit, archive and re-path funnels in the registry.", ["funnels.view"]),
  def("facebook_analytics.view", "pages", "Facebook analytics", "Open the FB Analytics page."),
  def("facebook_analytics.export", "exports", "Export Facebook analytics", "Download FB Analytics tables.", {
    requires: ["facebook_analytics.view"],
    sensitive: "export",
  }),

  // ---- forecasting -----------------------------------------------------------
  def("forecasting.view", "forecasting", "Forecasting", "Open the Forecasting page and saved projects."),
  def("forecasting.create", "forecasting", "Create forecasts", "Create new forecasting projects and scenarios.", { requires: ["forecasting.view"] }),
  def("forecasting.edit", "forecasting", "Edit forecasts", "Edit existing forecasting projects and scenarios.", { requires: ["forecasting.view"] }),
  def("forecasting.delete", "forecasting", "Delete forecasts", "Delete forecasting projects and scenarios.", { requires: ["forecasting.view"] }),

  // ---- transactions / payments -----------------------------------------------
  def("transactions.view", "pages", "Transactions", "Open the Transactions page (data-owner only in v1: the list is downloaded raw)."),
  def("transactions.export", "exports", "Export transactions", "Download transaction lists.", { requires: ["transactions.view"], sensitive: "export" }),
  def("transactions.details.view", "details", "Transaction details", "See individual transaction rows with customer identifiers.", {
    requires: ["transactions.view"],
    sensitive: "pii",
  }),
  def("payment_pass.view", "pages", "Payment pass", "Open the Payment Pass analytics tab."),
  def("payment_pass.banks.view", "details", "Bank breakdown", "See the issuer / bank breakdown in Payment Pass analytics.", { requires: ["payment_pass.view"] }),

  // ---- end users -------------------------------------------------------------
  def("users.view", "pages", "Users", "Open the Users page (aggregates)."),
  def("users.details.view", "details", "User details", "Open an individual user's drilldown.", { requires: ["users.view"] }),
  def("users.pii.view", "details", "User personal data", "See customer emails and other personal data.", { requires: ["users.view"], sensitive: "pii" }),
  def("leads.view", "pages", "Leads", "Open the Leads page."),
  def("subscriptions.view", "pages", "Subscriptions", "Open the Subscriptions page."),

  // ---- support ---------------------------------------------------------------
  def("support.view", "pages", "Support", "Open the Support analytics page (aggregates)."),
  def("support.messages.view", "details", "Support messages", "Read individual support messages and sender addresses.", {
    requires: ["support.view"],
    sensitive: "pii",
  }),
  def("support.export", "exports", "Export support", "Download support requests and unanswered contacts.", {
    requires: ["support.messages.view"],
    sensitive: "export",
  }),
  def("support.classification.edit", "details", "Edit support classification", "Correct the category of support requests.", {
    requires: ["support.messages.view"],
  }),

  // ---- reports ---------------------------------------------------------------
  def("reports.view", "reports", "Reports", "Open the Reports page and published reports."),
  def("reports.create", "reports", "Create reports", "Create report drafts.", { requires: ["reports.view"] }),
  def("reports.edit", "reports", "Edit reports", "Edit report drafts.", { requires: ["reports.view"] }),
  def("reports.publish", "reports", "Publish reports", "Publish report versions.", { requires: ["reports.edit"] }),
  def("reports.export", "reports", "Export reports", "Download reports.", { requires: ["reports.view"], sensitive: "export" }),

  // ---- AI --------------------------------------------------------------------
  def("ai.use", "ai", "AI assistant", "Ask the AI assistant and generate AI narratives (model cost).", { sensitive: "cost" }),
  def("ai.history.view", "ai", "AI history", "See the history of AI assistant runs.", { requires: ["ai.use"] }),

  // ---- admin (all privileged: full scope + Owner-granted only) --------------
  privileged("admin.users.view", "admin", "View members", "See workspace members, their roles and funnel scope."),
  privileged("admin.users.manage", "admin", "Manage members", "Add, disable and re-scope workspace members.", ["admin.users.view"]),
  privileged("admin.roles.view", "admin", "View roles", "See roles and their permissions."),
  privileged("admin.roles.manage", "admin", "Manage roles", "Create, edit and delete roles.", ["admin.roles.view"]),
  privileged("admin.audit.view", "admin", "Audit log", "Read the access audit log."),
  privileged("admin.integrations.view", "admin", "Integrations", "Open the Integrations page."),
  privileged("admin.api_keys.manage", "admin", "Manage API keys", "Create and revoke Export API keys.", ["admin.integrations.view"]),
  privileged("admin.sync.run", "admin", "Run syncs", "Trigger data syncs (FunnelFox, Facebook, support mail)."),
  privileged("admin.warehouse.manage", "admin", "Manage warehouse", "Initialize, backfill, validate and rebuild the ClickHouse warehouse."),
  privileged("admin.data.import", "admin", "Import data", "Import payment CSV files."),
  privileged("admin.diagnostics.view", "admin", "Diagnostics", "See warehouse health, reconciliation and allocation diagnostics."),
  privileged("api_export.use", "admin", "Export API", "Use the Export API with an API key."),

  // ---- planned (never effective until enforced) ------------------------------
  def("financials.revenue.view", "details", "Revenue", "See revenue figures.", { status: "planned" }),
  def("financials.spend.view", "details", "Ad spend", "See advertising spend figures.", { status: "planned" }),
  def("financials.profit.view", "details", "Profit", "See profit and margin figures.", { requires: ["financials.spend.view"], status: "planned" }),
  def("financials.costs.view", "details", "Costs", "See cost inputs (fees, COGS).", { status: "planned" }),
]);

const CATALOG_BY_KEY: ReadonlyMap<string, PermissionDef> = new Map(PERMISSION_CATALOG.map((entry) => [entry.key, entry]));

/** Catalog order index — every list this module returns is in catalog order so
 * role diffs and audit before/after snapshots are stable. */
const CATALOG_ORDER: ReadonlyMap<string, number> = new Map(PERMISSION_CATALOG.map((entry, index) => [entry.key, index]));

export const ENFORCED_PERMISSION_KEYS: readonly string[] = Object.freeze(
  PERMISSION_CATALOG.filter((entry) => entry.status === "enforced").map((entry) => entry.key),
);

/** The requiresFullScope set: admin.*, funnels.manage, api_export.use. */
export const PRIVILEGED_PERMISSION_KEYS: ReadonlySet<string> = new Set(
  PERMISSION_CATALOG.filter((entry) => entry.requiresFullScope).map((entry) => entry.key),
);

export function isKnownPermission(key: unknown): boolean {
  return typeof key === "string" && CATALOG_BY_KEY.has(key);
}

export function isPrivilegedPermission(key: unknown): boolean {
  return typeof key === "string" && PRIVILEGED_PERMISSION_KEYS.has(key);
}

export function getPermission(key: string): PermissionDef | undefined {
  return CATALOG_BY_KEY.get(key);
}

function inCatalogOrder(keys: Iterable<string>): string[] {
  return [...new Set(keys)].sort((a, b) => (CATALOG_ORDER.get(a) ?? 0) - (CATALOG_ORDER.get(b) ?? 0));
}

/** Known keys plus everything they transitively require, in catalog order.
 * Unknown keys are dropped (validateRolePermissions reports them). */
export function closeUnderRequires(keys: readonly string[]): string[] {
  const closed = new Set<string>();
  const pending = keys.filter((key) => isKnownPermission(key));
  while (pending.length) {
    const key = pending.pop() as string;
    if (closed.has(key)) continue;
    closed.add(key);
    for (const required of CATALOG_BY_KEY.get(key)?.requires ?? []) {
      if (!closed.has(required)) pending.push(required);
    }
  }
  return inCatalogOrder(closed);
}

/** Validates the permission array of a role save (Edge does this before calling
 * the access_* RPCs). Unknown or planned keys are errors; a set that is not
 * closed under `requires` is not an error — `normalized` adds the missing keys
 * so the stored role is always closed. */
export function validateRolePermissions(keys: readonly unknown[]): { ok: boolean; errors: string[]; normalized: string[] } {
  const errors: string[] = [];
  const accepted: string[] = [];
  if (!Array.isArray(keys)) return { ok: false, errors: ["invalid_permissions: expected an array of permission keys"], normalized: [] };
  for (const key of keys) {
    if (typeof key !== "string") {
      errors.push(`invalid_permission: ${JSON.stringify(key)}`);
      continue;
    }
    const entry = CATALOG_BY_KEY.get(key);
    if (!entry) {
      errors.push(`unknown_permission: ${key}`);
      continue;
    }
    if (entry.status !== "enforced") {
      errors.push(`planned_permission: ${key}`);
      continue;
    }
    accepted.push(key);
  }
  return { ok: errors.length === 0, errors, normalized: closeUnderRequires(accepted) };
}

/** The effective permission set of a member (§8). Owner ⇒ every enforced key.
 * Otherwise granted ∩ enforced, minus full-scope keys when the funnel scope is
 * not `all`, then iterated to a fixed point so a key whose prerequisite was
 * removed is removed too (requires are transitive). */
export function effectivePermissions(input: { granted: readonly string[]; isOwner: boolean; funnelScopeAll: boolean }): Set<string> {
  if (input.isOwner) return new Set(ENFORCED_PERMISSION_KEYS);
  const effective = new Set<string>();
  for (const key of Array.isArray(input.granted) ? input.granted : []) {
    const entry = typeof key === "string" ? CATALOG_BY_KEY.get(key) : undefined;
    if (!entry || entry.status !== "enforced") continue;
    if (entry.requiresFullScope && !input.funnelScopeAll) continue;
    effective.add(key);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const key of [...effective]) {
      const requires = CATALOG_BY_KEY.get(key)?.requires ?? [];
      if (requires.some((required) => !effective.has(required))) {
        effective.delete(key);
        changed = true;
      }
    }
  }
  return effective;
}
