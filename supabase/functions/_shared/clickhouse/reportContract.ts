// Weekly management report — contracts (Reports page, phase R1).
//
// A report is a FROZEN FACT PACK with prose attached. `ReportSnapshot` is the
// deterministic half: every number the report can show, already computed by the
// engines that own those formulas, each carrying an evidence path. `blocks` is
// the prose half. The report is complete and correct with `blocks` empty and no
// AI configured — that separation is the whole design, not an optimisation.
//
// Pure module: no Deno APIs, no browser APIs, no imports that reach either.
// It is imported verbatim by the edge functions, by the browser through the
// stub in src/services/, and directly by vitest.

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

/** Shape of ReportSnapshot. Bump when a stored snapshot can no longer be read
 * by the current code; `replayReport` then degrades the row to "archived"
 * rather than restating history with today's semantics. */
export const REPORT_SCHEMA_VERSION = 1;

/** Semantics of the derived report facts (deltas, statuses, rankings). */
export const REPORT_ENGINE_VERSION = "report-v1";

/**
 * A report reads from five upstream engines, so one version string cannot
 * explain why a re-collect moved a number. `fxRatesAsOf` is included because
 * fxRates.ts is a static hardcoded map: when it is refreshed, a historical
 * report must keep the rates it was built with, and the diff must be able to
 * say that the FX table — not the business — is what changed.
 */
export interface ReportEngineVersions {
  report: string;
  cohortClassification: string;
  funnelEconomics: string;
  supportClassification: string;
  fxRatesAsOf: string;
}

// ---------------------------------------------------------------------------
// Parameters (lineage — the only thing the operator edits)
// ---------------------------------------------------------------------------

export type ReportPeriodKind = "week" | "month" | "custom";

export interface ReportWindow {
  from: string; // YYYY-MM-DD, inclusive
  to: string;   // YYYY-MM-DD, inclusive
}

export type ReportSectionKey =
  | "kpi"
  | "highlights"
  | "executive_summary"
  | "funnels"
  | "geo_payments"
  | "channels"
  | "monetization"
  | "support"
  | "email"
  | "product"
  | "plan_fact"
  | "next_tasks"
  | "risks_decisions";

export interface ReportBindings {
  periodKind: ReportPeriodKind;
  period: ReportWindow;
  /** null when the operator explicitly turned comparison off. */
  compare: ReportWindow | null;
  /** Empty array means "every funnel with activity in the window". */
  funnels: string[];
  countries: string[];
  mediaBuyers: string[];
  trafficSources: string[];
  currency: string | null;
  sections: ReportSectionKey[];
  /** Threshold set id resolved at collect time; the resolved values live in
   * the snapshot so an old report is never re-scored against today's goals. */
  thresholdSetId: string | null;
  language: string;
  templateKey: string;
  stylePresetId: string | null;
}

// ---------------------------------------------------------------------------
// Values — the honesty primitives
// ---------------------------------------------------------------------------

/**
 * Why a number is not there. The distinction matters to the reader and to the
 * prompt: "no source" is a permanent architectural fact, "not measurable yet"
 * is a maturity problem that fixes itself next week, and "engine returned a
 * placeholder zero" is a trap — several engines hard-zero fields they simply do
 * not measure (subscription counts on the dynamic cohorts path; every fb_*
 * ratio on a cohort row). The report must translate those into "unavailable"
 * rather than print 0.
 */
export type ReportUnavailableReason =
  | "no_source"
  | "not_mature"
  | "insufficient_sample"
  | "engine_placeholder_zero"
  | "data_gap"
  | "mixed_currency"
  | "snapshot_stale";

export interface ReportUnavailable {
  status: "unavailable";
  reason: ReportUnavailableReason;
  /** One short sentence the UI and the prompt can both show verbatim. */
  detail: string;
  /** What it would take to make this measurable. */
  wouldNeed?: string;
}

export type ReportValueSource = "computed" | "manual" | "carried_over";

/**
 * One metric, ready to render and ready to hand to a model.
 *
 * `rendered` exists so the model never formats or computes: it copies the
 * string. `evidence` is a dotted path back into the snapshot, so every claim
 * can be resolved to the exact number that backs it without a separate
 * evidence table.
 */
export interface ReportValue {
  value: number | null;
  rendered: string;
  unit: "money" | "count" | "percent" | "days" | "ratio";
  source: ReportValueSource;
  evidence: string;
  unavailable?: ReportUnavailable;
}

export type ReportDirection = "up" | "down" | "flat";

/** Whether a move is good news. Polarity is per-metric and is decided by code:
 * CPA falling is good, trials falling is bad, refunds falling is good. */
export interface ReportDelta {
  previous: number | null;
  previousRendered: string;
  absolute: number | null;
  absoluteRendered: string;
  percent: number | null;
  percentRendered: string;
  direction: ReportDirection;
  better: boolean | null;
  /** False when the sample is too small for the move to mean anything. */
  significant: boolean;
}

export interface ReportTargetCheck {
  target: number;
  comparator: "gte" | "lte";
  met: boolean | null;
  rendered: string;
}

export interface ReportMetric {
  key: string;
  label: string;
  current: ReportValue;
  delta: ReportDelta | null;
  target: ReportTargetCheck | null;
  /** Denominator behind the metric; drives the honesty phrasing. */
  sampleSize: number | null;
}

// ---------------------------------------------------------------------------
// Gaps and provenance
// ---------------------------------------------------------------------------

/** A source that does not exist. Named explicitly so the UI can show it, the
 * prompt can state it, and no section silently invents a number instead. */
export interface ReportGap {
  key: string;
  label: string;
  reason: string;
  affectsSections: ReportSectionKey[];
  /** True when the operator can fill it in by hand for now. */
  manualEntryAvailable: boolean;
}

/** One upstream call that fed the snapshot, so "where did this come from" is
 * answerable without re-running anything. */
export interface ReportProvenanceEntry {
  key: string;
  engine: string;
  action: string;
  rowsRead: number | null;
  durationMs: number | null;
  warehouseVersion: string | null;
  collectedAt: string;
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

export interface ReportFunnelPassport {
  funnelPath: string;
  displayName: string;
  trialPrice: number | null;
  trialCurrency: string | null;
  trialDurationDays: number | null;
  subscriptionPrice: number | null;
  subscriptionCurrency: string | null;
  billingPeriod: string | null;
  upsells: Array<{ name: string; price: number | null; currency: string | null; ordinal: number }>;
  defaultLanguage: string | null;
  defaultCurrency: string | null;
  geoLocalization: string[];
  destination: string | null;
  product: string | null;
  trafficSources: string[];
  /** True when nobody has filled the passport in yet — the block renders a
   * "паспорт не заполнен" hint instead of an empty header. */
  incomplete: boolean;
}

export type ReportFunnelStatus =
  | "scale"
  | "continue_testing"
  | "needs_optimization"
  | "reduce_budget"
  | "pause"
  | "insufficient_data";

export interface ReportFunnelStatusVerdict {
  status: ReportFunnelStatus;
  /** The rule that fired, in the operator's language. Always shown next to the
   * badge — a status nobody can explain is a status nobody trusts. */
  because: string;
  ruleId: string;
}

export interface ReportFunnelRow {
  funnelPath: string;
  passport: ReportFunnelPassport;
  metrics: Record<string, ReportMetric>;
  status: ReportFunnelStatusVerdict;
  isNew: boolean;
}

export interface ReportSnapshot {
  schemaVersion: number;
  engineVersion: string;
  engineVersions: ReportEngineVersions;
  period: ReportWindow;
  compare: ReportWindow | null;
  collectedAt: string;
  /** Read before and after collection. When they differ the draft is flagged:
   * the collection is N sequential calls, so a consistent read across the whole
   * window is DETECTED, never guaranteed. */
  warehouseVersionBefore: string | null;
  warehouseVersionAfter: string | null;
  consistent: boolean;

  kpi: Record<string, ReportMetric>;
  funnels: ReportFunnelRow[];
  gaps: ReportGap[];
  provenance: ReportProvenanceEntry[];
  /** Resolved thresholds and targets, frozen so an old report keeps its goals. */
  thresholds: Record<string, number>;
  dataIncomplete: boolean;
  provisionalReasons: string[];
}

// ---------------------------------------------------------------------------
// Blocks (the editor's content)
// ---------------------------------------------------------------------------

export type ReportBlockType =
  | "heading"
  | "text"
  | "ai_summary"
  | "metrics_table"
  | "funnel_table"
  | "comparison_table"
  | "chart"
  | "list"
  | "plan_fact"
  | "risks"
  | "decisions"
  | "tasks"
  | "appendix";

export interface ReportBlock {
  id: string;
  type: ReportBlockType;
  section: ReportSectionKey;
  title: string;
  /** Constrained markdown subset for prose blocks; a data key for table and
   * chart blocks. Never raw HTML — there is no sanitizer in this codebase and
   * this text can carry model output. */
  content: string;
  hidden: boolean;
  /** Pinned blocks are never touched by a regeneration. */
  pinned: boolean;
  generatedBy: "deterministic" | "ai" | "human";
  /** Set when a human edited an AI block, so provenance stays honest. */
  editedByHuman: boolean;
  evidence: string[];
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// The row as the browser sees it
// ---------------------------------------------------------------------------

export type ReportStatus = "draft" | "collected" | "ready" | "published" | "archived";
export type ReportAiStatus = "none" | "generated" | "edited" | "failed";
export type ReportValidationStatus = "not_run" | "passed" | "warned" | "failed";

/** The narrow projection the list view reads. Mirrors the scalar columns so
 * listing never parses a 150 KB jsonb per row. */
export interface ReportListItem {
  id: string;
  title: string;
  status: ReportStatus;
  periodFrom: string;
  periodTo: string;
  spend: number | null;
  grossRevenue: number | null;
  netRevenue: number | null;
  trials: number | null;
  blendedCpa: number | null;
  funnelCount: number;
  dataIncomplete: boolean;
  provisionalReasons: string[];
  aiStatus: ReportAiStatus;
  validationStatus: ReportValidationStatus;
  publishedVersionNo: number | null;
  publishedAt: string | null;
  updatedAt: string;
}

export interface Report {
  id: string;
  title: string;
  status: ReportStatus;
  periodKind: ReportPeriodKind;
  period: ReportWindow;
  compare: ReportWindow | null;
  language: string;
  templateKey: string;
  schemaVersion: number;
  engineVersion: string;
  engineVersions: ReportEngineVersions;
  publishedVersionNo: number | null;
  publishedAt: string | null;
  bindings: ReportBindings;
  manualInputs: Record<string, ReportValue>;
  snapshot: ReportSnapshot | null;
  blocks: ReportBlock[];
  dataIncomplete: boolean;
  provisionalReasons: string[];
  aiStatus: ReportAiStatus;
  validationStatus: ReportValidationStatus;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Tasks, notes, targets
// ---------------------------------------------------------------------------

export type ReportTaskStatus =
  | "planned" | "in_progress" | "done" | "paused" | "blocked" | "moved" | "cancelled";
export type ReportTaskPriority = "high" | "medium" | "low";

/** Statuses that keep a task in play — these carry into next week's report. */
export const OPEN_TASK_STATUSES: readonly ReportTaskStatus[] = [
  "planned", "in_progress", "paused", "blocked", "moved",
];

export function isOpenTaskStatus(status: ReportTaskStatus): boolean {
  return OPEN_TASK_STATUSES.includes(status);
}

export interface ReportTask {
  id: string;
  title: string;
  direction: string | null;
  status: ReportTaskStatus;
  priority: ReportTaskPriority;
  owner: string | null;
  plannedDate: string | null;
  actualDate: string | null;
  comment: string | null;
  link: string | null;
  movedReason: string | null;
  result: string | null;
  firstReportId: string | null;
  closedReportId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ReportNoteImportance = "high" | "normal" | "low";

export interface ReportNote {
  id: string;
  noteDate: string;
  direction: string | null;
  funnelPath: string | null;
  channel: string | null;
  body: string;
  importance: ReportNoteImportance;
  useInAi: boolean;
  reportId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ReportTargetScope = "global" | "funnel" | "geo" | "channel";

export interface ReportTarget {
  id: string;
  metricKey: string;
  scopeKind: ReportTargetScope;
  scopeValue: string | null;
  targetValue: number;
  comparator: "gte" | "lte";
  effectiveFrom: string;
  effectiveTo: string | null;
  note: string | null;
  createdAt: string;
}

/**
 * Resolve the target that applies to a metric on a date, most specific first:
 * funnel → geo → channel → global. Ties inside a scope go to the newest
 * effective_from, so opening a July report evaluates July's ceilings.
 */
export function resolveTarget(
  targets: readonly ReportTarget[],
  metricKey: string,
  onDate: string,
  scope: { funnel?: string | null; geo?: string | null; channel?: string | null } = {},
): ReportTarget | null {
  const active = targets.filter((t) =>
    t.metricKey === metricKey &&
    t.effectiveFrom <= onDate &&
    (t.effectiveTo === null || t.effectiveTo >= onDate));

  const order: Array<[ReportTargetScope, string | null | undefined]> = [
    ["funnel", scope.funnel],
    ["geo", scope.geo],
    ["channel", scope.channel],
    ["global", null],
  ];

  for (const [kind, value] of order) {
    const matches = active.filter((t) =>
      t.scopeKind === kind && (kind === "global" || t.scopeValue === value));
    if (!matches.length) continue;
    return matches.reduce((newest, t) => (t.effectiveFrom > newest.effectiveFrom ? t : newest));
  }
  return null;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** The sections the built-in weekly template ships with. MVP scope: the
 * deterministic core plus the two prose blocks the reports always open and
 * close with. */
export const DEFAULT_REPORT_SECTIONS: readonly ReportSectionKey[] = [
  "kpi", "highlights", "executive_summary", "funnels", "plan_fact", "next_tasks",
];

export const WEEKLY_TEMPLATE_KEY = "weekly_management_v1";

export function emptyReportBindings(period: ReportWindow, compare: ReportWindow | null): ReportBindings {
  return {
    periodKind: "week",
    period,
    compare,
    funnels: [],
    countries: [],
    mediaBuyers: [],
    trafficSources: [],
    currency: null,
    sections: [...DEFAULT_REPORT_SECTIONS],
    thresholdSetId: null,
    language: "ru",
    templateKey: WEEKLY_TEMPLATE_KEY,
    stylePresetId: null,
  };
}
