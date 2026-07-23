// Facebook Warehouse V2 — Phase 1 dual-writer (FB_WAREHOUSE_V2_DESIGN.md §9, Фаза 1).
// Runs BESIDE the existing V1 pipeline: raw API responses, per-grain daily facts,
// the batch-registry mirror and DQ results are written to the V2 tables while
// fact_facebook_stats keeps being written exactly as before. Readers stay on V1.
//
// Fail-safe by the same contract as fbSyncHistory: every V2 write swallows its own
// errors into `errors` — a completely absent V2 schema must leave the sync
// byte-for-byte identical. Lineage (batch_id / run_id) is SHARED with the Phase 1
// Postgres history tables: facebook_import_batches is the control plane, the
// ClickHouse registry only mirrors its status for view-side filtering.
//
// Grain invariant (§2): facts are entity × day. The V1 `day` level is the spend
// ground truth, not a fact grain, and is never written here. A row whose window
// is wider than one day is a grain violation: it is counted, reported through DQ
// and NOT written — V2 never stores interval rows.
//
// SCD2 dims (account/campaign/adset/ad) are synced on every publish — see
// fbWarehouseV2Dims.ts for the versioning rules.

import type { ClickHouseClientLike, SupabaseLikeClient } from "./types.ts";
import { ensureFbWarehouseV2Schema, FB_BATCH_REGISTRY_TABLE, FB_DQ_RESULTS_TABLE, FACT_FB_ACCOUNT_DAILY_TABLE, FACT_FB_AD_DAILY_TABLE, FACT_FB_ADSET_DAILY_TABLE, FACT_FB_CAMPAIGN_DAILY_TABLE, RAW_FACEBOOK_API_RESPONSES_TABLE } from "./fbWarehouseV2Schema.ts";
import { deriveDimCandidatesFromRows, syncFbV2Dims, type FbDimSourceRow } from "./fbWarehouseV2Dims.ts";

export const FB_SYNC_RUN_REQUESTS_TABLE = "facebook_sync_run_requests";

type CapsuledFetcherLike = (
  dateFrom: string,
  dateTo: string,
  level: string,
) => Promise<{ envelope: Record<string, unknown>; bytes: number; latencyMs: number }>;

export interface FbV2DqCheck {
  check_name: string;
  status: "pass" | "warn" | "fail";
  details: Record<string, unknown>;
}

interface BufferedRequest {
  response_id: string;
  request_seq: number;
  level: string;
  request_date: string;
  request_params: string;
  http_status: number;
  response_body: string;
  row_count: number;
  api_latency_ms: number;
  received_at: string;
}

interface FbV2FactSourceRow {
  stat_date: string;
  level: string;
  ad_account_id: string;
  campaign_id: string;
  adset_id: string;
  ad_id: string;
  currency: string;
  spend: number;
  impressions: number;
  reach: number;
  clicks: number;
  link_clicks: number;
  outbound_clicks: number;
  fb_purchases: number;
  purchase_value: number;
  /** Name attributes feed the SCD2 dims, never the facts. */
  ad_account_name?: string;
  buyer?: string;
  campaign_name?: string;
  adset_name?: string;
  ad_name?: string;
}

const FACT_TABLE_BY_LEVEL: Record<string, string> = {
  account: FACT_FB_ACCOUNT_DAILY_TABLE,
  campaign: FACT_FB_CAMPAIGN_DAILY_TABLE,
  adset: FACT_FB_ADSET_DAILY_TABLE,
  ad: FACT_FB_AD_DAILY_TABLE,
};

const KEY_COLUMNS_BY_LEVEL: Record<string, readonly string[]> = {
  account: ["ad_account_id"],
  campaign: ["ad_account_id", "campaign_id"],
  adset: ["ad_account_id", "campaign_id", "adset_id"],
  ad: ["ad_account_id", "campaign_id", "adset_id", "ad_id"],
};

/** Deterministic 64-bit FNV-1a over the business key + metrics, as a decimal
 * string (ClickHouse UInt64 accepts it). Used to diff rows between batches. */
export function fbV2RowHash(parts: readonly (string | number)[]): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const text = parts.join("|");
  for (let index = 0; index < text.length; index += 1) {
    hash ^= BigInt(text.charCodeAt(index));
    hash = (hash * prime) & 0xffffffffffffffffn;
  }
  return hash.toString(10);
}

export function createFbWarehouseV2Writer(input: {
  clickhouse: ClickHouseClientLike;
  supabase: SupabaseLikeClient;
  authUserId: string;
  batchId: string;
  runId: string;
  warehouseVersion: string;
  nowIso: string;
}): FbWarehouseV2Writer {
  return new FbWarehouseV2Writer(input);
}

export class FbWarehouseV2Writer {
  readonly errors: string[] = [];
  private readonly requests: BufferedRequest[] = [];
  private rawFlushed = false;
  private schemaEnsured = false;
  private requestSeq = 0;

  constructor(private readonly input: {
    clickhouse: ClickHouseClientLike;
    supabase: SupabaseLikeClient;
    authUserId: string;
    batchId: string;
    runId: string;
    warehouseVersion: string;
    nowIso: string;
  }) {}

  private async guard(step: string, work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error) {
      this.errors.push(`${step}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async ensureSchema(): Promise<void> {
    if (this.schemaEnsured) return;
    await ensureFbWarehouseV2Schema(this.input.clickhouse);
    this.schemaEnsured = true;
  }

  /** Pass-through wrapper recording every request (success AND failure) verbatim. */
  wrapFetcher(fetcher: CapsuledFetcherLike): CapsuledFetcherLike {
    return async (dateFrom, dateTo, level) => {
      this.requestSeq += 1;
      const seq = this.requestSeq;
      const startedIso = new Date().toISOString();
      try {
        const result = await fetcher(dateFrom, dateTo, level);
        this.bufferRequest({
          seq,
          level,
          dateFrom,
          dateTo,
          httpStatus: 200,
          body: safeJson(result.envelope),
          rowCount: Array.isArray((result.envelope as { rows?: unknown }).rows)
            ? ((result.envelope as { rows: unknown[] }).rows).length
            : 0,
          latencyMs: result.latencyMs,
          receivedAtIso: startedIso,
        });
        return result;
      } catch (error) {
        this.bufferRequest({
          seq,
          level,
          dateFrom,
          dateTo,
          httpStatus: 0,
          body: safeJson({ error: error instanceof Error ? error.message : String(error) }),
          rowCount: 0,
          latencyMs: 0,
          receivedAtIso: startedIso,
        });
        throw error;
      }
    };
  }

  private bufferRequest(request: {
    seq: number;
    level: string;
    dateFrom: string;
    dateTo: string;
    httpStatus: number;
    body: string;
    rowCount: number;
    latencyMs: number;
    receivedAtIso: string;
  }): void {
    try {
      this.requests.push({
        response_id: crypto.randomUUID(),
        request_seq: request.seq,
        level: request.level,
        request_date: request.dateFrom,
        request_params: `dateFrom=${request.dateFrom}&dateTo=${request.dateTo}&level=${request.level}`,
        http_status: request.httpStatus,
        response_body: request.body,
        row_count: request.rowCount,
        api_latency_ms: Math.round(request.latencyMs),
        received_at: request.receivedAtIso,
      });
    } catch {
      // Buffering must never break the fetch path.
    }
  }

  /** Mirror a facebook_import_batches status transition into ClickHouse. */
  async mirrorBatch(status: "staged" | "validated" | "published" | "rolled_back"): Promise<void> {
    await this.guard(`registry:${status}`, async () => {
      await this.ensureSchema();
      await this.input.clickhouse.insert({
        table: FB_BATCH_REGISTRY_TABLE,
        values: [{
          auth_user_id: this.input.authUserId,
          batch_id: this.input.batchId,
          status,
          version: this.input.warehouseVersion,
          published_seq: Date.now(),
          updated_at: new Date().toISOString(),
        }],
        format: "JSONEachRow",
      });
    });
  }

  private async flushRaw(): Promise<void> {
    if (this.rawFlushed || this.requests.length === 0) return;
    await this.guard("raw", async () => {
      await this.ensureSchema();
      await this.input.clickhouse.insert({
        table: RAW_FACEBOOK_API_RESPONSES_TABLE,
        values: this.requests.map((request) => ({
          auth_user_id: this.input.authUserId,
          sync_run_id: this.input.runId,
          ...request,
        })),
        format: "JSONEachRow",
      });
      this.rawFlushed = true;
    });
  }

  /** Publish the batch: raw responses, per-grain single-day facts, DQ, registry.
   * When the batch contains merged (multi-day) rows, facts are NOT written at all:
   * V1 mapped rows no longer carry their source window, so the only honest way to
   * keep the entity×day grain invariant is to withhold the whole suspect batch —
   * the grain_single_day DQ failure documents exactly why the facts are absent. */
  async publish(inputRows: {
    rows: readonly FbV2FactSourceRow[];
    sourceVersion: string | null;
    dqChecks: readonly FbV2DqCheck[];
    mergedRowsDetected: number;
  }): Promise<void> {
    await this.flushRaw();
    await this.guard("facts", async () => {
      if (inputRows.mergedRowsDetected > 0) return;
      await this.ensureSchema();
      const byTable = new Map<string, Record<string, unknown>[]>();
      for (const row of inputRows.rows) {
        const table = FACT_TABLE_BY_LEVEL[row.level];
        if (!table) continue; // `day` is validation ground truth, never a fact grain.
        const keyColumns = KEY_COLUMNS_BY_LEVEL[row.level];
        const factRow: Record<string, unknown> = {
          auth_user_id: this.input.authUserId,
          stat_date: row.stat_date,
          spend: row.spend,
          impressions: row.impressions,
          reach: row.reach,
          clicks: row.clicks,
          link_clicks: row.link_clicks,
          outbound_clicks: row.outbound_clicks,
          fb_purchases: row.fb_purchases,
          purchase_value: row.purchase_value,
          currency: row.currency,
          import_batch_id: this.input.batchId,
          sync_run_id: this.input.runId,
          source_version: inputRows.sourceVersion ?? this.input.warehouseVersion,
          ingested_at: this.input.nowIso,
        };
        for (const column of keyColumns) factRow[column] = row[column as keyof FbV2FactSourceRow];
        factRow.row_hash = fbV2RowHash([
          row.stat_date,
          ...keyColumns.map((column) => String(row[column as keyof FbV2FactSourceRow])),
          row.spend,
          row.impressions,
          row.clicks,
          row.outbound_clicks,
          row.fb_purchases,
          row.purchase_value,
          row.currency,
        ]);
        const list = byTable.get(table) ?? [];
        list.push(factRow);
        byTable.set(table, list);
      }
      for (const [table, values] of byTable) {
        await this.input.clickhouse.insert({ table, values, format: "JSONEachRow" });
      }
    });
    await this.guard("dims", async () => {
      if (inputRows.mergedRowsDetected > 0) return; // suspect batches feed no dims either
      await this.ensureSchema();
      const { accounts, campaigns, adsets, ads } = deriveDimCandidatesFromRows(inputRows.rows as readonly FbDimSourceRow[]);
      await syncFbV2Dims({
        clickhouse: this.input.clickhouse,
        authUserId: this.input.authUserId,
        importBatchId: this.input.batchId,
        nowIso: this.input.nowIso,
        accounts,
        campaigns,
        adsets,
        ads,
      });
    });
    await this.guard("dq", async () => {
      await this.ensureSchema();
      const computedAt = new Date().toISOString();
      const values = inputRows.dqChecks.map((check) => ({
        auth_user_id: this.input.authUserId,
        dq_id: crypto.randomUUID(),
        batch_id: this.input.batchId,
        sync_run_id: this.input.runId,
        check_name: check.check_name,
        status: check.status,
        details: safeJson(check.details),
        computed_at: computedAt,
      }));
      if (values.length) {
        await this.input.clickhouse.insert({ table: FB_DQ_RESULTS_TABLE, values, format: "JSONEachRow" });
      }
    });
    await this.mirrorBatch("published");
  }

  /** Failure path: keep the raw evidence (post-mortem) and mark the mirror rolled back. */
  async abort(): Promise<void> {
    await this.flushRaw();
    await this.mirrorBatch("rolled_back");
  }

  /** Control-plane request telemetry (Postgres, append-only; service-role writer). */
  async recordRequestTelemetry(): Promise<void> {
    if (this.requests.length === 0) return;
    await this.guard("telemetry", async () => {
      const builder = this.input.supabase.from(FB_SYNC_RUN_REQUESTS_TABLE);
      if (!builder.insert) return; // optional on fakes/legacy clients — silently skip
      const { error } = await builder.insert(
        this.requests.map((request) => ({
          auth_user_id: this.input.authUserId,
          run_id: this.input.runId,
          request_seq: request.request_seq,
          entity_level: request.level,
          request_date: request.request_date,
          http_status: request.http_status,
          row_count: request.row_count,
          api_latency_ms: request.api_latency_ms,
        })),
      );
      if (error) throw new Error(error.message);
    });
  }
}

/** Derive the standard DQ check set from the Phase 1 batch report + gate outputs. */
export function buildFbV2DqChecks(input: {
  dqReport: Record<string, unknown>;
  mergedRowsDetected: number;
  spendMismatchCount: number;
}): FbV2DqCheck[] {
  const coveragePct = Number(input.dqReport.coverage_pct ?? 0);
  const duplicateKeys = Number(input.dqReport.duplicate_keys ?? 0);
  return [
    {
      check_name: "coverage",
      status: coveragePct >= 100 ? "pass" : "warn",
      details: {
        coverage_pct: coveragePct,
        expected_days: input.dqReport.expected_days ?? null,
        covered_days: input.dqReport.covered_days ?? null,
        missing_dates: input.dqReport.missing_dates ?? [],
      },
    },
    {
      check_name: "duplicate_keys",
      status: duplicateKeys === 0 ? "pass" : "fail",
      details: { duplicate_keys: duplicateKeys, samples: input.dqReport.duplicate_key_samples ?? [] },
    },
    {
      check_name: "grain_single_day",
      status: input.mergedRowsDetected === 0 ? "pass" : "fail",
      details: { merged_rows_detected: input.mergedRowsDetected },
    },
    {
      check_name: "spend_cross_level",
      status: input.spendMismatchCount === 0 ? "pass" : "fail",
      details: { mismatched_levels: input.spendMismatchCount, spend_total: input.dqReport.spend_total ?? null },
    },
  ];
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return '{"error":"unserializable"}';
  }
}
