# Developer Notes

## Known Limitations

- Palmer column names can vary by export. `palmerTransform.ts` supports common aliases, but new exports may require additional aliases.
- Metadata can be missing, malformed, or split across direct columns and JSON payloads.
- Funnel detection is string-based and intentionally conservative.
- Transactions that do not match explicit pricing and timing rules become `unknown`.
- Existing clean-template imports are trusted more than Palmer imports because they already include `transaction_type`.

## Assumptions

- trial = `$1`
- upsell = `$14.98`
- subscription = `$29.99`
- upsell must occur within 60 minutes after trial
- first_subscription must occur around 5-10 days after trial
- renewal_2 must occur 25-40 days after first_subscription
- renewal_3 must occur 25-40 days after renewal_2
- renewal means later successful `$29.99` payments after staged renewals
- cohort_date is based on the user's successful trial timestamp
- cohort_id is `{campaign_path}_{cohort_date}`
- funnel is broad and campaign_path is exact; do not group cohorts by funnel

## Edge Cases

- Missing metadata: funnel becomes `unknown`.
- Missing campaign path: campaign_path becomes `unknown`.
- Unknown funnels: stay `unknown`; do not default to `past_life`.
- Users without email: the importer uses `unknown@example.com`.
- Users without a successful trial: cohort fields are incomplete and `transaction_day` is `null`.
- Declined payments: classified as `failed_payment` and excluded from money-moving sums.
- Refunds and chargebacks: status is preserved and amount is stored as negative revenue.

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
