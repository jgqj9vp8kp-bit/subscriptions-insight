# Developer Notes

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
- Unknown funnels: stay `unknown`; do not default to `past_life`.
- Users without email: Palmer import keeps email empty and uses customerId, metadata email, or a unique `unknown_user_N` as user_id.
- Users without a successful trial: cohort fields are incomplete and `transaction_day` is `null`.
- Declined payments: classified as `failed_payment` and excluded from money-moving sums.
- Refunds from Palmer `amountRefunded`: status is preserved, refund amount is stored separately, and net revenue is gross minus refund.
- FunnelFox cancelled subscriptions may remain active until `period_ends_at`.
- FunnelFox mock mode returns no subscriptions until a backend proxy is configured.
- Set `VITE_FUNNELFOX_MOCK=false` only after a backend proxy exists; the browser still must not receive `FUNNELFOX_SECRET`.
- FunnelFox subscriptions are cached in IndexedDB, not localStorage.
- localStorage is only for small UI state such as filters, column settings, selected views, and forecast assumptions.

## FunnelFox Backend Requirement

The Import Data page calls `syncAllSubscriptions`, which uses a frontend-safe proxy placeholder. A production backend/serverless function should implement:

```text
GET /api/funnelfox/subscriptions
```

This repository includes two runtimes for the same proxy logic:

- Vercel/serverless deployment: `api/funnelfox/subscriptions.ts`
- Local Vite dev server: `vite.config.ts` registers a dev-only middleware for `/api/funnelfox/subscriptions`

A plain static Vite build does not execute `api/` files by itself. Production real sync requires a serverless/backend runtime such as Vercel, or an equivalent host that maps `/api/funnelfox/subscriptions` to server-side code.

The proxy runs server-side, reads the secret from the runtime environment, forwards optional `cursor` pagination, and returns the FunnelFox JSON response to the browser.

Set the server-side environment variable in the deployment platform:

```text
FUNNELFOX_SECRET=...
```

For local or deployed real sync, keep the secret out of `.env` files that are exposed to Vite. Only variables prefixed with `VITE_` are browser-facing, and `FUNNELFOX_SECRET` must never use that prefix.

After the server-side endpoint is available, enable real sync in the frontend environment:

```text
VITE_FUNNELFOX_MOCK=false
```

The browser will then call same-origin proxy routes:

```text
GET /api/funnelfox/subscriptions
GET /api/funnelfox/subscription?id=...
GET /api/funnelfox/profile?id=...
```

By default the browser blocks direct calls to `https://api.funnelfox.io` and blocks absolute external proxy URLs. External proxy URLs require `VITE_ALLOW_EXTERNAL_FUNNELFOX_PROXY=true`, and direct FunnelFox API URLs remain blocked.

The serverless endpoint calls FunnelFox:

```text
GET https://api.funnelfox.io/public/v1/subscriptions
Fox-Secret: process.env.FUNNELFOX_SECRET
```

The endpoint proxies page-by-page requests. The frontend keeps following `pagination.has_more` and passes `pagination.next_cursor` back as the `cursor` query parameter.

If subscription rows do not include email, product, funnel, or session fields, sync enriches them through subscription details via the server proxy:

```text
GET https://api.funnelfox.io/public/v1/subscriptions/{id}
Fox-Secret: process.env.FUNNELFOX_SECRET
```

Duplicate subscriptions are removed before normalization using `id`, then `subscription_id`, then `psp_id`; the most recently updated record is kept. Detail fetches are cached per sync so repeated subscription ids only call FunnelFox once. Detail failures do not fail the whole subscription sync; missing fields stay empty and the UI reports partial enrichment warnings.

Security warning: never put `Fox-Secret`, `FUNNELFOX_SECRET`, or the raw FunnelFox API URL in browser code. The browser must only call the server-side proxy.

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
