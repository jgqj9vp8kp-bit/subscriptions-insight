import { publicRuntimeConfig } from "@/config/publicRuntimeConfig";
import { supabase } from "@/services/supabaseClient";
import {
  API_KEY_SCOPE_CAMPAIGN_PERFORMANCE,
  apiKeyPrefix,
  generateApiKey,
  hashApiKey,
} from "@/services/apiKeys";

export interface ApiKeyRecord {
  id: string;
  name: string;
  prefix: string;
  is_active: boolean;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  allowed_scopes: string[];
  metadata: Record<string, unknown> | null;
}

export interface CreateApiKeyResult {
  rawKey: string;
  record: ApiKeyRecord;
}

export interface ApiExportLogRecord {
  id: string;
  api_key_id: string | null;
  user_id: string;
  endpoint: string;
  params: Record<string, unknown>;
  status_code: number;
  rows_returned: number;
  created_at: string;
  error_message: string | null;
  key_prefix?: string | null;
}

function ensureSupabase() {
  if (!supabase) throw new Error("Supabase is not configured.");
  return supabase;
}

async function currentUserId(): Promise<string> {
  const client = ensureSupabase();
  const { data, error } = await client.auth.getUser();
  if (error || !data.user?.id) throw new Error("Sign in before managing integrations.");
  return data.user.id;
}

export function exportCampaignPerformanceEndpoint(): string {
  const baseUrl = publicRuntimeConfig.supabaseUrl.replace(/\/+$/, "");
  return `${baseUrl}/functions/v1/export-campaign-performance`;
}

export async function listApiKeys(): Promise<ApiKeyRecord[]> {
  const client = ensureSupabase();
  const { data, error } = await client
    .from("api_keys")
    .select("id,name,prefix,is_active,created_at,last_used_at,revoked_at,allowed_scopes,metadata")
    .order("created_at", { ascending: false });
  if (error) throw new Error(`Could not load API keys: ${error.message}`);
  return (data ?? []) as ApiKeyRecord[];
}

export async function createApiKey(name: string): Promise<CreateApiKeyResult> {
  const userId = await currentUserId();
  const client = ensureSupabase();
  const rawKey = generateApiKey();
  const keyHash = await hashApiKey(rawKey);
  const { data, error } = await client
    .from("api_keys")
    .insert({
      user_id: userId,
      name: name.trim() || "Campaign performance export",
      key_hash: keyHash,
      prefix: apiKeyPrefix(rawKey),
      is_active: true,
      allowed_scopes: [API_KEY_SCOPE_CAMPAIGN_PERFORMANCE],
      metadata: { created_from: "integrations_page" },
    })
    .select("id,name,prefix,is_active,created_at,last_used_at,revoked_at,allowed_scopes,metadata")
    .single();
  if (error) throw new Error(`Could not create API key: ${error.message}`);
  return { rawKey, record: data as ApiKeyRecord };
}

export async function revokeApiKey(id: string): Promise<void> {
  const client = ensureSupabase();
  const { error } = await client
    .from("api_keys")
    .update({ is_active: false, revoked_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(`Could not revoke API key: ${error.message}`);
}

export interface ExportApiHealth {
  /** Rows in the transaction warehouse for the current user (read server-side, RLS-scoped). */
  transactionsCount: number;
  latestTransactionAt: string | null;
  latestTrafficSnapshotAt: string | null;
  activeApiKeys: number;
  /** Distinct import batches (CSV parts) in the warehouse. */
  importBatches: number;
  /** Rows belonging to the most recent import batch. */
  latestBatchRows: number;
  /** Rows from earlier import batches; > 0 means more than just the latest CSV is stored. */
  rowsOutsideLatestBatch: number;
  /** The Export API always reads the full warehouse across all batches (never the latest batch only). */
  usesFullWarehouse: boolean;
  /** Ready when the warehouse has rows AND an active API key exists, i.e. the Export API can serve. */
  ready: boolean;
}

/**
 * Status of the data the Export API serves. Read directly from Supabase (warehouse + traffic
 * snapshots) so it reflects exactly what the server-side Edge Function sees — it does NOT consult the
 * browser analytics cache, so it is unaffected by "Refresh local analytics cache from DB".
 */
export async function getExportApiHealth(): Promise<ExportApiHealth> {
  const client = ensureSupabase();
  const [txResult, trafficResult, keysResult, batchesResult] = await Promise.all([
    client
      .from("transactions")
      .select("event_time", { count: "exact" })
      .is("deleted_at", null)
      .order("event_time", { ascending: false })
      .limit(1),
    client
      .from("data_snapshots")
      .select("updated_at")
      .eq("dataset_type", "facebook_traffic")
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    client
      .from("api_keys")
      .select("id", { count: "exact", head: true })
      .eq("is_active", true)
      .is("revoked_at", null),
    client
      .from("import_batches")
      .select("id", { count: "exact" })
      .order("imported_at", { ascending: false })
      .limit(1),
  ]);

  if (txResult.error) throw new Error(`Could not read warehouse status: ${txResult.error.message}`);

  const transactionsCount = txResult.count ?? 0;
  const latestTransactionAt = (txResult.data?.[0] as { event_time?: string } | undefined)?.event_time ?? null;
  const latestTrafficSnapshotAt = (trafficResult.data as { updated_at?: string } | null)?.updated_at ?? null;
  const activeApiKeys = keysResult.count ?? 0;
  const importBatches = batchesResult.count ?? 0;
  const latestBatchId = (batchesResult.data?.[0] as { id?: string } | undefined)?.id ?? null;

  let latestBatchRows = 0;
  if (latestBatchId) {
    const { count } = await client
      .from("transactions")
      .select("id", { count: "exact", head: true })
      .is("deleted_at", null)
      .eq("import_batch_id", latestBatchId);
    latestBatchRows = count ?? 0;
  }

  return {
    transactionsCount,
    latestTransactionAt,
    latestTrafficSnapshotAt,
    activeApiKeys,
    importBatches,
    latestBatchRows,
    rowsOutsideLatestBatch: Math.max(0, transactionsCount - latestBatchRows),
    usesFullWarehouse: true,
    ready: transactionsCount > 0 && activeApiKeys > 0,
  };
}

export async function listApiExportLogs(limit = 20): Promise<ApiExportLogRecord[]> {
  const client = ensureSupabase();
  const { data, error } = await client
    .from("api_export_logs")
    .select("id,api_key_id,user_id,endpoint,params,status_code,rows_returned,created_at,error_message,key_prefix")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`Could not load export logs: ${error.message}`);
  return (data ?? []) as ApiExportLogRecord[];
}
