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

### Notes
- This project now uses a transformation pipeline:
  raw -> normalized -> classified -> cohort -> analytics
