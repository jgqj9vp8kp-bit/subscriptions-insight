# Architecture

## Overview

This project is a Vite + React + TypeScript subscription analytics dashboard.
It is organized into three main layers:

- UI layer (React): pages and components for Dashboard, Transactions, Users, Cohorts, and Import.
- Data transformation layer: import parsing, Palmer normalization, transaction classification, and cohort assignment.
- Analytics layer: KPI, revenue, user, funnel, and cohort aggregation functions used by the UI.

The UI should stay presentation-focused. Business rules belong in `src/services`, especially in `palmerTransform.ts` and `analytics.ts`.

## Data Flow

Raw Palmer export
-> `normalizePalmerRows`
-> `classifyUserTransactions`
-> `transactions_clean`
-> cohort aggregation by campaign_path + cohort_date
-> UI

The import page can still accept a clean template CSV. In that mode, `applyMapping` maps user-provided columns into the shared `Transaction` shape. In Palmer mode, raw rows are preserved and transformed through the Palmer pipeline before they enter analytics.

## Key Concepts

### transaction_type

`transaction_type` describes the business role of a payment:

- `trial`: first successful $1 payment for a user.
- `upsell`: successful $14.98 payment within 60 minutes after trial.
- `first_subscription`: first successful $29.99 payment around 5-10 days after trial.
- `renewal_2`: first renewal after first_subscription.
- `renewal_3`: second renewal after first_subscription.
- `renewal`: all later renewals.
- `failed_payment`, `refund`, `chargeback`, `unknown`: non-standard or non-success states.

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
