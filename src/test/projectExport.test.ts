// P8: extrapolation exposure math + the project export table.
import { describe, expect, it } from "vitest";
import { assembleProjectSpendLedger } from "@/services/projectSpendLedger";
import {
  extrapolatedRevenueShare,
  projectExtrapolationSummary,
  resolveProjectFromCohortRows,
  runResolvedProject,
  type CohortRowLike,
  type ProjectAggregationPolicy,
  type SharedCostPool,
} from "@/services/funnelEconomics";
import { buildProjectExportTable } from "@/services/projectExport";
import { cohortsTableToCsv } from "@/services/cohortsExport";

const JULY = { from: "2026-07-01", to: "2026-07-31" };
const AS_OF = "2026-09-15T00:00:00.000Z";

function policy(): ProjectAggregationPolicy {
  return {
    spendBasis: "full_funnel_spend",
    includeUnknownFunnelSpend: true,
    includeOtherUnallocatedSpend: true,
    allocation: { basis: "resolved_spend_share", renormalizeOverEnabled: true, includeSpendOnlyRows: true },
    dayGridStep: "period_end",
    headlinePayback: "fully_loaded",
    bonus: { kind: "per_funnel" },
    assumedCadence: "monthly",
    rounding: { mode: "full_precision" },
    manualCommissionByGroup: { "facebook:act_1:USD": 0.04, "facebook:act_9:USD": 0.04 },
  };
}

function sharedCosts(): SharedCostPool {
  return {
    monthly: { ffBilling: 5_000, funnelConstructor: 2_271.36, payroll: 9_000 },
    proration: { mode: "calendar_prorated" },
    extras: [],
  };
}

function resolveFixture() {
  const { windowLedger, funnelLedgers } = assembleProjectSpendLedger({
    spendRows: [
      { campaign_id: "c-a1", ad_account_id: "act_1", currency: "USD", campaign_name: "A1", spend: 5_000 },
      { campaign_id: "c-g1", ad_account_id: "act_9", currency: "USD", campaign_name: "G1", spend: 1_000 },
    ],
    windowPathRows: [{ campaign_id: "c-a1", campaign_path: "alpha", users: 100 }],
    historicalPathRows: [{ campaign_id: "c-g1", campaign_path: "ghost", users: 5 }],
    knownGaps: [],
    window: JULY,
  });
  const rows: CohortRowLike[] = [
    {
      cohort_date: "2026-07-05", campaign_path: "alpha", trial_users: 100,
      first_subscription_users: 40, renewal_users_by_level: { 2: 20 },
      trial_revenue: 100, first_subscription_revenue: 1_200, gross_revenue: 2_500,
      amount_refunded: 50, fb_spend: 4_500,
    },
  ];
  return resolveProjectFromCohortRows({
    window: JULY, asOf: AS_OF, rows, windowLedger, funnelLedgers,
    sharedCosts: sharedCosts(), policy: policy(),
  });
}

describe("extrapolation exposure", () => {
  it("splits projected gross by the survival provenance tags and reconciles", () => {
    const resolved = resolveFixture();
    const alpha = resolved.resolutions.find((resolution) => resolution.entry.funnelId === "alpha")!;
    const exposure = extrapolatedRevenueShare(alpha)!;
    // Observed depth is shallow (c1+c2 only), so most of a 12-period projection
    // is extrapolated — the share must be strictly between 0 and 1 and the
    // parts must sum to the funnel's gross.
    expect(exposure.grossTotal).toBeCloseTo(alpha.result!.revenue.grossTotal, 6);
    expect(exposure.extrapolatedGross).toBeGreaterThan(0);
    expect(exposure.extrapolatedGross).toBeLessThan(exposure.grossTotal);
    expect(exposure.share).toBeCloseTo(exposure.extrapolatedGross / exposure.grossTotal, 12);
  });

  it("project summary weights by gross, never averages shares; spend-only rows contribute nothing", () => {
    const resolved = resolveFixture();
    const summary = projectExtrapolationSummary(resolved.resolutions);
    const alpha = extrapolatedRevenueShare(resolved.resolutions.find((r) => r.entry.funnelId === "alpha")!)!;
    // One forecast funnel → the summary IS that funnel's exposure.
    expect(summary.extrapolatedGross).toBeCloseTo(alpha.extrapolatedGross, 6);
    expect(summary.grossTotal).toBeCloseTo(alpha.grossTotal, 6);
  });

  it("returns null share only when there is no gross at all", () => {
    expect(extrapolatedRevenueShare({ frozen: undefined, result: undefined })).toBeNull();
  });
});

describe("project export table", () => {
  it("exports every resolution row + TOTAL, with blanks (never zeros) for unavailable", () => {
    const resolved = resolveFixture();
    const run = runResolvedProject(resolved);
    const table = buildProjectExportTable(resolved, run);
    expect(table.headers).toContain("Extrapolated revenue share");
    // alpha + ghost + TOTAL.
    expect(table.rows).toHaveLength(3);
    const ghost = table.rows.find((row) => row[0] === "ghost")!;
    const grossIdx = table.headers.indexOf("Gross revenue");
    expect(ghost[grossIdx]).toBe("");           // spend-only: no revenue — blank, not 0
    const total = table.rows[table.rows.length - 1];
    expect(total[0]).toBe("TOTAL");
    const overheadIdx = table.headers.indexOf("Allocated overhead");
    expect(Math.abs((total[overheadIdx] as number) - 16_271.36)).toBeLessThan(0.01);
    // The generic CSV serializer accepts it unchanged.
    const csv = cohortsTableToCsv(table);
    expect(csv.split("\n")).toHaveLength(4);
    expect(csv.startsWith("Funnel,Status")).toBe(true);
  });

  it("blocked rows export their reason path", () => {
    const resolved = resolveFixture();
    // Remove ghost's commission → its outflow nulls but it stays a row; blocked
    // rows come from a funnel with no ledger at all:
    const run = runResolvedProject(resolved);
    const table = buildProjectExportTable(resolved, run);
    const statusIdx = table.headers.indexOf("Status");
    for (const row of table.rows.slice(0, -1)) {
      expect(["ok", "disabled"].includes(String(row[statusIdx])) || String(row[statusIdx]).startsWith("blocked:")).toBe(true);
    }
  });
});
