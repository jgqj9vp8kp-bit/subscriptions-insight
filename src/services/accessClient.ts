// Frontend access client: the browser's answer to "what may I do here?"
// (plan §14, §25).
//
// It calls public.my_access(), a SECURITY DEFINER RPC over auth.uid() exposed
// through PostgREST (cheap, no Edge cold start). The JSON is the same as the
// server-side resolve_access() MINUS data_key: the browser never learns the
// workspace tenant key, and this module drops the field even if a future server
// sends it.
//
// This is UX only. The Edge gate re-resolves access on every request and is the
// authority, so the client may be lenient in exactly one place: while the
// server is not bootstrapped yet (RPC missing, or status "no_workspace") the
// result is "legacy" and the UI behaves exactly as it does today. Every other
// failure is an explicit "error" — the UI offers Retry, never "allow".

export type MyAccessStatus = "ok" | "legacy" | "no_workspace" | "no_membership" | "disabled" | "error";

export interface MyAccessRole {
  id: string;
  key: string;
  name: string;
  is_owner: boolean;
  /** Granted keys as stored on the role; effective permissions are derived
   * client-side with effectivePermissions() from the shared catalog. */
  permissions: string[];
}

export interface MyAccessFunnelScope {
  /** "none" when no scope rule exists (no rule ⇒ no data, plan §9). */
  mode: "all" | "selected" | "none";
  funnel_ids: string[];
  /** Canonical campaign paths of the selected funnels (display only). */
  paths: string[];
}

export interface MyAccess {
  status: MyAccessStatus;
  workspace_id: string | null;
  member_id: string | null;
  user_id: string | null;
  email: string | null;
  display_name: string | null;
  is_data_owner: boolean;
  /** user_id = workspace data_key: raw-download / client-compute paths (D8). */
  raw_access: boolean;
  role: MyAccessRole | null;
  funnel_scope: MyAccessFunnelScope | null;
  /** member.access_version as text; "" unless status is "ok". */
  access_version: string;
  /** Server-issued cache partition (hex sha256); "" unless status is "ok". */
  partition: string;
  /** Diagnostic for status "error" (for logs; not meant to be shown verbatim). */
  error?: string;
}

/** The slice of the supabase-js client this module needs (test seam). */
export interface MyAccessRpcClient {
  rpc(fn: string): PromiseLike<unknown>;
}

export const MY_ACCESS_RPC = "my_access";

/** A hung RPC must not keep the app on the loading screen forever. */
export const MY_ACCESS_TIMEOUT_MS = 15_000;

const SERVER_STATUSES: ReadonlySet<string> = new Set(["ok", "no_workspace", "no_membership", "disabled"]);

function baseAccess(status: MyAccessStatus, extra: Partial<MyAccess> = {}): MyAccess {
  return {
    status,
    workspace_id: null,
    member_id: null,
    user_id: null,
    email: null,
    display_name: null,
    is_data_owner: false,
    raw_access: false,
    role: null,
    funnel_scope: null,
    access_version: "",
    partition: "",
    ...extra,
  };
}

/** The "server not bootstrapped / no Supabase" result: the UI behaves as today. */
export function legacyAccess(): MyAccess {
  return baseAccess("legacy");
}

export function errorAccess(message: string): MyAccess {
  return baseAccess("error", { error: message });
}

function record(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      return record(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function nonEmpty(value: unknown): string | null {
  const parsed = text(value);
  return parsed && parsed.length > 0 ? parsed : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/** Parses the my_access() JSON into a MyAccess. Unknown shapes and "ok" rows
 * missing anything the UI relies on become status "error" (fail closed);
 * "no_workspace" becomes "legacy". Never copies data_key. */
export function parseMyAccessPayload(raw: unknown): MyAccess {
  const row = record(raw);
  if (!row) return errorAccess("my_access returned no object");
  const status = text(row.status);
  if (!status || !SERVER_STATUSES.has(status)) return errorAccess(`my_access returned an unknown status: ${String(row.status)}`);
  if (status === "no_workspace") return legacyAccess();

  const identity = {
    workspace_id: text(row.workspace_id),
    user_id: text(row.user_id),
  };
  if (status === "no_membership" || status === "disabled") {
    return baseAccess(status, identity);
  }

  // status "ok": everything the UI keys on must be present.
  const roleRow = record(row.role);
  const scopeRow = record(row.funnel_scope);
  const role: MyAccessRole | null = roleRow && nonEmpty(roleRow.id) && nonEmpty(roleRow.key)
    ? {
      id: text(roleRow.id) as string,
      key: text(roleRow.key) as string,
      name: text(roleRow.name) ?? (text(roleRow.key) as string),
      is_owner: roleRow.is_owner === true,
      permissions: stringArray(roleRow.permissions),
    }
    : null;
  const mode = text(scopeRow?.mode);
  const funnelScope: MyAccessFunnelScope = scopeRow
    ? {
      mode: mode === "all" || mode === "selected" ? mode : "none",
      funnel_ids: stringArray(scopeRow.funnel_ids),
      paths: stringArray(scopeRow.paths),
    }
    : { mode: "none", funnel_ids: [], paths: [] };

  const access = baseAccess("ok", {
    workspace_id: nonEmpty(row.workspace_id),
    member_id: nonEmpty(row.member_id),
    user_id: nonEmpty(row.user_id),
    email: text(row.email),
    display_name: text(row.display_name),
    is_data_owner: row.is_data_owner === true,
    raw_access: row.raw_access === true,
    role,
    funnel_scope: funnelScope,
    access_version: nonEmpty(row.access_version) ?? "",
    partition: nonEmpty(row.partition) ?? "",
  });
  const missing = [
    access.workspace_id ? null : "workspace_id",
    access.member_id ? null : "member_id",
    access.user_id ? null : "user_id",
    access.role ? null : "role",
    access.access_version ? null : "access_version",
    access.partition ? null : "partition",
  ].filter(Boolean);
  if (missing.length) return errorAccess(`my_access ok payload is missing: ${missing.join(", ")}`);
  return access;
}

interface RpcErrorLike {
  code?: unknown;
  message?: unknown;
}

/** PostgREST answers PGRST202 ("could not find the function ... in the schema
 * cache") — or a bare 404 — when the migration that adds my_access() has not
 * been applied yet. That is the only error that means "legacy". */
export function isMissingRpcError(error: RpcErrorLike | null | undefined, status?: unknown): boolean {
  if (status === 404) return true;
  return Boolean(error && typeof error === "object" && error.code === "PGRST202");
}

function timeoutAfter(ms: number): { promise: Promise<never>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`my_access did not answer within ${ms} ms`)), ms);
  });
  return { promise, cancel: () => timer !== undefined && clearTimeout(timer) };
}

/** Fetches and parses the caller's access. Never throws.
 *  - no client (Supabase not configured / local dev auth) → "legacy";
 *  - RPC missing (PGRST202 / 404) or status "no_workspace" → "legacy";
 *  - ok / no_membership / disabled → passed through (validated);
 *  - anything else (network, timeout, permission, malformed) → "error". */
export async function fetchMyAccess(
  client: MyAccessRpcClient | null | undefined,
  options: { timeoutMs?: number } = {},
): Promise<MyAccess> {
  if (!client) return legacyAccess();
  const timeoutMs = options.timeoutMs ?? MY_ACCESS_TIMEOUT_MS;
  const timeout = timeoutAfter(timeoutMs);
  try {
    const response = record(await Promise.race([client.rpc(MY_ACCESS_RPC), timeout.promise])) ?? {};
    const error = (response.error ?? null) as RpcErrorLike | null;
    if (isMissingRpcError(error, response.status)) return legacyAccess();
    if (error) {
      const code = text(error.code);
      const message = text(error.message) ?? "unknown error";
      return errorAccess(`my_access failed${code ? ` (${code})` : ""}: ${message}`);
    }
    if (response.data === null || response.data === undefined) return errorAccess("my_access returned no data");
    return parseMyAccessPayload(response.data);
  } catch (error) {
    return errorAccess(error instanceof Error ? error.message : String(error));
  } finally {
    timeout.cancel();
  }
}
