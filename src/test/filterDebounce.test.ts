import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { PERSIST_DEBOUNCE_MS, usePersistedPageState } from "@/hooks/usePersistedPageState";

describe("useDebouncedValue", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("returns the draft value immediately with no pending state on first render", () => {
    const { result } = renderHook(() => useDebouncedValue("a", 300));
    expect(result.current[0]).toBe("a");
    expect(result.current[1]).toBe(false);
  });

  it("marks pending immediately when the draft changes but keeps the applied value stale", () => {
    const { result, rerender } = renderHook(({ v }) => useDebouncedValue(v, 300), {
      initialProps: { v: "a" },
    });

    // Draft changed: the control already shows "b", but the applied (analytics) value lags.
    rerender({ v: "b" });
    expect(result.current[0]).toBe("a");
    expect(result.current[1]).toBe(true);
  });

  it("applies the new value only after the debounce delay elapses", () => {
    const { result, rerender } = renderHook(({ v }) => useDebouncedValue(v, 300), {
      initialProps: { v: "a" },
    });

    rerender({ v: "b" });
    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(result.current[0]).toBe("a");

    act(() => {
      vi.advanceTimersByTime(1);
    });
    // After the debounce, applied === draft: identical value, so any derived metric is unchanged.
    expect(result.current[0]).toBe("b");
    expect(result.current[1]).toBe(false);
  });

  it("collapses a burst of rapid changes into a single applied update (one recompute)", () => {
    const { result, rerender } = renderHook(({ v }) => useDebouncedValue(v, 300), {
      initialProps: { v: 0 },
    });

    rerender({ v: 1 });
    act(() => vi.advanceTimersByTime(100));
    rerender({ v: 2 });
    act(() => vi.advanceTimersByTime(100));
    rerender({ v: 3 });

    // The delay never lapsed between clicks, so the applied value never saw 1 or 2.
    expect(result.current[0]).toBe(0);

    act(() => vi.advanceTimersByTime(300));
    expect(result.current[0]).toBe(3);
  });
});

describe("usePersistedPageState debounced persistence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
  });
  afterEach(() => vi.useRealTimers());

  it("does not write to localStorage on every change", () => {
    const { result } = renderHook(() => usePersistedPageState("k_debounce", { a: 1 }));

    act(() => result.current[1]({ a: 2 }));
    // No synchronous write — the click stays cheap.
    expect(localStorage.getItem("k_debounce")).toBeNull();
  });

  it("persists the latest value once the debounce window passes", () => {
    const { result } = renderHook(() => usePersistedPageState("k_debounce2", { a: 1 }));

    act(() => result.current[1]({ a: 2 }));
    act(() => result.current[1]({ a: 3 }));
    expect(localStorage.getItem("k_debounce2")).toBeNull();

    act(() => vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS));
    expect(JSON.parse(localStorage.getItem("k_debounce2") as string)).toEqual({ a: 3 });
  });

  it("flushes the latest value immediately on unmount so navigating away never drops edits", () => {
    const { result, unmount } = renderHook(() => usePersistedPageState("k_debounce3", { a: 1 }));

    act(() => result.current[1]({ a: 9 }));
    unmount();
    expect(JSON.parse(localStorage.getItem("k_debounce3") as string)).toEqual({ a: 9 });
  });
});
