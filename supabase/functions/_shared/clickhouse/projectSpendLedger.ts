// Project spend ledger — resolving window spend to campaign_path (P2, rev. 3 §8a).
//
// The project P&L needs FULL funnel-resolved source spend — including campaigns
// that burned money and produced zero users — while Model 1 (user-attributed)
// structurally excludes them and Model 2 resolves only to the 3-value brand
// bucket. This module implements the first two rungs of the resolution ladder:
//
//   1. observed-in-window  — campaigns whose trial users in the window already
//      carry a campaign_path (covers all user-attributed spend);
//   2. historical learning — the same campaign→path evidence over ALL history,
//      applied to this window's zero-user campaigns (a campaign that converted
//      in June but not in July still resolves correctly).
//
// What neither rung resolves is classified, never redistributed:
//   unknown_funnel     — a campaign id with no path evidence anywhere;
//   other_unallocated  — spend rows with no campaign identity at all.
//
// The window identity holds BY CONSTRUCTION — every spend row lands in exactly
// one bucket:
//   window_source_spend = user_attributed + no_user + unknown_funnel + other_unallocated
//
// Traffic commissions are NOT resolved here (correction 4): the warehouse has no
// per-account commission source, so every group ships trafficCommission: null and
// the client requires explicit manual assumptions before fully-loaded metrics
// resolve. Guessing a global rate is forbidden by design.
import type { DateWindow } from "./funnelEconomicsTypes.ts";
import {
  buildSpendBucket,
  type FunnelSpendLedger,
  type KnownGapDay,
  type SpendGroup,
  type WindowSpendLedger,
} from "./funnelEconomicsProject.ts";
import type { ClickHouseClientLike } from "./types.ts";

export const ANALYTICS_TRANSACTIONS_TABLE = "analytics_transactions";
export const FACT_FACEBOOK_STATS_TABLE = "fact_facebook_stats";

// ---- SQL builders (testable strings; params always bound) ------------------------

/** Window spend at (campaign × ad account × currency) grain. Deliberately does NOT
 * filter empty campaign_id — that spend is real and becomes other_unallocated. */
export function projectCampaignSpendSql(): string {
  return `
      SELECT campaign_id,
        ad_account_id,
        currency,
        argMax(campaign_name, stat_date) AS campaign_name,
        round(sum(spend), 2) AS spend
      FROM ${FACT_FACEBOOK_STATS_TABLE} FINAL
      WHERE auth_user_id = {auth_user_id:String} AND level = 'campaign'
        AND stat_date >= toDate({date_from:String}) AND stat_date <= toDate({date_to:String})
      GROUP BY campaign_id, ad_account_id, currency
    `;
}

/** campaign_id → campaign_path evidence from authoritative trial users. The same
 * statement serves rung 1 (window-scoped) and rung 2 (all history) — the caller
 * flips `windowed`. Dominance is decided in TS (deterministically) so the tie
 * rule is unit-tested, not buried in SQL. */
export function campaignPathEvidenceSql(windowed: boolean): string {
  const dateWhere = windowed
    ? `AND toDate(event_time) >= toDate({date_from:String}) AND toDate(event_time) <= toDate({date_to:String})`
    : "";
  return `
      SELECT campaign_id, campaign_path, uniqExact(user_id) AS users
      FROM ${ANALYTICS_TRANSACTIONS_TABLE} FINAL
      WHERE auth_user_id = {auth_user_id:String}
        AND status = 'success' AND transaction_type = 'trial'
        AND campaign_id != '' AND campaign_path != ''
        ${dateWhere}
      GROUP BY campaign_id, campaign_path
    `;
}

// ---- Raw rows --------------------------------------------------------------------

export interface RawCampaignSpendRow {
  campaign_id: string;
  ad_account_id: string;
  currency: string;
  campaign_name: string;
  spend: number | string;
}

export interface RawCampaignPathRow {
  campaign_id: string;
  campaign_path: string;
  users: number | string;
}

export interface KnownGapRecord {
  gap_id: string;
  gap_from: string;
  gap_to: string;
  reason: string;
}

// ---- Pure helpers ----------------------------------------------------------------

const num = (value: number | string): number => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/** One campaign → its dominant path: most trial users wins; ties break on the
 * lexicographically smallest path so re-runs never flap. */
export function dominantCampaignPaths(rows: ReadonlyArray<RawCampaignPathRow>): Map<string, { path: string; users: number }> {
  const byCampaign = new Map<string, Map<string, number>>();
  for (const row of rows) {
    if (!row.campaign_id || !row.campaign_path) continue;
    const paths = byCampaign.get(row.campaign_id) ?? new Map<string, number>();
    paths.set(row.campaign_path, (paths.get(row.campaign_path) ?? 0) + num(row.users));
    byCampaign.set(row.campaign_id, paths);
  }
  const dominant = new Map<string, { path: string; users: number }>();
  for (const [campaignId, paths] of byCampaign) {
    let bestPath = "";
    let bestUsers = -1;
    let totalUsers = 0;
    for (const [path, users] of paths) {
      totalUsers += users;
      if (users > bestUsers || (users === bestUsers && path < bestPath)) {
        bestPath = path;
        bestUsers = users;
      }
    }
    dominant.set(campaignId, { path: bestPath, users: totalUsers });
  }
  return dominant;
}

/** Expand recorded gap ranges into the individual days overlapping the window —
 * each carrying its evidence reference, so a provisional project can cite it. */
export function knownGapDaysInWindow(gaps: ReadonlyArray<KnownGapRecord>, window: DateWindow): KnownGapDay[] {
  const DAY_MS = 86_400_000;
  const fromMs = Date.parse(`${window.from}T00:00:00Z`);
  const toMs = Date.parse(`${window.to}T00:00:00Z`);
  const days: KnownGapDay[] = [];
  for (const gap of gaps) {
    const gapFrom = Date.parse(`${gap.gap_from}T00:00:00Z`);
    const gapTo = Date.parse(`${gap.gap_to}T00:00:00Z`);
    if (!Number.isFinite(gapFrom) || !Number.isFinite(gapTo)) continue;
    const start = Math.max(fromMs, gapFrom);
    const end = Math.min(toMs, gapTo);
    for (let dayMs = start; dayMs <= end; dayMs += DAY_MS) {
      days.push({
        date: new Date(dayMs).toISOString().slice(0, 10),
        reference: gap.gap_id,
        note: gap.reason,
      });
    }
  }
  return days.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

function mergeGroup(groups: Map<string, SpendGroup>, row: RawCampaignSpendRow): void {
  const key = `facebook:${row.ad_account_id}:${row.currency}`;
  const existing = groups.get(key);
  if (existing) {
    existing.spend += num(row.spend);
    return;
  }
  groups.set(key, {
    trafficChannel: "facebook",
    adAccountId: row.ad_account_id,
    currency: row.currency,
    spend: num(row.spend),
    // Correction 4: no per-account commission source exists — never guessed here.
    trafficCommission: null,
    trafficCashOutflow: null,
  });
}

// ---- Assembly --------------------------------------------------------------------

export interface CampaignLedgerDiagnostic {
  campaign_id: string;
  campaign_name: string;
  spend: number;
  classification: "user_attributed" | "no_user" | "unknown_funnel" | "other_unallocated";
  campaign_path: string | null;
  resolution: "window_users" | "historical_users" | null;
}

export interface ProjectSpendLedgerResult {
  windowLedger: WindowSpendLedger;
  funnelLedgers: Record<string, FunnelSpendLedger>;
  campaigns: CampaignLedgerDiagnostic[];
}

/** Classify every spend row into exactly one bucket and roll funnel ledgers up.
 * Pure; the Edge action feeds it query outputs, tests feed it fixtures. */
export function assembleProjectSpendLedger(input: {
  spendRows: ReadonlyArray<RawCampaignSpendRow>;
  windowPathRows: ReadonlyArray<RawCampaignPathRow>;
  historicalPathRows: ReadonlyArray<RawCampaignPathRow>;
  knownGaps: ReadonlyArray<KnownGapRecord>;
  window: DateWindow;
}): ProjectSpendLedgerResult {
  const windowPaths = dominantCampaignPaths(input.windowPathRows);
  const historicalPaths = dominantCampaignPaths(input.historicalPathRows);

  const attributedGroups = new Map<string, SpendGroup>();
  const noUserGroups = new Map<string, SpendGroup>();
  const unknownGroups = new Map<string, SpendGroup>();
  const unallocatedGroups = new Map<string, SpendGroup>();

  interface FunnelAccumulator {
    attributed: number;
    noUser: number;
    groups: Map<string, SpendGroup>;
    usedHistorical: boolean;
    currencies: Set<string>;
  }
  const funnels = new Map<string, FunnelAccumulator>();
  const campaigns: CampaignLedgerDiagnostic[] = [];

  // Deterministic accumulation order regardless of query row order.
  const orderedSpendRows = [...input.spendRows].sort((a, b) => {
    const keyA = `${a.campaign_id}|${a.ad_account_id}|${a.currency}`;
    const keyB = `${b.campaign_id}|${b.ad_account_id}|${b.currency}`;
    return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
  });

  let windowSourceSpend = 0;
  for (const row of orderedSpendRows) {
    const spend = num(row.spend);
    windowSourceSpend += spend;

    if (!row.campaign_id) {
      mergeGroup(unallocatedGroups, row);
      campaigns.push({ campaign_id: "", campaign_name: row.campaign_name, spend, classification: "other_unallocated", campaign_path: null, resolution: null });
      continue;
    }

    const inWindow = windowPaths.get(row.campaign_id);
    const historical = inWindow ? undefined : historicalPaths.get(row.campaign_id);
    const resolvedPath = inWindow?.path ?? historical?.path ?? null;

    if (resolvedPath === null) {
      mergeGroup(unknownGroups, row);
      campaigns.push({ campaign_id: row.campaign_id, campaign_name: row.campaign_name, spend, classification: "unknown_funnel", campaign_path: null, resolution: null });
      continue;
    }

    const funnel = funnels.get(resolvedPath) ?? {
      attributed: 0,
      noUser: 0,
      groups: new Map<string, SpendGroup>(),
      usedHistorical: false,
      currencies: new Set<string>(),
    };
    mergeGroup(funnel.groups, row);
    funnel.currencies.add(row.currency);
    if (inWindow) {
      funnel.attributed += spend;
      mergeGroup(attributedGroups, row);
      campaigns.push({ campaign_id: row.campaign_id, campaign_name: row.campaign_name, spend, classification: "user_attributed", campaign_path: resolvedPath, resolution: "window_users" });
    } else {
      funnel.noUser += spend;
      funnel.usedHistorical = true;
      mergeGroup(noUserGroups, row);
      campaigns.push({ campaign_id: row.campaign_id, campaign_name: row.campaign_name, spend, classification: "no_user", campaign_path: resolvedPath, resolution: "historical_users" });
    }
    funnels.set(resolvedPath, funnel);
  }

  const funnelLedgers: Record<string, FunnelSpendLedger> = {};
  for (const [path, acc] of [...funnels.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const resolved = acc.attributed + acc.noUser;
    const groups = [...acc.groups.values()];
    funnelLedgers[path] = {
      funnelResolvedSpend: resolved,
      userAttributedSpend: acc.attributed,
      noUserSpend: acc.noUser,
      spendCoverage: resolved > 0 ? acc.attributed / resolved : null,
      groups,
      // Null until commissions are assigned (manual per group, client-side).
      trafficCashOutflow: buildSpendBucket(groups).trafficCashOutflow,
      resolutionBasis: acc.usedHistorical ? "historical_campaign_path" : "user_attribution_only",
      currency: acc.currencies.size === 1 ? [...acc.currencies][0] : null,
      currencyMixed: acc.currencies.size > 1,
    };
  }

  const attributedBucket = buildSpendBucket([...attributedGroups.values()]);
  const noUserBucket = buildSpendBucket([...noUserGroups.values()]);
  const knownGapDays = knownGapDaysInWindow(input.knownGaps, input.window);

  const windowLedger: WindowSpendLedger = {
    windowSourceSpend,
    funnelResolved: buildSpendBucket([...[...attributedGroups.values()], ...[...noUserGroups.values()]]),
    userAttributed: attributedBucket,
    noUser: noUserBucket,
    unknownFunnel: buildSpendBucket([...unknownGroups.values()]),
    otherUnallocated: buildSpendBucket([...unallocatedGroups.values()]),
    knownGapDays,
    spendIncomplete: knownGapDays.length > 0,
  };

  return { windowLedger, funnelLedgers, campaigns };
}

// ---- Edge orchestration ----------------------------------------------------------

interface SupabaseLikeClient {
  from(table: string): {
    select(columns: string): {
      lte(column: string, value: string): {
        gte(column: string, value: string): PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;
      };
    };
  };
}

/** One call = the whole ledger: three ClickHouse reads + the known-gap overlap.
 * Wired as clickhouse-facebook action "spend_ledger". */
export async function runProjectSpendLedger(input: {
  clickhouse: ClickHouseClientLike;
  supabase: SupabaseLikeClient;
  authUserId: string;
  dateFrom: string | null;
  dateTo: string | null;
}): Promise<ProjectSpendLedgerResult & { window: DateWindow }> {
  if (!input.dateFrom || !input.dateTo) {
    throw new Error("spend_ledger requires date_from and date_to.");
  }
  const window: DateWindow = { from: input.dateFrom, to: input.dateTo };
  const params = { auth_user_id: input.authUserId, date_from: window.from, date_to: window.to };

  const json = async <T>(query: string, queryParams: Record<string, unknown>): Promise<T[]> => {
    const result = await input.clickhouse.query({ query, query_params: queryParams, format: "JSONEachRow" });
    return (await result.json()) as T[];
  };

  const [spendRows, windowPathRows, historicalPathRows, gapsResult] = await Promise.all([
    json<RawCampaignSpendRow>(projectCampaignSpendSql(), params),
    json<RawCampaignPathRow>(campaignPathEvidenceSql(true), params),
    json<RawCampaignPathRow>(campaignPathEvidenceSql(false), { auth_user_id: input.authUserId }),
    input.supabase
      .from("facebook_known_gaps")
      .select("gap_id,gap_from,gap_to,reason")
      .lte("gap_from", window.to)
      .gte("gap_to", window.from),
  ]);
  if (gapsResult.error) throw new Error(`Could not read known gaps: ${gapsResult.error.message}`);

  const assembled = assembleProjectSpendLedger({
    spendRows,
    windowPathRows,
    historicalPathRows,
    knownGaps: (gapsResult.data ?? []) as KnownGapRecord[],
    window,
  });
  return { ...assembled, window };
}
