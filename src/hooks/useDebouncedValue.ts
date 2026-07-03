import { useEffect, useState, useTransition } from "react";

/**
 * Returns a debounced copy of `value` plus a "pending" flag.
 *
 * The intent is to separate the *draft* filter state a user interacts with (updates instantly) from
 * the *applied* filter state that feeds heavy analytics recomputation. Filter controls keep reading
 * the live value so clicks/keystrokes feel immediate; the expensive memos read the returned applied
 * value, which only changes `delayMs` after the last edit. The commit is wrapped in
 * `startTransition`, so the heavy recompute it triggers runs at non-blocking priority and the UI
 * thread stays responsive.
 *
 * IMPORTANT: pass a referentially stable `value` (memoize objects/arrays with `useMemo`). Debouncing
 * keys on `Object.is`, so a fresh object literal every render would never settle.
 *
 * Correctness note: this only changes *when* the applied value updates, never *what* it is. Once the
 * debounce settles, `applied === value`, so any metric derived from it is identical to the
 * non-debounced result.
 *
 * @returns `[appliedValue, isPending]` — `isPending` is true while the applied value lags the draft.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): [T, boolean] {
  const [applied, setApplied] = useState(value);
  const [isTransitionPending, startTransition] = useTransition();

  useEffect(() => {
    if (Object.is(value, applied)) return undefined;
    const id = setTimeout(() => {
      startTransition(() => {
        // Updater form so a function-typed `value` is stored verbatim instead of being invoked.
        setApplied(() => value);
      });
    }, delayMs);
    return () => clearTimeout(id);
    // `startTransition` is stable. `applied` is included so the timer is cleared once it settles.
  }, [value, applied, delayMs]);

  return [applied, isTransitionPending || !Object.is(value, applied)];
}
