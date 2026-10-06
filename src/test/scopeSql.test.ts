// Funnel-scope SQL helpers (access Phase 2, spec §3.2).
//
// Two contracts are pinned here:
//   1. ALL scope renders exactly today's text, helper by helper (T20 part B —
//      the golden corpus, src/test/ownerSqlGolden.test.ts, proves the same for
//      whole owner queries);
//   2. restricted fragments are one-line, comment- and quote-identifier-free,
//      bind values only as unhex('…'), render an empty path set as `0`, and are
//      registered for THEIR context only — what the ScopedReader masks.
import { describe, expect, it } from "vitest";
import {
  ALL_SCOPE_SQL,
  FB_COLS,
  FC_COLS,
  OUT_OF_SCOPE_SENTINEL,
  SCOPE_PATH_RE,
  ScopeForbiddenError,
  ScopeSnapshotNotReadyError,
  TX_COLS,
  assertFbLevelInScope,
  assertKeyPathInScope,
  campaignScopeVisibleFrom,
  cohortsFrom,
  createRestrictedScopeSql,
  fbFrom,
  intersectIncludePaths,
  maskScopeFragments,
  presenceProbeSql,
  scopePaths,
  sqlStringLiteral,
  supportEmailsFrom,
  trialUtmIn,
  txEmailMatchedFrom,
  txFrom,
  type ScopeSql,
} from "../../supabase/functions/_shared/clickhouse/scopeSql.ts";
import {
  CAMPAIGN_SCOPE_VERSION,
  COHORT_CLASSIFICATION_VERSION,
  type CohortSnapshotState,
  type ScopeSnapshot,
} from "../../supabase/functions/_shared/clickhouse/cohortSnapshotState.ts";
import {
  CREATE_ANALYTICS_TRANSACTIONS_SQL,
  CREATE_FACT_FACEBOOK_STATS_SQL,
  CREATE_FACT_USER_COHORTS_SQL,
} from "../../supabase/functions/_shared/clickhouse/schema.ts";
import { activeCohortMemberWhere } from "../../supabase/functions/_shared/clickhouse/cohortMembership.ts";
import type { CohortFilters } from "../../supabase/functions/_shared/clickhouse/cohortContract.ts";
import {
  buildAccessContext,
  buildCronAccessContext,
  parseResolveAccessRow,
  type AccessContext,
} from "../../supabase/functions/_shared/access/accessContext.ts";
import { ACCESS_ERROR_MESSAGES } from "../../supabase/functions/_shared/access/errors.ts";

const DATA_KEY = "11111111-1111-4111-8111-111111111111";
const EMPLOYEE = "22222222-2222-4222-8222-222222222222";
const WH = "wh_scope_test";

function context(mode: "all" | "selected" | "none", paths: string[] = ["soulmate-sketch", "past-life"]): AccessContext {
  const row = parseResolveAccessRow({
    status: "ok",
    workspace_id: "33333333-3333-4333-8333-333333333333",
    data_key: DATA_KEY,
    member_id: "44444444-4444-4444-8444-444444444444",
    user_id: EMPLOYEE,
    email: "buyer@example.com",
    display_name: "Buyer",
    is_data_owner: false,
    raw_access: false,
    role: { id: "r1", key: "media_buyer", name: "Media Buyer", is_owner: false, permissions: ["cohorts.view"] },
    funnel_scope: { mode, funnel_ids: mode === "selected" ? ["f1"] : [], paths: mode === "selected" ? paths : [] },
    access_version: "1",
    partition: "p",
  });
  if (!row) throw new Error("fixture row did not parse");
  return buildAccessContext(row, { kind: "user", userId: EMPLOYEE, email: "buyer@example.com" }, `req-${mode}`);
}

function snapshot(overrides: Partial<ScopeSnapshot> = {}): ScopeSnapshot {
  return {
    warehouseVersion: WH,
    classificationVersion: COHORT_CLASSIFICATION_VERSION,
    campaignScopeReady: true,
    freshVerifiedAt: "2026-10-06T00:00:00.000Z",
    staleSince: null,
    state: {} as CohortSnapshotState,
    ...overrides,
  };
}

const L = sqlStringLiteral;
const PATHS_AB = `campaign_path IN (${L("past-life")}, ${L("soulmate-sketch")})`;
const SU_PREDICATES = (paths = PATHS_AB) =>
  `auth_user_id = {auth_user_id:String} AND warehouse_version = ${L(WH)} AND classification_version = ${L(COHORT_CLASSIFICATION_VERSION)} ` +
  `AND ${paths} AND NOT startsWith(canonical_user_id, 'unknown_user_')`;
const SU = (paths = PATHS_AB) => `SELECT canonical_user_id FROM fact_user_cohorts FINAL WHERE ${SU_PREDICATES(paths)}`;

/** Every restricted fragment kind for one handle. */
function allFragments(scope: ScopeSql): string[] {
  const params: Record<string, unknown> = {};
  return [
    txFrom(scope, "a"),
    txFrom(scope),
    cohortsFrom(scope, "fc"),
    cohortsFrom(scope),
    txEmailMatchedFrom(scope, "a"),
    campaignScopeVisibleFrom(scope),
    fbFrom(scope, "campaign", "f"),
    fbFrom(scope, "adset"),
    fbFrom(scope, "ad", "fb", "fact_facebook_stats AS fb FINAL"),
    supportEmailsFrom(scope),
    presenceProbeSql(scope, "fact_subscriptions"),
    presenceProbeSql(scope, "fact_support_requests"),
    trialUtmIn(scope, "fc.trial_transaction_id", ["fb", "tt"], "mmbutm", params),
  ];
}

const STATIC_LITERALS = ["'unknown_user_'", "'campaign'", "'adset'", "'ad'", "'resolved'", "' '", "''"];

function assertFragmentInvariants(fragment: string): void {
  expect(fragment, fragment).not.toMatch(/[\r\n]/);
  for (const token of ["--", "#", "/*", "*/", "`", "\"", "\\"]) expect(fragment.includes(token), `${token} in ${fragment}`).toBe(false);
  // Values only as unhex('<hex>'): what is left after removing those and the
  // fixed SQL-text literals has no quote at all.
  let rest = fragment.replace(/unhex\('[0-9a-f]*'\)/g, "");
  for (const literal of STATIC_LITERALS) rest = rest.split(literal).join("");
  expect(rest, fragment).not.toContain("'");
  expect(fragment).not.toContain("unhex('')");
}

function columnsOf(createSql: string): string[] {
  const body = createSql.slice(createSql.indexOf("(") + 1, createSql.indexOf("\n)"));
  return body.split("\n").map((line) => line.trim().split(/\s+/)[0]).filter((name) => /^[a-z_]+$/.test(name ?? ""));
}

const NO_FILTERS: CohortFilters = {
  funnel: [], campaign_path: [], campaign_path_exclude: [], campaign_id: [], traffic_source: [], price_plan: [],
  media_buyer: [], country: [], card_type: [], platform: [], currency: [], transaction_type: [], refund_status: "all" as CohortFilters["refund_status"],
};

// =========================================================================================

describe("ALL scope renders exactly today's text (T20, per helper)", () => {
  it("transactions / cohorts / email-matched sources", () => {
    expect(txFrom(ALL_SCOPE_SQL, "a")).toBe("analytics_transactions AS a FINAL");
    expect(txFrom(ALL_SCOPE_SQL)).toBe("analytics_transactions FINAL");
    expect(cohortsFrom(ALL_SCOPE_SQL, "fc")).toBe("fact_user_cohorts AS fc FINAL");
    expect(cohortsFrom(ALL_SCOPE_SQL)).toBe("fact_user_cohorts FINAL");
    expect(txEmailMatchedFrom(ALL_SCOPE_SQL, "a")).toBe("analytics_transactions AS a FINAL");
  });

  it("Facebook stats: the caller's own text when given (V2 compat views included), every level", () => {
    for (const level of ["account", "campaign", "adset", "ad", "day"] as const) {
      expect(fbFrom(ALL_SCOPE_SQL, level)).toBe("fact_facebook_stats FINAL");
      expect(fbFrom(ALL_SCOPE_SQL, level, "f")).toBe("fact_facebook_stats AS f FINAL");
      expect(fbFrom(ALL_SCOPE_SQL, level, "fb", "v_fb_stats_v2_campaign_compat AS fb")).toBe("v_fb_stats_v2_campaign_compat AS fb");
      expect(fbFrom(ALL_SCOPE_SQL, level, undefined, "fact_facebook_stats FINAL")).toBe("fact_facebook_stats FINAL");
    }
  });

  it("trialUtmIn is the media-buyer utm predicate of activeCohortMemberWhere, byte for byte, with the same bindings", () => {
    const params: Record<string, unknown> = {};
    const text = trialUtmIn(ALL_SCOPE_SQL, "fc.trial_transaction_id", ["facebook", "tiktok"], "mmbutm", params);
    expect(text).toBe(
      "fc.trial_transaction_id IN (SELECT transaction_id FROM analytics_transactions FINAL WHERE auth_user_id = {auth_user_id:String} " +
      "AND utm_source IN ({p_mmbutm_0:String}, {p_mmbutm_1:String}))",
    );
    expect(params).toEqual({ p_mmbutm_0: "facebook", p_mmbutm_1: "tiktok" });

    const memberParams: Record<string, unknown> = {};
    const where = activeCohortMemberWhere({ ...NO_FILTERS, media_buyer: ["utm:facebook", "utm:tiktok"] }, memberParams);
    expect(where).toBe(`AND ${text}`);
    expect(memberParams).toEqual(params);
  });

  it("include lists, explicit keys and FB levels are untouched", () => {
    const values = ["anything", "unknown", ""];
    const result = intersectIncludePaths(ALL_SCOPE_SQL, values);
    expect(result).toEqual({ values, dropped: 0 });
    expect(intersectIncludePaths(ALL_SCOPE_SQL, [])).toEqual({ values: [], dropped: 0 });
    expect(() => assertKeyPathInScope(ALL_SCOPE_SQL, "other-funnel")).not.toThrow();
    expect(() => assertKeyPathInScope(ALL_SCOPE_SQL, undefined)).not.toThrow();
    expect(() => assertFbLevelInScope(ALL_SCOPE_SQL, "account")).not.toThrow();
    expect(scopePaths(ALL_SCOPE_SQL)).toEqual([]);
  });

  it("the restricted-only helpers refuse ALL scope", () => {
    expect(() => campaignScopeVisibleFrom(ALL_SCOPE_SQL)).toThrow(/restricted scope only/);
    expect(() => supportEmailsFrom(ALL_SCOPE_SQL)).toThrow(/restricted scope only/);
    expect(() => presenceProbeSql(ALL_SCOPE_SQL, "fact_subscriptions")).toThrow(/restricted scope only/);
  });

  it("is frozen, unrestricted, and needs no context", () => {
    expect(Object.isFrozen(ALL_SCOPE_SQL)).toBe(true);
    expect(ALL_SCOPE_SQL).toMatchObject({ restricted: false, paths: null, snapshot: null });
  });
});

describe("restricted fragments", () => {
  it("txFrom / cohortsFrom bind the scoped users (anchor paths, active versions, no synthetic ids)", () => {
    const scope = createRestrictedScopeSql(context("selected"), snapshot());
    expect(txFrom(scope, "a")).toBe(
      `(SELECT ${TX_COLS.join(", ")} FROM analytics_transactions FINAL WHERE auth_user_id = {auth_user_id:String} AND user_id IN (${SU()})) AS a`,
    );
    expect(txFrom(scope)).toBe(`(SELECT ${TX_COLS.join(", ")} FROM analytics_transactions FINAL WHERE auth_user_id = {auth_user_id:String} AND user_id IN (${SU()}))`);
    expect(cohortsFrom(scope, "fc")).toBe(`(SELECT ${FC_COLS.join(", ")} FROM fact_user_cohorts FINAL WHERE ${SU_PREDICATES()}) AS fc`);
    expect(cohortsFrom(scope)).toBe(`(SELECT ${FC_COLS.join(", ")} FROM fact_user_cohorts FINAL WHERE ${SU_PREDICATES()})`);
  });

  it("txEmailMatchedFrom carries the 'not any snapshot member' exclusion inside the fragment (R-2)", () => {
    const scope = createRestrictedScopeSql(context("selected"), snapshot());
    const members = `SELECT canonical_user_id FROM fact_user_cohorts FINAL WHERE auth_user_id = {auth_user_id:String} AND warehouse_version = ${L(WH)} AND classification_version = ${L(COHORT_CLASSIFICATION_VERSION)}`;
    expect(txEmailMatchedFrom(scope, "a")).toBe(
      `(SELECT ${TX_COLS.join(", ")} FROM analytics_transactions FINAL WHERE auth_user_id = {auth_user_id:String} AND normalized_email != '' ` +
      `AND user_id NOT IN (${members}) AND normalized_email IN (SELECT normalized_email FROM analytics_transactions FINAL ` +
      `WHERE auth_user_id = {auth_user_id:String} AND normalized_email != '' AND user_id IN (${SU()}))) AS a`,
    );
    expect(() => txEmailMatchedFrom(scope, "" as string)).toThrow(/alias/);
  });

  it("FB: V1 rows of resolved in-scope campaigns, campaign / adset / ad only", () => {
    const scope = createRestrictedScopeSql(context("selected"), snapshot());
    const vis = `(SELECT campaign_id FROM fact_campaign_scope FINAL WHERE auth_user_id = {auth_user_id:String} AND warehouse_version = ${L(WH)} ` +
      `AND classification_version = ${L(COHORT_CLASSIFICATION_VERSION)} AND scope_version = ${L(CAMPAIGN_SCOPE_VERSION)} AND status = 'resolved' AND ${PATHS_AB})`;
    expect(campaignScopeVisibleFrom(scope)).toBe(vis);
    const fb = `(SELECT ${FB_COLS.join(", ")} FROM fact_facebook_stats FINAL WHERE auth_user_id = {auth_user_id:String} ` +
      `AND level IN ('campaign','adset','ad') AND trim(BOTH ' ' FROM campaign_id) IN ${vis})`;
    expect(fbFrom(scope, "campaign")).toBe(fb);
    expect(fbFrom(scope, "adset", "f")).toBe(`${fb} AS f`);
    // The all-mode text (a V2 view) is ignored: restricted reads are always V1.
    expect(fbFrom(scope, "ad", "fb", "v_fb_stats_v2_ad_compat AS fb")).toBe(`${fb} AS fb`);
  });

  it("FB account / day levels are 403 scope_not_supported before anything else", () => {
    const scope = createRestrictedScopeSql(context("selected"), null);
    for (const level of ["account", "day"] as const) {
      expect(() => fbFrom(scope, level)).toThrow(ScopeForbiddenError);
      try {
        fbFrom(scope, level);
      } catch (error) {
        expect((error as ScopeForbiddenError).code).toBe("scope_not_supported");
      }
    }
  });

  it("support emails and presence probes", () => {
    const scope = createRestrictedScopeSql(context("selected"), snapshot());
    expect(supportEmailsFrom(scope)).toBe(
      "(SELECT normalized_email FROM fact_support_requests FINAL WHERE auth_user_id = {auth_user_id:String} " +
      "AND lowerUTF8(trim(BOTH ' ' FROM normalized_email)) IN (SELECT lowerUTF8(trim(BOTH ' ' FROM normalized_email)) " +
      `FROM fact_user_cohorts FINAL WHERE ${SU_PREDICATES()}))`,
    );
    expect(presenceProbeSql(scope, "fact_subscriptions")).toBe(
      "SELECT count() AS c FROM (SELECT 1 FROM fact_subscriptions FINAL WHERE auth_user_id = {auth_user_id:String} LIMIT 1) FORMAT JSONEachRow",
    );
    expect(() => presenceProbeSql(scope, "analytics_transactions" as "fact_subscriptions")).toThrow(/unsupported table/);
  });

  it("trialUtmIn binds like bindList and reads the scoped transactions", () => {
    const scope = createRestrictedScopeSql(context("selected"), snapshot());
    const params: Record<string, unknown> = { keep: 1 };
    expect(trialUtmIn(scope, "fc.trial_transaction_id", ["fb"], "mmbutm", params)).toBe(
      `fc.trial_transaction_id IN (SELECT transaction_id FROM ${txFrom(scope)} WHERE auth_user_id = {auth_user_id:String} AND utm_source IN ({p_mmbutm_0:String}))`,
    );
    expect(params).toEqual({ keep: 1, p_mmbutm_0: "fb" });
    expect(trialUtmIn(scope, "fc.trial_transaction_id", [], "mmbutm", params)).toBe("0");
  });

  it("every fragment is one line, comment / quote-identifier free, with values only as unhex", () => {
    const fragments = allFragments(createRestrictedScopeSql(context("selected", ["it's-fine", "soulmate-sketch", "a\"b"]), snapshot()));
    expect(fragments.length).toBe(13);
    for (const fragment of fragments) assertFragmentInvariants(fragment);
  });

  it("an empty path set renders `0` — never 'no predicate', never unhex('')", () => {
    for (const ctx of [context("none"), context("selected", []), context("selected", ["a_b", "a--b", "-a", "unknown", "тест", "x".repeat(201)])]) {
      const scope = createRestrictedScopeSql(ctx, snapshot());
      expect(scopePaths(scope)).toEqual([]);
      for (const fragment of allFragments(scope)) {
        assertFragmentInvariants(fragment);
        expect(fragment).not.toContain("campaign_path IN");
      }
      expect(cohortsFrom(scope)).toContain(" AND 0 AND NOT startsWith(canonical_user_id, 'unknown_user_')");
      expect(campaignScopeVisibleFrom(scope)).toMatch(/ AND status = 'resolved' AND 0\)$/);
    }
  });
});

describe("scope paths (P filtering)", () => {
  it("keeps canonical campaign paths only: P, not 'unknown', at most 200 characters", () => {
    const longOk = `a${"-b".repeat(99)}0`; // 200 characters
    expect(longOk.length).toBe(200);
    const scope = createRestrictedScopeSql(context("selected", [
      "soulmate-sketch", "a_b", "a--b", "-a", "a-", "unknown", "тест", "x".repeat(201), longOk, "past-life", "past-life",
      "/palm-reading", "Upper-Case", " spaced ",
    ]), null);
    // canonicalScopePaths (scope.ts) already trimmed, lower-cased and stripped a leading "/".
    expect(scopePaths(scope)).toEqual([longOk, "palm-reading", "past-life", "soulmate-sketch", "spaced", "upper-case"]);
    expect(Object.isFrozen(scopePaths(scope))).toBe(true);
    for (const path of scopePaths(scope)) expect(SCOPE_PATH_RE.test(path)).toBe(true);
  });

  it("is empty for mode none", () => {
    expect(scopePaths(createRestrictedScopeSql(context("none"), null))).toEqual([]);
  });
});

describe("include intersection and explicit keys (R11)", () => {
  const scope = () => createRestrictedScopeSql(context("selected"), snapshot());

  it("keeps in-scope values and counts the dropped ones", () => {
    expect(intersectIncludePaths(scope(), ["soulmate-sketch", "other-funnel"])).toEqual({ values: ["soulmate-sketch"], dropped: 1 });
    expect(intersectIncludePaths(scope(), ["past-life", "soulmate-sketch"])).toEqual({ values: ["past-life", "soulmate-sketch"], dropped: 0 });
    expect(intersectIncludePaths(scope(), [])).toEqual({ values: [], dropped: 0 });
  });

  it("never turns an out-of-scope include list into 'no filter': it becomes the sentinel", () => {
    expect(intersectIncludePaths(scope(), ["other-funnel"])).toEqual({ values: [OUT_OF_SCOPE_SENTINEL], dropped: 1 });
    expect(intersectIncludePaths(scope(), ["unknown", "", "Soulmate-Sketch"])).toEqual({ values: [OUT_OF_SCOPE_SENTINEL], dropped: 3 });
    expect(SCOPE_PATH_RE.test(OUT_OF_SCOPE_SENTINEL)).toBe(false);
    const none = createRestrictedScopeSql(context("none"), null);
    expect(intersectIncludePaths(none, ["soulmate-sketch"])).toEqual({ values: [OUT_OF_SCOPE_SENTINEL], dropped: 1 });
  });

  it("an explicit key outside the scope is 403 funnel_out_of_scope", () => {
    expect(() => assertKeyPathInScope(scope(), "soulmate-sketch")).not.toThrow();
    expect(() => assertKeyPathInScope(scope(), "  past-life ")).not.toThrow();
    for (const bad of ["other-funnel", "", "unknown", "Soulmate-Sketch", undefined, null, 42, ["soulmate-sketch"]]) {
      let thrown: unknown = null;
      try {
        assertKeyPathInScope(scope(), bad);
      } catch (error) {
        thrown = error;
      }
      expect(thrown, JSON.stringify(bad)).toBeInstanceOf(ScopeForbiddenError);
      expect((thrown as ScopeForbiddenError).code).toBe("funnel_out_of_scope");
    }
  });

  it("FB levels: campaign / adset / ad only", () => {
    for (const level of ["campaign", "adset", "ad"]) expect(() => assertFbLevelInScope(scope(), level)).not.toThrow();
    for (const level of ["account", "day", "", "geo"]) {
      expect(() => assertFbLevelInScope(scope(), level), level).toThrow(ScopeForbiddenError);
    }
  });
});

describe("snapshot requirements", () => {
  it("every fact-reading restricted helper needs the gate's snapshot (snapshot_missing)", () => {
    const scope = createRestrictedScopeSql(context("selected"), null);
    const calls: Array<() => unknown> = [
      () => txFrom(scope, "a"),
      () => cohortsFrom(scope),
      () => txEmailMatchedFrom(scope, "a"),
      () => campaignScopeVisibleFrom(scope),
      () => fbFrom(scope, "campaign"),
      () => supportEmailsFrom(scope),
      () => presenceProbeSql(scope, "fact_support_requests"),
      () => trialUtmIn(scope, "fc.trial_transaction_id", ["fb"], "mmbutm", {}),
    ];
    for (const call of calls) {
      let thrown: unknown = null;
      try {
        call();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ScopeSnapshotNotReadyError);
      expect((thrown as ScopeSnapshotNotReadyError).reason).toBe("snapshot_missing");
    }
    // Pure helpers need none.
    expect(intersectIncludePaths(scope, ["soulmate-sketch"]).values).toEqual(["soulmate-sketch"]);
  });

  it("FB fragments need the campaign scope (campaign_scope_missing); the cohort fragments do not", () => {
    const scope = createRestrictedScopeSql(context("selected"), snapshot({ campaignScopeReady: false }));
    for (const call of [() => fbFrom(scope, "campaign"), () => campaignScopeVisibleFrom(scope)]) {
      let thrown: unknown = null;
      try {
        call();
      } catch (error) {
        thrown = error;
      }
      expect((thrown as ScopeSnapshotNotReadyError).reason).toBe("campaign_scope_missing");
    }
    expect(txFrom(scope, "a")).toContain("AS a");
  });

  it("the errors carry the gate's codes and messages", () => {
    const forbidden = new ScopeForbiddenError("funnel_out_of_scope");
    expect(forbidden).toMatchObject({ name: "ScopeForbiddenError", code: "funnel_out_of_scope", message: ACCESS_ERROR_MESSAGES.funnel_out_of_scope });
    const pending = new ScopeSnapshotNotReadyError("stale");
    expect(pending).toMatchObject({ name: "ScopeSnapshotNotReadyError", reason: "stale", message: ACCESS_ERROR_MESSAGES.scope_snapshot_not_ready });
  });
});

describe("validation of identifiers", () => {
  const scope = () => createRestrictedScopeSql(context("selected"), snapshot());

  it("aliases", () => {
    for (const alias of ["a", "fc", "_x", `a${"b".repeat(30)}`]) expect(() => txFrom(scope(), alias), alias).not.toThrow();
    for (const alias of ["A", "1a", "a b", "a;", "a.b", `a${"b".repeat(31)}`, "a)"]) {
      expect(() => txFrom(scope(), alias), alias).toThrow(/alias/);
      expect(() => txFrom(ALL_SCOPE_SQL, alias), `${alias} (all)`).toThrow(/alias/);
    }
  });

  it("trialUtmIn columns and prefixes", () => {
    for (const column of ["fc.trial_transaction_id", "trial_transaction_id", "_c.x1"]) {
      expect(() => trialUtmIn(scope(), column, ["fb"], "mmbutm", {}), column).not.toThrow();
    }
    for (const column of ["fc.x.y", "1x", "x;drop", "x)", "Fc.x", ""]) {
      expect(() => trialUtmIn(ALL_SCOPE_SQL, column, ["fb"], "mmbutm", {}), column).toThrow(/column/);
    }
    for (const prefix of ["a-b", "", "A", "p q"]) {
      expect(() => trialUtmIn(ALL_SCOPE_SQL, "fc.x", ["fb"], prefix, {}), prefix).toThrow(/prefix/);
    }
  });

  it("values are hex literals", () => {
    expect(sqlStringLiteral("a'b")).toBe("unhex('612762')");
    expect(sqlStringLiteral("тест")).toBe("unhex('d182d0b5d181d182')");
    expect(sqlStringLiteral("")).toBe("unhex('')");
  });
});

describe("handles and the private registry", () => {
  it("only handles created by the module are accepted", () => {
    const forged = Object.freeze({ restricted: false, paths: null, snapshot: null }) as unknown as ScopeSql;
    for (const call of [() => txFrom(forged), () => scopePaths(forged), () => intersectIncludePaths(forged, []), () => assertKeyPathInScope(forged, "x")]) {
      expect(call).toThrow(/not created by scopeSql/);
    }
    const scope = createRestrictedScopeSql(context("selected"), snapshot());
    expect(Object.isFrozen(scope)).toBe(true);
    expect(() => txFrom({ ...scope } as ScopeSql)).toThrow(/not created by scopeSql/);
  });

  it("restricted handles are built only for issued, restricted contexts", () => {
    const ctx = context("selected");
    expect(() => createRestrictedScopeSql({ ...ctx } as AccessContext, null)).toThrow(/issued AccessContext/);
    expect(() => createRestrictedScopeSql(context("all"), null)).toThrow(/restricted contexts only/);
    expect(() => createRestrictedScopeSql(buildCronAccessContext({ tenantKey: DATA_KEY, requestId: "cron" }), null)).toThrow(/restricted contexts only/);
  });

  it("masks this context's fragments (longest first, every occurrence) and nothing of another context's", () => {
    const ctxA = context("selected");
    const ctxB = context("selected");
    const scopeA = createRestrictedScopeSql(ctxA, snapshot());
    const scopeB = createRestrictedScopeSql(ctxB, snapshot());
    const fb = fbFrom(scopeA, "campaign", "f");
    const tx = txFrom(scopeA, "a");
    const sql = `SELECT 1 FROM ${fb} JOIN ${tx} ON 1 UNION ALL SELECT 1 FROM ${tx}`;
    const masked = maskScopeFragments(ctxA, sql);
    expect(masked).toBe("SELECT 1 FROM  __sf__  JOIN  __sf__  ON 1 UNION ALL SELECT 1 FROM  __sf__ ");
    expect(masked).not.toMatch(/fact_|analytics_transactions/);
    // Another context masks only what IT registered: nothing yet, then exactly
    // the identical txFrom text it produces itself — never A's FB fragment.
    expect(maskScopeFragments(ctxB, sql)).toBe(sql);
    txFrom(scopeB, "a");
    expect(maskScopeFragments(ctxB, sql)).not.toContain(tx);
    expect(maskScopeFragments(ctxB, sql)).toContain("fact_facebook_stats");
    // A context with nothing registered, and ALL-scope text, pass through.
    expect(maskScopeFragments(context("selected"), sql)).toBe(sql);
    expect(maskScopeFragments(ctxA, "SELECT 1 FROM analytics_transactions FINAL")).toBe("SELECT 1 FROM analytics_transactions FINAL");
  });

  it("masks longest first: VIS, registered before the FB fragment that contains it, does not break it", () => {
    const ctx = context("selected");
    const scope = createRestrictedScopeSql(ctx, snapshot());
    const vis = campaignScopeVisibleFrom(scope);
    const fb = fbFrom(scope, "campaign");
    expect(fb).toContain(vis);
    expect(maskScopeFragments(ctx, `SELECT 1 FROM ${fb} WHERE campaign_id IN ${vis}`)).toBe("SELECT 1 FROM  __sf__  WHERE campaign_id IN  __sf__ ");
  });

  it("every registered fragment is a closed (SELECT …) subquery, so outside text never reaches its WHERE (security review R7)", () => {
    const ctx = context("selected");
    const scope = createRestrictedScopeSql(ctx, snapshot());
    const fragments = [
      txFrom(scope, "a"), txFrom(scope), cohortsFrom(scope, "fc"), cohortsFrom(scope), txEmailMatchedFrom(scope, "a"),
      campaignScopeVisibleFrom(scope), fbFrom(scope, "campaign", "f"), fbFrom(scope, "ad"), supportEmailsFrom(scope),
    ];
    for (const fragment of fragments) {
      expect(fragment, fragment).toMatch(/^\(SELECT .*\)( AS [a-z_]+)?$/);
      expect(maskScopeFragments(ctx, fragment)).toBe(" __sf__ ");
    }
    // VIS used to be a bare SELECT: `(${vis} OR status = 'mixed')` widened its WHERE
    // and still masked clean. Now the appended text sits outside the closed unit…
    const vis = campaignScopeVisibleFrom(scope);
    expect(maskScopeFragments(ctx, `SELECT campaign_id FROM (${vis} OR status = 'mixed')`)).toBe("SELECT campaign_id FROM ( __sf__  OR status = 'mixed')");
    // …and splicing it INTO the fragment leaves fact_campaign_scope unmasked.
    expect(maskScopeFragments(ctx, `SELECT campaign_id FROM ${vis.slice(0, -1)} OR status = 'mixed')`)).toContain("fact_campaign_scope");
    // The presence probe is a statement: only its closed inner subquery is registered.
    expect(maskScopeFragments(ctx, presenceProbeSql(scope, "fact_subscriptions"))).toBe("SELECT count() AS c FROM  __sf__  FORMAT JSONEachRow");
  });

  it("ALL-scope helpers register nothing", () => {
    const ctx = context("selected");
    createRestrictedScopeSql(ctx, snapshot());
    const owner = `SELECT 1 FROM ${txFrom(ALL_SCOPE_SQL, "a")} JOIN ${cohortsFrom(ALL_SCOPE_SQL, "fc")} ON 1`;
    expect(maskScopeFragments(ctx, owner)).toBe(owner);
  });
});

describe("column lists (M15)", () => {
  it("TX_COLS are analytics_transactions columns without the raw payloads", () => {
    const columns = new Set(columnsOf(CREATE_ANALYTICS_TRANSACTIONS_SQL));
    expect(columns.size).toBeGreaterThan(40);
    for (const column of TX_COLS) expect(columns.has(column), column).toBe(true);
    expect(TX_COLS).not.toContain("raw_payload");
    expect(TX_COLS).not.toContain("normalized_payload");
    expect(TX_COLS).toContain("media_buyer");
    expect(new Set(TX_COLS).size).toBe(TX_COLS.length);
  });

  it("FC_COLS / FB_COLS are every column of their table", () => {
    expect([...FC_COLS].sort()).toEqual(columnsOf(CREATE_FACT_USER_COHORTS_SQL).sort());
    expect([...FB_COLS].sort()).toEqual(columnsOf(CREATE_FACT_FACEBOOK_STATS_SQL).sort());
    expect(FB_COLS).toContain("raw_payload");
  });

  it("are frozen", () => {
    for (const list of [TX_COLS, FC_COLS, FB_COLS]) expect(Object.isFrozen(list)).toBe(true);
  });
});
