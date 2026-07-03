# funnelfox-endpoint-probe (TEMPORARY DIAGNOSTIC — delete after the audit)

One-off Edge Function that probes FunnelFox for a **listing** endpoint capable of returning
email-only contacts (customers / profiles / sessions / leads / contacts), which the repo does not
use today. It is not imported by the app and changes no behavior. **Delete this folder once the
audit question is answered.**

## What it does

For each of `/profiles`, `/customers`, `/sessions`, `/leads`, `/contacts` (plus a `/subscriptions`
baseline), it calls FunnelFox with the server `FUNNELFOX_SECRET` and the pagination variants
`?limit=1`, `?page=1`, `?cursor=1`, and reports per call:

- HTTP `status` / `ok`
- `supports_listing` (did it return an array of rows?) and `array_container`
- `supports_pagination` + `pagination_fields`
- `top_level_keys`, `sample_row_keys`
- `target_field_presence` for: email, customer_id, profile_id, session_id, created_at, country,
  user_agent, funnel, campaign_path
- `email_masked_preview` (e.g. `jo***@example.com`)

## Safety

- Deploy **with** JWT verification (default) so only authenticated users can invoke it.
- `FUNNELFOX_SECRET` is read from Edge env only and never returned.
- PII-safe by default: field **names** + presence flags only; email values masked. The full
  sanitized sample row (key names + value *types*) is returned only if the server-only
  `FUNNELFOX_DEBUG=1` flag is set — a caller cannot enable it.

## Run

```bash
supabase functions deploy funnelfox-endpoint-probe        # JWT-verified by default
# FUNNELFOX_SECRET must already be set as a function secret (it powers the other funnelfox-* fns)
# optional, for the full sanitized sample row:
supabase secrets set FUNNELFOX_DEBUG=1

# invoke with a logged-in user's access token:
curl -s "$SUPABASE_URL/functions/v1/funnelfox-endpoint-probe" \
  -H "Authorization: Bearer $USER_JWT" -H "apikey: $SUPABASE_ANON_KEY" | jq .summary
```

`summary.any_listing_endpoint` answers the audit question directly;
`summary.listing_endpoints_found` lists any usable paths.

## Cleanup

```bash
supabase functions delete funnelfox-endpoint-probe
supabase secrets unset FUNNELFOX_DEBUG   # if you set it
rm -rf supabase/functions/funnelfox-endpoint-probe
```
