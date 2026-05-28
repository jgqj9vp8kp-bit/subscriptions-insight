import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
    transaction_id: overrides.transaction_id ?? "tx_1",
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
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it("displays user country code when available", () => {
    vi.mocked(useTransactions).mockReturnValue([tx()]);

    render(<UsersPage />);

    expect(screen.getByText("US")).toBeInTheDocument();
  });

  it("displays user card type", () => {
    vi.mocked(useTransactions).mockReturnValue([
      tx({ card_type: "prepaid", raw: { paymentInstrumentBinDataAccountFundingType: "prepaid" } }),
    ]);

    render(<UsersPage />);

    expect(screen.getByText("Prepaid")).toBeInTheDocument();
  });

  it("filters users by one card type from persisted UI state", () => {
    localStorage.setItem("ui_state_users", JSON.stringify({ selectedCardTypes: ["prepaid"] }));
    vi.mocked(useTransactions).mockReturnValue([
      tx({
        transaction_id: "prepaid_tx",
        user_id: "prepaid_user",
        email: "prepaid@example.com",
        card_type: "prepaid",
      }),
      tx({
        transaction_id: "credit_tx",
        user_id: "credit_user",
        email: "credit@example.com",
        card_type: "credit",
      }),
    ]);

    render(<UsersPage />);

    expect(screen.getByText("prepaid@example.com")).toBeInTheDocument();
    expect(screen.queryByText("credit@example.com")).not.toBeInTheDocument();
  });

  it("filters users by multiple card types from persisted UI state", () => {
    localStorage.setItem("ui_state_users", JSON.stringify({ selectedCardTypes: ["prepaid", "debit"] }));
    vi.mocked(useTransactions).mockReturnValue([
      tx({
        transaction_id: "prepaid_tx",
        user_id: "prepaid_user",
        email: "prepaid@example.com",
        card_type: "prepaid",
      }),
      tx({
        transaction_id: "debit_tx",
        user_id: "debit_user",
        email: "debit@example.com",
        card_type: "debit",
      }),
      tx({
        transaction_id: "credit_tx",
        user_id: "credit_user",
        email: "credit@example.com",
        card_type: "credit",
      }),
    ]);

    render(<UsersPage />);

    expect(screen.getByText("prepaid@example.com")).toBeInTheDocument();
    expect(screen.getByText("debit@example.com")).toBeInTheDocument();
    expect(screen.queryByText("credit@example.com")).not.toBeInTheDocument();
  });

  it("sorts users by card type", () => {
    localStorage.setItem("ui_state_users", JSON.stringify({ sortKey: "card_type", sortDir: "asc" }));
    vi.mocked(useTransactions).mockReturnValue([
      tx({
        transaction_id: "prepaid_tx",
        user_id: "prepaid_user",
        email: "prepaid@example.com",
        card_type: "prepaid",
      }),
      tx({
        transaction_id: "credit_tx",
        user_id: "credit_user",
        email: "credit@example.com",
        card_type: "credit",
      }),
      tx({
        transaction_id: "debit_tx",
        user_id: "debit_user",
        email: "debit@example.com",
        card_type: "debit",
      }),
    ]);

    render(<UsersPage />);

    const rows = screen.getAllByRole("row");
    expect(rows[1]).toHaveTextContent("credit@example.com");
    expect(rows[2]).toHaveTextContent("debit@example.com");
    expect(rows[3]).toHaveTextContent("prepaid@example.com");
  });

  it("displays failed payment analytics", () => {
    vi.mocked(useTransactions).mockReturnValue([
      tx({
        transaction_id: "failed_tx",
        status: "failed",
        transaction_type: "failed_payment",
        raw: { declineReasons: "[{'decline_reason': 'INSUFFICIENT_FUNDS', 'message': 'insufficient_funds'}]" },
      }),
    ]);

    render(<UsersPage />);

    expect(screen.getByText("Yes")).toBeInTheDocument();
    expect(screen.getByText("insufficient_funds")).toBeInTheDocument();
    expect(screen.getAllByText("01.01.2026").length).toBeGreaterThan(0);
  });

  it("filters users by failed payment status from persisted UI state", () => {
    localStorage.setItem("ui_state_users", JSON.stringify({ paymentFailedFilter: "has" }));
    vi.mocked(useTransactions).mockReturnValue([
      tx({
        transaction_id: "failed_tx",
        user_id: "failed_user",
        email: "failed@example.com",
        status: "failed",
        transaction_type: "failed_payment",
        raw: { declineReasons: "[{'decline_reason': 'DO_NOT_HONOR'}]" },
      }),
      tx({
        transaction_id: "success_tx",
        user_id: "success_user",
        email: "success@example.com",
      }),
    ]);

    render(<UsersPage />);

    expect(screen.getByText("failed@example.com")).toBeInTheDocument();
    expect(screen.queryByText("success@example.com")).not.toBeInTheDocument();
  });

  it("filters users by decline reason from persisted UI state", () => {
    localStorage.setItem("ui_state_users", JSON.stringify({ selectedDeclineReasons: ["card_not_supported"] }));
    vi.mocked(useTransactions).mockReturnValue([
      tx({
        transaction_id: "unsupported_tx",
        user_id: "unsupported_user",
        email: "unsupported@example.com",
        status: "failed",
        transaction_type: "failed_payment",
        raw: { declineReasons: "[{'message': 'Your card does not support this type of purchase.'}]" },
      }),
      tx({
        transaction_id: "funds_tx",
        user_id: "funds_user",
        email: "funds@example.com",
        status: "failed",
        transaction_type: "failed_payment",
        raw: { declineReasons: "[{'decline_reason': 'INSUFFICIENT_FUNDS'}]" },
      }),
    ]);

    render(<UsersPage />);

    expect(screen.getByText("unsupported@example.com")).toBeInTheDocument();
    expect(screen.queryByText("funds@example.com")).not.toBeInTheDocument();
  });

  it("filters users by failed attempts threshold", () => {
    localStorage.setItem("ui_state_users", JSON.stringify({ failedAttemptsFilter: "gte3" }));
    vi.mocked(useTransactions).mockReturnValue([
      tx({
        transaction_id: "multi_1",
        user_id: "multi_user",
        email: "multi@example.com",
        status: "failed",
        transaction_type: "failed_payment",
        event_time: "2026-01-01T10:00:00.000Z",
      }),
      tx({
        transaction_id: "multi_2",
        user_id: "multi_user",
        email: "multi@example.com",
        status: "failed",
        transaction_type: "failed_payment",
        event_time: "2026-01-02T10:00:00.000Z",
      }),
      tx({
        transaction_id: "multi_3",
        user_id: "multi_user",
        email: "multi@example.com",
        status: "failed",
        transaction_type: "failed_payment",
        event_time: "2026-01-03T10:00:00.000Z",
      }),
      tx({
        transaction_id: "single",
        user_id: "single_user",
        email: "single@example.com",
        status: "failed",
        transaction_type: "failed_payment",
      }),
    ]);

    render(<UsersPage />);

    expect(screen.getByText("multi@example.com")).toBeInTheDocument();
    expect(screen.queryByText("single@example.com")).not.toBeInTheDocument();
  });

  it("sorts users by failed attempts", () => {
    localStorage.setItem("ui_state_users", JSON.stringify({ sortKey: "failed_payment_count", sortDir: "desc" }));
    vi.mocked(useTransactions).mockReturnValue([
      tx({
        transaction_id: "single",
        user_id: "single_user",
        email: "single@example.com",
        status: "failed",
        transaction_type: "failed_payment",
      }),
      tx({
        transaction_id: "multi_1",
        user_id: "multi_user",
        email: "multi@example.com",
        status: "failed",
        transaction_type: "failed_payment",
        event_time: "2026-01-01T10:00:00.000Z",
      }),
      tx({
        transaction_id: "multi_2",
        user_id: "multi_user",
        email: "multi@example.com",
        status: "failed",
        transaction_type: "failed_payment",
        event_time: "2026-01-02T10:00:00.000Z",
      }),
    ]);

    render(<UsersPage />);

    const rows = screen.getAllByRole("row");
    expect(rows[1]).toHaveTextContent("multi@example.com");
    expect(rows[2]).toHaveTextContent("single@example.com");
  });
});
