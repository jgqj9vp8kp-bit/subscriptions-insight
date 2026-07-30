// Transaction source for the Campaign Performance Export API, reading the
// ClickHouse warehouse instead of the Postgres JSON blobs.
//
// WHY THIS EXISTS
// The export used to page EVERY non-deleted Postgres row with 17 columns,
// including raw_payload AND normalized_payload, and hold them all in one Edge
// Function invocation. Measured on live data: 10.62 MB of JSON per 1000 rows —
// ~401 MB and ~119 s for the current 37.7k rows. That is far past an Edge
// Function's memory ceiling, so the runtime killed the invocation before the
// handler's own try/catch could log anything: api_keys.last_used_at kept being
// stamped (auth is cheap and ran fine) while api_export_logs recorded nothing
// after 2026-07-20.
//
// The Supabase→ClickHouse migration already solved this shape of problem by
// flattening the payload into typed columns. Reading those columns instead of
// the JSON gives the SAME field values with ~30-40x less transfer, so the
// export's pure compute (compute.ts / aggregate.ts / classify.ts, pinned by 31
// tests) is reused verbatim — only the data acquisition changes.
//
// This module is pure: the SQL string and the row mapper. The Edge Function owns
// the client and the paging loop.
import type { ClickHouseClientLike } from "./types.ts";

export const EXPORT_TRANSACTIONS_PAGE_SIZE = 20000;

/** The shape compute.ts consumes. Declared structurally rather than imported so
 * this shared module stays independent of the function folder. */
export interface ExportSourceTxn {
  transaction_id: string;
  user_id: string;
  email: string;
  event_time: string;
  amount_usd: number;
  gross_amount_usd: number;
  refund_amount_usd: number;
  net_amount_usd: number;
  is_refunded: boolean;
  status: string;
  transaction_type: string;
  funnel: string;
  campaign_path: string;
  campaign_id: string;
  utm_source: string | null;
  classification_reason: string;
  billing_reason?: string;
  product?: string;
  currency?: string;
  source: string | null;
  import_batch_id: string | null;
  raw: Record<string, unknown>;
}

/** Every column the export's compute actually reads — and nothing else.
 * raw_payload / normalized_payload are deliberately absent: the classifier
 * (classify.ts -> palmerTransform) never touches tx.raw, and those two columns
 * were 56% + 30% of the old payload's bytes.
 *
 * event_time is emitted as an explicit UTC ISO-8601 string. ClickHouse's bare
 * toString() yields "YYYY-MM-DD hh:mm:ss.mmm", which `new Date()` would parse in
 * the RUNTIME's local zone and silently shift every timestamp. */
export const EXPORT_TRANSACTIONS_SELECT = `
  transaction_id,
  user_id,
  normalized_email AS email,
  concat(replaceOne(toString(event_time, 'UTC'), ' ', 'T'), 'Z') AS event_time,
  toFloat64(amount_usd) AS amount_usd,
  toFloat64(gross_amount_usd) AS gross_amount_usd,
  toFloat64(net_amount_usd) AS net_amount_usd,
  toFloat64(refund_amount_usd) AS refund_amount_usd,
  is_refund,
  status,
  transaction_type,
  funnel,
  campaign_path,
  campaign_id,
  utm_source,
  classification_reason,
  billing_reason,
  product_name,
  currency,
  source,
  import_batch_id
`.trim();

/** FINAL collapses the ReplacingMergeTree duplicates a re-sync leaves behind —
 * without it a re-imported transaction would be counted twice. Ordering matches
 * the previous Postgres read (event_time, transaction_id) so any downstream
 * tie-breaking behaves identically. */
export function buildExportTransactionsQuery(pageSize: number, offset: number): string {
  return `
    SELECT ${EXPORT_TRANSACTIONS_SELECT}
    FROM analytics_transactions FINAL
    WHERE auth_user_id = {auth_user_id:String}
    ORDER BY event_time ASC, transaction_id ASC
    LIMIT ${Math.max(1, Math.floor(pageSize))} OFFSET ${Math.max(0, Math.floor(offset))}
  `.trim();
}

const str = (value: unknown): string => (value === null || value === undefined ? "" : String(value).trim());

const numeric = (value: unknown): number => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/** Maps one warehouse row onto the compute's transaction shape.
 *
 * Field-for-field equivalent to the previous Postgres hydrateTransaction, with
 * two deliberate differences:
 *   - `raw` is always {} (the classifier never reads it; see module header).
 *   - values come from typed columns rather than JSON fallback chains, so the
 *     old `payload.x ?? record.y ?? payload.z` ladders collapse to one read. */
export function mapExportSourceRow(row: Record<string, unknown>): ExportSourceTxn | null {
  const transactionId = str(row.transaction_id);
  const eventTime = str(row.event_time);
  if (!transactionId || !eventTime) return null;

  const gross = numeric(row.gross_amount_usd);
  const net = numeric(row.net_amount_usd);
  const refunded = numeric(row.refund_amount_usd);
  const amount = numeric(row.amount_usd) || net || gross;

  return {
    transaction_id: transactionId,
    user_id: str(row.user_id) || str(row.email) || transactionId,
    email: str(row.email),
    event_time: eventTime,
    amount_usd: amount,
    gross_amount_usd: gross || amount,
    net_amount_usd: net || amount,
    refund_amount_usd: refunded,
    is_refunded: numeric(row.is_refund) > 0 || refunded > 0,
    status: str(row.status),
    transaction_type: str(row.transaction_type),
    funnel: str(row.funnel) || "unknown",
    campaign_path: str(row.campaign_path) || "unknown",
    campaign_id: str(row.campaign_id),
    utm_source: str(row.utm_source) || null,
    classification_reason: str(row.classification_reason),
    billing_reason: str(row.billing_reason) || undefined,
    product: str(row.product_name) || undefined,
    currency: str(row.currency) || undefined,
    source: str(row.source) || null,
    import_batch_id: str(row.import_batch_id) || null,
    raw: {},
  };
}

/** Pages the whole history for one account out of ClickHouse. Kept here so the
 * Edge Function stays a thin wrapper, matching this repo's compute-core rule. */
export async function loadExportTransactions(
  clickhouse: ClickHouseClientLike,
  authUserId: string,
  pageSize = EXPORT_TRANSACTIONS_PAGE_SIZE,
): Promise<ExportSourceTxn[]> {
  const out: ExportSourceTxn[] = [];
  let offset = 0;
  for (;;) {
    const result = await clickhouse.query({
      query: buildExportTransactionsQuery(pageSize, offset),
      query_params: { auth_user_id: authUserId },
      format: "JSONEachRow",
    });
    const rows = (await result.json()) as Record<string, unknown>[];
    for (const row of rows) {
      const mapped = mapExportSourceRow(row);
      if (mapped) out.push(mapped);
    }
    if (rows.length < pageSize) return out;
    offset += pageSize;
  }
}
