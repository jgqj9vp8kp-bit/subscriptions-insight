// Transient-failure handling in the shared ClickHouse client.
//
// ClickHouse Cloud idles a service and resets connections while waking, so a healthy
// warehouse regularly answers the first request with "Connection reset by peer".
// Before retries, that single failure dropped every page to the legacy client-side
// engine for the whole session (observed live 2026-07-27 across cohorts/support/
// users/health). Reads retry; writes must not (a reset can arrive after the server
// accepted the body, so a re-sent INSERT could duplicate rows).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FetchClickHouseClient } from "../../supabase/functions/_shared/clickhouse/client.ts";

const ENV = { host: "https://warehouse.example:8443", username: "default", password: "secret", database: "default" };

function client() {
  return new FetchClickHouseClient(ENV);
}

function okResponse(body: string) {
  return { ok: true, status: 200, text: () => Promise.resolve(body) } as unknown as Response;
}

function httpResponse(status: number, body = "boom") {
  return { ok: false, status, text: () => Promise.resolve(body) } as unknown as Response;
}

const reset = () => new TypeError(
  "error sending request for url (https://warehouse.example:8443/?database=default&param_auth_user_id=278c1a16): client error (Connect): Connection reset by peer (os error 104)",
);

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Drive the promise and the backoff timers together. */
async function run<T>(promise: Promise<T>): Promise<T> {
  type Settled = { ok: true; value: T } | { ok: false; error: unknown };
  const settled: Promise<Settled> = promise.then(
    (value): Settled => ({ ok: true, value }),
    (error): Settled => ({ ok: false, error }),
  );
  await vi.runAllTimersAsync();
  const result = await settled;
  if (result.ok === true) return result.value;
  throw (result as { ok: false; error: unknown }).error;
}

/** Run expecting a rejection; returns the thrown Error. */
async function runExpectingError(promise: Promise<unknown>): Promise<Error> {
  try {
    await run(promise);
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error("expected the request to fail, but it resolved");
}

describe("read retries", () => {
  it("recovers from a connection reset on the first attempt", async () => {
    fetchMock.mockRejectedValueOnce(reset()).mockResolvedValueOnce(okResponse('{"a":1}\n'));
    const rs = await run(client().query({ query: "SELECT 1", format: "JSONEachRow" }));
    expect(await rs.json()).toEqual([{ a: 1 }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up after the bounded attempt count and reports it", async () => {
    fetchMock.mockRejectedValue(reset());
    await expect(run(client().query({ query: "SELECT 1" }))).rejects.toThrow(/after 3 attempts/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not leak the endpoint URL, host or query params into the error", async () => {
    fetchMock.mockRejectedValue(reset());
    const error = await runExpectingError(client().query({ query: "SELECT 1" }));
    expect(error.message).toMatch(/Connection reset by peer/);
    expect(error.message).not.toMatch(/warehouse\.example/);
    expect(error.message).not.toMatch(/param_auth_user_id/);
    expect(error.message).not.toMatch(/https?:\/\//);
  });

  it("retries gateway statuses but never a client error", async () => {
    fetchMock.mockResolvedValueOnce(httpResponse(503)).mockResolvedValueOnce(okResponse("{}"));
    await run(client().query({ query: "SELECT 1" }));
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockClear();
    fetchMock.mockResolvedValue(httpResponse(400, "syntax error"));
    await expect(run(client().query({ query: "SELECT bad" }))).rejects.toThrow(/HTTP 400/);
    expect(fetchMock).toHaveBeenCalledTimes(1); // deterministic failure — no retry
  });

  it("succeeds without retrying when the first attempt works", async () => {
    fetchMock.mockResolvedValue(okResponse("{}"));
    await run(client().query({ query: "SELECT 1" }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("writes are never retried (duplicate-row safety)", () => {
  it("insert fails fast on a reset", async () => {
    fetchMock.mockRejectedValue(reset());
    await expect(run(client().insert({ table: "t", values: [{ a: 1 }] }))).rejects.toThrow(/ClickHouse unreachable/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("command fails fast on a reset", async () => {
    fetchMock.mockRejectedValue(reset());
    await expect(run(client().command({ query: "OPTIMIZE TABLE t" }))).rejects.toThrow(/ClickHouse unreachable/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("an empty insert never touches the network", async () => {
    await run(client().insert({ table: "t", values: [] }));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
