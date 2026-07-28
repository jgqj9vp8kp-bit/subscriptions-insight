// Bounded-concurrency range pagination for PostgREST tables.
//
// PostgREST caps a response at ~1000 rows, so big tables are loaded page by page.
// Loading those pages SEQUENTIALLY made app start crawl: 37k transactions = 41
// round-trips one after another = 76s measured. Pages addressed by .range() over a
// stable ORDER BY are independent, so they can be fetched concurrently — same data,
// a fraction of the wall clock.
//
// The caller supplies the exact row count (from a head+count request); the helper
// fans out the ranges with a small worker pool and reassembles pages IN ORDER, so
// the result is byte-identical to the sequential loop. Concurrency stays modest to
// be gentle to PostgREST and to keep memory bounded.

export const DEFAULT_RANGE_CONCURRENCY = 6;

export async function fetchRangesConcurrently<T>(input: {
  /** Total rows to fetch (already offset-adjusted and limit-capped by the caller). */
  totalRows: number;
  pageSize: number;
  /** First absolute row offset (defaults to 0). */
  startOffset?: number;
  concurrency?: number;
  /** Fetch one range [from, to] (absolute offsets, inclusive). */
  fetchRange: (from: number, to: number, pageIndex: number) => Promise<T[]>;
  /** Called after EACH page completes (any order) — for progress reporting. */
  onPage?: (completedPages: number, totalPages: number, rowsInPage: number) => void;
}): Promise<T[]> {
  const { totalRows, pageSize } = input;
  if (totalRows <= 0) return [];
  const startOffset = input.startOffset ?? 0;
  const totalPages = Math.ceil(totalRows / pageSize);
  const concurrency = Math.max(1, Math.min(input.concurrency ?? DEFAULT_RANGE_CONCURRENCY, totalPages));

  const pages: T[][] = new Array(totalPages);
  let nextPage = 0;
  let completedPages = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const pageIndex = nextPage;
      nextPage += 1;
      if (pageIndex >= totalPages) return;
      const from = startOffset + pageIndex * pageSize;
      const to = Math.min(from + pageSize - 1, startOffset + totalRows - 1);
      const rows = await input.fetchRange(from, to, pageIndex);
      pages[pageIndex] = rows;
      completedPages += 1;
      input.onPage?.(completedPages, totalPages, rows.length);
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return pages.flat();
}
