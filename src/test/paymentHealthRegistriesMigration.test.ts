// Executable tests for supabase/migrations/202610110002_payment_health_registries.sql
// (Payment System Health P1: the psp_accounts MID registry and
// network_program_thresholds), run against PGlite through the Supabase
// stand-in in ./support/pgliteSupabase.ts.
//
// The database is the production shape the migration lands on: every earlier
// migration (pg_cron / pg_net stubbed), the workspace bootstrapped before the
// RLS lockdown, the lockdown and the leads series through 202610070001.
//
// Covers: the guard (refuses before 202610070001, creates nothing); seeding
// psp_accounts from synthetic transactions (normalized processor / MID, "Stripe
// MID #n" / "Adyen MID #n" by first-seen order, first / last seen, the other
// account's and the deleted / incomplete rows ignored, the raw MID never in a
// label); uniqueness and the check constraints; idempotent re-apply (labels,
// manual fields and owner-edited thresholds kept, the seed call incremental);
// psp_accounts_sync for new MIDs, incremental on transactions.updated_at with
// the one-hour overlap and p_full; grants and RLS (no browser role,
// service_role select / insert / update only, updated_at trigger); the
// threshold seed (plan D values, source URLs, last_verified_at, the retry rules
// flagged unverified) and its natural key; function privileges; the lockdown's
// fail-closed block still passing.
//
// Every MID, id and email here is synthetic. Runs in the default jsdom
// environment (src/test/setup.ts needs `window`).
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createSupabasePglite, listMigrations, readMigration, type SqlRunner, type SupabasePglite } from "./support/pgliteSupabase";

const LOCKDOWN = "202610050003_access_rls_lockdown.sql";
const RECENT = "202610070001_leads_recent_candidates.sql";
const REGISTRIES = "202610110002_payment_health_registries.sql";

// Each test works on a clone of a ~100-migration database (1-2 s, more under load).
const CLONE_TIMEOUT = 60_000;

let beforeRecent: SupabasePglite; // everything before 202610070001 (the guard)
let ready: SupabasePglite; // everything before REGISTRIES + the fixture transactions
let applied: SupabasePglite; // ready + REGISTRIES (read-only tests)
let owner: string; // the workspace data key
let other: string; // another account with its own rows
const opened: SupabasePglite[] = [];

async function copyOf(source: SupabasePglite): Promise<SupabasePglite> {
  const copy = await source.clone();
  opened.push(copy);
  return copy;
}

async function one<T = Record<string, unknown>>(tx: SqlRunner, sql: string, params: unknown[] = []): Promise<T> {
  return (await tx.query<T>(sql, params)).rows[0];
}

const iso = (value: unknown) => (value == null ? null : new Date(value as string).toISOString());

interface TransactionSpec {
  owner: string;
  time: string;
  processor?: string | null;
  mid?: string | null;
  deleted?: boolean;
  /** transactions.updated_at (the sync's watermark); default now(), as an import writes it. */
  updatedAt?: string;
}

/** The fixture rows were "imported" long ago: their updated_at predates any sync watermark by more than the overlap. */
const OLD_UPDATED_AT = "2026-01-01T00:00:00Z";

let txSeq = 0;
async function insertTransaction(h: SupabasePglite, row: TransactionSpec) {
  txSeq += 1;
  const raw: Record<string, unknown> = {};
  if (row.processor !== undefined) raw.processor = row.processor;
  if (row.mid !== undefined) raw.processorMerchantId = row.mid;
  await h.db.query(
    `insert into public.transactions (auth_user_id, transaction_id, event_time, status, raw_payload, deleted_at, updated_at)
     values ($1, $2, $3, 'failed', $4::jsonb, case when $5 then now() end, coalesce($6::timestamptz, now()))`,
    [row.owner, `tx-${txSeq}`, row.time, JSON.stringify(raw), row.deleted ?? false, row.updatedAt ?? null],
  );
}

/** The processor x MID shapes the seed must handle (synthetic MIDs). */
async function seedTransactions(h: SupabasePglite) {
  const seeded = (row: Omit<TransactionSpec, "updatedAt">) => insertTransaction(h, { ...row, updatedAt: OLD_UPDATED_AT });
  await seeded({ owner, time: "2026-03-11T10:00:00Z", processor: "STRIPE", mid: "mid-stripe-a" });
  await seeded({ owner, time: "2026-04-01T10:00:00Z", processor: "STRIPE", mid: "mid-stripe-a" });
  // Case and whitespace variants normalize into the same account and extend last_seen_at.
  await seeded({ owner, time: "2026-09-01T10:00:00Z", processor: " stripe ", mid: " mid-stripe-a " });
  await seeded({ owner, time: "2026-05-01T10:00:00Z", processor: "STRIPE", mid: "mid-stripe-b" });
  await seeded({ owner, time: "2026-07-30T10:00:00Z", processor: "ADYEN", mid: "mid-adyen-a" });
  await seeded({ owner, time: "2026-10-05T10:00:00Z", processor: "ADYEN", mid: "mid-adyen-a" });
  // Ignored: no MID, no processor, an empty processor, a deleted row, no raw payload at all.
  await seeded({ owner, time: "2026-06-01T10:00:00Z", processor: "STRIPE" });
  await seeded({ owner, time: "2026-06-02T10:00:00Z", processor: "STRIPE", mid: null });
  await seeded({ owner, time: "2026-06-03T10:00:00Z", mid: "mid-ghost" });
  await seeded({ owner, time: "2026-06-04T10:00:00Z", processor: "  ", mid: "mid-empty" });
  await seeded({ owner, time: "2026-06-05T10:00:00Z", processor: "ADYEN", mid: "mid-deleted", deleted: true });
  await seeded({ owner, time: "2026-06-06T10:00:00Z" });
  // Another account's MID never reaches the owner's registry.
  await seeded({ owner: other, time: "2026-08-01T10:00:00Z", processor: "STRIPE", mid: "mid-other" });
}

interface SyncState {
  auth_user_id: string;
  synced_through: string;
  scanned_rows: number;
  last_full_scan: boolean;
}

async function syncStates(h: SupabasePglite): Promise<SyncState[]> {
  const rows = await h.db.query<SyncState>("select auth_user_id, synced_through, scanned_rows, last_full_scan from public.psp_accounts_sync_state order by auth_user_id");
  return rows.rows.map((row) => ({ ...row, synced_through: iso(row.synced_through)! }));
}

interface Account {
  processor: string;
  processor_merchant_id: string;
  seq: number;
  label: string;
  first_seen_at: string;
  last_seen_at: string;
  legal_entity: string | null;
  programs: unknown;
  manual_status: unknown;
}

async function accountsOf(h: SupabasePglite, key: string): Promise<Account[]> {
  const rows = await h.db.query<Account>(
    `select processor, processor_merchant_id, seq, label, first_seen_at, last_seen_at, legal_entity, programs, manual_status
     from public.psp_accounts where auth_user_id = $1 order by processor, seq`,
    [key],
  );
  return rows.rows.map((row) => ({ ...row, first_seen_at: iso(row.first_seen_at)!, last_seen_at: iso(row.last_seen_at)! }));
}

const EXPECTED_OWNER_ACCOUNTS = [
  { processor: "ADYEN", processor_merchant_id: "mid-adyen-a", seq: 1, label: "Adyen MID #1", first_seen_at: "2026-07-30T10:00:00.000Z", last_seen_at: "2026-10-05T10:00:00.000Z" },
  { processor: "STRIPE", processor_merchant_id: "mid-stripe-a", seq: 1, label: "Stripe MID #1", first_seen_at: "2026-03-11T10:00:00.000Z", last_seen_at: "2026-09-01T10:00:00.000Z" },
  { processor: "STRIPE", processor_merchant_id: "mid-stripe-b", seq: 2, label: "Stripe MID #2", first_seen_at: "2026-05-01T10:00:00.000Z", last_seen_at: "2026-05-01T10:00:00.000Z" },
];

beforeAll(async () => {
  const base = await createSupabasePglite({ migrations: listMigrations({ before: LOCKDOWN }), extensionStubs: true });
  owner = await base.createAuthUser("owner@example.com");
  other = await base.createAuthUser("other@example.com");
  await base.db.query("select public.bootstrap_workspace($1, 'SubEngine')", [owner]);
  for (const name of listMigrations().filter((migration) => migration >= LOCKDOWN && migration < REGISTRIES)) {
    if (name === RECENT) beforeRecent = await base.clone();
    await base.applyMigration(name);
  }
  await seedTransactions(base);
  ready = base;
  applied = await ready.clone();
  await applied.applyMigration(REGISTRIES);
}, 300_000);

afterEach(async () => {
  while (opened.length) await opened.pop()!.close();
});

describe("guard", () => {
  it("follows P0 and covers every migration before it", () => {
    // Relative ordering only: pinning "last migration" breaks on the next file (P2 permissions did).
    const all = listMigrations();
    const i = all.indexOf(REGISTRIES);
    expect(i).toBeGreaterThan(all.indexOf("202610110001_payment_health_p0.sql"));
    expect(listMigrations({ before: REGISTRIES })).toEqual(all.slice(0, i));
    expect(all.indexOf("202610120001_payment_health_permissions.sql")).toBe(i + 1);
  });

  it("refuses to apply before 202610070001, and creates nothing", { timeout: CLONE_TIMEOUT }, async () => {
    const h = await copyOf(beforeRecent);
    await expect(h.applyMigration(REGISTRIES)).rejects.toThrow(/202610070001_leads_recent_candidates\.sql has not been applied/);
    expect(
      await one(h.db, `select to_regclass('public.psp_accounts') as accounts, to_regclass('public.psp_accounts_sync_state') as sync_state,
                        to_regclass('public.network_program_thresholds') as thresholds,
                        to_regprocedure('public.psp_accounts_sync(uuid, boolean)') as sync, to_regprocedure('public.payment_health_set_updated_at()') as trigger_fn`),
    ).toEqual({ accounts: null, sync_state: null, thresholds: null, sync: null, trigger_fn: null });
  });
});

describe("psp_accounts: seeded from the workspace data key's transactions", () => {
  it("registers each processor x MID once, labelled 'Stripe MID #n' / 'Adyen MID #n' by first-seen order, with first / last seen", async () => {
    const accounts = await accountsOf(applied, owner);
    expect(accounts.map(({ legal_entity: _legal, programs: _programs, manual_status: _status, ...rest }) => rest)).toEqual(EXPECTED_OWNER_ACCOUNTS);
    for (const account of accounts) {
      expect(account.legal_entity).toBeNull();
      expect(account.programs).toEqual([]);
      expect(account.manual_status).toEqual({});
      // The raw MID is a registry value, never part of what the UI shows.
      expect(account.label).not.toContain(account.processor_merchant_id);
      expect(account.label).toMatch(/^(Stripe|Adyen) MID #\d+$/);
    }
    // Only the owner's rows: the other account's MID and the ignored shapes are absent.
    expect(await accountsOf(applied, other)).toEqual([]);
    const mids = (await applied.db.query<{ mid: string }>("select processor_merchant_id as mid from public.psp_accounts")).rows.map((row) => row.mid).sort();
    expect(mids).toEqual(["mid-adyen-a", "mid-stripe-a", "mid-stripe-b"]);
    // The seed left a watermark for the owner (a full scan: the 6 live rows with a processor and a MID) and for nobody else.
    expect(await syncStates(applied)).toEqual([{ auth_user_id: owner, synced_through: expect.any(String), scanned_rows: 6, last_full_scan: true }]);
  });

  it("has the documented shape", async () => {
    const columns = await applied.db.query<{ column_name: string; data_type: string; is_nullable: string }>(
      `select column_name, data_type, is_nullable from information_schema.columns
       where table_schema = 'public' and table_name = 'psp_accounts' order by ordinal_position`,
    );
    expect(columns.rows).toEqual([
      { column_name: "id", data_type: "uuid", is_nullable: "NO" },
      { column_name: "auth_user_id", data_type: "uuid", is_nullable: "NO" },
      { column_name: "processor", data_type: "text", is_nullable: "NO" },
      { column_name: "processor_merchant_id", data_type: "text", is_nullable: "NO" },
      { column_name: "seq", data_type: "integer", is_nullable: "NO" },
      { column_name: "label", data_type: "text", is_nullable: "NO" },
      { column_name: "legal_entity", data_type: "text", is_nullable: "YES" },
      { column_name: "acquirer_country", data_type: "text", is_nullable: "YES" },
      { column_name: "descriptor_prefix", data_type: "text", is_nullable: "YES" },
      { column_name: "programs", data_type: "jsonb", is_nullable: "NO" },
      { column_name: "manual_status", data_type: "jsonb", is_nullable: "NO" },
      { column_name: "first_seen_at", data_type: "timestamp with time zone", is_nullable: "YES" },
      { column_name: "last_seen_at", data_type: "timestamp with time zone", is_nullable: "YES" },
      { column_name: "created_at", data_type: "timestamp with time zone", is_nullable: "NO" },
      { column_name: "updated_at", data_type: "timestamp with time zone", is_nullable: "NO" },
    ]);
  });

  it("enforces uniqueness per (data key, processor, MID) and per (data key, processor, seq), and the value checks", { timeout: CLONE_TIMEOUT }, async () => {
    const h = await copyOf(applied);
    const insert = `insert into public.psp_accounts (auth_user_id, processor, processor_merchant_id, seq, label, programs, manual_status)
                    values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)`;
    await expect(h.db.query(insert, [owner, "STRIPE", "mid-stripe-a", 9, "dup", "[]", "{}"])).rejects.toThrow(/psp_accounts_mid_key/);
    await expect(h.db.query(insert, [owner, "STRIPE", "mid-stripe-z", 1, "dup seq", "[]", "{}"])).rejects.toThrow(/psp_accounts_seq_key/);
    await expect(h.db.query(insert, [owner, "stripe", "mid-stripe-z", 9, "lower", "[]", "{}"])).rejects.toThrow(/psp_accounts_processor_check/);
    await expect(h.db.query(insert, [owner, "STRIPE", " mid-stripe-z", 9, "spaced", "[]", "{}"])).rejects.toThrow(/psp_accounts_mid_check/);
    await expect(h.db.query(insert, [owner, "STRIPE", "mid-stripe-z", 0, "zero", "[]", "{}"])).rejects.toThrow(/psp_accounts_seq_check/);
    await expect(h.db.query(insert, [owner, "STRIPE", "mid-stripe-z", 9, "programs", '"x"', "{}"])).rejects.toThrow(/psp_accounts_programs_check/);
    await expect(h.db.query(insert, [owner, "STRIPE", "mid-stripe-z", 9, "status", "[]", "[]"])).rejects.toThrow(/psp_accounts_manual_status_check/);
    // The same MID under another data key is a different account.
    await h.db.query(insert, [other, "STRIPE", "mid-stripe-a", 1, "Stripe MID #1", "[]", "{}"]);
    expect((await accountsOf(h, other)).map((account) => account.processor_merchant_id)).toEqual(["mid-stripe-a"]);
  });

  it("re-applying keeps the owner's labels, manual fields and verified thresholds, adds nothing, and syncs incrementally", { timeout: CLONE_TIMEOUT }, async () => {
    const h = await copyOf(applied);
    await h.asService((tx) =>
      tx.query(
        `update public.psp_accounts set label = 'Main Stripe', legal_entity = 'Example Ltd', acquirer_country = 'US', descriptor_prefix = 'EXAMPLE',
           programs = '["visa_vamp"]'::jsonb,
           manual_status = '{"status": "ok", "source": "acquirer letter", "observed_at": "2026-10-01", "entered_by": "owner"}'::jsonb
         where auth_user_id = $1 and processor = 'STRIPE' and seq = 1`,
        [owner],
      ),
    );
    // The owner confirmed the MAC 03 / 21 rule with the acquirer (owner decision 8) and edited the row.
    await h.asService((tx) =>
      tx.query(
        `update public.network_program_thresholds
         set verified = true, last_verified_at = '2026-11-01', critical_value = 1, notes = 'Confirmed with the acquirer: one repeat within 30 days.'
         where program = 'mc_mac'`,
      ),
    );
    const before = await h.db.query("select * from public.psp_accounts order by processor, seq");
    const thresholdsBefore = await h.db.query("select * from public.network_program_thresholds order by program, metric_key, region, scope, effective_from");
    const [stateBefore] = await syncStates(h);
    await h.applyMigration(REGISTRIES);
    const after = await h.db.query("select * from public.psp_accounts order by processor, seq");
    expect(after.rows).toEqual(before.rows);
    expect(after.rows).toHaveLength(3);
    // Every threshold row survives byte for byte (updated_at included: nothing was touched), the edited one above all.
    const thresholdsAfter = await h.db.query("select * from public.network_program_thresholds order by program, metric_key, region, scope, effective_from");
    expect(thresholdsAfter.rows).toEqual(thresholdsBefore.rows);
    expect(thresholdsAfter.rows).toHaveLength(21);
    const mac = await one<{ verified: boolean; last_verified_at: string; critical_value: string; notes: string }>(
      h.db, "select verified, last_verified_at, critical_value, notes from public.network_program_thresholds where program = 'mc_mac'",
    );
    expect(mac.verified).toBe(true);
    expect(new Date(mac.last_verified_at).toISOString().slice(0, 10)).toBe("2026-11-01");
    expect(Number(mac.critical_value)).toBe(1);
    expect(mac.notes).toMatch(/^Confirmed with the acquirer/);
    const edited = (await accountsOf(h, owner)).find((account) => account.processor_merchant_id === "mid-stripe-a")!;
    expect(edited).toMatchObject({ label: "Main Stripe", legal_entity: "Example Ltd", programs: ["visa_vamp"] });
    expect(edited.manual_status).toMatchObject({ status: "ok", source: "acquirer letter", entered_by: "owner" });
    // The seed call found the watermark: an incremental read of nothing new, not a rescan of the history.
    const [stateAfter] = await syncStates(h);
    expect(stateAfter).toEqual({ auth_user_id: owner, synced_through: expect.any(String), scanned_rows: 0, last_full_scan: false });
    expect(new Date(stateAfter.synced_through).getTime()).toBeGreaterThan(new Date(stateBefore.synced_through).getTime());
  });
});

describe("psp_accounts_sync (service_role): new MIDs after later imports", () => {
  const sync = (h: SupabasePglite, key: string | null, full = false) =>
    h.asService(async (tx) => (await one<{ value: Record<string, unknown> }>(tx, "select public.psp_accounts_sync($1::uuid, $2::boolean) as value", [key, full])).value);

  it("adds the unknown MID with the next number, moves first / last seen outwards, and is a no-op afterwards", { timeout: CLONE_TIMEOUT }, async () => {
    const h = await copyOf(applied);
    await insertTransaction(h, { owner, time: "2026-10-01T10:00:00Z", processor: "STRIPE", mid: "mid-stripe-c" });
    await insertTransaction(h, { owner, time: "2026-07-01T10:00:00Z", processor: "ADYEN", mid: "mid-adyen-a" });
    await insertTransaction(h, { owner, time: "2026-10-06T10:00:00Z", processor: "adyen", mid: "mid-adyen-a" });
    await insertTransaction(h, { owner, time: "2026-10-07T10:00:00Z", processor: "STRIPE", mid: "mid-stripe-d", deleted: true });

    // Incremental: only the three live rows written since the seed are read, not the fixture history.
    expect(await sync(h, owner)).toEqual({ data_key: owner, inserted: 1, updated: 1, accounts: 4, full_scan: false, scanned: 3 });
    const accounts = await accountsOf(h, owner);
    expect(accounts.map((account) => [account.label, account.processor_merchant_id, account.first_seen_at, account.last_seen_at])).toEqual([
      ["Adyen MID #1", "mid-adyen-a", "2026-07-01T10:00:00.000Z", "2026-10-06T10:00:00.000Z"],
      ["Stripe MID #1", "mid-stripe-a", "2026-03-11T10:00:00.000Z", "2026-09-01T10:00:00.000Z"],
      ["Stripe MID #2", "mid-stripe-b", "2026-05-01T10:00:00.000Z", "2026-05-01T10:00:00.000Z"],
      ["Stripe MID #3", "mid-stripe-c", "2026-10-01T10:00:00.000Z", "2026-10-01T10:00:00.000Z"],
    ]);
    // The rows just read sit inside the one-hour overlap, so they are read again; nothing changes.
    expect(await sync(h, owner)).toEqual({ data_key: owner, inserted: 0, updated: 0, accounts: 4, full_scan: false, scanned: 3 });

    // A renamed account keeps its label and number; a MID that reappears after a gap is not re-numbered.
    await h.asService((tx) => tx.query("update public.psp_accounts set label = 'Legacy Stripe' where auth_user_id = $1 and processor_merchant_id = 'mid-stripe-b'", [owner]));
    await insertTransaction(h, { owner, time: "2026-10-08T10:00:00Z", processor: "STRIPE", mid: "mid-stripe-b" });
    expect(await sync(h, owner)).toMatchObject({ inserted: 0, updated: 1, full_scan: false, scanned: 4 });
    const renamed = (await accountsOf(h, owner)).find((account) => account.processor_merchant_id === "mid-stripe-b")!;
    expect(renamed).toMatchObject({ label: "Legacy Stripe", seq: 2, last_seen_at: "2026-10-08T10:00:00.000Z" });
  });

  it("reads only the rows written since the last call (transactions.updated_at, one-hour overlap); p_full rescans the history", { timeout: CLONE_TIMEOUT }, async () => {
    const h = await copyOf(applied);
    const [seeded] = await syncStates(h);
    // A row imported now with an OLD event_time (a backfilled month) is read: the watermark is updated_at, not event_time.
    await insertTransaction(h, { owner, time: "2026-02-01T10:00:00Z", processor: "STRIPE", mid: "mid-stripe-c" });
    // A row inside the overlap (written 30 minutes before the last sync) is read again ...
    await insertTransaction(h, { owner, time: "2026-10-09T11:00:00Z", processor: "ADYEN", mid: "mid-adyen-c", updatedAt: new Date(Date.now() - 30 * 60_000).toISOString() });
    // ... a row whose updated_at predates the watermark by more than the overlap is not: an import always stamps updated_at = now().
    await insertTransaction(h, { owner, time: "2026-10-09T10:00:00Z", processor: "ADYEN", mid: "mid-adyen-b", updatedAt: OLD_UPDATED_AT });

    expect(await sync(h, owner)).toEqual({ data_key: owner, inserted: 2, updated: 0, accounts: 5, full_scan: false, scanned: 2 });
    expect((await accountsOf(h, owner)).map((account) => [account.label, account.processor_merchant_id, account.first_seen_at])).toEqual([
      ["Adyen MID #1", "mid-adyen-a", "2026-07-30T10:00:00.000Z"],
      ["Adyen MID #2", "mid-adyen-c", "2026-10-09T11:00:00.000Z"],
      ["Stripe MID #1", "mid-stripe-a", "2026-03-11T10:00:00.000Z"],
      ["Stripe MID #2", "mid-stripe-b", "2026-05-01T10:00:00.000Z"],
      ["Stripe MID #3", "mid-stripe-c", "2026-02-01T10:00:00.000Z"],
    ]);
    const [incremental] = await syncStates(h);
    expect(incremental).toEqual({ auth_user_id: owner, synced_through: expect.any(String), scanned_rows: 2, last_full_scan: false });
    expect(new Date(incremental.synced_through).getTime()).toBeGreaterThan(new Date(seeded.synced_through).getTime());

    // p_full: the whole history again (6 fixture rows + 3 above), so the stale row is registered too.
    expect(await sync(h, owner, true)).toEqual({ data_key: owner, inserted: 1, updated: 0, accounts: 6, full_scan: true, scanned: 9 });
    expect((await accountsOf(h, owner)).find((account) => account.processor_merchant_id === "mid-adyen-b")).toMatchObject({ label: "Adyen MID #3", seq: 3 });
    expect((await syncStates(h))[0]).toMatchObject({ scanned_rows: 9, last_full_scan: true });
    // Only the owner has a watermark; the other account was never synced.
    expect((await syncStates(h)).map((state) => state.auth_user_id)).toEqual([owner]);
  });

  it("works per data key: another account gets its own numbering; an unknown key seeds nothing; no workspace -> skipped", { timeout: CLONE_TIMEOUT }, async () => {
    const h = await copyOf(applied);
    // No watermark for this key yet: the first call is a full scan, and it leaves one.
    expect(await sync(h, other)).toEqual({ data_key: other, inserted: 1, updated: 0, accounts: 1, full_scan: true, scanned: 1 });
    expect((await accountsOf(h, other)).map((account) => [account.label, account.processor_merchant_id])).toEqual([["Stripe MID #1", "mid-other"]]);
    expect((await syncStates(h)).map((state) => [state.auth_user_id, state.last_full_scan, state.scanned_rows])).toEqual(
      [[owner, true, 6], [other, true, 1]].sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1)),
    );
    // An unknown key (no auth.users row): nothing registered, no watermark row either (the FK is caught, as the leads cache does).
    expect(await sync(h, "00000000-0000-0000-0000-000000000000")).toEqual({
      data_key: "00000000-0000-0000-0000-000000000000", inserted: 0, updated: 0, accounts: 0, full_scan: true, scanned: 0,
    });
    expect((await syncStates(h)).map((state) => state.auth_user_id)).not.toContain("00000000-0000-0000-0000-000000000000");
    // A null key means the workspace data key.
    expect(await sync(h, null)).toEqual({ data_key: owner, inserted: 0, updated: 0, accounts: 3, full_scan: false, scanned: 0 });
    // Stands in for a database whose workspace is not bootstrapped.
    await h.db.exec("create or replace function public.workspace_data_key() returns uuid language sql stable security definer set search_path = '' as $$ select null::uuid $$;");
    const notices: string[] = [];
    const result = await h.db.query<{ value: Record<string, unknown> }>("select public.psp_accounts_sync() as value", [], {
      onNotice: (notice) => notices.push(String(notice.message)),
    });
    expect(result.rows[0].value).toEqual({ data_key: null, inserted: 0, updated: 0, accounts: 0, full_scan: false, scanned: 0 });
    expect(notices).toEqual([expect.stringMatching(/workspace is not bootstrapped/)]);
  });
});

describe("network_program_thresholds: plan D as rows, with source, verification date and verified flag", () => {
  interface Threshold {
    program: string;
    metric_key: string;
    region: string;
    scope: string;
    effective_from: string;
    effective_to: string | null;
    warning_value: string | null;
    critical_value: string | null;
    min_count: number | null;
    unit: string;
    source_url: string;
    last_verified_at: string;
    verified: boolean;
    notes: string | null;
  }
  const num = (value: string | null) => (value == null ? null : Number(value));
  const date = (value: unknown) => (value == null ? null : new Date(value as string).toISOString().slice(0, 10));

  it("seeds every threshold of plan D (and the two Mastercard TPE limits as unverified reference rows)", async () => {
    const rows = (await applied.db.query<Threshold>("select * from public.network_program_thresholds order by program, metric_key, region, scope")).rows;
    const pick = (program: string, metric: string, region = "global") => {
      const row = rows.find((candidate) => candidate.program === program && candidate.metric_key === metric && candidate.region === region);
      expect(row, `${program}/${metric}/${region}`).toBeDefined();
      return { warning: num(row!.warning_value), critical: num(row!.critical_value), min_count: row!.min_count, unit: row!.unit, verified: row!.verified, scope: row!.scope };
    };
    expect(rows).toHaveLength(21);
    expect(pick("visa_vamp", "vamp_ratio")).toEqual({ warning: 0.005, critical: 0.015, min_count: 1500, unit: "ratio", verified: true, scope: "merchant" });
    expect(pick("visa_vamp", "vamp_count")).toMatchObject({ critical: 1500, unit: "count", verified: true });
    expect(pick("visa_vamp", "vamp_ratio", "cemea")).toMatchObject({ critical: 0.022, min_count: 150 });
    expect(pick("visa_vamp", "vamp_count", "cemea")).toMatchObject({ critical: 150 });
    expect(pick("visa_vamp", "vamp_amount_usd", "cemea")).toMatchObject({ critical: 75000, unit: "usd" });
    expect(pick("visa_vamp_enumeration", "enumeration_ratio")).toMatchObject({ critical: 0.2, min_count: 300000 });
    expect(pick("visa_vamp_enumeration", "enumeration_count")).toMatchObject({ critical: 300000 });
    expect(pick("mc_ecm", "chargeback_count")).toMatchObject({ critical: 100 });
    expect(pick("mc_ecm", "chargeback_ratio")).toMatchObject({ critical: 0.015, min_count: 100 });
    expect(pick("mc_hecm", "chargeback_count")).toMatchObject({ critical: 300 });
    expect(pick("mc_hecm", "chargeback_ratio")).toMatchObject({ critical: 0.03, min_count: 300 });
    expect(pick("mc_efm", "ecom_transaction_count")).toMatchObject({ critical: 1000 });
    expect(pick("mc_efm", "fraud_chargeback_amount_usd")).toMatchObject({ critical: 50000, unit: "usd" });
    expect(pick("mc_efm", "fraud_chargeback_ratio")).toMatchObject({ critical: 0.005 });
    expect(pick("mc_efm", "three_ds_share_max", "non_regulated")).toMatchObject({ critical: 0.1, unit: "share" });
    expect(pick("mc_efm", "three_ds_share_max", "regulated")).toMatchObject({ critical: 0.5, unit: "share" });
    expect(pick("visa_reattempts", "reattempts_per_card_30d")).toEqual({ warning: null, critical: 15, min_count: null, unit: "count", verified: false, scope: "card" });
    expect(pick("visa_reattempts", "reattempts_after_category_1")).toMatchObject({ critical: 0, verified: false, scope: "card" });
    expect(pick("mc_mac", "reattempts_after_mac_03_21_30d")).toMatchObject({ critical: 0, verified: false, scope: "card" });
    expect(pick("mc_tpe", "retries_per_card_24h")).toMatchObject({ critical: 10, verified: false });
    expect(pick("mc_tpe", "retries_per_card_30d")).toMatchObject({ critical: 35, verified: false });

    for (const row of rows) {
      expect(row.source_url, `${row.program}/${row.metric_key}`).toMatch(/^https:\/\//);
      expect(date(row.last_verified_at), `${row.program}/${row.metric_key}`).toBe("2026-10-10");
      expect(date(row.effective_from)).toBe("2026-01-01");
      expect(row.effective_to).toBeNull();
      expect(row.notes?.length ?? 0).toBeGreaterThan(0);
      if (!row.verified) expect(row.notes, `${row.program}/${row.metric_key}`).toMatch(/^UNVERIFIED/);
    }
    // Exactly the retry-rule programs are unverified (secondary sources, plan D).
    expect([...new Set(rows.filter((row) => !row.verified).map((row) => row.program))].sort()).toEqual(["mc_mac", "mc_tpe", "visa_reattempts"]);
    expect(rows.filter((row) => row.verified).every((row) => row.source_url === "https://docs.stripe.com/disputes/monitoring-programs")).toBe(true);
  });

  it("keys rows by (program, metric, region, scope, effective_from) and checks unit, scope and the window", { timeout: CLONE_TIMEOUT }, async () => {
    const h = await copyOf(applied);
    const insert = `insert into public.network_program_thresholds (program, metric_key, region, scope, effective_from, effective_to, critical_value, unit, source_url)
                    values ($1, $2, $3, $4, $5, $6, $7, $8, 'https://example.test/rules')`;
    await expect(h.db.query(insert, ["visa_vamp", "vamp_ratio", "global", "merchant", "2026-01-01", null, 0.02, "ratio"])).rejects.toThrow(/network_program_thresholds_key/);
    await expect(h.db.query(insert, ["visa_vamp", "vamp_ratio", "global", "merchant", "2027-01-01", null, 0.02, "percent"])).rejects.toThrow(/network_program_thresholds_unit_check/);
    await expect(h.db.query(insert, ["visa_vamp", "vamp_ratio", "global", "acquirer", "2027-01-01", null, 0.02, "ratio"])).rejects.toThrow(/network_program_thresholds_scope_check/);
    await expect(h.db.query(insert, ["visa_vamp", "vamp_ratio", "global", "merchant", "2027-01-01", "2026-12-31", 0.02, "ratio"])).rejects.toThrow(/network_program_thresholds_window_check/);
    // A later effective window of the same key is a new row the seed never touches.
    await h.db.query(insert, ["visa_vamp", "vamp_ratio", "global", "merchant", "2027-01-01", null, 0.02, "ratio"]);
    await h.applyMigration(REGISTRIES);
    const versions = await h.db.query<{ effective_from: string; critical_value: string; verified: boolean }>(
      "select effective_from, critical_value, verified from public.network_program_thresholds where program = 'visa_vamp' and metric_key = 'vamp_ratio' and region = 'global' order by effective_from",
    );
    expect(versions.rows.map((row) => [date(row.effective_from), num(row.critical_value), row.verified])).toEqual([
      ["2026-01-01", 0.015, true],
      ["2027-01-01", 0.02, false],
    ]);
  });
});

describe("grants, RLS and the updated_at trigger", () => {
  const TABLES = ["psp_accounts", "psp_accounts_sync_state", "network_program_thresholds"];

  it("keeps both registries off the browser roles: RLS on, no policies, service_role select / insert / update only", async () => {
    for (const table of TABLES) {
      const row = await one(
        applied.db,
        `select c.relrowsecurity as rls,
                (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies,
                has_table_privilege('anon', c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') as anon,
                has_table_privilege('authenticated', c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') as authenticated,
                has_table_privilege('service_role', c.oid, 'SELECT') as service_select,
                has_table_privilege('service_role', c.oid, 'INSERT') as service_insert,
                has_table_privilege('service_role', c.oid, 'UPDATE') as service_update,
                has_table_privilege('service_role', c.oid, 'DELETE') as service_delete,
                has_table_privilege('service_role', c.oid, 'TRUNCATE') as service_truncate
         from pg_class c where c.oid = $1::regclass`,
        [`public.${table}`],
      );
      expect(row, table).toEqual({
        rls: true, policies: 0, anon: false, authenticated: false,
        service_select: true, service_insert: true, service_update: true, service_delete: false, service_truncate: false,
      });
      await expect(applied.asUser(owner, (tx) => tx.query(`select * from public.${table}`)), table).rejects.toThrow(/permission denied/);
      await expect(applied.asAnon((tx) => tx.query(`select * from public.${table}`)), table).rejects.toThrow(/permission denied/);
      await expect(applied.asService((tx) => tx.query(`delete from public.${table}`)), table).rejects.toThrow(/permission denied/);
    }
  });

  it("lets the Edge (service_role) read and update, and bumps updated_at on every update", { timeout: CLONE_TIMEOUT }, async () => {
    const h = await copyOf(applied);
    const before = await h.asService((tx) => one<{ created_at: string; updated_at: string }>(tx, "select created_at, updated_at from public.psp_accounts where auth_user_id = $1 and label = 'Stripe MID #2'", [owner]));
    expect(iso(before.updated_at)).toBe(iso(before.created_at));
    await h.asService((tx) => tx.query("update public.psp_accounts set acquirer_country = 'US' where auth_user_id = $1 and label = 'Stripe MID #2'", [owner]));
    const after = await h.asService((tx) => one<{ created_at: string; updated_at: string; acquirer_country: string }>(tx, "select created_at, updated_at, acquirer_country from public.psp_accounts where auth_user_id = $1 and label = 'Stripe MID #2'", [owner]));
    expect(after.acquirer_country).toBe("US");
    expect(new Date(after.updated_at).getTime()).toBeGreaterThan(new Date(before.updated_at).getTime());

    const threshold = await h.asService((tx) => one<{ id: string; updated_at: string }>(tx, "select id, updated_at from public.network_program_thresholds where program = 'mc_mac'"));
    await h.asService((tx) => tx.query("update public.network_program_thresholds set verified = true, last_verified_at = '2026-11-01' where id = $1", [threshold.id]));
    const bumped = await h.asService((tx) => one<{ updated_at: string; verified: boolean }>(tx, "select updated_at, verified from public.network_program_thresholds where id = $1", [threshold.id]));
    expect(bumped.verified).toBe(true);
    expect(new Date(bumped.updated_at).getTime()).toBeGreaterThan(new Date(threshold.updated_at).getTime());
  });

  it("exposes psp_accounts_sync to service_role only; the trigger function to nobody; both pin search_path", async () => {
    const privileges = (signature: string) =>
      one(
        applied.db,
        `select has_function_privilege('anon', $1, 'execute') as anon,
                has_function_privilege('authenticated', $1, 'execute') as authenticated,
                has_function_privilege('service_role', $1, 'execute') as service,
                coalesce(array_to_string((select p.proacl from pg_proc p where p.oid = $1::regprocedure), ',') ~ '(^|,)=X', true) as public_acl`,
        [signature],
      );
    expect(await privileges("public.psp_accounts_sync(uuid, boolean)")).toEqual({ anon: false, authenticated: false, service: true, public_acl: false });
    // The one-argument overload is gone: psp_accounts_sync(key) resolves to one function.
    expect(await one(applied.db, "select to_regprocedure('public.psp_accounts_sync(uuid)') as old")).toEqual({ old: null });
    expect(await privileges("public.payment_health_set_updated_at()")).toEqual({ anon: false, authenticated: false, service: false, public_acl: false });
    const pinned = await applied.db.query<{ proname: string; prosecdef: boolean; config: string[] | null }>(
      "select proname, prosecdef, proconfig as config from pg_proc where proname in ('psp_accounts_sync', 'payment_health_set_updated_at') order by proname",
    );
    expect(pinned.rows.map((row) => row.proname)).toEqual(["payment_health_set_updated_at", "psp_accounts_sync"]);
    for (const row of pinned.rows) {
      // SECURITY INVOKER (no definer rights to pin), search_path still pinned to '' (stored as search_path="").
      expect(row.prosecdef, row.proname).toBe(false);
      expect(row.config, row.proname).toEqual([expect.stringMatching(/^search_path=("")?$/)]);
    }
    await expect(applied.asUser(owner, (tx) => tx.query("select public.psp_accounts_sync()"))).rejects.toThrow(/permission denied for function psp_accounts_sync/);
  });

  it("passes 202610050003's fail-closed block and its own", async () => {
    const h = await copyOf(applied);
    const lockdown = readMigration(LOCKDOWN);
    const failClosed = lockdown.slice(lockdown.indexOf("do $$", lockdown.indexOf("-- Fail closed")));
    expect(failClosed).toMatch(/browser write policies remain/);
    await expect(h.db.exec(failClosed)).resolves.toBeDefined();
    const own = readMigration(REGISTRIES);
    const ownBlock = own.slice(own.indexOf("do $$", own.indexOf("-- Fail closed")));
    expect(ownBlock).toMatch(/reachable by a browser role or without RLS/);
    await expect(h.db.exec(ownBlock)).resolves.toBeDefined();
    // ...and that block really aborts on a browser grant.
    await h.db.exec("grant select on table public.psp_accounts to authenticated");
    await expect(h.db.exec(ownBlock)).rejects.toThrow(/reachable by a browser role or without RLS: psp_accounts/);
  }, CLONE_TIMEOUT);
});
