// Executable tests for supabase/migrations/202610130001_payment_health_alerts.sql
// and 202610130002_payment_health_alerts_cron.sql (Payment System Health P2.5,
// plan section Q), run against PGlite through the Supabase stand-in in
// ./support/pgliteSupabase.ts on the production shape: every earlier migration
// (pg_cron / pg_net stubbed), the workspace bootstrapped before the RLS
// lockdown, the lockdown, the leads series and the payment health P0 / P1 / P2
// migrations.
//
// Covers: the guards (the alerts refuse before 202610120001, the cron before
// the alerts; nothing created); the tables' shape, RLS, grants (no browser
// role; the service role reads and writes only through the functions) and the
// functions' privileges; the rule seed (the MVP rules = DEFAULT_ALERT_RULES)
// and its idempotence without resetting an owner's edits; the check
// constraints (low confidence is only ever info); the run claim (interval,
// running run, stale run); the apply semantics (insert, refresh by alert_key,
// carry forward, auto-resolve that never touches dismissed / owner-resolved
// alerts, reopen, suppression of an owner-closed alert's evidence — a count
// alert's old events, a rate alert's overlapping window — unless more severe,
// scope aliases of a registered Unlabelled MID); the status change
// (transitions, history, assignee, the audit row written in the same
// transaction, nothing on a refused change); the daily cron job (created once,
// the request it posts, closed to API roles).
//
// Every id and value is synthetic. Runs in the default jsdom environment.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createSupabasePglite, listMigrations, readMigration, type SqlRunner, type SupabasePglite } from "./support/pgliteSupabase";
import { ALERT_RULE_KEYS, DEFAULT_ALERT_RULES } from "../../supabase/functions/_shared/clickhouse/paymentRiskAlertsContract.ts";
import { buildAlertExplanation } from "../../supabase/functions/_shared/clickhouse/paymentRiskRecommendations.ts";

const LOCKDOWN = "202610050003_access_rls_lockdown.sql";
const PERMISSIONS = "202610120001_payment_health_permissions.sql";
const ALERTS = "202610130001_payment_health_alerts.sql";
const CRON = "202610130002_payment_health_alerts_cron.sql";
const TABLES = ["payment_alert_rules", "payment_alert_runs", "payment_risk_alerts"];
const FUNCTIONS = [
  "public.payment_alerts_claim_run(uuid, text, uuid, integer)",
  "public.payment_alerts_apply_run(uuid, uuid, jsonb, jsonb, jsonb, date)",
  "public.payment_alerts_fail_run(uuid, uuid, text)",
  "public.payment_alert_update_status(uuid, uuid, uuid, text, text, text)",
];

const CLONE_TIMEOUT = 60_000;

let beforePermissions: SupabasePglite; // everything before 202610120001 (the alerts guard)
let ready: SupabasePglite; // everything before ALERTS
let applied: SupabasePglite; // ready + ALERTS (read-only tests)
let owner: string; // the workspace data key
let other: string; // another account
const opened: SupabasePglite[] = [];

async function copyOf(source: SupabasePglite): Promise<SupabasePglite> {
  const copy = await source.clone();
  opened.push(copy);
  return copy;
}

async function one<T = Record<string, unknown>>(tx: SqlRunner, sql: string, params: unknown[] = []): Promise<T> {
  return (await tx.query<T>(sql, params)).rows[0];
}

/** select <expression> as value, as service_role (the Edge's client). */
const svc = <T = Record<string, unknown>>(h: SupabasePglite, expression: string, params: unknown[] = []) =>
  h.asService(async (tx) => (await tx.query<{ value: T }>(`select ${expression} as value`, params)).rows[0].value);

beforeAll(async () => {
  const base = await createSupabasePglite({ migrations: listMigrations({ before: LOCKDOWN }), extensionStubs: true });
  owner = await base.createAuthUser("owner@example.com");
  other = await base.createAuthUser("other@example.com");
  await base.db.query("select public.bootstrap_workspace($1, 'SubEngine')", [owner]);
  for (const name of listMigrations().filter((migration) => migration >= LOCKDOWN && migration < ALERTS)) {
    if (name === PERMISSIONS) beforePermissions = await base.clone();
    await base.applyMigration(name);
  }
  ready = base;
  applied = await ready.clone();
  await applied.applyMigration(ALERTS);
}, 300_000);

afterEach(async () => {
  while (opened.length) await opened.pop()!.close();
});

// ---- builders ---------------------------------------------------------------------------

const ACCOUNT_SCOPE = { kind: "account", processor: { key: "STRIPE", label: "Stripe" }, merchant_account: { key: "acct-1", label: "Stripe MID #1", processor: "STRIPE", labelled: true }, initiation: "cit" };
const EXPLANATION = buildAlertExplanation("approval_drop", { account: "Stripe MID #1 (Stripe)", initiation: "CIT", window: "w", baseline_window: "b", current: "50%", baseline: "70%", change: "-20", attempts: 400, significance: "" });

function candidate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const ruleKey = (overrides.rule_key as string) ?? "approval_drop";
  const scopeKey = (overrides.scope_key as string) ?? "account:STRIPE:acct-1:cit";
  const windowEnd = (overrides.window_end as string) ?? "2026-09-30";
  return {
    rule_key: ruleKey,
    alert_key: `${ruleKey}|${scopeKey}|${windowEnd}`,
    scope_key: scopeKey,
    severity: "warning",
    scope: ACCOUNT_SCOPE,
    affected_funnels: ["soulmate-sketch"],
    metric: "attempt_approval_rate",
    unit: "rate",
    current_value: 0.5,
    baseline_value: 0.7,
    change_value: -20,
    sample_size: 400,
    data_confidence: "high",
    window_start: "2026-09-24",
    window_end: windowEnd,
    evidence: { unit: "rate", reproduce: { action: "declines" } },
    explanation: EXPLANATION,
    newest_event_day: null,
    ...overrides,
  };
}

const postBan = (overrides: Record<string, unknown> = {}) =>
  candidate({ rule_key: "post_ban_retries", scope_key: "tenant:post_ban:mit", scope: { kind: "tenant", subject: "post_ban", initiation: "mit" }, metric: "post_ban_attempts", unit: "count", current_value: 2, baseline_value: null, change_value: null, window_start: "2026-09-01", explanation: buildAlertExplanation("post_ban_retries", { count: 2, window: "w", succeeded: 1, after_processor_change: 1 }, "mit"), ...overrides });

async function claim(h: SupabasePglite, key = owner, interval = 0, trigger = "cron"): Promise<Record<string, unknown>> {
  return svc(h, "public.payment_alerts_claim_run($1, $2, null, $3)", [key, trigger, interval]);
}

async function apply(h: SupabasePglite, alerts: Array<Record<string, unknown>>, cleared: Array<Record<string, unknown>> = [], dataThrough = "2026-09-30"): Promise<Record<string, number>> {
  const run = await claim(h);
  expect(run.claimed, JSON.stringify(run)).toBe(true);
  return svc(h, "public.payment_alerts_apply_run($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6::date)", [run.run_id, owner, JSON.stringify(alerts), JSON.stringify(cleared), JSON.stringify({ trigger: "cron", candidates: alerts.length }), dataThrough]);
}

interface AlertRow {
  id: string;
  alert_key: string;
  scope_key: string;
  status: string;
  severity: string;
  auto_resolved: boolean;
  resolved_at: string | null;
  window_end: string;
  current_value: string | null;
  assignee: string | null;
  updated_by: string | null;
  psp_scoped: boolean;
  status_history: Array<Record<string, unknown>>;
}

const alertsOf = (h: SupabasePglite) =>
  h.db.query<AlertRow>(
    `select id, alert_key, scope_key, status, severity, auto_resolved, resolved_at, window_end::text, current_value::text, assignee, updated_by, psp_scoped, status_history
     from public.payment_risk_alerts order by alert_key`,
  ).then((result) => result.rows);

// =========================================================================================

describe("guards", () => {
  it("covers every migration before it, in order", () => {
    const all = listMigrations();
    expect(all.indexOf(ALERTS)).toBeGreaterThan(all.indexOf(PERMISSIONS));
    expect(all.indexOf(CRON)).toBe(all.indexOf(ALERTS) + 1);
  });

  it("the alerts refuse to apply before 202610120001 (manage_alerts not privileged yet), and create nothing", { timeout: CLONE_TIMEOUT }, async () => {
    const h = await copyOf(beforePermissions);
    await expect(h.applyMigration(ALERTS)).rejects.toThrow(/202610120001_payment_health_permissions\.sql has not been applied/);
    expect(await one(h.db, "select to_regclass('public.payment_risk_alerts') as alerts, to_regclass('public.payment_alert_rules') as rules")).toEqual({ alerts: null, rules: null });
  });

  it("the cron refuses to apply before the alerts, and schedules nothing", { timeout: CLONE_TIMEOUT }, async () => {
    const h = await copyOf(ready);
    await expect(h.applyMigration(CRON)).rejects.toThrow(/202610130001_payment_health_alerts\.sql has not been applied/);
    expect(await one(h.db, "select count(*)::int as n from cron.job where jobname = 'payment-health-alerts'")).toEqual({ n: 0 });
    expect(await one(h.db, "select to_regprocedure('public.invoke_payment_alerts_tick()') as fn")).toEqual({ fn: null });
  });
});

describe("tables, RLS and privileges", () => {
  it("RLS on, no policies, nothing for anon / authenticated, SELECT only for the service role", async () => {
    for (const table of TABLES) {
      const row = await one(
        applied.db,
        `select c.relrowsecurity as rls,
                (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies,
                has_table_privilege('anon', c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') as anon,
                has_table_privilege('authenticated', c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') as authenticated,
                has_table_privilege('service_role', c.oid, 'SELECT') as service_select,
                has_table_privilege('service_role', c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE') as service_write
         from pg_class c where c.oid = $1::regclass`,
        [`public.${table}`],
      );
      expect(row, table).toEqual({ rls: true, policies: 0, anon: false, authenticated: false, service_select: true, service_write: false });
      await expect(applied.asUser(owner, (tx) => tx.query(`select * from public.${table}`)), table).rejects.toThrow(/permission denied/);
      await expect(applied.asAnon((tx) => tx.query(`select * from public.${table}`)), table).rejects.toThrow(/permission denied/);
    }
    // A status can change only through the functions (history and audit included): no direct write by the Edge.
    await expect(applied.asService((tx) => tx.query("update public.payment_risk_alerts set status = 'dismissed'"))).rejects.toThrow(/permission denied/);
    await expect(applied.asService((tx) => tx.query("update public.payment_alert_rules set enabled = false"))).rejects.toThrow(/permission denied/);
  });

  it("the functions: SECURITY DEFINER, search_path pinned, executable by service_role only", async () => {
    for (const signature of FUNCTIONS) {
      const row = await one(
        applied.db,
        `select has_function_privilege('anon', $1, 'execute') as anon,
                has_function_privilege('authenticated', $1, 'execute') as authenticated,
                has_function_privilege('service_role', $1, 'execute') as service,
                coalesce(array_to_string(p.proacl, ',') ~ '(^|,)=X', true) as public_acl,
                p.prosecdef as definer, p.proconfig as config
         from pg_proc p where p.oid = $1::regprocedure`,
        [signature],
      );
      expect(row, signature).toEqual({ anon: false, authenticated: false, service: true, public_acl: false, definer: true, config: [expect.stringMatching(/^search_path=("")?$/)] });
    }
    await expect(applied.asUser(owner, (tx) => tx.query("select public.payment_alerts_claim_run($1, 'manual', $1, 300)", [owner]))).rejects.toThrow(/permission denied for function/);
  });

  it("passes 202610050003's fail-closed block and its own, which aborts on a browser grant or a service-role write grant", { timeout: CLONE_TIMEOUT }, async () => {
    const h = await copyOf(applied);
    const lockdown = readMigration(LOCKDOWN);
    await expect(h.db.exec(lockdown.slice(lockdown.indexOf("do $$", lockdown.indexOf("-- Fail closed"))))).resolves.toBeDefined();
    const own = readMigration(ALERTS);
    const block = own.slice(own.indexOf("do $$", own.indexOf("-- Fail closed")));
    await expect(h.db.exec(block)).resolves.toBeDefined();
    await h.db.exec("grant insert on table public.payment_risk_alerts to service_role");
    await expect(h.db.exec(block)).rejects.toThrow(/reachable by an API role or without RLS: payment_risk_alerts/);
    await h.db.exec("revoke insert on table public.payment_risk_alerts from service_role; grant select on table public.payment_alert_rules to authenticated");
    await expect(h.db.exec(block)).rejects.toThrow(/payment_alert_rules/);
  });
});

describe("rule seed", () => {
  const rulesOf = (h: SupabasePglite) =>
    h.db.query<Record<string, unknown>>("select rule_key, enabled, severity_warning::float8 as severity_warning, severity_critical::float8 as severity_critical, min_sample, window_days, compare, params, description from public.payment_alert_rules order by rule_key").then((result) => result.rows);

  it("seeds exactly the MVP rules of DEFAULT_ALERT_RULES (no network-ratio rule)", async () => {
    const rows = await rulesOf(applied);
    expect(rows.map((row) => row.rule_key)).toEqual([...ALERT_RULE_KEYS].sort());
    expect(rows).toEqual([...DEFAULT_ALERT_RULES].sort((a, b) => a.rule_key.localeCompare(b.rule_key)).map((rule) => ({ ...rule })));
    expect(rows.some((row) => /vamp|ecp/i.test(String(row.rule_key)))).toBe(false);
  });

  it("re-applying keeps the owner's edits, re-adds a missing rule, duplicates nothing", { timeout: CLONE_TIMEOUT }, async () => {
    const h = await copyOf(applied);
    await h.db.query("update public.payment_alert_rules set severity_warning = 3, enabled = false, params = '{\"min_sample_info\": 80}' where rule_key = 'approval_drop'");
    await h.db.query("delete from public.payment_alert_rules where rule_key = 'data_stale'");
    await h.applyMigration(ALERTS);
    const rows = await rulesOf(h);
    expect(rows).toHaveLength(8);
    expect(rows.find((row) => row.rule_key === "approval_drop")).toMatchObject({ severity_warning: 3, enabled: false, params: { min_sample_info: 80 } });
    expect(rows.find((row) => row.rule_key === "data_stale")).toMatchObject({ severity_warning: 7, severity_critical: 14 });
  });

  it("checks the thresholds and the shape", { timeout: CLONE_TIMEOUT }, async () => {
    const h = await copyOf(applied);
    await expect(h.db.query("update public.payment_alert_rules set severity_critical = 1 where rule_key = 'approval_drop'")).rejects.toThrow(/payment_alert_rules_thresholds_check/);
    await expect(h.db.query("update public.payment_alert_rules set window_days = 0 where rule_key = 'approval_drop'")).rejects.toThrow(/payment_alert_rules_window_check/);
    await expect(h.db.query("update public.payment_alert_rules set compare = 'last_year' where rule_key = 'approval_drop'")).rejects.toThrow(/payment_alert_rules_compare_check/);
  });
});

describe("payment_alerts_claim_run / payment_alerts_fail_run", () => {
  it("claims a run, refuses another inside the interval (with retry_after) or while one is running, and closes a stale one", { timeout: CLONE_TIMEOUT }, async () => {
    const h = await copyOf(applied);
    const first = await claim(h, owner, 300, "manual");
    expect(first).toMatchObject({ claimed: true });
    const refused = await claim(h, owner, 300, "manual");
    expect(refused).toMatchObject({ claimed: false, last_status: "running" });
    expect(Number(refused.retry_after_seconds)).toBeGreaterThan(280);
    // A running run blocks even with no interval (no two runs at once).
    expect(await claim(h, owner, 0)).toMatchObject({ claimed: false });
    // Another data key is independent.
    expect(await claim(h, other, 300)).toMatchObject({ claimed: true });
    // A run left running past the 10-minute bound is closed as failed and a new one starts.
    await h.db.query("update public.payment_alert_runs set started_at = now() - interval '11 minutes' where id = $1", [first.run_id]);
    const next = await claim(h, owner, 300);
    expect(next).toMatchObject({ claimed: true });
    expect(await one(h.db, "select status, error from public.payment_alert_runs where id = $1", [first.run_id])).toEqual({ status: "failed", error: "abandoned: no result within 10 minutes" });
    // fail_run closes a running run of its own data key only.
    await svc(h, "public.payment_alerts_fail_run($1, $2, $3)", [next.run_id, other, "x"]);
    expect(await one(h.db, "select status from public.payment_alert_runs where id = $1", [next.run_id])).toEqual({ status: "running" });
    await svc(h, "public.payment_alerts_fail_run($1, $2, $3)", [next.run_id, owner, "boom"]);
    expect(await one(h.db, "select status, error, finished_at is not null as finished from public.payment_alert_runs where id = $1", [next.run_id])).toEqual({ status: "failed", error: "boom", finished: true });
    // A closed run cannot be applied; nor a run of another data key.
    await expect(svc(h, "public.payment_alerts_apply_run($1, $2, '[]', '[]', '{}', null)", [next.run_id, owner])).rejects.toThrow(/already closed/);
    const others = await svc<Record<string, unknown>>(h, "public.payment_alerts_claim_run($1, 'cron', null, 0)", [other]);
    expect(others.claimed).toBe(false); // the other key's first run is still running
    await expect(svc(h, "public.payment_alerts_apply_run($1, $2, '[]', '[]', '{}', null)", [first.run_id, other])).rejects.toThrow(/unknown alert run/);
  });
});

describe("payment_alerts_apply_run", () => {
  it("inserts new alerts with a 'raised' history entry, a generated psp_scoped and the run row closed with its counts", { timeout: CLONE_TIMEOUT }, async () => {
    const h = await copyOf(applied);
    const counts = await apply(h, [candidate(), postBan()]);
    expect(counts).toEqual({ inserted: 2, updated: 0, carried: 0, reopened: 0, suppressed: 0, auto_resolved: 0 });
    const rows = await alertsOf(h);
    expect(rows.map((row) => [row.scope_key, row.status, row.psp_scoped, row.status_history.map((entry) => entry.event)])).toEqual([
      ["account:STRIPE:acct-1:cit", "new", true, ["raised"]],
      ["tenant:post_ban:mit", "new", false, ["raised"]],
    ]);
    const run = await one<{ status: string; data_through: string; summary: Record<string, unknown> }>(h.db, "select status, data_through::text, summary from public.payment_alert_runs order by started_at desc limit 1");
    expect(run).toMatchObject({ status: "succeeded", data_through: "2026-09-30", summary: { trigger: "cron", candidates: 2, applied: counts } });
  });

  it("the same alert_key again refreshes the row (no duplicate) and keeps an owner's status", { timeout: CLONE_TIMEOUT }, async () => {
    const h = await copyOf(applied);
    await apply(h, [candidate(), postBan()]);
    await h.db.query("update public.payment_risk_alerts set status = 'dismissed' where scope_key = 'tenant:post_ban:mit'");
    await h.db.query("update public.payment_risk_alerts set status = 'investigating', assignee = $1 where scope_key = 'account:STRIPE:acct-1:cit'", [owner]);
    const counts = await apply(h, [candidate({ severity: "critical", current_value: 0.4, change_value: -30 }), postBan({ current_value: 3 })]);
    expect(counts).toMatchObject({ inserted: 0, updated: 2 });
    const rows = await alertsOf(h);
    expect(rows.map((row) => [row.scope_key, row.status, row.severity, Number(row.current_value), row.assignee])).toEqual([
      ["account:STRIPE:acct-1:cit", "investigating", "critical", 0.4, owner],
      ["tenant:post_ban:mit", "dismissed", "warning", 3, null],
    ]);
  });

  it("an open alert of the same rule + scope on a newer window is carried forward: same row, new window and key, status / assignee / history kept", { timeout: CLONE_TIMEOUT }, async () => {
    const h = await copyOf(applied);
    await apply(h, [candidate()]);
    const [before] = await alertsOf(h);
    await h.db.query("update public.payment_risk_alerts set status = 'investigating', assignee = $1 where id = $2", [owner, before.id]);
    const counts = await apply(h, [candidate({ window_end: "2026-10-07", window_start: "2026-10-01" })], [], "2026-10-07");
    expect(counts).toMatchObject({ inserted: 0, carried: 1 });
    const rows = await alertsOf(h);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: before.id, alert_key: "approval_drop|account:STRIPE:acct-1:cit|2026-10-07", window_end: "2026-10-07", status: "investigating", assignee: owner });
    expect(rows[0].status_history.map((entry) => entry.event)).toEqual(["raised"]);
  });

  it("auto-resolves only the OPEN alerts of a cleared condition; dismissed and owner-resolved ones are never touched", { timeout: CLONE_TIMEOUT }, async () => {
    const h = await copyOf(applied);
    const scopes = ["account:STRIPE:a:cit", "account:STRIPE:b:cit", "account:STRIPE:c:cit", "account:STRIPE:d:cit"];
    await apply(h, scopes.map((scope_key) => candidate({ scope_key })));
    await h.db.query("update public.payment_risk_alerts set status = 'investigating' where scope_key = $1", [scopes[1]]);
    await h.db.query("update public.payment_risk_alerts set status = 'dismissed' where scope_key = $1", [scopes[2]]);
    await h.db.query("update public.payment_risk_alerts set status = 'resolved', resolved_at = now() where scope_key = $1", [scopes[3]]);
    const counts = await apply(h, [], [...scopes, "account:STRIPE:none:cit"].map((scope_key) => ({ rule_key: "approval_drop", scope_key })));
    expect(counts.auto_resolved).toBe(2);
    const rows = await alertsOf(h);
    expect(rows.map((row) => [row.scope_key, row.status, row.auto_resolved, row.resolved_at !== null])).toEqual([
      [scopes[0], "resolved", true, true],
      [scopes[1], "resolved", true, true],
      [scopes[2], "dismissed", false, false],
      [scopes[3], "resolved", false, true],
    ]);
    expect(rows[1].status_history.at(-1)).toMatchObject({ event: "auto_resolved", from: "investigating", to: "resolved", by: null, auto: true });
    // A cleared condition of ANOTHER rule with the same scope key resolves nothing.
    const h2 = await copyOf(applied);
    await apply(h2, [candidate()]);
    expect((await apply(h2, [], [{ rule_key: "issuer_fraud_rise", scope_key: "account:STRIPE:acct-1:cit" }])).auto_resolved).toBe(0);
  });

  it("an auto-resolved alert that fires again on the same window reopens as new", { timeout: CLONE_TIMEOUT }, async () => {
    const h = await copyOf(applied);
    await apply(h, [candidate()]);
    await apply(h, [], [{ rule_key: "approval_drop", scope_key: "account:STRIPE:acct-1:cit" }]);
    const counts = await apply(h, [candidate()]);
    expect(counts).toMatchObject({ reopened: 1, inserted: 0, updated: 0 });
    const [row] = await alertsOf(h);
    expect(row).toMatchObject({ status: "new", auto_resolved: false, resolved_at: null });
    expect(row.status_history.map((entry) => entry.event)).toEqual(["raised", "auto_resolved", "reopened"]);
  });

  it("suppresses a count alert whose newest event an owner-closed alert already covered; newer evidence is a new alert", { timeout: CLONE_TIMEOUT }, async () => {
    const h = await copyOf(applied);
    await apply(h, [postBan({ newest_event_day: "2026-09-28" })]);
    await h.db.query("update public.payment_risk_alerts set status = 'dismissed'");
    // A week later the 30-day window still holds the same two re-attempts: not news.
    const old = await apply(h, [postBan({ window_end: "2026-10-07", newest_event_day: "2026-09-28" })], [], "2026-10-07");
    expect(old).toMatchObject({ suppressed: 1, inserted: 0 });
    expect(await alertsOf(h)).toHaveLength(1);
    // A re-attempt after the closed window: a new alert.
    const fresh = await apply(h, [postBan({ window_end: "2026-10-07", newest_event_day: "2026-10-03" })], [], "2026-10-07");
    expect(fresh).toMatchObject({ suppressed: 0, inserted: 1 });
    expect((await alertsOf(h)).map((row) => [row.window_end, row.status])).toEqual([["2026-09-30", "dismissed"], ["2026-10-07", "new"]]);
  });

  it("a rate alert the owner dismissed or resolved is not re-raised while the sliding window overlaps the closed one; after the overlap it is news again", { timeout: CLONE_TIMEOUT }, async () => {
    for (const close of ["dismissed", "resolved"] as const) {
      const h = await copyOf(applied);
      // approval_drop on 09-24..09-30 (window_end = data_through: every import is a new alert_key).
      await apply(h, [candidate()]);
      await h.db.query(
        close === "dismissed"
          ? "update public.payment_risk_alerts set status = 'dismissed'"
          : "update public.payment_risk_alerts set status = 'resolved', resolved_at = now(), auto_resolved = false",
      );
      // The next import: 09-25..10-01 shares six days with the closed window — the same evidence, suppressed.
      const next = await apply(h, [candidate({ window_start: "2026-09-25", window_end: "2026-10-01" })], [], "2026-10-02");
      expect(next, close).toMatchObject({ suppressed: 1, inserted: 0, carried: 0 });
      expect(await alertsOf(h), close).toHaveLength(1);
      // Six days later still: 09-30..10-06 shares 09-30.
      expect(await apply(h, [candidate({ window_start: "2026-09-30", window_end: "2026-10-06" })], [], "2026-10-07"), close).toMatchObject({ suppressed: 1, inserted: 0 });
      // A window that no longer overlaps the closed one: the condition still holds — a new alert.
      const fresh = await apply(h, [candidate({ window_start: "2026-10-01", window_end: "2026-10-07" })], [], "2026-10-08");
      expect(fresh, close).toMatchObject({ suppressed: 0, inserted: 1 });
      expect((await alertsOf(h)).map((row) => [row.window_end, row.status]), close).toEqual([["2026-09-30", close], ["2026-10-07", "new"]]);
    }
  });

  it("an overlapping alert MORE severe than the closed one goes through; an auto-resolved alert never suppresses", { timeout: CLONE_TIMEOUT }, async () => {
    const h = await copyOf(applied);
    await apply(h, [candidate({ severity: "info", data_confidence: "low" })]);
    await h.db.query("update public.payment_risk_alerts set status = 'dismissed'");
    // The owner dismissed a low-confidence hint; a confident warning on the overlapping window is new evidence.
    expect(await apply(h, [candidate({ window_start: "2026-09-25", window_end: "2026-10-01" })], [], "2026-10-02")).toMatchObject({ suppressed: 0, inserted: 1 });
    // ... and the same warning on the next window again is carried on that open alert (the dismissed one stays as it is).
    expect(await apply(h, [candidate({ window_start: "2026-09-26", window_end: "2026-10-02" })], [], "2026-10-03")).toMatchObject({ carried: 1, suppressed: 0, inserted: 0 });
    const h2 = await copyOf(applied);
    await apply(h2, [candidate()]);
    await apply(h2, [], [{ rule_key: "approval_drop", scope_key: "account:STRIPE:acct-1:cit" }]);
    expect(await apply(h2, [candidate({ window_start: "2026-09-25", window_end: "2026-10-01" })], [], "2026-10-02")).toMatchObject({ suppressed: 0, inserted: 1 });
  });

  it("scope aliases: an open alert raised under an Unlabelled MID's key continues under the registered key; a closed one still suppresses; a cleared alias resolves", { timeout: CLONE_TIMEOUT }, async () => {
    const OLD = "account:STRIPE:unlabelled:0123456789abcdef:cit";
    const h = await copyOf(applied);
    await apply(h, [candidate({ scope_key: OLD })]);
    const [before] = await alertsOf(h);
    await h.db.query("update public.payment_risk_alerts set status = 'investigating', assignee = $1 where id = $2", [owner, before.id]);
    // psp_accounts_sync registered the MID: the engine now keys it on the registry id and names the old key as its alias.
    const counts = await apply(h, [candidate({ window_start: "2026-09-25", window_end: "2026-10-01", scope_aliases: [OLD] })], [], "2026-10-02");
    expect(counts).toMatchObject({ carried: 1, inserted: 0 });
    const [carried] = await alertsOf(h);
    expect(carried).toMatchObject({ id: before.id, scope_key: "account:STRIPE:acct-1:cit", alert_key: "approval_drop|account:STRIPE:acct-1:cit|2026-10-01", status: "investigating", assignee: owner });
    // A malformed alias list is ignored, not an error.
    expect(await apply(h, [candidate({ window_start: "2026-09-26", window_end: "2026-10-02", scope_aliases: { not: "an array" } })], [], "2026-10-03")).toMatchObject({ carried: 1 });

    // Dismissed under the old key: the registered key's overlapping alert is the same evidence.
    const h2 = await copyOf(applied);
    await apply(h2, [candidate({ scope_key: OLD })]);
    await h2.db.query("update public.payment_risk_alerts set status = 'dismissed'");
    expect(await apply(h2, [candidate({ window_start: "2026-09-25", window_end: "2026-10-01", scope_aliases: [OLD] })], [], "2026-10-02")).toMatchObject({ suppressed: 1, inserted: 0 });

    // The engine lists the alias among the cleared conditions: the orphaned open alert resolves.
    const h3 = await copyOf(applied);
    await apply(h3, [candidate({ scope_key: OLD })]);
    expect((await apply(h3, [], [{ rule_key: "approval_drop", scope_key: "account:STRIPE:acct-1:cit" }, { rule_key: "approval_drop", scope_key: OLD }])).auto_resolved).toBe(1);
  });

  it("rejects a low-confidence warning, a malformed explanation or a bad severity (the whole run rolls back)", { timeout: CLONE_TIMEOUT }, async () => {
    const h = await copyOf(applied);
    await expect(apply(h, [candidate({ data_confidence: "low", severity: "warning" })])).rejects.toThrow(/payment_risk_alerts_low_confidence_check/);
    expect(await one(h.db, "select count(*)::int as n from public.payment_risk_alerts")).toEqual({ n: 0 });
    await h.db.query("update public.payment_alert_runs set status = 'failed', finished_at = now() where status = 'running'");
    await expect(apply(h, [candidate({ explanation: { fact: "x" } })])).rejects.toThrow(/payment_risk_alerts_explanation_shape_check/);
    await h.db.query("update public.payment_alert_runs set status = 'failed', finished_at = now() where status = 'running'");
    await expect(apply(h, [candidate({ severity: "high" })])).rejects.toThrow(/payment_risk_alerts_severity_check/);
    await h.db.query("update public.payment_alert_runs set status = 'failed', finished_at = now() where status = 'running'");
    expect((await apply(h, [candidate({ data_confidence: "low", severity: "info" })])).inserted).toBe(1);
  });
});

describe("payment_alert_update_status", () => {
  const update = (h: SupabasePglite, id: string, status: string, note: string | null = null, key = owner, actor = owner) =>
    svc<Record<string, unknown>>(h, "public.payment_alert_update_status($1, $2, $3, $4, $5, $6)", [key, actor, id, status, note, "req-test"]);
  const audits = (h: SupabasePglite) =>
    h.db.query<Record<string, unknown>>("select event, actor_kind, actor_user_id, actor_member_id is not null as member, target_type, target_id, outcome, before, after, context, request_id from public.access_audit_log where event = 'payment_health.alert_status_changed' order by id").then((result) => result.rows);

  it("acknowledges (assignee = the actor), writes the history entry with the note and one audit row without the note's text", { timeout: CLONE_TIMEOUT }, async () => {
    const h = await copyOf(applied);
    await apply(h, [candidate()]);
    const [alert] = await alertsOf(h);
    const updated = await update(h, alert.id, "investigating", "  Looking at the Stripe renewals  ");
    expect(updated).toMatchObject({ id: alert.id, status: "investigating", assignee: owner, updated_by: owner, resolved_at: null, auto_resolved: false, psp_scoped: true });
    expect((updated.status_history as Array<Record<string, unknown>>).at(-1)).toMatchObject({ event: "status", from: "new", to: "investigating", by: owner, auto: false, note: "Looking at the Stripe renewals" });
    const rows = await audits(h);
    expect(rows).toEqual([{
      event: "payment_health.alert_status_changed", actor_kind: "user", actor_user_id: owner, member: true, target_type: "payment_risk_alert", target_id: alert.id, outcome: "success",
      before: { status: "new", assignee: null }, after: { status: "investigating", assignee: owner, note: true },
      context: { request_id: "req-test", rule_key: "approval_drop", severity: "warning", scope_key: "account:STRIPE:acct-1:cit" }, request_id: "req-test",
    }]);
    expect(JSON.stringify(rows)).not.toContain("Stripe renewals");

    // investigating -> resolved (a person: auto_resolved false, resolved_at set) -> investigating (reopen: resolved_at cleared).
    expect(await update(h, alert.id, "resolved")).toMatchObject({ status: "resolved", auto_resolved: false, resolved_at: expect.any(String) });
    expect(await update(h, alert.id, "investigating")).toMatchObject({ status: "investigating", resolved_at: null, assignee: owner });
    expect(await update(h, alert.id, "dismissed")).toMatchObject({ status: "dismissed" });
    expect((await audits(h)).map((row) => [(row.before as Record<string, unknown>).status, (row.after as Record<string, unknown>).status])).toEqual([
      ["new", "investigating"], ["investigating", "resolved"], ["resolved", "investigating"], ["investigating", "dismissed"],
    ]);
  });

  it("refuses a transition the table does not allow, an unknown id and another data key's alert — with no change and no audit row", { timeout: CLONE_TIMEOUT }, async () => {
    const h = await copyOf(applied);
    await apply(h, [candidate()]);
    const [alert] = await alertsOf(h);
    await expect(update(h, alert.id, "new")).rejects.toThrow(/invalid_transition: new -> new/);
    await update(h, alert.id, "dismissed");
    await expect(update(h, alert.id, "resolved")).rejects.toThrow(/invalid_transition: dismissed -> resolved/);
    await expect(update(h, alert.id, "open")).rejects.toThrow(/invalid_transition: dismissed -> open/);
    await expect(update(h, "aaaa0000-0000-4000-8000-0000000000ff", "investigating")).rejects.toThrow(/not_found: alert not found/);
    await expect(update(h, alert.id, "investigating", null, other)).rejects.toThrow(/not_found/);
    await expect(update(h, alert.id, "investigating", "x".repeat(1001))).rejects.toThrow(/invalid: the note is longer/);
    expect((await alertsOf(h))[0].status).toBe("dismissed");
    expect((await audits(h)).length).toBe(1);
  });
});

describe("202610130002: the daily cron job", () => {
  let cron: SupabasePglite;

  beforeAll(async () => {
    cron = await applied.clone();
    await cron.db.query(
      `insert into public.fb_cron_config (auth_user_id, cron_secret, function_url, anon_key)
       values ($1, 'cron-secret', 'https://project.supabase.co/functions/v1/clickhouse-facebook', 'anon-jwt')
       on conflict (id) do update set auth_user_id = excluded.auth_user_id, cron_secret = excluded.cron_secret, function_url = excluded.function_url, anon_key = excluded.anon_key`,
      [owner],
    );
    await cron.applyMigration(CRON);
    await cron.applyMigration(CRON);
  }, CLONE_TIMEOUT);

  const requests = (h: SupabasePglite) =>
    h.db.query<{ url: string; headers: unknown; body: unknown; timeout_milliseconds: number }>("select url, headers, body, timeout_milliseconds from net.stub_requests order by id").then((result) => result.rows);

  it("schedules exactly one job daily at 07:40 UTC, as postgres (re-applying replaces it)", async () => {
    const jobs = await cron.db.query("select schedule, command, username from cron.job where jobname = 'payment-health-alerts'");
    expect(jobs.rows).toEqual([{ schedule: "40 7 * * *", command: "select public.invoke_payment_alerts_tick()", username: "postgres" }]);
  });

  it("posts alerts_tick for the workspace data key with the cron secret, never fb_cron_config's account", { timeout: CLONE_TIMEOUT }, async () => {
    const h = await copyOf(cron);
    const before = (await requests(h)).length;
    expect(await one(h.db, "select public.invoke_payment_alerts_tick() is not null as sent")).toEqual({ sent: true });
    const expected = {
      url: "https://project.supabase.co/functions/v1/clickhouse-payment-health",
      headers: { "Content-Type": "application/json", "x-cron-secret": "cron-secret", Authorization: "Bearer anon-jwt", apikey: "anon-jwt" },
      body: { auth_user_id: owner, action: "alerts_tick" },
      timeout_milliseconds: 150000,
    };
    expect((await requests(h)).slice(before)).toEqual([expected]);
    await h.db.query("update public.fb_cron_config set auth_user_id = $1", [other]);
    await h.db.query("select public.invoke_payment_alerts_tick()");
    expect((await requests(h)).at(-1)!.body).toEqual(expected.body);
    await h.db.query("delete from public.fb_cron_config");
    expect(await one(h.db, "select public.invoke_payment_alerts_tick() as id")).toEqual({ id: null });
  });

  it("is closed to every API role", async () => {
    expect(await one(
      cron.db,
      `select has_function_privilege('anon', 'public.invoke_payment_alerts_tick()', 'execute') as anon,
              has_function_privilege('authenticated', 'public.invoke_payment_alerts_tick()', 'execute') as authenticated,
              has_function_privilege('service_role', 'public.invoke_payment_alerts_tick()', 'execute') as service`,
    )).toEqual({ anon: false, authenticated: false, service: false });
    await expect(cron.asService((tx) => tx.query("select public.invoke_payment_alerts_tick()"))).rejects.toThrow(/permission denied for function/);
  });
});
