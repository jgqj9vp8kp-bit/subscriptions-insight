import { describe, expect, it } from "vitest";
import { formatDateKey, toDateKey } from "@/services/dateKeys";

describe("date key helpers", () => {
  it("keeps ISO timestamps as date-only keys without timezone shifts", () => {
    expect(toDateKey("2026-04-20T23:30:00Z")).toBe("2026-04-20");
    expect(toDateKey("2026-04-21T00:15:00Z")).toBe("2026-04-21");
  });

  it("matches only the selected inclusive date range", () => {
    const fromDate = toDateKey("2026-04-20");
    const toDate = toDateKey("2026-04-20");
    const matchesRange = (firstTrial: string) => {
      const firstTrialDate = toDateKey(firstTrial);
      return firstTrialDate >= fromDate && firstTrialDate <= toDate;
    };

    expect(matchesRange("2026-04-20T12:00:00Z")).toBe(true);
    expect(matchesRange("2026-04-21T00:00:00Z")).toBe(false);
  });

  it("formats displayed dates as DD.MM.YYYY", () => {
    expect(formatDateKey("2026-04-20T12:00:00Z")).toBe("20.04.2026");
  });
});
