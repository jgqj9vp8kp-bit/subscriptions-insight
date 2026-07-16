# TODO — Token / Multi-Upsell Monetization Rollout

Status of the Cohorts-page monetization work (multi-upsell + token pack analytics)
and the documented plan for the pieces intentionally **not** done yet.

## Shipped (Cohorts page only)

- `transaction_type: "token_purchase"` — successful web-app token/minute pack
  purchases, detected in `classifyUserTransactions` via the single product map
  `src/services/monetizationProductMap.ts` (known ids → name patterns → known
  pack price+currency; audited packs: $4.99 / $9.99 USD). Token purchases never
  occupy a trial / first_subscription / renewal slot and are excluded from
  price-plan assignment.
- Upsell 1/2/3 slots are assigned by the ORDER of the user's successful upsell
  purchases inside `computeCohorts` (the July 2026 warehouse audit showed
  payments carry no ordinal signal); 4th+ purchases land in `upsell_extra`.
  `MonetizationCategory` projection: `trial`, `first_subscription`, `renewal`,
  `funnel_upsell`, `token_purchase`, `unknown_addon`. `transaction_type:
  "upsell"` is unchanged, so all existing generic-upsell consumers keep working.
- Unknown-product diagnostics (`MonetizationDiagnostics.unknown_products`):
  unmarked charges inside the 72h app-addon window that match no config rule
  are surfaced in the Cohorts diagnostics panel + DEV console so new pack
  prices/ids can be added to `monetizationProductMap.ts` quickly.
- Per-cohort monetization metrics on `CohortRow` (computed in the same pass as
  the rest of `computeCohorts`): upsell 1/2/3 users + CR + gross revenue,
  unknown-upsell users/revenue, token buyers/CR/purchases/gross/net revenue,
  avg token revenue per trial / per buyer, add-on revenue, token pack breakdown.
- Token attribution: user_id first, then normalized-email fallback
  (`computeCohortsWithDiagnostics` → `TokenAttributionDiagnostics`); unmatched
  token purchases are excluded from cohort metrics and surfaced on the page.
- Cohorts UI: 20 new optional columns (hidden by default), built-in
  **Monetization** view, header tooltips, totals row with CRs recomputed from
  totals, expanded-row upsell-funnel + token-pack breakdown, aggregated pack
  table + diagnostics line above the table.

## Deliberately NOT done in this task (planned follow-ups)

### 1. Dashboard token revenue (later)
- `CASH_REVENUE_TRANSACTION_TYPES` in `src/services/dashboard.ts` does not
  include `token_purchase`, so Dashboard cash revenue ignores token purchases.
- Plan: add a "Token / Add-on Revenue" KPI card and include `token_purchase`
  in cash revenue behind the existing filters; extend `buildUpsellsByDay`-style
  daily series with a token series.

### 2. Forecasting token LTV component (later)
- Forecasting reads subscription-lifecycle types only; token revenue is
  invisible to it today.
- Plan: add an additive "token ARPU uplift" component — per-cohort
  `avg_token_revenue_per_trial` decaying/holding per forecast month — kept
  separate from renewal retention math so scenario editing stays independent.

### 3. Token LTV in cohort LTV columns (later)
- `net_ltv` / `revenue_dN` include token purchases only when the token purchase
  arrives under the same `user_id` as the funnel purchase (existing revenue
  definitions were intentionally left untouched). Email-matched token revenue
  currently appears **only** in the token columns. Once verified against real
  data, decide whether email-matched token revenue should also join
  `gross_revenue`/`net_revenue`/`revenue_dN` (that changes existing metric
  values, so it needs an explicit sign-off).

### 4. Export API / edge function parity (later)
- `supabase/functions/export-campaign-performance/classify.ts` duplicates the
  client classifier and does NOT know `token_purchase`; the export still
  counts token-like rows as renewals. Port the token detection there when the
  export needs token metrics.

## Known limitations (data, not code)

- **Upsell order** is inferred from purchase order (1st/2nd/3rd successful
  upsell). A duplicate/retried charge of the same offer counts as the next
  slot (observed once in real data: two identical $14.98 charges in the same
  minute). A dedicated ordinal or product id from the funnel would remove this
  ambiguity.
- **Token detection**: config-driven (`monetizationProductMap.ts`) — known ids,
  name patterns, and audited pack prices ($4.99/$9.99 USD). New pack prices
  must be added to the config; until then they appear in the
  "Unknown monetization products" diagnostics instead of token metrics.
- **Multi-currency amounts**: SOLVED for Cohorts — `computeCohorts` normalizes
  every money field to USD via `currencyNormalization.ts` + `fxRates.ts`
  (static rates as of 2026-07-01; TODO: replace with a daily FX rates
  table/API). Unconvertible rows are excluded from USD metrics and reported in
  the FX diagnostics. Dashboard / Users / Transactions / Export API still show
  raw charge-currency amounts — porting them onto `normalizeTransactionsToUsd`
  is a follow-up.
- **Token Net Rev**: refunds are detected from same-row `amountRefunded` and
  from refund/chargeback rows whose product matches a token pack. A standalone
  REFUNDED row without a token product signal cannot be linked to the original
  token purchase; in that case Token Net Rev equals Token Gross Rev.
- **Chat free minutes** are not tracked in any dataset; free-minute usage and
  conversion-from-free metrics need a new event feed before any UI work.
- **Session/profile join**: Palmer rows carry no `session_id`/`profile_id`, so
  token purchases cannot be joined to FunnelFox sessions; matching is
  user_id/email only.
