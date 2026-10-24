// Every word the Payback page shows (spec 2026-10-24 §4: one constants file,
// plain English, sentence case, no codes or field paths). Numbers are formatted
// by paybackFormat.ts; the definitions behind them are src/services/ltvPayback.ts.
import type { NoSpendReason, PaybackMonthIndex, PaybackSource, PaybackStatus } from "@/services/ltvPayback";
import type { PaybackPeriod, PaybackPeriodProblem, PaybackShow } from "@/components/payback/paybackState";
import { approxPrefix, fmtInt, fmtRoas, fmtShare } from "@/components/payback/paybackFormat";

const plural = (count: number, one: string, many = `${one}s`) => `${fmtInt(count)} ${count === 1 ? one : many}`;

export const PAYBACK_COPY = {
  /** Accessible names of the "i" buttons. */
  aria: {
    about: (label: string) => `About ${label.toLowerCase()}`,
    paymentsDate: "About the payments date",
    facebookDate: "About the Facebook date",
    agencyFee: "About the agency fee",
    unlinked: "About spend not linked to a funnel",
    excluded: "About left-out funnels",
    breakEven: "About break-even cost per trial",
    trend: "About the trend by trial month",
  },
  page: {
    title: "Payback by funnel",
    description: "How much of each funnel's Facebook cost its trials pay back within 1, 2 and 3 months.",
    oldPlanner: "Old planner",
    oldPlannerTitle: "The previous forecasting planner (Plan, Compare, Project). It stays here for a few weeks.",
    legacyTitle: "Old planner",
    legacyDescription: "The previous forecasting tools. Payback by funnel replaces them; this page stays for a few weeks.",
    backToPayback: "Back to Payback",
  },
  chips: {
    paymentsThrough: (date: string) => `Payments through ${date}`,
    paymentsInfo: "The newest imported payment. Trials too young for a checkpoint are partly projected there.",
    facebookThrough: (date: string) => `Facebook through ${date}`,
    facebookNone: "No Facebook spend loaded",
    facebookInfo: "The last day with Facebook spend in the warehouse. Trials after it cannot be paired with their cost.",
    agencyFee: "Agency fee 4%",
    agencyFeeInfo: "Adds a 4% agency fee on top of the Facebook spend. Switch it off to compare with the bare ad spend.",
  },
  filters: {
    product: "Product",
    allProducts: "All",
    productTitle: (paths: number) => `${plural(paths, "campaign path")}`,
    funnels: "Funnels",
    period: "Period",
    periods: { "30d": "30 days", "90d": "90 days", "180d": "180 days", custom: "Custom" } satisfies Record<PaybackPeriod, string>,
    from: "From",
    to: "To",
    problems: {
      start_after_end: "The start month is after the end month.",
      too_long: "Pick at most 12 months.",
      in_future: "This period has not started yet.",
    } satisfies Record<PaybackPeriodProblem, string>,
    show: "Show",
    shows: { back: "% of cost back", ltv: "Revenue per trial" } satisfies Record<PaybackShow, string>,
    export: "Export",
    exportCsv: "Export CSV",
    exportXlsx: "Export XLSX",
    funnelHint: (trials: number) => `${fmtInt(trials)} trials`,
  },
  banner: {
    spendThrough: (date: string) => `Facebook spend is loaded only through ${date}; newer funnels cannot be evaluated yet.`,
    noSpend: "No Facebook spend is loaded yet, so no funnel can be evaluated.",
    spendFailed: "Facebook spend could not be loaded, so no funnel can be evaluated.",
    retry: "Try again",
    rangeCapped: "The period was cut to the last 13 months.",
    trialsRefreshing: (date: string) => `Cohort data is refreshing, so trials after ${date} are not counted yet.`,
  },
  states: {
    loading: "Loading payments…",
    loadingSpend: "Loading Facebook spend…",
    snapshotNotReady: "Cohort data is still being prepared. Try again in a few minutes.",
    failed: "Payments could not be loaded.",
    noPayments: "No payments are imported for this period yet.",
    noTrials: "No trials in this period.",
    noFunnelPicked: "No funnel is picked. Choose funnels above.",
  },
  kpis: {
    spend: "Spend",
    spendInfo: "Facebook spend linked to these funnels for the trials in the period, plus the agency fee when it is on. Spend not linked to any funnel is not included.",
    spendWithFee: "incl. 4% agency fee",
    spendNoFee: "no agency fee",
    trials: "Trials",
    trialsInfo: "People whose first paid trial falls in the period and up to the last day of Facebook spend.",
    trialsInfoNotEvaluated: "People whose first paid trial falls in the period. Their Facebook spend is not known yet, so they are not evaluated.",
    trialsAfter: (count: number) => `+${fmtInt(count)} newer, not evaluated`,
    trialsNoneEvaluated: (date: string) => `None evaluated yet: all after ${date}`,
    cpt: "Cost per trial",
    cptInfo: "Spend divided by trials. It is higher than on the Cohorts page, which spreads spend differently.",
    back: "Back by month 3",
    backInfo: "Revenue these trials bring within 90 days of their trial, compared with the spend. Marked ≈ where it is partly projected. Below it: the money already received.",
    backHint: (received: string, spend: string) => `${received} received so far of ${spend}`,
    payback: "Payback",
    paybackInfo: "The first month in which the trials' revenue covers the spend.",
  },
  table: {
    title: "Funnels",
    funnel: "Funnel",
    trials: "Trials",
    spend: "Spend",
    cpt: "Cost per trial",
    month: (month: PaybackMonthIndex) => `Month ${month}`,
    payback: "Payback",
    trialsInfo: "First paid trials in the period, up to the last day of Facebook spend. A funnel whose trials all came after that day shows those trials instead, marked No spend data.",
    spendInfo: "The funnel's Facebook spend for those trials, plus the agency fee when it is on.",
    cptInfo: "Spend divided by trials.",
    monthInfo: (month: PaybackMonthIndex, show: PaybackShow) => {
      const days = month * 30;
      const base = show === "ltv"
        ? `Revenue per trial within ${days} days of the trial: the most a trial may cost to pay back by month ${month}.`
        : `Revenue within ${days} days of the trial as a share of the spend. 100% or more means the funnel paid back.`;
      return month === 1 ? `${base} With a 7-day trial on a monthly plan, month 1 holds no renewal yet.` : base;
    },
    paybackInfo: "The first month in which revenue covers the spend.",
    total: "Total",
    totalFunnels: (count: number) => plural(count, "funnel"),
    totalExcluded: (funnels: number, trials: number) => `Leaves out ${plural(funnels, "funnel")} without spend data${trials > 0 ? ` (${plural(trials, "trial")})` : ""}.`,
    smallFunnels: "Small funnels",
    smallHint: (count: number) => `${fmtInt(count)} under 50 trials each`,
    expand: (label: string) => `Show ${label}`,
    collapse: (label: string) => `Hide ${label}`,
    openDetails: (label: string) => `Open details for ${label}`,
    sortBy: (label: string) => `Sort by ${label}`,
    legend: "Green: paid back · Amber: 80–99% back · ≈ partly projected · Grey: rough estimate · Click a funnel for details",
    unlinked: (amount: string) => `+${amount} Facebook spend not linked to a funnel`,
    unlinkedInfo: "Spend on campaigns that could not be matched to a funnel. It is not in any row or in the total.",
    afterSpend: (count: number, date: string) => `${plural(count, "newer trial")} of these funnels, after ${date} (the last day of Facebook spend), are not counted yet.`,
    allAfterSpend: (count: number, date: string) => `All ${plural(count, "trial")} of these funnels are after ${date} (the last day of Facebook spend), so none can be evaluated yet.`,
  },
  export: {
    fileName: "payback-by-funnel",
    sheetName: "Payback",
    funnel: "Funnel",
    path: "Campaign path",
    trials: "Trials",
    trialsAfter: "Newer trials not evaluated",
    // The fee switch changes spend, cost per trial and every % column: the file says which.
    spend: (fee: boolean) => (fee ? "Spend incl. 4% agency fee" : "Spend, no agency fee"),
    cpt: (fee: boolean) => (fee ? "Cost per trial incl. 4% agency fee" : "Cost per trial, no agency fee"),
    revenuePerTrial: (month: PaybackMonthIndex) => `Month ${month} revenue per trial`,
    back: (month: PaybackMonthIndex) => `Month ${month} % of cost back`,
    projected: (month: PaybackMonthIndex) => `Month ${month} partly projected`,
    payback: "Payback",
    yes: "yes",
  },
  cell: {
    revenuePerTrial: (day: number, value: string) => `Revenue per trial by day ${day}: ${value}`,
    back: (value: string) => `${value} of the cost back`,
    breakEven: (value: string) => `Break-even cost per trial: ${value}`,
    observed: (day: number) => `Every trial is ${day} days old: fully observed.`,
    projected: (share: string, day: number, source: string) => `${share} of trials are ${day} days old; the rest is projected ${source}.`,
    pool: (trials: number) => `Projection based on ${plural(trials, "trial")}.`,
    rough: "Rough estimate: this funnel has too little history of its own.",
    noSpend: "No spend to compare with.",
  },
  sources: {
    funnel: "from this funnel's own older trials",
    product: "from other funnels of the same product",
    all: "from all funnels",
  } satisfies Record<PaybackSource, string>,
  status: {
    month: (month: PaybackMonthIndex, approx: boolean) => `${approxPrefix(approx)}Month ${month}`,
    notWithin: (roas: number | null, approx: boolean) => `${approxPrefix(approx)}Not within 3 months${roas === null ? "" : ` · ${fmtRoas(roas)} back`}`,
    notWithinShort: "Over 3 months",
    tooEarly: "Too early",
    tooEarlyInfo: (share: number | null) => share === null
      ? "None of these trials are 30 days old yet."
      : `Only ${fmtShare(share)} of these trials are 30 days old. Check back later.`,
    lowVolume: "Low volume",
    lowVolumeInfo: "Fewer than 50 trials: too few to judge.",
    noSpend: "No spend data",
    monthInfo: (month: PaybackMonthIndex) => `Revenue covered the spend within ${month * 30} days of the trial.`,
    notWithinInfo: "Revenue did not cover the spend within 90 days of the trial.",
  },
  reasons: {
    spend_unavailable: "Facebook spend could not be loaded.",
    no_spend_loaded: "No Facebook spend is loaded yet.",
    after_spend_through: "These trials started after the last day of loaded Facebook spend.",
    known_gap: "Facebook spend has a recorded gap in this period.",
    spend_window_mismatch: "Spend was read for a different period. Reload the page.",
    zero_spend: "No Facebook spend is linked to this funnel for these trials.",
    mixed_currency: "This funnel's ad accounts use more than one currency.",
    non_usd_currency: "This funnel's ad accounts are not in US dollars.",
  } satisfies Record<NoSpendReason, string>,
  sheet: {
    close: "Close",
    trials: "Trials",
    spend: "Spend",
    cpt: "Cost per trial",
    paybackDay: "Payback day",
    paybackDayValue: (day: number) => `≈ day ${day}`,
    paybackDayNone: "Not within 90 days",
    paybackDayInfo: "The day the revenue per trial reaches the cost per trial, read off the curve between checkpoints.",
    chartTitle: "Revenue per trial by day",
    chartObserved: "Revenue per trial",
    chartProjected: "Partly projected",
    chartCpt: "Cost per trial",
    chartWhatIf: "What-if cost",
    chartLegend: "Chart key",
    chartDay: (day: number) => `Day ${day}`,
    breakEven: "Break-even cost per trial",
    breakEvenInfo: "The most a trial may cost for the funnel to pay back by that month.",
    monthsTitle: "By month",
    monthsHeaders: ["", "Revenue per trial", "% of cost back", "Trials old enough"] as const,
    whatIf: "What if a trial cost",
    whatIfBadge: "what-if, not saved",
    whatIfHint: "Type a cost per trial to see when the funnel would pay back. Nothing is saved.",
    whatIfLabel: "What-if cost per trial in US dollars",
    trendTitle: "By trial month",
    trendInfo: "The same funnel, one row per month of trials. Each month is paired with its own Facebook spend.",
    trendHeaders: ["Trial month", "Trials", "Cost per trial", "Month 1", "Month 2", "Month 3", "Payback"] as const,
    trendLoading: "Loading…",
    trendNoTrials: "No trials",
    noSpendTitle: "Why there is no verdict",
    sourcesTitle: "Where these numbers come from",
    spendLine: (raw: string, total: string, fee: boolean) => (fee ? `Facebook spend ${raw}, plus the 4% agency fee: ${total}.` : `Facebook spend ${raw}, no agency fee.`),
    spendUnknown: "Facebook spend is not known for these trials.",
    unlinkedLine: (amount: string) => `Facebook spend not linked to any funnel: ${amount}. It is not included.`,
    gapsLine: (days: number) => (days === 0 ? "No recorded Facebook gaps in the period." : `Recorded Facebook gaps in the period: ${plural(days, "day")}.`),
    currencyLine: "All amounts are in US dollars.",
    trialsLine: (from: string, to: string) => `Trials from ${from} to ${to} are paired with spend.`,
    afterLine: (count: number, date: string) => `${plural(count, "trial")} after ${date} are not evaluated: there is no Facebook spend for them yet.`,
    revenueLine: "Revenue is everything these users paid (trial, subscription, renewals, upsells and tokens) minus refunds, before processor fees.",
    paymentsLine: (date: string) => `Payments are imported through ${date}.`,
    monthLine: (month: PaybackMonthIndex, share: string) => `Month ${month}: ${share} of trials are old enough.`,
    sourceLine: (source: string, pool: number | null) => ` The rest is projected ${source}${pool === null ? "" : ` (${plural(pool, "trial")})`}.`,
    roughLine: " Rough estimate.",
  },
} as const;

/** The verdict as one line (badge text, export). */
export function paybackStatusLabel(status: PaybackStatus): string {
  switch (status.kind) {
    case "month":
      return PAYBACK_COPY.status.month(status.month, status.approx);
    case "not_within":
      return PAYBACK_COPY.status.notWithin(status.roas, status.approx);
    case "too_early":
      return PAYBACK_COPY.status.tooEarly;
    case "low_volume":
      return PAYBACK_COPY.status.lowVolume;
    case "no_spend_data":
      return PAYBACK_COPY.status.noSpend;
  }
}

/** The verdict's explanation (badge tooltip). */
export function paybackStatusInfo(status: PaybackStatus): string {
  switch (status.kind) {
    case "month":
      return PAYBACK_COPY.status.monthInfo(status.month);
    case "not_within":
      return PAYBACK_COPY.status.notWithinInfo;
    case "too_early":
      return PAYBACK_COPY.status.tooEarlyInfo(status.observedShare);
    case "low_volume":
      return PAYBACK_COPY.status.lowVolumeInfo;
    case "no_spend_data":
      return status.reasons.map((reason) => PAYBACK_COPY.reasons[reason]).join(" ");
  }
}
