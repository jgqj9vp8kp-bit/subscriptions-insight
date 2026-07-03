import { describe, expect, it } from "vitest";
import {
  classifySupportIntent,
  enrichSupportMessageFromTransactions,
  filterSupportMessages,
  normalizeSupportEmail,
  summarizeSupportMessages,
  type SupportMessage,
} from "@/services/supportInbox";
import type { Transaction } from "@/services/types";
import {
  extractEmailLiterals,
  parseRawEmail,
} from "../../supabase/functions/sync-support-mail/support";

function tx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    transaction_id: "tx_1",
    user_id: "user_1",
    email: "customer@example.com",
    event_time: "2026-05-01T10:00:00.000Z",
    amount_usd: 1,
    gross_amount_usd: 1,
    refund_amount_usd: 0,
    net_amount_usd: 1,
    is_refunded: false,
    currency: "USD",
    status: "success",
    transaction_type: "trial",
    funnel: "soulmate",
    campaign_path: "soulmate-reading",
    product: "Trial",
    traffic_source: "facebook",
    campaign_id: "cmp_1",
    utm_source: "4",
    classification_reason: "test",
    metadata: { ff_country_code: "US", card_type: "debit", utm_source: "4" },
    raw: { metadata: { ff_country_code: "US" } },
    ...overrides,
  };
}

function message(overrides: Partial<SupportMessage> = {}): SupportMessage {
  return {
    id: "msg_1",
    auth_user_id: "auth_1",
    message_id: "mail_1",
    thread_id: null,
    mailbox: "support@azora-astro.com",
    folder: "INBOX",
    from_email: "customer@example.com",
    from_name: "Customer",
    to_email: "support@azora-astro.com",
    subject: "Please refund me",
    body_text: "I need help",
    body_html: null,
    received_at: "2026-05-02T10:00:00.000Z",
    synced_at: "2026-05-02T10:01:00.000Z",
    detected_intent: "refund_request",
    matched_user_email: "customer@example.com",
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

describe("support inbox helpers", () => {
  it("classifies intents by priority", () => {
    expect(classifySupportIntent("Cancel and refund", "Please return my money")).toBe("refund_request");
    expect(classifySupportIntent("Cancel", "unsubscribe me")).toBe("cancel_subscription");
    expect(classifySupportIntent("Payment declined", "My card was charged")).toBe("payment_problem");
    expect(classifySupportIntent("Cannot login", "password not received")).toBe("access_problem");
    expect(classifySupportIntent("Question", "Need support")).toBe("general_support");
    expect(classifySupportIntent("Hello", "Nice day")).toBe("unknown");
  });

  it("normalizes support email addresses", () => {
    expect(normalizeSupportEmail("  Customer@Example.COM ")).toBe("customer@example.com");
    expect(normalizeSupportEmail(null)).toBe("");
  });

  it("enriches matched users from existing warehouse transactions", () => {
    const enrichment = enrichSupportMessageFromTransactions("CUSTOMER@example.com", [
      tx(),
      tx({
        transaction_id: "sub_1",
        event_time: "2026-05-03T10:00:00.000Z",
        transaction_type: "first_subscription",
        amount_usd: 19,
        gross_amount_usd: 19,
        net_amount_usd: 19,
      }),
      tx({
        transaction_id: "refund_1",
        event_time: "2026-05-04T10:00:00.000Z",
        status: "refunded",
        transaction_type: "refund",
        amount_usd: -5,
        gross_amount_usd: 0,
        refund_amount_usd: 5,
        net_amount_usd: -5,
        is_refunded: true,
      }),
    ]);

    expect(enrichment.matched_user_id).toBe("user_1");
    expect(enrichment.cohort_id).toBe("soulmate_soulmate-reading_2026-05-01");
    expect(enrichment.media_buyer).toBe("Ivan");
    expect(enrichment.country_code).toBe("US");
    expect(enrichment.card_type).toBe("debit");
    expect(enrichment.subscription_status).toBe("has_subscription");
    expect(enrichment.refund_status).toBe("refunded");
    expect(enrichment.amount_paid).toBe(20);
    expect(enrichment.amount_refunded).toBe(5);
  });

  it("stores unmatched messages with null enrichment", () => {
    const enrichment = enrichSupportMessageFromTransactions("unknown@example.com", [tx()]);
    expect(enrichment.matched_user_id).toBeNull();
    expect(enrichment.cohort_id).toBeNull();
  });

  it("filters messages and builds summary cards", () => {
    const messages = [
      message(),
      message({
        id: "msg_2",
        message_id: "mail_2",
        detected_intent: "cancel_subscription",
        matched_user_id: null,
        matched_user_email: null,
        from_email: "other@example.com",
        campaign_path: "past-life",
        card_type: "credit",
      }),
    ];

    expect(filterSupportMessages(messages, { intent: "refund_request" })).toHaveLength(1);
    expect(filterSupportMessages(messages, { matchStatus: "unmatched" })[0].message_id).toBe("mail_2");
    expect(filterSupportMessages(messages, { search: "other" })[0].from_email).toBe("other@example.com");
    expect(summarizeSupportMessages(messages)).toEqual({
      totalMessages: 2,
      refundRequests: 1,
      cancelRequests: 1,
      paymentProblems: 0,
      matchedUsers: 1,
      unmatchedMessages: 1,
    });
  });

  it("parses raw IMAP emails without exposing credentials", () => {
    const raw = [
      "Message-ID: <m1@example.com>",
      "From: Customer <Customer@Example.com>",
      "To: support@azora-astro.com",
      "Subject: Refund request",
      "Date: Fri, 02 May 2026 10:00:00 +0000",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Please refund my subscription.",
    ].join("\r\n");

    const parsed = parseRawEmail(raw, "42");
    expect(parsed.message_id).toBe("<m1@example.com>");
    expect(parsed.from_email).toBe("customer@example.com");
    expect(parsed.body_text).toContain("Please refund");
    expect(JSON.stringify(parsed)).not.toContain("MAILRU_IMAP_PASSWORD");
  });

  it("extracts IMAP literals for message deduplication parsing", () => {
    const response = "* 1 FETCH (UID 7 BODY[] {5}\r\nhello)\r\nA0001 OK FETCH completed\r\n";
    expect(extractEmailLiterals(response)).toEqual(["hello"]);
  });
});
