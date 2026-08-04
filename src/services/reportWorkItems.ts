// Plan/Fact tasks, manual notes and targets (R1).
//
// These three live BETWEEN reports, not inside one. An unfinished task carries
// into next week; a note about a dead hook explains a CPA move weeks later; a
// target is never overwritten, it is closed and superseded so a July report can
// still be judged against July's ceilings.
import { supabase } from "@/services/supabaseClient";
import type {
  ReportNote,
  ReportNoteImportance,
  ReportTarget,
  ReportTargetScope,
  ReportTask,
  ReportTaskPriority,
  ReportTaskStatus,
} from "@/services/reportContract";
import { OPEN_TASK_STATUSES } from "@/services/reportContract";

function ensureSupabase() {
  if (!supabase) throw new Error("Supabase is not configured.");
  return supabase;
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

interface TaskRow {
  id: string;
  title: string;
  direction: string | null;
  status: ReportTaskStatus;
  priority: ReportTaskPriority;
  owner: string | null;
  planned_date: string | null;
  actual_date: string | null;
  comment: string | null;
  link: string | null;
  moved_reason: string | null;
  result: string | null;
  first_report_id: string | null;
  closed_report_id: string | null;
  created_at: string;
  updated_at: string;
}

function rowToTask(row: TaskRow): ReportTask {
  return {
    id: row.id,
    title: row.title,
    direction: row.direction,
    status: row.status,
    priority: row.priority,
    owner: row.owner,
    plannedDate: row.planned_date,
    actualDate: row.actual_date,
    comment: row.comment,
    link: row.link,
    movedReason: row.moved_reason,
    result: row.result,
    firstReportId: row.first_report_id,
    closedReportId: row.closed_report_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function taskToRow(task: Partial<ReportTask>) {
  const row: Record<string, unknown> = {};
  if (task.title !== undefined) row.title = task.title;
  if (task.direction !== undefined) row.direction = task.direction;
  if (task.status !== undefined) row.status = task.status;
  if (task.priority !== undefined) row.priority = task.priority;
  if (task.owner !== undefined) row.owner = task.owner;
  if (task.plannedDate !== undefined) row.planned_date = task.plannedDate;
  if (task.actualDate !== undefined) row.actual_date = task.actualDate;
  if (task.comment !== undefined) row.comment = task.comment;
  if (task.link !== undefined) row.link = task.link;
  if (task.movedReason !== undefined) row.moved_reason = task.movedReason;
  if (task.result !== undefined) row.result = task.result;
  if (task.firstReportId !== undefined) row.first_report_id = task.firstReportId;
  if (task.closedReportId !== undefined) row.closed_report_id = task.closedReportId;
  return row;
}

export async function listReportTasks(options: { openOnly?: boolean } = {}): Promise<ReportTask[]> {
  const client = ensureSupabase();
  let query = client.from("report_tasks").select("*");
  if (options.openOnly) query = query.in("status", [...OPEN_TASK_STATUSES]);
  const { data, error } = await query
    .order("priority", { ascending: true })
    .order("planned_date", { ascending: true, nullsFirst: false });
  if (error) throw new Error(`Could not list report tasks: ${error.message}`);
  return ((data ?? []) as TaskRow[]).map(rowToTask);
}

export async function saveReportTask(task: Partial<ReportTask> & { id?: string }): Promise<string> {
  const client = ensureSupabase();
  const row = taskToRow(task);
  if (task.id) {
    const { error } = await client.from("report_tasks").update(row).eq("id", task.id);
    if (error) throw new Error(`Could not update report task: ${error.message}`);
    return task.id;
  }
  const { data, error } = await client.from("report_tasks").insert(row).select("id").single();
  if (error) throw new Error(`Could not save report task: ${error.message}`);
  return (data as { id: string }).id;
}

export async function deleteReportTask(id: string): Promise<void> {
  const client = ensureSupabase();
  const { error } = await client.from("report_tasks").delete().eq("id", id);
  if (error) throw new Error(`Could not delete report task: ${error.message}`);
}

/**
 * Which tasks belong in a report's Plan/Fact block.
 *
 * "Done this week" is decided by `actualDate` falling in the window, not by the
 * status alone — a task closed three weeks ago must not reappear in every
 * later report. Everything still open carries over regardless of when it was
 * planned, which is exactly how the weekly reports behave: a task planned on
 * 6 июля and moved twice still shows up, with its reason.
 */
export function partitionTasksForPeriod(
  tasks: readonly ReportTask[],
  period: { from: string; to: string },
): { closed: ReportTask[]; open: ReportTask[] } {
  const closed: ReportTask[] = [];
  const open: ReportTask[] = [];
  for (const task of tasks) {
    const isOpen = OPEN_TASK_STATUSES.includes(task.status);
    if (isOpen) {
      open.push(task);
      continue;
    }
    const closedIn = task.actualDate && task.actualDate >= period.from && task.actualDate <= period.to;
    if (closedIn) closed.push(task);
  }
  return { closed, open };
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

interface NoteRow {
  id: string;
  note_date: string;
  direction: string | null;
  funnel_path: string | null;
  channel: string | null;
  body: string;
  importance: ReportNoteImportance;
  use_in_ai: boolean;
  report_id: string | null;
  created_at: string;
  updated_at: string;
}

function rowToNote(row: NoteRow): ReportNote {
  return {
    id: row.id,
    noteDate: row.note_date,
    direction: row.direction,
    funnelPath: row.funnel_path,
    channel: row.channel,
    body: row.body,
    importance: row.importance,
    useInAi: row.use_in_ai,
    reportId: row.report_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listReportNotes(period?: { from: string; to: string }): Promise<ReportNote[]> {
  const client = ensureSupabase();
  let query = client.from("report_notes").select("*");
  if (period) query = query.gte("note_date", period.from).lte("note_date", period.to);
  const { data, error } = await query.order("note_date", { ascending: false });
  if (error) throw new Error(`Could not list report notes: ${error.message}`);
  return ((data ?? []) as NoteRow[]).map(rowToNote);
}

export async function saveReportNote(note: Partial<ReportNote> & { id?: string }): Promise<string> {
  const client = ensureSupabase();
  const row: Record<string, unknown> = {};
  if (note.noteDate !== undefined) row.note_date = note.noteDate;
  if (note.direction !== undefined) row.direction = note.direction;
  if (note.funnelPath !== undefined) row.funnel_path = note.funnelPath;
  if (note.channel !== undefined) row.channel = note.channel;
  if (note.body !== undefined) row.body = note.body;
  if (note.importance !== undefined) row.importance = note.importance;
  if (note.useInAi !== undefined) row.use_in_ai = note.useInAi;
  if (note.reportId !== undefined) row.report_id = note.reportId;
  if (note.id) {
    const { error } = await client.from("report_notes").update(row).eq("id", note.id);
    if (error) throw new Error(`Could not update report note: ${error.message}`);
    return note.id;
  }
  const { data, error } = await client.from("report_notes").insert(row).select("id").single();
  if (error) throw new Error(`Could not save report note: ${error.message}`);
  return (data as { id: string }).id;
}

export async function deleteReportNote(id: string): Promise<void> {
  const client = ensureSupabase();
  const { error } = await client.from("report_notes").delete().eq("id", id);
  if (error) throw new Error(`Could not delete report note: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

interface TargetRow {
  id: string;
  metric_key: string;
  scope_kind: ReportTargetScope;
  scope_value: string | null;
  target_value: number;
  comparator: "gte" | "lte";
  effective_from: string;
  effective_to: string | null;
  note: string | null;
  created_at: string;
}

function rowToTarget(row: TargetRow): ReportTarget {
  return {
    id: row.id,
    metricKey: row.metric_key,
    scopeKind: row.scope_kind,
    scopeValue: row.scope_value,
    targetValue: Number(row.target_value),
    comparator: row.comparator,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    note: row.note,
    createdAt: row.created_at,
  };
}

export async function listReportTargets(): Promise<ReportTarget[]> {
  const client = ensureSupabase();
  const { data, error } = await client
    .from("report_targets").select("*").order("effective_from", { ascending: false });
  if (error) throw new Error(`Could not list report targets: ${error.message}`);
  return ((data ?? []) as TargetRow[]).map(rowToTarget);
}

/**
 * Change a target by SUPERSEDING it, never by editing it in place.
 *
 * The old row is closed the day before the new one opens, so every past report
 * can still resolve the goal that applied when it was written. Editing in place
 * would silently re-score history.
 */
export async function supersedeReportTarget(input: {
  metricKey: string;
  scopeKind: ReportTargetScope;
  scopeValue: string | null;
  targetValue: number;
  comparator: "gte" | "lte";
  effectiveFrom: string;
  note?: string | null;
}): Promise<string> {
  const client = ensureSupabase();
  const previousDay = new Date(`${input.effectiveFrom}T00:00:00Z`);
  previousDay.setUTCDate(previousDay.getUTCDate() - 1);
  const closeOn = previousDay.toISOString().slice(0, 10);

  let close = client
    .from("report_targets")
    .update({ effective_to: closeOn })
    .eq("metric_key", input.metricKey)
    .eq("scope_kind", input.scopeKind)
    .is("effective_to", null);
  close = input.scopeValue === null
    ? close.is("scope_value", null)
    : close.eq("scope_value", input.scopeValue);
  const { error: closeError } = await close;
  if (closeError) throw new Error(`Could not close previous target: ${closeError.message}`);

  const { data, error } = await client.from("report_targets").insert({
    metric_key: input.metricKey,
    scope_kind: input.scopeKind,
    scope_value: input.scopeValue,
    target_value: input.targetValue,
    comparator: input.comparator,
    effective_from: input.effectiveFrom,
    note: input.note ?? null,
  }).select("id").single();
  if (error) throw new Error(`Could not save report target: ${error.message}`);
  return (data as { id: string }).id;
}
