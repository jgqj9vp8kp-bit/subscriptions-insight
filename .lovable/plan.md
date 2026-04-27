## Goal

Make the Cohorts table easier to scan **without touching any calculation, filter, column, or data flow**. Pure presentation pass on `src/pages/Cohorts.tsx` (and a tiny CSS-only tweak to `src/components/ui/table.tsx` so vertical borders work).

## What changes (visual only)

### 1. Sticky header row
- Add `sticky top-0 z-20` + solid `bg-card` (and bottom border) to every `<TableHead>` in the existing `<TableHeader>`.
- The wrapping `<div class="overflow-x-auto">` becomes the scroll container with a fixed `max-h` (e.g. `max-h-[calc(100vh-260px)]`) and `overflow-y-auto`, so the header stays visible while scrolling rows vertically. Horizontal scroll keeps working unchanged.
- The existing sticky first column ("Cohort") gets bumped to `z-30` in the header so the corner cell sits above both the sticky row and sticky column.

### 2. Sticky-column polish (already exists, just hardened)
- Keep "Cohort" column sticky `left-0`. Add a subtle right shadow (`shadow-[1px_0_0_0_hsl(var(--border))]`) so it visually separates from the scrolling area.
- Match background to row state: `bg-card` on normal rows, `bg-muted` on the Total row, `bg-muted/30` on hovered/zebra rows — so the sticky cell never looks like a floating chip.

### 3. Column grouping via header coloring + section dividers
Group headers are already implicit. Add a thin left border on the first column of each logical section so the eye can find groups without changing column order:

```text
| Cohort | Date | Path | Funnel ║ Trial Upsell FirstSub ║ →UpCR →SubCR R2CR R3CR ║ R2 R3 TotalRen ║ Refund Amt% ║ Gross Net GLTV NLTV ║ D0..D67 RevTotal ║ LTV D7..Total |
```
Implemented by adding `border-l border-border/60` to the `<TableHead>` and matching `<TableCell>` at each section start (Trial, →Upsell CR, Renewal 2, Refund Users, Gross Revenue, Rev D0, LTV D7). No new columns, no reordering.

### 4. Density + alignment
- Tighten cell padding: override default `p-4` with `py-2 px-3` on `TableCell` and `h-10 px-3` on `TableHead` for this table only (via className). Numbers stay `tabular-nums text-right`, labels stay left.
- Add `whitespace-nowrap` to all numeric cells to prevent wrapping at narrow viewports.
- Min column widths via inline `style={{ minWidth: … }}` on heads only (e.g. 84px for short numerics, 110px for currency, 140px for "Cohort"), so columns don't collapse and stay aligned with the body.

### 5. Zebra rows + hover
- Apply `even:bg-muted/20 hover:bg-muted/40` to data `<TableRow>`s. Total row keeps its existing `bg-muted/50 font-semibold` look and gains `sticky bottom-0 z-10` so totals are always visible at the bottom of the scroll viewport.

### 6. Heatmap legibility (no logic change)
- The existing `heatStyle` stays as-is. Only adjust the text-color threshold from `> 0.55` to `> 0.5` and add `font-variant-numeric: tabular-nums` so the 4 CR columns read as a clean visual gradient. Values, max calcs, and color HSL untouched.

### 7. Filter bar polish (no filter changes)
- Wrap the existing filter row in a `flex flex-wrap gap-2 pb-3 mb-3 border-b border-border` block so it visually separates from the table. Same controls, same order, same options.

## Tiny shared change

`src/components/ui/table.tsx` — the `Table` wrapper currently forces `overflow-auto` on its own outer `<div>`. To let our page-level scroll container control sticky behavior, change that wrapper from `relative w-full overflow-auto` to `relative w-full`. This is the only shared-component edit and is purely structural — no API change, no visual regression for other tables (their parents already provide overflow when needed; if any don't, we add `overflow-x-auto` at the call site in a follow-up). I'll grep for other usages and confirm before applying; if any other table relies on the inner overflow, I'll instead introduce an opt-out prop and leave default behavior intact.

## What is NOT changing

- Column set, column order, column labels.
- Any filter, sort, or `useMemo` calculation.
- `computeCohorts`, `formatCurrency`, `formatPct`, `useTransactions`, `heatStyle` math.
- Data store, types, mock data, imports.
- Routing, layout shell, sidebar.

## Files touched

- `src/pages/Cohorts.tsx` — className/style-only edits on the existing JSX (header sticky, section borders, density, zebra, sticky totals, filter-bar wrapper).
- `src/components/ui/table.tsx` — remove inner `overflow-auto` from the root `<div>` wrapper (one-line change), only if grep confirms no other table depends on it; otherwise skipped and Cohorts uses an inner double-scroll that still works.

## Verification

After applying:
- Scroll the cohorts table horizontally → header row stays put, "Cohort" column stays put, totals row stays put.
- Resize to mobile width → table still scrolls horizontally, columns stay aligned, no wrapping in numeric cells.
- Numbers, percentages, and the heatmap render identical values to before.
