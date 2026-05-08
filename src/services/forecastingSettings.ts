export const FORECASTING_DEFAULT_RETENTION_KEY = "forecasting_default_retention_curve";

export const BUILTIN_DEFAULT_RETENTION_CURVE = [35, 22, 16, 12, 9, 7, 5.5, 4.5, 3.5, 3, 2.5, 2];

export function normalizeRetentionCurve(values: unknown): number[] | null {
  if (!Array.isArray(values) || values.length !== 12) return null;
  const normalized = values.map((value) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return null;
    return Math.min(100, Math.max(0, parsed));
  });
  if (normalized.some((value) => value == null)) return null;
  return normalized as number[];
}

export function loadDefaultRetentionCurve(): number[] {
  try {
    const raw = localStorage.getItem(FORECASTING_DEFAULT_RETENTION_KEY);
    if (!raw) return BUILTIN_DEFAULT_RETENTION_CURVE;
    return normalizeRetentionCurve(JSON.parse(raw)) ?? BUILTIN_DEFAULT_RETENTION_CURVE;
  } catch (error) {
    console.warn("Could not load forecasting default retention curve", error);
    return BUILTIN_DEFAULT_RETENTION_CURVE;
  }
}

export function saveDefaultRetentionCurve(values: number[]): number[] {
  const normalized = normalizeRetentionCurve(values) ?? BUILTIN_DEFAULT_RETENTION_CURVE;
  localStorage.setItem(FORECASTING_DEFAULT_RETENTION_KEY, JSON.stringify(normalized));
  return normalized;
}

export function resetDefaultRetentionCurve(): number[] {
  localStorage.removeItem(FORECASTING_DEFAULT_RETENTION_KEY);
  return BUILTIN_DEFAULT_RETENTION_CURVE;
}
