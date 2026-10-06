// scripts/deploy-functions.mjs (plan §26.6 / §31): the deploy-all gate. A
// partial deploy leaves old caller-as-tenant builds live, and functions deployed
// before migration 0002 + bootstrap answer 503 everywhere — the script must
// refuse the second and make the first impossible to miss.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  BUILD_ID_FILE,
  checkCliDataKeyOutput,
  checkDataKeyResponse,
  checkFunnelPathsResponse,
  DATA_KEY_CHECK_SQL_FILE,
  diffFunctionSets,
  generateBuildId,
  listRepoFunctions,
  parseArgs,
  parseDeployedFunctions,
  readBuildId,
  renderBuildIdSource,
  resolveCliCommand,
  runDeploy,
  SUPABASE_CLI_NPX_PACKAGE,
  verifyBuildIds,
} from "../../scripts/deploy-functions.mjs";

const DATA_KEY = "11111111-1111-4111-8111-111111111111";
const ROOT = process.cwd();
const BUILD_ID_SOURCE = readFileSync(resolve(ROOT, BUILD_ID_FILE), "utf8");

describe("pure helpers", () => {
  it("lists every function folder of the repo (27, no _shared), and the removed probe is not one", () => {
    const repo = listRepoFunctions(ROOT);
    expect(repo).toHaveLength(27);
    expect(repo).toContain("access");
    expect(repo).toContain("export-campaign-performance");
    expect(repo).not.toContain("_shared");
    expect(repo).not.toContain("funnelfox-endpoint-probe");
    expect([...repo].sort()).toEqual(repo);
  });

  it("parses `supabase functions list -o json` and diffs it against the repo", () => {
    expect(parseDeployedFunctions(JSON.stringify([{ slug: "b" }, { name: "a" }, { slug: "b" }]))).toEqual(["a", "b"]);
    expect(() => parseDeployedFunctions("not json")).toThrow(/could not parse/);
    expect(() => parseDeployedFunctions("{}")).toThrow(/did not return an array/);
    expect(diffFunctionSets(["a", "b", "c"], ["b", "c", "funnelfox-endpoint-probe"])).toEqual({ missing: ["a"], extra: ["funnelfox-endpoint-probe"] });
  });

  it("stamps a fresh build id into buildId.ts and nothing else", () => {
    const id = generateBuildId("abcdef1234567890", new Date("2026-10-06T12:34:56.789Z"));
    expect(id).toBe("deploy-20261006T123456Z-abcdef123456");
    const stamped = renderBuildIdSource(BUILD_ID_SOURCE, id);
    expect(readBuildId(stamped)).toBe(id);
    expect(stamped.replace(id, "X")).toBe(BUILD_ID_SOURCE.replace(readBuildId(BUILD_ID_SOURCE) as string, "X"));
    expect(() => renderBuildIdSource("export const OTHER = 1;", id)).toThrow(/no `export const BUILD_ID/);
    expect(() => renderBuildIdSource(BUILD_ID_SOURCE, 'x"; evil()')).toThrow(/invalid build id/);
  });

  it("reads the CLI pre-check output (rows JSON, stderr noise, failures)", () => {
    const ok = JSON.stringify({ boundary: "b", rows: [{ data_key: DATA_KEY, funnel_paths: true }], warning: "w" });
    expect(checkCliDataKeyOutput(0, ok, "Initialising login role...")).toEqual({ ok: true, dataKey: DATA_KEY });
    expect(checkCliDataKeyOutput(0, `Initialising login role...\n${ok}`, "")).toEqual({ ok: true, dataKey: DATA_KEY });
    expect(checkCliDataKeyOutput(0, JSON.stringify({ rows: [{ data_key: null }] }), "").reason).toMatch(/not bootstrapped/);
    expect(checkCliDataKeyOutput(0, JSON.stringify({ rows: [] }), "").reason).toMatch(/not bootstrapped/);
    expect(checkCliDataKeyOutput(0, JSON.stringify({ rows: [{ data_key: "x" }] }), "").ok).toBe(false);
    expect(checkCliDataKeyOutput(0, "not json", "").ok).toBe(false);
    expect(checkCliDataKeyOutput(1, "", "ERROR: function public.workspace_data_key() does not exist").reason).toMatch(/apply 202610050001 and 202610050002/);
    expect(checkCliDataKeyOutput(1, "", "Access token not provided").reason).toMatch(/supabase db query failed/);
    // Access Phase 2: the functions embed funnel_paths, so 202610060001 comes first.
    for (const funnelPaths of [false, null, undefined]) {
      expect(checkCliDataKeyOutput(0, JSON.stringify({ rows: [{ data_key: DATA_KEY, funnel_paths: funnelPaths }] }), "").reason).toMatch(/apply 202610060001_access_phase2_scope\.sql first/);
    }
    const sql = readFileSync(resolve(ROOT, DATA_KEY_CHECK_SQL_FILE), "utf8");
    expect(sql).toMatch(/select public\.workspace_data_key\(\)::text as data_key,/);
    expect(sql).toMatch(/to_regclass\('public\.funnel_paths'\) is not null as funnel_paths;/);
  });

  it("reads the PostgREST funnel_paths probe (service-key pre-check)", () => {
    expect(checkFunnelPathsResponse(200, "[]")).toEqual({ ok: true });
    expect(checkFunnelPathsResponse(206, "[]")).toEqual({ ok: true });
    expect(checkFunnelPathsResponse(404, '{"code":"PGRST205","message":"Could not find the table \'public.funnel_paths\' in the schema cache"}').reason).toMatch(/apply 202610060001/);
    expect(checkFunnelPathsResponse(400, '{"code":"42P01","message":"relation \\"public.funnel_paths\\" does not exist"}').reason).toMatch(/apply 202610060001/);
    expect(checkFunnelPathsResponse(500, "boom").reason).toMatch(/funnel_paths check failed with HTTP 500/);
  });

  it("runs the pinned CLI through npx when no supabase binary is installed", () => {
    expect(resolveCliCommand("supabase", ["functions", "list"], true)).toEqual({ command: "supabase", args: ["functions", "list"] });
    expect(resolveCliCommand("supabase", ["functions", "list"], false)).toEqual({ command: "npx", args: ["--yes", SUPABASE_CLI_NPX_PACKAGE, "functions", "list"] });
    expect(resolveCliCommand("git", ["rev-parse"], false)).toEqual({ command: "git", args: ["rev-parse"] });
  });

  it("accepts only a uuid data key from the pre-check", () => {
    expect(checkDataKeyResponse(200, JSON.stringify(DATA_KEY))).toEqual({ ok: true, dataKey: DATA_KEY });
    expect(checkDataKeyResponse(200, "null")).toMatchObject({ ok: false, reason: expect.stringMatching(/not bootstrapped/) });
    expect(checkDataKeyResponse(404, "{}")).toMatchObject({ ok: false, reason: expect.stringMatching(/apply 202610050001 and 202610050002/) });
    expect(checkDataKeyResponse(401, "denied")).toMatchObject({ ok: false });
    expect(checkDataKeyResponse(200, '"nope"')).toMatchObject({ ok: false });
    expect(checkDataKeyResponse(200, "<html>")).toMatchObject({ ok: false });
  });

  it("verifies one build id across functions", () => {
    expect(verifyBuildIds([{ fn: "a", status: 204, buildId: "x" }, { fn: "b", status: 204, buildId: "x" }], "x")).toEqual({ ok: true, problems: [] });
    expect(verifyBuildIds([{ fn: "a", status: 204, buildId: "x" }, { fn: "b", status: 204, buildId: "old" }], "x").problems).toEqual(["b: x-build-id old, expected x"]);
    expect(verifyBuildIds([{ fn: "a", status: 204, buildId: null }], "x").problems[0]).toMatch(/no x-build-id header/);
    expect(verifyBuildIds([{ fn: "a", status: 204, buildId: "x" }, { fn: "b", status: 204, buildId: "y" }]).problems).toEqual([
      "functions report 2 different build ids: x, y",
    ]);
  });

  it("parses the command line", () => {
    expect(parseArgs(["--project-ref", "ref"])).toEqual({ projectRef: "ref", dryRun: false, verifyOnly: false, buildId: null });
    expect(parseArgs(["--project-ref=ref", "--verify-only"])).toMatchObject({ verifyOnly: true });
    expect(() => parseArgs([])).toThrow(/--project-ref/);
    expect(() => parseArgs(["--project-ref", "r", "--dry-run", "--verify-only"])).toThrow(/exclusive/);
    expect(() => parseArgs(["--project-ref", "r", "--force"])).toThrow(/unknown argument/);
  });

  it("is wired as an npm script and replaces the README's partial deploy list", () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
    expect(pkg.scripts["deploy:functions"]).toBe("node scripts/deploy-functions.mjs");
    const readme = readFileSync(resolve(ROOT, "README.md"), "utf8");
    expect(readme).toContain("npm run deploy:functions");
    expect(readme).not.toMatch(/supabase functions deploy clickhouse-cohorts clickhouse-facebook/);
  });
});

// ---- orchestration with fakes ------------------------------------------------------------------

const REPO = ["access", "clickhouse-cohorts", "export-campaign-performance"];

function harness(options: {
  dataKey?: string | null;
  dataKeyStatus?: number;
  deployed?: string[];
  deployFails?: string[];
  liveBuildIds?: (fn: string, stamped: string) => string | null;
  /** CLI pre-check (no service key): the data key the query returns, or a failure. */
  cliDataKey?: string | null;
  cliFailure?: { code: number; stderr: string };
  /** Migration 202610060001 applied (public.funnel_paths exists); default true. */
  funnelPaths?: boolean;
} = {}) {
  const funnelPaths = options.funnelPaths ?? true;
  const files = new Map<string, string>([[resolve(ROOT, BUILD_ID_FILE), BUILD_ID_SOURCE]]);
  const lines: string[] = [];
  let deployed = [...(options.deployed ?? [...REPO, "funnelfox-endpoint-probe"])];
  const stampedAtDeploy: string[] = [];
  const exec = vi.fn((command: string, args: string[]) => {
    if (command === "git") return { code: 0, stdout: "abc123def456\n", stderr: "" };
    if (args[0] === "db" && args[1] === "query") {
      if (options.cliFailure) return { code: options.cliFailure.code, stdout: "", stderr: options.cliFailure.stderr };
      const value = options.cliDataKey === undefined ? DATA_KEY : options.cliDataKey;
      return { code: 0, stdout: JSON.stringify({ boundary: "b", rows: [{ data_key: value, funnel_paths: funnelPaths }], warning: "untrusted" }), stderr: "Initialising login role...\n" };
    }
    const [, sub, fn] = args;
    if (sub === "list") return { code: 0, stdout: JSON.stringify(deployed.map((slug) => ({ slug }))), stderr: "" };
    if (sub === "deploy") {
      stampedAtDeploy.push(readBuildId(files.get(resolve(ROOT, BUILD_ID_FILE)) as string) as string);
      if (options.deployFails?.includes(fn)) return { code: 1, stdout: "", stderr: "bundle failed" };
      if (!deployed.includes(fn)) deployed.push(fn);
      return { code: 0, stdout: "", stderr: "" };
    }
    if (sub === "delete") {
      deployed = deployed.filter((slug) => slug !== fn);
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "unexpected" };
  });
  const fetchFn = vi.fn(async (url: string, init: { method: string }) => {
    if (url.endsWith("/rest/v1/rpc/workspace_data_key")) {
      const value = options.dataKey === undefined ? DATA_KEY : options.dataKey;
      return new Response(JSON.stringify(value), { status: options.dataKeyStatus ?? 200 });
    }
    if (url.endsWith("/rest/v1/funnel_paths?select=id&limit=1")) {
      expect(init.method).toBe("GET");
      return funnelPaths
        ? new Response("[]", { status: 200 })
        : new Response(JSON.stringify({ code: "PGRST205", message: "Could not find the table 'public.funnel_paths' in the schema cache" }), { status: 404 });
    }
    expect(init.method).toBe("OPTIONS");
    const fn = url.split("/functions/v1/")[1];
    const stamped = stampedAtDeploy[0] ?? "committed-build";
    const id = options.liveBuildIds ? options.liveBuildIds(fn, stamped) : stamped;
    return new Response(null, { status: 204, headers: id ? { "x-build-id": id } : {} });
  });
  const deps = {
    root: ROOT,
    env: { SUPABASE_SERVICE_ROLE_KEY: "service-key" },
    log: (line: string) => lines.push(line),
    now: () => new Date("2026-10-06T12:00:00.000Z"),
    exec,
    fetch: fetchFn,
    readFile: (path: string) => files.get(path) as string,
    writeFile: (path: string, text: string) => files.set(path, text),
    listRepoFunctions: () => REPO,
  };
  const deploys = () => exec.mock.calls.filter(([, args]) => args[1] === "deploy").map(([, args]) => args[2]);
  const deletes = () => exec.mock.calls.filter(([, args]) => args[1] === "delete").map(([, args]) => args[2]);
  return { deps, lines, exec, fetchFn, files, deploys, deletes, stampedAtDeploy, buildIdFile: () => files.get(resolve(ROOT, BUILD_ID_FILE)) };
}

describe("runDeploy", () => {
  it("refuses to deploy anything before migration 0002 + bootstrap (every call would be 503)", async () => {
    for (const [dataKey, status] of [[null, 200], [DATA_KEY, 404]] as const) {
      const h = harness({ dataKey, dataKeyStatus: status });
      expect(await runDeploy(["--project-ref", "ref"], h.deps)).toBe(1);
      expect(h.deploys()).toEqual([]);
      expect(h.deletes()).toEqual([]);
      expect(h.lines.join("\n")).toMatch(/REFUSED/);
    }
    // Without SUPABASE_SERVICE_ROLE_KEY the same gate runs through the CLI login.
    for (const options of [{ cliDataKey: null }, { cliFailure: { code: 1, stderr: 'ERROR: function public.workspace_data_key() does not exist' } }]) {
      const h = harness(options);
      expect(await runDeploy(["--project-ref", "ref"], { ...h.deps, env: {} })).toBe(1);
      expect(h.deploys()).toEqual([]);
      expect(h.deletes()).toEqual([]);
      expect(h.lines.join("\n")).toMatch(/REFUSED/);
      expect(h.fetchFn.mock.calls.filter(([url]) => String(url).includes("/rest/v1/"))).toEqual([]);
    }
  });

  it("refuses to deploy before migration 202610060001 (the access function embeds funnel_paths), both pre-check routes", async () => {
    for (const env of [{ SUPABASE_SERVICE_ROLE_KEY: "service-key" }, {}]) {
      const h = harness({ funnelPaths: false });
      expect(await runDeploy(["--project-ref", "ref"], { ...h.deps, env })).toBe(1);
      expect(h.deploys()).toEqual([]);
      expect(h.deletes()).toEqual([]);
      expect(h.lines.join("\n")).toMatch(/REFUSED: public\.funnel_paths does not exist: apply 202610060001_access_phase2_scope\.sql first/);
      // --verify-only is gated the same way.
      const verify = harness({ funnelPaths: false });
      expect(await runDeploy(["--project-ref", "ref", "--verify-only"], { ...verify.deps, env })).toBe(1);
    }
  });

  it("pre-checks through the CLI login when no service key is set, then deploys with server-side bundling", async () => {
    const h = harness();
    expect(await runDeploy(["--project-ref", "ref"], { ...h.deps, env: {} })).toBe(0);
    const query = h.exec.mock.calls.find(([, args]) => args[0] === "db");
    expect(query?.[1]).toEqual(["db", "query", "--linked", "--project-ref", "ref", "-o", "json", "-f", DATA_KEY_CHECK_SQL_FILE]);
    expect(h.fetchFn.mock.calls.filter(([url]) => String(url).includes("/rest/v1/"))).toEqual([]);
    expect(h.deploys()).toEqual(REPO);
    for (const [, args] of h.exec.mock.calls.filter(([, args]) => args[1] === "deploy")) expect(args).toContain("--use-api");
  });

  it("deploys every repo function with one stamped build id, deletes extras, verifies, and restores buildId.ts", async () => {
    const h = harness();
    expect(await runDeploy(["--project-ref", "ref"], h.deps)).toBe(0);
    expect(h.deploys()).toEqual(REPO);
    expect(new Set(h.stampedAtDeploy)).toEqual(new Set(["deploy-20261006T120000Z-abc123def456"]));
    expect(h.deletes()).toEqual(["funnelfox-endpoint-probe"]);
    expect(h.buildIdFile()).toBe(BUILD_ID_SOURCE);
    expect(h.fetchFn.mock.calls.filter(([url]) => String(url).includes("/functions/v1/")).map(([url]) => String(url).split("/functions/v1/")[1])).toEqual(REPO);
    expect(h.lines.at(-1)).toMatch(/^VERIFIED: 3 functions deployed/);
  });

  it("fails the gate when any function still reports another build", async () => {
    const h = harness({ liveBuildIds: (fn, stamped) => (fn === "clickhouse-cohorts" ? "access-p1-2026-10-05" : stamped) });
    expect(await runDeploy(["--project-ref", "ref"], h.deps)).toBe(1);
    expect(h.lines.join("\n")).toMatch(/clickhouse-cohorts: x-build-id access-p1-2026-10-05, expected deploy-/);
    expect(h.buildIdFile()).toBe(BUILD_ID_SOURCE);
  });

  it("a failed deploy is reported as a mixed-build state, and buildId.ts is still restored", async () => {
    const h = harness({ deployFails: ["clickhouse-cohorts"] });
    expect(await runDeploy(["--project-ref", "ref"], h.deps)).toBe(1);
    expect(h.lines.join("\n")).toMatch(/MIXED builds/);
    expect(h.deletes()).toEqual([]);
    expect(h.buildIdFile()).toBe(BUILD_ID_SOURCE);
  });

  it("--dry-run prints the plan and changes nothing", async () => {
    const h = harness();
    expect(await runDeploy(["--project-ref", "ref", "--dry-run"], h.deps)).toBe(0);
    expect(h.deploys()).toEqual([]);
    expect(h.deletes()).toEqual([]);
    expect(h.lines.join("\n")).toMatch(/plan: delete 1 deployed function\(s\) not in the repo: funnelfox-endpoint-probe/);
  });

  it("--verify-only checks the live set and one shared build id without deploying", async () => {
    const same = harness({ deployed: REPO, liveBuildIds: () => "access-p1-2026-10-05" });
    expect(await runDeploy(["--project-ref", "ref", "--verify-only"], same.deps)).toBe(0);
    expect(same.deploys()).toEqual([]);

    const mixed = harness({ deployed: [...REPO, "funnelfox-endpoint-probe"], liveBuildIds: (fn) => (fn === "access" ? "new" : "old") });
    expect(await runDeploy(["--project-ref", "ref", "--verify-only"], mixed.deps)).toBe(1);
    const output = mixed.lines.join("\n");
    expect(output).toMatch(/deployed but not in the repo \(delete them\): funnelfox-endpoint-probe/);
    expect(output).toMatch(/different build ids/);
  });
});
