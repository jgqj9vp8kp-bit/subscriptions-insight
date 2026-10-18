// Executable tests for supabase/migrations/202610180002_shared_cohort_views.sql
// and 202610180003_shared_cohort_views_default_roles.sql,
// run against PGlite through the Supabase stand-in in ./support/pgliteSupabase.ts:
// every earlier migration (pg_cron / pg_net stubbed) with the workspace
// bootstrapped before the RLS lockdown, then members on custom roles, then this
// migration.
//
// Covers: the Owner inserts / updates / deletes; a member with cohorts.view —
// scope all or a single funnel — reads every view and can write none; a member
// without cohorts.view, a disabled member, an outsider and anon see nothing;
// name constraints (trimmed, 1..80, unique case-insensitively); updated_at;
// default_role_keys (default empty, Owner-only, no NULL element).
//
// Runs in the default jsdom environment (src/test/setup.ts needs `window`).
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createSupabasePglite, listMigrations, type SqlRunner, type SupabasePglite } from "./support/pgliteSupabase";
import { sharedViewFromRow } from "@/services/sharedCohortViews";

const LOCKDOWN = "202610050003_access_rls_lockdown.sql";
const MIGRATION = "202610180002_shared_cohort_views.sql";
const DEFAULT_ROLES = "202610180003_shared_cohort_views_default_roles.sql";

type Users = Record<"owner" | "buyer" | "scoped" | "noCohorts" | "disabled" | "outsider", string>;

let base: SupabasePglite;
let users: Users;
const opened: SupabasePglite[] = [];

async function one<T>(tx: SqlRunner, sql: string, params: unknown[] = []): Promise<T> {
  const result = await tx.query<T>(sql, params);
  return result.rows[0];
}

beforeAll(async () => {
  const db = await createSupabasePglite({ migrations: listMigrations({ before: LOCKDOWN }), extensionStubs: true });
  const owner = await db.createAuthUser("owner@example.com");
  await db.db.query("select public.bootstrap_workspace($1, 'SubEngine')", [owner]);
  for (const name of listMigrations().filter((migration) => migration >= LOCKDOWN && migration < MIGRATION)) {
    await db.applyMigration(name);
  }
  users = {
    owner,
    buyer: await db.createAuthUser("buyer@example.com"),
    scoped: await db.createAuthUser("scoped@example.com"),
    noCohorts: await db.createAuthUser("nocohorts@example.com"),
    disabled: await db.createAuthUser("disabled@example.com"),
    outsider: await db.createAuthUser("outsider@example.com"),
  };
  const funnel = await one<{ id: string }>(db.db, "insert into public.funnels (funnel_path, display_name) values ('palm-reading', 'Palm') returning id");
  const role = async (key: string, permissions: string[]) =>
    (await db.asService((tx) =>
      one<{ value: { role_id: string } }>(tx, "select public.access_create_role($1, $2, $3, '', $4::text[]) as value", [owner, key, key, permissions]),
    )).value.role_id;
  const buyerRole = await role("buyer", ["cohorts.view", "dashboard.view"]);
  const dashboardRole = await role("dashboard", ["dashboard.view"]);
  const add = async (email: string, roleId: string, mode: string, funnelIds: string[] = []) =>
    (await db.asService((tx) =>
      one<{ value: { member_id: string } }>(tx, "select public.access_add_member($1, $2, $3, $4, $5::uuid[], null) as value", [owner, email, roleId, mode, funnelIds]),
    )).value.member_id;
  await add("buyer@example.com", buyerRole, "all");
  await add("scoped@example.com", buyerRole, "selected", [funnel.id]);
  await add("nocohorts@example.com", dashboardRole, "all");
  const disabled = await add("disabled@example.com", buyerRole, "all");
  await db.asService((tx) => tx.query("select public.access_update_member($1, $2, null, 'disabled', null)", [owner, disabled]));
  await db.applyMigration(MIGRATION);
  await db.applyMigration(DEFAULT_ROLES);
  base = db;
}, 300_000);

afterEach(async () => {
  while (opened.length) await opened.pop()!.close();
});

async function copy(): Promise<SupabasePglite> {
  const h = await base.clone();
  opened.push(h);
  return h;
}

const INSERT = `insert into public.shared_cohort_views (name, column_order, column_visibility, column_widths)
  values ($1, array['trial_users','gross_revenue'], '{"trial_users":true,"gross_revenue":false}'::jsonb, '{"trial_users":120}'::jsonb)
  returning id, name, column_order, column_visibility, column_widths, updated_at, created_by`;

async function names(h: SupabasePglite, userId: string): Promise<string[]> {
  return h.asUser(userId, async (tx) => (await tx.query<{ name: string }>("select name from public.shared_cohort_views order by name")).rows.map((row) => row.name));
}

describe("202610180002 shared Cohorts views", () => {
  it("lets the Owner publish, update and remove; every Cohorts viewer reads", async () => {
    const h = await copy();
    const row = await h.asUser(users.owner, (tx) => one<Record<string, unknown>>(tx, INSERT, ["Buyer"]));
    expect(row.created_by).toBe(users.owner);
    expect(sharedViewFromRow(row)).toMatchObject({
      id: `shared:${row.id}`,
      name: "Buyer",
      columnOrder: ["trial_users", "gross_revenue"],
      columnVisibility: { trial_users: true, gross_revenue: false },
      columnWidths: { trial_users: 120 },
    });
    await h.asUser(users.owner, (tx) => tx.query(INSERT, ["Revenue team"]));

    for (const reader of [users.owner, users.buyer, users.scoped]) {
      expect(await names(h, reader)).toEqual(["Buyer", "Revenue team"]);
    }

    const before = String(row.updated_at);
    const updated = await h.asUser(users.owner, (tx) =>
      one<{ updated_at: string; column_order: string[] }>(
        tx,
        "update public.shared_cohort_views set column_order = array['gross_revenue'] where id = $1 returning updated_at, column_order",
        [row.id],
      ),
    );
    expect(updated.column_order).toEqual(["gross_revenue"]);
    expect(new Date(updated.updated_at).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime());

    await h.asUser(users.owner, (tx) => tx.query("delete from public.shared_cohort_views where id = $1", [row.id]));
    expect(await names(h, users.buyer)).toEqual(["Revenue team"]);
  });

  it("keeps every write to the Owner", async () => {
    const h = await copy();
    const row = await h.asUser(users.owner, (tx) => one<{ id: string }>(tx, INSERT, ["Buyer"]));
    for (const member of [users.buyer, users.scoped, users.noCohorts]) {
      await expect(h.asUser(member, (tx) => tx.query(INSERT, ["Mine"]))).rejects.toThrow(/row-level security/);
      const updated = await h.asUser(member, (tx) =>
        tx.query("update public.shared_cohort_views set name = 'Hijacked' where id = $1", [row.id]),
      );
      expect(updated.affectedRows ?? 0).toBe(0);
      const deleted = await h.asUser(member, (tx) => tx.query("delete from public.shared_cohort_views where id = $1", [row.id]));
      expect(deleted.affectedRows ?? 0).toBe(0);
    }
    expect(await names(h, users.owner)).toEqual(["Buyer"]);
  });

  it("shows nothing without cohorts.view or an active membership, and nothing to anon", async () => {
    const h = await copy();
    await h.asUser(users.owner, (tx) => tx.query(INSERT, ["Buyer"]));
    for (const reader of [users.noCohorts, users.disabled, users.outsider]) {
      expect(await names(h, reader)).toEqual([]);
    }
    await expect(h.asAnon((tx) => tx.query("select name from public.shared_cohort_views"))).rejects.toThrow(/permission denied/);
  });

  it("requires a trimmed 1..80 character name, unique in any case", async () => {
    const h = await copy();
    await h.asUser(users.owner, (tx) => tx.query(INSERT, ["Buyer"]));
    await expect(h.asUser(users.owner, (tx) => tx.query(INSERT, ["buyer"]))).rejects.toThrow(/shared_cohort_views_name_idx/);
    await expect(h.asUser(users.owner, (tx) => tx.query(INSERT, [" Padded "]))).rejects.toThrow(/shared_cohort_views_name_check/);
    await expect(h.asUser(users.owner, (tx) => tx.query(INSERT, [""]))).rejects.toThrow(/shared_cohort_views_name_check/);
    await expect(h.asUser(users.owner, (tx) => tx.query(INSERT, ["x".repeat(81)]))).rejects.toThrow(/shared_cohort_views_name_check/);
  });

  it("stores the default roles of a view, written by the Owner only", async () => {
    const h = await copy();
    const row = await h.asUser(users.owner, (tx) => one<{ id: string; default_role_keys: string[] }>(tx, INSERT.replace("created_by", "created_by, default_role_keys"), ["Buyer"]));
    expect(row.default_role_keys).toEqual([]);
    const updated = await h.asUser(users.owner, (tx) =>
      one<Record<string, unknown>>(
        tx,
        "update public.shared_cohort_views set default_role_keys = array['media_buyer','head_of_marketing'] where id = $1 returning id, name, column_order, column_visibility, column_widths, default_role_keys, updated_at",
        [row.id],
      ),
    );
    expect(sharedViewFromRow(updated)?.defaultRoleKeys).toEqual(["head_of_marketing", "media_buyer"]);
    await h.asUser(users.buyer, (tx) => tx.query("update public.shared_cohort_views set default_role_keys = '{}' where id = $1", [row.id]));
    const seen = await h.asUser(users.buyer, (tx) => one<{ default_role_keys: string[] }>(tx, "select default_role_keys from public.shared_cohort_views where id = $1", [row.id]));
    expect(seen.default_role_keys).toEqual(["media_buyer", "head_of_marketing"]);
    await expect(
      h.asUser(users.owner, (tx) => tx.query("update public.shared_cohort_views set default_role_keys = array['a', null] where id = $1", [row.id])),
    ).rejects.toThrow(/shared_cohort_views_default_roles_check/);
  });
});
