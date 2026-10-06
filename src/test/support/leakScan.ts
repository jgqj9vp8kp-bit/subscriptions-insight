// Leak sentinels for the security suite (plan §29 "New helpers").
//
// Fixtures plant these values where only the data owner (or nobody) may see
// them — in warehouse rows, stored sync diagnostics, raw upstream payloads,
// error messages — and scanForLeaks() looks for them in whatever reached the
// caller: a JSON body, a Response (body AND headers), a log line. A hit names
// the sentinel, so a failing test says what leaked, not just "something did".
//
// The values are synthetic and unique on purpose (no real customer data):
//   * e-mail addresses under the reserved .test TLD;
//   * the spend figure 987654.32 (and its integer part / grouped forms);
//   * funnel B's campaign paths (a funnel the restricted fixture is NOT granted);
//   * a SQL fragment and a ClickHouse error text (no warehouse text for employees).

export const SENTINEL_EMAILS = [
  "leak.sentinel.alpha@subengine.test",
  "leak.sentinel.beta@subengine.test",
] as const;

export const SENTINEL_SPEND = 987654.32;

/** Spend renderings a projection might emit (raw, integer part, grouped, ru-locale). */
export const SENTINEL_SPEND_FORMS = ["987654.32", "987654", "987,654.32", "987 654,32", "987 654,32"] as const;

/** Funnel B (past-life): canonical and raw registry spellings. */
export const FUNNEL_B_PATHS = ["past-life", "/past-life", "Past-Life", "past_life_b_sentinel"] as const;

export const SENTINEL_SQL = "SELECT leak_sentinel_column FROM fact_leak_sentinel WHERE auth_user_id = 'sentinel'";

export const SENTINEL_CLICKHOUSE_ERROR =
  `ClickHouse HTTP 400: Code: 47. DB::Exception: Missing columns: 'leak_sentinel_column' while processing query: '${SENTINEL_SQL}'`;

export interface LeakScanOptions {
  /** Also flag funnel B paths (off when the caller legitimately sees funnel B). */
  funnelB?: boolean;
  /** Also flag SQL / ClickHouse error text. Default true. */
  sql?: boolean;
  /** Extra exact strings to flag (e.g. a foreign tenant uuid). */
  extra?: readonly string[];
}

function serialize(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

/** Returns every sentinel found in `value` (strings are scanned as-is, anything
 * else as its JSON). Case-insensitive for e-mails and paths. */
export function scanForLeaks(value: unknown, options: LeakScanOptions = {}): string[] {
  const text = serialize(value);
  const lower = text.toLowerCase();
  const found: string[] = [];
  for (const email of SENTINEL_EMAILS) if (lower.includes(email)) found.push(email);
  for (const form of SENTINEL_SPEND_FORMS) if (text.includes(form)) found.push(form);
  if (options.funnelB) {
    for (const path of FUNNEL_B_PATHS) if (lower.includes(path.toLowerCase())) found.push(path);
  }
  if (options.sql ?? true) {
    for (const marker of ["leak_sentinel_column", "fact_leak_sentinel", "DB::Exception"]) if (text.includes(marker)) found.push(marker);
  }
  for (const extra of options.extra ?? []) if (extra && text.includes(extra)) found.push(extra);
  return [...new Set(found)];
}

/** Reads a Response (without consuming the caller's copy) and scans its body
 * and headers. */
export async function scanResponse(response: Response, options: LeakScanOptions = {}): Promise<{ text: string; leaks: string[] }> {
  const text = await response.clone().text();
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  return { text, leaks: scanForLeaks({ text, headers }, options) };
}

/** A warehouse row carrying every sentinel (for responders and fixtures). */
export function sentinelRow(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    email: SENTINEL_EMAILS[0],
    user_id: SENTINEL_EMAILS[1],
    campaign_path: FUNNEL_B_PATHS[0],
    spend: SENTINEL_SPEND,
    gross: SENTINEL_SPEND,
    ...extra,
  };
}
