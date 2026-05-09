# Architecture

## Overview

This project is a Vite + React + TypeScript subscription analytics dashboard.
It is organized into four main layers:

- Auth/access layer: Supabase Auth email/password login, session persistence, and protected routes for analytics pages.
- UI layer (React): pages and components for Dashboard, Transactions, Users, Cohorts, Forecasting, Subscriptions, and Import Data.
- Data transformation layer: import parsing, Palmer normalization, transaction classification, and cohort assignment.
- Analytics layer: KPI, revenue, user, funnel, and cohort aggregation functions used by the UI.
- Subscription monitoring layer: FunnelFox subscription sync, cancellation normalization, and subscription status UI.

The UI should stay presentation-focused. Business rules belong in `src/services`, especially in `palmerTransform.ts` and `analytics.ts`.

The Import Data page is the single source connection center. Palmer upload, Facebook traffic import, FunnelFox connection testing/sync, and local IndexedDB cache load/clear controls live there. Analytics pages should only render already-loaded data, filters, tables, and summaries.

Forecasting is a read-only scenario layer over existing cohort data. It uses Cohorts as the factual base, calculates absolute retention from original trial users, and lets the user edit forecast assumptions without mutating Palmer, FunnelFox, traffic, or cohort calculations.

Small page UI state is persisted in localStorage via `src/hooks/usePersistedPageState.ts`. Cohorts table settings additionally sync to Supabase `data_snapshots` as `cohorts_ui_settings` so column order, widths, visibility, active preset, and filters can follow the authenticated user across devices. Large data remains outside localStorage: Palmer, FunnelFox, and Facebook traffic datasets use IndexedDB for local reloads and Supabase `data_snapshots` for cross-device restore. API keys/secrets are never persisted.

All analytics routes are protected by Supabase Auth. `/login` is public; Dashboard, Cohorts, Forecasting, Transactions, Users, Subscriptions, and Import Data require an authenticated session. Supabase signup should be disabled in production, and allowed users should be created in Supabase Auth.

## Data Flow

Raw Palmer export
-> `normalizePalmerRows`
-> `classifyUserTransactions`
-> `transactions_clean`
-> cohort aggregation by campaign_path + cohort_date
-> UI

The import page can still accept a clean template CSV. In that mode, `applyMapping` maps user-provided columns into the shared `Transaction` shape. In Palmer mode, raw rows are preserved and transformed through the Palmer pipeline before they enter analytics.

Imported datasets are saved in two layers:

```text
Import/sync success
-> IndexedDB local cache
-> Supabase data_snapshots row scoped by auth.uid()
-> app startup restores IndexedDB first, then latest Supabase snapshot if local cache is missing
```

`data_snapshots` stores the latest snapshot per authenticated user and dataset type: `palmer`, `funnelfox_subscriptions`, `facebook_traffic`, `forecasting_settings`, and `cohorts_ui_settings`. Row-level security keeps snapshots private to the owning Supabase Auth user.

FunnelFox subscription monitoring is imported separately from Palmer transactions, then joined into cohort reporting by normalized email for subscription-health metrics:

```text
FunnelFox subscriptions API
-> backend/serverless proxy
-> optional subscription details enrichment
-> `normalizeSubscription`
-> `subscriptions`
-> Subscriptions UI
-> Cohorts/Dashboard active and cancellation metrics
```

The browser must never call FunnelFox directly with `Fox-Secret` or `https://api.funnelfox.io`. Backend endpoints read `process.env.FUNNELFOX_SECRET`, call FunnelFox server-side, and return JSON to the frontend. Frontend proxy URLs are restricted to same-origin `/api/funnelfox/...` paths unless external proxy use is explicitly enabled.

## Key Concepts

### transaction_type

`transaction_type` describes the business role of a payment:

- `trial`: first successful non-upsell payment for a user.
- `upsell`: successful upsell payment detected by `ff_billing_reason`, or a known upsell amount within 60 minutes after trial.
- `first_subscription`: next successful non-upsell payment after trial.
- `renewal_2`: next successful non-upsell payment after first_subscription.
- `renewal_3`: next successful non-upsell payment after renewal_2.
- `renewal`: all later successful non-upsell payments.
- `failed_payment`, `refund`, `chargeback`, `unknown`: non-standard or non-success states.

Revenue analytics use net revenue. When `net_amount_usd` is present, it is authoritative; otherwise revenue falls back to `amount_usd - refund_amount_usd`, then to `amount_usd`.

### cohort_date

`cohort_date` is the calendar date of the user's successful trial. Cohorts are based on the trial timestamp, not the later transaction timestamp.

### cohort_id

`cohort_id` combines exact campaign path and cohort date. It does not use the broad funnel because multiple landing paths can belong to the same funnel.

```text
{campaign_path}_{cohort_date}
```

Example:

```text
soulmate-marriage_2026-01-01
```

### campaign_path

`campaign_path` is the exact landing path from `ff_campaign_path`, normalized for grouping.
Examples:

- `/soulmate-marriage` -> `soulmate-marriage`
- `/soulmate-reading` -> `soulmate-reading`

If no path is available, `campaign_path` is `unknown`.

### transaction_day

`transaction_day` is the whole number of days since the user's trial timestamp.
It is used for interpreting customer lifecycle timing and cohort windows.

### FunnelFox subscriptions

FunnelFox data answers subscription-state questions that Palmer transaction exports do not answer reliably, especially cancellation state and cancellation timing.

`SubscriptionClean` is normalized in `src/services/subscriptionTransform.ts`.

- `is_cancelled` is true when FunnelFox status includes `cancel` or `renews === false`.
- `cancelled_at` uses FunnelFox `cancelled_at`, or falls back to `updated_at` when the subscription is cancelled.
- `is_active_now` can remain true after cancellation when the paid period has not ended.
- The Subscriptions page uses FunnelFox-normalized cancellation labels such as `cancelled_unknown_reason` and `auto_payment_related`.
- Cohorts and Dashboard use a cross-source cancellation classification based on FunnelFox subscription timing plus Palmer failed transactions near cancellation.
- FunnelFox subscriptions are cached in IndexedDB, not localStorage.
- Temporary FunnelFox key input is development-only and is shown only on Import Data. Production sync must use server-side `FUNNELFOX_SECRET`.
- Raw subscription debug output is development-only unless explicitly enabled with `VITE_ENABLE_FUNNELFOX_DEBUG=true`.

Planned webhook endpoint:

```text
POST /api/webhooks/funnelfox
```

The webhook handler should verify `Fox-Secret-Key` server-side and handle `subscription.cancelled`, `subscription.activated`, and `subscription.renewed`. This Vite frontend does not implement production webhooks.
