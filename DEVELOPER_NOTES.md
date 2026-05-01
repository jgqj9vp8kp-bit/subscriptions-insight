# Developer Notes

## Known Limitations

- Palmer column names can vary by export. `palmerTransform.ts` supports common aliases, but new exports may require additional aliases.
- Metadata can be missing, malformed, or split across direct columns and JSON payloads.
- Funnel detection is string-based and intentionally conservative.
- Successful non-upsell transactions are classified by lifecycle order, not by strict product price windows.
- Existing clean-template imports are trusted more than Palmer imports because they already include `transaction_type`.

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
