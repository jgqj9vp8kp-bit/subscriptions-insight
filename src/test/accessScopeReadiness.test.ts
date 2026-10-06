// Access Phase 2 readiness contract (spec §5.1 / §7 track I): the pages a
// funnel-restricted member may open (RESTRICTED_READY_ROUTES) and the Edge
// actions each of them calls (RESTRICTED_PAGE_ACTIONS) must agree with the
// policies the gate enforces:
//   * every listed action is scopeReady in its REAL policy;
//   * only clickhouse-summary.summary runs without a scopeSnapshot (its member
//     branch reads no ClickHouse); every other one waits for the snapshot;
//   * the Media Buyer template, narrowed to funnel A, is authorized for every
//     action of every page it can open (no page the UI offers is a 403);
//   * the browser route table marks exactly these routes restrictedReady;
//   * each listed action is really served to that member end to end (200 with a
//     ready snapshot, 409 without one) through the router replicas of
//     accessFixtures §6.

import { describe, expect, it } from "vitest";
import { authorizeAction } from "../../supabase/functions/_shared/access/accessContext.ts";
import { RESTRICTED_PAGE_ACTIONS, RESTRICTED_READY_ROUTES } from "../../supabase/functions/_shared/access/scopeReadiness.ts";
import { ROUTE_ACCESS } from "@/services/accessRoutes";
import { ALL_POLICIES, PERSONAS, SCOPE_READY_ACTIONS, SCOPE_READY_REQUESTS, contextFor, policyFor, readThroughRouter } from "./support/accessFixtures";

const PAGE_ACTIONS = Object.entries(RESTRICTED_PAGE_ACTIONS).flatMap(([route, actions]) =>
  actions.map(({ fn, action }) => [`${route} → ${fn}.${action}`, route, fn, action] as const),
);

describe("access Phase 2: restricted readiness contract", () => {
  it("lists a page entry for exactly the restricted-ready routes", () => {
    expect(Object.keys(RESTRICTED_PAGE_ACTIONS).sort()).toEqual([...RESTRICTED_READY_ROUTES].sort());
    expect(PAGE_ACTIONS.length).toBeGreaterThanOrEqual(10);
  });

  it.each(PAGE_ACTIONS)("%s is scopeReady in its policy and in the allowlist", (_label, _route, fn, action) => {
    const rule = policyFor(fn).actions[action];
    expect(rule, `${fn}.${action} exists`).toBeDefined();
    expect(rule.scopeReady).toBe(true);
    expect(SCOPE_READY_ACTIONS).toContain(`${fn}.${action}`);
  });

  it("only clickhouse-summary.summary is scopeReady without a scopeSnapshot", () => {
    const withoutSnapshot = ALL_POLICIES.flatMap((policy) =>
      Object.entries(policy.actions)
        .filter(([, rule]) => rule.scopeReady === true && !rule.scopeSnapshot)
        .map(([action]) => `${policy.fn}.${action}`),
    );
    expect(withoutSnapshot).toEqual(["clickhouse-summary.summary"]);
  });

  it.each(PAGE_ACTIONS)("%s: the Media Buyer template narrowed to funnel A is authorized", (_label, _route, fn, action) => {
    const ctx = contextFor(PERSONAS.buyerA);
    expect(ctx.restricted).toBe(true);
    expect(authorizeAction(ctx, policyFor(fn).actions[action])).toBeNull();
  });

  it("the browser route table marks exactly the restricted-ready routes", () => {
    const ready = ROUTE_ACCESS.filter((rule) => rule.restrictedReady).map((rule) => rule.path);
    expect(ready.sort()).toEqual([...RESTRICTED_READY_ROUTES].sort());
  });

  it.each(PAGE_ACTIONS)("%s: served to the Media Buyer @ {A} end to end with a ready snapshot (gate → router replica → real runner)", async (_label, _route, fn, action) => {
    const body = SCOPE_READY_REQUESTS[`${fn}.${action}`];
    expect(body, `${fn}.${action} has an in-scope request fixture`).toBeDefined();
    const result = await readThroughRouter(PERSONAS.buyerA, fn, body);
    expect(result.status, result.text.slice(0, 300)).toBe(200);
    // ...and a 409 (never a 403, never another engine) while the snapshot is not ready.
    const pending = await readThroughRouter(PERSONAS.buyerA, fn, body, { snapshotState: null });
    if (policyFor(fn).actions[action].scopeSnapshot) {
      expect(pending.status).toBe(409);
      expect(pending.json?.error_code).toBe("scope_snapshot_not_ready");
      expect(pending.clickhouse.statements).toEqual([]);
    } else {
      expect(pending.status).toBe(200);
    }
  });
});
