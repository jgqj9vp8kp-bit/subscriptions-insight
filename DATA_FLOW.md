# Data Flow

## 0. Access Control

Subengine requires Supabase Auth before any analytics or import page is accessible. `/login` is the only public app route. Authenticated sessions persist across refreshes through Supabase Auth.

The frontend uses:

```text
VITE_SUPABASE_URL
VITE_SUPABASE_ANON_KEY
```

Public signup should be disabled in Supabase; users are created/administered outside the app.

## 1. Raw Import

Data enters through the Import Data page from either:

- CSV file
- Public Google Sheet

The project supports two import modes:

- Clean template: already structured analytics rows.
- Palmer raw export: raw payment rows that need normalization and classification.

Import Data is the only page that owns data connection controls:

- Palmer Transactions Import
- Facebook Traffic Import
- FunnelFox Subscriptions Sync
- Local Saved Data

Cohorts, Subscriptions, Dashboard, Users, and Transactions consume already-loaded Zustand data and should not render import, sync, test connection, cache load, or cache clear controls.

Forecasting also consumes already-loaded data. It reads cohort facts and transactions, then calculates editable scenario outputs without writing back into cohort analytics.

Page filters and lightweight UI settings persist in localStorage under `ui_state_*` keys. Imported Palmer data, FunnelFox subscriptions, traffic rows, raw payloads, and secrets are not stored in these UI-state keys.

Example Palmer row:

```json
{
  "id": "tx_123",
  "user_id": "u_123",
  "email": "user@example.com",
  "created_at": "2026-01-01T10:00:00Z",
  "amount": "1498",
  "status": "SETTLED",
  "metadata": "{\"utm_campaign\":\"soulmate_launch\"}"
}
```

## 2. Metadata Parsing

`parseMetadata` reads funnel and campaign fields from the metadata JSON and direct columns.

Supported fields include:

- `ff_funnel_id`
- `ff_campaign_path`
- `utm_campaign`
- `utm_content`

Funnel values map to:

- `soulmate`
- `past_life`
- `starseed`
- `unknown`

Unknown metadata stays `unknown`; it must not default to `past_life`.

## 3. Amount Normalization

Palmer exports amounts in cents. `normalizeAmount` converts cents into USD:

```text
100 -> 1.00
1498 -> 14.98
2999 -> 29.99
```

Refunds from Palmer `amountRefunded` are stored separately as `refund_amount_usd`, with `net_amount_usd` representing gross minus refund. Revenue analytics use net revenue.

## 4. Status Normalization

Palmer statuses are mapped into the app status model:

```text
SETTLED -> success
DECLINED -> failed
REFUNDED -> refunded
CHARGEBACK -> chargeback
```

## 5. Transaction Classification

`classifyUserTransactions` groups transactions by `user_id`, sorts them by `event_time`, and applies lifecycle rules:

- first successful non-upsell payment is `trial`
- successful upsell payment detected by `ff_billing_reason`, or a known upsell amount within 60 minutes after trial, is `upsell`
- next successful non-upsell payment after trial is `first_subscription`
- next successful non-upsell payment after first_subscription is `renewal_2`
- next successful non-upsell payment after renewal_2 is `renewal_3`
- later successful non-upsell payments are `renewal`

Each row receives `transaction_type` and `classification_reason`.

## 6. Cohort Assignment

`addCohortFields` finds each user's successful trial and assigns:

- `cohort_date`: date of the trial timestamp
- `campaign_path`: exact landing path from `ff_campaign_path`, or `unknown`
- `cohort_id`: `{campaign_path}_{cohort_date}`
- `transaction_day`: days since trial timestamp

Example:

```text
trial event_time: 2026-01-01T18:00:00Z
transaction event_time: 2026-01-02T17:30:00Z
transaction_day: 0
```

The example is still D0 because it happened within the first 24 hours after trial.

Different campaign paths inside the same funnel stay separate:

```text
/soulmate-marriage + 2026-04-26 -> soulmate-marriage_2026-04-26
/soulmate-reading + 2026-04-26 -> soulmate-reading_2026-04-26
```

## 7. Aggregation

`analytics.ts` converts clean transactions into UI-ready metrics:

- KPIs
- revenue by day
- revenue by transaction type
- revenue by funnel
- trial -> upsell -> first_subscription funnel
- users table
- cohort table

Revenue aggregation uses net revenue. `net_amount_usd` is preferred; if it is absent, analytics fall back to `amount_usd - refund_amount_usd`, then to `amount_usd`.

Cohort windows are timestamp-based:

- D0 = first 24 hours after trial
- D7 = first 7 days after trial
- D30 = first 30 days after trial

## 8. FunnelFox Subscription Monitoring

FunnelFox subscription data is imported separately from Palmer payments.

```text
FunnelFox API /subscriptions
-> server-side proxy with Fox-Secret
-> `syncAllSubscriptions`
-> duplicate removal by subscription id / psp id
-> optional subscription details enrichment
-> `normalizeSubscription`
-> Zustand `subscriptions`
-> Import Data sync/cache status
-> Subscriptions page
-> Cohorts/Dashboard active and cancellation metrics by email match
```

The frontend uses safe mock/proxy mode unless real sync is enabled. It does not send `Fox-Secret` from browser code and blocks direct browser calls to `https://api.funnelfox.io`. A backend or serverless function must call:

```text
GET https://api.funnelfox.io/public/v1/subscriptions
Fox-Secret: process.env.FUNNELFOX_SECRET
```

Pagination should follow `pagination.has_more` and `pagination.next_cursor`.

Subscriptions are cached locally in IndexedDB, not localStorage, because the dataset is too large for browser key-value storage.

Cross-device persistence uses Supabase DB snapshots:

```text
IndexedDB cache miss after login
-> Supabase data_snapshots latest row for auth.uid()
-> restore Zustand data
-> warm IndexedDB cache for future reloads
```

Snapshot types are `palmer`, `funnelfox_subscriptions`, `facebook_traffic`, `forecasting_settings`, and `cohorts_ui_settings`. The app stores dataset payloads, small UI settings, and metadata only; it never stores API secrets.

Large snapshot payloads are compressed before upload and decompressed after download. Palmer cloud snapshots use this path so large `transactions + rawPalmerRows` imports can be restored on another device without re-uploading the source file.

Cohorts UI settings use the same snapshot table:

```text
Cohorts localStorage settings
-> debounced Supabase data_snapshots upsert
-> new device loads cloud settings when local settings are missing or older
```

The settings payload contains column order, widths, visibility, selected view, filters, and `updatedAt`. Unknown column IDs are ignored, duplicate IDs are removed, and newly added columns are appended to the saved order.

Cancellation fields are normalized as:

- status containing `cancel` -> cancelled
- `renews === false` -> cancelled
- `cancelled_at` preferred, falling back to `updated_at`
- active access can continue until `period_ends_at`

Cancellation labels differ by reporting surface:

- Subscriptions page: FunnelFox-normalized cancel type from status, renews, cancellation_reason, and timing.
- Cohorts/Dashboard: cross-source cancellation classification using FunnelFox cancellation timing plus Palmer failed/declined transactions within 48 hours before cancellation.

Temporary key input lives on Import Data and is a development-only tool. In production, configure `FUNNELFOX_SECRET` on the server and keep raw payload debug disabled unless explicitly enabled.

Webhook plan:

```text
POST /api/webhooks/funnelfox
Verify: Fox-Secret-Key
Events: subscription.cancelled, subscription.activated, subscription.renewed
```

Production webhooks are intentionally not implemented in the Vite frontend.

## 9. Forecasting

The Forecasting page uses existing cohort data as the factual base:

```text
transactions + subscriptions
-> computeCohorts
-> selected cohorts
-> absolute retention M1-M12
-> editable scenario
-> forecast output
```

Retention is absolute from original trial users:

```text
Retention_Mn = unique users with successful first_subscription / renewal payment in month n / trial_users
```

Retention includes `first_subscription`, `renewal_2`, `renewal_3`, and `renewal`. It excludes `trial`, `upsell`, failed rows, declined rows, and refund-only rows.

If selected cohorts have no observed paid users in a month, Forecasting falls back to matching historical cohorts with the same campaign path, then global history, then the user-editable default curve from Import Data. The curve is stored in localStorage under `forecasting_default_retention_curve`.
