import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import UsersPage from "@/pages/Users";
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
    useDataStore.setState({ rawPalmerRows: [], subscriptions: [] });
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

  function cohortTx(overrides: Partial<Transaction> = {}): Transaction {
    const campaignPath = overrides.campaign_path ?? "campaign-a";
    const eventDate = overrides.event_time?.slice(0, 10) ?? "2026-01-01";
    return tx({
      transaction_id: `${overrides.user_id ?? "user_1"}_trial`,
      user_id: overrides.user_id ?? "user_1",
      email: overrides.email ?? "user@example.com",
      event_time: overrides.event_time ?? "2026-01-01T10:00:00.000Z",
      campaign_path: campaignPath,
      funnel: overrides.funnel ?? "soulmate",
      cohort_date: overrides.cohort_date ?? eventDate,
      cohort_id: overrides.cohort_id ?? `${campaignPath}_${eventDate}`,
      ...overrides,
    });
  }

  function clickCohort(campaignPath: string, options: MouseEventInit = {}) {
    const label = screen.getAllByText(campaignPath)[0];
    const button = label.closest('[role="button"]');
    if (!button) throw new Error(`Could not find cohort button for ${campaignPath}`);
    fireEvent.click(button, options);
  }

  function switchToDeclineAnalytics() {
    const tab = screen.getByRole("tab", { name: "Decline Analytics" });
    fireEvent.mouseDown(tab, { button: 0, ctrlKey: false });
  }

  function startInDeclineAnalytics(extraState: Record<string, unknown> = {}) {
    localStorage.setItem("ui_state_users", JSON.stringify({ mode: "decline_analytics", ...extraState }));
  }

  function summaryCard(label: string): HTMLElement {
    const card = screen
      .getAllByText(label)
      .map((element) => element.closest(".rounded-md"))
      .find((element): element is HTMLElement => Boolean(element?.textContent?.includes(label)));
    if (!card) throw new Error(`Could not find summary card: ${label}`);
    return card;
  }

  function failedTx(overrides: Partial<Transaction> = {}): Transaction {
    return tx({
      transaction_id: overrides.transaction_id ?? "failed_tx",
      status: "failed",
      transaction_type: "failed_payment",
      amount_usd: 0,
      gross_amount_usd: 0,
      net_amount_usd: 0,
      classification_reason: "failed Palmer status",
      event_time: overrides.event_time ?? "2026-01-02T10:00:00.000Z",
      ...overrides,
    });
  }

  it("renders the cohort list", () => {
    vi.mocked(useTransactions).mockReturnValue([
      cohortTx({ user_id: "a", email: "a@example.com", campaign_path: "campaign-a" }),
      cohortTx({ user_id: "b", email: "b@example.com", campaign_path: "campaign-b", event_time: "2026-01-02T10:00:00.000Z" }),
    ]);

    render(<UsersPage />);

    expect(screen.getByText("Cohorts")).toBeInTheDocument();
    expect(screen.getAllByText("campaign-a").length).toBeGreaterThan(0);
    expect(screen.getAllByText("campaign-b").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/1 trials/).length).toBeGreaterThanOrEqual(2);
  });

  it("selects one cohort and filters users", () => {
    vi.mocked(useTransactions).mockReturnValue([
      cohortTx({ user_id: "a", email: "a@example.com", campaign_path: "campaign-a" }),
      cohortTx({ user_id: "b", email: "b@example.com", campaign_path: "campaign-b", event_time: "2026-01-02T10:00:00.000Z" }),
    ]);

    render(<UsersPage />);
    clickCohort("campaign-a");

    expect(screen.getByText("a@example.com")).toBeInTheDocument();
    expect(screen.queryByText("b@example.com")).not.toBeInTheDocument();
  });

  it("matches selected cohorts from transaction cohort ids when user rows have no trial cohort", () => {
    vi.mocked(useTransactions).mockReturnValue([
      cohortTx({ user_id: "trial_user", email: "trial@example.com", campaign_path: "campaign-a" }),
      tx({
        transaction_id: "payment_tx",
        user_id: "payment_user",
        email: "payment@example.com",
        transaction_type: "renewal_2",
        status: "success",
        amount_usd: 10,
        gross_amount_usd: 10,
        net_amount_usd: 10,
        campaign_path: "campaign-a",
        cohort_id: "campaign-a_2026-01-01",
        cohort_date: "2026-01-01",
      }),
      cohortTx({ user_id: "other", email: "other@example.com", campaign_path: "campaign-b", event_time: "2026-01-02T10:00:00.000Z" }),
    ]);

    render(<UsersPage />);
    clickCohort("campaign-a");

    expect(screen.getByText("trial@example.com")).toBeInTheDocument();
    expect(screen.getByText("payment@example.com")).toBeInTheDocument();
    expect(screen.queryByText("other@example.com")).not.toBeInTheDocument();
  });

  it("does not re-filter selected cohort users by campaign path", () => {
    localStorage.setItem(
      "ui_state_users",
      JSON.stringify({
        campaignPathFilter: "campaign-a",
        selectedCohortIds: ["campaign-a_2026-01-01"],
      }),
    );
    vi.mocked(useTransactions).mockReturnValue([
      cohortTx({ user_id: "trial_user", email: "trial@example.com", campaign_path: "campaign-a" }),
      tx({
        transaction_id: "payment_tx",
        user_id: "payment_user",
        email: "payment@example.com",
        transaction_type: "renewal_2",
        status: "success",
        amount_usd: 10,
        gross_amount_usd: 10,
        net_amount_usd: 10,
        campaign_path: "unknown",
        cohort_id: "campaign-a_2026-01-01",
        cohort_date: "2026-01-01",
      }),
    ]);

    render(<UsersPage />);

    expect(screen.getByText("trial@example.com")).toBeInTheDocument();
    expect(screen.getByText("payment@example.com")).toBeInTheDocument();
    expect(screen.queryByText("No users match your filters.")).not.toBeInTheDocument();
  });

  it("selects multiple cohorts with regular clicks", () => {
    vi.mocked(useTransactions).mockReturnValue([
      cohortTx({ user_id: "a", email: "a@example.com", campaign_path: "campaign-a" }),
      cohortTx({ user_id: "b", email: "b@example.com", campaign_path: "campaign-b", event_time: "2026-01-02T10:00:00.000Z" }),
      cohortTx({ user_id: "c", email: "c@example.com", campaign_path: "campaign-c", event_time: "2026-01-03T10:00:00.000Z" }),
    ]);

    render(<UsersPage />);
    clickCohort("campaign-a");
    clickCohort("campaign-b");

    expect(screen.getByText("a@example.com")).toBeInTheDocument();
    expect(screen.getByText("b@example.com")).toBeInTheDocument();
    expect(screen.queryByText("c@example.com")).not.toBeInTheDocument();
  });

  it("clears cohort selection and shows all users again", () => {
    vi.mocked(useTransactions).mockReturnValue([
      cohortTx({ user_id: "a", email: "a@example.com", campaign_path: "campaign-a" }),
      cohortTx({ user_id: "b", email: "b@example.com", campaign_path: "campaign-b", event_time: "2026-01-02T10:00:00.000Z" }),
    ]);

    render(<UsersPage />);
    clickCohort("campaign-a");
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));

    expect(screen.getByText("a@example.com")).toBeInTheDocument();
    expect(screen.getByText("b@example.com")).toBeInTheDocument();
  });

  it("updates summary stats after cohort selection", () => {
    vi.mocked(useTransactions).mockReturnValue([
      cohortTx({ user_id: "a", email: "a@example.com", campaign_path: "campaign-a" }),
      tx({
        transaction_id: "a_upsell",
        user_id: "a",
        email: "a@example.com",
        event_time: "2026-01-01T11:00:00.000Z",
        transaction_type: "upsell",
        campaign_path: "campaign-a",
        amount_usd: 9,
        gross_amount_usd: 9,
        net_amount_usd: 9,
      }),
      cohortTx({ user_id: "b", email: "b@example.com", campaign_path: "campaign-b", event_time: "2026-01-02T10:00:00.000Z" }),
    ]);

    render(<UsersPage />);
    clickCohort("campaign-a");

    expect(screen.getByText("Users").parentElement).toHaveTextContent("1");
    expect(screen.getByText("Upsell Users").parentElement).toHaveTextContent("1");
    expect(screen.getByText("Net Rev").parentElement).toHaveTextContent("$10");
  });

  it("keeps existing filters after cohort selection", () => {
    localStorage.setItem("ui_state_users", JSON.stringify({ selectedCardTypes: ["credit"] }));
    vi.mocked(useTransactions).mockReturnValue([
      cohortTx({ user_id: "credit", email: "credit@example.com", campaign_path: "campaign-a", card_type: "credit" }),
      cohortTx({ user_id: "debit", email: "debit@example.com", campaign_path: "campaign-a", card_type: "debit" }),
    ]);

    render(<UsersPage />);
    clickCohort("campaign-a");

    expect(screen.getByText("credit@example.com")).toBeInTheDocument();
    expect(screen.queryByText("debit@example.com")).not.toBeInTheDocument();
  });

  it("sorts users inside selected cohorts", () => {
    localStorage.setItem("ui_state_users", JSON.stringify({ sortKey: "total_revenue", sortDir: "desc" }));
    vi.mocked(useTransactions).mockReturnValue([
      cohortTx({ user_id: "low", email: "low@example.com", campaign_path: "campaign-a", amount_usd: 1, gross_amount_usd: 1, net_amount_usd: 1 }),
      cohortTx({ user_id: "high", email: "high@example.com", campaign_path: "campaign-a", amount_usd: 5, gross_amount_usd: 5, net_amount_usd: 5 }),
      cohortTx({ user_id: "other", email: "other@example.com", campaign_path: "campaign-b", event_time: "2026-01-02T10:00:00.000Z", amount_usd: 20, gross_amount_usd: 20, net_amount_usd: 20 }),
    ]);

    render(<UsersPage />);
    clickCohort("campaign-a");

    const rows = screen.getAllByRole("row");
    expect(rows[1]).toHaveTextContent("high@example.com");
    expect(rows[2]).toHaveTextContent("low@example.com");
    expect(screen.queryByText("other@example.com")).not.toBeInTheDocument();
  });

  it("switches from the users table to decline analytics", () => {
    vi.mocked(useTransactions).mockReturnValue([
      cohortTx({ user_id: "a", email: "a@example.com", campaign_path: "campaign-a" }),
    ]);

    render(<UsersPage />);

    expect(screen.getByText("a@example.com")).toBeInTheDocument();
    switchToDeclineAnalytics();
    expect(screen.getByText("No declined payments found for selected users.")).toBeInTheDocument();
  });

  it("switches to decline analytics and groups all failed transactions by reason", () => {
    startInDeclineAnalytics();
    vi.mocked(useTransactions).mockReturnValue([
      cohortTx({ user_id: "a", email: "a@example.com", campaign_path: "campaign-a" }),
      failedTx({
        transaction_id: "a_fail_1",
        user_id: "a",
        email: "a@example.com",
        raw: { declineReasons: "[{'decline_reason': 'INSUFFICIENT_FUNDS', 'message': 'insufficient_funds'}]" },
      }),
      failedTx({
        transaction_id: "a_fail_2",
        user_id: "a",
        email: "a@example.com",
        event_time: "2026-01-03T10:00:00.000Z",
        raw: { declineReasons: "[{'payment_method_result_code': '51'}]" },
      }),
      cohortTx({ user_id: "b", email: "b@example.com", campaign_path: "campaign-b", event_time: "2026-01-04T10:00:00.000Z" }),
      failedTx({
        transaction_id: "b_fail_1",
        user_id: "b",
        email: "b@example.com",
        event_time: "2026-01-05T10:00:00.000Z",
        raw: { declineReasons: "[{'decline_reason': 'DO_NOT_HONOR'}]" },
      }),
    ]);

    render(<UsersPage />);

    expect(summaryCard("Failed Users")).toHaveTextContent("2");
    expect(summaryCard("Failed Transactions")).toHaveTextContent("3");
    expect(summaryCard("Decline Rate")).toHaveTextContent("100.0%");
    expect(summaryCard("Top Decline Reason")).toHaveTextContent("insufficient_funds");
    expect(summaryCard("Avg Failed Attempts")).toHaveTextContent("1.50");
    expect(screen.getByText("66.7%")).toBeInTheDocument();
    expect(screen.getByText("33.3%")).toBeInTheDocument();
  });

  it("uses all visible users in decline analytics when no cohort is selected", () => {
    startInDeclineAnalytics({ selectedCardTypes: ["credit"] });
    vi.mocked(useTransactions).mockReturnValue([
      cohortTx({ user_id: "credit", email: "credit@example.com", campaign_path: "campaign-a", card_type: "credit" }),
      failedTx({
        transaction_id: "credit_fail",
        user_id: "credit",
        email: "credit@example.com",
        card_type: "credit",
        raw: { declineReasons: "[{'decline_reason': 'DO_NOT_HONOR'}]" },
      }),
      cohortTx({ user_id: "debit", email: "debit@example.com", campaign_path: "campaign-b", card_type: "debit" }),
      failedTx({
        transaction_id: "debit_fail",
        user_id: "debit",
        email: "debit@example.com",
        card_type: "debit",
        raw: { declineReasons: "[{'decline_reason': 'INSUFFICIENT_FUNDS'}]" },
      }),
    ]);

    render(<UsersPage />);

    expect(summaryCard("Failed Transactions")).toHaveTextContent("1");
    expect(screen.getAllByText("do_not_honor").length).toBeGreaterThan(0);
    expect(screen.queryByText("insufficient_funds")).not.toBeInTheDocument();
  });

  it("updates decline analytics when selected cohorts change", () => {
    startInDeclineAnalytics();
    vi.mocked(useTransactions).mockReturnValue([
      cohortTx({ user_id: "a", email: "a@example.com", campaign_path: "campaign-a" }),
      failedTx({
        transaction_id: "a_fail",
        user_id: "a",
        email: "a@example.com",
        raw: { declineReasons: "[{'decline_reason': 'INSUFFICIENT_FUNDS'}]" },
      }),
      cohortTx({ user_id: "b", email: "b@example.com", campaign_path: "campaign-b", event_time: "2026-01-04T10:00:00.000Z" }),
      failedTx({
        transaction_id: "b_fail",
        user_id: "b",
        email: "b@example.com",
        raw: { declineReasons: "[{'decline_reason': 'DO_NOT_HONOR'}]" },
      }),
    ]);

    render(<UsersPage />);
    clickCohort("campaign-a");

    expect(summaryCard("Failed Transactions")).toHaveTextContent("1");
    expect(screen.getAllByText("insufficient_funds").length).toBeGreaterThan(0);
    expect(screen.queryByText("do_not_honor")).not.toBeInTheDocument();
  });

  it("shows an empty decline analytics state when no failures exist", () => {
    startInDeclineAnalytics();
    vi.mocked(useTransactions).mockReturnValue([
      cohortTx({ user_id: "a", email: "a@example.com", campaign_path: "campaign-a" }),
    ]);

    render(<UsersPage />);

    expect(screen.getByText("No declined payments found for selected users.")).toBeInTheDocument();
  });

  it("sorts decline reason breakdown", () => {
    startInDeclineAnalytics();
    vi.mocked(useTransactions).mockReturnValue([
      cohortTx({ user_id: "a", email: "a@example.com", campaign_path: "campaign-a" }),
      failedTx({
        transaction_id: "a_fail",
        user_id: "a",
        email: "a@example.com",
        raw: { declineReasons: "[{'decline_reason': 'INSUFFICIENT_FUNDS'}]" },
      }),
      cohortTx({ user_id: "b", email: "b@example.com", campaign_path: "campaign-b", event_time: "2026-01-04T10:00:00.000Z" }),
      failedTx({
        transaction_id: "b_fail_1",
        user_id: "b",
        email: "b@example.com",
        raw: { declineReasons: "[{'decline_reason': 'DO_NOT_HONOR'}]" },
      }),
      failedTx({
        transaction_id: "b_fail_2",
        user_id: "b",
        email: "b@example.com",
        event_time: "2026-01-05T10:00:00.000Z",
        raw: { declineReasons: "[{'decline_reason': 'DO_NOT_HONOR'}]" },
      }),
    ]);

    render(<UsersPage />);

    let rows = screen.getAllByRole("row");
    expect(rows[1]).toHaveTextContent("do_not_honor");
    fireEvent.click(screen.getAllByRole("button", { name: /Decline Reason/ }).at(-1)!);
    rows = screen.getAllByRole("row");
    expect(rows[1]).toHaveTextContent("do_not_honor");
    fireEvent.click(screen.getAllByRole("button", { name: /Decline Reason/ }).at(-1)!);
    rows = screen.getAllByRole("row");
    expect(rows[1]).toHaveTextContent("insufficient_funds");
  });
});
