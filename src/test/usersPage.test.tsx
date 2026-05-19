import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import UsersPage from "@/pages/Users";
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
    transaction_id: "tx_1",
    user_id: "user_1",
    email: "user@example.com",
    event_time: "2026-01-01T10:00:00.000Z",
    amount_usd: 1,
    gross_amount_usd: 1,
    refund_amount_usd: 0,
    net_amount_usd: 1,
    is_refunded: false,
    currency: "USD",
    status: "success",
    transaction_type: "trial",
    funnel: "unknown",
    campaign_path: "soulmate-reading",
    product: "Trial",
    traffic_source: "unknown",
    campaign_id: "",
    classification_reason: "test",
    metadata: { ff_country_code: "us" },
    ...overrides,
  };
}

describe("Users page", () => {
  it("displays user country code when available", () => {
    vi.mocked(useTransactions).mockReturnValue([tx()]);

    render(<UsersPage />);

    expect(screen.getByText("US")).toBeInTheDocument();
  });
});
