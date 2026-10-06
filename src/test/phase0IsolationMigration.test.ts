// Executable tests for supabase/migrations/202610050001_phase0_isolation_fixes.sql
// (PGlite via ./support/pgliteSupabase.ts). The owner-scoped overload
// active_funnelfox_subscription_emails(p_data_key) must return only that
// owner's live subscriptions and be reachable by service_role only; the legacy
// no-arg form stays RLS-scoped for authenticated callers and closed to anon.
//
// Runs in the default jsdom environment (src/test/setup.ts needs `window`).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PHASE0_TEST_MIGRATIONS, createSupabasePglite, type SupabasePglite } from "./support/pgliteSupabase";

let h: SupabasePglite;
let ownerA: string;
let ownerB: string;

const DAY_MS = 86_400_000;
const future = () => new Date(Date.now() + 30 * DAY_MS).toISOString();
const past = () => new Date(Date.now() - 30 * DAY_MS).toISOString();

async function insertSubscription(row: {
  owner: string;
  id: string;
  email: string;
  status?: string;
  renews?: boolean;
  periodEndsAt?: string;
  rawDetail?: Record<string, unknown> | null;
  rawList?: Record<string, unknown> | null;
}) {
  await h.db.query(
    `insert into public.funnelfox_subscriptions
       (auth_user_id, subscription_id, normalized_email, status, renews, period_ends_at, raw_detail, raw_list)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)`,
    [
      row.owner,
      row.id,
      row.email,
      row.status ?? "active",
      row.renews ?? true,
      row.periodEndsAt ?? future(),
      row.rawDetail ? JSON.stringify(row.rawDetail) : null,
      row.rawList ? JSON.stringify(row.rawList) : null,
    ],
  );
}

const scoped = (dataKey: string | null) =>
  h.asService(async (tx) =>
    (await tx.query<{ value: Record<string, string[]> }>("select public.active_funnelfox_subscription_emails($1::uuid) as value", [dataKey]))
      .rows[0].value,
  );

beforeAll(async () => {
  h = await createSupabasePglite({ migrations: PHASE0_TEST_MIGRATIONS });
  ownerA = await h.createAuthUser("owner-a@example.com");
  ownerB = await h.createAuthUser("owner-b@example.com");

  await insertSubscription({ owner: ownerA, id: "a-live-1", email: " Shared@Example.com " });
  await insertSubscription({ owner: ownerA, id: "a-live-2", email: "shared@example.com" });
  await insertSubscription({ owner: ownerA, id: "a-only", email: "a-only@example.com" });
  await insertSubscription({ owner: ownerA, id: "a-sandbox", email: "qa@example.com", rawDetail: { sandbox: true } });
  await insertSubscription({ owner: ownerA, id: "a-expired", email: "gone@example.com", periodEndsAt: past() });
  await insertSubscription({ owner: ownerA, id: "a-cancelled", email: "cancel@example.com", status: "cancelled" });
  await insertSubscription({ owner: ownerA, id: "a-no-renew", email: "norenew@example.com", renews: false });
  await insertSubscription({ owner: ownerB, id: "b-live", email: "shared@example.com" });
  await insertSubscription({ owner: ownerB, id: "b-only", email: "b-only@example.com" });
}, 120_000);

afterAll(async () => {
  await h?.close();
});

describe("active_funnelfox_subscription_emails(p_data_key)", () => {
  it("returns only the given owner's active, non-sandbox subscriptions", async () => {
    const forA = await scoped(ownerA);
    expect(Object.keys(forA).sort()).toEqual(["a-only@example.com", "shared@example.com"]);
    expect([...forA["shared@example.com"]].sort()).toEqual(["a-live-1", "a-live-2"]);
    expect(JSON.stringify(forA)).not.toContain("b-");

    const forB = await scoped(ownerB);
    expect(forB).toEqual({ "b-only@example.com": ["b-only"], "shared@example.com": ["b-live"] });
  });

  it("returns nothing for a null or unknown owner (never all owners)", async () => {
    expect(await scoped(null)).toEqual({});
    expect(await scoped("00000000-0000-0000-0000-000000000000")).toEqual({});
  });

  it("is executable by service_role only", async () => {
    await expect(
      h.asUser(ownerA, (tx) => tx.query("select public.active_funnelfox_subscription_emails($1::uuid)", [ownerA])),
    ).rejects.toThrow(/permission denied for function active_funnelfox_subscription_emails/);
    await expect(
      h.asAnon((tx) => tx.query("select public.active_funnelfox_subscription_emails($1::uuid)", [ownerA])),
    ).rejects.toThrow(/permission denied/);
    const grants = await h.db.query(
      `select has_function_privilege('anon', 'public.active_funnelfox_subscription_emails(uuid)', 'execute') anon,
              has_function_privilege('authenticated', 'public.active_funnelfox_subscription_emails(uuid)', 'execute') authenticated,
              has_function_privilege('service_role', 'public.active_funnelfox_subscription_emails(uuid)', 'execute') service`,
    );
    expect(grants.rows[0]).toEqual({ anon: false, authenticated: false, service: true });
  });
});

describe("legacy active_funnelfox_subscription_emails()", () => {
  it("stays RLS-scoped to the authenticated caller", async () => {
    const mine = await h.asUser(ownerB, async (tx) =>
      (await tx.query<{ value: Record<string, string[]> }>("select public.active_funnelfox_subscription_emails() as value")).rows[0].value,
    );
    expect(mine).toEqual({ "b-only@example.com": ["b-only"], "shared@example.com": ["b-live"] });
  });

  it("is closed to anon but kept for authenticated and the deployed service-role caller", async () => {
    await expect(h.asAnon((tx) => tx.query("select public.active_funnelfox_subscription_emails()"))).rejects.toThrow(
      /permission denied for function active_funnelfox_subscription_emails/,
    );
    const grants = await h.db.query(
      `select has_function_privilege('anon', 'public.active_funnelfox_subscription_emails()', 'execute') anon,
              has_function_privilege('authenticated', 'public.active_funnelfox_subscription_emails()', 'execute') authenticated,
              has_function_privilege('service_role', 'public.active_funnelfox_subscription_emails()', 'execute') service`,
    );
    expect(grants.rows[0]).toEqual({ anon: false, authenticated: true, service: true });
  });
});
