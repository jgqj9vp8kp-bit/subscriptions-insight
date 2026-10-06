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
   'funnels-active-from-traffic', 'cohort-membership-freshness');` (the last one exists from access
   Phase 2 on; use the same list for every later deploy, and `active := true` to unfreeze).
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
3. Functions: redeploy commit `470a153` with the deploy script — restricted members get 403 everywhere again.
4. SQL: run `supabase/rollback/202610060001_rollback.sql`. `funnel_paths`, the new snapshot columns and
   `fact_campaign_scope` stay in place, unused. Leave the `schema_migrations` rows of `202610060001` /
   `202610060002` in place: `202610060001` is one-shot (plain `create table` / `create trigger` /
   `create policy`), so a later roll-forward needs a dedicated script, not a re-run of the file.
5. Frontend: revert the commit (the `funnel_paths` embed keeps working, the table still exists).
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
