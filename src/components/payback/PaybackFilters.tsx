// Payback page filters (spec 2026-10-24 §4): Product chips (the Cohorts
// product map, full scope only), the funnel multi-select and one period —
// 30 / 90 / 180 days or whole custom months. Presentational: the page keeps
// every value in the URL.
import { FunnelMultiSelect, type FunnelMultiSelectOption } from "@/components/forecasting/FunnelMultiSelect";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { PAYBACK_COPY } from "@/components/payback/paybackCopy";
import { PAYBACK_PERIODS, type PaybackPeriod, type PaybackPeriodProblem } from "@/components/payback/paybackState";
import { productKey, type CohortProductOption } from "@/services/cohortProductFilter";
import { cn } from "@/lib/utils";

const COPY = PAYBACK_COPY.filters;

export interface PaybackFiltersProps {
  /** null hides the product row (not available for this viewer, or failed). */
  products: CohortProductOption[] | null;
  selectedProducts: readonly string[];
  onToggleProduct: (key: string) => void;
  onClearProducts: () => void;
  funnelOptions: FunnelMultiSelectOption[];
  selectedFunnels: ReadonlySet<string>;
  onToggleFunnel: (path: string) => void;
  onSelectAllFunnels: () => void;
  onClearFunnels: () => void;
  period: PaybackPeriod;
  fromMonth: string;
  toMonth: string;
  /** The current month (YYYY-MM): custom months cannot go past it. */
  maxMonth: string;
  problem: PaybackPeriodProblem | null;
  onPeriod: (period: PaybackPeriod) => void;
  onCustomMonths: (fromMonth: string, toMonth: string) => void;
}

export function PaybackFilters(props: PaybackFiltersProps) {
  const {
    products, selectedProducts, onToggleProduct, onClearProducts,
    funnelOptions, selectedFunnels, onToggleFunnel, onSelectAllFunnels, onClearFunnels,
    period, fromMonth, toMonth, maxMonth, problem, onPeriod, onCustomMonths,
  } = props;
  const selectedProductSet = new Set(selectedProducts);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2" data-testid="payback-filters">
      {products && products.length > 0 && (
        <div role="group" aria-label={COPY.product} className="flex min-w-0 flex-wrap items-center gap-1">
          <span className="mr-1 text-xs text-muted-foreground">{COPY.product}</span>
          {[
            { key: null as string | null, label: COPY.allProducts, title: undefined as string | undefined, pressed: selectedProducts.length === 0 },
            ...products.map((product) => ({
              key: productKey(product),
              label: product.label,
              title: COPY.productTitle(new Set(product.campaign_paths).size),
              pressed: selectedProductSet.has(productKey(product)),
            })),
          ].map((chip) => (
            <button
              key={chip.key ?? "__all__"}
              type="button"
              aria-pressed={chip.pressed}
              title={chip.title}
              onClick={() => (chip.key === null ? onClearProducts() : onToggleProduct(chip.key))}
              className={cn(
                "inline-flex h-7 max-w-[160px] items-center rounded-full border px-2.5 text-xs transition-colors hover:bg-muted/60",
                chip.pressed ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground",
              )}
            >
              <span className="truncate">{chip.label}</span>
            </button>
          ))}
        </div>
      )}

      <FunnelMultiSelect
        label={COPY.funnels}
        options={funnelOptions}
        selected={selectedFunnels}
        onToggle={onToggleFunnel}
        onSelectAll={onSelectAllFunnels}
        onClear={onClearFunnels}
        triggerClassName="h-8 max-w-[220px] text-xs"
      />

      <div className="flex flex-wrap items-center gap-2">
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={period}
          aria-label={COPY.period}
          onValueChange={(value) => {
            if (value) onPeriod(value as PaybackPeriod);
          }}
        >
          {PAYBACK_PERIODS.map((value) => (
            <ToggleGroupItem key={value} value={value} className="h-8 px-2.5 text-xs">
              {COPY.periods[value]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        {period === "custom" && (
          <div className="flex items-center gap-1.5 text-xs">
            <label className="flex items-center gap-1">
              <span className="text-muted-foreground">{COPY.from}</span>
              <Input
                type="month"
                value={fromMonth}
                max={maxMonth}
                aria-label={COPY.from}
                className="h-8 w-[136px] text-xs"
                onChange={(event) => event.target.value && onCustomMonths(event.target.value, toMonth)}
              />
            </label>
            <label className="flex items-center gap-1">
              <span className="text-muted-foreground">{COPY.to}</span>
              <Input
                type="month"
                value={toMonth}
                max={maxMonth}
                aria-label={COPY.to}
                className="h-8 w-[136px] text-xs"
                onChange={(event) => event.target.value && onCustomMonths(fromMonth, event.target.value)}
              />
            </label>
          </div>
        )}
        {problem && <span className="text-xs text-destructive" role="status">{COPY.problems[problem]}</span>}
      </div>
    </div>
  );
}
