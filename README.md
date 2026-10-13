# Subengine

## Requirements

This project requires **Node.js >= 18** (CI and local development are validated on **Node 20**).
The toolchain (`vite`, `vitest`, `eslint`) uses syntax that older Node versions (e.g. Node 12/14)
cannot parse, so `npm test`, `npm run build`, and `npm run lint` will fail on them with confusing
parser errors rather than real failures.

The required version is pinned in `package.json` (`engines.node`), `.nvmrc`, and `.node-version`.

Switch Node version before running any scripts:

```text
# nvm
nvm install      # installs the version from .nvmrc (20)
nvm use          # switches to it

# fnm
fnm use          # reads .nvmrc / .node-version

# Homebrew (no version manager)
export PATH="$(brew --prefix node@20)/bin:$PATH"
```

Verify with `node -v` (should print `v20.x` or any `v18+`).

## Local Environment

Create `.env.local` for local development:

```text
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...
```

Restart `npm run dev` after changing env variables. Vite reads `.env.local` only when the dev server starts.

Only use the Supabase publishable anon key in frontend env. Never expose `service_role`, `sb_secret`, FunnelFox secrets, or other server-only credentials in `VITE_` variables.

## Deployment Checklist

### Lovable frontend env

```text
VITE_SUPABASE_URL=https://wsjbpkderyhdefukppvb.supabase.co
VITE_SUPABASE_ANON_KEY=your_publishable_anon_key
VITE_FUNNELFOX_MOCK=false
VITE_FUNNELFOX_PROXY_URL=https://wsjbpkderyhdefukppvb.supabase.co/functions/v1
```

Production defaults must stay locked down:

- Do not set `VITE_ENABLE_LOCAL_AUTH=true`.
- Do not set `VITE_ENABLE_FUNNELFOX_DEBUG=true`.
- Do not set the `FUNNELFOX_DEBUG` Edge Function secret. When unset, the `funnelfox-profile` endpoint
  returns only `{ profile_id, email }` and never the raw FunnelFox profile payload.
- Do not expose `FUNNELFOX_SECRET` or any other server secret through `VITE_` variables.
- The temporary FunnelFox key input is hidden in production by default.
- Raw FunnelFox debug output is hidden in production by default.

### Edge Functions: always deploy all of them

Every Edge function resolves the caller's workspace access through the shared gate
(`supabase/functions/_shared/access/`). A function left on an older build treats any valid JWT as
authorized and the caller as the tenant, so **never deploy functions one by one**
(`supabase functions deploy <name>`). Use the deploy-all script:

```text
supabase login
SUPABASE_SERVICE_ROLE_KEY=... npm run deploy:functions -- --project-ref wsjbpkderyhdefukppvb
```

`scripts/deploy-functions.mjs`:

1. refuses to deploy anything unless `public.workspace_data_key()` returns the data key (migrations
   `202610050001` + `202610050002` applied and the workspace bootstrapped — before that every new
   function answers 503 to every call, cron and Export API key), and unless `public.funnel_paths` exists
   (`202610060001`, access Phase 2);
2. stamps a fresh `BUILD_ID` (git sha + time) into `_shared/access/buildId.ts` for this run and restores
   the file afterwards;
3. deploys every folder of `supabase/functions` (27 today);
4. deletes every deployed function that is no longer in the repo (e.g. `funnelfox-endpoint-probe`);
5. verifies that the deployed set equals the repo and that every function answers `OPTIONS` with that
   `x-build-id`. Exit code 1 otherwise: do not unfreeze crons or add employees until it passes.

`--dry-run` prints the plan only. `npm run verify:functions -- --project-ref …` re-checks what is live
(one shared build id, set equal to the repo) without deploying — run it before adding an employee.

After the first deploy of `clickhouse-init`, run ClickHouse Init once from the Integrations UI —
it idempotently creates/extends the warehouse schema (including Warehouse V2 tables).

### Access control rollout (plan §26) — in this order

0. **Before merging** (manual):
   - Confirm that Lovable (or any GitHub integration) does **not** auto-deploy Edge functions or
     auto-apply migrations on push (plan Q12). If it does, turn that off first: functions deployed
     before step 4 answer 503 everywhere.
   - The Vite dev server keeps the Lovable template bind `host: "::"` (the editor preview needs it),
     but the dev FunnelFox proxy only switches itself on for a loopback bind
     (`npm run dev -- --host localhost`); on `::` it stays off unless `FUNNELFOX_LOCAL_PROXY_ENABLED`
     is set explicitly — never set it in the Lovable sandbox.
   - Supabase Auth: public signup disabled, email confirmation required; the `app` schema is not in
     the API's exposed schemas.
1. **Pre-flight** (read-only SQL): which account owns the data — `select auth_user_id, count(*) …
   group by 1` over transactions, support_*, funnelfox_*, capsuled_*, facebook_* and the
   `clickhouse_*_state` tables — and `select auth_user_id from public.fb_cron_config`.
   `bootstrap_workspace()` refuses if `fb_cron_config` or the support (INBOX) / FunnelFox
   subscriptions / leads sync state belongs to another account; merge or re-key it first (plan §26.2).
2. **Freeze the crons**: `select cron.alter_job(jobid, active := false) from cron.job where jobname in
   ('fb-daily-warehouse-tick', 'funnelfox-subscriptions-advance', 'funnelfox-subscriptions-refresh',
   'support-mail-sync-tick', 'support-classification-tick', 'support-sent-backfill-tick',
   'funnels-active-from-traffic', 'funnelfox-leads-advance', 'funnelfox-leads-refresh',
   'cohort-membership-freshness');` (the leads jobs exist from `202610060011` on, the last one from
   access Phase 2 on; use the same list for every later deploy, and `active := true` to unfreeze).
3. **Apply `202610050001` and `202610050002` only** — not `supabase db push`, which would also attempt
   `202610050003` (it aborts before bootstrap, and a runner that applies all pending files in one
   transaction rolls back the first two as well):

   ```text
   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f supabase/migrations/202610050001_phase0_isolation_fixes.sql
   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f supabase/migrations/202610050002_access_core.sql
   supabase migration repair --status applied 202610050001 202610050002
   ```

   (or paste each file into the SQL editor, then run the `migration repair` line).
4. **Bootstrap**: `select public.bootstrap_workspace('<data owner uuid>', 'SubEngine');`. If it named
   the wrong account and nobody else was added yet, fix it with
   `supabase/runbooks/rebootstrap_workspace.sql` (fill in both uuids; it re-checks the pre-flight,
   re-keys the workspace in place and restores the API keys the wrong bootstrap revoked).
5. **Deploy every function** with `npm run deploy:functions` (above). Run it with `--dry-run` first and
   read the PRUNE list: the script deletes every deployed function that is not in this repo, so make
   sure nothing created outside the repo (e.g. from the Lovable or Supabase UI) is on that list.
6. **Gates**: the script printed `VERIFIED`; the owner opens every page; unfreeze the crons
   (`active := true`) and check `select * from net._http_response order by created desc` for a 200 per
   cron (cron error bodies keep their detail there; members get generic errors).
7. **Deploy the frontend.**
8. **Apply `202610050003_access_rls_lockdown.sql`**: `supabase db push` (now the only pending file).
   It refuses to run before bootstrap or when `fb_cron_config.auth_user_id` is not the data key.
9. **Before the first employee**: `npm run verify:functions -- --project-ref …` passes.

Rollback: before any employee exists, redeploy the previous functions; after employees exist, disable
the members first.

What the data owner will notice after this release (expected, not regressions):

- **Corrected numbers** (Phase-0 isolation fixes; other accounts' self-provisioned copies no longer
  leak in): the Cohorts "active subscriptions" overlay counts only the data owner's FunnelFox
  subscriptions; ClickHouse Init row counts are tenant-filtered; the support data status no longer says
  `sync_pending` from a deployment-wide count; spend-ledger known gaps and the Funnels `is_active`
  flags use only the data owner's rows. The step-1 pre-flight counts tell these shifts from
  regressions.
- **One cold start**: the first load re-downloads the warehouse and datasets (cache schema v16;
  IndexedDB caches written before the release are ignored).
- **Sign-out clears this browser** (plan §20, shared devices): any sign-out — the button, an expired
  session, a sign-out in another tab — deletes the IndexedDB caches and the Forecasting Compare
  working set. Save Compare scenarios you want to keep; the first load after signing in again
  re-downloads. An automatic sign-out after a rejected request ends only this browser's session.
- Users and Support lists are no longer kept in sessionStorage (they hold customer data), so an
  in-session reload refetches them.
- A ClickHouse backfill killed mid-run holds its lease for up to 10 minutes; Continue / the
  post-import sync then report "Another backfill run holds the lease" with the time to retry.

### FunnelFox Leads export — rollout (in this order)

The Leads tab of /users is now merged on the server (`clickhouse-users` actions `leads_list` /
`leads_overview`, data owner only), and `funnelfox-leads-sync` exports every FunnelFox profile that
carries an email into `public.funnelfox_leads` in the background. Details: DEVELOPER_NOTES.md
"FunnelFox leads export + server-side Leads tab".

1. **Apply `202610060010_funnelfox_leads_export.sql` alone** — not `supabase db push`, which would
   also apply the cron migration before the functions that serve it are deployed:

   ```text
   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f supabase/migrations/202610060010_funnelfox_leads_export.sql
   supabase migration repair --status applied 202610060010
   ```

   It adds `preview` / `email_source` / `lease_until` / `lease_token`, the reconcile / lease /
   candidates RPCs (service_role only) and a covering index on `public.transactions` (built in
   place: writes to `transactions` wait a few seconds, about 40 MB). One-way: legacy
   `funnelfox_leads` rows without a list email are deleted, the raw jsonb payloads of the rows kept
   are cleared, and the leads sync state (cursors, stage flags, counters, stats) is reset; the crawl
   rebuilds everything from FunnelFox.
2. **Deploy every function** with `npm run deploy:functions` (above). Before step 1 the leads sync
   answers 502 on every call (no lease RPC) and the Leads actions answer 502 (no candidates RPC); the
   Users actions are unaffected.
3. **Probe**: as the data owner open Users → Leads, click **Diagnose** (a dry run: at most 2 profile
   pages + 1 sessions page, key names and counts only, nothing written) and check
   `profiles.cursor_key`, `profiles.root_email` and `profiles.preview_true`; then click
   **Continue Sync** once.
4. **Apply `202610060011_funnelfox_leads_cron.sql` alone**, outside `supabase db push`, and record it
   as applied:

   ```text
   npx.cmd supabase db query --linked -f supabase/migrations/202610060011_funnelfox_leads_cron.sql
   npx.cmd supabase migration repair --status applied 202610060011
   ```

   (or paste the file into the SQL editor, then run the `migration repair` line). It refuses to run
   before `202610060010`. Never use `supabase db push` while access Phase 2 (`202610060001` /
   `202610060002`) is unapplied: those files sort before the applied `202610060010`, so `db push`
   refuses, and its `--include-all` hint would apply the Phase 2 cron before the functions that
   serve it. Applied before step 2, every tick would be a refused (401) Edge invocation. Check
   `select * from net._http_response order by created desc` for 200s.
5. **Deploy the frontend.** The new tab needs the step-2 functions; the old tab keeps working until
   then (the server ignores its `conversion` body and fills in the missing page sizes).
6. **Latest 1,000 leads (2026-10-07): apply `202610070001_leads_recent_candidates.sql` on its own** —
   out of band, never `supabase db push` (that would also apply every other pending file, e.g.
   `202610060011` if it is still pending). It needs only `202610060010` (it refuses to run before it):

   ```text
   npx supabase db query --linked -f supabase/migrations/202610070001_leads_recent_candidates.sql
   npx supabase migration repair --status applied 202610070001
   ```

   (or paste the file into the Dashboard SQL Editor; either way it runs as one transaction). It adds
   `leads_recent_candidates_compute` / `leads_recent_candidates` / `leads_refresh_recent_candidates`
   (service_role only), the cache table `public.funnelfox_leads_candidates_cache` (RLS on, no
   browser access) and the pg_cron job `funnelfox-leads-recent-cache` (every 5 minutes, pure SQL, no
   HTTP).

   Once `202610070001` is recorded, `supabase db push` refuses any still-pending `202610060011`,
   because it sorts before the last applied version. Apply that file out of band too:
   `npx supabase db query --linked -f supabase/migrations/202610060011_funnelfox_leads_cron.sql`,
   then `npx supabase migration repair --status applied 202610060011` (or use the SQL Editor).
   Never use `--include-all`.

   Then warm the cache once and check it:

   ```text
   select public.leads_refresh_recent_candidates();
   select profile_limit, computed_at, duration_ms from public.funnelfox_leads_candidates_cache;
   select status, return_message, start_time from cron.job_run_details
     where jobid = (select jobid from cron.job where jobname = 'funnelfox-leads-recent-cache')
     order by start_time desc limit 5;
   ```

   Then deploy the functions and the frontend. The order does not matter: until the migration is
   applied the functions fall back to `leads_profile_candidates` with its old 50,000 cap (slow and
   timeout-prone, as before; the merged set is still cut to the latest 1,000), and the old frontend
   simply shows no banner. Rollback: `select cron.unschedule('funnelfox-leads-recent-cache');`
   stops the refresh (the Edge then computes on a cache miss, at most every 15 minutes).

   **Reconcile queue (incident 2026-10-07), same file, section 6.** The export's `reconcile` stage
   called `funnelfox_leads_reconcile` through PostgREST; its first pass over the 235k stored
   profiles rewrites almost every row and ran into the 8 s statement timeout every minute
   (`reconcile failed: canceling statement due to statement timeout`, `last_status = 'error'`,
   `next_stage = 'reconcile'`). The file now also adds the `funnelfox_leads_sync_state` columns
   `reconcile_requested_at` / `reconcile_applied_at` / `reconcile_summary` / `reconcile_failure`
   (no browser write access), `funnelfox_leads_reconcile_request` (service_role only: stamps the
   request, one row update), `funnelfox_leads_reconcile_pending(p_force default false)` (no API
   role) and the pg_cron job `funnelfox-leads-reconcile` (every minute, pure SQL, no HTTP, as
   postgres): the stage now only queues the reconcile and completes; the job runs the unchanged
   `funnelfox_leads_reconcile` within a minute and records it. postgres is not under PostgREST's
   8 s limit but IS under Supabase's 2-minute global `statement_timeout`, so the job's command sets
   its own first: `set statement_timeout = '15min'; set lock_timeout = '30s'; select
   public.funnelfox_leads_reconcile_pending()`. A run that still fails (timeout or any error) rolls
   back, is recorded in `reconcile_failure` (`failed_at`, `duration_ms`, `sqlstate`, `error`,
   `failures`, `retry_after`; a WARNING in the Postgres log — the cron run itself reads `succeeded`)
   and the job waits 15 min before the next attempt, doubling per consecutive failure up to 6 h, so
   it never restarts back to back. Deploy order does not matter either: before the SQL, the new
   `funnelfox-leads-sync` falls back (PGRST202) to the inline reconcile, which keeps failing exactly
   as today until the file is applied. Once both are live, the next advance tick queues the
   reconcile (a click on **Continue Sync** does it at once) and the pipeline turns `ok`.

   The first pass is the heavy one (~216k rows rewritten): within a few minutes of the first
   request, check that it applied and how long it took. Check:

   ```text
   select reconcile_requested_at, reconcile_applied_at, reconcile_summary->>'duration_ms' as duration_ms,
          reconcile_summary, reconcile_failure from public.funnelfox_leads_sync_state;
   select status, return_message, start_time, end_time from cron.job_run_details
     where jobid = (select jobid from cron.job where jobname = 'funnelfox-leads-reconcile')
     order by start_time desc limit 5;
   ```

   `reconcile_applied_at >= reconcile_requested_at` means the last request is applied;
   `reconcile_summary` holds its counts (`checked`, `leads`, `paid_excluded`, `active_excluded`,
   `updated`, `duration_ms`, `applied_at`). An idle minute of the job costs one primary-key read.
   If `reconcile_failure` is set (e.g. `canceling statement due to statement timeout` after 15 min),
   run the pass once by hand without a timeout, from the SQL editor or better a direct connection
   (`p_force` skips the backoff; a run already in progress answers `skipped: running`):

   ```text
   set statement_timeout = 0; select public.funnelfox_leads_reconcile_pending(true);
   ```

   If runs keep failing, freeze the job until it is understood:
   `select cron.alter_job(jobid, active := false) from cron.job where jobname = 'funnelfox-leads-reconcile';`
   Rollback: `select cron.unschedule('funnelfox-leads-reconcile');` (requests then simply stay
   queued; nothing reads the five conversion columns the reconcile writes). While a request stays
   queued for more than 15 minutes, or after a failed run, the sync card shows an amber "Conversion
   reconcile queued since … but not applied yet" warning (the status itself stays `ok`).

How the background export proceeds:

- `funnelfox-leads-advance` posts every minute and runs ONE stage per call (~50 s budget):
  `profiles` (crawl the profile list newest first, store only rows with an email; checkpoint every
  10 pages) → `sessions` (attribution for the stored profiles) → `reconcile` (queues the conversion
  reconcile: paid / active emails stop being leads once the pg_cron job `funnelfox-leads-reconcile`
  applies it, within a minute; before `202610070001` it runs inline). Each call resumes from the
  saved cursor.
- The tick is skipped without an HTTP call while another call holds the lease (120 s), while a
  FunnelFox 429 pause runs (`stats.rate_limited_until`, Retry-After or 60 s), while the backoff after
  a FunnelFox error runs (`stats.error_backoff_until`, 60 s doubling to at most 1 h) and once every
  stage is complete. The Continue button only speeds things up (at most 10 calls per click) and is
  never held back by the error backoff. A cursor FunnelFox keeps refusing is dropped after 3 errors
  in a row (the pass restarts from the newest profile).
- `funnelfox-leads-refresh` (06:15 UTC daily, after the 05:45 subscriptions refresh) re-crawls the
  whole list. While a healthy pass is still unfinished it only advances it, so the backfill never
  restarts; a pipeline whose last run failed is restarted.
- Progress (read-only): `select current_stage, last_status, last_error, lease_until,
  profiles_completed, sessions_completed, reconcile_completed, stats->>'profiles_scanned_total',
  stats->>'profiles_with_email', stats->>'rate_limited_until', stats->>'error_backoff_until',
  reconcile_requested_at, reconcile_applied_at, reconcile_summary, reconcile_failure from
  public.funnelfox_leads_sync_state;` (the four new `reconcile_*` columns exist once `202610070001`
  is applied; the sync card shows "Conversion reconcile queued …" while a request waits for the job —
  not a failure — and an amber warning once it waits past 15 minutes or its last run failed).
- What the Leads tab shows (owner decision 2026-10-07, for speed): only the **latest 1,000 leads**
  by lead date (about the last 3 days today). The list, search, filters, filter options and the
  Total Leads / Leads Today / Leads Last 7 Days cards cover those 1,000; Emails Found, Converted
  Excluded and Active Subs Excluded are whole-base counts. A banner says "Showing the latest 1,000
  leads (since …)" and when the server last computed them (the cache is at most ~5 minutes old;
  the Refresh button and the end of a sync rebuild the server's 60 s memo and recompute the cache
  unless it is under a minute old). Known transient: for up to ~5 min after an import's ClickHouse
  sync, a returning old lead can show with its new transaction date, and a just-converted recent
  lead can stay listed, until the next `funnelfox-leads-recent-cache` tick (the cached Postgres
  candidates are merged with the live ClickHouse rows).
- Pause / resume: `select cron.alter_job(jobid, active := false) from cron.job where jobname like
  'funnelfox-leads-%';` (`active := true` to resume; this includes `funnelfox-leads-recent-cache`
  and `funnelfox-leads-reconcile` — freeze all four leads jobs around a deploy that touches them).

Server-summary flags stay off in production until real-data parity is confirmed
(see `.env.example`): `VITE_FB_ANALYTICS_SOURCE` and `VITE_DASHBOARD_SOURCE`
default to `client`; `VITE_COHORTS_DATA_SOURCE` defaults to `clickhouse`.

### Funnel-scoped access (access Phase 2) — in this order

Members with **Selected funnels** can open Dashboard (Revenue Intelligence only), Cohorts, Funnels
(read-only) and FB Analytics (warehouse tab, campaign / adset / ad levels). They see the customers
whose acquisition funnel (`fact_user_cohorts.campaign_path`) is one of their funnels' paths, with every
later payment of those customers; unregistered, `unknown` and synthetic `unknown_user_*` data, and FB
campaigns shared by several funnels, stay visible with scope **All funnels** only. Every other page and
action answers 403 `scope_not_supported`; while the funnel-scoped snapshot is not ready the four pages
answer 409 `scope_snapshot_not_ready` ("Funnel-scoped data is being prepared").

The SQL comes first: the frontend embeds `funnel_paths`, and the functions read the new snapshot columns.

1. **Pre-flight** (read-only). Non-canonical anchor paths stay invisible to restricted members until a
   separate, signed-off data rewrite:

   ```sql
   -- Q1 (Postgres): non-canonical transaction paths of the data key
   select source, campaign_path, count(*), count(distinct user_id) from public.transactions
   where auth_user_id = (select data_key from public.workspaces) and deleted_at is null
     and (campaign_path !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or campaign_path is null) group by 1, 2 order by 4 desc;
   -- Q2 (Postgres): registry rows the migration will not seed as active
   select id, funnel_path from public.funnels where funnel_path !~ '^[a-z0-9]+(-[a-z0-9]+)*$';
   -- Q3 (ClickHouse console): non-canonical anchors of the active snapshot (expected: only 'unknown')
   SELECT campaign_path, uniqExact(canonical_user_id) FROM fact_user_cohorts FINAL
   WHERE auth_user_id = '<data key>' AND warehouse_version = '<active>'
     AND NOT match(campaign_path, '^[a-z0-9]+(-[a-z0-9]+)*$') GROUP BY 1;
   ```

   Q2 also matters after the release: a funnel created or re-pathed from now on stores the canonical
   path (a FunnelFox alias `Soulmate_Sketch` is stored as `soulmate-sketch`), while the daily
   `funnels-active-from-traffic` recompute still compares the raw `ff_campaign_path`. Such a funnel stays
   inactive until a separate, owner-signed migration compares canonical forms there. The FunnelFox
   aliases seen so far are already canonical; existing rows are not rewritten.

2. **Apply `202610060001_access_phase2_scope.sql`** to production, outside `supabase db push` (which would
   also apply `202610060002` before the functions exist), and record it as applied:

   ```text
   npx.cmd supabase db query --linked -f supabase/migrations/202610060001_access_phase2_scope.sql
   npx.cmd supabase migration repair --status applied 202610060001
   ```

   (or paste the file into the SQL editor, then run the `migration repair` line). Without `--linked`,
   `db query` targets the local stack; without the repair, the next `supabase db push` runs the file again
   and aborts on `relation "funnel_paths" already exists`, which blocks every later migration. It refuses
   to run before `202610050003`. Check `select status, source, count(*) from public.funnel_paths group by 1, 2;`
   and `select public.resolve_access('<an all-scope member uuid>');`.
3. **Deploy every function**: `npm.cmd run deploy:functions -- --project-ref wsjbpkderyhdefukppvb`, then
   `--verify-only` (freeze / unfreeze the crons as above). The script now also refuses to deploy until
   `public.funnel_paths` exists (step 2): the `access` function's member and funnel lists embed it.
4. **Apply `202610060002_cohort_membership_freshness_cron.sql`** the same way (the cron calls the new
   `cron_tick` action, so the functions must be live first):

   ```text
   npx.cmd supabase db query --linked -f supabase/migrations/202610060002_cohort_membership_freshness_cron.sql
   npx.cmd supabase migration repair --status applied 202610060002
   ```
5. **Build the campaign scope and the freshness stamp**: `select public.invoke_cohort_membership_tick(true);`,
   then
   - `select status_code, left(content, 400) from net._http_response order by id desc limit 1;` → 200 with
     `tick_status` `campaign_scope_rebuilt` or `rebuilt` (`current` when the scope was already built).
     `backoff` means a build of the same warehouse version failed or was abandoned recently: the tick
     waits 1 h after the first attempt, doubling per attempt up to 6 h. The owner's own rebuild has no
     backoff: read `last_error` in `clickhouse_cohort_snapshot_state`, then open Cohorts as the data owner
     (it rebuilds a stale snapshot) and run the tick again. `in_progress` means another build holds the
     lease: run the tick again in a few minutes;
   - `select active_campaign_scope_version, fresh_verified_at, stale_since from public.clickhouse_cohort_snapshot_state;`
     → `campaign_scope_v1` and a fresh timestamp. The campaign scope is built after the snapshot is
     activated, so its result is in the tick response (`campaign_scope`), not in `diagnostics`;
   - the rebuild `duration_ms` (classification and validation, up to activation) stays under 40 s. The
     campaign scope then gets at most 10 s more, and the whole call must answer within the 55 s function
     limit.

   The tick then runs every 15 minutes (`7,22,37,52 * * * *`) while any restricted member exists. Restricted
   reads need a snapshot verified within `SCOPE_SNAPSHOT_MAX_STALENESS_HOURS` (Edge secret, default 6).
6. **Push the frontend** to `main` (Lovable).
7. **Admin → Funnel coverage**: registered users ≈ 98% of the snapshot; confirm the seeded proposals
   (`soulmate-1-tariff-month-veb → soulmate-sketch`, `starseed-reading-spain → starseed-reading-sp`);
   review the unregistered queue. Attaching, confirming or retiring a path changes what its members see
   on their next request.
8. **Smoke test and parity**, before any real buyer:
   - add the owner's second account as a Media Buyer with ONE funnel that has no synthetic
     `unknown_user_*` customers, then run `select public.invoke_cohort_membership_tick(true);` right away.
     While no restricted member exists the tick does not run, so the freshness stamp can be older than 6 h,
     and the member would get 409 until the next tick;
   - open the four pages; replay tampered requests (another funnel's path in the filters, another
     funnel's `cohort_key` / `funnel_key`, FB `level: "account"`): zero rows / 403;
   - run the read-only parity check (exit 0 = parity, 1 = a difference above the tolerance, 2 = error;
     the JWTs come from signed-in browser sessions and are never printed):

     ```text
     SUPABASE_URL=https://wsjbpkderyhdefukppvb.supabase.co SUPABASE_ANON_KEY=... OWNER_JWT=... MEMBER_JWT=... \
     MEMBER_PATHS=<the test funnel's paths, comma-separated> node scripts/scope-parity-check.mjs [--date-from … --date-to …]
     ```
9. **First real buyer.** Keep at most 3 restricted members active at the same time until the separate
   read-only ClickHouse user exists (plan Phase 8): six concurrent classifier passes do not finish.

Rollback (Phase 2):

1. Disable the restricted members first.
2. Cron: `select cron.unschedule('cohort-membership-freshness');` (before the functions, so no tick
   reaches a build without `cron_tick`).
3. Functions: redeploy the last `main` before Phase 2 with the deploy script (`91fea2f` as of
   2026-10-07: server-side Leads, the latest-1,000 candidates and the queued reconcile; an older
   build would run the reconcile inline again, which times out) — restricted members get 403
   everywhere again.
4. SQL: run `supabase/rollback/202610060001_rollback.sql`. `funnel_paths`, the new snapshot columns and
   `fact_campaign_scope` stay in place, unused. Leave the `schema_migrations` rows of `202610060001` /
   `202610060002` in place: `202610060001` is one-shot (plain `create table` / `create trigger` /
   `create policy`), so a later roll-forward needs a dedicated script, not a re-run of the file.
5. Frontend: return `main` to its pre-Phase-2 frontend with `git revert -m 2 <merge>`, where
   `<merge>` is the newest commit that merged `main` into `feature/access-phase2`
   (`git log --merges -1 --format=%h feature/access-phase2`; parent 1 = the Phase 2 side, parent 2 =
   `main`). Never `-m 1`: it drops the Leads frontend and keeps Phase 2. The `funnel_paths` embed keeps
   working, the table still exists.
6. The ClickHouse retention deletes cannot be undone; they only remove versions older than the previous
   active snapshot.

Known limits of Phase 2 (accepted, or waiting for a later phase):

- **Email-matched token purchases** (owner decision pending). Cohorts folds a non-member token purchase
  into the cohort of the member with the same email. A restricted list does that within the member's own
  funnels, exactly like the owner's Cohorts filtered to those funnels (spec R-2). When two funnels' members
  share an email, both buyers see that purchase, while the owner's unfiltered view gives it to the earliest
  trial. Other by-email channels: support requests and active subscriptions.
- **Re-pathing** keeps the old path granted (retired), so cohorts acquired under it stay visible. A path
  set by mistake stays granted until it is revoked under Admin → Funnel coverage. A revoked path is never
  re-granted by editing the funnel's path: attach it again first.
- **Saved objects**: reports, forecasts and AI history a member saved while on All funnels stay readable
  to them after they are narrowed (Phase 4 scope stamps; the member sheet says so).
- **Capacity**: no per-member limit on parallel restricted requests yet (each request runs at most 3
  ClickHouse queries at once) — the step-9 cap and the Phase 8 ClickHouse user are the gate.

### Payment health P0 — rollout (data fixes, in this order)

A separate release with a before / after comparison (plan "Payment System Health", phase P0, owner
decision 1). It changes data, not pages: raw CSV rows are paired with transactions by Primer id, the
32 mis-paired `raw_payload` rows are repaired, `transactions.country_code` is filled (FunnelFox
country), `transactions.refund_observed_at` appears (trigger-owned), `analytics_transactions` gains
the payment health columns (`raw_status`, MID, descriptor, CIT/MIT, decline codes, 3DS, ...), and
Payment Pass stops counting CANCELLED / PENDING rows as attempts. Details: DEVELOPER_NOTES.md
"Payment health P0". Nothing changes `status` (CANCELLED / PENDING stay `failed`) and no cohort anchor
moves — the comparison below proves it.

1. **Before**: run every statement of `scripts/sql/p0_before_after.sql` (read-only, one statement per
   `npx supabase db query --linked --project-ref wsjbpkderyhdefukppvb "<statement>"` call) and keep
   the output. Expected on 2026-10-11 data: 0% country fill, 32 mismatched raw ids (all repairable),
   8 status / 4 processor disagreements (#5, both sides present; 6 of the 8 flip the outcome), 14
   card-type disagreements and 3 success rows with a decline bucket (#7), 0 refunds with
   `refund_observed_at`.
2. **Apply `202610110001_payment_health_p0.sql` alone** — out of band, never `supabase db push` (it
   would also apply any other pending file), and record it:

   ```text
   npx supabase db query --linked -f supabase/migrations/202610110001_payment_health_p0.sql
   npx supabase migration repair --status applied 202610110001
   ```

   (or paste the file into the Dashboard SQL Editor; either way one transaction). It refuses to run
   before `202610070001`. It adds the column + trigger, backfills `refund_observed_at` of the refunded
   rows with `updated_at` (approximate), repairs the mis-paired rows from the row that holds the
   correct payload, rebuilds their `normalized_payload->'raw'` and drops their derived `card_type` /
   `normalized_decline_reason` / `decline_message` keys (the ClickHouse mapper and the browser
   hydration read those first and fall back to the payload only when they are absent; both re-derive
   them from the repaired payload, and the Integrations "repair legacy normalized payloads" action
   re-persists them whenever it is next run), fills `country_code` from `metadata.ff_country_code`
   (safe parse), and aborts if a mismatched row whose correct payload exists is left. The NOTICE
   lines report the three counts. Idempotent.
3. **After**: run `scripts/sql/p0_before_after.sql` again. #2 (trial anchors: count and checksum) must
   be identical; #4 `repairable`, #5 and #7 must be 0; #3 fill rate ~37.5%; #6 `with_observed_at` =
   `refunded_rows`. Stop here if #2 differs.
4. **Deploy every function** with `npm run deploy:functions` (above). The backfill build selects
   `refund_observed_at`, so it must come AFTER step 2 (before it, every `clickhouse-backfill` batch
   read fails on the missing column and the post-import auto-sync reports "failed"; nothing is written).
   Press step 5's **Init immediately after** the deploy finishes, and let **no CSV import** (its
   post-import auto-sync) and **no Continue Backfill** run in between: the new backfill build inserts
   the 24 payment-health columns, and ClickHouse rejects the batch (unknown JSONEachRow fields) until
   Init adds them. A run in that window first evicts the batch's rows (DELETE before INSERT), so they
   are missing from every ClickHouse surface until the next successful run after Init rewrites them
   (the cursor does not advance on a failed batch, so that run does).
5. **ClickHouse Init** once from Integrations (adds the columns, `ADD COLUMN IF NOT EXISTS`), then a
   **full backfill** from Integrations (`mode: full_backfill`, Continue until `completed`; ~68k rows,
   a few minutes). Until it completes, the new columns are `''` / 0 / NULL on the rows not yet rewritten
   and Payment Pass keeps its old denominator (`raw_status = ''` rows are kept).
6. **Deploy the frontend**: new imports pair raw rows by id and show "Raw rows unpaired" in the
   warehouse summary (0 expected; a non-zero count means a transaction whose id has no raw row stored
   its own normalized subset as `raw_payload` — never a neighbouring CSV row — and the raw-row index
   should be looked at).

Numbers that change (expected, not regressions):

- **Payment Pass / Banks attempts** drop by the CANCELLED + PENDING rows (168 + 48 on 2026-10-10
  data, ~0.3% of attempts); approvals do not move, so every pass rate rises slightly (Stripe CIT cards
  the most, ~+1.7 pp). Users → declines and the cohort / revenue numbers do not change.
- **Transactions country**: ClickHouse `country_code` already fell back to the user's country, so it
  moves only where a transaction's FunnelFox country differs from the user's; measure with #3.
- **32 rows** get their own raw payload: 6 change raw status, 4 change processor in the ClickHouse
  columns derived from `raw_payload` (`processor`, issuer, network, decline fields); their `card_type`
  and `decline_reason` are re-derived from their own payload (14 card types change, 3 success rows
  lose the decline bucket a neighbour's DECLINED payload gave them); `status` and the amounts never
  move.
- **Refund dates** exist from now on (`refund_observed_at`): approximate (`updated_at` of the row at
  rollout) for refunds observed before 2026-10-11, the first import that saw the refund afterwards.

Rollback: the migration is additive (the column, trigger and `app.*` helpers can stay); the repaired
payloads and the filled countries are the correct data and are not rolled back. Redeploying the
previous functions is safe (they ignore the new columns). To undo the Payment Pass denominator alone,
revert `ATTEMPT_RAW_STATUS_EXCLUSION` in `paymentAnalytics.ts` and redeploy.

### Payment health P2 — permissions, migration, deploy

The Payment System Health page's backend (plan phase P2; DEVELOPER_NOTES.md "Payment health P2
backend"): the Edge function `clickhouse-payment-health` and five catalog keys. Owner + Admin only in
the MVP (owner decision 3).

**Permissions** (`supabase/functions/_shared/access/permissions.ts`):

| key | kind | what it opens |
|---|---|---|
| `payment_health.view` | ordinary | the page: approvals and declines, retries, refunds and complaints, data sources, filter options |
| `payment_health.export` | ordinary (requires view, export-sensitive) | downloads (frontend) |
| `payment_health.risk_events.view` | ordinary (requires view) | dispute / fraud-report events once a source is connected (P3) |
| `payment_health.psp_global.view` | **privileged** (requires view; full scope, Owner-granted) | PSP × MID and descriptor breakdowns, the MID / descriptor filters and options |
| `payment_health.manage_alerts` | **privileged** (requires view) | alert writes (P2.5) |

Ordinary keys do not make the module reachable for a funnel-restricted member: no action is
scopeReady, so a narrowed member holding `payment_health.view` gets 403 `scope_not_supported`
(`permission_denied` without it), exactly like Payment Pass. Without `payment_health.psp_global.view`
the page is served with the PSP × MID table, the account references and the registry filter options
stripped, and a request naming a PSP filter or dimension is 403 `permission_denied` — counted in the
owner's denial counters like any other 403 (the gate records a 403 the handler raises too).
`payment_health.view` is also a **warehouse-probe key** (`WAREHOUSE_PROBE_VIEW_PERMISSIONS` in
`policies/clickhouse-summary.ts`): the page keys its cache on the warehouse version from
`clickhouse-summary`, so a member holding only this key must be able to call that probe.

**New keys are not added to stored roles.** The Owner role holds every enforced key implicitly. The
`admin` template only reflects the catalog at seeding time, so the live Admin role does NOT gain the
keys by deploying: the owner adds `payment_health.view`, `payment_health.export`,
`payment_health.risk_events.view`, `payment_health.psp_global.view` (and later
`payment_health.manage_alerts`) to the Admin role by hand under Admin → Roles (owner decision 10;
only the Owner may grant the two privileged keys, and only to full-scope members).

**Rollout, in this order:**

1. **Apply `202610120001_payment_health_permissions.sql` alone**, out of band like the P0 / P1 files
   (never `supabase db push` while earlier-sorting migrations are pending), and record it:

   ```text
   npx supabase db query --linked -f supabase/migrations/202610120001_payment_health_permissions.sql
   npx supabase migration repair --status applied 202610120001
   ```

   It refuses to run before `202610110002` (the P1 registries) and refuses — changing nothing — when a
   member outside funnel scope all already holds a role with one of the two privileged keys (name the
   member, re-scope or edit the role, re-apply). It extends `app.is_privileged_permission` to the two
   keys (the SQL side of the anti-escalation rules); the TS catalog and the predicate are kept in
   parity by `accessCoreMigration.test.ts`. One transaction, idempotent.
2. **Deploy every function** with `npm run deploy:functions` (28 functions now; the script refuses a
   partial set). The migration comes FIRST: with the new catalog live and the old predicate, an Admin
   could grant `payment_health.psp_global.view` as if it were ordinary.
3. **Registry labels**: the page shows MIDs as `psp_accounts` labels ("Stripe MID #1", ...). A MID
   that appears after the last `psp_accounts_sync` shows as "Unlabelled MID" until the sync runs
   (the runner does not call it); run `select public.psp_accounts_sync();` after an import that may
   have introduced a MID, or edit the labels / `descriptor_prefix` in `public.psp_accounts`. Alerts
   (P2.5) raised on an "Unlabelled MID" carry over to its label after the sync (the alert engine
   matches the MID's former key); only deleting a `psp_accounts` row leaves its open alerts to be
   resolved or dismissed by hand.
4. **Funnel attribution** needs a validated `fact_user_cohorts` snapshot (the Cohorts snapshot state);
   without one every row is "unattributed" and the response says so (`meta.funnel_attribution`).
5. **Frontend**: the `/payment-health` page ships with the SPA (Lovable deploys `main`); see
   "Payment System Health (page)" below. It needs the function above live: every tab is one
   `clickhouse-payment-health` request, and until the function is deployed the page shows its
   error card (never zeros).

Rollback: redeploy the previous functions (the policy file is only read by the new function; the
catalog keys stay harmless in `permissions.ts` and in roles that list them). The migration can stay:
the predicate only matters for keys no role holds unless the owner granted them.

### Payment health P2.5 — alerts: migrations, deploy, daily run

The alert engine of the Payment System Health page (plan section Q, phase P2.5; DEVELOPER_NOTES.md
"Payment health P2.5 alerts"). Once a day it reads the page's own figures for the newest complete
windows of whole days (the 7 days before "data through" against the 7 before them — "data through"
itself is the day the export was taken during, so it is partial and left out; the last 30 days for
the retry rules; the newest window that is 30 days old for refunds), raises an alert where a rule's
threshold is crossed **and** the change is significant (95% Wilson intervals, at least 200
observations per window), and resolves an open alert by itself only when a later run finds the
condition clear: enough data and a change under the warning threshold. A change above the threshold
that is not significant leaves an open alert as it is. A smaller sample or a still-maturing window
— for complaints also support data that does not reach the window's end — never raises a warning
and never resolves anything: at most an `info` alert marked **low confidence**. Every alert says the fact, the likely explanation, an **unverified**
hypothesis and lawful actions only (clear descriptor, re-attempt rules, 3DS where the issuer requires
it, cancellation and refunds, traffic quality) — never moving or splitting volume between MIDs,
descriptors or PSPs, and never lowering authentication. Network-ratio alerts (VAMP / ECP) come with
the dispute data (P4).

**Rules** (`public.payment_alert_rules`; the owner may change thresholds, `enabled` and `params` in
the SQL editor, a re-applied migration never resets them):

| rule | fires on | warning / critical |
|---|---|---|
| `approval_drop` | approval per PSP × MID and CIT / MIT fell, significant — and per PSP (all its MIDs together) when it has more than one | 5 / 10 pp |
| `issuer_fraud_rise` | issuer fraud-suspicion declines (59 / 63 / 83) per PSP × MID rose — a decline code, not fraud | 1 / 2.5 pp |
| `psp_integration_rise` | PSP / integration declines per PSP × MID, and those + unrouted declines over all attempts, rose | 1 / 3 pp |
| `post_ban_retries` | re-attempts after a do-not-retry decline in the last 30 days, CIT and MIT separately | 1 / 10 attempts |
| `excessive_reattempts` | card × MID pairs with more than 15 declines in a rolling 30 days | 1 / 5 pairs |
| `unauthorized_complaints_rise` | "possible unauthorized charge" requests per settled payment, per PSP × MID, rose (low confidence while the support data does not reach the window's end) | 1 / 3 pp |
| `refund_rate_rise` | refund rate per PSP × MID by original payment date rose, on the mature window | 1 / 2.5 pp |
| `data_stale` | "data through" older than 7 / 14 days, or the last ClickHouse sync of payment rows or of support requests older than 72 / 168 hours | — |

A dismissed alert, or one resolved by a person, is not raised again for the same evidence: while the
next windows still overlap the one that was closed (a 7-day window shares 6 days with the day
before's; for the retry rules, until a newer re-attempt or violation appears), unless it becomes more
severe.

**Who.** Reading alerts needs `payment_health.view`; alerts that name a PSP account are shown only
with `payment_health.psp_global.view` (or to the data owner), like the page's PSP × MID table.
Changing a status (new → investigating / resolved / dismissed, investigating → resolved / dismissed,
a closed alert back to investigating) and "run now" need the privileged
`payment_health.manage_alerts` — the owner adds it to the Admin role by hand under Admin → Roles.
Every status change writes an `access_audit_log` row (`payment_health.alert_status_changed`).
"Run now" is limited to one run per 5 minutes.

**Rollout, in this order:**

1. **Apply `202610130001_payment_health_alerts.sql` alone**, out of band like the earlier payment
   health files (never `supabase db push` while earlier-sorting migrations are pending), and record it:

   ```text
   npx supabase db query --linked -f supabase/migrations/202610130001_payment_health_alerts.sql
   npx supabase migration repair --status applied 202610130001
   ```

   It refuses to run before `202610120001` (the key that gates the writes must already be
   privileged). One transaction, idempotent: the tables `payment_alert_rules` (seeded with the
   eight rules), `payment_alert_runs`, `payment_risk_alerts` (RLS on, no browser access, the service
   role reads them and writes only through the four `payment_alert*` functions).
2. **Deploy every function** with `npm run deploy:functions` (still 28: the alerts are actions of
   `clickhouse-payment-health`, not a new function).
3. **Apply `202610130002_payment_health_alerts_cron.sql`** the same way, AFTER step 2 (before it,
   every tick would be answered 401 `invalid_session`: the old function has no cron branch, so the
   tick is treated as a user request with the anon key):

   ```text
   npx supabase db query --linked -f supabase/migrations/202610130002_payment_health_alerts_cron.sql
   npx supabase migration repair --status applied 202610130002
   ```

   It schedules the pg_cron job `payment-health-alerts` daily at 07:40 UTC (after the night's syncs
   and the 06:15 leads refresh). It posts `{auth_user_id: <data key>, action: "alerts_tick"}` with the
   shared FB cron secret, like the cohort freshness tick.
4. **First run**: `select public.invoke_payment_alerts_tick() as request_id;` (it returns the pg_net
   request id), then — after about two minutes, a run can take that long — read THAT response (other
   cron jobs write `net._http_response` too, so "the newest row" can be someone else's):
   `select status_code, timed_out, left(content, 400) from net._http_response where id = <request_id>;`
   → 200 with `{"ok":true,"action":"alerts_tick","run":{...,"status":"succeeded",...}}`. The run row
   says the same: `select status, trigger, data_through from public.payment_alert_runs order by started_at desc limit 1;`
   → `succeeded`, `cron`.
5. **Verify** (read-only):
   - `select status, trigger, data_through, summary -> 'applied' from public.payment_alert_runs order by started_at desc limit 3;`
   - `select rule_key, severity, status, data_confidence, window_end, sample_size from public.payment_risk_alerts order by last_seen_at desc;`
   - `select jobname, schedule from cron.job where jobname = 'payment-health-alerts';` → `40 7 * * *`
   - no alert carries a raw MID (prints a count only):
     `select count(*) from public.payment_risk_alerts a join public.psp_accounts p on p.auth_user_id = a.auth_user_id and a.evidence::text || a.explanation::text || a.scope::text like '%' || p.processor_merchant_id || '%';` → 0
6. **Frontend**: the Alerts tab ships with the SPA and reads `alerts_list`; it needs step 2 live
   (until then the tab says the checks are not deployed yet). What the tab shows: "Payment System
   Health (page)" below.

Rollback: `select cron.unschedule('payment-health-alerts');` and redeploy the previous functions.
The tables can stay (nothing else reads them).

### Payment System Health (page)

Sidebar "Payment health" → `/payment-health`. What the page shows, who sees it and what is an
estimate (DEVELOPER_NOTES.md "Payment health P2 frontend" for the code).

**Who opens it.** The route needs `payment_health.view` (Owner always; the Admin role once the owner
adds the key under Admin → Roles). A funnel-restricted member never sees it (no action of the module
is scope-ready yet, like Payment Pass). The PSP × MID table, the processor / merchant account /
descriptor filters and those three breakdown dimensions appear only when the server answers with
`psp_global_visible` — the data owner or a member holding `payment_health.psp_global.view`; the page
never probes for the key, and a filter remembered from a session that had it is dropped, not sent.

**The banner** on every tab: *Estimates from the Primer export; data through <day>; network ratios need
official reports.* "Data through" is the newest attempt day in the warehouse (the manual CSV import,
not a live feed). A window that ends after it carries a grey **incomplete period** marker, and a
comparison inside it is never called significant. The refund rate and the unauthorized-charge complaint
rate mature later still: a payment can be refunded or complained about for weeks, so their comparison
keeps the marker (and is never called significant) until "data through" is 30 days past the window's
end — the newest window is always lower on these two for structural reasons, not because anything
improved. The trend chart covers every day of the window (a day without attempts is a zero bar) and
draws the days after "data through" lighter.

**Filters** (remembered per person): period (last 7 / 14 / 30 / 90 days, rolling with today in UTC, or
custom dates) compared with the previous period of the same length; processor, merchant account and
statement descriptor (registry labels such as "Stripe MID #1", "Unlabelled MID" for a MID that
appeared after the last `psp_accounts_sync`); funnel (the user's acquisition anchor from the cohort
snapshot — totals match Payment Pass, the per-funnel split can differ, and without a validated
snapshot every row is "unattributed"); issuer country (BIN, not the billing address); card network;
payment method; CIT / MIT; stage / transaction type.

**Reading the numbers.** A rate whose denominator is zero reads **no data**, never 0%. Every
comparison shows the current rate, the arrow against the previous period, the delta in percentage
points and flags: **significant** (95% Wilson intervals do not overlap and both periods reach the
minimum sample, 200 attempts), **small sample**, **incomplete period**. Declines are classified
(insufficient funds, issuer suspected fraud, lost or stolen, restricted, closed account, policy,
issuer unreachable, other issuer, authentication, PSP / integration, cause not verified); "Issuer
suspected fraud (decline, not fraud)" is the issuer's suspicion code — a decline, never a fraud count.

**Tabs**

| tab | what it answers |
|---|---|
| Overview | Attempts, approval rate, issuer-suspected-fraud decline rate, refund rate, unauthorized-charge complaint rate and settled amount, each against the previous period; the daily (or weekly) attempts / declines / approval trend; the PSP × merchant account table (volume, approval, issuer-suspected-fraud rate, refund rate, complaint rate, trend sparkline); the decline-class mix; "What changed": for each dimension's top movers, Δ declines split into the volume effect (more attempts at the old rate) and the rate effect (a worse rate on the new volume). |
| Approvals & Declines | Approval by a chosen dimension (processor, MID, descriptor, funnel, issuer country, card network, payment method, CIT / MIT, stage); decline classes with their rate over attempts; the issuer code / Primer code / advised action / advice code mix with soft / hard severity, the re-attempt guidance each code carries and the **ban** rows (DO_NOT_RETRY, STOP_ALL_PAYMENTS, Visa category 1, Mastercard MAC 03 / 21). |
| Retries & Network Rules | Attempt chains (**heuristic**: Primer gives every retry a new orderId, so chains link attempts by user, instrument or currency + amount, price point and initiation within CIT 60 min / MIT 72 h): first-try approval, final success, retry recovery, cascade recovery; post-ban re-attempts (CIT / MIT, same / switched processor, within one hour, succeeded) with the newest rows; instrument × account pairs over 15 decline records in a rolling 30 days. The tab says **rules unverified**: the network rules come from secondary sources, the flags are potential violations, not fines. |
| Refunds & Complaints | Refunds by the original payment date: rate against the previous period, timing buckets from the import that first saw the refund (≤ 7 / 30 / 90 / > 90 days; "unobserved" = synced before P0), by payment month and by dimension. Support complaints (possible unauthorized charge, requires refund, duplicate charge) by received month, attributed to the last settled payment of the matched user within 30 days, else unattributed; by PSP × MID with the key; a month whose classifier version changed is marked **version break**. The Disputes & fraud reports card says the source is not connected yet. |
| Alerts | The alerts the daily checks raised (section "Payment health P2.5 — alerts" above). The tab carries the number of open alerts (new + investigating; red when one is critical). Each row: severity, rule, what it is about (registry labels only: "Stripe MID #1 · Stripe · CIT", or "Whole workspace"), current against previous with the change in pp (or the count / days for the retry and freshness rules), the sample and flags (**significant**, **small sample**, **incomplete window**, **low confidence**), the window, first / last seen, status and who holds it ("you" / "a teammate", never an id). Expanding a row shows the evidence (both windows with numerator, denominator, rate and 95% interval, the thresholds and minimum sample; for the retry rules the counts and, with the PSP key, the split by merchant account), the explanation in four labelled parts — **Fact**, **Likely explanation**, **Hypothesis** (marked *unverified*), **Recommended actions** — the history with notes, and **Open in …**, which switches to the tab, window and filters that show the same numbers. Filters: status (default: open) and severity; the page's period and filter bar do not apply here. |
| Data Sources | Warehouse bounds, last ClickHouse sync, rows synced before the P0 backfill, data through and lag; the share of attempt rows that fill each P0 column (decline-record columns over declines, `refund_observed_at` over refunded payments); the last import and the sync state (lifecycle fields only); support requests by month with classifier versions; the metric dictionary: every metric of the plan with its phase and whether it is measured, a heuristic or an estimate. |

**Alerts: what to expect.** A **low confidence** alert (a small sample or a still-incomplete window) always
reads *Info*, never warning or critical — it is a hint to look, not a finding. An issuer fraud-suspicion
alert counts the issuers' decline codes, not fraud. Alerts about a PSP account appear only with
`payment_health.psp_global.view` (or to the data owner); without it the tab says how many were left out.
With `payment_health.manage_alerts` (privileged; the data owner always) an expanded row offers the status
buttons the transition table allows — **Investigating** (you become the assignee if nobody is),
**Resolve**, **Dismiss**, and **Reopen** on a closed alert — each with an optional note saved in the
history, and the header offers **Run checks now** (one run per 5 minutes per workspace, whoever started
it; a run can take up to two minutes). Without open alerts the tab says *No open alerts — last run at
<time>*. The tab needs the P2.5 functions deployed (rollout above); against an older function it says
*The alert checks are not deployed on the server yet* and shows no count.

Disputes and 3DS are later phases: the page shows a placeholder, not a zero.

### Supabase Edge Function secret

```text
FUNNELFOX_SECRET=your_funnelfox_secret
```

Set the secret, then deploy with the deploy-all script (never function by function):

```text
supabase link --project-ref wsjbpkderyhdefukppvb
supabase secrets set FUNNELFOX_SECRET=your_funnelfox_secret
SUPABASE_SERVICE_ROLE_KEY=... npm run deploy:functions -- --project-ref wsjbpkderyhdefukppvb
```

Production FunnelFox flow:

```text
Lovable frontend -> Supabase Edge Functions -> FunnelFox API
```

The frontend sends the current Supabase Auth bearer token and anon `apikey` to Edge Functions. `FUNNELFOX_SECRET` stays only in Supabase Function secrets.

### Capsuled Facebook secrets

Capsuled Facebook traffic sync runs only in the `capsuled-facebook-sync` Supabase Edge Function. The browser never receives the Capsuled bearer token.

```text
supabase secrets set CAPSULED_API_BASE_URL=https://your-capsuled-api-host
supabase secrets set CAPSULED_API_TOKEN=your_capsuled_api_token
npm run deploy:functions -- --project-ref wsjbpkderyhdefukppvb
```

The function calls `GET /api/external/v1/fb-stats`, stores the raw response, upserts normalized campaign rows by `level + campaign_id + date range`, and refreshes the latest `facebook_traffic` snapshot for the Export API.

### Mail.ru Support Inbox secrets

Support Inbox reads `support@azora-astro.com` through IMAP from the `sync-support-mail` Supabase Edge Function. The browser never connects to IMAP and never receives the mailbox password.

Required Edge Function secrets:

```text
MAILRU_IMAP_HOST=imap.mail.ru
MAILRU_IMAP_PORT=993
MAILRU_IMAP_USER=support@azora-astro.com
MAILRU_IMAP_PASSWORD=...
```

Set secrets and deploy:

```text
supabase secrets set MAILRU_IMAP_HOST=imap.mail.ru
supabase secrets set MAILRU_IMAP_PORT=993
supabase secrets set MAILRU_IMAP_USER=support@azora-astro.com
supabase secrets set MAILRU_IMAP_PASSWORD=...
npm run deploy:functions -- --project-ref wsjbpkderyhdefukppvb
```

If Mail.ru 2FA is enabled, use an app password for `MAILRU_IMAP_PASSWORD`.

### Supabase settings

- Disable public signup.
- Add the production Site URL.
- Add production Redirect URLs.
- Create allowed users manually in Supabase Auth.
- Use only the publishable anon key in the frontend.

### Supabase dataset persistence

Apply database migrations before relying on cross-device data restore:

```text
supabase db push
```

(During the access-control rollout, follow its order instead: `202610050003` must not be pushed
before bootstrap and the function deploy.)

The `data_snapshots` table stores the latest Palmer, FunnelFox subscriptions, Facebook traffic, Forecasting settings, and Cohorts UI settings snapshots per authenticated user. RLS restricts each user to their own rows. IndexedDB remains the fast local cache for large datasets; Supabase DB is the cross-device fallback/source of truth. Do not store API secrets in snapshots.
