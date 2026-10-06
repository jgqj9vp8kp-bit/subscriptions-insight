// Executable tests for supabase/migrations/202610060010_funnelfox_leads_export.sql
// and 202610060011_funnelfox_leads_cron.sql, run against PGlite through the
// Supabase stand-in in ./support/pgliteSupabase.ts (used read-only).
//
// The database is the production shape the two migrations land on: every
// earlier migration (pg_cron / pg_net stubbed), the workspace bootstrapped
// before the RLS lockdown, then the lockdown and everything after it, plus
// legacy funnelfox_leads rows as the old 1-profile-per-call build left them.
//
// Covers: the new columns and defaults; the legacy backfill (list email and
// preview flag copied out, rows without an email deleted, sync state reset);
// the index changes; funnelfox_leads_reconcile correctness and idempotence;
// lease exclusivity; leads_profile_candidates shape, exclusions and KPIs; the
// service-role-only grants; and the cron sender + its two jobs.
//
// Runs in the default jsdom environment (src/test/setup.ts needs `window`).
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createSupabasePglite, listMigrations, type SqlRunner, type SupabasePglite } from "./support/pgliteSupabase";

const LOCKDOWN = "202610050003_access_rls_lockdown.sql";
const EXPORT = "202610060010_funnelfox_leads_export.sql";
const CRON = "202610060011_funnelfox_leads_cron.sql";

const FUNCTION_URL = "https://project.supabase.co/functions/v1/clickhouse-facebook";
const DAY_MS = 86_400_000;
// Each test works on a clone of a ~100-migration database (1-2 s, more under load).
const CLONE_TIMEOUT = 60_000;
const future = () => new Date(Date.now() + 30 * DAY_MS).toISOString();
const past = () => new Date(Date.now() - 30 * DAY_MS).toISOString();

let legacy: SupabasePglite; // everything before EXPORT + legacy rows
let exported: SupabasePglite; // + EXPORT
let full: SupabasePglite; // + CRON
let owner: string; // the workspace data key
let other: string; // another account with its own (pre-lockdown) rows
const opened: SupabasePglite[] = [];

async function copyOf(source: SupabasePglite): Promise<SupabasePglite> {
  const copy = await source.clone();
  opened.push(copy);
  return copy;
}

async function one<T = Record<string, unknown>>(tx: SqlRunner, sql: string, params: unknown[] = []): Promise<T> {
  return (await tx.query<T>(sql, params)).rows[0];
}

function rpc<T>(h: SupabasePglite, sql: string, params: unknown[] = []): Promise<T> {
  return h.asService(async (tx) => (await one<{ value: T }>(tx, `select ${sql} as value`, params)).value);
}

const iso = (value: unknown) => (value == null ? null : new Date(value as string).toISOString());

async function insertLead(
  h: SupabasePglite,
  row: {
    owner: string;
    profileId: string;
    email?: string | null;
    preview?: boolean;
    createdAt?: string | null;
    sessionCreatedAt?: string | null;
    funnelId?: string | null;
    campaignPath?: string | null;
    campaignId?: string | null;
    utmSource?: string | null;
    mediaBuyer?: string | null;
    countryCode?: string | null;
    userAgent?: string | null;
    origin?: string | null;
    isLead?: boolean;
  },
) {
  await h.db.query(
    `insert into public.funnelfox_leads
       (auth_user_id, profile_id, email, normalized_email, preview, created_at, session_created_at, funnel_id,
        campaign_path, campaign_id, utm_source, media_buyer, country_code, user_agent, origin, is_lead)
     values ($1, $2, $3, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, coalesce($15, false))`,
    [
      row.owner, row.profileId, row.email ?? null, row.preview ?? false, row.createdAt ?? null, row.sessionCreatedAt ?? null,
      row.funnelId ?? null, row.campaignPath ?? null, row.campaignId ?? null, row.utmSource ?? null, row.mediaBuyer ?? null,
      row.countryCode ?? null, row.userAgent ?? null, row.origin ?? null, row.isLead ?? null,
    ],
  );
}

let txSeq = 0;
async function insertTransaction(
  h: SupabasePglite,
  row: { owner: string; email: string; status: string; type?: string; eventTime?: string; deleted?: boolean },
) {
  txSeq += 1;
  await h.db.query(
    `insert into public.transactions (auth_user_id, transaction_id, event_time, status, transaction_type, email, deleted_at)
     values ($1, $2, $3, $4, $5, $6, case when $7 then now() end)`,
    [row.owner, `tx-${txSeq}`, row.eventTime ?? "2026-09-01T00:00:00Z", row.status, row.type ?? "subscription", row.email, row.deleted ?? false],
  );
}

async function insertSubscription(
  h: SupabasePglite,
  row: {
    owner: string;
    id: string;
    email: string;
    profileId?: string | null;
    status?: string;
    renews?: boolean | null;
    periodEndsAt?: string;
    price?: number | null;
    createdAt?: string | null;
    funnel?: string | null;
    rawDetail?: Record<string, unknown> | null;
    rawList?: Record<string, unknown> | null;
  },
) {
  await h.db.query(
    `insert into public.funnelfox_subscriptions
       (auth_user_id, subscription_id, profile_id, email, normalized_email, status, renews, period_ends_at, price,
        created_at, funnel, raw_detail, raw_list)
     values ($1, $2, $3, $4, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb)`,
    [
      row.owner, row.id, row.profileId ?? null, row.email, row.status ?? "active",
      row.renews === undefined ? true : row.renews, row.periodEndsAt ?? future(), row.price ?? 0, row.createdAt ?? null,
      row.funnel ?? null, row.rawDetail ? JSON.stringify(row.rawDetail) : null, row.rawList ? JSON.stringify(row.rawList) : null,
    ],
  );
}

/**
 * Quiz email ≠ checkout email: four stored profiles, each with ITS OWN FunnelFox
 * subscription (funnelfox_subscriptions.profile_id) under a different email.
 * p-quiz1..3 show a paying / subscribed customer, p-quiz4 is the control.
 */
async function seedLinkedSubscriptions(h: SupabasePglite) {
  await insertLead(h, { owner, profileId: "p-quiz1", email: "quiz1@example.com", createdAt: "2026-09-20T00:00:00Z" });
  await insertLead(h, { owner, profileId: "p-quiz2", email: "quiz2@example.com", createdAt: "2026-09-20T00:00:00Z" });
  await insertLead(h, { owner, profileId: "p-quiz3", email: "quiz3@example.com", createdAt: "2026-09-20T00:00:00Z" });
  await insertLead(h, { owner, profileId: "p-quiz4", email: "quiz4@example.com", createdAt: "2026-09-20T00:00:00Z" });
  // 1: the checkout email paid (the warehouse knows it, not the quiz email).
  await insertTransaction(h, { owner, email: "checkout1@example.com", status: "success", type: "trial" });
  await insertSubscription(h, { owner, id: "sl-1", email: "checkout1@example.com", profileId: "p-quiz1", periodEndsAt: past() });
  // 2: priced, cancelled right after the purchase, still inside the paid period; not in the warehouse.
  await insertSubscription(h, {
    owner, id: "sl-2", email: "checkout2@example.com", profileId: "p-quiz2", price: 19.99, status: "cancelled", renews: false, periodEndsAt: future(),
  });
  // 3: the checkout email is an active subscriber; the link carries the pro_ prefix.
  await insertSubscription(h, { owner, id: "sl-3", email: "checkout3@example.com", profileId: "pro_p-quiz3" });
  // 4 (control): a free, cancelled, expired subscription of its own.
  await insertSubscription(h, {
    owner, id: "sl-4", email: "checkout4@example.com", profileId: "p-quiz4", status: "cancelled", renews: false, periodEndsAt: past(),
  });
  // Another account's paid subscription naming the same profile id never links.
  await insertSubscription(h, { owner: other, id: "ql-4", email: "x@example.com", profileId: "p-quiz4", price: 49 });
}

beforeAll(async () => {
  const base = await createSupabasePglite({ migrations: listMigrations({ before: LOCKDOWN }), extensionStubs: true });
  owner = await base.createAuthUser("owner@example.com");
  other = await base.createAuthUser("other@example.com");
  await base.db.query("select public.bootstrap_workspace($1, 'SubEngine')", [owner]);
  await base.db.query(
    `insert into public.fb_cron_config (auth_user_id, cron_secret, function_url, anon_key)
     values ($1, 'cron-secret', $2, 'anon-jwt')`,
    [owner, FUNCTION_URL],
  );
  for (const name of listMigrations().filter((migration) => migration >= LOCKDOWN && migration < EXPORT)) {
    await base.applyMigration(name);
  }

  // Legacy rows as the old profiles stage stored them: raw list row, no email
  // column, is_lead defaulting to true.
  const legacyRow = async (account: string, profileId: string, raw: Record<string, unknown> | null, email: string | null = null) =>
    base.db.query(
      `insert into public.funnelfox_leads (auth_user_id, profile_id, email, normalized_email, raw_profile_list)
       values ($1, $2, $3, $3, $4::jsonb)`,
      [account, profileId, email, raw ? JSON.stringify(raw) : null],
    );
  await legacyRow(owner, "p-mail", { id: "p-mail", created_at: "2026-06-20T10:00:00Z", funnel_id: "F1", preview: false, email: " Lead@Example.com " });
  await legacyRow(owner, "p-preview-mail", { id: "p-preview-mail", funnel_id: "F1", preview: true, email: "qa@example.com" });
  await legacyRow(owner, "p-nomail", { id: "p-nomail", funnel_id: "F1", preview: false });
  await legacyRow(owner, "p-bad-mail", { id: "p-bad-mail", preview: false, email: "not-an-email" });
  await legacyRow(owner, "p-old-detail", null, "old@example.com");
  await legacyRow(other, "q-mail", { id: "q-mail", preview: false, email: "other@example.com" });
  // The old detail / sessions stages stored their raw payloads too.
  await base.db.query(
    `update public.funnelfox_leads
     set raw_profile_detail = '{"id": "p-old-detail", "replies": [{"value": "answer"}]}'::jsonb,
         raw_session = '{"id": "s-1", "origin": "https://quiz.example.com/?utm_source=4"}'::jsonb
     where profile_id in ('p-old-detail', 'p-mail')`,
  );
  await base.db.query(
    `insert into public.funnelfox_leads_sync_state
       (auth_user_id, current_stage, last_profiles_cursor, last_sessions_cursor, profiles_completed, details_completed,
        sessions_completed, reconcile_completed, profiles_scanned_total, sessions_scanned_total,
        profiles_total_reported_by_api, stats, last_full_sync_at, last_status)
     values ($1, 'profiles', 'old-cursor', 'old-session-cursor', true, true, false, false, 40, 7, 999,
             '{"profiles_saved": 157}'::jsonb, '2026-06-21T00:00:00Z', 'partial')`,
    [owner],
  );

  legacy = base;
  exported = await legacy.clone();
  await exported.applyMigration(EXPORT);
  full = await exported.clone();
  await full.applyMigration(CRON);
}, 300_000);

afterEach(async () => {
  while (opened.length) await opened.pop()!.close();
});

// ---------------------------------------------------------------------------
// 202610060010: schema
// ---------------------------------------------------------------------------

describe("export migration: columns and defaults", { timeout: CLONE_TIMEOUT }, () => {
  it("adds preview (not null, default false), email_source and the lease column", async () => {
    const columns = await exported.db.query<{ table_name: string; column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
      `select table_name, column_name, data_type, is_nullable, column_default
       from information_schema.columns
       where table_schema = 'public'
         and (table_name, column_name) in (('funnelfox_leads', 'preview'), ('funnelfox_leads', 'email_source'),
                                           ('funnelfox_leads', 'is_lead'), ('funnelfox_leads_sync_state', 'lease_until'))
       order by 1, 2`,
    );
    expect(columns.rows).toEqual([
      { table_name: "funnelfox_leads", column_name: "email_source", data_type: "text", is_nullable: "YES", column_default: null },
      { table_name: "funnelfox_leads", column_name: "is_lead", data_type: "boolean", is_nullable: "YES", column_default: "false" },
      { table_name: "funnelfox_leads", column_name: "preview", data_type: "boolean", is_nullable: "NO", column_default: "false" },
      { table_name: "funnelfox_leads_sync_state", column_name: "lease_until", data_type: "timestamp with time zone", is_nullable: "YES", column_default: null },
    ]);
  });

  it("a row is not a lead until reconcile says so (is_lead defaults to false)", async () => {
    const h = await copyOf(exported);
    await h.db.query("insert into public.funnelfox_leads (auth_user_id, profile_id) values ($1, 'fresh')", [owner]);
    const row = await one(h.db, "select is_lead, preview, email_source from public.funnelfox_leads where profile_id = 'fresh'");
    expect(row).toEqual({ is_lead: false, preview: false, email_source: null });
  });
});

describe("export migration: legacy rows and sync state", { timeout: CLONE_TIMEOUT }, () => {
  it("copies the list email and preview flag out of raw_profile_list and deletes rows without an email", async () => {
    const rows = await exported.db.query(
      `select auth_user_id = $1 as is_owner, profile_id, email, normalized_email, email_source, preview, is_lead
       from public.funnelfox_leads order by profile_id`,
      [owner],
    );
    expect(rows.rows).toEqual([
      { is_owner: true, profile_id: "p-mail", email: "Lead@Example.com", normalized_email: "lead@example.com", email_source: "list", preview: false, is_lead: true },
      { is_owner: true, profile_id: "p-old-detail", email: "old@example.com", normalized_email: "old@example.com", email_source: null, preview: false, is_lead: true },
      { is_owner: true, profile_id: "p-preview-mail", email: "qa@example.com", normalized_email: "qa@example.com", email_source: "list", preview: true, is_lead: true },
      { is_owner: false, profile_id: "q-mail", email: "other@example.com", normalized_email: "other@example.com", email_source: "list", preview: false, is_lead: true },
    ]);
    // Contrast: all six were there before.
    expect((await one<{ n: number }>(legacy.db, "select count(*)::int as n from public.funnelfox_leads")).n).toBe(6);
  });

  it("clears every raw payload of the surviving legacy rows (owner decision 1: no raw JSON kept)", async () => {
    const raw = `select count(*)::int as rows,
                        count(*) filter (where raw_profile_list is not null)::int as list,
                        count(*) filter (where raw_profile_detail is not null)::int as detail,
                        count(*) filter (where raw_session is not null)::int as session
                 from public.funnelfox_leads`;
    expect(await one(legacy.db, raw)).toEqual({ rows: 6, list: 5, detail: 2, session: 2 });
    expect(await one(exported.db, raw)).toEqual({ rows: 4, list: 0, detail: 0, session: 0 });
  });

  it("resets cursors, stage flags, counters and stale stats so the new sync starts from the newest profile", async () => {
    const state = await one(
      exported.db,
      `select current_stage, last_profiles_cursor, last_sessions_cursor, profiles_completed, details_completed,
              sessions_completed, reconcile_completed, profiles_scanned_total, sessions_scanned_total,
              profiles_total_reported_by_api, stats, lease_until, lease_token, last_full_sync_at, last_status
       from public.funnelfox_leads_sync_state where auth_user_id = $1`,
      [owner],
    );
    expect({ ...state, last_full_sync_at: iso(state.last_full_sync_at) }).toEqual({
      current_stage: null,
      last_profiles_cursor: null,
      last_sessions_cursor: null,
      profiles_completed: false,
      details_completed: false,
      sessions_completed: false,
      reconcile_completed: false,
      profiles_scanned_total: 0,
      sessions_scanned_total: 0,
      profiles_total_reported_by_api: null,
      stats: null,
      lease_until: null,
      lease_token: null,
      // History is kept.
      last_full_sync_at: "2026-06-21T00:00:00.000Z",
      last_status: "partial",
    });
  });
});

describe("export migration: indexes", { timeout: CLONE_TIMEOUT }, () => {
  const indexes = async (h: SupabasePglite, table: string) =>
    new Map(
      (await h.db.query<{ indexname: string; indexdef: string }>(
        "select indexname, indexdef from pg_indexes where schemaname = 'public' and tablename = $1",
        [table],
      )).rows.map((row) => [row.indexname, row.indexdef]),
    );

  it("adds (auth_user_id, normalized_email) where normalized_email is not null and drops the unused single-column indexes", async () => {
    const before = await indexes(legacy, "funnelfox_leads");
    const after = await indexes(exported, "funnelfox_leads");
    expect(after.get("funnelfox_leads_owner_email_idx")).toMatch(
      /ON public\.funnelfox_leads USING btree \(auth_user_id, normalized_email\) WHERE \(normalized_email IS NOT NULL\)/,
    );
    const dropped = [
      "funnelfox_leads_profile_id_idx", "funnelfox_leads_campaign_path_idx", "funnelfox_leads_campaign_id_idx",
      "funnelfox_leads_media_buyer_idx", "funnelfox_leads_country_code_idx", "funnelfox_leads_is_lead_idx",
    ];
    for (const name of dropped) {
      expect(before.has(name), name).toBe(true);
      expect(after.has(name), name).toBe(false);
    }
    // Kept: the owner index, the unique (auth_user_id, profile_id) the sync upserts on, and the date / enrichment ones.
    for (const name of [
      "funnelfox_leads_auth_user_id_idx", "funnelfox_leads_auth_user_id_profile_id_key", "funnelfox_leads_normalized_email_idx",
      "funnelfox_leads_created_at_idx", "funnelfox_leads_session_created_at_idx", "funnelfox_leads_detail_checked_idx",
    ]) {
      expect(after.has(name), name).toBe(true);
    }
  });

  it("serves the paid-email read from the covering warehouse index (index-only)", async () => {
    const def = (await indexes(exported, "transactions")).get("transactions_live_owner_email_idx");
    expect(def).toMatch(/\(auth_user_id, lower\(btrim\(email\)\)\) INCLUDE \(status, transaction_type, event_time, email\) WHERE \(\(deleted_at IS NULL\) AND \(email IS NOT NULL\)\)/);
    const plan = await exported.asPostgres(async (tx) => {
      await tx.exec("set local enable_seqscan = off; set local enable_bitmapscan = off;");
      const result = await tx.query<{ "QUERY PLAN": string }>(
        `explain select lower(btrim(t.email)), min(t.event_time) filter (where t.transaction_type = 'trial')
         from public.transactions t
         where t.auth_user_id = $1 and t.deleted_at is null and t.email is not null and t.status = 'success'
           and btrim(t.email) <> ''
         group by 1`,
        [owner],
      );
      return result.rows.map((row) => row["QUERY PLAN"]).join("\n");
    });
    expect(plan).toContain("Index Only Scan using transactions_live_owner_email_idx");
  });
});

// ---------------------------------------------------------------------------
// funnelfox_leads_reconcile
// ---------------------------------------------------------------------------

describe("funnelfox_leads_reconcile(p_data_key)", { timeout: CLONE_TIMEOUT }, () => {
  async function seed(): Promise<SupabasePglite> {
    const h = await copyOf(exported);
    await h.db.query("delete from public.funnelfox_leads");
    await insertLead(h, { owner, profileId: "p-paid", email: " PAID@example.com" });
    await insertLead(h, { owner, profileId: "p-active", email: "active@example.com" });
    await insertLead(h, { owner, profileId: "p-both", email: "both@example.com" });
    await insertLead(h, { owner, profileId: "p-lead", email: "lead@example.com" });
    await insertLead(h, { owner, profileId: "p-preview", email: "preview@example.com", preview: true });
    await insertLead(h, { owner, profileId: "p-deleted", email: "deleted@example.com" });
    await insertLead(h, { owner, profileId: "p-cross", email: "cross@example.com" });
    await insertLead(h, { owner, profileId: "p-sandbox", email: "sandbox@example.com" });
    // Another account's row for an email the owner treats as a lead.
    await insertLead(h, { owner: other, profileId: "q-lead", email: "lead@example.com", isLead: true });

    await insertTransaction(h, { owner, email: "paid@example.com", status: "success", type: "trial", eventTime: "2026-08-05T00:00:00Z" });
    await insertTransaction(h, { owner, email: " Paid@Example.com ", status: "success", type: "trial", eventTime: "2026-08-01T00:00:00Z" });
    await insertTransaction(h, { owner, email: "paid@example.com", status: "success", type: "first_subscription", eventTime: "2026-08-08T00:00:00Z" });
    await insertTransaction(h, { owner, email: "paid@example.com", status: "failed", type: "trial", eventTime: "2026-07-01T00:00:00Z" });
    await insertTransaction(h, { owner, email: "both@example.com", status: "success", type: "renewal" });
    await insertTransaction(h, { owner, email: "lead@example.com", status: "failed", type: "trial" });
    await insertTransaction(h, { owner, email: "deleted@example.com", status: "success", type: "trial", deleted: true });
    await insertTransaction(h, { owner: other, email: "cross@example.com", status: "success", type: "trial" });

    await insertSubscription(h, { owner, id: "s-active", email: "active@example.com" });
    await insertSubscription(h, { owner, id: "s-both", email: "both@example.com" });
    await insertSubscription(h, { owner, id: "s-sandbox", email: "sandbox@example.com", rawDetail: { sandbox: true } });
    await insertSubscription(h, { owner, id: "s-expired", email: "lead@example.com", periodEndsAt: past() });
    await insertSubscription(h, { owner: other, id: "q-active", email: "cross@example.com" });
    return h;
  }

  interface StateRow {
    profile_id: string;
    paid: boolean;
    active: boolean;
    is_lead: boolean;
    first_trial_at: string | null;
    first_sub_at: string | null;
  }
  const states = async (h: SupabasePglite, account: string) =>
    Object.fromEntries(
      (await h.db.query<StateRow>(
        `select profile_id, has_successful_payment as paid, has_active_subscription as active, is_lead, first_trial_at, first_sub_at
         from public.funnelfox_leads where auth_user_id = $1`,
        [account],
      )).rows.map(({ profile_id, first_trial_at, first_sub_at, ...rest }) => [
        profile_id,
        { ...rest, first_trial_at: iso(first_trial_at), first_sub_at: iso(first_sub_at) },
      ]),
    );

  it("marks paid / active / leads from the owner's warehouse and subscriptions only, and returns the counts", async () => {
    const h = await seed();
    const result = await rpc(h, "public.funnelfox_leads_reconcile($1::uuid)", [owner]);
    expect(result).toEqual({ checked: 8, leads: 4, paid_excluded: 2, active_excluded: 1, updated: 7 });

    const notPaid = { paid: false, first_trial_at: null, first_sub_at: null };
    expect(await states(h, owner)).toEqual({
      // Earliest successful trial / first subscription; the failed trial before them does not count.
      "p-paid": { paid: true, active: false, is_lead: false, first_trial_at: "2026-08-01T00:00:00.000Z", first_sub_at: "2026-08-08T00:00:00.000Z" },
      "p-active": { ...notPaid, active: true, is_lead: false },
      "p-both": { paid: true, active: true, is_lead: false, first_trial_at: null, first_sub_at: null },
      "p-lead": { ...notPaid, active: false, is_lead: true },
      // Preview runs are never leads.
      "p-preview": { ...notPaid, active: false, is_lead: false },
      // A deleted successful transaction is not a payment.
      "p-deleted": { ...notPaid, active: false, is_lead: true },
      // Another account's payment / subscription does not convert the owner's lead.
      "p-cross": { ...notPaid, active: false, is_lead: true },
      // A sandbox subscription is not active (Cohorts definition).
      "p-sandbox": { ...notPaid, active: false, is_lead: true },
    });
    // The other account's rows are untouched.
    expect(await states(h, other)).toEqual({ "q-lead": { ...notPaid, active: false, is_lead: true } });
  });

  it("is idempotent: a second call changes no row", async () => {
    const h = await seed();
    const first = await rpc<Record<string, number>>(h, "public.funnelfox_leads_reconcile($1::uuid)", [owner]);
    const stamps = await h.db.query("select profile_id, updated_row_at from public.funnelfox_leads order by 1");
    const second = await rpc<Record<string, number>>(h, "public.funnelfox_leads_reconcile($1::uuid)", [owner]);
    expect(second).toEqual({ ...first, updated: 0 });
    expect((await h.db.query("select profile_id, updated_row_at from public.funnelfox_leads order by 1")).rows).toEqual(stamps.rows);
  });

  it("follows a new payment on the next call", async () => {
    const h = await seed();
    await rpc(h, "public.funnelfox_leads_reconcile($1::uuid)", [owner]);
    await insertTransaction(h, { owner, email: "LEAD@example.com", status: "success", type: "first_subscription", eventTime: "2026-09-02T00:00:00Z" });
    const result = await rpc(h, "public.funnelfox_leads_reconcile($1::uuid)", [owner]);
    expect(result).toEqual({ checked: 8, leads: 3, paid_excluded: 3, active_excluded: 1, updated: 1 });
    expect((await states(h, owner))["p-lead"]).toEqual({ paid: true, active: false, is_lead: false, first_trial_at: null, first_sub_at: "2026-09-02T00:00:00.000Z" });
  });

  it("a profile whose OWN subscription shows a paying customer is not a lead, whatever email the checkout used", async () => {
    const h = await seed();
    await seedLinkedSubscriptions(h);
    await rpc(h, "public.funnelfox_leads_reconcile($1::uuid)", [owner]);
    const all = await states(h, owner);
    const linked = Object.fromEntries(["p-quiz1", "p-quiz2", "p-quiz3", "p-quiz4"].map((id) => [id, all[id]]));
    const notPaid = { first_trial_at: null, first_sub_at: null };
    expect(linked).toEqual({
      // Its subscription's (checkout) email paid in the warehouse.
      "p-quiz1": { ...notPaid, paid: true, active: false, is_lead: false },
      // Priced, cancelled, still inside its paid period.
      "p-quiz2": { ...notPaid, paid: true, active: false, is_lead: false },
      // Linked through a pro_-prefixed id; the checkout email is an active subscriber.
      "p-quiz3": { ...notPaid, paid: true, active: false, is_lead: false },
      // Control: a free, cancelled, expired subscription of its own — still a lead.
      "p-quiz4": { ...notPaid, paid: false, active: false, is_lead: true },
    });
    // The pre-existing rows keep their state (no subscription links them).
    expect(all["p-lead"]).toEqual({ ...notPaid, paid: false, active: false, is_lead: true });
  });

  it("a null or unknown key matches nothing (never every owner)", async () => {
    const h = await seed();
    const zero = { checked: 0, leads: 0, paid_excluded: 0, active_excluded: 0, updated: 0 };
    expect(await rpc(h, "public.funnelfox_leads_reconcile($1::uuid)", [null])).toEqual(zero);
    expect(await rpc(h, "public.funnelfox_leads_reconcile($1::uuid)", ["00000000-0000-0000-0000-000000000000"])).toEqual(zero);
    expect(Object.values(await states(h, owner)).every((row) => row.is_lead === false)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Lease
// ---------------------------------------------------------------------------

describe("funnelfox_leads_acquire_lease / funnelfox_leads_release_lease", { timeout: CLONE_TIMEOUT }, () => {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const acquire = (h: SupabasePglite, key: string | null, seconds: number | null = 120) =>
    rpc<string | null>(h, "public.funnelfox_leads_acquire_lease($1::uuid, $2::int)", [key, seconds]);
  const release = (h: SupabasePglite, key: string | null, token: string | null) =>
    h.asService((tx) => tx.query("select public.funnelfox_leads_release_lease($1::uuid, $2::uuid)", [key, token]));
  const lease = (h: SupabasePglite, key: string) =>
    one<{ lease_until: string | null; lease_token: string | null }>(
      h.db,
      "select lease_until, lease_token from public.funnelfox_leads_sync_state where auth_user_id = $1",
      [key],
    );

  it("is exclusive per owner until released; each grant answers a fresh token", async () => {
    const h = await copyOf(exported);
    const token = await acquire(h, owner);
    expect(token).toMatch(UUID);
    expect(await acquire(h, owner)).toBeNull();
    expect(await acquire(h, owner, 5)).toBeNull();
    expect((await lease(h, owner)).lease_token).toBe(token);

    await release(h, owner, token);
    expect(await lease(h, owner)).toEqual({ lease_until: null, lease_token: null });
    const next = await acquire(h, owner);
    expect(next).toMatch(UUID);
    expect(next).not.toBe(token);
  });

  it("only the holder's token releases: a call that outlived its lease never frees the next holder's", async () => {
    const h = await copyOf(exported);
    const stale = await acquire(h, owner, 60);
    // The first call overran: its lease expired and the next tick took it.
    await h.db.query("update public.funnelfox_leads_sync_state set lease_until = now() - interval '1 second' where auth_user_id = $1", [owner]);
    const current = await acquire(h, owner);
    expect(current).toMatch(UUID);
    expect(current).not.toBe(stale);

    await release(h, owner, stale);
    expect((await lease(h, owner)).lease_token).toBe(current);
    expect(await acquire(h, owner)).toBeNull();
    await release(h, owner, null);
    expect((await lease(h, owner)).lease_token).toBe(current);

    await release(h, owner, current);
    expect(await lease(h, owner)).toEqual({ lease_until: null, lease_token: null });
  });

  it("can be taken once the held lease has expired", async () => {
    const h = await copyOf(exported);
    expect(await acquire(h, owner, 60)).toMatch(UUID);
    const held = await one<{ seconds: number }>(
      h.db,
      "select extract(epoch from lease_until - now())::int as seconds from public.funnelfox_leads_sync_state where auth_user_id = $1",
      [owner],
    );
    expect(held.seconds).toBeGreaterThan(50);
    expect(held.seconds).toBeLessThanOrEqual(61);

    await h.db.query("update public.funnelfox_leads_sync_state set lease_until = now() - interval '1 second' where auth_user_id = $1", [owner]);
    expect(await acquire(h, owner)).toMatch(UUID);
  });

  it("gives exactly one of two calls in the same statement the lease", async () => {
    const h = await copyOf(exported);
    const both = await h.asService((tx) =>
      one<{ a: string | null; b: string | null }>(
        tx,
        "select public.funnelfox_leads_acquire_lease($1::uuid, 60) as a, public.funnelfox_leads_acquire_lease($1::uuid, 60) as b",
        [owner],
      ),
    );
    expect([both.a, both.b].filter(Boolean)).toHaveLength(1);
  });

  it("creates the state row on the first call, per owner, and touches nothing but the lease", async () => {
    const h = await copyOf(exported);
    expect(await one<{ n: number }>(h.db, "select count(*)::int as n from public.funnelfox_leads_sync_state where auth_user_id = $1", [other])).toEqual({ n: 0 });
    expect(await acquire(h, other)).toMatch(UUID);
    const created = await one(
      h.db,
      "select lease_until is not null as leased, profiles_completed, current_stage from public.funnelfox_leads_sync_state where auth_user_id = $1",
      [other],
    );
    expect(created).toEqual({ leased: true, profiles_completed: false, current_stage: null });
    // Independent of the owner's lease.
    expect(await acquire(h, owner)).toMatch(UUID);

    await h.db.query("update public.funnelfox_leads_sync_state set lease_until = null, last_profiles_cursor = 'cur-1', current_stage = 'sessions' where auth_user_id = $1", [owner]);
    const token = await acquire(h, owner);
    expect(token).toMatch(UUID);
    await release(h, owner, token);
    expect(
      await one(h.db, "select lease_until, lease_token, last_profiles_cursor, current_stage from public.funnelfox_leads_sync_state where auth_user_id = $1", [owner]),
    ).toEqual({ lease_until: null, lease_token: null, last_profiles_cursor: "cur-1", current_stage: "sessions" });
  });

  it("rejects a missing key or an out-of-range duration; releasing without a state row is a no-op", async () => {
    const h = await copyOf(exported);
    await expect(acquire(h, null)).rejects.toThrow(/p_data_key is required/);
    for (const seconds of [null, 0, -5, 3601]) {
      await expect(acquire(h, owner, seconds), String(seconds)).rejects.toThrow(/p_seconds must be between 1 and 3600/);
    }
    await expect(release(h, other, "00000000-0000-0000-0000-000000000000")).resolves.toBeDefined();
    await expect(release(h, null, null)).resolves.toBeDefined();
    expect((await one<{ n: number }>(h.db, "select count(*)::int as n from public.funnelfox_leads_sync_state where auth_user_id = $1", [other])).n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// leads_profile_candidates
// ---------------------------------------------------------------------------

describe("leads_profile_candidates(p_data_key)", { timeout: CLONE_TIMEOUT }, () => {
  interface Candidates {
    profile_leads: Array<Record<string, unknown>>;
    subscription_leads: Array<Record<string, unknown>>;
    kpis: Record<string, number>;
  }

  async function seed(): Promise<SupabasePglite> {
    const h = await copyOf(exported);
    await h.db.query("delete from public.funnelfox_leads");
    await h.db.query(
      `insert into public.funnels (funnel_path, display_name, funnelfox_funnel_id)
       values ('soulmate-sketch', 'Soulmate', 'FUN-SOUL'), ('palm-reading', 'Palm', 'FUN-PALM')`,
    );

    // Profiles.
    await insertLead(h, { owner, profileId: "p-dup-late", email: "dup@example.com", createdAt: "2026-09-02T00:00:00Z", funnelId: "FUN-SOUL" });
    await insertLead(h, {
      owner, profileId: "p-dup-early", email: " DUP@example.com", createdAt: "2026-09-01T00:00:00Z", funnelId: "FUN-PALM",
      campaignPath: "session-path", campaignId: "123", utmSource: "fb_john", mediaBuyer: "John", countryCode: "US",
      userAgent: "UA/1.0", origin: "https://funnel.example.com/?utm_source=fb_john",
    });
    await insertLead(h, { owner, profileId: "p-registry", email: "registry@example.com", createdAt: "2026-08-20T00:00:00Z", funnelId: "FUN-SOUL", campaignPath: " " });
    await insertLead(h, { owner, profileId: "p-paid", email: "paid@example.com", createdAt: "2026-09-03T00:00:00Z" });
    await insertLead(h, { owner, profileId: "p-active", email: "active@example.com", createdAt: "2026-09-03T00:00:00Z" });
    await insertLead(h, { owner, profileId: "p-preview", email: "preview@example.com", preview: true, createdAt: "2026-09-03T00:00:00Z" });
    await insertLead(h, { owner, profileId: "p-warehouse", email: "wh@example.com", createdAt: "2026-09-05T00:00:00Z", funnelId: "FUN-UNKNOWN" });
    await insertLead(h, { owner, profileId: "p-nodate", email: "nodate@example.com", sessionCreatedAt: "2026-08-01T00:00:00Z" });
    await insertLead(h, { owner, profileId: "p-noemail", createdAt: "2026-09-04T00:00:00Z" });
    await insertLead(h, { owner: other, profileId: "q-lead", email: "other-lead@example.com", createdAt: "2026-09-01T00:00:00Z" });

    // Warehouse.
    await insertTransaction(h, { owner, email: " PAID@Example.com", status: "success", type: "trial" });
    await insertTransaction(h, { owner, email: "wh@example.com", status: "failed", type: "trial" });
    await insertTransaction(h, { owner, email: "wh@example.com", status: "success", type: "trial", deleted: true });
    await insertTransaction(h, { owner, email: "subfail@example.com", status: "failed", type: "trial" });
    await insertTransaction(h, { owner: other, email: "sub-cross@example.com", status: "success", type: "trial" });
    await insertTransaction(h, { owner: other, email: "dup@example.com", status: "success", type: "trial" });

    // Subscriptions (none of them active unless stated).
    await insertSubscription(h, {
      owner, id: "s-01", email: "sublead@example.com", profileId: "prof-1", price: 0, periodEndsAt: past(), createdAt: "2026-09-10T00:00:00Z",
      rawDetail: { funnel: { alias: "soulmate-sketch", title: "Soulmate Sketch" } },
    });
    // Paid and not cancelled: skipped; its cancelled sibling qualifies (first qualifying by subscription_id).
    await insertSubscription(h, { owner, id: "s-02", email: "paidsub@example.com", price: 29.99, periodEndsAt: past(), createdAt: "2026-06-02T00:00:00Z" });
    await insertSubscription(h, {
      owner, id: "s-03", email: "paidsub@example.com", price: 29.99, status: "cancelled", renews: false, periodEndsAt: past(),
      createdAt: "2026-06-01T00:00:00Z", rawList: { funnel: { alias: "past-life-reading" } },
    });
    await insertSubscription(h, { owner, id: "s-04", email: "active@example.com" }); // active
    await insertSubscription(h, { owner, id: "s-05", email: "subfail@example.com", periodEndsAt: past() }); // in the warehouse
    await insertSubscription(h, { owner, id: "s-06", email: "dup@example.com", periodEndsAt: past() }); // already a profile lead
    await insertSubscription(h, {
      owner, id: "s-07", email: "nodatesub@example.com", periodEndsAt: past(),
      rawList: { period_starts_at: "2026-07-01T00:00:00Z", funnel: { title: "Starseed reading" } },
      rawDetail: { status: "expired" },
    });
    await insertSubscription(h, { owner, id: "s-08", email: "sub-cross@example.com", periodEndsAt: past(), createdAt: "2026-05-01T00:00:00Z" });
    // renews=false counts as cancelled, so a priced one still qualifies once its period is over; the
    // column alias is the fallback.
    await insertSubscription(h, {
      owner, id: "s-09", email: "renewsfalse@example.com", price: 10, renews: false, periodEndsAt: past(), createdAt: "2026-04-01T00:00:00Z",
      funnel: "my-starseed",
    });
    // Priced and cancelled (renews=false) but still inside the paid period: a paying customer (the
    // browser's is_active_now excluded it), never a subscription-only lead — even with an older free
    // subscription that would qualify on its own.
    await insertSubscription(h, { owner, id: "s-10", email: "inperiod@example.com", price: 29.99, status: "cancelled", renews: false, periodEndsAt: future(), createdAt: "2026-09-12T00:00:00Z" });
    await insertSubscription(h, { owner, id: "s-11", email: "inperiod@example.com", periodEndsAt: past(), createdAt: "2026-03-01T00:00:00Z" });
    await insertSubscription(h, { owner: other, id: "q-01", email: "other-sub@example.com", periodEndsAt: past() });
    return h;
  }

  it("returns exactly the contract shape (no user_agent / origin in the bulk read)", async () => {
    const h = await seed();
    const result = await rpc<Candidates>(h, "public.leads_profile_candidates($1::uuid)", [owner]);
    expect(Object.keys(result).sort()).toEqual(["kpis", "profile_leads", "profile_leads_total", "profile_leads_truncated", "subscription_leads"]);
    expect(Object.keys(result.kpis).sort()).toEqual(["active_subs_excluded", "converted_excluded", "emails_found"]);
    for (const row of result.profile_leads) {
      expect(Object.keys(row).sort()).toEqual([
        "campaign_id", "campaign_path", "country", "email", "funnel_id", "lead_date", "media_buyer", "profile_id", "utm_source",
      ]);
    }
    for (const row of result.subscription_leads) {
      expect(Object.keys(row).sort()).toEqual(["customer_id", "email", "funnel", "lead_date"]);
    }
    expect(result).toMatchObject({ profile_leads_total: 4, profile_leads_truncated: false });
  });

  it("p_profile_limit keeps the newest profile leads and reports the uncapped total", async () => {
    const h = await seed();
    const capped = await rpc<Candidates & { profile_leads_total: number; profile_leads_truncated: boolean }>(
      h,
      "public.leads_profile_candidates($1::uuid, $2::int)",
      [owner, 2],
    );
    expect(capped.profile_leads.map((row) => row.profile_id)).toEqual(["p-warehouse", "p-dup-early"]);
    expect(capped).toMatchObject({ profile_leads_total: 4, profile_leads_truncated: true });
    // The cap never changes what else is excluded or counted.
    const full = await rpc<Candidates>(h, "public.leads_profile_candidates($1::uuid)", [owner]);
    expect(capped.subscription_leads).toEqual(full.subscription_leads);
    expect(capped.kpis).toEqual(full.kpis);
    expect(await rpc(h, "public.leads_profile_candidates($1::uuid, $2::int)", [owner, 4])).toMatchObject({ profile_leads_total: 4, profile_leads_truncated: false });
    expect(await rpc(h, "public.leads_profile_candidates($1::uuid, $2::int)", [owner, 0])).toMatchObject({ profile_leads: [], profile_leads_total: 4, profile_leads_truncated: true });
  });

  it("one impossible period_starts_at never fails the read: that lead's date is null", async () => {
    const h = await seed();
    await insertSubscription(h, { owner, id: "s-20", email: "feb30@example.com", periodEndsAt: past(), rawList: { period_starts_at: "2026-02-30T00:00:00Z" } });
    await insertSubscription(h, { owner, id: "s-21", email: "month13@example.com", periodEndsAt: past(), rawDetail: { period_starts_at: "2026-13-01" } });
    await insertSubscription(h, { owner, id: "s-22", email: "word@example.com", periodEndsAt: past(), rawDetail: { period_starts_at: "now" } });
    const { subscription_leads } = await rpc<Candidates>(h, "public.leads_profile_candidates($1::uuid)", [owner]);
    const byEmail = Object.fromEntries(subscription_leads.map((row) => [row.email, row.lead_date]));
    expect(byEmail["feb30@example.com"]).toBeNull();
    expect(byEmail["month13@example.com"]).toBeNull();
    expect(byEmail["word@example.com"]).toBeNull();
    // A valid one still parses.
    expect(iso(byEmail["nodatesub@example.com"])).toBe("2026-07-01T00:00:00.000Z");
  });

  it("profile leads: email, not preview, not paid, not active; one row per email (earliest); registry campaign_path fallback", async () => {
    const h = await seed();
    const { profile_leads } = await rpc<Candidates>(h, "public.leads_profile_candidates($1::uuid)", [owner]);
    expect(profile_leads.map((row) => ({ ...row, lead_date: iso(row.lead_date) }))).toEqual([
      {
        profile_id: "p-warehouse", email: "wh@example.com", lead_date: "2026-09-05T00:00:00.000Z", funnel_id: "FUN-UNKNOWN",
        campaign_path: null, campaign_id: null, utm_source: null, media_buyer: null, country: null,
      },
      {
        profile_id: "p-dup-early", email: "dup@example.com", lead_date: "2026-09-01T00:00:00.000Z", funnel_id: "FUN-PALM",
        // The session's own path wins over the registry's. (user_agent / origin are read per page.)
        campaign_path: "session-path", campaign_id: "123", utm_source: "fb_john", media_buyer: "John", country: "US",
      },
      {
        profile_id: "p-registry", email: "registry@example.com", lead_date: "2026-08-20T00:00:00.000Z", funnel_id: "FUN-SOUL",
        campaign_path: "soulmate-sketch", campaign_id: null, utm_source: null, media_buyer: null, country: null,
      },
      {
        // No profile date: the session date.
        profile_id: "p-nodate", email: "nodate@example.com", lead_date: "2026-08-01T00:00:00.000Z", funnel_id: null,
        campaign_path: null, campaign_id: null, utm_source: null, media_buyer: null, country: null,
      },
    ]);
  });

  it("a profile whose OWN subscription shows a paying customer under another email is not a lead", async () => {
    const h = await seed();
    await seedLinkedSubscriptions(h);
    const { profile_leads, subscription_leads } = await rpc<Candidates>(h, "public.leads_profile_candidates($1::uuid)", [owner]);
    const quiz = profile_leads.map((row) => row.profile_id).filter((id) => String(id).startsWith("p-quiz"));
    expect(quiz).toEqual(["p-quiz4"]);
    // The checkout emails: paid (warehouse), paid and in period, active — none is a lead; the
    // control's free expired subscription is (the browser's subscription-only rule).
    expect(subscription_leads.map((row) => row.email).filter((email) => String(email).startsWith("checkout"))).toEqual(["checkout4@example.com"]);
  });

  it("subscription-only leads mirror src/services/leads.ts", async () => {
    const h = await seed();
    const { subscription_leads } = await rpc<Candidates>(h, "public.leads_profile_candidates($1::uuid)", [owner]);
    expect(subscription_leads.map((row) => ({ ...row, lead_date: iso(row.lead_date) }))).toEqual([
      { email: "sublead@example.com", lead_date: "2026-09-10T00:00:00.000Z", funnel: "soulmate", customer_id: "prof-1" },
      // No created_at: period_starts_at; funnel from the title.
      { email: "nodatesub@example.com", lead_date: "2026-07-01T00:00:00.000Z", funnel: "starseed", customer_id: "s-07" },
      // s-02 (paid, not cancelled) is skipped, s-03 qualifies.
      { email: "paidsub@example.com", lead_date: "2026-06-01T00:00:00.000Z", funnel: "past_life", customer_id: "s-03" },
      // Another account's payment does not exclude the owner's contact.
      { email: "sub-cross@example.com", lead_date: "2026-05-01T00:00:00.000Z", funnel: "unknown", customer_id: "s-08" },
      { email: "renewsfalse@example.com", lead_date: "2026-04-01T00:00:00.000Z", funnel: "starseed", customer_id: "s-09" },
      // inperiod@ (s-10 priced, cancelled, still in its paid period) is not listed, s-11 notwithstanding.
    ]);
  });

  it("counts the KPIs over distinct emails", async () => {
    const h = await seed();
    const { kpis } = await rpc<Candidates>(h, "public.leads_profile_candidates($1::uuid)", [owner]);
    // warehouse: paid, wh, subfail | profiles (non-preview): dup, registry, paid, active, wh, nodate |
    // subscriptions: sublead, paidsub, active, subfail, dup, nodatesub, sub-cross, renewsfalse, inperiod
    expect(kpis).toEqual({ emails_found: 13, converted_excluded: 1, active_subs_excluded: 1 });
  });

  it("is scoped to the given owner; a null key returns nothing", async () => {
    const h = await seed();
    const forOther = await rpc<Candidates>(h, "public.leads_profile_candidates($1::uuid)", [other]);
    expect(forOther.profile_leads.map((row) => row.email)).toEqual(["other-lead@example.com"]);
    expect(forOther.subscription_leads.map((row) => row.email)).toEqual(["other-sub@example.com"]);
    // The other account's own paid emails: sub-cross and dup.
    expect(forOther.kpis).toEqual({ emails_found: 4, converted_excluded: 2, active_subs_excluded: 0 });

    const empty = {
      profile_leads: [], profile_leads_total: 0, profile_leads_truncated: false, subscription_leads: [],
      kpis: { emails_found: 0, converted_excluded: 0, active_subs_excluded: 0 },
    };
    expect(await rpc(h, "public.leads_profile_candidates($1::uuid)", [null])).toEqual(empty);
  });
});

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------

describe("grants", { timeout: CLONE_TIMEOUT }, () => {
  const SERVICE_ONLY = [
    "public.funnelfox_leads_reconcile(uuid)",
    "public.funnelfox_leads_acquire_lease(uuid, integer)",
    "public.funnelfox_leads_release_lease(uuid, uuid)",
    "public.leads_profile_candidates(uuid, integer)",
    "public.leads_try_timestamptz(text)",
  ];

  it("leaves no earlier signature behind", async () => {
    for (const signature of ["public.funnelfox_leads_release_lease(uuid)", "public.leads_profile_candidates(uuid)"]) {
      expect((await one(full.db, "select to_regprocedure($1) as fn", [signature])).fn, signature).toBeNull();
    }
  });

  it("the RPCs are SECURITY INVOKER, pin search_path and are executable by service_role only", async () => {
    for (const signature of SERVICE_ONLY) {
      const row = await one(
        full.db,
        `select has_function_privilege('anon', $1, 'execute') as anon,
                has_function_privilege('authenticated', $1, 'execute') as authenticated,
                has_function_privilege('service_role', $1, 'execute') as service,
                coalesce(array_to_string(p.proacl, ',') ~ '(^|,)=X', true) as public_acl,
                p.prosecdef as definer,
                p.proconfig as config
         from pg_proc p where p.oid = $1::regprocedure`,
        [signature],
      );
      expect(row, signature).toEqual({ anon: false, authenticated: false, service: true, public_acl: false, definer: false, config: ['search_path=""'] });
    }
  });

  it("browser roles are refused", async () => {
    for (const call of [
      "public.funnelfox_leads_reconcile($1::uuid)",
      "public.funnelfox_leads_acquire_lease($1::uuid, 60)",
      "public.funnelfox_leads_release_lease($1::uuid, null)",
      "public.leads_profile_candidates($1::uuid)",
      "public.leads_try_timestamptz($1::text)",
    ]) {
      await expect(full.asUser(owner, (tx) => tx.query(`select ${call}`, [owner])), call).rejects.toThrow(/permission denied for function/);
      await expect(full.asAnon((tx) => tx.query(`select ${call}`, [owner])), call).rejects.toThrow(/permission denied for function/);
    }
  });

  it("the cron sender is SECURITY DEFINER with a pinned search_path and closed to every API role", async () => {
    const row = await one(
      full.db,
      `select has_function_privilege('anon', $1, 'execute') as anon,
              has_function_privilege('authenticated', $1, 'execute') as authenticated,
              has_function_privilege('service_role', $1, 'execute') as service,
              coalesce(array_to_string(p.proacl, ',') ~ '(^|,)=X', true) as public_acl,
              p.prosecdef as definer,
              p.proconfig as config
       from pg_proc p where p.oid = $1::regprocedure`,
      ["public.invoke_funnelfox_leads_sync(boolean)"],
    );
    expect(row).toEqual({ anon: false, authenticated: false, service: false, public_acl: false, definer: true, config: ['search_path=""'] });
  });
});

// ---------------------------------------------------------------------------
// 202610060011: cron
// ---------------------------------------------------------------------------

describe("cron migration", { timeout: CLONE_TIMEOUT }, () => {
  const jobs = async (h: SupabasePglite) =>
    (await h.db.query("select jobname, schedule, command from cron.job where jobname like 'funnelfox-leads-%' order by jobname")).rows;
  const requests = async (h: SupabasePglite) =>
    (await h.db.query<{ url: string; headers: Record<string, string>; body: Record<string, unknown>; timeout_milliseconds: number }>(
      "select url, headers, body, timeout_milliseconds from net.stub_requests where url like '%/funnelfox-leads-sync' order by id",
    )).rows;
  const invoke = async (h: SupabasePglite, fullReset: boolean) =>
    (await one<{ skipped: boolean }>(h.db, "select public.invoke_funnelfox_leads_sync($1) is null as skipped", [fullReset])).skipped;

  it("schedules the minute advance tick and the 06:15 refresh, idempotently", async () => {
    const expected = [
      { jobname: "funnelfox-leads-advance", schedule: "* * * * *", command: "select public.invoke_funnelfox_leads_sync(false)" },
      { jobname: "funnelfox-leads-refresh", schedule: "15 6 * * *", command: "select public.invoke_funnelfox_leads_sync(true)" },
    ];
    expect(await jobs(full)).toEqual(expected);
    const h = await copyOf(full);
    await h.applyMigration(CRON);
    expect(await jobs(h)).toEqual(expected);
    // The subscriptions jobs it must run after are untouched.
    expect((await h.db.query("select schedule from cron.job where jobname = 'funnelfox-subscriptions-refresh'")).rows).toEqual([{ schedule: "45 5 * * *" }]);
  });

  it("posts the workspace data key, the cron secret and explicit paging to funnelfox-leads-sync", async () => {
    const h = await copyOf(full);
    // The body never trusts fb_cron_config.auth_user_id.
    await h.db.query("update public.fb_cron_config set auth_user_id = $1", [other]);
    expect(await invoke(h, true)).toBe(false);
    expect(await invoke(h, false)).toBe(false);
    const sent = await requests(h);
    expect(sent).toHaveLength(2);
    for (const [index, fullReset] of [[0, true], [1, false]] as const) {
      expect(sent[index]).toEqual({
        url: "https://project.supabase.co/functions/v1/funnelfox-leads-sync",
        headers: { "Content-Type": "application/json", "x-cron-secret": "cron-secret", Authorization: "Bearer anon-jwt", apikey: "anon-jwt" },
        body: { auth_user_id: owner, full_reset: fullReset, limit: 100, max_pages: 200 },
        timeout_milliseconds: 150000,
      });
    }
  });

  it("the advance tick skips the call while a lease is held or once every stage is complete; the refresh always posts", async () => {
    const h = await copyOf(full);
    const token = await rpc<string>(h, "public.funnelfox_leads_acquire_lease($1::uuid, 120)", [owner]);
    expect(await invoke(h, false)).toBe(true);
    expect(await invoke(h, true)).toBe(false);

    await h.asService((tx) => tx.query("select public.funnelfox_leads_release_lease($1::uuid, $2::uuid)", [owner, token]));
    expect(await invoke(h, false)).toBe(false);

    await h.db.query(
      `update public.funnelfox_leads_sync_state
       set profiles_completed = true, details_completed = true, sessions_completed = true, reconcile_completed = true
       where auth_user_id = $1`,
      [owner],
    );
    expect(await invoke(h, false)).toBe(true);
    expect(await invoke(h, true)).toBe(false);

    // An expired lease does not block; a pipeline with any stage left is advanced.
    await h.db.query(
      "update public.funnelfox_leads_sync_state set reconcile_completed = false, lease_until = now() - interval '1 minute' where auth_user_id = $1",
      [owner],
    );
    expect(await invoke(h, false)).toBe(false);
    expect((await requests(h)).map((request) => request.body.full_reset)).toEqual([true, false, true, false]);
  });

  it("the advance tick also waits out a FunnelFox 429 pause (stats.rate_limited_until); the refresh still posts", async () => {
    const h = await copyOf(full);
    const setUntil = (value: string | null) =>
      h.db.query("update public.funnelfox_leads_sync_state set stats = $2::jsonb where auth_user_id = $1", [
        owner,
        JSON.stringify({ rate_limited_until: value }),
      ]);
    await setUntil(new Date(Date.now() + 120_000).toISOString());
    expect(await invoke(h, false)).toBe(true);
    expect(await invoke(h, true)).toBe(false);
    // Over, cleared or unparsable: the tick posts.
    for (const value of [new Date(Date.now() - 60_000).toISOString(), null, "not-a-date"]) {
      await setUntil(value);
      expect(await invoke(h, false), String(value)).toBe(false);
    }
    expect((await requests(h)).map((request) => request.body.full_reset)).toEqual([true, false, false, false]);
  });

  it("the advance tick waits out the backoff after FunnelFox errors (stats.error_backoff_until); the refresh still posts", async () => {
    const h = await copyOf(full);
    const setUntil = (value: string | null) =>
      h.db.query("update public.funnelfox_leads_sync_state set last_status = 'error', stats = $2::jsonb where auth_user_id = $1", [
        owner,
        JSON.stringify({ consecutive_api_errors: 4, error_backoff_until: value }),
      ]);
    await setUntil(new Date(Date.now() + 480_000).toISOString());
    expect(await invoke(h, false)).toBe(true);
    expect(await invoke(h, true)).toBe(false);
    for (const value of [new Date(Date.now() - 1_000).toISOString(), null, "garbage"]) {
      await setUntil(value);
      expect(await invoke(h, false), String(value)).toBe(false);
    }
    expect((await requests(h)).map((request) => request.body.full_reset)).toEqual([true, false, false, false]);
  });

  it("posts when there is no sync state yet, and skips quietly without config", async () => {
    const h = await copyOf(full);
    await h.db.query("delete from public.funnelfox_leads_sync_state");
    expect(await invoke(h, false)).toBe(false);
    await h.db.query("delete from public.fb_cron_config");
    expect(await invoke(h, false)).toBe(true);
    expect(await invoke(h, true)).toBe(true);
    expect(await requests(h)).toHaveLength(1);
  });

  it("refuses to apply before the export migration, and schedules nothing", async () => {
    const h = await copyOf(legacy);
    await expect(h.applyMigration(CRON)).rejects.toThrow(/202610060010_funnelfox_leads_export\.sql has not been applied/);
    expect(await jobs(h)).toEqual([]);
    expect((await h.db.query("select to_regprocedure('public.invoke_funnelfox_leads_sync(boolean)') as fn")).rows[0]).toEqual({ fn: null });
  });
});
