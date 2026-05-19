export const MAX_RENEWAL_COLUMNS_STORAGE_KEY = "max_renewal_columns";
export const MAX_RENEWAL_COLUMNS_CHANGED_EVENT = "max_renewal_columns_changed";
export const MAX_RENEWAL_COLUMN_OPTIONS = [3, 6, 9, 12] as const;
export const DEFAULT_MAX_RENEWAL_COLUMNS = 6;
export const MAX_SUPPORTED_RENEWAL_COLUMNS = 12;

export type MaxRenewalColumns = (typeof MAX_RENEWAL_COLUMN_OPTIONS)[number];

export function sanitizeMaxRenewalColumns(value: unknown): MaxRenewalColumns {
  const numeric = typeof value === "string" && value.trim() ? Number(value) : value;
  return MAX_RENEWAL_COLUMN_OPTIONS.includes(numeric as MaxRenewalColumns)
    ? (numeric as MaxRenewalColumns)
    : DEFAULT_MAX_RENEWAL_COLUMNS;
}

export function loadMaxRenewalColumns(): MaxRenewalColumns {
  try {
    return sanitizeMaxRenewalColumns(localStorage.getItem(MAX_RENEWAL_COLUMNS_STORAGE_KEY));
  } catch {
    return DEFAULT_MAX_RENEWAL_COLUMNS;
  }
}

export function saveMaxRenewalColumns(value: unknown): MaxRenewalColumns {
  const next = sanitizeMaxRenewalColumns(value);
  try {
    localStorage.setItem(MAX_RENEWAL_COLUMNS_STORAGE_KEY, String(next));
    window.dispatchEvent(new CustomEvent(MAX_RENEWAL_COLUMNS_CHANGED_EVENT, { detail: next }));
  } catch {
    // Local storage may be unavailable in private contexts; callers still receive the sanitized value.
  }
  return next;
}

export function renewalColumnId(level: number): string {
  return `renewal_${level}_users`;
}

export function renewalLevelFromColumnId(columnId: string): number | null {
  const match = columnId.match(/^renewal_(\d+)_users$/);
  if (!match) return null;
  const level = Number(match[1]);
  return Number.isInteger(level) && level >= 2 && level <= MAX_SUPPORTED_RENEWAL_COLUMNS ? level : null;
}

export function renewalColumnIds(maxRenewalColumns: unknown): string[] {
  const max = sanitizeMaxRenewalColumns(maxRenewalColumns);
  return Array.from({ length: max - 1 }, (_, index) => renewalColumnId(index + 2));
}
