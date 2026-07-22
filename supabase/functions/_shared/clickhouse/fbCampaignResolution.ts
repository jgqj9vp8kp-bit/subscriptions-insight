// Campaign resolution layers (roadmap rev.2, Wave 3). Mapping is DATA, not code:
//
//   Layer A  facebook_campaign_mapping    observed utm_campaign -> source campaign id
//   Layer B  facebook_campaign_funnel_map source campaign id    -> funnel
//
// Layer B must resolve campaigns with ZERO authoritative users — it feeds
// Model 2 (full funnel spend), which is NOT a rollup of the user-attributed
// allocation engine. Every resolved number carries match_kind provenance:
// a mapped/suggested figure may never look like an exact one.

import type { ClickHouseClientLike, SupabaseLikeClient } from "./types.ts";
import { CONFIRMED_FB_CAMPAIGN_ALIASES } from "./fbSourceClassification.ts";
import { ANALYTICS_TRANSACTIONS_TABLE, FACT_FACEBOOK_STATS_TABLE } from "./schema.ts";

export const FB_CAMPAIGN_MAPPING_TABLE = "facebook_campaign_mapping";
export const FB_CAMPAIGN_FUNNEL_MAP_TABLE = "facebook_campaign_funnel_map";

const ALIAS_SEED_EVIDENCE = {
  source: "fb-campaign-id-mapping-audit",
  audited_at: "2026-07-19",
  method: "one-digit id family + campaign name match, validated against authoritative trials",
} as const;

// ---- Layer A: campaign alias mapping ----------------------------------------

/** Seed the audited confirmed alias pairs into the mapping table (idempotent:
 * pairs that already have an active row are skipped). The hardcoded fallback in
 * fbSourceClassification stays until decommission; the table is authoritative. */
export async function seedConfirmedCampaignAliases(
  supabase: SupabaseLikeClient,
  authUserId: string,
): Promise<{ inserted: number; existing: number }> {
  const builder = supabase.from(FB_CAMPAIGN_MAPPING_TABLE);
  const { data, error } = await builder
    .select("observed_campaign_id,fb_campaign_id")
    .eq("auth_user_id", authUserId)
    .eq("status", "active");
  if (error) throw new Error(`Could not read campaign mappings: ${error.message}`);
  const existing = new Set(
    ((data ?? []) as Array<{ observed_campaign_id: string; fb_campaign_id: string }>)
      .map((row) => `${row.observed_campaign_id}->${row.fb_campaign_id}`),
  );
  const missing = Object.entries(CONFIRMED_FB_CAMPAIGN_ALIASES)
    .filter(([observed, fb]) => !existing.has(`${observed}->${fb}`))
    .map(([observed, fb]) => ({
      auth_user_id: authUserId,
      observed_campaign_id: observed,
      fb_campaign_id: fb,
      mapping_type: "confirmed_alias",
      confidence: 1,
      evidence: ALIAS_SEED_EVIDENCE,
      created_by: "seed:confirmed-alias-audit",
    }));
  if (missing.length) {
    const insertBuilder = supabase.from(FB_CAMPAIGN_MAPPING_TABLE);
    if (!insertBuilder.insert) throw new Error("Supabase client does not support inserts.");
    const { error: insertError } = await insertBuilder.insert(missing);
    if (insertError) throw new Error(`Could not seed campaign aliases: ${insertError.message}`);
  }
  return { inserted: missing.length, existing: existing.size };
}

/** Active alias pairs: table rows win, the audited hardcode remains as the
 * transition fallback until Phase 6 decommission. */
export async function loadActiveCampaignAliasMap(
  supabase: SupabaseLikeClient,
  authUserId: string,
): Promise<Record<string, string>> {
  const { data, error } = await supabase
    .from(FB_CAMPAIGN_MAPPING_TABLE)
    .select("observed_campaign_id,fb_campaign_id")
    .eq("auth_user_id", authUserId)
    .eq("status", "active");
  if (error) throw new Error(`Could not load campaign mappings: ${error.message}`);
  const map: Record<string, string> = { ...CONFIRMED_FB_CAMPAIGN_ALIASES };
  for (const row of (data ?? []) as Array<{ observed_campaign_id: string; fb_campaign_id: string }>) {
    if (row.observed_campaign_id && row.fb_campaign_id) map[row.observed_campaign_id] = row.fb_campaign_id;
  }
  return map;
}

// ---- Layer B: campaign -> funnel --------------------------------------------

export interface CampaignFunnelResolution {
  funnel: string;
  match_kind: "confirmed" | "suggested";
  evidence_source: string;
  confidence: number | null;
}

/** Active funnel resolutions per campaign. A confirmed row always wins; among
 * suggested rows the highest confidence wins (funnel name breaks ties). */
export async function loadActiveCampaignFunnelMap(
  supabase: SupabaseLikeClient,
  authUserId: string,
): Promise<Record<string, CampaignFunnelResolution>> {
  const { data, error } = await supabase
    .from(FB_CAMPAIGN_FUNNEL_MAP_TABLE)
    .select("fb_campaign_id,funnel,match_kind,evidence_source,confidence")
    .eq("auth_user_id", authUserId)
    .eq("status", "active");
  if (error) throw new Error(`Could not load the campaign funnel map: ${error.message}`);
  const map: Record<string, CampaignFunnelResolution> = {};
  for (const row of (data ?? []) as Array<CampaignFunnelResolution & { fb_campaign_id: string }>) {
    if (!row.fb_campaign_id || !row.funnel) continue;
    const current = map[row.fb_campaign_id];
    const candidate: CampaignFunnelResolution = {
      funnel: row.funnel,
      match_kind: row.match_kind === "confirmed" ? "confirmed" : "suggested",
      evidence_source: String(row.evidence_source ?? "manual"),
      confidence: typeof row.confidence === "number" ? row.confidence : null,
    };
    if (!current) {
      map[row.fb_campaign_id] = candidate;
      continue;
    }
    if (current.match_kind === "confirmed") continue;
    if (candidate.match_kind === "confirmed") {
      map[row.fb_campaign_id] = candidate;
      continue;
    }
    const currentScore = current.confidence ?? 0;
    const candidateScore = candidate.confidence ?? 0;
    if (candidateScore > currentScore || (candidateScore === currentScore && candidate.funnel < current.funnel)) {
      map[row.fb_campaign_id] = candidate;
    }
  }
  return map;
}

// ---- Layer B evidence collector ---------------------------------------------

export interface CampaignFunnelSuggestion {
  fb_campaign_id: string;
  funnel: string;
  match_kind: "confirmed" | "suggested";
  evidence_source: "campaign_path" | "name_rule";
  confidence: number;
  evidence: Record<string, unknown>;
}

export const FUNNEL_EVIDENCE_MIN_USERS = 3;

/** Pure evidence builder (rev.2 ladder, the automatable rungs):
 *  - stable funnel across ALL of a campaign's authoritative trial users
 *    (>= minUsers, single non-unknown funnel) -> CONFIRMED via campaign_path;
 *  - a known funnel token inside the campaign name -> SUGGESTED via name_rule
 *    (never confirmed — enforced here AND by the table CHECK constraint).
 * Campaigns that already have an active confirmed resolution are skipped. */
export function buildCampaignFunnelSuggestions(input: {
  authoritative: Array<{ campaign_id: string; funnel: string; users: number }>;
  campaignNames: Array<{ campaign_id: string; campaign_name: string }>;
  existing: Record<string, CampaignFunnelResolution>;
  knownFunnels: readonly string[];
  minUsers?: number;
}): CampaignFunnelSuggestion[] {
  const minUsers = input.minUsers ?? FUNNEL_EVIDENCE_MIN_USERS;
  const suggestions: CampaignFunnelSuggestion[] = [];
  const suggestedCampaigns = new Set<string>();

  const byCampaign = new Map<string, Array<{ funnel: string; users: number }>>();
  for (const row of input.authoritative) {
    const id = row.campaign_id?.trim();
    if (!id) continue;
    const list = byCampaign.get(id) ?? [];
    list.push({ funnel: row.funnel, users: row.users });
    byCampaign.set(id, list);
  }

  for (const [campaignId, rows] of byCampaign) {
    if (input.existing[campaignId]?.match_kind === "confirmed") continue;
    const meaningful = rows.filter((row) => row.funnel && row.funnel !== "unknown");
    const funnels = new Set(meaningful.map((row) => row.funnel));
    const users = meaningful.reduce((total, row) => total + row.users, 0);
    if (funnels.size !== 1 || users < minUsers) continue;
    const funnel = [...funnels][0];
    suggestions.push({
      fb_campaign_id: campaignId,
      funnel,
      match_kind: "confirmed",
      evidence_source: "campaign_path",
      confidence: 1,
      evidence: { users, distinct_funnels: 1, method: "stable funnel across authoritative trial users" },
    });
    suggestedCampaigns.add(campaignId);
  }

  for (const { campaign_id, campaign_name } of input.campaignNames) {
    const id = campaign_id?.trim();
    if (!id || suggestedCampaigns.has(id) || input.existing[id]) continue;
    const name = (campaign_name ?? "").toLowerCase();
    const matches = input.knownFunnels.filter((funnel) => name.includes(funnel.toLowerCase().replace(/_/g, "-")) || name.includes(funnel.toLowerCase().replace(/_/g, " ")) || name.includes(funnel.toLowerCase()));
    if (matches.length !== 1) continue; // ambiguous or no token — no suggestion
    suggestions.push({
      fb_campaign_id: id,
      funnel: matches[0],
      match_kind: "suggested",
      evidence_source: "name_rule",
      confidence: 0.5,
      evidence: { campaign_name, matched_token: matches[0] },
    });
    suggestedCampaigns.add(id);
  }

  return suggestions.sort((a, b) => a.fb_campaign_id.localeCompare(b.fb_campaign_id));
}

/** ClickHouse inputs for the evidence collector. */
export function funnelEvidenceQueries(): { authoritativeSql: string; namesSql: string } {
  return {
    authoritativeSql: `
      SELECT campaign_id, funnel, uniqExact(user_id) AS users
      FROM ${ANALYTICS_TRANSACTIONS_TABLE} FINAL
      WHERE auth_user_id = {auth_user_id:String}
        AND status = 'success' AND transaction_type = 'trial' AND campaign_id != ''
      GROUP BY campaign_id, funnel
    `,
    namesSql: `
      SELECT campaign_id, argMax(campaign_name, stat_date) AS campaign_name
      FROM ${FACT_FACEBOOK_STATS_TABLE} FINAL
      WHERE auth_user_id = {auth_user_id:String} AND level = 'campaign' AND campaign_id != ''
      GROUP BY campaign_id
    `,
  };
}

export async function insertCampaignFunnelSuggestions(
  supabase: SupabaseLikeClient,
  authUserId: string,
  suggestions: readonly CampaignFunnelSuggestion[],
): Promise<number> {
  if (!suggestions.length) return 0;
  const builder = supabase.from(FB_CAMPAIGN_FUNNEL_MAP_TABLE);
  if (!builder.insert) throw new Error("Supabase client does not support inserts.");
  const { error } = await builder.insert(
    suggestions.map((suggestion) => ({
      auth_user_id: authUserId,
      fb_campaign_id: suggestion.fb_campaign_id,
      funnel: suggestion.funnel,
      match_kind: suggestion.match_kind,
      evidence_source: suggestion.evidence_source,
      confidence: suggestion.confidence,
      evidence: suggestion.evidence,
      created_by: "collector:funnel-evidence",
    })),
  );
  if (error) throw new Error(`Could not insert funnel suggestions: ${error.message}`);
  return suggestions.length;
}

// ---- Model 2: full funnel spend ---------------------------------------------

export interface CampaignPeriodSpendRow {
  campaign_id: string;
  campaign_name: string;
  spend: number;
  fb_purchases: number;
}

export function campaignPeriodSpendSql(filters: { hasFrom: boolean; hasTo: boolean }): string {
  const dateWhere = [
    filters.hasFrom ? "AND stat_date >= {date_from:String}" : "",
    filters.hasTo ? "AND stat_date <= {date_to:String}" : "",
  ].join("\n        ");
  return `
      SELECT campaign_id,
        argMax(campaign_name, stat_date) AS campaign_name,
        round(sum(spend), 2) AS spend,
        sum(fb_purchases) AS fb_purchases
      FROM ${FACT_FACEBOOK_STATS_TABLE} FINAL
      WHERE auth_user_id = {auth_user_id:String} AND level = 'campaign' AND campaign_id != ''
        ${dateWhere}
      GROUP BY campaign_id
    `;
}

export interface FunnelSpendRow {
  funnel: string;
  spend: number;
  fb_purchases: number;
  campaigns: number;
  confirmed_spend: number;
  suggested_spend: number;
}

export interface FunnelSpendResult {
  funnels: FunnelSpendRow[];
  unknown_funnel: { spend: number; fb_purchases: number; campaigns: number };
  campaigns: Array<CampaignPeriodSpendRow & { funnel: string | null; match_kind: string | null; evidence_source: string | null }>;
  totals: {
    source_spend: number;
    funnel_resolved_spend: number;
    unknown_funnel_spend: number;
    resolved_campaigns: number;
    unresolved_campaigns: number;
  };
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

/** Model 2: source campaign spend -> funnel via Layer B. INCLUDES zero-user
 * campaigns by construction (the input is the spend side, not the user side).
 * source_spend === funnel_resolved_spend + unknown_funnel_spend always holds;
 * nothing here is ever forced to match the user-attributed allocation. */
export function computeFunnelSpend(input: {
  campaignSpend: readonly CampaignPeriodSpendRow[];
  funnelMap: Record<string, CampaignFunnelResolution>;
}): FunnelSpendResult {
  const funnelRows = new Map<string, FunnelSpendRow>();
  const unknown = { spend: 0, fb_purchases: 0, campaigns: 0 };
  const campaigns: FunnelSpendResult["campaigns"] = [];
  let resolvedSpend = 0;

  for (const row of input.campaignSpend) {
    const resolution = input.funnelMap[row.campaign_id] ?? null;
    campaigns.push({
      ...row,
      funnel: resolution?.funnel ?? null,
      match_kind: resolution?.match_kind ?? null,
      evidence_source: resolution?.evidence_source ?? null,
    });
    if (!resolution) {
      unknown.spend = round2(unknown.spend + row.spend);
      unknown.fb_purchases += row.fb_purchases;
      unknown.campaigns += 1;
      continue;
    }
    resolvedSpend += row.spend;
    const funnelRow = funnelRows.get(resolution.funnel) ?? {
      funnel: resolution.funnel,
      spend: 0,
      fb_purchases: 0,
      campaigns: 0,
      confirmed_spend: 0,
      suggested_spend: 0,
    };
    funnelRow.spend = round2(funnelRow.spend + row.spend);
    funnelRow.fb_purchases += row.fb_purchases;
    funnelRow.campaigns += 1;
    if (resolution.match_kind === "confirmed") funnelRow.confirmed_spend = round2(funnelRow.confirmed_spend + row.spend);
    else funnelRow.suggested_spend = round2(funnelRow.suggested_spend + row.spend);
    funnelRows.set(resolution.funnel, funnelRow);
  }

  const sourceSpend = round2(input.campaignSpend.reduce((total, row) => total + row.spend, 0));
  return {
    funnels: [...funnelRows.values()].sort((a, b) => b.spend - a.spend),
    unknown_funnel: unknown,
    campaigns: campaigns.sort((a, b) => b.spend - a.spend),
    totals: {
      source_spend: sourceSpend,
      funnel_resolved_spend: round2(resolvedSpend),
      unknown_funnel_spend: unknown.spend,
      resolved_campaigns: campaigns.filter((row) => row.funnel != null).length,
      unresolved_campaigns: unknown.campaigns,
    },
  };
}

export async function runFunnelSpend(input: {
  clickhouse: ClickHouseClientLike;
  supabase: SupabaseLikeClient;
  authUserId: string;
  dateFrom?: string | null;
  dateTo?: string | null;
}): Promise<FunnelSpendResult> {
  const params: Record<string, unknown> = { auth_user_id: input.authUserId };
  if (input.dateFrom) params.date_from = input.dateFrom;
  if (input.dateTo) params.date_to = input.dateTo;
  const sql = campaignPeriodSpendSql({ hasFrom: Boolean(input.dateFrom), hasTo: Boolean(input.dateTo) });
  const [spendRows, funnelMap] = await Promise.all([
    input.clickhouse
      .query({ query: sql, query_params: params, format: "JSONEachRow" })
      .then(async (rs) => (await rs.json()) as CampaignPeriodSpendRow[]),
    loadActiveCampaignFunnelMap(input.supabase, input.authUserId),
  ]);
  return computeFunnelSpend({
    campaignSpend: spendRows.map((row) => ({
      campaign_id: String(row.campaign_id),
      campaign_name: String(row.campaign_name ?? ""),
      spend: Number(row.spend) || 0,
      fb_purchases: Number(row.fb_purchases) || 0,
    })),
    funnelMap,
  });
}
