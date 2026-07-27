// Shared hand-off between the Plan and Compare tabs: a small localStorage list of
// serializable {id, label, frozen} entries. Plan pushes snapshots; Compare re-runs
// them through the engine (deterministic) and diffs against a chosen baseline.
// Saved-scenario persistence (Postgres) is separate — this is the working set.
import type { FrozenForecastInputs } from "@/services/funnelEconomics";

const STORAGE_KEY = "forecasting_compare_entries_v1";
export const COMPARE_ENTRIES_LIMIT = 6;

export interface CompareStoreEntry {
  id: string;
  label: string;
  frozen: FrozenForecastInputs;
  addedAt: string;
}

export function loadCompareEntries(): CompareStoreEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is CompareStoreEntry =>
      Boolean(entry && typeof entry === "object" && "id" in entry && "frozen" in entry),
    );
  } catch {
    return [];
  }
}

export function saveCompareEntries(entries: CompareStoreEntry[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, COMPARE_ENTRIES_LIMIT)));
}

/** Append (or replace by id) and persist; returns the new list. */
export function addCompareEntry(entry: CompareStoreEntry): CompareStoreEntry[] {
  const rest = loadCompareEntries().filter((existing) => existing.id !== entry.id);
  const next = [...rest, entry].slice(-COMPARE_ENTRIES_LIMIT);
  saveCompareEntries(next);
  return next;
}

export function removeCompareEntry(id: string): CompareStoreEntry[] {
  const next = loadCompareEntries().filter((entry) => entry.id !== id);
  saveCompareEntries(next);
  return next;
}

export function clearCompareEntries(): void {
  saveCompareEntries([]);
}
