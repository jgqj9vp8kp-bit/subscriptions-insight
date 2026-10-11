// parseDeclineReasons: the Primer `declineReasons` cell (Python repr of a list
// of dicts, or JSON) -> DeclineRecord[]. Every fixture below is synthetic: the
// shapes (quoting, None/True/False, escapes, cascades) are the ones the live
// export uses, the values are made up.
import { describe, expect, it } from "vitest";
import {
  DECLINE_RECORD_FIELDS,
  declineTypeFromAdvisedAction,
  finalDeclineRecord,
  parseDeclineReasons,
} from "../../supabase/functions/_shared/clickhouse/declineReasons.ts";

const PY_ONE =
  "[{'decline_reason': 'INSUFFICIENT_FUNDS', 'message': 'Insufficient Funds', 'payment_method_result_code': '51', " +
  "'payment_method_result_message': 'Insufficient funds', 'payment_method_advice_code': None, 'payment_method_advice_message': None, " +
  "'advised_action': 'RETRY_LATER', 'transaction_lifecycle_event': 'AUTHORIZATION_DECLINED', 'transaction_type': 'SALE', " +
  "'created_at': '2026-05-01T10:00:00.000000Z'}]";

describe("parseDeclineReasons: Python repr", () => {
  it("parses one single-quoted record with None values as ''", () => {
    const records = parseDeclineReasons(PY_ONE);
    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record.decline_reason).toBe("INSUFFICIENT_FUNDS");
    expect(record.payment_method_result_code).toBe("51");
    expect(record.payment_method_advice_code).toBe("");
    expect(record.payment_method_advice_message).toBe("");
    expect(record.advised_action).toBe("RETRY_LATER");
    expect(record.transaction_lifecycle_event).toBe("AUTHORIZATION_DECLINED");
    expect(record.transaction_type).toBe("SALE");
    expect(record.created_at).toBe("2026-05-01T10:00:00.000000Z");
    // every known field is present on every record
    for (const field of DECLINE_RECORD_FIELDS) expect(typeof record[field]).toBe("string");
  });

  it("double-quoted strings (an apostrophe inside), commas inside values, True/False", () => {
    const text =
      "[{'decline_reason': 'DO_NOT_HONOR', 'message': \"Card's issuer said no, try another\", 'payment_method_result_code': '05', " +
      "'payment_method_result_message': 'Do not honor', 'payment_method_advice_code': '01', 'payment_method_advice_message': 'New account information available', " +
      "'advised_action': 'UPDATE_DATA', 'transaction_lifecycle_event': 'AUTHORIZATION_DECLINED', 'transaction_type': True, 'created_at': False}]";
    const [record] = parseDeclineReasons(text);
    expect(record.message).toBe("Card's issuer said no, try another");
    expect(record.payment_method_advice_message).toBe("New account information available");
    expect(record.transaction_type).toBe("true");
    expect(record.created_at).toBe("false");
  });

  it("escaped quotes inside single-quoted strings and \\x / \\u escapes", () => {
    const text = "[{'decline_reason': 'ERROR', 'message': 'It\\'s \"both\" \\x41\\u00e9', 'advised_action': None}]";
    const [record] = parseDeclineReasons(text);
    expect(record.message).toBe("It's \"both\" Aé");
    expect(record.decline_reason).toBe("ERROR");
  });

  it("keeps several records in export order (cascade / retry inside one payment)", () => {
    const text =
      "[{'decline_reason': 'ISSUER_TEMPORARILY_UNAVAILABLE', 'advised_action': 'RETRY_LATER', 'transaction_lifecycle_event': 'AUTHORIZATION_FAILED', 'created_at': None}, " +
      "{'decline_reason': 'LOST_OR_STOLEN_CARD', 'payment_method_result_code': '41', 'advised_action': 'STOP_ALL_PAYMENTS', 'transaction_lifecycle_event': 'AUTHORIZATION_DECLINED', 'created_at': None}]";
    const records = parseDeclineReasons(text);
    expect(records.map((record) => record.decline_reason)).toEqual(["ISSUER_TEMPORARILY_UNAVAILABLE", "LOST_OR_STOLEN_CARD"]);
    const last = finalDeclineRecord(records);
    expect(last?.advised_action).toBe("STOP_ALL_PAYMENTS");
    expect(last?.payment_method_result_code).toBe("41");
    expect(finalDeclineRecord([])).toBeNull();
  });

  it("empty forms yield no records", () => {
    for (const empty of ["", "   ", "[]", "null", "None", "{}", null, undefined]) {
      expect(parseDeclineReasons(empty)).toEqual([]);
    }
  });

  it("ignores unknown keys and numbers become their text", () => {
    const [record] = parseDeclineReasons("[{'decline_reason': 'ERROR', 'something_else': 'x', 'payment_method_result_code': 62}]");
    expect(record.decline_reason).toBe("ERROR");
    expect(record.payment_method_result_code).toBe("62");
    expect("something_else" in record).toBe(false);
  });
});

describe("parseDeclineReasons: JSON and parsed input", () => {
  it("parses a JSON list and a JSON object", () => {
    const list = parseDeclineReasons(JSON.stringify([{ decline_reason: "EXPIRED_CARD", advised_action: "UPDATE_DATA", created_at: null }]));
    expect(list).toHaveLength(1);
    expect(list[0].decline_reason).toBe("EXPIRED_CARD");
    expect(list[0].created_at).toBe("");
    const single = parseDeclineReasons({ decline_reason: "DO_NOT_HONOR" });
    expect(single).toHaveLength(1);
    expect(single[0].decline_reason).toBe("DO_NOT_HONOR");
  });

  it("accepts an already-parsed array", () => {
    expect(parseDeclineReasons([{ decline_reason: "A" }, { decline_reason: "B" }]).map((record) => record.decline_reason)).toEqual(["A", "B"]);
  });

  it("never throws on garbage: falls back to the quote-anchored extraction", () => {
    // Truncated repr (a cut-off cell): the fields before the cut are kept.
    const truncated = "[{'decline_reason': 'INSUFFICIENT_FUNDS', 'payment_method_result_code': '51', 'advised_action': 'RETRY_LA";
    const [record] = parseDeclineReasons(truncated);
    expect(record.decline_reason).toBe("INSUFFICIENT_FUNDS");
    expect(record.payment_method_result_code).toBe("51");
    expect(parseDeclineReasons("not a list at all")).toEqual([]);
    expect(parseDeclineReasons(42)).toEqual([]);
  });
});

describe("declineTypeFromAdvisedAction", () => {
  it("maps the four Primer advised actions and nothing else", () => {
    expect(declineTypeFromAdvisedAction("RETRY_LATER")).toBe("soft");
    expect(declineTypeFromAdvisedAction("DO_NOT_RETRY")).toBe("hard");
    expect(declineTypeFromAdvisedAction("STOP_ALL_PAYMENTS")).toBe("hard");
    expect(declineTypeFromAdvisedAction("UPDATE_DATA")).toBe("update");
    expect(declineTypeFromAdvisedAction(" retry-later ")).toBe("soft");
    expect(declineTypeFromAdvisedAction("")).toBe("");
    expect(declineTypeFromAdvisedAction(null)).toBe("");
    expect(declineTypeFromAdvisedAction("SOMETHING_NEW")).toBe("");
  });
});
