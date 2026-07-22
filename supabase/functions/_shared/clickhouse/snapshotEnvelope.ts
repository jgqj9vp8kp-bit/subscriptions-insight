// data_snapshots payload envelope, shared by the browser app and Edge Functions.
// The lz-string implementation is injected so this module stays dependency-free:
// the browser passes the npm import, Deno passes the esm.sh import, tests pass either.

export const SNAPSHOT_COMPRESSION_ALGORITHM = "lz-string-uri-v1";

export interface CompressedSnapshotEnvelope {
  __subengine_compressed: true;
  algorithm: typeof SNAPSHOT_COMPRESSION_ALGORITHM;
  data: string;
  original_size_kb: number;
  compressed_size_kb: number;
}

export type SnapshotDecompress = (data: string) => string | null;

export function isCompressedSnapshotEnvelope(value: unknown): value is CompressedSnapshotEnvelope {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && (value as Record<string, unknown>).__subengine_compressed === true
    && (value as Record<string, unknown>).algorithm === SNAPSHOT_COMPRESSION_ALGORITHM
    && typeof (value as Record<string, unknown>).data === "string";
}

/** Unwrap a snapshot payload: pass plain payloads through, decompress enveloped ones.
 * Returns null when an enveloped payload cannot be decompressed or parsed. */
export function resolveSnapshotEnvelope<TPayload>(payload: unknown, decompress: SnapshotDecompress): TPayload | null {
  if (!isCompressedSnapshotEnvelope(payload)) return payload as TPayload;
  try {
    const decompressed = decompress(payload.data);
    if (!decompressed) return null;
    return JSON.parse(decompressed) as TPayload;
  } catch {
    return null;
  }
}
