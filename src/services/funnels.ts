// Funnels admin registry (Funnels page). Config metadata, not analytics —
// see supabase/migrations/202607240001_create_funnels_admin.sql for the
// schema. Reads are scoped by RLS since access Phase 2
// (202610060001_access_phase2_scope.sql): a funnel-restricted member reads
// only their own funnels, their tags and their granted paths; writes stay
// with funnels.manage (full scope).
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

/** Lifecycle of one campaign path of a funnel (funnel_paths, access Phase 2).
 * Only active and retired paths grant funnel access. */
export type FunnelPathStatus = "proposed" | "active" | "retired" | "revoked";

/** One campaign path of a funnel, in canonical form. The registry RLS hands a
 * funnel-restricted member only the active and retired paths of their own
 * funnels; a full-scope reader also sees proposed and revoked rows. */
export interface FunnelPathRecord {
  id: string;
  path: string;
  status: FunnelPathStatus;
}

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
  /** The campaign paths that make up this funnel (current, old, proposed). */
  paths: FunnelPathRecord[];
}

/** Whether a path row grants funnel access (active or retired). */
export function isGrantingFunnelPath(path: Pick<FunnelPathRecord, "status">): boolean {
  return path.status === "active" || path.status === "retired";
}

const SCOPE_PATH_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * The campaign paths a funnel-restricted member's reads are bound to: the
 * server-resolved paths of their funnels (useAccess().funnelScope), kept only
 * in canonical form, at most 200 characters and never "unknown"; none unless
 * the mode is "selected" — the same rule as the restricted scope in
 * supabase/functions/_shared/clickhouse/scopeSql.ts. The server intersects
 * every campaign_path include filter with this set; the pages use it to offer
 * only these options and to name the saved values it ignores.
 */
export function funnelScopeFilterPaths(
  scope: { mode: string; paths: readonly string[] } | null | undefined,
): Set<string> {
  if (!scope || scope.mode !== "selected") return new Set();
  return new Set(
    scope.paths.filter((path) => typeof path === "string" && path !== "unknown" && path.length <= 200 && SCOPE_PATH_RE.test(path)),
  );
}

/**
 * TypeScript mirror of app.canonical_campaign_path (migration 202610060001 §1):
 * the canonical campaign_path the registry stores a funnel path as — trimmed,
 * lower-cased, scheme/host, query and fragment stripped, every run of other
 * characters collapsed to "-". null when there is no canonical form (empty,
 * "unknown", longer than 200 characters): the database refuses such a path.
 */
export function canonicalCampaignPath(raw: string | null | undefined): string | null {
  const value = String(raw ?? "").replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "").toLowerCase();
  const path = value.replace(/^https?:\/\/[^/]+/, "").split("?")[0].split("#")[0];
  const slug = path.replace(/^\/+|\/+$/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug === "" || slug === "unknown" || slug.length > 200 ? null : slug;
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
// funnel_paths exists from migration 202610060001 on (access Phase 2): the
// embed below needs it in production before this frontend ships.
const FUNNEL_PATH_COLUMNS = "id,path_canonical,status";
const FUNNEL_PATH_STATUSES: ReadonlySet<string> = new Set(["proposed", "active", "retired", "revoked"]);

/** The embedded funnel_paths rows. A row with an unknown status is dropped: it
 * must never read as a grant. */
function mapFunnelPaths(value: unknown): FunnelPathRecord[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const row = entry as { id?: unknown; path_canonical?: unknown; status?: unknown } | null;
    if (!row || typeof row.path_canonical !== "string" || !row.path_canonical) return [];
    if (typeof row.status !== "string" || !FUNNEL_PATH_STATUSES.has(row.status)) return [];
    return [{ id: String(row.id ?? ""), path: row.path_canonical, status: row.status as FunnelPathStatus }];
  });
}

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

/** Unique-violation on the (funnel_path | tag name) index -> a friendly message instead of the raw Postgres one.
 * The funnels triggers (access Phase 2) raise P0001 "invalid: …" / "conflict: …"
 * (no canonical path form, path held by another funnel): the code prefix is dropped. */
function friendlyConflictMessage(error: { code?: string; message: string }, label: string): string {
  if (error.code === "23505") return `${label} already exists.`;
  if (error.code === "P0001") {
    const detail = /^(?:invalid|conflict): ([\s\S]+)$/.exec(error.message)?.[1];
    if (detail) return `${detail.charAt(0).toUpperCase()}${detail.slice(1)}.`;
  }
  return error.message;
}

// The registry RLS scopes this read (access Phase 2): a funnel-restricted
// member gets only their own funnels, the tags linked to them and their active
// and retired paths; everyone with funnel scope "all" gets every row.
export async function listFunnels(): Promise<FunnelRecord[]> {
  const client = ensureSupabase();
  const { data, error } = await client
    .from("funnels")
    .select(`${FUNNEL_COLUMNS},funnel_tags(tags(${TAG_COLUMNS})),funnel_paths(${FUNNEL_PATH_COLUMNS})`)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`Could not load funnels: ${error.message}`);
  return (
    (data ?? []) as unknown as Array<
      Record<string, unknown> & { funnel_tags: Array<{ tags: TagRecord | null }>; funnel_paths?: unknown }
    >
  ).map(
    (row) => {
      const { funnel_tags, funnel_paths, ...rest } = row;
      return {
        ...(rest as Omit<FunnelRecord, "tags" | "paths">),
        tags: funnel_tags.map((link) => link.tags).filter((tag): tag is TagRecord => tag != null),
        paths: mapFunnelPaths(funnel_paths),
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
  // The new path row is written by the funnels trigger; the next listFunnels reads it.
  return { ...(data as unknown as Omit<FunnelRecord, "tags" | "paths">), tags: [], paths: [] };
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
  return { ...(data as unknown as Omit<FunnelRecord, "tags" | "paths">), tags: [], paths: [] };
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
  // occupies the same path (hand-created before the import existed), also in
  // canonical form: a path granted to a funnel cannot be imported again.
  const registeredIds = new Set(existing.map((row) => row.funnelfox_funnel_id).filter(Boolean));
  const registeredPaths = new Set(existing.map((row) => row.funnel_path));
  const grantedPaths = new Set(existing.flatMap((row) => (row.paths ?? []).filter(isGrantingFunnelPath).map((path) => path.path)));

  return funnels
    .filter((funnel) => funnel.id && funnel.alias)
    .map((funnel) => ({
      ...funnel,
      alreadyRegistered:
        registeredIds.has(funnel.id) ||
        registeredPaths.has(funnel.alias) ||
        grantedPaths.has(canonicalCampaignPath(funnel.alias) ?? ""),
    }));
}

/** The canonical paths currently granted (active or retired) to any funnel. */
async function grantedCampaignPaths(): Promise<Set<string>> {
  const client = ensureSupabase();
  const { data, error } = await client.from("funnel_paths").select("path_canonical,status");
  if (error) throw new Error(`Could not load funnel paths: ${error.message}`);
  return new Set(
    ((data ?? []) as Array<{ path_canonical?: unknown; status?: unknown }>)
      .filter((row) => (row.status === "active" || row.status === "retired") && typeof row.path_canonical === "string")
      .map((row) => row.path_canonical as string),
  );
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

/** A selected FunnelFox funnel the import left out, and why. */
export interface FunnelFoxImportSkip {
  id: string;
  alias: string;
  /** path_taken: its canonical path is granted to another funnel;
   * no_canonical_path: the alias has no canonical form; duplicate_in_batch:
   * an earlier row of the same batch has the same canonical path. */
  reason: "path_taken" | "no_canonical_path" | "duplicate_in_batch";
}

export interface FunnelFoxImportResult {
  importedFunnels: number;
  createdTags: number;
  /** Present only when rows were left out. */
  skipped?: FunnelFoxImportSkip[];
}

/**
 * Creates a registry row per selected FunnelFox funnel and mirrors its tags.
 * is_active is NOT taken from FunnelFox's publish state: "active" means traffic
 * is flowing, which a fresh import cannot know. New rows start inactive and the
 * recompute (button + daily cron) flips on the ones with recent traffic.
 *
 * The batch is one INSERT, and the funnels trigger refuses a path that is
 * already granted to another funnel (or has no canonical form) — one such row
 * would abort the whole batch. They are filtered out first and reported in
 * `skipped`; a concurrent registry change can still abort the batch.
 */
export async function importFunnelFoxFunnels(funnels: FunnelFoxFunnel[]): Promise<FunnelFoxImportResult> {
  const client = ensureSupabase();
  if (!funnels.length) return { importedFunnels: 0, createdTags: 0 };
  const userId = await currentUserId();

  const granted = await grantedCampaignPaths();
  const batchPaths = new Set<string>();
  const skipped: FunnelFoxImportSkip[] = [];
  const importable = funnels.filter((funnel) => {
    const path = canonicalCampaignPath(funnel.alias);
    const reason: FunnelFoxImportSkip["reason"] | null =
      path === null ? "no_canonical_path" : granted.has(path) ? "path_taken" : batchPaths.has(path) ? "duplicate_in_batch" : null;
    if (reason) {
      skipped.push({ id: funnel.id, alias: funnel.alias, reason });
      return false;
    }
    batchPaths.add(path as string);
    return true;
  });
  const withSkipped = (result: FunnelFoxImportResult): FunnelFoxImportResult => (skipped.length ? { ...result, skipped } : result);
  if (!importable.length) return withSkipped({ importedFunnels: 0, createdTags: 0 });

  const tagsBefore = (await listTags()).length;
  const tagIdByName = await ensureTags(importable.flatMap((funnel) => funnel.tags));
  const createdTags = tagIdByName.size - tagsBefore;

  const { data, error } = await client
    .from("funnels")
    .insert(
      importable.map((funnel) => ({
        funnel_path: funnel.alias.trim(),
        display_name: funnel.title.trim(),
        is_active: false,
        funnelfox_funnel_id: funnel.id,
        created_by: userId,
      })),
    )
    .select(FUNNEL_COLUMNS);
  if (error) throw new Error(`Could not import funnels: ${error.message}`);

  const inserted = (data ?? []) as unknown as Array<Omit<FunnelRecord, "tags" | "paths">>;
  const idByFunnelFoxId = new Map(inserted.map((row) => [row.funnelfox_funnel_id, row.id]));

  // Tag links go through the atomic RPC, one call per funnel. Sequential on
  // purpose: this is a one-off admin action, and a burst of ~59 concurrent
  // RPCs buys nothing.
  for (const funnel of importable) {
    const funnelId = idByFunnelFoxId.get(funnel.id);
    if (!funnelId || !funnel.tags.length) continue;
    const tagIds = funnel.tags
      .map((name) => tagIdByName.get(name.trim().toLowerCase()))
      .filter((id): id is string => Boolean(id));
    if (tagIds.length) await replaceFunnelTags(funnelId, tagIds);
  }

  return withSkipped({ importedFunnels: inserted.length, createdTags: Math.max(0, createdTags) });
}
