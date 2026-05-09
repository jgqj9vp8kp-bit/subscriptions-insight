import { compressToEncodedURIComponent, decompressFromEncodedURIComponent } from "lz-string";
import { supabase } from "@/services/supabaseClient";

export type DatasetType =
  | "palmer"
  | "funnelfox_subscriptions"
  | "facebook_traffic"
  | "forecasting_settings"
  | "cohorts_ui_settings";

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

const SNAPSHOT_COMPRESSION_THRESHOLD_KB = 256;
const SNAPSHOT_COMPRESSION_ALGORITHM = "lz-string-uri-v1";

type CompressedSnapshotPayload = {
  __subengine_compressed: true;
  algorithm: typeof SNAPSHOT_COMPRESSION_ALGORITHM;
  data: string;
  original_size_kb: number;
  compressed_size_kb: number;
};

export function jsonSizeKb(value: unknown): number {
  try {
    const json = JSON.stringify(value);
    const bytes = new TextEncoder().encode(json).length;
    return Math.round((bytes / 1024) * 10) / 10;
  } catch {
    return 0;
  }
}

function stringSizeKb(value: string): number {
  const bytes = new TextEncoder().encode(value).length;
  return Math.round((bytes / 1024) * 10) / 10;
}

function isCompressedSnapshotPayload(value: unknown): value is CompressedSnapshotPayload {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && (value as Record<string, unknown>).__subengine_compressed === true
    && (value as Record<string, unknown>).algorithm === SNAPSHOT_COMPRESSION_ALGORITHM
    && typeof (value as Record<string, unknown>).data === "string";
}

export function prepareSnapshotPayload<TPayload>(
  payload: TPayload,
  thresholdKb = SNAPSHOT_COMPRESSION_THRESHOLD_KB,
): {
  payload: TPayload | CompressedSnapshotPayload;
  metadata: Record<string, unknown>;
} {
  const json = JSON.stringify(payload);
  const originalSizeKb = stringSizeKb(json);

  if (originalSizeKb < thresholdKb) {
    return {
      payload,
      metadata: {
        payload_size_kb: originalSizeKb,
        payload_compressed: false,
      },
    };
  }

  const compressed = compressToEncodedURIComponent(json);
  const compressedSizeKb = stringSizeKb(compressed);

  return {
    payload: {
      __subengine_compressed: true,
      algorithm: SNAPSHOT_COMPRESSION_ALGORITHM,
      data: compressed,
      original_size_kb: originalSizeKb,
      compressed_size_kb: compressedSizeKb,
    },
    metadata: {
      payload_size_kb: originalSizeKb,
      compressed_payload_size_kb: compressedSizeKb,
      payload_compressed: true,
      compression_algorithm: SNAPSHOT_COMPRESSION_ALGORITHM,
    },
  };
}

export function resolveSnapshotPayload<TPayload>(payload: unknown): TPayload | null {
  if (!isCompressedSnapshotPayload(payload)) return payload as TPayload;

  try {
    const decompressed = decompressFromEncodedURIComponent(payload.data);
    if (!decompressed) return null;
    return JSON.parse(decompressed) as TPayload;
  } catch (error) {
    console.warn("Could not decompress cloud snapshot payload.", error);
    return null;
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
  const userId = await currentUserId();
  if (!userId) {
    throw new Error("Cannot save cloud snapshot because no authenticated Supabase user is available.");
  }
  const client = ensureSupabase();

  const prepared = prepareSnapshotPayload(payload);
  const nextMetadata = {
    ...metadata,
    ...prepared.metadata,
    saved_at: new Date().toISOString(),
  };

  console.info("Saving cloud snapshot", {
    user_id_exists: Boolean(userId),
    dataset_type: datasetType,
    payload_size_kb: nextMetadata.payload_size_kb,
    compressed_payload_size_kb: nextMetadata.compressed_payload_size_kb,
    payload_compressed: nextMetadata.payload_compressed,
  });

  const { data, error } = await client
    .from("data_snapshots")
    .upsert(
      {
        user_id: userId,
        dataset_type: datasetType,
        name,
        payload: prepared.payload,
        metadata: nextMetadata,
      },
      { onConflict: "user_id,dataset_type" },
    )
    .select(snapshotSelect())
    .single();

  if (error) {
    console.warn("Cloud snapshot save failed", {
      dataset_type: datasetType,
      error_message: error.message,
      payload_size_kb: nextMetadata.payload_size_kb,
      compressed_payload_size_kb: nextMetadata.compressed_payload_size_kb,
    });
    throw new Error(
      `Could not save ${datasetType} cloud snapshot (${nextMetadata.payload_size_kb} KB): ${error.message}`,
    );
  }

  console.info("Cloud snapshot saved", {
    dataset_type: datasetType,
    snapshot_id: data?.id,
    updated_at: data?.updated_at,
  });

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

  if (!data) return null;

  const payload = resolveSnapshotPayload<TPayload>(data.payload);
  if (!payload) {
    console.warn("Cloud snapshot payload is invalid or corrupted", {
      dataset_type: datasetType,
      snapshot_id: data.id,
    });
    return null;
  }

  return { ...data, payload } as CloudSnapshot<TPayload>;
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
