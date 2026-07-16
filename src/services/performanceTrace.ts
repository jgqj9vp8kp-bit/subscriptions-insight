type TraceType = "mark" | "measure" | "event";

export interface AnalyticsPerfTraceEntry {
  type: TraceType;
  name: string;
  at: number;
  durationMs?: number;
  detail?: Record<string, unknown>;
}

declare global {
  interface Window {
    __SUBENGINE_PERF_TRACE__?: AnalyticsPerfTraceEntry[];
    __SUBENGINE_IN_FLIGHT_PERF__?: Record<string, number>;
  }
}

const PREFIX = "subengine";
const MAX_DETAIL_STRING = 160;
const SENSITIVE_KEY_RE = /(token|secret|password|authorization|email|sql|raw|payload|cursor|transaction_id|user_id)$/i;

function fnv(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function enabled(): boolean {
  const runningVitest = typeof process !== "undefined" && process.env.VITEST;
  return Boolean(import.meta.env.DEV && !runningVitest && typeof window !== "undefined" && typeof performance !== "undefined");
}

function traceStore(): AnalyticsPerfTraceEntry[] | null {
  if (!enabled()) return null;
  window.__SUBENGINE_PERF_TRACE__ = window.__SUBENGINE_PERF_TRACE__ ?? [];
  return window.__SUBENGINE_PERF_TRACE__;
}

function sanitizeValue(key: string, value: unknown): unknown {
  if (SENSITIVE_KEY_RE.test(key)) return "[redacted]";
  if (typeof value === "string") return value.length > MAX_DETAIL_STRING ? `${value.slice(0, MAX_DETAIL_STRING)}…` : value;
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return { count: value.length };
  if (value && typeof value === "object") return "[object]";
  return value == null ? value : String(value);
}

function sanitizeDetail(detail?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!detail) return undefined;
  return Object.fromEntries(Object.entries(detail).map(([key, value]) => [key, sanitizeValue(key, value)]));
}

function perfName(name: string): string {
  return `${PREFIX}:${name}`;
}

export function traceMark(name: string, detail?: Record<string, unknown>): void {
  const store = traceStore();
  if (!store) return;
  const safeDetail = sanitizeDetail(detail);
  const mark = perfName(name);
  performance.mark(mark);
  const entry: AnalyticsPerfTraceEntry = { type: "mark", name, at: performance.now(), detail: safeDetail };
  store.push(entry);
  console.debug("[subengine:perf]", entry);
}

export function traceMeasure(name: string, startName: string, endName?: string, detail?: Record<string, unknown>): void {
  const store = traceStore();
  if (!store) return;
  const start = perfName(startName);
  const end = endName ? perfName(endName) : undefined;
  try {
    const measure = performance.measure(perfName(name), start, end);
    const entry: AnalyticsPerfTraceEntry = {
      type: "measure",
      name,
      at: measure.startTime,
      durationMs: measure.duration,
      detail: sanitizeDetail(detail),
    };
    store.push(entry);
    console.debug("[subengine:perf]", entry);
  } catch {
    // Missing marks should not affect application behavior.
  }
}

export function traceEvent(name: string, detail?: Record<string, unknown>): void {
  const store = traceStore();
  if (!store) return;
  const entry: AnalyticsPerfTraceEntry = { type: "event", name, at: performance.now(), detail: sanitizeDetail(detail) };
  store.push(entry);
  console.debug("[subengine:perf]", entry);
}

export async function traceAsync<T>(
  name: string,
  fn: () => Promise<T>,
  detail?: Record<string, unknown>,
): Promise<T> {
  if (!enabled()) return fn();
  const start = `${name}:start:${Math.random().toString(36).slice(2)}`;
  const end = `${name}:end:${Math.random().toString(36).slice(2)}`;
  traceMark(start, detail);
  try {
    const result = await fn();
    traceMark(end, { ...detail, status: "success" });
    traceMeasure(name, start, end, { ...detail, status: "success" });
    return result;
  } catch (error) {
    traceMark(end, {
      ...detail,
      status: "error",
      error_class: error instanceof Error ? error.name : typeof error,
    });
    traceMeasure(name, start, end, { ...detail, status: "error" });
    throw error;
  }
}

export async function traceRequest<T>(
  name: string,
  requestKey: string,
  fn: () => Promise<T>,
  detail?: Record<string, unknown>,
): Promise<T> {
  if (!enabled()) return fn();
  window.__SUBENGINE_IN_FLIGHT_PERF__ = window.__SUBENGINE_IN_FLIGHT_PERF__ ?? {};
  const inFlight = window.__SUBENGINE_IN_FLIGHT_PERF__;
  const duplicate = (inFlight[requestKey] ?? 0) > 0;
  inFlight[requestKey] = (inFlight[requestKey] ?? 0) + 1;
  traceEvent(`${name}:request`, { ...detail, duplicate, request_key: requestKey });
  try {
    return await traceAsync(name, fn, { ...detail, duplicate });
  } finally {
    inFlight[requestKey] = Math.max(0, (inFlight[requestKey] ?? 1) - 1);
  }
}

export function traceHash(value: unknown): string {
  try {
    return fnv(JSON.stringify(value));
  } catch {
    return fnv(String(value));
  }
}
