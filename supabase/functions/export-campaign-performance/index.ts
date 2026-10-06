/* global Deno */

// export-campaign-performance: the Export API. Authenticated by API key
// (verify_jwt = false; GET), so it does not use serveWithAccess — the key path
// lives in ./handler.ts (pure, unit-tested): key hash → the key creator's
// resolve_access → api_export.use with funnel scope all → every read keyed by
// the workspace data key (ctx.tenantKey) through a ScopedReader. The policy
// (EXPORT_CAMPAIGN_PERFORMANCE_POLICY) is validated at boot like a gated
// function's.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { assertValidPolicy } from "../_shared/access/gate.ts";
import { EXPORT_CAMPAIGN_PERFORMANCE_POLICY } from "../_shared/access/policies/export-campaign-performance.ts";
import { createScopedReader } from "../_shared/clickhouse/scopedClient.ts";
import type { SupabaseLikeClient } from "../_shared/clickhouse/types.ts";
import { handleExportCampaignPerformance } from "./handler.ts";

assertValidPolicy(EXPORT_CAMPAIGN_PERFORMANCE_POLICY);

Deno.serve((req: Request) => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  return handleExportCampaignPerformance(req, {
    configError: supabaseUrl && serviceRoleKey ? null : "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not configured.",
    pg: () => createClient(supabaseUrl as string, serviceRoleKey as string, { auth: { persistSession: false } }) as unknown as SupabaseLikeClient,
    createClickHouse: (ctx) => createScopedReader(ctx),
  });
});
