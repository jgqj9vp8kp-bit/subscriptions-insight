# Data Flow

## 1. Raw Import

Data enters through the Import page from either:

- CSV file
- Public Google Sheet

The project supports two import modes:

- Clean template: already structured analytics rows.
- Palmer raw export: raw payment rows that need normalization and classification.

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

Refunds and chargebacks are stored as negative money movement after status normalization.

## 4. Status Normalization

Palmer statuses are mapped into the app status model:

```text
SETTLED -> success
DECLINED -> failed
REFUNDED -> refunded
CHARGEBACK -> chargeback
```

## 5. Transaction Classification

`classifyUserTransactions` groups transactions by `user_id`, sorts them by `event_time`, and applies explicit product rules:

- first successful `$1` payment is `trial`
- successful `$14.98` payment within 60 minutes after trial is `upsell`
- first successful `$29.99` payment at least 7 days after trial is `first_subscription`
- later successful `$29.99` payments are `renewal`

Each row receives `transaction_type` and `classification_reason`.

## 6. Cohort Assignment

`addCohortFields` finds each user's successful trial and assigns:

- `cohort_date`: date of the trial timestamp
- `cohort_id`: `{funnel}_{cohort_date}`
- `transaction_day`: days since trial timestamp

Example:

```text
trial event_time: 2026-01-01T18:00:00Z
transaction event_time: 2026-01-02T17:30:00Z
transaction_day: 0
```

The example is still D0 because it happened within the first 24 hours after trial.

## 7. Aggregation

`analytics.ts` converts clean transactions into UI-ready metrics:

- KPIs
- revenue by day
- revenue by transaction type
- revenue by funnel
- trial -> upsell -> first_subscription funnel
- users table
- cohort table

Cohort windows are timestamp-based:

- D0 = first 24 hours after trial
- D7 = first 7 days after trial
- D30 = first 30 days after trial
