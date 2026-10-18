// Executable tests for supabase/migrations/202610180001_brainza_campaign_path_prefix.sql,
// run against PGlite through the Supabase stand-in in ./support/pgliteSupabase.ts.
//
// The database is the production shape the migration lands on: every earlier
// migration (pg_cron / pg_net stubbed) with the workspace bootstrapped before the
// RLS lockdown. Rows are stored the way the importer stored them BEFORE the
// Brainza prefix (palmerTransform without the project rule, metadata keeping
// ff_project_id); after the migration campaign_path and cohort_id must equal what
// palmerTransform produces today for the same Primer rows.
//
// Covers: Brainza trial / decline / later payment without metadata; a FoxIQ user
// with the same path and trial date keeps the bare path and the old cohort_id;
// other projects and already-prefixed rows are untouched (updated_at included);
// every other payload key is kept; a second run changes nothing.
//
// Runs in the default jsdom environment (src/test/setup.ts needs `window`).
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createSupabasePglite, listMigrations, type SupabasePglite } from "./support/pgliteSupabase";
import { transformPalmerRows, type RawPalmerRow } from "../../supabase/functions/_shared/clickhouse/palmerTransform.ts";
import type { Transaction } from "../../supabase/functions/_shared/clickhouse/serviceTypes.ts";

const LOCKDOWN = "202610050003_access_rls_lockdown.sql";
const MIGRATION = "202610180001_brainza_campaign_path_prefix.sql";

const BRAINZA = "01KKEGM9PVW291BKJKYNC7QPSV";
const FOXIQ = "01M36MDN39CQYEKTPZ92PN2R33";
const AZORA = "01KJQKSJ0H4EBZQ9SGVAQ1BNSB";
const OLD_UPDATED_AT = "2026-09-01T00:00:00.000Z";

let base: SupabasePglite;
let owner: string;
const opened: SupabasePglite[] = [];

beforeAll(async () => {
  const db = await createSupabasePglite({ migrations: listMigrations({ before: LOCKDOWN }), extensionStubs: true });
  owner = await db.createAuthUser("owner@example.com");
  await db.db.query("select public.bootstrap_workspace($1, 'SubEngine')", [owner]);
  for (const name of listMigrations().filter((migration) => migration >= LOCKDOWN && migration < MIGRATION)) {
    await db.applyMigration(name);
  }
  base = db;
}, 300_000);

afterEach(async () => {
  while (opened.length) await opened.pop()!.close();
});

async function copyOf(source: SupabasePglite): Promise<SupabasePglite> {
  const copy = await source.clone();
  opened.push(copy);
  return copy;
}

function primer(id: string, user: string, at: string, amount: string, status: string, metadata?: Record<string, unknown>): RawPalmerRow {
  return {
    id,
    customerId: user,
    customerEmailAddress: `${user}@example.com`,
    createdAt: at,
    amount,
    currency: "USD",
    status,
    ...(metadata ? { metadata: JSON.stringify(metadata) } : {}),
  };
}

const RAW: RawPalmerRow[] = [
  primer("a-decline", "brainza-user", "2026-05-24T09:55:00Z", "100", "DECLINED", { ff_campaign_path: "/test-iq", ff_project_id: BRAINZA }),
  primer("a-trial", "brainza-user", "2026-05-24T10:00:00Z", "100", "SETTLED", { ff_campaign_path: "/test-iq", ff_project_id: BRAINZA }),
  primer("a-sub", "brainza-user", "2026-05-31T10:00:00Z", "2999", "SETTLED"),
  primer("b-trial", "foxiq-user", "2026-05-24T11:00:00Z", "100", "SETTLED", { ff_campaign_path: "/test-iq", ff_project_id: FOXIQ }),
  primer("b-sub", "foxiq-user", "2026-05-31T11:00:00Z", "2999", "SETTLED"),
  primer("c-trial", "azora-user", "2026-05-24T12:00:00Z", "100", "SETTLED", { ff_campaign_path: "/soulmate-reading", ff_project_id: AZORA }),
  primer("d-trial", "brainza-url-user", "2026-04-10T12:00:00Z", "100", "SETTLED", { ff_project_id: BRAINZA, initialUrl: "https://quiz.brainza.app/my-test-iq2?utm_source=fb" }),
];

/** What the importer stored before the Brainza rule: the same transform without
 * ff_project_id, then the metadata (which the warehouse keeps verbatim) put back. */
function storedBeforePrefix(): Transaction[] {
  const withoutProject = RAW.map((row) => {
    if (typeof row.metadata !== "string") return row;
    const { ff_project_id: _dropped, ...rest } = JSON.parse(row.metadata) as Record<string, unknown>;
    return { ...row, metadata: JSON.stringify(rest) };
  });
  const metadataById = new Map(RAW.map((row) => [String(row.id), typeof row.metadata === "string" ? JSON.parse(row.metadata) : undefined]));
  return transformPalmerRows(withoutProject).map((tx) => {
    const metadata = metadataById.get(tx.transaction_id);
    return metadata ? { ...tx, metadata: { ...tx.metadata, ...metadata } } : tx;
  });
}

async function insertTx(h: SupabasePglite, tx: Transaction) {
  await h.db.query(
    `insert into public.transactions
       (auth_user_id, user_id, transaction_id, event_time, status, transaction_type, currency, campaign_path, funnel,
        raw_payload, normalized_payload, updated_at)
     values ($1, $2, $3, $4, $5, $6, 'USD', $7, $8, '{}'::jsonb, $9::jsonb, $10)`,
    [owner, tx.user_id, tx.transaction_id, tx.event_time, tx.status, tx.transaction_type, tx.campaign_path, tx.funnel, JSON.stringify(tx), OLD_UPDATED_AT],
  );
}

type Stored = { transaction_id: string; campaign_path: string | null; normalized_payload: Record<string, unknown>; updated_at: string | Date };

async function rows(h: SupabasePglite): Promise<Map<string, Stored>> {
  const result = await h.db.query<Stored>("select transaction_id, campaign_path, normalized_payload, updated_at from public.transactions order by transaction_id");
  return new Map(result.rows.map((row) => [row.transaction_id, row]));
}

const iso = (value: string | Date) => new Date(value).toISOString();

describe("202610180001 Brainza campaign path prefix", () => {
  it("rewrites stored Brainza rows to what the importer produces now and leaves every other project alone", async () => {
    const h = await copyOf(base);
    const before = storedBeforePrefix();
    for (const tx of before) await insertTx(h, tx);
    expect(before.find((tx) => tx.transaction_id === "a-trial")?.cohort_id).toBe("unknown_test-iq_2026-05-24");
    expect(before.find((tx) => tx.transaction_id === "b-trial")?.cohort_id).toBe("unknown_test-iq_2026-05-24");

    await h.applyMigration(MIGRATION);

    const after = await rows(h);
    const expected = new Map(transformPalmerRows(RAW).map((tx) => [tx.transaction_id, tx]));
    for (const old of before) {
      const row = after.get(old.transaction_id)!;
      const want = expected.get(old.transaction_id)!;
      expect(row.campaign_path, old.transaction_id).toBe(want.campaign_path);
      expect(row.normalized_payload.campaign_path, old.transaction_id).toBe(want.campaign_path);
      expect(row.normalized_payload.cohort_id, old.transaction_id).toBe(want.cohort_id);
      const { campaign_path: _p, cohort_id: _c, ...restAfter } = row.normalized_payload;
      const { campaign_path: _op, cohort_id: _oc, ...restBefore } = JSON.parse(JSON.stringify(old)) as Record<string, unknown>;
      expect(restAfter, old.transaction_id).toEqual(restBefore);
    }

    expect(after.get("a-trial")?.campaign_path).toBe("brainza-test-iq");
    expect(after.get("a-decline")?.campaign_path).toBe("brainza-test-iq");
    expect(after.get("a-sub")?.campaign_path).toBe("unknown");
    expect(after.get("a-sub")?.normalized_payload.cohort_id).toBe("unknown_brainza-test-iq_2026-05-24");
    expect(after.get("d-trial")?.campaign_path).toBe("brainza-my-test-iq2");
    expect(after.get("b-trial")?.campaign_path).toBe("test-iq");
    expect(after.get("b-sub")?.normalized_payload.cohort_id).toBe("unknown_test-iq_2026-05-24");

    for (const id of ["a-decline", "a-trial", "a-sub", "d-trial"]) {
      expect(iso(after.get(id)!.updated_at), id).not.toBe(OLD_UPDATED_AT);
    }
    for (const id of ["b-trial", "b-sub", "c-trial"]) {
      expect(iso(after.get(id)!.updated_at), id).toBe(OLD_UPDATED_AT);
    }
  }, 60_000);

  it("keeps the legacy `{path}_{date}` cohort_id shape and still matches by user, not by cohort_id", async () => {
    const h = await copyOf(base);
    const legacy = (tx: Transaction): Transaction => ({ ...tx, cohort_id: `${tx.campaign_path === "unknown" ? "test-iq" : tx.campaign_path}_2026-05-24` });
    for (const tx of storedBeforePrefix()) {
      await insertTx(h, ["a-trial", "a-decline", "a-sub", "b-trial", "b-sub"].includes(tx.transaction_id) ? legacy(tx) : tx);
    }

    await h.applyMigration(MIGRATION);

    const after = await rows(h);
    for (const id of ["a-trial", "a-decline", "a-sub"]) {
      expect(after.get(id)?.normalized_payload.cohort_id, id).toBe("brainza-test-iq_2026-05-24");
    }
    for (const id of ["b-trial", "b-sub"]) {
      expect(after.get(id)?.normalized_payload.cohort_id, id).toBe("test-iq_2026-05-24");
    }
  }, 60_000);

  it("skips rows the new importer already wrote and changes nothing on a second run", async () => {
    const h = await copyOf(base);
    for (const tx of transformPalmerRows(RAW)) await insertTx(h, tx);
    const fresh = await rows(h);

    await h.applyMigration(MIGRATION);
    expect(await rows(h)).toEqual(fresh);

    const migrated = await copyOf(base);
    for (const tx of storedBeforePrefix()) await insertTx(migrated, tx);
    await migrated.applyMigration(MIGRATION);
    const once = await rows(migrated);
    await migrated.applyMigration(MIGRATION);
    expect(await rows(migrated)).toEqual(once);
  }, 60_000);
});
