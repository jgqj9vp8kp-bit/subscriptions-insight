// Daily per-campaign series for the AI engine's campaign trend family.
//
// Source: the Capsuled stats rows the FB Analytics page ALREADY holds in
// state. Since the 2026-08-17 daily-split sync, campaign-level rows are daily
// (date_from === date_to) and multi-day period rows are superseded server-side
// — but the client's 5000-row cap (ordered by last_import_at desc) can still
// surface stragglers, so period rows are excluded here and (campaign, date)
// duplicates resolve to the freshest import.
//
// The resulting CPA basis is spend / fb_purchases — FB-reported purchases,
// which the cohort allocation model treats as "one FB purchase per matched
// authoritative trial user". Close to, but NOT identical to, the ladder's
// CPA (spend / authoritative trials): the series supports trend DIRECTION
// only and must never be compared level-to-level against cpaCeiling.
import type { CapsuledFacebookRow } from "./trafficMetric.ts";

export interface AiCampaignDailyPoint {
  date: string;
  spend: number;
  purchases: number;
}

export function buildCampaignDailySeries(
  rows: readonly Pick<CapsuledFacebookRow, "level" | "campaign_id" | "date_from" | "date_to" | "spend" | "fb_purchases" | "last_import_at">[],
  opts: { dateFrom: string | null; dateTo: string | null },
): Record<string, AiCampaignDailyPoint[]> {
  // Freshest import wins per (campaign, date). Input arrives ordered by
  // last_import_at desc, but the rule is enforced, not assumed.
  const freshest = new Map<string, { point: AiCampaignDailyPoint; importedAt: string }>();
  for (const row of rows) {
    if (row.level !== "campaign") continue;
    const campaignId = String(row.campaign_id ?? "").trim();
    if (!campaignId) continue;
    const date = String(row.date_from ?? "").slice(0, 10);
    if (!date || row.date_from !== row.date_to) continue; // daily-split contract
    if (opts.dateFrom && date < opts.dateFrom) continue;
    if (opts.dateTo && date > opts.dateTo) continue;
    const spend = Number(row.spend);
    const purchases = Number(row.fb_purchases);
    if (!Number.isFinite(spend) || spend < 0) continue;
    const key = `${campaignId}|${date}`;
    const importedAt = String(row.last_import_at ?? "");
    const current = freshest.get(key);
    if (current && current.importedAt >= importedAt) continue;
    freshest.set(key, {
      point: { date, spend, purchases: Number.isFinite(purchases) && purchases > 0 ? purchases : 0 },
      importedAt,
    });
  }

  const out: Record<string, AiCampaignDailyPoint[]> = {};
  for (const [key, { point }] of freshest) {
    const campaignId = key.slice(0, key.indexOf("|"));
    (out[campaignId] ??= []).push(point);
  }
  for (const series of Object.values(out)) {
    series.sort((a, b) => a.date.localeCompare(b.date));
  }
  return out;
}
