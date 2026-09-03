// The reply matcher: which support requests count as answered, from which
// signal, and with what first-response time. Tier precedence, thread grouping,
// id-normalization asymmetry and no-op suppression are all load-bearing.
import { describe, expect, it } from "vitest";
import {
  matchReplies,
  type MatchableReply,
  type MatchableRequest,
} from "@/services/supportReplyMatching";

function request(over: Partial<MatchableRequest> = {}): MatchableRequest {
  return {
    id: over.id ?? "r1",
    message_id: "<Req-1@Customer.Example>",
    in_reply_to: null,
    references: [],
    received_at: "2026-09-01T10:00:00.000Z",
    normalized_email: "client@example.com",
    imap_flags: ["Seen"],
    answered_at: null,
    answer_source: null,
    answered_reply_id: null,
    reply_count: 0,
    ...over,
  };
}

function reply(over: Partial<MatchableReply> = {}): MatchableReply {
  return {
    id: over.id ?? "s1",
    normalized_message_id: "reply-1@support",
    in_reply_to: "req-1@customer.example",
    references: ["req-1@customer.example"],
    to_emails: ["client@example.com"],
    sent_at: "2026-09-01T12:00:00.000Z",
    ...over,
  };
}

describe("tier thread", () => {
  it("matches by in_reply_to despite raw-vs-normalized message id forms", () => {
    const outcomes = matchReplies([request()], [reply()]);
    expect(outcomes).toEqual([
      { request_id: "r1", answered_at: "2026-09-01T12:00:00.000Z", answer_source: "thread", answered_reply_id: "s1", reply_count: 1 },
    ]);
  });

  it("matches by references when in_reply_to is missing", () => {
    const outcomes = matchReplies(
      [request()],
      [reply({ in_reply_to: null, references: ["other@x", "req-1@customer.example"] })],
    );
    expect(outcomes[0]?.answer_source).toBe("thread");
  });

  it("thread group: an answer to the customer's LAST mail answers the earlier ones too", () => {
    const first = request({ id: "r1", message_id: "<a@c>", received_at: "2026-09-01T10:00:00.000Z" });
    const second = request({
      id: "r2",
      message_id: "<b@c>",
      in_reply_to: "a@c",
      references: ["a@c"],
      received_at: "2026-09-02T10:00:00.000Z",
    });
    const answer = reply({ in_reply_to: "b@c", references: ["a@c", "b@c"], sent_at: "2026-09-02T11:00:00.000Z" });
    const outcomes = matchReplies([first, second], [answer]);
    expect(outcomes.map((o) => [o.request_id, o.answer_source])).toEqual([
      ["r1", "thread"],
      ["r2", "thread"],
    ]);
  });

  it("uses the EARLIEST reply for answered_at and counts all thread replies", () => {
    const outcomes = matchReplies(
      [request()],
      [
        reply({ id: "s2", normalized_message_id: "reply-2@support", sent_at: "2026-09-03T09:00:00.000Z" }),
        reply({ id: "s1", sent_at: "2026-09-01T12:00:00.000Z" }),
      ],
    );
    expect(outcomes[0]).toMatchObject({ answered_at: "2026-09-01T12:00:00.000Z", answered_reply_id: "s1", reply_count: 2 });
  });

  it("tolerates small clock skew but rejects replies clearly before the request", () => {
    const skewed = matchReplies([request()], [reply({ sent_at: "2026-09-01T09:57:00.000Z" })]);
    expect(skewed[0]?.answer_source).toBe("thread");
    const before = matchReplies([request()], [reply({ sent_at: "2026-09-01T09:00:00.000Z" })]);
    expect(before.find((o) => o.answer_source === "thread")).toBeUndefined();
  });

  it("dedupes UIDVALIDITY re-imported copies of the same reply", () => {
    const outcomes = matchReplies(
      [request()],
      [reply({ id: "s1" }), reply({ id: "s1b" })],
    );
    expect(outcomes[0]?.reply_count).toBe(1);
  });

  it("never joins threads through synthetic imap: ids", () => {
    const outcomes = matchReplies(
      [request({ message_id: "imap:42" })],
      [reply({ in_reply_to: "imap:42", references: [] })],
    );
    expect(outcomes.find((o) => o.answer_source === "thread")).toBeUndefined();
  });
});

describe("tier recipient", () => {
  it("falls back to a Sent mail addressed to the customer after the request", () => {
    const outcomes = matchReplies(
      [request()],
      [reply({ in_reply_to: null, references: [], sent_at: "2026-09-02T10:00:00.000Z" })],
    );
    expect(outcomes[0]).toMatchObject({ answer_source: "recipient", answered_at: "2026-09-02T10:00:00.000Z" });
  });

  it("one fresh reply closes every earlier open request of that customer", () => {
    const outcomes = matchReplies(
      [
        request({ id: "r1", message_id: "<a@c>", received_at: "2026-09-01T10:00:00.000Z" }),
        request({ id: "r2", message_id: "<b@c>", received_at: "2026-09-03T10:00:00.000Z" }),
      ],
      [reply({ in_reply_to: null, references: [], sent_at: "2026-09-04T10:00:00.000Z" })],
    );
    expect(outcomes.map((o) => [o.request_id, o.answer_source])).toEqual([
      ["r1", "recipient"],
      ["r2", "recipient"],
    ]);
  });

  it("respects the 14-day window", () => {
    const outcomes = matchReplies(
      [request()],
      [reply({ in_reply_to: null, references: [], sent_at: "2026-09-20T10:00:00.000Z" })],
    );
    expect(outcomes.find((o) => o.answer_source === "recipient")).toBeUndefined();
  });

  it("does not reuse a reply already consumed by a thread match", () => {
    const threaded = request({ id: "r1", message_id: "<a@c>", normalized_email: "client@example.com" });
    const stranger = request({ id: "r2", message_id: "<z@c>", normalized_email: "client@example.com", received_at: "2026-09-01T09:00:00.000Z" });
    const outcomes = matchReplies([threaded, stranger], [reply({ in_reply_to: "a@c", references: ["a@c"] })]);
    expect(outcomes.find((o) => o.request_id === "r2")).toBeUndefined();
  });
});

describe("tiers imap_flag and customer_reply", () => {
  it("flag Answered marks the request answered with no timestamp", () => {
    const outcomes = matchReplies([request({ imap_flags: ["Seen", "Answered"] })], []);
    expect(outcomes).toEqual([
      { request_id: "r1", answered_at: null, answer_source: "imap_flag", answered_reply_id: null, reply_count: 0 },
    ]);
  });

  it("a later customer mail replying to an UNKNOWN id proves our lost answer", () => {
    const first = request({ id: "r1", message_id: "<a@c>", received_at: "2026-09-01T10:00:00.000Z" });
    const followUp = request({
      id: "r2",
      message_id: "<b@c>",
      in_reply_to: "our-lost-answer@support",
      references: ["a@c", "our-lost-answer@support"],
      received_at: "2026-09-02T10:00:00.000Z",
    });
    const outcomes = matchReplies([first, followUp], []);
    expect(outcomes.find((o) => o.request_id === "r1")?.answer_source).toBe("customer_reply");
  });

  it("two customer mails in one thread WITHOUT our answer stay unanswered", () => {
    const first = request({ id: "r1", message_id: "<a@c>" });
    const second = request({
      id: "r2",
      message_id: "<b@c>",
      in_reply_to: "a@c",
      references: ["a@c"],
      received_at: "2026-09-02T10:00:00.000Z",
    });
    expect(matchReplies([first, second], [])).toEqual([]);
  });
});

describe("re-matching discipline", () => {
  it("emits nothing when the stored verdict already matches (no-op suppression)", () => {
    const answered = request({
      answered_at: "2026-09-01T12:00:00.000Z",
      answer_source: "thread",
      answered_reply_id: "s1",
      reply_count: 1,
    });
    expect(matchReplies([answered], [reply()])).toEqual([]);
  });

  it("upgrades imap_flag to thread when the Sent backfill arrives", () => {
    const flagged = request({ answer_source: "imap_flag", imap_flags: ["Answered"] });
    const outcomes = matchReplies([flagged], [reply()]);
    expect(outcomes[0]).toMatchObject({ answer_source: "thread", answered_at: "2026-09-01T12:00:00.000Z" });
  });

  it("is deterministic under input order", () => {
    const requests = [
      request({ id: "r1", message_id: "<a@c>" }),
      request({ id: "r2", message_id: "<b@c>", normalized_email: "other@example.com" }),
    ];
    const replies = [
      reply({ id: "s1", in_reply_to: "a@c", references: ["a@c"] }),
      reply({ id: "s2", normalized_message_id: "reply-2@support", in_reply_to: "b@c", references: ["b@c"], to_emails: ["other@example.com"] }),
    ];
    const forward = matchReplies(requests, replies);
    const reversed = matchReplies([...requests].reverse(), [...replies].reverse());
    expect(reversed).toEqual(forward);
  });
});
