// Bounded-concurrency range pagination — correctness must be byte-identical to the
// old sequential loop (order, boundaries), only the wall clock changes.
import { describe, expect, it } from "vitest";
import { fetchRangesConcurrently, DEFAULT_RANGE_CONCURRENCY } from "@/services/supabasePagination";

function dataset(size: number): number[] {
  return Array.from({ length: size }, (_, index) => index);
}

function rangeFetcher(rows: number[], calls?: Array<[number, number]>) {
  return async (from: number, to: number): Promise<number[]> => {
    calls?.push([from, to]);
    return rows.slice(from, to + 1);
  };
}

describe("fetchRangesConcurrently", () => {
  it("reassembles pages in order regardless of completion order", async () => {
    const rows = dataset(3_500);
    // Delay pages by a reversed amount so later pages finish FIRST.
    const fetchRange = async (from: number, to: number, pageIndex: number): Promise<number[]> => {
      await new Promise((resolve) => setTimeout(resolve, (4 - pageIndex) * 5));
      return rows.slice(from, to + 1);
    };
    const result = await fetchRangesConcurrently({ totalRows: 3_500, pageSize: 1_000, fetchRange });
    expect(result).toEqual(rows);
  });

  it("issues exact inclusive ranges, clamping the final page", async () => {
    const calls: Array<[number, number]> = [];
    await fetchRangesConcurrently({ totalRows: 2_400, pageSize: 1_000, fetchRange: rangeFetcher(dataset(2_400), calls) });
    expect(calls.sort((a, b) => a[0] - b[0])).toEqual([[0, 999], [1000, 1999], [2000, 2399]]);
  });

  it("respects a start offset (partial loads)", async () => {
    const calls: Array<[number, number]> = [];
    const rows = dataset(5_000);
    const result = await fetchRangesConcurrently({
      totalRows: 1_500, pageSize: 1_000, startOffset: 3_000,
      fetchRange: rangeFetcher(rows, calls),
    });
    expect(calls.sort((a, b) => a[0] - b[0])).toEqual([[3000, 3999], [4000, 4499]]);
    expect(result).toEqual(rows.slice(3_000, 4_500));
  });

  it("never runs more than the concurrency limit at once", async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchRange = async (from: number, to: number): Promise<number[]> => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return dataset(20_000).slice(from, to + 1);
    };
    await fetchRangesConcurrently({ totalRows: 20_000, pageSize: 1_000, concurrency: 4, fetchRange });
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1); // it actually parallelised
  });

  it("reports per-page progress with a monotonic completed counter", async () => {
    const seen: number[] = [];
    await fetchRangesConcurrently({
      totalRows: 3_000, pageSize: 1_000,
      fetchRange: rangeFetcher(dataset(3_000)),
      onPage: (completed, totalPages, rowsInPage) => {
        seen.push(completed);
        expect(totalPages).toBe(3);
        expect(rowsInPage).toBe(1_000);
      },
    });
    expect(seen).toEqual([1, 2, 3]);
  });

  it("returns empty for zero rows without calling the fetcher", async () => {
    const calls: Array<[number, number]> = [];
    const result = await fetchRangesConcurrently({ totalRows: 0, pageSize: 1_000, fetchRange: rangeFetcher([], calls) });
    expect(result).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("a failing page rejects the whole load (no silent partial data)", async () => {
    const fetchRange = async (from: number): Promise<number[]> => {
      if (from >= 2_000) throw new Error("page 3 failed");
      return dataset(3_000).slice(from, from + 1_000);
    };
    await expect(fetchRangesConcurrently({ totalRows: 3_000, pageSize: 1_000, fetchRange }))
      .rejects.toThrow("page 3 failed");
  });

  it("default concurrency is sane", () => {
    expect(DEFAULT_RANGE_CONCURRENCY).toBeGreaterThanOrEqual(2);
    expect(DEFAULT_RANGE_CONCURRENCY).toBeLessThanOrEqual(10);
  });
});
