// Weekly reports — Postgres persistence (R1).
//
// Mirrors projectForecasts.ts: the row carries lineage (`bindings`,
// `manual_inputs` — the only things the operator edits) plus the frozen
// deterministic state (`snapshot`) plus the prose (`blocks`). The list select
// is deliberately narrow — scalar columns only — so listing never parses a
// ~150 KB jsonb per row.
//
// Publishing goes through the publish_report() RPC rather than a read + insert
// from here: two open tabs would otherwise race into a duplicate version_no or
// a version whose snapshot is half-updated.
import { supabase } from "@/services/supabaseClient";
import type {
  Report,
  ReportAiStatus,
  ReportBindings,
  ReportBlock,
  ReportEngineVersions,
  ReportListItem,
  ReportSnapshot,
  ReportStatus,
  ReportValidationStatus,
  ReportValue,
} from "@/services/reportContract";
import { REPORT_ENGINE_VERSION, REPORT_SCHEMA_VERSION } from "@/services/reportContract";
import { sanitizeBlocks } from "@/services/reportBlocks";

function ensureSupabase() {
  if (!supabase) throw new Error("Supabase is not configured.");
  return supabase;
}

const LIST_COLUMNS =
  "id,title,status,period_from,period_to,spend,gross_revenue,net_revenue,trials,blended_cpa," +
  "funnel_count,data_incomplete,provisional_reasons,ai_status,validation_status," +
  "published_version_no,published_at,updated_at";

interface ReportRow {
  id: string;
  title: string;
  status: ReportStatus;
  period_kind: Report["periodKind"];
  period_from: string;
  period_to: string;
  compare_from: string | null;
  compare_to: string | null;
  language: string;
  template_key: string;
  spend: number | null;
  gross_revenue: number | null;
  net_revenue: number | null;
  refund_amount: number | null;
  trials: number | null;
  blended_cpa: number | null;
  funnel_count: number;
  data_incomplete: boolean;
  provisional_reasons: string[];
  ai_status: ReportAiStatus;
  validation_status: ReportValidationStatus;
  schema_version: number;
  engine_version: string;
  engine_versions: ReportEngineVersions;
  published_version_no: number | null;
  published_at: string | null;
  bindings: ReportBindings;
  manual_inputs: Record<string, ReportValue>;
  snapshot: ReportSnapshot | Record<string, never>;
  blocks: ReportBlock[];
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ReportListRow {
  id: string;
  title: string;
  status: ReportStatus;
  period_from: string;
  period_to: string;
  spend: number | null;
  gross_revenue: number | null;
  net_revenue: number | null;
  trials: number | null;
  blended_cpa: number | null;
  funnel_count: number;
  data_incomplete: boolean;
  provisional_reasons: string[];
  ai_status: ReportAiStatus;
  validation_status: ReportValidationStatus;
  published_version_no: number | null;
  published_at: string | null;
  updated_at: string;
}

/** An uncollected report stores `{}` rather than null, so the column can stay
 * NOT NULL. Anything without a schemaVersion is "not collected yet", never a
 * half-read snapshot. */
function rowSnapshot(value: ReportRow["snapshot"]): ReportSnapshot | null {
  if (!value || typeof value !== "object") return null;
  return "schemaVersion" in value ? (value as ReportSnapshot) : null;
}

export function rowToReport(row: ReportRow): Report {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    periodKind: row.period_kind,
    period: { from: row.period_from, to: row.period_to },
    compare: row.compare_from && row.compare_to
      ? { from: row.compare_from, to: row.compare_to }
      : null,
    language: row.language,
    templateKey: row.template_key,
    schemaVersion: row.schema_version,
    engineVersion: row.engine_version,
    engineVersions: row.engine_versions,
    publishedVersionNo: row.published_version_no,
    publishedAt: row.published_at,
    bindings: row.bindings,
    manualInputs: row.manual_inputs ?? {},
    snapshot: rowSnapshot(row.snapshot),
    blocks: sanitizeBlocks(row.blocks),
    dataIncomplete: row.data_incomplete,
    provisionalReasons: row.provisional_reasons ?? [],
    aiStatus: row.ai_status,
    validationStatus: row.validation_status,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function listRowToItem(row: ReportListRow): ReportListItem {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    periodFrom: row.period_from,
    periodTo: row.period_to,
    spend: row.spend,
    grossRevenue: row.gross_revenue,
    netRevenue: row.net_revenue,
    trials: row.trials,
    blendedCpa: row.blended_cpa,
    funnelCount: row.funnel_count,
    dataIncomplete: row.data_incomplete,
    provisionalReasons: row.provisional_reasons ?? [],
    aiStatus: row.ai_status,
    validationStatus: row.validation_status,
    publishedVersionNo: row.published_version_no,
    publishedAt: row.published_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Domain → row. The scalar columns are DERIVED here from the snapshot rather
 * than tracked by hand, so the list can never disagree with the report it
 * summarises. A metric with no value stays null — the list renders an em dash,
 * never a 0 that reads like a real measurement.
 */
function reportToRow(report: Report) {
  const kpi = report.snapshot?.kpi ?? {};
  const num = (key: string): number | null => kpi[key]?.current.value ?? null;
  return {
    title: report.title,
    status: report.status,
    period_kind: report.periodKind,
    period_from: report.period.from,
    period_to: report.period.to,
    compare_from: report.compare?.from ?? null,
    compare_to: report.compare?.to ?? null,
    language: report.language,
    template_key: report.templateKey,
    spend: num("spend"),
    gross_revenue: num("gross_revenue"),
    net_revenue: num("net_revenue"),
    refund_amount: num("refund_amount"),
    trials: num("trials"),
    blended_cpa: num("blended_cpa"),
    funnel_count: report.snapshot?.funnels.length ?? 0,
    data_incomplete: report.snapshot?.dataIncomplete ?? false,
    provisional_reasons: report.snapshot?.provisionalReasons ?? [],
    ai_status: report.aiStatus,
    validation_status: report.validationStatus,
    schema_version: report.schemaVersion,
    engine_version: report.engineVersion,
    engine_versions: report.engineVersions,
    bindings: report.bindings,
    manual_inputs: report.manualInputs,
    snapshot: report.snapshot ?? {},
    blocks: report.blocks,
    resolved_at: report.resolvedAt,
  };
}

export async function listReports(includeArchived = false): Promise<ReportListItem[]> {
  const client = ensureSupabase();
  let query = client.from("reports").select(LIST_COLUMNS);
  if (!includeArchived) query = query.neq("status", "archived");
  const { data, error } = await query.order("period_from", { ascending: false }).limit(100);
  if (error) throw new Error(`Could not list reports: ${error.message}`);
  // Cast through unknown: PostgREST cannot type a runtime column-list string,
  // so it widens the row to its parse-error union.
  return ((data ?? []) as unknown as ReportListRow[]).map(listRowToItem);
}

export async function loadReport(id: string): Promise<Report> {
  const client = ensureSupabase();
  const { data, error } = await client.from("reports").select("*").eq("id", id).single();
  if (error) throw new Error(`Could not load report: ${error.message}`);
  return rowToReport(data as ReportRow);
}

/**
 * Autosave path for the editor: writes the prose and nothing else.
 *
 * Deliberately not `saveReport`. A full save re-sends the snapshot, which is the
 * ~150 KB half of the row, on every debounce tick — and, worse, it would write
 * back whatever snapshot the open tab happens to hold, so an autosave firing
 * after a re-collect in another tab would quietly restore the old numbers. The
 * prose is the only thing the editor owns.
 */
export async function saveReportBlocks(id: string, blocks: ReportBlock[]): Promise<void> {
  const client = ensureSupabase();
  const { error } = await client.from("reports").update({ blocks }).eq("id", id);
  if (error) throw new Error(`Could not save report blocks: ${error.message}`);
}

/** Insert or update. Returns the row id. */
export async function saveReport(report: Report): Promise<string> {
  const client = ensureSupabase();
  const row = reportToRow(report);
  if (report.id) {
    const { error } = await client.from("reports").update(row).eq("id", report.id);
    if (error) throw new Error(`Could not update report: ${error.message}`);
    return report.id;
  }
  const { data, error } = await client.from("reports").insert(row).select("id").single();
  if (error) throw new Error(`Could not save report: ${error.message}`);
  return (data as { id: string }).id;
}

/**
 * Retirement is a status change, not a DELETE.
 *
 * report_versions is append-only and deliberately carries no foreign key (a
 * cascade into it would hit the guard trigger and abort the transaction), so a
 * hard delete would strand a report's published history with no way to reach
 * it. The funnels registry made the same call for the same kind of reason.
 */
export async function archiveReport(id: string): Promise<void> {
  const client = ensureSupabase();
  const { error } = await client.from("reports").update({ status: "archived" }).eq("id", id);
  if (error) throw new Error(`Could not archive report: ${error.message}`);
}

export async function duplicateReport(id: string, title?: string): Promise<string> {
  const source = await loadReport(id);
  return saveReport({
    ...source,
    id: "",
    title: title ?? `${source.title} (копия)`,
    status: "draft",
    aiStatus: "none",
    validationStatus: "not_run",
    publishedVersionNo: null,
    publishedAt: null,
  });
}

/** Publish atomically. Returns the new version number. */
export async function publishReport(id: string): Promise<number> {
  const client = ensureSupabase();
  const { data, error } = await client.rpc("publish_report", { p_report_id: id });
  if (error) throw new Error(`Could not publish report: ${error.message}`);
  return Number(data);
}

/**
 * Verified live: a published version cannot be changed from the app.
 *
 * Note the failure mode, because it is quiet. report_versions has no UPDATE and
 * no DELETE policy, so PostgREST does not reject those calls — RLS just matches
 * zero rows and the call returns `error: null`. Nothing is modified, but a
 * caller that reads "no error" as "it worked" would be wrong in the other
 * direction. The append-only trigger is the second line of defence and covers
 * service_role, which RLS does not.
 */
export interface ReportVersionListItem {
  id: string;
  versionNo: number;
  title: string;
  publishedAt: string;
  schemaVersion: number;
}

export async function listReportVersions(reportId: string): Promise<ReportVersionListItem[]> {
  const client = ensureSupabase();
  const { data, error } = await client
    .from("report_versions")
    .select("id,version_no,title,published_at,schema_version")
    .eq("report_id", reportId)
    .order("version_no", { ascending: false });
  if (error) throw new Error(`Could not list report versions: ${error.message}`);
  return ((data ?? []) as Array<{
    id: string; version_no: number; title: string; published_at: string; schema_version: number;
  }>).map((row) => ({
    id: row.id,
    versionNo: row.version_no,
    title: row.title,
    publishedAt: row.published_at,
    schemaVersion: row.schema_version,
  }));
}

export interface ReportVersion {
  id: string;
  reportId: string;
  versionNo: number;
  title: string;
  period: { from: string; to: string };
  schemaVersion: number;
  engineVersion: string;
  engineVersions: ReportEngineVersions;
  bindings: ReportBindings;
  manualInputs: Record<string, ReportValue>;
  snapshot: ReportSnapshot;
  blocks: ReportBlock[];
  publishedAt: string;
}

export async function loadReportVersion(versionId: string): Promise<ReportVersion> {
  const client = ensureSupabase();
  const { data, error } = await client
    .from("report_versions").select("*").eq("id", versionId).single();
  if (error) throw new Error(`Could not load report version: ${error.message}`);
  const row = data as {
    id: string; report_id: string; version_no: number; title: string;
    period_from: string; period_to: string; schema_version: number; engine_version: string;
    engine_versions: ReportEngineVersions; bindings: ReportBindings;
    manual_inputs: Record<string, ReportValue>; snapshot: ReportSnapshot;
    blocks: ReportBlock[]; published_at: string;
  };
  return {
    id: row.id,
    reportId: row.report_id,
    versionNo: row.version_no,
    title: row.title,
    period: { from: row.period_from, to: row.period_to },
    schemaVersion: row.schema_version,
    engineVersion: row.engine_version,
    engineVersions: row.engine_versions,
    bindings: row.bindings,
    manualInputs: row.manual_inputs ?? {},
    snapshot: row.snapshot,
    blocks: sanitizeBlocks(row.blocks),
    publishedAt: row.published_at,
  };
}

/**
 * Open a published version.
 *
 * A schema bump must never brick the archive: when the stored snapshot predates
 * the current contract we return it as `archived` with the reason, exactly as
 * replayProjectForecast does, rather than throwing or — worse — re-rendering
 * last month's numbers under this month's semantics.
 */
export type ReportVersionOpen =
  | { kind: "ok"; version: ReportVersion }
  | { kind: "archived"; version: ReportVersion; reason: string };

export function openReportVersion(version: ReportVersion): ReportVersionOpen {
  if (version.schemaVersion !== REPORT_SCHEMA_VERSION) {
    return {
      kind: "archived",
      version,
      reason: `Отчёт сохранён схемой v${version.schemaVersion}, текущая v${REPORT_SCHEMA_VERSION}. ` +
        `Показываем как есть, без пересчёта.`,
    };
  }
  return { kind: "ok", version };
}

/** A fresh, uncollected report. The snapshot arrives in R2. */
export function newReport(input: {
  title: string;
  bindings: ReportBindings;
  engineVersions: ReportEngineVersions;
}): Report {
  return {
    id: "",
    title: input.title,
    status: "draft",
    periodKind: input.bindings.periodKind,
    period: input.bindings.period,
    compare: input.bindings.compare,
    language: input.bindings.language,
    templateKey: input.bindings.templateKey,
    schemaVersion: REPORT_SCHEMA_VERSION,
    engineVersion: REPORT_ENGINE_VERSION,
    engineVersions: input.engineVersions,
    publishedVersionNo: null,
    publishedAt: null,
    bindings: input.bindings,
    manualInputs: {},
    snapshot: null,
    blocks: [],
    dataIncomplete: false,
    provisionalReasons: [],
    aiStatus: "none",
    validationStatus: "not_run",
    resolvedAt: null,
    createdAt: "",
    updatedAt: "",
  };
}
