## Refactor cohort drill-down to inline rows

Replace the current nested-card breakdown in `src/pages/Cohorts.tsx` with child rows that share the parent table's column structure.

### Changes

**File:** `src/pages/Cohorts.tsx` — only the `{expanded && (...)}` block inside the cohorts map.

Remove:
- The card wrapper, title ("Plan breakdown by entry price"), subtitle, and nested `<table>`
- The single colSpan row that contained all of it

Add: one `<TableRow>` per `plan_breakdown` entry, rendered as a sibling of the cohort row, with a cell for every parent column (32 total) so alignment is preserved exactly.

### Child row styling

- Background: `bg-muted/10` (subtle tint vs. parent zebra)
- Hover: `bg-muted/20`
- Sticky first column ("Cohort"): shows `formatCurrency(plan.price)` only — no "Price" label, indented with `pl-8`, smaller `text-xs`, `text-muted-foreground`, `font-medium`, sticky shadow preserved
- All numeric cells: `text-xs text-muted-foreground tabular-nums`, compact `py-1.5 px-3`
- Reuse existing `SECTION_DIVIDER` to keep group separators aligned with parent
- No card, no border, no header, no title

### Column mapping (parent → child)

PlanBreakdownRow has fewer fields than CohortRow, so columns without source data render an em-dash (`—`, dimmed):

| Parent column | Child value |
|---|---|
| Cohort | `formatCurrency(plan.price)` |
| Cohort date / Campaign path / Funnel | — |
| Trial / Upsell / First Sub | plan.trial_users / upsell_users / first_subscription_users |
| Upsell CR / Sub CR / Sub→R2 CR / R2→R3 CR | plan.* |
| Renewal 2 / Renewal 3 / Total Renewals | plan.renewal_2_users / renewal_3_users / renewal_users |
| Refund Users / Amount Refunded / Refund Rate | plan.refund_users / amount_refunded / refund_rate |
| Gross Revenue / Net Revenue / Gross LTV / Net LTV | plan.gross_revenue / net_revenue / — / plan.net_ltv |
| Rev D0..D67 / Rev Total | — (not in PlanBreakdownRow) |
| LTV D7..LTV Total | — (not in PlanBreakdownRow) |

### Empty state

If `c.plan_breakdown.length === 0` while expanded, render a single child row whose sticky cell shows "No price breakdown" (italic, muted) and remaining cells are empty — keeps alignment without a banner.

### What stays untouched

- All calculations, `computeCohorts`, totals, filters, sorting
- Parent table structure, columns, headers, sticky behavior
- `heatStyle`, zebra striping, footer Total row
- Data model and types
