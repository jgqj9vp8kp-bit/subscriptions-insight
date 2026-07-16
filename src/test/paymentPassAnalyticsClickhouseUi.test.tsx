import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PaymentPassAnalytics } from "@/components/PaymentPassAnalytics";
import type { PaymentAnalyticsBundle } from "@/services/paymentAnalyticsDataSource";

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

Object.defineProperty(window, "ResizeObserver", {
  writable: true,
  value: MockResizeObserver,
});

vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: { id: "user-1" } }) }));
vi.mock("@/hooks/useAnalyticsCache", () => ({ useWarehouseVersion: () => ({ version: "whv_test", ready: true }) }));
vi.mock("@/services/paymentAnalyticsDataSource", async (importActual) => {
  const actual = await importActual<typeof import("@/services/paymentAnalyticsDataSource")>();
  return { ...actual, paymentAnalyticsMode: () => "clickhouse" as const };
});

const metrics = {
  attempts: 409,
  successful: 198,
  failed: 211,
  pass_rate: 198 / 409,
  users_with_attempts: 300,
  users_with_success: 180,
  user_pass_rate: 0.6,
  failed_users: 120,
  first_attempts: 250,
  first_success: 130,
  first_attempt_pass_rate: 0.52,
  first_sub_attempts: 80,
  first_sub_success: 40,
  first_sub_pass_rate: 0.5,
  renewal_attempts: 60,
  renewal_success: 28,
  renewal_pass_rate: 28 / 60,
  top_decline_reason: "do_not_honor",
  top_decline_reason_users: 50,
  insufficient_funds_failures: 20,
  eligible_attempts_ex_if: 389,
  pass_rate_ex_if: 198 / 389,
};

const bundle: PaymentAnalyticsBundle = {
  schemaVersion: 2,
  summary: metrics,
  firstSummary: metrics,
  funnelRows: [{ key: "soulmate", label: "soulmate", ...metrics }],
  stageRows: [{ stage: "trial_or_entry", key: "trial_or_entry", label: "Trial / Entry", ...metrics }],
  segmentRows: [{ key: "soulmate-1-week", label: "soulmate-1-week", ...metrics }],
  firstTxRows: [{ key: "soulmate", label: "soulmate", ...metrics }],
  renewalRows: [{ level: 2, key: "2", label: "Renewal 2", ...metrics }],
  renewalSegmentRows: [{ key: "soulmate", label: "soulmate", ...metrics }],
  declineRows: [{
    reason: "do_not_honor",
    label: "do_not_honor",
    failed_attempts: 120,
    failed_users: 90,
    share_of_failed: 120 / 211,
    affected_funnels: ["soulmate"],
    most_common_stage: "trial_or_entry",
    most_common_card_type: "credit",
    most_common_country: "US",
  }],
  firstDeclineRows: [{
    reason: "do_not_honor",
    label: "do_not_honor",
    failed_attempts: 50,
    failed_users: 40,
    share_of_failed: 0.5,
    affected_funnels: ["soulmate"],
    most_common_stage: "trial_or_entry",
    most_common_card_type: "credit",
    most_common_country: "US",
  }],
  timePoints: [{ date: "2026-06-01", attempts: 409, successful: 198, failed: 211, pass_rate: 198 / 409 }],
  trialByCountry: [{ key: "US", label: "US", ...metrics }],
  options: {
    funnels: ["soulmate"],
    campaignPaths: ["soulmate-1-week"],
    campaignIds: ["cmp-1"],
    mediaBuyers: ["Ivan"],
    countries: ["US"],
    cardTypes: ["credit"],
    transactionTypes: ["trial"],
    declineReasons: ["do_not_honor"],
  },
  durationMs: 42,
};

vi.mock("@/hooks/usePaymentAnalyticsCache", () => ({
  usePaymentAnalyticsBundle: () => ({
    chBundle: bundle,
    chStatus: { loading: false, error: null },
    isBackgroundRefreshing: false,
    isInitialLoading: false,
    progressPercent: 100,
    dataUpdatedAt: Date.now(),
  }),
}));

describe("PaymentPassAnalytics ClickHouse UI", () => {
  it("renders the complete ClickHouse bundle instead of the legacy empty state", () => {
    render(<PaymentPassAnalytics txs={[]} />);

    expect(screen.getByText("Total Attempts")).toBeInTheDocument();
    expect(screen.getAllByText("409").length).toBeGreaterThan(0);
    expect(screen.queryByText("No payment attempts match your filters.")).not.toBeInTheDocument();
    expect(screen.getByText("Pass Rate by Funnel")).toBeInTheDocument();
    expect(screen.getByText("Breakdown by Funnel")).toBeInTheDocument();
    expect(screen.getByText("Breakdown by Stage")).toBeInTheDocument();
    expect(screen.getByText("Breakdown by Segment")).toBeInTheDocument();
    expect(screen.getByText("First Transaction Analytics")).toBeInTheDocument();
    expect(screen.getByText("Renewal Pass Analytics")).toBeInTheDocument();
    expect(screen.getByText("Decline Reason Analytics")).toBeInTheDocument();
  });
});
