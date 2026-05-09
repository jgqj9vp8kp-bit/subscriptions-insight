import { describe, expect, it } from "vitest";
import {
  prepareSnapshotPayload,
  resolveSnapshotPayload,
  saveCloudSnapshot,
} from "@/services/dataSnapshots";

describe("dataSnapshots payload handling", () => {
  it("roundtrips compressed payloads", () => {
    const input = {
      transactions: Array.from({ length: 20 }, (_, index) => ({
        id: `tx_${index}`,
        amount: 29.99,
        notes: "large payload row ".repeat(20),
      })),
    };

    const prepared = prepareSnapshotPayload(input, 0.1);
    expect(prepared.metadata.payload_compressed).toBe(true);

    const resolved = resolveSnapshotPayload<typeof input>(prepared.payload);
    expect(resolved).toEqual(input);
  });

  it("returns null for corrupted compressed payloads", () => {
    const resolved = resolveSnapshotPayload({
      __subengine_compressed: true,
      algorithm: "lz-string-uri-v1",
      data: "not-valid-compressed-json",
      original_size_kb: 1,
      compressed_size_kb: 1,
    });

    expect(resolved).toBeNull();
  });

  it("prevents save without authenticated Supabase user with a clear error", async () => {
    await expect(
      saveCloudSnapshot({
        datasetType: "palmer",
        payload: { transactions: [] },
      }),
    ).rejects.toThrow(/authenticated Supabase user/);
  });
});
