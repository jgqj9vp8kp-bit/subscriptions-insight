// Executable tests for supabase/migrations/202610050003_access_rls_lockdown.sql,
// run against PGlite (real Postgres compiled to WASM) through the Supabase
// stand-in in ./support/pgliteSupabase.ts. EVERY earlier migration is applied
// (pg_cron / pg_net stubbed), so each public table the app has is exercised,
// not a hand-picked subset.
//
// Covers: the bootstrap guard and the fb_cron_config owner assertion; RESTRICTIVE
// active-member + data-key policies on every tenant, actor-owned and registry
// table (non-member, disabled member, data owner, employee); registry writes
// gated on funnels.manage + scope all, including the RPC wrappers and the cron
// path of the recompute; dropped sync-state write policies; revoked / rewritten
// RPCs (support_apply_answer_matches, publish_report, internals); the cron
// senders posting the workspace data key; and the shape of every new policy
// (initPlan form, `to authenticated`).
//
// Runs in the default jsdom environment: src/test/setup.ts touches `window`
// (the harness makes PGlite work under jsdom).
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createSupabasePglite, listMigrations, type SqlRunner, type SupabasePglite } from "./support/pgliteSupabase";

const LOCKDOWN = "202610050003_access_rls_lockdown.sql";

// One seed row per account: $1 = the owning account, $2 = a unique text key.
// Insertion order matters (import_batch_files needs its batch).
const TENANT_TABLES: Record<string, { owner: string; insert: string }> = {
  transactions: {
    owner: "auth_user_id",
    insert: "insert into public.transactions (auth_user_id, transaction_id, event_time) values ($1, $2, now())",
  },
  import_batches: { owner: "user_id", insert: "insert into public.import_batches (user_id, filename) values ($1, $2)" },
  import_batch_files: {
    owner: "",
    insert: `insert into public.import_batch_files (import_batch_id, filename)
             select b.id, $2 from public.import_batches b where b.user_id = $1`,
  },
  api_export_logs: {
    owner: "user_id",
    insert: "insert into public.api_export_logs (user_id, endpoint, status_code) values ($1, $2, 200)",
  },
  capsuled_facebook_syncs: {
    owner: "user_id",
    insert: `insert into public.capsuled_facebook_syncs (user_id, date_from, date_to, level, status, error_message)
             values ($1, current_date, current_date, 'campaign', 'success', $2)`,
  },
  capsuled_facebook_stats: {
    owner: "user_id",
    insert: `insert into public.capsuled_facebook_stats (user_id, import_key, date_from, date_to, level)
             values ($1, $2, current_date, current_date, 'campaign')`,
  },
  funnelfox_leads: { owner: "auth_user_id", insert: "insert into public.funnelfox_leads (auth_user_id, profile_id) values ($1, $2)" },
  funnelfox_leads_sync_state: {
    owner: "auth_user_id",
    insert: "insert into public.funnelfox_leads_sync_state (auth_user_id, last_status) values ($1, $2)",
  },
  funnelfox_subscriptions: {
    owner: "auth_user_id",
    insert: "insert into public.funnelfox_subscriptions (auth_user_id, subscription_id) values ($1, $2)",
  },
  funnelfox_subscriptions_sync_state: {
    owner: "auth_user_id",
    insert: "insert into public.funnelfox_subscriptions_sync_state (auth_user_id, last_status) values ($1, $2)",
  },
  clickhouse_transaction_sync_state: {
    owner: "auth_user_id",
    insert: "insert into public.clickhouse_transaction_sync_state (auth_user_id, sync_name) values ($1, $2)",
  },
  clickhouse_validation_state: {
    owner: "auth_user_id",
    insert: "insert into public.clickhouse_validation_state (auth_user_id, validation_name) values ($1, $2)",
  },
  clickhouse_cohort_snapshot_state: {
    owner: "auth_user_id",
    insert: "insert into public.clickhouse_cohort_snapshot_state (auth_user_id, last_error) values ($1, $2)",
  },
  support_messages: { owner: "auth_user_id", insert: "insert into public.support_messages (auth_user_id, message_id) values ($1, $2)" },
  support_import_batches: {
    owner: "auth_user_id",
    insert: `insert into public.support_import_batches (auth_user_id, filename, checksum, import_year)
             values ($1, $2, $2, 2026)`,
  },
  support_requests: {
    owner: "auth_user_id",
    insert: "insert into public.support_requests (auth_user_id, source_row_number, source_hash) values ($1, 1, $2)",
  },
  support_mail_sync_state: {
    owner: "auth_user_id",
    insert: `insert into public.support_mail_sync_state (auth_user_id, mailbox_key, host, username)
             values ($1, $2, 'imap.example.com', 'support')`,
  },
  support_classification_state: {
    owner: "auth_user_id",
    insert: "insert into public.support_classification_state (auth_user_id, job_name) values ($1, $2)",
  },
  support_replies: {
    owner: "auth_user_id",
    insert: `insert into public.support_replies (auth_user_id, mailbox_key, folder, imap_uid_validity, imap_uid, message_id)
             values ($1, 'support', 'Sent', '1', 1, $2)`,
  },
  facebook_sync_runs: {
    owner: "auth_user_id",
    insert: `insert into public.facebook_sync_runs (run_id, auth_user_id, started_at, finished_at, status, mode, warehouse_version)
             values (gen_random_uuid(), $1, now(), now(), 'completed', 'full', $2)`,
  },
  facebook_import_batches: {
    owner: "auth_user_id",
    insert: `insert into public.facebook_import_batches (batch_id, run_id, auth_user_id, version)
             values (gen_random_uuid(), gen_random_uuid(), $1, $2)`,
  },
  facebook_raw_payloads: {
    owner: "auth_user_id",
    insert: `insert into public.facebook_raw_payloads (batch_id, auth_user_id, entity_level, page, payload_json)
             values (gen_random_uuid(), $1, 'campaign', 1, jsonb_build_object('key', $2::text))`,
  },
  facebook_batch_dq: {
    owner: "auth_user_id",
    insert: `insert into public.facebook_batch_dq (batch_id, run_id, auth_user_id, duplicate_key_samples)
             values (gen_random_uuid(), gen_random_uuid(), $1, jsonb_build_array($2::text))`,
  },
  facebook_campaign_mapping: {
    owner: "auth_user_id",
    insert: `insert into public.facebook_campaign_mapping (auth_user_id, observed_campaign_id, fb_campaign_id, mapping_type)
             values ($1, $2, $2, 'manual')`,
  },
  facebook_campaign_funnel_map: {
    owner: "auth_user_id",
    insert: `insert into public.facebook_campaign_funnel_map (auth_user_id, fb_campaign_id, funnel, match_kind, evidence_source)
             values ($1, $2, 'soulmate', 'confirmed', 'manual')`,
  },
  facebook_buyer_mapping: {
    owner: "auth_user_id",
    insert: "insert into public.facebook_buyer_mapping (auth_user_id, utm_source, buyer) values ($1, $2, 'buyer')",
  },
  facebook_known_gaps: {
    owner: "auth_user_id",
    insert: `insert into public.facebook_known_gaps (auth_user_id, gap_from, gap_to, level, reason)
             values ($1, current_date, current_date, 'campaign', $2)`,
  },
  facebook_sync_run_requests: {
    owner: "auth_user_id",
    insert: `insert into public.facebook_sync_run_requests (auth_user_id, run_id, request_seq, error_message)
             values ($1, gen_random_uuid(), 1, $2)`,
  },
};

const ACTOR_TABLES: Record<string, { owner: string; insert: string }> = {
  reports: {
    owner: "auth_user_id",
    insert: `insert into public.reports (auth_user_id, title, period_from, period_to, schema_version, engine_version, bindings)
             values ($1, $2, current_date, current_date, 1, 'v1', '{}')`,
  },
  report_versions: {
    owner: "auth_user_id",
    insert: `insert into public.report_versions (report_id, auth_user_id, version_no, title, period_from, period_to,
               schema_version, engine_version, bindings, snapshot, blocks)
             values (gen_random_uuid(), $1, 1, $2, current_date, current_date, 1, 'v1', '{}', '{}', '[]')`,
  },
  report_tasks: { owner: "auth_user_id", insert: "insert into public.report_tasks (auth_user_id, title) values ($1, $2)" },
  report_notes: {
    owner: "auth_user_id",
    insert: "insert into public.report_notes (auth_user_id, note_date, body) values ($1, current_date, $2)",
  },
  report_targets: {
    owner: "auth_user_id",
    insert: `insert into public.report_targets (auth_user_id, metric_key, target_value, effective_from)
             values ($1, $2, 1, current_date)`,
  },
  report_settings: {
    owner: "auth_user_id",
    insert: "insert into public.report_settings (auth_user_id, templates) values ($1, jsonb_build_array($2::text))",
  },
  project_forecasts: {
    owner: "auth_user_id",
    insert: `insert into public.project_forecasts (auth_user_id, name, schema_version, engine_version, source_window_from,
               source_window_to, source_as_of, bindings, window_ledger, resolved_at)
             values ($1, $2, 1, 'v1', current_date, current_date, now(), '{}', '{}', now())`,
  },
  forecast_scenarios: {
    owner: "auth_user_id",
    insert: `insert into public.forecast_scenarios (auth_user_id, name, funnel_id, horizon_periods, frozen)
             values ($1, $2, 'soulmate', 6, '{}')`,
  },
  ai_recommendations: {
    owner: "auth_user_id",
    insert: `insert into public.ai_recommendations (auth_user_id, surface, context_hash, engine_version)
             values ($1, 'cohort', $2, 'v1')`,
  },
  ai_feedback: {
    owner: "auth_user_id",
    insert: `insert into public.ai_feedback (auth_user_id, subject_kind, subject_id, verdict)
             values ($1, 'recommendation', $2, 'up')`,
  },
  ai_assistant_runs: {
    owner: "auth_user_id",
    insert: "insert into public.ai_assistant_runs (auth_user_id, model, prompt_version, status) values ($1, $2, 'p1', 'ok')",
  },
  report_ai_runs: {
    owner: "auth_user_id",
    insert: "insert into public.report_ai_runs (auth_user_id, model, prompt_version, status) values ($1, $2, 'p1', 'ok')",
  },
  api_keys: {
    owner: "user_id",
    insert: "insert into public.api_keys (user_id, name, key_hash, prefix) values ($1, $2, $2, 'sk_')",
  },
};

const SNAPSHOT_SEED = `insert into public.data_snapshots (user_id, dataset_type, name)
                       values ($1, 'palmer', $2), ($1, 'cohorts_ui_settings', $2)`;

const REGISTRY_TABLES = ["funnels", "tags", "funnel_tags"];

// The seven tables 202610050002 created and already locks.
const ACCESS_TABLES = [
  "access_audit_log", "access_denial_counters", "access_roles", "member_scope_rules",
  "member_scope_values", "workspace_members", "workspaces",
];

const SYNC_STATE_TABLES = [
  "clickhouse_transaction_sync_state", "clickhouse_validation_state", "clickhouse_cohort_snapshot_state",
  "funnelfox_leads_sync_state", "funnelfox_subscriptions_sync_state",
  "support_mail_sync_state", "support_classification_state",
];

const CONFIG_TABLES = ["fb_cron_config", "support_mail_cron_config"];

const ROLES: Record<string, string[]> = {
  viewer: ["cohorts.view", "dashboard.view", "funnels.view", "reports.view"],
  manager: ["funnels.manage", "funnels.view"],
  editor: ["reports.create", "reports.edit", "reports.publish", "reports.view"],
};

interface Seed {
  users: {
    owner: string;
    member: string;
    manager: string;
    editor: string;
    buyer: string;
    disabled: string;
    outsider: string;
  };
  funnels: { soulmate: string; palm: string; pastLife: string };
  tag: string;
}

let base: SupabasePglite; // every migration before the lockdown, no workspace
let prepared: SupabasePglite; // + bootstrap, members, data (the state step 8 finds)
let locked: SupabasePglite; // + the lockdown (shared by read-only tests)
let seed: Seed;
const opened: SupabasePglite[] = [];

async function copyOf(source: SupabasePglite): Promise<SupabasePglite> {
  const copy = await source.clone();
  opened.push(copy);
  return copy;
}

async function one<T = Record<string, unknown>>(tx: SqlRunner, sql: string, params: unknown[] = []): Promise<T> {
  return (await tx.query<T>(sql, params)).rows[0];
}

function countAs(h: SupabasePglite, user: string, table: string): Promise<number> {
  return h.asUser(user, async (tx) => (await one<{ n: number }>(tx, `select count(*)::int as n from public.${table}`)).n);
}

async function rowsOwnedBy(h: SupabasePglite, table: string, column: string, owner: string): Promise<number> {
  return (await one<{ n: number }>(h.db, `select count(*)::int as n from public.${table} where ${column} = $1`, [owner])).n;
}

async function buildPrepared(): Promise<{ h: SupabasePglite; seed: Seed }> {
  const h = await base.clone();
  const users = {
    owner: await h.createAuthUser("owner@example.com"),
    member: await h.createAuthUser("member@example.com"),
    manager: await h.createAuthUser("manager@example.com"),
    editor: await h.createAuthUser("editor@example.com"),
    buyer: await h.createAuthUser("buyer@example.com"),
    disabled: await h.createAuthUser("disabled@example.com"),
    outsider: await h.createAuthUser("outsider@example.com"),
  };

  const funnelRows = await h.db.query<{ id: string; funnel_path: string }>(
    `insert into public.funnels (funnel_path, display_name, is_active) values
       ('soulmate-sketch', 'Soulmate', false), ('palm-reading', 'Palm', true), ('past-life', 'Past life', false)
     returning id, funnel_path`,
  );
  const funnelId = (path: string) => funnelRows.rows.find((row) => row.funnel_path === path)!.id;
  const funnels = { soulmate: funnelId("soulmate-sketch"), palm: funnelId("palm-reading"), pastLife: funnelId("past-life") };
  const tag = (await one<{ id: string }>(h.db, "insert into public.tags (name) values ('evergreen') returning id")).id;
  await h.db.query("insert into public.funnel_tags (funnel_id, tag_id) values ($1, $2)", [funnels.soulmate, tag]);

  await h.db.query("select public.bootstrap_workspace($1, 'SubEngine')", [users.owner]);
  const roleIds: Record<string, string> = {};
  for (const [key, permissions] of Object.entries(ROLES)) {
    const result = await h.asService((tx) =>
      one<{ value: { role_id: string } }>(
        tx,
        "select public.access_create_role($1, $2, $3, '', $4::text[]) as value",
        [users.owner, key, key, permissions],
      ),
    );
    roleIds[key] = result.value.role_id;
  }
  const add = async (email: string, role: string, mode: string, funnelIds: string[] = []) => {
    const result = await h.asService((tx) =>
      one<{ value: { member_id: string } }>(
        tx,
        "select public.access_add_member($1, $2, $3, $4, $5::uuid[], null) as value",
        [users.owner, email, roleIds[role], mode, funnelIds],
      ),
    );
    return result.value.member_id;
  };
  await add("member@example.com", "viewer", "all");
  await add("manager@example.com", "manager", "all");
  await add("editor@example.com", "editor", "all");
  await add("buyer@example.com", "viewer", "selected", [funnels.soulmate]);
  const disabledMember = await add("disabled@example.com", "viewer", "all");
  await h.asService((tx) =>
    tx.query("select public.access_update_member($1, $2, null, 'disabled', null)", [users.owner, disabledMember]),
  );

  // Every account holds rows: the data owner's real data, and private copies
  // the other accounts made before the lockdown (plan G1).
  for (const [label, account] of Object.entries({ owner: users.owner, member: users.member, outsider: users.outsider, disabled: users.disabled })) {
    for (const [table, spec] of Object.entries({ ...TENANT_TABLES, ...ACTOR_TABLES })) {
      await h.db.query(spec.insert, [account, `${table}-${label}`]);
    }
    await h.db.query(SNAPSHOT_SEED, [account, `snapshot-${label}`]);
  }

  await h.db.query(
    `insert into public.fb_cron_config (auth_user_id, cron_secret, function_url, anon_key)
     values ($1, 'cron-secret', 'https://project.supabase.co/functions/v1/clickhouse-facebook', 'anon-jwt')`,
    [users.owner],
  );
  await h.db.query(
    `insert into public.support_mail_cron_config (cron_secret, function_url)
     values ('mail-secret', 'https://project.supabase.co/functions/v1/sync-support-mail')`,
  );

  return { h, seed: { users, funnels, tag } };
}

beforeAll(async () => {
  base = await createSupabasePglite({ migrations: listMigrations({ before: LOCKDOWN }), extensionStubs: true });
  ({ h: prepared, seed } = await buildPrepared());
  locked = await prepared.clone();
  await locked.applyMigration(LOCKDOWN);
}, 240_000);

afterEach(async () => {
  while (opened.length) await opened.pop()!.close();
});

describe("guards", () => {
  it("covers every migration before it", () => {
    const all = listMigrations();
    expect(all).toContain(LOCKDOWN);
    expect(listMigrations({ before: LOCKDOWN })).toEqual(all.slice(0, all.indexOf(LOCKDOWN)));
  });

  it("refuses to apply before the workspace is bootstrapped, and changes nothing", async () => {
    const h = await copyOf(base);
    await expect(h.applyMigration(LOCKDOWN)).rejects.toThrow(/public\.workspaces is empty, the workspace is not bootstrapped/);

    const policies = await one<{ n: number }>(h.db, "select count(*)::int as n from pg_policy where polname like 'lockdown%'");
    expect(policies.n).toBe(0);
    const grants = await one(
      h.db,
      `select has_function_privilege('authenticated', 'public.replace_funnel_tags(uuid, uuid[])', 'execute') as tags,
              has_function_privilege('authenticated', 'public.support_apply_answer_matches(uuid, jsonb)', 'execute') as matches`,
    );
    expect(grants).toEqual({ tags: true, matches: true });
    const job = await one<{ command: string }>(h.db, "select command from cron.job where jobname = 'funnels-active-from-traffic'");
    expect(job.command).toBe("select public.recompute_funnel_active_status(30)");
  });

  it("refuses when fb_cron_config does not belong to the workspace data key", async () => {
    const h = await copyOf(prepared);
    await h.db.query("update public.fb_cron_config set auth_user_id = $1", [seed.users.outsider]);
    await expect(h.applyMigration(LOCKDOWN)).rejects.toThrow(/fb_cron_config\.auth_user_id is not the workspace data key/);
    expect((await one<{ n: number }>(h.db, "select count(*)::int as n from pg_policy where polname like 'lockdown%'")).n).toBe(0);
  });

  it("applies when fb_cron_config is absent", async () => {
    const h = await copyOf(prepared);
    await h.db.query("delete from public.fb_cron_config");
    await expect(h.applyMigration(LOCKDOWN)).resolves.toBeUndefined();
  });

  it("aborts on a browser-reachable public table it does not classify (e.g. created in the dashboard)", async () => {
    const h = await copyOf(prepared);
    await h.db.exec("create table public.rogue_export (id int); alter table public.rogue_export enable row level security;");
    await expect(h.applyMigration(LOCKDOWN)).rejects.toThrow(/reachable by the browser without lockdown_active_member: rogue_export/);
    // Not reachable by the browser roles => nothing to lock => no abort.
    await h.db.exec("revoke all on table public.rogue_export from anon, authenticated;");
    await expect(h.applyMigration(LOCKDOWN)).resolves.toBeUndefined();
  });
});

describe("tenant data and actor-owned rows", () => {
  const everyTable = [...Object.keys(TENANT_TABLES), ...Object.keys(ACTOR_TABLES), "data_snapshots", ...REGISTRY_TABLES];

  it("seeds rows under every account, so the zero counts below are not vacuous", async () => {
    for (const account of [seed.users.owner, seed.users.member, seed.users.outsider, seed.users.disabled]) {
      for (const [table, spec] of Object.entries({ ...TENANT_TABLES, ...ACTOR_TABLES })) {
        if (!spec.owner) continue;
        expect(await rowsOwnedBy(locked, table, spec.owner, account), table).toBe(1);
      }
      expect(await rowsOwnedBy(locked, "data_snapshots", "user_id", account)).toBe(2);
    }
  });

  it("gives a signed-in account that is not a member nothing, not even rows stored under its own id", async () => {
    for (const table of everyTable) {
      expect(await countAs(locked, seed.users.outsider, table), table).toBe(0);
    }
  });

  it("gives a disabled member nothing, not even rows stored under its own id", async () => {
    for (const table of everyTable) {
      expect(await countAs(locked, seed.users.disabled, table), table).toBe(0);
    }
  });

  it("keeps the data owner's own rows, and only those", async () => {
    const { owner } = seed.users;
    for (const table of [...Object.keys(TENANT_TABLES), ...Object.keys(ACTOR_TABLES)]) {
      expect(await countAs(locked, owner, table), table).toBe(1);
    }
    expect(await countAs(locked, owner, "data_snapshots")).toBe(2);
    expect(await countAs(locked, owner, "funnels")).toBe(3);
    const transactions = await locked.asUser(owner, (tx) => tx.query<{ auth_user_id: string }>("select auth_user_id from public.transactions"));
    expect(transactions.rows).toEqual([{ auth_user_id: owner }]);
  });

  it("gives an employee no tenant table, not even the private copies under their own id", async () => {
    for (const table of Object.keys(TENANT_TABLES)) {
      expect(await countAs(locked, seed.users.member, table), table).toBe(0);
    }
    // data_snapshots: their own UI settings row stays, the palmer dataset does not.
    const snapshots = await locked.asUser(seed.users.member, (tx) =>
      tx.query<{ dataset_type: string; user_id: string }>("select dataset_type, user_id from public.data_snapshots"),
    );
    expect(snapshots.rows).toEqual([{ dataset_type: "cohorts_ui_settings", user_id: seed.users.member }]);
  });

  it("keeps an employee's own actor-owned rows and never shows them the owner's (own-row RLS still applies)", async () => {
    const { member } = seed.users;
    for (const [table, spec] of Object.entries(ACTOR_TABLES)) {
      const rows = await locked.asUser(member, (tx) => tx.query<{ owner: string }>(`select ${spec.owner}::text as owner from public.${table}`));
      expect(rows.rows, table).toEqual([{ owner: member }]);
    }
  });

  it("lets a restricted (selected-scope) member read the registry but no tenant table", async () => {
    for (const table of Object.keys(TENANT_TABLES)) {
      expect(await countAs(locked, seed.users.buyer, table), table).toBe(0);
    }
    expect(await countAs(locked, seed.users.buyer, "funnels")).toBe(3);
  });

  it("leaves anon with nothing", async () => {
    for (const table of ["transactions", "reports", "funnels", "data_snapshots", "support_requests"]) {
      const n = await locked.asAnon(async (tx) => (await one<{ n: number }>(tx, `select count(*)::int as n from public.${table}`)).n);
      expect(n, table).toBe(0);
    }
  });

  it("keeps the owner writing tenant tables and stops every other account writing them under any id", async () => {
    const h = await copyOf(locked);
    const { owner, member, outsider } = seed.users;
    const insertTx = "insert into public.transactions (auth_user_id, transaction_id, event_time) values ($1, $2, now())";

    await h.asUser(owner, (tx) => tx.query(insertTx, [owner, "owner-new"]));
    const updated = await h.asUser(owner, (tx) => tx.query("update public.transactions set status = 'success' where transaction_id = 'owner-new'"));
    expect(updated.affectedRows).toBe(1);

    // Postgres names the RESTRICTIVE policy that refused (a permissive miss is anonymous).
    const refusals: Array<[string, string, RegExp]> = [
      [member, owner, /violates row-level security policy for table "transactions"/], // own-row policy
      [member, member, /violates row-level security policy "lockdown_data_key" for table "transactions"/],
      [outsider, outsider, /violates row-level security policy "lockdown_active_member" for table "transactions"/],
    ];
    for (const [actor, target, refusal] of refusals) {
      await expect(h.asUser(actor, (tx) => tx.query(insertTx, [target, `forged-${actor}-${target}`]))).rejects.toThrow(refusal);
    }
    const forged = await h.asUser(member, (tx) => tx.query("update public.transactions set status = 'x'"));
    expect(forged.affectedRows).toBe(0);
  });

  it("keeps per-user settings snapshots per actor and dataset snapshots data-key only", async () => {
    const h = await copyOf(locked);
    const { owner, member } = seed.users;
    const upsert = `insert into public.data_snapshots (user_id, dataset_type, payload) values ($1, $2, '{"v": 2}')
                    on conflict (user_id, dataset_type) do update set payload = excluded.payload`;

    await h.asUser(member, (tx) => tx.query(upsert, [member, "cohorts_ui_settings"]));
    await h.asUser(member, (tx) => tx.query(upsert, [member, "forecasting_settings"]));
    for (const dataset of ["palmer", "facebook_traffic", "funnelfox_subscriptions"]) {
      await expect(h.asUser(member, (tx) => tx.query(upsert, [member, dataset]))).rejects.toThrow(
        'violates row-level security policy "lockdown_data_key" for table "data_snapshots"',
      );
    }
    await h.asUser(owner, (tx) => tx.query(upsert, [owner, "facebook_traffic"]));
    expect(await countAs(h, owner, "data_snapshots")).toBe(3);
    expect(await countAs(h, member, "data_snapshots")).toBe(2);
  });

  it("lets employees create their own saved objects but not as someone else, and not once disabled", async () => {
    const h = await copyOf(locked);
    const { owner, member, disabled } = seed.users;
    await h.asUser(member, (tx) => tx.query(ACTOR_TABLES.report_tasks.insert, [member, "member-task-2"]));
    await expect(h.asUser(member, (tx) => tx.query(ACTOR_TABLES.report_tasks.insert, [owner, "forged-task"]))).rejects.toThrow(
      'violates row-level security policy for table "report_tasks"',
    );
    await expect(h.asUser(disabled, (tx) => tx.query(ACTOR_TABLES.report_tasks.insert, [disabled, "disabled-task"]))).rejects.toThrow(
      'violates row-level security policy "lockdown_active_member" for table "report_tasks"',
    );
    expect(await countAs(h, member, "report_tasks")).toBe(2);
  });
});

describe("funnel registry", () => {
  const PERMISSION_DENIED = /permission_denied: funnels\.manage with funnel scope all is required/;

  it("is readable by every active member and by nobody else", async () => {
    for (const user of [seed.users.owner, seed.users.member, seed.users.manager, seed.users.buyer]) {
      expect(await countAs(locked, user, "funnels")).toBe(3);
      expect(await countAs(locked, user, "tags")).toBe(1);
      expect(await countAs(locked, user, "funnel_tags")).toBe(1);
    }
    for (const user of [seed.users.outsider, seed.users.disabled]) {
      for (const table of REGISTRY_TABLES) expect(await countAs(locked, user, table), table).toBe(0);
    }
  });

  it("refuses every write path to members without funnels.manage", async () => {
    const h = await copyOf(locked);
    const { funnels, tag } = seed;
    const { member, buyer, editor, disabled, outsider } = seed.users;
    // Active members are stopped by the registry rule; everyone else earlier, by membership.
    const refusedBy: Array<[string, string]> = [
      [member, "lockdown_registry_insert"],
      [buyer, "lockdown_registry_insert"],
      [editor, "lockdown_registry_insert"],
      [disabled, "lockdown_active_member"],
      [outsider, "lockdown_active_member"],
    ];
    for (const [user, policy] of refusedBy) {
      await expect(
        h.asUser(user, (tx) => tx.query("insert into public.funnels (funnel_path) values ($1)", [`forged-${user}`])),
      ).rejects.toThrow(`violates row-level security policy "${policy}" for table "funnels"`);
      await expect(h.asUser(user, (tx) => tx.query("insert into public.tags (name) values ($1)", [`forged-${user}`]))).rejects.toThrow(
        `violates row-level security policy "${policy}" for table "tags"`,
      );
      const renamed = await h.asUser(user, (tx) => tx.query("update public.funnels set display_name = 'Forged', funnel_path = 'x' || id"));
      expect(renamed.affectedRows).toBe(0);
      const deleted = await h.asUser(user, (tx) => tx.query("delete from public.tags"));
      expect(deleted.affectedRows).toBe(0);
      await expect(
        h.asUser(user, (tx) => tx.query("select public.replace_funnel_tags($1, $2::uuid[])", [funnels.palm, [tag]])),
      ).rejects.toThrow(PERMISSION_DENIED);
      await expect(h.asUser(user, (tx) => tx.query("select public.recompute_funnel_active_status(30)"))).rejects.toThrow(
        PERMISSION_DENIED,
      );
    }
    const registry = await h.db.query("select funnel_path, display_name, is_active from public.funnels order by funnel_path");
    expect(registry.rows).toEqual([
      { funnel_path: "palm-reading", display_name: "Palm", is_active: true },
      { funnel_path: "past-life", display_name: "Past life", is_active: false },
      { funnel_path: "soulmate-sketch", display_name: "Soulmate", is_active: false },
    ]);
    expect((await one<{ n: number }>(h.db, "select count(*)::int as n from public.tags")).n).toBe(1);
    expect((await one<{ n: number }>(h.db, "select count(*)::int as n from public.funnel_tags")).n).toBe(1);
  });

  it("keeps every write path for funnels.manage with scope all, and for the owner", async () => {
    for (const user of [seed.users.manager, seed.users.owner]) {
      const h = await copyOf(locked);
      const created = await h.asUser(user, (tx) =>
        one<{ id: string }>(tx, "insert into public.funnels (funnel_path, display_name, created_by) values ('new-funnel', 'New', $1) returning id", [user]),
      );
      const renamed = await h.asUser(user, (tx) => tx.query("update public.funnels set display_name = 'Renamed' where id = $1", [created.id]));
      expect(renamed.affectedRows).toBe(1);
      const newTag = await h.asUser(user, (tx) => one<{ id: string }>(tx, "insert into public.tags (name) values ('fresh') returning id"));
      const replaced = await h.asUser(user, (tx) =>
        one<{ value: unknown }>(tx, "select public.replace_funnel_tags($1, $2::uuid[]) as value", [created.id, [seed.tag, newTag.id]]),
      );
      expect(replaced.value).toEqual({ funnel_id: created.id, tag_count: 2 });
      const recomputed = await h.asUser(user, (tx) => one<{ value: Record<string, number> }>(tx, "select public.recompute_funnel_active_status(30) as value"));
      expect(recomputed.value).toMatchObject({ window_days: 30 });
      const deleted = await h.asUser(user, (tx) => tx.query("delete from public.tags where id = $1", [newTag.id]));
      expect(deleted.affectedRows).toBe(1);
      expect(await countAs(h, user, "funnel_tags")).toBe(2);
    }
  });

  it("still has no direct funnel_tags write path, even for the owner", async () => {
    const h = await copyOf(locked);
    await expect(
      h.asUser(seed.users.owner, (tx) =>
        tx.query("insert into public.funnel_tags (funnel_id, tag_id) values ($1, $2)", [seed.funnels.palm, seed.tag]),
      ),
    ).rejects.toThrow(/row-level security policy for table "funnel_tags"/);
  });

  it("keeps the internals out of reach and the wrappers callable by authenticated only", async () => {
    const privileges = async (signature: string) =>
      one(
        locked.db,
        `select has_function_privilege('anon', $1, 'execute') as anon,
                has_function_privilege('authenticated', $1, 'execute') as authenticated,
                has_function_privilege('service_role', $1, 'execute') as service`,
        [signature],
      );
    for (const signature of [
      "app.require_registry_manager()",
      "app.replace_funnel_tags_internal(uuid, uuid[])",
      "app.recompute_funnel_active_status_internal(integer)",
    ]) {
      expect(await privileges(signature), signature).toEqual({ anon: false, authenticated: false, service: false });
    }
    for (const signature of ["public.replace_funnel_tags(uuid, uuid[])", "public.recompute_funnel_active_status(integer)"]) {
      expect(await privileges(signature), signature).toEqual({ anon: false, authenticated: true, service: false });
    }
  });

  it("recomputes from data-key traffic only, through the rescheduled cron job", async () => {
    const { owner, outsider } = seed.users;
    const traffic = `insert into public.transactions (auth_user_id, transaction_id, event_time, status, normalized_payload)
                     values ($1, $2, now() - interval '1 day', 'success', jsonb_build_object('metadata', jsonb_build_object('ff_campaign_path', $3::text)))`;
    const seedTraffic = async (h: SupabasePglite) => {
      await h.db.query(traffic, [owner, "owner-soulmate", "/soulmate-sketch"]);
      // A private copy under another account must not keep palm-reading alive.
      await h.db.query(traffic, [outsider, "outsider-palm", "/palm-reading"]);
    };

    // Contrast: before the lockdown the job counted every account's traffic.
    const before = await copyOf(prepared);
    await seedTraffic(before);
    const legacy = await one<{ command: string }>(before.db, "select command from cron.job where jobname = 'funnels-active-from-traffic'");
    expect((await one<{ value: unknown }>(before.db, `${legacy.command} as value`)).value).toMatchObject({ active_total: 2 });

    const h = await copyOf(locked);
    await seedTraffic(h);

    const job = await one<{ command: string; schedule: string; username: string }>(
      h.db,
      "select command, schedule, username from cron.job where jobname = 'funnels-active-from-traffic'",
    );
    expect(job).toEqual({
      command: "select app.recompute_funnel_active_status_internal(30)",
      schedule: "0 6 * * *",
      username: "postgres",
    });
    // The job runs as postgres with no JWT: exactly what this executes.
    const result = await one<{ value: unknown }>(h.db, `${job.command} as value`);
    expect(result.value).toEqual({ window_days: 30, activated: 1, deactivated: 1, active_total: 1 });
    const flags = await h.db.query("select funnel_path, is_active from public.funnels order by funnel_path");
    expect(flags.rows).toEqual([
      { funnel_path: "palm-reading", is_active: false },
      { funnel_path: "past-life", is_active: false },
      { funnel_path: "soulmate-sketch", is_active: true },
    ]);
    // The browser wrapper agrees with the cron (same internal function).
    const again = await h.asUser(owner, (tx) => one<{ value: unknown }>(tx, "select public.recompute_funnel_active_status(30) as value"));
    expect(again.value).toEqual({ window_days: 30, activated: 0, deactivated: 0, active_total: 1 });
  });
});

describe("sync-state tables", () => {
  it("keep only their read policies, plus the restrictive lockdown", async () => {
    const policies = await locked.db.query<{ table: string; polname: string; polcmd: string; permissive: boolean }>(
      `select c.relname as table, p.polname, p.polcmd::text as polcmd, p.polpermissive as permissive
       from pg_policy p join pg_class c on c.oid = p.polrelid
       where c.relname = any($1::text[])
       order by 1, 2`,
      [SYNC_STATE_TABLES],
    );
    for (const table of SYNC_STATE_TABLES) {
      const own = policies.rows.filter((row) => row.table === table);
      expect(own.filter((row) => row.permissive).map((row) => row.polcmd), table).toEqual(["r"]);
      expect(own.filter((row) => !row.permissive).map((row) => `${row.polname}:${row.polcmd}`).sort(), table).toEqual([
        "lockdown_active_member:*",
        "lockdown_data_key:*",
      ]);
      const grants = await one(
        locked.db,
        `select has_table_privilege('authenticated', $1, 'SELECT') as select,
                has_table_privilege('authenticated', $1, 'INSERT, UPDATE, DELETE, TRUNCATE') as write,
                has_table_privilege('anon', $1, 'INSERT, UPDATE, DELETE, TRUNCATE') as anon_write`,
        [`public.${table}`],
      );
      expect(grants, table).toEqual({ select: true, write: false, anon_write: false });
    }
  });

  it("are still read by the owner UI and written by Edge (service role), never by the browser", async () => {
    const h = await copyOf(locked);
    const { owner } = seed.users;
    expect(await countAs(h, owner, "funnelfox_subscriptions_sync_state")).toBe(1);
    expect(await countAs(h, owner, "funnelfox_leads_sync_state")).toBe(1);
    for (const statement of [
      "insert into public.clickhouse_transaction_sync_state (auth_user_id, sync_name) values (auth.uid(), 'browser')",
      "update public.clickhouse_cohort_snapshot_state set last_error = 'browser'",
      "delete from public.support_classification_state",
    ]) {
      await expect(h.asUser(owner, (tx) => tx.query(statement))).rejects.toThrow(/permission denied for table/);
    }
    await h.asService((tx) =>
      tx.query("insert into public.clickhouse_transaction_sync_state (auth_user_id, sync_name) values ($1, 'edge')", [owner]),
    );
    expect(await rowsOwnedBy(h, "clickhouse_transaction_sync_state", "auth_user_id", owner)).toBe(2);
  });
});

describe("RPC fixes", () => {
  it("makes support_apply_answer_matches service-role only", async () => {
    const h = await copyOf(locked);
    const { owner } = seed.users;
    expect(
      await one(
        h.db,
        `select has_function_privilege('anon', 'public.support_apply_answer_matches(uuid, jsonb)', 'execute') as anon,
                has_function_privilege('authenticated', 'public.support_apply_answer_matches(uuid, jsonb)', 'execute') as authenticated,
                has_function_privilege('service_role', 'public.support_apply_answer_matches(uuid, jsonb)', 'execute') as service`,
      ),
    ).toEqual({ anon: false, authenticated: false, service: true });

    const request = await one<{ id: string }>(h.db, "select id from public.support_requests where auth_user_id = $1", [owner]);
    const matches = JSON.stringify([{ id: request.id, answered_at: "2026-10-01T00:00:00Z", answer_source: "thread", answered_reply_id: null, reply_count: 2 }]);
    await expect(
      h.asUser(owner, (tx) => tx.query("select public.support_apply_answer_matches($1, $2::jsonb)", [owner, matches])),
    ).rejects.toThrow(/permission denied for function support_apply_answer_matches/);
    const applied = await h.asService((tx) => one<{ n: number }>(tx, "select public.support_apply_answer_matches($1, $2::jsonb) as n", [owner, matches]));
    expect(applied.n).toBe(1);
  });

  it("publishes through publish_report only, with reports.publish, for the report's own author", async () => {
    const h = await copyOf(locked);
    const { owner, member, editor, outsider } = seed.users;
    const createReport = (user: string, title: string) =>
      h.asUser(user, (tx) =>
        one<{ id: string }>(
          tx,
          `insert into public.reports (auth_user_id, title, period_from, period_to, schema_version, engine_version, bindings, snapshot)
           values ($1, $2, current_date, current_date, 1, 'v1', '{}', '{"kpi": {"net": 1}}') returning id`,
          [user, title],
        ),
      );
    const publish = (user: string, reportId: string) =>
      h.asUser(user, (tx) => one<{ v: number }>(tx, "select public.publish_report($1) as v", [reportId]));

    const ownerReport = await createReport(owner, "Owner weekly");
    expect((await publish(owner, ownerReport.id)).v).toBe(1);
    expect((await publish(owner, ownerReport.id)).v).toBe(2);
    const versions = await h.asUser(owner, (tx) =>
      tx.query("select version_no, title from public.report_versions where report_id = $1 order by 1", [ownerReport.id]),
    );
    expect(versions.rows).toEqual([{ version_no: 1, title: "Owner weekly" }, { version_no: 2, title: "Owner weekly" }]);
    const status = await one(h.db, "select status, published_version_no from public.reports where id = $1", [ownerReport.id]);
    expect(status).toEqual({ status: "published", published_version_no: 2 });

    // The forgeable direct insert is gone, for the owner too.
    await expect(
      h.asUser(owner, (tx) => tx.query(ACTOR_TABLES.report_versions.insert, [owner, "forged-version"])),
    ).rejects.toThrow(/permission denied for table report_versions/);

    const memberReport = await createReport(member, "Member draft");
    await expect(publish(member, memberReport.id)).rejects.toThrow(/permission_denied: reports\.publish is required/);
    await expect(publish(outsider, ownerReport.id)).rejects.toThrow(/permission_denied: reports\.publish is required/);

    const editorReport = await createReport(editor, "Editor weekly");
    expect((await publish(editor, editorReport.id)).v).toBe(1);
    // Someone else's report stays "not found" (no existence oracle), as before.
    await expect(publish(editor, ownerReport.id)).rejects.toThrow(/Report .* not found/);

    expect(
      await one(
        h.db,
        `select has_function_privilege('anon', 'public.publish_report(uuid)', 'execute') as anon,
                has_function_privilege('authenticated', 'public.publish_report(uuid)', 'execute') as authenticated`,
      ),
    ).toEqual({ anon: false, authenticated: true });
  });

  it("still refuses to publish an empty report", async () => {
    const h = await copyOf(locked);
    const report = await one<{ id: string }>(h.db, "select id from public.reports where auth_user_id = $1", [seed.users.owner]);
    await expect(
      h.asUser(seed.users.owner, (tx) => tx.query("select public.publish_report($1)", [report.id])),
    ).rejects.toThrow(/has no collected data to publish/);
  });
});

describe("cron senders", () => {
  const lastRequest = async (h: SupabasePglite) =>
    one<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }>(
      h.db,
      "select url, headers, body from net.stub_requests order by id desc limit 1",
    );

  it("post the workspace data key, not whatever fb_cron_config says later", async () => {
    const h = await copyOf(locked);
    await h.db.query("update public.fb_cron_config set auth_user_id = $1", [seed.users.outsider]);

    await h.db.query("select public.invoke_fb_daily_cron()");
    const fb = await lastRequest(h);
    expect(fb.url).toBe("https://project.supabase.co/functions/v1/clickhouse-facebook");
    expect(fb.body).toEqual({ auth_user_id: seed.users.owner });
    expect(fb.headers).toEqual({
      "Content-Type": "application/json",
      "x-cron-secret": "cron-secret",
      Authorization: "Bearer anon-jwt",
      apikey: "anon-jwt",
    });

    await h.db.query("select public.invoke_funnelfox_subscriptions_sync(true)");
    const funnelfox = await lastRequest(h);
    expect(funnelfox.url).toBe("https://project.supabase.co/functions/v1/funnelfox-subscriptions-sync");
    expect(funnelfox.body).toEqual({ auth_user_id: seed.users.owner, full_reset: true });
  });

  it("used to post fb_cron_config.auth_user_id (contrast for the test above)", async () => {
    const h = await copyOf(prepared);
    await h.db.query("update public.fb_cron_config set auth_user_id = $1", [seed.users.outsider]);
    await h.db.query("select public.invoke_fb_daily_cron()");
    expect((await lastRequest(h)).body).toEqual({ auth_user_id: seed.users.outsider });
  });

  it("pin the Sent backfill tick to the data owner's sync state", async () => {
    // The owner's Sent backfill is mid-way; another account's newer row says
    // "complete". The old tick took the newest row of ANY account.
    const sentStates = async (h: SupabasePglite) => {
      await h.db.query(
        `insert into public.support_mail_sync_state (auth_user_id, mailbox_key, host, username, folder, status, updated_at)
         values ($1, 'support', 'imap.example.com', 'support', 'Sent', 'syncing', now() - interval '1 day')`,
        [seed.users.owner],
      );
      await h.db.query(
        `insert into public.support_mail_sync_state (auth_user_id, mailbox_key, host, username, folder, status, history_completed_at)
         values ($1, 'support', 'imap.example.com', 'support', 'Sent', 'completed', now())`,
        [seed.users.outsider],
      );
    };
    const tickJobs = async (h: SupabasePglite) =>
      (await h.db.query("select 1 from cron.job where jobname = 'support-sent-backfill-tick'")).rows.length;

    const before = await copyOf(prepared);
    await sentStates(before);
    await before.db.query("select public.invoke_support_sent_backfill_tick()");
    expect((await lastRequest(before)).body).toEqual({ internal: true, action: "rematch_replies", mode: "full" });
    expect(await tickJobs(before)).toBe(0); // retired itself on someone else's state

    const h = await copyOf(locked);
    await sentStates(h);
    await h.db.query("select public.invoke_support_sent_backfill_tick()");
    const tick = await lastRequest(h);
    expect(tick.body).toEqual({ internal: true, action: "sent_continue_sync" });
    expect(tick.headers).toEqual({ "Content-Type": "application/json", "x-support-mail-internal-secret": "mail-secret" });
    expect(await tickJobs(h)).toBe(1);
  });

  it("stay closed to browser roles", async () => {
    for (const signature of [
      "public.invoke_fb_daily_cron()",
      "public.invoke_funnelfox_subscriptions_sync(boolean)",
      "public.invoke_support_sent_backfill_tick()",
    ]) {
      const row = await one(
        locked.db,
        `select has_function_privilege('anon', $1, 'execute') as anon,
                has_function_privilege('authenticated', $1, 'execute') as authenticated`,
        [signature],
      );
      expect(row, signature).toEqual({ anon: false, authenticated: false });
    }
  });
});

describe("policy shape", () => {
  it("puts the restrictive active-member policy on every browser-reachable table except the access tables", async () => {
    const tables = await locked.db.query<{ relname: string; reachable: boolean; active: boolean; data_key: boolean }>(
      `select c.relname,
              has_table_privilege('authenticated', c.oid, 'SELECT, INSERT, UPDATE, DELETE') as reachable,
              exists (select 1 from pg_policy p where p.polrelid = c.oid and p.polname = 'lockdown_active_member' and not p.polpermissive) as active,
              exists (select 1 from pg_policy p where p.polrelid = c.oid and p.polname = 'lockdown_data_key' and not p.polpermissive) as data_key
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r', 'p')
       order by 1`,
    );
    const byName = new Map(tables.rows.map((row) => [row.relname, row]));
    const classified = [
      ...Object.keys(TENANT_TABLES), ...Object.keys(ACTOR_TABLES), "data_snapshots", ...REGISTRY_TABLES,
      ...ACCESS_TABLES, ...CONFIG_TABLES,
    ];
    // Every table in the schema is classified by these tests (a new table fails here).
    expect([...byName.keys()].sort()).toEqual([...classified].sort());

    for (const table of [...Object.keys(TENANT_TABLES), "data_snapshots"]) {
      expect(byName.get(table), table).toMatchObject({ reachable: true, active: true, data_key: true });
    }
    for (const table of [...Object.keys(ACTOR_TABLES), ...REGISTRY_TABLES]) {
      expect(byName.get(table), table).toMatchObject({ reachable: true, active: true, data_key: false });
    }
    for (const table of ACCESS_TABLES) {
      expect(byName.get(table), table).toMatchObject({ active: false, data_key: false });
    }
    for (const table of CONFIG_TABLES) {
      expect(byName.get(table), table).toMatchObject({ reachable: false });
      const anon = await one<{ v: boolean }>(locked.db, "select has_table_privilege('anon', $1, 'SELECT, INSERT, UPDATE, DELETE') as v", [`public.${table}`]);
      expect(anon.v, table).toBe(false);
    }
  });

  it("applies every lockdown policy to authenticated only, in the initPlan form", async () => {
    const policies = await locked.db.query<{ table: string; polname: string; roles: string[]; qual: string | null; check: string | null }>(
      `select c.relname as table, p.polname,
              array(select r.rolname::text from pg_roles r where r.oid = any (p.polroles) order by 1) as roles,
              pg_get_expr(p.polqual, p.polrelid) as qual,
              pg_get_expr(p.polwithcheck, p.polrelid) as check
       from pg_policy p join pg_class c on c.oid = p.polrelid
       where p.polname like 'lockdown%'`,
    );
    expect(policies.rows.length).toBeGreaterThan(80);
    for (const policy of policies.rows) {
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
});

// ---- review follow-ups ----------------------------------------------------------------------------

describe("views, materialized views and foreign tables (owner rights bypass RLS)", () => {
  it("aborts on a browser-readable view created outside migrations; security_invoker or no browser grant passes", async () => {
    const leaky = await copyOf(prepared);
    await leaky.db.exec("create view public.all_transactions as select auth_user_id, transaction_id from public.transactions;");
    await expect(leaky.applyMigration(LOCKDOWN)).rejects.toThrow(/readable by the browser roles bypass RLS: all_transactions/);
    expect((await one<{ n: number }>(leaky.db, "select count(*)::int as n from pg_policy where polname like 'lockdown%'")).n).toBe(0);

    const invoker = await copyOf(prepared);
    await invoker.db.exec("create view public.all_transactions with (security_invoker = true) as select auth_user_id, transaction_id from public.transactions;");
    await expect(invoker.applyMigration(LOCKDOWN)).resolves.toBeUndefined();
    // ...and through it the browser sees exactly what RLS lets it see.
    expect(await countAs(invoker, seed.users.outsider, "all_transactions")).toBe(0);
    expect(await countAs(invoker, seed.users.owner, "all_transactions")).toBe(1);

    const matview = await copyOf(prepared);
    await matview.db.exec("create materialized view public.tx_counts as select auth_user_id, count(*) n from public.transactions group by 1;");
    await expect(matview.applyMigration(LOCKDOWN)).rejects.toThrow(/bypass RLS: tx_counts/);
    await matview.db.exec("revoke all on public.tx_counts from anon, authenticated;");
    await expect(matview.applyMigration(LOCKDOWN)).resolves.toBeUndefined();
  }, 120_000);
});

describe("legacy no-argument active_funnelfox_subscription_emails()", () => {
  it("is no longer executable by the service role (cross-tenant merge); browsers keep the RLS-scoped form", async () => {
    const grants = await one(
      locked.db,
      `select has_function_privilege('anon', 'public.active_funnelfox_subscription_emails()', 'execute') as anon,
              has_function_privilege('authenticated', 'public.active_funnelfox_subscription_emails()', 'execute') as authenticated,
              has_function_privilege('service_role', 'public.active_funnelfox_subscription_emails()', 'execute') as service,
              has_function_privilege('service_role', 'public.active_funnelfox_subscription_emails(uuid)', 'execute') as service_scoped`,
    );
    expect(grants).toEqual({ anon: false, authenticated: true, service: false, service_scoped: true });
    await expect(locked.asService((tx) => tx.query("select public.active_funnelfox_subscription_emails()"))).rejects.toThrow(/permission denied/);
    // Before this migration the deployed (pre-access) Edge build still had it.
    const before = await one<{ service: boolean }>(
      prepared.db,
      "select has_function_privilege('service_role', 'public.active_funnelfox_subscription_emails()', 'execute') as service",
    );
    expect(before.service).toBe(true);
  });
});

describe("Export API log rows of an employee's authorized export", () => {
  it("are tenant data: logged under the data key (actor kept), the data owner reads them, the employee does not", async () => {
    const h = await copyOf(locked);
    await h.db.query(
      "insert into public.api_export_logs (user_id, actor_user_id, endpoint, status_code) values ($1, $2, 'export-campaign-performance', 200)",
      [seed.users.owner, seed.users.member],
    );
    const ownerRows = await h.asUser(seed.users.owner, (tx) =>
      tx.query<{ actor_user_id: string | null }>("select actor_user_id from public.api_export_logs where actor_user_id is not null"),
    );
    expect(ownerRows.rows).toEqual([{ actor_user_id: seed.users.member }]);
    expect(await countAs(h, seed.users.member, "api_export_logs")).toBe(0);
  });
});
