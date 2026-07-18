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

  it("options key follows the filter scope minus country/sort/page (dependent country options)", () => {
    const k1 = usersOptionsKey(parts(q()));
    const k2 = usersOptionsKey(parts(q()));
    expect(hashKey(k1)).toBe(hashKey(k2));
    expect(k1[0]).toBe("users");
    expect(k1[1]).toBe("options");
    // Country / sort / page changes never refetch options…
    expect(hashKey(usersOptionsKey(parts(q({ country: "US" }))))).toBe(hashKey(k1));
    expect(hashKey(usersOptionsKey(parts(q({ sortField: "country_code", sortDir: "asc" }))))).toBe(hashKey(k1));
    expect(hashKey(usersOptionsKey(parts(q({ page: 4 }))))).toBe(hashKey(k1));
    // …but a scoping filter change does (the country list narrows with it).
    expect(hashKey(usersOptionsKey(parts(q({ firstSub: "has" }))))).not.toBe(hashKey(k1));
  });

  it("isolated by user; busted by warehouse version", () => {
    const a = { userScopeHash: hashUserScope("a"), warehouseVersion: "whv_x", request: q() };
    const b = { userScopeHash: hashUserScope("b"), warehouseVersion: "whv_x", request: q() };
    const c = { userScopeHash: hashUserScope("a"), warehouseVersion: "whv_y", request: q() };
    expect(hashKey(usersListKey(a))).not.toBe(hashKey(usersListKey(b)));
    expect(hashKey(usersListKey(a))).not.toBe(hashKey(usersListKey(c)));
  });
});
