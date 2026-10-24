// Payback page queries (src/hooks/usePayback.ts): the ltv curve and the spend
// ledgers are keyed by the access partition, the warehouse probe runs only for
// a member who may read it, ok: false from the ltv action is a typed "not
// ready" error (no retry), and the trend's ledgers load only while the
// drilldown is open.
import { createElement, type ReactNode } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccessContext, buildAccessValue, type AccessContextValue } from "@/contexts/accessContext";
import type { MyAccess } from "@/services/accessClient";

const mocks = vi.hoisted(() => ({
  runClickHouseCohortLtv: vi.fn(),
  getClickHouseSummary: vi.fn(),
  fetchProjectSpendLedger: vi.fn(),
}));
vi.mock("@/services/clickhouse", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/clickhouse")>();
  return { ...actual, runClickHouseCohortLtv: mocks.runClickHouseCohortLtv, getClickHouseSummary: mocks.getClickHouseSummary };
});
vi.mock("@/services/projectSpendLedger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/projectSpendLedger")>();
  return { ...actual, fetchProjectSpendLedger: mocks.fetchProjectSpendLedger };
});

import { WAREHOUSE_ANALYTICS_INVALIDATED_EVENT } from "@/services/analyticsCache";
import { staleSnapshotRebuildKey } from "@/services/cohortSnapshotHealth";
import {
  PaybackLtvError,
  PAYBACK_SNAPSHOT_NOT_READY,
  paybackLedgerKey,
  paybackLtvKey,
  paybackSnapshotHealth,
  usePaybackLedger,
  usePaybackLtv,
  usePaybackTrendLedgers,
} from "@/hooks/usePayback";

function row(permissions: string[]): MyAccess {
  return {
    status: "ok", workspace_id: "ws-1", member_id: "member-a", user_id: "user-a", email: "a@example.test", display_name: null,
    is_data_owner: false, raw_access: false,
    role: { id: "role-1", key: "custom", name: "Custom", is_owner: false, permissions },
    funnel_scope: { mode: "all", funnel_ids: [], paths: [] }, access_version: "1", partition: "p-member",
  };
}
const member = (permissions: string[]) => buildAccessValue({ status: "ok", access: row(permissions), userId: "user-a" });

const RANGE = { from: "2026-02-01", to: "2026-07-31" };
const LTV = { ok: true, source: "clickhouse", action: "ltv", checkpoints: [0, 30, 60, 90], data_through: "2026-10-20T12:00:00Z", range: null, rows: [], diagnostics: {} };

let client: QueryClient;
function wrapperFor(access: AccessContextValue) {
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, createElement(AccessContext.Provider, { value: access }, children));
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.runClickHouseCohortLtv.mockResolvedValue(LTV);
  mocks.getClickHouseSummary.mockResolvedValue({ sync_state: { cursor_transaction_id: "c1", cursor_updated_at: "t", clickhouse_total: 5 } });
  mocks.fetchProjectSpendLedger.mockImplementation(async (window: { from: string; to: string }) => ({ ok: true, window, spendThrough: "2026-09-14" }));
});
afterEach(() => client.clear());

describe("usePaybackLtv", () => {
  it("a forecasting-only member: no warehouse probe (it would be a 403), the partition key, the ltv action", async () => {
    const { result } = renderHook(() => usePaybackLtv(RANGE), { wrapper: wrapperFor(member(["forecasting.view"])) });
    await waitFor(() => expect(result.current.data).toEqual(LTV));
    expect(mocks.getClickHouseSummary).not.toHaveBeenCalled();
    expect(mocks.runClickHouseCohortLtv).toHaveBeenCalledWith({ date_from: RANGE.from, date_to: RANGE.to });
    expect(client.getQueryData(paybackLtvKey("p-member", "whv_unknown", RANGE))).toEqual(LTV);
  });

  it("a member who may read the probe keys the curve on the warehouse version", async () => {
    const { result } = renderHook(() => usePaybackLtv(RANGE), { wrapper: wrapperFor(member(["forecasting.view", "cohorts.view"])) });
    await waitFor(() => expect(result.current.data).toEqual(LTV));
    expect(mocks.getClickHouseSummary).toHaveBeenCalled();
    // Held until the version is known: one request, under the real version.
    expect(mocks.runClickHouseCohortLtv).toHaveBeenCalledTimes(1);
    const fetched = client.getQueryCache().findAll({ queryKey: ["payback", "ltv", "p-member"] }).filter((query) => query.state.data !== undefined);
    expect(fetched).toHaveLength(1);
    expect(fetched[0].queryKey[3]).toMatch(/^whv_/);
    expect(fetched[0].queryKey[3]).not.toBe("whv_unknown");
  });

  it("ok: false is a typed error, never data", async () => {
    mocks.runClickHouseCohortLtv.mockResolvedValue({ ...LTV, ok: false, error: PAYBACK_SNAPSHOT_NOT_READY });
    const { result } = renderHook(() => usePaybackLtv(RANGE), { wrapper: wrapperFor(member(["forecasting.view"])) });
    await waitFor(() => expect(result.current.error).toBeInstanceOf(PaybackLtvError));
    expect((result.current.error as PaybackLtvError).code).toBe(PAYBACK_SNAPSHOT_NOT_READY);
    expect(result.current.data).toBeNull();
    expect(mocks.runClickHouseCohortLtv).toHaveBeenCalledTimes(1);
  });

  it("a completed snapshot rebuild (the warehouse-invalidated event) refetches the curve", async () => {
    const { result } = renderHook(() => usePaybackLtv(RANGE), { wrapper: wrapperFor(member(["forecasting.view"])) });
    await waitFor(() => expect(result.current.data).toEqual(LTV));
    expect(mocks.runClickHouseCohortLtv).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event(WAREHOUSE_ANALYTICS_INVALIDATED_EVENT));
    await waitFor(() => expect(mocks.runClickHouseCohortLtv).toHaveBeenCalledTimes(2));
  });

  it("a stale answer maps onto the Cohorts page's rebuild key; anything else needs no rebuild", () => {
    const diagnostics = { active_snapshot_version: "wh_old:cohort_classifier_v3_platform", snapshot_generated_at: "2026-10-20T07:00:00.000Z", current_warehouse_version: "wh_new", rows: 0, trial_users: 0 };
    const health = paybackSnapshotHealth({ snapshot_stale: true, diagnostics })!;
    expect(health).toMatchObject({ known: true, status: "stale", snapshotWarehouseVersion: "wh_old", currentWarehouseVersion: "wh_new" });
    expect(staleSnapshotRebuildKey(health)).toBe("wh_old→wh_new→→");
    expect(paybackSnapshotHealth({ snapshot_stale: false, diagnostics })).toBeNull();
    expect(paybackSnapshotHealth({ snapshot_stale: null, diagnostics })).toBeNull();
    expect(paybackSnapshotHealth(null)).toBeNull();
  });

  it("no range (an invalid custom period): no request", () => {
    const { result } = renderHook(() => usePaybackLtv(null), { wrapper: wrapperFor(member(["forecasting.view"])) });
    expect(result.current.loading).toBe(false);
    expect(mocks.runClickHouseCohortLtv).not.toHaveBeenCalled();
  });
});

describe("spend ledgers", () => {
  it("one call per window, under the partition; none without a window", async () => {
    const window = { from: "2026-07-01", to: "2026-07-31" };
    const { result } = renderHook(() => usePaybackLedger(window), { wrapper: wrapperFor(member(["forecasting.view"])) });
    await waitFor(() => expect(result.current.settled).toBe(true));
    expect(mocks.fetchProjectSpendLedger).toHaveBeenCalledWith(window);
    expect(client.getQueryData(paybackLedgerKey("p-member", window))).toMatchObject({ spendThrough: "2026-09-14" });

    const idle = renderHook(() => usePaybackLedger(null), { wrapper: wrapperFor(member(["forecasting.view"])) });
    expect(idle.result.current).toMatchObject({ data: null, loading: false, settled: true });
    expect(mocks.fetchProjectSpendLedger).toHaveBeenCalledTimes(1);
  });

  it("the trend's months load only while the drilldown is open", async () => {
    const months = [{ from: "2026-06-01", to: "2026-06-30" }, { from: "2026-07-01", to: "2026-07-31" }, null];
    const { result, rerender } = renderHook((props: { open: boolean }) => usePaybackTrendLedgers(months, props.open), {
      wrapper: wrapperFor(member(["forecasting.view"])),
      initialProps: { open: false },
    });
    expect(result.current.map((entry) => entry.loading)).toEqual([false, false, false]);
    expect(mocks.fetchProjectSpendLedger).not.toHaveBeenCalled();
    rerender({ open: true });
    await waitFor(() => expect(result.current[1].data).toMatchObject({ window: months[1] }));
    expect(mocks.fetchProjectSpendLedger).toHaveBeenCalledTimes(2);
    expect(result.current[2]).toEqual({ data: null, loading: false, failed: false });
  });
});
