import { useCallback, useContext, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { AuthContext } from "@/contexts/authContext";
import { AccessContext } from "@/contexts/accessContext";
import { principalHash, registerPurgeHandler } from "@/services/sessionPurge";

type SetState<T> = Dispatch<SetStateAction<T>>;

// How long to wait after the last change before writing UI state to localStorage. Filter clicks and
// keystrokes mutate this state rapidly; serializing + writing on every change is a measurable source
// of input lag. The latest value is always flushed on unmount so navigating away never drops edits.
export const PERSIST_DEBOUNCE_MS = 1000;

// Page UI state (filters, searches, selected funnels) belongs to the person who set it (plan §20):
// keys are suffixed with "@<principal hash>" of the signed-in user, so another account on the same
// browser never starts from it. A value under the bare key was written before this suffix existed
// (owner unknown): only the data owner (rawAccess — before access control the app was theirs) adopts
// it, once, and it is removed on the first write; anyone else never reads it and deletes it on
// sight. The session purge deletes any still left on sign-out / account switch (registered at app
// start: App.tsx imports this module for that side effect). Without a signed-in user (no
// AuthProvider, e.g. unit tests) the bare key is used as before.
const PRINCIPAL_KEY_SEPARATOR = "@";
const PAGE_STATE_KEY_PREFIX = "ui_state_";

/** Bare keys this tab has used — purged as unowned leftovers (besides every bare "ui_state_*"). */
const knownBaseKeys = new Set<string>();

export function principalPageStateKey(key: string, userId: string | null | undefined): string {
  return userId ? `${key}${PRINCIPAL_KEY_SEPARATOR}${principalHash(userId.toLowerCase())}` : key;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Removes every un-suffixed (owner unknown) page-state value. */
export function purgeUnownedPageState(): void {
  try {
    const keys: string[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key !== null) keys.push(key);
    }
    for (const key of keys) {
      if (key.includes(PRINCIPAL_KEY_SEPARATOR)) continue;
      if (key.startsWith(PAGE_STATE_KEY_PREFIX) || knownBaseKeys.has(key)) localStorage.removeItem(key);
    }
  } catch {
    // storage unavailable — nothing to purge
  }
}

// Same person after an access change keeps their own (suffixed) UI state.
registerPurgeHandler("page-ui-state", (reason) => {
  if (reason !== "access_changed") purgeUnownedPageState();
});

export function usePersistedPageState<T>(key: string, defaultValue: T): [T, SetState<T>, () => void] {
  const userId = useContext(AuthContext)?.user?.id ?? null;
  const access = useContext(AccessContext);
  // No AccessProvider (unit tests, legacy wiring): adopt as before.
  const mayAdoptUnowned = !access || access.rawAccess;
  const storageKey = principalPageStateKey(key, userId);
  knownBaseKeys.add(key);

  const [state, setState] = useState<T>(() => {
    try {
      let unowned: string | null = null;
      if (storageKey !== key) {
        unowned = readStored(key);
        if (unowned !== null && !mayAdoptUnowned) {
          // Someone else's pre-suffix state (filters, searches): never shown to
          // this principal, and not left behind for the next one either.
          try {
            localStorage.removeItem(key);
          } catch {
            // storage unavailable
          }
          unowned = null;
        }
      }
      const raw = readStored(storageKey) ?? unowned;
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

  const writeNow = useCallback((targetKey: string, baseKey: string) => {
    try {
      localStorage.setItem(targetKey, JSON.stringify(latestStateRef.current));
      // The adopted unowned value now lives under the owner's key.
      if (targetKey !== baseKey) localStorage.removeItem(baseKey);
    } catch (error) {
      console.warn(`Could not persist UI state for ${targetKey}`, error);
    }
  }, []);

  // Debounced write: only persist once the user stops changing filters for PERSIST_DEBOUNCE_MS.
  useEffect(() => {
    const id = setTimeout(() => writeNow(storageKey, key), PERSIST_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [key, storageKey, state, writeNow]);

  // Guarantee the final value is persisted when the page unmounts or the storage key changes, since
  // the debounce timer above is cancelled by its own cleanup before it can fire on unmount.
  useEffect(() => {
    return () => writeNow(storageKey, key);
  }, [key, storageKey, writeNow]);

  const reset = useCallback(() => {
    try {
      localStorage.removeItem(storageKey);
      if (storageKey !== key) localStorage.removeItem(key);
    } catch (error) {
      console.warn(`Could not reset persisted UI state for ${storageKey}`, error);
    }
    setState(defaultValue);
  }, [defaultValue, key, storageKey]);

  return [state, setState, reset];
}
