# Developer Notes

## Known Limitations

- Palmer column names can vary by export. `palmerTransform.ts` supports common aliases, but new exports may require additional aliases.
- Metadata can be missing, malformed, or split across direct columns and JSON payloads.
- Funnel detection is string-based and intentionally conservative.
- Successful non-upsell transactions are classified by lifecycle order, not by strict product price windows.
- Existing clean-template imports are trusted more than Palmer imports because they already include `transaction_type`.
- FunnelFox subscription monitoring is separate from Palmer transaction analytics and must not mutate transaction/cohort calculations.
- FunnelFox API secrets must stay server-side; do not expose `FUNNELFOX_SECRET` in Vite/browser code.

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

## FunnelFox Backend Requirement

The Subscriptions page calls `syncAllSubscriptions`, which uses a frontend-safe proxy placeholder. A production backend/serverless function should implement:

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

The browser will then call:

```text
GET /api/funnelfox/subscriptions
GET /api/funnelfox/profiles/{id}
```

The serverless endpoint calls FunnelFox:

```text
GET https://api.funnelfox.io/public/v1/subscriptions
Fox-Secret: process.env.FUNNELFOX_SECRET
```

The endpoint proxies page-by-page requests. The frontend keeps following `pagination.has_more` and passes `pagination.next_cursor` back as the `cursor` query parameter.

If subscription rows do not include email, sync enriches missing emails through the server proxy:

```text
GET https://api.funnelfox.io/public/v1/profiles/{id}
Fox-Secret: process.env.FUNNELFOX_SECRET
```

Profile ids are read from `profile_id`, `profile.id`, `profileId`, or string `profile`. Profile fetches are cached per sync so repeated subscriptions for the same profile only call FunnelFox once. Profile fetch failures do not fail the whole subscription sync; the email stays `null`.

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

Open the app and use the Subscriptions sync button. In local development, Vite serves the app and the dev proxy at:

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

For development only, the Subscriptions page also has a collapsible FunnelFox API connection panel. A pasted key is kept only in React component state for the current browser session and is sent only to the server proxy as `X-FunnelFox-Secret`. The proxy still calls FunnelFox with `Fox-Secret` server-side. Do not store this key in localStorage, commit it, log it, or use this temporary input as the production configuration path.

Webhook planning:

```text
POST /api/webhooks/funnelfox
Verify header: Fox-Secret-Key
Handle: subscription.cancelled, subscription.activated, subscription.renewed
```

Do not implement production webhooks in the Vite frontend.

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
