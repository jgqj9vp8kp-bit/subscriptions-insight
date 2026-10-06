// Funnel data-scope primitives (plan §9, §20). Pure: no Deno globals, only Web
// Crypto (crypto.subtle exists in Deno, browsers and Node >= 19 / vitest).
//
// Semantics (§9): `all` is dynamic (future funnels and unattributed data);
// `selected` is an OR over the granted funnels and an EMPTY selection means zero
// rows, never "all"; `none` (no rule) means no data. Only `all` is unrestricted.

export type FunnelScope =
  | { mode: "all" }
  | { mode: "selected"; funnelIds: string[]; paths: string[] }
  | { mode: "none" };

export type FunnelScopeMode = FunnelScope["mode"];

/** Canonical campaign_path form used for scope matching — same normalization as
 * the registry / export paths elsewhere (trim, strip leading "/", lowercase) and
 * as resolve_access's lower(btrim(...)) expansion. */
export function canonicalPathForScope(path: unknown): string {
  return String(path ?? "")
    .trim()
    .replace(/^\/+/, "")
    .trim()
    .toLowerCase();
}

/** Canonical, de-duplicated, sorted, non-empty paths. */
export function canonicalScopePaths(paths: readonly unknown[] | null | undefined): string[] {
  const out = new Set<string>();
  for (const path of Array.isArray(paths) ? paths : []) {
    const canonical = canonicalPathForScope(path);
    if (canonical) out.add(canonical);
  }
  return [...out].sort();
}

/** De-duplicated, sorted, lower-cased funnel ids (uuids compare case-insensitively). */
export function canonicalFunnelIds(ids: readonly unknown[] | null | undefined): string[] {
  const out = new Set<string>();
  for (const id of Array.isArray(ids) ? ids : []) {
    const value = String(id ?? "").trim().toLowerCase();
    if (value) out.add(value);
  }
  return [...out].sort();
}

/** Stable text form of a scope: "all" | "none" | "selected:<sorted ids>". Two
 * members with the same funnel set produce the same string. */
export function scopeFingerprint(scope: FunnelScope): string {
  if (scope.mode === "all") return "all";
  if (scope.mode === "none") return "none";
  return `selected:${canonicalFunnelIds(scope.funnelIds).join(",")}`;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Hash of the funnel scope, for future scope-aware result caches (§20: keyed by
 * workspace + scopeHash + data version, so an admin entry can never match a
 * restricted key and two buyers with the same funnels share entries). */
export function scopeHash(scope: FunnelScope): Promise<string> {
  return sha256Hex(`funnel-scope|${scopeFingerprint(scope)}`);
}

/** Input string of the client cache partition, mirroring resolve_access's
 * sha256(workspace_id|user_id|access_version|scope-mode|sorted funnel ids).
 * The server-issued `partition` stays authoritative; this exists for parity
 * tests and diagnostics. */
export function accessPartitionInput(input: {
  workspaceId: string;
  userId: string;
  accessVersion: string;
  mode: FunnelScopeMode;
  funnelIds: readonly string[];
}): string {
  return [input.workspaceId, input.userId, input.accessVersion, input.mode, canonicalFunnelIds(input.funnelIds).join(",")].join("|");
}

export function computeAccessPartition(input: Parameters<typeof accessPartitionInput>[0]): Promise<string> {
  return sha256Hex(accessPartitionInput(input));
}
