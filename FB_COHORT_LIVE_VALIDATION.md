# FB Cohorts authenticated live-validation runbook

## Access and feature flag

Runtime allocation diagnostics reuse the existing `clickhouse-cohorts` Edge
Function and the existing protected `/cohorts` page. There is no public debug
endpoint or separate navigation item.

The Edge Function calls `requireSupabaseUser` before parsing the request. A
Supabase anon key without a valid user JWT receives 401. ClickHouse credentials,
the service-role key, timezone configuration, raw payloads and SQL never enter
the response.

Detailed rows are disabled by default. Enable them server-side for a validation
window with:

```text
FB_COHORT_ALLOCATION_DIAGNOSTICS_ENABLED=true
```

Keep the Meta timezone configuration server-side:

```text
FB_META_ACCOUNT_TIMEZONES_JSON={"act_...":"America/Los_Angeles"}
FB_META_DEFAULT_TIMEZONE=America/Los_Angeles
```

Restart or deploy the Edge Function only after explicit production approval.
After validation, set the diagnostics flag back to `false` and redeploy through
the normal controlled process.

## Meaning of the 100-row limit

The value 100 is only the maximum diagnostics page size. It bounds response
payload and browser table rendering during a debug session.

- Campaign Metrics and user_cpp allocation run over the complete visible scope.
- Campaign/Date aggregation happens before diagnostics filtering and pagination.
- Diagnostics filters run before pagination.
- Summary, reconciliation values and `total_rows` are calculated before LIMIT.
- Cohort rows and `fb_totals` never use the page slice.
- Server-side pagination is available with `page`; `page_size` is capped at 100.
- Pages use a stable reporting-date/Campaign/account/status order, so rows do not
  overlap between pages for the same warehouse version and filters.
- When more than 100 rows match, the first page explicitly says:
  `Показаны первые 100 из N Campaign/Date rows`.

The previous implementation applied `slice(0, 100)` after the complete business
calculation, so it did not affect Cohort Spend, but it had no pagination and the
returned array did not disclose the full count. The slice has been replaced by
the explicit diagnostics pagination contract.

## Live-validation procedure

1. Confirm the authenticated production account and active validated
   `fact_user_cohorts` snapshot. Snapshot diagnostics must show zero duplicate
   canonical users.
2. Confirm every participating Meta ad account has a verified IANA timezone in
   the payload or `FB_META_ACCOUNT_TIMEZONES_JSON`. Use the default only when it
   is authoritative for every otherwise-unmapped account.
3. Enable `FB_COHORT_ALLOCATION_DIAGNOSTICS_ENABLED` in the Edge runtime and
   perform the approved deployment.
4. Sign in with a real Supabase user session. Verify an anonymous request and a
   request carrying only the public anon key both receive 401.
5. Open the protected Cohorts page and expand **FB runtime allocation
   diagnostics**. No browser receives ClickHouse credentials or direct database
   access.
6. Select a Cohorts scope broad enough to contain at least 20 real Campaign IDs
   and at least three consecutive Meta reporting dates.
7. Use the diagnostics date inputs. These inputs mean `fb_reporting_date`, not
   product `cohort_date`; record that distinction in the validation evidence.
8. Review every page, not only page 1. Confirm the shown range and `total_rows`
   agree and no Campaign/Date/account key repeats between pages.
9. Validate at least 20 real Campaign IDs across at least three consecutive
   `fb_reporting_date` values. For every row save:
   Campaign ID/name, ad account, Meta timezone/source, FB Spend, FB Purchases,
   matched users, Campaign CPP, allocated/unallocated Spend, coverage and status.
10. Include at least one Campaign whose first-trial timestamps cross a UTC/Meta
    reporting-date boundary. Compare timestamps immediately before and after the
    account-local midnight.
11. Include at least one Campaign affecting multiple funnels and one affecting
    multiple campaign paths. Confirm each user receives one Campaign CPP and
    shared Campaign Spend is not copied into each Cohorts row.
12. If the real reporting window contains a DST transition, validate timestamps
    on both sides. If not, retain the automated DST evidence and record that no
    real DST-period row was available.
13. Validate one complete Meta reporting day, then a three-to-seven-day range.
    For each scope verify:

```text
total_allocated_spend + total_unallocated_spend
≈ total_fb_spend

sum_visible_cohort_spend
≈ total_allocated_spend
```

The allowed money tolerance is ±$0.01 after aggregation.

14. Investigate every non-green status:
    - `underallocated`: explain unmatched FB Purchases and unallocated Spend;
    - `overallocated`: confirm `user_cpp` and Cohort Spend are blocked for the
      Campaign/Date and resolve the data error;
    - `no_matched_users` or `campaign_unmatched`: reconcile attribution scope;
    - `timezone_unverified` or `invalid_timezone`: correct timezone evidence;
    - `invalid_metrics`: correct negative/non-finite/conflicting source metrics.
15. Export or capture the authenticated validation evidence according to the
    production data-handling policy. Do not copy credentials, JWTs, environment
    values, SQL or raw FB payloads.
16. Disable the feature flag after the validation window.

## Rollout blockers

Do not approve production rollout when any of these remain unexplained:

- snapshot duplicate users or failed snapshot validation;
- allocation or visible-spend reconciliation outside ±$0.01;
- any overallocated Campaign/Date;
- invalid metrics;
- missing, invalid or conflicting Meta timezone evidence;
- incomplete pagination review when `total_rows` exceeds the page size.

This checkout has no authenticated production ClickHouse access. Consequently,
the runbook and production-shaped fixtures are provided, but no production
Campaign result is claimed here.
