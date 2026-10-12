// Executable tests for supabase/migrations/202610120001_payment_health_permissions.sql
// (Payment System Health P2, plan section X): the SQL privileged-key predicate
// learns the two payment_health privileged keys. Run against PGlite through the
// Supabase stand-in in ./support/pgliteSupabase.ts on the production shape:
// every earlier migration (pg_cron / pg_net stubbed), the workspace bootstrapped
// before the RLS lockdown, the lockdown, the leads series and the P0 / P1
// payment health migrations.
//
// Covers: the guard (refuses before the P1 registries, changes nothing); the
// pre-flight that refuses when a narrowed member already holds a role with one
// of the keys; the predicate's answer for every catalog key (parity with
// PRIVILEGED_PERMISSION_KEYS); the anti-escalation RPCs now treating the keys
// as privileged (Admin cannot grant, Owner can; a role with them cannot go to a
// narrowed member; a holder cannot be narrowed); the function's privileges;
// idempotent re-apply.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createSupabasePglite, listMigrations, type SqlRunner, type SupabasePglite } from "./support/pgliteSupabase";
import { PERMISSION_CATALOG, PRIVILEGED_PERMISSION_KEYS } from "../../supabase/functions/_shared/access/permissions.ts";
import { seedTemplatesPayload } from "../../supabase/functions/_shared/access/adminApi.ts";

const LOCKDOWN = "202610050003_access_rls_lockdown.sql";
const REGISTRIES = "202610110002_payment_health_registries.sql";
const PERMISSIONS = "202610120001_payment_health_permissions.sql";
const PRIVILEGED_KEYS = ["payment_health.psp_global.view", "payment_health.manage_alerts"];

const CLONE_TIMEOUT = 60_000;

let beforeRegistries: SupabasePglite; // everything before 202610110002 (the guard)
let ready: SupabasePglite; // everything before PERMISSIONS, members seeded
let applied: SupabasePglite; // ready + PERMISSIONS
let owner: string;
let admin: string;
let buyer: string;
let viewer: string;
let roles: Record<string, string>;
let members: Record<string, string>;
let funnelId: string;
const opened: SupabasePglite[] = [];

async function copyOf(source: SupabasePglite): Promise<SupabasePglite> {
  const copy = await source.clone();
  opened.push(copy);
  return copy;
}

async function one<T = Record<string, unknown>>(tx: SqlRunner, expression: string, params: unknown[] = []): Promise<T> {
  return (await tx.query<{ value: T }>(`select ${expression} as value`, params)).rows[0].value;
}

const svc = <T = Record<string, unknown>>(h: SupabasePglite, expression: string, params: unknown[] = []) => h.asService((tx) => one<T>(tx, expression, params));

const CREATE_ROLE = "public.access_create_role($1, $2, $3, $4, $5::text[])";
const UPDATE_ROLE = "public.access_update_role($1, $2, $3, $4, $5::text[])";
const ADD_MEMBER = "public.access_add_member($1, $2, $3, $4, $5::uuid[], $6)";
const UPDATE_MEMBER = "public.access_update_member($1, $2, $3, $4, $5)";
const SET_SCOPE = "public.access_set_member_scope($1, $2, $3, $4::uuid[])";

beforeAll(async () => {
  const base = await createSupabasePglite({ migrations: listMigrations({ before: LOCKDOWN }), extensionStubs: true });
  owner = await base.createAuthUser("owner@example.com");
  admin = await base.createAuthUser("admin@example.com");
  buyer = await base.createAuthUser("buyer@example.com");
  viewer = await base.createAuthUser("viewer@example.com");
  await base.createAuthUser("newbie@example.com");
  funnelId = (await base.db.query<{ id: string }>("insert into public.funnels (funnel_path, display_name) values ('palm-reading', 'Palm') returning id")).rows[0].id;
  await base.db.query("select public.bootstrap_workspace($1, 'SubEngine')", [owner]);
  await svc(base, "public.access_seed_role_templates($1, $2::jsonb)", [owner, JSON.stringify(seedTemplatesPayload())]);
  roles = Object.fromEntries((await base.db.query<{ id: string; key: string }>("select id::text, key from public.access_roles")).rows.map((row) => [row.key, row.id]));
  const add = async (actor: string, email: string, role: string, mode: string, funnelIds: string[] = []) =>
    (await svc<{ member_id: string }>(base, ADD_MEMBER, [actor, email, roles[role], mode, funnelIds, null])).member_id;
  members = {
    admin: await add(owner, "admin@example.com", "admin", "all"),
    buyer: await add(owner, "buyer@example.com", "media_buyer", "selected", [funnelId]),
    viewer: await add(owner, "viewer@example.com", "viewer", "all"),
  };
  for (const name of listMigrations().filter((migration) => migration >= LOCKDOWN && migration < PERMISSIONS)) {
    if (name === REGISTRIES) beforeRegistries = await base.clone();
    await base.applyMigration(name);
  }
  ready = base;
  applied = await ready.clone();
  await applied.applyMigration(PERMISSIONS);
}, 300_000);

afterEach(async () => {
  while (opened.length) await opened.pop()!.close();
});

describe("guard", () => {
  it("follows the P1 registries and covers every migration before it", () => {
    // Adjacency to the prerequisite, never "last in the list": the next migration must not break this suite.
    const all = listMigrations();
    const i = all.indexOf(PERMISSIONS);
    expect(i).toBe(all.indexOf(REGISTRIES) + 1);
    expect(listMigrations({ before: PERMISSIONS })).toEqual(all.slice(0, i));
  });

  it("refuses to apply before the P1 registries, and the predicate keeps its 202610050002 answer", { timeout: CLONE_TIMEOUT }, async () => {
    const h = await copyOf(beforeRegistries);
    await expect(h.applyMigration(PERMISSIONS)).rejects.toThrow(/202610110002_payment_health_registries\.sql has not been applied/);
    expect(await h.asPostgres((tx) => one<boolean>(tx, "app.is_privileged_permission('payment_health.psp_global.view')"))).toBe(false);
    expect(await h.asPostgres((tx) => one<boolean>(tx, "app.is_privileged_permission('admin.users.view')"))).toBe(true);
  });

  it("refuses when a narrowed member already holds a role with one of the keys (the old predicate let an Owner grant it), naming the member", { timeout: CLONE_TIMEOUT }, async () => {
    const h = await copyOf(ready);
    // Before this migration the key is ordinary in SQL: the Owner can create such a role and assign it to a narrowed member.
    const created = await svc<{ role_id: string }>(h, CREATE_ROLE, [owner, "psp_viewer", "PSP viewer", "", ["payment_health.view", "payment_health.psp_global.view"]]);
    await svc(h, UPDATE_MEMBER, [owner, members.buyer, created.role_id, null, null]);
    await expect(h.applyMigration(PERMISSIONS)).rejects.toThrow(new RegExp(`members outside funnel scope all hold a role with a payment_health privileged key: ${members.buyer} \\(psp_viewer\\)`));
    expect(await h.asPostgres((tx) => one<boolean>(tx, "app.is_privileged_permission('payment_health.psp_global.view')"))).toBe(false);
    // Re-scoped to all funnels, the same database applies.
    await svc(h, SET_SCOPE, [owner, members.buyer, "all", []]);
    await expect(h.applyMigration(PERMISSIONS)).resolves.toBeUndefined();
    expect(await h.asPostgres((tx) => one<boolean>(tx, "app.is_privileged_permission('payment_health.psp_global.view')"))).toBe(true);
  });
});

describe("the predicate", () => {
  it("answers exactly what PRIVILEGED_PERMISSION_KEYS says for every catalog key, and false for null / unknown", async () => {
    const keys = PERMISSION_CATALOG.map((entry) => entry.key);
    const rows = await applied.asPostgres((tx) =>
      tx.query<{ k: string; privileged: boolean }>("select k, app.is_privileged_permission(k) as privileged from unnest($1::text[]) k", [keys]),
    );
    expect(rows.rows).toHaveLength(keys.length);
    for (const row of rows.rows) expect(row.privileged, row.k).toBe(PRIVILEGED_PERMISSION_KEYS.has(row.k));
    expect(rows.rows.filter((row) => row.privileged && row.k.startsWith("payment_health.")).map((row) => row.k).sort()).toEqual([...PRIVILEGED_KEYS].sort());
    expect(await applied.asPostgres((tx) => one<boolean>(tx, "app.is_privileged_permission(null)"))).toBe(false);
    expect(await applied.asPostgres((tx) => one<boolean>(tx, "app.is_privileged_permission('payment_health.nothing')"))).toBe(false);
    expect(await applied.asPostgres((tx) => one<boolean>(tx, "app.permissions_privileged(array['payment_health.view', 'payment_health.manage_alerts'])"))).toBe(true);
    expect(await applied.asPostgres((tx) => one<boolean>(tx, "app.permissions_privileged(array['payment_health.view', 'payment_health.export', 'payment_health.risk_events.view'])"))).toBe(false);
  });

  it("stays immutable, search_path-pinned and executable by no API role", async () => {
    const row = await applied.db.query<{ volatility: string; config: string[] | null; anon: boolean; authenticated: boolean; service: boolean }>(
      `select p.provolatile as volatility, p.proconfig as config,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
              has_function_privilege('service_role', p.oid, 'execute') as service
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'app' and p.proname = 'is_privileged_permission'`,
    );
    expect(row.rows).toEqual([{ volatility: "i", config: ['search_path=""'], anon: false, authenticated: false, service: false }]);
  });

  it("re-applies without change", { timeout: CLONE_TIMEOUT }, async () => {
    const h = await copyOf(applied);
    await expect(h.applyMigration(PERMISSIONS)).resolves.toBeUndefined();
    expect(await h.asPostgres((tx) => one<boolean>(tx, "app.is_privileged_permission('payment_health.manage_alerts')"))).toBe(true);
  });
});

describe("anti-escalation through the real RPCs", () => {
  it("an Admin can no longer grant the keys; the Owner can; a role holding them cannot reach or keep a narrowed member", { timeout: CLONE_TIMEOUT }, async () => {
    const h = await copyOf(applied);
    for (const key of PRIVILEGED_KEYS) {
      await expect(svc(h, CREATE_ROLE, [admin, `role_${key.replace(/\W/g, "_")}`, key, "", ["payment_health.view", key]])).rejects.toThrow(
        /escalation_denied: only the Owner may grant privileged permissions/,
      );
      await expect(svc(h, UPDATE_ROLE, [admin, roles.viewer, null, null, ["dashboard.view", "payment_health.view", key]])).rejects.toThrow(/escalation_denied/);
    }
    // The ordinary keys stay grantable by an Admin.
    const plain = await svc<{ role: { permissions: string[] } }>(h, CREATE_ROLE, [admin, "ph_viewer", "PH viewer", "", ["payment_health.view", "payment_health.export", "payment_health.risk_events.view"]]);
    expect([...plain.role.permissions].sort()).toEqual(["payment_health.export", "payment_health.risk_events.view", "payment_health.view"]);

    const privileged = await svc<{ role_id: string; role: { permissions: string[] } }>(h, CREATE_ROLE, [owner, "ph_psp", "PH accounts", "", ["payment_health.view", "payment_health.psp_global.view"]]);
    expect(privileged.role.permissions).toEqual(["payment_health.psp_global.view", "payment_health.view"]);
    await expect(svc(h, ADD_MEMBER, [owner, "newbie@example.com", privileged.role_id, "selected", [funnelId], null])).rejects.toThrow(
      /escalation_denied: a role with privileged permissions requires funnel scope all/,
    );
    await expect(svc(h, UPDATE_MEMBER, [owner, members.buyer, privileged.role_id, null, null])).rejects.toThrow(/requires funnel scope all/);
    // Assigned to a full-scope member, the member can no longer be narrowed, and only the Owner may touch them.
    await svc(h, UPDATE_MEMBER, [owner, members.viewer, privileged.role_id, null, null]);
    await expect(svc(h, SET_SCOPE, [owner, members.viewer, "selected", [funnelId]])).rejects.toThrow(/a member holding privileged permissions requires funnel scope all/);
    await expect(svc(h, UPDATE_MEMBER, [admin, members.viewer, null, "disabled", null])).rejects.toThrow(/only the Owner may modify a member holding privileged permissions/);
    // The effective-permission helper drops the privileged key for anyone outside scope all.
    const holder = await h.asPostgres((tx) => one<boolean>(tx, "app.has_permission('payment_health.psp_global.view')"), viewer);
    expect(holder).toBe(true);
    const resolved = await svc<{ role: { permissions: string[] } }>(h, "public.resolve_access($1)", [viewer]);
    expect(resolved.role.permissions).toEqual(["payment_health.psp_global.view", "payment_health.view"]);
  });

  it("a buyer narrowed to one funnel never gets the privileged key through has_permission, even when the role lists it", { timeout: CLONE_TIMEOUT }, async () => {
    const h = await copyOf(applied);
    // Direct SQL as postgres (the RPCs refuse): the commit-time invariant still refuses the assignment.
    const role = (await h.db.query<{ id: string }>("insert into public.access_roles (workspace_id, key, name, permissions) select id, 'ph_direct', 'Direct', array['payment_health.view', 'payment_health.manage_alerts'] from public.workspaces returning id")).rows[0].id;
    await expect(h.asPostgres((tx) => tx.query("update public.workspace_members set role_id = $2 where id = $1", [members.buyer, role]))).rejects.toThrow(
      /requires funnel scope all/,
    );
    expect(await h.asPostgres((tx) => one<boolean>(tx, "app.has_permission('payment_health.manage_alerts')"), buyer)).toBe(false);
  });
});
