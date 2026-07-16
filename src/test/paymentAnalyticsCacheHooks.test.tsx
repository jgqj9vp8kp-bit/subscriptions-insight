import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/services/paymentAnalyticsDataSource", async (importActual) => {
  const actual = await importActual<typeof import("@/services/paymentAnalyticsDataSource")>();
  return { ...actual, loadPaymentAnalytics: vi.fn() };
});

import { loadPaymentAnalytics } from "@/services/paymentAnalyticsDataSource";
import { usePaymentAnalyticsBundle } from "@/hooks/usePaymentAnalyticsCache";
import { paymentAnalyticsBundleKey } from "@/services/paymentAnalyticsCache";
import type { PaymentAnalyticsQuery } from "@/services/paymentAnalyticsDataSource";

const load = loadPaymentAnalytics as unknown as ReturnType<typeof vi.fn>;
const SCOPE = "u_test";
const WHV = "whv_test";
const q = (over: Partial<PaymentAnalyticsQuery> = {}): PaymentAnalyticsQuery => ({
  dateBasis: "transaction", dateFrom: null, dateTo: null, funnel: "all", campaignPath: "all", campaignId: "all",
  mediaBuyer: "all", country: "all", cardType: "all", stage: "all", declineReason: "all", transactionType: "all",
  outcome: "all", groupBy: "country", firstTxDimension: "country", renewalDimension: "country", ...over,
});
const keyFor = (query: PaymentAnalyticsQuery) => paymentAnalyticsBundleKey({ userScopeHash: SCOPE, warehouseVersion: WHV, request: query });
const metrics = {
  attempts: 1,
  successful: 1,
  failed: 0,
  pass_rate: 1,
  users_with_attempts: 1,
  users_with_success: 1,
  user_pass_rate: 1,
  failed_users: 0,
  first_attempts: 1,
  first_success: 1,
  first_attempt_pass_rate: 1,
  first_sub_attempts: 0,
  first_sub_success: 0,
  first_sub_pass_rate: 0,
  renewal_attempts: 0,
  renewal_success: 0,
  renewal_pass_rate: 0,
  top_decline_reason: null,
  top_decline_reason_users: 0,
  insufficient_funds_failures: 0,
  eligible_attempts_ex_if: 1,
  pass_rate_ex_if: 1,
};
const bundle = (id: string) => ({
  schemaVersion: 2,
  summary: metrics,
  firstSummary: metrics,
  funnelRows: [],
  stageRows: [],
  segmentRows: [],
  firstTxRows: [],
  renewalRows: [],
  renewalSegmentRows: [],
  declineRows: [],
  firstDeclineRows: [],
  timePoints: [],
  trialByCountry: [],
  options: { funnels: [], campaignPaths: [], campaignIds: [], mediaBuyers: [], countries: [], cardTypes: [], transactionTypes: [], declineReasons: [] },
  durationMs: 5,
  tag: id,
});

let client: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client }, children);
}
function mount(query: PaymentAnalyticsQuery, enabled = true) {
  return renderHook(
    (props: { query: PaymentAnalyticsQuery }) => usePaymentAnalyticsBundle({ query: props.query, userScopeHash: SCOPE, warehouseVersion: WHV, enabled }),
    { wrapper, initialProps: { query } },
  );
}
function markStale(query: PaymentAnalyticsQuery, ageMs: number) {
  const qu = client.getQueryCache().find({ queryKey: keyFor(query) });
  if (qu) qu.state.dataUpdatedAt = Date.now() - ageMs;
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  load.mockReset();
});
afterEach(() => client.clear());

describe("usePaymentAnalyticsBundle — SWR", () => {
  it("renders the cached bundle immediately + no refetch when fresh", async () => {
    client.setQueryData(keyFor(q()), bundle("cached"));
    const { result } = mount(q());
    expect((result.current.chBundle as unknown as { tag: string }).tag).toBe("cached");
    expect(result.current.isInitialLoading).toBe(false);
    await new Promise((r) => setTimeout(r, 20));
    expect(load).not.toHaveBeenCalled();
  });

  it("stale bundle keeps visible + refetches in background", async () => {
    client.setQueryData(keyFor(q()), bundle("old"));
    markStale(q(), 10 * 60 * 1000);
    load.mockResolvedValueOnce(bundle("fresh"));
    const { result } = mount(q());
    expect((result.current.chBundle as unknown as { tag: string }).tag).toBe("old");
    await waitFor(() => expect(load).toHaveBeenCalled());
    await waitFor(() => expect((result.current.chBundle as unknown as { tag: string }).tag).toBe("fresh"));
  });

  it("a failed refresh preserves the cached bundle", async () => {
    client.setQueryData(keyFor(q()), bundle("kept"));
    markStale(q(), 10 * 60 * 1000);
    load.mockRejectedValueOnce(new Error("invalid blip"));
    const { result } = mount(q());
    await waitFor(() => expect(result.current.chStatus.error).toBeTruthy());
    expect((result.current.chBundle as unknown as { tag: string }).tag).toBe("kept");
  });

  it("filter change keeps previous bundle until the new one arrives (latest wins)", async () => {
    load.mockImplementation((query: PaymentAnalyticsQuery) => Promise.resolve(bundle(query.country)));
    const { result, rerender } = mount(q({ country: "A" }));
    await waitFor(() => expect((result.current.chBundle as unknown as { tag: string }).tag).toBe("A"));
    rerender({ query: q({ country: "B" }) });
    await waitFor(() => expect((result.current.chBundle as unknown as { tag: string }).tag).toBe("B"));
  });

  it("disabled (legacy mode) never fetches", async () => {
    const { result } = mount(q(), false);
    await new Promise((r) => setTimeout(r, 20));
    expect(load).not.toHaveBeenCalled();
    expect(result.current.chBundle).toBeNull();
  });

  it("rejects an incomplete cached bundle and refetches it", async () => {
    client.setQueryData(keyFor(q()), { summary: { attempts: 409 }, durationMs: 5, tag: "summary-only" });
    load.mockResolvedValueOnce(bundle("complete"));
    const { result } = mount(q());
    expect(result.current.chBundle).toBeNull();
    await waitFor(() => expect(load).toHaveBeenCalled());
    await waitFor(() => expect((result.current.chBundle as unknown as { tag: string }).tag).toBe("complete"));
  });
});
