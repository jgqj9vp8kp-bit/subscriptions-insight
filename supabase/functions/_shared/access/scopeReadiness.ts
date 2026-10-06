// Funnel-restricted readiness contract (plan §5.1, Phase 2): which SPA pages a
// funnel-restricted member (funnel scope other than "all") may open, and which
// Edge actions each of those pages calls.
//
// This module is pure TypeScript with no Deno globals and no imports: the
// browser route table (src/services/accessRoutes.ts) and the security suites
// read the SAME lists. UX only on the browser side — the Edge gate stays
// authoritative: every action listed here must be scopeReady in its policy
// (src/test/accessScopeReadiness.test.ts), and every other action answers a
// restricted member 403 scope_not_supported.

/** The pages a funnel-restricted member may open: the media-buyer surfaces
 * (Dashboard's Revenue Intelligence section, Cohorts, the read-only Funnels
 * registry, the FB Analytics warehouse tab). Every other ROUTE_ACCESS rule
 * declares restrictedReady: false. */
export const RESTRICTED_READY_ROUTES: readonly string[] = Object.freeze(["/", "/cohorts", "/funnels", "/fb-analytics"]);

/** The Edge actions each restricted-ready page calls for a restricted member.
 * "/funnels" reads the registry through PostgREST only (scoped by RLS), so it
 * calls no Edge action. */
export const RESTRICTED_PAGE_ACTIONS: Readonly<Record<string, ReadonlyArray<{ fn: string; action: string }>>> = Object.freeze({
  "/": Object.freeze([
    { fn: "clickhouse-summary", action: "summary" },
    { fn: "clickhouse-revenue", action: "bundle" },
    { fn: "clickhouse-revenue", action: "day_breakdown" },
  ]),
  "/cohorts": Object.freeze([
    { fn: "clickhouse-summary", action: "summary" },
    { fn: "clickhouse-cohorts", action: "list" },
    { fn: "clickhouse-cohorts", action: "details" },
    { fn: "clickhouse-facebook", action: "status" },
  ]),
  "/funnels": Object.freeze([]),
  "/fb-analytics": Object.freeze([
    { fn: "clickhouse-summary", action: "summary" },
    { fn: "clickhouse-facebook", action: "status" },
    { fn: "clickhouse-facebook", action: "report" },
  ]),
});
