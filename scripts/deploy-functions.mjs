#!/usr/bin/env node
// Deploy-all for the Supabase Edge functions (plan §26.6 / §31 "scripts/deploy-functions").
//
// Access control only holds when EVERY function runs the access-aware build: an
// old build left live treats any valid JWT as authorized and the caller as the
// tenant. So functions are never deployed one by one by hand. This script:
//
//   1. PRE-CHECK  public.workspace_data_key() must return the workspace data key
//      (migrations 202610050001 + 202610050002 applied AND bootstrap_workspace()
//      run). Without it every new function answers 503 (calls, crons, the Export
//      API), so the script refuses to deploy anything.
//   2. STAMP      a fresh BUILD_ID into supabase/functions/_shared/access/buildId.ts
//      (git sha + UTC time), restored to the committed content afterwards.
//   3. DEPLOY     every folder under supabase/functions that has an index.ts.
//   4. PRUNE      delete every DEPLOYED function that is not in the repo (e.g. the
//      removed funnelfox-endpoint-probe).
//   5. VERIFY     the deployed set equals the repo set, and every function answers
//      OPTIONS with x-build-id == the stamped id. Exit code 1 otherwise.
//
// `--verify-only` runs 1 and 5 against what is live (all functions report the
// SAME build id, set equal to the repo): the gate before adding the first
// employee. `--dry-run` prints the plan and changes nothing.
//
// Usage:
//   SUPABASE_SERVICE_ROLE_KEY=... node scripts/deploy-functions.mjs --project-ref <ref> [--dry-run | --verify-only]
//   (SUPABASE_URL defaults to https://<ref>.supabase.co; the Supabase CLI must be
//   logged in: `supabase login`.)
//
// Freeze the crons before running it and unfreeze them only after it passed
// (README "Access control rollout").

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const FUNCTIONS_DIR = "supabase/functions";
export const BUILD_ID_FILE = "supabase/functions/_shared/access/buildId.ts";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BUILD_ID_LINE = /^export const BUILD_ID = "[^"\n]*";$/m;

// ---- pure helpers (unit-tested) ------------------------------------------------------------

/** Function folders of the repo: every directory with an index.ts, except
 * shared code (`_shared`) and hidden folders. Sorted. */
export function listRepoFunctions(root, fsLike = { readdirSync, existsSync }) {
  const dir = join(root, FUNCTIONS_DIR);
  return fsLike
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_") && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .filter((name) => fsLike.existsSync(join(dir, name, "index.ts")))
    .sort();
}

/** Slugs from `supabase functions list -o json` (an array of {slug|name, ...}). */
export function parseDeployedFunctions(jsonText) {
  let parsed;
  try {
    parsed = JSON.parse(String(jsonText ?? "").trim() || "null");
  } catch {
    throw new Error("could not parse `supabase functions list -o json` output");
  }
  if (!Array.isArray(parsed)) throw new Error("`supabase functions list -o json` did not return an array");
  return [...new Set(parsed.map((entry) => String(entry?.slug ?? entry?.name ?? "").trim()).filter(Boolean))].sort();
}

export function diffFunctionSets(repo, deployed) {
  const repoSet = new Set(repo);
  const deployedSet = new Set(deployed);
  return {
    missing: repo.filter((name) => !deployedSet.has(name)),
    extra: deployed.filter((name) => !repoSet.has(name)),
  };
}

export function generateBuildId(gitSha, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const sha = String(gitSha ?? "").trim().slice(0, 12) || "nogit";
  return `deploy-${stamp}-${sha}`;
}

/** buildId.ts with its BUILD_ID constant replaced (the rest kept verbatim). */
export function renderBuildIdSource(original, buildId) {
  if (!/^[A-Za-z0-9._:-]{1,80}$/.test(buildId)) throw new Error(`invalid build id: ${buildId}`);
  if (!BUILD_ID_LINE.test(original)) throw new Error(`${BUILD_ID_FILE} has no \`export const BUILD_ID = "...";\` line`);
  return original.replace(BUILD_ID_LINE, `export const BUILD_ID = "${buildId}";`);
}

export function readBuildId(source) {
  const match = /^export const BUILD_ID = "([^"\n]*)";$/m.exec(source);
  return match ? match[1] : null;
}

/** PostgREST answer of rpc/workspace_data_key → ok only for a uuid. */
export function checkDataKeyResponse(status, bodyText) {
  if (status === 404) return { ok: false, reason: "public.workspace_data_key() does not exist: apply 202610050001 and 202610050002 first" };
  if (status < 200 || status >= 300) return { ok: false, reason: `workspace_data_key() failed with HTTP ${status}: ${String(bodyText).slice(0, 200)}` };
  let value;
  try {
    value = JSON.parse(String(bodyText ?? "").trim() || "null");
  } catch {
    return { ok: false, reason: "workspace_data_key() returned a non-JSON body" };
  }
  if (value === null) return { ok: false, reason: "the workspace is not bootstrapped: run select public.bootstrap_workspace('<data owner uuid>', 'SubEngine'); first" };
  if (typeof value !== "string" || !UUID_RE.test(value)) return { ok: false, reason: "workspace_data_key() returned something that is not a uuid" };
  return { ok: true, dataKey: value };
}

/** Every function answered with the expected build id (or, without one, all
 * with the SAME id). results: [{ fn, status, buildId }]. */
export function verifyBuildIds(results, expected) {
  const problems = [];
  for (const { fn, status, buildId } of results) {
    if (!buildId) problems.push(`${fn}: no x-build-id header (HTTP ${status}) — an old build or not deployed`);
    else if (expected && buildId !== expected) problems.push(`${fn}: x-build-id ${buildId}, expected ${expected}`);
  }
  if (!expected) {
    const ids = [...new Set(results.map((result) => result.buildId).filter(Boolean))];
    if (ids.length > 1) problems.push(`functions report ${ids.length} different build ids: ${ids.join(", ")}`);
  }
  return { ok: problems.length === 0, problems };
}

export function parseArgs(argv) {
  const options = { projectRef: null, dryRun: false, verifyOnly: false, buildId: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--verify-only") options.verifyOnly = true;
    else if (arg === "--project-ref") options.projectRef = argv[++index] ?? null;
    else if (arg.startsWith("--project-ref=")) options.projectRef = arg.slice("--project-ref=".length);
    else if (arg === "--build-id") options.buildId = argv[++index] ?? null;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!options.projectRef) throw new Error("--project-ref <ref> is required");
  if (options.dryRun && options.verifyOnly) throw new Error("--dry-run and --verify-only are exclusive");
  return options;
}

// ---- orchestration (dependency-injected; vitest drives it with fakes) --------------------------

/**
 * deps: {
 *   root, env, log(line), now(),
 *   exec(command, args) → { code, stdout, stderr },   // the Supabase CLI and git
 *   fetch(url, init) → Response,
 *   readFile(path), writeFile(path, text),
 *   listRepoFunctions(root),
 * }
 * Returns the process exit code (0 = every gate passed).
 */
export async function runDeploy(argv, deps) {
  const log = deps.log;
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    log(`error: ${error.message}`);
    return 2;
  }
  const ref = options.projectRef;
  const baseUrl = String(deps.env.SUPABASE_URL ?? `https://${ref}.supabase.co`).replace(/\/+$/, "");
  const serviceKey = String(deps.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
  if (!serviceKey) {
    log("error: SUPABASE_SERVICE_ROLE_KEY is required for the workspace pre-check (it is never sent anywhere but the project's PostgREST)");
    return 2;
  }

  // 1. pre-check: migrations + bootstrap before any function
  let check;
  try {
    const response = await deps.fetch(`${baseUrl}/rest/v1/rpc/workspace_data_key`, {
      method: "POST",
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
      body: "{}",
    });
    check = checkDataKeyResponse(response.status, await response.text());
  } catch (error) {
    check = { ok: false, reason: `could not reach PostgREST: ${error.message}` };
  }
  if (!check.ok) {
    log(`REFUSED: ${check.reason}`);
    log("Nothing was deployed. Functions deployed before migration 0002 + bootstrap answer 503 to every call, cron and Export API key.");
    return 1;
  }
  log(`pre-check ok: the workspace is bootstrapped (data key ${check.dataKey.slice(0, 8)}…)`);

  const repo = deps.listRepoFunctions(deps.root);
  const listDeployed = () => {
    const listed = deps.exec("supabase", ["functions", "list", "--project-ref", ref, "-o", "json"]);
    if (listed.code !== 0) throw new Error(`supabase functions list failed: ${listed.stderr || listed.stdout}`);
    return parseDeployedFunctions(listed.stdout);
  };

  let expected = null;
  if (!options.verifyOnly) {
    let deployed;
    try {
      deployed = listDeployed();
    } catch (error) {
      log(`error: ${error.message}`);
      return 1;
    }
    const { extra } = diffFunctionSets(repo, deployed);
    const sha = deps.exec("git", ["rev-parse", "--short=12", "HEAD"]);
    expected = options.buildId ?? generateBuildId(sha.code === 0 ? sha.stdout : "", deps.now());
    log(`plan: deploy ${repo.length} functions as ${expected}: ${repo.join(", ")}`);
    log(extra.length ? `plan: delete ${extra.length} deployed function(s) not in the repo: ${extra.join(", ")}` : "plan: nothing to delete");
    if (options.dryRun) {
      log("dry run: nothing changed");
      return 0;
    }

    // 2 + 3. stamp, deploy every function, always restore buildId.ts
    const buildIdPath = join(deps.root, BUILD_ID_FILE);
    const original = deps.readFile(buildIdPath);
    const failed = [];
    try {
      deps.writeFile(buildIdPath, renderBuildIdSource(original, expected));
      for (const fn of repo) {
        log(`deploy ${fn}`);
        const result = deps.exec("supabase", ["functions", "deploy", fn, "--project-ref", ref]);
        if (result.code !== 0) {
          failed.push(fn);
          log(`  FAILED: ${(result.stderr || result.stdout || "").trim().slice(0, 500)}`);
        }
      }
    } finally {
      deps.writeFile(buildIdPath, original);
    }
    if (failed.length) {
      log(`ERROR: ${failed.length} function(s) failed to deploy: ${failed.join(", ")}. The project now runs MIXED builds — re-run this script; do not add employees.`);
      return 1;
    }

    // 4. prune what the repo no longer has
    for (const fn of extra) {
      log(`delete ${fn}`);
      const result = deps.exec("supabase", ["functions", "delete", fn, "--project-ref", ref]);
      if (result.code !== 0) {
        log(`ERROR: could not delete ${fn}: ${(result.stderr || result.stdout || "").trim().slice(0, 500)}`);
        return 1;
      }
    }
  }

  // 5. verify: deployed set == repo set, one build id everywhere
  let problems = [];
  try {
    const { missing, extra } = diffFunctionSets(repo, listDeployed());
    if (missing.length) problems.push(`not deployed: ${missing.join(", ")}`);
    if (extra.length) problems.push(`deployed but not in the repo (delete them): ${extra.join(", ")}`);
  } catch (error) {
    problems.push(error.message);
  }
  const results = [];
  for (const fn of repo) {
    try {
      const response = await deps.fetch(`${baseUrl}/functions/v1/${fn}`, {
        method: "OPTIONS",
        headers: { Origin: "https://deploy-check.invalid", "Access-Control-Request-Method": "POST" },
      });
      results.push({ fn, status: response.status, buildId: response.headers.get("x-build-id") });
    } catch (error) {
      results.push({ fn, status: 0, buildId: null });
      problems.push(`${fn}: ${error.message}`);
    }
  }
  const verdict = verifyBuildIds(results, expected);
  problems = [...problems, ...verdict.problems];
  if (problems.length) {
    log("VERIFY FAILED:");
    for (const problem of problems) log(`  - ${problem}`);
    log("Do not unfreeze the crons or add employees until this passes.");
    return 1;
  }
  const id = expected ?? results[0]?.buildId;
  log(`VERIFIED: ${repo.length} functions deployed, set equals the repo, every function reports build ${id}.`);
  return 0;
}

// ---- CLI ----------------------------------------------------------------------------------------

function liveDeps(root) {
  return {
    root,
    env: process.env,
    log: (line) => console.log(line),
    now: () => new Date(),
    exec: (command, args) => {
      // `shell` on Windows so the npm-installed `supabase.cmd` shim resolves.
      const result = spawnSync(command, args, { cwd: root, encoding: "utf8", shell: process.platform === "win32" });
      return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? String(result.error ?? "") };
    },
    fetch: (url, init) => fetch(url, init),
    readFile: (path) => readFileSync(path, "utf8"),
    writeFile: (path, text) => writeFileSync(path, text),
    listRepoFunctions: (dir) => listRepoFunctions(dir),
  };
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  runDeploy(process.argv.slice(2), liveDeps(root)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error);
      process.exit(1);
    },
  );
}
