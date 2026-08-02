// Shared display formatters for forecasting surfaces (Plan, Compare, Project).
//
// Extracted from PlanMode (P4) — one definition of "how a forecast number
// renders", including the '—' convention for unavailable values (never a
// misleading zero).
import { formatCurrency } from "@/services/analytics";

export const fmtMoney = (value: number | null | undefined) => (value == null ? "—" : formatCurrency(value));
export const fmtInt = (value: number) => Math.round(value).toLocaleString("en-US");
export const fmtPctValue = (value: number | null | undefined, digits = 1) => (value == null ? "—" : `${(value * 100).toFixed(digits)}%`);
export const fmtRatio = (value: number | null | undefined) => (value == null ? "—" : value.toFixed(2));
