// Executable tests for supabase/migrations/202610070001_leads_recent_candidates.sql,
// run against PGlite through the Supabase stand-in in ./support/pgliteSupabase.ts.
//
// The database is the production shape the migration lands on: every earlier
// migration (pg_cron / pg_net stubbed), the workspace bootstrapped before the RLS
// lockdown, then the lockdown, 202610060010 (export) and 202610060011 (cron).
//
// Covers: parity of leads_recent_candidates_compute with the old
// leads_profile_candidates(p_data_key, null) on a fixture with every exclusion
// and tie the representative rule and the two newest-first streams care about
// (profile-only rows = the old ones inside each stream's cut, warehouse-email
// profiles, subscription leads and KPIs equal); the end-to-end property the Edge
// relies on (the newest-N cut of the merged set is the same over the new
// candidates as over the old full list); the cache (fresh hit, stale / other
// limit / max age 0 recompute, null and unknown keys never cached, the newer
// payload wins); the pg_cron refresh; grants / RLS; the guard and idempotence.
//
// Runs in the default jsdom environment (src/test/setup.ts needs `window`).
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createSupabasePglite, listMigrations, type SqlRunner, type SupabasePglite } from "./support/pgliteSupabase";
import {
  keepNewestLeads,
  mergeLeadsWithProfiles,
  parseLeadsProfileCandidates,
  type WarehouseLeadCandidate,
} from "../../supabase/functions/_shared/clickhouse/leads.ts";

const LOCKDOWN = "202610050003_access_rls_lockdown.sql";
const EXPORT = "202610060010_funnelfox_leads_export.sql";
const RECENT = "202610070001_leads_recent_candidates.sql";

const DAY_MS = 86_400_000;
// Each test works on a clone of a ~100-migration database (1-2 s, more under load).
const CLONE_TIMEOUT = 60_000;
const future = () => new Date(Date.now() + 30 * DAY_MS).toISOString();
const past = () => new Date(Date.now() - 30 * DAY_MS).toISOString();

let beforeExport: SupabasePglite; // everything before 202610060010
let recent: SupabasePglite; // + 0010, 0011, RECENT (no fixture rows)
let seeded: SupabasePglite; // recent + the fixture below (read-only tests)
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
  },
) {
  // normalized_email as the sync stores it: lower(btrim(email)).
  await h.db.query(
    `insert into public.funnelfox_leads
       (auth_user_id, profile_id, email, normalized_email, preview, created_at, session_created_at, funnel_id,
        campaign_path, campaign_id, utm_source, media_buyer, country_code, user_agent, origin)
     values ($1, $2, $3, lower(btrim($3)), $4, $5, $6, $7, $8, $9, $10, $11, $12, 'UA', 'https://o')`,
    [
      row.owner, row.profileId, row.email ?? null, row.preview ?? false, row.createdAt ?? null, row.sessionCreatedAt ?? null,
      row.funnelId ?? null, row.campaignPath ?? null, row.campaignId ?? null, row.utmSource ?? null, row.mediaBuyer ?? null,
      row.countryCode ?? null,
    ],
  );
}

let txSeq = 0;
async function insertTransaction(
  h: SupabasePglite,
  row: { owner: string; email: string; status: string | null; type?: string; deleted?: boolean },
) {
  txSeq += 1;
  await h.db.query(
    `insert into public.transactions (auth_user_id, transaction_id, event_time, status, transaction_type, email, deleted_at)
     values ($1, $2, '2026-09-01T00:00:00Z', $3, $4, $5, case when $6 then now() end)`,
    [row.owner, `tx-${txSeq}`, row.status, row.type ?? "subscription", row.email, row.deleted ?? false],
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

/** Every case the representative rule, the exclusions and the two streams care about. */
async function seedFixture(h: SupabasePglite) {
  await h.db.query(
    `insert into public.funnels (funnel_path, display_name, funnelfox_funnel_id)
     values ('soulmate-sketch', 'Soulmate', 'FUN-SOUL'), ('palm-reading', 'Palm', 'FUN-PALM')`,
  );
  const lead = (profileId: string, email: string | null, createdAt: string | null, extra: Partial<Parameters<typeof insertLead>[1]> = {}) =>
    insertLead(h, { owner, profileId, email, createdAt, ...extra });

  // Plain profile-only leads, one per day (the dated stream).
  for (let day = 1; day <= 12; day += 1) {
    const d = String(day).padStart(2, "0");
    await lead(`p-a${d}`, `lead-a${d}@example.com`, `2026-09-${d}T10:00:00Z`, {
      funnelId: day % 2 ? "FUN-SOUL" : "FUN-PALM", campaignPath: day % 3 ? `path-${d}` : " ", campaignId: day % 4 ? ` ${day} ` : null,
      utmSource: day % 5 ? "fb_john" : null, mediaBuyer: day % 2 ? "John" : "  ", countryCode: day % 2 ? "US" : null,
    });
  }
  // Three leads tied on the same created_at (ties at a cut).
  await lead("p-tie1", "tie1@example.com", "2026-09-20T00:00:00Z");
  await lead("p-tie2", "tie2@example.com", "2026-09-20T00:00:00Z");
  await lead("p-tie3", "tie3@example.com", "2026-09-20T00:00:00Z");
  await lead("p-top", "top@example.com", "2026-09-22T00:00:00Z", { funnelId: "FUN-UNKNOWN", campaignPath: "session-path" });
  // Several profiles per email: the earliest non-preview one represents it.
  await lead("p-dup-late", "dup@example.com", "2026-09-21T00:00:00Z", { funnelId: "FUN-SOUL" });
  await lead("p-dup-early", " DUP@Example.com ", "2026-09-05T12:00:00Z", { funnelId: "FUN-PALM", campaignPath: "dup-path" });
  // An earlier preview run never represents an email.
  await lead("p-dp-preview", "dupprev@example.com", "2026-08-01T00:00:00Z", { preview: true });
  await lead("p-dp-real", "dupprev@example.com", "2026-09-19T00:00:00Z");
  // Same date for two profiles of one email: the lower profile id.
  await lead("p-same-b", "same@example.com", "2026-09-18T00:00:00Z");
  await lead("p-same-a", "same@example.com", "2026-09-18T00:00:00Z", { campaignPath: "same-a" });
  // A created_at-null profile with an earlier session date beats a dated one (undated stream).
  await lead("p-mx-dated", "mixed@example.com", "2026-09-17T00:00:00Z");
  await lead("p-mx-session", "mixed@example.com", null, { sessionCreatedAt: "2026-09-16T00:00:00Z" });
  // created_at null: the session date (undated stream), several of them.
  await lead("p-sess1", "sess1@example.com", null, { sessionCreatedAt: "2026-09-23T00:00:00Z" });
  await lead("p-sess2", "sess2@example.com", null, { sessionCreatedAt: "2026-09-08T00:00:00Z" });
  await lead("p-sess3", "sess3@example.com", null, { sessionCreatedAt: "2026-09-08T00:00:00Z" });
  // No date at all (undated last); two undated profiles of one email: the lower id.
  await lead("p-undated1", "undated1@example.com", null);
  await lead("p-undated2", "undated2@example.com", null);
  await lead("p-und-b", "undatedpair@example.com", null);
  await lead("p-und-a", "undatedpair@example.com", null);
  // A dated profile always beats an undated one of the same email.
  await lead("p-und-c", "undatedmix@example.com", null);
  await lead("p-und-d", "undatedmix@example.com", "2026-07-01T00:00:00Z");
  // Never leads: no / empty email, preview only.
  await lead("p-noemail", null, "2026-09-30T00:00:00Z");
  await lead("p-empty", "", "2026-09-30T00:00:00Z");
  await lead("p-prevonly", "prevonly@example.com", "2026-09-30T00:00:00Z", { preview: true });

  // Warehouse. Paid (case / space variants), unpaid, deleted-only, another account's.
  await lead("p-paid", "paid@example.com", "2026-09-29T00:00:00Z");
  await insertTransaction(h, { owner, email: " PAID@Example.com ", status: "success", type: "trial" });
  await insertTransaction(h, { owner, email: "paid@example.com", status: "failed", type: "trial" });
  await lead("p-wh1", "wh1@example.com", "2026-09-25T00:00:00Z", { campaignPath: "wh-path" });
  await insertTransaction(h, { owner, email: "wh1@example.com", status: "failed", type: "trial" });
  await lead("p-wh2-late", "wh2@example.com", "2026-09-29T00:00:00Z");
  await lead("p-wh2-early", "wh2@example.com", "2026-08-01T00:00:00Z", { funnelId: "FUN-SOUL" });
  await insertTransaction(h, { owner, email: " WH2@Example.com", status: "failed", type: "trial" });
  await lead("p-wh-old", "wh-old@example.com", "2020-01-01T00:00:00Z");
  await insertTransaction(h, { owner, email: "wh-old@example.com", status: "failed", type: "trial" });
  await lead("p-wh-undated", "wh-undated@example.com", null);
  await insertTransaction(h, { owner, email: "wh-undated@example.com", status: "failed", type: "trial" });
  await lead("p-wh-preview", "wh-preview@example.com", "2026-09-26T00:00:00Z", { preview: true });
  await insertTransaction(h, { owner, email: "wh-preview@example.com", status: "failed", type: "trial" });
  await insertTransaction(h, { owner, email: "whnoprof@example.com", status: "failed", type: "trial" });
  // Its only live transaction has a NULL status (the column is nullable): never paid,
  // so its old profile is a warehouse-email profile like any other.
  await lead("p-wh-null", "wh-null@example.com", "2020-02-01T00:00:00Z");
  await insertTransaction(h, { owner, email: "wh-null@example.com", status: null, type: "trial" });
  await lead("p-deleted", "deleted@example.com", "2026-09-24T00:00:00Z");
  await insertTransaction(h, { owner, email: "deleted@example.com", status: "success", type: "trial", deleted: true });
  await lead("p-cross", "cross@example.com", "2026-09-14T00:00:00Z");
  await insertTransaction(h, { owner: other, email: "cross@example.com", status: "success", type: "trial" });

  // Active / sandbox subscriptions.
  await lead("p-active", "active@example.com", "2026-09-28T00:00:00Z");
  await insertSubscription(h, { owner, id: "s-active", email: "active@example.com" });
  await lead("p-sandbox", "sandbox@example.com", "2026-09-13T00:00:00Z");
  await insertSubscription(h, { owner, id: "s-sandbox", email: "sandbox@example.com", rawDetail: { sandbox: true } });
  // An active unpaid warehouse email: neither a profile lead nor a warehouse profile.
  await lead("p-wh-active", "wh-active@example.com", "2026-09-27T00:00:00Z");
  await insertTransaction(h, { owner, email: "wh-active@example.com", status: "failed", type: "trial" });
  await insertSubscription(h, { owner, id: "s-wh-active", email: "wh-active@example.com" });

  // Linked: the profile's OWN subscription shows a paying / subscribed customer.
  await lead("p-quiz1", "quiz1@example.com", "2026-09-27T00:00:00Z");
  await lead("p-quiz1b", "quiz1@example.com", "2026-09-28T00:00:00Z"); // same email: excluded too
  await insertTransaction(h, { owner, email: "checkout1@example.com", status: "success", type: "trial" });
  await insertSubscription(h, { owner, id: "sl-1", email: "checkout1@example.com", profileId: "p-quiz1", periodEndsAt: past() });
  await insertSubscription(h, { owner, id: "sl-1q", email: "quiz1@example.com", periodEndsAt: past() }); // a linked email: no sub lead
  await lead("p-quiz2", "quiz2@example.com", "2026-09-26T00:00:00Z");
  await insertSubscription(h, {
    owner, id: "sl-2", email: "checkout2@example.com", profileId: "p-quiz2", price: 19.99, status: "cancelled", renews: false, periodEndsAt: future(),
  });
  await lead("p-quiz3", "quiz3@example.com", "2026-09-26T00:00:00Z");
  await insertSubscription(h, { owner, id: "sl-3", email: "checkout3@example.com", profileId: "pro_p-quiz3" });
  await lead("p-quiz4", "quiz4@example.com", "2026-09-11T00:00:00Z"); // control: still a lead
  await insertSubscription(h, {
    owner, id: "sl-4", email: "checkout4@example.com", profileId: "p-quiz4", status: "cancelled", renews: false, periodEndsAt: past(),
  });
  await lead("p-quiz5", "quiz5@example.com", "2026-09-15T00:00:00Z"); // looks paid (priced, renewing)
  await insertSubscription(h, { owner, id: "sl-5", email: "checkout5@example.com", profileId: "PRO_p-quiz5", price: 29, periodEndsAt: past() });
  await lead("p-whlinked", "whlinked@example.com", "2026-09-10T00:00:00Z"); // unpaid warehouse email, but linked
  await insertTransaction(h, { owner, email: "whlinked@example.com", status: "failed", type: "trial" });
  await insertSubscription(h, { owner, id: "sl-6", email: "checkout6@example.com", profileId: "p-whlinked", price: 9, periodEndsAt: past() });
  // Another account's paid subscription naming an owner profile id never links.
  await insertSubscription(h, { owner: other, id: "ql-1", email: "x@example.com", profileId: "p-a03", price: 49 });

  // Subscription-only leads (and the ones that are not).
  await insertSubscription(h, {
    owner, id: "s-01", email: "sublead@example.com", profileId: "prof-1", periodEndsAt: past(), createdAt: "2026-09-10T00:00:00Z",
    rawDetail: { funnel: { alias: "soulmate-sketch", title: "Soulmate Sketch" } },
  });
  await insertSubscription(h, { owner, id: "s-02", email: "paidsub@example.com", price: 29.99, periodEndsAt: past(), createdAt: "2026-06-02T00:00:00Z" });
  await insertSubscription(h, {
    owner, id: "s-03", email: "paidsub@example.com", price: 29.99, status: "cancelled", renews: false, periodEndsAt: past(),
    createdAt: "2026-06-01T00:00:00Z", rawList: { funnel: { alias: "past-life-reading" } },
  });
  await insertSubscription(h, { owner, id: "s-05", email: "wh1@example.com", periodEndsAt: past() }); // in the warehouse
  await insertSubscription(h, { owner, id: "s-06", email: "dup@example.com", periodEndsAt: past() }); // a profile lead
  await insertSubscription(h, {
    owner, id: "s-07", email: "nodatesub@example.com", periodEndsAt: past(),
    rawList: { period_starts_at: "2026-07-01T00:00:00Z", funnel: { title: "Starseed reading" } }, rawDetail: { status: "expired" },
  });
  await insertSubscription(h, { owner, id: "s-08", email: "cross-sub@example.com", periodEndsAt: past(), createdAt: "2026-05-01T00:00:00Z" });
  await insertTransaction(h, { owner: other, email: "cross-sub@example.com", status: "success", type: "trial" });
  await insertSubscription(h, { owner, id: "s-10", email: "inperiod@example.com", price: 29.99, status: "cancelled", renews: false, periodEndsAt: future(), createdAt: "2026-09-12T00:00:00Z" });
  await insertSubscription(h, { owner, id: "s-11", email: "inperiod@example.com", periodEndsAt: past(), createdAt: "2026-03-01T00:00:00Z" });
  await insertSubscription(h, { owner, id: "s-12", email: "prevonly@example.com", periodEndsAt: past(), createdAt: "2026-09-02T00:00:00Z" }); // only a preview profile
  await insertSubscription(h, { owner, id: "s-13", email: "feb30@example.com", periodEndsAt: past(), rawList: { period_starts_at: "2026-02-30T00:00:00Z" } });

  // Another account: its rows never reach the owner's candidates.
  await insertLead(h, { owner: other, profileId: "q-early", email: "lead-a05@example.com", createdAt: "2020-01-01T00:00:00Z" });
  await insertLead(h, { owner: other, profileId: "q-lead", email: "other-lead@example.com", createdAt: "2026-09-30T00:00:00Z" });
  await insertSubscription(h, { owner: other, id: "q-01", email: "other-sub@example.com", periodEndsAt: past() });
}

beforeAll(async () => {
  const base = await createSupabasePglite({ migrations: listMigrations({ before: LOCKDOWN }), extensionStubs: true });
  owner = await base.createAuthUser("owner@example.com");
  other = await base.createAuthUser("other@example.com");
  await base.db.query("select public.bootstrap_workspace($1, 'SubEngine')", [owner]);
  for (const name of listMigrations().filter((migration) => migration >= LOCKDOWN && migration < RECENT)) {
    if (name === EXPORT) beforeExport = await base.clone();
    await base.applyMigration(name);
  }
  recent = base;
  await recent.applyMigration(RECENT);
  seeded = await recent.clone();
  await seedFixture(seeded);
}, 300_000);

afterEach(async () => {
  while (opened.length) await opened.pop()!.close();
});

// ---------------------------------------------------------------------------
// Parity with leads_profile_candidates
// ---------------------------------------------------------------------------

interface ProfileLead {
  profile_id: string;
  email: string;
  lead_date: string | null;
  funnel_id: string | null;
  campaign_path: string | null;
  campaign_id: string | null;
  utm_source: string | null;
  media_buyer: string | null;
  country: string | null;
}
interface Candidates {
  profile_leads: ProfileLead[];
  profile_only_limited?: boolean;
  subscription_leads: Array<Record<string, unknown>>;
  kpis: Record<string, number>;
  computed_at?: string;
  cached?: boolean;
}

const LIMITS = [0, 1, 2, 3, 5, 8, 50];

const normalized = (row: ProfileLead): ProfileLead => ({ ...row, lead_date: iso(row.lead_date) });
const byProfile = (rows: ProfileLead[]) => [...rows].map(normalized).sort((a, b) => (a.profile_id < b.profile_id ? -1 : a.profile_id > b.profile_id ? 1 : 0));
const dateMs = (row: ProfileLead) => (row.lead_date == null ? null : Date.parse(row.lead_date));
/** lead_date desc, nulls last (the order both RPCs rank by). */
function newestFirst(a: ProfileLead, b: ProfileLead): number {
  const am = dateMs(a);
  const bm = dateMs(b);
  if (am === null || bm === null) return am === bm ? 0 : am === null ? 1 : -1;
  return bm - am;
}
/** The newest n rows, rows tied with the n-th included (FETCH FIRST n ROWS WITH TIES). */
function topWithTies(rows: ProfileLead[], n: number): ProfileLead[] {
  const sorted = [...rows].sort(newestFirst);
  if (sorted.length <= n) return sorted;
  const cut = sorted[n - 1];
  return sorted.filter((row) => newestFirst(row, cut) <= 0);
}

describe("leads_recent_candidates_compute matches leads_profile_candidates", { timeout: CLONE_TIMEOUT }, () => {
  let old: Candidates;
  let warehouseEmails: Set<string>;
  let createdAtNull: Set<string>;

  beforeAll(async () => {
    old = await rpc<Candidates>(seeded, "public.leads_profile_candidates($1::uuid, null)", [owner]);
    warehouseEmails = new Set(
      (await seeded.db.query<{ email: string }>(
        `select distinct lower(btrim(email)) as email from public.transactions
         where auth_user_id = $1 and deleted_at is null and email is not null and btrim(email) <> ''`,
        [owner],
      )).rows.map((row) => row.email),
    );
    createdAtNull = new Set(
      (await seeded.db.query<{ profile_id: string }>(
        "select profile_id from public.funnelfox_leads where auth_user_id = $1 and created_at is null",
        [owner],
      )).rows.map((row) => row.profile_id),
    );
  });

  it("the fixture is not vacuous", () => {
    const oldProfileOnly = old.profile_leads.filter((row) => !warehouseEmails.has(row.email));
    const oldWarehouse = old.profile_leads.filter((row) => warehouseEmails.has(row.email));
    expect(oldProfileOnly.length).toBeGreaterThan(25);
    expect(oldProfileOnly.filter((row) => createdAtNull.has(row.profile_id)).length).toBeGreaterThanOrEqual(6);
    expect(oldProfileOnly.filter((row) => row.lead_date == null).length).toBeGreaterThanOrEqual(3);
    // wh1, wh2 (earliest of two), wh-old (2020), wh-undated, wh-null (only a NULL-status transaction).
    expect(oldWarehouse.map((row) => row.profile_id).sort()).toEqual(["p-wh-null", "p-wh-old", "p-wh-undated", "p-wh1", "p-wh2-early"]);
    expect(old.subscription_leads.length).toBeGreaterThanOrEqual(6);
  });

  for (const limit of LIMITS) {
    it(`limit ${limit}: profile-only rows inside each stream's cut, every warehouse-email profile, subscription leads and KPIs`, async () => {
      const fresh = await rpc<Candidates>(seeded, "public.leads_recent_candidates_compute($1::uuid, $2::int)", [owner, limit]);
      expect(Object.keys(fresh).sort()).toEqual(["kpis", "profile_leads", "profile_only_limited", "subscription_leads"]);

      const oldProfileOnly = old.profile_leads.filter((row) => !warehouseEmails.has(row.email));
      const freshProfileOnly = fresh.profile_leads.filter((row) => !warehouseEmails.has(row.email));
      // Two newest-first streams, each cut after limit + 1 rows (ties included).
      const expected = [
        ...topWithTies(oldProfileOnly.filter((row) => !createdAtNull.has(row.profile_id)), limit + 1),
        ...topWithTies(oldProfileOnly.filter((row) => createdAtNull.has(row.profile_id)), limit + 1),
      ];
      expect(byProfile(freshProfileOnly)).toEqual(byProfile(expected));
      // What the Edge's cut needs: the newest limit + 1 (with ties) of ALL profile-only leads are there.
      const freshIds = new Set(freshProfileOnly.map((row) => row.profile_id));
      for (const row of topWithTies(oldProfileOnly, limit + 1)) expect(freshIds.has(row.profile_id), row.profile_id).toBe(true);
      expect(fresh.profile_only_limited).toBe(expected.length > limit);

      // Every unpaid warehouse email's representative, whatever its age.
      expect(byProfile(fresh.profile_leads.filter((row) => warehouseEmails.has(row.email)))).toEqual(
        byProfile(old.profile_leads.filter((row) => warehouseEmails.has(row.email))),
      );
      // Newest first, undated last, then email.
      const order = fresh.profile_leads.map(normalized);
      expect(order).toEqual([...order].sort((a, b) => newestFirst(a, b) || (a.email < b.email ? -1 : a.email > b.email ? 1 : 0)));

      expect(fresh.subscription_leads).toEqual(old.subscription_leads);
      expect(fresh.kpis).toEqual(old.kpis);
    });
  }

  it("the limit defaults to 1000 and is clamped (null -> 1000, negative -> 0)", async () => {
    const at = (limit: number | null) => rpc<Candidates>(seeded, "public.leads_recent_candidates_compute($1::uuid, $2::int)", [owner, limit]);
    expect(await at(null)).toEqual(await at(1000));
    expect(await at(-5)).toEqual(await at(0));
    expect(await rpc(seeded, "public.leads_recent_candidates_compute($1::uuid)", [owner])).toEqual(await at(1000));
    // Above every lead: nothing is limited, every profile lead of the old RPC is there.
    const all = await at(1000);
    expect(all.profile_only_limited).toBe(false);
    expect(byProfile(all.profile_leads)).toEqual(byProfile(old.profile_leads));
  });

  it("is scoped to the given owner; a null or unknown key matches nothing", async () => {
    const forOther = await rpc<Candidates>(seeded, "public.leads_recent_candidates_compute($1::uuid, 5)", [other]);
    const oldOther = await rpc<Candidates>(seeded, "public.leads_profile_candidates($1::uuid, null)", [other]);
    expect(byProfile(forOther.profile_leads)).toEqual(byProfile(oldOther.profile_leads));
    expect(forOther.profile_leads.map((row) => row.profile_id).sort()).toEqual(["q-early", "q-lead"]);
    expect(forOther.subscription_leads).toEqual(oldOther.subscription_leads);
    expect(forOther.kpis).toEqual(oldOther.kpis);

    const empty = { profile_leads: [], profile_only_limited: false, subscription_leads: [], kpis: { emails_found: 0, converted_excluded: 0, active_subs_excluded: 0 } };
    expect(await rpc(seeded, "public.leads_recent_candidates_compute($1::uuid, 5)", [null])).toEqual(empty);
    expect(await rpc(seeded, "public.leads_recent_candidates_compute($1::uuid, 5)", ["00000000-0000-0000-0000-000000000000"])).toEqual(empty);
  });

  it("end to end: the Edge's newest-N cut is the same over the new candidates as over the old full list", async () => {
    // Query A stand-in: one warehouse lead per unpaid live warehouse email (ClickHouse
    // mirrors public.transactions), first touches spread around the profile dates.
    const touches: Record<string, string> = {
      "wh1@example.com": "2026-09-28T00:00:00.000Z", // later than its profile (09-25): lead_date 09-25
      "wh2@example.com": "2026-09-30T00:00:00.000Z", // its earliest profile is 08-01: never kept for the 09-30 touch alone
      "wh-old@example.com": "2026-09-30T12:00:00.000Z", // profile from 2020
      "wh-undated@example.com": "2026-09-09T00:00:00.000Z",
      "wh-null@example.com": "2026-09-30T06:00:00.000Z", // only a NULL-status transaction; profile from 2020
      "wh-preview@example.com": "2026-09-26T12:00:00.000Z", // only a preview profile: warehouse only
      "whnoprof@example.com": "2026-09-27T00:00:00.000Z",
      "wh-active@example.com": "2026-09-30T00:00:00.000Z", // active: dropped
      "whlinked@example.com": "2026-09-29T00:00:00.000Z", // linked profile: excluded in SQL, ClickHouse still lists it
    };
    const warehouse: WarehouseLeadCandidate[] = Object.entries(touches).map(([email, sessionDate], index) => ({
      customer_id: `u${index}`, email, session_date: sessionDate, funnel: "soulmate", campaign_path: "soulmate-reading",
      campaign_id: "cmp", utm_source: null, country: "US", user_agent: null, has_declines: false, decline_reason: null,
    }));
    const activeEmails = Object.keys(await rpc<Record<string, unknown>>(seeded, "public.active_funnelfox_subscription_emails($1::uuid)", [owner]));
    const now = Date.parse("2026-10-07T12:00:00.000Z");
    const cut = (candidates: unknown, n: number) => {
      const parsed = parseLeadsProfileCandidates(candidates);
      return keepNewestLeads(
        mergeLeadsWithProfiles({ warehouse, profiles: parsed.profile_leads, subscriptions: parsed.subscription_leads, activeEmails, now }).rows,
        n,
      );
    };
    const oldFull = await rpc(seeded, "public.leads_profile_candidates($1::uuid, null)", [owner]);
    for (const n of [1, 2, 3, 4, 5, 8, 13, 21, 50]) {
      const fresh = await rpc(seeded, "public.leads_recent_candidates_compute($1::uuid, $2::int)", [owner, n]);
      expect(cut(fresh, n), `n = ${n}`).toEqual(cut(oldFull, n));
    }
    // Contrast: the old RPC capped at n (its 50k cap, scaled down) would NOT be exact.
    const capped = await rpc(seeded, "public.leads_profile_candidates($1::uuid, $2::int)", [owner, 5]);
    expect(cut(capped, 5)).not.toEqual(cut(oldFull, 5));
  });
});

// ---------------------------------------------------------------------------
// Cache: leads_recent_candidates / leads_refresh_recent_candidates
// ---------------------------------------------------------------------------

describe("leads_recent_candidates (the Edge read) and the cache", { timeout: CLONE_TIMEOUT }, () => {
  const read = (h: SupabasePglite, key: string | null, limit: number | null = 3, maxAge: number | null = 900) =>
    rpc<Candidates>(h, "public.leads_recent_candidates($1::uuid, $2::int, $3::int)", [key, limit, maxAge]);
  const cacheRows = async (h: SupabasePglite) =>
    (await h.db.query<{ auth_user_id: string; profile_limit: number; computed_at: string; duration_ms: number | null }>(
      "select auth_user_id, profile_limit, computed_at, duration_ms from public.funnelfox_leads_candidates_cache order by computed_at",
    )).rows;
  const strip = ({ computed_at: _at, cached: _cached, ...payload }: Candidates) => payload;

  it("computes on a miss, stores the payload, and serves it from the cache while it is fresh", async () => {
    const h = await copyOf(seeded);
    expect(await cacheRows(h)).toEqual([]);
    const first = await read(h, owner);
    expect(first.cached).toBe(false);
    expect(iso(first.computed_at)).not.toBeNull();
    expect(strip(first)).toEqual(await rpc(h, "public.leads_recent_candidates_compute($1::uuid, 3)", [owner]));
    const rows = await cacheRows(h);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ auth_user_id: owner, profile_limit: 3 });
    expect(iso(rows[0].computed_at)).toBe(iso(first.computed_at));
    expect(rows[0].duration_ms).toBeGreaterThanOrEqual(0);

    // A new lead arrives: the fresh cache row still answers (no recompute).
    await insertLead(h, { owner, profileId: "p-brand-new", email: "brand-new@example.com", createdAt: "2026-10-01T00:00:00Z" });
    const second = await read(h, owner);
    expect(second.cached).toBe(true);
    expect(iso(second.computed_at)).toBe(iso(first.computed_at));
    expect(strip(second)).toEqual(strip(first));
    expect(second.profile_leads.some((row) => row.profile_id === "p-brand-new")).toBe(false);

    // Stale (older than the max age): recomputed, stored, and the new lead is in.
    await h.db.query("update public.funnelfox_leads_candidates_cache set computed_at = now() - interval '16 minutes'");
    const third = await read(h, owner);
    expect(third.cached).toBe(false);
    expect(Date.parse(third.computed_at!)).toBeGreaterThan(Date.parse(first.computed_at!) - 1);
    expect(third.profile_leads.some((row) => row.profile_id === "p-brand-new")).toBe(true);
    expect((await read(h, owner)).cached).toBe(true);
    expect(await cacheRows(h)).toHaveLength(1);
  });

  it("another limit, or max age 0, recomputes; a null limit / max age mean 1000 / 900", async () => {
    const h = await copyOf(seeded);
    await read(h, owner, 3);
    const other5 = await read(h, owner, 5);
    expect(other5.cached).toBe(false);
    expect((await cacheRows(h))[0]).toMatchObject({ profile_limit: 5 });
    expect((await read(h, owner, 5)).cached).toBe(true);
    expect((await read(h, owner, 5, 0)).cached).toBe(false);
    expect((await read(h, owner, 5, -10)).cached).toBe(false);

    const defaults = await read(h, owner, null, null);
    expect(defaults.cached).toBe(false);
    expect((await cacheRows(h))[0]).toMatchObject({ profile_limit: 1000 });
    expect((await rpc<Candidates>(h, "public.leads_recent_candidates($1::uuid)", [owner])).cached).toBe(true);
  });

  it("a null key or an unknown account is computed (empty) but never cached", async () => {
    const h = await copyOf(seeded);
    const empty = { profile_leads: [], profile_only_limited: false, subscription_leads: [], kpis: { emails_found: 0, converted_excluded: 0, active_subs_excluded: 0 } };
    for (const key of [null, "00000000-0000-0000-0000-000000000000"]) {
      const result = await read(h, key);
      expect(strip(result), String(key)).toEqual(empty);
      expect(result.cached).toBe(false);
    }
    expect(await cacheRows(h)).toEqual([]);
  });

  it("one row per account; a payload computed earlier never overwrites a newer one", async () => {
    const h = await copyOf(seeded);
    await read(h, owner);
    await read(h, other);
    expect((await cacheRows(h)).map((row) => row.auth_user_id).sort()).toEqual([owner, other].sort());
    // A slow call that started before the stored row was computed must not replace it
    // (another limit forces the miss; the stored row is "newer" than this call).
    await h.db.query("update public.funnelfox_leads_candidates_cache set computed_at = now() + interval '1 hour', payload = '{\"marker\": true}'::jsonb where auth_user_id = $1", [owner]);
    const result = await read(h, owner, 7, 900);
    expect(result.cached).toBe(false);
    expect(result.profile_leads.length).toBeGreaterThan(0);
    expect(await one(h.db, "select payload, profile_limit from public.funnelfox_leads_candidates_cache where auth_user_id = $1", [owner])).toEqual({
      payload: { marker: true },
      profile_limit: 3,
    });
  });

  it("deleting the account drops its cache row", async () => {
    const h = await copyOf(seeded);
    const temp = await h.createAuthUser("temp@example.com");
    await read(h, temp);
    expect((await cacheRows(h)).map((row) => row.auth_user_id)).toEqual([temp]);
    await h.db.query("delete from auth.users where id = $1", [temp]);
    expect(await cacheRows(h)).toEqual([]);
  });

  it("leads_refresh_recent_candidates: the workspace key and limit 1000 by default; the Edge read then hits", async () => {
    const h = await copyOf(seeded);
    const summary = await one<{ value: { computed_at: string; duration_ms: number; profile_leads: number } }>(
      h.db,
      "select public.leads_refresh_recent_candidates() as value",
    );
    const all = await rpc<Candidates>(h, "public.leads_recent_candidates_compute($1::uuid, 1000)", [owner]);
    expect(summary.value).toMatchObject({ profile_leads: all.profile_leads.length });
    expect(summary.value.duration_ms).toBeGreaterThanOrEqual(0);
    expect(await cacheRows(h)).toEqual([expect.objectContaining({ auth_user_id: owner, profile_limit: 1000 })]);
    const served = await rpc<Candidates>(h, "public.leads_recent_candidates($1::uuid, 1000, 900)", [owner]);
    expect(served.cached).toBe(true);
    expect(iso(served.computed_at)).toBe(iso(summary.value.computed_at));
    expect(strip(served)).toEqual(all);

    // An explicit key and limit (service_role may call it too).
    await rpc(h, "public.leads_refresh_recent_candidates($1::uuid, 2)", [other]);
    expect((await cacheRows(h)).find((row) => row.auth_user_id === other)).toMatchObject({ profile_limit: 2 });
  });
});

// ---------------------------------------------------------------------------
// Schema, grants, cron, guard
// ---------------------------------------------------------------------------

describe("schema, grants and cron", { timeout: CLONE_TIMEOUT }, () => {
  const FUNCTIONS = [
    { signature: "public.leads_recent_candidates_compute(uuid, integer)", volatile: "s", args: "p_data_key uuid, p_limit integer DEFAULT 1000" },
    { signature: "public.leads_refresh_recent_candidates(uuid, integer)", volatile: "v", args: "p_data_key uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 1000" },
    { signature: "public.leads_recent_candidates(uuid, integer, integer)", volatile: "v", args: "p_data_key uuid, p_limit integer DEFAULT 1000, p_max_age_seconds integer DEFAULT 900" },
  ];

  it("the RPCs are SECURITY INVOKER, pin search_path and are executable by service_role only", async () => {
    for (const fn of FUNCTIONS) {
      const row = await one(
        recent.db,
        `select has_function_privilege('anon', $1, 'execute') as anon,
                has_function_privilege('authenticated', $1, 'execute') as authenticated,
                has_function_privilege('service_role', $1, 'execute') as service,
                coalesce(array_to_string(p.proacl, ',') ~ '(^|,)=X', true) as public_acl,
                p.prosecdef as definer,
                p.proconfig as config,
                p.provolatile as volatile,
                pg_get_function_arguments(p.oid) as args
         from pg_proc p where p.oid = $1::regprocedure`,
        [fn.signature],
      );
      expect(row, fn.signature).toEqual({
        anon: false, authenticated: false, service: true, public_acl: false, definer: false, config: ['search_path=""'], volatile: fn.volatile, args: fn.args,
      });
    }
  });

  it("browser roles are refused", async () => {
    for (const call of [
      "public.leads_recent_candidates_compute($1::uuid, 5)",
      "public.leads_refresh_recent_candidates($1::uuid)",
      "public.leads_recent_candidates($1::uuid)",
    ]) {
      await expect(recent.asUser(owner, (tx) => tx.query(`select ${call}`, [owner])), call).rejects.toThrow(/permission denied for function/);
      await expect(recent.asAnon((tx) => tx.query(`select ${call}`, [owner])), call).rejects.toThrow(/permission denied for function/);
    }
  });

  it("the cache table: RLS on, no policies, no browser privilege; service_role reads and writes it", async () => {
    const table = await one(
      recent.db,
      `select c.relrowsecurity as rls,
              (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies,
              has_table_privilege('anon', c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') as anon,
              has_table_privilege('authenticated', c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') as authenticated,
              has_table_privilege('service_role', c.oid, 'SELECT, INSERT, UPDATE, DELETE') as service
       from pg_class c where c.oid = 'public.funnelfox_leads_candidates_cache'::regclass`,
    );
    expect(table).toEqual({ rls: true, policies: 0, anon: false, authenticated: false, service: true });
    await expect(recent.asUser(owner, (tx) => tx.query("select * from public.funnelfox_leads_candidates_cache"))).rejects.toThrow(/permission denied/);
    const columns = await recent.db.query<{ column_name: string; data_type: string; is_nullable: string }>(
      `select column_name, data_type, is_nullable from information_schema.columns
       where table_schema = 'public' and table_name = 'funnelfox_leads_candidates_cache' order by ordinal_position`,
    );
    expect(columns.rows).toEqual([
      { column_name: "auth_user_id", data_type: "uuid", is_nullable: "NO" },
      { column_name: "profile_limit", data_type: "integer", is_nullable: "NO" },
      { column_name: "computed_at", data_type: "timestamp with time zone", is_nullable: "NO" },
      { column_name: "duration_ms", data_type: "integer", is_nullable: "YES" },
      { column_name: "payload", data_type: "jsonb", is_nullable: "NO" },
    ]);
  });

  it("schedules the 5-minute pure-SQL refresh, idempotently, next to the existing leads jobs", async () => {
    const jobs = async (h: SupabasePglite) =>
      (await h.db.query("select jobname, schedule, command from cron.job where jobname like 'funnelfox-leads-%' order by jobname")).rows;
    const expected = [
      { jobname: "funnelfox-leads-advance", schedule: "* * * * *", command: "select public.invoke_funnelfox_leads_sync(false)" },
      { jobname: "funnelfox-leads-recent-cache", schedule: "*/5 * * * *", command: "select public.leads_refresh_recent_candidates()" },
      { jobname: "funnelfox-leads-refresh", schedule: "15 6 * * *", command: "select public.invoke_funnelfox_leads_sync(true)" },
    ];
    expect(await jobs(recent)).toEqual(expected);
    const h = await copyOf(seeded);
    await h.db.query("select public.leads_refresh_recent_candidates()");
    await h.applyMigration(RECENT);
    expect(await jobs(h)).toEqual(expected);
    // Re-applying keeps the cached row and the functions.
    expect((await one<{ n: number }>(h.db, "select count(*)::int as n from public.funnelfox_leads_candidates_cache")).n).toBe(1);
    // The job's command runs as postgres (pg_cron's user) and touches no HTTP.
    const requests = (await one<{ n: number }>(h.db, "select count(*)::int as n from net.stub_requests")).n;
    await h.db.query((expected[1] as { command: string }).command);
    expect((await one<{ n: number }>(h.db, "select count(*)::int as n from net.stub_requests")).n).toBe(requests);
  });

  it("refuses to apply before 202610060010, and creates nothing", async () => {
    const h = await copyOf(beforeExport);
    await expect(h.applyMigration(RECENT)).rejects.toThrow(/202610060010_funnelfox_leads_export\.sql has not been applied/);
    expect(await one(h.db, "select to_regclass('public.funnelfox_leads_candidates_cache') as cache, to_regprocedure('public.leads_recent_candidates(uuid, integer, integer)') as fn")).toEqual({ cache: null, fn: null });
    expect((await h.db.query("select jobname from cron.job where jobname = 'funnelfox-leads-recent-cache'")).rows).toEqual([]);
  });

  it("leaves the old RPC in place (the Edge's fallback before this migration)", async () => {
    expect((await one(recent.db, "select to_regprocedure('public.leads_profile_candidates(uuid, integer)') is not null as present")).present).toBe(true);
  });
});
