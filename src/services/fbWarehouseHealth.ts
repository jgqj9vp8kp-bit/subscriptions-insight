// Warehouse Health panel data: parses stored recon snapshots (Wave 4) into the
// latest-state view plus the Wave 5 cutover gate tracker (7 consecutive green
// parity days). Pure — the UI component stays thin.

export interface ParsedReconSnapshot {
  computed_at: string;
  window_from: string;
  window_to: string;
  health: "green" | "yellow" | "red";
  source_spend: number;
  funnel_resolved_spend: number;
  user_allocated_spend: number;
  allocated_campaign_spend: number;
  no_user_spend: number;
  unknown_funnel_spend: number;
  unknown_campaign_spend: number;
  coverage_pct: number;
  suggested_share_pct: number;
  known_gap_days: number;
  dq_warn_count: number;
  dq_fail_count: number;
  campaigns_total: number;
  campaigns_allocated: number;
  campaigns_no_user: number;
  campaigns_unknown_funnel: number;
  campaigns_unknown: number;
  v2_parity: {
    verdict: "parity" | "mismatch" | "no_overlap";
    overlap_days: number;
    matched_days: number;
    mismatched_count: number;
    overlap_spend_diff: number;
  } | null;
}

export interface ParityGateDay {
  date: string;
  verdict: "parity" | "mismatch" | "no_overlap" | "none";
}

export interface WarehouseHealthView {
  latest: ParsedReconSnapshot | null;
  snapshots: ParsedReconSnapshot[];
  /** Last 7 calendar days with the day's FINAL parity verdict (newest last). */
  gateDays: ParityGateDay[];
  /** Consecutive days ending with the most recent snapshot day whose verdict is "parity". */
  consecutiveGreenDays: number;
  gateSatisfied: boolean;
}

export const PARITY_GATE_REQUIRED_DAYS = 7;

const num = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

export function parseReconSnapshotRow(row: Record<string, unknown>): ParsedReconSnapshot {
  let details: Record<string, unknown> = {};
  try {
    details = typeof row.details === "string" ? (JSON.parse(row.details) as Record<string, unknown>) : ((row.details as Record<string, unknown>) ?? {});
  } catch {
    details = {};
  }
  const rawParity = details.v2_parity as ParsedReconSnapshot["v2_parity"] | undefined;
  const health = row.health === "green" || row.health === "red" ? row.health : "yellow";
  return {
    computed_at: String(row.computed_at ?? ""),
    window_from: String(row.window_from ?? ""),
    window_to: String(row.window_to ?? ""),
    health,
    source_spend: num(row.source_spend),
    funnel_resolved_spend: num(row.funnel_resolved_spend),
    user_allocated_spend: num(row.user_allocated_spend),
    allocated_campaign_spend: num(row.allocated_campaign_spend),
    no_user_spend: num(row.no_user_spend),
    unknown_funnel_spend: num(row.unknown_funnel_spend),
    unknown_campaign_spend: num(row.unknown_campaign_spend),
    coverage_pct: num(row.coverage_pct),
    suggested_share_pct: num(row.suggested_share_pct),
    known_gap_days: num(row.known_gap_days),
    dq_warn_count: num(row.dq_warn_count),
    dq_fail_count: num(row.dq_fail_count),
    campaigns_total: num(row.campaigns_total),
    campaigns_allocated: num(row.campaigns_allocated),
    campaigns_no_user: num(row.campaigns_no_user),
    campaigns_unknown_funnel: num(row.campaigns_unknown_funnel),
    campaigns_unknown: num(row.campaigns_unknown),
    v2_parity: rawParity && typeof rawParity === "object" && "verdict" in rawParity ? rawParity : null,
  };
}

export function buildWarehouseHealthView(rows: Array<Record<string, unknown>>): WarehouseHealthView {
  const snapshots = rows
    .map(parseReconSnapshotRow)
    .filter((snapshot) => snapshot.computed_at)
    .sort((a, b) => b.computed_at.localeCompare(a.computed_at));

  // The day's FINAL verdict wins (snapshots are sorted newest-first).
  const verdictByDay = new Map<string, ParityGateDay["verdict"]>();
  for (const snapshot of snapshots) {
    const day = snapshot.computed_at.slice(0, 10);
    if (!day || verdictByDay.has(day)) continue;
    verdictByDay.set(day, snapshot.v2_parity?.verdict ?? "none");
  }

  const days = [...verdictByDay.entries()]
    .map(([date, verdict]) => ({ date, verdict }))
    .sort((a, b) => a.date.localeCompare(b.date));

  let consecutiveGreenDays = 0;
  for (let index = days.length - 1; index >= 0; index -= 1) {
    if (days[index].verdict !== "parity") break;
    consecutiveGreenDays += 1;
  }

  return {
    latest: snapshots[0] ?? null,
    snapshots,
    gateDays: days.slice(-PARITY_GATE_REQUIRED_DAYS),
    consecutiveGreenDays,
    gateSatisfied: consecutiveGreenDays >= PARITY_GATE_REQUIRED_DAYS,
  };
}
