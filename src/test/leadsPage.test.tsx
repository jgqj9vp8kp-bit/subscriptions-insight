import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import LeadsPage, { formatLeadDateTime } from "@/pages/Leads";
import { useDataStore } from "@/store/dataStore";
import type { Transaction } from "@/services/types";

vi.mock("@/components/AppLayout", () => ({
  AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/services/sheets", () => ({
  useTransactions: vi.fn(),
}));

// The page reads useAccess(); these tests cover the data owner's view (legacy
// access: every permission, raw access on — exactly today's behaviour).
vi.mock("@/hooks/useAccess", async () => {
  const { buildAccessValue } = await import("@/contexts/accessContext");
  const owner = buildAccessValue({ status: "legacy", access: null, userId: "test-user" });
  return { useAccess: () => owner, useOptionalAccess: () => owner, useCan: (key: string) => owner.can(key) };
});

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

describe("Leads — lead date column", () => {
  it("shows when each lead came in (first touch, local date and time) right after the email", () => {
    vi.mocked(useTransactions).mockReturnValue([
      tx({ transaction_id: "first", user_id: "lead_user", email: "lead@example.com", status: "failed", event_time: "2026-06-10T10:00:00.000Z" }),
      tx({ transaction_id: "later", user_id: "lead_user", email: "lead@example.com", status: "failed", event_time: "2026-06-12T08:30:00.000Z" }),
    ]);
    render(<LeadsPage />);
    const headers = screen.getAllByRole("columnheader").map((cell) => cell.textContent);
    expect(headers.slice(0, 2)).toEqual(["Email", "Lead Date"]);
    expect(screen.getByText(formatLeadDateTime("2026-06-10T10:00:00.000Z"))).toBeInTheDocument();
  });

  it("formats as YYYY-MM-DD HH:mm in local time and tolerates missing values", () => {
    const local = new Date(2026, 9, 5, 7, 4);
    expect(formatLeadDateTime(local.toISOString())).toBe("2026-10-05 07:04");
    expect(formatLeadDateTime(null)).toBe("");
    expect(formatLeadDateTime("not a date")).toBe("");
  });
});
