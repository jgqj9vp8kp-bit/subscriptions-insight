// Access migration of the AI and Export API Edge functions (plan §7 rows "AI
// assistant", "Report prose", "Export API"; §10, §21, §23, §27 — Milestone A).
//
// ai-analytics and reports-generate are driven through the pure gate core
// (handleWithAccess) with their real handlers and fake Supabase / model
// transports; export-campaign-performance (API-key auth, no JWT gate) is driven
// through its pure handler with a fake service client and a real ScopedReader.
// The tests prove: who may call which action, that funnel-restricted contexts
// are refused, that the model is a server decision, that run rows are keyed by
// the ACTOR, that report_id must belong to the actor (404 otherwise), that the
// Export API resolves the key's creator and reads the WORKSPACE data key, and
// that the owner-visible response bodies keep their previous shape.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  assertValidPolicy,
  handleWithAccess,
  type AccessGateDeps,
  type AccessHandler,
  type FunctionPolicy,
} from "../../supabase/functions/_shared/access/gate.ts";
import { ACCESS_ERROR, ACCESS_ERROR_MESSAGES, ActionNormalizeError } from "../../supabase/functions/_shared/access/errors.ts";
import type { AccessContext } from "../../supabase/functions/_shared/access/accessContext.ts";
import { ENFORCED_PERMISSION_KEYS } from "../../supabase/functions/_shared/access/permissions.ts";
import { createScopedReader, ScopeViolation } from "../../supabase/functions/_shared/clickhouse/scopedClient.ts";
import { AI_ANALYTICS_POLICY, normalizeAiAnalyticsAction } from "../../supabase/functions/_shared/access/policies/ai-analytics.ts";
import { REPORTS_GENERATE_POLICY, normalizeReportsGenerateAction } from "../../supabase/functions/_shared/access/policies/reports-generate.ts";
import {
  decideApiKeyAccess,
  EXPORT_API_KEY_SCOPE,
  EXPORT_CAMPAIGN_PERFORMANCE_POLICY,
  normalizeExportCampaignPerformanceAction,
} from "../../supabase/functions/_shared/access/policies/export-campaign-performance.ts";
import { ASSISTANT_FAILED_MESSAGE, createAiAnalyticsHandler } from "../../supabase/functions/ai-analytics/handler.ts";
import { createReportsGenerateHandler, NARRATIVE_FAILED_MESSAGE, REPORT_NOT_FOUND } from "../../supabase/functions/reports-generate/handler.ts";
import { handleExportCampaignPerformance, type ExportCampaignPerformanceDeps } from "../../supabase/functions/export-campaign-performance/handler.ts";
import { buildCampaignGeoDailyRows, buildCampaignPerformanceRows } from "../../supabase/functions/export-campaign-performance/compute.ts";
import { mapExportSourceRow, type ExportSourceTxn } from "../../supabase/functions/_shared/clickhouse/exportCampaignSource.ts";
import { FACT_FACEBOOK_STATS_TABLE } from "../../supabase/functions/_shared/clickhouse/schema.ts";
import {
  ASSISTANT_MODEL,
  ASSISTANT_PROMPT_VERSION,
  validateAssistantAnswer,
  type AssistantInput,
} from "../../supabase/functions/_shared/clickhouse/aiAssistant.ts";
import {
  NARRATIVE_MODEL,
  NARRATIVE_PROMPT_VERSION,
  parseNarrativeResponse,
  validateNarrative,
  type NarrativeInput,
} from "../../supabase/functions/_shared/clickhouse/reportNarrative.ts";
import { CLASSIFICATION_MODEL, type ModelCaller } from "../../supabase/functions/_shared/clickhouse/supportClassifier.ts";
import type { ClickHouseClientLike } from "../../supabase/functions/_shared/clickhouse/types.ts";

const DATA_KEY = "11111111-1111-4111-8111-111111111111";
const EMPLOYEE = "22222222-2222-4222-8222-222222222222";
const OTHER = "99999999-9999-4999-8999-999999999999";
const WORKSPACE = "33333333-3333-4333-8333-333333333333";
const MEMBER_ID = "44444444-4444-4444-8444-444444444444";
const REPORT_ID = "66666666-6666-4666-8666-666666666666";

type Scope = "all" | "selected" | "none";

function accessRow(options: { userId?: string; permissions?: string[]; isOwner?: boolean; scope?: Scope; status?: string } = {}) {
  const userId = options.userId ?? EMPLOYEE;
  if (options.status && options.status !== "ok") return { status: options.status, user_id: userId, workspace_id: WORKSPACE };
  const scope = options.scope ?? "all";
  return {
    status: "ok",
    workspace_id: WORKSPACE,
    data_key: DATA_KEY,
    member_id: MEMBER_ID,
    user_id: userId,
    email: "member@example.com",
    display_name: "Member",
    is_data_owner: userId === DATA_KEY,
    raw_access: userId === DATA_KEY,
    role: { id: "role-1", key: options.isOwner ? "owner" : "custom", name: "Role", is_owner: options.isOwner ?? false, permissions: options.permissions ?? [] },
    funnel_scope: { mode: scope, funnel_ids: scope === "selected" ? ["55555555-5555-4555-8555-555555555555"] : [], paths: scope === "selected" ? ["soulmate"] : [] },
    access_version: "7",
    partition: "partition-hash",
  };
}

type Row = ReturnType<typeof accessRow>;
const ownerRow = (scope: Scope = "all") => accessRow({ userId: DATA_KEY, isOwner: true, scope });
const memberRow = (permissions: string[], scope: Scope = "all") => accessRow({ permissions, scope });

// ---- a fake service-role Supabase client ------------------------------------------

type Op = [string, unknown[]];
interface PgCall {
  table: string;
  ops: Op[];
}
type QueryResult = { data: unknown; error: unknown };

class FakePg {
  readonly calls: PgCall[] = [];
  readonly inserts: Array<{ table: string; row: Record<string, unknown> }> = [];
  readonly rpc = vi.fn(async (_fn: string, _params?: Record<string, unknown>): Promise<QueryResult> => ({ data: null, error: null }));
  readonly auth = { getUser: vi.fn() };

  constructor(private readonly resolver: (call: PgCall) => QueryResult = () => ({ data: null, error: null })) {}

  from(table: string): FakeBuilder {
    const call: PgCall = { table, ops: [] };
    this.calls.push(call);
    return new FakeBuilder(call, this);
  }

  answer(call: PgCall): QueryResult {
    return this.resolver(call);
  }

  callsTo(table: string): PgCall[] {
    return this.calls.filter((call) => call.table === table);
  }

  insertsTo(table: string): Record<string, unknown>[] {
    return this.inserts.filter((entry) => entry.table === table).map((entry) => entry.row);
  }
}

class FakeBuilder implements PromiseLike<QueryResult> {
  constructor(private readonly call: PgCall, private readonly pg: FakePg) {}

  private push(op: string, args: unknown[]): this {
    this.call.ops.push([op, args]);
    return this;
  }

  select(...args: unknown[]) { return this.push("select", args); }
  eq(...args: unknown[]) { return this.push("eq", args); }
  order(...args: unknown[]) { return this.push("order", args); }
  limit(...args: unknown[]) { return this.push("limit", args); }
  update(...args: unknown[]) { return this.push("update", args); }

  async maybeSingle(): Promise<QueryResult> {
    this.call.ops.push(["maybeSingle", []]);
    return this.pg.answer(this.call);
  }

  insert(row: Record<string, unknown>) {
    this.pg.inserts.push({ table: this.call.table, row });
    const result: QueryResult = { data: { id: "run-1" }, error: null };
    return {
      then: <T1 = QueryResult, T2 = never>(ok?: ((value: QueryResult) => T1 | PromiseLike<T1>) | null, ko?: ((reason: unknown) => T2 | PromiseLike<T2>) | null) =>
        Promise.resolve(result).then(ok, ko),
      select: () => ({ single: async () => result }),
    };
  }

  then<T1 = QueryResult, T2 = never>(ok?: ((value: QueryResult) => T1 | PromiseLike<T1>) | null, ko?: ((reason: unknown) => T2 | PromiseLike<T2>) | null) {
    return Promise.resolve(this.pg.answer(this.call)).then(ok, ko);
  }
}

const eqs = (call: PgCall) => call.ops.filter(([op]) => op === "eq").map(([, args]) => args);

// ---- gate plumbing ---------------------------------------------------------------------

function gateDeps(row: Row, pg: FakePg): AccessGateDeps {
  return {
    configError: null,
    pg: pg as unknown as AccessGateDeps["pg"],
    getUser: vi.fn(async (token: string) => ({ data: { user: token === "good-token" ? { id: row.user_id, email: "member@example.com" } : null }, error: token === "good-token" ? null : { status: 401, message: "invalid JWT" } })),
    loadAccess: vi.fn(async () => ({ data: row, error: null })),
    workspaceDataKey: vi.fn(async () => ({ data: DATA_KEY, error: null })),
    readEnv: vi.fn(() => undefined),
    createClickHouse: vi.fn((ctx: AccessContext) => createScopedReader(ctx, { query: vi.fn(), command: vi.fn(), insert: vi.fn() } as unknown as ClickHouseClientLike)),
    newRequestId: () => "req-test-1",
    log: vi.fn(),
  };
}

function postRequest(body: unknown, token = "good-token") {
  const req = new Request("https://edge.test/functions/v1/fn", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const textSpy = vi.spyOn(req, "text");
  return { req, textSpy };
}

async function callGate<A extends string>(policy: FunctionPolicy<A>, handler: AccessHandler<A>, body: unknown, row: Row, pg = new FakePg(), token = "good-token") {
  const { req, textSpy } = postRequest(body, token);
  const response = await handleWithAccess(req, policy, handler, gateDeps(row, pg));
  return { response, status: response.status, body: (await response.json()) as Record<string, unknown>, pg, textSpy };
}

function modelStub(payload: unknown) {
  const call = vi.fn(async () => ({ payload, input_tokens: 120, output_tokens: 40 }));
  const createModelCaller = vi.fn((_apiKey: string, _model: string): ModelCaller => call);
  return { call, createModelCaller };
}

// ---- fixtures ----------------------------------------------------------------------------

function assistantInput(): AssistantInput {
  return {
    question: "What should I scale?",
    surface: "cohort",
    contextLabel: "Cohorts · 2 cohorts",
    contextPack: {
      engineVersion: "ai-signals-v1",
      asOfDate: "2026-08-20",
      items: [{
        scopeLabel: "soulmate-sketch-web-en · 2026-07-01",
        scopeKind: "cohort",
        action: "Scale +20%",
        confidence: "high",
        claim: "Scale +20%: CPA 15,00 $ with headroom.",
        evidenceLines: ["CPA: 15,00 $ (benchmark 24,10 $, 6 peers) — good"],
        contradictionLines: [],
        monitorLine: "CPA",
        dataNotes: [],
      }],
      inputStatusLines: [],
    },
  } as AssistantInput;
}

const ASSISTANT_PAYLOAD = {
  conclusion: "Scale soulmate-sketch-web-en carefully.",
  sections: [{ title: "Scale", items: [{ scopeLabel: "soulmate-sketch-web-en · 2026-07-01", text: "CPA 15,00 $ is below the benchmark." }] }],
  cautions: [],
};

function narrativeInput(): NarrativeInput {
  const metric = (key: string, rendered: string) => ({
    key, label: key, rendered, previousRendered: null, deltaRendered: null, better: null, significant: null,
    targetRendered: null, sampleSize: null, unavailable: null, evidence: `kpi.${key}`,
  });
  return {
    period: { from: "2026-07-27", to: "2026-08-02" },
    compare: null,
    language: "ru",
    dataIncomplete: false,
    provisionalReasons: [],
    kpi: [metric("trials", "959")],
    funnels: [],
    findings: [],
    gaps: [],
    thresholds: {},
    notes: [],
    tasks: { closed: [], open: [] },
  } as NarrativeInput;
}

const NARRATIVE_PAYLOAD = {
  highlights: [],
  executiveSummary: "959 триалов за неделю.",
  funnelInsights: [],
  risks: [],
  decisions: [],
  nextSteps: [],
  warnings: [],
};

// =============================================================================================

describe("policy tables", () => {
  const POLICIES = [AI_ANALYTICS_POLICY, REPORTS_GENERATE_POLICY, EXPORT_CAMPAIGN_PERFORMANCE_POLICY] as FunctionPolicy<string>[];

  it("are valid and named after their function", () => {
    for (const policy of POLICIES) expect(() => assertValidPolicy(policy)).not.toThrow();
    expect(POLICIES.map((policy) => policy.fn)).toEqual(["ai-analytics", "reports-generate", "export-campaign-performance"]);
    expect(AI_ANALYTICS_POLICY.methods ?? ["POST"]).toEqual(["POST"]);
    expect(REPORTS_GENERATE_POLICY.methods ?? ["POST"]).toEqual(["POST"]);
    expect(EXPORT_CAMPAIGN_PERFORMANCE_POLICY.methods).toEqual(["GET"]);
    for (const policy of POLICIES) expect(policy.cron).toBeUndefined();
  });

  it("match the Phase-1 permission table exactly (none is scopeReady)", () => {
    expect(AI_ANALYTICS_POLICY.actions).toEqual({ assistant_answer: { anyOf: ["ai.use"] } });
    expect(REPORTS_GENERATE_POLICY.actions).toEqual({
      generate: { allOf: ["reports.edit", "ai.use"] },
      regenerate_block: { allOf: ["reports.edit", "ai.use"] },
    });
    expect(EXPORT_CAMPAIGN_PERFORMANCE_POLICY.actions).toEqual({
      campaign_performance: { allOf: ["api_export.use"] },
      campaign_performance_geo: { allOf: ["api_export.use"] },
    });
    for (const policy of POLICIES) {
      for (const entry of Object.values(policy.actions)) {
        expect(entry.scopeReady).toBeFalsy();
        for (const key of [...(entry.anyOf ?? []), ...(entry.allOf ?? [])]) expect(ENFORCED_PERMISSION_KEYS).toContain(key);
      }
    }
  });
});

describe("canonical action normalizers (rule R3)", () => {
  it("ai-analytics accepts only assistant_answer", () => {
    expect(normalizeAiAnalyticsAction({ action: "assistant_answer" })).toBe("assistant_answer");
    for (const body of [{}, { action: null }, { action: "answer" }, { action: "ASSISTANT_ANSWER" }]) {
      expect(() => normalizeAiAnalyticsAction(body)).toThrow(ActionNormalizeError);
    }
  });

  it("reports-generate no longer turns an unknown action into generate", () => {
    expect(normalizeReportsGenerateAction({ action: "generate" })).toBe("generate");
    expect(normalizeReportsGenerateAction({ action: "regenerate_block" })).toBe("regenerate_block");
    for (const body of [{}, { action: "publish" }, { action: "" }]) {
      expect(() => normalizeReportsGenerateAction(body)).toThrow(ActionNormalizeError);
    }
  });

  it("the Export API keeps its implicit default and maps the geo breakdown to its own action", () => {
    const url = (query: string) => new URL(`https://edge.test/functions/v1/export-campaign-performance${query}`);
    expect(normalizeExportCampaignPerformanceAction({ method: "GET", url: url("") })).toBe("campaign_performance");
    expect(normalizeExportCampaignPerformanceAction({ method: "GET", url: url("?breakdown=campaign") })).toBe("campaign_performance");
    expect(normalizeExportCampaignPerformanceAction({ method: "GET", url: url("?breakdown=country") })).toBe("campaign_performance_geo");
    expect(normalizeExportCampaignPerformanceAction({ method: "GET", url: url("?breakdown=GEO") })).toBe("campaign_performance_geo");
    expect(() => normalizeExportCampaignPerformanceAction({ method: "POST", url: url("") })).toThrow(ActionNormalizeError);
  });
});

// ---- ai-analytics -----------------------------------------------------------------------------

describe("ai-analytics", () => {
  const handlerWith = (payload: unknown = ASSISTANT_PAYLOAD, apiKey: string | null = "sk-test") => {
    const model = modelStub(payload);
    const handler = createAiAnalyticsHandler({ apiKey: () => apiKey, createModelCaller: model.createModelCaller });
    return { handler, ...model };
  };
  const request = (over: Record<string, unknown> = {}) => ({ action: "assistant_answer", input: assistantInput(), ...over });

  it("serves the data owner the same body as before, with a server-chosen model", async () => {
    const { handler, createModelCaller } = handlerWith();
    const result = await callGate(AI_ANALYTICS_POLICY, handler, request({ model: "claude-mythos-9" }), ownerRow());
    expect(result.status).toBe(200);
    expect(createModelCaller).toHaveBeenCalledWith("sk-test", ASSISTANT_MODEL);
    const validation = validateAssistantAnswer(ASSISTANT_PAYLOAD as never, assistantInput());
    expect(result.body).toEqual({
      ok: validation.ok,
      promptVersion: ASSISTANT_PROMPT_VERSION,
      model: ASSISTANT_MODEL,
      runId: "run-1",
      answer: validation.accepted,
      validation: { ok: validation.ok, violations: validation.violations },
      usage: { inputTokens: 120, outputTokens: 40, durationMs: expect.any(Number) },
    });
    expect(result.response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("honours a requested model only when it is on the server allowlist", async () => {
    const { handler, createModelCaller } = handlerWith();
    const result = await callGate(AI_ANALYTICS_POLICY, handler, request({ model: CLASSIFICATION_MODEL }), ownerRow());
    expect(createModelCaller).toHaveBeenCalledWith("sk-test", CLASSIFICATION_MODEL);
    expect(result.body.model).toBe(CLASSIFICATION_MODEL);
  });

  it("keys the run row by the actor, not the workspace tenant", async () => {
    const { handler } = handlerWith();
    const result = await callGate(AI_ANALYTICS_POLICY, handler, request({ model: "gpt-x" }), memberRow(["ai.use"]));
    expect(result.status).toBe(200);
    const [row] = result.pg.insertsTo("ai_assistant_runs");
    expect(row).toMatchObject({ auth_user_id: EMPLOYEE, model: ASSISTANT_MODEL, status: expect.any(String), surface: "cohort" });
    expect(row.auth_user_id).not.toBe(DATA_KEY);
  });

  it("requires ai.use", async () => {
    const { handler, createModelCaller } = handlerWith();
    const result = await callGate(AI_ANALYTICS_POLICY, handler, request(), memberRow([...ENFORCED_PERMISSION_KEYS].filter((key) => key !== "ai.use" && key !== "ai.history.view")));
    expect(result.status).toBe(403);
    expect(result.body.error_code).toBe(ACCESS_ERROR.PERMISSION_DENIED);
    expect(createModelCaller).not.toHaveBeenCalled();
    expect(result.pg.inserts).toEqual([]);
  });

  it.each(["selected", "none"] as const)("Milestone A: a %s-scope member is refused with scope_not_supported", async (scope) => {
    const { handler, createModelCaller } = handlerWith();
    const result = await callGate(AI_ANALYTICS_POLICY, handler, request(), memberRow(["ai.use"], scope));
    expect(result.status).toBe(403);
    expect(result.body.error_code).toBe(ACCESS_ERROR.SCOPE_NOT_SUPPORTED);
    expect(createModelCaller).not.toHaveBeenCalled();
  });

  it("authenticates before reading the body", async () => {
    const { handler } = handlerWith();
    const result = await callGate(AI_ANALYTICS_POLICY, handler, request(), memberRow(["ai.use"]), new FakePg(), "expired");
    expect(result.status).toBe(401);
    expect(result.body.error_code).toBe(ACCESS_ERROR.INVALID_SESSION);
    expect(result.textSpy).not.toHaveBeenCalled();
  });

  it("rejects a missing action with 400 unknown_action", async () => {
    const { handler } = handlerWith();
    const result = await callGate(AI_ANALYTICS_POLICY, handler, { input: assistantInput() }, ownerRow());
    expect(result.status).toBe(400);
    expect(result.body.error_code).toBe(ACCESS_ERROR.UNKNOWN_ACTION);
  });

  it("keeps the unavailable / validation / failure outcomes unchanged", async () => {
    const noKey = handlerWith(ASSISTANT_PAYLOAD, null);
    const unavailable = await callGate(AI_ANALYTICS_POLICY, noKey.handler, request(), ownerRow());
    expect(unavailable.status).toBe(200);
    expect(unavailable.body).toEqual({
      ok: false,
      unavailable: true,
      error: "ANTHROPIC_API_KEY is not configured — the assistant is unavailable; all deterministic AI features keep working.",
    });

    const { handler } = handlerWith();
    const missing = await callGate(AI_ANALYTICS_POLICY, handler, { action: "assistant_answer", input: { question: " " } }, ownerRow());
    expect(missing.status).toBe(400);
    expect(missing.body).toEqual({ ok: false, error: "Missing question or deterministic context." });

    const failing = createAiAnalyticsHandler({
      apiKey: () => "sk-test",
      createModelCaller: () => async () => { throw new Error("overloaded"); },
    });
    const failed = await callGate(AI_ANALYTICS_POLICY, failing, request(), ownerRow());
    expect(failed.status).toBe(200);
    expect(failed.body).toEqual({ ok: false, runId: "run-1", error: "overloaded" });
    expect(failed.pg.insertsTo("ai_assistant_runs")[0]).toMatchObject({ auth_user_id: DATA_KEY, status: "error", error: "overloaded" });

    const broke = createAiAnalyticsHandler({
      apiKey: () => "sk-test",
      createModelCaller: () => async () => { throw new Error("Your credit balance is too low to access the API"); },
    });
    const empty = await callGate(AI_ANALYTICS_POLICY, broke, request(), ownerRow());
    expect(empty.body).toMatchObject({ ok: false, unavailable: true });
  });

  it("a member who is not the data owner gets a fixed failure text, never the model / transport error", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const failing = createAiAnalyticsHandler({
        apiKey: () => "sk-test",
        createModelCaller: () => async () => { throw new Error("529 overloaded_error req_011CXyz (upstream detail)"); },
      });
      const failed = await callGate(AI_ANALYTICS_POLICY, failing, request(), memberRow(["ai.use"]));
      expect(failed.status).toBe(200);
      expect(failed.body).toEqual({ ok: false, runId: "run-1", error: ASSISTANT_FAILED_MESSAGE });
      expect(JSON.stringify(failed.body)).not.toContain("upstream detail");
      // The detail goes to the server log (and the actor-keyed run row).
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("upstream detail"));
      expect(failed.pg.insertsTo("ai_assistant_runs")[0]).toMatchObject({ auth_user_id: EMPLOYEE, status: "error" });
    } finally {
      consoleError.mockRestore();
    }
  });
});

// ---- reports-generate ---------------------------------------------------------------------------

describe("reports-generate", () => {
  const REPORT_EDITOR = ["reports.view", "reports.edit", "ai.use"];
  /** reports rows: REPORT_ID belongs to `author`. */
  const reportsPg = (author: string, error: unknown = null) => new FakePg((call) => {
    if (call.table !== "reports") return { data: null, error: null };
    if (error) return { data: null, error };
    const [id, owner] = [eqs(call).find(([column]) => column === "id")?.[1], eqs(call).find(([column]) => column === "auth_user_id")?.[1]];
    return { data: id === REPORT_ID && owner === author ? { id: REPORT_ID } : null, error: null };
  });
  const handlerWith = (apiKey: string | null = "sk-test") => {
    const model = modelStub(NARRATIVE_PAYLOAD);
    return { handler: createReportsGenerateHandler({ apiKey: () => apiKey, createModelCaller: model.createModelCaller }), ...model };
  };
  const request = (over: Record<string, unknown> = {}) => ({ action: "generate", report_id: REPORT_ID, block_id: null, input: narrativeInput(), ...over });

  it("serves the data owner's own report with the same body as before", async () => {
    const { handler, createModelCaller } = handlerWith();
    const pg = reportsPg(DATA_KEY);
    const result = await callGate(REPORTS_GENERATE_POLICY, handler, request({ model: "claude-mythos-9" }), ownerRow(), pg);
    expect(result.status).toBe(200);
    expect(createModelCaller).toHaveBeenCalledWith("sk-test", NARRATIVE_MODEL);
    const validation = validateNarrative(parseNarrativeResponse(NARRATIVE_PAYLOAD), narrativeInput());
    expect(result.body).toEqual({
      ok: validation.ok,
      promptVersion: NARRATIVE_PROMPT_VERSION,
      model: NARRATIVE_MODEL,
      response: validation.accepted,
      validation: { ok: validation.ok, violations: validation.violations },
      usage: { inputTokens: 120, outputTokens: 40, durationMs: expect.any(Number) },
    });
    // The ownership probe reads only the id of a row the actor authored.
    const [lookup] = pg.callsTo("reports");
    expect(lookup.ops[0]).toEqual(["select", ["id"]]);
    expect(eqs(lookup)).toEqual([["id", REPORT_ID], ["auth_user_id", DATA_KEY]]);
  });

  it("lets an employee generate prose for THEIR report and logs the run under them", async () => {
    const { handler } = handlerWith();
    const pg = reportsPg(EMPLOYEE);
    const result = await callGate(REPORTS_GENERATE_POLICY, handler, request({ action: "regenerate_block", block_id: "b1" }), memberRow(REPORT_EDITOR), pg);
    expect(result.status).toBe(200);
    expect(eqs(pg.callsTo("reports")[0])).toEqual([["id", REPORT_ID], ["auth_user_id", EMPLOYEE]]);
    expect(pg.insertsTo("report_ai_runs")).toEqual([expect.objectContaining({
      auth_user_id: EMPLOYEE,
      report_id: REPORT_ID,
      block_id: "b1",
      action: "regenerate_block",
      model: NARRATIVE_MODEL,
    })]);
  });

  it("answers 404 for a report the actor does not own — before any model call or log", async () => {
    const { handler, createModelCaller } = handlerWith();
    for (const pg of [reportsPg(DATA_KEY), reportsPg(OTHER)]) {
      const result = await callGate(REPORTS_GENERATE_POLICY, handler, request(), memberRow(REPORT_EDITOR), pg);
      expect(result.status).toBe(404);
      expect(result.body).toEqual({ ok: false, error_code: REPORT_NOT_FOUND, error: "Report not found." });
      expect(pg.insertsTo("report_ai_runs")).toEqual([]);
    }
    expect(createModelCaller).not.toHaveBeenCalled();
  });

  it("answers the same 404 even when the model is not configured (no existence oracle)", async () => {
    const { handler } = handlerWith(null);
    const result = await callGate(REPORTS_GENERATE_POLICY, handler, request(), memberRow(REPORT_EDITOR), reportsPg(OTHER));
    expect(result.status).toBe(404);
  });

  it("answers 404 for a malformed report id without querying", async () => {
    const { handler } = handlerWith();
    for (const report_id of ["not-a-uuid", "", 42]) {
      const pg = reportsPg(EMPLOYEE);
      const result = await callGate(REPORTS_GENERATE_POLICY, handler, request({ report_id }), memberRow(REPORT_EDITOR), pg);
      expect(result.status).toBe(404);
      expect(pg.callsTo("reports")).toEqual([]);
    }
  });

  it("fails closed with 503 when the ownership lookup fails", async () => {
    const { handler, createModelCaller } = handlerWith();
    const result = await callGate(REPORTS_GENERATE_POLICY, handler, request(), ownerRow(), reportsPg(DATA_KEY, { message: "pg down" }));
    expect(result.status).toBe(503);
    expect(result.body).toEqual({ ok: false, error_code: ACCESS_ERROR.ACCESS_SERVICE_ERROR, error: ACCESS_ERROR_MESSAGES.access_service_error });
    expect(createModelCaller).not.toHaveBeenCalled();
  });

  it("keeps a report-less generation allowed (the id only labels the run row)", async () => {
    const { handler } = handlerWith();
    const pg = reportsPg(EMPLOYEE);
    const result = await callGate(REPORTS_GENERATE_POLICY, handler, request({ report_id: null }), memberRow(REPORT_EDITOR), pg);
    expect(result.status).toBe(200);
    expect(pg.callsTo("reports")).toEqual([]);
    expect(pg.insertsTo("report_ai_runs")[0]).toMatchObject({ auth_user_id: EMPLOYEE, report_id: null });
  });

  it("requires reports.edit AND ai.use", async () => {
    const { handler, createModelCaller } = handlerWith();
    for (const permissions of [["reports.view", "reports.edit"], ["reports.view", "ai.use"], ["ai.use"]]) {
      const result = await callGate(REPORTS_GENERATE_POLICY, handler, request(), memberRow(permissions), reportsPg(EMPLOYEE));
      expect(result.status).toBe(403);
      expect(result.body.error_code).toBe(ACCESS_ERROR.PERMISSION_DENIED);
    }
    expect(createModelCaller).not.toHaveBeenCalled();
  });

  it.each(["selected", "none"] as const)("Milestone A: a %s-scope member is refused with scope_not_supported", async (scope) => {
    const { handler } = handlerWith();
    const pg = reportsPg(EMPLOYEE);
    const result = await callGate(REPORTS_GENERATE_POLICY, handler, request(), memberRow(REPORT_EDITOR, scope), pg);
    expect(result.status).toBe(403);
    expect(result.body.error_code).toBe(ACCESS_ERROR.SCOPE_NOT_SUPPORTED);
    expect(pg.calls).toEqual([]);
  });

  it("keeps the unavailable / bad-input / failure outcomes unchanged", async () => {
    const noKey = handlerWith(null);
    const unavailable = await callGate(REPORTS_GENERATE_POLICY, noKey.handler, request(), ownerRow(), reportsPg(DATA_KEY));
    expect(unavailable.status).toBe(200);
    expect(unavailable.body).toEqual({ ok: false, unavailable: true, error: "ANTHROPIC_API_KEY не задан — формулировки недоступны, отчёт работает без них." });

    const { handler } = handlerWith();
    const bad = await callGate(REPORTS_GENERATE_POLICY, handler, request({ input: { kpi: [] } }), ownerRow(), reportsPg(DATA_KEY));
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({ ok: false, error: "Не передан посчитанный вход отчёта." });

    const failing = createReportsGenerateHandler({ apiKey: () => "sk-test", createModelCaller: () => async () => { throw new Error("overloaded"); } });
    const failed = await callGate(REPORTS_GENERATE_POLICY, failing, request(), ownerRow(), reportsPg(DATA_KEY));
    expect(failed.status).toBe(200);
    expect(failed.body).toEqual({ ok: false, error: "overloaded" });
  });

  it("a member who is not the data owner gets a fixed failure text, never the model / transport error", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const failing = createReportsGenerateHandler({ apiKey: () => "sk-test", createModelCaller: () => async () => { throw new Error("overloaded (upstream detail)"); } });
      const failed = await callGate(REPORTS_GENERATE_POLICY, failing, request(), memberRow(REPORT_EDITOR), reportsPg(EMPLOYEE));
      expect(failed.status).toBe(200);
      expect(failed.body).toEqual({ ok: false, error: NARRATIVE_FAILED_MESSAGE });
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("upstream detail"));
    } finally {
      consoleError.mockRestore();
    }
  });

  it("rejects an unknown action with 400", async () => {
    const { handler } = handlerWith();
    const result = await callGate(REPORTS_GENERATE_POLICY, handler, request({ action: "publish" }), ownerRow(), reportsPg(DATA_KEY));
    expect(result.status).toBe(400);
    expect(result.body.error_code).toBe(ACCESS_ERROR.UNKNOWN_ACTION);
  });
});

// ---- export-campaign-performance (API key) ---------------------------------------------------------

const API_KEY = "subengine_live_abcdef0123456789";
const API_KEY_ID = "77777777-7777-4777-8777-777777777777";

const TX_ROWS = [
  { transaction_id: "t1", user_id: "u1", email: "a@example.com", event_time: "2026-05-01T10:00:00Z", amount_usd: 1, gross_amount_usd: 1, net_amount_usd: 1, refund_amount_usd: 0, is_refund: 0, status: "success", transaction_type: "trial", funnel: "past_life", campaign_path: "soulmate", campaign_id: "c1", country_code: "us", utm_source: "fb", classification_reason: "", billing_reason: "", product_name: "", currency: "USD", source: "palmer_csv", import_batch_id: "batch-1" },
  { transaction_id: "t2", user_id: "u2", email: "b@example.com", event_time: "2026-05-02T10:00:00Z", amount_usd: 1, gross_amount_usd: 1, net_amount_usd: 1, refund_amount_usd: 0, is_refund: 0, status: "success", transaction_type: "trial", funnel: "past_life", campaign_path: "soulmate", campaign_id: "c1", country_code: "de", utm_source: "fb", classification_reason: "", billing_reason: "", product_name: "", currency: "USD", source: "palmer_csv", import_batch_id: "batch-2" },
];

interface ExportSetup {
  keyUserId?: string;
  row?: unknown;
  rpcError?: unknown;
  key?: Partial<{ is_active: boolean; revoked_at: string | null; allowed_scopes: string[] | null }> | null;
  chQuery?: (input: { query: string; query_params?: Record<string, unknown> }) => Promise<unknown[]>;
}

function exportSetup(setup: ExportSetup = {}) {
  const keyUserId = setup.keyUserId ?? DATA_KEY;
  const pg = new FakePg((call) => {
    if (call.table === "api_keys" && call.ops.some(([op]) => op === "maybeSingle")) {
      if (setup.key === null) return { data: null, error: null };
      return {
        data: { id: API_KEY_ID, user_id: keyUserId, prefix: "subengine_live_abc", is_active: true, revoked_at: null, allowed_scopes: [EXPORT_API_KEY_SCOPE], ...(setup.key ?? {}) },
        error: null,
      };
    }
    if (call.table === "import_batches") return { data: { id: "batch-2" }, error: null };
    return { data: null, error: null };
  });
  pg.rpc.mockImplementation(async () => ({ data: setup.row === undefined ? ownerRow() : setup.row, error: setup.rpcError ?? null }));
  const queries: Array<{ query: string; params: Record<string, unknown> }> = [];
  const raw: ClickHouseClientLike = {
    query: vi.fn(async (input: { query: string; query_params?: Record<string, unknown> }) => {
      queries.push({ query: input.query, params: input.query_params ?? {} });
      if (setup.chQuery) {
        const rows = await setup.chQuery(input);
        return { json: async () => rows };
      }
      if (input.query.includes("analytics_transactions")) return { json: async () => TX_ROWS };
      if (input.query.includes(FACT_FACEBOOK_STATS_TABLE)) return { json: async () => [{ campaign_id: "c1", campaign_name: "Soulmate US" }] };
      return { json: async () => [] };
    }),
    command: vi.fn(async () => undefined),
    insert: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
  const contexts: AccessContext[] = [];
  const log = vi.fn();
  const deps: ExportCampaignPerformanceDeps = {
    configError: null,
    pg: () => pg as unknown as ReturnType<ExportCampaignPerformanceDeps["pg"]>,
    createClickHouse: (ctx) => {
      contexts.push(ctx);
      return createScopedReader(ctx, raw);
    },
    newRequestId: () => "req-export-1",
    log,
  };
  return { pg, raw, queries, contexts, deps, log };
}

function exportRequest(options: { query?: string; method?: string; key?: string | null } = {}) {
  const headers: Record<string, string> = {};
  if (options.key !== null) headers.Authorization = `Bearer ${options.key ?? API_KEY}`;
  return new Request(`https://edge.test/functions/v1/export-campaign-performance${options.query ?? ""}`, { method: options.method ?? "GET", headers });
}

async function runExport(setup: ExportSetup = {}, request: Parameters<typeof exportRequest>[0] = {}) {
  const env = exportSetup(setup);
  const response = await handleExportCampaignPerformance(exportRequest(request), env.deps);
  const text = await response.text();
  return { ...env, response, status: response.status, body: (text ? JSON.parse(text) : null) as Record<string, unknown> | null };
}

const mapped = () => TX_ROWS.map((row) => mapExportSourceRow(row)).filter((row): row is ExportSourceTxn => Boolean(row));
const NULL_PARAMS = { date_from: null, date_to: null, campaign_path: null, media_buyer: null, campaign_id: null };

describe("export-campaign-performance (API key)", () => {
  it("serves the data owner's key with the same body as before (+ no-store, GET-only CORS)", async () => {
    const result = await runExport();
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      data: buildCampaignPerformanceRows({ txs: mapped(), traffic: [], params: NULL_PARAMS }),
      meta: {
        date_from: null,
        date_to: null,
        rows: 1,
        breakdown: null,
        traffic_rows: 0,
        transactions_loaded: 2,
        import_batches_loaded: 2,
        latest_batch_rows: 1,
        rows_outside_latest_batch: 1,
        generated_at: expect.any(String),
      },
    });
    expect(result.response.headers.get("Content-Type")).toBe("application/json");
    expect(result.response.headers.get("Cache-Control")).toBe("no-store");
    expect(result.response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(result.response.headers.get("Access-Control-Allow-Methods")).toBe("GET, OPTIONS");
    expect(result.response.headers.get("x-request-id")).toBe("req-export-1");
    expect(result.pg.rpc).toHaveBeenCalledWith("resolve_access", { p_user_id: DATA_KEY });
    expect(result.contexts[0].actor).toEqual({ kind: "api_key", userId: DATA_KEY, memberId: MEMBER_ID, email: "member@example.com" });
    expect(result.contexts[0].rawAccess).toBe(false);
    expect(result.pg.insertsTo("api_export_logs")).toEqual([expect.objectContaining({ api_key_id: API_KEY_ID, user_id: DATA_KEY, status_code: 200, rows_returned: 1 })]);
    expect(result.pg.callsTo("api_keys").some((call) => call.ops.some(([op]) => op === "update"))).toBe(true);
  });

  it("reads the WORKSPACE data key for an employee's key, and logs the employee as the actor", async () => {
    const result = await runExport({ keyUserId: EMPLOYEE, row: memberRow(["api_export.use"]) });
    expect(result.status).toBe(200);
    expect(result.pg.rpc).toHaveBeenCalledWith("resolve_access", { p_user_id: EMPLOYEE });
    expect(result.queries.length).toBeGreaterThan(0);
    for (const entry of result.queries) expect(entry.params.auth_user_id).toBe(DATA_KEY);
    expect(eqs(result.pg.callsTo("import_batches")[0])).toEqual([["user_id", DATA_KEY]]);
    const [log] = result.pg.insertsTo("api_export_logs");
    // Logged under the workspace (tenant data the owner can read); the actor is kept.
    expect(log).toMatchObject({ user_id: DATA_KEY, actor_user_id: EMPLOYEE, status_code: 200 });
    expect(result.contexts[0].tenantKey).toBe(DATA_KEY);
    expect(result.contexts[0].actor.userId).toBe(EMPLOYEE);
    expect(result.log).toHaveBeenCalledWith("info", "api_export", expect.objectContaining({ actor_kind: "api_key", user_id: EMPLOYEE, member_id: MEMBER_ID }));
  });

  it("serves the geo breakdown from the workspace's FB campaign names", async () => {
    const result = await runExport({ keyUserId: EMPLOYEE, row: memberRow(["api_export.use"]) }, { query: "?breakdown=country" });
    expect(result.status).toBe(200);
    expect(result.body?.data).toEqual(buildCampaignGeoDailyRows({ txs: mapped(), params: NULL_PARAMS, campaignNames: new Map([["c1", "Soulmate US"]]) }));
    expect((result.body?.meta as Record<string, unknown>).breakdown).toBe("country");
    const names = result.queries.find((entry) => entry.query.includes(FACT_FACEBOOK_STATS_TABLE));
    expect(names?.params.auth_user_id).toBe(DATA_KEY);
  });

  it("Milestone A: a funnel-restricted key creator is refused with scope_not_supported, before any read", async () => {
    for (const scope of ["selected", "none"] as const) {
      for (const row of [memberRow(["api_export.use"], scope), ownerRow(scope)]) {
        const result = await runExport({ keyUserId: row.user_id, row });
        expect(result.status).toBe(403);
        expect(result.body).toEqual({ ok: false, error_code: ACCESS_ERROR.SCOPE_NOT_SUPPORTED, error: ACCESS_ERROR_MESSAGES.scope_not_supported });
        expect(result.queries).toEqual([]);
        expect(result.contexts).toEqual([]);
        expect(result.pg.insertsTo("api_export_logs")).toEqual([expect.objectContaining({ status_code: 403, rows_returned: 0, error_message: "scope_not_supported" })]);
      }
    }
  });

  it("requires the creator's effective api_export.use", async () => {
    const result = await runExport({ keyUserId: EMPLOYEE, row: memberRow([...ENFORCED_PERMISSION_KEYS].filter((key) => key !== "api_export.use")) });
    expect(result.status).toBe(403);
    expect(result.body?.error_code).toBe(ACCESS_ERROR.PERMISSION_DENIED);
    expect(result.queries).toEqual([]);
    expect(result.pg.callsTo("api_keys").some((call) => call.ops.some(([op]) => op === "update"))).toBe(false);
  });

  it.each([
    ["a disabled creator", { status: "disabled" }, 403, ACCESS_ERROR.MEMBERSHIP_DISABLED],
    ["a non-member creator", { status: "no_membership" }, 403, ACCESS_ERROR.NO_MEMBERSHIP],
    ["no workspace", { status: "no_workspace" }, 503, ACCESS_ERROR.WORKSPACE_NOT_BOOTSTRAPPED],
  ] as const)("refuses %s", async (_label, options, status, code) => {
    const result = await runExport({ keyUserId: EMPLOYEE, row: accessRow({ ...options }) });
    expect(result.status).toBe(status);
    expect(result.body).toEqual({ ok: false, error_code: code, error: ACCESS_ERROR_MESSAGES[code] });
    expect(result.queries).toEqual([]);
  });

  it.each([
    ["an RPC error", { rpcError: { message: "function resolve_access does not exist" } }],
    ["a malformed row", { row: { status: "ok", user_id: EMPLOYEE } }],
    ["a row for another user", { row: accessRow({ userId: OTHER, permissions: ["api_export.use"] }) }],
  ])("fails closed with 503 on %s", async (_label, setup) => {
    const result = await runExport({ keyUserId: EMPLOYEE, ...setup });
    expect(result.status).toBe(503);
    expect(result.body?.error_code).toBe(ACCESS_ERROR.ACCESS_SERVICE_ERROR);
    expect(result.queries).toEqual([]);
  });

  it("keeps the legacy key / method / config errors byte-identical and resolves nobody", async () => {
    for (const [request, key] of [
      [{ key: null }, undefined],
      [{ key: "sk_live_wrong_prefix" }, undefined],
      [{}, null],
      [{}, { is_active: false }],
      [{}, { revoked_at: "2026-09-01T00:00:00Z" }],
      [{}, { allowed_scopes: ["something:else"] }],
    ] as const) {
      const result = await runExport({ key: key as ExportSetup["key"] }, request);
      expect(result.status).toBe(401);
      expect(result.body).toEqual({ error: "Invalid API key." });
      expect(result.pg.rpc).not.toHaveBeenCalled();
    }
    const post = await runExport({}, { method: "POST" });
    expect(post.status).toBe(405);
    expect(post.body).toEqual({ error: "Method not allowed." });

    const options = await runExport({}, { method: "OPTIONS" });
    expect(options.status).toBe(204);
    expect(options.response.headers.get("Access-Control-Allow-Methods")).toBe("GET, OPTIONS");

    const env = exportSetup();
    const unconfigured = await handleExportCampaignPerformance(exportRequest(), { ...env.deps, configError: "missing" });
    expect(unconfigured.status).toBe(500);
    expect(await unconfigured.json()).toEqual({ error: "API export is not configured." });
    expect(unconfigured.headers.get("Cache-Control")).toBe("no-store");
  });

  it("keeps the generic 500 on a warehouse failure and logs it", async () => {
    const result = await runExport({ chQuery: async () => { throw new Error("ClickHouse HTTP 500: boom"); } });
    expect(result.status).toBe(500);
    expect(result.body).toEqual({ error: "Export failed." });
    expect(result.pg.insertsTo("api_export_logs")).toEqual([expect.objectContaining({ status_code: 500, error_message: "ClickHouse HTTP 500: boom" })]);
  });

  it("fails the export on a scope violation even if it was swallowed (R7)", async () => {
    // The campaign-name lookup is best-effort — except for a ScopeViolation.
    const thrown = await runExport({
      chQuery: async (input) => {
        if (input.query.includes(FACT_FACEBOOK_STATS_TABLE)) throw new ScopeViolation("restricted_protected_table", FACT_FACEBOOK_STATS_TABLE);
        return TX_ROWS;
      },
    }, { query: "?breakdown=geo" });
    expect(thrown.status).toBe(500);
    expect(thrown.body).toEqual({ error: "Export failed." });

    // A violation recorded on the context fails the export regardless.
    const env = exportSetup();
    const recording: ExportCampaignPerformanceDeps = {
      ...env.deps,
      createClickHouse: (ctx) => {
        const reader = createScopedReader(ctx, env.raw);
        return {
          ...reader,
          query: async (input) => {
            ctx.violations.push("manual");
            return reader.query(input);
          },
        };
      },
    };
    const response = await handleExportCampaignPerformance(exportRequest(), recording);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Export failed." });
  });

  it("decideApiKeyAccess builds an api_key context on the workspace tenant", () => {
    const decision = decideApiKeyAccess({
      keyUserId: EMPLOYEE,
      resolved: { data: memberRow(["api_export.use"]), error: null },
      action: "campaign_performance",
      requestId: "r1",
    });
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.ctx.actor.kind).toBe("api_key");
    expect(decision.ctx.tenantKey).toBe(DATA_KEY);
    expect(decision.ctx.restricted).toBe(false);
  });
});

// ---- static: entrypoints ----------------------------------------------------------------------

describe("index.ts entrypoints", () => {
  const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
  const LEGACY = ["requireSupabaseUser", "requireCronSecret", "createClickHouseClient", "clickhouse/client.ts", "auth.id", "parseJsonBody"];

  it.each([
    ["ai-analytics", "AI_ANALYTICS_POLICY", "createAiAnalyticsHandler"],
    ["reports-generate", "REPORTS_GENERATE_POLICY", "createReportsGenerateHandler"],
  ])("%s serves through serveWithAccess(%s)", (fn, policyName, factory) => {
    const source = read(`supabase/functions/${fn}/index.ts`);
    expect(source).toMatch(new RegExp(`serveWithAccess\\(\\s*${policyName},\\s*${factory}\\(`));
    expect(source).toContain(`from "../_shared/access/policies/${fn}.ts"`);
    for (const banned of [...LEGACY, "Deno.serve("]) expect(source).not.toContain(banned);
    const handler = read(`supabase/functions/${fn}/handler.ts`);
    expect(handler).toContain("resolveAllowedModel(request.model");
    expect(handler).toContain("auth_user_id: ctx.actor.userId");
    expect(handler).not.toContain("ctx.tenantKey,");
    for (const banned of LEGACY) expect(handler).not.toContain(banned);
  });

  it("export-campaign-performance reads through a ScopedReader on ctx.tenantKey", () => {
    const index = read("supabase/functions/export-campaign-performance/index.ts");
    const handler = read("supabase/functions/export-campaign-performance/handler.ts");
    expect(index).toContain("createScopedReader(ctx)");
    expect(index).toContain("assertValidPolicy(EXPORT_CAMPAIGN_PERFORMANCE_POLICY)");
    for (const banned of LEGACY) {
      expect(index).not.toContain(banned);
      expect(handler).not.toContain(banned);
    }
    expect(handler).toContain("loadExportTransactions(reader, ctx.tenantKey)");
    expect(handler).toContain("loadLatestBatchId(client, ctx.tenantKey)");
    expect(handler).toContain("loadCampaignNames(reader, ctx.tenantKey)");
    expect(handler).not.toMatch(/load\w+\([^)]*key\.user_id/);
    expect(handler).toContain("buildCorsHeaders({ methods: METHODS })");
    expect(handler).toContain('"Cache-Control": "no-store"');
  });
});
