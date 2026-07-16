import { describe, expect, it } from "vitest";
import { utils, write } from "xlsx";
import {
  SUPPORT_REQUEST_SUMMARY_SELECT,
  buildSupportDashboard,
  classifySupportRequest,
  parseSupportCsvText,
  parseSupportReceivedDate,
  parseSupportWorkbookArrayBuffer,
  summarizeParsedSupportImport,
  type SupportRequestSummaryRow,
} from "@/services/supportAnalytics";

function csv(rows: string[][]): string {
  return rows.map((row) => row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(",")).join("\n");
}

function workbookBuffer(): ArrayBuffer {
  const wb = utils.book_new();
  const ws = utils.aoa_to_sheet([
    ["data", "data2", "data3", "data5", "email", "matched_contact_name"],
    ["Julie Wiley", "Please cancel my membership", "Sent from my iPhone", "30 июн", "", ""],
    ["Angie", "Cancelación", "Solicito mi cancelación", "29 июн", "angie@example.com", "Angie"],
  ]);
  utils.book_append_sheet(wb, ws, "Unified data");
  const bytes = write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  return bytes;
}

function request(overrides: Partial<SupportRequestSummaryRow> = {}): SupportRequestSummaryRow {
  return {
    id: "req_1",
    import_batch_id: "batch_1",
    source_row_number: 2,
    sender_name: "Customer",
    subject: "Refund",
    received_at: "2026-06-30T00:00:00.000Z",
    received_date_raw: "30 июн",
    customer_email: "customer@example.com",
    normalized_email: "customer@example.com",
    matched_contact_name: "Customer",
    category: "Refund",
    subcategory: "refund_request",
    language: "en",
    sentiment: "neutral",
    urgency: "medium",
    requires_refund: true,
    requires_cancellation: false,
    payment_related: true,
    delivery_related: false,
    possible_unauthorized_charge: false,
    duplicate_charge: false,
    urgent: false,
    matched_customer: true,
    classification_confidence: 0.9,
    classification_reason: "Matched",
    manual_category: null,
    manual_subcategory: null,
    manual_urgency: null,
    manual_changed_at: null,
    imported_at: "2026-07-13T00:00:00.000Z",
    ...overrides,
  };
}

describe("support analytics import and classification", () => {
  it("detects XLSM/XLSX-style Unified data sheets and maps generic headers", () => {
    const result = parseSupportWorkbookArrayBuffer(workbookBuffer(), { importYear: 2026 });
    expect(result.diagnostics.sheet_name).toBe("Unified data");
    expect(result.diagnostics.detected_headers).toEqual(["data", "data2", "data3", "data5", "email", "matched_contact_name"]);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].sender_name).toBe("Julie Wiley");
    expect(result.rows[1].normalized_email).toBe("angie@example.com");
  });

  it("parses Russian month abbreviations and records missing-year assumptions", () => {
    const parsed = parseSupportReceivedDate("30 июн", 2026);
    expect(parsed.date_key).toBe("2026-06-30");
    expect(parsed.assumed_year).toBe(2026);
    expect(parsed.warning).toBe("year_assumed_from_import_setting");
    expect(parseSupportReceivedDate("31 мая", 2026).date_key).toBe("2026-05-31");
    expect(parseSupportReceivedDate("1 января", 2026).date_key).toBe("2026-01-01");
  });

  it("parses day-month-year dot dates from exported support files", () => {
    expect(parseSupportReceivedDate("31.12.25", 2026).date_key).toBe("2025-12-31");
    expect(parseSupportReceivedDate("01.01.2026", 2026).date_key).toBe("2026-01-01");
  });

  it("reports invalid localized dates", () => {
    const parsed = parseSupportReceivedDate("35 июн", 2026);
    expect(parsed.received_at).toBeNull();
    expect(parsed.warning).toBe("unparsed_date");
  });

  it("deduplicates identical records but keeps repeated legitimate messages with changed body", () => {
    const source = [
      ["data", "data2", "data3", "data5", "email", "matched_contact_name"],
      ["A", "Same subject", "First body", "30 июн", "a@example.com", "A"],
      ["A", "Same subject", "First body", "30 июн", "a@example.com", "A"],
      ["A", "Same subject", "Second body", "30 июн", "a@example.com", "A"],
    ];
    const result = parseSupportCsvText(csv(source), { importYear: 2026 });
    expect(result.rows[0].source_hash).toBe(result.rows[1].source_hash);
    expect(result.rows[2].source_hash).not.toBe(result.rows[0].source_hash);
  });

  it("classifies English and Spanish cancellation", () => {
    expect(classifySupportRequest("Cancel", "Please unsubscribe me").category).toBe("Cancellation");
    expect(classifySupportRequest("Cancelación", "Solicito dar de baja mi suscripción").category).toBe("Cancellation");
  });

  it("classifies English and Spanish refund", () => {
    expect(classifySupportRequest("Refund", "I want my money back").category).toBe("Refund");
    expect(classifySupportRequest("Reembolso", "Quiero devolver el dinero").category).toBe("Refund");
  });

  it("classifies unauthorized charge, missing product, payment issue, and spam", () => {
    expect(classifySupportRequest("Unauthorized", "I did not subscribe").category).toBe("Unauthorized or unexpected charge");
    expect(classifySupportRequest("Missing order", "I did not receive my soulmate sketch").category).toBe("Product/report not received");
    expect(classifySupportRequest("Payment failed", "My card was declined").category).toBe("Payment issue");
    expect(classifySupportRequest("SEO services", "Marketing proposal").category).toBe("Spam/unrelated");
  });

  it("detects language and urgency from operational rules", () => {
    const spanish = classifySupportRequest("Reembolso", "No recibí mi informe");
    expect(spanish.language).toBe("es");
    const urgent = classifySupportRequest("Unauthorized charge", "Fraud, I will file a chargeback");
    expect(urgent.urgency).toBe("high");
    expect(urgent.payment_related).toBe(true);
  });

  it("builds KPIs, category distribution, matching quality, and manual override effective categories", () => {
    const dashboard = buildSupportDashboard([
      request(),
      request({
        id: "req_2",
        normalized_email: null,
        customer_email: null,
        matched_contact_name: null,
        matched_customer: false,
        category: "Cancellation",
        subcategory: "cancel_subscription",
        requires_cancellation: true,
        requires_refund: false,
        manual_category: "Refund",
        manual_subcategory: "refund_request",
        manual_urgency: "high",
      }),
    ]);
    expect(dashboard.kpis.totalRequests).toBe(2);
    expect(dashboard.kpis.matchedCustomers).toBe(1);
    expect(dashboard.kpis.refundRequests).toBe(2);
    expect(dashboard.categoryRanking[0].category).toBe("Refund");
    expect(dashboard.priorityDistribution.find((row) => row.urgency === "high")?.requests).toBe(1);
    expect(dashboard.matching.unmatched).toBe(1);
  });

  it("keeps aggregate summary selects free of full message bodies", () => {
    expect(SUPPORT_REQUEST_SUMMARY_SELECT).not.toContain("message_body");
  });

  it("summarizes parsed real-import diagnostics without claiming invalid rows succeeded", () => {
    const result = parseSupportCsvText(csv([
      ["data", "data2", "data3", "data5", "email", "matched_contact_name"],
      ["A", "Refund", "refund please", "30 июн", "a@example.com", "A"],
      ["B", "Broken date", "help", "not a date", "", ""],
    ]), { importYear: 2026 });
    const summary = summarizeParsedSupportImport(result, "support.csv");
    expect(summary.total_rows).toBe(2);
    expect(summary.inserted_rows).toBe(1);
    expect(summary.invalid_rows).toBe(1);
    expect(summary.date_range.from).toBe("2026-06-30");
  });
});
