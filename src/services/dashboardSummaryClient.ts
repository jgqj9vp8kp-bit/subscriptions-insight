// Frontend bridge to the dashboard-summary Edge Function. Parity-first rollout:
// the server path is fetched only when VITE_DASHBOARD_SOURCE=server; the page keeps
// rendering the in-browser compute and (in DEV) reconciles both, warning on drift.
// Rendering switches to the server response in a later step, after real-data parity.

import { supabase } from "@/services/supabaseClient";
import {
  DASHBOARD_SUMMARY_FUNCTION,
  type DashboardSummaryFilters,
  type DashboardSummaryResponse,
} from "../../supabase/functions/_shared/clickhouse/dashboardSummary.ts";

export type DashboardSource = "client" | "server";

export function dashboardSource(): DashboardSource {
  return import.meta.env.VITE_DASHBOARD_SOURCE === "server" ? "server" : "client";
}

export async function fetchDashboardSummary(filters: DashboardSummaryFilters): Promise<DashboardSummaryResponse> {
  if (!supabase) throw new Error("Supabase is not configured.");
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  if (sessionError || !token) throw new Error("Sign in before loading the dashboard summary.");

  const { data, error } = await supabase.functions.invoke(DASHBOARD_SUMMARY_FUNCTION, {
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
    throw new Error(`Dashboard summary failed: ${message}`);
  }
  if (!data || typeof data !== "object" || (data as { ok?: unknown }).ok !== true) {
    throw new Error("Dashboard summary returned an invalid response.");
  }
  return data as DashboardSummaryResponse;
}
