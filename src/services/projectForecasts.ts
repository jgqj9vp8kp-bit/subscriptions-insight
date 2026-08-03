// Saved project forecasts — Postgres persistence (P7).
//
// Mirrors forecastScenarios.ts: rows carry lineage (bindings) + the replayable
// state (frozen snapshots + ledgers). Loading REPLAYS via the pure
// replayProjectForecast — deterministic, zero network — never re-derives from
// live data. The list select is deliberately narrow: scalar columns only, so
// listing never parses half a megabyte of jsonb per row.
import { supabase } from "@/services/supabaseClient";
import type {
  FunnelSpendLedger,
  ProjectAggregationPolicy,
  ProjectForecast,
  ProjectFunnelEntry,
  ProjectSeedEvidence,
  SharedCostPool,
  WindowSpendLedger,
} from "@/services/funnelEconomics";
import type { FrozenForecastInputs } from "@/services/funnelEconomics";

function ensureSupabase() {
  if (!supabase) throw new Error("Supabase is not configured.");
  return supabase;
}

export interface ProjectForecastListItem {
  id: string;
  name: string;
  spend_basis: string;
  source_window_from: string;
  source_window_to: string;
  funnel_count: number;
  total_planned_budget: number;
  project_scoped_spend: number;
  spend_coverage: number;
  spend_incomplete: boolean;
  provisional_reasons: string[];
  resolved_at: string;
  updated_at: string;
}

const LIST_COLUMNS = "id,name,spend_basis,source_window_from,source_window_to,funnel_count,total_planned_budget,project_scoped_spend,spend_coverage,spend_incomplete,provisional_reasons,resolved_at,updated_at";

interface ProjectForecastRow extends ProjectForecastListItem {
  notes: string | null;
  schema_version: number;
  engine_version: string;
  forecast_model: string;
  source_as_of: string;
  bindings: { entries: ProjectFunnelEntry[]; sharedCosts: SharedCostPool; policy: ProjectAggregationPolicy };
  frozen: Record<string, FrozenForecastInputs>;
  window_ledger: WindowSpendLedger;
  funnel_ledgers: Record<string, FunnelSpendLedger>;
  seed_evidence: Record<string, ProjectSeedEvidence>;
  created_at: string;
}

export function rowToProjectForecast(row: ProjectForecastRow): ProjectForecast {
  return {
    schemaVersion: row.schema_version,
    engineVersion: row.engine_version,
    forecastModel: row.forecast_model as ProjectForecast["forecastModel"],
    id: row.id,
    name: row.name,
    notes: row.notes ?? undefined,
    source: {
      window: { from: row.source_window_from, to: row.source_window_to },
      asOf: row.source_as_of,
      dataSource: "clickhouse",
    },
    entries: row.bindings.entries,
    windowLedger: row.window_ledger,
    funnelLedgers: row.funnel_ledgers,
    sharedCosts: row.bindings.sharedCosts,
    policy: row.bindings.policy,
    frozen: row.frozen,
    seedEvidence: row.seed_evidence,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function projectToRow(project: ProjectForecast) {
  const provisionalReasons: string[] = [];
  if (project.policy.spendBasis === "attributed_only") provisionalReasons.push("attributed_only");
  if (project.windowLedger.spendIncomplete) provisionalReasons.push("spend_incomplete");
  const totalBudget = project.entries
    .filter((entry) => entry.enabled)
    .reduce((sum, entry) => sum + entry.plannedBudget, 0);
  const inProject = project.entries
    .filter((entry) => entry.enabled)
    .reduce((sum, entry) => sum + (project.funnelLedgers[entry.funnelId]?.funnelResolvedSpend ?? 0), 0);
  const resolvedTotal = project.windowLedger.funnelResolved.spend;
  return {
    name: project.name,
    notes: project.notes ?? null,
    schema_version: project.schemaVersion,
    engine_version: project.engineVersion,
    forecast_model: project.forecastModel,
    spend_basis: project.policy.spendBasis,
    source_window_from: project.source.window.from,
    source_window_to: project.source.window.to,
    source_as_of: project.source.asOf,
    funnel_count: project.entries.filter((entry) => entry.enabled).length,
    total_planned_budget: totalBudget,
    window_source_spend: project.windowLedger.windowSourceSpend,
    project_scoped_spend: inProject,
    out_of_project_spend: resolvedTotal - inProject,
    spend_coverage: project.windowLedger.windowSourceSpend > 0 ? inProject / project.windowLedger.windowSourceSpend : 0,
    spend_incomplete: project.windowLedger.spendIncomplete,
    provisional_reasons: provisionalReasons,
    bindings: { entries: project.entries, sharedCosts: project.sharedCosts, policy: project.policy },
    frozen: project.frozen,
    window_ledger: project.windowLedger,
    funnel_ledgers: project.funnelLedgers,
    seed_evidence: project.seedEvidence,
    resolved_at: project.resolvedAt,
  };
}

export async function listProjectForecasts(): Promise<ProjectForecastListItem[]> {
  const client = ensureSupabase();
  const { data, error } = await client
    .from("project_forecasts")
    .select(LIST_COLUMNS)
    .order("updated_at", { ascending: false })
    .limit(100);
  if (error) throw new Error(`Could not list project forecasts: ${error.message}`);
  return (data ?? []) as ProjectForecastListItem[];
}

export async function loadProjectForecast(id: string): Promise<ProjectForecast> {
  const client = ensureSupabase();
  const { data, error } = await client
    .from("project_forecasts")
    .select("*")
    .eq("id", id)
    .single();
  if (error) throw new Error(`Could not load project forecast: ${error.message}`);
  return rowToProjectForecast(data as ProjectForecastRow);
}

/** Insert or update. Returns the row id. */
export async function saveProjectForecast(project: ProjectForecast): Promise<string> {
  const client = ensureSupabase();
  const row = projectToRow(project);
  if (project.id) {
    const { error } = await client.from("project_forecasts").update(row).eq("id", project.id);
    if (error) throw new Error(`Could not update project forecast: ${error.message}`);
    return project.id;
  }
  const { data, error } = await client.from("project_forecasts").insert(row).select("id").single();
  if (error) throw new Error(`Could not save project forecast: ${error.message}`);
  return (data as { id: string }).id;
}

export async function deleteProjectForecast(id: string): Promise<void> {
  const client = ensureSupabase();
  const { error } = await client.from("project_forecasts").delete().eq("id", id);
  if (error) throw new Error(`Could not delete project forecast: ${error.message}`);
}

export async function duplicateProjectForecast(id: string, now: string): Promise<string> {
  const source = await loadProjectForecast(id);
  return saveProjectForecast({ ...source, id: "", name: `${source.name} (copy)`, resolvedAt: source.resolvedAt, createdAt: now, updatedAt: now });
}
