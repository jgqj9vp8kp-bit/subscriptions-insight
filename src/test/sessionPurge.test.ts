import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  notePrincipal,
  principalHash,
  PRINCIPAL_STORAGE_KEY,
  registeredPurgeHandlers,
  registerPurgeHandler,
  runPurge,
  type PurgeReason,
} from "@/services/sessionPurge";

// The registry is module-global: every test unregisters what it registered.
const cleanups: Array<() => void> = [];
function register(name: string, fn: (reason: PurgeReason) => void | Promise<void>) {
  cleanups.push(registerPurgeHandler(name, fn));
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
  vi.restoreAllMocks();
});

describe("session purge registry", () => {
  it("runs every registered handler with the reason", async () => {
    const a = vi.fn();
    const b = vi.fn(async () => {});
    register("a", a);
    register("b", b);

    await runPurge("signed_out");

    expect(a).toHaveBeenCalledWith("signed_out");
    expect(b).toHaveBeenCalledWith("signed_out");
  });

  it("swallows sync throws and async rejections, logs them, and still runs the others", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ok = vi.fn();
    register("throws", () => {
      throw new Error("boom");
    });
    register("rejects", async () => {
      throw new Error("async boom");
    });
    register("ok", ok);

    await expect(runPurge("access_changed")).resolves.toBeUndefined();

    expect(ok).toHaveBeenCalledWith("access_changed");
    const logged = warn.mock.calls.map((call) => String(call[0]));
    expect(logged.some((line) => line.includes('"throws"') && line.includes("boom"))).toBe(true);
    expect(logged.some((line) => line.includes('"rejects"') && line.includes("async boom"))).toBe(true);
  });

  it("abandons a handler that never settles after the timeout", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ok = vi.fn();
    register("hangs", () => new Promise<void>(() => {}));
    register("ok", ok);

    await runPurge("principal_changed", { timeoutMs: 20 });

    expect(ok).toHaveBeenCalledWith("principal_changed");
    expect(warn.mock.calls.some((call) => String(call[0]).includes('"hangs"'))).toBe(true);
  });

  it("re-registering a name replaces the handler; a stale unregister does not remove the new one", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const unregisterFirst = registerPurgeHandler("same", first);
    register("same", second);

    unregisterFirst(); // stale: "same" now points at `second`
    expect(registeredPurgeHandlers()).toContain("same");

    await runPurge("signed_out");
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("unregister removes the handler", async () => {
    const fn = vi.fn();
    const unregister = registerPurgeHandler("temp", fn);
    unregister();
    await runPurge("signed_out");
    expect(fn).not.toHaveBeenCalled();
    expect(registeredPurgeHandlers()).not.toContain("temp");
  });

  it("resolves with no handlers registered", async () => {
    await expect(runPurge("signed_out")).resolves.toBeUndefined();
  });
});

describe("principal marker", () => {
  it("reports first, same, then changed for another user", () => {
    expect(notePrincipal("user-a")).toBe("first");
    expect(notePrincipal("user-a")).toBe("same");
    expect(notePrincipal("USER-A")).toBe("same");
    expect(notePrincipal("user-b")).toBe("changed");
    expect(notePrincipal("user-b")).toBe("same");
  });

  it("stores only a hash of the user id", () => {
    notePrincipal("11111111-2222-3333-4444-555555555555");
    const stored = localStorage.getItem(PRINCIPAL_STORAGE_KEY);
    expect(stored).toBe(principalHash("11111111-2222-3333-4444-555555555555"));
    expect(stored).not.toContain("1111");
  });

  it("treats unusable storage as first sight", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(notePrincipal("user-a")).toBe("first");
  });
});
