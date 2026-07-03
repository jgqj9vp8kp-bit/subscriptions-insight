import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";

type SetState<T> = Dispatch<SetStateAction<T>>;

// How long to wait after the last change before writing UI state to localStorage. Filter clicks and
// keystrokes mutate this state rapidly; serializing + writing on every change is a measurable source
// of input lag. The latest value is always flushed on unmount so navigating away never drops edits.
export const PERSIST_DEBOUNCE_MS = 1000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function usePersistedPageState<T>(key: string, defaultValue: T): [T, SetState<T>, () => void] {
  const [state, setState] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return defaultValue;
      const parsed = JSON.parse(raw);
      if (isPlainObject(defaultValue) && isPlainObject(parsed)) {
        return { ...defaultValue, ...parsed } as T;
      }
      return parsed as T;
    } catch (error) {
      console.warn(`Could not load persisted UI state for ${key}`, error);
      return defaultValue;
    }
  });

  // Keep the latest state in a ref so the unmount/key-change flush always writes the newest value
  // without re-subscribing the cleanup on every change.
  const latestStateRef = useRef(state);
  latestStateRef.current = state;

  const writeNow = useCallback((targetKey: string) => {
    try {
      localStorage.setItem(targetKey, JSON.stringify(latestStateRef.current));
    } catch (error) {
      console.warn(`Could not persist UI state for ${targetKey}`, error);
    }
  }, []);

  // Debounced write: only persist once the user stops changing filters for PERSIST_DEBOUNCE_MS.
  useEffect(() => {
    const id = setTimeout(() => writeNow(key), PERSIST_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [key, state, writeNow]);

  // Guarantee the final value is persisted when the page unmounts or the storage key changes, since
  // the debounce timer above is cancelled by its own cleanup before it can fire on unmount.
  useEffect(() => {
    return () => writeNow(key);
  }, [key, writeNow]);

  const reset = useCallback(() => {
    try {
      localStorage.removeItem(key);
    } catch (error) {
      console.warn(`Could not reset persisted UI state for ${key}`, error);
    }
    setState(defaultValue);
  }, [defaultValue, key]);

  return [state, setState, reset];
}
