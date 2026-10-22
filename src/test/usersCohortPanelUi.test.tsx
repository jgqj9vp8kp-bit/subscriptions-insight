// Users cohort panel on the ClickHouse path: product chips count trial users
// from the cohort list (requested WITHOUT campaign_path, so every product and
// funnel keeps its count), a product narrows the funnel picker, the cohort
// list, the users request and (through a second, with-paths options request)
// the country list, a saved product holds the users until its map is known,
// and a cohort selection still wins over the paths.

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import UsersPage from "@/pages/Users";
import { NO_PRODUCT_PATH, type CohortProductOption } from "@/services/cohortProductFilter";
import { campaignPathList, type UsersQuery } from "@/services/usersDataSource";

vi.mock("@/components/AppLayout", () => ({
  AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/services/sheets", () => ({ useTransactions: () => [] }));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: { id: "test-user" } }) }));
vi.mock("@/hooks/useAccess", async () => {
  const { buildAccessValue } = await import("@/contexts/accessContext");
  const owner = buildAccessValue({ status: "legacy", access: null, userId: "test-user" });
  return { useAccess: () => owner, useOptionalAccess: () => owner, useCan: (key: string) => owner.can(key) };
});
vi.mock("@/hooks/useAnalyticsCache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/useAnalyticsCache")>();
  return { ...actual, useWarehouseVersion: () => ({ version: "whv_test", ready: true }) };
});

// The product map (its own hook test covers the request rules): a mutable
// answer, so a test can flip it from pending to settled.
const productsState = vi.hoisted(() => ({
  value: { products: null as CohortProductOption[] | null, settled: true },
}));
vi.mock("@/hooks/useCohortProducts", () => ({ useCohortProducts: () => productsState.value }));

const loadUsersDecline = vi.fn();
const loadUserOptions = vi.fn();
const loadUsers = vi.fn();
const loadUsersSummary = vi.fn();
vi.mock("@/services/usersDataSource", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/usersDataSource")>();
  return {
    ...actual,
    loadUsersDeclineFromClickHouse: (...args: unknown[]) => loadUsersDecline(...args),
    loadUserOptionsFromClickHouse: (...args: unknown[]) => loadUserOptions(...args),
    loadUsersFromClickHouse: (...args: unknown[]) => loadUsers(...args),
    loadUsersSummaryFromClickHouse: (...args: unknown[]) => loadUsersSummary(...args),
  };
});

const PRODUCTS: CohortProductOption[] = [
  // trial_count is all-time: the chip must never show it.
  { project_id: "p-azora", label: "azora-astro.com", host: "f.azora-astro.com", trial_count: 999, campaign_paths: ["p-azora-1", "p-azora-2"] },
  { project_id: "p-brainza", label: "brainza.app", host: "brainza.app", trial_count: 500, campaign_paths: ["p-brainza-1"] },
  { project_id: "", label: "Unknown", host: "", trial_count: 3, campaign_paths: ["unknown"] },
];

const COHORTS = [
  { cohort_id: "soulmate_p-azora-1_2026-10-20", cohort_date: "2026-10-20", funnel: "soulmate", campaign_path: "p-azora-1", trial_users: 5, net_revenue: 50 },
  { cohort_id: "soulmate_p-azora-2_2026-10-19", cohort_date: "2026-10-19", funnel: "soulmate", campaign_path: "p-azora-2", trial_users: 3, net_revenue: 30 },
  { cohort_id: "soulmate_p-brainza-1_2026-10-18", cohort_date: "2026-10-18", funnel: "soulmate", campaign_path: "p-brainza-1", trial_users: 7, net_revenue: 70 },
];

let client: QueryClient;
const tree = () => (
  <MemoryRouter>
    <QueryClientProvider client={client}>
      <UsersPage />
    </QueryClientProvider>
  </MemoryRouter>
);
function renderPage(state: Record<string, unknown> = {}) {
  localStorage.setItem("ui_state_users", JSON.stringify(state));
  return render(tree());
}

const lastUsersQuery = (): UsersQuery => loadUsers.mock.calls.at(-1)?.[0] as UsersQuery;
const productGroup = () => screen.getByRole("group", { name: "Product" });
const chip = (name: string) => within(productGroup()).getByRole("button", { name });

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  productsState.value = { products: PRODUCTS, settled: true };
  loadUserOptions.mockResolvedValue({
    funnel: [], campaign_path: [], campaign_id: [], media_buyer: [], currency: [], card_type: [], country: [],
    cohort: COHORTS,
  });
  loadUsers.mockResolvedValue({ rows: [], total: 0, page: 1, pageSize: 50, totalPages: 1, durationMs: 1 });
  loadUsersSummary.mockResolvedValue(null);
  loadUsersDecline.mockResolvedValue(null);
});

// Every test renders the full Users page (~2 s alone): the default 5 s timeout
// flakes under the parallel full-suite run.
describe("Users cohort panel — product, funnel and selection on the ClickHouse path", () => {
  it("counts each product's trial users from the cohort list, not its all-time trial_count", async () => {
    renderPage();
    expect(await screen.findByRole("button", { name: "azora-astro.com 8" })).toHaveAttribute("aria-pressed", "false");
    expect(chip("All 15")).toHaveAttribute("aria-pressed", "true");
    expect(chip("brainza.app 7")).toBeInTheDocument();
    expect(chip("Unknown 0")).toBeInTheDocument();
    expect(chip("azora-astro.com 8")).toHaveAttribute("title", "f.azora-astro.com · 2 campaign paths");
    expect(chip("brainza.app 7")).toHaveAttribute("title", "brainza.app · 1 campaign path");
  }, 20_000);

  it("a product narrows the users request, the funnel picker and the list; the cohort list never carries a path", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "azora-astro.com 8" }));

    await waitFor(() => expect(lastUsersQuery().campaignPath).toEqual(["p-azora-1", "p-azora-2"]));
    expect(chip("azora-astro.com 8")).toHaveAttribute("aria-pressed", "true");
    // Other products keep their counts (the cohort list is path-free).
    expect(chip("brainza.app 7")).toBeInTheDocument();
    // The path-free options request (cohort list) and the with-paths one (the
    // country list only) are the only two shapes.
    const optionPaths = loadUserOptions.mock.calls.map(([query]) => campaignPathList((query as UsersQuery).campaignPath));
    expect(optionPaths).toContainEqual([]);
    for (const paths of optionPaths) expect([[], ["p-azora-1", "p-azora-2"]]).toContainEqual(paths);

    expect(screen.getByRole("checkbox", { name: "Select all cohorts of p-azora-1" })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "Select all cohorts of p-brainza-1" })).toBeNull();
    expect(screen.getByText("Product: azora-astro.com")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Funnel filter: All funnels" }));
    expect(screen.getByRole("checkbox", { name: "p-azora-1" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "p-azora-2" })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "p-brainza-1" })).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "p-azora-2" }));
    await waitFor(() => expect(lastUsersQuery().campaignPath).toEqual(["p-azora-2"]));
  }, 20_000);

  it("the country list narrows by the picked product (a second options request with its paths)", async () => {
    loadUserOptions.mockImplementation(async (query: UsersQuery) => ({
      funnel: [], campaign_path: [], campaign_id: [], media_buyer: [], currency: [], card_type: [],
      country: campaignPathList(query.campaignPath).length > 0
        ? [{ country_code: "DE", user_count: 8 }]
        : [{ country_code: "DE", user_count: 2 }, { country_code: "US", user_count: 13 }],
      cohort: COHORTS,
    }));
    renderPage({ countryFilter: "DE" });
    // The closed Select shows the chosen option's text: its count tells the lists apart.
    expect(await screen.findByText("DE · 2")).toBeInTheDocument();
    const pathFreeCalls = loadUserOptions.mock.calls.length;
    expect(loadUserOptions.mock.calls.every(([query]) => campaignPathList((query as UsersQuery).campaignPath).length === 0)).toBe(true);

    fireEvent.click(chip("azora-astro.com 8"));
    expect(await screen.findByText("DE · 8")).toBeInTheDocument();
    expect(loadUserOptions.mock.calls.slice(pathFreeCalls).map(([query]) => campaignPathList((query as UsersQuery).campaignPath)))
      .toContainEqual(["p-azora-1", "p-azora-2"]);
    // The panel still lists every product's cohorts (from the path-free list).
    expect(chip("brainza.app 7")).toBeInTheDocument();

    fireEvent.click(chip("All 15"));
    expect(await screen.findByText("DE · 2")).toBeInTheDocument();
  }, 20_000);

  it("a saved product and a funnel of another product send the no-overlap sentinel", async () => {
    renderPage({ selectedProducts: ["p-azora"], selectedCampaignPaths: ["p-brainza-1"] });
    await waitFor(() => expect(lastUsersQuery()?.campaignPath).toEqual([NO_PRODUCT_PATH]));
    // Both stay visible as chips, so either can be removed.
    expect(await screen.findByText("Product: azora-astro.com")).toBeInTheDocument();
    expect(screen.getByText("Funnel: p-brainza-1")).toBeInTheDocument();
    expect(await screen.findByText("No cohorts match your filters.")).toBeInTheDocument();
  }, 20_000);

  it("without the product map the row is hidden and the users still load", async () => {
    productsState.value = { products: null, settled: true };
    renderPage({ selectedProducts: ["p-azora"] });
    await waitFor(() => expect(loadUsers).toHaveBeenCalled());
    expect(lastUsersQuery().campaignPath).toEqual([]);
    expect(screen.queryByRole("group", { name: "Product" })).toBeNull();
    expect(await screen.findByRole("checkbox", { name: "Select all cohorts of p-brainza-1" })).toBeInTheDocument();
  }, 20_000);

  it("holds the users requests while a saved product's map is pending", async () => {
    productsState.value = { products: null, settled: false };
    const view = renderPage({ selectedProducts: ["p-azora"] });
    await waitFor(() => expect(loadUserOptions).toHaveBeenCalled()); // options do not wait
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    expect(loadUsers).not.toHaveBeenCalled();
    expect(loadUsersSummary).not.toHaveBeenCalled();
    expect(screen.getByText(/Loading users…/)).toBeInTheDocument();
    expect(screen.queryByText("No users match your filters.")).toBeNull();

    productsState.value = { products: PRODUCTS, settled: true };
    view.rerender(tree());
    await waitFor(() => expect(loadUsers).toHaveBeenCalled());
    expect(loadUsers.mock.calls.every(([query]) => JSON.stringify((query as UsersQuery).campaignPath) === JSON.stringify(["p-azora-1", "p-azora-2"]))).toBe(true);
  }, 20_000);

  it("drops a saved product the map no longer knows", async () => {
    const view = renderPage({ selectedProducts: ["p-gone", "p-azora"] });
    await waitFor(() => expect(lastUsersQuery()?.campaignPath).toEqual(["p-azora-1", "p-azora-2"]));
    view.unmount(); // flushes the debounced UI state
    expect(JSON.parse(localStorage.getItem("ui_state_users") ?? "{}").selectedProducts).toEqual(["p-azora"]);
  }, 20_000);

  it("a cohort selection wins over the product paths for the users", async () => {
    renderPage({ selectedProducts: ["p-azora"], selectedCohortIds: ["soulmate_p-azora-1_2026-10-20"] });
    await waitFor(() => expect(loadUsers).toHaveBeenCalled());
    expect(lastUsersQuery()).toMatchObject({ campaignPath: [], cohortIds: ["soulmate_p-azora-1_2026-10-20"] });
    expect(await screen.findByText("Cohorts: 1 selected")).toBeInTheDocument();
  }, 20_000);

  it("removes a funnel from its chip", async () => {
    renderPage({ selectedCampaignPaths: ["p-brainza-1"] });
    await waitFor(() => expect(lastUsersQuery()?.campaignPath).toEqual(["p-brainza-1"]));
    fireEvent.click(screen.getByRole("button", { name: "Remove filter Funnel: p-brainza-1" }));
    await waitFor(() => expect(lastUsersQuery().campaignPath).toEqual([]));
    expect(screen.queryByText("Funnel: p-brainza-1")).toBeNull();
  }, 20_000);

  it("selects every shown cohort", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Select all shown (3)" }));
    await waitFor(() => expect([...(lastUsersQuery().cohortIds ?? [])].sort()).toEqual(COHORTS.map((c) => c.cohort_id).sort()));
    expect(screen.getByText("3 selected")).toBeInTheDocument();
  }, 20_000);
});
