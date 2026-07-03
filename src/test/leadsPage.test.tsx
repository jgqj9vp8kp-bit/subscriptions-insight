import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import LeadsPage from "@/pages/Leads";
import { useDataStore } from "@/store/dataStore";
import type { Transaction } from "@/services/types";

vi.mock("@/components/AppLayout", () => ({
  AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/services/sheets", () => ({
  useTransactions: vi.fn(),
}));

import { useTransactions } from "@/services/sheets";

function tx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    transaction_id: overrides.transaction_id ?? "tx_1",
    user_id: overrides.user_id ?? "user_1",
    email: overrides.email ?? "lead@example.com",
    event_time: overrides.event_time ?? "2026-06-10T10:00:00.000Z",
    amount_usd: 0,
    gross_amount_usd: 0,
    refund_amount_usd: 0,
    net_amount_usd: 0,
    is_refunded: false,
    currency: "USD",
    status: overrides.status ?? "failed",
    transaction_type: overrides.transaction_type ?? "failed_payment",
    funnel: overrides.funnel ?? "soulmate",
    campaign_path: overrides.campaign_path ?? "soulmate-reading",
    product: "Trial",
    traffic_source: "facebook",
    campaign_id: overrides.campaign_id ?? "cmp_1",
    classification_reason: "test",
    metadata: overrides.metadata ?? { ff_country_code: "us" },
    ...overrides,
  };
}

describe("Leads page", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    useDataStore.setState({ rawPalmerRows: [], subscriptions: [] });
  });

  it("lists an email that only has failed payments and hides one that paid", () => {
    vi.mocked(useTransactions).mockReturnValue([
      tx({ transaction_id: "lead", user_id: "lead_user", email: "lead@example.com", status: "failed" }),
      tx({ transaction_id: "paid", user_id: "paid_user", email: "paid@example.com", status: "success", transaction_type: "trial" }),
    ]);

    render(<LeadsPage />);

    expect(screen.getByText("lead@example.com")).toBeInTheDocument();
    expect(screen.queryByText("paid@example.com")).not.toBeInTheDocument();
  });

  it("renders the Total Leads KPI with the correct count", () => {
    vi.mocked(useTransactions).mockReturnValue([
      tx({ transaction_id: "a", user_id: "u1", email: "a@example.com", status: "failed" }),
      tx({ transaction_id: "b", user_id: "u2", email: "b@example.com", status: "failed" }),
    ]);

    render(<LeadsPage />);

    const totalCard = screen.getByText("Total Leads").parentElement;
    expect(totalCard).toHaveTextContent("2");
  });

  it("excludes a lead whose email has an active subscription", () => {
    vi.mocked(useTransactions).mockReturnValue([
      tx({ email: "active@example.com", status: "failed" }),
    ]);
    useDataStore.setState({
      rawPalmerRows: [],
      // minimal active subscription for the same email
      subscriptions: [{ email: "active@example.com", is_active_now: true } as never],
    });

    render(<LeadsPage />);

    expect(screen.queryByText("active@example.com")).not.toBeInTheDocument();
    expect(screen.getByText(/No leads found/)).toBeInTheDocument();
  });
});
