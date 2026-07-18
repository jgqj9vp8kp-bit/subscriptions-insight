// Query-key + request normalization for the country filter/sort work: the list
// key includes country/sort/page, the summary key excludes the page, options
// are keyed by the filter scope MINUS country, and the decline bundle key
// includes country + reason/stage display filters + country sort (no page).

import { describe, expect, it } from "vitest";
import {
  normalizeUsersDeclineRequest,
  normalizeUsersRequest,
  usersDeclineKey,
  usersListKey,
  usersOptionsKey,
  usersSummaryKey,
} from "@/services/usersCache";
import { buildLegacyCountryOptions, buildUsersDeclineRequest, buildUsersRequest, type UsersDeclineQuery, type UsersQuery } from "@/services/usersDataSource";

const baseQuery = (overrides: Partial<UsersQuery> = {}): UsersQuery => ({
  search: "",
  firstTrialFrom: "",
  firstTrialTo: "",
  firstSub: "all",
  refund: "all",
  paymentFailed: "all",
  failedAttempts: "all",
  campaignPath: "all",
  country: "all",
  cardTypes: [],
  declineReasons: [],
  sortField: "first_trial_date",
  sortDir: "desc",
  page: 1,
  pageSize: 50,
  ...overrides,
});

const baseDecline = (overrides: Partial<UsersDeclineQuery> = {}): UsersDeclineQuery => ({
  search: "",
  firstSub: "all",
  refund: "all",
  paymentFailed: "all",
  failedAttempts: "all",
  campaignPath: "all",
  country: "all",
  cardTypes: [],
  declineReasons: [],
  analyticsReasons: [],
  analyticsStages: [],
  countrySortField: "total_attempts",
  countrySortDir: "desc",
  ...overrides,
});

const keyParts = { userScopeHash: "scope", warehouseVersion: "whv_1" };

describe("users list/summary keys with country", () => {
  it("list key includes country filter, sort field/direction, and page", () => {
    const key = usersListKey({ ...keyParts, request: baseQuery({ country: "US", sortField: "country_code", sortDir: "asc", page: 3 }) });
    const norm = key[4];
    expect(norm.country).toBe("US");
    expect(norm.sort).toEqual({ field: "country_code", direction: "asc" });
    expect(norm.page).toBe(3);
  });

  it("changing country / sort / page each changes the list key", () => {
    const a = JSON.stringify(usersListKey({ ...keyParts, request: baseQuery() }));
    expect(JSON.stringify(usersListKey({ ...keyParts, request: baseQuery({ country: "DE" }) }))).not.toBe(a);
    expect(JSON.stringify(usersListKey({ ...keyParts, request: baseQuery({ sortField: "country_code" }) }))).not.toBe(a);
    expect(JSON.stringify(usersListKey({ ...keyParts, request: baseQuery({ page: 2 }) }))).not.toBe(a);
  });

  it("All countries normalizes to an empty filter (same key as default)", () => {
    const all = usersListKey({ ...keyParts, request: baseQuery({ country: "all" }) });
    const dflt = usersListKey({ ...keyParts, request: baseQuery() });
    expect(JSON.stringify(all)).toBe(JSON.stringify(dflt));
    expect(all[4].country).toBeNull();
    expect(buildUsersRequest(baseQuery({ country: "all" })).filters?.country).toEqual([]);
    expect(buildUsersRequest(baseQuery({ country: "US" })).filters?.country).toEqual(["US"]);
  });

  it("summary key keeps the country filter but excludes the page", () => {
    const p1 = usersSummaryKey({ ...keyParts, request: baseQuery({ country: "US", page: 1 }) });
    const p2 = usersSummaryKey({ ...keyParts, request: baseQuery({ country: "US", page: 7 }) });
    expect(JSON.stringify(p1)).toBe(JSON.stringify(p2));
    expect(p1[4].country).toBe("US");
    expect(p1[4].page).toBeNull();
  });
});

describe("options key (dependent country options scope)", () => {
  it("ignores country, sort and page — same key when only those change", () => {
    const a = JSON.stringify(usersOptionsKey({ ...keyParts, request: baseQuery() }));
    expect(JSON.stringify(usersOptionsKey({ ...keyParts, request: baseQuery({ country: "US" }) }))).toBe(a);
    expect(JSON.stringify(usersOptionsKey({ ...keyParts, request: baseQuery({ sortField: "country_code", sortDir: "asc" }) }))).toBe(a);
    expect(JSON.stringify(usersOptionsKey({ ...keyParts, request: baseQuery({ page: 5 }) }))).toBe(a);
  });

  it("changes when a scoping filter changes (Funnel-style narrowing)", () => {
    const a = JSON.stringify(usersOptionsKey({ ...keyParts, request: baseQuery() }));
    expect(JSON.stringify(usersOptionsKey({ ...keyParts, request: baseQuery({ firstSub: "has" }) }))).not.toBe(a);
    expect(JSON.stringify(usersOptionsKey({ ...keyParts, request: baseQuery({ campaignPath: "summer" }) }))).not.toBe(a);
    expect(JSON.stringify(usersOptionsKey({ ...keyParts, request: baseQuery({ refund: "has" }) }))).not.toBe(a);
  });
});

describe("decline bundle key", () => {
  it("includes country filter, display filters and country sort; no page/table sort", () => {
    const norm = normalizeUsersDeclineRequest(baseDecline({
      country: "US",
      analyticsReasons: ["do_not_honor", "insufficient_funds", "do_not_honor"],
      analyticsStages: ["after_trial"],
      countrySortField: "country",
      countrySortDir: "asc",
    }));
    expect(norm.country).toBe("US");
    expect(norm.analytics_reasons).toEqual(["do_not_honor", "insufficient_funds"]); // deduped + sorted
    expect(norm.analytics_stages).toEqual(["after_trial"]);
    expect(norm.country_sort).toEqual({ field: "country", direction: "asc" });
    expect("page" in norm).toBe(false);
    expect("sort" in norm).toBe(false);
  });

  it("logically identical selections produce identical keys", () => {
    const a = usersDeclineKey({ ...keyParts, request: baseDecline({ analyticsReasons: ["b", "a"] }) });
    const b = usersDeclineKey({ ...keyParts, request: baseDecline({ analyticsReasons: ["a", "b", "a"] }) });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("changing country filter or country sort changes the key (cached return stays instant per key)", () => {
    const a = JSON.stringify(usersDeclineKey({ ...keyParts, request: baseDecline() }));
    expect(JSON.stringify(usersDeclineKey({ ...keyParts, request: baseDecline({ country: "DE" }) }))).not.toBe(a);
    expect(JSON.stringify(usersDeclineKey({ ...keyParts, request: baseDecline({ countrySortField: "failed" }) }))).not.toBe(a);
    expect(JSON.stringify(usersDeclineKey({ ...keyParts, request: baseDecline({ countrySortDir: "asc" }) }))).not.toBe(a);
  });

  it("buildUsersDeclineRequest sends action=decline with display filters + country sort", () => {
    const req = buildUsersDeclineRequest(baseDecline({
      country: "Unknown",
      analyticsReasons: ["insufficient_funds"],
      analyticsStages: ["after_trial"],
      countrySortField: "pass_rate_ex_if",
      countrySortDir: "asc",
    }));
    expect(req.action).toBe("decline");
    expect(req.filters?.country).toEqual(["Unknown"]);
    expect(req.decline).toEqual({
      reasons: ["insufficient_funds"],
      stages: ["after_trial"],
      country_sort: { field: "pass_rate_ex_if", direction: "asc" },
    });
  });
});

describe("normalized request country field", () => {
  it("trims and keeps single-select semantics", () => {
    expect(normalizeUsersRequest(baseQuery({ country: "US" })).country).toBe("US");
    expect(normalizeUsersRequest(baseQuery({ country: "all" })).country).toBeNull();
  });
});

describe("legacy country options (Cohorts-parity: scoped countries + trial counts)", () => {
  const row = (country_code: string | null, first_trial_date: string | null) => ({ country_code, first_trial_date });

  it("lists only countries present in the scoped set, counts trial users, A→Z with Unknown last", () => {
    const options = buildLegacyCountryOptions([
      row("US", "2026-06-01"),
      row("US", "2026-06-02"),
      row("US", null), // failed-only user: member, not counted as a trial
      row("MX", "2026-06-03"),
      row(null, "2026-06-04"), // no attributed country → Unknown bucket
    ]);
    expect(options).toEqual([
      { country_code: "MX", user_count: 1 },
      { country_code: "US", user_count: 2 },
      { country_code: "Unknown", user_count: 1 },
    ]);
  });

  it("keeps a zero-trial country listed (decline analytics covers failed-only users)", () => {
    const options = buildLegacyCountryOptions([row("DE", null)]);
    expect(options).toEqual([{ country_code: "DE", user_count: 0 }]);
  });

  it("countries outside the scoped set never appear", () => {
    const options = buildLegacyCountryOptions([row("US", "2026-06-01")]);
    expect(options.map((option) => option.country_code)).toEqual(["US"]);
  });
});
