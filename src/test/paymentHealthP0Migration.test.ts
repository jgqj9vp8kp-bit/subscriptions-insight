// Executable tests for supabase/migrations/202610110001_payment_health_p0.sql,
// run against PGlite through the Supabase stand-in in ./support/pgliteSupabase.ts.
//
// The database is the production shape the migration lands on: every earlier
// migration (pg_cron / pg_net stubbed), the workspace bootstrapped before the
// RLS lockdown, then every migration up to 202610070001. Each test clones that
// base, seeds synthetic rows, applies the migration and asserts.
//
// Covers: the guard; refund_observed_at (backfill = the OLD updated_at of every
// refunded row; the trigger stamps once on INSERT / on the 0 -> >0 transition
// and never moves it, through a full-row upsert as the browser sends it, an
// explicit NULL, or a refund amount going back to 0); the repair of the
// mis-paired raw payloads (a swapped pair, a chain, a row whose correct payload
// exists only in another account or nowhere is left alone, the rebuilt
// normalized_payload->'raw' equals palmerTransform's raw subset byte for byte,
// the derived card_type / decline keys are dropped so the ClickHouse mapper and
// the browser hydration re-derive them from the repaired payload, a row without
// a normalized `raw` object keeps them); the country_code backfill (metadata
// JSON, invalid JSON skipped, a stored value kept, the top-level column when
// present); grants; idempotence.
//
// Runs in the default jsdom environment (src/test/setup.ts needs `window`).
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createSupabasePglite, listMigrations, type SupabasePglite } from "./support/pgliteSupabase";
import { normalizePalmerRows } from "../../supabase/functions/_shared/clickhouse/palmerTransform.ts";
import { mapSupabaseTransactionToClickHouse, type SupabaseTransactionRow } from "../../supabase/functions/_shared/clickhouse/transactionMapper.ts";
import { hydrateWarehouseTransactionsForAnalytics } from "../../supabase/functions/_shared/clickhouse/warehouseHydration.ts";
import { cardTypeFromTransaction } from "../../supabase/functions/_shared/clickhouse/userCardType.ts";

const LOCKDOWN = "202610050003_access_rls_lockdown.sql";
const RECENT = "202610070001_leads_recent_candidates.sql";
const P0 = "202610110001_payment_health_p0.sql";

const CLONE_TIMEOUT = 60_000;

let beforeRecent: SupabasePglite; // everything before 202610070001
let base: SupabasePglite; // everything before P0
let owner: string;
let other: string;
const opened: SupabasePglite[] = [];

async function copyOf(source: SupabasePglite): Promise<SupabasePglite> {
  const copy = await source.clone();
  opened.push(copy);
  return copy;
}

beforeAll(async () => {
  const db = await createSupabasePglite({ migrations: listMigrations({ before: LOCKDOWN }), extensionStubs: true });
  owner = await db.createAuthUser("owner@example.com");
  other = await db.createAuthUser("other@example.com");
  await db.db.query("select public.bootstrap_workspace($1, 'SubEngine')", [owner]);
  for (const name of listMigrations().filter((migration) => migration >= LOCKDOWN && migration < P0)) {
    if (name === RECENT) beforeRecent = await db.clone();
    await db.applyMigration(name);
  }
  base = db;
}, 300_000);

afterEach(async () => {
  while (opened.length) await opened.pop()!.close();
});

/** A synthetic Primer CSV row as the importer stores it in raw_payload. */
function primerRow(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    customerId: `cust-${id}`,
    customerEmailAddress: `${id}@example.com`,
    createdAt: "2026-05-01T10:00:00.000Z",
    amount: "2999",
    amountRefunded: "0",
    currency: "USD",
    status: "SETTLED",
    processor: "STRIPE",
    processorMerchantId: `mid-synthetic-${id}`,
    declineReasons: "[]",
    paymentInstrumentBinDataAccountFundingType: "DEBIT",
    paymentInstrumentThreeDSecureAuthenticationResponseCode: "",
    metadata: JSON.stringify({ ff_initiation_type: "cit", ff_country_code: "US", ff_billing_reason: "", ff_price_point: "29.99" }),
    ...over,
  };
}

async function insertTx(
  h: SupabasePglite,
  row: {
    owner: string;
    id: string;
    raw: Record<string, unknown> | null;
    normalized?: Record<string, unknown> | null;
    countryCode?: string | null;
    amountRefunded?: number | null;
    updatedAt?: string;
    deleted?: boolean;
  },
) {
  await h.db.query(
    `insert into public.transactions
       (auth_user_id, transaction_id, event_time, status, amount_gross, amount_refunded, currency, country_code,
        raw_payload, normalized_payload, updated_at, deleted_at)
     values ($1, $2, '2026-05-01T10:00:00Z', 'success', 29.99, $3, 'USD', $4, $5::jsonb, $6::jsonb, $7, case when $8 then now() end)`,
    [
      row.owner, row.id, row.amountRefunded ?? 0, row.countryCode ?? null,
      JSON.stringify(row.raw ?? {}), JSON.stringify(row.normalized ?? {}),
      row.updatedAt ?? "2026-09-01T00:00:00Z", row.deleted ?? false,
    ],
  );
}

async function txRow(h: SupabasePglite, ownerId: string, id: string) {
  const res = await h.db.query<{
    raw_payload: Record<string, unknown>;
    normalized_payload: Record<string, unknown>;
    country_code: string | null;
    amount_refunded: string | null;
    refund_observed_at: string | Date | null;
    updated_at: string | Date;
  }>(
    "select raw_payload, normalized_payload, country_code, amount_refunded, refund_observed_at, updated_at from public.transactions where auth_user_id = $1 and transaction_id = $2",
    [ownerId, id],
  );
  // PGlite hands timestamptz back as Date objects: compare them as ISO text.
  const row = res.rows[0];
  const iso = (value: string | Date | null) => (value == null ? null : new Date(value).toISOString());
  return { ...row, refund_observed_at: iso(row.refund_observed_at), updated_at: iso(row.updated_at) as string };
}

/** The row as clickhouse-backfill selects it, for the ClickHouse mapper. */
async function mapperRow(h: SupabasePglite, ownerId: string, id: string): Promise<SupabaseTransactionRow> {
  const res = await h.db.query<Record<string, unknown> & { event_time: string | Date; refund_observed_at: string | Date | null }>(
    `select id, auth_user_id, transaction_id, event_time, status, amount_gross, amount_refunded, currency, country_code,
            raw_payload, normalized_payload, refund_observed_at
     from public.transactions where auth_user_id = $1 and transaction_id = $2`,
    [ownerId, id],
  );
  const row = res.rows[0];
  return {
    ...row,
    event_time: new Date(row.event_time).toISOString(),
    refund_observed_at: row.refund_observed_at == null ? null : new Date(row.refund_observed_at).toISOString(),
  } as unknown as SupabaseTransactionRow;
}

describe("guard", () => {
  it("refuses before 202610070001 and names it", async () => {
    const h = await copyOf(beforeRecent);
    await expect(h.applyMigration(P0)).rejects.toThrow(/202610070001_leads_recent_candidates\.sql has not been applied/);
  }, CLONE_TIMEOUT);
});

describe("refund_observed_at", () => {
  it("backfills refunded rows with their OLD updated_at (approximate, documented) and leaves the rest null", async () => {
    const h = await copyOf(base);
    await insertTx(h, { owner, id: "r-refunded", raw: primerRow("r-refunded"), amountRefunded: 29.99, updatedAt: "2026-08-15T08:00:00Z" });
    await insertTx(h, { owner, id: "r-none", raw: primerRow("r-none"), amountRefunded: 0 });
    await insertTx(h, { owner, id: "r-null", raw: primerRow("r-null"), amountRefunded: null });
    await h.applyMigration(P0);

    const refunded = await txRow(h, owner, "r-refunded");
    expect(new Date(refunded.refund_observed_at as string).toISOString()).toBe("2026-08-15T08:00:00.000Z");
    // the backfill UPDATE went through the updated_at trigger: the row is re-queued for the sync
    expect(new Date(refunded.updated_at).getTime()).toBeGreaterThan(Date.parse("2026-08-15T08:00:00Z"));
    expect((await txRow(h, owner, "r-none")).refund_observed_at).toBeNull();
    expect((await txRow(h, owner, "r-null")).refund_observed_at).toBeNull();

    const comment = await h.db.query<{ c: string }>(
      "select col_description('public.transactions'::regclass, attnum) as c from pg_attribute where attrelid = 'public.transactions'::regclass and attname = 'refund_observed_at'",
    );
    expect(comment.rows[0].c).toMatch(/APPROXIMATE/);
  }, CLONE_TIMEOUT);

  it("is set once on the 0 -> >0 transition and never moves afterwards (full-row upsert, explicit null, back to 0)", async () => {
    const h = await copyOf(base);
    await h.applyMigration(P0);
    const before = Date.now() - 1000;
    await insertTx(h, { owner, id: "t-1", raw: primerRow("t-1"), amountRefunded: 0 });
    expect((await txRow(h, owner, "t-1")).refund_observed_at).toBeNull();

    // The browser upsert: the whole row again, now with the refund, no refund_observed_at in the payload.
    const upsert = (amountRefunded: number) =>
      h.db.query(
        `insert into public.transactions (auth_user_id, transaction_id, event_time, status, amount_gross, amount_refunded, currency, raw_payload, normalized_payload)
         values ($1, $2, '2026-05-01T10:00:00Z', 'success', 29.99, $3, 'USD', '{}'::jsonb, '{}'::jsonb)
         on conflict (auth_user_id, transaction_id) do update
           set amount_refunded = excluded.amount_refunded, raw_payload = excluded.raw_payload, normalized_payload = excluded.normalized_payload`,
        [owner, "t-1", amountRefunded],
      );
    await upsert(29.99);
    const first = (await txRow(h, owner, "t-1")).refund_observed_at as string;
    expect(first).not.toBeNull();
    expect(new Date(first).getTime()).toBeGreaterThanOrEqual(before);

    await new Promise((resolve) => setTimeout(resolve, 20));
    await upsert(29.99);
    expect((await txRow(h, owner, "t-1")).refund_observed_at).toBe(first);
    await h.db.query("update public.transactions set refund_observed_at = null where auth_user_id = $1 and transaction_id = $2", [owner, "t-1"]);
    expect((await txRow(h, owner, "t-1")).refund_observed_at).toBe(first);
    await h.db.query("update public.transactions set refund_observed_at = '2020-01-01T00:00:00Z' where auth_user_id = $1 and transaction_id = $2", [owner, "t-1"]);
    expect((await txRow(h, owner, "t-1")).refund_observed_at).toBe(first);
    await upsert(0);
    expect((await txRow(h, owner, "t-1")).refund_observed_at).toBe(first);
    await upsert(29.99); // a second transition does not re-stamp
    expect((await txRow(h, owner, "t-1")).refund_observed_at).toBe(first);
  }, CLONE_TIMEOUT);

  it("an INSERT that already carries a refund is stamped now(); an explicit value on the transition is kept", async () => {
    const h = await copyOf(base);
    await h.applyMigration(P0);
    const before = Date.now() - 1000;
    await insertTx(h, { owner, id: "t-2", raw: primerRow("t-2"), amountRefunded: 5 });
    const stamped = (await txRow(h, owner, "t-2")).refund_observed_at as string;
    expect(new Date(stamped).getTime()).toBeGreaterThanOrEqual(before);

    await insertTx(h, { owner, id: "t-3", raw: primerRow("t-3"), amountRefunded: 0 });
    await h.db.query(
      "update public.transactions set amount_refunded = 5, refund_observed_at = '2026-07-01T00:00:00Z' where auth_user_id = $1 and transaction_id = $2",
      [owner, "t-3"],
    );
    expect(new Date((await txRow(h, owner, "t-3")).refund_observed_at as string).toISOString()).toBe("2026-07-01T00:00:00.000Z");
  }, CLONE_TIMEOUT);

  it("fires for the browser role too (the trigger function is executable by nobody, the trigger still runs)", async () => {
    const h = await copyOf(base);
    await h.applyMigration(P0);
    await h.asUser(owner, async (tx) => {
      await tx.query(
        `insert into public.transactions (auth_user_id, transaction_id, event_time, status, amount_refunded, raw_payload, normalized_payload)
         values ($1, 'browser-1', '2026-05-01T10:00:00Z', 'success', 1, '{}'::jsonb, '{}'::jsonb)`,
        [owner],
      );
    });
    expect((await txRow(h, owner, "browser-1")).refund_observed_at).not.toBeNull();
  }, CLONE_TIMEOUT);
});

describe("repair of the mis-paired raw payloads", () => {
  it("swaps, chains, keeps the unrepairable, never crosses accounts, rebuilds normalized_payload->'raw' exactly", async () => {
    const h = await copyOf(base);
    const rawA = primerRow("tx-a", {
      status: "DECLINED", processor: "ADYEN", paymentInstrumentBinDataAccountFundingType: "CREDIT",
      declineReasons: "[{'decline_reason': 'DO_NOT_HONOR', 'advised_action': 'DO_NOT_RETRY'}]",
    });
    const rawB = primerRow("tx-b");
    const rawC = primerRow("tx-c", { metadata: JSON.stringify({ ff_country_code: "BR" }) });
    const rawD = primerRow("tx-d");
    const rawF = primerRow("tx-f");
    const staleRaw = { status: "STALE", metadata: {} };
    const eventTime = "2026-05-01T10:00:00.000Z";
    // A <-> B swapped; C holds D's payload while D holds its own (a chain of one); F's correct
    // payload exists only in the OTHER account; G's correct payload exists nowhere; H is deleted.
    // A and B carry the derived keys the legacy repair persisted from the mis-paired payload: A
    // (a CREDIT decline) holds B's DEBIT card type and a wrong decline bucket, B (a SETTLED
    // success) holds A's card type and the decline bucket A's DECLINED payload gave it.
    await insertTx(h, {
      owner, id: "tx-a",
      raw: rawB,
      normalized: {
        transaction_id: "tx-a", event_time: eventTime, user_id: "user-a", status: "failed", amount_usd: 29.99, gross_amount_usd: 29.99, currency: "USD",
        raw: staleRaw, card_type: "debit", normalized_decline_reason: "insufficient_funds", decline_message: "stale message",
      },
    });
    await insertTx(h, {
      owner, id: "tx-b",
      raw: rawA,
      normalized: {
        transaction_id: "tx-b", event_time: eventTime, user_id: "user-b", status: "success", amount_usd: 29.99, gross_amount_usd: 29.99, currency: "USD",
        raw: staleRaw, card_type: "credit", normalized_decline_reason: "do_not_honor", decline_message: "Do not honor",
      },
    });
    await insertTx(h, { owner, id: "tx-c", raw: rawD, normalized: { transaction_id: "tx-c", raw: staleRaw } });
    await insertTx(h, { owner, id: "tx-d", raw: rawD, normalized: { transaction_id: "tx-d", raw: staleRaw } });
    await insertTx(h, { owner, id: "tx-c-holder", raw: rawC, normalized: { transaction_id: "tx-c-holder", raw: staleRaw } });
    await insertTx(h, { owner, id: "tx-f", raw: primerRow("tx-zzz"), normalized: { transaction_id: "tx-f", raw: staleRaw } });
    await insertTx(h, { owner: other, id: "other-1", raw: rawF, normalized: { transaction_id: "other-1", raw: staleRaw } });
    await insertTx(h, { owner, id: "tx-g", raw: primerRow("tx-nowhere"), normalized: { transaction_id: "tx-g", raw: staleRaw } });
    // A row without a `raw` object in normalized_payload (clean-template import): raw_payload is
    // repaired, normalized_payload untouched (its derived keys included: the slim fetch would have
    // nothing to re-derive them from).
    await insertTx(h, { owner, id: "tx-plain", raw: primerRow("tx-plain-other"), normalized: { transaction_id: "tx-plain", card_type: "debit" } });
    await insertTx(h, { owner, id: "tx-plain-holder", raw: primerRow("tx-plain"), normalized: { transaction_id: "tx-plain-holder" } });

    await h.applyMigration(P0);

    const a = await txRow(h, owner, "tx-a");
    const b = await txRow(h, owner, "tx-b");
    expect(a.raw_payload).toEqual(rawA);
    expect(b.raw_payload).toEqual(rawB);
    // normalized_payload->'raw' = the TS raw subset of the repaired payload; the rest of the payload stays.
    const expectedRawA = JSON.parse(JSON.stringify(normalizePalmerRows([rawA])[0].raw));
    expect(a.normalized_payload.raw).toEqual(expectedRawA);
    expect(a.normalized_payload.status).toBe("failed");
    expect((a.normalized_payload.raw as Record<string, unknown>).status).toBe("DECLINED");
    expect((b.normalized_payload.raw as Record<string, unknown>).status).toBe("SETTLED");
    expect((a.normalized_payload.raw as Record<string, unknown>).ff_country_code).toBe("US");
    // every key of the subset is present (metadata merged with the direct funding-type column)
    expect(Object.keys(a.normalized_payload.raw as Record<string, unknown>).sort()).toEqual(Object.keys(expectedRawA).sort());
    expect((a.normalized_payload.raw as Record<string, unknown>).metadata).toEqual({
      ff_initiation_type: "cit", ff_country_code: "US", ff_billing_reason: "", ff_price_point: "29.99",
      paymentInstrumentBinDataAccountFundingType: "CREDIT",
    });

    // The derived keys are dropped on the repaired rows (the mapper and the hydration read them
    // FIRST and only fall back to the payload when absent); the rest of the payload stays.
    for (const payload of [a.normalized_payload, b.normalized_payload]) {
      expect(payload).not.toHaveProperty("card_type");
      expect(payload).not.toHaveProperty("normalized_decline_reason");
      expect(payload).not.toHaveProperty("decline_message");
    }
    expect(b.normalized_payload).toMatchObject({ transaction_id: "tx-b", status: "success", user_id: "user-b", currency: "USD" });

    // ClickHouse mapper (clickhouse-backfill): the repaired row maps exactly like a row that was
    // imported with its own payload from the start (card type from the funding type of the repaired
    // payload, decline bucket from its declineReasons, none on the success row).
    const cleanImport = (id: string, status: string, raw: Record<string, unknown>) =>
      mapSupabaseTransactionToClickHouse({
        authUserId: owner,
        row: {
          transaction_id: id, event_time: eventTime, status, currency: "USD", amount_gross: 29.99, raw_payload: raw,
          normalized_payload: { transaction_id: id, event_time: eventTime, status, amount_usd: 29.99, gross_amount_usd: 29.99, currency: "USD", raw: normalizePalmerRows([raw])[0].raw },
        },
      });
    const mappedA = mapSupabaseTransactionToClickHouse({ authUserId: owner, row: await mapperRow(h, owner, "tx-a") });
    const mappedB = mapSupabaseTransactionToClickHouse({ authUserId: owner, row: await mapperRow(h, owner, "tx-b") });
    expect(mappedA).toMatchObject({ card_type: "credit", decline_reason: "do_not_honor", processor: "ADYEN", raw_status: "DECLINED", primer_decline_code: "DO_NOT_HONOR" });
    expect(mappedB).toMatchObject({ card_type: "debit", decline_reason: "", processor: "STRIPE", raw_status: "SETTLED", primer_decline_code: "" });
    const derived = ["card_type", "decline_reason", "processor", "raw_status", "primer_decline_code", "advised_action", "decline_type"] as const;
    for (const key of derived) {
      expect(mappedA?.[key], key).toEqual(cleanImport("tx-a", "failed", rawA)?.[key]);
      expect(mappedB?.[key], key).toEqual(cleanImport("tx-b", "success", rawB)?.[key]);
    }

    // Browser hydration from the slim fetch (normalized_payload only, no raw_payload): the decline
    // bucket comes back from the rebuilt raw subset on the failed row and not at all on the success
    // row; the card type is read through cardTypeFromTransaction's raw fallback.
    const hydrated = hydrateWarehouseTransactionsForAnalytics([
      { source: "palmer_csv", normalized_payload: a.normalized_payload },
      { source: "palmer_csv", normalized_payload: b.normalized_payload },
    ]);
    const hydratedA = hydrated.find((tx) => tx.transaction_id === "tx-a");
    const hydratedB = hydrated.find((tx) => tx.transaction_id === "tx-b");
    expect(hydratedA?.normalized_decline_reason).toBe("do_not_honor");
    expect(hydratedA?.decline_message).toBe("DO_NOT_HONOR");
    expect(cardTypeFromTransaction(hydratedA!)).toBe("credit");
    expect(hydratedB?.normalized_decline_reason).toBeUndefined();
    expect(hydratedB?.decline_message).toBeUndefined();
    expect(cardTypeFromTransaction(hydratedB!)).toBe("debit");

    expect((await txRow(h, owner, "tx-c")).raw_payload).toEqual(rawC);
    expect((await txRow(h, owner, "tx-d")).raw_payload).toEqual(rawD);
    expect((await txRow(h, owner, "tx-c-holder")).raw_payload).toEqual(rawC); // still mismatched: nobody holds its payload
    expect((await txRow(h, owner, "tx-f")).raw_payload).toEqual(primerRow("tx-zzz")); // other account's copy is never used
    expect((await txRow(h, other, "other-1")).raw_payload).toEqual(rawF);
    expect((await txRow(h, owner, "tx-g")).raw_payload).toEqual(primerRow("tx-nowhere"));
    const plain = await txRow(h, owner, "tx-plain");
    expect(plain.raw_payload).toEqual(primerRow("tx-plain"));
    expect(plain.normalized_payload).toEqual({ transaction_id: "tx-plain", card_type: "debit" });

    // Invariant the before/after script checks: no row whose correct payload exists is mismatched.
    const left = await h.db.query<{ n: number }>(
      `select count(*)::int as n from public.transactions t
       where t.raw_payload ->> 'id' <> t.transaction_id
         and exists (select 1 from public.transactions s where s.auth_user_id = t.auth_user_id and s.raw_payload ->> 'id' = t.transaction_id)`,
    );
    expect(left.rows[0].n).toBe(0);
  }, CLONE_TIMEOUT);

  it("the SQL mirror of palmerTransform's raw subset matches the TypeScript output on alias and edge cases", async () => {
    const h = await copyOf(base);
    await h.applyMigration(P0);
    const rows = [
      primerRow("m-1"),
      // header aliases, direct columns, an apostrophe-quoted record, a blank metadata cell
      { id: "m-2", "Decline Reasons": "[{'message': \"Card's limit\"}]", Status: "DECLINED", error_message: "boom", metadata: "", ff_country_code: "de " },
      { id: "m-3", metadata: "not json", processor: "  " },
      { id: "m-4", metadata: JSON.stringify([1, 2]), payload: JSON.stringify({ ff_funnel_id: "f1" }) },
    ];
    for (const raw of rows) {
      const res = await h.db.query<{ raw: Record<string, unknown> }>("select app.palmer_normalized_raw($1::jsonb) as raw", [JSON.stringify(raw)]);
      const expected = JSON.parse(JSON.stringify(normalizePalmerRows([raw])[0].raw));
      expect(res.rows[0].raw, String(raw.id)).toEqual(expected);
    }
  }, CLONE_TIMEOUT);
});

describe("country_code backfill", () => {
  it("fills empty values from metadata.ff_country_code, skips invalid JSON, keeps stored values", async () => {
    const h = await copyOf(base);
    await insertTx(h, { owner, id: "c-meta", raw: primerRow("c-meta") });
    await insertTx(h, { owner, id: "c-blank", raw: primerRow("c-blank"), countryCode: "  " });
    await insertTx(h, { owner, id: "c-invalid", raw: primerRow("c-invalid", { metadata: "{not json" }) });
    await insertTx(h, { owner, id: "c-array", raw: primerRow("c-array", { metadata: "[1,2]" }) });
    await insertTx(h, { owner, id: "c-missing", raw: primerRow("c-missing", { metadata: JSON.stringify({ ff_initiation_type: "mit" }) }) });
    await insertTx(h, { owner, id: "c-kept", raw: primerRow("c-kept"), countryCode: "DE" });
    await insertTx(h, { owner, id: "c-direct", raw: primerRow("c-direct", { ff_country_code: "FR" }) });
    await insertTx(h, { owner, id: "c-noraw", raw: null });
    await insertTx(h, { owner: other, id: "c-other", raw: primerRow("c-other", { metadata: JSON.stringify({ ff_country_code: "MX" }) }) });

    await h.applyMigration(P0);

    expect((await txRow(h, owner, "c-meta")).country_code).toBe("US");
    expect((await txRow(h, owner, "c-blank")).country_code).toBe("US");
    expect((await txRow(h, owner, "c-invalid")).country_code).toBeNull();
    expect((await txRow(h, owner, "c-array")).country_code).toBeNull();
    expect((await txRow(h, owner, "c-missing")).country_code).toBeNull();
    expect((await txRow(h, owner, "c-kept")).country_code).toBe("DE");
    expect((await txRow(h, owner, "c-direct")).country_code).toBe("FR");
    expect((await txRow(h, owner, "c-noraw")).country_code).toBeNull();
    expect((await txRow(h, other, "c-other")).country_code).toBe("MX");
  }, CLONE_TIMEOUT);
});

describe("grants, trigger and idempotence", () => {
  it("no API role can execute the new functions; the trigger is attached; a second run changes nothing", async () => {
    const h = await copyOf(base);
    await insertTx(h, { owner, id: "i-refund", raw: primerRow("i-refund"), amountRefunded: 3, updatedAt: "2026-08-01T00:00:00Z" });
    await h.applyMigration(P0);
    for (const signature of [
      "app.transactions_refund_observed_at()", "app.palmer_raw_value(jsonb, text[])", "app.try_jsonb_object(text)",
      "app.palmer_parse_metadata(jsonb)", "app.palmer_normalized_raw(jsonb)",
    ]) {
      const grants = await h.db.query<{ anon: boolean; authenticated: boolean; service: boolean }>(
        `select has_function_privilege('anon', $1, 'execute') as anon,
                has_function_privilege('authenticated', $1, 'execute') as authenticated,
                has_function_privilege('service_role', $1, 'execute') as service`,
        [signature],
      );
      expect(grants.rows[0], signature).toEqual({ anon: false, authenticated: false, service: false });
    }
    const trigger = await h.db.query<{ tgname: string; tgtype: number }>(
      "select tgname, tgtype from pg_trigger where tgrelid = 'public.transactions'::regclass and tgname = 'transactions_set_refund_observed_at'",
    );
    expect(trigger.rows).toHaveLength(1);
    // BEFORE (bit 1) ROW (bit 0) INSERT (bit 2) UPDATE (bit 4)
    expect(trigger.rows[0].tgtype & 0b10111).toBe(0b10111);

    const first = await txRow(h, owner, "i-refund");
    await h.applyMigration(P0);
    const second = await txRow(h, owner, "i-refund");
    expect(second.refund_observed_at).toBe(first.refund_observed_at);
    expect(new Date(second.refund_observed_at as string).toISOString()).toBe("2026-08-01T00:00:00.000Z");
  }, CLONE_TIMEOUT);
});
