// Executable tests for supabase/migrations/202610060001_access_phase2_scope.sql
// and 202610060002_cohort_membership_freshness_cron.sql (implementation spec
// §2.4), run against PGlite through ./support/pgliteSupabase.ts. Every earlier
// migration is applied (pg_cron / pg_net stubbed), then the workspace, members
// and registry the migration finds, then the RLS lockdown, then this one.
//
// Covers: the 0003 guard and the fail-closed checks; the funnel_paths seed
// (collisions, unscopable paths, FunnelFox rename proposals); CHECK, identity
// and uniqueness rules; the funnels canonicalize / mirror triggers; resolver
// output from funnel_paths; access_version bumps; registry RLS (reads scoped
// to the member's funnels, no browser writes on funnel_paths); the path RPCs
// with their audit rows; the snapshot-state columns and RPCs; SQL vs
// TypeScript canonicalizer parity; policy shape; the freshness cron; the
// rollback file.
//
// Runs in the default jsdom environment: src/test/setup.ts touches `window`
// (the harness makes PGlite work under jsdom).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createSupabasePglite,
  listMigrations,
  readMigration,
  type SqlRunner,
  type SupabasePglite,
} from "./support/pgliteSupabase";
import { normalizePalmerRows } from "../../supabase/functions/_shared/clickhouse/palmerTransform.ts";

const LOCKDOWN = "202610050003_access_rls_lockdown.sql";
const PHASE2 = "202610060001_access_phase2_scope.sql";
const CRON = "202610060002_cohort_membership_freshness_cron.sql";
const ROLLBACK_SQL = readFileSync(join(process.cwd(), "supabase", "rollback", "202610060001_rollback.sql"), "utf8");

const FF_SOULMATE = "01KTKBKEHTK6WCNV9TVDJWQHBS";
const COLLISION_NOTE = "canonical collision: several registry rows share this path";
const ALIAS = "soulmate-1-tariff-month-veb";

const ATTACH = "public.access_attach_funnel_path($1, $2, $3, $4)";
const SET_STATUS = "public.access_set_funnel_path_status($1, $2::bigint, $3, $4)";

type Json = Record<string, unknown>;
type UserKey = "owner" | "manager" | "viewer" | "buyerA" | "buyerAB" | "buyerC" | "none" | "disabled" | "outsider";
type MemberKey = Exclude<UserKey, "outsider">;
type FunnelKey = "soulmate" | "pastLife" | "palm" | "aUnderscore" | "aDash" | "cyrillic";

interface Seed {
  users: Record<UserKey, string>;
  members: Record<MemberKey, string>;
  funnels: Record<FunnelKey, string>;
  tags: { evergreen: string; palmistry: string; shared: string; orphan: string };
}

interface PathRow {
  funnel: string;
  path: string;
  status: string;
  source: string;
  funnelfox_funnel_id: string | null;
  note: string;
  confirmed: boolean;
}

interface MutationResult {
  ok: boolean;
  changed: boolean;
  path: Json & { id: number; funnel_id: string; path_canonical: string; status: string; source: string };
  affected_members: number;
}

let base: SupabasePglite; // every migration before the lockdown, no workspace
let prepared: SupabasePglite; // + registry, bootstrap, members, snapshot state
let locked: SupabasePglite; // + the lockdown (and anything before this migration)
let post: SupabasePglite; // + 202610060001
let full: SupabasePglite; // + 202610060002 (cron)
let seed: Seed;
const opened: SupabasePglite[] = [];

// Every test clones a PGlite database and runs many statements (T1 applies the
// migration again): seconds each, more under a parallel run.
vi.setConfig({ testTimeout: 60_000 });

const ZERO: Record<MemberKey, number> = {
  owner: 0, manager: 0, viewer: 0, buyerA: 0, buyerAB: 0, buyerC: 0, none: 0, disabled: 0,
};
// Every member whose member_scope_values hold the soulmate funnel (the disabled
// one too: its version moves, it just cannot use it).
const SOULMATE_HOLDERS = { ...ZERO, buyerA: 1, buyerAB: 1, disabled: 1 };

async function copyOf(source: SupabasePglite): Promise<SupabasePglite> {
  const copy = await source.clone();
  opened.push(copy);
  return copy;
}

async function one<T = Json>(tx: SqlRunner, expression: string, params: unknown[] = []): Promise<T> {
  return (await tx.query<{ value: T }>(`select ${expression} as value`, params)).rows[0].value;
}

function svc<T = Json>(h: SupabasePglite, expression: string, params: unknown[] = []): Promise<T> {
  return h.asService((tx) => one<T>(tx, expression, params));
}

function countAs(h: SupabasePglite, user: string, table: string): Promise<number> {
  return h.asUser(user, (tx) => one<number>(tx, `(select count(*)::int from public.${table})`));
}

function funnelName(id: string): string {
  return Object.entries(seed.funnels).find(([, value]) => value === id)?.[0] ?? id;
}

async function pathRows(h: SupabasePglite, funnelId: string | null = null): Promise<PathRow[]> {
  const result = await h.db.query<PathRow & { funnel_id: string }>(
    `select funnel_id::text, path_canonical as path, status, source, funnelfox_funnel_id, note,
            confirmed_at is not null as confirmed
     from public.funnel_paths where $1::uuid is null or funnel_id = $1::uuid`,
    [funnelId],
  );
  const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return result.rows
    .map(({ funnel_id, ...row }) => ({ ...row, funnel: funnelName(funnel_id) }))
    .sort((a, b) => byCodePoint(a.path, b.path) || byCodePoint(a.funnel, b.funnel));
}

/** INSERT ... RETURNING id as postgres (a data-modifying statement cannot sit in a subquery). */
async function insertId(h: SupabasePglite, sql: string, params: unknown[] = []): Promise<string> {
  return (await h.db.query<{ id: string }>(`${sql} returning id::text as id`, params)).rows[0].id;
}

async function pathId(h: SupabasePglite, funnelId: string, path: string): Promise<string> {
  return one<string>(h.db, "(select id::text from public.funnel_paths where funnel_id = $1 and path_canonical = $2)", [funnelId, path]);
}

async function versions(h: SupabasePglite): Promise<Record<MemberKey, number>> {
  const rows = (await h.db.query<{ id: string; v: number }>("select id::text, access_version::int as v from public.workspace_members")).rows;
  const byId = new Map(rows.map((row) => [row.id, row.v]));
  return Object.fromEntries(Object.entries(seed.members).map(([name, id]) => [name, byId.get(id)!])) as Record<MemberKey, number>;
}

/** access_version delta per member caused by `action`. */
async function bumps(h: SupabasePglite, action: () => Promise<unknown>): Promise<Record<MemberKey, number>> {
  const before = await versions(h);
  await action();
  const after = await versions(h);
  return Object.fromEntries(Object.keys(before).map((name) => [name, after[name as MemberKey] - before[name as MemberKey]])) as Record<MemberKey, number>;
}

const resolve = (h: SupabasePglite, user: string) => svc<Json>(h, "public.resolve_access($1)", [user]);
const scopePaths = async (h: SupabasePglite, user: string) => ((await resolve(h, user)).funnel_scope as { paths: string[] }).paths;
const myAccess = (h: SupabasePglite, user: string) => h.asUser(user, (tx) => one<Json>(tx, "public.my_access()"));
// app.* has no schema USAGE for the API roles: evaluate as postgres with the JWT claim.
const allowedPaths = (h: SupabasePglite, user: string) => h.asPostgres((tx) => one<string[]>(tx, "app.allowed_paths()"), user);

const attach = (h: SupabasePglite, actor: string | null, funnelId: string | null, path: string, note: string | null = null) =>
  svc<MutationResult>(h, ATTACH, [actor, funnelId, path, note]);
const setStatus = (h: SupabasePglite, actor: string | null, id: string, status: string, note: string | null = null) =>
  svc<MutationResult>(h, SET_STATUS, [actor, id, status, note]);

async function registryAudit(h: SupabasePglite) {
  return (
    await h.db.query<{
      event: string; actor_kind: string; actor_user_id: string | null; actor_member_id: string | null;
      target_type: string | null; target_id: string | null; before: Json | null; after: Json | null; context: Json;
    }>(
      `select event, actor_kind, actor_user_id::text, actor_member_id::text, target_type, target_id, before, after, context
       from public.access_audit_log where event like 'registry.%' order by id`,
    )
  ).rows;
}

async function privileges(h: SupabasePglite, signature: string) {
  return one<Json>(
    h.db,
    `json_build_object(
       'anon', has_function_privilege('anon', $1, 'execute'),
       'authenticated', has_function_privilege('authenticated', $1, 'execute'),
       'service', has_function_privilege('service_role', $1, 'execute'),
       'public', coalesce((select array_to_string(p.proacl, ',') ~ '(^|,)=X' from pg_proc p where p.oid = $1::regprocedure), true))`,
    [signature],
  );
}

async function buildPrepared(): Promise<{ h: SupabasePglite; seed: Seed }> {
  const h = await base.clone();
  const users = {
    owner: await h.createAuthUser("owner@example.com"),
    manager: await h.createAuthUser("manager@example.com"),
    viewer: await h.createAuthUser("viewer@example.com"),
    buyerA: await h.createAuthUser("buyer-a@example.com"),
    buyerAB: await h.createAuthUser("buyer-ab@example.com"),
    buyerC: await h.createAuthUser("buyer-c@example.com"),
    none: await h.createAuthUser("none@example.com"),
    disabled: await h.createAuthUser("disabled@example.com"),
    outsider: await h.createAuthUser("outsider@example.com"),
  };

  // The registry as production has it before this migration: a non-canonical
  // path, a FunnelFox-imported row, a slug collision and an unscopable path.
  const funnelRows = await h.db.query<{ id: string; funnel_path: string }>(
    `insert into public.funnels (funnel_path, display_name, funnelfox_funnel_id) values
       ('/Soulmate-Sketch', 'Soulmate', $1), ('past-life', 'Past life', null), ('palm-reading', 'Palm', null),
       ('a_b', 'A underscore B', null), ('a-b', 'A dash B', null), ('тест', 'Cyrillic', null)
     returning id, funnel_path`,
    [FF_SOULMATE],
  );
  const funnelId = (path: string) => funnelRows.rows.find((row) => row.funnel_path === path)!.id;
  const funnels = {
    soulmate: funnelId("/Soulmate-Sketch"), pastLife: funnelId("past-life"), palm: funnelId("palm-reading"),
    aUnderscore: funnelId("a_b"), aDash: funnelId("a-b"), cyrillic: funnelId("тест"),
  };
  const tag = async (name: string, funnelIds: string[]) => {
    const id = await insertId(h, "insert into public.tags (name) values ($1)", [name]);
    for (const funnel of funnelIds) await h.db.query("insert into public.funnel_tags (funnel_id, tag_id) values ($1, $2)", [funnel, id]);
    return id;
  };
  const tags = {
    evergreen: await tag("evergreen", [funnels.soulmate]),
    palmistry: await tag("palmistry", [funnels.palm]),
    shared: await tag("shared", [funnels.soulmate, funnels.palm]),
    orphan: await tag("orphan", []),
  };

  await h.db.query("select public.bootstrap_workspace($1, 'SubEngine')", [users.owner]);
  const role = async (key: string, permissions: string[]) =>
    (await svc<{ role_id: string }>(h, "public.access_create_role($1, $2, $3, '', $4::text[])", [users.owner, key, key, permissions])).role_id;
  const roles = {
    viewer: await role("viewer", ["cohorts.view", "dashboard.view", "funnels.view"]),
    manager: await role("manager", ["funnels.manage", "funnels.view"]),
  };
  const add = async (email: string, roleId: string, mode: string, funnelIds: string[] = []) =>
    (await svc<{ member_id: string }>(h, "public.access_add_member($1, $2, $3, $4, $5::uuid[], null)", [users.owner, email, roleId, mode, funnelIds])).member_id;
  const members = {
    owner: await one<string>(h.db, "(select id::text from public.workspace_members where user_id = $1)", [users.owner]),
    manager: await add("manager@example.com", roles.manager, "all"),
    viewer: await add("viewer@example.com", roles.viewer, "all"),
    buyerA: await add("buyer-a@example.com", roles.viewer, "selected", [funnels.soulmate]),
    buyerAB: await add("buyer-ab@example.com", roles.viewer, "selected", [funnels.soulmate, funnels.pastLife]),
    buyerC: await add("buyer-c@example.com", roles.viewer, "selected", [funnels.palm]),
    none: await add("none@example.com", roles.viewer, "none"),
    disabled: await add("disabled@example.com", roles.viewer, "selected", [funnels.soulmate]),
  };
  await svc(h, "public.access_update_member($1, $2, null, 'disabled', null)", [users.owner, members.disabled]);

  await h.db.query(
    `insert into public.fb_cron_config (auth_user_id, cron_secret, function_url, anon_key)
     values ($1, 'cron-secret', 'https://project.supabase.co/functions/v1/clickhouse-facebook', 'anon-jwt')`,
    [users.owner],
  );
  // The snapshot active today (backfilled) and another account's failed build (not).
  await h.db.query(
    `insert into public.clickhouse_cohort_snapshot_state
       (auth_user_id, status, active_warehouse_version, active_classification_version, finished_at, diagnostics)
     values ($1, 'completed', 'wh_1', 'cv_1', '2026-10-01T00:00:00Z', '{"validation": {"status": "PASS", "duplicate_users": 0}}'),
            ($2, 'failed', 'wh_0', 'cv_1', '2026-10-02T00:00:00Z', '{"validation": {"status": "FAIL"}}')`,
    [users.owner, users.outsider],
  );

  return { h, seed: { users, members, funnels, tags } };
}

beforeAll(async () => {
  base = await createSupabasePglite({ migrations: listMigrations({ before: LOCKDOWN }), extensionStubs: true });
  ({ h: prepared, seed } = await buildPrepared());
  locked = await prepared.clone();
  for (const name of listMigrations().filter((migration) => migration >= LOCKDOWN && migration < PHASE2)) {
    await locked.applyMigration(name);
  }
  post = await locked.clone();
  await post.applyMigration(PHASE2);
  full = await post.clone();
  for (const name of listMigrations().filter((migration) => migration > PHASE2 && migration <= CRON)) {
    await full.applyMigration(name);
  }
}, 300_000);

afterEach(async () => {
  while (opened.length) await opened.pop()!.close();
});

// ---------------------------------------------------------------------------------------------------

describe("T1 guard and fail-closed checks", () => {
  it("orders the two migrations after the lockdown", () => {
    const all = listMigrations();
    expect(all.indexOf(PHASE2)).toBeGreaterThan(all.indexOf(LOCKDOWN));
    expect(all.indexOf(CRON)).toBe(all.indexOf(PHASE2) + 1);
  });

  it("aborts before the RLS lockdown, and creates nothing", async () => {
    const h = await copyOf(prepared);
    await expect(h.applyMigration(PHASE2)).rejects.toThrow(/202610050003_access_rls_lockdown\.sql is not applied/);
    expect(await one(h.db, "to_regclass('public.funnel_paths')::text")).toBeNull();
    expect(await one(h.db, "to_regprocedure('app.canonical_campaign_path(text)')::text")).toBeNull();
    expect(await one(h.db, "(select count(*)::int from pg_trigger where tgname = 'funnels_bump_member_access_version')")).toBe(1);
  });

  it("aborts on a browser-reachable table without the lockdown policy, or a table without RLS", async () => {
    const reachable = await copyOf(locked);
    await reachable.db.exec("create table public.rogue_registry (id int); alter table public.rogue_registry enable row level security;");
    await expect(reachable.applyMigration(PHASE2)).rejects.toThrow(/reachable by the browser without lockdown_active_member: rogue_registry/);
    expect(await one(reachable.db, "to_regclass('public.funnel_paths')::text")).toBeNull();

    const noRls = await copyOf(locked);
    await noRls.db.exec("create table public.rogue_plain (id int); revoke all on public.rogue_plain from anon, authenticated;");
    await expect(noRls.applyMigration(PHASE2)).rejects.toThrow(/row level security is disabled on public table\(s\): rogue_plain/);
  });
});

describe("T2 seed", () => {
  it("grants every funnel its own canonical path; collisions and FunnelFox renames become proposals", async () => {
    const own = { source: "registry_seed", note: "", confirmed: true, status: "active" };
    const collision = { path: "a-b", status: "proposed", source: "registry_seed", funnelfox_funnel_id: null, note: COLLISION_NOTE, confirmed: false };
    expect(await pathRows(post)).toEqual([
      { ...collision, funnel: "aDash" },
      { ...collision, funnel: "aUnderscore" },
      { ...own, funnel: "palm", path: "palm-reading", funnelfox_funnel_id: null },
      { ...own, funnel: "pastLife", path: "past-life", funnelfox_funnel_id: null },
      {
        funnel: "soulmate", path: ALIAS, status: "proposed", source: "funnelfox_alias_seed", funnelfox_funnel_id: FF_SOULMATE,
        note: `FunnelFox funnel ${FF_SOULMATE} has also run under this path (202607240002)`, confirmed: false,
      },
      { ...own, funnel: "soulmate", path: "soulmate-sketch", funnelfox_funnel_id: FF_SOULMATE },
    ]);
    // The unscopable funnel gets no row (its data stays scope-all only).
    expect(await pathRows(post, seed.funnels.cyrillic)).toEqual([]);
  });

  it("writes one system audit row with the counts", async () => {
    expect(await registryAudit(post)).toEqual([
      {
        event: "registry.paths_seeded", actor_kind: "system", actor_user_id: null, actor_member_id: null,
        target_type: "registry", target_id: null, before: null, after: null,
        // skipped = the unscopable funnel + the alias pair whose path is already granted.
        context: { active: 3, proposed: 3, skipped: 2 },
      },
    ]);
  });

  it("changes no access_version and no resolver output, and rewrites no funnel row", async () => {
    expect(await versions(post)).toEqual(await versions(locked));
    for (const user of Object.values(seed.users)) {
      expect(await resolve(post, user), user).toEqual(await resolve(locked, user));
      expect(await myAccess(post, user), user).toEqual(await myAccess(locked, user));
    }
    const funnels = "select id, funnel_path, display_name, is_active, updated_at from public.funnels order by id";
    expect((await post.db.query(funnels)).rows).toEqual((await locked.db.query(funnels)).rows);
  });
});

describe("T3 CHECK constraints", () => {
  const insert = (h: SupabasePglite, path: string, extra: { status?: string; source?: string; note?: string; confirmed?: boolean } = {}) =>
    h.db.query(
      `insert into public.funnel_paths (funnel_id, path_canonical, status, source, note, confirmed_at)
       values ($1, $2, $3, $4, $5, case when $6 then now() end)`,
      [seed.funnels.pastLife, path, extra.status ?? "proposed", extra.source ?? "admin_alias", extra.note ?? "", extra.confirmed ?? false],
    );

  it("stores canonical paths only", async () => {
    const h = await copyOf(post);
    for (const path of ["Soulmate", "/x", "a--b", "-a", "a-", "a_b", "a b", "unknown", "", "a".repeat(201)]) {
      await expect(insert(h, path), JSON.stringify(path)).rejects.toThrow(/funnel_paths_path_canonical_check/);
    }
    await insert(h, "a-b-1");
    await insert(h, "a".repeat(200));
    expect((await pathRows(h, seed.funnels.pastLife)).map((row) => row.path)).toEqual(["a-b-1", "a".repeat(200), "past-life"]);
  });

  it("checks status, source, confirmation and note length", async () => {
    const h = await copyOf(post);
    await expect(insert(h, "x-1", { status: "pending" })).rejects.toThrow(/funnel_paths_status_check/);
    await expect(insert(h, "x-2", { source: "browser" })).rejects.toThrow(/funnel_paths_source_check/);
    await expect(insert(h, "x-3", { status: "active" })).rejects.toThrow(/funnel_paths_confirmed_check/);
    await expect(insert(h, "x-4", { status: "retired" })).rejects.toThrow(/funnel_paths_confirmed_check/);
    await expect(insert(h, "x-5", { note: "n".repeat(501) })).rejects.toThrow(/funnel_paths_note_check/);
    await insert(h, "x-6", { status: "active", confirmed: true, note: "n".repeat(500) });
    await insert(h, "x-7", { status: "revoked" });
  });
});

describe("T4 immutability", () => {
  it("refuses identity changes, a way back to proposed, DELETE and TRUNCATE, for the table owner too", async () => {
    const h = await copyOf(post);
    const id = await pathId(h, seed.funnels.soulmate, "soulmate-sketch");
    const immutable = /invalid: funnel_paths funnel_id, path_canonical, source, funnelfox_funnel_id and created_\* are immutable/;
    for (const [column, value] of [
      ["funnel_id", `'${seed.funnels.palm}'::uuid`],
      ["path_canonical", "'soulmate-other'"],
      ["source", "'admin_alias'"],
      ["funnelfox_funnel_id", "'01OTHER'"],
      ["created_at", "now() - interval '1 day'"],
      ["created_by", `'${seed.users.owner}'::uuid`],
    ]) {
      await expect(h.db.query(`update public.funnel_paths set ${column} = ${value} where id = $1`, [id]), column).rejects.toThrow(immutable);
    }
    await expect(h.db.query("update public.funnel_paths set status = 'proposed' where id = $1", [id])).rejects.toThrow(
      /invalid: a funnel path cannot go back to proposed/,
    );
    await expect(h.db.query("delete from public.funnel_paths where id = $1", [id])).rejects.toThrow(
      /invalid: funnel_paths rows are never deleted; revoke the path instead/,
    );
    await expect(h.db.exec("truncate public.funnel_paths")).rejects.toThrow(/invalid: TRUNCATE is not allowed on funnel_paths/);
    // Deleting a funnel that has paths (here only a proposal) is refused by the FK.
    await expect(h.db.query("delete from public.funnels where id = $1", [seed.funnels.aDash])).rejects.toThrow(/funnel_paths_funnel_id_fkey/);
    expect(await pathRows(h)).toEqual(await pathRows(post));
  });

  it("keeps the mutable columns mutable and stamps updated_at", async () => {
    const h = await copyOf(post);
    const id = await pathId(h, seed.funnels.soulmate, "soulmate-sketch");
    const before = await one<string>(h.db, "(select updated_at::text from public.funnel_paths where id = $1)", [id]);
    await h.db.query("update public.funnel_paths set note = 'checked' where id = $1", [id]);
    const after = await one<{ note: string; moved: boolean }>(
      h.db,
      "(select json_build_object('note', note, 'moved', updated_at::text <> $2) from public.funnel_paths where id = $1)",
      [id, before],
    );
    expect(after).toEqual({ note: "checked", moved: true });
  });
});

describe("T5 uniqueness", () => {
  it("grants a path to one funnel only; proposals may compete; a revoked path can be granted elsewhere", async () => {
    const h = await copyOf(post);
    const { soulmate, palm, pastLife } = seed.funnels;
    for (const status of ["active", "retired"]) {
      await expect(
        h.db.query(
          "insert into public.funnel_paths (funnel_id, path_canonical, status, source, confirmed_at) values ($1, 'soulmate-sketch', $2, 'admin_alias', now())",
          [palm, status],
        ),
        status,
      ).rejects.toThrow(/funnel_paths_granted_path_uidx/);
    }
    const propose = (funnel: string) =>
      h.db.query("insert into public.funnel_paths (funnel_id, path_canonical, status, source) values ($1, 'shared-idea', 'proposed', 'admin_alias')", [funnel]);
    await propose(palm);
    await propose(pastLife);
    await expect(propose(palm)).rejects.toThrow(/funnel_paths_funnel_path_uidx/);

    const { owner } = seed.users;
    const attached = await attach(h, owner, soulmate, "soulmate-old");
    await expect(attach(h, owner, palm, "soulmate-old")).rejects.toThrow(/^conflict: path is already part of another funnel/);
    await setStatus(h, owner, String(attached.path.id), "retired");
    await expect(attach(h, owner, palm, "soulmate-old")).rejects.toThrow(/^conflict: path is already part of another funnel/);
    await setStatus(h, owner, String(attached.path.id), "revoked");
    const moved = await attach(h, owner, palm, "soulmate-old");
    expect(moved).toMatchObject({ ok: true, changed: true, path: { funnel_id: palm, path_canonical: "soulmate-old", status: "active", source: "admin_alias" } });
    expect((await pathRows(h)).filter((row) => row.path === "soulmate-old").map((row) => [row.funnel, row.status])).toEqual([
      ["palm", "active"],
      ["soulmate", "revoked"],
    ]);
  });
});

describe("T6 funnels triggers", () => {
  const insertFunnel = (h: SupabasePglite, user: string, path: string, funnelfoxId: string | null = null) =>
    h.asUser(user, async (tx) =>
      (
        await tx.query<{ id: string; funnel_path: string }>(
          "insert into public.funnels (funnel_path, display_name, funnelfox_funnel_id) values ($1, 'New', $2) returning id::text, funnel_path",
          [path, funnelfoxId],
        )
      ).rows[0],
    );
  const repath = (h: SupabasePglite, user: string, funnelId: string, path: string) =>
    h.asUser(user, (tx) => tx.query("update public.funnels set funnel_path = $2 where id = $1", [funnelId, path]));

  it("stores a new funnel's canonical path with an active registry row, audited for the user", async () => {
    const h = await copyOf(post);
    const { manager } = seed.users;
    const created = await insertFunnel(h, manager, "/New-Funnel", "01NEWFUNNEL");
    expect(created.funnel_path).toBe("new-funnel");
    const row = await one<Json>(
      h.db,
      `(select json_build_object('path', path_canonical, 'status', status, 'source', source, 'funnelfox_funnel_id', funnelfox_funnel_id,
                                 'created_by', created_by, 'confirmed_by', confirmed_by, 'confirmed', confirmed_at is not null)
        from public.funnel_paths where funnel_id = $1)`,
      [created.id],
    );
    expect(row).toEqual({
      path: "new-funnel", status: "active", source: "registry", funnelfox_funnel_id: "01NEWFUNNEL",
      created_by: manager, confirmed_by: manager, confirmed: true,
    });
    expect((await registryAudit(h)).at(-1)).toEqual({
      event: "registry.path_registered", actor_kind: "user", actor_user_id: manager, actor_member_id: seed.members.manager,
      target_type: "funnel", target_id: created.id, before: null, after: { path: "new-funnel" }, context: {},
    });

    // The SQL editor (postgres, no JWT) is audited as the system.
    await h.db.query("insert into public.funnels (funnel_path) values ('Editor Funnel')");
    expect((await registryAudit(h)).at(-1)).toMatchObject({
      event: "registry.path_registered", actor_kind: "system", actor_user_id: null, actor_member_id: null, after: { path: "editor-funnel" },
    });
  });

  it("refuses a path with no canonical form", async () => {
    const h = await copyOf(post);
    const { manager } = seed.users;
    await expect(insertFunnel(h, manager, "/тест/")).rejects.toThrow(/invalid: funnel_path has no canonical campaign_path form/);
    await expect(insertFunnel(h, manager, "unknown")).rejects.toThrow(/invalid: funnel_path has no canonical campaign_path form/);
    await expect(repath(h, manager, seed.funnels.palm, "///")).rejects.toThrow(/invalid: funnel_path has no canonical campaign_path form/);
    expect(await one(h.db, "(select count(*)::int from public.funnels)")).toBe(6);
  });

  it("refuses a path granted to another funnel, and writes no funnel row", async () => {
    const h = await copyOf(post);
    const { manager, owner } = seed.users;
    await expect(insertFunnel(h, manager, "Soulmate_Sketch")).rejects.toThrow(/conflict: path soulmate-sketch already belongs to another funnel/);
    await attach(h, owner, seed.funnels.palm, "palm-old");
    await expect(insertFunnel(h, manager, "palm-old")).rejects.toThrow(/conflict: path palm-old already belongs to another funnel/);
    await expect(repath(h, manager, seed.funnels.pastLife, "PALM_OLD")).rejects.toThrow(/conflict: path palm-old already belongs to another funnel/);
    expect(await one(h.db, "(select count(*)::int from public.funnels)")).toBe(6);
    expect(await one(h.db, "(select funnel_path from public.funnels where id = $1)", [seed.funnels.pastLife])).toBe("past-life");
  });

  it("retires the old path on a re-path, and re-activates it on a re-path back", async () => {
    const h = await copyOf(post);
    const { manager } = seed.users;
    const { palm } = seed.funnels;
    const statuses = async () => (await pathRows(h, palm)).map((row) => [row.path, row.status, row.source]);
    const retiredAt = (path: string) => one<boolean>(h.db, "(select retired_at is not null from public.funnel_paths where funnel_id = $1 and path_canonical = $2)", [palm, path]);

    expect(await bumps(h, () => repath(h, manager, palm, "Palm-Reading-V2"))).toEqual({ ...ZERO, buyerC: 1 });
    expect(await one(h.db, "(select funnel_path from public.funnels where id = $1)", [palm])).toBe("palm-reading-v2");
    expect(await statuses()).toEqual([["palm-reading", "retired", "registry_seed"], ["palm-reading-v2", "active", "registry"]]);
    expect(await retiredAt("palm-reading")).toBe(true);
    expect(await scopePaths(h, seed.users.buyerC)).toEqual(["palm-reading", "palm-reading-v2"]);
    // The audit names who sees the change (buyerC holds palm), like the path RPCs.
    expect((await registryAudit(h)).at(-1)).toMatchObject({
      event: "registry.path_repathed", actor_kind: "user", actor_user_id: manager, target_type: "funnel", target_id: palm,
      before: { path: "palm-reading" }, after: { path: "palm-reading-v2" }, context: { affected_members: 1 },
    });

    // Both paths stay granted either way: re-pathing back changes nothing a member sees.
    expect(await bumps(h, () => repath(h, manager, palm, "palm-reading"))).toEqual(ZERO);
    expect(await statuses()).toEqual([["palm-reading", "active", "registry_seed"], ["palm-reading-v2", "retired", "registry"]]);
    expect(await retiredAt("palm-reading")).toBe(false);
  });

  it("never re-grants a path an admin revoked from the funnel through a funnel_path edit (security review)", async () => {
    const h = await copyOf(post);
    const { manager, owner } = seed.users;
    const { palm } = seed.funnels;
    const statuses = async () => (await pathRows(h, palm)).map((row) => [row.path, row.status]);
    // palm-reading-v2 becomes the path, palm-reading is retired, then revoked.
    await repath(h, manager, palm, "palm-reading-v2");
    await setStatus(h, owner, await pathId(h, palm, "palm-reading"), "revoked");
    expect(await statuses()).toEqual([["palm-reading", "revoked"], ["palm-reading-v2", "active"]]);
    const audits = (await registryAudit(h)).length;

    // Editing the funnel back to the revoked path is refused as a whole: no
    // re-grant, no bump, the funnel keeps its path.
    expect(await bumps(h, async () => {
      await expect(repath(h, manager, palm, "Palm_Reading")).rejects.toThrow(
        /conflict: path palm-reading was revoked from this funnel; attach it again under Admin -> Funnel coverage first/,
      );
    })).toEqual(ZERO);
    expect(await one(h.db, "(select funnel_path from public.funnels where id = $1)", [palm])).toBe("palm-reading-v2");
    expect(await statuses()).toEqual([["palm-reading", "revoked"], ["palm-reading-v2", "active"]]);
    expect(await scopePaths(h, seed.users.buyerC)).toEqual(["palm-reading-v2"]);
    expect((await registryAudit(h)).length).toBe(audits);

    // The explicit route works: attach (audited, confirmed), then the edit is a plain re-path.
    await attach(h, owner, palm, "palm-reading");
    await repath(h, manager, palm, "palm-reading");
    expect(await statuses()).toEqual([["palm-reading", "active"], ["palm-reading-v2", "retired"]]);
  });

  it("treats a case-only change, or an edit that leaves funnel_path alone, as a no-op", async () => {
    const h = await copyOf(post);
    const { manager } = seed.users;
    const { soulmate } = seed.funnels;
    const snapshot = "select id, status, updated_at from public.funnel_paths order by id";
    const before = (await h.db.query(snapshot)).rows;
    const audits = (await registryAudit(h)).length;

    expect(await bumps(h, () => repath(h, manager, soulmate, "SOULMATE-SKETCH"))).toEqual(ZERO);
    expect(await one(h.db, "(select funnel_path from public.funnels where id = $1)", [soulmate])).toBe("soulmate-sketch");
    expect(await bumps(h, () => h.asUser(manager, (tx) => tx.query("update public.funnels set display_name = 'Soul' where id = $1", [soulmate])))).toEqual(ZERO);
    // A row written before this migration keeps its stored path until it is edited.
    await h.asUser(manager, (tx) => tx.query("update public.funnels set is_active = false where id = $1", [seed.funnels.aUnderscore]));
    expect(await one(h.db, "(select funnel_path from public.funnels where id = $1)", [seed.funnels.aUnderscore])).toBe("a_b");

    expect((await h.db.query(snapshot)).rows).toEqual(before);
    expect((await registryAudit(h)).length).toBe(audits);
  });

  it("replaces the funnels re-path trigger but keeps its function (rollback and lint)", async () => {
    const triggers = await post.db.query<{ tgname: string }>(
      "select tgname from pg_trigger where tgrelid = 'public.funnels'::regclass and not tgisinternal order by tgname",
    );
    expect(triggers.rows.map((row) => row.tgname)).toEqual(["funnels_canonicalize_path", "funnels_set_updated_at", "funnels_sync_paths"]);
    expect(await one(post.db, "to_regprocedure('app.funnel_path_bump_members()')::text")).toBe("app.funnel_path_bump_members()");
  });
});

describe("T7 resolver", () => {
  it("expands a selected scope to the granted paths; my_access and allowed_paths agree", async () => {
    const { users } = seed;
    const expected: Array<[UserKey, string, string[], string[]]> = [
      ["buyerA", "selected", ["soulmate-sketch"], ["soulmate-sketch"]],
      ["buyerAB", "selected", ["past-life", "soulmate-sketch"], ["past-life", "soulmate-sketch"]],
      ["buyerC", "selected", ["palm-reading"], ["palm-reading"]],
      ["none", "none", [], []],
      ["viewer", "all", [], ["*"]],
      ["owner", "all", [], ["*"]],
    ];
    for (const [name, mode, paths, allowed] of expected) {
      const access = await resolve(post, users[name]);
      expect(access.funnel_scope, name).toMatchObject({ mode, paths });
      expect((await myAccess(post, users[name])).funnel_scope, name).toEqual(access.funnel_scope);
      expect(await allowedPaths(post, users[name]), name).toEqual(allowed);
    }
    expect(await allowedPaths(post, users.disabled)).toEqual([]);
    expect(await allowedPaths(post, users.outsider)).toEqual([]);
  });

  it("includes active and retired paths, sorted; never proposed or revoked ones", async () => {
    const h = await copyOf(post);
    const { owner, buyerA } = seed.users;
    const { soulmate } = seed.funnels;
    const agree = async (paths: string[]) => {
      expect(await scopePaths(h, buyerA)).toEqual(paths);
      expect(((await myAccess(h, buyerA)).funnel_scope as { paths: string[] }).paths).toEqual(paths);
      expect(await allowedPaths(h, buyerA)).toEqual(paths);
    };
    await agree(["soulmate-sketch"]); // the alias proposal is not granted

    const old = await attach(h, owner, soulmate, "soulmate-old");
    await agree(["soulmate-old", "soulmate-sketch"]);
    await setStatus(h, owner, String(old.path.id), "retired");
    await agree(["soulmate-old", "soulmate-sketch"]);
    await setStatus(h, owner, String(old.path.id), "revoked");
    await agree(["soulmate-sketch"]);
    await setStatus(h, owner, await pathId(h, soulmate, ALIAS), "active");
    await agree([ALIAS, "soulmate-sketch"]);
  });

  it("gives a collision funnel no path until its proposal is confirmed", async () => {
    const h = await copyOf(post);
    const scope = (funnel: string) => one<string[]>(h.db, "app.funnel_scope_paths(array[$1]::uuid[])", [funnel]);
    expect(await scope(seed.funnels.aDash)).toEqual([]);
    await setStatus(h, seed.users.owner, await pathId(h, seed.funnels.aDash, "a-b"), "active");
    expect(await scope(seed.funnels.aDash)).toEqual(["a-b"]);
    expect(await scope(seed.funnels.aUnderscore)).toEqual([]);
    expect(await one(h.db, "app.funnel_scope_paths(null)")).toEqual([]);
  });
});

describe("T8 access_version bumps", () => {
  it("move exactly when a funnel's granted path set changes, for the members holding it", async () => {
    const h = await copyOf(post);
    const { owner, manager, buyerA } = seed.users;
    const { soulmate, palm } = seed.funnels;
    const partition = async () => (await resolve(h, buyerA)).partition;

    const partition0 = await partition();
    let old!: MutationResult;
    expect(await bumps(h, async () => { old = await attach(h, owner, soulmate, "soulmate-old"); })).toEqual(SOULMATE_HOLDERS);
    const partition1 = await partition();
    expect(partition1).not.toBe(partition0);
    const oldId = String(old.path.id);

    expect(await bumps(h, () => setStatus(h, owner, oldId, "retired"))).toEqual(ZERO);
    expect(await bumps(h, () => setStatus(h, owner, oldId, "active"))).toEqual(ZERO);
    expect(await partition()).toBe(partition1);
    expect(await bumps(h, () => setStatus(h, owner, oldId, "revoked"))).toEqual(SOULMATE_HOLDERS);
    expect(await bumps(h, () => attach(h, owner, soulmate, "soulmate-old"))).toEqual(SOULMATE_HOLDERS);
    expect(await bumps(h, () => attach(h, owner, soulmate, "soulmate-old"))).toEqual(ZERO); // idempotent

    expect(await bumps(h, () => setStatus(h, owner, String(old.path.id), "active", "same status"))).toEqual(ZERO);
    const alias = await pathId(h, soulmate, ALIAS);
    expect(await bumps(h, () => setStatus(h, owner, alias, "active"))).toEqual(SOULMATE_HOLDERS);
    expect(await bumps(h, () => h.db.query("update public.funnel_paths set note = 'note only' where funnel_id = $1", [soulmate]))).toEqual(ZERO);

    let idea!: string;
    expect(
      await bumps(h, async () => {
        idea = await insertId(h, "insert into public.funnel_paths (funnel_id, path_canonical, status, source) values ($1, 'palm-idea', 'proposed', 'admin_alias')", [palm]);
      }),
    ).toEqual(ZERO);
    expect(await bumps(h, () => setStatus(h, owner, idea, "revoked"))).toEqual(ZERO);

    // A re-path through the registry: exactly +1, for the funnel's holders only.
    expect(await bumps(h, () => h.asUser(manager, (tx) => tx.query("update public.funnels set funnel_path = 'palm-v3' where id = $1", [palm])))).toEqual({
      ...ZERO,
      buyerC: 1,
    });
  });
});

describe("T9 registry reads", () => {
  let h: SupabasePglite;
  const ids = (rows: Array<{ id: string }>) => rows.map((row) => row.id).sort();

  // soulmate: soulmate-sketch active, soulmate-old retired, soulmate-gone revoked, the alias proposed.
  async function scoped(): Promise<SupabasePglite> {
    const copy = await copyOf(post);
    const { owner } = seed.users;
    const old = await attach(copy, owner, seed.funnels.soulmate, "soulmate-old");
    await setStatus(copy, owner, String(old.path.id), "retired");
    const gone = await attach(copy, owner, seed.funnels.soulmate, "soulmate-gone");
    await setStatus(copy, owner, String(gone.path.id), "revoked");
    return copy;
  }

  const read = (user: string, sql: string) => h.asUser(user, async (tx) => (await tx.query<Json>(sql)).rows);

  it("shows a restricted member its own funnels, their tags and their granted paths only", async () => {
    h = await scoped();
    const { buyerA, buyerAB, buyerC } = seed.users;
    const { funnels, tags } = seed;

    expect(ids((await read(buyerA, "select id::text from public.funnels")) as Array<{ id: string }>)).toEqual([funnels.soulmate]);
    expect(ids((await read(buyerAB, "select id::text from public.funnels")) as Array<{ id: string }>)).toEqual([funnels.soulmate, funnels.pastLife].sort());
    expect(ids((await read(buyerC, "select id::text from public.funnels")) as Array<{ id: string }>)).toEqual([funnels.palm]);

    expect(ids((await read(buyerA, "select id::text from public.tags")) as Array<{ id: string }>)).toEqual([tags.evergreen, tags.shared].sort());
    expect(ids((await read(buyerAB, "select id::text from public.tags")) as Array<{ id: string }>)).toEqual([tags.evergreen, tags.shared].sort());
    expect(ids((await read(buyerC, "select id::text from public.tags")) as Array<{ id: string }>)).toEqual([tags.palmistry, tags.shared].sort());
    expect(await read(buyerA, "select funnel_id::text, tag_id::text from public.funnel_tags order by tag_id")).toEqual(
      [tags.evergreen, tags.shared].sort().map((tag) => ({ funnel_id: funnels.soulmate, tag_id: tag })),
    );

    expect(await read(buyerA, "select path_canonical, status from public.funnel_paths order by path_canonical")).toEqual([
      { path_canonical: "soulmate-old", status: "retired" },
      { path_canonical: "soulmate-sketch", status: "active" },
    ]);
    expect(await read(buyerC, "select path_canonical from public.funnel_paths")).toEqual([{ path_canonical: "palm-reading" }]);
    // Asking for another funnel by id is an empty result, not an error.
    expect(await read(buyerA, `select id from public.funnels where id = '${funnels.palm}'`)).toEqual([]);
    expect(await read(buyerA, `select id from public.funnel_paths where funnel_id = '${funnels.palm}'`)).toEqual([]);
  });

  it("answers the Funnels page embed with funnel A only", async () => {
    h = await scoped();
    const embed = `
      select f.funnel_path,
             (select coalesce(json_agg(json_build_object('path', p.path_canonical, 'status', p.status) order by p.path_canonical), '[]'::json)
                from public.funnel_paths p where p.funnel_id = f.id) as funnel_paths,
             (select coalesce(json_agg(t.name order by t.name), '[]'::json)
                from public.funnel_tags ft join public.tags t on t.id = ft.tag_id where ft.funnel_id = f.id) as tags
      from public.funnels f order by f.funnel_path`;
    expect(await read(seed.users.buyerA, embed)).toEqual([
      {
        funnel_path: "/Soulmate-Sketch",
        funnel_paths: [{ path: "soulmate-old", status: "retired" }, { path: "soulmate-sketch", status: "active" }],
        tags: ["evergreen", "shared"],
      },
    ]);
  });

  it("shows scope-all members everything, proposals and revoked paths included", async () => {
    h = await scoped();
    const total = await one<number>(h.db, "(select count(*)::int from public.funnel_paths)");
    expect(total).toBe(8);
    for (const user of [seed.users.viewer, seed.users.manager, seed.users.owner]) {
      expect(await countAs(h, user, "funnels"), user).toBe(6);
      expect(await countAs(h, user, "tags"), user).toBe(4);
      expect(await countAs(h, user, "funnel_tags"), user).toBe(4);
      expect(await countAs(h, user, "funnel_paths"), user).toBe(total);
    }
  });

  it("shows none-scope, disabled and non-members nothing; anon may not read funnel_paths at all", async () => {
    h = await scoped();
    for (const user of [seed.users.none, seed.users.disabled, seed.users.outsider]) {
      for (const table of ["funnels", "tags", "funnel_tags", "funnel_paths"]) {
        expect(await countAs(h, user, table), `${user} ${table}`).toBe(0);
      }
    }
    await expect(h.asAnon((tx) => tx.query("select count(*) from public.funnel_paths"))).rejects.toThrow(/permission denied for table funnel_paths/);
    expect(await h.asAnon((tx) => one<number>(tx, "(select count(*)::int from public.funnels)"))).toBe(0);
  });

  it("serves the browser the page's columns only: admin notes and user ids stay with the service role (security review)", async () => {
    h = await scoped();
    const { buyerA, owner, viewer } = seed.users;
    // What the Funnels page embed and the FunnelFox import pre-filter read.
    expect(await read(buyerA, "select id::text is not null as id, funnel_id::text as funnel_id, path_canonical, status, retired_at is not null as retired from public.funnel_paths order by path_canonical")).toEqual([
      { id: true, funnel_id: seed.funnels.soulmate, path_canonical: "soulmate-old", status: "retired", retired: true },
      { id: true, funnel_id: seed.funnels.soulmate, path_canonical: "soulmate-sketch", status: "active", retired: false },
    ]);
    // Admin metadata is refused even to the data owner through PostgREST (the
    // admin API reads it as service_role); so is `select *`.
    for (const user of [buyerA, viewer, owner]) {
      for (const column of ["note", "source", "funnelfox_funnel_id", "created_by", "confirmed_by", "revoked_by", "confirmed_at", "revoked_at", "*"]) {
        await expect(h.asUser(user, (tx) => tx.query(`select ${column} from public.funnel_paths`)), `${user} ${column}`).rejects.toThrow(
          /permission denied for table funnel_paths/,
        );
      }
    }
    expect(await h.asService((tx) => one<number>(tx, "(select count(note)::int from public.funnel_paths)"))).toBe(8);
  });
});

describe("T10 registry writes", () => {
  it("has no browser or service-role write path on funnel_paths, the owner included", async () => {
    const h = await copyOf(post);
    const { owner, manager } = seed.users;
    const id = await pathId(h, seed.funnels.soulmate, "soulmate-sketch");
    const writes = [
      `insert into public.funnel_paths (funnel_id, path_canonical, status, source) values ('${seed.funnels.palm}', 'forged', 'proposed', 'admin_alias')`,
      `update public.funnel_paths set status = 'revoked' where id = ${id}`,
      `delete from public.funnel_paths where id = ${id}`,
      "truncate public.funnel_paths",
    ];
    for (const sql of writes) {
      for (const user of [owner, manager]) {
        await expect(h.asUser(user, (tx) => tx.query(sql)), `${user}: ${sql}`).rejects.toThrow(/permission denied for table funnel_paths/);
      }
      await expect(h.asAnon((tx) => tx.query(sql)), sql).rejects.toThrow(/permission denied for table funnel_paths/);
      await expect(h.asService((tx) => tx.query(sql)), sql).rejects.toThrow(/permission denied for table funnel_paths/);
    }
    expect(await h.asService((tx) => one<number>(tx, "(select count(*)::int from public.funnel_paths)"))).toBe(6);

    const grants = await one<Json>(
      h.db,
      `json_build_object(
         'auth_select', has_table_privilege('authenticated', 'public.funnel_paths', 'SELECT'),
         'auth_columns', (select array_agg(a.attname::text order by a.attnum) from pg_attribute a
                          where a.attrelid = 'public.funnel_paths'::regclass and a.attnum > 0 and not a.attisdropped
                            and has_column_privilege('authenticated', 'public.funnel_paths', a.attname, 'SELECT')),
         'auth_column_write', has_any_column_privilege('authenticated', 'public.funnel_paths', 'INSERT, UPDATE, REFERENCES'),
         'auth_write', has_table_privilege('authenticated', 'public.funnel_paths', 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
         'anon_any', has_table_privilege('anon', 'public.funnel_paths', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE'),
         'service_select', has_table_privilege('service_role', 'public.funnel_paths', 'SELECT'),
         'service_write', has_table_privilege('service_role', 'public.funnel_paths', 'INSERT, UPDATE, DELETE, TRUNCATE'),
         'sequence', has_sequence_privilege('authenticated', 'public.funnel_paths_id_seq', 'USAGE, SELECT, UPDATE')
                     or has_sequence_privilege('service_role', 'public.funnel_paths_id_seq', 'USAGE, SELECT, UPDATE'))`,
    );
    expect(grants).toEqual({
      // Column grants only: the page's columns, never the admin metadata.
      auth_select: false,
      auth_columns: ["id", "funnel_id", "path_canonical", "status", "retired_at"],
      auth_column_write: false,
      auth_write: false,
      anon_any: false,
      service_select: true,
      service_write: false,
      sequence: false,
    });
    expect(await pathRows(h)).toEqual(await pathRows(post));
  });

  it("keeps the registry closed to members without funnels.manage", async () => {
    const h = await copyOf(post);
    const { buyerA, viewer } = seed.users;
    for (const [user, policy] of [[buyerA, "lockdown_registry_insert"], [viewer, "lockdown_registry_insert"]]) {
      await expect(h.asUser(user, (tx) => tx.query("insert into public.funnels (funnel_path) values ('forged-funnel')"))).rejects.toThrow(
        `violates row-level security policy "${policy}" for table "funnels"`,
      );
      const renamed = await h.asUser(user, (tx) => tx.query("update public.funnels set funnel_path = 'forged-path', display_name = 'Forged'"));
      expect(renamed.affectedRows, user).toBe(0);
      await expect(h.asUser(user, (tx) => tx.query("select public.replace_funnel_tags($1, '{}'::uuid[])", [seed.funnels.soulmate]))).rejects.toThrow(
        /permission_denied: funnels\.manage with funnel scope all is required/,
      );
      await expect(
        h.asUser(user, (tx) => tx.query("insert into public.funnel_tags (funnel_id, tag_id) values ($1, $2)", [seed.funnels.soulmate, seed.tags.orphan])),
      ).rejects.toThrow(/row-level security policy/);
    }
    expect(await pathRows(h)).toEqual(await pathRows(post));
  });
});

describe("T11 path RPCs", () => {
  const PERMISSION = /^permission_denied: funnels\.manage is required/;

  it("attaches a path as an audited admin alias, idempotently", async () => {
    const h = await copyOf(post);
    const { manager } = seed.users;
    const { soulmate } = seed.funnels;
    const first = await attach(h, manager, soulmate, "soulmate-old", "  renamed in Ads Manager ");
    expect(first).toMatchObject({
      ok: true, changed: true, affected_members: 2,
      path: {
        funnel_id: soulmate, path_canonical: "soulmate-old", status: "active", source: "admin_alias", note: "renamed in Ads Manager",
        created_by: manager, confirmed_by: manager, funnelfox_funnel_id: null, retired_at: null, revoked_at: null,
      },
    });
    expect(typeof first.path.confirmed_at).toBe("string");
    const again = await attach(h, manager, soulmate, " soulmate-old ");
    expect(again).toMatchObject({ ok: true, changed: false, affected_members: 2, path: { id: first.path.id, status: "active" } });
    expect((await registryAudit(h)).slice(1)).toEqual([
      {
        event: "registry.path_attached", actor_kind: "user", actor_user_id: manager, actor_member_id: seed.members.manager,
        target_type: "funnel", target_id: soulmate, before: null, after: first.path,
        context: { path_id: first.path.id, path: "soulmate-old" },
      },
    ]);
    expect((await attach(h, manager, seed.funnels.palm, "palm-old")).affected_members).toBe(1);
  });

  it("refuses malformed paths, unknown funnels and paths of another funnel", async () => {
    const h = await copyOf(post);
    const { owner } = seed.users;
    const { soulmate } = seed.funnels;
    for (const path of ["Soulmate-Old", "/soulmate-old", "soulmate_old", "a--b", "unknown", "", "   ", "a".repeat(201)]) {
      await expect(attach(h, owner, soulmate, path), JSON.stringify(path)).rejects.toThrow(/^invalid: path must be a canonical campaign path/);
    }
    await expect(attach(h, owner, soulmate, "soulmate-old", "n".repeat(501))).rejects.toThrow(/^invalid: note must be at most 500 characters/);
    await expect(attach(h, owner, "00000000-0000-4000-8000-000000000000", "soulmate-old")).rejects.toThrow(/^not_found: funnel not found/);
    await expect(attach(h, owner, null, "soulmate-old")).rejects.toThrow(/^not_found: funnel not found/);
    await expect(attach(h, owner, soulmate, "palm-reading")).rejects.toThrow(/^conflict: path is already part of another funnel; revoke it there first/);
    expect(await pathRows(h)).toEqual(await pathRows(post));
  });

  it("requires an active member holding funnels.manage, for both RPCs", async () => {
    const h = await copyOf(post);
    const { users, funnels } = seed;
    const id = await pathId(h, funnels.soulmate, ALIAS);
    for (const actor of [users.buyerA, users.viewer, users.none]) {
      await expect(attach(h, actor, funnels.soulmate, "soulmate-old"), actor).rejects.toThrow(PERMISSION);
      await expect(setStatus(h, actor, id, "active"), actor).rejects.toThrow(PERMISSION);
    }
    for (const actor of [users.disabled, users.outsider]) {
      await expect(attach(h, actor, funnels.soulmate, "soulmate-old")).rejects.toThrow(/^permission_denied: the actor is not an active member/);
      await expect(setStatus(h, actor, id, "active")).rejects.toThrow(/^permission_denied: the actor is not an active member/);
    }
    await expect(attach(h, null, funnels.soulmate, "soulmate-old")).rejects.toThrow(/^permission_denied: an actor is required/);
    expect(await pathRows(h)).toEqual(await pathRows(post));
    expect(await registryAudit(h)).toHaveLength(1);
  });

  it("walks every allowed status transition, audited, and refuses the others", async () => {
    const h = await copyOf(post);
    const { owner } = seed.users;
    const { soulmate, palm } = seed.funnels;
    const alias = await pathId(h, soulmate, ALIAS);

    const confirmed = await setStatus(h, owner, alias, "active", "same funnel, renamed");
    expect(confirmed).toMatchObject({ changed: true, affected_members: 2, path: { status: "active", confirmed_by: owner, note: "same funnel, renamed" } });
    expect(await setStatus(h, owner, alias, "active")).toMatchObject({ changed: false, path: { status: "active" } });
    const retired = await setStatus(h, owner, alias, " Retired ");
    expect(retired.path).toMatchObject({ status: "retired" });
    expect(typeof retired.path.retired_at).toBe("string");
    expect((await setStatus(h, owner, alias, "active")).path).toMatchObject({ status: "active", retired_at: null });
    const revoked = await setStatus(h, owner, alias, "revoked");
    expect(revoked.path).toMatchObject({ status: "revoked", revoked_by: owner });
    for (const status of ["active", "retired"]) {
      await expect(setStatus(h, owner, alias, status)).rejects.toThrow(new RegExp(`^invalid: a revoked path cannot become ${status}`));
    }
    // attach re-grants a revoked path (same row).
    expect(await attach(h, owner, soulmate, ALIAS)).toMatchObject({
      changed: true, path: { id: Number(alias), status: "active", revoked_by: null, revoked_at: null, source: "funnelfox_alias_seed" },
    });

    const idea = await insertId(h, "insert into public.funnel_paths (funnel_id, path_canonical, status, source) values ($1, 'palm-idea', 'proposed', 'admin_alias')", [palm]);
    await expect(setStatus(h, owner, idea, "retired")).rejects.toThrow(/^invalid: a proposed path cannot become retired/);
    expect((await setStatus(h, owner, idea, "revoked")).path).toMatchObject({ status: "revoked", revoked_by: owner, confirmed_at: null });
    for (const status of ["proposed", "bogus", ""]) {
      await expect(setStatus(h, owner, idea, status)).rejects.toThrow(/^invalid: status must be active, retired or revoked/);
    }
    await expect(setStatus(h, owner, "999999", "active")).rejects.toThrow(/^not_found: funnel path not found/);

    const events = (await registryAudit(h)).slice(1).map((row) => [row.event, row.target_id, (row.context as { path: string }).path]);
    expect(events).toEqual([
      ["registry.path_confirmed", soulmate, ALIAS],
      ["registry.path_retired", soulmate, ALIAS],
      ["registry.path_reactivated", soulmate, ALIAS],
      ["registry.path_revoked", soulmate, ALIAS],
      ["registry.path_attached", soulmate, ALIAS],
      ["registry.path_rejected", palm, "palm-idea"],
    ]);
    const revokedAudit = (await registryAudit(h)).find((row) => row.event === "registry.path_revoked")!;
    expect(revokedAudit).toMatchObject({ actor_kind: "user", actor_user_id: owner, actor_member_id: seed.members.owner, before: { status: "active" }, after: { status: "revoked" } });
  });

  it("settles a collision: one proposal is confirmed, the other conflicts", async () => {
    const h = await copyOf(post);
    const { owner } = seed.users;
    expect((await setStatus(h, owner, await pathId(h, seed.funnels.aDash, "a-b"), "active")).path).toMatchObject({ status: "active" });
    const other = await pathId(h, seed.funnels.aUnderscore, "a-b");
    await expect(setStatus(h, owner, other, "active")).rejects.toThrow(/^conflict: path is already part of another funnel/);
    // It is still that funnel's own path: editing the funnel's path settles it.
    await expect(setStatus(h, owner, other, "revoked")).rejects.toThrow(/^invalid: this is the funnel path itself: edit the funnel path instead/);
  });

  it("never retires or revokes a funnel's own path", async () => {
    const h = await copyOf(post);
    const own = await pathId(h, seed.funnels.soulmate, "soulmate-sketch"); // stored as '/Soulmate-Sketch'
    for (const status of ["retired", "revoked"]) {
      await expect(setStatus(h, seed.users.owner, own, status)).rejects.toThrow(/^invalid: this is the funnel path itself: edit the funnel path instead/);
    }
    expect(await setStatus(h, seed.users.owner, own, "active")).toMatchObject({ changed: false });
  });

  it("are callable by service_role only", async () => {
    for (const signature of ["public.access_attach_funnel_path(uuid, uuid, text, text)", "public.access_set_funnel_path_status(uuid, bigint, text, text)"]) {
      expect(await privileges(post, signature), signature).toEqual({ anon: false, authenticated: false, service: true, public: false });
    }
    await expect(
      post.asUser(seed.users.owner, (tx) => tx.query(`select ${ATTACH}`, [seed.users.owner, seed.funnels.soulmate, "soulmate-old", null])),
    ).rejects.toThrow(/permission denied for function access_attach_funnel_path/);
  });
});

describe("T12 cohort snapshot state", () => {
  const OWNER_STATE = `(select json_build_object(
      'status', status, 'active_warehouse_version', active_warehouse_version, 'active_validation', active_validation,
      'active_validated_at', (extract(epoch from active_validated_at) * 1000)::bigint,
      'active_campaign_scope_version', active_campaign_scope_version,
      'fresh', fresh_verified_at is not null, 'stale', stale_since is not null)
    from public.clickhouse_cohort_snapshot_state where auth_user_id = $1)`;
  const BACKFILLED_AT = Date.parse("2026-10-01T00:00:00Z");
  const FINISHED_AT = Date.parse("2026-10-06T00:00:00Z");
  const state = (h: SupabasePglite, user = seed.users.owner) => one<Json | null>(h.db, OWNER_STATE, [user]);
  const claim = (h: SupabasePglite, token: string, wh: string) =>
    svc<boolean>(h, "public.claim_clickhouse_cohort_snapshot_build($1, $2, $3, 'cv_1', now(), 300, 10, 5, '{}'::jsonb)", [seed.users.owner, token, wh]);
  const complete = (h: SupabasePglite, token: string, wh: string, diagnostics: Json) =>
    svc<boolean>(
      h,
      "public.complete_clickhouse_cohort_snapshot_build($1, $2, $3, 'cv_1', now(), '2026-10-06T00:00:00Z', 1200, 5, 5, 0, 0, 10, 5, $4::jsonb)",
      [seed.users.owner, token, wh, JSON.stringify(diagnostics)],
    );
  const PASS = { status: "PASS", duplicate_users: 0 };
  const TOKENS = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"];

  it("backfills the active validation of a completed snapshot only", async () => {
    expect(await state(post)).toEqual({
      status: "completed", active_warehouse_version: "wh_1", active_validation: PASS, active_validated_at: BACKFILLED_AT,
      active_campaign_scope_version: null, fresh: false, stale: false,
    });
    expect(await state(post, seed.users.outsider)).toMatchObject({ status: "failed", active_validation: null });
  });

  it("completes a build into the active_* columns; claiming or failing the next one leaves them alone", async () => {
    const h = await copyOf(post);
    expect(await claim(h, TOKENS[0], "wh_2")).toBe(true);
    expect(await complete(h, TOKENS[0], "wh_2", { validation: PASS, campaign_scope: { status: "PASS", version: "campaign_scope_v1" } })).toBe(true);
    const completed = {
      status: "completed", active_warehouse_version: "wh_2", active_validation: PASS, active_validated_at: FINISHED_AT,
      active_campaign_scope_version: "campaign_scope_v1", fresh: true, stale: false,
    };
    expect(await state(h)).toEqual(completed);
    const freshAt = await one<string>(h.db, "(select fresh_verified_at::text from public.clickhouse_cohort_snapshot_state where auth_user_id = $1)", [seed.users.owner]);

    expect(await claim(h, TOKENS[1], "wh_3")).toBe(true);
    expect(await state(h)).toEqual({ ...completed, status: "building" });
    expect(await svc<boolean>(h, "public.fail_clickhouse_cohort_snapshot_build($1, $2, now(), 10, 'boom', '{\"validation\": {\"status\": \"FAIL\"}}'::jsonb)", [seed.users.owner, TOKENS[1]])).toBe(true);
    expect(await state(h)).toEqual({ ...completed, status: "failed" });
    expect(await one(h.db, "(select fresh_verified_at::text from public.clickhouse_cohort_snapshot_state where auth_user_id = $1)", [seed.users.owner])).toBe(freshAt);

    // A failed campaign scope (or none) leaves the version empty.
    expect(await claim(h, TOKENS[2], "wh_4")).toBe(true);
    expect(await complete(h, TOKENS[1], "wh_4", { validation: PASS })).toBe(false); // stale token
    expect(await complete(h, TOKENS[2], "wh_4", { validation: PASS, campaign_scope: { status: "FAIL", version: "campaign_scope_v1" } })).toBe(true);
    expect(await state(h)).toMatchObject({ active_warehouse_version: "wh_4", active_campaign_scope_version: null });
    expect(await claim(h, TOKENS[0], "wh_5")).toBe(true);
    expect(await complete(h, TOKENS[0], "wh_5", { validation: { status: "FAIL" } })).toBe(true);
    expect(await state(h)).toMatchObject({ active_validation: { status: "FAIL" }, active_campaign_scope_version: null });
  });

  it("observes the warehouse fingerprint: current -> fresh, changed -> stale since the first mismatch", async () => {
    const h = await copyOf(post);
    const observe = (user: string, wh: string, cv = "cv_1") =>
      svc<boolean>(h, "public.observe_clickhouse_cohort_snapshot_fingerprint($1, $2, $3)", [user, wh, cv]);
    const staleSince = () => one<string | null>(h.db, "(select stale_since::text from public.clickhouse_cohort_snapshot_state where auth_user_id = $1)", [seed.users.owner]);
    const { owner } = seed.users;

    expect(await observe(owner, "wh_1")).toBe(true);
    expect(await state(h)).toMatchObject({ fresh: true, stale: false });
    expect(await observe(owner, "wh_9")).toBe(false);
    const since = await staleSince();
    expect(since).not.toBeNull();
    expect(await observe(owner, "wh_1", "cv_2")).toBe(false);
    expect(await staleSince()).toBe(since);
    expect(await observe(owner, "wh_1")).toBe(true);
    expect(await state(h)).toMatchObject({ fresh: true, stale: false });

    expect(await observe(seed.users.manager, "wh_1")).toBe(false); // no state row
    expect(await one(h.db, "(select count(*)::int from public.clickhouse_cohort_snapshot_state where auth_user_id = $1)", [seed.users.manager])).toBe(0);
  });

  it("records the campaign scope version only for the snapshot that is still active", async () => {
    const h = await copyOf(post);
    const set = (wh: string, cv: string) =>
      svc<boolean>(h, "public.set_clickhouse_campaign_scope_version($1, $2, $3, 'campaign_scope_v1')", [seed.users.owner, wh, cv]);
    expect(await set("wh_0", "cv_1")).toBe(false);
    expect(await set("wh_1", "cv_0")).toBe(false);
    expect(await state(h)).toMatchObject({ active_campaign_scope_version: null });
    expect(await set("wh_1", "cv_1")).toBe(true);
    expect(await state(h)).toMatchObject({ active_campaign_scope_version: "campaign_scope_v1" });
  });

  it("are callable by service_role only", async () => {
    for (const signature of [
      "public.complete_clickhouse_cohort_snapshot_build(uuid, uuid, text, text, timestamptz, timestamptz, integer, bigint, bigint, bigint, bigint, bigint, bigint, jsonb)",
      "public.observe_clickhouse_cohort_snapshot_fingerprint(uuid, text, text)",
      "public.set_clickhouse_campaign_scope_version(uuid, text, text, text)",
    ]) {
      expect(await privileges(post, signature), signature).toEqual({ anon: false, authenticated: false, service: true, public: false });
    }
  });
});

describe("T13 canonicalizer parity with palmerTransform rule A", () => {
  // Rule A as the warehouse applies it: palmerTransform's normalizeCampaignPath,
  // reached through the public normalizePalmerRows (direct ff_campaign_path
  // column, no initialUrl fallback). Not mirrored in SQL, so not listed here:
  // what `new URL()` adds for http(s) values (percent-encoding, dot segments,
  // invalid hosts), Unicode case folding to ASCII (U+0130, U+212A) and
  // non-ASCII whitespace before a scheme.
  const ruleA = (raw: string) => normalizePalmerRows([{ ff_campaign_path: raw }])[0].campaign_path;
  const VECTORS = [
    "soulmate-sketch", "/Soulmate-Sketch", "/soulmate-sketch/", "  /Soulmate-Sketch  ", "\t/past-life\r\n", "Soulmate Sketch!",
    "a_b", "a--b", "-a-", "A__B__C", "/a/b/c", "//double//slash//", "?query-only", "path?x=1&y=2", "path#frag", "path#frag?x=1",
    "path?x=1#frag", "#only", "https://example.com/Soulmate-Sketch?utm_source=fb#top", "http://example.com/a/b/",
    "HTTPS://EXAMPLE.COM/PATH", "https://example.com", "https://example.com/", "https://example.com:8443/x", "https://user@example.com/x",
    "https://example.com/a?b=/c", "http://", "https:/broken", "ftp://example.com/x", "example.com/landing", "\"/soulmate-reading\"",
    "'/soulmate-reading'", "unknown", "UNKNOWN", "/unknown/", "", "   ", "---", "///", "тест", "Straße", "CAFÉ-1", "123",
    "funnel.v2", "a".repeat(200), "a".repeat(201), `/${"a".repeat(200)}/`, `${"a-".repeat(100)}b`, `https://example.com/${"b".repeat(199)}`,
  ];

  it("returns rule A's path, or null where rule A says 'unknown' or the path exceeds 200 characters", async () => {
    for (const raw of VECTORS) {
      const js = ruleA(raw);
      const sql = await one<string | null>(post.db, "app.canonical_campaign_path($1)", [raw]);
      expect(sql, JSON.stringify(raw)).toBe(js === "unknown" || js.length > 200 ? null : js);
    }
    expect(await one(post.db, "app.canonical_campaign_path(null)")).toBeNull();
  });

  it("only ever returns values the funnel_paths CHECK accepts", async () => {
    const result = await post.db.query<{ v: string }>("select app.canonical_campaign_path(v) as v from unnest($1::text[]) v", [VECTORS]);
    for (const { v } of result.rows) {
      if (v !== null) expect(v).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });
});

describe("T14 policy shape and function grants", () => {
  it("scopes registry reads with RESTRICTIVE policies for authenticated, in the initPlan form", async () => {
    const policies = await post.db.query<{ table: string; polname: string; permissive: boolean; cmd: string; roles: string[]; qual: string | null; check: string | null }>(
      `select c.relname as table, p.polname, p.polpermissive as permissive, p.polcmd::text as cmd,
              array(select r.rolname::text from pg_roles r where r.oid = any (p.polroles) order by 1) as roles,
              pg_get_expr(p.polqual, p.polrelid) as qual, pg_get_expr(p.polwithcheck, p.polrelid) as check
       from pg_policy p join pg_class c on c.oid = p.polrelid
       where c.relname in ('funnels', 'tags', 'funnel_tags', 'funnel_paths')
       order by 1, 2`,
    );
    const scopeRows = policies.rows.filter((row) => row.polname === "lockdown_registry_scope");
    expect(scopeRows.map((row) => [row.table, row.permissive, row.cmd])).toEqual([
      ["funnel_tags", false, "r"],
      ["funnels", false, "r"],
      ["tags", false, "r"],
    ]);
    expect(policies.rows.filter((row) => row.table === "funnel_paths").map((row) => [row.polname, row.permissive, row.cmd])).toEqual([
      ["Members read the paths of visible funnels", true, "r"],
      ["lockdown_active_member", false, "*"],
    ]);
    for (const policy of [...scopeRows, ...policies.rows.filter((row) => row.table === "funnel_paths")]) {
      expect(policy.roles, `${policy.table}.${policy.polname}`).toEqual(["authenticated"]);
      for (const expression of [policy.qual, policy.check]) {
        if (!expression) continue;
        const calls = expression.match(/app\.\w+\(/g) ?? [];
        const wrapped = expression.match(/SELECT app\.\w+\(/g) ?? [];
        expect(calls.length, `${policy.table}.${policy.polname}: ${expression}`).toBeGreaterThan(0);
        expect(wrapped.length, `${policy.table}.${policy.polname}: ${expression}`).toBe(calls.length);
      }
    }
  });

  it("keeps every new app.* function out of reach, except the RLS helper for authenticated", async () => {
    for (const signature of [
      "app.canonical_campaign_path(text)", "app.funnel_paths_guard()", "app.funnels_canonicalize_path()", "app.funnels_sync_paths()",
      "app.funnel_paths_bump_members()", "app.funnel_scope_paths(uuid[])", "app.funnel_path_affected_members(uuid)",
    ]) {
      expect(await privileges(post, signature), signature).toEqual({ anon: false, authenticated: false, service: false, public: false });
    }
    expect(await privileges(post, "app.my_funnel_ids()")).toEqual({ anon: false, authenticated: true, service: false, public: false });
    // The replaced helpers keep their 202610050002 grants.
    expect(await privileges(post, "app.allowed_paths()")).toEqual({ anon: false, authenticated: true, service: false, public: false });
    expect(await privileges(post, "app.resolve_access_core(uuid, boolean)")).toEqual({ anon: false, authenticated: false, service: false, public: false });
  });

  it("pins search_path on every function the migrations define", () => {
    for (const migration of [PHASE2, CRON]) {
      const sql = readMigration(migration);
      const headers = [...sql.matchAll(/create\s+or\s+replace\s+function\s+([a-z_.0-9]+)\s*\(([\s\S]*?)\bas\s+\$\$/gi)];
      expect(headers.length, migration).toBeGreaterThan(0);
      for (const header of headers) expect(header[0], header[1]).toMatch(/set search_path = ''/);
    }
  });
});

describe("T15 cohort membership freshness cron", () => {
  const requests = (h: SupabasePglite) =>
    h.db.query<{ url: string; headers: Json; body: Json; timeout_milliseconds: number }>(
      "select url, headers, body, timeout_milliseconds from net.stub_requests order by id",
    ).then((result) => result.rows);
  const tick = (h: SupabasePglite, force?: boolean) =>
    one<number | null>(h.db, force === undefined ? "public.invoke_cohort_membership_tick()" : "public.invoke_cohort_membership_tick($1)", force === undefined ? [] : [force]);

  it("schedules the tick every 15 minutes as postgres", async () => {
    expect(await one(full.db, "(select json_build_object('schedule', schedule, 'command', command, 'username', username) from cron.job where jobname = 'cohort-membership-freshness')")).toEqual({
      schedule: "7,22,37,52 * * * *",
      command: "select public.invoke_cohort_membership_tick(false)",
      username: "postgres",
    });
  });

  it("posts cron_tick for the workspace data key while a restricted member exists", async () => {
    const h = await copyOf(full);
    expect(await tick(h)).not.toBeNull();
    const expected = {
      url: "https://project.supabase.co/functions/v1/clickhouse-cohort-membership",
      headers: { "Content-Type": "application/json", "x-cron-secret": "cron-secret", Authorization: "Bearer anon-jwt", apikey: "anon-jwt" },
      body: { auth_user_id: seed.users.owner, action: "cron_tick" },
      timeout_milliseconds: 150000,
    };
    expect(await requests(h)).toEqual([expected]);
    // The body names the workspace data key, never fb_cron_config.auth_user_id.
    await h.db.query("update public.fb_cron_config set auth_user_id = $1", [seed.users.outsider]);
    await tick(h, false);
    expect((await requests(h)).at(-1)!.body).toEqual(expected.body);
  });

  it("skips without restricted members unless forced", async () => {
    const h = await copyOf(full);
    const restricted = [seed.members.buyerA, seed.members.buyerAB, seed.members.buyerC, seed.members.none];
    await h.db.query("update public.workspace_members set status = 'disabled' where id = any ($1::uuid[])", [restricted]);
    expect(await tick(h)).toBeNull();
    expect(await tick(h, false)).toBeNull();
    expect(await requests(h)).toEqual([]);
    expect(await tick(h, true)).not.toBeNull();
    expect((await requests(h)).map((row) => [row.url, row.body])).toEqual([
      ["https://project.supabase.co/functions/v1/clickhouse-cohort-membership", { auth_user_id: seed.users.owner, action: "cron_tick" }],
    ]);
    // A member with no scope rule at all counts as restricted.
    await h.db.query("update public.workspace_members set status = 'active' where id = $1", [seed.members.none]);
    expect(await tick(h)).not.toBeNull();
  });

  it("skips without the cron config", async () => {
    const h = await copyOf(full);
    await h.db.query("delete from public.fb_cron_config");
    expect(await tick(h, true)).toBeNull();
    expect(await requests(h)).toEqual([]);
  });

  it("is closed to every API role", async () => {
    expect(await privileges(full, "public.invoke_cohort_membership_tick(boolean)")).toEqual({ anon: false, authenticated: false, service: false, public: false });
    await expect(full.asService((tx) => tx.query("select public.invoke_cohort_membership_tick(true)"))).rejects.toThrow(/permission denied for function/);
  });
});

describe("rollback (supabase/rollback/202610060001_rollback.sql)", () => {
  const bodyOf = (sql: string, name: string) => {
    const match = sql.replace(/\r\n/g, "\n").match(new RegExp(`create or replace function ${name.replace(".", "\\.")}\\([\\s\\S]*?\\n\\$\\$;`));
    expect(match, name).not.toBeNull();
    return match![0];
  };

  it("re-creates the 202610050002 resolver bodies verbatim", () => {
    const core = readMigration("202610050002_access_core.sql");
    for (const name of ["app.resolve_access_core", "app.allowed_paths"]) {
      expect(bodyOf(ROLLBACK_SQL, name)).toBe(bodyOf(core, name));
    }
  });

  it("restores Phase-1 registry reads, paths and re-path bumps, and keeps funnel_paths", async () => {
    const h = await copyOf(full);
    const { owner, buyerA, manager } = seed.users;
    await attach(h, owner, seed.funnels.soulmate, "soulmate-old");
    expect(await scopePaths(h, buyerA)).toEqual(["soulmate-old", "soulmate-sketch"]);

    await h.db.exec(ROLLBACK_SQL);

    expect(await scopePaths(h, buyerA)).toEqual(["soulmate-sketch"]);
    expect(await allowedPaths(h, buyerA)).toEqual(["soulmate-sketch"]);
    expect(await countAs(h, buyerA, "funnels")).toBe(6);
    expect(await countAs(h, buyerA, "tags")).toBe(4);
    expect(await one(h.db, "(select count(*)::int from pg_policy where polname = 'lockdown_registry_scope')")).toBe(0);
    const triggers = await h.db.query<{ tgname: string }>(
      "select tgname from pg_trigger where tgrelid = 'public.funnels'::regclass and not tgisinternal order by tgname",
    );
    expect(triggers.rows.map((row) => row.tgname)).toEqual(["funnels_bump_member_access_version", "funnels_set_updated_at"]);

    const created = await h.asUser(manager, async (tx) =>
      (await tx.query<{ funnel_path: string }>("insert into public.funnels (funnel_path) values ('/Raw Path') returning funnel_path")).rows[0].funnel_path);
    expect(created).toBe("/Raw Path");
    expect(await bumps(h, () => h.asUser(manager, (tx) => tx.query("update public.funnels set funnel_path = 'palm-v9' where id = $1", [seed.funnels.palm])))).toEqual({
      ...ZERO,
      buyerC: 1,
    });
    expect(await one(h.db, "(select count(*)::int from public.funnel_paths)")).toBe(7);
    // Still the Phase-1 lockdown underneath.
    expect(await countAs(h, seed.users.outsider, "funnels")).toBe(0);
  });
});
