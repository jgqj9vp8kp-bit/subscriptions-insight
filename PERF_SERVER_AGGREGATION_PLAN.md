# Server-side aggregation plan (not yet implemented)

The analytics pages currently load the **entire** transaction warehouse into the browser
(`loadWarehouseTransactions` pages every row into the Zustand store) and run `computeCohorts` /
dashboard math client-side. That is the root cost for large accounts: download size, memory, and
repeated O(transactions) passes on the main thread.

This document is a **plan** for moving the heavy aggregation server-side. It is intentionally *not*
implemented here, because each summary must reproduce the existing formulas **exactly** and that
needs a reconciliation phase before anything is switched over. Nothing below changes current
behavior.

## Principle: parity-first, flag-gated rollout

For every summary:

1. Implement a Supabase RPC (Postgres function) or an Edge Function that returns the **same shape**
   the client computes today.
2. Add a reconciliation test/dev-guard that computes both ways for the same account/filters and
   asserts equality within tolerance (the FB↔Cohorts reconciliation in `fbAnalytics.ts` is the
   model). Ship the server path **disabled**.
3. Flip a per-summary feature flag only after parity holds on real data. Keep the client path as a
   fallback.

This guarantees "metric formulas unchanged" — the server is a faster producer of identical numbers,
not a reinterpretation.

## RPCs

### `dashboard_summary(p_user uuid, p_from date, p_to date)`
Mirrors `computeKpis` + the dashboard cards. Returns totals only (no per-row payload):
`total_revenue, trial_payments, upsell_revenue, first_subscription_revenue, renewal_revenue,
trial_to_upsell_cr, trial_to_first_subscription_cr, average_ltv`.
Source of truth: classified `transactions` rows; revenue excludes `status='failed'`. Heavy part
(per-user classification) is already materialized in `normalized_payload` — but the **authoritative**
classification is full-history (see the Export edge function), so this RPC must classify in SQL the
same way `classifyUserTransactions` does, or call the shared logic in an Edge Function instead of a
pure SQL RPC. Edge Function is the lower-risk option because it can import the existing
`compute.ts`/`classify.ts` modules verbatim.

### `cash_revenue_summary(p_user uuid, p_from date, p_to date)`
Mirrors `getWarehouseAggregationSummary` / dashboard cash-revenue: `cash_revenue, cohort_revenue,
active_subscriptions, refunds`. Pure aggregation over classified rows; cheapest to move and a good
first candidate.

### `cohort_summary(p_user uuid, filters jsonb)`
Mirrors `computeCohorts` → `computeCohortReportTotals`. The hardest one: canonical renewal-depth
sequencing per user and subscription-flag joins. Recommend an **Edge Function** that reuses the
in-app `computeCohorts` (Deno-compatible extraction, same pattern as the Export API's `compute.ts`),
returning the cohort rows already aggregated. Filters: funnel, campaign_path, date range,
country/card-type/media-buyer, campaign IDs.

### `fb_analytics_summary(p_user uuid, filters jsonb)`
Mirrors `buildFbAnalytics`. This is also the worst **client** hotspot: it calls `computeCohorts`
once per campaign **and once per trial user** (`fbAnalytics.ts:237` and `:247`) — O(users) cohort
computations. Moving it server-side (Edge Function reusing the cohort logic) removes that cost from
the browser entirely. Returns the per-campaign rows + summary already computed, plus the
spend/CAC/ROAS join against the latest `facebook_traffic` snapshot (logic already exists in the
Export edge `compute.ts`).

## Suggested order (lowest risk → highest value)

1. `cash_revenue_summary` (pure SQL, easy parity).
2. `dashboard_summary`.
3. `fb_analytics_summary` (largest client win — removes the per-user `computeCohorts` loop).
4. `cohort_summary`.

## Client changes when adopting

- Keep `loadWarehouseTransactions` for the Transactions/Users **drill-down** views, but let
  Dashboard/Cohorts/FB read their summary RPCs instead of pulling all rows. That removes the
  full-warehouse download from the common navigation path.
- Gate each page behind `if (serverSummaryEnabled) useRpc() else useClientComputation()`.

## Client-side optimizations already shipped (no formula changes)

These are safe, behavior-preserving wins applied while the server plan above is still pending. None
of them alter a metric formula, an import path, Supabase auth, or the Export API contract.

- **Route code-splitting** (`App.tsx`): every heavy analytics page is `React.lazy` + `Suspense`;
  only Login/NotFound stay eager. Heavy pages and recharts load on first navigation, not at boot.
- **Vendor chunk split** (`vite.config.ts` `manualChunks`): react/react-dom/router, recharts,
  supabase, and react-query are isolated into long-cached chunks. The eager `index` chunk dropped
  from ~610 kB to ~210 kB and the >500 kB build warning is gone. recharts (`vendor-charts`, ~411 kB)
  stays demand-loaded because only lazy chart pages import it.
- **Shared cohort computation** (`Cohorts.tsx`): `allCohorts` reuses `parentCohorts` when no Campaign
  ID filter is active instead of running `computeCohorts` a second time over an identical input set.
- **Bounded table DOM**: Users (50/page) and Transactions (25/page) render one page at a time;
  summaries/totals/decline analytics are still computed from the full filtered set, so pagination
  changes only what is rendered, never a number. The Cohorts and FB-Analytics tables render
  pre-aggregated rows (one per cohort group / campaign) so their row counts are already bounded.
- **Non-blocking heavy recompute + loading state** (`FBAnalytics.tsx`): `buildFbAnalytics` (the
  worst client hotspot — `computeCohorts` per campaign and per trial user) is fed a
  `useDeferredValue` filter set, so filter clicks stay responsive and a "Recalculating…" affordance
  shows while the background recompute runs. The deferred filters feed every downstream derive
  (rows, charts, totals, the dev reconciliation baseline) so results stay internally consistent.

### Deliberately NOT changed (would not be safe today)

- **Cohorts `useDeferredValue`**: the page has reconciliation effects (`Cohorts.tsx` ~977 and
  ~1019) that prune `campaignPathFilter` / `selectedCampaignIds` against option lists derived from
  the cohort compute. Deferring those inputs can make an effect prune against a stale option set and
  fight the user. With no render-test coverage on Cohorts, this is left for after such tests exist.
- **Row virtualization on the aggregated tables**: the Cohorts pivot table relies on sticky header,
  sticky total row, sticky/resizable first column, and expandable plan rows; virtualizing it is
  high-risk for low benefit (rows are already bounded). Pagination was chosen for the genuinely
  large tables instead.
