import type { CapsuledFacebookLevel, CapsuledFacebookRow, CapsuledFacebookSyncMetadata } from "@/services/capsuledFacebook";

export type FbTrafficMatchStatus =
  | "matched"
  | "missing_in_capsuled"
  | "capsuled_only"
  | "missing_campaign_id"
  | "duplicate_in_capsuled"
  | "outside_date_range"
  | "sync_not_run"
  | "level_mismatch"
  | "unknown";

export interface FbTrafficDiagnosticsInput {
  warehouseCampaignIds: readonly string[];
  capsuledRows: readonly CapsuledFacebookRow[];
  dateFrom?: string | null;
  dateTo?: string | null;
  selectedLevel?: CapsuledFacebookLevel;
  latestSyncMetadata?: Partial<CapsuledFacebookSyncMetadata> | null;
}

export interface FbTrafficDiagnosticSummary {
  warehouse_campaign_ids_count: number;
  capsuled_rows_count: number;
  capsuled_unique_campaign_ids_count: number;
  matched_campaign_ids_count: number;
  unmatched_warehouse_campaign_ids_count: number;
  capsuled_only_campaign_ids_count: number;
  duplicate_capsuled_campaign_ids_count: number;
  missing_campaign_id_rows_count: number;
  rows_without_spend_count: number;
  rows_without_purchases_count: number;
  total_spend: number;
  total_fb_purchases: number;
  latest_sync_at: string | null;
  fb_stats_to: string | null;
  api_level: CapsuledFacebookLevel | "unknown";
  date_from: string | null;
  date_to: string | null;
  selected_range_outside_synced_range: boolean;
}

export interface FbTrafficDiagnosticCampaign {
  campaign_id: string;
  warehouse_present: boolean;
  capsuled_present: boolean;
  match_status: FbTrafficMatchStatus;
  reason: string;
  campaign_name: string | null;
  ad_account: string | null;
  spend: number | null;
  fb_purchases: number | null;
  last_sync_at: string | null;
  date_from: string | null;
  date_to: string | null;
}

export interface FbTrafficDiagnosticsResult {
  summary: FbTrafficDiagnosticSummary;
  campaigns: FbTrafficDiagnosticCampaign[];
}

export function fbTrafficStatusLabel(status: FbTrafficMatchStatus): string {
  switch (status) {
    case "matched":
      return "Matched";
    case "missing_in_capsuled":
      return "Not returned by Capsuled";
    case "capsuled_only":
      return "Capsuled only";
    case "missing_campaign_id":
      return "Missing Campaign ID";
    case "duplicate_in_capsuled":
      return "Duplicate ID";
    case "outside_date_range":
      return "Outside date range";
    case "sync_not_run":
      return "Sync not run";
    case "level_mismatch":
      return "Wrong level";
    default:
      return "Unknown";
  }
}

function dateKey(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (match) return match[1];
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function cleanCampaignId(value: unknown): string {
  return String(value ?? "").trim();
}

function uniqueSorted(values: Iterable<string>): string[] {
  return Array.from(new Set(Array.from(values).map(cleanCampaignId).filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

function rowOverlapsRange(row: Pick<CapsuledFacebookRow, "date_from" | "date_to">, from: string | null, to: string | null): boolean {
  const rowFrom = dateKey(row.date_from);
  const rowTo = dateKey(row.date_to);
  if (!rowFrom || !rowTo) return false;
  if (from && rowTo < from) return false;
  if (to && rowFrom > to) return false;
  return true;
}

function rowsDateRange(rows: readonly CapsuledFacebookRow[]): { from: string | null; to: string | null } {
  const from = rows.map((row) => dateKey(row.date_from)).filter((value): value is string => Boolean(value)).sort()[0] ?? null;
  const to = rows.map((row) => dateKey(row.date_to)).filter((value): value is string => Boolean(value)).sort().at(-1) ?? null;
  return { from, to };
}

function isSelectedRangeOutsideSyncedRange(rows: readonly CapsuledFacebookRow[], from: string | null, to: string | null): boolean {
  if (!rows.length || (!from && !to)) return false;
  const synced = rowsDateRange(rows);
  if (!synced.from || !synced.to) return false;
  if (from && from > synced.to) return true;
  if (to && to < synced.from) return true;
  return false;
}

function combineRows(rows: readonly CapsuledFacebookRow[]): {
  campaign_name: string | null;
  ad_account: string | null;
  spend: number;
  fb_purchases: number;
  last_sync_at: string | null;
  date_from: string | null;
  date_to: string | null;
} {
  return {
    campaign_name: rows.map((row) => row.campaign_name).find(Boolean) ?? null,
    ad_account: rows.map((row) => row.ad_account_name ?? row.ad_account_id).find(Boolean) ?? null,
    spend: rows.reduce((total, row) => total + row.spend, 0),
    fb_purchases: rows.reduce((total, row) => total + row.fb_purchases, 0),
    last_sync_at: rows.map((row) => row.last_import_at).filter(Boolean).sort().at(-1) ?? null,
    date_from: rowsDateRange(rows).from,
    date_to: rowsDateRange(rows).to,
  };
}

export function buildFbTrafficDiagnostics(input: FbTrafficDiagnosticsInput): FbTrafficDiagnosticsResult {
  const dateFrom = dateKey(input.dateFrom);
  const dateTo = dateKey(input.dateTo);
  const selectedLevel = input.selectedLevel ?? "campaign";
  const latestSync = input.latestSyncMetadata ?? null;
  const latestSyncAt = latestSync?.lastSync ?? null;
  const apiLevel = latestSync?.level ?? selectedLevel ?? "unknown";
  const syncNotRun = !latestSyncAt && input.capsuledRows.length === 0;
  const levelMismatch = Boolean(latestSyncAt && apiLevel !== "campaign");
  const warehouseIds = uniqueSorted(input.warehouseCampaignIds);
  const warehouseSet = new Set(warehouseIds);

  const levelRows = input.capsuledRows.filter((row) => row.level === selectedLevel);
  const inRangeRows = levelRows.filter((row) => rowOverlapsRange(row, dateFrom, dateTo));
  const selectedRangeOutsideSyncedRange = isSelectedRangeOutsideSyncedRange(levelRows, dateFrom, dateTo);

  const rowsForMatching = selectedLevel === "campaign" ? inRangeRows : [];
  const rowsById = new Map<string, CapsuledFacebookRow[]>();
  const allLevelRowsById = new Map<string, CapsuledFacebookRow[]>();
  const missingCampaignRows = rowsForMatching.filter((row) => !cleanCampaignId(row.campaign_id));

  for (const row of rowsForMatching) {
    const id = cleanCampaignId(row.campaign_id);
    if (!id) continue;
    rowsById.set(id, [...(rowsById.get(id) ?? []), row]);
  }
  for (const row of levelRows) {
    const id = cleanCampaignId(row.campaign_id);
    if (!id) continue;
    allLevelRowsById.set(id, [...(allLevelRowsById.get(id) ?? []), row]);
  }

  const capsuledIds = uniqueSorted(rowsById.keys());
  const capsuledSet = new Set(capsuledIds);
  const duplicateIds = uniqueSorted(Array.from(rowsById.entries()).filter(([, rows]) => rows.length > 1).map(([id]) => id));
  const duplicateSet = new Set(duplicateIds);
  const matchedIds = warehouseIds.filter((id) => capsuledSet.has(id) && !duplicateSet.has(id));
  const capsuledOnlyIds = capsuledIds.filter((id) => !warehouseSet.has(id));
  const unmatchedWarehouseIds = warehouseIds.filter((id) => !capsuledSet.has(id));

  const campaigns: FbTrafficDiagnosticCampaign[] = [];
  const addCampaign = (campaign: FbTrafficDiagnosticCampaign) => campaigns.push(campaign);

  for (const id of warehouseIds) {
    const rows = rowsById.get(id) ?? [];
    const anyLevelRows = allLevelRowsById.get(id) ?? [];
    const combined = combineRows(rows.length ? rows : anyLevelRows);
    let status: FbTrafficMatchStatus = "unknown";
    let reason = "Unable to determine Capsuled match status.";

    if (syncNotRun) {
      status = "sync_not_run";
      reason = "Capsuled sync has not run yet.";
    } else if (levelMismatch) {
      status = "level_mismatch";
      reason = `Capsuled data was imported at ${apiLevel} level, but FB Analytics requires campaign level.`;
    } else if (!rows.length && anyLevelRows.length) {
      status = "outside_date_range";
      reason = "Campaign was returned by Capsuled, but not for the selected date range.";
    } else if (!rows.length) {
      status = selectedRangeOutsideSyncedRange ? "outside_date_range" : "missing_in_capsuled";
      reason = selectedRangeOutsideSyncedRange
        ? "Selected date range is outside the synced Capsuled range."
        : "Campaign ID exists in Subengine but was not returned by Capsuled for selected date range.";
    } else if (duplicateSet.has(id)) {
      status = "duplicate_in_capsuled";
      reason = "Campaign ID appears multiple times in Capsuled rows for the selected date range.";
    } else {
      status = "matched";
      reason = combined.spend === 0 ? "Campaign was returned by Capsuled but spend is zero." : "Campaign ID matched between Subengine and Capsuled.";
    }

    addCampaign({
      campaign_id: id,
      warehouse_present: true,
      capsuled_present: rows.length > 0,
      match_status: status,
      reason,
      campaign_name: combined.campaign_name,
      ad_account: combined.ad_account,
      spend: rows.length || anyLevelRows.length ? combined.spend : null,
      fb_purchases: rows.length || anyLevelRows.length ? combined.fb_purchases : null,
      last_sync_at: combined.last_sync_at ?? latestSyncAt,
      date_from: combined.date_from,
      date_to: combined.date_to,
    });
  }

  for (const id of capsuledOnlyIds) {
    const combined = combineRows(rowsById.get(id) ?? []);
    addCampaign({
      campaign_id: id,
      warehouse_present: false,
      capsuled_present: true,
      match_status: duplicateSet.has(id) ? "duplicate_in_capsuled" : "capsuled_only",
      reason: duplicateSet.has(id)
        ? "Campaign ID appears multiple times in Capsuled rows and does not exist in Subengine."
        : "Campaign was returned by Capsuled but is not present in Subengine warehouse campaign IDs.",
      campaign_name: combined.campaign_name,
      ad_account: combined.ad_account,
      spend: combined.spend,
      fb_purchases: combined.fb_purchases,
      last_sync_at: combined.last_sync_at ?? latestSyncAt,
      date_from: combined.date_from,
      date_to: combined.date_to,
    });
  }

  missingCampaignRows.forEach((row, index) => {
    addCampaign({
      campaign_id: `(missing campaign_id row ${index + 1})`,
      warehouse_present: false,
      capsuled_present: true,
      match_status: "missing_campaign_id",
      reason: "Capsuled returned a row without campaign_id, so it cannot be matched to Subengine.",
      campaign_name: row.campaign_name,
      ad_account: row.ad_account_name ?? row.ad_account_id,
      spend: row.spend,
      fb_purchases: row.fb_purchases,
      last_sync_at: row.last_import_at || latestSyncAt,
      date_from: row.date_from,
      date_to: row.date_to,
    });
  });

  campaigns.sort((a, b) => {
    if (a.warehouse_present !== b.warehouse_present) return a.warehouse_present ? -1 : 1;
    return a.campaign_id.localeCompare(b.campaign_id);
  });

  return {
    summary: {
      warehouse_campaign_ids_count: warehouseIds.length,
      capsuled_rows_count: rowsForMatching.length,
      capsuled_unique_campaign_ids_count: capsuledIds.length,
      matched_campaign_ids_count: matchedIds.length,
      unmatched_warehouse_campaign_ids_count: unmatchedWarehouseIds.length,
      capsuled_only_campaign_ids_count: capsuledOnlyIds.length,
      duplicate_capsuled_campaign_ids_count: duplicateIds.length,
      missing_campaign_id_rows_count: missingCampaignRows.length,
      rows_without_spend_count: rowsForMatching.filter((row) => row.spend <= 0).length,
      rows_without_purchases_count: rowsForMatching.filter((row) => row.fb_purchases <= 0).length,
      total_spend: rowsForMatching.reduce((total, row) => total + row.spend, 0),
      total_fb_purchases: rowsForMatching.reduce((total, row) => total + row.fb_purchases, 0),
      latest_sync_at: latestSyncAt ?? rowsForMatching.map((row) => row.last_import_at).filter(Boolean).sort().at(-1) ?? null,
      fb_stats_to: latestSync?.facebookStatsDate ?? rowsDateRange(rowsForMatching).to,
      api_level: apiLevel,
      date_from: dateFrom,
      date_to: dateTo,
      selected_range_outside_synced_range: selectedRangeOutsideSyncedRange,
    },
    campaigns,
  };
}

function csvEscape(value: unknown): string {
  const raw = String(value ?? "");
  return /[",\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
}

export function exportMissingCampaignIdsCsv(diagnostics: FbTrafficDiagnosticsResult): string {
  const header = ["campaign_id", "reason", "date_from", "date_to", "latest_sync_at"];
  const rows = diagnostics.campaigns
    .filter((campaign) => campaign.match_status === "missing_in_capsuled")
    .map((campaign) => [
      campaign.campaign_id,
      campaign.reason,
      diagnostics.summary.date_from ?? "",
      diagnostics.summary.date_to ?? "",
      diagnostics.summary.latest_sync_at ?? "",
    ]);
  return [header, ...rows].map((row) => row.map(csvEscape).join(",")).join("\n");
}
