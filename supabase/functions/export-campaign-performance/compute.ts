// Pure, dependency-free compute pipeline for the campaign-performance export.
//
// Imported by BOTH the Deno edge function (index.ts) and the vitest tests. It takes raw warehouse
// rows + the latest Facebook traffic snapshot and returns the API rows — re-classifying transaction
// types over each user's FULL history so the API never depends on per-import-batch stored types or
// any frontend recalc.

import { classifyWarehouseTransactions, type ClassifiableTxn } from "./classify.ts";
import { netRevenue, type AggregateTxn, type TrafficMetricLike } from "./aggregate.ts";

export interface ComputeTxn extends ClassifiableTxn {
  email?: string;
  campaign_id?: string;
  is_refunded?: boolean;
  refund_amount_usd?: number;
  net_amount_usd?: number;
  utm_source?: string | null;
  metadata?: Record<string, unknown> | null;
  raw?: Record<string, unknown> | null;
  source?: string | null;
  import_batch_id?: string | null;
}

export interface BatchLoadSummary {
  transactions_loaded: number;
  import_batches_loaded: number;
  latest_batch_rows: number;
  rows_outside_latest_batch: number;
}

// Page through every row of a paginated source until a short page is returned. Used by the edge to
// load the FULL warehouse — it must not rely on Supabase's default single-page row cap.
export async function collectPages<T>(
  fetchPage: (offset: number, limit: number) => Promise<T[]>,
  pageSize = 1000,
): Promise<T[]> {
  const all: T[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = await fetchPage(offset, pageSize);
    all.push(...page);
    if (page.length < pageSize) break;
  }
  return all;
}

// Diagnostics proving the API loaded the whole warehouse, not just the latest import batch.
export function summarizeBatchLoad(
  txs: Array<{ import_batch_id?: string | null }>,
  latestBatchId: string | null,
): BatchLoadSummary {
  const batchIds = new Set<string>();
  let latestBatchRows = 0;
  for (const tx of txs) {
    const id = tx.import_batch_id ?? null;
    if (id) batchIds.add(id);
    if (latestBatchId && id === latestBatchId) latestBatchRows += 1;
  }
  return {
    transactions_loaded: txs.length,
    import_batches_loaded: batchIds.size,
    latest_batch_rows: latestBatchRows,
    rows_outside_latest_batch: txs.length - latestBatchRows,
  };
}

export interface ComputeParams {
  date_from?: string | null;
  date_to?: string | null;
  campaign_path?: string | null;
  media_buyer?: string | null;
  campaign_id?: string | null;
}

export interface CampaignPerformanceRow {
  campaign_id: string;
  campaign_path: string;
  funnel: string;
  date_from: string | null;
  date_to: string | null;
  trial_users: number;
  upsell_users: number;
  upsell_cr: number;
  first_sub_users: number;
  trial_to_first_sub_cr: number;
  refund_users: number;
  net_revenue: number;
  spend: number | null;
  cac: number | null;
  roas: number | null;
}

function dateKey(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = String(value).match(/^(\d{4}-\d{2}-\d{2})/);
  if (match) return match[1];
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function normalize(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizePath(value: unknown): string {
  return normalize(value).replace(/^\/+/, "").toLowerCase();
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundRatio(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function objectFrom(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return null;
}

function valueAtPath(source: unknown, path: string[]): unknown {
  let current: unknown = source;
  for (const segment of path) {
    const object = objectFrom(current);
    if (!object) return undefined;
    current = object[segment];
  }
  return current;
}

function firstString(source: unknown, paths: string[][]): string | null {
  for (const path of paths) {
    const normalized = normalize(valueAtPath(source, path));
    if (normalized) return normalized;
  }
  return null;
}

function campaignIdFor(tx: ComputeTxn): string {
  return normalize(
    tx.campaign_id ||
      firstString(tx, [["campaign_id"], ["campaign", "id"], ["raw_payload", "campaign_id"], ["normalized_payload", "campaign_id"]]) ||
      firstString(tx.metadata, [["campaign_id"], ["campaign", "id"]]) ||
      firstString(tx.raw, [["campaign_id"], ["campaign", "id"], ["raw_payload", "campaign_id"], ["normalized_payload", "campaign_id"]]) ||
      "Unknown",
  );
}

function utmSourceFrom(source: unknown): string | null {
  return firstString(source, [
    ["utm_source"],
    ["user", "utm_source"],
    ["transaction", "utm_source"],
    ["metadata", "utm_source"],
    ["raw_payload", "utm_source"],
    ["normalized_payload", "utm_source"],
  ]);
}

function utmSourceFor(tx: ComputeTxn): string | null {
  return (
    (tx.utm_source ? normalize(tx.utm_source) : null) ??
    utmSourceFrom(tx.metadata) ??
    utmSourceFrom(tx.raw) ??
    utmSourceFrom(objectFrom(tx.raw)?.metadata) ??
    null
  );
}

function mediaBuyerFromUtmSource(value: unknown): string {
  const normalized = normalize(value);
  if (normalized === "4") return "Ivan";
  if (normalized === "22") return "Artem A";
  if (normalized === "19") return "Artem D";
  return "Unknown";
}

function mediaBuyerForUser(txs: ComputeTxn[]): string {
  const sorted = [...txs].sort((a, b) => a.event_time.localeCompare(b.event_time));
  const trial = sorted.find((tx) => tx.status === "success" && tx.transaction_type === "trial");
  const trialUtm = trial ? utmSourceFor(trial) : null;
  if (trialUtm) return mediaBuyerFromUtmSource(trialUtm);
  const fallback = sorted.map(utmSourceFor).find(Boolean) ?? null;
  return mediaBuyerFromUtmSource(fallback);
}

function userKey(tx: ComputeTxn): string {
  return tx.user_id || tx.email || tx.transaction_id;
}

function withinWindow(date: string, from: string | null, to: string | null): boolean {
  const d = dateKey(date);
  if (!d) return false;
  if (from && d < from) return false;
  if (to && d > to) return false;
  return true;
}

interface SpendContext {
  from: string | null;
  to: string | null;
  campaignIdsByPath: Map<string, Set<string>>;
}

// Traffic is path-keyed; a path's spend is attributable to a single campaign only when no other
// in-scope campaign uses that path (mirrors fbAnalytics.ts). When the snapshot carries campaign_id,
// match exactly. Returns null when spend cannot be attributed (no data, or a shared path).
function spendForGroup(
  campaignId: string,
  campaignPath: string,
  traffic: TrafficMetricLike[],
  ctx: SpendContext,
): number | null {
  if (!traffic.length) return null;
  const inWindow = traffic.filter((row) => withinWindow(row.date, ctx.from, ctx.to));
  const byId = inWindow.filter((row) => row.campaign_id && normalize(row.campaign_id) === campaignId);
  if (byId.length) return byId.reduce((total, row) => total + (row.spend || 0), 0);

  const path = normalizePath(campaignPath);
  const pathRows = inWindow.filter((row) => !row.campaign_id && normalizePath(row.campaign_path) === path);
  if (!pathRows.length) return null;
  const exclusive = (ctx.campaignIdsByPath.get(path)?.size ?? 0) <= 1;
  if (!exclusive) return null;
  return pathRows.reduce((total, row) => total + (row.spend || 0), 0);
}

interface Entry {
  userId: string;
  txs: ComputeTxn[];
  campaignId: string;
  campaignPath: string;
  funnel: string;
}

export function buildCampaignPerformanceRows(input: {
  txs: ComputeTxn[];
  traffic?: TrafficMetricLike[];
  params?: ComputeParams;
}): CampaignPerformanceRow[] {
  const params = input.params ?? {};
  const from = dateKey(params.date_from);
  const to = dateKey(params.date_to);
  const pathFilter = normalizePath(params.campaign_path);
  const buyerFilter = normalize(params.media_buyer);
  const campaignIdFilter = normalize(params.campaign_id);
  const traffic = input.traffic ?? [];

  // 1. Authoritative classification over each user's full warehouse history.
  const classified = classifyWarehouseTransactions(input.txs);

  // 2. Group transactions by user.
  const byUser = new Map<string, ComputeTxn[]>();
  for (const tx of classified) {
    const key = userKey(tx);
    byUser.set(key, [...(byUser.get(key) ?? []), tx]);
  }

  // 3. Attribute each user to their first successful trial and apply request filters.
  const grouped = new Map<string, Entry[]>();
  byUser.forEach((list, userId) => {
    const trial = [...list]
      .filter((tx) => tx.status === "success" && tx.transaction_type === "trial")
      .sort((a, b) => a.event_time.localeCompare(b.event_time))[0];
    if (!trial) return;
    const trialDate = dateKey(trial.event_time);
    if (!trialDate) return;
    if (from && trialDate < from) return;
    if (to && trialDate > to) return;

    const campaignId = campaignIdFor(trial);
    if (campaignIdFilter && campaignId !== campaignIdFilter) return;
    const campaignPath = trial.campaign_path || "unknown";
    if (pathFilter && normalizePath(campaignPath) !== pathFilter) return;
    if (buyerFilter && mediaBuyerForUser(list) !== buyerFilter) return;

    const funnel = trial.funnel || "unknown";
    const key = [campaignId, campaignPath, funnel].join("||");
    grouped.set(key, [...(grouped.get(key) ?? []), { userId, txs: list, campaignId, campaignPath, funnel }]);
  });

  // 4. Map each campaign_path to the campaign_ids using it (for spend-attribution exclusivity).
  const campaignIdsByPath = new Map<string, Set<string>>();
  grouped.forEach((entries) => {
    const { campaignId, campaignPath } = entries[0];
    const path = normalizePath(campaignPath);
    const set = campaignIdsByPath.get(path) ?? new Set<string>();
    set.add(campaignId);
    campaignIdsByPath.set(path, set);
  });
  const spendCtx: SpendContext = { from, to, campaignIdsByPath };

  // 5. Build one row per (campaign_id, campaign_path, funnel).
  const rows = Array.from(grouped.values()).map((entries) => {
    const first = entries[0];
    const allTxs = entries.flatMap((entry) => entry.txs);
    const trialUsers = entries.length;
    const upsellUsers = new Set(
      allTxs.filter((tx) => tx.status === "success" && tx.transaction_type === "upsell").map(userKey),
    ).size;
    const firstSubUsers = new Set(
      allTxs.filter((tx) => tx.status === "success" && tx.transaction_type === "first_subscription").map(userKey),
    ).size;
    const refundUsers = new Set(
      allTxs.filter((tx) => tx.is_refunded || tx.transaction_type === "refund" || (tx.refund_amount_usd ?? 0) > 0).map(userKey),
    ).size;
    const net = netRevenue(allTxs as AggregateTxn[]);
    const spend = spendForGroup(first.campaignId, first.campaignPath, traffic, spendCtx);
    const cac = spend != null && trialUsers ? round2(spend / trialUsers) : null;
    const roas = spend != null && spend > 0 ? round2(net / spend) : null;

    return {
      campaign_id: first.campaignId,
      campaign_path: first.campaignPath,
      funnel: first.funnel,
      date_from: from,
      date_to: to,
      trial_users: trialUsers,
      upsell_users: upsellUsers,
      upsell_cr: trialUsers ? roundRatio(upsellUsers / trialUsers) : 0,
      first_sub_users: firstSubUsers,
      trial_to_first_sub_cr: trialUsers ? roundRatio(firstSubUsers / trialUsers) : 0,
      refund_users: refundUsers,
      net_revenue: round2(net),
      spend: spend != null ? round2(spend) : null,
      cac,
      roas,
    } satisfies CampaignPerformanceRow;
  });

  return rows.sort((a, b) => b.trial_users - a.trial_users || a.campaign_id.localeCompare(b.campaign_id));
}
