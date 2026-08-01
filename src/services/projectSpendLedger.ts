// Browser bridge for the project spend ledger (Project Forecasting P2).
//
// The pure resolution/assembly logic lives in the shared module (one definition
// for browser + Edge); this file adds only the network call through the
// clickhouse-facebook Edge Function. Commissions arrive null by design — the
// client applies operator-supplied assumptions via applyManualCommissions before
// any outflow-derived metric can resolve (rev. 3 correction 4).
import { runClickHouseFacebook } from "@/services/clickhouse";
import type { DateWindow } from "@/services/funnelEconomics";
import type { ProjectSpendLedgerResult } from "../../supabase/functions/_shared/clickhouse/projectSpendLedger.ts";

export * from "../../supabase/functions/_shared/clickhouse/projectSpendLedger.ts";

export interface ProjectSpendLedgerResponse extends ProjectSpendLedgerResult {
  ok: boolean;
  action: "spend_ledger";
  window: DateWindow;
  error?: string;
}

export async function fetchProjectSpendLedger(window: DateWindow): Promise<ProjectSpendLedgerResponse> {
  const response = await runClickHouseFacebook<ProjectSpendLedgerResponse>({
    action: "spend_ledger",
    date_from: window.from,
    date_to: window.to,
  });
  if (!response.ok) throw new Error(response.error || "Project spend ledger request failed.");
  return response;
}
