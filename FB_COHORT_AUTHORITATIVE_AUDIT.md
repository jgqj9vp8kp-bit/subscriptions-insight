# FB Analytics → Cohorts: user-first architecture and timezone audit

## Decision

Cohorts no longer receives Campaign Spend directly. The only monetary value
that crosses from Facebook campaign grain to Cohorts user grain is Campaign
CPP:

```text
Campaign CPP = Campaign Spend / Facebook Purchases
user_cpp      = Campaign CPP for the user's Campaign ID + FB Reporting Date
Cohort Spend  = SUM(user_cpp)
Cohort CPP    = Cohort Spend / all authoritative Trial Users in the row
```

The project business invariant is that one Facebook Purchase represents one
unique Trial User. No proportional distribution of Campaign Spend by the
number of Cohorts users is performed.

## Source grains and data flow

The two source grains remain separate:

```text
fact_user_cohorts
  one validated row per canonical_user_id
  campaign_id + trial_timestamp_utc + product cohort dimensions
                    │
                    │ UTC timestamp converted with an explicit IANA timezone
                    ▼
authoritative user key
  campaign_id + fb_reporting_date
                    │
                    ├───────────────┐
                    ▼               ▼
fact_facebook_stats                 Campaign Metrics
  campaign source rows              campaign_id + fb_reporting_date
                                    Spend, Purchases, CPP,
                                    Clicks, Impressions, CTR, CPM, CPC
                                            │
                                            ▼
                                    one user_cpp per matched user
                                            │
                                            ▼
                                    Cohort rows and report totals
                                    aggregate only user_cpp
```

`cohort_date` remains the product acquisition date and is still used by Cohorts
filters and grouping. It is never renamed or reused as `fb_reporting_date`.

The server fetches Campaign Metrics only for authoritative Campaign IDs in the
visible Cohorts scope. It fetches a UTC date envelope of ±1 day so IANA timezone
conversion can safely move a timestamp across a reporting-date boundary.
Adjacent FB dates that no authoritative user requests do not enter allocation
or unallocated-spend diagnostics.

## Campaign Metrics

The intermediate Campaign Metrics layer is grouped by:

```text
Campaign ID + Facebook Reporting Date
```

The warehouse query first groups source rows by date, Campaign, ad account and
currency. The server then forms the Campaign/Date metric and rejects ambiguous
components instead of merging values that have incompatible account, currency
or timezone semantics.

Campaign metrics include:

- Spend and Facebook Purchases;
- Campaign CPP (`Spend / Purchases`, null for zero Purchases);
- Clicks and Impressions;
- CTR (`Clicks / Impressions × 100`);
- CPM (`Spend / Impressions × 1000`);
- CPC (`Spend / Clicks`).

Exact duplicate metric components are idempotent. Negative source metrics are
not allowed to create negative user costs.

Clicks and Impressions remain available in Campaign Metrics validation, but
they are not copied onto Cohorts rows because the approved architecture defines
only a per-user cost. Inventing a per-user click/impression split would be a new
allocation model. The Cohorts fields for those unsupported allocations are
therefore null rather than direct Campaign totals.

## User assignment and row semantics

For every visible authoritative user, the server:

1. normalizes the authoritative Campaign ID;
2. converts `trial_timestamp_utc` to the Meta reporting date;
3. looks up Campaign Metrics by Campaign ID + reporting date;
4. assigns the exact Campaign CPP as `fb_user_cpp` only when the metric is
   allocatable;
5. builds Cohorts rows and totals from those assignments.

Sub-cent precision is retained for `user_cpp` so repeated addition reconciles
to Campaign Spend. Presentation values are rounded to two decimals.

If one Campaign/Date is shared by multiple funnels or campaign paths, users in
each row receive the same Campaign CPP. The campaign total is not copied into
either row. Consequently, the visible row sum is always the report total:

```text
SUM(row.fb_spend) = SUM(all matched users' user_cpp) = totals.fb_spend
```

The fixture audit contains one shared Campaign/Date across two funnels and one
across two campaign paths. Both reconcile without duplicate Spend. No local
persisted production dataset is present in this checkout, so a production
shared-key count cannot be claimed from this machine.

## Coverage and discrepancies

Campaign/Date validation exposes:

- Campaign ID and FB Reporting Date;
- Facebook Purchases and matched authoritative users;
- coverage percentage;
- Campaign CPP and Campaign Spend;
- allocated and unallocated Spend;
- Meta timezone and allocation status.

The runtime diagnostic statuses are:

- `fully_allocated`: matched users equal Facebook Purchases;
- `underallocated`: matched users are fewer than Facebook Purchases;
- `overallocated`: matched users exceed Facebook Purchases and user CPP is
  blocked for that Campaign/Date;
- `campaign_unmatched`: an authoritative Campaign/Date has no FB metric;
- `no_matched_users`: an FB Campaign/Date has no authoritative users;
- `no_fb_purchases`: Purchases are zero, so CPP is undefined;
- `timezone_unverified`: an exact Meta reporting date cannot be proven;
- `invalid_timezone`: explicit timezone evidence is invalid or conflicting;
- `invalid_metrics`: account/currency components conflict or a metric is
  negative, non-finite, or otherwise impossible.

For an underallocated campaign:

```text
Allocated Spend   = CPP × Matched Users
Unallocated Spend = MAX(FB Spend − Allocated Spend, 0)
```

An overallocated campaign is treated as a data error. Its users do not receive
`user_cpp`, so invalid cost cannot inflate Cohorts rows or totals.

## Diagnostics contract

The response exposes the required user-first diagnostics:

- `fb_reporting_date`;
- `fb_campaign_cpp`;
- `fb_user_cpp`;
- `fb_matched_users` and `fb_unmatched_users`;
- `fb_campaign_coverage`;
- `fb_cpp_source = campaign_spend_div_fb_purchases`;
- `fb_timezone`;
- `coverage_rate`.

It also exposes scoped campaign/user counts, allocated and unallocated Spend,
underallocated/overallocated/zero-purchase campaign counts, timezone-unverified
users and snapshot uniqueness. The feature-flagged UI includes a paginated
Campaign/Date allocation table, full-scope summary, filters and unavailable-value
tooltips.

## Timezone audit

### Primer / transaction input

The clean Primer import converts valid input timestamps through JavaScript
`Date` and stores ISO UTC values. Supabase stores transaction `event_time` as
`timestamptz`; the ClickHouse mapper converts it again with `toISOString()`.
The authoritative warehouse representation is therefore an instant in UTC.
Primer files must include `Z` or an explicit offset; a timezone-less timestamp
would otherwise be interpreted by the importing runtime and is not acceptable
as an authoritative instant.

### ClickHouse

- `analytics_transactions.event_time` is `DateTime64(3, 'UTC')`;
- `fact_user_cohorts.trial_event_time` is `DateTime64(3, 'UTC')`;
- `fact_user_cohorts.cohort_date` is derived with `toDate(event_time)` from the
  UTC timestamp, so it is the product UTC date;
- `fact_facebook_stats.stat_date` is a `Date`, not a timestamp.

### Facebook / Meta

Capsuled `date`/`dateFrom` is copied verbatim into `stat_date`. It is treated as
the Meta reporting-date label. The current Capsuled envelope does not guarantee
an ad-account timezone field, so timezone resolution has this order:

1. a valid, unambiguous IANA timezone in the FB raw payload;
2. `FB_META_ACCOUNT_TIMEZONES_JSON`, keyed by `ad_account_id`;
3. `FB_META_DEFAULT_TIMEZONE`.

Both configuration values are server-only. A fixed offset such as `-7` is not
used because it would be wrong across DST and for other ad accounts. Invalid or
conflicting explicit timezone evidence is not hidden by the configured default;
missing evidence is blocked as `timezone_unverified`; invalid or conflicting
evidence is blocked as `invalid_timezone`.

### Browser

The browser timezone is not used for FB matching. Reporting dates are calculated
server-side with `Intl.DateTimeFormat` and an explicit `timeZone`. The browser
only formats presentation values.

Boundary tests cover UTC and both date directions, exact midnight boundaries,
America/Los_Angeles, multiple ad-account timezones, US and European DST start
and end, invalid/conflicting timezone evidence, and browser-timezone isolation.

## Snapshot uniqueness

The materialized snapshot classification version was bumped. Authoritative
fields are explicit members of its per-user classification grain; Campaign ID
is not copied with `any()`, `max()`, or another arbitrary aggregate.

Before activation, validation compares the dynamic classifier with the new
snapshot and calculates duplicates. The active snapshot gate requires:

```text
count(*) = countDistinct(canonical_user_id)
duplicate_users = 0
validation.status = PASS
```

The FB path independently runs the same uniqueness invariant over the complete
active version. It throws before user mapping if the invariant fails, and the
in-memory assembler also rejects a repeated `canonical_user_id`. A later
Campaign/Date `DISTINCT` is never used to conceal duplicate users.

## Local/live-data audit boundary

The checkout contains Supabase public client configuration but no ClickHouse
credentials and no persisted FB export. Therefore the local suite validates
production-shaped Campaign IDs, but this machine cannot honestly report results
for 20 production campaigns. Runtime diagnostics paginate at most 100 rows
per page; the algorithm, Cohort Spend, diagnostics summary and total row count
use the complete scope before pagination. See `FB_COHORT_LIVE_VALIDATION.md` for
the authenticated rollout checklist. `timezone_unverified`, `invalid_timezone`,
`overallocated`, `invalid_metrics` and snapshot uniqueness are explicit blockers.
