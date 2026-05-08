import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from "react";

type SetState<T> = Dispatch<SetStateAction<T>>;

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

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(state));
    } catch (error) {
      console.warn(`Could not persist UI state for ${key}`, error);
    }
  }, [key, state]);

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
