// Frontend bridge to the fb-analytics-summary Edge Function. Parity-first rollout:
// the server path is used only when VITE_FB_ANALYTICS_SOURCE=server; the default
// keeps the in-browser compute. In DEV the page reconciles both and warns on drift.

import { supabase } from "@/services/supabaseClient";
import type { FbAnalyticsFilters } from "@/services/fbAnalytics";
import {
  FB_ANALYTICS_SUMMARY_FUNCTION,
  type FbAnalyticsSummaryResponse,
} from "../../supabase/functions/_shared/clickhouse/fbAnalyticsSummary.ts";

export type FbAnalyticsSource = "client" | "server";

export function fbAnalyticsSource(): FbAnalyticsSource {
  return import.meta.env.VITE_FB_ANALYTICS_SOURCE === "server" ? "server" : "client";
}

export async function fetchFbAnalyticsSummary(filters: FbAnalyticsFilters): Promise<FbAnalyticsSummaryResponse> {
  if (!supabase) throw new Error("Supabase is not configured.");
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  if (sessionError || !token) throw new Error("Sign in before loading the FB analytics summary.");

  const { data, error } = await supabase.functions.invoke(FB_ANALYTICS_SUMMARY_FUNCTION, {
    body: { filters },
    headers: { Authorization: `Bearer ${token}` },
  });
  if (error) {
    const context = (error as { context?: unknown }).context;
    let message = error.message;
    if (context instanceof Response) {
      const text = await context.clone().text().catch(() => "");
      message = text.slice(0, 500) || message;
      try {
        const payload = JSON.parse(text) as { error?: unknown };
        if (payload && payload.error != null) message = String(payload.error);
      } catch {
        // Keep the raw body text when the Edge Function returns non-JSON.
      }
    }
    throw new Error(`FB analytics summary failed: ${message}`);
  }
  if (!data || typeof data !== "object" || (data as { ok?: unknown }).ok !== true) {
    throw new Error("FB analytics summary returned an invalid response.");
  }
  return data as FbAnalyticsSummaryResponse;
}
