// The breakdown dimension picker shared by the declines and refunds tabs. The
// list is the contract's dimensions; the three PSP ones appear only when the
// server said the PSP dimensions are visible (a request naming one without the
// key is refused, so the option is not offered at all).

import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DIMENSION_LABELS, type PaymentHealthDimension } from "../../../supabase/functions/_shared/clickhouse/paymentHealthContract";
import { dimensionOptions } from "./model";

export interface DimensionSelectProps {
  /** The dimension the response was computed for (the server default when the state is ""). */
  value: PaymentHealthDimension;
  onChange: (value: PaymentHealthDimension) => void;
  pspVisible: boolean;
}

export function DimensionSelect({ value, onChange, pspVisible }: DimensionSelectProps) {
  return (
    <div className="flex items-center gap-2">
      <Label className="text-xs text-muted-foreground">Break down by</Label>
      <Select value={value} onValueChange={(next) => onChange(next as PaymentHealthDimension)}>
        <SelectTrigger className="h-8 w-[200px] text-xs" aria-label="Break down by"><SelectValue /></SelectTrigger>
        <SelectContent>
          {dimensionOptions(pspVisible).map((dimension) => (
            <SelectItem key={dimension} value={dimension}>{DIMENSION_LABELS[dimension]}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
