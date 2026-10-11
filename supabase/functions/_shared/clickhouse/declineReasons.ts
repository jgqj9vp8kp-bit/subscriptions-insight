// Primer `declineReasons` parser (Payment health P0, plan G / T).
//
// The Primer CSV exports the decline records of a payment as ONE text cell that
// is the Python repr of a list of dicts, e.g.
//   [{'decline_reason': 'INSUFFICIENT_FUNDS', 'message': "Card's limit", 'created_at': None, ...}]
// — single-quoted strings (double-quoted when the value holds an apostrophe,
// backslash-escaped when it holds both), None / True / False literals, nested
// commas inside messages, and 362 live rows carry more than one record (a
// cascade or a retry inside the same payment). Real JSON ('[]', 'null', or a
// JSON-encoded list) appears too. JSON.parse rejects the Python form, and the
// regex extraction users.ts / paymentFailures.ts use at query time cannot keep
// the fields of one record together once a value contains a quote or a comma.
//
// This module is PURE (no Deno globals): the ClickHouse mapper imports it and
// vitest tests it directly. A string that is neither JSON nor Python literal
// syntax falls back to the quote-anchored field extraction, so the mapper
// never throws on a malformed cell — it degrades to whatever fields it can
// read, exactly like the query-time regexes do today.

export const DECLINE_RECORD_FIELDS = [
  "decline_reason",
  "message",
  "payment_method_result_code",
  "payment_method_result_message",
  "payment_method_advice_code",
  "payment_method_advice_message",
  "advised_action",
  "transaction_lifecycle_event",
  "transaction_type",
  "created_at",
] as const;

export type DeclineRecordField = (typeof DECLINE_RECORD_FIELDS)[number];

/** One decline record with every known field present ('' when the export
 * holds None / an empty string / no such key). Python True / False become
 * 'true' / 'false'; numbers their decimal text. */
export type DeclineRecord = Record<DeclineRecordField, string>;

/** `decline_type` of a decline record, derived from Primer's advised_action
 * (plan G `decline_mix`: soft / hard by advised_action). Documented mapping:
 *   RETRY_LATER                      -> 'soft'   (temporary: funds, issuer down)
 *   DO_NOT_RETRY, STOP_ALL_PAYMENTS  -> 'hard'   (retrying breaks network rules)
 *   UPDATE_DATA                      -> 'update' (expired card, wrong details)
 *   anything else / absent           -> ''
 * It is a derived label, never a provider field: Primer's own SOFT / HARD
 * declineType lives in the Payments API, not in the CSV. */
export type DeclineType = "soft" | "hard" | "update" | "";

export function declineTypeFromAdvisedAction(advisedAction: string | null | undefined): DeclineType {
  const action = String(advisedAction ?? "").trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (action === "RETRY_LATER") return "soft";
  if (action === "DO_NOT_RETRY" || action === "STOP_ALL_PAYMENTS") return "hard";
  if (action === "UPDATE_DATA") return "update";
  return "";
}

function emptyRecord(): DeclineRecord {
  const record = {} as DeclineRecord;
  for (const field of DECLINE_RECORD_FIELDS) record[field] = "";
  return record;
}

const FIELD_BY_NORMALIZED_KEY = new Map<string, DeclineRecordField>(
  DECLINE_RECORD_FIELDS.map((field) => [normalizeKey(field), field]),
);

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Scalar -> stored text. null/undefined (Python None, JSON null) -> ''. */
function scalarText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "string") return value.trim();
  // A nested list / dict inside a record field: keep its JSON so nothing is
  // silently dropped; the known fields are scalars in every live row.
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function recordFromObject(value: unknown): DeclineRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = emptyRecord();
  let known = 0;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const field = FIELD_BY_NORMALIZED_KEY.get(normalizeKey(key));
    if (!field) continue;
    known += 1;
    record[field] = scalarText(entry);
  }
  return known ? record : null;
}

function recordsFromValue(value: unknown): DeclineRecord[] {
  if (Array.isArray(value)) {
    return value.map(recordFromObject).filter((record): record is DeclineRecord => record !== null);
  }
  const single = recordFromObject(value);
  return single ? [single] : [];
}

// ---- Python / JSON literal parser --------------------------------------------
//
// Recursive descent over the literal subset both syntaxes share: lists, dicts
// (string keys), strings in either quote with backslash escapes, numbers, and
// the literals None/True/False/null/true/false. Anything else throws, and the
// caller falls back to the lenient extraction below.

class LiteralParser {
  private index = 0;

  constructor(private readonly text: string) {}

  parse(): unknown {
    this.skipWhitespace();
    const value = this.value();
    this.skipWhitespace();
    if (this.index !== this.text.length) throw new SyntaxError(`trailing input at ${this.index}`);
    return value;
  }

  private peek(): string {
    return this.text[this.index] ?? "";
  }

  private skipWhitespace(): void {
    while (this.index < this.text.length && /\s/.test(this.text[this.index])) this.index += 1;
  }

  private expect(char: string): void {
    if (this.peek() !== char) throw new SyntaxError(`expected ${char} at ${this.index}`);
    this.index += 1;
  }

  private value(): unknown {
    const char = this.peek();
    if (char === "[") return this.list();
    if (char === "{") return this.dict();
    if (char === "'" || char === "\"") return this.string();
    if (char === "-" || char === "+" || (char >= "0" && char <= "9")) return this.number();
    return this.word();
  }

  private list(): unknown[] {
    this.expect("[");
    const items: unknown[] = [];
    this.skipWhitespace();
    if (this.peek() === "]") {
      this.index += 1;
      return items;
    }
    for (;;) {
      this.skipWhitespace();
      items.push(this.value());
      this.skipWhitespace();
      const char = this.peek();
      if (char === ",") {
        this.index += 1;
        this.skipWhitespace();
        if (this.peek() === "]") { // Python tolerates a trailing comma
          this.index += 1;
          return items;
        }
        continue;
      }
      this.expect("]");
      return items;
    }
  }

  private dict(): Record<string, unknown> {
    this.expect("{");
    const out: Record<string, unknown> = {};
    this.skipWhitespace();
    if (this.peek() === "}") {
      this.index += 1;
      return out;
    }
    for (;;) {
      this.skipWhitespace();
      const keyChar = this.peek();
      const key = keyChar === "'" || keyChar === "\"" ? this.string() : scalarText(this.value());
      this.skipWhitespace();
      this.expect(":");
      this.skipWhitespace();
      out[key] = this.value();
      this.skipWhitespace();
      const char = this.peek();
      if (char === ",") {
        this.index += 1;
        this.skipWhitespace();
        if (this.peek() === "}") {
          this.index += 1;
          return out;
        }
        continue;
      }
      this.expect("}");
      return out;
    }
  }

  private string(): string {
    const quote = this.peek();
    this.index += 1;
    let out = "";
    while (this.index < this.text.length) {
      const char = this.text[this.index];
      if (char === quote) {
        this.index += 1;
        return out;
      }
      if (char === "\\") {
        out += this.escape();
        continue;
      }
      out += char;
      this.index += 1;
    }
    throw new SyntaxError("unterminated string");
  }

  /** Python and JSON share \\ \' \" \n \r \t \b \f \/ \xNN \uNNNN; an unknown
   * escape keeps the backslash like Python does (repr never emits one). */
  private escape(): string {
    const next = this.text[this.index + 1] ?? "";
    this.index += 2;
    switch (next) {
      case "n": return "\n";
      case "r": return "\r";
      case "t": return "\t";
      case "b": return "\b";
      case "f": return "\f";
      case "0": return "\0";
      case "\\": return "\\";
      case "'": return "'";
      case "\"": return "\"";
      case "/": return "/";
      case "x": {
        const hex = this.text.slice(this.index, this.index + 2);
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          this.index += 2;
          return String.fromCharCode(parseInt(hex, 16));
        }
        return "\\x";
      }
      case "u": {
        const hex = this.text.slice(this.index, this.index + 4);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          this.index += 4;
          return String.fromCharCode(parseInt(hex, 16));
        }
        return "\\u";
      }
      default:
        return `\\${next}`;
    }
  }

  private number(): number {
    const match = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(this.text.slice(this.index));
    if (!match) throw new SyntaxError(`bad number at ${this.index}`);
    this.index += match[0].length;
    return Number(match[0]);
  }

  private word(): unknown {
    const match = /^[A-Za-z_]+/.exec(this.text.slice(this.index));
    if (!match) throw new SyntaxError(`unexpected input at ${this.index}`);
    this.index += match[0].length;
    switch (match[0]) {
      case "None": case "null": return null;
      case "True": case "true": return true;
      case "False": case "false": return false;
      default: throw new SyntaxError(`unknown literal ${match[0]}`);
    }
  }
}

// ---- lenient fallback ---------------------------------------------------------

/** Field values in document order, found by their quoted key (either quote),
 * when the cell is not valid literal syntax. Records are rebuilt positionally
 * (the i-th value of every field belongs to the i-th record), which is what
 * the query-time regexes assume as well. */
function lenientRecords(text: string): DeclineRecord[] {
  const perField = new Map<DeclineRecordField, string[]>();
  for (const field of DECLINE_RECORD_FIELDS) {
    const values: string[] = [];
    const pattern = new RegExp(`["']${field}["']\\s*:\\s*(?:(["'])((?:\\\\.|(?!\\1)[^\\\\])*)\\1|(None|True|False|null|true|false|-?\\d+(?:\\.\\d+)?))`, "g");
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text))) {
      if (match[2] !== undefined) values.push(match[2].replace(/\\(['"\\])/g, "$1").trim());
      else values.push(scalarText(match[3] === "None" || match[3] === "null" ? null : match[3] === "True" || match[3] === "true" ? true : match[3] === "False" || match[3] === "false" ? false : Number(match[3])));
    }
    perField.set(field, values);
  }
  const length = Math.max(0, ...[...perField.values()].map((values) => values.length));
  return Array.from({ length }, (_, position) => {
    const record = emptyRecord();
    for (const field of DECLINE_RECORD_FIELDS) record[field] = perField.get(field)?.[position] ?? "";
    return record;
  });
}

/**
 * Every decline record of a Primer `declineReasons` cell, in export order.
 * Accepts the Python repr, JSON, an already-parsed array / object, and the
 * empty forms ('', '[]', 'null', 'None') which yield []. Never throws.
 */
export function parseDeclineReasons(source: unknown): DeclineRecord[] {
  if (source == null) return [];
  if (typeof source !== "string") return recordsFromValue(source);
  const text = source.trim();
  if (!text || text === "[]" || text === "{}" || text === "null" || text === "None") return [];
  try {
    return recordsFromValue(new LiteralParser(text).parse());
  } catch {
    return lenientRecords(text);
  }
}

/** The record that describes the payment's final outcome: the LAST one (a
 * cascade / retry inside one payment appends; the first record is the attempt
 * that was superseded). null when there is none. */
export function finalDeclineRecord(records: readonly DeclineRecord[]): DeclineRecord | null {
  return records.length ? records[records.length - 1] : null;
}
