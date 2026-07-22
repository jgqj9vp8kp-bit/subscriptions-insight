# Architecture

Updated 2026-07-23. Companion docs: `FB_WAREHOUSE_V2_DESIGN.md` (warehouse redesign),
`FB_COHORT_AUTHORITATIVE_AUDIT.md` (allocation architecture), `PERF_SERVER_AGGREGATION_PLAN.md`
(server aggregation), `DEVELOPER_NOTES.md` (operational rules).

## Overview

Vite + React + TypeScript subscription analytics dashboard backed by Supabase
(Auth, Postgres, Edge Functions) and a ClickHouse analytics warehouse.

- **Auth/access**: Supabase email/password, protected routes, no public signup.
- **UI (React)**: Dashboard, Cohorts, FB Analytics, Forecasting, Transactions, Users,
  Subscriptions, Support, Import Data. Presentation-focused; business rules live in services.
- **Compute core (`supabase/functions/_shared/clickhouse/`)**: ALL pure business logic —
  cohort computation, classification, FB analytics, dashboard math, currency/FX,
  mapping/resolution, reconciliation. The browser imports these exact modules through
  one-line re-export stubs in `src/services/`, and Edge Functions import them directly:
  **one definition of every formula, shared verbatim by client and server.**
- **Edge Functions (Deno)**: thin HTTP wrappers over the compute core plus the only
  holders of secrets (ClickHouse credentials, Capsuled token, FunnelFox secret).
- **Warehouses**: Supabase Postgres `transactions` (transaction warehouse, the
  production store source) and ClickHouse (`analytics_transactions`,
  `fact_user_cohorts`, `fact_facebook_stats`, Warehouse V2 tables).

## Data flow

```text
Palmer CSV / FunnelFox sync / Capsuled FB sync
  -> import + normalization (palmerTransform, subscriptionTransform)
  -> IndexedDB cache + Supabase data_snapshots (cross-device restore)
  -> Supabase transactions warehouse (authoritative store source in production;
     MIT recurring payments arrive HERE via sync and never enter the palmer snapshot)
  -> ClickHouse analytics_transactions / fact_user_cohorts (cohort snapshot, CAS-guarded builds)
  -> readers: pages (client compute) and summary Edge Functions (server compute)
```

The browser store policy — warehouse rows when available, palmer snapshot otherwise —
is mirrored server-side by `serverTransactionsSource.ts`, so summary functions see the
same inputs as the page (`meta.transactions_source` in every response tells which).

## Server aggregation (parity-first, flag-gated)

Heavy page computes move server-side only as *faster producers of identical numbers*:
the Edge Function reuses the in-app modules verbatim, ships behind a flag defaulting to
the client path, and DEV reconciles both sides before any flag flips.

| Function | Mirrors | Flag |
|---|---|---|
| `clickhouse-cohorts` | Cohorts read path (materialized snapshot + FB user-cost allocation) | `VITE_COHORTS_DATA_SOURCE` (default `clickhouse`) |
| `fb-analytics-summary` | `buildFbAnalytics` over the exact page enrichment chain | `VITE_FB_ANALYTICS_SOURCE` (default `client`) |
| `dashboard-summary` | The full Dashboard chain (KPIs, cash revenue, trends, daily series, FX) | `VITE_DASHBOARD_SOURCE` (default `client`) |

## Facebook analytics: two spend models, two mapping layers

**Model 1 — user-attributed spend** (validated, the Cohorts engine):
`user_cpp = Campaign CPP (spend / fb_purchases)` for the user's Campaign ID + FB
reporting date; `Cohort Spend = SUM(user_cpp)`. No proportional distribution, exact
campaign_id matching only, IANA-timezone reporting dates, snapshot-uniqueness gate.
Campaigns with zero matched users contribute nothing here — by design.

**Model 2 — full funnel spend** (`fbCampaignResolution.ts`): source campaign spend
resolved to funnels through mapping Layer B. Zero-user campaigns are INCLUDED by
construction; every figure carries `match_kind` provenance (confirmed vs suggested);
`source_spend == funnel_resolved_spend + unknown_funnel_spend` holds by identity.
**The two models are never forced to agree — divergence is signal.**

Mapping is data, not code (Postgres, owner-editable, retire-only):

- **Layer A** `facebook_campaign_mapping`: observed utm_campaign → actual source
  campaign id (seeded from the audited 22-pair hardcode; classification-only, never
  allocation math).
- **Layer B** `facebook_campaign_funnel_map`: source campaign id → funnel. Evidence
  ladder: destination URL > stable funnel across authoritative users (`campaign_path`,
  auto-confirmed at ≥3 users) > copy relation > manual > name token (`name_rule`,
  suggested ONLY — enforced by CHECK) > unknown.

## Facebook Warehouse V2 (migration in progress)

V1 (`fact_facebook_stats`, mixed `level` column, silent restates) is being replaced
without stopping production. Both pipelines run until cutover; every phase rolls back
by flag.

- **Phase 0 — schema** (`fbWarehouseV2Schema.ts`, created by `clickhouse-init`):
  per-grain daily facts (no stored ratios, full lineage), verbatim raw API response
  layer (no TTL), SCD2 dims, `facebook_batch_registry` mirror, DQ results,
  `facebook_recon_snapshots`; `v_*_current` views resolve the latest PUBLISHED batch;
  `v_channel_campaign_daily` is the cross-channel contract seed (`traffic_channel`
  dimension — TikTok/Google later UNION their own facts into it).
- **Phase 1 — dual-write** (`fbWarehouseV2Writer.ts`): the existing sync writes V2
  beside V1, fail-safe (absent V2 schema leaves the sync byte-identical). Shared
  batch/run lineage with the append-only Postgres history
  (`facebook_sync_runs` / `facebook_import_batches` / `facebook_raw_payloads` /
  `facebook_batch_dq`, UPDATE/DELETE rejected by triggers). The `day` level is spend
  ground truth, never a fact; merged multi-day rows withhold the batch with a
  `grain_single_day` DQ failure.
- **Phase 2 — probe/backfill**: `source_probe` action (read-only day scan, defaults
  to the audited 2026-05-08..06-14 gap) → data ⇒ `runFbBackfillWindow` (full sync
  with explicit dates, lands in both warehouses) · empty ⇒ `recordFacebookKnownGap`
  (append-only, refuses to record when data exists).
- **Recon (Wave 4)** (`fbReconSnapshot.ts`): stored snapshots partition source spend
  by campaign state (allocated / no_user / unknown_funnel / unknown_campaign) with
  Model 1 reported beside (uncapped — overallocation stays visible), coverage against
  a known-gap-adjusted denominator, and green/yellow/red health. Degradation is
  caught by the next snapshot, not a retrospective audit.
- **Cutover (pending)**: readers switch to `v_*_current` behind `FB_WAREHOUSE_V2_READS`
  after a ≤$0.01 parity harness holds for 7 days; cohorts switch last.

## Key concepts

- `transaction_type`: `trial` (first successful non-upsell), `upsell`,
  `first_subscription`, `renewal_2`, `renewal_3`, `renewal`, `token_purchase`
  (web-app add-on packs), plus `failed_payment` / `refund` / `chargeback` / `unknown`.
  Revenue analytics use net USD (FX-normalized; unconvertible rows keep flowing with
  zeroed money and are surfaced in FX diagnostics — rows are never dropped).
- `cohort_date`: calendar date of the user's successful trial.
- `cohort_id`: `{funnel}_{campaign_path}_{cohort_date}`; campaign_path is the exact
  normalized landing path, funnel is verbatim from the payload (never derived).
- `campaign_id` **is** `utm_campaign` verbatim — forensically proven (0 exceptions,
  95.1% of spend); `utm_term`/`utm_content` are structurally similar Meta ids but
  never campaign ids.

## Persistence rules

- IndexedDB: fast local cache for large datasets (palmer, subscriptions, traffic).
- Supabase `data_snapshots`: latest cross-device snapshot per dataset type, RLS-scoped,
  lz-string envelope over 256KB (`snapshotEnvelope.ts` — one definition, decompressor
  injected: npm in the browser, esm.sh in Deno).
- localStorage: small UI state only. Secrets never persist anywhere client-side.
