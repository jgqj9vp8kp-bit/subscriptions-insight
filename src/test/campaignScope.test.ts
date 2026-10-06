// fact_campaign_scope (access Phase 2, spec §3.7): the classification that
// decides which Facebook campaigns a funnel-restricted member may see, and its
// build inside the snapshot rebuild.
//
// What must hold:
//   * resolved = exactly one scopable path with ≥ PATH_EVIDENCE_MIN_USERS users
//     (alias evidence included); two or more paths — '' and 'unknown' count —
//     are mixed; everything else is unresolved; only resolved rows carry a path;
//   * alias evidence is UNIONED (stricter than resolveCampaignPaths, where the
//     spend-side id's own evidence wins);
//   * the build writes exactly the classified rows for the snapshot versions and
//     PASSes only when the FINAL read-back matches; any failure is a FAIL result,
//     never a throw — except a ScopeViolation.
import { describe, expect, it } from "vitest";
import {
  CAMPAIGN_SCOPE_EVIDENCE_SQL,
  CAMPAIGN_SCOPE_EXISTING_IDS_SQL,
  CAMPAIGN_SCOPE_VALIDATION_SQL,
  CREATE_FACT_CAMPAIGN_SCOPE_SQL,
  FACT_CAMPAIGN_SCOPE_TABLE,
  buildCampaignScope,
  classifyCampaignScope,
  isScopableCampaignPath,
  type CampaignEvidenceRow,
  type CampaignScopeRow,
} from "../../supabase/functions/_shared/clickhouse/campaignScope.ts";
import { PATH_EVIDENCE_MIN_USERS, resolveCampaignPaths } from "../../supabase/functions/_shared/clickhouse/capsuledTraffic.ts";
import { CAMPAIGN_SCOPE_VERSION, COHORT_CLASSIFICATION_VERSION } from "../../supabase/functions/_shared/clickhouse/cohortSnapshotState.ts";
import { CONFIRMED_FB_CAMPAIGN_ALIASES } from "../../supabase/functions/_shared/clickhouse/fbSourceClassification.ts";
import { ScopeViolation } from "../../supabase/functions/_shared/clickhouse/scopedClient.ts";
import type { SupabaseLikeClient } from "../../supabase/functions/_shared/clickhouse/types.ts";
import { createRecordingClickHouse, type RecordedStatement } from "./support/recordingClickHouse.ts";

const DATA_KEY = "11111111-1111-4111-8111-111111111111";
const WH = "wh_2026_10_06";
const GENERATED_AT = "2026-10-06T08:30:00.123Z";

const ev = (campaign_id: string, campaign_path: string, users: number): CampaignEvidenceRow => ({ campaign_id, campaign_path, users });
const byId = (rows: CampaignScopeRow[]) => Object.fromEntries(rows.map((row) => [row.campaign_id, row]));

describe("classifyCampaignScope — truth table", () => {
  it("resolves one scopable path with enough users, and nothing else", () => {
    const rows = byId(classifyCampaignScope([
      ev("c_resolved", "soulmate-sketch", 3),
      ev("c_split_users", "past-life", 2),
      ev("c_split_users", "past-life", 2), // the same pair twice still adds up
      ev("c_thin", "past-life", PATH_EVIDENCE_MIN_USERS - 1),
      ev("c_unknown_only", "unknown", 50),
      ev("c_empty_only", "", 50),
      ev("c_noncanonical", "Soulmate_Sketch", 50),
      ev("c_too_long", "a".repeat(201), 50),
    ], {}));
    expect(rows.c_resolved).toEqual({
      campaign_id: "c_resolved", campaign_path: "soulmate-sketch", status: "resolved",
      anchor_users: 3, merged_users: 3, distinct_paths: 1, source: "anchor",
    });
    expect(rows.c_split_users).toMatchObject({ status: "resolved", campaign_path: "past-life", anchor_users: 4, merged_users: 4 });
    for (const id of ["c_thin", "c_unknown_only", "c_empty_only", "c_noncanonical", "c_too_long"]) {
      expect(rows[id], id).toMatchObject({ status: "unresolved", campaign_path: "", distinct_paths: 1 });
    }
    expect(rows.c_thin.merged_users).toBe(PATH_EVIDENCE_MIN_USERS - 1);
  });

  it("two or more paths are mixed — an empty or unknown path counts as a path", () => {
    const rows = byId(classifyCampaignScope([
      ev("c_two", "soulmate-sketch", 40), ev("c_two", "past-life", 1),
      ev("c_unknown", "soulmate-sketch", 40), ev("c_unknown", "unknown", 1),
      ev("c_empty", "soulmate-sketch", 40), ev("c_empty", "", 1),
      ev("c_near_duplicate", "a-b", 10), ev("c_near_duplicate", "a_b", 10),
    ], {}));
    for (const id of ["c_two", "c_unknown", "c_empty", "c_near_duplicate"]) {
      expect(rows[id], id).toMatchObject({ status: "mixed", campaign_path: "", distinct_paths: 2 });
    }
    expect(rows.c_two).toMatchObject({ anchor_users: 41, merged_users: 41 });
  });

  it("drops placeholder campaign ids and non-positive counts; ids are trimmed; output is sorted", () => {
    const rows = classifyCampaignScope([
      ev("", "past-life", 10), ev("unknown", "past-life", 10), ev("NULL", "past-life", 10), ev("n/a", "past-life", 10), ev(" none ", "past-life", 10),
      ev(" c2 ", "past-life", 3), ev("c1", "past-life", 0), ev("c1", "soulmate-sketch", -4), ev("c0", "past-life", 3),
    ], {});
    expect(rows.map((row) => row.campaign_id)).toEqual(["c0", "c2"]);
    expect(rows[1]).toMatchObject({ campaign_id: "c2", status: "resolved" });
  });

  it("alias evidence is unioned into the spend-side id (stricter than resolveCampaignPaths)", () => {
    const evidence = [ev("fb_1", "soulmate-sketch", 5), ev("utm_1", "past-life", 3)];
    const aliases = { utm_1: "fb_1" };
    // The traffic snapshot keeps fb_1's own resolution …
    expect(resolveCampaignPaths(evidence.map((row) => ({ campaign_id: row.campaign_id, campaign_path: row.campaign_path, trial_users: row.users })), aliases).get("fb_1")).toBe("soulmate-sketch");
    // … the visibility rule refuses to resolve on part of the evidence.
    const rows = byId(classifyCampaignScope(evidence, aliases));
    expect(rows.fb_1).toEqual({
      campaign_id: "fb_1", campaign_path: "", status: "mixed",
      anchor_users: 5, merged_users: 8, distinct_paths: 2, source: "anchor",
    });
    // The observed id keeps its own row (its own evidence only).
    expect(rows.utm_1).toMatchObject({ status: "resolved", campaign_path: "past-life", anchor_users: 3, merged_users: 3, source: "anchor" });
  });

  it("an alias-only id gets source alias and anchor_users 0; agreeing evidence still resolves", () => {
    const rows = byId(classifyCampaignScope([
      ev("utm_2", "past-life", 2),
      ev("utm_3", "past-life", 1),
      ev("fb_3", "past-life", 1),
    ], { utm_2: "fb_2", utm_3: "fb_3", utm_missing: "fb_missing", fb_3: "fb_3", " ": "fb_blank" }));
    expect(rows.fb_2).toEqual({
      campaign_id: "fb_2", campaign_path: "", status: "unresolved",
      anchor_users: 0, merged_users: 2, distinct_paths: 1, source: "alias",
    });
    // own 1 + alias 1 on one path → still thin.
    expect(rows.fb_3).toMatchObject({ status: "unresolved", anchor_users: 1, merged_users: 2, source: "anchor" });
    // An alias whose observed id has no evidence (or is blank / itself) adds nothing.
    expect(rows.fb_missing).toBeUndefined();
    expect(rows.fb_blank).toBeUndefined();

    const agreeing = byId(classifyCampaignScope([ev("utm_4", "past-life", 2), ev("utm_5", "past-life", 1)], { utm_4: "fb_4", utm_5: "fb_4" }));
    expect(agreeing.fb_4).toMatchObject({ status: "resolved", campaign_path: "past-life", anchor_users: 0, merged_users: 3, source: "alias" });
  });

  it("the audited alias pairs are in effect through the alias map", () => {
    const [observed, fbId] = Object.entries(CONFIRMED_FB_CAMPAIGN_ALIASES)[0];
    const rows = byId(classifyCampaignScope([ev(observed, "soulmate-sketch", 4)], CONFIRMED_FB_CAMPAIGN_ALIASES));
    expect(rows[fbId]).toMatchObject({ status: "resolved", campaign_path: "soulmate-sketch", source: "alias" });
  });

  it("scopable paths are exactly P (canonical, not unknown, ≤ 200 chars)", () => {
    for (const path of ["a", "a-b-1", "soulmate-sketch", "a".repeat(200)]) expect(isScopableCampaignPath(path), path).toBe(true);
    for (const path of ["", "unknown", "Soulmate", "/x", "a--b", "-a", "a-", "a_b", "a b", "a".repeat(201)]) expect(isScopableCampaignPath(path), path).toBe(false);
  });
});

// ---- build ---------------------------------------------------------------------------

interface FakeSupabase extends SupabaseLikeClient {
  reads: string[];
}

function aliasSupabase(rows: Array<{ observed_campaign_id: string; fb_campaign_id: string }> = [], error: string | null = null): FakeSupabase {
  const reads: string[] = [];
  return {
    reads,
    from(table: string) {
      reads.push(table);
      const builder: Record<string, unknown> = {};
      for (const method of ["select", "eq"]) builder[method] = () => builder;
      builder.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve(error ? { data: null, error: { message: error } } : { data: rows, error: null }).then(resolve, reject);
      return builder as never;
    },
  };
}

const EVIDENCE = [
  { cid: "c_a", campaign_path: "soulmate-sketch", users: "5" },
  { cid: "c_mixed", campaign_path: "soulmate-sketch", users: "3" },
  { cid: "c_mixed", campaign_path: "past-life", users: "3" },
  { cid: "c_thin", campaign_path: "past-life", users: "1" },
  { cid: "", campaign_path: "past-life", users: "9" }, // no campaign: dropped
];

/** A warehouse that answers the evidence query and reads back whatever was inserted. */
function warehouse(options: { evidence?: unknown[]; existing?: string[]; readBack?: (inserted: Record<string, unknown>[]) => Record<string, unknown>; fail?: (statement: RecordedStatement) => Error | null } = {}) {
  let inserted: Record<string, unknown>[] = [];
  const recording = createRecordingClickHouse((statement) => {
    const failure = options.fail?.(statement);
    if (failure) throw failure;
    if (statement.query === CAMPAIGN_SCOPE_EVIDENCE_SQL) return options.evidence ?? EVIDENCE;
    if (statement.query === CAMPAIGN_SCOPE_EXISTING_IDS_SQL) return (options.existing ?? []).map((campaign_id) => ({ campaign_id }));
    if (statement.query === CAMPAIGN_SCOPE_VALIDATION_SQL) {
      if (options.readBack) return [options.readBack(inserted)];
      return [{
        scope_rows: String(inserted.length),
        campaign_ids: String(new Set(inserted.map((row) => row.campaign_id)).size),
        bad_resolved: String(inserted.filter((row) => row.status === "resolved" && (row.campaign_path === "" || Number(row.merged_users) < 3)).length),
        bad_mixed: String(inserted.filter((row) => row.status === "mixed" && Number(row.distinct_paths) < 2).length),
        anchor_total: String(inserted.reduce((sum, row) => sum + Number(row.anchor_users), 0)),
      }];
    }
    return [];
  });
  // The recording double answers reads only; route DDL and inserts through `fail` too.
  const command = recording.command.bind(recording);
  recording.command = async (input) => {
    const failure = options.fail?.({ kind: "command", query: input.query, params: {} });
    if (failure) throw failure;
    await command(input);
  };
  const insert = recording.insert.bind(recording);
  recording.insert = async (input) => {
    const failure = options.fail?.({ kind: "insert", query: `INSERT INTO ${input.table}`, params: {}, table: input.table });
    if (failure) throw failure;
    inserted = input.values.map((row) => ({ ...row }));
    await insert(input);
  };
  return recording;
}

const build = (clickhouse: ReturnType<typeof warehouse>, supabase: SupabaseLikeClient = aliasSupabase(), overrides: Record<string, unknown> = {}) =>
  buildCampaignScope({
    clickhouse,
    supabase,
    authUserId: DATA_KEY,
    warehouseVersion: WH,
    classificationVersion: COHORT_CLASSIFICATION_VERSION,
    generatedAt: GENERATED_AT,
    ...overrides,
  });

describe("buildCampaignScope", () => {
  it("DDL: ReplacingMergeTree keyed by tenant, snapshot versions, scope version and campaign", () => {
    expect(FACT_CAMPAIGN_SCOPE_TABLE).toBe("fact_campaign_scope");
    const ddl = CREATE_FACT_CAMPAIGN_SCOPE_SQL.replace(/\s+/g, " ");
    expect(ddl).toContain("CREATE TABLE IF NOT EXISTS fact_campaign_scope");
    for (const column of [
      "auth_user_id String", "warehouse_version String", "classification_version String", "scope_version String",
      "campaign_id String", "campaign_path String", "status LowCardinality(String)", "anchor_users UInt32",
      "merged_users UInt32", "distinct_paths UInt16", "source LowCardinality(String)", "generated_at DateTime64(3, 'UTC')", "row_version UInt64",
    ]) {
      expect(ddl, column).toContain(column);
    }
    expect(ddl).toContain("ENGINE = ReplacingMergeTree(row_version) ORDER BY ( auth_user_id, warehouse_version, classification_version, scope_version, campaign_id )");
  });

  it("runs ensure → evidence → existing ids → insert → read-back, binds the versions and PASSes", async () => {
    const clickhouse = warehouse();
    const supabase = aliasSupabase();
    const result = await build(clickhouse, supabase);
    expect(result).toEqual({ version: CAMPAIGN_SCOPE_VERSION, status: "PASS", rows: 3, resolved: 1, mixed: 1, unresolved: 1, noncanonical_paths: 0 });

    expect(clickhouse.statements.map((statement) => statement.kind)).toEqual(["command", "query", "query", "insert", "query"]);
    const [ensure, evidence, existing, insert, readBack] = clickhouse.statements;
    expect(ensure.query).toBe(CREATE_FACT_CAMPAIGN_SCOPE_SQL);
    expect(evidence.query).toBe(CAMPAIGN_SCOPE_EVIDENCE_SQL);
    expect(evidence.params).toEqual({ auth_user_id: DATA_KEY, warehouse_version: WH, classification_version: COHORT_CLASSIFICATION_VERSION });
    expect(existing.query).toBe(CAMPAIGN_SCOPE_EXISTING_IDS_SQL);
    expect(existing.params).toEqual({ auth_user_id: DATA_KEY, warehouse_version: WH, classification_version: COHORT_CLASSIFICATION_VERSION, scope_version: CAMPAIGN_SCOPE_VERSION });
    expect(readBack.query).toBe(CAMPAIGN_SCOPE_VALIDATION_SQL);
    expect(readBack.params).toEqual({ auth_user_id: DATA_KEY, warehouse_version: WH, classification_version: COHORT_CLASSIFICATION_VERSION, scope_version: CAMPAIGN_SCOPE_VERSION });
    expect(clickhouse.boundTenants()).toEqual([DATA_KEY]);
    expect(supabase.reads).toEqual(["facebook_campaign_mapping"]);

    expect(insert.table).toBe("fact_campaign_scope");
    expect(insert.format).toBe("JSONEachRow");
    const common = {
      auth_user_id: DATA_KEY, warehouse_version: WH, classification_version: COHORT_CLASSIFICATION_VERSION, scope_version: CAMPAIGN_SCOPE_VERSION,
      generated_at: "2026-10-06 08:30:00.123", row_version: Date.parse(GENERATED_AT),
    };
    expect(insert.values).toEqual([
      { ...common, campaign_id: "c_a", campaign_path: "soulmate-sketch", status: "resolved", anchor_users: 5, merged_users: 5, distinct_paths: 1, source: "anchor" },
      { ...common, campaign_id: "c_mixed", campaign_path: "", status: "mixed", anchor_users: 6, merged_users: 6, distinct_paths: 2, source: "anchor" },
      { ...common, campaign_id: "c_thin", campaign_path: "", status: "unresolved", anchor_users: 1, merged_users: 1, distinct_paths: 1, source: "anchor" },
    ]);
  });

  it("the evidence SQL is the anchor attribution: authoritative campaign id, non-synthetic users, this snapshot only", () => {
    const sql = CAMPAIGN_SCOPE_EVIDENCE_SQL.replace(/\s+/g, " ");
    expect(sql).toContain("if(lowerUTF8(trim(BOTH ' ' FROM fc.campaign_id)) IN ('', 'unknown', 'null', 'n/a', 'none'), '', trim(BOTH ' ' FROM fc.campaign_id)) AS cid");
    expect(sql).toContain("FROM fact_user_cohorts AS fc FINAL");
    expect(sql).toContain("fc.auth_user_id = {auth_user_id:String} AND fc.warehouse_version = {warehouse_version:String} AND fc.classification_version = {classification_version:String}");
    expect(sql).toContain("AND NOT startsWith(fc.canonical_user_id, 'unknown_user_')");
    expect(sql).toContain("GROUP BY cid, campaign_path FORMAT JSONEachRow");
    const check = CAMPAIGN_SCOPE_VALIDATION_SQL.replace(/\s+/g, " ");
    expect(check).toContain("FROM fact_campaign_scope FINAL");
    expect(check).toContain("AND scope_version = {scope_version:String}");
  });

  it("unions the table aliases (plus the audited fallback) into the classification", async () => {
    const clickhouse = warehouse({ evidence: [{ cid: "fb_9", campaign_path: "soulmate-sketch", users: 4 }, { cid: "utm_9", campaign_path: "past-life", users: 1 }] });
    const result = await build(clickhouse, aliasSupabase([{ observed_campaign_id: "utm_9", fb_campaign_id: "fb_9" }]));
    expect(result).toMatchObject({ status: "PASS", resolved: 0, mixed: 1, unresolved: 1 });
    const insert = clickhouse.statements.find((statement) => statement.kind === "insert")!;
    expect(insert.values?.find((row) => row.campaign_id === "fb_9")).toMatchObject({ status: "mixed", anchor_users: 4, merged_users: 5 });
  });

  it("counts the distinct evidence paths outside P", async () => {
    const result = await build(warehouse({
      evidence: [
        { cid: "c1", campaign_path: "unknown", users: 3 },
        { cid: "c2", campaign_path: "", users: 3 },
        { cid: "c3", campaign_path: "Soulmate_Sketch", users: 3 },
        { cid: "c4", campaign_path: "Soulmate_Sketch", users: 3 },
        { cid: "c5", campaign_path: "past-life", users: 3 },
      ],
    }));
    expect(result).toMatchObject({ status: "PASS", noncanonical_paths: 3, resolved: 1, unresolved: 4 });
  });

  it("no evidence: nothing is inserted, and an empty read-back PASSes", async () => {
    const clickhouse = warehouse({ evidence: [] });
    const result = await build(clickhouse);
    expect(result).toEqual({ version: CAMPAIGN_SCOPE_VERSION, status: "PASS", rows: 0, resolved: 0, mixed: 0, unresolved: 0, noncanonical_paths: 0 });
    expect(clickhouse.statements.map((statement) => statement.kind)).toEqual(["command", "query", "query", "query"]);
  });

  // Owner-regression review: a same-version rebuild (rebuild_force, the tick's
  // refill after a FAIL) used to leave the ids it no longer classifies in place
  // — still visible as before, and every later read-back FAILed on the count
  // (restricted FB 409 until the warehouse version changed).
  it("retires ids an earlier build of the same versions stored, so they are hidden and the read-back PASSes", async () => {
    const clickhouse = warehouse({ existing: ["c_a", "c_alias_gone", "c_mixed", "c_thin", ""] });
    const result = await build(clickhouse);
    expect(result).toEqual({ version: CAMPAIGN_SCOPE_VERSION, status: "PASS", rows: 4, resolved: 1, mixed: 1, unresolved: 2, noncanonical_paths: 0, retired: 1 });
    const insert = clickhouse.statements.find((statement) => statement.kind === "insert")!;
    expect(insert.values?.map((row) => row.campaign_id)).toEqual(["c_a", "c_mixed", "c_thin", "c_alias_gone"]);
    expect(insert.values?.at(-1)).toMatchObject({
      campaign_id: "c_alias_gone", campaign_path: "", status: "unresolved", anchor_users: 0, merged_users: 0, distinct_paths: 0,
      row_version: Date.parse(GENERATED_AT),
    });
  });

  it.each([
    ["a stale row left in the table", (rows: Record<string, unknown>[]) => ({ scope_rows: rows.length + 1, campaign_ids: rows.length + 1, bad_resolved: 0, bad_mixed: 0, anchor_total: 12 }), /rows 4 != 3/],
    ["a duplicated campaign id", (rows: Record<string, unknown>[]) => ({ scope_rows: rows.length, campaign_ids: rows.length - 1, bad_resolved: 0, bad_mixed: 0, anchor_total: 12 }), /campaign ids 2 != 3/],
    ["a resolved row without a path", (rows: Record<string, unknown>[]) => ({ scope_rows: rows.length, campaign_ids: rows.length, bad_resolved: 1, bad_mixed: 0, anchor_total: 12 }), /1 resolved rows/],
    ["a mixed row with one path", (rows: Record<string, unknown>[]) => ({ scope_rows: rows.length, campaign_ids: rows.length, bad_resolved: 0, bad_mixed: 1, anchor_total: 12 }), /1 mixed rows/],
    ["lost anchor users", (rows: Record<string, unknown>[]) => ({ scope_rows: rows.length, campaign_ids: rows.length, bad_resolved: 0, bad_mixed: 0, anchor_total: 11 }), /anchor users 11 != evidence 12/],
    ["an empty read-back", () => ({}), /rows 0 != 3/],
  ])("FAILs (never throws) on %s", async (_label, readBack, message) => {
    const result = await build(warehouse({ readBack }));
    expect(result.status).toBe("FAIL");
    expect(result.rows).toBe(3);
    expect(result.error).toMatch(message);
  });

  it("FAILs (never throws) on a warehouse, alias or input fault", async () => {
    const boom = (match: (statement: RecordedStatement) => boolean) => (statement: RecordedStatement) => (match(statement) ? new Error("Code: 241. DB::Exception: Memory limit exceeded\nstack trace line") : null);
    const ddl = await build(warehouse({ fail: boom((statement) => statement.kind === "command") }));
    expect(ddl).toMatchObject({ status: "FAIL", rows: 0, error: "Code: 241. DB::Exception: Memory limit exceeded" });
    const evidence = await build(warehouse({ fail: boom((statement) => statement.query === CAMPAIGN_SCOPE_EVIDENCE_SQL) }));
    expect(evidence.status).toBe("FAIL");
    const insert = await build(warehouse({ fail: boom((statement) => statement.kind === "insert") }));
    expect(insert).toMatchObject({ status: "FAIL", rows: 3, resolved: 1 });
    const readBack = await build(warehouse({ fail: boom((statement) => statement.query === CAMPAIGN_SCOPE_VALIDATION_SQL) }));
    expect(readBack.status).toBe("FAIL");
    const aliases = await build(warehouse(), aliasSupabase([], "permission denied for table facebook_campaign_mapping"));
    expect(aliases).toMatchObject({ status: "FAIL", error: expect.stringContaining("Could not load campaign mappings") });
    for (const overrides of [{ warehouseVersion: "" }, { classificationVersion: "" }, { generatedAt: "not a date" }]) {
      const clickhouse = warehouse();
      const result = await build(clickhouse, aliasSupabase(), overrides);
      expect(result.status, JSON.stringify(overrides)).toBe("FAIL");
      expect(clickhouse.statements).toEqual([]);
    }
  });

  it("a ScopeViolation is the one error that propagates", async () => {
    const violation = new ScopeViolation("restricted_write", "fact_campaign_scope");
    await expect(build(warehouse({ fail: (statement) => (statement.kind === "insert" ? violation : null) }))).rejects.toBe(violation);
    await expect(build(warehouse({ fail: (statement) => (statement.kind === "command" ? violation : null) }))).rejects.toBe(violation);
  });
});
