// The Users cohort panel's product map: one cached clickhouse-cohorts
// product_paths query, requested only for full-scope members with
// cohorts.view, and never fatal (a failure hides the product row).
import { createElement, type ReactNode } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccessContext, buildAccessValue, type AccessContextValue } from "@/contexts/accessContext";
import type { MyAccess } from "@/services/accessClient";

const mocks = vi.hoisted(() => ({ runClickHouseCohortProducts: vi.fn() }));
vi.mock("@/services/clickhouse", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/clickhouse")>();
  return { ...actual, runClickHouseCohortProducts: mocks.runClickHouseCohortProducts };
});

import { ClickHouseRequestError } from "@/services/clickhouse";
import { cohortProductsKey, useCohortProducts } from "@/hooks/useCohortProducts";

const PRODUCTS = [
  { project_id: "p-azora", label: "azora-astro.com", host: "f.azora-astro.com", trial_count: 10, campaign_paths: ["a1"] },
  { project_id: "", label: "Unknown", host: "", trial_count: 1, campaign_paths: ["unknown"] },
];

function row(permissions: string[], scope: "all" | "selected" = "all"): MyAccess {
  return {
    status: "ok",
    workspace_id: "ws-1",
    member_id: "member-a",
    user_id: "user-a",
    email: "a@example.test",
    display_name: null,
    is_data_owner: false,
    raw_access: false,
    role: { id: "role-1", key: "custom", name: "Custom", is_owner: false, permissions },
    funnel_scope: { mode: scope, funnel_ids: scope === "all" ? [] : ["f1"], paths: scope === "all" ? [] : ["a1"] },
    access_version: "1",
    partition: "p-member",
  };
}
const member = (permissions: string[], scope: "all" | "selected" = "all") =>
  buildAccessValue({ status: "ok", access: row(permissions, scope), userId: "user-a" });

let client: QueryClient;
function mount(access: AccessContextValue | null, props: { warehouseVersion?: string; enabled?: boolean; userScopeHash?: string } = {}) {
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(
      QueryClientProvider,
      { client },
      access ? createElement(AccessContext.Provider, { value: access }, children) : children,
    );
  return renderHook(
    (p: { warehouseVersion: string }) =>
      useCohortProducts({ userScopeHash: props.userScopeHash ?? "u_scope", warehouseVersion: p.warehouseVersion, enabled: props.enabled ?? true }),
    { wrapper, initialProps: { warehouseVersion: props.warehouseVersion ?? "whv_1" } },
  );
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mocks.runClickHouseCohortProducts.mockReset();
  mocks.runClickHouseCohortProducts.mockResolvedValue({ ok: true, source: "clickhouse", generated_at: "", query_duration_ms: 1, products: PRODUCTS });
});
afterEach(() => client.clear());

describe("useCohortProducts", () => {
  it("keys the map under the warehouse-dependent cohorts root, per partition and version", () => {
    expect(cohortProductsKey("p-1", "whv_2")).toEqual(["cohorts", "products", "p-1", "whv_2"]);
  });

  it("returns the products for a full-scope member with cohorts.view, under the access partition", async () => {
    const { result } = mount(member(["cohorts.view", "users.view"]));
    await waitFor(() => expect(result.current.products).toEqual(PRODUCTS));
    expect(result.current.settled).toBe(true);
    expect(mocks.runClickHouseCohortProducts).toHaveBeenCalledTimes(1);
    expect(client.getQueryData(cohortProductsKey("p-member", "whv_1"))).toEqual(PRODUCTS);
  });

  it("a non-array answer reads as an empty map", async () => {
    mocks.runClickHouseCohortProducts.mockResolvedValue({ ok: true, products: null });
    const { result } = mount(null);
    await waitFor(() => expect(result.current.products).toEqual([]));
    expect(result.current.settled).toBe(true);
  });

  it.each([
    ["without cohorts.view", member(["users.view", "users.pii.view"]), {}],
    ["for a funnel-restricted member", member(["cohorts.view", "users.view"], "selected"), {}],
    ["when disabled", member(["cohorts.view"]), { enabled: false }],
    ["with an empty partition (outside a provider)", null, { userScopeHash: "" }],
  ] as const)("is never requested %s: no product filter, settled", async (_label, access, props) => {
    const { result } = mount(access, props);
    expect(result.current).toEqual({ products: null, settled: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mocks.runClickHouseCohortProducts).not.toHaveBeenCalled();
  });

  it("a 403 hides the filter after one call (no retry) and settles", async () => {
    mocks.runClickHouseCohortProducts.mockRejectedValue(new ClickHouseRequestError("Forbidden", { status: 403, errorCode: "permission_denied" }));
    // The page's client retries transient errors; a 4xx must not be retried.
    client = new QueryClient();
    const { result } = mount(member(["cohorts.view"]));
    await waitFor(() => expect(result.current.settled).toBe(true));
    expect(result.current.products).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mocks.runClickHouseCohortProducts).toHaveBeenCalledTimes(1);
  });

  it("is pending (not settled) until the first answer", async () => {
    let resolve: (value: unknown) => void = () => {};
    mocks.runClickHouseCohortProducts.mockReturnValue(new Promise((r) => { resolve = r; }));
    const { result } = mount(member(["cohorts.view"]));
    expect(result.current).toEqual({ products: null, settled: false });
    resolve({ ok: true, products: PRODUCTS });
    await waitFor(() => expect(result.current.products).toEqual(PRODUCTS));
  });

  it("keeps the previous map across a warehouse-version bump", async () => {
    const { result, rerender } = mount(member(["cohorts.view"]));
    await waitFor(() => expect(result.current.products).toEqual(PRODUCTS));
    mocks.runClickHouseCohortProducts.mockReturnValue(new Promise(() => {}));
    rerender({ warehouseVersion: "whv_2" });
    expect(result.current.products).toEqual(PRODUCTS);
    expect(result.current.settled).toBe(true);
    await waitFor(() => expect(mocks.runClickHouseCohortProducts).toHaveBeenCalledTimes(2));
    expect(result.current.products).toEqual(PRODUCTS);
  });
});
