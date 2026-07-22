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

### Analytics Edge Functions (ClickHouse warehouse + server summaries)

Apply migrations first, then deploy the analytics functions:

```text
supabase db push
supabase functions deploy clickhouse-cohorts clickhouse-facebook clickhouse-init fb-analytics-summary dashboard-summary
```

After deploying `clickhouse-init`, run ClickHouse Init once from the Integrations UI —
it idempotently creates/extends the warehouse schema (including Warehouse V2 tables).

Server-summary flags stay off in production until real-data parity is confirmed
(see `.env.example`): `VITE_FB_ANALYTICS_SOURCE` and `VITE_DASHBOARD_SOURCE`
default to `client`; `VITE_COHORTS_DATA_SOURCE` defaults to `clickhouse`.

### Supabase Edge Function secret

```text
FUNNELFOX_SECRET=your_funnelfox_secret
```

Deploy the FunnelFox proxy functions:

```text
supabase link --project-ref wsjbpkderyhdefukppvb
supabase functions deploy funnelfox-subscriptions
supabase functions deploy funnelfox-subscription
supabase functions deploy funnelfox-profile
supabase secrets set FUNNELFOX_SECRET=your_funnelfox_secret
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
supabase functions deploy capsuled-facebook-sync
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
supabase functions deploy sync-support-mail
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

The `data_snapshots` table stores the latest Palmer, FunnelFox subscriptions, Facebook traffic, Forecasting settings, and Cohorts UI settings snapshots per authenticated user. RLS restricts each user to their own rows. IndexedDB remains the fast local cache for large datasets; Supabase DB is the cross-device fallback/source of truth. Do not store API secrets in snapshots.
