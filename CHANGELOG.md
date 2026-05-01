## [Unreleased]

### Added
- Palmer raw data import
- Transaction normalization layer
- Transaction classification (trial, upsell, first_subscription, renewal)
- Cohort system (cohort_date, cohort_id)
- transaction_day calculation

### Changed
- Cohort calculations now use trial timestamp instead of calendar date
- Amount parsing fixed (cents -> USD)
- Status normalization updated
- Dashboard revenue analytics now use net revenue consistently with Users and Cohorts
- Palmer lifecycle classification now assigns `renewal_2` and `renewal_3` before later generic `renewal`
- Documentation updated to reflect sequence-based lifecycle classification

### Notes
- This project now uses a transformation pipeline:
  raw -> normalized -> classified -> cohort -> analytics
