import { sha256Hex } from "@/services/sha256";

export const API_KEY_PREFIX = "subengine_live_";
export const API_KEY_SCOPE_CAMPAIGN_PERFORMANCE = "campaign_performance:read";

export { sha256Hex };

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function generateApiKey(randomBytes?: Uint8Array): string {
  const bytes = randomBytes ?? crypto.getRandomValues(new Uint8Array(32));
  return `${API_KEY_PREFIX}${bytesToBase64Url(bytes)}`;
}

export function apiKeyPrefix(rawKey: string): string {
  return rawKey.slice(0, API_KEY_PREFIX.length + 8);
}

export function isSubengineApiKey(rawKey: string): boolean {
  return rawKey.startsWith(API_KEY_PREFIX) && rawKey.length > API_KEY_PREFIX.length + 16;
}

export async function hashApiKey(rawKey: string): Promise<string> {
  return sha256Hex(rawKey.trim());
}

export async function apiKeyMatchesHash(rawKey: string, storedHash: string): Promise<boolean> {
  if (!isSubengineApiKey(rawKey)) return false;
  return (await hashApiKey(rawKey)) === storedHash;
}

export interface ApiKeyValidationRecord {
  key_hash: string;
  is_active: boolean;
  revoked_at?: string | null;
  allowed_scopes?: string[] | null;
}

export type ApiKeyValidationResult =
  | { ok: true; status: 200 }
  | { ok: false; status: 401; reason: "invalid_key" | "revoked_key" | "missing_scope" };

export async function validateApiKeyRecord(
  rawKey: string,
  record: ApiKeyValidationRecord | null | undefined,
  requiredScope = API_KEY_SCOPE_CAMPAIGN_PERFORMANCE,
): Promise<ApiKeyValidationResult> {
  if (!record || !await apiKeyMatchesHash(rawKey, record.key_hash)) {
    return { ok: false, status: 401, reason: "invalid_key" };
  }
  if (!record.is_active || record.revoked_at) {
    return { ok: false, status: 401, reason: "revoked_key" };
  }
  if (requiredScope && !record.allowed_scopes?.includes(requiredScope)) {
    return { ok: false, status: 401, reason: "missing_scope" };
  }
  return { ok: true, status: 200 };
}
