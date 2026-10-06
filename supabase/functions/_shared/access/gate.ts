// The Edge access gate (plan §10 requireAccess, §13 layer 1, §27 fail-closed
// rules). Every Edge function is meant to be ONE call:
//
//   serveWithAccess(POLICY, async ({ ctx, action, body, clickhouse, pg }) => ...)
//
// where POLICY is a pure dispatch table: canonical action → permissions,
// rawOnly/ownerOnly/fullScopeOnly, scopeReady. This module is the pure,
// dependency-injected core (vitest drives it with fakes); SH/http.ts wires the
// live Supabase/ClickHouse dependencies and calls Deno.serve.
//
// Order of operations — each step fails closed and none is skippable:
//   1. OPTIONS → 204 (CORS); method not in policy.methods → 405.
//   2a. Cron (policy.cron and its header present): the secret is compared in
//       constant time BEFORE the body is read; the tenant comes from
//       workspace_data_key(), never from the request (R14) — a body
//       auth_user_id may only repeat it; only policy.cron.actions are callable.
//   2b. User: bearer → getUser. A bad token is 401 invalid_session; an auth
//       service fault is 503 auth_service_error (never 401 — a GoTrue blip
//       must not sign everyone out). The body is parsed only AFTER this.
//       resolve_access(sub) is STARTED alongside getUser (§10 step 2: in
//       parallel) from the token's unverified `sub`; its row is used only if
//       the verified user id is the same, else resolve_access runs again for
//       the verified id. Nothing is read from that row before step 4.
//   3. normalizeAction → 400 unknown_action; no policy entry → 403 (R3).
//   4. resolve_access(user) → 503 on any fault or a missing workspace (R2),
//      403 no_membership / membership_disabled (R1).
//   5. authorizeAction: permissions, rawOnly, ownerOnly, fullScopeOnly, and
//      restricted ∧ ¬scopeReady → 403 scope_not_supported (R6); restricted ∧
//      restrictedAnyOf unmet → 403 scope_not_supported.
//   5b. Scope handle (Phase 2, spec §3.5): scope all (and cron) → ALL_SCOPE_SQL
//      with no I/O. Restricted on a scopeSnapshot action → the cohort snapshot
//      state is loaded (a fault → 503) and must be fresh and validated, else
//      409 scope_snapshot_not_ready; restricted otherwise → a restricted handle
//      without a snapshot. The handler gets it as `scope`.
//   6. handler. ScopeForbiddenError → 403 with its code, ScopeSnapshotNotReadyError
//      → 409 (before onError, never sanitized further). Other thrown errors are
//      mapped (onError) or 502; for anyone but the data owner (and the cron,
//      which holds the secret and whose body only lands in net._http_response)
//      the body is replaced by a generic { error_code, request_id } so warehouse
//      messages never reach employees.
//   7. Any recorded scope violation → 500 scope_violation, whatever the handler
//      returned or swallowed (R7).
// Audit (§24, best effort, never changes a response): a 403 for an
// authenticated user is counted (access_record_denial, deduplicated per day);
// a `write` action run by a member who is not the data owner writes one
// sync.triggered / warehouse.admin row (access_write_audit). The `access`
// function's own writes are audited in SQL, the data owner's are not audited,
// so their behaviour is unchanged.
// Every response carries x-build-id and x-request-id (exposed via CORS).

import type { ClickHouseClientLike, SupabaseAuthClient } from "../clickhouse/types.ts";
import { extractBearerToken, unverifiedBearerSubject, verifyEdgeBearerSession, type GetUserResult } from "../clickhouse/auth.ts";
import { ACCESS_ERROR, ACCESS_ERROR_MESSAGES, ActionNormalizeError, accessDenial, type AccessDenial } from "./errors.ts";
import {
  authorizeAction,
  buildAccessContext,
  buildCronAccessContext,
  isUuid,
  parseResolveAccessRow,
  type AccessContext,
  type ActionPolicy,
} from "./accessContext.ts";
import { timingSafeEqual } from "./timingSafe.ts";
import { BUILD_ID } from "./buildId.ts";
import { buildCorsHeaders, EXPOSED_RESPONSE_HEADERS } from "./cors.ts";
import {
  ALL_SCOPE_SQL,
  createRestrictedScopeSql,
  ScopeForbiddenError,
  ScopeSnapshotNotReadyError,
  type ScopeSql,
} from "../clickhouse/scopeSql.ts";
import {
  restrictedSnapshotReadiness,
  SCOPE_SNAPSHOT_MAX_STALENESS_HOURS_DEFAULT,
  type CohortSnapshotState,
} from "../clickhouse/cohortSnapshotState.ts";

export type { AccessContext, ActionPolicy, ScopeSql };
export { ActionNormalizeError };

export interface NormalizeActionInput {
  method: string;
  body: Record<string, unknown>;
  url: URL;
  /** True on the cron branch (lets a policy map a body-less cron tick to its action). */
  cron?: boolean;
}

export interface FunctionPolicy<A extends string> {
  fn: string;
  /** Default ["POST"]. OPTIONS is always answered. */
  methods?: string[];
  /** Throw ActionNormalizeError (or anything) → 400 unknown_action. */
  normalizeAction(input: NormalizeActionInput): A;
  actions: Record<A, ActionPolicy>;
  cron?: { header: string; secretEnv: string; actions: A[] };
  /** Do not read the request body (the handler reads `req` itself, e.g. uploads). */
  bodyless?: boolean;
}

export interface AccessRequest<A extends string> {
  ctx: AccessContext;
  action: A;
  body: Record<string, unknown>;
  url: URL;
  req: Request;
  /** Service-role client (bypasses RLS — scope every read by ctx). */
  pg: SupabaseAuthClient;
  /** Lazily created ScopedReader bound to ctx. */
  clickhouse(): ClickHouseClientLike;
  /** Scope-SQL handle for this request: ALL_SCOPE_SQL unless ctx.restricted. */
  scope: ScopeSql;
}

export type AccessHandler<A extends string> = (request: AccessRequest<A>) => Promise<Response | unknown>;

export interface ServeWithAccessOptions {
  /** Map a thrown error to a status/body (e.g. a request-validation error → 400).
   * Return null to fall back to 502. Non-data-owner bodies are still sanitized. */
  onError?: (error: unknown, ctx: AccessContext) => { status: number; body: Record<string, unknown> } | null;
}

export interface RpcResult {
  data: unknown;
  error: unknown;
}

export type GateLogLevel = "info" | "warn" | "error";

/** One access_write_audit row written by the gate (§24 v1 events). */
export interface GateAuditEntry {
  event: "sync.triggered" | "warehouse.admin";
  actorKind: "user" | "api_key";
  actorUserId: string;
  fn: string;
  action: string;
  outcome: "success" | "error";
  status: number;
  errorCode: string | null;
  requestId: string;
}

/** One access_record_denial call (deduplicated per day in SQL). */
export interface GateDenialEntry {
  actorUserId: string;
  fn: string;
  action: string | null;
  errorCode: string;
  requestId: string;
}

/** Upper bound for a best-effort audit write: a slow audit never holds a response. */
export const GATE_AUDIT_TIMEOUT_MS = 1_500;

export interface AccessGateDeps {
  /** Set when the live environment is missing Supabase config → 503 server_not_configured. */
  configError?: string | null;
  pg: SupabaseAuthClient | null;
  getUser(token: string): Promise<GetUserResult>;
  /** public.resolve_access(p_user_id) */
  loadAccess(userId: string): Promise<RpcResult>;
  /** public.workspace_data_key() */
  workspaceDataKey(): Promise<RpcResult>;
  readEnv(name: string): string | undefined;
  /** Builds the ScopedReader for a context (called at most once per request). */
  createClickHouse(ctx: AccessContext): ClickHouseClientLike;
  newRequestId?(): string;
  log?(level: GateLogLevel, event: string, details: Record<string, unknown>): void;
  /** public.access_write_audit (best effort; omitted ⇒ not audited). */
  writeAudit?(entry: GateAuditEntry): Promise<unknown>;
  /** public.access_record_denial (best effort; omitted ⇒ not counted). */
  recordDenial?(entry: GateDenialEntry): Promise<unknown>;
  /** public.clickhouse_cohort_snapshot_state of the tenant (restricted
   * scopeSnapshot actions only; omitted ⇒ those requests are 503). */
  loadCohortSnapshotState?(tenantKey: string): Promise<CohortSnapshotState | null>;
  /** Clock of the freshness check (tests); default new Date(). */
  now?(): Date;
}

/** The §24 event a write action is audited under: warehouse administration
 * (anything gated on admin.warehouse.manage) or a sync trigger. */
export function auditEventFor(actionPolicy: ActionPolicy): GateAuditEntry["event"] {
  const keys = [...(actionPolicy.allOf ?? []), ...(actionPolicy.anyOf ?? [])];
  return keys.includes("admin.warehouse.manage") ? "warehouse.admin" : "sync.triggered";
}

/** public.access_write_audit parameters of a gate audit entry: ids and codes
 * only (no request body, no secrets, no emails — §24). */
export function auditRpcParams(entry: GateAuditEntry): Record<string, unknown> {
  return {
    p_event: entry.event,
    p_actor_kind: entry.actorKind,
    p_actor_user_id: entry.actorUserId,
    p_target_type: "edge_function",
    p_target_id: `${entry.fn}:${entry.action}`,
    p_outcome: entry.outcome,
    p_reason_code: entry.errorCode,
    p_before: null,
    p_after: null,
    p_context: { request_id: entry.requestId, fn: entry.fn, action: entry.action, status: entry.status },
  };
}

/** public.access_record_denial parameters of a gate denial. */
export function denialRpcParams(entry: GateDenialEntry): Record<string, unknown> {
  return {
    p_actor_user_id: entry.actorUserId,
    p_fn: entry.fn,
    p_action: entry.action,
    p_error_code: entry.errorCode,
    p_request_id: entry.requestId,
  };
}

/** Functions whose writes are audited elsewhere (the access admin RPCs write
 * their own member.* / role.* rows in the same SQL transaction). */
const SELF_AUDITED_FUNCTIONS: ReadonlySet<string> = new Set(["access"]);

/** Runs a best-effort side write: bounded, never throws, failures only logged. */
async function bestEffort(
  work: (() => Promise<unknown>) | null,
  log: (level: GateLogLevel, event: string, details: Record<string, unknown>) => void,
  event: string,
  details: Record<string, unknown>,
): Promise<void> {
  if (!work) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      Promise.resolve().then(work),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${GATE_AUDIT_TIMEOUT_MS} ms`)), GATE_AUDIT_TIMEOUT_MS);
      }),
    ]);
    const failure = isRecord(result) ? result.error : null;
    if (failure) {
      const message = isRecord(failure) && typeof failure.message === "string" ? failure.message : errorMessage(failure);
      log("warn", event, { ...details, error: message });
    }
  } catch (error) {
    log("warn", event, { ...details, error: errorMessage(error) });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ---- policy validation ------------------------------------------------------------

function ownsAction<A extends string>(policy: FunctionPolicy<A>, action: string): action is A {
  return Object.prototype.hasOwnProperty.call(policy.actions, action);
}

function allowedMethods(policy: FunctionPolicy<string>): string[] {
  const methods = (policy.methods?.length ? policy.methods : ["POST"]).map((method) => method.toUpperCase());
  return [...new Set(methods)];
}

/** Boot-time sanity check (serveWithAccess calls it at module load, so a broken
 * policy fails the deploy smoke test instead of a request). */
export function assertValidPolicy<A extends string>(policy: FunctionPolicy<A>): void {
  if (!policy || typeof policy.fn !== "string" || !policy.fn.trim()) throw new Error("FunctionPolicy.fn is required.");
  if (typeof policy.normalizeAction !== "function") throw new Error(`${policy.fn}: normalizeAction is required.`);
  const actions = Object.keys(policy.actions ?? {});
  if (!actions.length) throw new Error(`${policy.fn}: at least one action policy is required.`);
  if (policy.methods && !policy.methods.length) throw new Error(`${policy.fn}: methods must not be empty.`);
  for (const action of actions) {
    const entry = (policy.actions as Record<string, ActionPolicy>)[action];
    if (entry?.scopeSnapshot !== undefined) {
      if (entry.scopeSnapshot !== "cohort" && entry.scopeSnapshot !== "campaign") {
        throw new Error(`${policy.fn}: action "${action}" has an unknown scopeSnapshot.`);
      }
      if (entry.scopeReady !== true) throw new Error(`${policy.fn}: action "${action}" sets scopeSnapshot without scopeReady.`);
    }
    if (entry?.restrictedAnyOf !== undefined) {
      if (!Array.isArray(entry.restrictedAnyOf) || entry.restrictedAnyOf.some((key) => typeof key !== "string" || !key)) {
        throw new Error(`${policy.fn}: action "${action}" has a malformed restrictedAnyOf.`);
      }
    }
  }
  if (policy.cron) {
    if (!policy.cron.header?.trim() || !policy.cron.secretEnv?.trim()) throw new Error(`${policy.fn}: cron.header and cron.secretEnv are required.`);
    for (const action of policy.cron.actions ?? []) {
      if (!ownsAction(policy, action)) throw new Error(`${policy.fn}: cron action "${action}" has no action policy.`);
    }
  }
}

// ---- responses ----------------------------------------------------------------------

function gateHeaders(requestId: string, methods: readonly string[], extra: Record<string, string> = {}): Record<string, string> {
  return { ...buildCorsHeaders({ methods }), "x-build-id": BUILD_ID, "x-request-id": requestId, ...extra };
}

function gateJson(body: unknown, status: number, requestId: string, methods: readonly string[], extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body ?? null), {
    status,
    headers: gateHeaders(requestId, methods, { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra }),
  });
}

/** Stamps a handler-built Response: CORS (without clobbering what the handler set),
 * the exposed-header list merged, and the build / request ids always ours. */
function withGateHeaders(response: Response, requestId: string, methods: readonly string[]): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(buildCorsHeaders({ methods }))) {
    if (name === "Access-Control-Expose-Headers") {
      const existing = (headers.get(name) ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
      headers.set(name, [...new Set([...existing, ...EXPOSED_RESPONSE_HEADERS])].join(", "));
    } else if (!headers.has(name)) {
      headers.set(name, value);
    }
  }
  headers.set("x-build-id", BUILD_ID);
  headers.set("x-request-id", requestId);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Request failed.";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function defaultLog(level: GateLogLevel, event: string, details: Record<string, unknown>): void {
  const line = JSON.stringify({ event, ...details });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}

async function readJsonBody(req: Request, method: string, bodyless: boolean): Promise<Record<string, unknown> | null> {
  if (bodyless || method === "GET" || method === "HEAD") return {};
  let text: string;
  try {
    text = await req.text();
  } catch {
    return null;
  }
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const sameId = (a: unknown, b: unknown) => typeof a === "string" && typeof b === "string" && a.length > 0 && a.toLowerCase() === b.toLowerCase();

// ---- the gate ---------------------------------------------------------------------------

export async function handleWithAccess<A extends string>(
  req: Request,
  policy: FunctionPolicy<A>,
  handler: AccessHandler<A>,
  deps: AccessGateDeps,
  options: ServeWithAccessOptions = {},
): Promise<Response> {
  const requestId = deps.newRequestId?.() ?? crypto.randomUUID();
  const log = deps.log ?? defaultLog;
  const methods = allowedMethods(policy as FunctionPolicy<string>);
  const method = req.method.toUpperCase();
  const respond = (body: unknown, status: number, extra?: Record<string, string>) => gateJson(body, status, requestId, methods, extra);
  const deny = async (denial: AccessDenial, details: Record<string, unknown> = {}, extra?: Record<string, string>): Promise<Response> => {
    log(denial.status >= 500 ? "error" : "warn", "access_denied", {
      fn: policy.fn,
      request_id: requestId,
      status: denial.status,
      error_code: denial.error_code,
      ...details,
    });
    // §24 "denials, deduped into counters": only a refusal of an AUTHENTICATED
    // user (403) is counted — never an anonymous 401 (no amplification) or a 5xx.
    const actorUserId = typeof details.user_id === "string" ? details.user_id : null;
    if (denial.status === 403 && actorUserId && deps.recordDenial) {
      const entry: GateDenialEntry = {
        actorUserId,
        fn: policy.fn,
        action: typeof details.action === "string" ? details.action : null,
        errorCode: denial.error_code,
        requestId,
      };
      await bestEffort(() => deps.recordDenial!(entry), log, "access_denial_not_recorded", { fn: policy.fn, request_id: requestId });
    }
    return respond({ ok: false, error_code: denial.error_code, error: denial.error }, denial.status, extra);
  };

  if (method === "OPTIONS") return new Response(null, { status: 204, headers: gateHeaders(requestId, methods) });
  if (!methods.includes(method)) return deny(accessDenial(405, ACCESS_ERROR.METHOD_NOT_ALLOWED), { method }, { Allow: methods.join(", ") });
  if (deps.configError || !deps.pg) return deny(accessDenial(503, ACCESS_ERROR.SERVER_NOT_CONFIGURED), { reason: deps.configError ?? "pg client missing" });

  const url = new URL(req.url);

  const normalize = (body: Record<string, unknown>, cron: boolean): A | null => {
    try {
      const action = policy.normalizeAction({ method, body, url, cron });
      return typeof action === "string" && action ? action : null;
    } catch {
      return null;
    }
  };

  /** Step 5b: the request's ScopeSql handle, or the denial that replaces the
   * handler (503 when the snapshot state cannot be read, 409 when it is not
   * fresh / validated). Scope all and cron never do I/O here. */
  const scopeFor = async (ctx: AccessContext, action: A): Promise<{ scope: ScopeSql } | { denial: Response }> => {
    if (!ctx.restricted || ctx.actor.kind === "cron") return { scope: ALL_SCOPE_SQL };
    const needs = policy.actions[action]?.scopeSnapshot;
    if (!needs) return { scope: createRestrictedScopeSql(ctx, null) };
    const details = { user_id: ctx.actor.userId, member_id: ctx.actor.memberId, action, restricted: true };
    if (!deps.loadCohortSnapshotState) {
      return { denial: await deny(accessDenial(503, ACCESS_ERROR.ACCESS_SERVICE_ERROR), { ...details, reason: "snapshot state loader missing" }) };
    }
    let state: CohortSnapshotState | null;
    try {
      const loaded = await deps.loadCohortSnapshotState(ctx.tenantKey);
      if (isRecord(loaded) && "error" in loaded && loaded.error) throw new Error(errorMessage(loaded.error));
      state = (loaded ?? null) as CohortSnapshotState | null;
    } catch (error) {
      return { denial: await deny(accessDenial(503, ACCESS_ERROR.ACCESS_SERVICE_ERROR), { ...details, reason: `snapshot state: ${errorMessage(error)}` }) };
    }
    const hours = Number(deps.readEnv("SCOPE_SNAPSHOT_MAX_STALENESS_HOURS") ?? SCOPE_SNAPSHOT_MAX_STALENESS_HOURS_DEFAULT);
    const maxStalenessMs = (Number.isFinite(hours) && hours > 0 ? hours : SCOPE_SNAPSHOT_MAX_STALENESS_HOURS_DEFAULT) * 3_600_000;
    const readiness = restrictedSnapshotReadiness(state, { now: deps.now?.() ?? new Date(), maxStalenessMs, needsCampaignScope: needs === "campaign" });
    // `=== false` narrows under the app tsconfig too (no strictNullChecks).
    if (readiness.ok === false) {
      // The reason is logged, never returned (it would describe the warehouse).
      return { denial: await deny(accessDenial(409, ACCESS_ERROR.SCOPE_SNAPSHOT_NOT_READY), { ...details, reason: readiness.reason }) };
    }
    return { scope: createRestrictedScopeSql(ctx, readiness.snapshot) };
  };

  const run = async (ctx: AccessContext, action: A, body: Record<string, unknown>): Promise<Response> => {
    const scoped = await scopeFor(ctx, action);
    if ("denial" in scoped) return scoped.denial;
    const scope = scoped.scope;
    let reader: ClickHouseClientLike | null = null;
    const clickhouse = () => (reader ??= deps.createClickHouse(ctx));
    let response: Response;
    try {
      const result = await handler({ ctx, action, body, url, req, pg: deps.pg as SupabaseAuthClient, clickhouse, scope });
      response = result instanceof Response ? withGateHeaders(result, requestId, methods) : respond(result ?? null, 200);
    } catch (error) {
      // A ScopeViolation is recorded by the reader before it throws; record it
      // here too in case it came from a reader built for another context.
      if (error instanceof Error && error.name === "ScopeViolation" && !ctx.violations.length) ctx.violations.push(error.message);
      response = handlerErrorResponse(error, ctx, action);
    } finally {
      const opened = reader as ClickHouseClientLike | null;
      if (opened?.close) {
        try {
          await opened.close();
        } catch {
          // closing is best-effort; the transport holds no state worth failing on
        }
      }
    }
    if (ctx.violations.length) {
      log("error", "scope_violation", { fn: policy.fn, request_id: requestId, action, actor_kind: ctx.actor.kind, user_id: ctx.actor.userId, violations: ctx.violations });
      response = respond({ ok: false, error_code: ACCESS_ERROR.SCOPE_VIOLATION, error: ACCESS_ERROR_MESSAGES.scope_violation, request_id: requestId }, 500);
    }
    await auditWrite(ctx, action, response);
    return response;
  };

  // §24 sync.triggered / warehouse.admin: a write action run by a member who is
  // not the data owner. The response is already final; this never changes it.
  const auditWrite = async (ctx: AccessContext, action: A, response: Response): Promise<void> => {
    const actionPolicy = policy.actions[action];
    if (!deps.writeAudit || !actionPolicy?.write || SELF_AUDITED_FUNCTIONS.has(policy.fn)) return;
    if (ctx.rawAccess || (ctx.actor.kind !== "user" && ctx.actor.kind !== "api_key") || !ctx.actor.userId) return;
    const entry: GateAuditEntry = {
      event: auditEventFor(actionPolicy),
      actorKind: ctx.actor.kind,
      actorUserId: ctx.actor.userId,
      fn: policy.fn,
      action,
      outcome: response.status < 400 ? "success" : "error",
      status: response.status,
      errorCode: response.status < 400 ? null : ctx.violations.length ? ACCESS_ERROR.SCOPE_VIOLATION : `http_${response.status}`,
      requestId,
    };
    await bestEffort(() => deps.writeAudit!(entry), log, "access_audit_not_written", { fn: policy.fn, request_id: requestId, action });
  };

  const handlerErrorResponse = (error: unknown, ctx: AccessContext, action: A): Response => {
    // Scope refusals raised by the scopeSql.ts helpers inside the handler: fixed
    // coded bodies, mapped before onError and exempt from the generic rewrite.
    if (error instanceof ScopeForbiddenError) {
      log("warn", "access_denied", { fn: policy.fn, request_id: requestId, status: 403, error_code: error.code, user_id: ctx.actor.userId, action, restricted: ctx.restricted });
      return respond({ ok: false, error_code: error.code, error: ACCESS_ERROR_MESSAGES[error.code], request_id: requestId }, 403);
    }
    if (error instanceof ScopeSnapshotNotReadyError) {
      log("warn", "access_denied", { fn: policy.fn, request_id: requestId, status: 409, error_code: ACCESS_ERROR.SCOPE_SNAPSHOT_NOT_READY, user_id: ctx.actor.userId, action, reason: error.reason });
      return respond({ ok: false, error_code: ACCESS_ERROR.SCOPE_SNAPSHOT_NOT_READY, error: ACCESS_ERROR_MESSAGES.scope_snapshot_not_ready, request_id: requestId }, 409);
    }
    let status = 502;
    let body: Record<string, unknown> = { ok: false, source: "clickhouse", error: errorMessage(error), request_id: requestId };
    let mapped: { status: number; body: Record<string, unknown> } | null = null;
    try {
      mapped = options.onError?.(error, ctx) ?? null;
    } catch {
      mapped = null;
    }
    if (mapped && Number.isInteger(mapped.status) && mapped.status >= 400 && mapped.status <= 599) {
      status = mapped.status;
      body = isRecord(mapped.body) ? { ...mapped.body } : { ok: false };
      if (body.request_id === undefined) body.request_id = requestId;
    }
    log("error", "handler_failed", { fn: policy.fn, request_id: requestId, action, status, actor_kind: ctx.actor.kind, error: errorMessage(error) });
    // Generic body for every employee. The data owner keeps today's detailed
    // body, and so does the cron: it proved the shared secret, and its body only
    // lands in net._http_response, the owner's existing way to see why a tick
    // failed.
    if (!ctx.rawAccess && ctx.actor.kind !== "cron") {
      const mappedCode = typeof body.error_code === "string" && body.error_code ? body.error_code : null;
      body = {
        ok: false,
        error_code: mappedCode ?? (status >= 500 ? ACCESS_ERROR.UPSTREAM_ERROR : ACCESS_ERROR.REQUEST_FAILED),
        error: ACCESS_ERROR_MESSAGES.request_failed,
        request_id: requestId,
      };
    }
    return respond(body, status);
  };

  // ---- cron branch (header present) — secret first, body after ----------------------
  if (policy.cron && req.headers.has(policy.cron.header)) {
    const cron = policy.cron;
    const secret = (deps.readEnv(cron.secretEnv) ?? "").trim();
    if (!secret) return deny(accessDenial(503, ACCESS_ERROR.CRON_NOT_CONFIGURED), { actor_kind: "cron" });
    const provided = (req.headers.get(cron.header) ?? "").trim();
    if (!timingSafeEqual(provided, secret)) return deny(accessDenial(401, ACCESS_ERROR.INVALID_CRON_SECRET), { actor_kind: "cron" });

    let keyResult: RpcResult;
    try {
      keyResult = await deps.workspaceDataKey();
    } catch (error) {
      return deny(accessDenial(503, ACCESS_ERROR.ACCESS_SERVICE_ERROR), { actor_kind: "cron", reason: errorMessage(error) });
    }
    if (keyResult?.error) return deny(accessDenial(503, ACCESS_ERROR.ACCESS_SERVICE_ERROR), { actor_kind: "cron", reason: "workspace_data_key failed" });
    const tenantKey = keyResult?.data;
    if (tenantKey === null || tenantKey === undefined || tenantKey === "") {
      return deny(accessDenial(503, ACCESS_ERROR.WORKSPACE_NOT_BOOTSTRAPPED), { actor_kind: "cron" });
    }
    if (!isUuid(tenantKey)) return deny(accessDenial(503, ACCESS_ERROR.ACCESS_SERVICE_ERROR), { actor_kind: "cron", reason: "malformed data key" });

    const body = await readJsonBody(req, method, Boolean(policy.bodyless));
    if (!body) return deny(accessDenial(400, ACCESS_ERROR.INVALID_BODY), { actor_kind: "cron" });
    if (body.auth_user_id !== undefined && body.auth_user_id !== null && !sameId(String(body.auth_user_id).trim(), tenantKey)) {
      return deny(accessDenial(400, ACCESS_ERROR.TENANT_MISMATCH), { actor_kind: "cron" });
    }
    const action = normalize(body, true);
    if (!action) return deny(accessDenial(400, ACCESS_ERROR.UNKNOWN_ACTION), { actor_kind: "cron" });
    if (!(cron.actions ?? []).includes(action)) return deny(accessDenial(403, ACCESS_ERROR.CRON_ACTION_NOT_ALLOWED), { actor_kind: "cron", action });
    if (!ownsAction(policy, action)) return deny(accessDenial(403, ACCESS_ERROR.POLICY_MISSING), { actor_kind: "cron", action });

    // The policy's cron.actions list IS the cron authorization: the context holds
    // every enforced permission with scope all, but no Owner role and no raw
    // access, so per-action checks would only reject what the policy author
    // explicitly allowed for the scheduler.
    return run(buildCronAccessContext({ tenantKey, requestId }), action, body);
  }

  // ---- user branch: authenticate before reading the body ----------------------------
  // resolve_access starts now for the token's UNVERIFIED subject, in parallel
  // with getUser (§10 step 2). Its row is only a prefetch: it is used below only
  // when getUser verified that same user, and nothing reads it before then.
  type AccessLoad = { ok: true; result: RpcResult } | { ok: false; error: unknown };
  const startLoad = (userId: string): Promise<AccessLoad> =>
    Promise.resolve()
      .then(() => deps.loadAccess(userId))
      .then((result): AccessLoad => ({ ok: true, result }), (error): AccessLoad => ({ ok: false, error }));
  const claimedUserId = unverifiedBearerSubject(extractBearerToken(req.headers.get("Authorization")));
  const prefetched = claimedUserId ? startLoad(claimedUserId) : null;

  const session = await verifyEdgeBearerSession({ authorization: req.headers.get("Authorization"), getUser: deps.getUser });
  if ("status" in session) {
    return session.status === 401
      ? deny(accessDenial(401, ACCESS_ERROR.INVALID_SESSION))
      : deny(accessDenial(503, ACCESS_ERROR.AUTH_SERVICE_ERROR));
  }

  const body = await readJsonBody(req, method, Boolean(policy.bodyless));
  if (!body) return deny(accessDenial(400, ACCESS_ERROR.INVALID_BODY), { user_id: session.id });
  const action = normalize(body, false);
  if (!action) return deny(accessDenial(400, ACCESS_ERROR.UNKNOWN_ACTION), { user_id: session.id });
  if (!ownsAction(policy, action)) return deny(accessDenial(403, ACCESS_ERROR.POLICY_MISSING), { user_id: session.id, action });

  const load = prefetched && sameId(claimedUserId, session.id) ? await prefetched : await startLoad(session.id);
  // `=== false` (not `!load.ok`) so the union narrows under the app tsconfig
  // too, which runs without strictNullChecks.
  if (load.ok === false) {
    return deny(accessDenial(503, ACCESS_ERROR.ACCESS_SERVICE_ERROR), { user_id: session.id, reason: errorMessage(load.error) });
  }
  const resolved = load.result;
  if (!resolved || resolved.error) return deny(accessDenial(503, ACCESS_ERROR.ACCESS_SERVICE_ERROR), { user_id: session.id, reason: "resolve_access failed" });
  const row = parseResolveAccessRow(resolved.data);
  if (!row) return deny(accessDenial(503, ACCESS_ERROR.ACCESS_SERVICE_ERROR), { user_id: session.id, reason: "malformed resolve_access row" });
  // A row for anyone but the authenticated user is discarded (§10 step 2).
  if (!sameId(row.user_id, session.id)) return deny(accessDenial(503, ACCESS_ERROR.ACCESS_SERVICE_ERROR), { user_id: session.id, reason: "resolve_access user mismatch" });
  if (row.status === "no_workspace") return deny(accessDenial(503, ACCESS_ERROR.WORKSPACE_NOT_BOOTSTRAPPED), { user_id: session.id });
  if (row.status === "no_membership") return deny(accessDenial(403, ACCESS_ERROR.NO_MEMBERSHIP), { user_id: session.id, action });
  if (row.status === "disabled") return deny(accessDenial(403, ACCESS_ERROR.MEMBERSHIP_DISABLED), { user_id: session.id, action });

  let ctx: AccessContext;
  try {
    ctx = buildAccessContext(row, { kind: "user", userId: session.id, email: session.email }, requestId);
  } catch (error) {
    return deny(accessDenial(503, ACCESS_ERROR.ACCESS_SERVICE_ERROR), { user_id: session.id, reason: errorMessage(error) });
  }

  const denial = authorizeAction(ctx, policy.actions[action]);
  if (denial) return deny(denial, { user_id: session.id, member_id: ctx.actor.memberId, action, restricted: ctx.restricted });
  return run(ctx, action, body);
}
