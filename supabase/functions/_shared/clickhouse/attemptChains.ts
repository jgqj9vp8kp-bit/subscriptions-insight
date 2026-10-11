// Payment System Health: attempt chains ("payment intents") and retry
// compliance over attempt rows (plan sections G, J, L, Z #4, 8, 10, 15, 20).
//
// Primer gives every retry a new orderId, so an intent has to be inferred: a
// chain is the attempts with the same key (user_id, payment_instrument_key or
// currency + amount, price_point, initiation_type) that follow one another
// within a window (CIT 60 minutes, MIT 72 hours; parameters). The transaction
// type is NOT in the key: declines do not carry a recovered type. The chain is
// a heuristic and every consumer labels it as one.
//
// Bans. A decline whose advised_action is DO_NOT_RETRY / STOP_ALL_PAYMENTS, a
// Visa category 1 code or a Mastercard MAC 03 / 21 (declineTaxonomy.ts,
// retryBanSources) bans the instrument. Every later attempt on the same
// payment_instrument_key, in any chain, is a post-ban attempt: it is a
// potential violation (plan G retry_compliance (a)) and NEVER a recovery,
// cascade (a processor switch) included. For a chain keyed by currency +
// amount (no instrument key) the instrument cannot be told apart, so only a
// ban inside that chain applies and its later attempts are excluded from
// recovery as well (conservative: a success we cannot prove was on another
// card is not counted as recovery).
//
// Rolling limit (plan G retry_compliance (b)): per (payment_instrument_key,
// processor_merchant_id), declines in any rolling 30-day window, counted by
// decline RECORDS (decline_record_count) and not rows, flagged above 15.
//
// Pure module: no Deno globals, no ClickHouse; the P2 runner feeds it rows and
// tests feed it fixtures.

import {
  attemptOutcome,
  classifyDecline,
  normalizeToken,
  VISA_REATTEMPT_LIMIT_PER_30_DAYS,
  type AttemptOutcome,
  type BanSource,
  type DeclineClassification,
  type DeclineFields,
} from "./declineTaxonomy.ts";

/** One analytics_transactions row, with the columns plan T adds (P0 track). */
export interface AttemptRow extends DeclineFields {
  transaction_id: string;
  user_id?: string | null;
  event_time: string;
  processor?: string | null;
  processor_merchant_id?: string | null;
  payment_instrument_key?: string | null;
  currency?: string | null;
  original_amount?: number | null;
  price_point?: string | null;
  initiation_type?: string | null;
}

export interface ChainOptions {
  /** Window between consecutive attempts of a customer-initiated chain (plan G: 60 minutes). */
  citWindowMinutes?: number;
  /** Window between consecutive attempts of a merchant-initiated chain (plan G: 72 hours). */
  mitWindowHours?: number;
  /** Rolling window of the per-card re-attempt limit (plan D: 30 days). */
  rollingWindowDays?: number;
  /** Declines per card and MID above which the rolling window is flagged (plan D: 15). */
  rollingDeclineLimit?: number;
}

export interface ResolvedChainOptions {
  citWindowMs: number;
  mitWindowMs: number;
  rollingWindowMs: number;
  rollingDeclineLimit: number;
}

export const DEFAULT_CHAIN_OPTIONS: Readonly<Required<ChainOptions>> = {
  citWindowMinutes: 60,
  mitWindowHours: 72,
  rollingWindowDays: 30,
  rollingDeclineLimit: VISA_REATTEMPT_LIMIT_PER_30_DAYS,
};

export function resolveChainOptions(options: ChainOptions = {}): ResolvedChainOptions {
  const merged = { ...DEFAULT_CHAIN_OPTIONS, ...options };
  return {
    citWindowMs: merged.citWindowMinutes * 60_000,
    mitWindowMs: merged.mitWindowHours * 3_600_000,
    rollingWindowMs: merged.rollingWindowDays * 86_400_000,
    rollingDeclineLimit: merged.rollingDeclineLimit,
  };
}

export type InitiationType = "cit" | "mit" | "unknown";

export function normalizeInitiationType(value: unknown): InitiationType {
  const token = normalizeToken(value);
  if (token === "CIT" || token === "CUSTOMER_INITIATED") return "cit";
  if (token === "MIT" || token === "MERCHANT_INITIATED") return "mit";
  return "unknown";
}

export interface ChainAttempt {
  transaction_id: string;
  event_time: string;
  time_ms: number;
  outcome: Exclude<AttemptOutcome, "not_an_attempt">;
  success: boolean;
  processor: string | null;
  processor_merchant_id: string | null;
  payment_instrument_key: string | null;
  initiation_type: InitiationType;
  /** The taxonomy result for a decline; null for a success. */
  decline: DeclineClassification | null;
  /** This decline bans the instrument from further attempts. */
  ban: boolean;
  ban_sources: BanSource[];
  /** Made after a ban on the same instrument (or, without an instrument key, after a ban inside this chain). */
  post_ban: boolean;
  /** The processor differs from the previous attempt of the chain. */
  processor_switched: boolean;
  /** decline_record_count > 1: a cascade inside one Primer payment. */
  cascade_row: boolean;
}

export type ChainKeyKind = "instrument" | "currency_amount" | "singleton";

export interface AttemptChain {
  chain_id: string;
  key: string;
  key_kind: ChainKeyKind;
  user_id: string | null;
  payment_instrument_key: string | null;
  price_point: string | null;
  initiation_type: InitiationType;
  window_ms: number;
  started_at: string;
  ended_at: string;
  attempts: ChainAttempt[];
  attempt_count: number;
  decline_count: number;
  /** The first attempt settled. */
  first_try_success: boolean;
  /** The last attempt settled. */
  final_success: boolean;
  had_decline: boolean;
  /** had_decline and the final success was not a post-ban attempt (plan G retry_recovery_rate). */
  recovered: boolean;
  /** The final success came after a ban: a violation, not a recovery. */
  post_ban_success: boolean;
  /** The processor switched at least once inside the chain. */
  cascade: boolean;
  /** cascade and recovered (never after a ban). */
  cascade_recovered: boolean;
  first_ban_index: number | null;
  post_ban_attempt_count: number;
  cascade_row_count: number;
}

export interface ChainSummary {
  rows: number;
  attempts: number;
  /** Rows whose raw_status is neither SETTLED, DECLINED nor FAILED (CANCELLED, PENDING, ...). */
  not_attempts: number;
  chains: number;
  chains_first_try_success: number;
  chains_final_success: number;
  chains_with_decline: number;
  chains_recovered: number;
  /** Chains with a decline that ended settled AFTER a ban: excluded from recovery. */
  chains_post_ban_success: number;
  chains_cascade: number;
  chains_cascade_recovered: number;
  /** Chains that could not be linked (no user_id): one chain per row. */
  chains_singleton: number;
  cascade_rows: number;
}

export interface ChainBuild {
  chains: AttemptChain[];
  summary: ChainSummary;
}

interface ParsedRow {
  row: AttemptRow;
  time_ms: number;
  outcome: Exclude<AttemptOutcome, "not_an_attempt">;
  initiation: InitiationType;
  instrument: string | null;
  processor: string | null;
  mid: string | null;
  decline: DeclineClassification | null;
  ban_sources: BanSource[];
  cascade_row: boolean;
}

function optionalText(value: unknown): string | null {
  if (value == null) return null;
  const trimmed = String(value).trim();
  return trimmed ? trimmed : null;
}

function parseTime(value: string): number {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : Number.NaN;
}

/** Time ascending; at a tie declines before successes (a decline then a success at the same instant is a
 * retry that recovered, the reverse is not an intent); then transaction_id for determinism. */
function compareParsed(a: ParsedRow, b: ParsedRow): number {
  if (a.time_ms !== b.time_ms) return a.time_ms - b.time_ms;
  if (a.outcome !== b.outcome) return a.outcome === "decline" ? -1 : 1;
  return a.row.transaction_id < b.row.transaction_id ? -1 : a.row.transaction_id > b.row.transaction_id ? 1 : 0;
}

function parseRows(rows: readonly AttemptRow[]): { parsed: ParsedRow[]; notAttempts: number } {
  const parsed: ParsedRow[] = [];
  let notAttempts = 0;
  for (const row of rows) {
    const outcome = attemptOutcome(row);
    const time = parseTime(row.event_time);
    if (outcome === "not_an_attempt" || Number.isNaN(time)) {
      notAttempts += 1;
      continue;
    }
    const decline = outcome === "decline" ? classifyDecline(row) : null;
    parsed.push({
      row,
      time_ms: time,
      outcome,
      initiation: normalizeInitiationType(row.initiation_type),
      instrument: optionalText(row.payment_instrument_key),
      processor: normalizeToken(row.processor),
      mid: optionalText(row.processor_merchant_id),
      decline,
      ban_sources: decline?.ban_sources ?? [],
      cascade_row: decline?.cascade_row ?? (typeof row.decline_record_count === "number" && row.decline_record_count > 1),
    });
  }
  parsed.sort(compareParsed);
  return { parsed, notAttempts };
}

/** The position (in global order) of the first banning decline per instrument, over every attempt of any chain. */
function instrumentBanOrder(parsed: readonly ParsedRow[]): Map<string, number> {
  const bans = new Map<string, number>();
  parsed.forEach((entry, order) => {
    if (!entry.instrument || !entry.ban_sources.length || bans.has(entry.instrument)) return;
    bans.set(entry.instrument, order);
  });
  return bans;
}

function chainKey(entry: ParsedRow): { key: string; kind: ChainKeyKind } {
  const user = optionalText(entry.row.user_id);
  if (!user) return { key: `tx:${entry.row.transaction_id}`, kind: "singleton" };
  const price = optionalText(entry.row.price_point) ?? "";
  if (entry.instrument) return { key: `u:${user}|i:${entry.instrument}|p:${price}|${entry.initiation}`, kind: "instrument" };
  const currency = normalizeToken(entry.row.currency) ?? "";
  const amount = typeof entry.row.original_amount === "number" && Number.isFinite(entry.row.original_amount) ? String(entry.row.original_amount) : "";
  return { key: `u:${user}|c:${currency}|a:${amount}|p:${price}|${entry.initiation}`, kind: "currency_amount" };
}

function windowFor(initiation: InitiationType, options: ResolvedChainOptions): number {
  // An unknown initiation type gets the shorter (CIT) window: the safer assumption for linking.
  return initiation === "mit" ? options.mitWindowMs : options.citWindowMs;
}

export function buildAttemptChains(rows: readonly AttemptRow[], options: ChainOptions = {}): ChainBuild {
  const resolved = resolveChainOptions(options);
  const { parsed, notAttempts } = parseRows(rows);
  const bans = instrumentBanOrder(parsed);

  // Group by key, keeping the global order inside each group.
  const groups = new Map<string, { kind: ChainKeyKind; entries: Array<{ entry: ParsedRow; order: number }> }>();
  parsed.forEach((entry, order) => {
    const { key, kind } = chainKey(entry);
    const group = groups.get(key) ?? { kind, entries: [] };
    group.entries.push({ entry, order });
    groups.set(key, group);
  });

  const chains: AttemptChain[] = [];
  for (const [key, group] of groups) {
    const windowMs = windowFor(group.entries[0].entry.initiation, resolved);
    let current: Array<{ entry: ParsedRow; order: number }> = [];
    const flush = () => {
      if (current.length) chains.push(assembleChain(key, group.kind, current, windowMs, bans));
      current = [];
    };
    for (const item of group.entries) {
      const previous = current[current.length - 1];
      // A settled attempt ends the intent; a later attempt with the same key is a new one (a renewal, an upsell).
      if (previous && (previous.entry.outcome === "success" || item.entry.time_ms - previous.entry.time_ms > windowMs)) flush();
      current.push(item);
    }
    flush();
  }

  chains.sort((a, b) => (a.started_at < b.started_at ? -1 : a.started_at > b.started_at ? 1 : a.chain_id < b.chain_id ? -1 : 1));

  const summary: ChainSummary = {
    rows: rows.length,
    attempts: parsed.length,
    not_attempts: notAttempts,
    chains: chains.length,
    chains_first_try_success: chains.filter((chain) => chain.first_try_success).length,
    chains_final_success: chains.filter((chain) => chain.final_success).length,
    chains_with_decline: chains.filter((chain) => chain.had_decline).length,
    chains_recovered: chains.filter((chain) => chain.recovered).length,
    chains_post_ban_success: chains.filter((chain) => chain.post_ban_success).length,
    chains_cascade: chains.filter((chain) => chain.cascade).length,
    chains_cascade_recovered: chains.filter((chain) => chain.cascade_recovered).length,
    chains_singleton: chains.filter((chain) => chain.key_kind === "singleton").length,
    cascade_rows: parsed.filter((entry) => entry.cascade_row).length,
  };
  return { chains, summary };
}

function assembleChain(
  key: string,
  kind: ChainKeyKind,
  items: Array<{ entry: ParsedRow; order: number }>,
  windowMs: number,
  bans: Map<string, number>,
): AttemptChain {
  const first = items[0].entry;
  let firstBanIndex: number | null = null;
  const attempts: ChainAttempt[] = items.map(({ entry, order }, index) => {
    const instrumentBan = entry.instrument ? bans.get(entry.instrument) : undefined;
    // Post-ban: ordered after the instrument's first ban (global), or after a ban earlier in this chain.
    const postBan = (instrumentBan != null && order > instrumentBan) || (firstBanIndex != null && index > firstBanIndex);
    if (entry.ban_sources.length && firstBanIndex == null) firstBanIndex = index;
    const previous = index > 0 ? items[index - 1].entry : null;
    return {
      transaction_id: entry.row.transaction_id,
      event_time: entry.row.event_time,
      time_ms: entry.time_ms,
      outcome: entry.outcome,
      success: entry.outcome === "success",
      processor: entry.processor,
      processor_merchant_id: entry.mid,
      payment_instrument_key: entry.instrument,
      initiation_type: entry.initiation,
      decline: entry.decline,
      ban: entry.ban_sources.length > 0,
      ban_sources: entry.ban_sources,
      post_ban: postBan,
      // A switch needs two known processors: an unrouted decline (no processor) followed by a routed
      // attempt is not a cascade, it is the first routed attempt.
      processor_switched: previous != null && previous.processor != null && entry.processor != null && previous.processor !== entry.processor,
      cascade_row: entry.cascade_row,
    };
  });

  const last = attempts[attempts.length - 1];
  const hadDecline = attempts.some((attempt) => !attempt.success);
  const finalSuccess = last.success;
  const postBanSuccess = finalSuccess && last.post_ban;
  const recovered = hadDecline && finalSuccess && !last.post_ban;
  const cascade = attempts.some((attempt) => attempt.processor_switched);

  return {
    chain_id: `${key}@${first.row.transaction_id}`,
    key,
    key_kind: kind,
    user_id: optionalText(first.row.user_id),
    payment_instrument_key: first.instrument,
    price_point: optionalText(first.row.price_point),
    initiation_type: first.initiation,
    window_ms: windowMs,
    started_at: first.row.event_time,
    ended_at: last.event_time,
    attempts,
    attempt_count: attempts.length,
    decline_count: attempts.filter((attempt) => !attempt.success).length,
    first_try_success: attempts[0].success,
    final_success: finalSuccess,
    had_decline: hadDecline,
    recovered,
    post_ban_success: postBanSuccess,
    cascade,
    cascade_recovered: cascade && recovered,
    first_ban_index: firstBanIndex,
    post_ban_attempt_count: attempts.filter((attempt) => attempt.post_ban).length,
    cascade_row_count: attempts.filter((attempt) => attempt.cascade_row).length,
  };
}

// ---------------------------------------------------------------------------
// Retry compliance (plan G retry_compliance, L, Q rules)
// ---------------------------------------------------------------------------

export interface PostBanAttempt {
  payment_instrument_key: string;
  ban_transaction_id: string;
  ban_event_time: string;
  ban_sources: BanSource[];
  ban_processor: string | null;
  transaction_id: string;
  event_time: string;
  minutes_since_ban: number;
  initiation_type: InitiationType;
  processor: string | null;
  processor_merchant_id: string | null;
  /** 'unknown' when either the ban or the attempt has no processor (an unrouted attempt). */
  processor_relation: "same" | "switched" | "unknown";
  same_processor: boolean;
  succeeded: boolean;
  /** This attempt is itself a banning decline (a second DO_NOT_RETRY, ...). */
  banned_again: boolean;
}

export interface PostBanSummary {
  banned_instruments: number;
  retried_instruments: number;
  attempts: number;
  cit: number;
  mit: number;
  unknown_initiation: number;
  same_processor: number;
  switched_processor: number;
  unknown_processor: number;
  succeeded: number;
  succeeded_switched_processor: number;
  within_one_hour: number;
}

export interface RollingDeclineWindow {
  payment_instrument_key: string;
  /** 'unknown_mid' when the row has no processor_merchant_id (plan W: unknowns are kept, never dropped). */
  processor_merchant_id: string;
  /** The largest number of decline records in any rolling window. */
  max_declines: number;
  /** The window that reached max_declines: its first and last decline. */
  window_start: string;
  window_end: string;
  decline_records_total: number;
  decline_rows_total: number;
  exceeds_limit: boolean;
  limit: number;
}

export interface RetryComplianceReport {
  post_ban_attempts: PostBanAttempt[];
  post_ban_summary: PostBanSummary;
  rolling_windows: RollingDeclineWindow[];
  /** Instrument × MID pairs over the rolling limit. */
  rolling_violations: number;
  /** Transaction ids of rows with decline_record_count > 1 (plan G cascade_rows). */
  cascade_rows: string[];
  options: ResolvedChainOptions;
}

export const UNKNOWN_MID = "unknown_mid";

export function retryCompliance(rows: readonly AttemptRow[], options: ChainOptions = {}): RetryComplianceReport {
  const resolved = resolveChainOptions(options);
  const { parsed } = parseRows(rows);

  // (a) attempts after a ban on the same instrument
  const byInstrument = new Map<string, ParsedRow[]>();
  for (const entry of parsed) {
    if (!entry.instrument) continue;
    const list = byInstrument.get(entry.instrument) ?? [];
    list.push(entry);
    byInstrument.set(entry.instrument, list);
  }
  const postBan: PostBanAttempt[] = [];
  let bannedInstruments = 0;
  let retriedInstruments = 0;
  for (const [instrument, entries] of byInstrument) {
    const banIndex = entries.findIndex((entry) => entry.ban_sources.length > 0);
    if (banIndex < 0) continue;
    bannedInstruments += 1;
    const ban = entries[banIndex];
    const later = entries.slice(banIndex + 1);
    if (later.length) retriedInstruments += 1;
    for (const entry of later) {
      const relation = entry.processor == null || ban.processor == null ? "unknown" : entry.processor === ban.processor ? "same" : "switched";
      postBan.push({
        payment_instrument_key: instrument,
        ban_transaction_id: ban.row.transaction_id,
        ban_event_time: ban.row.event_time,
        ban_sources: ban.ban_sources,
        ban_processor: ban.processor,
        transaction_id: entry.row.transaction_id,
        event_time: entry.row.event_time,
        minutes_since_ban: (entry.time_ms - ban.time_ms) / 60_000,
        initiation_type: entry.initiation,
        processor: entry.processor,
        processor_merchant_id: entry.mid,
        processor_relation: relation,
        same_processor: relation === "same",
        succeeded: entry.outcome === "success",
        banned_again: entry.ban_sources.length > 0,
      });
    }
  }
  const postBanSummary: PostBanSummary = {
    banned_instruments: bannedInstruments,
    retried_instruments: retriedInstruments,
    attempts: postBan.length,
    cit: postBan.filter((attempt) => attempt.initiation_type === "cit").length,
    mit: postBan.filter((attempt) => attempt.initiation_type === "mit").length,
    unknown_initiation: postBan.filter((attempt) => attempt.initiation_type === "unknown").length,
    same_processor: postBan.filter((attempt) => attempt.processor_relation === "same").length,
    switched_processor: postBan.filter((attempt) => attempt.processor_relation === "switched").length,
    unknown_processor: postBan.filter((attempt) => attempt.processor_relation === "unknown").length,
    succeeded: postBan.filter((attempt) => attempt.succeeded).length,
    succeeded_switched_processor: postBan.filter((attempt) => attempt.succeeded && attempt.processor_relation === "switched").length,
    within_one_hour: postBan.filter((attempt) => attempt.minutes_since_ban <= 60).length,
  };

  // (b) declines per instrument and MID in a rolling window, by decline records
  const byPair = new Map<string, { instrument: string; mid: string; declines: Array<{ entry: ParsedRow; weight: number }> }>();
  for (const entry of parsed) {
    if (entry.outcome !== "decline" || !entry.instrument) continue;
    const mid = entry.mid ?? UNKNOWN_MID;
    const pairKey = `${entry.instrument}\u0000${mid}`;
    const pair = byPair.get(pairKey) ?? { instrument: entry.instrument, mid, declines: [] };
    const count = entry.row.decline_record_count;
    pair.declines.push({ entry, weight: typeof count === "number" && count > 1 ? count : 1 });
    byPair.set(pairKey, pair);
  }
  const rolling: RollingDeclineWindow[] = [];
  for (const pair of byPair.values()) {
    let max = 0;
    let maxStart = 0;
    let maxEnd = 0;
    let start = 0;
    let sum = 0;
    pair.declines.forEach((decline, index) => {
      sum += decline.weight;
      // Drop declines that fell out of the window ending at this decline (half-open: exactly 30 days apart is out).
      while (decline.entry.time_ms - pair.declines[start].entry.time_ms >= resolved.rollingWindowMs) {
        sum -= pair.declines[start].weight;
        start += 1;
      }
      if (sum > max) {
        max = sum;
        maxStart = start;
        maxEnd = index;
      }
    });
    rolling.push({
      payment_instrument_key: pair.instrument,
      processor_merchant_id: pair.mid,
      max_declines: max,
      window_start: pair.declines[maxStart].entry.row.event_time,
      window_end: pair.declines[maxEnd].entry.row.event_time,
      decline_records_total: pair.declines.reduce((total, decline) => total + decline.weight, 0),
      decline_rows_total: pair.declines.length,
      exceeds_limit: max > resolved.rollingDeclineLimit,
      limit: resolved.rollingDeclineLimit,
    });
  }
  const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  rolling.sort((a, b) =>
    b.max_declines - a.max_declines
    || byText(a.payment_instrument_key, b.payment_instrument_key)
    || byText(a.processor_merchant_id, b.processor_merchant_id));

  return {
    post_ban_attempts: postBan,
    post_ban_summary: postBanSummary,
    rolling_windows: rolling,
    rolling_violations: rolling.filter((window) => window.exceeds_limit).length,
    cascade_rows: parsed.filter((entry) => entry.cascade_row).map((entry) => entry.row.transaction_id),
    options: resolved,
  };
}
