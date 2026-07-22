import type { Funnel } from "./serviceTypes.ts";

export function buildCohortId(funnel: Funnel | string | null | undefined, campaignPath: string | null | undefined, date: string): string {
  const normalizedFunnel = String(funnel ?? "").trim() || "unknown";
  const normalizedPath = String(campaignPath ?? "").trim() || "unknown";
  return `${normalizedFunnel}_${normalizedPath}_${date}`;
}
