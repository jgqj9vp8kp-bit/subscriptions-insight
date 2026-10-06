// T20 (access Phase 2, spec §6 "Step 0" / §7 parity contract 1): the data
// owner's SQL is byte-identical before and after funnel scoping.
//
// The harness (support/ownerSqlCorpus.ts) drives every Cohorts / Revenue / FB
// read runner over a fixed request matrix with a recording warehouse; this file
// compares the recording to src/test/fixtures/owner-sql-golden.json, which was
// generated from the UNMODIFIED base code (4b4057e). Any byte change to an
// owner query, to a bound parameter, to the number of statements, or to a
// runner's outcome fails here — with the scenario and the first differing
// offset in the message.
//
// Do NOT regenerate the fixture to make a failure go away: in all-scope mode
// the ScopeSql helpers must render exactly today's text (spec §1 mechanism 2).
// Regeneration is reserved for an intentional, owner-approved change of the
// owner's SQL:
//   OWNER_SQL_GOLDEN_WRITE=owner-approved npx vitest run src/test/ownerSqlGolden.test.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  OWNER_SQL_CORPUS_FORMAT,
  OWNER_SQL_CORPUS_NOW,
  OWNER_SQL_RUNNERS,
  OWNER_SQL_SCENARIOS,
  OWNER_SQL_TENANT,
  diffOwnerSqlCorpus,
  diffOwnerSqlScenario,
  ownerSqlTextKey,
  recordOwnerSqlCorpus,
  serializeOwnerSqlCorpus,
  type OwnerSqlCorpus,
} from "./support/ownerSqlCorpus";

const FIXTURE_PATH = resolve(process.cwd(), "src/test/fixtures/owner-sql-golden.json");
const WRITE_FIXTURE = process.env.OWNER_SQL_GOLDEN_WRITE === "owner-approved";
const ENV_BEFORE = process.env.FB_WAREHOUSE_V2_READS;

let recorded: OwnerSqlCorpus;
let golden: OwnerSqlCorpus;

beforeAll(async () => {
  recorded = await recordOwnerSqlCorpus();
  if (WRITE_FIXTURE) {
    mkdirSync(dirname(FIXTURE_PATH), { recursive: true });
    writeFileSync(FIXTURE_PATH, serializeOwnerSqlCorpus(recorded), "utf8");
  }
  if (!existsSync(FIXTURE_PATH)) throw new Error(`Owner SQL golden fixture is missing: ${FIXTURE_PATH}`);
  // Parsed, not compared as file text: a CRLF checkout must not matter.
  golden = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as OwnerSqlCorpus;
}, 120_000);

describe("owner SQL golden corpus: fixture integrity", () => {
  it("is the expected format, clock and tenant", () => {
    expect(golden.format).toBe(OWNER_SQL_CORPUS_FORMAT);
    expect(golden.now).toBe(OWNER_SQL_CORPUS_NOW);
    expect(golden.tenant).toBe(OWNER_SQL_TENANT);
  });

  it("stores every query text under its own content key, each referenced", () => {
    const referenced = new Set(Object.values(golden.scenarios).flatMap((scenario) => scenario.statements.map((statement) => statement.query)));
    for (const [key, text] of Object.entries(golden.sql)) {
      expect(ownerSqlTextKey(text), key).toBe(key);
      expect(referenced.has(key), `${key} is never referenced`).toBe(true);
    }
    for (const key of referenced) expect(golden.sql[key], `${key} has no text`).toBeTypeOf("string");
  });

  it("covers every runner of the matrix, and every scenario really ran SQL", () => {
    expect(new Set(Object.values(golden.scenarios).map((scenario) => scenario.runner))).toEqual(new Set(OWNER_SQL_RUNNERS));
    for (const [id, scenario] of Object.entries(golden.scenarios)) {
      expect(scenario.outcome, id).toBe("resolved");
      expect(scenario.statements.length, id).toBeGreaterThan(0);
      for (const statement of scenario.statements) {
        // Owner transport input carries no restricted-mode capacity settings.
        expect(statement, id).not.toHaveProperty("settings");
        expect(statement, id).not.toHaveProperty("query_id");
        expect(statement.kind, id).toBe("query");
      }
    }
  });
});

describe("owner SQL golden corpus: harness", () => {
  it("records exactly the fixture's scenario set", () => {
    expect(Object.keys(recorded.scenarios)).toEqual(Object.keys(golden.scenarios));
    expect(OWNER_SQL_SCENARIOS.map((scenario) => scenario.id)).toEqual(Object.keys(golden.scenarios));
  });

  it("is deterministic: a second recording is identical", async () => {
    const again = await recordOwnerSqlCorpus();
    expect(diffOwnerSqlCorpus(recorded, again)).toEqual([]);
    expect(serializeOwnerSqlCorpus(again)).toBe(serializeOwnerSqlCorpus(recorded));
  });

  it("restores the real clock and the FB V2 read flag after recording", () => {
    expect(vi.isFakeTimers()).toBe(false);
    expect(process.env.FB_WAREHOUSE_V2_READS).toBe(ENV_BEFORE);
  });

  it("the comparator fails on a one-byte change to a query, a param, or the statement count", () => {
    const clone = (): OwnerSqlCorpus => JSON.parse(JSON.stringify(recorded)) as OwnerSqlCorpus;
    const id = "cohorts.list.materialized/all";

    const textChanged = clone();
    const key = textChanged.scenarios[id].statements[0].query;
    const text = textChanged.sql[key];
    const flipped = `${text.slice(0, 10)}${text[10] === " " ? "\t" : " "}${text.slice(11)}`;
    const flippedKey = ownerSqlTextKey(flipped);
    textChanged.sql[flippedKey] = flipped;
    textChanged.scenarios[id].statements[0].query = flippedKey;
    expect(diffOwnerSqlScenario(id, recorded, textChanged).join("\n")).toMatch(/query text changed; first difference at offset 10/);

    const paramChanged = clone();
    const withParams = paramChanged.scenarios[id].statements.find((statement) => Object.keys(statement.query_params).length > 1)!;
    const [param] = Object.keys(withParams.query_params).filter((name) => name !== "auth_user_id");
    withParams.query_params[param] = `${String(withParams.query_params[param])}x`;
    expect(diffOwnerSqlScenario(id, recorded, paramChanged).join("\n")).toMatch(/params\/transport changed/);

    const dropped = clone();
    dropped.scenarios[id].statements.pop();
    expect(diffOwnerSqlScenario(id, recorded, dropped).join("\n")).toMatch(/statements expected/);
  });
});

describe("owner SQL golden corpus: byte identity with the base code", () => {
  it.each(OWNER_SQL_SCENARIOS.map((scenario) => [scenario.id]))("%s", (id) => {
    expect(diffOwnerSqlScenario(id, golden, recorded)).toEqual([]);
  });

  it("the whole corpus serializes to the fixture's content", () => {
    expect(diffOwnerSqlCorpus(golden, recorded)).toEqual([]);
    expect(serializeOwnerSqlCorpus(recorded)).toBe(serializeOwnerSqlCorpus(golden));
  });
});
