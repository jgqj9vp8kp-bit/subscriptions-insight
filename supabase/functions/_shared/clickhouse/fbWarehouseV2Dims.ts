// Warehouse V2 dimension population (SCD2) — the read-cutover prerequisite:
// facts carry only ids; names/buyer live here. Versioning rules:
//  - a new version is opened ONLY when identity attributes change
//    (account: name/buyer/currency; campaign: name/ad account);
//  - first_seen/last_seen are informational (written at version creation,
//    refreshed opportunistically on new versions) and NEVER trigger versioning —
//    otherwise every batch would explode the history;
//  - "closing" a version re-inserts the same (entity, valid_from) key with
//    is_current=0 and valid_to set: the dims are ReplacingMergeTree, so the
//    later insert wins under FINAL. Append-only storage, view-resolved truth —
//    same philosophy as the facts.

import type { ClickHouseClientLike } from "./types.ts";
import { DIM_FB_ACCOUNT_TABLE, DIM_FB_CAMPAIGN_TABLE, ensureFbWarehouseV2Schema } from "./fbWarehouseV2Schema.ts";
import { FACT_FACEBOOK_STATS_TABLE } from "./schema.ts";
import { clickHouseBodyStringSet } from "./fbCohortStats.ts";

export interface FbDimSourceRow {
  level: string;
  stat_date: string;
  ad_account_id: string;
  ad_account_name: string;
  buyer: string;
  currency: string;
  campaign_id: string;
  campaign_name: string;
}

export interface FbAccountDimCandidate {
  ad_account_id: string;
  account_name: string;
  buyer: string;
  currency: string;
}

export interface FbCampaignDimCandidate {
  campaign_id: string;
  ad_account_id: string;
  campaign_name: string;
  first_seen_date: string;
  last_seen_date: string;
}

/** Latest attributes per entity out of a batch's mapped rows (argmax by stat_date). */
export function deriveDimCandidatesFromRows(rows: readonly FbDimSourceRow[]): {
  accounts: FbAccountDimCandidate[];
  campaigns: FbCampaignDimCandidate[];
} {
  const accounts = new Map<string, { stat_date: string } & FbAccountDimCandidate>();
  const campaigns = new Map<string, { stat_date: string } & FbCampaignDimCandidate>();

  for (const row of rows) {
    const accountId = row.ad_account_id?.trim();
    if (accountId) {
      const current = accounts.get(accountId);
      if (!current || row.stat_date >= current.stat_date) {
        accounts.set(accountId, {
          stat_date: row.stat_date,
          ad_account_id: accountId,
          account_name: row.ad_account_name ?? "",
          buyer: row.buyer ?? "",
          currency: row.currency ?? "",
        });
      }
    }
    const campaignId = row.level === "campaign" ? row.campaign_id?.trim() : "";
    if (campaignId) {
      const current = campaigns.get(campaignId);
      if (!current) {
        campaigns.set(campaignId, {
          stat_date: row.stat_date,
          campaign_id: campaignId,
          ad_account_id: row.ad_account_id ?? "",
          campaign_name: row.campaign_name ?? "",
          first_seen_date: row.stat_date,
          last_seen_date: row.stat_date,
        });
      } else {
        if (row.stat_date >= current.stat_date) {
          current.stat_date = row.stat_date;
          current.campaign_name = row.campaign_name ?? current.campaign_name;
          current.ad_account_id = row.ad_account_id || current.ad_account_id;
        }
        if (row.stat_date < current.first_seen_date) current.first_seen_date = row.stat_date;
        if (row.stat_date > current.last_seen_date) current.last_seen_date = row.stat_date;
      }
    }
  }

  return {
    accounts: [...accounts.values()].map(({ stat_date: _s, ...rest }) => rest),
    campaigns: [...campaigns.values()].map(({ stat_date: _s, ...rest }) => rest),
  };
}

interface CurrentAccountVersion {
  ad_account_id: string;
  account_name: string;
  buyer: string;
  currency: string;
  latest_valid_from: string;
}

interface CurrentCampaignVersion {
  campaign_id: string;
  ad_account_id: string;
  campaign_name: string;
  first_seen_date: string;
  latest_valid_from: string;
}

async function jsonRows<T>(client: ClickHouseClientLike, query: string, params: Record<string, unknown>): Promise<T[]> {
  const rs = await client.query({ query, query_params: params, format: "JSONEachRow" });
  return (await rs.json()) as T[];
}

/** SCD2 sync of both dims for one batch. Returns version-churn counters. */
export async function syncFbV2Dims(input: {
  clickhouse: ClickHouseClientLike;
  authUserId: string;
  importBatchId: string;
  nowIso: string;
  accounts: readonly FbAccountDimCandidate[];
  campaigns: readonly FbCampaignDimCandidate[];
}): Promise<{ accounts_opened: number; accounts_closed: number; campaigns_opened: number; campaigns_closed: number }> {
  const counters = { accounts_opened: 0, accounts_closed: 0, campaigns_opened: 0, campaigns_closed: 0 };
  const ch = input.clickhouse;

  if (input.accounts.length) {
    const current = await jsonRows<CurrentAccountVersion>(
      ch,
      `SELECT ad_account_id,
         argMax(account_name, valid_from) AS account_name,
         argMax(buyer, valid_from) AS buyer,
         argMax(currency, valid_from) AS currency,
         toString(max(valid_from)) AS latest_valid_from
       FROM ${DIM_FB_ACCOUNT_TABLE} FINAL
       WHERE auth_user_id = {auth_user_id:String} AND is_current = 1
         AND ad_account_id IN (${clickHouseBodyStringSet(input.accounts.map((account) => account.ad_account_id))})
       GROUP BY ad_account_id`,
      { auth_user_id: input.authUserId },
    );
    const currentById = new Map(current.map((row) => [row.ad_account_id, row]));
    const closes: Record<string, unknown>[] = [];
    const opens: Record<string, unknown>[] = [];
    for (const candidate of input.accounts) {
      const existing = currentById.get(candidate.ad_account_id);
      const changed =
        !existing ||
        existing.account_name !== candidate.account_name ||
        existing.buyer !== candidate.buyer ||
        existing.currency !== candidate.currency;
      if (!changed) continue;
      if (existing) {
        closes.push({
          auth_user_id: input.authUserId,
          ad_account_id: candidate.ad_account_id,
          account_name: existing.account_name,
          buyer: existing.buyer,
          currency: existing.currency,
          timezone: "",
          valid_from: existing.latest_valid_from,
          valid_to: input.nowIso,
          is_current: 0,
          import_batch_id: input.importBatchId,
        });
      }
      opens.push({
        auth_user_id: input.authUserId,
        ad_account_id: candidate.ad_account_id,
        account_name: candidate.account_name,
        buyer: candidate.buyer,
        currency: candidate.currency,
        timezone: "",
        valid_from: input.nowIso,
        valid_to: null,
        is_current: 1,
        import_batch_id: input.importBatchId,
      });
    }
    if (closes.length) await ch.insert({ table: DIM_FB_ACCOUNT_TABLE, values: closes, format: "JSONEachRow" });
    if (opens.length) await ch.insert({ table: DIM_FB_ACCOUNT_TABLE, values: opens, format: "JSONEachRow" });
    counters.accounts_closed = closes.length;
    counters.accounts_opened = opens.length;
  }

  if (input.campaigns.length) {
    const current = await jsonRows<CurrentCampaignVersion>(
      ch,
      `SELECT campaign_id,
         argMax(ad_account_id, valid_from) AS ad_account_id,
         argMax(campaign_name, valid_from) AS campaign_name,
         toString(argMax(first_seen_date, valid_from)) AS first_seen_date,
         toString(max(valid_from)) AS latest_valid_from
       FROM ${DIM_FB_CAMPAIGN_TABLE} FINAL
       WHERE auth_user_id = {auth_user_id:String} AND is_current = 1
         AND campaign_id IN (${clickHouseBodyStringSet(input.campaigns.map((campaign) => campaign.campaign_id))})
       GROUP BY campaign_id`,
      { auth_user_id: input.authUserId },
    );
    const currentById = new Map(current.map((row) => [row.campaign_id, row]));
    const closes: Record<string, unknown>[] = [];
    const opens: Record<string, unknown>[] = [];
    for (const candidate of input.campaigns) {
      const existing = currentById.get(candidate.campaign_id);
      const changed =
        !existing ||
        existing.campaign_name !== candidate.campaign_name ||
        existing.ad_account_id !== candidate.ad_account_id;
      if (!changed) continue;
      const firstSeen = existing && existing.first_seen_date < candidate.first_seen_date
        ? existing.first_seen_date
        : candidate.first_seen_date;
      if (existing) {
        closes.push({
          auth_user_id: input.authUserId,
          campaign_id: candidate.campaign_id,
          ad_account_id: existing.ad_account_id,
          campaign_name: existing.campaign_name,
          first_seen_date: existing.first_seen_date,
          last_seen_date: candidate.last_seen_date,
          valid_from: existing.latest_valid_from,
          valid_to: input.nowIso,
          is_current: 0,
          import_batch_id: input.importBatchId,
        });
      }
      opens.push({
        auth_user_id: input.authUserId,
        campaign_id: candidate.campaign_id,
        ad_account_id: candidate.ad_account_id,
        campaign_name: candidate.campaign_name,
        first_seen_date: firstSeen,
        last_seen_date: candidate.last_seen_date,
        valid_from: input.nowIso,
        valid_to: null,
        is_current: 1,
        import_batch_id: input.importBatchId,
      });
    }
    if (closes.length) await ch.insert({ table: DIM_FB_CAMPAIGN_TABLE, values: closes, format: "JSONEachRow" });
    if (opens.length) await ch.insert({ table: DIM_FB_CAMPAIGN_TABLE, values: opens, format: "JSONEachRow" });
    counters.campaigns_closed = closes.length;
    counters.campaigns_opened = opens.length;
  }

  return counters;
}

/** One-shot dim seed from the V1 warehouse (latest names per entity). Idempotent:
 * syncFbV2Dims semantics — entities that already have a current version with the
 * same attributes are skipped. */
export async function backfillFbV2DimsFromV1(input: {
  clickhouse: ClickHouseClientLike;
  authUserId: string;
  nowIso: string;
}): Promise<{ accounts_opened: number; accounts_closed: number; campaigns_opened: number; campaigns_closed: number }> {
  await ensureFbWarehouseV2Schema(input.clickhouse);
  const params = { auth_user_id: input.authUserId };
  const [accounts, campaigns] = await Promise.all([
    jsonRows<FbAccountDimCandidate>(
      input.clickhouse,
      `SELECT ad_account_id,
         argMax(ad_account_name, stat_date) AS account_name,
         argMax(buyer, stat_date) AS buyer,
         argMax(currency, stat_date) AS currency
       FROM ${FACT_FACEBOOK_STATS_TABLE} FINAL
       WHERE auth_user_id = {auth_user_id:String} AND ad_account_id != ''
       GROUP BY ad_account_id`,
      params,
    ),
    jsonRows<FbCampaignDimCandidate>(
      input.clickhouse,
      `SELECT campaign_id,
         argMax(ad_account_id, stat_date) AS ad_account_id,
         argMax(campaign_name, stat_date) AS campaign_name,
         toString(min(stat_date)) AS first_seen_date,
         toString(max(stat_date)) AS last_seen_date
       FROM ${FACT_FACEBOOK_STATS_TABLE} FINAL
       WHERE auth_user_id = {auth_user_id:String} AND level = 'campaign' AND campaign_id != ''
       GROUP BY campaign_id`,
      params,
    ),
  ]);
  return syncFbV2Dims({
    clickhouse: input.clickhouse,
    authUserId: input.authUserId,
    importBatchId: "00000000-0000-0000-0000-000000000000",
    nowIso: input.nowIso,
    accounts,
    campaigns,
  });
}

export async function fbV2DimsStatus(clickhouse: ClickHouseClientLike, authUserId: string): Promise<{
  current_accounts: number;
  current_campaigns: number;
  campaign_versions: number;
}> {
  const params = { auth_user_id: authUserId };
  const [accounts, campaigns, versions] = await Promise.all([
    jsonRows<{ c: number }>(clickhouse, `SELECT count() c FROM ${DIM_FB_ACCOUNT_TABLE} FINAL WHERE auth_user_id = {auth_user_id:String} AND is_current = 1`, params),
    jsonRows<{ c: number }>(clickhouse, `SELECT count() c FROM ${DIM_FB_CAMPAIGN_TABLE} FINAL WHERE auth_user_id = {auth_user_id:String} AND is_current = 1`, params),
    jsonRows<{ c: number }>(clickhouse, `SELECT count() c FROM ${DIM_FB_CAMPAIGN_TABLE} FINAL WHERE auth_user_id = {auth_user_id:String}`, params),
  ]);
  return {
    current_accounts: Number(accounts[0]?.c) || 0,
    current_campaigns: Number(campaigns[0]?.c) || 0,
    campaign_versions: Number(versions[0]?.c) || 0,
  };
}
