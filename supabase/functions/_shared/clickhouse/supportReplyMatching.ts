// Answered/unanswered support analytics: the reply matcher.
//
// Decides, for every INBOX support request, whether WE answered it, from three
// independent signals in strength order:
//   'thread'         a Sent reply whose In-Reply-To/References thread contains
//                    the request (exact, carries the reply timestamp);
//   'recipient'      a Sent mail to the same customer after the request
//                    (heuristic, carries a timestamp);
//   'imap_flag'      the INBOX message carries \Answered (exact fact, no time —
//                    flags are frozen at sync time and refreshed periodically);
//   'customer_reply' the customer replied to OUR message whose Sent copy is
//                    unavailable (heuristic, no time).
// The source rides with the verdict so the UI can show coverage quality —
// answers sent outside SpaceMail are only visible through the weaker tiers.
//
// Pure module: no Deno, no fetch, no clock (now is injected). The orchestrator
// at the bottom talks to Postgres through the SupabaseLikeClient contract.

import type { SupabaseLikeClient } from "./types.ts";

export const ANSWER_SOURCES = ["thread", "recipient", "imap_flag", "customer_reply"] as const;
export type AnswerSource = (typeof ANSWER_SOURCES)[number];

/** Replies may be timestamped slightly before the request they answer (server
 * clock differences between Date headers). */
export const MATCH_CLOCK_SKEW_MS = 5 * 60_000;
/** A Sent mail to the customer this long after the request no longer counts as
 * its answer (tier 'recipient' only — threads have no window). */
export const RECIPIENT_MATCH_WINDOW_MS = 14 * 86_400_000;

export interface MatchableRequest {
  id: string;
  /** RAW message id as stored on support_requests (normalized on the fly —
   * support_requests.normalized_message_id is nulled on dedupe collisions and
   * must never be used as a join key). */
  message_id: string | null;
  in_reply_to: string | null;
  references: readonly string[];
  received_at: string;
  normalized_email: string | null;
  imap_flags: readonly string[];
  answered_at: string | null;
  answer_source: string | null;
  answered_reply_id: string | null;
  reply_count: number;
}

export interface MatchableReply {
  id: string;
  normalized_message_id: string | null;
  in_reply_to: string | null;
  references: readonly string[];
  to_emails: readonly string[];
  sent_at: string | null;
}

export interface MatchOutcome {
  request_id: string;
  answered_at: string | null;
  answer_source: AnswerSource;
  answered_reply_id: string | null;
  reply_count: number;
}

/** Must match normalizeMessageId in sync-support-mail/support.ts: requests
 * store message_id RAW while in_reply_to/references are stored normalized. */
export function normalizeMessageId(value: string | null | undefined): string | null {
  const normalized = String(value ?? "").trim().toLowerCase().replace(/^<|>$/g, "");
  return normalized || null;
}

/** Synthetic ids minted for messages without a Message-ID header can collide
 * across mailboxes/folders (imap:<uid>) — they must never join threads. */
function threadableId(value: string | null | undefined): string | null {
  const id = normalizeMessageId(value);
  return id && !id.startsWith("imap:") ? id : null;
}

function ts(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// Union-find over message-id strings: every message (request or reply) links
// its own id with every id it mentions, and connected components become
// conversation threads.
class ThreadIndex {
  private parent = new Map<string, string>();

  private find(id: string): string {
    let root = id;
    while (this.parent.get(root) !== undefined && this.parent.get(root) !== root) root = this.parent.get(root)!;
    // Path compression.
    let cursor = id;
    while (cursor !== root) {
      const next = this.parent.get(cursor)!;
      this.parent.set(cursor, root);
      cursor = next;
    }
    if (!this.parent.has(root)) this.parent.set(root, root);
    return root;
  }

  union(ids: readonly string[]): void {
    if (!ids.length) return;
    const root = this.find(ids[0]);
    for (const id of ids.slice(1)) this.parent.set(this.find(id), root);
  }

  rootOf(id: string): string {
    return this.find(id);
  }
}

function mentionedIds(item: { in_reply_to: string | null; references: readonly string[] }): string[] {
  const out: string[] = [];
  const reply = threadableId(item.in_reply_to);
  if (reply) out.push(reply);
  for (const ref of item.references) {
    const id = threadableId(ref);
    if (id) out.push(id);
  }
  return out;
}

function outcomeDiffers(request: MatchableRequest, outcome: MatchOutcome): boolean {
  const storedAt = ts(request.answered_at);
  const nextAt = ts(outcome.answered_at);
  return (
    (request.answer_source ?? "") !== outcome.answer_source ||
    storedAt !== nextAt ||
    (request.answered_reply_id ?? null) !== (outcome.answered_reply_id ?? null) ||
    (request.reply_count ?? 0) !== outcome.reply_count
  );
}

/** Deterministic: outcomes are ordered by request id; only CHANGED verdicts are
 * emitted (every UPDATE bumps updated_at and re-syncs the row to ClickHouse —
 * a no-op storm would multiply row versions for nothing). */
export function matchReplies(
  requests: readonly MatchableRequest[],
  replies: readonly MatchableReply[],
  options: { clockSkewMs?: number; recipientWindowMs?: number } = {},
): MatchOutcome[] {
  const skew = options.clockSkewMs ?? MATCH_CLOCK_SKEW_MS;
  const window = options.recipientWindowMs ?? RECIPIENT_MATCH_WINDOW_MS;

  // Dedupe replies by normalized message id (UIDVALIDITY re-imports store the
  // same message twice under different uids) — keep the earliest sent copy.
  const byMessageId = new Map<string, MatchableReply>();
  const anonymous: MatchableReply[] = [];
  for (const reply of replies) {
    const id = threadableId(reply.normalized_message_id);
    if (!id) {
      anonymous.push(reply);
      continue;
    }
    const existing = byMessageId.get(id);
    if (!existing || (ts(reply.sent_at) ?? Infinity) < (ts(existing.sent_at) ?? Infinity)) {
      byMessageId.set(id, reply);
    }
  }
  const uniqueReplies = [...byMessageId.values(), ...anonymous];

  // Thread components over requests + replies.
  const threads = new ThreadIndex();
  const knownIds = new Set<string>();
  for (const request of requests) {
    const own = threadableId(request.message_id);
    if (own) knownIds.add(own);
    const ids = [...(own ? [own] : []), ...mentionedIds(request)];
    threads.union(ids);
  }
  for (const reply of uniqueReplies) {
    const own = threadableId(reply.normalized_message_id);
    if (own) knownIds.add(own);
    const ids = [...(own ? [own] : []), ...mentionedIds(reply)];
    threads.union(ids);
  }

  // Replies grouped by thread component root.
  const repliesByThread = new Map<string, MatchableReply[]>();
  for (const reply of uniqueReplies) {
    const anchor = threadableId(reply.normalized_message_id) ?? mentionedIds(reply)[0];
    if (!anchor) continue;
    const root = threads.rootOf(anchor);
    const bucket = repliesByThread.get(root);
    if (bucket) bucket.push(reply);
    else repliesByThread.set(root, [reply]);
  }

  const outcomes: MatchOutcome[] = [];
  const threadConsumedReplyIds = new Set<string>();
  const unansweredAfterThread: MatchableRequest[] = [];

  // Tier 'thread'.
  for (const request of requests) {
    const anchor = threadableId(request.message_id) ?? mentionedIds(request)[0];
    const receivedAt = ts(request.received_at);
    const candidates = anchor && receivedAt !== null
      ? (repliesByThread.get(threads.rootOf(anchor)) ?? []).filter((reply) => {
          const sentAt = ts(reply.sent_at);
          return sentAt !== null && sentAt >= receivedAt - skew;
        })
      : [];
    if (!candidates.length) {
      unansweredAfterThread.push(request);
      continue;
    }
    candidates.sort((a, b) => (ts(a.sent_at) ?? 0) - (ts(b.sent_at) ?? 0));
    for (const reply of candidates) threadConsumedReplyIds.add(reply.id);
    const earliest = candidates[0];
    const outcome: MatchOutcome = {
      request_id: request.id,
      answered_at: new Date(ts(earliest.sent_at)!).toISOString(),
      answer_source: "thread",
      answered_reply_id: earliest.id,
      reply_count: candidates.length,
    };
    if (outcomeDiffers(request, outcome)) outcomes.push(outcome);
  }

  // Tier 'recipient': a Sent mail to the same customer, after the request,
  // inside the window. One reply closes EVERY earlier open request of that
  // customer — answering a person answers their pending emails.
  const recipientReplies = uniqueReplies.filter((reply) => !threadConsumedReplyIds.has(reply.id) && ts(reply.sent_at) !== null);
  const repliesByRecipient = new Map<string, MatchableReply[]>();
  for (const reply of recipientReplies) {
    for (const email of reply.to_emails) {
      const key = email.trim().toLowerCase();
      if (!key) continue;
      const bucket = repliesByRecipient.get(key);
      if (bucket) bucket.push(reply);
      else repliesByRecipient.set(key, [reply]);
    }
  }
  const stillOpen: MatchableRequest[] = [];
  for (const request of unansweredAfterThread) {
    const email = (request.normalized_email ?? "").trim().toLowerCase();
    const receivedAt = ts(request.received_at);
    const candidates = email && receivedAt !== null
      ? (repliesByRecipient.get(email) ?? []).filter((reply) => {
          const sentAt = ts(reply.sent_at)!;
          return sentAt >= receivedAt - skew && sentAt - receivedAt <= window;
        })
      : [];
    if (!candidates.length) {
      stillOpen.push(request);
      continue;
    }
    candidates.sort((a, b) => (ts(a.sent_at) ?? 0) - (ts(b.sent_at) ?? 0));
    const earliest = candidates[0];
    const outcome: MatchOutcome = {
      request_id: request.id,
      answered_at: new Date(ts(earliest.sent_at)!).toISOString(),
      answer_source: "recipient",
      answered_reply_id: earliest.id,
      reply_count: candidates.length,
    };
    if (outcomeDiffers(request, outcome)) outcomes.push(outcome);
  }

  // Tier 'imap_flag': the mail server says an answer was sent, we just cannot
  // see it (deleted Sent copy, external client). No timestamp.
  const flaggedOpen: MatchableRequest[] = [];
  for (const request of stillOpen) {
    const answeredFlag = request.imap_flags.some((flag) => flag.trim().toLowerCase() === "answered");
    if (!answeredFlag) {
      flaggedOpen.push(request);
      continue;
    }
    const outcome: MatchOutcome = {
      request_id: request.id,
      answered_at: null,
      answer_source: "imap_flag",
      answered_reply_id: null,
      reply_count: 0,
    };
    if (outcomeDiffers(request, outcome)) outcomes.push(outcome);
  }

  // Tier 'customer_reply': a LATER inbound message in the same thread points at
  // a message id we have never seen (neither a request nor a stored reply) —
  // the customer answered OUR mail whose Sent copy is unavailable.
  const requestsByThread = new Map<string, MatchableRequest[]>();
  for (const request of requests) {
    const anchor = threadableId(request.message_id) ?? mentionedIds(request)[0];
    if (!anchor) continue;
    const root = threads.rootOf(anchor);
    const bucket = requestsByThread.get(root);
    if (bucket) bucket.push(request);
    else requestsByThread.set(root, [request]);
  }
  for (const request of flaggedOpen) {
    const anchor = threadableId(request.message_id) ?? mentionedIds(request)[0];
    const receivedAt = ts(request.received_at);
    if (!anchor || receivedAt === null) continue;
    const email = (request.normalized_email ?? "").trim().toLowerCase();
    const peers = requestsByThread.get(threads.rootOf(anchor)) ?? [];
    const evidence = peers.some((peer) => {
      if (peer.id === request.id) return false;
      const peerAt = ts(peer.received_at);
      if (peerAt === null || peerAt <= receivedAt) return false;
      if ((peer.normalized_email ?? "").trim().toLowerCase() !== email || !email) return false;
      const parent = threadableId(peer.in_reply_to);
      return Boolean(parent) && !knownIds.has(parent!);
    });
    if (!evidence) continue;
    const outcome: MatchOutcome = {
      request_id: request.id,
      answered_at: null,
      answer_source: "customer_reply",
      answered_reply_id: null,
      reply_count: 0,
    };
    if (outcomeDiffers(request, outcome)) outcomes.push(outcome);
  }

  return outcomes.sort((a, b) => a.request_id.localeCompare(b.request_id));
}

// ---- Orchestrator -----------------------------------------------------------

const PAGE_SIZE = 1000; // PostgREST max-rows cap; page instead of trusting one read.
const APPLY_CHUNK = 500;

export interface ReplyMatchingResult {
  requests_considered: number;
  replies_considered: number;
  outcomes: number;
  applied: number;
}

type Row = Record<string, unknown>;

function s(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => s(item)).filter(Boolean) : [];
}

async function readAllPages(fetchPage: (from: number, to: number) => PromiseLike<{ data?: unknown; error?: { message: string } | null }>): Promise<Row[]> {
  const rows: Row[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await fetchPage(offset, offset + PAGE_SIZE - 1);
    if (error) throw new Error(`Reply matching read failed: ${error.message}`);
    const page = (data as Row[] | null) ?? [];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
}

/** Loads requests + replies, runs the pure matcher, applies changed verdicts
 * through the support_apply_answer_matches RPC (one call per 500 rows).
 * mode "incremental" re-examines only recent, non-terminal rows (hourly tick);
 * mode "full" walks everything (once, after the Sent backfill). */
export async function runReplyMatching(input: {
  supabase: SupabaseLikeClient;
  authUserId: string;
  mode: "incremental" | "full";
  now?: Date;
}): Promise<ReplyMatchingResult> {
  const now = input.now ?? new Date();
  const sinceIso = new Date(now.getTime() - 90 * 86_400_000).toISOString();

  const requestRows = await readAllPages((from, to) => {
    let query = input.supabase
      .from("support_requests")
      .select("id,message_id,in_reply_to,references_json,received_at,normalized_email,imap_flags,answered_at,answer_source,answered_reply_id,reply_count")
      .eq("auth_user_id", input.authUserId)
      .eq("source_type", "imap")
      .or("answer_source.is.null,answer_source.neq.thread")
      .order("received_at", { ascending: true });
    if (input.mode === "incremental") {
      if (!query.gte) throw new Error("Reply matching requires gte() filter support.");
      query = query.gte("received_at", sinceIso);
    }
    if (!query.range) throw new Error("Reply matching requires range() pagination support.");
    return query.range(from, to);
  });

  const replyRows = await readAllPages((from, to) => {
    const query = input.supabase
      .from("support_replies")
      .select("id,normalized_message_id,in_reply_to,references_json,to_emails,sent_at")
      .eq("auth_user_id", input.authUserId)
      .order("sent_at", { ascending: true });
    if (!query.range) throw new Error("Reply matching requires range() pagination support.");
    return query.range(from, to);
  });

  const requests: MatchableRequest[] = requestRows.map((row) => ({
    id: s(row.id),
    message_id: s(row.message_id) || null,
    in_reply_to: s(row.in_reply_to) || null,
    references: stringArray(row.references_json),
    received_at: s(row.received_at),
    normalized_email: s(row.normalized_email) || null,
    imap_flags: stringArray(row.imap_flags),
    answered_at: s(row.answered_at) || null,
    answer_source: s(row.answer_source) || null,
    answered_reply_id: s(row.answered_reply_id) || null,
    reply_count: Number(row.reply_count ?? 0) || 0,
  }));
  const replies: MatchableReply[] = replyRows.map((row) => ({
    id: s(row.id),
    normalized_message_id: s(row.normalized_message_id) || null,
    in_reply_to: s(row.in_reply_to) || null,
    references: stringArray(row.references_json),
    to_emails: stringArray(row.to_emails),
    sent_at: s(row.sent_at) || null,
  }));

  const outcomes = matchReplies(requests, replies);

  let applied = 0;
  for (let index = 0; index < outcomes.length; index += APPLY_CHUNK) {
    const chunk = outcomes.slice(index, index + APPLY_CHUNK).map((outcome) => ({
      id: outcome.request_id,
      answered_at: outcome.answered_at,
      answer_source: outcome.answer_source,
      answered_reply_id: outcome.answered_reply_id,
      reply_count: outcome.reply_count,
    }));
    if (!input.supabase.rpc) throw new Error("Reply matching requires rpc() support.");
    const { data, error } = await input.supabase.rpc("support_apply_answer_matches", {
      p_auth_user_id: input.authUserId,
      p_matches: chunk,
    });
    if (error) throw new Error(`Could not apply answer matches: ${error.message}`);
    applied += Number(data ?? 0) || 0;
  }

  return {
    requests_considered: requests.length,
    replies_considered: replies.length,
    outcomes: outcomes.length,
    applied,
  };
}
