// Security static lints (plan §29 "Static lints"), in the repo's readFileSync
// style but parsed with the TypeScript compiler API where text matching would be
// fragile (imports, catch blocks, string literals vs comments).
//
//   1. The ClickHouse transport (client.ts) is reachable only through the
//      ScopedReader: no file under supabase/functions/** except
//      _shared/clickhouse/scopedClient.ts imports internalCreateClickHouseClient /
//      FetchClickHouseClient / createClickHouseClient; the documented health
//      allowlist imports only the secret-free config probes.
//   2. The warehouse password (and host / user) is read only in client.ts.
//   3. No function entry point reads a tenant from the request (body / query
//      auth_user_id), nobody but the gate reads the request body, and every SQL
//      tenant predicate binds {auth_user_id:String} (never an interpolated id or
//      another parameter name the ScopedReader would not force).
//   4. Every catch in the runner modules that swallows errors rethrows
//      ScopeViolation (R7); the exceptions are whitelisted with reasons and
//      checked mechanically (no warehouse call can throw one there).
//   5. Folded migrations (PGlite end state, every migration + bootstrap + the
//      lockdown): every public table has RLS; every SECURITY DEFINER function
//      pins search_path and is not executable by anon; the 2026-10-05 functions
//      are revoked from anon; no browser write path remains on access / state
//      tables.
//   6. No access error code or message says "unavailable" (the frontend breaker
//      matches that word).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/services/supabaseClient", () => ({
  isSupabaseConfigured: true,
  supabase: {
    functions: { invoke: async () => ({ data: null, error: null }) },
    auth: { getSession: async () => ({ data: { session: null }, error: null }) },
  },
}));

import { ACCESS_ERROR, ACCESS_ERROR_MESSAGES } from "../../supabase/functions/_shared/access/errors.ts";
import { AccessAdminError, AccessAdminStoreError, accessAdminOnError } from "../../supabase/functions/_shared/access/adminApi.ts";
import { verifyEdgeBearerSession } from "../../supabase/functions/_shared/clickhouse/auth.ts";
import { REPORT_NOT_FOUND } from "../../supabase/functions/reports-generate/handler.ts";
import { isWarehouseDownError } from "@/services/clickhouse";
import { createLockedWorkspace, type SeededWorkspace } from "./support/accessFixtures";
import { listMigrations, readMigration } from "./support/pgliteSupabase";

const ROOT = process.cwd();
const FUNCTIONS_DIR = resolve(ROOT, "supabase/functions");
const CLICKHOUSE_DIR = resolve(FUNCTIONS_DIR, "_shared/clickhouse");
const ACCESS_DIR = resolve(FUNCTIONS_DIR, "_shared/access");
const CLIENT_TS = resolve(CLICKHOUSE_DIR, "client.ts");

const rel = (path: string) => relative(FUNCTIONS_DIR, path).split(sep).join("/");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (/\.(ts|tsx|js|mjs)$/.test(name)) out.push(path);
  }
  return out.sort();
}

const FUNCTION_FILES = walk(FUNCTIONS_DIR);
const sources = new Map<string, ts.SourceFile>();
function parse(path: string): ts.SourceFile {
  let file = sources.get(path);
  if (!file) {
    file = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    sources.set(path, file);
  }
  return file;
}

function visit(node: ts.Node, fn: (node: ts.Node) => void): void {
  fn(node);
  ts.forEachChild(node, (child) => visit(child, fn));
}

function line(file: ts.SourceFile, node: ts.Node): number {
  return file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
}

/** Every module specifier (static import / export-from / dynamic import()) of a file. */
function moduleReferences(file: ts.SourceFile): Array<{ specifier: string; names: string[] | "*"; node: ts.Node }> {
  const refs: Array<{ specifier: string; names: string[] | "*"; node: ts.Node }> = [];
  visit(file, (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      let names: string[] | "*" = [];
      if (clause?.name) names = "*"; // default import: the whole module surface
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) names = "*";
      if (bindings && ts.isNamedImports(bindings) && names !== "*") {
        names = bindings.elements.map((element) => (element.propertyName ?? element.name).text);
      }
      refs.push({ specifier: node.moduleSpecifier.text, names, node });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const names = node.exportClause && ts.isNamedExports(node.exportClause)
        ? node.exportClause.elements.map((element) => (element.propertyName ?? element.name).text)
        : "*";
      refs.push({ specifier: node.moduleSpecifier.text, names, node });
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [arg] = node.arguments;
      refs.push({ specifier: arg && ts.isStringLiteralLike(arg) ? arg.text : "<dynamic>", names: "*", node });
    }
  });
  return refs;
}

function resolvesTo(fromFile: string, specifier: string, target: string): boolean {
  if (!specifier.startsWith(".")) return false;
  const resolved = resolve(dirname(fromFile), specifier);
  return resolved === target || `${resolved}.ts` === target;
}

// =========================================================================================
// 1-2. the ClickHouse transport and its secrets
// =========================================================================================

const TRANSPORT_SYMBOLS = new Set(["internalCreateClickHouseClient", "FetchClickHouseClient", "createClickHouseClient"]);

/** Files allowed to import client.ts, and exactly what. */
const CLIENT_IMPORT_ALLOWLIST: Record<string, { names: string[]; reason: string }> = {
  "_shared/clickhouse/scopedClient.ts": {
    names: ["internalCreateClickHouseClient"],
    reason: "the ScopedReader is the only owner of the raw transport (plan §13 layer 2)",
  },
  "clickhouse-health/index.ts": {
    names: ["clickHouseEnv", "isClickHouseConfigured"],
    reason: "config probes only (booleans + database name); the SELECT 1 probe itself runs through the request's ScopedReader",
  },
};

describe("1. the ClickHouse transport is reachable only through the ScopedReader", () => {
  const importers = FUNCTION_FILES.flatMap((path) =>
    moduleReferences(parse(path))
      .filter((ref) => ref.specifier === "<dynamic>" || resolvesTo(path, ref.specifier, CLIENT_TS))
      .map((ref) => ({ path, file: rel(path), ...ref })),
  );

  it("scans every function source (sanity)", () => {
    expect(FUNCTION_FILES.length).toBeGreaterThan(100);
    expect(FUNCTION_FILES.map(rel)).toContain("_shared/clickhouse/scopedClient.ts");
  });

  it("no file but scopedClient.ts imports a transport symbol (static, re-export or dynamic import)", () => {
    const offenders = importers
      .filter((ref) => ref.file !== "_shared/clickhouse/scopedClient.ts")
      .filter((ref) => ref.names === "*" || ref.names.some((name) => TRANSPORT_SYMBOLS.has(name)))
      .map((ref) => `${ref.file}:${line(parse(ref.path), ref.node)} imports ${ref.names === "*" ? "*" : ref.names.join(", ")} from ${ref.specifier}`);
    expect(offenders).toEqual([]);
  });

  it("every importer of client.ts is allowlisted and imports only its listed names; no allowlist entry is stale", () => {
    const seen = new Set<string>();
    for (const ref of importers) {
      if (ref.specifier === "<dynamic>") throw new Error(`${ref.file}: dynamic import() with a computed specifier`);
      const allowed = CLIENT_IMPORT_ALLOWLIST[ref.file];
      expect(allowed, `${ref.file} imports client.ts`).toBeDefined();
      expect(ref.names, ref.file).not.toBe("*");
      for (const name of ref.names as string[]) expect(allowed.names, `${ref.file}: ${name}`).toContain(name);
      seen.add(ref.file);
    }
    expect([...seen].sort()).toEqual(Object.keys(CLIENT_IMPORT_ALLOWLIST).sort());
  });

  it("nothing outside client.ts constructs or re-implements the transport", () => {
    const offenders: string[] = [];
    for (const path of FUNCTION_FILES) {
      if (path === CLIENT_TS) continue;
      const text = parse(path).getFullText();
      for (const pattern of [/\bnew\s+FetchClickHouseClient\b/, /encodeBasicAuth\(/, /param_\$\{/]) {
        if (pattern.test(text)) offenders.push(`${rel(path)}: ${pattern}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("2. warehouse secrets are read only in client.ts", () => {
  const SECRET_NAMES = new Set(["CLICKHOUSE_PASSWORD", "CLICKHOUSE_HOST", "CLICKHOUSE_USERNAME"]);

  it("the secret names appear as string literals only in client.ts", () => {
    const offenders: string[] = [];
    for (const path of FUNCTION_FILES) {
      if (path === CLIENT_TS) continue;
      const file = parse(path);
      visit(file, (node) => {
        if (ts.isStringLiteralLike(node) && SECRET_NAMES.has(node.text)) offenders.push(`${rel(path)}:${line(file, node)} "${node.text}"`);
      });
    }
    expect(offenders).toEqual([]);
    // Positive control: client.ts does read it.
    expect(readFileSync(CLIENT_TS, "utf8")).toMatch(/["']CLICKHOUSE_PASSWORD["']/);
  });

  it("no function dumps the whole environment", () => {
    const offenders = FUNCTION_FILES.filter((path) => /Deno\.env\.toObject\s*\(/.test(readFileSync(path, "utf8"))).map(rel);
    expect(offenders).toEqual([]);
  });
});

// =========================================================================================
// 3. tenant identity never comes from the request
// =========================================================================================

const ENTRY_FILES = FUNCTION_FILES.filter((path) => !rel(path).startsWith("_shared/"));
/** Names the entry points give the parsed request body (serveWithAccess hands
 * it over as `body`; handlers alias it as `request`). Internal helper inputs
 * (`input.authUserId` = ctx.tenantKey) are not request-sourced. */
const REQUEST_IDENTIFIERS = new Set(["body", "request", "req", "payload", "json"]);
const TENANT_FIELDS = new Set(["auth_user_id", "authUserId", "tenant_key", "tenantKey", "data_key", "dataKey"]);

/** Reads of a tenant identity from the request in one source file. */
function requestTenantReads(name: string, file: ts.SourceFile): string[] {
  const offenders: string[] = [];
  const flag = (node: ts.Node) => offenders.push(`${name}:${line(file, node)} ${node.getText(file)}`);
  visit(file, (node) => {
    if (ts.isPropertyAccessExpression(node) && TENANT_FIELDS.has(node.name.text)) {
      const target = node.expression;
      if (ts.isIdentifier(target) && REQUEST_IDENTIFIERS.has(target.text)) flag(node);
    }
    if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) && TENANT_FIELDS.has(node.argumentExpression.text)) flag(node);
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer) {
      const source = ts.isAsExpression(node.initializer) ? node.initializer.expression : node.initializer;
      const fromRequest = ts.isIdentifier(source) && REQUEST_IDENTIFIERS.has(source.text);
      const names = node.name.elements.map((element) => (element.propertyName ?? element.name).getText(file));
      if (fromRequest && names.some((entry) => TENANT_FIELDS.has(entry))) flag(node);
    }
    if (ts.isCallExpression(node) && /\.get$/.test(node.expression.getText(file))) {
      const [arg] = node.arguments;
      if (arg && ts.isStringLiteralLike(arg) && TENANT_FIELDS.has(arg.text)) flag(node);
    }
  });
  if (/\bauth\.id\b/.test(file.getFullText())) offenders.push(`${name}: bare auth.id`);
  return offenders;
}

const CONTEXT_FIELDS = new Set([
  "tenantKey", "restricted", "rawAccess", "permissions", "scope", "actor", "role", "violations", "workspaceId", "accessVersion", "partition",
]);

/** Assignments to ctx.<identity field> (at any depth), deletes, and mutating
 * calls on ctx.permissions / ctx.violations other than violations.push(). */
function contextMutations(name: string, file: ts.SourceFile): string[] {
  const offenders: string[] = [];
  const unwrap = (node: ts.Expression): ts.Expression => {
    let current = node;
    while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isNonNullExpression(current) || ts.isTypeAssertionExpression(current)) {
      current = current.expression;
    }
    return current;
  };
  const contextPath = (node: ts.Expression): string[] | null => {
    const parts: string[] = [];
    let current: ts.Expression = unwrap(node);
    while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
      parts.unshift(ts.isPropertyAccessExpression(current) ? current.name.text : current.argumentExpression.getText(file));
      current = unwrap(current.expression);
    }
    return ts.isIdentifier(current) && current.text === "ctx" && parts.length && CONTEXT_FIELDS.has(parts[0]) ? parts : null;
  };
  visit(file, (node) => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      if (contextPath(node.left)) offenders.push(`${name}:${line(file, node)} ${node.getText(file)}`);
    }
    if (ts.isDeleteExpression(node) && contextPath(node.expression)) offenders.push(`${name}:${line(file, node)} ${node.getText(file)}`);
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const target = contextPath(node.expression.expression);
      const method = node.expression.name.text;
      if (target && target.length === 1 && ["permissions", "violations"].includes(target[0])) {
        const allowed = target[0] === "violations" && method === "push";
        const mutating = ["add", "delete", "clear", "splice", "pop", "shift", "unshift", "fill", "copyWithin", "reverse", "sort", "push"].includes(method);
        if (mutating && !allowed) offenders.push(`${name}:${line(file, node)} ${node.getText(file)}`);
      }
    }
  });
  return offenders;
}

/** Tenant tables and their owner column, read from the lockdown migration's own
 * classification (category (a), `lockdown_data_key`), so the lint and the RLS
 * policy can never disagree about what is tenant data. */
function tenantOwnerColumns(): Map<string, string> {
  const sql = readMigration("202610050003_access_rls_lockdown.sql");
  const block = sql.slice(sql.indexOf("2. Workspace data key only"), sql.indexOf("import_batch_files has no owner column"));
  const owners = new Map<string, string>();
  for (const match of block.matchAll(/\('([a-z_]+)',\s*'([a-z_]+)'\)/g)) owners.set(match[1], match[2]);
  owners.set("data_snapshots", "user_id");
  // Category (b), actor-owned rows: the service client must filter on the author.
  for (const table of [
    "reports", "report_versions", "report_tasks", "report_notes", "report_targets", "report_settings",
    "project_forecasts", "forecast_scenarios", "ai_recommendations", "ai_feedback", "ai_assistant_runs", "report_ai_runs",
  ]) owners.set(table, "auth_user_id");
  owners.set("api_keys", "user_id");
  return owners;
}

const NOT_SUPABASE = new Set(["Array", "Buffer", "Uint8Array", "Object", "Set", "Map"]);

/** Tenant-table queries filtered by something other than the owner column, with
 * the reason that is safe. Matched on file + the query text; stale entries fail. */
const TENANT_QUERY_WHITELIST: Array<{ file: string; contains: string; reason: string }> = [
  {
    file: "sync-support-mail/index.ts",
    contains: '.from("support_import_batches").update(patch).eq("id", batchId)',
    reason: "the batch id is created by createImportBatch in the same run, under ctx.tenantKey; it never comes from the request",
  },
  {
    file: "export-campaign-performance/handler.ts",
    contains: '.from("api_keys").select("id,user_id,prefix,is_active,revoked_at,allowed_scopes").eq("key_hash",keyHash)',
    reason: "API-key authentication: the key hash IS the credential; the creator (user_id) is then re-resolved with resolve_access",
  },
  {
    file: "export-campaign-performance/handler.ts",
    contains: '.from("api_keys").update?.({last_used_at:newDate().toISOString()}).eq("id",key.id)',
    reason: "touches last_used_at of the key row just authenticated by its hash",
  },
];

type ChainMethod = { name: string; first: string | null };

/** Method calls chained onto `start` (start.a(...).b(...)...). */
function chainedMethods(start: ts.Node): { methods: ChainMethod[]; end: ts.Node } {
  const methods: ChainMethod[] = [];
  let current: ts.Node = start;
  for (;;) {
    let parent = current.parent;
    while (parent && (ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent) || ts.isNonNullExpression(parent))) {
      current = parent;
      parent = current.parent;
    }
    if (!(parent && ts.isPropertyAccessExpression(parent) && ts.isCallExpression(parent.parent) && parent.parent.expression === parent)) break;
    const call = parent.parent;
    const [first] = call.arguments;
    methods.push({ name: parent.name.text, first: first && ts.isStringLiteralLike(first) ? first.text : null });
    current = call;
  }
  return { methods, end: current };
}

/** `.from("<tenant table>")` chains that read / update / delete without an
 * `.eq(<owner>, …)` (or `.in(<owner>, …)`) — in the chain itself or, when the
 * builder is first stored in a variable, in any chain on that variable within
 * the same function. Writes (insert / upsert) carry the owner in the row. */
function unfilteredTenantQueries(name: string, file: ts.SourceFile, owners: Map<string, string>): { offenders: string[]; checked: number } {
  const offenders: string[] = [];
  let checked = 0;
  visit(file, (node) => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== "from") return;
    const receiver = node.expression.expression;
    if (ts.isIdentifier(receiver) && NOT_SUPABASE.has(receiver.text)) return;
    const [tableArg] = node.arguments;
    if (!tableArg || !ts.isStringLiteralLike(tableArg) || !owners.has(tableArg.text)) return;
    const owner = owners.get(tableArg.text) as string;
    const { methods, end } = chainedMethods(node);

    // `const builder = supabase.from(T) [as …];` — follow the variable.
    let declaration: ts.Node | undefined = end.parent;
    if (declaration && ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name)) {
      const variable = declaration.name.text;
      let scope: ts.Node = declaration;
      while (scope.parent && !ts.isFunctionLike(scope)) scope = scope.parent;
      visit(scope, (inner) => {
        if (ts.isIdentifier(inner) && inner.text === variable && inner !== (declaration as ts.VariableDeclaration).name) {
          methods.push(...chainedMethods(inner).methods);
        }
      });
    } else {
      declaration = undefined;
    }

    if (methods.some((method) => method.name === "insert" || method.name === "upsert")) return;
    checked += 1;
    const filtered = methods.some((method) => (method.name === "eq" || method.name === "in") && method.first === owner);
    if (filtered) return;
    const statementText = (end.parent && ts.isAwaitExpression(end.parent) ? end.parent : end).getText(file).replace(/\s+/g, "");
    const whitelisted = TENANT_QUERY_WHITELIST.find((entry) => entry.file === name && statementText.includes(entry.contains.replace(/\s+/g, "")));
    if (whitelisted) {
      usedTenantWhitelist.add(whitelisted.contains);
      return;
    }
    offenders.push(`${name}:${line(file, node)} ${tableArg.text}: ${methods.map((method) => method.name).join(".")} (no .eq("${owner}", …))`);
  });
  return { offenders, checked };
}

const usedTenantWhitelist = new Set<string>();

/** SQL tenant predicates that bind anything but {auth_user_id:String}. */
function tenantPlaceholderOffenders(name: string, text: string): { offenders: string[]; predicates: number } {
  const offenders: string[] = [];
  let predicates = 0;
  for (const match of text.matchAll(/\bauth_user_id\s*(?:=|\bIN\b)\s*\{\s*(\w+)\s*:\s*(\w+)\s*\}/gi)) {
    predicates += 1;
    if (match[1] !== "auth_user_id") offenders.push(`${name}: ${match[0]}`);
  }
  for (const match of text.matchAll(/\bauth_user_id\s*(?:=|\bIN\b)\s*\(?\s*'?\$\{[^}]*\}/gi)) offenders.push(`${name}: ${match[0]}`);
  for (const match of text.matchAll(/\bauth_user_id\s*=\s*'[0-9a-f-]{36}'/gi)) offenders.push(`${name}: ${match[0]}`);
  return { offenders, predicates };
}

describe("3. no entry point takes the tenant from the request", () => {
  it("scans every function entry point (sanity)", () => {
    expect(ENTRY_FILES.filter((path) => path.endsWith(`${sep}index.ts`)).length).toBeGreaterThanOrEqual(27);
  });

  it("no index.ts / handler.ts reads body.auth_user_id (property, element, destructuring or query string)", () => {
    const offenders = ENTRY_FILES.flatMap((path) => requestTenantReads(rel(path), parse(path)));
    expect(offenders).toEqual([]);
  });

  it("the removed caller-as-tenant helpers are neither defined nor used anywhere (http.ts included)", () => {
    const offenders: string[] = [];
    for (const path of FUNCTION_FILES) {
      const file = parse(path);
      visit(file, (node) => {
        if (ts.isIdentifier(node) && ["requireSupabaseUser", "requireCronSecret", "parseJsonBody"].includes(node.text)) {
          offenders.push(`${rel(path)}:${line(file, node)} ${node.text}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it("no code rewrites the AccessContext identity or clears its recorded violations", () => {
    // The ScopedReader reads ctx.tenantKey / ctx.restricted at QUERY time and the
    // gate reads ctx.violations AFTER the handler: a handler that reassigned the
    // tenant or emptied the violation list would silently defeat both.
    const offenders = FUNCTION_FILES.flatMap((path) => contextMutations(rel(path), parse(path)));
    expect(offenders).toEqual([]);
  });

  it("every service-role read / update / delete of a tenant table filters on its owner column", () => {
    const owners = tenantOwnerColumns();
    expect(owners.size).toBeGreaterThan(25);
    const results = FUNCTION_FILES.map((path) => unfilteredTenantQueries(rel(path), parse(path), owners));
    expect(results.reduce((sum, result) => sum + result.checked, 0)).toBeGreaterThan(40);
    expect(results.flatMap((result) => result.offenders)).toEqual([]);
    for (const entry of TENANT_QUERY_WHITELIST) expect(usedTenantWhitelist.has(entry.contains), `stale whitelist: ${entry.file}`).toBe(true);
  });

  it("only the gate reads the request body (authenticate before parse)", () => {
    const offenders: string[] = [];
    for (const path of FUNCTION_FILES) {
      if (rel(path) === "_shared/access/gate.ts") continue;
      const file = parse(path);
      visit(file, (node) => {
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          ["json", "text", "formData", "arrayBuffer", "blob"].includes(node.expression.name.text) &&
          ts.isIdentifier(node.expression.expression) &&
          ["req", "request"].includes(node.expression.expression.text)
        ) {
          offenders.push(`${rel(path)}:${line(file, node)} ${node.getText(file)}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it("every entry point is a serveWithAccess wrapper (the API-key export builds its context itself)", () => {
    for (const path of ENTRY_FILES.filter((candidate) => candidate.endsWith(`${sep}index.ts`))) {
      const text = readFileSync(path, "utf8");
      const fn = rel(path).split("/")[0];
      if (fn === "export-campaign-performance") {
        // API-key auth: Deno.serve straight into the pure handler, which resolves
        // the key creator itself and reads through a ScopedReader.
        expect(text).toMatch(/Deno\.serve\(\(req: Request\) => \{[\s\S]*handleExportCampaignPerformance\(req,/);
        expect(text).toContain("createScopedReader(ctx)");
      } else {
        expect(text, fn).toMatch(/serveWithAccess\(/);
        expect(text, fn).not.toMatch(/\bDeno\.serve\s*\(/);
      }
      for (const banned of ["requireSupabaseUser", "requireCronSecret", "parseJsonBody", "createClickHouseClient"]) expect(text, `${fn}: ${banned}`).not.toContain(banned);
    }
  });

  it("every SQL tenant predicate binds {auth_user_id:String} — never another parameter name or an interpolated id", () => {
    const results = FUNCTION_FILES.map((path) => tenantPlaceholderOffenders(rel(path), readFileSync(path, "utf8")));
    expect(results.flatMap((result) => result.offenders)).toEqual([]);
    expect(results.reduce((sum, result) => sum + result.predicates, 0)).toBeGreaterThan(100);
  });
});

// =========================================================================================
// 4. every swallowing catch in the runner modules rethrows ScopeViolation
// =========================================================================================

const CATCH_LINT_FILES = [
  "cohorts", "cohortMembership", "fbCohortStats", "users", "paymentAnalytics", "bankAnalytics", "revenueIntelligence", "support", "facebookStats",
].map((name) => resolve(CLICKHOUSE_DIR, `${name}.ts`));

/** Postgres-only helpers: they take the service-role Supabase client and never
 * a ClickHouse reader, so no ScopeViolation can originate inside them. Checked
 * against their declarations below. */
const POSTGRES_ONLY_RECEIVERS = ["getFbSyncState", "getCohortSnapshotState", "upsertFbSyncState", "upsertSyncState", "getSyncState", "sourceTotal"];

/** catch blocks whose try body makes no warehouse call (checked mechanically). */
const CATCH_CLAUSE_WHITELIST: Array<{ file: string; tryContains: string; reason: string }> = [
  { file: "fbCohortStats.ts", tryContains: "new Intl.DateTimeFormat", reason: "timezone validity probe: Intl only, no warehouse call in the try" },
  { file: "fbCohortStats.ts", tryContains: "JSON.parse", reason: "parses the FB_META_ACCOUNT_TIMEZONES_JSON config; no warehouse call in the try" },
];

const WAREHOUSE_CALL = /\.(query|command|insert)\s*\(|clickhouse|ScopedReader/i;

function rethrows(block: string, variable: string | null): boolean {
  if (/\bScopeViolation\b/.test(block)) return true;
  return Boolean(variable) && new RegExp(`\\bthrow\\s+${variable}\\b`).test(block);
}

interface CatchSite {
  file: string;
  line: number;
  kind: "clause" | "promise";
  ok: boolean;
  reason: string;
  text: string;
}

function catchSites(path: string): CatchSite[] {
  return catchSitesOf(path.split(sep).pop() as string, parse(path));
}

function catchSitesOf(name: string, file: ts.SourceFile): CatchSite[] {
  const sites: CatchSite[] = [];
  visit(file, (node) => {
    if (ts.isCatchClause(node)) {
      const variable = node.variableDeclaration && ts.isIdentifier(node.variableDeclaration.name) ? node.variableDeclaration.name.text : null;
      const block = node.block.getText(file);
      const tryBlock = (node.parent as ts.TryStatement).tryBlock.getText(file);
      let ok = rethrows(block, variable);
      let reason = ok ? "rethrows" : "";
      if (!ok) {
        const entry = CATCH_CLAUSE_WHITELIST.find((candidate) => candidate.file === name && tryBlock.includes(candidate.tryContains));
        if (entry && !WAREHOUSE_CALL.test(tryBlock)) {
          ok = true;
          reason = `whitelisted: ${entry.reason}`;
        }
      }
      sites.push({ file: name, line: line(file, node), kind: "clause", ok, reason, text: tryBlock.slice(0, 120) });
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "catch") {
      const [handler] = node.arguments;
      const receiver = node.expression.expression;
      let ok = false;
      let reason = "";
      if (handler && (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler))) {
        const param = handler.parameters[0];
        const variable = param && ts.isIdentifier(param.name) ? param.name.text : null;
        ok = rethrows(handler.body.getText(file), variable);
        reason = ok ? "rethrows" : "";
      }
      if (!ok && ts.isCallExpression(receiver) && ts.isIdentifier(receiver.expression) && POSTGRES_ONLY_RECEIVERS.includes(receiver.expression.text)) {
        const args = receiver.arguments.map((arg) => arg.getText(file));
        if (args.length && /(^|\.)supabase$/.test(args[0]) && !args.some((arg) => /clickhouse/i.test(arg))) {
          ok = true;
          reason = `postgres-only receiver ${receiver.expression.text}(${args[0]}, ...)`;
        }
      }
      sites.push({ file: name, line: line(file, node), kind: "promise", ok, reason, text: node.getText(file).slice(0, 120) });
    }
  });
  return sites;
}

describe("4. every swallowing catch in the runner modules rethrows ScopeViolation (R7)", () => {
  const sites = CATCH_LINT_FILES.flatMap(catchSites);

  it("finds the catch sites (non-vacuous)", () => {
    expect(sites.length).toBeGreaterThan(35);
    expect(sites.filter((site) => site.reason === "rethrows").length).toBeGreaterThan(25);
  });

  it("each site rethrows ScopeViolation or is a reasoned exception", () => {
    const offenders = sites.filter((site) => !site.ok).map((site) => `${site.file}:${site.line} [${site.kind}] ${site.text}`);
    expect(offenders).toEqual([]);
  });

  it("the Postgres-only receivers really take the Supabase client and never a ClickHouse reader", () => {
    const declarations = new Map<string, string>();
    for (const path of FUNCTION_FILES.filter((candidate) => candidate.startsWith(CLICKHOUSE_DIR))) {
      const file = parse(path);
      visit(file, (node) => {
        if (ts.isFunctionDeclaration(node) && node.name && POSTGRES_ONLY_RECEIVERS.includes(node.name.text)) {
          declarations.set(node.name.text, node.parameters.map((parameter) => parameter.getText(file)).join(", "));
        }
      });
    }
    for (const name of POSTGRES_ONLY_RECEIVERS) {
      const params = declarations.get(name);
      expect(params, `${name} declaration`).toBeDefined();
      expect(params, name).toMatch(/Supabase(Like|Auth)Client/);
      expect(params, name).not.toMatch(/ClickHouseClientLike/);
    }
  });

  it("every whitelist entry still matches a site (no stale exceptions)", () => {
    for (const entry of CATCH_CLAUSE_WHITELIST) {
      expect(sites.some((site) => site.file === entry.file && site.reason.includes(entry.reason)), `${entry.file}: ${entry.tryContains}`).toBe(true);
    }
  });
});

// =========================================================================================
// 5. folded migrations
// =========================================================================================

const NEW_MIGRATIONS = listMigrations().filter((name) => name >= "202610050001");

/** Functions created by the access-control migrations (schema.name). */
function newFunctionNames(): string[] {
  const names = new Set<string>();
  for (const migration of NEW_MIGRATIONS) {
    for (const match of readMigration(migration).matchAll(/create\s+(?:or\s+replace\s+)?function\s+([a-z_]+)\.([a-z_0-9]+)\s*\(/gi)) {
      names.add(`${match[1].toLowerCase()}.${match[2].toLowerCase()}`);
    }
  }
  return [...names].sort();
}

describe("5. folded migrations", () => {
  let folded: SeededWorkspace;

  beforeAll(async () => {
    folded = await createLockedWorkspace();
  }, 300_000);

  afterAll(async () => {
    await folded?.h.close();
  });

  it("applies every migration (sanity)", () => {
    expect(NEW_MIGRATIONS).toEqual(expect.arrayContaining([
      "202610050001_phase0_isolation_fixes.sql", "202610050002_access_core.sql", "202610050003_access_rls_lockdown.sql",
    ]));
  });

  it("every public table has row level security", async () => {
    const tables = await folded.h.db.query<{ relname: string; relrowsecurity: boolean }>(
      `select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r', 'p') order by 1`,
    );
    expect(tables.rows.length).toBeGreaterThan(40);
    expect(tables.rows.filter((row) => !row.relrowsecurity).map((row) => row.relname)).toEqual([]);
  });

  it("no view / materialized view / foreign table in public is browser-readable without security_invoker (they bypass RLS)", async () => {
    const leaky = await folded.h.db.query<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('v', 'm', 'f')
         and (has_table_privilege('anon', c.oid, 'SELECT') or has_table_privilege('authenticated', c.oid, 'SELECT'))
         and not (c.relkind = 'v' and coalesce(c.reloptions, '{}'::text[]) && array['security_invoker=true', 'security_invoker=on'])
       order by 1`,
    );
    expect(leaky.rows.map((row) => row.relname)).toEqual([]);
    // Both fail-closed blocks check it, so a dashboard-created view aborts the migrations.
    for (const migration of ["202610050002_access_core.sql", "202610050003_access_rls_lockdown.sql"]) {
      expect(readMigration(migration), migration).toMatch(/c\.relkind in \('v', 'm', 'f'\)/);
    }
  });

  it("the cross-tenant no-argument subscription RPC is not executable by the service role", async () => {
    const grants = await folded.h.db.query<{ service: boolean; scoped: boolean }>(
      `select has_function_privilege('service_role', 'public.active_funnelfox_subscription_emails()', 'execute') as service,
              has_function_privilege('service_role', 'public.active_funnelfox_subscription_emails(uuid)', 'execute') as scoped`,
    );
    expect(grants.rows[0]).toEqual({ service: false, scoped: true });
  });

  it("every SECURITY DEFINER function pins search_path", async () => {
    const definers = await folded.h.db.query<{ n: number }>(
      `select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where p.prosecdef and n.nspname in ('public', 'app')`,
    );
    expect(definers.rows[0].n).toBeGreaterThan(40);
    const unpinned = await folded.h.db.query<{ signature: string }>(
      `select p.oid::regprocedure::text as signature
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where p.prosecdef and n.nspname in ('public', 'app')
         and not exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) setting where setting like 'search_path=%')
       order by 1`,
    );
    expect(unpinned.rows.map((row) => row.signature)).toEqual([]);
  });

  it("no SECURITY DEFINER function is executable by anon", async () => {
    const exposed = await folded.h.db.query<{ signature: string }>(
      `select p.oid::regprocedure::text as signature
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where p.prosecdef and n.nspname in ('public', 'app') and has_function_privilege('anon', p.oid, 'execute')
       order by 1`,
    );
    expect(exposed.rows.map((row) => row.signature)).toEqual([]);
  });

  it("every function the access-control migrations create is revoked from anon (and PUBLIC)", async () => {
    const names = newFunctionNames();
    expect(names.length).toBeGreaterThan(40);
    const rows = await folded.h.db.query<{ name: string; signature: string; anon: boolean; public_acl: boolean }>(
      `select n.nspname || '.' || p.proname as name,
              p.oid::regprocedure::text as signature,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              coalesce(array_to_string(p.proacl, ',') ~ '(^|,)=X', true) as public_acl
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where (n.nspname || '.' || p.proname) = any($1::text[])
       order by 2`,
      [names],
    );
    const found = new Set(rows.rows.map((row) => row.name));
    for (const name of names) expect(found.has(name), `${name} exists in the folded schema`).toBe(true);
    expect(rows.rows.filter((row) => row.anon || row.public_acl).map((row) => row.signature)).toEqual([]);
  });

  it("every SECURITY DEFINER function in the access-control migrations declares set search_path in its header", () => {
    const offenders: string[] = [];
    for (const migration of NEW_MIGRATIONS) {
      const sql = readMigration(migration);
      for (const match of sql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+([a-z_.0-9]+)\s*\(([\s\S]*?)\bas\s+\$(\w*)\$/gi)) {
        const header = match[0];
        if (/security\s+definer/i.test(header) && !/set\s+search_path\s*=/i.test(header)) offenders.push(`${migration}: ${match[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no browser write path remains on access or state tables (grants and permissive write policies)", async () => {
    const tables = [
      "workspaces", "access_roles", "workspace_members", "member_scope_rules", "member_scope_values", "access_audit_log", "access_denial_counters",
      "clickhouse_transaction_sync_state", "clickhouse_validation_state", "clickhouse_cohort_snapshot_state",
      "funnelfox_leads_sync_state", "funnelfox_subscriptions_sync_state", "support_mail_sync_state", "support_classification_state",
      "fb_cron_config", "support_mail_cron_config",
    ];
    for (const table of tables) {
      const grants = await folded.h.db.query<{ authenticated: boolean; anon: boolean }>(
        `select has_table_privilege('authenticated', $1, 'INSERT, UPDATE, DELETE, TRUNCATE') as authenticated,
                has_table_privilege('anon', $1, 'INSERT, UPDATE, DELETE, TRUNCATE') as anon`,
        [`public.${table}`],
      );
      expect(grants.rows[0], table).toEqual({ authenticated: false, anon: false });
    }
    const policies = await folded.h.db.query<{ table: string; polname: string }>(
      `select c.relname as table, p.polname
       from pg_policy p join pg_class c on c.oid = p.polrelid
       where c.relname = any($1::text[]) and p.polpermissive and p.polcmd in ('a', 'w', 'd', '*')
         and (p.polroles = '{0}'::oid[] or 'authenticated'::regrole = any(p.polroles) or 'anon'::regrole = any(p.polroles))`,
      [tables],
    );
    expect(policies.rows).toEqual([]);
  });
});

// =========================================================================================
// 6. no "unavailable" in access errors
// =========================================================================================

describe("6. access error codes and messages never say 'unavailable'", () => {
  const BANNED = /unavailable/i;

  it("the gate vocabulary (codes, messages) and the auth-session failures", async () => {
    const auth = [
      await verifyEdgeBearerSession({ authorization: null, getUser: async () => ({ data: { user: null } }) }),
      await verifyEdgeBearerSession({ authorization: "Bearer x", getUser: async () => ({ data: { user: null }, error: { status: 401 } }) }),
      await verifyEdgeBearerSession({ authorization: "Bearer x", getUser: async () => { throw new Error("down"); } }),
    ].map((decision) => JSON.stringify(decision));
    for (const text of [...Object.values(ACCESS_ERROR), ...Object.values(ACCESS_ERROR_MESSAGES), ...auth]) {
      expect(text, text).not.toMatch(BANNED);
      expect(isWarehouseDownError(text), text).toBe(false);
    }
  });

  it("the access admin API error bodies and the report 404", () => {
    const bodies = [
      ...(["invalid", "permission_denied", "escalation_denied", "not_found", "conflict"] as const).map((code) => accessAdminOnError(new AccessAdminError(code)).body),
      accessAdminOnError(new AccessAdminStoreError("store down")).body,
      accessAdminOnError(new Error("boom")).body,
      { error_code: REPORT_NOT_FOUND, error: "Report not found." },
    ];
    for (const body of bodies) {
      expect(JSON.stringify(body)).not.toMatch(BANNED);
      expect(isWarehouseDownError(String(body.error ?? "")), JSON.stringify(body)).toBe(false);
    }
  });

  it("no string literal under _shared/access/** contains it", () => {
    const offenders: string[] = [];
    for (const path of FUNCTION_FILES.filter((candidate) => candidate.startsWith(ACCESS_DIR))) {
      const file = parse(path);
      visit(file, (node) => {
        if ((ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) && BANNED.test(node.text)) {
          offenders.push(`${rel(path)}:${line(file, node)} ${node.text}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it("no SQL error the access migrations raise contains it", () => {
    const offenders: string[] = [];
    for (const migration of NEW_MIGRATIONS) {
      const sql = readMigration(migration);
      for (const match of sql.matchAll(/(?:app\.deny\(\s*'[a-z_]+'\s*,\s*'([^']*)'|raise\s+exception\s+'([^']*)'|message\s*=\s*'([^']*)')/gi)) {
        const message = match[1] ?? match[2] ?? match[3] ?? "";
        if (BANNED.test(message)) offenders.push(`${migration}: ${message}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

// =========================================================================================
// the lints are not vacuous: each one flags a known-bad snippet
// =========================================================================================

describe("the lints catch known-bad code (self-test)", () => {
  const source = (name: string, text: string) => ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  it("transport imports outside scopedClient.ts", () => {
    const fakePath = resolve(FUNCTIONS_DIR, "rogue-fn", "index.ts");
    const refs = moduleReferences(source(fakePath, [
      'import { createClickHouseClient } from "../_shared/clickhouse/client.ts";',
      'export * from "../_shared/clickhouse/client.ts";',
      'const lazy = await import("../_shared/clickhouse/client.ts");',
    ].join("\n"))).filter((ref) => resolvesTo(fakePath, ref.specifier, CLIENT_TS));
    expect(refs.map((ref) => ref.names)).toEqual([["createClickHouseClient"], "*", "*"]);
  });

  it("tenant reads from the request", () => {
    const offenders = requestTenantReads("rogue.ts", source("rogue.ts", [
      "serveWithAccess(P, async ({ body, url }) => {",
      "  const a = body.auth_user_id;",
      '  const b = body["tenant_key"];',
      "  const { auth_user_id } = body as Record<string, string>;",
      '  const c = url.searchParams.get("auth_user_id");',
      "  const request = body; const d = request.authUserId;",
      "  const ok = input.authUserId;",
      "});",
    ].join("\n")));
    expect(offenders).toHaveLength(5);
    expect(offenders.join("\n")).not.toContain("input.authUserId");
  });

  it("tenant placeholders other than {auth_user_id:String}", () => {
    const { offenders, predicates } = tenantPlaceholderOffenders("rogue.ts", [
      "`SELECT 1 FROM fact_x WHERE auth_user_id = {auth_user_id:String}`",
      "`SELECT 1 FROM fact_x WHERE auth_user_id = {uid:String}`",
      "`SELECT 1 FROM fact_x WHERE auth_user_id = '${callerId}'`",
      "`SELECT 1 FROM fact_x WHERE auth_user_id = '11111111-1111-4111-8111-111111111111'`",
    ].join("\n"));
    expect(predicates).toBe(2);
    expect(offenders).toHaveLength(3);
  });

  it("tenant-table queries without the owner predicate", () => {
    const { offenders, checked } = unfilteredTenantQueries("rogue.ts", source("rogue.ts", [
      "async function a(supabase, key) { return supabase.from('transactions').select('*').limit(10); }",
      "async function b(supabase, key) { return supabase.from('transactions').select('*').eq('auth_user_id', key); }",
      "async function c(supabase, key) { const builder = supabase.from('support_requests') as any; return builder.delete().eq('auth_user_id', key); }",
      "async function d(supabase, key) { return supabase.from('reports').select('id').eq('id', key).maybeSingle(); }",
      "async function e(supabase, rows) { return supabase.from('transactions').insert(rows); }",
      "function f(list) { return Array.from(list); }",
      "async function g(supabase, key) { return supabase.from('facebook_sync_runs').select('*').or(`auth_user_id.eq.${key}`); }",
    ].join("\n")), tenantOwnerColumns());
    expect(checked).toBe(5);
    expect(offenders.map((offender) => offender.split(" ")[1])).toEqual(["transactions:", "reports:", "facebook_sync_runs:"]);
  });

  it("AccessContext mutations", () => {
    const offenders = contextMutations("rogue.ts", source("rogue.ts", [
      "handler(async ({ ctx, body }) => {",
      "  ctx.tenantKey = String(body.x);",
      "  ctx.scope.funnel = { mode: 'all' };",
      "  ctx.violations.length = 0;",
      "  ctx.violations.splice(0);",
      "  (ctx.permissions as Set<string>).add('admin.users.manage');",
      "  ctx.permissions.add('admin.users.manage');",
      "  delete ctx.role;",
      "  ctx.violations.push('fine');",
      "  const copy = { ...ctx, tenantKey: 'x' };",
      "});",
    ].join("\n")));
    expect(offenders).toHaveLength(7);
    expect(offenders.join("\n")).not.toContain("push('fine')");
  });

  it("swallowing catches", () => {
    const sites = catchSitesOf("rogue.ts", source("rogue.ts", [
      "async function a(client) { return client.query({ query: 'SELECT 1' }).catch(() => []); }",
      "async function b(client) { try { await client.query({ query: 'SELECT 1' }); } catch (error) { return null; } }",
      "async function c(client) { return client.query({ query: 'SELECT 1' }).catch((error) => { if (error instanceof ScopeViolation) throw error; return []; }); }",
      "async function d(client) { try { await client.query({ query: 'SELECT 1' }); } catch (error) { await log(error); throw error; } }",
      "async function e(supabase) { return getFbSyncState(supabase, key).catch(() => null); }",
      "async function f(client) { return getFbSyncState(client, key).catch(() => null); }",
    ].join("\n")));
    expect(sites.map((site) => site.ok)).toEqual([false, false, true, true, true, false]);
  });
});
