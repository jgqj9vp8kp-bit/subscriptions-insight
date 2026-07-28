// Staleness of the ClickHouse parity-validation verdict.
//
// Live case that prompted this (2026-07-28): the Integrations panel showed a red
// "Validation FAIL · 29,479 source rows · missing 258" with no timestamp. The run
// was actually from 2026-07-14 and the source had grown to 37,036 rows since, so the
// verdict described a warehouse that no longer existed.
import { describe, expect, it } from "vitest";
import { validationStaleness, VALIDATION_STALE_AFTER_MS } from "@/services/validationStaleness";

const NOW = Date.parse("2026-07-28T12:00:00.000Z");

describe("validationStaleness", () => {
  it("flags the live case: two weeks old and the source has grown", () => {
    const result = validationStaleness({
      completedAt: "2026-07-14T12:23:31.000Z",
      status: "completed",
      validatedRows: 29_479,
      currentSourceRows: 37_036,
      now: NOW,
    });
    expect(result).not.toBeNull();
    expect(result?.sourceGrew).toBe(true);
    // 13 d 23 h — floored, and the exact instant is rendered next to the label.
    expect(result?.ageLabel).toBe("13 days ago");
    expect(result?.validatedRows).toBe(29_479);
    expect(result?.currentRows).toBe(37_036);
  });

  it("flags a fresh run whose source has already moved on", () => {
    const result = validationStaleness({
      completedAt: new Date(NOW - 60_000).toISOString(),
      status: "completed",
      validatedRows: 100,
      currentSourceRows: 120,
      now: NOW,
    });
    expect(result?.sourceGrew).toBe(true);
    expect(result?.ageLabel).toBe("1 min ago");
  });

  it("stays silent for a recent run over an unchanged source", () => {
    expect(validationStaleness({
      completedAt: new Date(NOW - 60 * 60 * 1000).toISOString(),
      status: "completed",
      validatedRows: 37_036,
      currentSourceRows: 37_036,
      now: NOW,
    })).toBeNull();
  });

  it("flags an old run even when the source has not changed", () => {
    const result = validationStaleness({
      completedAt: new Date(NOW - VALIDATION_STALE_AFTER_MS - 1000).toISOString(),
      status: "completed",
      validatedRows: 37_036,
      currentSourceRows: 37_036,
      now: NOW,
    });
    expect(result).not.toBeNull();
    expect(result?.sourceGrew).toBe(false);
  });

  it("says nothing when validation never ran or is still in flight", () => {
    expect(validationStaleness({ status: "never_started", now: NOW })).toBeNull();
    expect(validationStaleness({
      startedAt: "2026-07-14T12:22:00.000Z",
      status: "running",
      now: NOW,
    })).toBeNull();
  });

  it("falls back to started_at and ignores an unparsable instant", () => {
    expect(validationStaleness({
      startedAt: "2026-07-14T12:22:00.000Z", status: "completed", now: NOW,
    })?.at).toBe("2026-07-14T12:22:00.000Z");
    expect(validationStaleness({ completedAt: "not-a-date", status: "completed", now: NOW })).toBeNull();
  });

  it("does not treat a shrinking source as growth, and never reports a negative age", () => {
    expect(validationStaleness({
      completedAt: new Date(NOW - 1000).toISOString(),
      status: "completed", validatedRows: 500, currentSourceRows: 400, now: NOW,
    })).toBeNull();
    const future = validationStaleness({
      completedAt: new Date(NOW + 60_000).toISOString(),
      status: "completed", validatedRows: 1, currentSourceRows: 2, now: NOW,
    });
    expect(future?.ageMs).toBe(0);
  });
});
