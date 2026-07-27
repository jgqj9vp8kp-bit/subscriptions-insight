// Saved forecast scenarios — thin persistence layer over public.forecast_scenarios.
//
// Rows carry the frozen, schema-versioned FrozenForecastInputs snapshot; loading a
// scenario re-runs the engine from that snapshot (deterministic), never from live
// state. RLS scopes rows to the signed-in user (sharing = open business question Q5).
import { supabase } from "@/services/supabaseClient";
import type { FrozenForecastInputs, ScenarioBindings } from "@/services/funnelEconomics";

function ensureSupabase() {
  if (!supabase) throw new Error("Supabase is not configured.");
  return supabase;
}

export interface ForecastScenarioListItem {
  id: string;
  name: string;
  funnel_id: string;
  scenario_type: string;
  horizon_periods: number;
  updated_at: string;
}

export interface ForecastScenarioRecord extends ForecastScenarioListItem {
  notes: string | null;
  bindings: ScenarioBindings;
  frozen: FrozenForecastInputs;
  source_scenario_id: string | null;
  created_at: string;
}

export interface SaveForecastScenarioInput {
  id?: string;
  name: string;
  funnelId: string;
  scenarioType?: string;
  horizonPeriods: number;
  frozen: FrozenForecastInputs;
  bindings?: ScenarioBindings;
  notes?: string;
  sourceScenarioId?: string;
}

export async function listForecastScenarios(): Promise<ForecastScenarioListItem[]> {
  const client = ensureSupabase();
  const { data, error } = await client
    .from("forecast_scenarios")
    .select("id, name, funnel_id, scenario_type, horizon_periods, updated_at")
    .order("updated_at", { ascending: false })
    .limit(100);
  if (error) throw new Error(`Could not list forecast scenarios: ${error.message}`);
  return (data ?? []) as ForecastScenarioListItem[];
}

export async function loadForecastScenario(id: string): Promise<ForecastScenarioRecord> {
  const client = ensureSupabase();
  const { data, error } = await client
    .from("forecast_scenarios")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`Could not load forecast scenario: ${error.message}`);
  if (!data) throw new Error("Forecast scenario not found.");
  return data as ForecastScenarioRecord;
}

export async function saveForecastScenario(input: SaveForecastScenarioInput): Promise<ForecastScenarioRecord> {
  const client = ensureSupabase();
  const row = {
    ...(input.id ? { id: input.id } : {}),
    name: input.name,
    funnel_id: input.funnelId,
    scenario_type: input.scenarioType ?? "custom",
    horizon_periods: input.horizonPeriods,
    frozen: input.frozen,
    bindings: input.bindings ?? {},
    notes: input.notes ?? null,
    source_scenario_id: input.sourceScenarioId ?? null,
  };
  const { data, error } = await client
    .from("forecast_scenarios")
    .upsert(row)
    .select("*")
    .single();
  if (error) throw new Error(`Could not save forecast scenario: ${error.message}`);
  return data as ForecastScenarioRecord;
}

export async function deleteForecastScenario(id: string): Promise<void> {
  const client = ensureSupabase();
  const { error } = await client.from("forecast_scenarios").delete().eq("id", id);
  if (error) throw new Error(`Could not delete forecast scenario: ${error.message}`);
}
