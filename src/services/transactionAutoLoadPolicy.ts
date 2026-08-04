const TRANSACTIONS_UI_STATE_KEY = "ui_state_transactions";

function readPersistedTransactionsMode(storage: Storage | null): "list" | "pass" {
  if (!storage) return "list";
  try {
    const raw = storage.getItem(TRANSACTIONS_UI_STATE_KEY);
    if (!raw) return "list";
    const parsed = JSON.parse(raw) as { mode?: unknown };
    return parsed.mode === "pass" ? "pass" : "list";
  } catch {
    return "list";
  }
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

export function shouldAutoLoadTransactionsForPath(pathname: string, storage: Storage | null = safeLocalStorage()): boolean {
  const normalized = pathname.replace(/\/+$/, "") || "/";
  if (normalized === "/cohorts" || normalized === "/users" || normalized === "/reports") return false;
  if (normalized === "/transactions") return readPersistedTransactionsMode(storage) !== "pass";
  return true;
}

/**
 * Whether the "Sample data mode" banner may appear for the current route.
 *
 * The banner claims the RENDERED numbers are generated demo data. On routes
 * where this policy defers transaction hydration (Cohorts, Users, Payment
 * Pass), the store legitimately stays on source "mock" while the page renders
 * real ClickHouse aggregates — and the mock dataset is architecturally
 * unreachable there (the legacy compute paths receive an empty list until the
 * store leaves "mock"). Showing the banner would state something false about
 * real data. On every other route hydration is actually attempted, so a
 * "mock" store genuinely means demo numbers may be on screen (or the account
 * has no data yet and the import hint is the right guidance) — old behavior.
 */
export function shouldShowSampleDataBanner(
  storeSource: string,
  pathname: string,
  storage: Storage | null = safeLocalStorage(),
): boolean {
  return storeSource === "mock" && shouldAutoLoadTransactionsForPath(pathname, storage);
}
