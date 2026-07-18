// Shared analytics query-cache primitives, reused by Cohorts, Users, and Payment
// Pass Analytics: the non-reversible user-scope hash, the hashed warehouse-version
// fingerprint, the warehouse-dependent query roots, and array normalization.
//
// No raw user identifiers or cursor ids ever appear in a key or persisted storage —
// only non-reversible hashes.

import type { ClickHouseSummary } from "@/services/clickhouse";

// v3: CohortRow grew renewal_3_to_renewal_4_cr / 4→5 / 5→6.
// v4: CohortRow grew the FB Analytics block (fb_spend…fb_match_status) and the
// bundle carries fb_totals/fb_diagnostics — pre-FB bundles must be discarded.
export const ANALYTICS_CACHE_SCHEMA_VERSION = 4;

export const WAREHOUSE_VERSION_KEY = ["clickhouse", "warehouse-version"] as const;
export const SUPPORT_WAREHOUSE_VERSION_KEY = ["clickhouse", "support-warehouse-version"] as const;
export const WAREHOUSE_ANALYTICS_INVALIDATED_EVENT = "warehouse-analytics-invalidated";

// Analytics query roots that depend on warehouse transaction data. Invalidated
// together after a successful CSV import + ClickHouse auto-sync, and persisted by
// the shared persistence layer. fb-analytics rides the same lifecycle (persist,
// logout clear, external invalidation) — its own re-keying comes from the FB
// warehouse version, so a transaction-sync invalidation is just a cheap refetch.
export const WAREHOUSE_DEPENDENT_ROOTS: readonly string[] = ["cohorts", "users", "payment-analytics", "support", "fb-analytics"];

function fnv(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

// Non-reversible per-user scope for cache isolation — never exposes the raw id/email.
export function hashUserScope(userId: string | null | undefined): string {
  const input = (userId ?? "anonymous").trim() || "anonymous";
  return `u_${fnv(input)}`;
}

// Deterministic array normalization: dedupe + trim + sort, so two logically
// identical filter sets produce byte-identical keys.
export function sortUniq(v: readonly string[] | undefined | null): string[] {
  return Array.from(new Set((v ?? []).map((x) => String(x).trim()).filter(Boolean))).sort();
}

// A stable, HASHED fingerprint of the warehouse state that changes after a
// successful sync (new cursor / row count). No raw cursor id is exposed.
export function warehouseVersionFromSummary(summary: ClickHouseSummary | null | undefined): string {
  const st = summary?.sync_state;
  const cohortSnapshot = summary?.cohort_snapshot_state;
  const cursorId = st?.cursor_transaction_id ?? "";
  const cursorAt = st?.cursor_updated_at ?? "";
  const total = st?.clickhouse_total ?? summary?.transaction_count ?? "";
  const snapshotVersion = [
    cohortSnapshot?.status ?? "",
    cohortSnapshot?.active_warehouse_version ?? "",
    cohortSnapshot?.active_classification_version ?? "",
    cohortSnapshot?.active_generated_at ?? "",
    cohortSnapshot?.users_classified ?? "",
  ].join(":");
  if (!cursorId && !cursorAt && total === "" && !snapshotVersion.replace(/:/g, "")) return "whv_unknown";
  return `whv_${fnv(`${cursorId}:${cursorAt}:${total}:${snapshotVersion}`)}`;
}

export function supportWarehouseVersionFromSummary(summary: ClickHouseSummary | null | undefined): string {
  const supportSync = summary?.support_sync_state;
  const cohortSnapshot = summary?.cohort_snapshot_state;
  const supportAttribution = supportSync?.diagnostics?.attribution;
  const attribution = supportAttribution && typeof supportAttribution === "object"
    ? supportAttribution as Record<string, unknown>
    : {};
  const value = [
    supportSync?.cursor_transaction_id ?? "",
    supportSync?.cursor_updated_at ?? "",
    supportSync?.clickhouse_total ?? "",
    supportSync?.status ?? "",
    attribution.attribution_version ?? "",
    attribution.funnel_matched ?? "",
    attribution.unknown ?? "",
    cohortSnapshot?.active_warehouse_version ?? "",
    cohortSnapshot?.active_classification_version ?? "",
    cohortSnapshot?.active_generated_at ?? "",
  ].join(":");
  return value.replace(/:/g, "") ? `swhv_${fnv(value)}` : "swhv_unknown";
}

export function warehouseVersionFromSync(sync: { cursor_transaction_id?: string | null; clickhouse_total?: number | null } | null | undefined): string {
  if (!sync || (!sync.cursor_transaction_id && sync.clickhouse_total == null)) return "whv_unknown";
  return `whv_${fnv(`${sync.cursor_transaction_id ?? ""}::${sync.clickhouse_total ?? ""}`)}`;
}
