// The Payback KPI row (spec 2026-10-24 §4): the Total row in five numbers —
// spend, trials, cost per trial, the real money back by month 3 against what
// was spent, and the payback verdict. Each card explains itself (KpiCard info).
// The payback day stays in the drilldown (spec §1).
import { KpiCard } from "@/components/KpiCard";
import type { PaybackAggregateRow, PaybackStatus } from "@/services/ltvPayback";
import { PAYBACK_COPY, paybackStatusLabel } from "@/components/payback/paybackCopy";
import { approxPrefix, fmtDay, fmtInt, fmtMoney, fmtMoneyCents, fmtRoas } from "@/components/payback/paybackFormat";

const COPY = PAYBACK_COPY.kpis;

/** Short enough for a KPI value (the table badge says the full verdict). */
function verdictValue(status: PaybackStatus): string {
  if (status.kind === "not_within") return `${approxPrefix(status.approx)}${PAYBACK_COPY.status.notWithinShort}`;
  return paybackStatusLabel(status);
}

/** Trials after the last day of Facebook spend: "+N newer" next to evaluated
 * trials; when none is evaluated they ARE the trials shown, and the hint says so. */
function trialsHint(total: PaybackAggregateRow, spendThrough: string | null): string | undefined {
  if (!(total.trialsAfterSpendThrough > 0) || !spendThrough) return undefined;
  return total.evaluated ? COPY.trialsAfter(total.trialsAfterSpendThrough) : COPY.trialsNoneEvaluated(fmtDay(spendThrough));
}

export function PaybackKpis({ total, agencyFee, spendThrough }: { total: PaybackAggregateRow; agencyFee: boolean; spendThrough: string | null }) {
  const month3 = total.months[2];
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5" data-testid="payback-kpis">
      <KpiCard label={COPY.spend} value={fmtMoney(total.spend)} hint={total.spend === null ? undefined : agencyFee ? COPY.spendWithFee : COPY.spendNoFee} info={COPY.spendInfo} />
      <KpiCard
        label={COPY.trials}
        value={fmtInt(total.trials)}
        hint={trialsHint(total, spendThrough)}
        info={total.evaluated ? COPY.trialsInfo : COPY.trialsInfoNotEvaluated}
      />
      <KpiCard label={COPY.cpt} value={fmtMoneyCents(total.cpt)} info={COPY.cptInfo} />
      <KpiCard
        label={COPY.back}
        value={month3.roas === null ? fmtRoas(null) : `${approxPrefix(month3.approx)}${fmtRoas(month3.roas)}`}
        // The real money: what these trials have paid so far, never the projection.
        hint={month3.roas === null || total.spend === null ? undefined : COPY.backHint(fmtMoney(total.collected), fmtMoney(total.spend))}
        info={COPY.backInfo}
      />
      <KpiCard label={COPY.payback} value={verdictValue(total.status)} info={COPY.paybackInfo} />
    </div>
  );
}
