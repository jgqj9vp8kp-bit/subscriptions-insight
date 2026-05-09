import { describe, expect, it } from "vitest";
import {
  buildPalmerCloudMetadata,
  buildPalmerCloudPayload,
  normalizePalmerCloudPayload,
} from "@/services/palmerCloudSnapshot";
import type { Transaction } from "@/services/types";

const transactions: Transaction[] = [
  {
    transaction_id: "tx_1",
    user_id: "user_1",
    email: "one@example.com",
    event_time: "2026-03-01T00:00:00Z",
    cohort_date: "2026-03-01",
    cohort_id: "path_2026-03-01",
    transaction_day: 0,
    transaction_type: "trial",
    status: "success",
    amount_usd: 1,
    gross_amount_usd: 1,
    refund_amount_usd: 0,
    net_amount_usd: 1,
    is_refunded: false,
    currency: "USD",
    funnel: "unknown",
    campaign_path: "path",
    product: "Trial",
    campaign_id: "campaign",
    traffic_source: "facebook",
    classification_reason: "test",
  },
  {
    transaction_id: "tx_2",
    user_id: "user_2",
    email: "two@example.com",
    event_time: "2026-03-02T00:00:00Z",
    cohort_date: "2026-03-02",
    cohort_id: "path_2026-03-02",
    transaction_day: 0,
    transaction_type: "trial",
    status: "success",
    amount_usd: 1,
    gross_amount_usd: 1,
    refund_amount_usd: 0,
    net_amount_usd: 1,
    is_refunded: false,
    currency: "USD",
    funnel: "unknown",
    campaign_path: "path",
    product: "Trial",
    campaign_id: "campaign",
    traffic_source: "facebook",
    classification_reason: "test",
  },
];

describe("palmer cloud snapshot", () => {
  it("builds save payload shape with enough data to restore Palmer", () => {
    const payload = buildPalmerCloudPayload(transactions, [{ email: "one@example.com" }]);

    expect(payload.payload_version).toBe(1);
    expect(payload.transactions).toHaveLength(2);
    expect(payload.rawPalmerRows).toHaveLength(1);
  });

  it("builds metadata with row, transaction, user, and cohort counts", () => {
    const metadata = buildPalmerCloudMetadata({
      transactions,
      rawPalmerRows: [{}, {}, {}],
      fileName: "palmer.csv",
      importedAt: "2026-05-09T00:00:00Z",
    });

    expect(metadata.file_name).toBe("palmer.csv");
    expect(metadata.rows_count).toBe(3);
    expect(metadata.transactions_count).toBe(2);
    expect(metadata.users_count).toBe(2);
    expect(metadata.cohorts_count).toBe(2);
  });

  it("normalizes corrupted Palmer payloads to null without crashing", () => {
    expect(normalizePalmerCloudPayload({ rawPalmerRows: [] })).toBeNull();
    expect(normalizePalmerCloudPayload(null)).toBeNull();
  });

  it("restores old Palmer payload shape with transactions", () => {
    const payload = normalizePalmerCloudPayload({ transactions });

    expect(payload?.transactions).toHaveLength(2);
    expect(payload?.payload_version).toBe(1);
  });
});
