// Funnels admin registry (Funnels page). Config metadata, not analytics —
// see supabase/migrations/202607240001_create_funnels_admin.sql for the
// schema and the deployment-shared RLS rationale (no auth.uid() scoping;
// every authenticated user of this project reads/writes the same rows).
import { supabase } from "@/services/supabaseClient";

export interface TagRecord {
  id: string;
  name: string;
  created_by: string | null;
  created_at: string;
}

/** One upsell as the weekly report prints it: "Апсейл 1 Zodiac Report 14.98$". */
export interface FunnelUpsell {
  name: string;
  price: number | null;
  currency: string | null;
  ordinal: number;
}

/**
 * The funnel passport — the header every weekly report opens a funnel block
 * with. None of it is derivable: cohorts' price_plan is a rounded USD string
 * with NO interval, so it cannot tell a monthly $29.99 from a weekly one, and
 * trial length, upsell names and localisation exist nowhere in the warehouse.
 * Filled once per funnel here, then substituted into every report.
 */
export interface FunnelPassportFields {
  trial_price: number | null;
  trial_currency: string | null;
  trial_duration_days: number | null;
  subscription_price: number | null;
  subscription_currency: string | null;
  billing_period: string | null;
  upsells: FunnelUpsell[];
  default_language: string | null;
  default_currency: string | null;
  geo_localization: string[];
  destination: string | null;
  product: string | null;
  traffic_sources: string[];
  passport_notes: string | null;
}

export const BILLING_PERIODS = ["weekly", "biweekly", "monthly", "quarterly", "annual", "custom"] as const;
export const FUNNEL_DESTINATIONS = ["web_app", "ios", "android", "content"] as const;

export interface FunnelRecord extends FunnelPassportFields {
  id: string;
  funnel_path: string;
  display_name: string;
  is_active: boolean;
  funnelfox_funnel_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  tags: TagRecord[];
}

/**
 * Whether the passport carries enough to print a funnel block header.
 *
 * Trial price, trial length and the subscription price with its period are the
 * four the report cannot fake — the rest degrade quietly. `trial_duration_days`
 * is load-bearing beyond display: without it no cohort can be proved mature,
 * so the funnel's conversion rate stays unmeasurable.
 */
export function isPassportComplete(funnel: FunnelPassportFields): boolean {
  return funnel.trial_price !== null &&
    funnel.trial_duration_days !== null &&
    funnel.subscription_price !== null &&
    funnel.billing_period !== null;
}

/** One funnel as FunnelFox reports it (see supabase/functions/funnelfox-funnels). */
export interface FunnelFoxFunnel {
  id: string;
  title: string;
  alias: string;
  type: string;
  status: string;
  is_draft: boolean;
  environment: string;
  last_published_at: string;
  tags: string[];
}

export interface FunnelFoxImportCandidate extends FunnelFoxFunnel {
  /** Already in the registry — shown for context but not importable again. */
  alreadyRegistered: boolean;
}

const PASSPORT_COLUMNS =
  "trial_price,trial_currency,trial_duration_days,subscription_price,subscription_currency," +
  "billing_period,upsells,default_language,default_currency,geo_localization,destination," +
  "product,traffic_sources,passport_notes";
const FUNNEL_COLUMNS =
  "id,funnel_path,display_name,is_active,funnelfox_funnel_id,created_by,created_at,updated_at," +
  PASSPORT_COLUMNS;
const TAG_COLUMNS = "id,name,created_by,created_at";

function ensureSupabase() {
  if (!supabase) throw new Error("Supabase is not configured.");
  return supabase;
}

async function currentUserId(): Promise<string> {
  const client = ensureSupabase();
  const { data, error } = await client.auth.getUser();
  if (error || !data.user?.id) throw new Error("Sign in before managing funnels.");
  return data.user.id;
}

/** Unique-violation on the (funnel_path | tag name) index -> a friendly message instead of the raw Postgres one. */
function friendlyConflictMessage(error: { code?: string; message: string }, label: string): string {
  return error.code === "23505" ? `${label} already exists.` : error.message;
}

export async function listFunnels(): Promise<FunnelRecord[]> {
  const client = ensureSupabase();
  const { data, error } = await client
    .from("funnels")
    .select(`${FUNNEL_COLUMNS},funnel_tags(tags(${TAG_COLUMNS}))`)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`Could not load funnels: ${error.message}`);
  return (
    (data ?? []) as unknown as Array<Record<string, unknown> & { funnel_tags: Array<{ tags: TagRecord | null }> }>
  ).map(
    (row) => {
      const { funnel_tags, ...rest } = row;
      return {
        ...(rest as Omit<FunnelRecord, "tags">),
        tags: funnel_tags.map((link) => link.tags).filter((tag): tag is TagRecord => tag != null),
      };
    },
  );
}

export async function createFunnel(input: { funnel_path: string; display_name: string }): Promise<FunnelRecord> {
  const client = ensureSupabase();
  const userId = await currentUserId();
  const funnelPath = input.funnel_path.trim();
  if (!funnelPath) throw new Error("Funnel path is required.");
  const { data, error } = await client
    .from("funnels")
    .insert({ funnel_path: funnelPath, display_name: input.display_name.trim(), created_by: userId })
    .select(FUNNEL_COLUMNS)
    .single();
  if (error) throw new Error(friendlyConflictMessage(error, `A funnel with path "${funnelPath}"`));
  return { ...(data as unknown as Omit<FunnelRecord, "tags">), tags: [] };
}

// funnel_path is deliberately not part of the update surface in v1 — the
// Funnels UI only edits display name and tags (see plan §3/§6).
export async function updateFunnelDisplayName(id: string, displayName: string): Promise<FunnelRecord> {
  const client = ensureSupabase();
  const { data, error } = await client
    .from("funnels")
    .update({ display_name: displayName.trim() })
    .eq("id", id)
    .select(FUNNEL_COLUMNS)
    .single();
  if (error) throw new Error(`Could not update funnel: ${error.message}`);
  return { ...(data as unknown as Omit<FunnelRecord, "tags">), tags: [] };
}

/**
 * Save the passport.
 *
 * Only the keys the caller passes are written, so a form that edits pricing
 * cannot silently blank the localisation list. Numbers arriving as empty
 * strings from the form become null rather than 0 — an unset trial price and a
 * free trial are different facts.
 */
export async function updateFunnelPassport(
  id: string,
  patch: Partial<FunnelPassportFields>,
): Promise<void> {
  const client = ensureSupabase();
  const row: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    row[key] = value === "" ? null : value;
  }
  if (!Object.keys(row).length) return;
  const { error } = await client.from("funnels").update(row).eq("id", id);
  if (error) throw new Error(`Could not update funnel passport: ${error.message}`);
}

// No deleteFunnel: is_active is the sole retirement mechanism in v1. A manual
// toggle still exists for one-off overrides, but the daily recompute (below)
// re-derives is_active from traffic on the next tick.
export async function setFunnelActive(id: string, isActive: boolean): Promise<void> {
  const client = ensureSupabase();
  const { error } = await client.from("funnels").update({ is_active: isActive }).eq("id", id);
  if (error) throw new Error(`Could not update funnel status: ${error.message}`);
}

export interface RecomputeActiveResult {
  window_days: number;
  activated: number;
  deactivated: number;
  active_total: number;
}

// "Active" means traffic is flowing: a successful transaction on the funnel's
// path within the trailing window. This calls the same SQL the daily
// funnels-active-from-traffic cron runs, so the button and the automatic tick
// can never disagree.
export async function recomputeFunnelActiveStatus(windowDays = 30): Promise<RecomputeActiveResult> {
  const client = ensureSupabase();
  const { data, error } = await client.rpc("recompute_funnel_active_status", { p_window_days: windowDays });
  if (error) throw new Error(`Could not recompute active status: ${error.message}`);
  return data as RecomputeActiveResult;
}

// The funnel_path set for the currently-active funnels. Cohorts uses this to
// highlight active funnels in its Campaign path filter (funnel_path there is
// the same value as campaign_path).
export async function listActiveFunnelPaths(): Promise<string[]> {
  const client = ensureSupabase();
  const { data, error } = await client.from("funnels").select("funnel_path").eq("is_active", true);
  if (error) throw new Error(`Could not load active funnels: ${error.message}`);
  return ((data ?? []) as Array<{ funnel_path: string }>).map((row) => row.funnel_path);
}

export async function listTags(): Promise<TagRecord[]> {
  const client = ensureSupabase();
  const { data, error } = await client.from("tags").select(TAG_COLUMNS).order("name", { ascending: true });
  if (error) throw new Error(`Could not load tags: ${error.message}`);
  return (data ?? []) as TagRecord[];
}

export async function createTag(name: string): Promise<TagRecord> {
  const client = ensureSupabase();
  const userId = await currentUserId();
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Tag name is required.");
  const { data, error } = await client
    .from("tags")
    .insert({ name: trimmed, created_by: userId })
    .select(TAG_COLUMNS)
    .single();
  if (error) throw new Error(friendlyConflictMessage(error, `A tag named "${trimmed}"`));
  return data as TagRecord;
}

export async function renameTag(id: string, name: string): Promise<TagRecord> {
  const client = ensureSupabase();
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Tag name is required.");
  const { data, error } = await client.from("tags").update({ name: trimmed }).eq("id", id).select(TAG_COLUMNS).single();
  if (error) throw new Error(friendlyConflictMessage(error, `A tag named "${trimmed}"`));
  return data as TagRecord;
}

// Cascades funnel_tags rows via the FK (ON DELETE CASCADE) — stays in scope
// unlike funnel deletion, which is deliberately absent from this module.
export async function deleteTag(id: string): Promise<void> {
  const client = ensureSupabase();
  const { error } = await client.from("tags").delete().eq("id", id);
  if (error) throw new Error(`Could not delete tag: ${error.message}`);
}

// Single atomic RPC call, not two independent PostgREST writes — see
// replace_funnel_tags() in the migration for why (funnel_tags has no
// direct insert/update/delete policy; this is its only mutation path).
export async function replaceFunnelTags(funnelId: string, tagIds: string[]): Promise<void> {
  const client = ensureSupabase();
  const { error } = await client.rpc("replace_funnel_tags", { p_funnel_id: funnelId, p_tag_ids: tagIds });
  if (error) throw new Error(`Could not update funnel tags: ${error.message}`);
}

// ---- FunnelFox import ------------------------------------------------------
// FunnelFox is the system of record for funnel identity: it knows every funnel
// (including ones with no traffic yet) and carries the human-readable title and
// its own tags. The warehouse only knows paths that already produced
// transactions, and would force machine-derived display names.

/** Lists FunnelFox funnels and marks which are already in the registry. */
export async function listFunnelFoxFunnels(): Promise<FunnelFoxImportCandidate[]> {
  const client = ensureSupabase();
  const { data, error } = await client.functions.invoke("funnelfox-funnels", { body: {} });
  if (error) throw new Error(`Could not reach FunnelFox: ${error.message}`);
  const payload = (data ?? {}) as { funnels?: FunnelFoxFunnel[]; truncated?: boolean };
  const funnels = payload.funnels ?? [];

  const existing = await listFunnels();
  // A row counts as registered if it carries the FunnelFox id OR already
  // occupies the same path (hand-created before the import existed).
  const registeredIds = new Set(existing.map((row) => row.funnelfox_funnel_id).filter(Boolean));
  const registeredPaths = new Set(existing.map((row) => row.funnel_path));

  return funnels
    .filter((funnel) => funnel.id && funnel.alias)
    .map((funnel) => ({
      ...funnel,
      alreadyRegistered: registeredIds.has(funnel.id) || registeredPaths.has(funnel.alias),
    }));
}

/** Case-insensitive name -> tag id, creating any tag that does not exist yet. */
async function ensureTags(names: string[]): Promise<Map<string, string>> {
  const wanted = [...new Set(names.map((name) => name.trim()).filter(Boolean))];
  const byLowerName = new Map<string, string>();
  if (!wanted.length) return byLowerName;

  for (const tag of await listTags()) byLowerName.set(tag.name.trim().toLowerCase(), tag.id);

  for (const name of wanted) {
    const key = name.toLowerCase();
    if (byLowerName.has(key)) continue;
    const created = await createTag(name);
    byLowerName.set(created.name.trim().toLowerCase(), created.id);
  }
  return byLowerName;
}

export interface FunnelFoxImportResult {
  importedFunnels: number;
  createdTags: number;
}

/**
 * Creates a registry row per selected FunnelFox funnel and mirrors its tags.
 * is_active is NOT taken from FunnelFox's publish state: "active" means traffic
 * is flowing, which a fresh import cannot know. New rows start inactive and the
 * recompute (button + daily cron) flips on the ones with recent traffic.
 */
export async function importFunnelFoxFunnels(funnels: FunnelFoxFunnel[]): Promise<FunnelFoxImportResult> {
  const client = ensureSupabase();
  if (!funnels.length) return { importedFunnels: 0, createdTags: 0 };
  const userId = await currentUserId();

  const tagsBefore = (await listTags()).length;
  const tagIdByName = await ensureTags(funnels.flatMap((funnel) => funnel.tags));
  const createdTags = tagIdByName.size - tagsBefore;

  const { data, error } = await client
    .from("funnels")
    .insert(
      funnels.map((funnel) => ({
        funnel_path: funnel.alias.trim(),
        display_name: funnel.title.trim(),
        is_active: false,
        funnelfox_funnel_id: funnel.id,
        created_by: userId,
      })),
    )
    .select(FUNNEL_COLUMNS);
  if (error) throw new Error(`Could not import funnels: ${error.message}`);

  const inserted = (data ?? []) as unknown as Array<Omit<FunnelRecord, "tags">>;
  const idByFunnelFoxId = new Map(inserted.map((row) => [row.funnelfox_funnel_id, row.id]));

  // Tag links go through the atomic RPC, one call per funnel. Sequential on
  // purpose: this is a one-off admin action, and a burst of ~59 concurrent
  // RPCs buys nothing.
  for (const funnel of funnels) {
    const funnelId = idByFunnelFoxId.get(funnel.id);
    if (!funnelId || !funnel.tags.length) continue;
    const tagIds = funnel.tags
      .map((name) => tagIdByName.get(name.trim().toLowerCase()))
      .filter((id): id is string => Boolean(id));
    if (tagIds.length) await replaceFunnelTags(funnelId, tagIds);
  }

  return { importedFunnels: inserted.length, createdTags: Math.max(0, createdTags) };
}
