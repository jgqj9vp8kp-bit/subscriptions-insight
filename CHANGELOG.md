## [Unreleased]

### Added
- Palmer raw data import
- Transaction normalization layer
- Transaction classification (trial, upsell, first_subscription, renewal)
- Cohort system (cohort_date, cohort_id)
- transaction_day calculation
- FunnelFox subscription sync through server-side proxy
- IndexedDB cache for FunnelFox subscriptions
- FunnelFox active/cancellation metrics in Cohorts and Dashboard
- FunnelFox sync duplicate removal diagnostics
- Development-only FunnelFox raw payload debug and temporary key input guards
- Forecasting page with auto-filled editable absolute retention curve and LTV scenario outputs
- Reusable persisted page UI-state hook for filters and small table/scenario settings
- Import Data forecasting settings for editable default fallback retention curve
- Supabase Auth email/password login with protected analytics/import routes
- Temporary sessionStorage-only local admin login fallback for local development/demo when Supabase is not configured

### Changed
- Data connection controls were centralized on Import Data; Cohorts and Subscriptions now stay analytics/table-only.
- Dashboard, Cohorts, Users, Transactions, Subscriptions, Forecasting, and Import Data preserve small UI settings across navigation.
- Cohort calculations now use trial timestamp instead of calendar date
- Amount parsing fixed (cents -> USD)
- Status normalization updated
- Dashboard revenue analytics now use net revenue consistently with Users and Cohorts
- Palmer lifecycle classification now assigns `renewal_2` and `renewal_3` before later generic `renewal`
- Documentation updated to reflect sequence-based lifecycle classification
- FunnelFox proxy URLs are restricted to same-origin `/api/funnelfox/...` routes by default, and direct browser calls to `https://api.funnelfox.io` are blocked
- Raw FunnelFox debug payloads are sanitized before rendering

### Notes
- This project now uses a transformation pipeline:
  raw -> normalized -> classified -> cohort -> analytics
