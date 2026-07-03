import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SupportPage from "@/pages/Support";
import type { SupportMessage } from "@/services/supportInbox";

vi.mock("@/components/AppLayout", () => ({
  AppLayout: ({ title, description, actions, children }: { title: string; description?: string; actions?: ReactNode; children: ReactNode }) => (
    <div>
      <h1>{title}</h1>
      {description && <p>{description}</p>}
      <div>{actions}</div>
      {children}
    </div>
  ),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@/services/supportInbox", async () => {
  const actual = await vi.importActual<typeof import("@/services/supportInbox")>("@/services/supportInbox");
  return {
    ...actual,
    listSupportMessages: vi.fn(),
    syncSupportMail: vi.fn(),
  };
});

import { listSupportMessages, syncSupportMail } from "@/services/supportInbox";

function message(overrides: Partial<SupportMessage> = {}): SupportMessage {
  return {
    id: "msg_1",
    auth_user_id: "auth_1",
    message_id: "mail_1",
    thread_id: null,
    mailbox: "support@azora-astro.com",
    folder: "INBOX",
    from_email: "refund@example.com",
    from_name: "Refund User",
    to_email: "support@azora-astro.com",
    subject: "Refund please",
    body_text: "Please refund my order.",
    body_html: null,
    received_at: "2026-05-02T10:00:00.000Z",
    synced_at: "2026-05-02T10:01:00.000Z",
    detected_intent: "refund_request",
    matched_user_email: "refund@example.com",
    matched_user_id: "user_1",
    cohort_id: "soulmate_soulmate-reading_2026-05-01",
    cohort_date: "2026-05-01",
    campaign_path: "soulmate-reading",
    campaign_id: "cmp_1",
    media_buyer: "Ivan",
    country_code: "US",
    card_type: "debit",
    subscription_status: "has_subscription",
    refund_status: "refunded",
    amount_paid: 20,
    amount_refunded: 10,
    raw_headers: {},
    raw_payload: {},
    created_at: "2026-05-02T10:01:00.000Z",
    updated_at: "2026-05-02T10:01:00.000Z",
    ...overrides,
  };
}

describe("Support page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listSupportMessages).mockResolvedValue([
      message(),
      message({
        id: "msg_2",
        message_id: "mail_2",
        from_email: "cancel@example.com",
        subject: "Cancel my plan",
        body_text: "Please cancel.",
        detected_intent: "cancel_subscription",
        matched_user_id: null,
        matched_user_email: null,
        campaign_path: "past-life",
        campaign_id: "cmp_2",
        media_buyer: "Unknown",
        country_code: "CA",
        card_type: "credit",
        subscription_status: null,
        refund_status: null,
        amount_paid: null,
        amount_refunded: null,
      }),
    ]);
    vi.mocked(syncSupportMail).mockResolvedValue({
      synced: 2,
      inserted: 1,
      updated: 1,
      skipped: 0,
      matched_users: 1,
      unmatched: 1,
      latest_received_at: "2026-05-02T10:00:00.000Z",
    });
  });

  it("renders summary cards and messages", async () => {
    render(<SupportPage />);

    expect(await screen.findByText("Support Inbox")).toBeInTheDocument();
    expect(screen.getByText("Mail.ru support mailbox synced with user/cohort analytics.")).toBeInTheDocument();
    expect(screen.getByText("Total Messages")).toBeInTheDocument();
    expect(screen.getByText("Refund Requests")).toBeInTheDocument();
    expect(screen.getByText("Cancel Requests")).toBeInTheDocument();
    expect(screen.getByText("refund@example.com")).toBeInTheDocument();
    expect(screen.getAllByText("cancel@example.com").length).toBeGreaterThan(0);
  });

  it("filters the table by search text", async () => {
    render(<SupportPage />);
    await screen.findByText("refund@example.com");

    fireEvent.change(screen.getByPlaceholderText("Email or subject"), { target: { value: "cancel" } });

    await waitFor(() => expect(screen.getAllByText("cancel@example.com").length).toBeGreaterThan(0));
    expect(screen.queryByText("refund@example.com")).not.toBeInTheDocument();
  });

  it("shows sync summary response after manual sync", async () => {
    render(<SupportPage />);
    await screen.findByText("refund@example.com");

    fireEvent.click(screen.getByRole("button", { name: /sync mail.ru inbox/i }));

    await waitFor(() => expect(syncSupportMail).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Inserted")).toBeInTheDocument();
    expect(screen.getAllByText("1").length).toBeGreaterThan(0);
  });

  it("opens a message detail dialog", async () => {
    render(<SupportPage />);
    const row = (await screen.findByText("Refund please")).closest("tr");
    expect(row).not.toBeNull();

    fireEvent.click(row!);

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Message Body")).toBeInTheDocument();
    expect(within(dialog).getByText("Please refund my order.")).toBeInTheDocument();
    expect(within(dialog).getByText("soulmate_soulmate-reading_2026-05-01")).toBeInTheDocument();
  });
});
