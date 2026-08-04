import { describe, expect, it } from "vitest";
import { hashKey } from "@tanstack/react-query";
import { usersListKey, usersSummaryKey, usersOptionsKey, normalizeUsersRequest } from "@/services/usersCache";
import { hashUserScope } from "@/services/analyticsCache";
import type { UsersQuery } from "@/services/usersDataSource";

const q = (over: Partial<UsersQuery> = {}): UsersQuery => ({
  search: "",
  firstTrialFrom: null,
  firstTrialTo: null,
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
  ...over,
});
const parts = (request: UsersQuery) => ({ userScopeHash: "u_1", warehouseVersion: "whv_x", request });

describe("users cache keys", () => {
  it("normalizes card-type / decline arrays (order + dupes) → stable keys", () => {
    const a = q({ cardTypes: ["visa", "mc", "visa"], declineReasons: ["b", "a"] });
    const b = q({ cardTypes: ["mc", "visa"], declineReasons: ["a", "b", "a"] });
    expect(normalizeUsersRequest(a)).toEqual(normalizeUsersRequest(b));
    expect(hashKey(usersListKey(parts(a)))).toBe(hashKey(usersListKey(parts(b))));
  });

  it("list key includes pagination; summary key excludes it", () => {
    const p1 = q({ page: 1 });
    const p2 = q({ page: 2 });
    // Different page → different LIST key (server-side pagination).
    expect(hashKey(usersListKey(parts(p1)))).not.toBe(hashKey(usersListKey(parts(p2))));
    // Same filters, different page → SAME summary key (summary is page-independent).
    expect(hashKey(usersSummaryKey(parts(p1)))).toBe(hashKey(usersSummaryKey(parts(p2))));
  });

  it("different filters → different keys", () => {
    expect(hashKey(usersListKey(parts(q())))).not.toBe(hashKey(usersListKey(parts(q({ country: "US" })))));
    expect(hashKey(usersListKey(parts(q())))).not.toBe(hashKey(usersListKey(parts(q({ search: "abc" })))));
  });

  it("options key follows every filter that narrows a dependent branch", () => {
    // Two branches of the options response are dependent, and each excludes only
    // ITSELF: the country list respects the cohort selection, and the cohort list
    // respects the country. So both belong in the key — leaving them out meant
    // picking a country left the cohort panel showing counts for every country,
    // with no error and nothing to debug.
    const base = q();
    expect(hashKey(usersOptionsKey(parts(q({ country: "US" }))))).not.toBe(hashKey(usersOptionsKey(parts(base))));
    expect(hashKey(usersOptionsKey(parts(q({ cohortIds: ["soulmate_path_2026-07-01"] })))))
      .not.toBe(hashKey(usersOptionsKey(parts(base))));
    // Sort and pagination still cannot change what the lists contain.
    expect(hashKey(usersOptionsKey(parts(q({ sortField: "country_code", sortDir: "asc" }))))).toBe(hashKey(usersOptionsKey(parts(base))));
    expect(hashKey(usersOptionsKey(parts(q({ page: 4 }))))).toBe(hashKey(usersOptionsKey(parts(base))));
  });

  it("options key ignores sort and pagination", () => {
    const k1 = usersOptionsKey(parts(q()));
    const k2 = usersOptionsKey(parts(q()));
    expect(hashKey(k1)).toBe(hashKey(k2));
    expect(k1[0]).toBe("users");
    expect(k1[1]).toBe("options");
    // Sort / page changes never refetch options…
    expect(hashKey(usersOptionsKey(parts(q({ sortField: "country_code", sortDir: "asc" }))))).toBe(hashKey(k1));
    expect(hashKey(usersOptionsKey(parts(q({ page: 4 }))))).toBe(hashKey(k1));
    // …but a scoping filter change does (the country list narrows with it).
    expect(hashKey(usersOptionsKey(parts(q({ firstSub: "has" }))))).not.toBe(hashKey(k1));
  });

  it("platform and media buyer reach every key — a filter absent from the key is a filter that does nothing", () => {
    // The keys enumerate their fields by hand, so a new filter that is not added
    // here produces no error at all: TanStack simply returns the previous
    // answer, and the filter looks broken with nothing to debug.
    const base = q();
    const ios = q({ platform: ["ios"] });
    const ivan = q({ mediaBuyer: ["Ivan"] });

    expect(hashKey(usersListKey(parts(ios)))).not.toBe(hashKey(usersListKey(parts(base))));
    expect(hashKey(usersSummaryKey(parts(ios)))).not.toBe(hashKey(usersSummaryKey(parts(base))));
    expect(hashKey(usersListKey(parts(ivan)))).not.toBe(hashKey(usersListKey(parts(base))));
    expect(hashKey(usersSummaryKey(parts(ivan)))).not.toBe(hashKey(usersSummaryKey(parts(base))));

    // Both are part of userWhere, so they narrow the DEPENDENT option branches
    // (country, cohort) of the same response and belong in the options scope.
    expect(hashKey(usersOptionsKey(parts(ios)))).not.toBe(hashKey(usersOptionsKey(parts(base))));
    expect(hashKey(usersOptionsKey(parts(ivan)))).not.toBe(hashKey(usersOptionsKey(parts(base))));

    // Order and duplicates must not matter, like every other list filter.
    expect(normalizeUsersRequest(q({ platform: ["android", "ios", "ios"] })))
      .toEqual(normalizeUsersRequest(q({ platform: ["ios", "android"] })));
  });

  it("isolated by user; busted by warehouse version", () => {
    const a = { userScopeHash: hashUserScope("a"), warehouseVersion: "whv_x", request: q() };
    const b = { userScopeHash: hashUserScope("b"), warehouseVersion: "whv_x", request: q() };
    const c = { userScopeHash: hashUserScope("a"), warehouseVersion: "whv_y", request: q() };
    expect(hashKey(usersListKey(a))).not.toBe(hashKey(usersListKey(b)));
    expect(hashKey(usersListKey(a))).not.toBe(hashKey(usersListKey(c)));
  });
});
