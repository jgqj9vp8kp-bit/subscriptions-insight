// Cohorts-specific query keys + filter normalization. Shared analytics primitives
// (user-scope hash, warehouse version, roots, array normalization) live in
// analyticsCache.ts and are re-exported here for existing importers.

import type { CohortRequest, CohortRefundStatus, CohortSort } from "../../supabase/functions/_shared/clickhouse/cohortContract";
import { ANALYTICS_CACHE_SCHEMA_VERSION, sortUniq } from "@/services/analyticsCache";

export {
  hashUserScope,
  warehouseVersionFromSummary,
  warehouseVersionFromSync,
  WAREHOUSE_DEPENDENT_ROOTS,
  WAREHOUSE_VERSION_KEY,
} from "@/services/analyticsCache";

// Back-compat alias (persistence schema version is analytics-wide).
export const COHORTS_CACHE_SCHEMA_VERSION = ANALYTICS_CACHE_SCHEMA_VERSION;
export const COHORTS_QUERY_ROOT = "cohorts" as const;

export interface NormalizedCohortRequest {
  action: "list";
  date_from: string | null;
  date_to: string | null;
  group_by: string | null;
  max_renewal_depth: number | null;
  refund_status: CohortRefundStatus;
  sort: { field: string; direction: string } | null;
  funnel: string[];
  campaign_path: string[];
  campaign_id: string[];
  traffic_source: string[];
  price_plan: string[];
  media_buyer: string[];
  country: string[];
  card_type: string[];
  currency: string[];
  transaction_type: string[];
}

// Canonicalize a CohortRequest so logically-identical filters are byte-identical.
export function normalizeCohortRequest(req: CohortRequest, opts: { includeSort?: boolean } = {}): NormalizedCohortRequest {
  const f = req.filters ?? {};
  const sort: CohortSort | undefined = req.sort;
  return {
    action: "list",
    date_from: req.date_from || null,
    date_to: req.date_to || null,
    group_by: req.group_by ?? null,
    max_renewal_depth: req.max_renewal_depth ?? null,
    refund_status: (f.refund_status as CohortRefundStatus) ?? "all",
    sort: opts.includeSort && sort ? { field: sort.field, direction: sort.direction } : null,
    funnel: sortUniq(f.funnel),
    campaign_path: sortUniq(f.campaign_path),
    campaign_id: sortUniq(f.campaign_id),
    traffic_source: sortUniq(f.traffic_source),
    price_plan: sortUniq(f.price_plan),
    media_buyer: sortUniq(f.media_buyer),
    country: sortUniq(f.country),
    card_type: sortUniq(f.card_type),
    currency: sortUniq(f.currency),
    transaction_type: sortUniq(f.transaction_type),
  };
}

export interface CohortsKeyParts {
  userScopeHash: string;
  dataSource: "clickhouse" | "legacy";
  warehouseVersion: string;
  request: CohortRequest;
}

export function cohortsListKey(parts: CohortsKeyParts): [string, "list", string, string, string, NormalizedCohortRequest] {
  return [
    COHORTS_QUERY_ROOT,
    "list",
    parts.userScopeHash,
    parts.dataSource,
    parts.warehouseVersion,
    normalizeCohortRequest(parts.request),
  ];
}

export interface CohortDetailsKeyParts {
  userScopeHash: string;
  warehouseVersion: string;
  cohortKey: { cohort_date: string; funnel: string; campaign_path: string };
  request: CohortRequest;
  include?: Record<string, boolean>;
}

export function cohortDetailsKey(parts: CohortDetailsKeyParts): [string, "details", string, string, string, NormalizedCohortRequest, Record<string, boolean> | null] {
  const ck = parts.cohortKey;
  return [
    COHORTS_QUERY_ROOT,
    "details",
    parts.userScopeHash,
    parts.warehouseVersion,
    `${ck.cohort_date}|${ck.funnel}|${ck.campaign_path}`,
    normalizeCohortRequest(parts.request),
    parts.include ?? null,
  ];
}
