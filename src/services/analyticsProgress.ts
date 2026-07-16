// Honest staged progress model for one-shot ClickHouse analytics requests, shared
// by Cohorts, Users, and Payment Pass Analytics.
//
// The Edge Functions do NOT expose real server-side progress, so this is an
// ESTIMATE based on observable milestones (request start, response arrival) and
// the historical median request duration. It is labelled "Loading…/Updating…"
// (never "rows processed"), is monotonic, and is capped below 100 until the rows
// are actually ready — 100% is only ever emitted on a real success.

const OPENING_MS = 250; // prepare → auth → send milestones fill 5→15 over this window
const WAIT_START = 15; // % when the request is in flight
const WAIT_CAP = 88; // hard ceiling while waiting — never reached, never exceeded

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

// Asymptotic ramp toward WAIT_CAP; strictly increasing in elapsedMs, never >= cap.
// Cold-start (elapsed >> median) keeps creeping toward the cap without hitting it.
export function estimateWaitingProgress(elapsedMs: number, medianMs: number): number {
  const tau = Math.max(500, (medianMs || 0) * 0.6);
  const p = WAIT_START + (WAIT_CAP - WAIT_START) * (1 - Math.exp(-Math.max(0, elapsedMs) / tau));
  return clamp(p, WAIT_START, WAIT_CAP);
}

// Percent for an in-flight request at `elapsedMs`, medianMs from history.
// 0–250ms: 5→15 (prepare/auth/send). After: asymptotic wait ramp toward 88.
export function computeActivePercent(elapsedMs: number, medianMs: number): number {
  if (elapsedMs < OPENING_MS) return clamp(5 + (10 * elapsedMs) / OPENING_MS, 5, WAIT_START);
  return estimateWaitingProgress(elapsedMs - OPENING_MS, medianMs);
}

// ---- pure progress reducer (unit-tested) ----------------------------------
export type ProgressPhase = "idle" | "loading" | "done";
export interface ProgressState {
  percent: number;
  phase: ProgressPhase;
  startedAt: number | null;
  key: string | null;
}
export type ProgressEvent =
  | { type: "start"; key: string; now: number }
  | { type: "tick"; now: number; medianMs: number }
  | { type: "success"; key: string }
  | { type: "settle" } // error / non-success finish: leave without completing
  | { type: "reset" };

export const INITIAL_PROGRESS: ProgressState = { percent: 0, phase: "idle", startedAt: null, key: null };

export function progressReducer(state: ProgressState, event: ProgressEvent): ProgressState {
  switch (event.type) {
    case "start":
      return { percent: Math.max(5, 0), phase: "loading", startedAt: event.now, key: event.key };
    case "tick": {
      if (state.phase !== "loading" || state.startedAt == null) return state;
      const next = computeActivePercent(event.now - state.startedAt, event.medianMs);
      return { ...state, percent: Math.min(WAIT_CAP, Math.max(state.percent, next)) };
    }
    case "success":
      if (state.phase !== "loading" || state.key !== event.key) return state;
      return { ...state, percent: 100, phase: "done" };
    case "settle":
      if (state.phase !== "loading") return state;
      return INITIAL_PROGRESS;
    case "reset":
      return INITIAL_PROGRESS;
    default:
      return state;
  }
}

// ---- rolling-median duration tracker (per-page namespace) ------------------
// Persisted locally so cold-start estimates improve across sessions. Bounded to
// the most recent samples; contains only millisecond durations (no PII). Each
// page uses its own namespace so a slow page never skews another page's estimate.
const MAX_SAMPLES = 10;
const DEFAULT_MEDIAN_MS = 3500;

function durationsKey(ns: string): string {
  return `analytics.req.durations.${ns}.v1`;
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

export function readDurations(ns = "default"): number[] {
  const ls = safeLocalStorage();
  if (!ls) return [];
  try {
    const parsed = JSON.parse(ls.getItem(durationsKey(ns)) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((n) => typeof n === "number" && n > 0).slice(-MAX_SAMPLES) : [];
  } catch {
    return [];
  }
}

export function recordDuration(ms: number, ns = "default"): void {
  const ls = safeLocalStorage();
  if (!ls || !(ms > 0)) return;
  const next = [...readDurations(ns), Math.round(ms)].slice(-MAX_SAMPLES);
  try {
    ls.setItem(durationsKey(ns), JSON.stringify(next));
  } catch {
    /* quota — ignore */
  }
}

export function median(values: number[]): number {
  if (!values.length) return DEFAULT_MEDIAN_MS;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

export function medianDuration(ns = "default"): number {
  return median(readDurations(ns));
}

export const PROGRESS_WAIT_CAP = WAIT_CAP;

// Compact "updated N ago" label for the data-source strips.
export function formatUpdatedAgo(updatedAt: number): string {
  if (!updatedAt) return "just now";
  const sec = Math.max(0, Math.round((Date.now() - updatedAt) / 1000));
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec} sec ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min ago`;
  return `${Math.round(min / 60)} hr ago`;
}
