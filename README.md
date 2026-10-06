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
