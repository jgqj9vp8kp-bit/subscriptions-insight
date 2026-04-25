## Subscription Analytics — Plan

A clean, modern SaaS analytics frontend that simulates a Google Sheets-backed transaction database. Built so the mock data layer can be swapped for a real Google Sheets connection later with minimal changes.

---

### 1. Design system (Posthog/Mixpanel-inspired)

- Light, near-white app background; white cards with hairline borders + subtle shadows; rounded-xl corners.
- Accent palette: indigo/violet primary with teal + amber secondary accents for charts.
- Typography: Inter, tight headings, muted secondary text.
- Status pills (success / failed / refund / chargeback) and transaction-type badges with consistent color coding reused across pages.
- All colors defined as HSL tokens in `index.css` + `tailwind.config.ts` (no hardcoded colors in components).

### 2. App shell & navigation

- Persistent **left sidebar** using shadcn `Sidebar` with sections: Dashboard, Transactions, Users, Cohorts.
- Top header with app title "Subscription Analytics", a global date-range selector (last 7 / 30 / 90 days / all time), and a always-visible sidebar trigger.
- Responsive: sidebar collapses to icon rail on smaller screens; tables scroll horizontally on mobile.
- Routes added to `App.tsx`: `/` (Dashboard), `/transactions`, `/users`, `/cohorts`.

### 3. Mock data layer (Google-Sheets-shaped)

- `src/services/sheets.ts` — single module exposing async functions:
  - `getTransactions()`, `getUsers()`, `getCohorts()`
  - Each returns typed rows matching the exact column schema you provided (`transaction_id`, `user_id`, `email`, `event_time`, `amount_usd`, `currency`, `status`, `transaction_type`, `funnel`, `product`, `traffic_source`, `campaign_id`, `classification_reason`).
  - Internally reads from `src/services/mockTransactions.ts`. Later, the body of these functions can be replaced with a `fetch` to the Google Sheets API — callers won't change.
- `src/services/analytics.ts` — pure functions that derive KPIs, daily revenue, funnel rollups, user aggregates, and cohort metrics from the raw transaction rows (so logic mirrors what would happen against real sheet data).

### 4. Mock dataset (50 users, realistic scenarios)

Generated deterministically and including:
- Trial $1 only (some convert, some don't)
- Trial $1 + upsell $14.98
- Trial $1 + first subscription $29.99 after 7 days
- Trial $1 + upsell + subscription
- Multiple monthly renewals at $29.99
- Failed payments, refunds, and a few chargebacks
- Funnels: `past_life`, `soulmate`, `starseed`
- Traffic sources: `facebook`, `tiktok`, `google`
- Spread across ~90 days so cohort and time-series charts look meaningful.

### 5. Pages

**Dashboard (`/`)**
- 8 KPI cards in a responsive grid: Total Revenue, Trial Payments, Upsell Revenue, First Subscription Revenue, Renewal Revenue, Trial→Upsell CR %, Trial→First Subscription CR %, Average LTV per User.
- Charts (Recharts):
  - Revenue by day — area/line chart
  - Revenue by transaction type — bar chart
  - Funnel comparison by revenue — grouped bar chart across the 3 funnels
  - Trial → Upsell → First Subscription — funnel chart (stepped bars with conversion % labels)

**Transactions (`/transactions`)**
- Full transaction table with columns from the sheet schema.
- Toolbar: search by email, filters for transaction_type, funnel, and status (multi-select dropdowns), clear-filters button.
- Sortable headers for `event_time` and `amount_usd`.
- Status + type rendered as colored badges. Pagination for long lists.

**Users (`/users`)**
- Aggregated table grouped by `user_id` / email with: email, first_trial_date, total_revenue, has_upsell, has_first_subscription, renewal_count, user_ltv, funnel.
- Search by email, filter by funnel, sort by total_revenue / user_ltv / renewal_count.
- Boolean columns shown as check/× icons.

**Cohorts (`/cohorts`)**
- Cohort table grouped by trial date (daily cohorts) with: cohort_date, trial_users, upsell_users, first_subscription_users, renewal_users, trial_to_upsell_cr, trial_to_first_subscription_cr, revenue_d0, revenue_d7, revenue_d14, revenue_d30, ltv_d7, ltv_d14, ltv_d30.
- Conversion-rate cells use a heatmap-style background tint to make patterns pop.
- Sticky first column for cohort_date on horizontal scroll.

### 6. Out of scope (per your request)

- No authentication, no Stripe/Primer, no real Google Sheets call yet. The service module is the seam where the real Sheets fetch will plug in later.

---

After approval I'll implement the design tokens, sidebar shell, mock data + service layer, then build the four pages in order: Dashboard → Transactions → Users → Cohorts.