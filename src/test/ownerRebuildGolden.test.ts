// Owner snapshot-rebuild golden corpus (access Phase 2; owner-regression review:
// the read corpus, ownerSqlGolden.test.ts, never sees the rebuild).
//
// src/test/fixtures/owner-rebuild-golden.json was recorded from the UNMODIFIED
// base code (4b4057e) with support/ownerRebuildCorpus.ts. Here the current
// rebuildCohortMembership is recorded over the same scenarios. Phase 2 may only
// ADD work after the owner's path — the fact_campaign_scope build and the
// retention ALTERs, plus the observe / set-campaign-scope RPCs. With those
// removed, every ClickHouse statement (text, bound parameters, order) and the
// claim / complete / fail RPC sequence must equal the base byte for byte, and
// the additions must come after everything the base does.
//
// Do NOT regenerate the fixture from the branch: it is the base's behaviour.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { rebuildCohortMembership } from "../../supabase/functions/_shared/clickhouse/cohortMembership.ts";
import {
  OWNER_REBUILD_BASE_COMMIT,
  OWNER_REBUILD_CORPUS_FORMAT,
  OWNER_REBUILD_NOW,
  OWNER_REBUILD_SCENARIOS,
  OWNER_REBUILD_TENANT,
  PHASE2_REBUILD_RPCS,
  isPhase2RebuildAddition,
  ownerRebuildTextKey,
  recordOwnerRebuildCorpus,
  withoutPhase2Additions,
  type OwnerRebuildCorpus,
  type OwnerRebuildStatement,
} from "./support/ownerRebuildCorpus";

const FIXTURE_PATH = resolve(process.cwd(), "src/test/fixtures/owner-rebuild-golden.json");

let golden: OwnerRebuildCorpus;
let recorded: OwnerRebuildCorpus;

beforeAll(async () => {
  golden = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as OwnerRebuildCorpus;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(OWNER_REBUILD_NOW));
  try {
    recorded = await recordOwnerRebuildCorpus(rebuildCohortMembership);
  } finally {
    vi.useRealTimers();
  }
});

afterAll(() => {
  vi.useRealTimers();
});

const expand = (statement: OwnerRebuildStatement, sql: Record<string, string>) => {
  const { query, ...rest } = statement;
  return { text: sql[query] ?? `<missing ${query}>`, rest: JSON.stringify(rest) };
};

const FULL_BUILDS = ["full/previous=old", "full/first_build", "force/current", "full/after_failed_build"];

describe("owner rebuild golden corpus: fixture integrity", () => {
  it("is the base recording: format, commit, clock, tenant, every scenario", () => {
    expect(golden.format).toBe(OWNER_REBUILD_CORPUS_FORMAT);
    expect(golden.base_commit).toBe(OWNER_REBUILD_BASE_COMMIT);
    expect(golden.now).toBe(OWNER_REBUILD_NOW);
    expect(golden.tenant).toBe(OWNER_REBUILD_TENANT);
    expect(Object.keys(golden.scenarios)).toEqual(OWNER_REBUILD_SCENARIOS.map((scenario) => scenario.id));
    for (const [key, text] of Object.entries(golden.sql)) expect(ownerRebuildTextKey(text), key).toBe(key);
    // The base never touched fact_campaign_scope nor pruned versions.
    for (const [id, record] of Object.entries(golden.scenarios)) {
      expect(record.statements.filter((statement) => isPhase2RebuildAddition(statement, golden.sql)), id).toEqual([]);
      expect(record.rpc.filter((name) => PHASE2_REBUILD_RPCS.has(name)), id).toEqual([]);
    }
    // The matrix reaches the classifier INSERT, the validation failure and the short-circuit.
    expect(golden.scenarios["full/previous=old"].statements.some((statement) => golden.sql[statement.query].includes("INSERT INTO fact_user_cohorts"))).toBe(true);
    expect(golden.scenarios["full/validation_fail"]).toMatchObject({ outcome: "rejected:Error", rpc: ["claim_clickhouse_cohort_snapshot_build", "fail_clickhouse_cohort_snapshot_build"] });
    expect(golden.scenarios["current/campaign_scope_recorded"].statements).toHaveLength(2);
  });
});

describe("owner rebuild golden corpus: the base path is unchanged", () => {
  it.each(OWNER_REBUILD_SCENARIOS.map((scenario) => [scenario.id]))("%s", (id) => {
    const base = golden.scenarios[id];
    const now = withoutPhase2Additions(recorded.scenarios[id], recorded.sql);
    expect(now.outcome).toBe(base.outcome);
    expect(now.rpc).toEqual(base.rpc);
    expect(now.statements.map((statement) => expand(statement, recorded.sql))).toEqual(
      base.statements.map((statement) => expand(statement, golden.sql)),
    );
  });

  it.each(OWNER_REBUILD_SCENARIOS.map((scenario) => [scenario.id]))("%s: Phase-2 work only follows the base work", (id) => {
    const statements = recorded.scenarios[id].statements;
    const firstAddition = statements.findIndex((statement) => isPhase2RebuildAddition(statement, recorded.sql));
    if (firstAddition >= 0) {
      expect(statements.slice(firstAddition).every((statement) => isPhase2RebuildAddition(statement, recorded.sql))).toBe(true);
    }
    // The snapshot is activated (complete RPC) before the campaign scope is recorded.
    const rpc = recorded.scenarios[id].rpc;
    if (rpc.includes("set_clickhouse_campaign_scope_version") && rpc.includes("complete_clickhouse_cohort_snapshot_build")) {
      expect(rpc.indexOf("set_clickhouse_campaign_scope_version")).toBeGreaterThan(rpc.indexOf("complete_clickhouse_cohort_snapshot_build"));
    }
  });

  it("adds exactly the campaign scope and the retention to a full build, and only the campaign-scope fill to a pre-Phase-2 current snapshot", () => {
    const additions = (id: string) => recorded.scenarios[id].statements
      .filter((statement) => isPhase2RebuildAddition(statement, recorded.sql))
      .map((statement) => {
        const text = recorded.sql[statement.query].trim();
        if (statement.kind === "insert") return `insert:${statement.table}`;
        if (text.startsWith("ALTER TABLE")) return text.split(/\s+/).slice(0, 3).join(" ");
        if (text.startsWith("CREATE TABLE")) return "CREATE fact_campaign_scope";
        if (text.includes("AS cid")) return "evidence";
        if (text.includes("AS scope_rows")) return "read-back";
        return "existing ids";
      });
    const scope = ["CREATE fact_campaign_scope", "evidence", "existing ids", "insert:fact_campaign_scope", "read-back"];
    for (const id of FULL_BUILDS) {
      expect(additions(id), id).toEqual([...scope, "ALTER TABLE fact_user_cohorts", "ALTER TABLE fact_campaign_scope"]);
      expect(recorded.scenarios[id].rpc, id).toEqual([
        "observe_clickhouse_cohort_snapshot_fingerprint",
        "claim_clickhouse_cohort_snapshot_build",
        "complete_clickhouse_cohort_snapshot_build",
        "set_clickhouse_campaign_scope_version",
      ]);
    }
    expect(additions("current/pre_phase2_state")).toEqual(scope);
    expect(additions("current/campaign_scope_recorded")).toEqual([]);
    expect(additions("full/validation_fail")).toEqual([]);
  });
});
