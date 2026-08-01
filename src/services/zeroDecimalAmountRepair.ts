// Repair of stored amounts for zero-decimal currencies (JPY defect).
//
// The Palmer importer used to divide every integer amount by 100, but ISO 4217
// exponent-0 currencies (JPY, KRW, ...) have no minor unit — ¥6,415 arrived as
// "6415" and was stored as 64.15. The importer is currency-aware now; this
// routine re-derives already-imported rows from raw_payload via the
// repair_transactions_zero_decimal_amounts RPC (security invoker, RLS-scoped,
// idempotent — a second run repairs 0 rows). The currency list is passed in
// from ZERO_DECIMAL_CURRENCIES so the registry lives in exactly one place.
import { supabase } from "@/services/supabaseClient";
import { ZERO_DECIMAL_CURRENCIES } from "@/services/fxRates";

export interface ZeroDecimalRepairSummary {
  repaired: number;
  currencies: string[];
  duration_ms: number;
}

export async function repairZeroDecimalAmounts(): Promise<ZeroDecimalRepairSummary> {
  if (!supabase) throw new Error("Supabase is not configured.");
  const startedAt = Date.now();
  const currencies = [...ZERO_DECIMAL_CURRENCIES].sort();
  const { data, error } = await supabase.rpc("repair_transactions_zero_decimal_amounts", {
    zero_decimal_currencies: currencies,
  });
  if (error) throw new Error(`Zero-decimal amount repair failed: ${error.message}`);
  return { repaired: Number(data ?? 0), currencies, duration_ms: Date.now() - startedAt };
}
