# Developer Notes

## ClickHouse SQL gotchas (caught live, do not relearn)

- The project's custom ClickHouse HTTP client does NOT serialize `Array(String)`
  query params. Never write `IN {ids:Array(String)}` — build IN lists with
  `clickHouseBodyStringSet(...)` from `fbCohortStats.ts`.
- ClickHouse substitutes SELECT aliases into sibling expressions. An output alias
  that shadows a column used in ANOTHER aggregate fails with ILLEGAL_AGGREGATION
  (`max(valid_from) AS valid_from` + `argMax(x, valid_from)` elsewhere). Rename
  such aliases (`latest_valid_from`). Self-reference (`argMax(spend, t) AS spend`)
  is safe. The same rule applies inside CREATE VIEW: a WHERE on a column that a
  SELECT alias shadows must live in an inner subquery.
- Table alias goes BEFORE `FINAL`: `FROM t AS x FINAL`, never `FROM t FINAL AS x`.
- Views never take `FINAL`; ReplacingMergeTree tables read through views must
  apply `FINAL` inside the view definition (or use argMax-per-key views).

## ClickHouse transactions: sorting-key drift makes duplicates (2026-09-29)

`analytics_transactions` is ReplacingMergeTree keyed by
`(auth_user_id, cohort_date, funnel, campaign_path, campaign_id, user_id,
event_time, transaction_id)` — five of those columns are DERIVED at mapping
time. A transaction re-synced after its derivation changed (the incremental
Palmer import normalizes a day on its own: `cohort_date` = own day, type
`trial`; the next full pass re-derives `cohort_date`) lands under a NEW key
and FINAL keeps the old copy too. Symptom found live: one 254.99 BRL first
subscription stored twice, the lifecycle classifier numbered the copies
lvl 1 and lvl 2 ("Sub → Renewal 2 CR" 100% three days after the trial), the
`USING(uid, tid)` join fanned each out again, and first-subscription revenue
doubled. Rule: the backfill evicts EVERY existing copy of a batch's
transaction_ids (lightweight `DELETE`, key-agnostic) before inserting;
`clickhouse-backfill {mode:"dedup"}` finds ids with >1 copy through FINAL,
bumps their `updated_at` so the keyset sync re-reads them, and rewrites them.
Parity signal: `clickhouse-summary.transaction_count` must equal the count
of non-deleted Supabase transactions (66,370 == 66,370 after the cleanup);
a gap means copies again. Do not "fix" this in the classifier — deduping
`(uid, tid)` there would hide doubled revenue rather than remove it.

## Payment health P0: raw-row pairing, raw_status, decline parser, refund_observed_at (2026-10-11)

Plan "Payment System Health" phase P0 (owner decision 1). Rollout: README "Payment health P0".

**Raw-row pairing by Primer id.** `prepareWarehouseRecords` (src/services/transactionWarehouse.ts)
used `rawRows[index]` for `rows[index]`, but `transformPalmerRows` re-sorts the transactions
(`classifyUserTransactions` returns newest-first), so output index N is not CSV row N. 32 live rows
got another customer's `raw_payload` (same event second, 5 s apart at most; 6 with the opposite raw
status, 4 with another processor). Now the raw rows are indexed by the transaction_id they produce
(`rawPalmerRowTransactionId`: the same `id` aliases `normalizePalmerRows` uses, `palmer-row-N` as the
fallback; keys trimmed like the lookup, so a whitespace-padded id still matches) and every
transaction takes its own row. A transaction whose id has no raw row never falls back to the
positional row (that would store a neighbour's CSV row again): it stores its own normalized subset
(`row.raw`, as the no-raw-rows path does) and is counted: `WarehouseImportSummary.rawRowsUnpaired`,
the "Raw rows unpaired" tile on Import, `import_batches.metadata.raw_rows_unpaired`. The 32 history rows
were repaired by migration `202610110001` from the row that holds the correct payload
(`raw_payload->>'id' = transaction_id`, same account, snapshots taken in one materialized CTE so a
swapped pair does not interfere); their `normalized_payload->'raw'` was rebuilt with
`app.palmer_normalized_raw`, the SQL mirror of the `raw: {...}` subset `normalizePalmerRows` writes
(`app.palmer_raw_value` = `valueFrom`, `app.palmer_parse_metadata` = `parseMetadata`; the PGlite test
proves the SQL output equals the TypeScript output). The migration also drops the three keys
`normalized_payload` derives from the payload (`card_type`, `normalized_decline_reason`,
`decline_message`) on those rows: the ClickHouse mapper (`cardTypeFromTransaction`,
`declineDetailsForTransaction`) and the browser hydration read them FIRST and fall back to the payload
only when they are absent, and `repairLegacyNormalizedPayloads` had derived them from the merged
(mis-paired) `raw_payload` — 3 success rows carried a decline bucket a neighbour's DECLINED payload
gave them, 14 card types disagreed with the payload (`p0_before_after.sql` #7). Dropped, both
consumers re-derive them from the repaired payload (`normalized_payload->'raw'` carries the funding
type and `declineReasons`, so the slim startup fetch needs no `raw_payload`); the Integrations repair
action re-persists them from the correct payload whenever it is next run. Rows without a normalized
`raw` object keep their keys (the slim fetch would have nothing to re-derive them from). Rule:
`raw_payload->>'id' = transaction_id` on 100% of `palmer_csv` rows (`scripts/sql/p0_before_after.sql`
#4 / #5).

**`country_code` in Postgres.** The Primer CSV has no top-level `ff_country_code` column; the
FunnelFox country lives in `metadata.ff_country_code` (parsed by `parseMetadata`). `normalizeForWarehouse`
tested `typeof raw.ff_country_code === "string"` first, which the empty string satisfied, so the
column was empty on 100% of rows. It now takes the first non-blank of `metadata.ff_country_code` /
`raw.ff_country_code` (and `raw.ff_country_code` itself now falls back to the metadata value). The
semantics are unchanged: the FunnelFox country, never the billing or the issuer country (those are
`billing_country` / `issuer_country` in ClickHouse). The migration backfilled history from the
metadata JSON with a safe parse (`app.try_jsonb_object`; invalid JSON -> skipped; a stored value is
never changed). ClickHouse `country_code` already fell back to metadata and to the user's country
(`transactionMapper.ts` / `userCountry.ts`), so analytics move only where the two differ.

**`transactions.refund_observed_at`.** The Primer export has no refund date; a refund is only
`amount_refunded > 0` on the original payment. The trigger `transactions_set_refund_observed_at`
(`app.transactions_refund_observed_at`, BEFORE INSERT OR UPDATE) stamps `now()` once when
`amount_refunded` goes from null / 0 to > 0 (or on an INSERT that already carries a refund) and then
keeps OLD's value whatever an UPDATE says: an import rewrites the whole row (upsert), so a browser-
written column would be lost, and an explicit NULL or a refund amount back to 0 does not clear it. A
statement that supplies a value on the transition keeps it (the migration backfill: `updated_at` of
every refunded row at rollout — APPROXIMATE, the last rewrite of the row, not the refund; the column
comment says so). The exact date arrives with the settlement report / FunnelFox refund webhook (P3 /
P6). The value rides into ClickHouse `refund_observed_at` (`Nullable(DateTime64(3,'UTC'))`) through
`backfill.ts` `TRANSACTION_SELECT` — which is why the P0 functions must be deployed AFTER the
migration — and ClickHouse Init must be pressed immediately after the deploy, with no CSV import
(post-import auto-sync) and no Continue Backfill in between: the new build inserts the 24
payment-health columns and ClickHouse rejects the batch (unknown JSONEachRow fields) until Init adds
them; the batch's rows are evicted (DELETE before INSERT) until the next successful run after Init
rewrites them (the cursor does not advance on a failed batch). README "Payment health P0" step 4.

**New `analytics_transactions` columns** (`schema.ts` `ALTER_PAYMENT_HEALTH_COLUMNS_SQL`, appended
at the tail, `ADD COLUMN IF NOT EXISTS`, filled by `paymentHealthColumns` in `transactionMapper.ts`
from `raw_payload` with `normalized_payload.raw` as the fallback for legacy rows; a full backfill
fills history): `raw_status` (Primer status verbatim), `processor_merchant_id`, `statement_descriptor`,
`initiation_type` ('cit' | 'mit' | ''), `ff_billing_reason`, `payment_type_flag`,
`primer_decline_code`, `issuer_result_code`, `advice_code`, `advised_action`, `lifecycle_event`,
`decline_record_count` (UInt8), `decline_type`, `three_ds_response`, `three_ds_challenge`,
`three_ds_version`, `is_network_tokenized`, `account_number_type`, `amount_authorized`,
`billing_country`, `payment_instrument_key` (`paymentInstrumentAnalyticsId`: the card fingerprint
without BIN / last4, the retry-chain key), `price_point`, `price_id`, `refund_observed_at`.
Conventions: absent = `''` (never 'unknown'); `three_ds_challenge` and `is_network_tokenized` are
tri-state text ('true' / 'false' / '') because absent is not false (3DS ran on 0.19% of rows);
`amount_authorized` is in the ORIGINAL currency with the amount's minor-unit rule (`normalizeAmount`:
JPY has no minor unit, decimal cells are not divided), 0 when absent. The decline columns come from
the LAST `declineReasons` record (the final outcome of a cascade / retry inside one payment);
`decline_record_count` keeps how many records the cell held (362 rows > 1, plan G `cascade_rows`).
`decline_type` is DERIVED from `advised_action` (`declineTypeFromAdvisedAction`): RETRY_LATER ->
'soft', DO_NOT_RETRY / STOP_ALL_PAYMENTS -> 'hard', UPDATE_DATA -> 'update', else '' — Primer's own
SOFT / HARD lives in the Payments API, not in the CSV. The existing `decline_reason` bucket is
untouched (still `paymentFailures.ts` over the first record).

**`parseDeclineReasons` (`_shared/clickhouse/declineReasons.ts`, pure).** The cell is the Python
repr of a list of dicts: single-quoted strings, double-quoted when the value holds an apostrophe,
backslash escapes when it holds both, `None` / `True` / `False`, commas inside messages, several
records per cell; sometimes real JSON (`[]`, `null`). A small recursive-descent parser over the
literal subset both syntaxes share (lists, dicts, strings in either quote with escapes, numbers,
the literals) returns `DeclineRecord[]` with every known field present (`''` for None / missing,
'true' / 'false' for booleans, unknown keys ignored); a cell that is neither falls back to a
quote-anchored per-field extraction (records rebuilt positionally) so the mapper never throws. The
query-time regexes in `users.ts` (`declineMessageSQL`) and `paymentFailures.ts`
(`parseDeclineReasonRecords`) are unchanged and keep working: `raw_payload` holds the same cell.

**Payment Pass denominator (plan G `attempts`).** `paymentAnalytics.ts` `allrows` now adds
`raw_status NOT IN ('CANCELLED', 'PENDING')` (`ATTEMPT_RAW_STATUS_EXCLUSION`): attempts =
SETTLED / DECLINED / FAILED. Banks shares the staged table, so it moves with it. `status` is NOT
changed (`normalizeStatus` still maps CANCELLED / PENDING to `failed`): a new status value would turn
~210 such rows without an earlier payment into trial anchors and shift cohorts, revenue and
`fact_user_cohorts` app-wide. Rows synced before the full backfill carry `raw_status = ''` and are
kept, so the numbers move only once the backfill has run. Users → declines (`users.ts`) keeps its own
attempt list and is unchanged.

**Reports.** `reportCollect.ts` `processor_split`: the "no Adyen transactions" note was stale (Adyen
rows exist since 2026-07-30, `processor` is in the warehouse); the metric stays unavailable until the
split is wired into reports.

**Still open after P0** (plan AC): the PII / card-fragment cleanup of the two ClickHouse JSON columns
is postponed (owner decision 2).

## Payment health P2 backend: clickhouse-payment-health (2026-10-12)

Plan "Payment System Health" phase P2 (MVP, owner decisions 3 / 4 / 10): the server side of the
Payment System Health page. Rollout: README "Payment health P2". Files: Edge function
`supabase/functions/clickhouse-payment-health/index.ts`, policy
`_shared/access/policies/clickhouse-payment-health.ts`, runner `_shared/clickhouse/paymentHealth.ts`,
contract `_shared/clickhouse/paymentHealthContract.ts` (request / response shapes the browser data
source imports), migration `202610120001_payment_health_permissions.sql`. Tests:
`accessEdgePaymentHealth.test.ts` (gate), `paymentHealthClickhouse.test.ts` (SQL + parity on
fixtures), `paymentHealthPermissionsMigration.test.ts` (PGlite), `support/paymentHealthFixtures.ts`
(a semantic ClickHouse responder: it answers the runner's statements from fixture rows with the
SQL's own window / period / filter / group-by semantics, dispatched on the `/* ph:<name> */` marker
every statement carries, so the parity expectations are computed independently of the runner).

**Actions** (body `action`, POST only, no default; every other value is 400 `unknown_action`):
`overview`, `declines`, `retries`, `refunds_support`, `sources`, `options`. All need
`payment_health.view`; none is scopeReady (a funnel-restricted member gets 403 `scope_not_supported`,
like Payment Pass; the restricted variant is plan P7).

**PSP dimensions behind `payment_health.psp_global.view`** (plan X; the task's "gate or strip" choice:
strip). Processor, merchant account (MID) and descriptor are whole-tenant account figures. A caller
without the privileged key (the data owner always has it) still gets every action, but: the overview's
`psp_mid_rows` is `[]` and `what_changed` skips the processor / merchant_account dimensions; the
options' `processor` / `merchant_account` / `descriptor` lists are `[]` and `dimensions` omits the
three; the retries rows carry `processor: null`, `merchant_account: null`; the complaints
`by_account` is `[]`; `meta.psp_global_visible` is false. A request that NAMES a PSP filter or
dimension without the key is refused with 403 `permission_denied` (`PaymentHealthPermissionError`
through `paymentHealthErrorResponse`), never answered with other numbers than it asked for; the default
dimension is `funnel` for such a caller, `processor` otherwise.

**Request** (`normalizePaymentHealthRequest`): `date_from` / `date_to` (YYYY-MM-DD, inclusive;
default the last 30 days up to today UTC; at most 400 days; a longer or inverted window is 400
`invalid_request`), `filters` (`processor[]` keys as options lists them incl. `unrouted`;
`merchant_account[]` and `descriptor[]` OPAQUE ids from options; `funnel[]` anchor campaign paths or
`unattributed`; `country[]` issuer-country codes or `unknown`; `card_network[]`, `payment_method[]`
upper-cased; `initiation[]` cit / mit / unknown; `transaction_type[]` raw column values; lists
de-duplicated after normalization, 200 values each), `dimension` (declines / refunds_support
breakdown: processor, merchant_account, descriptor, funnel, country, card_network, payment_method,
initiation, stage). The comparison window is the previous window of the same length (`compare`), read
in the SAME scan as the current one (`period` column).

**SQL** (`attemptCtes`, CTE-only, no scratch table, every statement binds `{auth_user_id:String}`):
`anchors` (the validated `fact_user_cohorts` snapshot: `clickhouse_cohort_snapshot_state` through
`activeCohortSnapshotVersion`; no snapshot → versions bound as `''`, every row `unattributed`,
`meta.funnel_attribution.status = 'no_snapshot'`) → `src` (`analytics_transactions FINAL` of the
window, `raw_status NOT IN ('CANCELLED', 'PENDING')` = `ATTEMPT_RAW_STATUS_EXCLUSION`, LEFT JOIN
anchors on `user_id = canonical_user_id`; raw columns aliased `*_raw` where a derived column reuses
the name — an alias shadowing the column its expression reads is a ClickHouse cyclic-alias trap) →
`base` (derived: `period`, `processor` = upper or `unrouted`, `initiation` (`unknown` for ''),
`stage` (`STAGE_SQL`: a success's type; a decline's `declined_<ff_billing_reason>` else
`declined_mit` / `declined_cit` / `declined_unknown` — a heuristic, labelled), `card_network`,
`payment_method`, `country` = `issuer_country` (98.4% filled vs 77.4% billing; `COUNTRY_BASIS`),
`funnel`) → `att` (the request's filters; MID / descriptor ids are mapped back to the raw values
through the registry and bound as `(processor, processor_merchant_id) IN ((…), …)` tuples, an unknown
id is 400). Attempts = `count()`, successes = `sum(is_success)`, amounts = `sumIf(amount_usd,
is_success = 1)`: parity with Payment Pass on attempts / successes by processor and day is a test.

**Decline classes**: the grouped SQL carries the raw code columns (`is_success, lifecycle_event,
issuer_result_code, primer_decline_code, advice_code, advised_action, decline_type, card_network_raw,
proc, cascade_row, three_ds`) and the Edge classifies each group with `classifyDecline`
(`declineTaxonomy.ts`) — one taxonomy, never a SQL copy of it. `issuer_fraud_declines` is the
`issuer_suspected_fraud` class (the issuer's suspicion code, never "fraud"). The overview's trend
groups by day (≤ 120-day windows) or Monday-week (`toStartOfWeek(day, 1)`) with the code columns, so
the per-bucket fraud-suspicion count is classified the same way.

**Registry labels** (`loadDimensionRegistry`): `public.psp_accounts` (service role, `auth_user_id =
tenant`) × the distinct `(processor, MID, descriptor)` triples of the tenant's attempts (`/* ph:registry
*/`, also the warehouse's first / last attempt day = `meta.data_through`). Known MID → `{ key:
psp_accounts.id, label }`; unknown MID → `key 'unlabelled:<16-hex keyed hash>'`, label "Unlabelled
MID" (`labelled: false` — run `psp_accounts_sync` after an import; the runner does not call it, see
README); no MID → `none:<processor>` / "No MID". Descriptors: `key 'd:<16-hex keyed hash>'`, label
"<Processor> descriptor #n" numbered per processor by first seen, or "<prefix> (<account label>)"
when a registry `descriptor_prefix` of that processor matches. The keyed hash is
`sha256(tenantKey|kind|processor|value)` (`opaqueId`): stable within the workspace, meaningless
outside it; raw MIDs, descriptors and instrument keys never leave the server.

**retries**: the window's attempt rows plus `RETRY_LOOKBACK_DAYS` (30) before it (a ban issued before
the window still bans), minimal columns (`event_time` as `toUnixTimestamp64Milli` → ISO in the Edge,
never a local-time parse), `ORDER BY event_time, transaction_id LIMIT {row_cap}` with
`ATTEMPT_ROW_CAP + 1` (300,001) → `meta.limited.attempt_rows`. `computeRetries` runs
`buildAttemptChains` + `retryCompliance` and keeps chains that STARTED in the window, post-ban attempts
and rolling windows that END in it; the summaries are recomputed over that subset
(`post_ban.within_window`). The report is memoized per `tenantKey | sha256(range + filters)` for
`PAYMENT_HEALTH_MEMO_TTL_MS` (60 s, 16 entries, in-flight coalescing, a failed load never cached —
the leads.ts pattern); the memo holds the PSP-visible report and `stripRetriesForViewer` nulls the
account references for a caller without the key. Post-ban rows: newest 200, instrument = keyed hash,
no transaction ids; rolling windows: the pairs over the limit (≤ 100). Each cap that was hit is said in
`meta.limited` (`attempt_rows`, `post_ban_attempts`, `rolling_windows`; the declines action likewise
reports `code_mix` when more than `CODE_MIX_LIMIT` code groups were cut), so the UI's "cap hit" badge
appears instead of a truncated list posing as the whole. `cascade_rows` is the plan G definition in every
tab — every row with `decline_record_count > 1`, a payment that settled after an in-payment cascade
included — accumulated from the SQL `cascade_row` flag, not from the decline classification.

**refunds_support**: refunds by original payment date (`is_success = 1 AND is_refund = 1`, the
Primer row stays SETTLED with `amount_refunded > 0`), by dimension (both windows) and by month
(current); timing buckets from `refund_observed_at` (`dateDiff('day', event_time, refund_observed_at)`
≤ 7 / 30 / 90 / beyond; `unobserved` = refunded rows synced before P0). Complaints (`/* ph:complaints
*/`): `fact_support_requests FINAL` of both windows by `request_date`, attributed to the LAST settled
payment of `matched_user_id` within `COMPLAINT_ATTRIBUTION_DAYS` (30) before `received_at`
(`argMax(proc, paid_at)` over an INNER JOIN on the user with the time predicate; settled rows read from
30 days before the baseline window), else `unattributed` (also when `matched_user_id` is ''). By
received month with the `classification_version` set and a `version_break` flag (the set differs from
the previous month: plan F), by category, by account (current window, PSP key only).
`support_unauthorized_rate` = flagged requests over the window's settled payments **regardless of the
request's filters**: a support request carries no funnel / country / network / initiation, so the
numerator cannot be filtered and the denominator comes from a second filter-free statement (`/*
ph:settled_counts */`, settled payments of both windows per processor × MID) rather than the filtered
`att` CTE — numerator and denominator describe the same population. The PSP × MID row carries the same
figure per account as `complaint_rate` (server-computed; the browser never divides the complaints by
the filtered successes). `COMPLAINT_NOTE` says so in `meta.estimates`.

**sources**: tenant-wide coverage per P0 column (`countIf(col != '')` / `> 0` over attempt rows;
decline-record coverage over declines, `refund_observed_at` over refunded rows), warehouse bounds and
`max(clickhouse_synced_at)` (read as `toUnixTimestamp64Milli` and returned as ISO with a zone — a
zone-less ClickHouse DateTime text would be parsed as LOCAL time by the browser), the last `import_batches` row (`user_id = tenant`: imported_at, status,
counts, source — not the filename), the transactions sync state reduced to lifecycle fields (status,
updated_at, last_run_at — no cursor, counters or error text), support requests by month with versions,
and the metric dictionary with `available` = phase P1 / P2.

**options**: one scan of the whole tenant history through the same base (`window 1970-01-02 …
2100-12-31`, inside the ClickHouse `Date` range; no filters; `ARRAY JOIN` of `(dimension, value)`
tuples → one GROUP BY), the registry lists for the PSP key, `bounds` from the registry.

**meta** on every response: `range`, `compare`, `data_through` (newest attempt day), `incomplete`
(`range.to` after it: the manual import has not covered the window, plan P), `lag_days`,
`funnel_attribution`, `country_basis`, `psp_global_visible`, `limited`, `estimates` (plain-language
notes: the anchor funnel differs from Payment Pass's per-user split, chains are a heuristic, the
network rules are unverified, refund dates are approximate, the complaint rule, the maturity rule),
`definitions` (metric dictionary keys), `query_duration_ms`. No diagnostics beyond that (no tenant-wide
counters a filtered action would not already return).

**Maturity of the comparisons** (`maturityOf`, computed once per run so `meta.incomplete` and the
comparisons cannot drift): every `comparePeriods` call gets `{ immature }` — `immature` = the
incomplete flag for the approval, issuer-suspicion and per-class rates; for `refund_rate` and
`support_unauthorized_rate`, which are time-to-event figures by original payment date (the newest
window is structurally lower because its payments have had fewer days to be refunded or complained
about), `refund_immature` = incomplete OR `data_through` less than `REFUND_MATURITY_DAYS` (30, the
contract) past `range.to`. An immature comparison carries `significance_reason: 'immature_period'`
and is never `significant` (the UI draws the grey "incomplete period" badge from it). The overview's
trend is filled over the whole window (`trendBuckets`: every day, or every Monday from the week of
`range.from`): a bucket without attempts is a zero point and a bucket after `data_through` is flagged
`incomplete` — only a filled series can show that, since `data_through` is the newest attempt day.

**Errors**: `PaymentHealthRequestError` → 400 `invalid_request`; `PaymentHealthPermissionError` →
403 `permission_denied` — counted by `access_record_denial` like a gate-level refusal (the gate's
`handlerErrorResponse` records any 403 the handler raises, `ScopeForbiddenError` included, and logs it
as `access_denied`, not `handler_failed`); anything else → the gate's 502 (sanitized for employees); a
`ScopeViolation` is rethrown from every best-effort catch (snapshot state, sync state) and becomes 500
`scope_violation`. Timeout 55 s like clickhouse-payment-analytics.

**Live SQL not yet exercised.** The statements are proven on the recording client and the semantic
fixture responder, not against ClickHouse: the first live call should be the owner's, on the
`sources` and `options` actions first (one statement each), then `overview`.

## Payment health P2 frontend: /payment-health (2026-10-12)

The page over the function above (README "Payment System Health (page)" for what each tab means).
Files: page `src/pages/PaymentHealth.tsx`; components `src/components/payment-health/*`
(`PaymentHealthFilterBar`, `OverviewTab`, `DeclinesTab`, `RetriesTab`, `RefundsComplaintsTab`,
`SourcesTab`, `DimensionSelect`, `shared.tsx` = QueryFrame / comparison cells / MetaNotes /
Sparkline / placeholder, `format.ts` + `model.ts` + `pageState.ts` = pure helpers); data source
`src/services/paymentHealthDataSource.ts`; cache keys `src/services/paymentHealthCache.ts`; hook
`src/hooks/usePaymentHealth.ts`; invoke `runClickHousePaymentHealth` in `src/services/clickhouse.ts`
(breaker-gated like Payment Pass, no legacy engine). Tests: `paymentHealthPage.test.tsx` (every tab
from typed fixtures, filters, persistence, PSP stripping, 403 → NoAccess, leak scan),
`paymentHealthDataSource.test.ts` (request builders against the server normalizer, shape check,
typed errors, cache keys, page state, formatting rules), `paymentHealthHooks.test.tsx` (partition
keys, no retry on 4xx, SWR), `support/paymentHealthResponses.ts` (fixtures with planted sentinels);
`accessShell.test.tsx` / `accessRoutes.test.ts` pin the route, the sidebar item and the guard.

**Wiring.** `ROUTE_ACCESS` `/payment-health`: `anyOf ["payment_health.view"]`, `restrictedReady:
false` (right after `/transactions`, so `firstAllowedRoute` order is unchanged for the existing
roles); `App.tsx` lazy route inside `RequirePermission route="/payment-health"`; sidebar item
"Payment health" (HeartPulse) after Transactions; `PAGE_TITLES` for the admin preview. The page
reads `payment_health.view` only — the PSP key is never checked in the browser.

**Types are the Edge contract.** The data source imports the request / response types from
`supabase/functions/_shared/clickhouse/paymentHealthContract.ts` (and the labels from
`declineTaxonomy.ts`, both pure modules), so a field the server renames fails `tsc` here, not in a
tab. `buildPaymentHealthRequest(action, query)`: window-free actions (`options`, `sources`) send the
action alone; the dimension goes only with `declines` / `refunds_support`; empty filter lists are
omitted; the test feeds every built body through the server's `normalizePaymentHealthRequest`.
`loadPaymentHealth` throws on a 200 with `ok:false` and on an incomplete body
(`isCompletePaymentHealthResponse`: required top-level fields per action), so the tables never
render zeros from a half answer. `describePaymentHealthError` → `kind` access (gate 401/403/404/409
codes: NoAccess, never retried) / request (400) / upstream (5xx) / transport / shape.

**Cache.** Key `["payment-health", action, schema 1, access partition, warehouse version,
normalized request]` (`paymentHealthQueryKey`): the partition slot is `useAccess().partition`
through `useCacheScope`, `""` ⇒ the query stays disabled. `"payment-health"` is in
`WAREHOUSE_DEPENDENT_ROOTS` (persisted with the other analytics roots, refetched after an import +
sync; the version slot already re-keys). SWR with `keepPreviousData`, `transientRetry` (a 4xx is
never asked again). Only the active tab mounts its query; the others fetch when opened.

**PSP visibility.** `meta.psp_global_visible` of the `options` response decides everything: the
PSP × MID table, the registry filters, the account columns of the retry tables, the complaints
by-account table and the three PSP dimensions in the picker. `effectiveQuery(state, pspVisible,
today)` (pageState.ts) strips a persisted PSP filter / dimension when it is false, and the windowed
queries stay disabled until `options` has settled whenever the persisted state names one
(`hasPspSelection`) — a stale filter from a session that had the key can never turn into a 403.
Without a PSP selection the first tab request goes out in parallel with `options`.

**Page state** (`usePersistedPageState("ui_state_payment_health")`, per principal): tab, range
preset (`7d | 14d | 30d | 90d | custom`: presets are re-resolved against today's UTC day on every
render, so "last 30 days" rolls; custom keeps the two dates), one value per filter (`"all"` = none;
the request carries one-element lists, the contract accepts arrays for a later multi-select),
dimension (`""` = the server default: processor with the key, funnel without). The compare caption
uses the contract's `windowsFor`. A custom window the server would refuse (`customRangeProblem`:
from after to, over `MAX_RANGE_DAYS`) is not sent: the windowed queries stay disabled, the filter bar
names the problem and the tab shows the hook's `isDisabled` state (`QueryFrame` idle card with the
page's `idleNote`) instead of a progress bar or an error card per keystroke. "Clear" resets the
filters and the preset but keeps the open tab and the dimension. An `options` failure that is not
an access denial is said in the filter bar with a retry (the lists stay empty, the banner reads
"data through unknown", the tabs still load without the PSP parts); an access denial on `options`
renders NoAccess for the Data Sources tab directly, since the same gate would refuse it.

**Rendering rules** (format.ts, pinned by tests): `fmtPct(null)` = "no data" (never 0%);
`summarizeComparison` takes `significant` / `small_sample` / `immature_period` from the server
(never from the delta) and maps the arrow to a tone through `higherIsBetter` (approval up = good,
refunds / issuer-suspected-fraud / complaints up = bad); `MetaNotes` shows `meta.estimates`
verbatim plus the grey "incomplete period" badge, the no-snapshot badge and any `limited` cap.
Instrument keys appear as 10-character prefixes of the server's opaque hash; MIDs and descriptors
only as the registry labels; the Retries tab carries an explicit "Rules unverified" note and
"heuristic" badges on the chain rates. Disputes / 3DS / alerts: one `DisputesPlaceholderCard`
(Overview and Refunds), no tab.

**Not done / later.** Multi-select filters (the contract already takes arrays); an export button
behind `payment_health.export`; the Disputes / 3DS / Alerts tabs (P2.5 / P3); a restricted
(funnel-scoped) variant (plan P7). The page has not been exercised against the live function yet
(see "Live SQL not yet exercised" above): the first live open should be the owner's, Data Sources
tab first.

## Known Limitations

- Palmer column names can vary by export. `palmerTransform.ts` supports common aliases, but new exports may require additional aliases.
- Metadata can be missing, malformed, or split across direct columns and JSON payloads.
- Funnel detection is string-based and intentionally conservative.
- Successful non-upsell transactions are classified by lifecycle order, not by strict product price windows.
- Existing clean-template imports are trusted more than Palmer imports because they already include `transaction_type`.
- FunnelFox subscription monitoring is imported separately from Palmer transactions. It does not mutate Palmer transactions, but Cohorts and Dashboard use it for active/cancellation metrics after matching by normalized email.
- FunnelFox API secrets must stay server-side; do not expose `FUNNELFOX_SECRET` in Vite/browser code.
- Import Data is the single connection center. Keep Palmer import/cache, Facebook traffic import, FunnelFox sync/test, and local saved-data controls there; analytics pages should not own data loading controls.
- Page filters and small UI settings are persisted through `usePersistedPageState`; never put imported datasets, raw API payloads, or secrets into page UI state.
- Subengine requires Supabase Auth before analytics routes render. Keep Supabase credentials in environment variables and disable public signup in the Supabase project.
- Support Inbox reads Mail.ru only from the `sync-support-mail` Supabase Edge Function. Do not put `MAILRU_IMAP_PASSWORD`, service role keys, raw IMAP credentials, or full email bodies in frontend logs or browser state.

## Assumptions

- trial = first successful non-upsell payment
- upsell = payment whose `ff_billing_reason` contains `upsell`, or a known upsell amount within 60 minutes after trial
- first_subscription = next successful non-upsell payment after trial
- renewal_2 = next successful non-upsell payment after first_subscription
- renewal_3 = next successful non-upsell payment after renewal_2
- renewal = later successful non-upsell payments after staged renewals
- revenue analytics use net revenue, not gross revenue
- cohort_date is based on the user's successful trial timestamp
- cohort_id is `{campaign_path}_{cohort_date}`
- funnel is broad and campaign_path is exact; do not group cohorts by funnel

## Edge Cases

- Missing metadata: funnel becomes `unknown`.
- Missing campaign path: campaign_path becomes `unknown`.
- Same landing path in two FunnelFox projects (`quiz.brainza.app/test-iq` and `f.foxiq.app/test-iq`): `normalizeCampaignPath` drops the host, so `withProjectPathPrefix` in `palmerTransform.ts` prefixes every path of a listed project (`CAMPAIGN_PATH_PROJECT_PREFIXES`, keyed by `metadata.ff_project_id`; only Brainza -> `brainza-`, owner decision 2026-10-18). Migration `202610180001` rewrote the stored history with the same rule (the campaign_path column and payload, plus the user-scoped cohort_id). Adding a project to the map needs the same kind of history migration. Sources that carry no project id still see the bare path: Google Sheet traffic typed by media buyers, the FunnelFox registry alias, and `recompute_funnel_active_status`, which reads the raw `ff_campaign_path`.
- Unknown funnels: stay `unknown`; do not default to `past_life`.
- Users without email: Palmer import keeps email empty and uses customerId, metadata email, or a unique `unknown_user_N` as user_id.
- Users without a successful trial: cohort fields are incomplete and `transaction_day` is `null`.
- Declined payments: classified as `failed_payment` and excluded from money-moving sums.
- Refunds from Palmer `amountRefunded`: status is preserved, refund amount is stored separately, and net revenue is gross minus refund.
- FunnelFox cancelled subscriptions may remain active until `period_ends_at`.
- FunnelFox mock mode returns no subscriptions until a backend proxy is configured.
- Set `VITE_FUNNELFOX_MOCK=false` only after a backend proxy exists; the browser still must not receive `FUNNELFOX_SECRET`.
- FunnelFox subscriptions are cached in IndexedDB, not localStorage.
- IndexedDB is the fast local cache, while Supabase `data_snapshots` is the cross-device source of truth for imported Palmer data, FunnelFox subscription snapshots, Facebook traffic data, and forecasting default settings.
- localStorage is only for small UI state such as filters, column settings, selected views, and forecast assumptions.

## Cohorts: Product filter (2026-10-18)

A product is a FunnelFox project (`metadata.ff_project_id`), labelled by its landing domain (`azora-astro.com`, `brainza.app`, `foxiq.app`, …; metadata-less cohorts form `Unknown`).

It is not a cohort dimension. Since the Brainza path prefix (migration `202610180001`), every campaign_path belongs to one project. The `clickhouse-cohorts` action `product_paths` (`cohortProducts.ts`) returns the path -> project map, read from successful `analytics_transactions` rows. The page (`cohortProductFilter.ts`) turns the selected products into the campaign_path filter: the picked paths narrowed to the products, or all of the products' paths. An empty overlap sends the `NO_PRODUCT_PATH` sentinel, so the report is empty instead of widening. Snapshot, scope and fallback engines are therefore unchanged. The path picker only offers the selected products' paths.

`product_paths` is not scopeReady: it reads `normalized_payload`, which the restricted scope never exposes. A funnel-restricted member gets 403 and the page hides the filter. Product counts are trial users over all time; they do not cascade with the other filters.

## Cohorts: "Users" view and payment-failure columns (2026-10-18)

The built-in "Users" view shows what happened to a cohort's users after the trial: First Sub, the renewal steps, declined charges and refunds.

The declined-charge columns (`cohortPaymentFailures.ts`, hidden by default) reuse the Users page Decline Analytics classification:
- A failed attempt is a warehouse row with status `failed` from the trial on.
- Stage = the user's lifecycle level before the attempt (`pre_lvl`): none → after trial, 1 → after the first subscription, ≥2 → after a renewal.
- Reason = the stored normalized `decline_reason`, grouped into 7 columns (Insufficient Funds, Fraud, Card Not Supported, Do Not Honor / Generic, 3DS, Card Lost / Stolen / Expired, Other).
- The reason groups are split by stage (2026-10-19). The server returns every stage, `DECLINE_STAGES`:
  - the bare column = after trial;
  - `_first_sub`, `_renewal` and `_all` = the other stages.
- The page's "Declines" switch (`uiState.declineStage`, default after trial) projects the rows once at `effectiveFilteredCohorts` (`projectDeclineStage`). Cells, Total, Funnels, sorting and exports therefore follow it without a refetch.
- Counts are distinct users. A user declined for several reasons counts in each group.

Engines:
- Materialized: `dr` / `pre_lvl` are added in `materializedFinxCtes`.
- Dynamic: they are added in `emailTokenSQL`'s `finx` (a `fdr` lookup plus a window). `classifierSQL` is untouched on purpose, because the snapshot rebuild golden corpus and the Users / Payment pages share it.
- `TX_COLS` gained `decline_reason` (a token, never a message) so the restricted scope can read it. The owner SQL golden corpus was regenerated for this owner-requested change.
- Rows cached before the release carry no counts and show "—".

### Cancellations on the ClickHouse path (step 2, 2026-10-18)

`fact_subscriptions` now has a writer: `factSubscriptionsSync.ts`, called at the end of the FunnelFox subscriptions sync (finalize stage, best-effort).
- It does a full tenant refresh. Every row carries the run version, older rows are deleted afterwards, and nothing is deleted after an empty read.
- The cancel date and reason come from `raw_detail` (`cancelled_at`, `cancellation_reason`), because the `cancelled_at` column was never filled. The fallback is `updated_at` for a cancelled subscription, as in `normalizeSubscription`.
- `raw_detail` is a card first fetched about the purchase; since 2026-10-19 the sync re-fetches it when the list no longer matches it (see "Stale detail cards" below). FunnelFox gives no `cancelled_at` in it, so the fallback decides the cancel date. Since 2026-10-19 the card's `updated_at` is used only when the card already shows the cancel (renewal off, or a cancel status). Otherwise the list's `updated_at` is used, which every sync refreshes.
  - Before the fix, a subscription cancelled after its card was taken got a cancel date at the purchase. A declined first charge three days later then fell outside the 48 h window.
  - Example: the palm-reading-month-web cohort of Oct 7–14 showed 192 user / 0 auto cancels. With the fix, about 117 / 75.
  - The fix moves 1,410 of 14,545 cancelled subscriptions, by about 10.7 days on average.
- Sandbox subscriptions are skipped. The raw email is never stored.
- `ensureFactSubscriptionsSchema` (also run by ClickHouse Init) re-asserts every non-key column, because production holds a copy of the table created by an earlier build.

`cohortCancellations.ts` turns the subscriptions into per-email flags (CTEs `csub` / `cauto` / `cflags`). The measures read them by `IN (SELECT sub_email FROM cflags …)` over `u_normalized_email`, like `support_users`.

The rule started as the legacy client engine's. Since 2026-10-19 (owner decision) it is, per subscription:
1. FunnelFox reason "User requested cancellation" → user, always, even after a declined charge.
2. A failed transaction within 48 h before the cancel → auto, unless it belongs to the checkout: declines before the subscription start or in its first 2 h (`CANCELLATION_PURCHASE_WINDOW_MS`) do not count.
3. Cancelled at or after the period end → auto.
4. Otherwise → user.

Per member, the precedence is: user reason > auto (failed) > user > auto (period end).

Why the checkout bound: with a 3-day trial the 48 h window covered most of the trial, so an upsell declined right after the purchase turned a user's own cancel into "auto". Data for July–October 2026: checkout declines land before the start or in its first 2 h, period charges 60 h or more after it, with almost nothing between. `period_ends_at` cannot serve as the bound: for a paid trial on a monthly plan, FunnelFox shows the period end at day 14 while the first charge runs at day 7. The subscription start is `fact_subscriptions.started_at` (FunnelFox `created_at`, added 2026-10-19). A row without it keeps the plain 48 h window. The legacy client engine (`cohortAnalytics.ts`) still uses the old rule.

Measured on September 2026 cohorts (Postgres approximation): user 899 → 1,029, auto 652 → 522. The reason rule alone moves about 50 users; the checkout bound moves about 80 more. Those figures still used the stale card date. With the cancel-date fix the estimate is user 629, auto 922.

Restricted members read through `subscriptionsFrom(scope)` (`SUB_COLS`, no raw email). Rows ship synthetic cohort-scoped ids so the Total / Funnels id-set counts add up. The Users page subscription status (`users.ts`) reads the same table.

Rollout order: deploy the sync first, run it (finalize), then deploy the cohort SQL. Otherwise the cohort query references `cancellation_reason` before the column exists. The 2026-10-19 change follows the same order for `started_at`.

## Cohorts: shared views (2026-10-18)

Personal saved views live in the author's own `data_snapshots` row (`cohorts_ui_settings`), which RLS keeps to that account. Workspace-wide views live in `public.shared_cohort_views` (migration `202610180002`).
- Reads go to every active member with `cohorts.view`, including funnel-restricted ones. A view is only a column layout; the data stays scoped by the gate.
- Writes are for the workspace Owner only (`app.is_workspace_owner()`). No catalog permission exists for it yet.
- The Views popover lists them with a "shared" badge. The Owner shares a personal view with the people icon; a shared view of the same name is updated in place. The trash icon on a shared view removes it for everyone.
- A shared view's page id is `shared:<uuid>`. `sanitizeCohortsUiSettingsPayload` keeps such a `selectedView`, so the "View:" label survives a cloud reload.
- Default view per role (migration `202610180003`, column `default_role_keys` = `access_roles.key`): the Owner ticks roles with the person-check icon on a shared view.
  - A member of such a role lands on the view when they have no active view and no personal views. If several views name the role, the most recently updated wins.
  - It lands once per member and view. The marker `cohorts_role_default_applied:<principal hash>` lives in localStorage; members have no cloud copy of their Cohorts settings. Columns they change afterwards are kept.
  - A member whose active view is a shared view gets it re-applied on every load, so the Owner's later edits reach them.
  - The frontend selects `default_role_keys`, so `202610180003` must be applied BEFORE the frontend ships. Otherwise the shared-view list fails to load and shows nothing.

## Cohorts: Funnels view (2026-08)

The Cohorts page has two view modes (persisted `viewMode`, default `cohorts`):
one row per cohort date, or one row per `campaign_path` over the selected
period ("Funnels"). Both are projections of the SAME dataset and totals
engine — `computeCohortReportTotals` (shared, also feeds fbAnalyticsSummary)
builds the Total row, each funnel pseudo-row (`src/services/funnelView.ts`,
synthetic `funnelpath:` ids) and the weekly report rollup. Invariant, pinned
by `src/test/funnelViewRollup.test.ts`: Funnels TOTAL == Cohorts TOTAL, and a
single selected path's funnel row equals the Cohorts Total for that path.

Aggregation rules (proven by the totals engine): trial-anchored counts are
additive (a user belongs to exactly one cohort row); only active users /
active subscriptions need id-array unions (the email-keyed FunnelFox overlay
can duplicate across rows); every ratio recomputes from summed
numerator/denominator — never averaged. Traffic joins by (date, path) and is
deduplicated per key (`funnelTrafficForGroup`) in BOTH the Total row and
funnel rows: a campaign path feeding two funnels on one day counts that day's
spend once (the pre-2026-08 Total double-counted this case). FB fields sum
exactly (per-user allocation partitions across rows); business ratios
re-derive via `deriveFbBusinessMetrics` on the aggregated inputs.

Funnel-grain details: `action: "details"` with `funnel_key: {campaign_path}`
scopes to every cohort of one path within `date_from/date_to` — the date
window and funnel filter are applied in WHERE explicitly because on the list
path they are cohort-level HAVING post-filters that details has no
equivalent of. `refund_status` is not reproduced there (the UI hardcodes
"all"). Columns with no funnel-grain meaning (`cohort_date`, `currency_mix`,
`fx_missing_amount`) are filtered from the visible order per mode (`ai_action`
works in both modes since path-grain recommendations); column state, saved
views and sanitizers stay mode-agnostic.

Known dead field: `dateSort` in `ui_state_cohorts` (kept for persisted-state
compatibility; nothing reads it).

Funnel exclusion switch: `excludedCampaignPaths` in `ui_state_cohorts` works
at TWO levels. Client-side, the paths' rows are dropped at the single
ClickHouse/legacy merge point (`effectiveFilteredCohorts`) — instant, and it
carries every row-derived stat (funnel pseudo-rows, Total, AI signals + the
AI history contextKey, exports, assistant context). Server-side, the same
list travels as `filters.campaign_path_exclude` (NOT IN wherever
campaign_path IN applies: the list HAVING, the materialized member scope,
and BOTH fbCohortStats scopes) because `fb_totals` — full-funnel Spend (FB)
/ CPP (FB) / FB Purchases — is a server bundle not derivable from rows.
Gotcha caught live: the client cache-key normalizer
(`cohortsCache.normalizeCohortRequest`) must also carry the field, or the
query key never changes and the refetch silently doesn't happen. Filter
OPTION lists deliberately ignore the exclusion, and stale excluded paths
are never pruned against them — a path with no current data must stay
re-includable. It is a hygiene switch, not a view filter: it survives
"Reset filters" (the "Excluded" popover has its own "Include all").

## AI Analytics layer (2026-08)

The layer is deterministic-first: a pure rules engine
(`_shared/clickhouse/aiSignals.ts`, `ai-signals-v2`) computes every
recommendation in the browser over the rows the page already shows; the model
(assistant) only selects/phrases over that output and can never widen it.

**Engine.** One strict-precedence ladder (sample gate → refund/payment stops →
CPA breaches → scale rungs → hold) runs per row on two surfaces: `cohort`
(Cohorts page rows) and `campaign` (FB Analytics). Benchmarks are pooled
leave-one-out (Σnum/Σden across peers, never averaged ratios); rates get
Wilson-95 anti-flap ("bad" = floor breach AND Wilson-below-account-norm);
confidence is a product of sample/maturity/spend/benchmark factors bucketed
high/medium/low. Effective thresholds ride on `AiEngineOutput.thresholds`.

**Grains.** On the cohort surface the SAME engine run also emits one
recommendation per `campaign_path` (`scope.kind === "path"`,
`analyzePathGroup` over pooled rows) — pseudo-rows are never fed to the
engine (their synthetic cohort_date would break maturity/payback/trends).
Path policies: conversion from the mature-row subset only, refunds
amount-based (cohort-surface convention; campaign surface is user-based —
same ruleId, documented asymmetry), payback from the age≥60 pooled grid,
peers = other paths. Path recommendations do not enter derivedTotalSpend;
Opportunities cap path-family entries at 1 per path (others 3).

**Campaign trends.** `aiCampaignSeries.ts` builds daily per-campaign series
from Capsuled daily-split rows already in FB Analytics state. The trend basis
CPA_fb = spend / FB purchases is DIRECTION-ONLY: it is never compared to
`cpaCeiling` (the ladder's CPA is spend / authoritative trials). Windows are
7d-vs-prev-7d anchored to the series max date (syncs are manual), each needs
≥4 active days and >0 purchases. A known deteriorating trend disqualifies
rung 5a's "no trend axis" fallback.

**Assistant** (`aiAssistant.ts` + `ai-analytics` edge fn, `ai-assistant-v2`).
Stateless multi-turn: the drawer re-sends the last 3 accepted exchanges;
prior questions travel inside the `#####` fence (untrusted), prior answers
are plain-quoted with `#` neutralized. Every number the model emits must
already exist in the context pack, the question, or a prior exchange —
violating fragments are rejected one by one (the rest of the answer
survives). Number rendering must stay round-trippable: `extractNumbers` sees
"12 106,00" as [12, 106] on BOTH sides of the gate, so do not change the
space-thousands format. The Cohorts page publishes the grain the table
shows (path items in Funnels mode); the client slices packs to 120 items.

**Wave 3 additions.** §18 history: AiAnalysisPanel lazily loads past
verdicts for its scope from the ai_recommendations snapshots
(extractAiActionHistory collapses consecutive identical verdicts keeping the
first date; scoped to the SAME contextHash — verdicts across filter contexts
are not comparable; the line renders only when the verdict changed). §6
warehouse AI Action: txByCampaignCTE additionally computes
first_subscription_users, user-based refund_users and anyHeavyIf
campaign_path; fbWarehouseAiAdapter maps the blend onto the engine's
campaign input (campaign level only, no daily series → trend missing there).
§20 Budget Planner: pure aiBudgetPlanner allocates additional budget over
SCALE candidates only (cap = 2x the recommended step, remainder = Reserve),
three goals (profit = net/spend, payback = observed days, risk = engine
confidence), linear projection with explicit notes; dialog on FB Analytics.

**Storage & keys.** `ai_assistant_runs` (audit, one row per call; the edge
returns `runId`), `ai_recommendations` (append-only snapshots with a
mutation-guard trigger), `ai_feedback`. Feedback subject ids:
recommendations use `surface:aiScopeKey(scope):ruleId` (byte-for-byte the
AiOpportunity id; aiScopeKey is display-name independent — a campaign rename
must not fork history), assistant answers use the run uuid.
`aiRecommendationLog.ts` writes snapshots per (surface, `context_hash` =
`c_` + fnv of surface+dates+applied-filter contextKey; warehouseVersion is a
column, not part of the hash). Dedup canonicalizes JSON (Postgres jsonb does
not preserve key order) and compares the last 3 rows, not 1 — a cold load
emits settling steps (maturity missing → full) that a last-row compare would
re-insert forever; writes are serialized per tab because two debounce timers
can race read-then-insert (observed live) and the append-only guard makes a
raced duplicate permanent. Path recommendations persist under
surface='cohort' (the table CHECK knows only cohort/campaign; the grain
lives in scope.kind inside the jsonb).

## Supabase Dataset Snapshots

The migration `supabase/migrations/202605090001_create_data_snapshots.sql` creates `public.data_snapshots`.

Each authenticated user gets one latest snapshot per `dataset_type`:

- `palmer`
- `funnelfox_subscriptions`
- `facebook_traffic`
- `forecasting_settings`
- `cohorts_ui_settings`

RLS policies require `auth.uid() = user_id` for select, insert, update, and delete. The frontend uses the publishable anon key plus the logged-in Supabase session; no service role key is used in browser code.

Import/sync flow:

```text
Import Data action succeeds
-> save parsed data to IndexedDB
-> upsert latest Supabase data_snapshots row
```

Large snapshots are compressed before they are written to `payload`. `src/services/dataSnapshots.ts` wraps payloads larger than the configured threshold in a small `lz-string-uri-v1` envelope and transparently decompresses them in `loadLatestCloudSnapshot`. This is mainly important for Palmer imports because they include transformed transactions plus raw Palmer rows.

Safe cloud-save diagnostics are allowed, but never log full payloads or raw emails. The snapshot save path logs only whether a user session exists, `dataset_type`, size estimates, compression status, snapshot id, and safe error messages.

Startup restore flow:

```text
Protected app mounts
-> SavedDataAutoLoader reads IndexedDB caches
-> if a cache is missing, loads latest Supabase snapshot
-> restores Zustand
-> warms IndexedDB with cloud-loaded data
```

Use the Local Saved Data section on Import Data to manually Save to cloud or Load from cloud for Palmer, FunnelFox subscriptions, Facebook traffic, and Forecasting settings. Cohorts view settings are managed from the Cohorts column settings panel and are saved to cloud automatically with a debounce. Do not store FunnelFox secrets, Supabase service role keys, raw API keys, or other credentials in snapshot payloads.

### Cohorts UI Settings Sync

`src/services/cohortsUiSettings.ts` owns validation and local storage keys for Cohorts view settings. It syncs this small payload:

```ts
{
  columnOrder,
  columnWidths,
  columnVisibility,
  selectedView,
  filters,
  updatedAt
}
```

Load rule:

```text
localStorage first
-> Supabase cloud snapshot
-> apply cloud only when cloud.updatedAt is newer or local settings do not exist
```

When app versions add or remove cohort columns, sanitize the saved payload before applying it: ignore unknown column IDs, remove duplicates, and append missing valid columns at the end.

## FunnelFox subscriptions sync — staged pipeline (2026-09-25)

`funnelfox-subscriptions-sync` is a resumable four-stage crawler (list →
details → profiles → finalize) persisted in `funnelfox_subscriptions_sync_state`
(cursor + one completed-flag per stage + `stats`), driven by pg_cron: a
`full_reset` refresh at 05:45 UTC and an `advance` tick every 15 minutes
(migration 202607250001). Its unit-tested twin is
`src/services/funnelfoxSubscriptionsSyncCore.ts` — keep both in lockstep.

Rules learned from the 2026-09 incident (Cohorts active-subscription overlay
dead: `empty_source`, 0 active for every recent cohort):
- The LIST payload carries no profile/product/customer. The list upsert must
  write ONLY the columns it actually has (`subscriptionListUpsertColumns`);
  upserting the enrichment columns as null wiped the detail stage's work every
  15 minutes (8,921/8,921 rows with an email in `raw_detail` had a null column).
- `full_reset` must persist ALL four stage flags as false. Resetting them in
  memory while the row kept `details/profiles/finalize_completed = true` meant
  `nextIncompleteStage()` skipped enrichment forever after the list stage.
- `full_reset` re-opens `detail_checked` only for rows with no `raw_detail` or
  no email (`FULL_RESET_DETAIL_REOPEN_FILTER`); re-opening everything made the
  ~1,000-details-per-run budget chase 14.6k rows daily and never finish.
- `campaign_path`/`funnel` come from the DETAIL's `funnel.alias` (byte-identical
  to campaign_path elsewhere); nothing else writes them.
- Stale detail cards are re-fetched (2026-10-19), see below.

### Stale detail cards (2026-10-19)

The detail card (`raw_detail`) used to be fetched once, about the trial
purchase, and never again. On 2026-10-19, 2,603 of 16,725 cards no longer
matched the list: 1,411 cancels still showed renewal on, 566 converted trials
still said "trialing". The cancellation reason of those cancels was unknown.

How it works now:
- The list stage reads each existing row's card status / renews
  (`raw_detail->>status`, `raw_detail->>renews`) in the query it already makes
  per upsert batch. A checked row whose list status or renews differs from its
  card (`isDetailCardStale` / `staleDetailCardIds`) goes back to the detail
  queue: `detail_checked = false`, the same `detail_pending` partial index.
  Stat: `stale_details_reopened` (per daily cycle).
- The detail stage always re-fetches a row that already has a card (no
  list-row shortcut). Stats: `details_refreshed`, `details_reason_kept`.
- Nothing to compare is never stale: a row without a card status (never
  fetched, or a stored 404 body) or an unknown list value.
- The list is crawled once per daily cycle, so a card is re-fetched at most
  once a day, even if FunnelFox's list and card keep disagreeing.
- Rate limits: the re-fetches share the detail stage's pool (5 at a time,
  2,000 candidates and a 50 s budget per run). A 429 now stops the pool; the
  run ends `rate_limited` (status partial, `made_progress` false so a manual
  Continue loop stops) and the 15-minute tick resumes. The first cycle after
  the deploy re-fetches the ~2.6k backlog in about three ticks.
- A 404/410 on a re-fetch keeps the stored card and only marks the row checked
  (`detailWrite`); a first fetch stores the body as before.
- FunnelFox keeps `cancellation_reason` only while a cancel is scheduled
  (renewal off, status still trialing / active): 582 such cards carry "User
  requested cancellation", 0 of 12,556 cancelled cards carry any reason. A
  re-fetch keeps the stored reason when the fresh card has none and still
  shows a cancel (`refreshedDetailCard`, marked
  `cancellation_reason_source: "previous_card"` inside `raw_detail`). A
  renewing card means the cancel was undone, so its old reason is dropped. Without that, the refresh would turn the users' own
  cancels at the period end into "auto" (528 stale cards with a reason today).
- The cancel date of a re-fetched cancel comes from the fresh card, like the
  other cancelled cards: its `cancelled_at` when filled, else its `updated_at`.
  Every cancelled card carries a `cancelled_at` key; whether it holds the
  request or the final cancel was not checked. If it is the final cancel, a
  user who scheduled the cancel during the trial moves from the request day to
  the period end. The classification does not change (the reason wins), but
  Dashboard per-day cancellations would.
- `normalizeSubscriptionForClickHouse` is unchanged: finalize runs after the
  detail stage, so the cards it reads are fresh. The list `updated_at`
  fallback still covers a card whose re-fetch is pending or failed.
- An `api_error` stop persists its diagnostic into `last_error`.
- Downstream: the Cohorts overlay reads the RPC `active_funnelfox_subscription_emails`
  (Supabase columns: normalized_email/renews/status/period_ends_at, sandbox from
  raw); ClickHouse `fact_subscriptions` is read by code but nothing writes it yet.
- The leads sync (`funnelfox-leads-sync`) was stalled from 2026-06-21
  (`max_pages_reached`, 157 profiles, 0 emails) until the 2026-10-06 rewrite
  below; it now has its own cron.

Screen-to-screen conversion (asked 2026-09-21): the public API has no event or
step endpoints (`/events`, `/steps`, `/screens`, `/analytics` → 404). What
exists: `/sessions` lists every visitor session (cursor, `funnel_id`,
`profile_id`, geo; ~3k/day), `/sessions/{id}` carries `replies[]` with
`screen_id`/`element_id` (screens where the user submitted input), and
`/funnels/{id}.config_url` is a public config.json with the ordered `screens[]`
(id, customId, elements, navigate actions). A step funnel over input screens +
email screen + purchase (`session.id` on the subscription detail) is buildable
at ~3k detail requests/day; info-only screens leave no trace. (The former
`funnelfox-endpoint-probe` discovery function was removed with access control:
it had no in-function auth. Delete it from the deployed project too:
`supabase functions delete funnelfox-endpoint-probe`.)

## FunnelFox leads export + server-side Leads tab (2026-10-06)

Why the old sync stored 157 profiles and 0 emails:
- The browser never sent `limit` / `max_pages`; `Number(null)` is 0, clamped up
  to 1, so every call crawled ONE page of ONE profile (40 per click). The Edge
  now uses `resolveIntParam` (absent → default 100 / 200), like the
  subscriptions sync, and the page always sends both explicitly.
- Emails come ONLY from the profile LIST: about 24% of list rows carry `email`
  at the row root. `/profiles/{id}` carries no email at all (probe over 37
  stored payloads), so the old `profile_details` stage is gone and the function
  never calls `/profiles/{id}`. `details_completed` is always written as true so
  older readers and the cron's idle check see the stage as done.
- The list row has a boolean `preview` (FunnelFox editor / preview runs): it is
  stored and preview profiles are never leads.

Pipeline (`supabase/functions/funnelfox-leads-sync/index.ts`; pure twin
`src/services/funnelfoxLeadsTransform.ts` — keep both in lockstep):
- `profiles` → crawl `/profiles` newest first and upsert only rows that carry an
  email (light columns + `preview` + `email_source = 'list'`; no raw JSON).
  Profiles without an email are only counted in `stats`
  (`profiles_scanned_total`, `profiles_with_email`, `profiles_without_email`,
  `preview_excluded` — scan counters of the current pass, not table counts).
  The cursor is read from `pagination.cursor`, then `next_cursor`; a repeated
  cursor stops the crawl. `has_more` without a recognised next cursor, or a 2xx
  without a `data` array, is an `api_error` (its `last_error` names the
  pagination / body key names) — never a silent "completed". Rows and cursor are
  checkpointed every 10 pages; every page has a 20 s timeout.
- `sessions` → crawl `/sessions` and attach the earliest session's attribution
  to STORED profiles only (light columns, no `raw_session`).
- `reconcile` → `public.funnelfox_leads_reconcile(p_data_key)`: paid emails
  from `public.transactions`, active ones from
  `active_funnelfox_subscription_emails` (Cohorts definition). The Edge ignores
  any `conversion` body key; the browser no longer builds one.
- Reconcile queue (incident 2026-10-07, migration `202610070001` section 6):
  the stage used to call `funnelfox_leads_reconcile` through PostgREST. Its
  first pass over the export (235k rows) rewrites almost every row
  (`has_successful_payment`, `has_active_subscription`, `is_lead`,
  `first_trial_at`, `first_sub_at`) and hit the 8 s statement timeout of the
  role PostgREST runs service_role calls under, every minute (sync state stuck
  at `next_stage = 'reconcile'`, `last_status = 'error'`, ~8 s of DB time per
  tick). Now the stage calls `funnelfox_leads_reconcile_request(p_data_key)`
  (service_role only; stamps `funnelfox_leads_sync_state.reconcile_requested_at`,
  one row update, answers `{queued, requested_at, last_applied_at,
  last_summary}`), marks `reconcile_completed` and copies the last APPLIED
  run's counts into `stats` (`reconcile_rows` / `leads_found` /
  `converted_excluded` / `active_sub_excluded` / `reconciled_at` from
  `checked` / `leads` / `paid_excluded` / `active_excluded` / `applied_at`;
  without an applied run the previous values stay) plus `reconcile_queued_at`.
  The pg_cron job `funnelfox-leads-reconcile` (every minute, as postgres, pure
  SQL) runs `set statement_timeout = '15min'; set lock_timeout = '30s'; select
  funnelfox_leads_reconcile_pending()` — postgres has no timeout of its own but
  Supabase's global default caps it at 2 minutes, which the first pass (~216k
  non-HOT row updates over 8 indexes) may not fit on a small instance; since
  PG13 each statement of a multi-statement command arms its own timeout, so
  the SETs apply to the SELECT. `funnelfox_leads_reconcile_pending(p_force
  boolean default false)`: when `reconcile_requested_at` is newer than
  `reconcile_applied_at` it takes a transaction advisory lock, runs the
  unchanged `funnelfox_leads_reconcile(workspace_data_key())` and stores
  `reconcile_applied_at` = the run's START time and `reconcile_summary` = the
  counts + `duration_ms` + `applied_at` (and clears `reconcile_failure`), so a
  request stamped during a run is picked up by the next one. The reconcile
  call sits in a block that traps `query_canceled` (a timeout; `others` does
  not match it) and every other error: its work rolls back, the advisory lock
  stays, `reconcile_failure` = `{failed_at, started_at, duration_ms, sqlstate,
  error, failures, retry_after}` plus a WARNING, and later ticks answer
  `{skipped: 'backoff'}` until `retry_after` (15 min after the first failure,
  doubling per consecutive failure, at most 6 h). `p_force = true` skips that
  wait (the manual `set statement_timeout = 0; select
  public.funnelfox_leads_reconcile_pending(true);`). Trade-off: a trapped
  failure shows as `succeeded` in `cron.job_run_details` (the failure lives in
  `reconcile_failure` instead — recording it needs the transaction to commit).
  The migration drops a no-argument `funnelfox_leads_reconcile_pending()` (an
  earlier draft) so the job's call is never ambiguous. Nothing in the app reads
  the five conversion columns (the Leads tab computes exclusions on the fly in
  `leads_recent_candidates_compute`), so the queue only delays those columns
  and the card's "Leads found". The Edge falls back (PGRST202 / 404 /
  "could not find the function", `isMissingRpcError` mirrored from
  `_shared/clickhouse/leads.ts`) to the inline call while the migration is not
  applied; any other request error (or `queued: false`) fails the run as
  before. The sync card shows "Conversion reconcile queued …" (muted, not an
  error) while a request waits, polls for up to 15 min, and prefers the row's
  `reconcile_summary.leads` over the stats copy. `isReconcileOverdue` (queued
  for at least `RECONCILE_QUEUE_POLL_WINDOW_MS`, i.e. where polling stops, or
  queued with a `reconcile_failure`) turns the note into an amber warning
  ("… but not applied yet — the pg_cron job funnelfox-leads-reconcile may not
  be running (check cron.job_run_details)", or the failure's error and
  `retry_after`); `last_status` and its styling stay as they are.
- A stored profile is also never a lead when ITS OWN subscription
  (`funnelfox_subscriptions.profile_id`) shows a paying / subscribed customer
  (its email paid or active, or priced and not cancelled / still in its paid
  period) — the quiz email can differ from the checkout email. Same rule in
  reconcile, `leads_profile_candidates` and `leads_recent_candidates_compute`.
- Upserts are grouped by key set (supabase-js fills missing keys with NULL in a
  bulk upsert — the same incident as the subscriptions list stage above).
- A lease (`funnelfox_leads_acquire_lease` returns a token,
  `funnelfox_leads_release_lease(p_data_key, p_token)` frees only that token's
  lease; 120 s) keeps the cron tick and the page's button off the same cursor;
  the loser answers `status: "busy"`. A FunnelFox 429 parks the pipeline until
  `stats.rate_limited_until` (Retry-After, default 60 s). Any other FunnelFox
  error backs the cron off (`stats.error_backoff_until`: 60 s · 2^(n-1), at most
  an hour; `stats.consecutive_api_errors`); a click is not held back. A cursor
  FunnelFox keeps refusing (400/404/410/422 or one that does not advance) is
  dropped after 3 errors in a row and the pass restarts (`stats.cursor_reset`).
  With every stage complete a plain sync is an idle no-op (one read, no
  writes). A cron `full_reset` that arrives while a pass is unfinished runs as a
  plain advance — unless the last run ended in an error, then it restarts.
- Cron (migration `202610060011`): `funnelfox-leads-advance` every minute and
  `funnelfox-leads-refresh` (full_reset) at 06:15 UTC, after the 05:45
  subscriptions refresh. `invoke_funnelfox_leads_sync` skips the HTTP call
  while a lease is held, while a 429 pause or an error backoff runs, or once
  every stage is complete; the refresh always posts. Auth: `x-cron-secret =
  FB_CRON_SECRET` through the gate's `policy.cron` branch (actions `sync` /
  `sync_full_reset`, never the dry run).
- Diagnose (`dry_run`, owner-only button): at most 2 list pages + 1 sessions
  page; returns key names and counts only (no email, no cursor value).

Leads tab read path (`clickhouse-users` actions `leads_list` /
`leads_overview`; `supabase/functions/_shared/clickhouse/leads.ts`, contract in
`leadsContract.ts`, browser `runClickHouseLeads` + `src/hooks/useLeadsData.ts`):
- Merged in Edge from (A) one ClickHouse query of warehouse lead candidates,
  (B) the RPC `leads_recent_candidates(p_data_key, p_limit, p_max_age_seconds)`
  (migration `202610070001`; profile leads + subscription-only emails + KPI
  counts, served from a Postgres cache, see below) and (C)
  `activeSubscriptionsByEmail`; `mergeLeads` is pure and parity-tested against
  `computeLeads`. The merged set is then cut to the newest
  `LEADS_RECENT_LIMIT` (1 000) leads by lead date (`keepNewestLeads`: lead_date
  desc, undated last, ties by row key — the page's default sort). Filters,
  search, the sort allowlist, pagination, the filter options and the lead
  counts (Total Leads, Leads Today, Leads Last 7 Days) run in Edge over that
  cut set, memoized per workspace for 60 s per isolate (`refresh: true`
  bypasses the memo, never joins a plain load already in flight, and asks the
  Postgres cache for candidates at most `LEADS_CANDIDATES_REFRESH_MAX_AGE_SECONDS`
  (60 s) old, so it recomputes unless the cron just ran; if that inline compute
  fails, e.g. 57014 on a cold buffer cache, it retries once with 900 s; the page
  sends it after a sync, on Refresh and when a background pass finishes).
- Latest 1 000 leads only (owner decision 2026-10-07, for speed; about the last
  3 days today). `leads_profile_candidates` ranked all 216k profile leads per
  call (5.8-12 s, over the 8 s PostgREST statement timeout of the Edge's
  service-role calls) and still showed only the newest 50k. Emails Found /
  Converted Excluded / Active Subs Excluded stay whole-base (the RPC's `kpis`).
  `diagnostics.lead_set_limited` / `lead_set_oldest_date` drive the page's
  "Showing the latest 1,000 leads (since …)" banner; `candidates_computed_at`
  its "Updated N min ago".
- `leads_recent_candidates_compute(p_data_key, p_limit)` returns only what an
  exact newest-N cut needs: the newest N + 1 representative profile leads of
  emails outside the warehouse (ties included; two newest-first streams along
  the `created_at` / `session_created_at` indexes) plus the representative
  profile of EVERY unpaid warehouse email whatever its age (the merge folds it
  into the warehouse row as "both" with the earlier date, so an old profile
  must never be missing — a "both" row competes with its merged date, never
  its fresh warehouse date). The paid flag is two-valued
  (`coalesce(bool_or(status = 'success'), false)`): `transactions.status` is
  nullable, and a NULL flag would drop that email's profile. Exclusions, the
  representative rule and the field derivations are those of
  `leads_profile_candidates` (production parity
  2026-10-07: 0 differences; PGlite parity + an end-to-end cut test in
  `src/test/leadsRecentCandidatesMigration.test.ts`). PL/pgSQL with `EXECUTE …
  USING` so the key and limit are planned as constants (the measured plan);
  it assumes `funnelfox_leads.normalized_email` is stored as
  `lower(btrim(email))`, which the sync guarantees.
- Cache: `public.funnelfox_leads_candidates_cache` (one row per data key, RLS on,
  no policies, no browser grants). pg_cron `funnelfox-leads-recent-cache`
  (`*/5 * * * *`, pure SQL, as postgres) runs
  `leads_refresh_recent_candidates()`; the Edge reads with max age 900 s and
  computes inline (and stores) only on a miss — 1.1 s warm, 2.5-10 s while the
  export churns the buffer cache. `LEADS_RECENT_LIMIT` must equal the SQL
  default `p_limit` (1000): the cron caches that limit and a test checks it.
  Until `202610070001` is applied the Edge falls back (PGRST202) to
  `leads_profile_candidates(p_data_key, p_profile_limit := 50000)`
  (`LEADS_LEGACY_PROFILE_LIMIT`, what the previous build sent; slow and
  timeout-prone as before). Not 1 000: the old RPC ranks the profiles of unpaid
  warehouse emails together with the profile-only ones, so a 1 000 cap would
  drop the older profiles the "both" merge needs. `keepNewestLeads` still cuts
  the merged set to 1 000.
- Known transient (cached snapshot vs live warehouse): the candidates are a
  Postgres snapshot (`computed_at`), the ClickHouse warehouse rows are read
  live. For up to ~5 min after an import's ClickHouse sync, a returning old
  lead can show with its new transaction date (source "warehouse": its old
  profile was not an unpaid warehouse email's at compute time, so it is not in
  the payload and cannot fold into "both"), and a just-converted recent lead
  can stay listed, until the next `funnelfox-leads-recent-cache` tick (+ the
  60 s memo). Not patched in Edge: a per-email profile lookup would need the
  linked-profile exclusion only the SQL knows.
- A warehouse lead that also has a profile ("both") keeps the warehouse
  attribution (campaign path, campaign id, media buyer, country); the profile
  only fills fields the warehouse lacks. Profile campaign paths are normalized
  like the warehouse import.
- Size: the bulk RPC carries no profile `user_agent` / `origin` (`leads_list`
  reads them for the page's rows only, of the kept set). The warehouse
  candidates (A) are still read whole from ClickHouse and cut in Edge.
- Data-owner only for the first release: both actions are `rawOnly` +
  `users.view` + `users.pii.view` + `leads.view`, none `scopeReady`. Dropping
  `rawOnly` later (policy + `accessRoutes.ts` + `Users.tsx`) opens it to members
  holding the three keys.
- The tab no longer hydrates the raw warehouse (`useRequireRawTransactions` has
  no caller now). The `"leads"` query root is deliberately not persisted to
  IndexedDB (rows carry customer emails).

Deploy order (each step needs the previous one): migration `202610060010` →
deploy all functions → Diagnose + one Continue → migration `202610060011` (cron)
→ frontend. See README "FunnelFox Leads export — rollout". Migration
`202610070001` (latest-1 000 candidates + cache + its cron job, and the
reconcile queue + the `funnelfox-leads-reconcile` job) only needs
`202610060010`; it is applied on its own (README step 6). The leads pg_cron
jobs are `funnelfox-leads-advance`, `funnelfox-leads-refresh`,
`funnelfox-leads-recent-cache` and `funnelfox-leads-reconcile` (freeze them
together: `jobname like 'funnelfox-leads-%'`). Since the access Phase 2 merge
the deploy script also needs `202610060001` (`public.funnel_paths`) applied
first, and every leads migration goes in out of band (`db query --linked` +
`migration repair`), never via `supabase db push` while `202610060001` /
`202610060002` are pending (they sort before the applied `202610060010`).

## FunnelFox Backend Requirement

The Import Data page calls `syncAllSubscriptions`, which uses a frontend-safe proxy. Production Lovable deployments should use Supabase Edge Functions:

```text
Lovable frontend -> Supabase Edge Functions -> FunnelFox API
```

This repository includes multiple proxy runtimes:

- Supabase Edge Functions for production Lovable deployments:
  - `supabase/functions/funnelfox-subscriptions/index.ts`
  - `supabase/functions/funnelfox-subscription/index.ts`
  - `supabase/functions/funnelfox-profile/index.ts`
- `api/funnelfox/*.ts` (serverless) and the Vite middleware for `/api/funnelfox/subscriptions` are
  **dev-only**: every handler answers 404 unless `FUNNELFOX_LOCAL_PROXY_ENABLED=true`, which only
  `vite.config.ts` sets for `vite serve` when the dev server binds to loopback
  (`npm run dev -- --host localhost`; the default `::` bind for the Lovable preview leaves it off).
  Never set that variable on a deployment or in the Lovable sandbox.

Access (Phase 1): the three Edge proxies require the data owner (raw access) plus
`admin.sync.run`; `funnelfox-funnels` requires `funnels.manage`. Every function goes through
`serveWithAccess` and its policy in `supabase/functions/_shared/access/policies/`.

A plain static Vite build does not execute `api/` files by itself. Production real sync requires a backend runtime. For Lovable, deploy the Supabase Edge Functions and point the frontend at the Supabase Functions base URL.

The Edge Function proxy runs server-side, reads the secret from `Deno.env.get("FUNNELFOX_SECRET")`, forwards optional `cursor` pagination, and returns the FunnelFox JSON response to the browser.

Set the Supabase Edge Function secret:

```text
supabase secrets set FUNNELFOX_SECRET=...
```

For local or deployed real sync, keep the secret out of `.env` files that are exposed to Vite. Only variables prefixed with `VITE_` are browser-facing, and `FUNNELFOX_SECRET` must never use that prefix.

Deploy the functions:

```text
supabase link --project-ref wsjbpkderyhdefukppvb
# Always all functions at once (one BUILD_ID, no old caller-as-tenant build left live):
SUPABASE_SERVICE_ROLE_KEY=... npm run deploy:functions -- --project-ref wsjbpkderyhdefukppvb
```

After the Edge Functions are available, enable real sync in the frontend environment:

```text
VITE_FUNNELFOX_MOCK=false
VITE_FUNNELFOX_PROXY_URL=https://wsjbpkderyhdefukppvb.supabase.co/functions/v1
```

The browser maps the Functions base URL to these routes:

```text
GET /functions/v1/funnelfox-subscriptions
GET /functions/v1/funnelfox-subscription?id=...
GET /functions/v1/funnelfox-profile?id=...
```

The frontend sends the current Supabase Auth bearer token and anon `apikey` to Edge Functions. `FUNNELFOX_SECRET` is never sent from the browser.

By default the browser blocks direct calls to `https://api.funnelfox.io`. Same-origin `/api/funnelfox/...` routes and Supabase `*.supabase.co/functions/v1` Edge Function URLs are allowed. Other external proxy URLs require `VITE_ALLOW_EXTERNAL_FUNNELFOX_PROXY=true`.

The Edge Function calls FunnelFox:

```text
GET https://api.funnelfox.io/public/v1/subscriptions
Fox-Secret: Deno.env.get("FUNNELFOX_SECRET")
```

The endpoint proxies page-by-page requests. The frontend keeps following `pagination.has_more` and passes `pagination.next_cursor` back as the `cursor` query parameter.

If subscription rows do not include email, product, funnel, or session fields, sync enriches them through subscription details via the server proxy:

```text
GET https://api.funnelfox.io/public/v1/subscriptions/{id}
Fox-Secret: Deno.env.get("FUNNELFOX_SECRET")
```

Duplicate subscriptions are removed before normalization using `id`, then `subscription_id`, then `psp_id`; the most recently updated record is kept. Detail fetches are cached per sync so repeated subscription ids only call FunnelFox once. Detail failures do not fail the whole subscription sync; missing fields stay empty and the UI reports partial enrichment warnings.

Security warning: never put `Fox-Secret`, `FUNNELFOX_SECRET`, or the raw FunnelFox API URL in browser code. The browser must only call the server-side proxy.

## Support answered/unanswered analytics (2026-09)

THE UNIT IS THE ADDRESS, not the message: a contact counts as answered once
ANY mail left our mailbox for their address. Per-message verdicts still carry
the richest evidence (`answer_source`): `thread` (a Sent-folder reply whose
In-Reply-To/References thread contains the request — exact, has a timestamp),
`recipient` (Sent mail to the customer's address at/after the request — no
time window), `contact` (we wrote to this address only BEFORE this message —
answered, no time), `imap_flag` (\Answered on the INBOX copy), and
`customer_reply` (the customer answered OUR mail whose Sent copy is gone).
KPIs count unique addresses (`answeredContacts`/`unansweredContacts`,
address key = normalized_email falling back to sender); answer rate =
answered-answerable contacts / answerable contacts, where answerable means
the contact has at least one request outside `Spam/unrelated` and
`Automated notification`.

Pipeline: `sync-support-mail` gained Sent-folder ingestion (headers only into
`public.support_replies` via `BODY.PEEK[HEADER]`, own sync-state row — the
`(auth_user_id, mailbox_key, folder)` key fits a second folder) and, appended
to every `sync_new` (cron and manual), post-stages: Sent delta → INBOX flags
refresh (one ranged `UID FETCH (UID FLAGS)` over the last 30 days; stored
flags are frozen at first sync and systematically miss \Answered, and ONLY
changed rows are updated — each UPDATE re-syncs the row to ClickHouse) →
reply matching → one ClickHouse sync if anything changed. Stages are fenced
and budgeted so they can never fail the INBOX import.

Matching is the pure module `_shared/clickhouse/supportReplyMatching.ts`
(vitest: supportReplyMatching.test.ts): thread components are connected
components over message-id mentions (synthetic `imap:{uid}` ids excluded),
requests store `message_id` RAW while `in_reply_to`/`references` are
normalized — always `normalizeMessageId()` the request side, and NEVER join on
`support_requests.normalized_message_id` (nulled on dedupe collisions).
Verdicts land on `support_requests.answered_at/answer_source/answered_reply_id/
reply_count` through the `support_apply_answer_matches` RPC (one call per 500
rows); the BEFORE UPDATE trigger bumps `updated_at`, so the ClickHouse keyset
sync republishes changed rows by itself. `thread` verdicts are terminal;
weaker tiers are re-evaluated each pass, and the matcher emits ONLY changed
verdicts (a no-op UPDATE storm would multiply CH row versions).

ClickHouse: additive columns `answered_at/answer_source/reply_count` on
`fact_support_requests` — they ride `SUPPORT_FACT_COLUMNS` AND the
`enrichSupportAttribution` INSERT-SELECT (a column missing there is silently
zeroed on the next attribution pass; guarded by clickhouseSupport.test.ts).
`first_response_minutes` is computed at query time. The `answered` filter and
KPIs read `answer_source != ''`, not `answered_at` (flag/customer tiers carry
no timestamp). Rollout: the operator runs "Import Sent History" on the Support
page until complete, then one `rematch_replies {"mode":"full"}`.

## FX: a currency without a rate is a silent revenue zero (2026-09-25)

`fxRates.ts` is a static table and the ONLY FX source. When a warehouse
currency has no entry, `convertAmountToUsd` returns `missing_fx_rate`, the
ClickHouse mapper writes `gross_amount_usd = 0` (net/refund too), and every
count-based metric still works — the Cohorts page showed 92 trials, 31
upsells, 5 token buyers and Gross Rev $0.00 for the new `*-web-pt` funnels,
which charge in BRL. Six currencies were in the warehouse without a rate
(BRL, AUD, CAD, NZD, PHP, ZAR; 1,480 transactions). The Supabase rows are
correct (normalized_payload keeps the original amount and no `fx_status`),
so the repair is: add the rate, redeploy `clickhouse-backfill` and
`clickhouse-validate` (they bundle the mapper), call
`resync_transactions_for_currencies(text[])` (bumps `updated_at` — the
incremental sync is keyset on it and re-maps the rows; the newer row_version
wins under FINAL), then run a `continue` backfill. Deploy BEFORE the bump:
a sync that runs in between re-maps with the old table and moves the cursor
past the rows. Watch `fx_diagnostics.transactions_missing_fx_rate` in the
Cohorts response — non-zero means a currency is missing again; the per-row
`fx_missing_*` fields on materialized rows are hardcoded 0 and cannot warn.
Rates for the pre-existing currencies were deliberately NOT refreshed
(restating history is a product decision); the drift is visible against
FX_RATES_AS_OF.

## Dashboard Revenue Intelligence (2026-09)

The calendar projection of the SAME cohort-revenue facts Cohorts reads:
"how much did the project make on day D and which cohorts produced it".
Contract + pure SQL/assembly in `_shared/clickhouse/revenueIntelligence*.ts`,
edge fn `clickhouse-revenue` (actions `bundle` | `day_breakdown`), UI in
`src/components/RevenueIntelligenceSection.tsx` (first Dashboard section).

Two orthogonal axes ride every number and are NEVER merged into exclusive
buckets: RevenueType (the Cohorts classifier's lifecycle taxonomy — the
classifier CTEs are copied verbatim from `cohortMembership.ts` and typed over
the user's FULL history; windowing before typing would misnumber renewal
levels) × CohortRelation (new | existing | unattributed relative to the
BUCKET). New/Existing is SAME-BUCKET: one daily scan carries the same-day,
same-ISO-week (`toStartOfWeek(x, 1)` — `bucketStart()` in TS must agree) and
same-month pairs at once, and assembly picks the pair for the requested
grain. Summing the same-day split into weeks would be wrong and is exactly
what invariants 14–15 in `revenueIntelligence.test.ts` guard against.

Cohort identity is the ACTIVE `fact_user_cohorts` snapshot — the same
versions Cohorts serves. No snapshot → `cohort_snapshot_not_ready` (no live
classifier fallback). Payments whose user_id has no snapshot row flow into an
EXPLICIT Unattributed stream (`NOT IN`), never dropped, never counted as
existing; live coverage measured 99.94%. Refunds are RESTATED onto the
original payment row — the warehouse has no refund date, so Net of past days
can move after a sync while per-day Gross is stable (documented in the UI).

Do not parallelize the bundle's queries: four of the six run the full
classifier CTE chain (JOIN + window functions), and firing them concurrently
exhausted ClickHouse into the 25s timeout. Sequential, the full-history
bundle serves in ~800ms server-side (~1.1–1.4s wall, measured p95 over the
whole 182-day history); `day_breakdown` ≈ 330ms. The plan's materialization
threshold (>5M rows or p95 > 3s) is nowhere close.

Filters are cohort-grain member filters — `activeCohortMemberWhere` (the
Cohorts WHERE builder) injected into the classifier's base CTE, narrowing the
SET OF USERS while keeping each remaining user's full history. Honesty rule:
the Unattributed and Facebook-spend streams have no user grain, so an active
filter EXCLUDES them (diagnostics.filters_active; the UI shows "—" with a
banner and the CSV writes blanks) instead of silently keeping them
project-wide, which would make profit a filtered-net-minus-full-spend lie.

Client caching rides the shared analyticsCache pattern: root `"revenue"` in
`WAREHOUSE_DEPENDENT_ROOTS`, keys carry userScopeHash + warehouseVersion +
the normalized request (`revenueCache.ts`); adding the root required the
`ANALYTICS_CACHE_SCHEMA_VERSION` bump to 15.

Review-hardened rules (adversarial review 2026-09, all confirmed findings
fixed): the slice queries (by_funnel/by_plan) take the SAME
`sameBucketPredicate(bucket)` as the daily query — a same-day slice next to a
same-month KPI is a visible contradiction; existing = successful − new so
future-cohort rows never vanish from both columns. The requested window is
expanded to WHOLE buckets (`bucketStart`/`bucketEndDay`) before any slice
query, or Σ slice ≠ totals at week/month grain. `csvCell` must never de-fang
numbers (a negative profit shipped as the text `'-123.45`). In the section,
everything that captions the numbers derives from the DISPLAYED bundle
(`diagnostics.filters_active`, `bundle.bucket`), never from the controls —
keepPreviousData keeps the previous bundle on screen during a refetch.
`KpiCard` colors the accent only on the icon container: no `icon`, no
accent. The drilldown's "Open in Cohorts" link passes `?cohort_date=D`;
Cohorts consumes it once on mount AND re-applies it inside
`applyCohortsUiSettings`, because the saved-view restore replaces the whole
uiState after the session resolves and silently wiped a mount-time set.

## Mail.ru Support Inbox

STALE: the section below describes the original Mail.ru sync writing to
`public.support_messages`. The live pipeline is SpaceMail IMAP →
`public.support_requests` (see `sync-support-mail/index.ts`); the auth and
secret-handling notes still apply.

The Support page is backed by `public.support_messages` and the `sync-support-mail` Edge Function:

```text
Mail.ru IMAP
-> Supabase Edge Function sync-support-mail
-> public.support_messages
-> Support page filters / detail view
```

The function requires a logged-in Supabase JWT in `Authorization: Bearer ...`; it should not be deployed as a public unauthenticated mailbox sync. Mailbox credentials are read only from Edge Function secrets:

```text
MAILRU_IMAP_HOST=imap.mail.ru
MAILRU_IMAP_PORT=993
MAILRU_IMAP_USER=support@azora-astro.com
MAILRU_IMAP_PASSWORD=...
```

Set and deploy:

```text
supabase secrets set MAILRU_IMAP_HOST=imap.mail.ru
supabase secrets set MAILRU_IMAP_PORT=993
supabase secrets set MAILRU_IMAP_USER=support@azora-astro.com
supabase secrets set MAILRU_IMAP_PASSWORD=...
npm run deploy:functions -- --project-ref wsjbpkderyhdefukppvb
```

If Mail.ru 2FA is enabled, use a Mail.ru app password. The frontend calls only `/functions/v1/sync-support-mail`; it never connects to IMAP directly.

Support intent classification is keyword-based with priority:

```text
refund_request
-> cancel_subscription
-> payment_problem
-> access_problem
-> general_support
-> unknown
```

Matching uses normalized sender email against transaction warehouse email fields and enriches with the existing user/cohort attribution helpers. Unmatched messages are still stored with null matched fields so the Support page can triage them.

### Local FunnelFox sync testing

Create a local env file that is used by the server process. Do not prefix the secret with `VITE_`:

```text
FUNNELFOX_SECRET=your_real_secret
VITE_FUNNELFOX_MOCK=false
```

Run the app:

```bash
npm run dev
```

Open the app, go to Import Data, and use the FunnelFox Subscriptions Sync section. In local development, Vite serves the app and the dev proxy at:

```text
http://localhost:8080/api/funnelfox/subscriptions
```

Debug the proxy without exposing secrets:

```text
GET /api/funnelfox/subscriptions?debug=1
```

The debug response includes:

```json
{
  "secret_exists": true,
  "can_call_funnelfox": true,
  "funnelfox_status": 200,
  "subscription_count": 10
}
```

If `secret_exists` is `false`, the server process did not receive `FUNNELFOX_SECRET`. If `can_call_funnelfox` is `false`, check the secret value, FunnelFox availability, and network access. The debug response never returns the secret.

For development only, Import Data can show a temporary FunnelFox key input. A pasted key is kept only in React component state for the current browser session and is sent only to the server proxy as `X-FunnelFox-Secret`. The proxy still calls FunnelFox with `Fox-Secret` server-side. Do not store this key in localStorage, commit it, log it, or use this temporary input as the production configuration path. In production, the temporary key input is hidden and sync must use server-side `FUNNELFOX_SECRET`.

Raw subscription payload debug is also development-only unless `VITE_ENABLE_FUNNELFOX_DEBUG=true`. Debug output is sanitized before rendering and redacts payment/card fields, provider metadata, tokens, secrets, and authorization-like fields.

Cancellation labels differ by surface:

- Subscriptions page uses FunnelFox-normalized cancel type from `status`, `renews`, `cancelled_at`, `period_ends_at`, and `cancellation_reason`.
- Cohorts and Dashboard use cross-source cancellation classification with Palmer failed/declined transactions near cancellation plus FunnelFox period timing.

Webhook planning:

```text
POST /api/webhooks/funnelfox
Verify header: Fox-Secret-Key
Handle: subscription.cancelled, subscription.activated, subscription.renewed
```

Do not implement production webhooks in the Vite frontend.

## Supabase Auth

Subengine protects all analytics and data pages behind Supabase email/password authentication:

```text
/                       Dashboard
/cohorts                Cohorts
/forecasting            Forecasting
/transactions           Transactions
/users                  Users
/subscriptions          Subscriptions
/import                 Import Data
```

Unauthenticated users are redirected to:

```text
/login
```

Set browser-safe Supabase project values in Vite/Lovable/Vercel:

```text
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=...
```

The anon key is intentionally public, but it must be paired with Supabase Auth, RLS policies, and disabled public signup. Create allowed users in Supabase Auth before deployment and turn off public self-registration in the Supabase dashboard. Subengine only renders a login form; it does not render a signup flow.

Sessions persist through Supabase Auth local storage and auto-refresh. The app header shows the current user email and a logout button on protected pages.

### Temporary local admin fallback

When Supabase is not configured, local development can use a temporary sessionStorage-only admin fallback:

```text
username: admin
password: Mobidima
```

This fallback is enabled automatically in Vite development (`import.meta.env.DEV`) and can be enabled explicitly with:

```text
VITE_ENABLE_LOCAL_AUTH=true
```

Do not enable `VITE_ENABLE_LOCAL_AUTH` for production deployments. The fallback exists only for local demos before Supabase is configured. It stores only a local session flag in `sessionStorage`, never in localStorage.

## Naming

Use these exact transaction names across services, tests, and UI:

- `trial`
- `upsell`
- `first_subscription`
- `renewal_2`
- `renewal_3`
- `renewal`
- `failed_payment`
- `refund`
- `chargeback`
- `unknown`
