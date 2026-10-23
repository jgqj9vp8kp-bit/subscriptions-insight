import { describe, expect, it } from "vitest";
import {
  AGGREGATE_MEASURES,
  CohortRequestError,
  normalizeAction,
  normalizeCohortRequest,
  buildDynamicCohortEmailQuery,
  buildFilterOptionsQuery,
  buildListQuery,
  classifierSQL,
  cohortDetailsSelects,
  emailTokenSQL,
  runCohortDetails,
  toAggregateRow,
  computeTotals,
  supportDataStatus,
  emailMatchedTokenPurchases,
  tokenDiagnosticsFromRows,
} from "../../supabase/functions/_shared/clickhouse/cohorts.ts";
import {
  DYNAMIC_TRIAL_TEST,
  oneOffTypingSql,
  priceSignalSql,
  upsellPricePointsCte,
} from "../../supabase/functions/_shared/clickhouse/monetizationTyping.ts";
import { ALL_SCOPE_SQL } from "../../supabase/functions/_shared/clickhouse/scopeSql.ts";
import type { CohortAggregateRow } from "../../supabase/functions/_shared/clickhouse/cohortContract.ts";
import type { ClickHouseClientLike } from "../../supabase/functions/_shared/clickhouse/types.ts";

describe("clickhouse-cohorts request validation", () => {
  it("normalizes action names and legacy aliases", () => {
    expect(normalizeAction(undefined)).toBe("list");
    expect(normalizeAction("list")).toBe("list");
    expect(normalizeAction("cohorts")).toBe("list");
    expect(normalizeAction("details")).toBe("details");
    expect(normalizeAction("cohort_details")).toBe("details");
    expect(normalizeAction("options")).toBe("options");
    expect(normalizeAction("filter_options")).toBe("options");
  });

  it("rejects unknown actions", () => {
    expect(() => normalizeAction("drop_table")).toThrow(CohortRequestError);
  });

  it("rejects malformed dates", () => {
    expect(() => normalizeCohortRequest({ date_from: "2026/01/01" })).toThrow(CohortRequestError);
    expect(() => normalizeCohortRequest({ date_to: "not-a-date" })).toThrow(CohortRequestError);
    expect(normalizeCohortRequest({ date_from: "2026-01-01", date_to: "2026-02-01" }).dateFrom).toBe("2026-01-01");
  });

  it("sanitizes filter arrays (trim, dedupe, drop empties)", () => {
    const nreq = normalizeCohortRequest({ filters: { funnel: [" soulmate ", "soulmate", "", "past_life"] } });
    expect(nreq.filters.funnel).toEqual(["soulmate", "past_life"]);
  });

  it("normalizes refund_status", () => {
    expect(normalizeCohortRequest({ filters: { refund_status: "has" } }).filters.refund_status).toBe("has");
    expect(normalizeCohortRequest({ filters: { refund_status: "bogus" as never } }).filters.refund_status).toBe("all");
  });

  it("rejects non-array filters", () => {
    expect(() => normalizeCohortRequest({ filters: { funnel: "soulmate" as never } })).toThrow(CohortRequestError);
  });

  it("caps oversized filter lists", () => {
    const many = Array.from({ length: 501 }, (_, i) => `v${i}`);
    expect(() => normalizeCohortRequest({ filters: { campaign_id: many } })).toThrow(CohortRequestError);
  });
});

describe("clickhouse-cohorts SQL safety and scoping", () => {
  it("always scopes by auth_user_id via a bound parameter", () => {
    const nreq = normalizeCohortRequest({});
    const params: Record<string, unknown> = { auth_user_id: "user-1" };
    const sql = buildListQuery(nreq, params);
    expect(sql).toContain("a.auth_user_id = {auth_user_id:String}");
    expect(params.auth_user_id).toBe("user-1");
  });

  it("keeps classifier columns unqualified after joining cohort identity", () => {
    const nreq = normalizeCohortRequest({});
    const sql = buildListQuery(nreq, { auth_user_id: "user-1" });
    expect(sql).not.toContain("SELECT e.*");
    expect(sql).toContain("SELECT e.uid uid, e.tid tid");
    expect(sql).toContain("FROM pretyped p LEFT JOIN lifeidx li USING(uid, tid)");
  });

  it("binds filter values as parameters — never interpolates raw input", () => {
    const malicious = "soulmate' OR '1'='1";
    const nreq = normalizeCohortRequest({ filters: { funnel: [malicious] } });
    const params: Record<string, unknown> = { auth_user_id: "user-1" };
    const sql = buildListQuery(nreq, params);
    // The raw value must appear ONLY in query_params, never in the SQL text.
    expect(sql).not.toContain(malicious);
    expect(sql).toMatch(/funnel IN \(\{p_fn_0:String\}\)/);
    expect(Object.values(params)).toContain(malicious);
  });

  it("never exposes raw payloads, emails, or transaction ids in the response shape", () => {
    const nreq = normalizeCohortRequest({ filters: { media_buyer: ["Ivan"], currency: ["USD"] } });
    const sql = buildListQuery(nreq, { auth_user_id: "user-1" });
    expect(sql).not.toMatch(/raw_payload/);
    // normalized_payload may be read internally for traffic_source attribution,
    // but it is never selected out of the aggregate response.
    expect(sql).toMatch(/JSONExtractString\(a\.normalized_payload, 'traffic_source'\)/);
    // The SELECT list exposes only aggregates — no email / transaction_id columns leak out.
    expect(sql).not.toMatch(/SELECT[^;]*\bemail\b/i);
  });

  it("applies media_buyer and currency filters with bound params", () => {
    const nreq = normalizeCohortRequest({ filters: { media_buyer: ["Ivan", "Artem A"], currency: ["MXN"] } });
    const params: Record<string, unknown> = { auth_user_id: "u" };
    const sql = buildListQuery(nreq, params);
    expect(sql).toContain("u_media_buyer IN ({p_mb_0:String}, {p_mb_1:String})");
    expect(sql).toContain("keep AS (");
    expect(params.p_mb_0).toBe("Ivan");
    expect(params.p_cur_0).toBe("MXN");
  });

  it("applies attributed campaign, traffic, country and card filters after classification", () => {
    const nreq = normalizeCohortRequest({
      filters: {
        campaign_id: ["cmp-1"],
        traffic_source: ["facebook"],
        country: ["US"],
        card_type: ["credit"],
      },
    });
    const params: Record<string, unknown> = { auth_user_id: "u" };
    const sql = buildListQuery(nreq, params);
    expect(sql).toContain("c_campaign_id IN ({p_cid_0:String})");
    expect(sql).toContain("c_traffic_source IN ({p_tsrc_0:String})");
    expect(sql).toContain("u_country IN ({p_country_0:String})");
    expect(sql).toContain("u_card_type IN ({p_card_0:String})");
    // The aggregate reads finx (fin + email-matched token rows, item 3) and the
    // member filters still apply AFTER classification, at the aggregate level.
    expect(sql).toContain("FROM finx\nWHERE");
    expect(params.p_cid_0).toBe("cmp-1");
    expect(params.p_tsrc_0).toBe("facebook");
    expect(params.p_country_0).toBe("US");
    expect(params.p_card_0).toBe("credit");
  });

  it("emits date/funnel/refund post-filters as HAVING", () => {
    const nreq = normalizeCohortRequest({ date_from: "2026-01-01", date_to: "2026-03-01", filters: { refund_status: "has" } });
    const params: Record<string, unknown> = { auth_user_id: "u" };
    const sql = buildListQuery(nreq, params);
    expect(sql).toContain("cohort_date >= {date_from:String}");
    expect(sql).toContain("cohort_date <= {date_to:String}");
    expect(sql).toContain("refund_raw > 0");
  });

  // The funnel exclusion switch: excluded paths are a parameterized NOT IN in
  // the same HAVING wrapper the include-filter uses, so the row list and every
  // total derived from it drop the switched-off funnels server-side.
  it("emits campaign_path_exclude as a parameterized NOT IN post-filter", () => {
    const nreq = normalizeCohortRequest({ filters: { campaign_path_exclude: ["soulmate-sketch-es", "tt-test"] } });
    const params: Record<string, unknown> = { auth_user_id: "u" };
    const sql = buildListQuery(nreq, params);
    expect(sql).toContain("campaign_path NOT IN ({p_cpx_0:String}, {p_cpx_1:String})");
    expect(params.p_cpx_0).toBe("soulmate-sketch-es");
    expect(params.p_cpx_1).toBe("tt-test");
    // No exclusions -> no clause at all (the classifier's own NOT INs remain).
    const clean = buildListQuery(normalizeCohortRequest({}), { auth_user_id: "u" });
    expect(clean).not.toContain("campaign_path NOT IN");
  });

  it("adds Support metrics with a deduped email semi-join, not a many-to-many join", () => {
    const nreq = normalizeCohortRequest({});
    const sql = buildListQuery(nreq, { auth_user_id: "u" });
    expect(sql).toContain("support_emails AS");
    expect(sql).toContain("SELECT DISTINCT lowerUTF8(trim(BOTH ' ' FROM normalized_email))");
    expect(sql).toContain("FROM fact_support_requests FINAL");
    expect(sql).toContain("uniqExactIf(");
    expect(sql).toContain("uid,");
    expect(sql).toContain("IN (SELECT normalized_email FROM support_emails)");
    expect(sql).not.toMatch(/JOIN\s+fact_support_requests/i);
  });

  it("keeps Cohorts on ClickHouse when Support data is empty or unavailable", () => {
    const nreq = normalizeCohortRequest({});
    const sql = buildListQuery(nreq, { auth_user_id: "u" }, "empty_source");
    expect(sql).toContain("support_emails AS (SELECT '' AS normalized_email WHERE 0)");
    expect(sql).not.toContain("FROM fact_support_requests FINAL");
    expect(sql).toContain("uniqExactIf(");
  });
});

function rawAgg(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cohort_date: "2026-05-01", funnel: "soulmate", campaign_path: "unknown", trial_users: 100,
    gross_raw: 1000.005, refund_raw: 50, d0_raw: 200, d7_raw: 600, d14_raw: 700, d30_raw: 800, d60_raw: 900,
    trial_rev_raw: 80, first_sub_rev_raw: 500, renewal_rev_raw: 250, upsell_rev_raw: 120,
    first_subscription_users: 40, renewal_users: 12, r2: 8, r3: 3, r4: 1, r5: 0, r6: 0,
    upsell_users: 20, funnel_upsell_users: 20, funnel_upsell_rev_raw: 130,
    upsell_1_users: 18, upsell_2_users: 2, upsell_3_users: 0, upsell_extra_users: 0,
    u1_raw: 120, u2_raw: 10, u3_raw: 0, uextra_raw: 0,
    token_purchases: 5, token_buyers: 4, token_gross_raw: 30, token_refund_raw: 5,
    refund_users: 3, support_users: 8, ...over,
  };
}

describe("clickhouse-cohorts aggregate mapping + totals", () => {
  it("produces refund_users in SQL — the legacy rule (any post-anchor refund amount)", () => {
    // Regression: toAggregateRow always read refund_users, but the measure was
    // missing from AGGREGATE_MEASURES, so refund_users/refund_rate were
    // structurally ZERO on both ClickHouse paths (only amount_refunded was
    // real). The rule mirrors the legacy engine: userRefundAmount > 0.
    expect(AGGREGATE_MEASURES).toContain("uniqExactIf(uid, rr > 0) refund_users");
  });

  it("rounds money half-up and computes addon = u1+u2+u3+token_net", () => {
    const row = toAggregateRow(rawAgg() as never);
    expect(row.gross_revenue).toBe(1000.01); // 1000.005 -> half-up
    expect(row.net_revenue).toBe(950.01);
    expect(row.token_net_revenue).toBe(25); // 30 - 5
    expect(row.addon_revenue).toBe(155); // 120 + 10 + 0 + 25
    expect(row.renewal_users_by_level).toEqual({ 2: 8, 3: 3, 4: 1 });
    expect(row.support_users).toBe(8);
    expect(row.support_rate).toBe(8);
    // Subscription metrics stay 0 (deferred, not zero-proven).
    expect(row.active_users).toBe(0);
    expect(row.net_revenue_1m).toBe(row.revenue_d30);
  });

  it("recomputes totals additively (never averages rows)", () => {
    const a = toAggregateRow(rawAgg({ cohort_date: "2026-05-01" }) as never);
    const b = toAggregateRow(rawAgg({ cohort_date: "2026-05-02", trial_users: 50, r2: 2 }) as never);
    const totals = computeTotals([a, b] as CohortAggregateRow[]);
    expect(totals.trial_users).toBe(150);
    expect(totals.support_users).toBe(16);
    expect(totals.support_rate).toBeCloseTo((16 / 150) * 100, 8);
    expect(totals.renewal_users_by_level[2]).toBe(10); // 8 + 2
    expect(totals.gross_revenue).toBe(2000.02);
    // Weighted LTV = sum(d30) / sum(trial_users), not an average of per-row LTVs.
    expect(totals.ltv_1m_per_user).toBe(Math.floor((1600 / 150) * 100 + 0.5) / 100);
  });

  it("handles Support Users = 0 and Trial Users = 0 safely", () => {
    const row = toAggregateRow(rawAgg({ trial_users: 0, support_users: 4 }) as never);
    const zero = toAggregateRow(rawAgg({ trial_users: 50, support_users: 0 }) as never);
    const totals = computeTotals([row, zero] as CohortAggregateRow[]);
    expect(row.support_users).toBe(4);
    expect(row.support_rate).toBe(0);
    expect(zero.support_rate).toBe(0);
    expect(totals.support_users).toBe(4);
    expect(totals.support_rate).toBe(8);
  });
});

describe("clickhouse-cohorts support data status", () => {
  function clientFor(rowsByQuery: Array<unknown[]>): { query: () => Promise<{ json: () => Promise<unknown[]> }> } {
    let i = 0;
    return {
      query: async () => {
        const rows = rowsByQuery[i++] ?? [];
        return { json: async () => rows };
      },
    };
  }

  it("reports ready with support request and unique email counts", async () => {
    const status = await supportDataStatus(clientFor([[{ c: 1 }], [{ support_requests: 3, support_unique_emails: 2 }]]) as never, "u");
    expect(status).toEqual({ support_data_status: "ready", support_requests: 3, support_unique_emails: 2 });
  });

  // Phase 0 (access control): the probe used to fall back to a count over
  // EVERY tenant's support rows to report "sync_pending". That cross-tenant
  // read is gone — a tenant without support rows is empty_source, whatever
  // other tenants hold, and no query runs without the tenant predicate.
  it("reports empty_source and unavailable without throwing, never reading other tenants", async () => {
    const queries: Array<{ query: string; query_params?: Record<string, unknown> }> = [];
    const rows: Array<unknown[]> = [[{ c: 1 }], [{ support_requests: 0, support_unique_emails: 0 }], [{ c: 9 }]];
    const recording = {
      query: async (input: { query: string; query_params?: Record<string, unknown> }) => {
        queries.push(input);
        const result = rows[queries.length - 1] ?? [];
        return { json: async () => result };
      },
    };
    await expect(supportDataStatus(recording as never, "u")).resolves.toEqual({
      support_data_status: "empty_source",
      support_requests: 0,
      support_unique_emails: 0,
    });
    expect(queries).toHaveLength(2);
    expect(queries[0].query).toContain("system.tables");
    expect(queries[1].query).toContain("WHERE auth_user_id = {auth_user_id:String}");
    expect(queries[1].query_params).toEqual({ auth_user_id: "u" });
    await expect(supportDataStatus({ query: async () => { throw new Error("no table"); } } as never, "u"))
      .resolves.toMatchObject({ support_data_status: "unavailable" });
  });
});

describe("email-matched token revenue in the dynamic engine (TODO_MONETIZATION item 3)", () => {
  it("unions email-matched token rows into the aggregate via finx", () => {
    const nreq = normalizeCohortRequest({});
    const params: Record<string, unknown> = { auth_user_id: "u" };
    const sql = buildListQuery(nreq, params);
    expect(sql).toContain("cemail AS");
    expect(sql).toContain("etok AS");
    expect(sql).toContain("finx AS");
    // Only non-members are email-attributed; a member's own rows stay uid-keyed.
    expect(sql).toContain("b.uid NOT IN (SELECT uid FROM tr)");
    // Exact predicate — the warehouse stores the client-classified type.
    expect(sql).toContain("b.ttype = 'token_purchase'");
    // Email rows can never enter the lifecycle/upsell sequences.
    expect(sql).toContain("0 lvl, 0 slot");
    // Same pre-trial cut as the client accumulation (dt < 0 -> skip).
    expect(sql).toContain("floor((b.ets - tr.trial_ts) / 86400000) >= 0");
    // The aggregate reads the union and counts the email subset for diagnostics.
    expect(sql).toContain("FROM finx");
    expect(sql).toContain("token_email_purchases");
    // Email-matched refund rows count as token refunds even without the price
    // signal; a member refund follows the one-off category of its payment.
    expect(sql).toContain("(ocat = 'token_purchase' OR via_email = 1)");
  });

  it("wires matched_by_email diagnostics to the aggregate email count", () => {
    expect(emailMatchedTokenPurchases([{ token_email_purchases: 2 }, { token_email_purchases: "1" }] as never)).toBe(3);
    const diag = tokenDiagnosticsFromRows([{ token_purchases: 5 } as never], 3);
    expect(diag.token_purchases_total).toBe(5);
    expect(diag.token_purchases_matched).toBe(5);
    expect(diag.token_purchases_matched_by_email).toBe(3);
  });
});

// ---- Token / in-product / funnel upsell split (monetizationTyping.ts) --------

/** Top-level comma split of a SELECT list (commas inside parentheses stay). */
function selectItems(list: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of list) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      items.push(current.trim());
      current = "";
    } else current += char;
  }
  if (current.trim()) items.push(current.trim());
  return items;
}

const aliasOf = (item: string) => item.split(/\s+/).pop()!;

describe("token / in-product upsell split: the dynamic classifier", () => {
  const W = "a.auth_user_id = {auth_user_id:String}";

  it("legacy is the default and carries nothing of the split (the rebuild golden's bytes)", () => {
    const legacy = classifierSQL(W, "");
    expect(classifierSQL(W, "", "legacy")).toBe(legacy);
    expect(legacy).not.toContain("psig");
    expect(legacy).not.toContain("upp AS (");
    expect(legacy).not.toContain("ocat");
    // The literal TABs of the cl CTE are part of the legacy text.
    expect(legacy).toContain("\t    tr.c_campaign_id c_campaign_id, tr.c_traffic_source c_traffic_source,");
  });

  it("price_point mode: upp before base, signals through cl into fin, typed by the rule table", () => {
    const sql = classifierSQL(W, "", "price_point");
    expect(sql.startsWith(`\n${upsellPricePointsCte(ALL_SCOPE_SQL)},\nbase AS (`)).toBe(true);
    expect(sql).toContain(`a.product_name pname,\n    ${priceSignalSql("a")}\n  FROM analytics_transactions AS a FINAL`);
    expect(sql).toContain("e.lifeelig lifeelig,\n    e.pp pp, e.psig psig,");
    expect(sql).toContain(`SELECT *, floor((ets - trial_ts) / 86400000) d,\n    ${oneOffTypingSql(DYNAMIC_TRIAL_TEST)}\n  FROM cl`);
    expect(sql).toContain("p.pname pname, p.pp pp, p.psig psig, p.ocat ocat, p.orule orule,");
  });

  it("the anchor CTEs (elig, tr) are byte-identical in both modes", () => {
    const legacy = classifierSQL(W, "");
    const split = classifierSQL(W, "", "price_point");
    const elig = "elig AS (SELECT *, (statusType = '' AND NOT upmark AND NOT tokenAmt) lifeelig FROM base),";
    expect(legacy).toContain(elig);
    expect(split).toContain(elig);
    const tr = (text: string) => text.slice(text.indexOf("\ntr AS ("), text.indexOf("\nuserdim AS ("));
    expect(tr(split)).toBe(tr(legacy));
    expect(tr(split).length).toBeGreaterThan(100);
  });

  it("the list and details use the split; filter options and the email overlay stay legacy", async () => {
    expect(buildListQuery(normalizeCohortRequest({}), { auth_user_id: "u" })).toContain(classifierSQL(W, "", "price_point"));
    expect(buildFilterOptionsQuery(normalizeCohortRequest({}), {})).toContain(classifierSQL(W, ""));
    expect(buildFilterOptionsQuery(normalizeCohortRequest({}), {})).not.toContain("upp AS (");
    expect(buildDynamicCohortEmailQuery({})).toContain(classifierSQL(W, ""));
    expect(buildDynamicCohortEmailQuery({})).not.toContain("upp AS (");

    const queries: string[] = [];
    const client = {
      query: async (input: { query: string }) => {
        queries.push(input.query);
        return { json: async () => [] };
      },
      command: async () => {},
      insert: async () => {},
    } as unknown as ClickHouseClientLike;
    await runCohortDetails({
      authUserId: "u",
      clickhouse: client,
      request: { action: "details", cohort_key: { cohort_date: "2026-09-01", funnel: "f", campaign_path: "p" } },
    });
    const details = queries.filter((query) => query.includes("scoped AS ("));
    expect(details).toHaveLength(4);
    for (const query of details) expect(query).toContain(classifierSQL(W, "", "price_point"));
  });

  it("emailTokenSQL's finx branches stay positionally aligned (UNION ALL is positional)", () => {
    const sql = emailTokenSQL();
    const fin = sql.slice(sql.indexOf("finx AS (\n  SELECT ") + "finx AS (\n  SELECT ".length, sql.indexOf("\n  FROM fin AS f"));
    const etok = sql.slice(sql.indexOf("UNION ALL\n  SELECT ") + "UNION ALL\n  SELECT ".length, sql.indexOf("\n  FROM etok"));
    const finAliases = selectItems(fin).map(aliasOf);
    const etokAliases = selectItems(etok).map(aliasOf);
    expect(etokAliases).toEqual(finAliases);
    expect(finAliases.slice(-6)).toEqual(["lt", "pp", "psig", "ocat", "orule", "via_email"]);
    // An email-matched row is a token purchase.
    expect(sql).toContain("b.pp pp, b.psig psig, 'token_purchase' ocat, 'email_token' orule");
  });

  it("AGGREGATE_MEASURES: in-product upsell measures, refunds attributed by ocat", () => {
    expect(AGGREGATE_MEASURES).toContain("countIf(is_success = 1 AND lt = 'app_upsell') app_upsell_purchases");
    expect(AGGREGATE_MEASURES).toContain("uniqExactIf(uid, is_success = 1 AND lt = 'app_upsell') app_upsell_buyers");
    expect(AGGREGATE_MEASURES).toContain("sumIf(g, is_success = 1 AND lt = 'app_upsell') app_upsell_gross_raw");
    expect(AGGREGATE_MEASURES).toContain(
      "sumIf(rr, lt = 'app_upsell' OR (statusType IN ('refund','chargeback') AND ocat = 'app_upsell')) app_upsell_refund_raw",
    );
    expect(AGGREGATE_MEASURES).toContain(
      "sumIf(rr, lt = 'token_purchase' OR (statusType IN ('refund','chargeback') AND (ocat = 'token_purchase' OR via_email = 1))) token_refund_raw",
    );
    expect(AGGREGATE_MEASURES).not.toContain("tokenAmt");
    // Funnel upsell metrics stay funnel-only.
    expect(AGGREGATE_MEASURES).toContain("uniqExactIf(uid, is_success = 1 AND lt = 'upsell') upsell_users");
  });

  it("maps the in-product upsell fields; addon = u1 + u2 + u3 + token net + in-product upsell net", () => {
    const row = toAggregateRow(rawAgg({ app_upsell_purchases: 3, app_upsell_buyers: 2, app_upsell_gross_raw: 8.97, app_upsell_refund_raw: 2.99 }) as never);
    expect(row).toMatchObject({ app_upsell_purchases: 3, app_upsell_buyers: 2, app_upsell_gross_revenue: 8.97, app_upsell_net_revenue: 5.98 });
    expect(row.token_net_revenue).toBe(25);
    expect(row.addon_revenue).toBe(160.98); // 120 + 10 + 0 + 25 + 5.98
    // A row without the app fields (cached before the split) maps to zeros.
    expect(toAggregateRow(rawAgg() as never)).toMatchObject({ app_upsell_buyers: 0, app_upsell_purchases: 0, app_upsell_net_revenue: 0, addon_revenue: 155 });

    const other = toAggregateRow(rawAgg({ cohort_date: "2026-05-02", app_upsell_purchases: 1, app_upsell_buyers: 1, app_upsell_gross_raw: 2.99 }) as never);
    const totals = computeTotals([row, other]);
    expect(totals).toMatchObject({ app_upsell_buyers: 3, app_upsell_purchases: 4, app_upsell_gross_revenue: 11.96, app_upsell_net_revenue: 8.97 });
    expect(totals.addon_revenue).toBe(Math.floor((row.addon_revenue + other.addon_revenue) * 100 + 0.5) / 100);
    expect(tokenDiagnosticsFromRows([row, other]).app_upsell_purchases_total).toBe(4);
    expect(tokenDiagnosticsFromRows([row, other]).unknown_products).toEqual([]);
  });

  it("token packs are keyed by price id and priced in their own currency", async () => {
    const token = cohortDetailsSelects().token;
    expect(token).toContain("SELECT if(pid != '', pid, pp) product_id, pname product, cur currency, round(amt, 2) price,");
    expect(token).toContain("WHERE is_success = 1 AND lt = 'token_purchase' GROUP BY product_id, pname, cur, round(amt, 2)");

    const client = {
      query: async (input: { query: string }) => ({
        json: async () => input.query.includes("lt = 'token_purchase' GROUP BY product_id")
          ? [
            { product_id: "price_01M0049J2NX8JWC3EK2FJHEZRN", product: "", currency: "JPY", price: 480, purchases: 2, buyers: 2, gross_revenue: 6.4 },
            { product_id: "", product: "", currency: "", price: 4.99, purchases: 1, buyers: 1, gross_revenue: 4.99 },
          ]
          : [],
      }),
      command: async () => {},
      insert: async () => {},
    } as unknown as ClickHouseClientLike;
    const response = await runCohortDetails({
      authUserId: "u",
      clickhouse: client,
      request: { action: "details", cohort_key: { cohort_date: "2026-09-01", funnel: "f", campaign_path: "p" } },
    });
    expect(response.token_pack_breakdown[0]).toMatchObject({ product_id: "price_01M0049J2NX8JWC3EK2FJHEZRN", product: "Token JPY 480.00", currency: "JPY", price: 480 });
    expect(response.token_pack_breakdown[1]).toMatchObject({ product: "Token 4.99", currency: "" });
  });
});
