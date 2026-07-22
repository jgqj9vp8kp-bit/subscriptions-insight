export {
  DEFAULT_MAX_RENEWAL_COLUMNS,
  MAX_RENEWAL_COLUMN_OPTIONS,
  MAX_SUPPORTED_RENEWAL_COLUMNS,
  renewalColumnId,
  renewalColumnIds,
  renewalLevelFromColumnId,
  sanitizeMaxRenewalColumns,
  type MaxRenewalColumns,
} from "../../supabase/functions/_shared/clickhouse/renewalColumns.ts";
import {
  DEFAULT_MAX_RENEWAL_COLUMNS,
  sanitizeMaxRenewalColumns,
  type MaxRenewalColumns,
} from "../../supabase/functions/_shared/clickhouse/renewalColumns.ts";

export const MAX_RENEWAL_COLUMNS_STORAGE_KEY = "max_renewal_columns";
export const MAX_RENEWAL_COLUMNS_CHANGED_EVENT = "max_renewal_columns_changed";

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
