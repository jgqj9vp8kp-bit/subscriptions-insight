// The global filter bar of the Payment System Health page: window preset (with
// the compare period the server answered), the registry filters (processor,
// merchant account, descriptor — only when meta.psp_global_visible), funnel,
// issuer country, card network, payment method, CIT / MIT and transaction type.
// Option lists come from the options action (whole tenant history); the values
// the selects hold are the opaque keys the server accepts, the texts are the
// server's labels — a raw MID or descriptor never reaches this component.

import { RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { OptionsResponse, PaymentHealthError } from "@/services/paymentHealthDataSource";
import type { DateWindow, DimensionValue } from "../../../supabase/functions/_shared/clickhouse/paymentHealthContract";
import { ALL, RANGE_PRESETS, hasActiveFilters, type PaymentHealthUiState, type RangePreset } from "./pageState";

interface FilterSelectProps {
  id: string;
  label: string;
  value: string;
  allLabel: string;
  options: DimensionValue[];
  onChange: (value: string) => void;
  width?: string;
  disabled?: boolean;
}

function FilterSelect({ id, label, value, allLabel, options, onChange, width = "w-[150px]", disabled }: FilterSelectProps) {
  // A persisted value the options no longer list stays selectable, so the
  // trigger always shows what the request really filters on.
  const known = options.some((option) => option.key === value);
  return (
    <div className="flex flex-col gap-1" data-testid={`filter-${id}`}>
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger className={`h-9 ${width}`} aria-label={label}><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>{allLabel}</SelectItem>
          {!known && value !== ALL && <SelectItem value={value}>{value}</SelectItem>}
          {options.map((option) => (
            <SelectItem key={option.key} value={option.key}>{option.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

const INITIATION_FALLBACK: DimensionValue[] = [
  { key: "cit", label: "CIT (customer-initiated)" },
  { key: "mit", label: "MIT (merchant-initiated)" },
  { key: "unknown", label: "Unknown" },
];

export interface PaymentHealthFilterBarProps {
  state: PaymentHealthUiState;
  onChange: (patch: Partial<PaymentHealthUiState>) => void;
  onReset: () => void;
  options: OptionsResponse["options"] | null;
  optionsLoading: boolean;
  /** The options action failed (an access denial is shown by the tabs, not here): the lists stay empty until a retry succeeds. */
  optionsError: PaymentHealthError | null;
  onRetryOptions: () => void;
  /** meta.psp_global_visible of the options response (false until it arrives). */
  pspVisible: boolean;
  /** The window pair of the active tab's response, for the compare caption. */
  range: DateWindow | null;
  compare: DateWindow | null;
  /** customRangeProblem(state): the typed window is not sent while this is set. */
  rangeProblem: string | null;
}

export function PaymentHealthFilterBar({ state, onChange, onReset, options, optionsLoading, optionsError, onRetryOptions, pspVisible, range, compare, rangeProblem }: PaymentHealthFilterBarProps) {
  const processors = options?.processor ?? [];
  // The account and descriptor lists narrow to the selected processor: a MID of
  // another PSP combined with a processor filter would always answer nothing.
  const merchantAccounts = (options?.merchant_account ?? []).filter((account) => state.processor === ALL || account.processor === state.processor);
  const descriptors = (options?.descriptor ?? []).filter((descriptor) => state.processor === ALL || descriptor.processor === state.processor);
  const initiation = options?.initiation?.length ? options.initiation : INITIATION_FALLBACK;

  return (
    <Card className="p-4 shadow-card" data-testid="payment-health-filters">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1" data-testid="filter-range">
          <Label className="text-xs text-muted-foreground">Period</Label>
          <Select value={state.rangePreset} onValueChange={(value) => onChange({ rangePreset: value as RangePreset })}>
            <SelectTrigger className="h-9 w-[150px]" aria-label="Period"><SelectValue /></SelectTrigger>
            <SelectContent>
              {RANGE_PRESETS.map((preset) => (
                <SelectItem key={preset.key} value={preset.key}>{preset.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {state.rangePreset === "custom" && (
          <>
            <div className="flex flex-col gap-1">
              <Label htmlFor="ph-date-from" className="text-xs text-muted-foreground">From</Label>
              <Input id="ph-date-from" type="date" value={state.dateFrom} onChange={(event) => onChange({ dateFrom: event.target.value })} className="h-9 w-[150px]" />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="ph-date-to" className="text-xs text-muted-foreground">To</Label>
              <Input id="ph-date-to" type="date" value={state.dateTo} onChange={(event) => onChange({ dateTo: event.target.value })} className="h-9 w-[150px]" />
            </div>
          </>
        )}
        {pspVisible && (
          <>
            <FilterSelect
              id="processor"
              label="Processor (PSP)"
              value={state.processor}
              allLabel="All processors"
              options={processors}
              onChange={(value) => onChange({ processor: value, merchantAccount: ALL, descriptor: ALL })}
              disabled={optionsLoading}
            />
            <FilterSelect
              id="merchant-account"
              label="Merchant account (MID)"
              value={state.merchantAccount}
              allLabel="All accounts"
              options={merchantAccounts}
              onChange={(value) => onChange({ merchantAccount: value })}
              width="w-[190px]"
              disabled={optionsLoading}
            />
            <FilterSelect
              id="descriptor"
              label="Statement descriptor"
              value={state.descriptor}
              allLabel="All descriptors"
              options={descriptors}
              onChange={(value) => onChange({ descriptor: value })}
              width="w-[190px]"
              disabled={optionsLoading}
            />
          </>
        )}
        <FilterSelect id="funnel" label="Funnel (anchor)" value={state.funnel} allLabel="All funnels" options={options?.funnel ?? []} onChange={(value) => onChange({ funnel: value })} width="w-[180px]" disabled={optionsLoading} />
        <FilterSelect id="country" label="Issuer country (BIN)" value={state.country} allLabel="All countries" options={options?.country ?? []} onChange={(value) => onChange({ country: value })} width="w-[160px]" disabled={optionsLoading} />
        <FilterSelect id="card-network" label="Card network" value={state.cardNetwork} allLabel="All networks" options={options?.card_network ?? []} onChange={(value) => onChange({ cardNetwork: value })} width="w-[140px]" disabled={optionsLoading} />
        <FilterSelect id="payment-method" label="Payment method" value={state.paymentMethod} allLabel="All methods" options={options?.payment_method ?? []} onChange={(value) => onChange({ paymentMethod: value })} width="w-[150px]" disabled={optionsLoading} />
        <FilterSelect id="initiation" label="CIT / MIT" value={state.initiation} allLabel="All" options={initiation} onChange={(value) => onChange({ initiation: value })} width="w-[130px]" />
        <FilterSelect id="transaction-type" label="Stage / type" value={state.transactionType} allLabel="All types" options={options?.transaction_type ?? []} onChange={(value) => onChange({ transactionType: value })} width="w-[160px]" disabled={optionsLoading} />
        {hasActiveFilters(state) && (
          <Button type="button" variant="ghost" size="sm" onClick={onReset} className="h-9">
            <X className="mr-1 h-4 w-4" /> Clear
          </Button>
        )}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground" data-testid="compare-caption">
        {range && compare ? (
          <span>
            Period <span className="font-mono text-foreground">{range.from} – {range.to}</span> ({range.days} d), compared with the previous{" "}
            <span className="font-mono">{compare.from} – {compare.to}</span>
          </span>
        ) : (
          <span>Compared with the previous period of the same length.</span>
        )}
        {optionsLoading && <span>Loading filter options…</span>}
        {optionsError && optionsError.kind !== "access" && (
          <span className="flex flex-wrap items-center gap-2 text-warning" role="status" data-testid="options-error">
            Filter options could not be loaded ({optionsError.message}).
            <Button type="button" variant="outline" size="sm" onClick={onRetryOptions} className="h-6 px-2 text-xs">
              <RefreshCw className="h-3 w-3" /> Retry
            </Button>
          </span>
        )}
        {rangeProblem && (
          <span className="text-warning" role="status" data-testid="range-problem">
            {rangeProblem} The window is not sent until it is fixed.
          </span>
        )}
      </div>
    </Card>
  );
}
