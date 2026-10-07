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
   function answers 503 to every call, cron and Export API key);
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
   'funnels-active-from-traffic');`
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
4. **Apply `202610060011_funnelfox_leads_cron.sql`** (`supabase db push`, now the only pending file;
   it refuses to run before `202610060010`). Applied before step 2, every tick would be a refused
   (401) Edge invocation. Check `select * from net._http_response order by created desc` for 200s.
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
