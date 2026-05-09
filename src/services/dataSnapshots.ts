import { supabase } from "@/services/supabaseClient";

export type DatasetType = "palmer" | "funnelfox_subscriptions" | "facebook_traffic" | "forecasting_settings";

export type CloudSnapshotInfo = {
  id: string;
  dataset_type: DatasetType;
  name: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type CloudSnapshot<TPayload = unknown> = CloudSnapshotInfo & {
  payload: TPayload;
};

export type SaveCloudSnapshotInput<TPayload> = {
  datasetType: DatasetType;
  name?: string;
  payload: TPayload;
  metadata?: Record<string, unknown>;
};

function jsonSizeKb(value: unknown): number {
  try {
    const json = JSON.stringify(value);
    const bytes = new TextEncoder().encode(json).length;
    return Math.round((bytes / 1024) * 10) / 10;
  } catch {
    return 0;
  }
}

async function currentUserId(): Promise<string | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.auth.getUser();
  if (error) return null;
  return data.user?.id ?? null;
}

function ensureSupabase() {
  if (!supabase) throw new Error("Supabase is not configured.");
  return supabase;
}

function snapshotSelect() {
  return "id,dataset_type,name,metadata,created_at,updated_at";
}

export async function saveCloudSnapshot<TPayload>({
  datasetType,
  name = "latest",
  payload,
  metadata = {},
}: SaveCloudSnapshotInput<TPayload>): Promise<CloudSnapshotInfo | null> {
  const client = ensureSupabase();
  const userId = await currentUserId();
  if (!userId) return null;

  const payloadSizeKb = jsonSizeKb(payload);
  const nextMetadata = {
    ...metadata,
    payload_size_kb: payloadSizeKb,
    saved_at: new Date().toISOString(),
  };

  const { data, error } = await client
    .from("data_snapshots")
    .upsert(
      {
        user_id: userId,
        dataset_type: datasetType,
        name,
        payload,
        metadata: nextMetadata,
      },
      { onConflict: "user_id,dataset_type" },
    )
    .select(snapshotSelect())
    .single();

  if (error) {
    throw new Error(`Could not save ${datasetType} cloud snapshot (${payloadSizeKb} KB): ${error.message}`);
  }

  return data as CloudSnapshotInfo;
}

export async function loadLatestCloudSnapshot<TPayload = unknown>(
  datasetType: DatasetType,
): Promise<CloudSnapshot<TPayload> | null> {
  const client = ensureSupabase();
  const userId = await currentUserId();
  if (!userId) return null;

  const { data, error } = await client
    .from("data_snapshots")
    .select("id,dataset_type,name,payload,metadata,created_at,updated_at")
    .eq("user_id", userId)
    .eq("dataset_type", datasetType)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`Could not load ${datasetType} cloud snapshot: ${error.message}`);
  }

  return data as CloudSnapshot<TPayload> | null;
}

export async function getCloudSnapshotInfo(datasetType: DatasetType): Promise<CloudSnapshotInfo | null> {
  const client = ensureSupabase();
  const userId = await currentUserId();
  if (!userId) return null;

  const { data, error } = await client
    .from("data_snapshots")
    .select(snapshotSelect())
    .eq("user_id", userId)
    .eq("dataset_type", datasetType)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`Could not load ${datasetType} cloud snapshot info: ${error.message}`);
  }

  return data as CloudSnapshotInfo | null;
}

export async function getCloudSnapshotInfos(datasetTypes: DatasetType[]): Promise<Record<DatasetType, CloudSnapshotInfo | null>> {
  const entries = await Promise.all(
    datasetTypes.map(async (datasetType) => [datasetType, await getCloudSnapshotInfo(datasetType)] as const),
  );
  return Object.fromEntries(entries) as Record<DatasetType, CloudSnapshotInfo | null>;
}
