// Age of a ClickHouse parity-validation verdict.
//
// A completed validation keeps its result in clickhouse_validation_state until the
// next run, and the Integrations panel rendered that result with no timestamp — so a
// FAIL produced weeks earlier (29,479 rows, 258 missing) looked like it described the
// warehouse right now, while the source had since grown past 37,000 rows. This turns
// the raw state into an explicit "how old, and has the source moved on" verdict.

export interface ValidationStaleness {
  /** ISO instant the verdict was produced (completed_at, else started_at). */
  at: string;
  ageMs: number;
  /** Human age, e.g. "14 days ago". */
  ageLabel: string;
  validatedRows: number | null;
  currentRows: number | null;
  /** The source grew since the run, so the verdict cannot describe it any more. */
  sourceGrew: boolean;
}

/** Older than this and the verdict is worth flagging even if nothing changed. */
export const VALIDATION_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

function ageLabel(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

/**
 * Returns null when the verdict is current enough to trust as-is: never run, still
 * running, produced recently AND over the same row count the source has today.
 */
export function validationStaleness(input: {
  completedAt?: string | null;
  startedAt?: string | null;
  status?: string | null;
  validatedRows?: number | null;
  currentSourceRows?: number | null;
  now?: number;
}): ValidationStaleness | null {
  const at = input.completedAt ?? input.startedAt ?? null;
  if (!at) return null;
  // A run in flight reports its own progress; nothing to call stale yet.
  if (input.status && input.status !== "completed" && input.status !== "failed") return null;
  const atMs = Date.parse(at);
  if (!Number.isFinite(atMs)) return null;

  const now = input.now ?? Date.now();
  const ageMs = Math.max(0, now - atMs);
  const validatedRows = input.validatedRows ?? null;
  const currentRows = input.currentSourceRows ?? null;
  const sourceGrew = validatedRows != null && currentRows != null && currentRows > validatedRows;

  if (!sourceGrew && ageMs < VALIDATION_STALE_AFTER_MS) return null;
  return { at, ageMs, ageLabel: ageLabel(ageMs), validatedRows, currentRows, sourceGrew };
}
