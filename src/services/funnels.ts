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

export interface FunnelRecord {
  id: string;
  funnel_path: string;
  display_name: string;
  is_active: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  tags: TagRecord[];
}

const FUNNEL_COLUMNS = "id,funnel_path,display_name,is_active,created_by,created_at,updated_at";
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
  return { ...(data as Omit<FunnelRecord, "tags">), tags: [] };
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
  return { ...(data as Omit<FunnelRecord, "tags">), tags: [] };
}

// No deleteFunnel: is_active is the sole retirement mechanism in v1.
export async function setFunnelActive(id: string, isActive: boolean): Promise<void> {
  const client = ensureSupabase();
  const { error } = await client.from("funnels").update({ is_active: isActive }).eq("id", id);
  if (error) throw new Error(`Could not update funnel status: ${error.message}`);
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
