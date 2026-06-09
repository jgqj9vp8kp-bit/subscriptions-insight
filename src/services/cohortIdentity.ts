import type { Funnel } from "@/services/types";

export function buildCohortId(funnel: Funnel | string | null | undefined, campaignPath: string | null | undefined, date: string): string {
  const normalizedFunnel = String(funnel ?? "").trim() || "unknown";
  const normalizedPath = String(campaignPath ?? "").trim() || "unknown";
  return `${normalizedFunnel}_${normalizedPath}_${date}`;
}
