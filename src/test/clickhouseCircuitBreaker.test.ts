// ClickHouse circuit breaker: while the warehouse is down, report reads must
// fail INSTANTLY (so the legacy in-browser engine takes over on every filter
// change) while maintenance calls still reach the edge and recovery is
// automatic on the first successful response.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/supabaseClient", () => ({
  supabase: {
    functions: { invoke: vi.fn() },
    auth: { getSession: vi.fn(async () => ({ data: { session: { access_token: "token" } }, error: null })) },
  },
}));

import { supabase } from "@/services/supabaseClient";
import {
  CLICKHOUSE_UNAVAILABLE_MESSAGE,
  isClickHouseCircuitOpen,
  isWarehouseDownError,
  noteClickHouseReachable,
  runClickHouseBackfill,
  runClickHouseCohorts,
  runClickHouseUsers,
  testClickHouseConnection,
} from "@/services/clickhouse";
import type { CohortRequest } from "../../supabase/functions/_shared/clickhouse/cohortContract";

const invokeMock = vi.mocked(supabase!.functions.invoke);

const cohortsRequest = { action: "list" } as CohortRequest;

beforeEach(() => {
  invokeMock.mockReset();
  noteClickHouseReachable(); // breaker state is module-level — start closed
});

describe("isWarehouseDownError", () => {
  it("matches transport-shaped failures only", () => {
    for (const down of [
      "connection error: Connection reset by peer",
      "TLS handshake failed",
      "Failed to fetch",
      "upstream returned status 503",
      "connect ETIMEDOUT 10.0.0.1:8443",
      "ClickHouse warehouse is unavailable right now",
    ]) {
      expect(isWarehouseDownError(down), down).toBe(true);
    }
    for (const notDown of [
      "Sign in before using ClickHouse warehouse actions.",
      "400 Bad Request: malformed filter",
      "Unknown column fb_spend in table",
      "unauthorized",
      "Row count mismatch: 5 missing ids",
    ]) {
      expect(isWarehouseDownError(notDown), notDown).toBe(false);
    }
  });
});

describe("breaker open/close flow", () => {
  it("a down-shaped edge failure opens the breaker; the next report read fails instantly without a network call", async () => {
    invokeMock.mockResolvedValueOnce({ data: null, error: new Error("connection error: Connection reset by peer") });

    await expect(runClickHouseCohorts(cohortsRequest)).rejects.toThrow(/Connection reset/i);
    expect(isClickHouseCircuitOpen()).toBe(true);

    await expect(runClickHouseCohorts(cohortsRequest)).rejects.toThrow(CLICKHOUSE_UNAVAILABLE_MESSAGE);
    await expect(runClickHouseUsers({ action: "list" } as never)).rejects.toThrow(CLICKHOUSE_UNAVAILABLE_MESSAGE);
    expect(invokeMock).toHaveBeenCalledTimes(1); // only the first, real attempt
  });

  it("a query/auth error does NOT open the breaker", async () => {
    invokeMock.mockResolvedValueOnce({ data: null, error: new Error("Unknown column fb_spend in table") });
    await expect(runClickHouseCohorts(cohortsRequest)).rejects.toThrow(/Unknown column/);
    expect(isClickHouseCircuitOpen()).toBe(false);
  });

  it("maintenance calls bypass the open breaker and a successful response closes it", async () => {
    invokeMock.mockResolvedValueOnce({ data: null, error: new Error("connection reset by peer") });
    await expect(runClickHouseCohorts(cohortsRequest)).rejects.toThrow();
    expect(isClickHouseCircuitOpen()).toBe(true);

    invokeMock.mockResolvedValueOnce({ data: { status: "completed", rows_inserted: 0 }, error: null });
    await runClickHouseBackfill({ mode: "continue" });
    expect(invokeMock).toHaveBeenCalledTimes(2); // the backfill went out despite the open breaker
    expect(isClickHouseCircuitOpen()).toBe(false); // and its success closed it

    invokeMock.mockResolvedValueOnce({ data: { ok: true, rows: [] }, error: null });
    await runClickHouseCohorts(cohortsRequest); // reads flow again
    expect(invokeMock).toHaveBeenCalledTimes(3);
  });

  it("a 200 response with an embedded down-shaped {ok:false,error} opens the breaker instead of closing it", async () => {
    invokeMock.mockResolvedValueOnce({ data: { ok: false, error: "connection reset by peer" }, error: null });
    await runClickHouseCohorts(cohortsRequest); // contract-level failure surfaces downstream via ok:false
    expect(isClickHouseCircuitOpen()).toBe(true);
  });

  it("health: connected=false never closes the breaker, connected=true does", async () => {
    invokeMock.mockResolvedValueOnce({ data: null, error: new Error("connection reset by peer") });
    await expect(runClickHouseCohorts(cohortsRequest)).rejects.toThrow();
    expect(isClickHouseCircuitOpen()).toBe(true);

    invokeMock.mockResolvedValueOnce({ data: { connected: false, error: "still down" }, error: null });
    await testClickHouseConnection();
    expect(isClickHouseCircuitOpen()).toBe(true);

    invokeMock.mockResolvedValueOnce({ data: { connected: true }, error: null });
    await testClickHouseConnection();
    expect(isClickHouseCircuitOpen()).toBe(false);
  });
});
