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
  if (normalized === "/cohorts" || normalized === "/users") return false;
  if (normalized === "/transactions") return readPersistedTransactionsMode(storage) !== "pass";
  return true;
}
