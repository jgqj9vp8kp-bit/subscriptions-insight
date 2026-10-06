// Executable tests for supabase/migrations/202610050002_access_core.sql, run
// against PGlite (real Postgres compiled to WASM) via the Supabase stand-in in
// ./support/pgliteSupabase.ts. Covers: bootstrap latch, resolve_access /
// my_access shapes, mutation RPCs + anti-escalation, Owner / data-owner /
// last-owner invariants, append-only audit, RLS + grants, access_version bumps,
// and the cross-layer contract: the JSON the SQL actually emits is fed through
// the Edge gate's parser (accessContext.ts) and the browser's (accessClient.ts),
// the partition is recomputed with the TS formula, and the SQL privileged-key
// predicate is compared with the TS catalog.
//
// Runs in the default jsdom environment: src/test/setup.ts touches `window`,
// so the node environment pragma cannot be used until setup.ts guards it. The
// harness makes PGlite work under jsdom (see withNodeBlobs there).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  ACCESS_TEST_MIGRATIONS,
  createSupabasePglite,
  readMigration,
  type SqlRunner,
  type SupabasePglite,
} from "./support/pgliteSupabase";
import { buildAccessContext, parseResolveAccessRow } from "../../supabase/functions/_shared/access/accessContext.ts";
import {
  ENFORCED_PERMISSION_KEYS,
  PERMISSION_CATALOG,
  PRIVILEGED_PERMISSION_KEYS,
} from "../../supabase/functions/_shared/access/permissions.ts";
import { ROLE_TEMPLATES } from "../../supabase/functions/_shared/access/roles.ts";
import { accessPartitionInput, type FunnelScopeMode } from "../../supabase/functions/_shared/access/scope.ts";
import { MY_ACCESS_RPC, parseMyAccessPayload } from "@/services/accessClient";

// Mirrors the enforced keys of supabase/functions/_shared/access/permissions.ts
// (shared contract). Written out so a catalog edit shows up as a diff here;
// "contract parity" below asserts it equals ENFORCED_PERMISSION_KEYS.
const ENFORCED_PERMISSIONS = [
  "dashboard.view", "cohorts.view", "cohorts.export", "funnels.view", "funnels.manage",
  "facebook_analytics.view", "facebook_analytics.export",
  "forecasting.view", "forecasting.create", "forecasting.edit", "forecasting.delete",
  "transactions.view", "transactions.export", "transactions.details.view",
  "payment_pass.view", "payment_pass.banks.view",
  "users.view", "users.details.view", "users.pii.view", "leads.view", "subscriptions.view",
  "support.view", "support.messages.view", "support.export", "support.classification.edit",
  "reports.view", "reports.create", "reports.edit", "reports.publish", "reports.export",
  "ai.use", "ai.history.view",
  "admin.users.view", "admin.users.manage", "admin.roles.view", "admin.roles.manage", "admin.audit.view",
  "admin.integrations.view", "admin.api_keys.manage", "admin.sync.run", "admin.warehouse.manage",
  "admin.data.import", "admin.diagnostics.view", "api_export.use",
];

const TEMPLATES = [
  { key: "admin", name: "Admin", description: "Everything", permissions: ENFORCED_PERMISSIONS },
  {
    key: "head_of_marketing",
    name: "Head of Marketing",
    description: "",
    permissions: ["dashboard.view", "cohorts.view", "cohorts.export", "funnels.view", "facebook_analytics.view", "reports.view", "ai.use"],
  },
  {
    key: "media_buyer",
    name: "Media Buyer",
    description: "",
    permissions: ["dashboard.view", "cohorts.view", "funnels.view", "facebook_analytics.view", "ai.use"],
  },
  { key: "product_manager", name: "Product Manager", description: "", permissions: ["dashboard.view", "cohorts.view", "funnels.view", "forecasting.view"] },
  { key: "analyst", name: "Analyst", description: "", permissions: ["dashboard.view", "cohorts.view", "cohorts.export", "funnels.view", "reports.view"] },
  { key: "viewer", name: "Viewer", description: "", permissions: ["dashboard.view", "cohorts.view", "funnels.view", "reports.view"] },
];

type Json = Record<string, unknown>;

interface Seed {
  h: SupabasePglite;
  users: {
    owner: string;
    admin: string;
    viewer: string;
    buyer: string;
    disabled: string;
    outsider: string;
    pending: string;
    newbie: string;
  };
  roles: Record<string, string>;
  members: { owner: string; admin: string; viewer: string; buyer: string; disabled: string };
  funnels: { soulmate: string; palm: string; pastLife: string };
}

async function one<T = Json>(tx: SqlRunner, expression: string, params: unknown[] = []): Promise<T> {
  const result = await tx.query<{ value: T }>(`select ${expression} as value`, params);
  return result.rows[0].value;
}

function svc<T = Json>(h: SupabasePglite, expression: string, params: unknown[] = []): Promise<T> {
  return h.asService((tx) => one<T>(tx, expression, params));
}

const ADD_MEMBER = "public.access_add_member($1, $2, $3, $4, $5::uuid[], $6)";
const UPDATE_MEMBER = "public.access_update_member($1, $2, $3, $4, $5)";
const SET_SCOPE = "public.access_set_member_scope($1, $2, $3, $4::uuid[])";
const CREATE_ROLE = "public.access_create_role($1, $2, $3, $4, $5::text[])";
const UPDATE_ROLE = "public.access_update_role($1, $2, $3, $4, $5::text[])";
const DELETE_ROLE = "public.access_delete_role($1, $2)";

let base: SupabasePglite;
let seeded: Seed;
const opened: SupabasePglite[] = [];

async function fresh(): Promise<SupabasePglite> {
  const copy = await base.clone();
  opened.push(copy);
  return copy;
}

async function seededCopy(): Promise<Seed> {
  const h = await seeded.h.clone();
  opened.push(h);
  return { ...seeded, h };
}

async function buildSeed(): Promise<Seed> {
  const h = await base.clone();
  const users = {
    owner: await h.createAuthUser("Owner@Example.com"),
    admin: await h.createAuthUser("admin@example.com"),
    viewer: await h.createAuthUser("viewer@example.com"),
    buyer: await h.createAuthUser("buyer@example.com"),
    disabled: await h.createAuthUser("disabled@example.com"),
    outsider: await h.createAuthUser("outsider@example.com"),
    pending: await h.createAuthUser("pending@example.com", { confirmed: false }),
    newbie: await h.createAuthUser("newbie@example.com"),
  };
  const funnelRows = await h.db.query<{ id: string; funnel_path: string }>(
    `insert into public.funnels (funnel_path, display_name) values
       ('/Soulmate-Sketch ', 'Soulmate'), ('palm-reading', 'Palm'), ('past-life', 'Past life')
     returning id, funnel_path`,
  );
  const funnelId = (path: string) => funnelRows.rows.find((row) => row.funnel_path === path)!.id;
  const funnels = { soulmate: funnelId("/Soulmate-Sketch "), palm: funnelId("palm-reading"), pastLife: funnelId("past-life") };

  await h.db.query("select public.bootstrap_workspace($1, 'SubEngine')", [users.owner]);
  await svc(h, "public.access_seed_role_templates($1, $2::jsonb)", [users.owner, JSON.stringify(TEMPLATES)]);
  const roleRows = await h.db.query<{ id: string; key: string }>("select id, key from public.access_roles");
  const roles = Object.fromEntries(roleRows.rows.map((row) => [row.key, row.id]));

  const add = async (actor: string, email: string, role: string, mode: string, funnelIds: string[] = []) => {
    const result = await svc(h, ADD_MEMBER, [actor, email, roles[role], mode, funnelIds, null]);
    return result.member_id as string;
  };
  const members = {
    owner: (await h.db.query<{ id: string }>("select id from public.workspace_members where user_id = $1", [users.owner])).rows[0].id,
    admin: await add(users.owner, "admin@example.com", "admin", "all"),
    viewer: await add(users.admin, "viewer@example.com", "viewer", "all"),
    buyer: await add(users.admin, "buyer@example.com", "media_buyer", "selected", [funnels.soulmate, funnels.palm]),
    disabled: await add(users.admin, "disabled@example.com", "viewer", "all"),
  };
  await svc(h, UPDATE_MEMBER, [users.admin, members.disabled, null, "disabled", null]);
  return { h, users, roles, members, funnels };
}

beforeAll(async () => {
  base = await createSupabasePglite({ migrations: ACCESS_TEST_MIGRATIONS });
  seeded = await buildSeed();
}, 120_000);

afterEach(async () => {
  while (opened.length) await opened.pop()!.close();
});

describe("bootstrap_workspace", () => {
  it("reports no_workspace before the latch exists", async () => {
    const h = await fresh();
    const user = await h.createAuthUser("someone@example.com");
    expect(await svc(h, "public.resolve_access($1)", [user])).toEqual({
      status: "no_workspace",
      user_id: user,
      workspace_id: null,
    });
    const mine = await h.asUser(user, (tx) => one(tx, "public.my_access()"));
    expect(mine.status).toBe("no_workspace");
    expect(await svc(h, "public.workspace_data_key()")).toBeNull();
  });

  it("creates the workspace, Owner role, data-owner membership and revokes foreign API keys", async () => {
    const h = await fresh();
    const owner = await h.createAuthUser("owner@example.com");
    const other = await h.createAuthUser("other@example.com");
    await h.db.query(
      `insert into public.api_keys (user_id, name, key_hash, prefix) values
         ($1, 'owner key', 'hash-owner', 'sk_o'), ($2, 'other key', 'hash-other', 'sk_x')`,
      [owner, other],
    );

    const result = await h.asService((tx) => one(tx, "public.bootstrap_workspace($1, 'SubEngine')", [owner]));
    expect(result).toMatchObject({ ok: true, api_keys_revoked: 1 });

    const workspace = await h.db.query<{ id: string; data_key: string; name: string }>("select * from public.workspaces");
    expect(workspace.rows).toHaveLength(1);
    expect(workspace.rows[0]).toMatchObject({ id: result.workspace_id, data_key: owner, name: "SubEngine" });

    const role = await h.db.query("select key, is_owner, is_system, permissions from public.access_roles");
    expect(role.rows).toEqual([{ key: "owner", is_owner: true, is_system: true, permissions: [] }]);

    const member = await h.db.query(
      "select user_id, status, is_data_owner, email_snapshot from public.workspace_members",
    );
    expect(member.rows).toEqual([
      { user_id: owner, status: "active", is_data_owner: true, email_snapshot: "owner@example.com" },
    ]);
    const rule = await h.db.query("select dimension, mode from public.member_scope_rules");
    expect(rule.rows).toEqual([{ dimension: "funnel", mode: "all" }]);

    const keys = await h.db.query<{ user_id: string; is_active: boolean; revoked_at: unknown }>(
      "select user_id, is_active, revoked_at from public.api_keys order by name",
    );
    expect(keys.rows.find((k) => k.user_id === other)).toMatchObject({ is_active: false });
    expect(keys.rows.find((k) => k.user_id === other)!.revoked_at).not.toBeNull();
    expect(keys.rows.find((k) => k.user_id === owner)).toMatchObject({ is_active: true, revoked_at: null });

    const audit = await h.db.query<{ event: string; actor_kind: string; outcome: string; after: Json }>(
      "select event, actor_kind, outcome, after from public.access_audit_log",
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ event: "bootstrap.completed", actor_kind: "system", outcome: "success" });
    expect(audit.rows[0].after).toMatchObject({ workspace_id: result.workspace_id, api_keys_revoked: 1 });
    expect(await svc(h, "public.workspace_data_key()")).toBe(owner);
  });

  it("refuses a second bootstrap and an unknown data owner", async () => {
    const h = await fresh();
    const owner = await h.createAuthUser("owner@example.com");
    await expect(
      h.db.query("select public.bootstrap_workspace($1, 'X')", ["00000000-0000-0000-0000-000000000001"]),
    ).rejects.toThrow(/not_found: the data owner user does not exist/);
    await h.db.query("select public.bootstrap_workspace($1, 'SubEngine')", [owner]);
    await expect(h.db.query("select public.bootstrap_workspace($1, 'Again')", [owner])).rejects.toThrow(
      /conflict: the workspace is already bootstrapped/,
    );
    await expect(
      h.db.query("insert into public.workspaces (name, data_key) values ('second', gen_random_uuid())"),
    ).rejects.toThrow(/workspaces_singleton_idx/);
  });

  it("is not callable by browser roles", async () => {
    const h = await fresh();
    const owner = await h.createAuthUser("owner@example.com");
    await expect(
      h.asUser(owner, (tx) => one(tx, "public.bootstrap_workspace($1, 'X')", [owner])),
    ).rejects.toThrow(/permission denied for function bootstrap_workspace/);
    await expect(h.asAnon((tx) => one(tx, "public.bootstrap_workspace($1, 'X')", [owner]))).rejects.toThrow(
      /permission denied/,
    );
  });
});

describe("resolve_access / my_access", () => {
  it("resolves the data owner: ok, raw access, Owner, scope all", async () => {
    const { h, users, members, roles } = seeded;
    const access = await svc(h, "public.resolve_access($1)", [users.owner]);
    expect(access).toMatchObject({
      status: "ok",
      user_id: users.owner,
      data_key: users.owner,
      member_id: members.owner,
      email: "Owner@Example.com",
      display_name: null,
      is_data_owner: true,
      raw_access: true,
      role: { id: roles.owner, key: "owner", name: "Owner", is_owner: true, permissions: [] },
      funnel_scope: { mode: "all", funnel_ids: [], paths: [] },
    });
    expect(access.access_version).toMatch(/^\d+$/);
    expect(access.partition).toMatch(/^[0-9a-f]{64}$/);

    const mine = await h.asUser(users.owner, (tx) => one(tx, "public.my_access()"));
    expect(mine).not.toHaveProperty("data_key");
    const { data_key: _omitted, ...withoutDataKey } = access;
    expect(mine).toEqual(withoutDataKey);
  });

  it("resolves an employee without raw access and without leaking data_key to the browser", async () => {
    const { h, users, roles } = seeded;
    const access = await svc(h, "public.resolve_access($1)", [users.viewer]);
    expect(access).toMatchObject({
      status: "ok",
      data_key: users.owner,
      is_data_owner: false,
      raw_access: false,
      role: { id: roles.viewer, key: "viewer", is_owner: false },
      funnel_scope: { mode: "all", funnel_ids: [], paths: [] },
    });
    expect((access.role as Json).permissions).toEqual(["cohorts.view", "dashboard.view", "funnels.view", "reports.view"]);
    const mine = await h.asUser(users.viewer, (tx) => one(tx, "public.my_access()"));
    expect(mine).not.toHaveProperty("data_key");
    expect(JSON.stringify(mine)).not.toContain(users.owner);
  });

  it("returns no_membership for a signed-in non-member", async () => {
    const { h, users } = seeded;
    const access = await svc(h, "public.resolve_access($1)", [users.outsider]);
    expect(access).toEqual({ status: "no_membership", user_id: users.outsider, workspace_id: expect.any(String) });
    const mine = await h.asUser(users.outsider, (tx) => one(tx, "public.my_access()"));
    expect(mine.status).toBe("no_membership");
    expect(mine).not.toHaveProperty("role");
  });

  it("returns disabled for a disabled member, without role or scope", async () => {
    const { h, users } = seeded;
    const access = await svc(h, "public.resolve_access($1)", [users.disabled]);
    expect(access).toEqual({ status: "disabled", user_id: users.disabled, workspace_id: expect.any(String) });
    const mine = await h.asUser(users.disabled, (tx) => one(tx, "public.my_access()"));
    expect(mine.status).toBe("disabled");
  });

  it("expands a selected funnel scope to sorted ids and canonical paths", async () => {
    const { h, users, funnels } = seeded;
    const access = await svc(h, "public.resolve_access($1)", [users.buyer]);
    const scope = access.funnel_scope as { mode: string; funnel_ids: string[]; paths: string[] };
    expect(scope.mode).toBe("selected");
    expect(scope.funnel_ids).toEqual([funnels.soulmate, funnels.palm].sort());
    expect(scope.paths).toEqual(["palm-reading", "soulmate-sketch"]);
    expect(access.raw_access).toBe(false);
    const viewer = await svc(h, "public.resolve_access($1)", [users.viewer]);
    expect(access.partition).not.toBe(viewer.partition);
  });

  it("returns ok with funnel scope none when a member has no scope rule", async () => {
    const s = await seededCopy();
    await svc(s.h, SET_SCOPE, [s.users.admin, s.members.viewer, "none", []]);
    const access = await svc(s.h, "public.resolve_access($1)", [s.users.viewer]);
    expect(access.status).toBe("ok");
    expect(access.funnel_scope).toEqual({ mode: "none", funnel_ids: [], paths: [] });
  });
});

describe("mutation RPCs", () => {
  it("lets an admin add a member, audited with an after snapshot", async () => {
    const s = await seededCopy();
    const result = await svc(s.h, ADD_MEMBER, [s.users.admin, " NEWBIE@example.com ", s.roles.analyst, "selected", [s.funnels.pastLife], "New Person"]);
    expect(result).toMatchObject({ ok: true });
    const member = result.member as Json;
    expect(member).toMatchObject({
      user_id: s.users.newbie,
      role_key: "analyst",
      status: "active",
      is_data_owner: false,
      display_name: "New Person",
      funnel_scope: { mode: "selected", funnel_ids: [s.funnels.pastLife] },
    });
    const audit = await s.h.db.query<{ event: string; actor_user_id: string; actor_member_id: string; target_id: string; before: unknown; after: Json }>(
      "select * from public.access_audit_log where event = 'member.added' and target_id = $1",
      [result.member_id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ actor_user_id: s.users.admin, actor_member_id: s.members.admin, before: null });
    expect(audit.rows[0].after).toEqual(member);
    expect(JSON.stringify(audit.rows[0].after)).not.toContain("newbie@example.com");
  });

  it("rejects adds from non-admins, unknown or unconfirmed users and duplicates", async () => {
    const s = await seededCopy();
    await expect(svc(s.h, ADD_MEMBER, [s.users.viewer, "newbie@example.com", s.roles.viewer, "all", [], null])).rejects.toThrow(
      /permission_denied: admin.users.manage is required/,
    );
    await expect(svc(s.h, ADD_MEMBER, [s.users.outsider, "newbie@example.com", s.roles.viewer, "all", [], null])).rejects.toThrow(
      /permission_denied: the actor is not an active member/,
    );
    await expect(svc(s.h, ADD_MEMBER, [s.users.disabled, "newbie@example.com", s.roles.viewer, "all", [], null])).rejects.toThrow(
      /permission_denied/,
    );
    await expect(svc(s.h, ADD_MEMBER, [s.users.admin, "nobody@example.com", s.roles.viewer, "all", [], null])).rejects.toThrow(
      /not_found: no user with that email/,
    );
    await expect(svc(s.h, ADD_MEMBER, [s.users.admin, "pending@example.com", s.roles.viewer, "all", [], null])).rejects.toThrow(
      /invalid: the user has not confirmed their email/,
    );
    await expect(svc(s.h, ADD_MEMBER, [s.users.admin, "viewer@example.com", s.roles.viewer, "all", [], null])).rejects.toThrow(
      /conflict: the user is already a member/,
    );
    await expect(svc(s.h, ADD_MEMBER, [s.users.admin, "newbie@example.com", s.roles.viewer, "everything", [], null])).rejects.toThrow(
      /invalid: scope mode/,
    );
    await expect(
      svc(s.h, ADD_MEMBER, [s.users.admin, "newbie@example.com", s.roles.viewer, "selected", ["00000000-0000-0000-0000-00000000beef"], null]),
    ).rejects.toThrow(/not_found: unknown funnel id/);
  });

  it("keeps privileged permissions Owner-only (create, edit, assign)", async () => {
    const s = await seededCopy();
    await expect(svc(s.h, CREATE_ROLE, [s.users.admin, "auditor", "Auditor", "", ["admin.audit.view"]])).rejects.toThrow(
      /escalation_denied: only the Owner may grant privileged permissions/,
    );
    await expect(svc(s.h, CREATE_ROLE, [s.users.admin, "exporter", "Exporter", "", ["api_export.use"]])).rejects.toThrow(
      /escalation_denied/,
    );
    await expect(svc(s.h, UPDATE_ROLE, [s.users.admin, s.roles.viewer, null, null, ["dashboard.view", "funnels.manage"]])).rejects.toThrow(
      /escalation_denied: only the Owner may edit a role with privileged permissions/,
    );
    await expect(svc(s.h, ADD_MEMBER, [s.users.admin, "newbie@example.com", s.roles.admin, "all", [], null])).rejects.toThrow(
      /escalation_denied: only the Owner may assign a role with privileged permissions/,
    );
    await expect(svc(s.h, UPDATE_MEMBER, [s.users.admin, s.members.viewer, s.roles.admin, null, null])).rejects.toThrow(
      /escalation_denied: only the Owner may assign a role with privileged permissions/,
    );
    // Duplicating the Admin role under another key does not bypass the rule.
    await expect(svc(s.h, CREATE_ROLE, [s.users.admin, "admin_copy", "Admin copy", "", ENFORCED_PERMISSIONS])).rejects.toThrow(
      /escalation_denied/,
    );
    // The Owner may.
    const created = await svc(s.h, CREATE_ROLE, [s.users.owner, "auditor", "Auditor", "", ["admin.audit.view", "dashboard.view"]]);
    expect(created).toMatchObject({ ok: true, role: { key: "auditor", permissions: ["admin.audit.view", "dashboard.view"] } });
    // ...and an admin can still manage non-privileged roles.
    const plain = await svc(s.h, CREATE_ROLE, [s.users.admin, "reporter", "Reporter", "", ["reports.view", "reports.view", "dashboard.view"]]);
    expect((plain.role as Json).permissions).toEqual(["dashboard.view", "reports.view"]);
  });

  it("requires the grantor to hold every permission granted", async () => {
    const s = await seededCopy();
    const roleAdmin = await svc(s.h, CREATE_ROLE, [
      s.users.owner, "role_admin", "Role admin", "", ["admin.roles.manage", "admin.roles.view", "dashboard.view"],
    ]);
    await svc(s.h, ADD_MEMBER, [s.users.owner, "newbie@example.com", roleAdmin.role_id, "all", [], null]);
    await expect(svc(s.h, CREATE_ROLE, [s.users.newbie, "cohorts_only", "Cohorts", "", ["cohorts.view"]])).rejects.toThrow(
      /escalation_denied: cannot grant permissions you do not hold/,
    );
    await expect(svc(s.h, UPDATE_ROLE, [s.users.newbie, s.roles.viewer, "Renamed", null, null])).rejects.toThrow(
      /escalation_denied: cannot edit a role beyond the permissions you hold/,
    );
    const ok = await svc(s.h, CREATE_ROLE, [s.users.newbie, "dash_only", "Dashboard", "", ["dashboard.view"]]);
    expect(ok.ok).toBe(true);
  });

  it("never gives a privileged role to a member without funnel scope all", async () => {
    const s = await seededCopy();
    await expect(
      svc(s.h, ADD_MEMBER, [s.users.owner, "newbie@example.com", s.roles.admin, "selected", [s.funnels.palm], null]),
    ).rejects.toThrow(/escalation_denied: a role with privileged permissions requires funnel scope all/);
    await expect(svc(s.h, SET_SCOPE, [s.users.owner, s.members.admin, "selected", [s.funnels.palm]])).rejects.toThrow(
      /escalation_denied: a member holding privileged permissions requires funnel scope all/,
    );
    await expect(svc(s.h, UPDATE_MEMBER, [s.users.owner, s.members.buyer, s.roles.admin, null, null])).rejects.toThrow(
      /escalation_denied: a role with privileged permissions requires funnel scope all/,
    );
    await expect(
      svc(s.h, UPDATE_ROLE, [s.users.owner, s.roles.media_buyer, null, null, [...TEMPLATES[2].permissions, "admin.audit.view"]]),
    ).rejects.toThrow(/escalation_denied: the role is assigned to members without funnel scope all/);
    // Backstop: the commit-time invariant also holds for direct SQL.
    await expect(
      s.h.asPostgres((tx) => tx.query("update public.member_scope_rules set mode = 'selected' where member_id = $1", [s.members.admin])),
    ).rejects.toThrow(/escalation_denied: a member holding privileged permissions requires funnel scope all/);
  });

  it("forbids editing your own membership, scope or role", async () => {
    const s = await seededCopy();
    await expect(svc(s.h, UPDATE_MEMBER, [s.users.admin, s.members.admin, null, null, "Me"])).rejects.toThrow(
      /escalation_denied: you cannot modify your own membership/,
    );
    await expect(svc(s.h, SET_SCOPE, [s.users.admin, s.members.admin, "all", []])).rejects.toThrow(
      /escalation_denied: you cannot modify your own membership/,
    );
    await expect(svc(s.h, UPDATE_MEMBER, [s.users.owner, s.members.owner, null, null, "Boss"])).rejects.toThrow(
      /escalation_denied: you cannot modify your own membership/,
    );
    await expect(svc(s.h, UPDATE_ROLE, [s.users.admin, s.roles.admin, "Admins", null, null])).rejects.toThrow(
      /escalation_denied/,
    );
  });

  it("only lets the Owner modify members holding privileged permissions", async () => {
    const s = await seededCopy();
    await expect(svc(s.h, UPDATE_MEMBER, [s.users.admin, s.members.owner, null, "disabled", null])).rejects.toThrow(
      /escalation_denied: only the Owner may modify a member holding privileged permissions/,
    );
    await svc(s.h, ADD_MEMBER, [s.users.owner, "newbie@example.com", s.roles.admin, "all", [], null]);
    const second = (await s.h.db.query<{ id: string }>("select id from public.workspace_members where user_id = $1", [s.users.newbie])).rows[0].id;
    await expect(svc(s.h, UPDATE_MEMBER, [s.users.admin, second, null, "disabled", null])).rejects.toThrow(
      /escalation_denied: only the Owner may modify a member holding privileged permissions/,
    );
    const disabled = await svc(s.h, UPDATE_MEMBER, [s.users.owner, second, null, "disabled", null]);
    expect(disabled).toMatchObject({ ok: true, changed: true, member: { status: "disabled" } });
    const events = await s.h.db.query<{ event: string }>(
      "select event from public.access_audit_log where target_id = $1 order by id",
      [second],
    );
    expect(events.rows.map((row) => row.event)).toEqual([
      "member.added",
      "admin_access.granted",
      "member.disabled",
      "admin_access.revoked",
    ]);
  });

  it("keeps the data-owner membership immutable (Owner, active, scope all)", async () => {
    const s = await seededCopy();
    // A second Owner cannot demote, disable or narrow the data owner.
    await svc(s.h, ADD_MEMBER, [s.users.owner, "newbie@example.com", s.roles.owner, "all", [], null]);
    await expect(svc(s.h, UPDATE_MEMBER, [s.users.newbie, s.members.owner, s.roles.viewer, null, null])).rejects.toThrow(
      /invalid: the data owner membership is immutable/,
    );
    await expect(svc(s.h, UPDATE_MEMBER, [s.users.newbie, s.members.owner, null, "disabled", null])).rejects.toThrow(
      /invalid: the data owner membership is immutable/,
    );
    await expect(svc(s.h, SET_SCOPE, [s.users.newbie, s.members.owner, "selected", [s.funnels.palm]])).rejects.toThrow(
      /invalid: the data owner membership is immutable/,
    );
    // Display name is not part of the invariant.
    const renamed = await svc(s.h, UPDATE_MEMBER, [s.users.newbie, s.members.owner, null, null, "Founder"]);
    expect(renamed).toMatchObject({ ok: true, changed: true });

    // Direct SQL (even as postgres) hits the triggers.
    const asPg = (sql: string, params: unknown[] = []) => s.h.asPostgres((tx) => tx.query(sql, params));
    await expect(asPg("update public.workspace_members set status = 'disabled' where id = $1", [s.members.owner])).rejects.toThrow(
      /data owner membership is immutable/,
    );
    await expect(asPg("update public.workspace_members set role_id = $2 where id = $1", [s.members.owner, s.roles.viewer])).rejects.toThrow(
      /data owner membership is immutable/,
    );
    await expect(asPg("update public.workspace_members set user_id = $2 where id = $1", [s.members.owner, s.users.outsider])).rejects.toThrow(
      /identity columns \(user_id, is_data_owner\) are immutable/,
    );
    await expect(asPg("update public.workspace_members set is_data_owner = true where id = $1", [s.members.viewer])).rejects.toThrow(
      /immutable/,
    );
    await expect(asPg("delete from public.workspace_members where id = $1", [s.members.owner])).rejects.toThrow(
      /the data owner membership cannot be deleted/,
    );
    await expect(asPg("delete from public.member_scope_rules where member_id = $1", [s.members.owner])).rejects.toThrow(
      /data owner membership is immutable/,
    );
    await expect(asPg("update public.workspaces set data_key = gen_random_uuid()")).rejects.toThrow(/immutable/);
    await expect(asPg("delete from public.workspaces")).rejects.toThrow(/the workspace cannot be deleted/);
    await expect(asPg("truncate public.workspace_members cascade")).rejects.toThrow(/TRUNCATE is not allowed/);
    // A member for the data key must be the data owner and vice versa.
    await expect(
      asPg(
        "insert into public.workspace_members (workspace_id, user_id, role_id, is_data_owner) select id, $1, $2, true from public.workspaces",
        [s.users.outsider, s.roles.owner],
      ),
    ).rejects.toThrow(/is_data_owner must be set exactly for the workspace data key/);
  });

  it("never leaves the workspace without an active Owner", async () => {
    const s = await seededCopy();
    // A second Owner can be disabled while the data owner remains.
    await svc(s.h, ADD_MEMBER, [s.users.owner, "newbie@example.com", s.roles.owner, "all", [], null]);
    const second = (await s.h.db.query<{ id: string }>("select id from public.workspace_members where user_id = $1", [s.users.newbie])).rows[0].id;
    await expect(svc(s.h, UPDATE_MEMBER, [s.users.owner, second, s.roles.viewer, null, null])).resolves.toMatchObject({ ok: true });

    // The data-owner guard normally makes the last Owner unreachable; with it
    // switched off, the independent last-owner guard still refuses.
    const demoteLastOwner = (column: "status" | "role_id") =>
      s.h.asPostgres(async (tx) => {
        await tx.exec("alter table public.workspace_members disable trigger workspace_members_data_owner_guard");
        if (column === "status") {
          await tx.query("update public.workspace_members set status = 'disabled' where id = $1", [s.members.owner]);
        } else {
          await tx.query("update public.workspace_members set role_id = $2 where id = $1", [s.members.owner, s.roles.viewer]);
        }
      });
    await expect(demoteLastOwner("status")).rejects.toThrow(/the last active Owner cannot be disabled, demoted or removed/);
    await expect(demoteLastOwner("role_id")).rejects.toThrow(/the last active Owner cannot be disabled, demoted or removed/);
  });

  it("protects the Owner role and roles still in use", async () => {
    const s = await seededCopy();
    await expect(svc(s.h, UPDATE_ROLE, [s.users.owner, s.roles.owner, "Boss", null, null])).rejects.toThrow(
      /invalid: the Owner role is immutable/,
    );
    await expect(svc(s.h, DELETE_ROLE, [s.users.owner, s.roles.owner])).rejects.toThrow(/invalid: system roles cannot be deleted/);
    await expect(svc(s.h, DELETE_ROLE, [s.users.admin, s.roles.viewer])).rejects.toThrow(/conflict: the role is assigned to 2 member/);
    await expect(
      s.h.asPostgres((tx) => tx.query("update public.access_roles set permissions = '{dashboard.view}' where id = $1", [s.roles.owner])),
    ).rejects.toThrow(/Owner role/);

    const deleted = await svc(s.h, DELETE_ROLE, [s.users.admin, s.roles.product_manager]);
    expect(deleted).toMatchObject({ ok: true });
    const audit = await s.h.db.query<{ before: Json; after: unknown }>(
      "select before, after from public.access_audit_log where event = 'role.deleted'",
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].before).toMatchObject({ key: "product_manager" });
    expect(audit.rows[0].after).toBeNull();
  });

  it("seeds role templates idempotently and only for the Owner", async () => {
    const s = await seededCopy();
    const again = await svc(s.h, "public.access_seed_role_templates($1, $2::jsonb)", [s.users.owner, JSON.stringify(TEMPLATES)]);
    expect(again).toEqual({ ok: true, created: [], skipped: TEMPLATES.map((t) => t.key) });
    await expect(
      svc(s.h, "public.access_seed_role_templates($1, $2::jsonb)", [s.users.admin, JSON.stringify(TEMPLATES)]),
    ).rejects.toThrow(/permission_denied: only the Owner may seed role templates/);
    const adminRole = await s.h.db.query<{ permissions: string[]; template_key: string; is_system: boolean }>(
      "select permissions, template_key, is_system from public.access_roles where key = 'admin'",
    );
    expect(adminRole.rows[0]).toEqual({ permissions: [...ENFORCED_PERMISSIONS].sort(), template_key: "admin", is_system: false });
  });

  it("recovers an Owner for an existing member, audited", async () => {
    const s = await seededCopy();
    const result = await svc(s.h, "public.recover_owner($1)", [s.users.disabled]);
    expect(result).toMatchObject({ ok: true, member: { role_key: "owner", status: "active", funnel_scope: { mode: "all" } } });
    const audit = await s.h.db.query<{ before: Json; after: Json; actor_kind: string }>(
      "select before, after, actor_kind from public.access_audit_log where event = 'owner.recovered'",
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ actor_kind: "system", before: { status: "disabled" }, after: { status: "active" } });
    await expect(svc(s.h, "public.recover_owner($1)", [s.users.outsider])).rejects.toThrow(/not_found: the user is not a member/);
    await expect(
      s.h.asUser(s.users.admin, (tx) => one(tx, "public.recover_owner($1)", [s.users.admin])),
    ).rejects.toThrow(/permission denied for function recover_owner/);
  });

  it("writes audit rows with before/after and an append-only log", async () => {
    const s = await seededCopy();
    await svc(s.h, UPDATE_ROLE, [s.users.admin, s.roles.viewer, null, null, ["dashboard.view", "cohorts.view", "cohorts.export", "funnels.view"]]);
    const audit = await s.h.db.query<{ before: Json; after: Json; context: Json; actor_member_id: string }>(
      "select before, after, context, actor_member_id from public.access_audit_log where event = 'role.updated'",
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].before.permissions).toEqual(["cohorts.view", "dashboard.view", "funnels.view", "reports.view"]);
    expect(audit.rows[0].after.permissions).toEqual(["cohorts.export", "cohorts.view", "dashboard.view", "funnels.view"]);
    expect(audit.rows[0].context).toEqual({ added_permissions: ["cohorts.export"], removed_permissions: ["reports.view"] });
    expect(audit.rows[0].actor_member_id).toBe(s.members.admin);

    await svc(s.h, SET_SCOPE, [s.users.admin, s.members.buyer, "selected", [s.funnels.pastLife, s.funnels.palm]]);
    const scopeAudit = await s.h.db.query<{ before: Json; after: Json; context: Json }>(
      "select before, after, context from public.access_audit_log where event = 'scope.updated'",
    );
    expect(scopeAudit.rows[0].context).toEqual({
      added_funnel_ids: [s.funnels.pastLife],
      removed_funnel_ids: [s.funnels.soulmate],
    });

    const id = await svc<number>(s.h, "public.access_write_audit($1, 'user', $2, 'export', 'cohorts', 'success', null, null, null, $3::jsonb)", [
      "export.performed",
      s.users.viewer,
      JSON.stringify({ request_id: "req-1", rows: 10 }),
    ]);
    const written = await s.h.db.query("select request_id, actor_member_id, event from public.access_audit_log where id = $1", [id]);
    expect(written.rows[0]).toEqual({ request_id: "req-1", actor_member_id: s.members.viewer, event: "export.performed" });
    await expect(
      svc(s.h, "public.access_write_audit('Bad Event', 'user', null, null, null, 'success', null, null, null, null)"),
    ).rejects.toThrow(/invalid: event/);

    const asPg = (sql: string) => s.h.asPostgres((tx) => tx.exec(sql));
    await expect(asPg("update public.access_audit_log set event = 'tampered.event'")).rejects.toThrow(/append-only: UPDATE/);
    await expect(asPg("delete from public.access_audit_log")).rejects.toThrow(/append-only: DELETE/);
    await expect(asPg("truncate public.access_audit_log")).rejects.toThrow(/TRUNCATE is not allowed on access_audit_log/);
    await expect(s.h.asService((tx) => tx.exec("update public.access_audit_log set event = 'tampered.event'"))).rejects.toThrow(
      /permission denied/,
    );
    await expect(s.h.asService((tx) => tx.exec("delete from public.access_audit_log"))).rejects.toThrow(/permission denied/);
  });

  it("deduplicates denials into counters", async () => {
    const s = await seededCopy();
    const args = [s.users.viewer, "clickhouse-users", "details", "permission_denied", "req-9"];
    expect(await svc<number>(s.h, "public.access_record_denial($1, $2, $3, $4, $5)", args)).toBe(1);
    expect(await svc<number>(s.h, "public.access_record_denial($1, $2, $3, $4, $5)", args)).toBe(2);
    const rows = await s.h.db.query("select denials, last_request_id from public.access_denial_counters");
    expect(rows.rows).toEqual([{ denials: 2, last_request_id: "req-9" }]);
  });
});

describe("access_version", () => {
  const version = async (h: SupabasePglite, user: string) => {
    const access = await svc(h, "public.resolve_access($1)", [user]);
    return { version: Number(access.access_version), partition: access.partition as string, scope: access.funnel_scope as Json };
  };

  it("bumps every holder of a role when its permissions change (and nobody else)", async () => {
    const s = await seededCopy();
    const viewerBefore = await version(s.h, s.users.viewer);
    const buyerBefore = await version(s.h, s.users.buyer);
    await svc(s.h, UPDATE_ROLE, [s.users.admin, s.roles.viewer, null, null, ["dashboard.view", "cohorts.view"]]);
    const viewerAfter = await version(s.h, s.users.viewer);
    expect(viewerAfter.version).toBe(viewerBefore.version + 1);
    expect(viewerAfter.partition).not.toBe(viewerBefore.partition);
    expect((await version(s.h, s.users.buyer)).version).toBe(buyerBefore.version);
    // A rename alone does not change access.
    await svc(s.h, UPDATE_ROLE, [s.users.admin, s.roles.viewer, "Read only", null, null]);
    expect((await version(s.h, s.users.viewer)).version).toBe(viewerAfter.version);
  });

  it("bumps on scope, role and status changes", async () => {
    const s = await seededCopy();
    const before = await version(s.h, s.users.buyer);
    await svc(s.h, SET_SCOPE, [s.users.admin, s.members.buyer, "selected", [s.funnels.pastLife]]);
    const afterScope = await version(s.h, s.users.buyer);
    expect(afterScope.version).toBeGreaterThan(before.version);
    expect(afterScope.scope).toEqual({ mode: "selected", funnel_ids: [s.funnels.pastLife], paths: ["past-life"] });

    await svc(s.h, UPDATE_MEMBER, [s.users.admin, s.members.buyer, s.roles.analyst, null, null]);
    const afterRole = await version(s.h, s.users.buyer);
    expect(afterRole.version).toBe(afterScope.version + 1);

    // Display-name edits do not bump.
    await svc(s.h, UPDATE_MEMBER, [s.users.admin, s.members.buyer, null, null, "Buyer"]);
    expect((await version(s.h, s.users.buyer)).version).toBe(afterRole.version);

    const versionRow = async () =>
      Number((await s.h.db.query<{ v: string }>("select access_version::text v from public.workspace_members where id = $1", [s.members.buyer])).rows[0].v);
    await svc(s.h, UPDATE_MEMBER, [s.users.admin, s.members.buyer, null, "disabled", null]);
    expect(await versionRow()).toBe(afterRole.version + 1);
  });

  it("bumps members holding a funnel when it is re-pathed (even by a browser write)", async () => {
    const s = await seededCopy();
    const buyerBefore = await version(s.h, s.users.buyer);
    const viewerBefore = await version(s.h, s.users.viewer);
    await s.h.asUser(s.users.viewer, (tx) =>
      tx.query("update public.funnels set funnel_path = '/Palm-Reading-V2' where id = $1", [s.funnels.palm]),
    );
    const buyerAfter = await version(s.h, s.users.buyer);
    expect(buyerAfter.version).toBe(buyerBefore.version + 1);
    expect((buyerAfter.scope as { paths: string[] }).paths).toEqual(["palm-reading-v2", "soulmate-sketch"]);
    expect((await version(s.h, s.users.viewer)).version).toBe(viewerBefore.version);
    // is_active flips (the daily recompute) do not bump.
    await s.h.db.query("update public.funnels set is_active = false where id = $1", [s.funnels.palm]);
    expect((await version(s.h, s.users.buyer)).version).toBe(buyerAfter.version);
  });
});

describe("RLS and grants", () => {
  const ACCESS_TABLES = [
    "workspaces",
    "access_roles",
    "workspace_members",
    "member_scope_rules",
    "member_scope_values",
    "access_audit_log",
    "access_denial_counters",
  ];

  const count = async (h: SupabasePglite, user: string, table: string) =>
    h.asUser(user, async (tx) => (await tx.query(`select * from public.${table}`)).rows.length);

  it("shows a non-admin only their own membership, role and scope; no audit", async () => {
    const { h, users, members, roles } = seeded;
    for (const user of [users.viewer, users.buyer]) {
      const rows = await h.asUser(user, (tx) => tx.query<{ user_id: string }>("select user_id from public.workspace_members"));
      expect(rows.rows).toEqual([{ user_id: user }]);
      expect(await count(h, user, "access_audit_log")).toBe(0);
      expect(await count(h, user, "access_denial_counters")).toBe(0);
    }
    const viewerRoles = await h.asUser(users.viewer, (tx) => tx.query<{ id: string }>("select id from public.access_roles"));
    expect(viewerRoles.rows).toEqual([{ id: roles.viewer }]);
    const buyerRules = await h.asUser(users.buyer, (tx) => tx.query<{ member_id: string }>("select member_id from public.member_scope_rules"));
    expect(buyerRules.rows).toEqual([{ member_id: members.buyer }]);
    expect(await count(h, users.buyer, "member_scope_values")).toBe(2);
    expect(await count(h, users.viewer, "member_scope_values")).toBe(0);
    await expect(count(h, users.viewer, "workspaces")).rejects.toThrow(/permission denied for table workspaces/);
  });

  it("shows admins the member list, roles and audit", async () => {
    const { h, users } = seeded;
    expect(await count(h, users.admin, "workspace_members")).toBe(5);
    expect(await count(h, users.admin, "access_roles")).toBe(7);
    expect(await count(h, users.admin, "member_scope_rules")).toBe(5);
    expect(await count(h, users.admin, "access_audit_log")).toBeGreaterThan(5);
    await expect(count(h, users.admin, "workspaces")).rejects.toThrow(/permission denied/);
  });

  it("shows disabled members and outsiders nothing beyond their own membership row", async () => {
    const { h, users } = seeded;
    expect(await count(h, users.disabled, "workspace_members")).toBe(1);
    expect(await count(h, users.disabled, "access_roles")).toBe(0);
    expect(await count(h, users.disabled, "member_scope_rules")).toBe(0);
    expect(await count(h, users.outsider, "workspace_members")).toBe(0);
    expect(await count(h, users.outsider, "access_roles")).toBe(0);
  });

  it("allows no client writes on any access table, even for admins", async () => {
    const { h, users } = seeded;
    for (const table of ACCESS_TABLES) {
      await expect(h.asUser(users.admin, (tx) => tx.exec(`insert into public.${table} default values`))).rejects.toThrow(
        /permission denied/,
      );
      await expect(h.asUser(users.admin, (tx) => tx.exec(`delete from public.${table}`))).rejects.toThrow(/permission denied/);
    }
    await expect(
      h.asUser(users.admin, (tx) => tx.exec("update public.workspace_members set display_name = 'x'")),
    ).rejects.toThrow(/permission denied/);
    await expect(
      h.asUser(users.owner, (tx) => tx.exec("update public.access_roles set permissions = '{}'")),
    ).rejects.toThrow(/permission denied/);
  });

  it("gives anon no access at all", async () => {
    const { h } = seeded;
    for (const table of ACCESS_TABLES) {
      await expect(h.asAnon((tx) => tx.exec(`select * from public.${table}`))).rejects.toThrow(/permission denied/);
    }
    await expect(h.asAnon((tx) => tx.exec("select public.my_access()"))).rejects.toThrow(/permission denied for function my_access/);
    await expect(h.asAnon((tx) => tx.exec("select app.has_permission('dashboard.view')"))).rejects.toThrow(/permission denied/);
  });

  it("evaluates the RLS helpers for the caller", async () => {
    const { h, users, funnels } = seeded;
    // No role has USAGE on schema app: clients can never call the helpers
    // directly, only policies can (by OID, with EXECUTE).
    await expect(h.asUser(users.owner, (tx) => tx.exec("select app.has_permission('dashboard.view')"))).rejects.toThrow(
      /permission denied for schema app/,
    );
    const helpers = (user: string) =>
      h.asPostgres((tx) =>
        one<Json>(
          tx,
          `jsonb_build_object(
             'active', app.is_active_member(),
             'member', app.current_member(),
             'dashboard', app.has_permission('dashboard.view'),
             'users_view', app.has_permission('admin.users.view'),
             'scope_all', app.funnel_scope_all(),
             'paths', app.allowed_paths(),
             'soulmate', app.can_see_funnel($1),
             'past_life', app.can_see_funnel($2),
             'unknown_perm', app.has_permission('no.such_key'),
             'null_perm', app.has_permission(null))`,
          [funnels.soulmate, funnels.pastLife],
        ),
        user,
      );
    expect(await helpers(users.owner)).toMatchObject({
      active: true, dashboard: true, users_view: true, scope_all: true, paths: ["*"], soulmate: true, past_life: true, null_perm: false,
    });
    expect(await helpers(users.buyer)).toMatchObject({
      active: true, dashboard: true, users_view: false, scope_all: false,
      paths: ["palm-reading", "soulmate-sketch"], soulmate: true, past_life: false, unknown_perm: false, null_perm: false,
    });
    expect(await helpers(users.disabled)).toMatchObject({
      active: false, member: null, dashboard: false, scope_all: false, paths: [], soulmate: false,
    });
    expect(await helpers(users.outsider)).toMatchObject({ active: false, member: null, dashboard: false, paths: [] });
  });

  it("grants EXECUTE only where the contract says", async () => {
    const { h } = seeded;
    const expected: Record<string, [anon: boolean, authenticated: boolean, service: boolean]> = {
      "public.resolve_access(uuid)": [false, false, true],
      "public.my_access()": [false, true, false],
      "public.workspace_data_key()": [false, false, true],
      "public.access_write_audit(text,text,uuid,text,text,text,text,jsonb,jsonb,jsonb)": [false, false, true],
      "public.access_record_denial(uuid,text,text,text,text)": [false, false, true],
      "public.access_add_member(uuid,text,uuid,text,uuid[],text)": [false, false, true],
      "public.access_update_member(uuid,uuid,uuid,text,text)": [false, false, true],
      "public.access_set_member_scope(uuid,uuid,text,uuid[])": [false, false, true],
      "public.access_create_role(uuid,text,text,text,text[])": [false, false, true],
      "public.access_update_role(uuid,uuid,text,text,text[])": [false, false, true],
      "public.access_delete_role(uuid,uuid)": [false, false, true],
      "public.access_seed_role_templates(uuid,jsonb)": [false, false, true],
      "public.bootstrap_workspace(uuid,text)": [false, false, true],
      "public.recover_owner(uuid)": [false, false, true],
      // Policy helpers: EXECUTE for authenticated (policies), but no schema USAGE.
      "app.data_key()": [false, true, false],
      "app.current_member()": [false, true, false],
      "app.is_active_member()": [false, true, false],
      "app.has_permission(text)": [false, true, false],
      "app.funnel_scope_all()": [false, true, false],
      "app.allowed_paths()": [false, true, false],
      "app.can_see_funnel(uuid)": [false, true, false],
    };
    const usage = await h.db.query(
      `select has_schema_privilege('anon', 'app', 'usage') anon,
              has_schema_privilege('authenticated', 'app', 'usage') authenticated,
              has_schema_privilege('service_role', 'app', 'usage') service`,
    );
    expect(usage.rows[0]).toEqual({ anon: false, authenticated: false, service: false });
    for (const [signature, [anon, authenticated, service]] of Object.entries(expected)) {
      const row = await h.db.query<{ anon: boolean; authenticated: boolean; service: boolean }>(
        `select has_function_privilege('anon', $1, 'execute') anon,
                has_function_privilege('authenticated', $1, 'execute') authenticated,
                has_function_privilege('service_role', $1, 'execute') service`,
        [signature],
      );
      expect({ signature, ...row.rows[0] }).toEqual({ signature, anon, authenticated, service });
    }
    // Every other function in `app` (internals, triggers) is callable by nobody but its owner.
    const internals = await h.db.query<{ signature: string }>(
      `select p.oid::regprocedure::text signature
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'app'
         and (has_function_privilege('anon', p.oid, 'execute')
           or has_function_privilege('service_role', p.oid, 'execute')
           or has_function_privilege('authenticated', p.oid, 'execute'))`,
    );
    expect(internals.rows.map((row) => row.signature).sort()).toEqual(
      Object.keys(expected).filter((s) => s.startsWith("app.")).sort(),
    );
  });

  it("leaves no public table without row level security", async () => {
    const { h } = seeded;
    const tables = await h.db.query<{ relname: string; relrowsecurity: boolean }>(
      `select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r', 'p') order by 1`,
    );
    expect(tables.rows.length).toBeGreaterThan(ACCESS_TABLES.length);
    expect(tables.rows.filter((row) => !row.relrowsecurity)).toEqual([]);
  });
});

// The three layers are written by different hands against one JSON/RPC
// contract. These tests run the REAL SQL output through the REAL TS consumers,
// so a renamed field, a changed type or a different partition formula fails here
// instead of as a production 503 (gate) or "error" screen (browser).
describe("contract parity with the TS gate, catalog and browser client", () => {
  const sha256Hex = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
  const resolve = (h: SupabasePglite, user: string) => svc(h, "public.resolve_access($1)", [user]);
  const mine = (h: SupabasePglite, user: string) => h.asUser(user, (tx) => one(tx, "public.my_access()"));

  it("feeds resolve_access rows straight into the Edge gate's parser and context builder", async () => {
    const { h, users, members, roles, funnels } = seeded;
    const contextFor = async (user: string) => {
      const row = parseResolveAccessRow(await resolve(h, user));
      expect(row, user).not.toBeNull();
      return buildAccessContext(row!, { kind: "user", userId: user }, "req-parity");
    };

    const owner = await contextFor(users.owner);
    expect(owner).toMatchObject({
      tenantKey: users.owner,
      rawAccess: true,
      restricted: false,
      role: { id: roles.owner, key: "owner", name: "Owner", isOwner: true },
      scope: { funnel: { mode: "all" } },
      violations: [],
    });
    expect(owner.actor).toEqual({ kind: "user", userId: users.owner, memberId: members.owner, email: "Owner@Example.com" });
    expect([...owner.permissions].sort()).toEqual([...ENFORCED_PERMISSION_KEYS].sort());

    // Employees: tenant is the WORKSPACE data key, never the caller.
    const viewer = await contextFor(users.viewer);
    expect(viewer).toMatchObject({ tenantKey: users.owner, rawAccess: false, restricted: false, role: { key: "viewer", isOwner: false } });
    expect([...viewer.permissions].sort()).toEqual(["cohorts.view", "dashboard.view", "funnels.view", "reports.view"]);

    const admin = await contextFor(users.admin);
    expect(admin).toMatchObject({ tenantKey: users.owner, rawAccess: false, restricted: false, role: { key: "admin", isOwner: false } });
    expect([...admin.permissions].sort()).toEqual([...ENFORCED_PERMISSION_KEYS].sort());

    const buyer = await contextFor(users.buyer);
    expect(buyer).toMatchObject({ tenantKey: users.owner, rawAccess: false, restricted: true });
    expect(buyer.scope.funnel).toEqual({
      mode: "selected",
      funnelIds: [funnels.soulmate, funnels.palm].sort(),
      paths: ["palm-reading", "soulmate-sketch"],
    });
    expect([...buyer.permissions].sort()).toEqual(["ai.use", "cohorts.view", "dashboard.view", "facebook_analytics.view", "funnels.view"]);
  });

  it("emits every non-ok status in the shape the gate branches on", async () => {
    const { h, users } = seeded;
    expect(parseResolveAccessRow(await resolve(h, users.outsider))).toMatchObject({ status: "no_membership", user_id: users.outsider });
    expect(parseResolveAccessRow(await resolve(h, users.disabled))).toMatchObject({ status: "disabled", user_id: users.disabled });
    const empty = await fresh();
    const someone = await empty.createAuthUser("someone@example.com");
    expect(parseResolveAccessRow(await resolve(empty, someone))).toMatchObject({ status: "no_workspace", user_id: someone });
  });

  it("feeds my_access rows into the browser client's parser (no data_key, same partition)", async () => {
    const { h, users } = seeded;
    for (const user of [users.owner, users.admin, users.viewer, users.buyer]) {
      const server = await resolve(h, user);
      const parsed = parseMyAccessPayload(await mine(h, user));
      expect(parsed.status, user).toBe("ok");
      expect(parsed).not.toHaveProperty("data_key");
      expect(parsed).toMatchObject({
        user_id: user,
        member_id: server.member_id,
        workspace_id: server.workspace_id,
        raw_access: server.raw_access,
        is_data_owner: server.is_data_owner,
        role: server.role,
        funnel_scope: server.funnel_scope,
        access_version: server.access_version,
        partition: server.partition,
      });
    }
    expect(parseMyAccessPayload(await mine(h, users.disabled)).status).toBe("disabled");
    expect(parseMyAccessPayload(await mine(h, users.outsider)).status).toBe("no_membership");
    // Not bootstrapped yet ⇒ the browser keeps today's behaviour (server stays authoritative).
    const empty = await fresh();
    const someone = await empty.createAuthUser("someone@example.com");
    expect(parseMyAccessPayload(await mine(empty, someone)).status).toBe("legacy");
  });

  it("issues partition = core sha256 of accessPartitionInput(), for all / selected / none", async () => {
    const s = await seededCopy();
    await svc(s.h, SET_SCOPE, [s.users.admin, s.members.viewer, "none", []]);
    const modes: string[] = [];
    for (const user of [s.users.owner, s.users.buyer, s.users.viewer]) {
      const row = await resolve(s.h, user);
      const scope = row.funnel_scope as { mode: FunnelScopeMode; funnel_ids: string[] };
      modes.push(scope.mode);
      const input = accessPartitionInput({
        workspaceId: row.workspace_id as string,
        userId: user,
        accessVersion: row.access_version as string,
        mode: scope.mode,
        // Reversed and upper-cased on purpose: the TS side must canonicalize to
        // the SQL order (uuid order = lower-case hex text order).
        funnelIds: [...scope.funnel_ids].reverse().map((id) => id.toUpperCase()),
      });
      expect(row.partition, user).toBe(sha256Hex(input));
    }
    expect(modes).toEqual(["all", "selected", "none"]);
    // Core sha256() only: no pgcrypto (digest/hmac/crypt) and no extensions.
    const sql = readMigration("202610050002_access_core.sql");
    expect(sql).toMatch(/encode\(sha256\(convert_to\(concat_ws\('\|'/);
    expect(sql).not.toMatch(/\b(digest|hmac|crypt|gen_salt)\s*\(/i);
    expect(sql).not.toMatch(/create\s+extension/i);
  });

  it("agrees with the TS catalog on enforced, privileged and well-formed keys", async () => {
    expect([...ENFORCED_PERMISSIONS].sort()).toEqual([...ENFORCED_PERMISSION_KEYS].sort());
    const keys = PERMISSION_CATALOG.map((entry) => entry.key);
    const result = await seeded.h.asPostgres((tx) =>
      tx.query<{ k: string; privileged: boolean; well_formed: boolean }>(
        `select k, app.is_privileged_permission(k) as privileged, app.permissions_well_formed(array[k]) as well_formed
         from unnest($1::text[]) k`,
        [keys],
      ),
    );
    expect(result.rows).toHaveLength(keys.length);
    for (const row of result.rows) {
      expect(row.privileged, row.k).toBe(PRIVILEGED_PERMISSION_KEYS.has(row.k));
      expect(row.well_formed, row.k).toBe(true);
    }
    // app.has_permission mirrors effectivePermissions() without re-deriving
    // `requires`; that is exact only while no ordinary key requires a
    // privileged one (a privileged prerequisite would be dropped under a
    // selected scope in TS but not in SQL).
    for (const entry of PERMISSION_CATALOG) {
      if (PRIVILEGED_PERMISSION_KEYS.has(entry.key)) continue;
      expect(entry.requires.filter((key) => PRIVILEGED_PERMISSION_KEYS.has(key)), entry.key).toEqual([]);
    }
  });

  it("accepts the real ROLE_TEMPLATES and treats only the admin template as privileged", async () => {
    const h = await fresh();
    const owner = await h.createAuthUser("owner@example.com");
    await h.db.query("select public.bootstrap_workspace($1, 'SubEngine')", [owner]);
    const result = await svc(h, "public.access_seed_role_templates($1, $2::jsonb)", [owner, JSON.stringify(ROLE_TEMPLATES)]);
    expect(result).toEqual({ ok: true, created: ROLE_TEMPLATES.map((template) => template.key), skipped: [] });
    const stored = await h.asPostgres((tx) =>
      tx.query<{ key: string; permissions: string[]; privileged: boolean }>(
        "select key, permissions, app.permissions_privileged(permissions) as privileged from public.access_roles where not is_owner",
      ),
    );
    expect(stored.rows.map((row) => row.key).sort()).toEqual(ROLE_TEMPLATES.map((template) => template.key).sort());
    for (const template of ROLE_TEMPLATES) {
      const row = stored.rows.find((candidate) => candidate.key === template.key)!;
      expect([...row.permissions].sort(), template.key).toEqual([...template.permissions].sort());
      expect(row.privileged, template.key).toBe(template.key === "admin");
    }
  });

  it("exposes every contract RPC under the exact name, PostgREST parameter names and return type", async () => {
    const jsonb = "jsonb";
    const expected: Record<string, { args: string; returns: string }> = {
      resolve_access: { args: "p_user_id uuid", returns: jsonb },
      my_access: { args: "", returns: jsonb },
      workspace_data_key: { args: "", returns: "uuid" },
      access_write_audit: {
        args: "p_event text, p_actor_kind text, p_actor_user_id uuid, p_target_type text, p_target_id text, p_outcome text, p_reason_code text, p_before jsonb, p_after jsonb, p_context jsonb",
        returns: "bigint",
      },
      access_add_member: { args: "p_actor uuid, p_email text, p_role_id uuid, p_scope_mode text, p_funnel_ids uuid[], p_display_name text", returns: jsonb },
      access_update_member: { args: "p_actor uuid, p_member_id uuid, p_role_id uuid, p_status text, p_display_name text", returns: jsonb },
      access_set_member_scope: { args: "p_actor uuid, p_member_id uuid, p_mode text, p_funnel_ids uuid[]", returns: jsonb },
      access_create_role: { args: "p_actor uuid, p_key text, p_name text, p_description text, p_permissions text[]", returns: jsonb },
      access_update_role: { args: "p_actor uuid, p_role_id uuid, p_name text, p_description text, p_permissions text[]", returns: jsonb },
      access_delete_role: { args: "p_actor uuid, p_role_id uuid", returns: jsonb },
      access_seed_role_templates: { args: "p_actor uuid, p_templates jsonb", returns: jsonb },
      bootstrap_workspace: { args: "p_data_owner uuid, p_name text", returns: jsonb },
      recover_owner: { args: "p_user_id uuid", returns: jsonb },
    };
    const rows = await seeded.h.db.query<{ name: string; args: string; returns: string; definer: boolean; config: string[] | null }>(
      `select p.proname as name, pg_get_function_identity_arguments(p.oid) as args, pg_get_function_result(p.oid) as returns,
              p.prosecdef as definer, p.proconfig as config
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = any($1::text[])`,
      [Object.keys(expected)],
    );
    expect(Object.fromEntries(rows.rows.map((row) => [row.name, { args: row.args, returns: row.returns }]))).toEqual(expected);
    for (const row of rows.rows) {
      expect(row.definer, row.name).toBe(true);
      expect(row.config ?? [], row.name).toContain('search_path=""');
    }

    // ...and the callers use exactly these names / parameters.
    const http = readFileSync("supabase/functions/_shared/clickhouse/http.ts", "utf8");
    expect(http).toMatch(/callRpc\(client, "resolve_access", \{ p_user_id: userId \}\)/);
    expect(http).toMatch(/callRpc\(client, "workspace_data_key"\)/);
    expect(MY_ACCESS_RPC).toBe("my_access");
  });
});

// ---- bootstrap tenant pre-flight (plan §26.1), enforced inside the latch ------------------------

// The tables the pre-flight looks at come from migrations the access suite does
// not all apply (202607090001 does create funnelfox_subscriptions_sync_state);
// minimal stand-ins with the columns it reads.
const PREFLIGHT_TABLES_SQL = `
create table if not exists public.fb_cron_config (id boolean primary key default true check (id), auth_user_id uuid not null, cron_secret text not null default 's', function_url text not null default 'u');
create table if not exists public.support_mail_sync_state (id uuid primary key default gen_random_uuid(), auth_user_id uuid not null, folder text not null default 'INBOX');
create table if not exists public.funnelfox_subscriptions_sync_state (auth_user_id uuid primary key);
create table if not exists public.funnelfox_leads_sync_state (auth_user_id uuid primary key);
`;

describe("bootstrap_workspace tenant pre-flight", () => {
  async function prepared() {
    const h = await fresh();
    await h.db.exec(PREFLIGHT_TABLES_SQL);
    const owner = await h.createAuthUser("owner@example.com");
    const other = await h.createAuthUser("other@example.com");
    return { h, owner, other };
  }
  const workspaces = async (h: SupabasePglite) => (await h.db.query<{ n: number }>("select count(*)::int as n from public.workspaces")).rows[0].n;

  it("refuses when fb_cron_config runs the crons for another account, and creates nothing", async () => {
    const { h, owner, other } = await prepared();
    await h.db.query("insert into public.fb_cron_config (auth_user_id) values ($1)", [other]);
    await expect(svc(h, "public.bootstrap_workspace($1, 'SubEngine')", [owner])).rejects.toThrow(
      /invalid: preflight: fb_cron_config\.auth_user_id is not the data owner/,
    );
    expect(await workspaces(h)).toBe(0);
    await h.db.query("update public.fb_cron_config set auth_user_id = $1", [owner]);
    await expect(svc(h, "public.bootstrap_workspace($1, 'SubEngine')", [owner])).resolves.toMatchObject({ ok: true });
  });

  it.each([
    ["support_mail_sync_state", "insert into public.support_mail_sync_state (auth_user_id) values ($1)"],
    ["funnelfox_subscriptions_sync_state", "insert into public.funnelfox_subscriptions_sync_state (auth_user_id) values ($1)"],
    ["funnelfox_leads_sync_state", "insert into public.funnelfox_leads_sync_state (auth_user_id) values ($1)"],
  ])("refuses when %s has rows but none of the data owner's", async (table, insert) => {
    const { h, owner, other } = await prepared();
    await h.db.query(insert, [other]);
    await expect(svc(h, "public.bootstrap_workspace($1, 'SubEngine')", [owner])).rejects.toThrow(
      new RegExp(`invalid: preflight: ${table} has rows, but none belongs to the data owner`),
    );
    expect(await workspaces(h)).toBe(0);
    // The data owner's own row (a private copy of another account may coexist).
    await h.db.query(insert, [owner]);
    await expect(svc(h, "public.bootstrap_workspace($1, 'SubEngine')", [owner])).resolves.toMatchObject({ ok: true });
  }, 60_000);

  it("only the INBOX row counts for support (a foreign Sent-folder row alone does not block)", async () => {
    const { h, owner, other } = await prepared();
    await h.db.query("insert into public.support_mail_sync_state (auth_user_id, folder) values ($1, 'Sent')", [other]);
    await expect(svc(h, "public.bootstrap_workspace($1, 'SubEngine')", [owner])).resolves.toMatchObject({ ok: true });
  });

  it("passes with empty or missing tables (nothing configured yet)", async () => {
    const empty = await prepared();
    await expect(svc(empty.h, "public.bootstrap_workspace($1, 'SubEngine')", [empty.owner])).resolves.toMatchObject({ ok: true });
    const bare = await fresh();
    const owner = await bare.createAuthUser("owner@example.com");
    await expect(svc(bare, "public.bootstrap_workspace($1, 'SubEngine')", [owner])).resolves.toMatchObject({ ok: true });
  }, 60_000);

  it("records the ids of the API keys it revoked (for the re-bootstrap runbook)", async () => {
    const { h, owner, other } = await prepared();
    const keys = await h.db.query<{ id: string }>(
      `insert into public.api_keys (user_id, name, key_hash, prefix) values ($1, 'other key', 'hash-x', 'sk_x') returning id`,
      [other],
    );
    await svc(h, "public.bootstrap_workspace($1, 'SubEngine')", [owner]);
    const audit = await h.db.query<{ after: Json }>("select after from public.access_audit_log where event = 'bootstrap.completed'");
    expect(audit.rows[0].after).toMatchObject({ api_keys_revoked: 1, api_keys_revoked_ids: [keys.rows[0].id] });
  });
});

// ---- supabase/runbooks/rebootstrap_workspace.sql -------------------------------------------------

describe("re-bootstrap runbook (wrong data owner, no other member yet)", () => {
  const RUNBOOK = readFileSync("supabase/runbooks/rebootstrap_workspace.sql", "utf8");

  function runbookFor(wrong: string, owner: string): string {
    expect(RUNBOOK).toContain("'__WRONG_OWNER_UUID__'");
    expect(RUNBOOK).toContain("'__DATA_OWNER_UUID__'");
    // The test runs it inside its own transaction (asPostgres), so the file's
    // explicit begin / commit are dropped; everything else runs verbatim.
    return RUNBOOK
      .replace("'__WRONG_OWNER_UUID__'", `'${wrong}'`)
      .replace("'__DATA_OWNER_UUID__'", `'${owner}'`)
      .replace(/^begin;$/m, "")
      .replace(/^commit;$/m, "");
  }

  async function wronglyBootstrapped() {
    const h = await fresh();
    await h.db.exec(PREFLIGHT_TABLES_SQL);
    const wrong = await h.createAuthUser("wrong@example.com");
    const owner = await h.createAuthUser("owner@example.com");
    const ownerKey = (await h.db.query<{ id: string }>(
      `insert into public.api_keys (user_id, name, key_hash, prefix) values ($1, 'owner key', 'hash-o', 'sk_o') returning id`,
      [owner],
    )).rows[0].id;
    const wrongKey = (await h.db.query<{ id: string }>(
      `insert into public.api_keys (user_id, name, key_hash, prefix) values ($1, 'wrong key', 'hash-w', 'sk_w') returning id`,
      [wrong],
    )).rows[0].id;
    await svc(h, "public.bootstrap_workspace($1, 'SubEngine')", [wrong]);
    await svc(h, "public.access_seed_role_templates($1, $2::jsonb)", [wrong, JSON.stringify(TEMPLATES)]);
    return { h, wrong, owner, ownerKey, wrongKey };
  }

  it("moves the workspace and the data-owner membership to the right account, keeping roles and audit", async () => {
    const { h, wrong, owner, ownerKey, wrongKey } = await wronglyBootstrapped();
    const roles = (await h.db.query<{ n: number }>("select count(*)::int as n from public.access_roles")).rows[0].n;
    await h.asPostgres((tx) => tx.exec(runbookFor(wrong, owner)));

    expect(await svc(h, "public.workspace_data_key()")).toBe(owner);
    const access = await svc(h, "public.resolve_access($1)", [owner]);
    expect(access).toMatchObject({ status: "ok", is_data_owner: true, raw_access: true, data_key: owner, email: "owner@example.com" });
    expect(await svc(h, "public.resolve_access($1)", [wrong])).toMatchObject({ status: "no_membership" });
    expect((await h.db.query<{ n: number }>("select count(*)::int as n from public.access_roles")).rows[0].n).toBe(roles);

    const keys = await h.db.query<{ id: string; is_active: boolean; revoked_at: unknown }>("select id, is_active, revoked_at from public.api_keys");
    expect(keys.rows.find((key) => key.id === ownerKey)).toMatchObject({ is_active: true, revoked_at: null });
    expect(keys.rows.find((key) => key.id === wrongKey)).toMatchObject({ is_active: false });

    const events = await h.db.query<{ event: string }>("select event from public.access_audit_log order by id");
    expect(events.rows.map((row) => row.event)).toContain("bootstrap.completed");
    expect(events.rows.map((row) => row.event).at(-1)).toBe("bootstrap.rekeyed");

    // The guards are back on afterwards.
    await expect(h.db.query("update public.workspaces set data_key = $1", [wrong])).rejects.toThrow();
    await expect(h.db.query("update public.workspace_members set user_id = $1", [wrong])).rejects.toThrow(/immutable/);
  }, 120_000);

  it("refuses (changing nothing) once another member exists, or when the new owner fails the pre-flight", async () => {
    const withMember = await wronglyBootstrapped();
    await withMember.h.createAuthUser("viewer@example.com");
    const viewerRole = (await withMember.h.db.query<{ id: string }>("select id from public.access_roles where key = 'viewer'")).rows[0].id;
    await svc(withMember.h, ADD_MEMBER, [withMember.wrong, "viewer@example.com", viewerRole, "all", [], null]);
    await expect(withMember.h.asPostgres((tx) => tx.exec(runbookFor(withMember.wrong, withMember.owner)))).rejects.toThrow(/other members exist/);
    expect(await svc(withMember.h, "public.workspace_data_key()")).toBe(withMember.wrong);

    const badPreflight = await wronglyBootstrapped();
    await badPreflight.h.db.query("insert into public.fb_cron_config (auth_user_id) values ($1)", [badPreflight.wrong]);
    await expect(badPreflight.h.asPostgres((tx) => tx.exec(runbookFor(badPreflight.wrong, badPreflight.owner)))).rejects.toThrow(
      /preflight: fb_cron_config\.auth_user_id is not the data owner/,
    );
    expect(await svc(badPreflight.h, "public.workspace_data_key()")).toBe(badPreflight.wrong);
  }, 120_000);

  it("fails closed when the placeholders were not filled in", async () => {
    const { h } = await wronglyBootstrapped();
    const unfilled = RUNBOOK.replace(/^begin;$/m, "").replace(/^commit;$/m, "");
    await expect(h.asPostgres((tx) => tx.exec(unfilled))).rejects.toThrow(/invalid input syntax for type uuid/);
  }, 60_000);
});

// ---- views bypass RLS: the fail-closed check covers them ---------------------------------------

describe("fail-closed check: views, materialized views and foreign tables", () => {
  const CORE = "202610050002_access_core.sql";

  it("aborts on a browser-readable view (owner rights bypass RLS); a security_invoker view or an unreadable one passes", async () => {
    const before = await createSupabasePglite({ migrations: ACCESS_TEST_MIGRATIONS.filter((name) => name !== CORE) });
    opened.push(before);
    await before.db.exec("create view public.subscription_emails as select auth_user_id, normalized_email from public.funnelfox_subscriptions;");
    const leaky = await before.clone();
    opened.push(leaky);
    await expect(leaky.applyMigration(CORE)).rejects.toThrow(/readable by the browser roles bypass RLS: subscription_emails/);

    const invoker = await before.clone();
    opened.push(invoker);
    await invoker.db.exec("alter view public.subscription_emails set (security_invoker = true);");
    await expect(invoker.applyMigration(CORE)).resolves.toBeUndefined();

    const revoked = await before.clone();
    opened.push(revoked);
    await revoked.db.exec("revoke all on public.subscription_emails from anon, authenticated;");
    await expect(revoked.applyMigration(CORE)).resolves.toBeUndefined();
  }, 120_000);
});

describe("api_export_logs.actor_user_id", () => {
  it("exists before the Edge deploy that writes it (added by this migration, nullable)", async () => {
    const column = await seeded.h.db.query<{ is_nullable: string; data_type: string }>(
      `select is_nullable, data_type from information_schema.columns
       where table_schema = 'public' and table_name = 'api_export_logs' and column_name = 'actor_user_id'`,
    );
    expect(column.rows).toEqual([{ is_nullable: "YES", data_type: "uuid" }]);
  });
});
