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
