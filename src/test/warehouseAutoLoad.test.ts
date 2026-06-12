import { beforeEach, describe, expect, it, vi } from "vitest";

// P0-2: clean-template / Primer imports live only in the Supabase warehouse and must be
// auto-loaded on startup so analytics do not silently revert to mock data.
vi.mock("@/services/transactionWarehouse", () => ({
  isTransactionWarehouseEnabled: vi.fn(),
  getWarehouseTransactionCount: vi.fn(),
  loadWarehouseTransactions: vi.fn(),
}));

import { autoLoadWarehouseIntoStore } from "@/services/analyticsAdapters";
import {
  getWarehouseTransactionCount,
  isTransactionWarehouseEnabled,
  loadWarehouseTransactions,
} from "@/services/transactionWarehouse";
import { useDataStore } from "@/store/dataStore";
import type { Transaction } from "@/services/types";

const enabledMock = vi.mocked(isTransactionWarehouseEnabled);
const countMock = vi.mocked(getWarehouseTransactionCount);
const loadMock = vi.mocked(loadWarehouseTransactions);

function whTx(id: string): Transaction {
  return {
    transaction_id: id,
    user_id: `user_${id}`,
    email: `${id}@example.com`,
    event_time: "2026-04-01T00:00:00Z",
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
    product: "",
    traffic_source: "facebook",
    campaign_id: "",
    classification_reason: "",
    transaction_day: 0,
  };
}

describe("autoLoadWarehouseIntoStore (P0-2)", () => {
  beforeEach(() => {
    useDataStore.getState().resetToMock();
    enabledMock.mockReset();
    countMock.mockReset();
    loadMock.mockReset();
  });

  it("auto-loads warehouse transactions on startup and replaces mock data", async () => {
    enabledMock.mockReturnValue(true);
    countMock.mockResolvedValue(3);
    loadMock.mockResolvedValue([whTx("a"), whTx("b"), whTx("c")]);

    const result = await autoLoadWarehouseIntoStore();

    expect(result.status).toBe("loaded");
    expect(result.count).toBe(3);
    const state = useDataStore.getState();
    expect(state.meta.source).toBe("transaction_warehouse");
    expect(state.transactions.map((tx) => tx.transaction_id)).toEqual(["a", "b", "c"]);
  });

  it("does NOT fall back to mock data when the warehouse has data", async () => {
    enabledMock.mockReturnValue(true);
    countMock.mockResolvedValue(1);
    loadMock.mockResolvedValue([whTx("only")]);

    await autoLoadWarehouseIntoStore();

    const state = useDataStore.getState();
    expect(state.meta.source).not.toBe("mock");
    expect(state.transactions).toHaveLength(1);
    expect(state.transactions[0].transaction_id).toBe("only");
  });

  it("reports empty and keeps the sample-data (mock) state when the warehouse has no rows", async () => {
    enabledMock.mockReturnValue(true);
    countMock.mockResolvedValue(0);

    const result = await autoLoadWarehouseIntoStore();

    expect(result.status).toBe("empty");
    expect(result.message).toBe("No warehouse data found");
    expect(loadMock).not.toHaveBeenCalled();
    expect(useDataStore.getState().meta.source).toBe("mock");
  });

  it("does not clobber a dataset the user already loaded", async () => {
    useDataStore.getState().setImported([whTx("palmer-1")], {
      source: "palmer_raw",
      importMode: "palmer_raw",
      fileName: "palmer.csv",
    });
    enabledMock.mockReturnValue(true);

    const result = await autoLoadWarehouseIntoStore();

    expect(result.status).toBe("skipped");
    expect(countMock).not.toHaveBeenCalled();
    expect(loadMock).not.toHaveBeenCalled();
    const state = useDataStore.getState();
    expect(state.meta.source).toBe("palmer_raw");
    expect(state.transactions.map((tx) => tx.transaction_id)).toEqual(["palmer-1"]);
  });

  it("is a no-op when the warehouse is disabled", async () => {
    enabledMock.mockReturnValue(false);

    const result = await autoLoadWarehouseIntoStore();

    expect(result.status).toBe("disabled");
    expect(countMock).not.toHaveBeenCalled();
    expect(useDataStore.getState().meta.source).toBe("mock");
  });

  it("surfaces an error WITHOUT presenting mock data as real (store stays on mock => banner stays)", async () => {
    enabledMock.mockReturnValue(true);
    countMock.mockResolvedValue(5);
    loadMock.mockRejectedValue(new Error("network down"));

    const result = await autoLoadWarehouseIntoStore();

    expect(result.status).toBe("error");
    expect(result.error).toContain("network down");
    // Critically: source remains "mock" so the UI keeps the visible "Sample data mode" banner
    // rather than silently showing mock numbers as if they were real.
    expect(useDataStore.getState().meta.source).toBe("mock");
  });
});
