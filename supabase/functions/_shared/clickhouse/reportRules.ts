// Weekly report — the rule engine (R3).
//
// Turns a ReportSnapshot into findings and per-funnel statuses. This is the
// layer that decides what is worth saying; the model only phrases what comes
// out of here. Every finding carries the evidence path behind it and the
// sample it rests on, so "why does the report claim this" is always answerable
// without asking a model anything.
//
// Two disciplines run through all of it:
//   * A move is only "significant" when it clears an absolute floor, a relative
//     floor AND a minimum denominator. The weekly reports say "рано делать
//     выводы" constantly; the code has to earn the right to say otherwise.
//   * A status nobody can explain is a status nobody trusts, so every verdict
//     ships with the sentence that produced it.
//
// Pure module: no Deno APIs, no browser APIs, no clock.
import type {
  ReportFunnelRow,
  ReportFunnelStatus,
  ReportFunnelStatusVerdict,
  ReportMetric,
  ReportSnapshot,
} from "./reportContract.ts";
import { round2 } from "./financialPrimitives.ts";

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/**
 * The operator's own numbers, taken from the weekly reports rather than
 * invented: payment pass ≥ 60% ("за ориентир можем брать 60%"), Trial→Sub
 * ≥ 40%, support/refund under 10%, $5 gross per user from upsells, token CR
 * 8-10%, payback 1-2 months.
 */
export interface ReportThresholds {
  /** Trial → subscription conversion, percent. */
  trialToSubTarget: number;
  /** CPA ceiling in dollars. Per funnel in practice; this is the fallback. */
  cpaCeiling: number;
  /** Support-request rate, percent. */
  supportRateCeiling: number;
  /** Refund rate, percent. */
  refundRateCeiling: number;
  /** Upsell conversion, percent. */
  upsellCrTarget: number;
  /** Token purchase conversion, percent. */
  tokenCrTarget: number;
  /** Minimum trials before a conversion rate is allowed to drive a decision. */
  minTrialsForVerdict: number;
  /** Minimum trials before a period-over-period move is called significant. */
  minTrialsForSignificance: number;
  /** Relative move that counts as material. */
  minRelativeMove: number;
}

export const DEFAULT_THRESHOLDS: ReportThresholds = {
  trialToSubTarget: 40,
  cpaCeiling: 30,
  supportRateCeiling: 10,
  refundRateCeiling: 10,
  upsellCrTarget: 15,
  tokenCrTarget: 8,
  minTrialsForVerdict: 25,
  minTrialsForSignificance: 50,
  minRelativeMove: 0.05,
};

/**
 * Resolve thresholds most-specific-first: funnel → geo → subscription model →
 * project → global. The resolved set is frozen into the snapshot, so reopening
 * a July report scores it against July's ceilings rather than today's.
 */
export function resolveThresholds(
  global: ReportThresholds,
  overrides: Readonly<Record<string, Partial<ReportThresholds>>>,
  scope: { funnel?: string | null; geo?: string | null; billingPeriod?: string | null },
): ReportThresholds {
  const order = [
    scope.billingPeriod ? `model:${scope.billingPeriod}` : null,
    scope.geo ? `geo:${scope.geo}` : null,
    scope.funnel ? `funnel:${scope.funnel}` : null,
  ].filter((key): key is string => Boolean(key));

  let resolved = { ...global };
  for (const key of order) {
    const patch = overrides[key];
    if (patch) resolved = { ...resolved, ...patch };
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

export type FindingSeverity = "critical" | "high" | "medium" | "low" | "info";
export type FindingPolarity = "good" | "bad" | "neutral";

export type FindingKind =
  | "cpa_move" | "conversion_move" | "upsell_move" | "refund_rise" | "support_rise"
  | "scaling_success" | "degrading_while_scaling" | "cheap_but_weak" | "expensive_but_converting"
  | "new_funnel_start" | "funnel_went_quiet" | "insufficient_sample" | "data_quality";

export interface Finding {
  id: string;
  kind: FindingKind;
  severity: FindingSeverity;
  polarity: FindingPolarity;
  /** Where it happened: a funnel path, or null for a project-level finding. */
  scope: string | null;
  /** The sentence, already containing the rendered numbers. The model may
   * rephrase it but has nothing to compute. */
  claim: string;
  evidence: string[];
  sampleSize: number | null;
  /** Ranking weight; higher wins a place in "Главное за неделю". */
  score: number;
}

const SEVERITY_WEIGHT: Record<FindingSeverity, number> = {
  critical: 100, high: 60, medium: 30, low: 12, info: 4,
};

function metricValue(metrics: Record<string, ReportMetric>, key: string): number | null {
  return metrics[key]?.current.value ?? null;
}

function isSignificant(metric: ReportMetric | undefined): boolean {
  return Boolean(metric?.delta?.significant);
}

/**
 * Ranking weight.
 *
 * Severity sets the base; the share of the week's spend or revenue the finding
 * touches scales it, so a 30% CPA jump on a $20 test funnel never outranks a
 * 10% jump on the funnel carrying most of the budget; and a thin sample damps
 * it, because an eye-catching move on 12 trials is not news.
 */
export function scoreFinding(input: {
  severity: FindingSeverity;
  budgetShare: number;
  sampleSize: number | null;
  minSample: number;
}): number {
  const base = SEVERITY_WEIGHT[input.severity];
  const share = Math.max(0, Math.min(1, input.budgetShare));
  const confidence = input.sampleSize === null
    ? 0.5
    : Math.max(0.2, Math.min(1, input.sampleSize / input.minSample));
  return round2(base * (0.25 + 0.75 * share) * confidence);
}

// ---------------------------------------------------------------------------
// Funnel status
// ---------------------------------------------------------------------------

interface StatusInput {
  trials: number | null;
  matureTrials: number | null;
  cpa: number | null;
  trialToSubCr: number | null;
  supportRate: number | null;
  refundRate: number | null;
  cpaTrendImproving: boolean | null;
  thresholds: ReportThresholds;
}

/**
 * The decision table, in strict precedence order. First rule that fires wins,
 * so the ladder reads top-down and a funnel can never hold two verdicts.
 *
 * "Insufficient data" comes first on purpose: without a sample, every other
 * rule would be reading noise. That is the difference between this and a
 * dashboard that colours a cell red on n=3.
 */
export function classifyFunnel(input: StatusInput): ReportFunnelStatusVerdict {
  const t = input.thresholds;
  const trials = input.matureTrials ?? 0;

  const verdict = (status: ReportFunnelStatus, ruleId: string, because: string) =>
    ({ status, ruleId, because });

  if (trials < t.minTrialsForVerdict || input.trialToSubCr === null) {
    return verdict(
      "insufficient_data",
      "sample_gate",
      input.trialToSubCr === null
        ? "Конверсия ещё не измерима: триалы не закончились или не заполнена длительность триала."
        : `Зрелых триалов ${trials} при пороге ${t.minTrialsForVerdict} — для вывода мало.`,
    );
  }

  const cpaOverCeiling = input.cpa !== null && input.cpa > t.cpaCeiling;
  const cpaFarOver = input.cpa !== null && input.cpa > t.cpaCeiling * 1.5;
  const crFarUnder = input.trialToSubCr < t.trialToSubTarget * 0.6;
  const supportHigh = input.supportRate !== null && input.supportRate > t.supportRateCeiling * 2;
  const refundHigh = input.refundRate !== null && input.refundRate > t.refundRateCeiling * 2;

  if (supportHigh || refundHigh) {
    const which = supportHigh ? "обращений в support" : "рефандов";
    return verdict("pause", "quality_breach",
      `Доля ${which} вдвое выше цели — воронку стоит остановить, а не масштабировать.`);
  }
  if (cpaFarOver && crFarUnder) {
    return verdict("pause", "cpa_and_cr_breach",
      `CPA ${input.cpa} при потолке ${t.cpaCeiling} и конверсия ${input.trialToSubCr}% против цели ${t.trialToSubTarget}% — оба показателя далеко от нормы.`);
  }
  if (cpaOverCeiling && input.cpaTrendImproving === false) {
    return verdict("reduce_budget", "cpa_over_ceiling_no_trend",
      `CPA ${input.cpa} выше потолка ${t.cpaCeiling} и не улучшается — снижаем объём.`);
  }
  if (cpaOverCeiling || input.trialToSubCr < t.trialToSubTarget) {
    return verdict("needs_optimization", "one_side_off",
      cpaOverCeiling
        ? `Конверсия в норме, но CPA ${input.cpa} выше потолка ${t.cpaCeiling}.`
        : `CPA в норме, но конверсия ${input.trialToSubCr}% ниже цели ${t.trialToSubTarget}%.`);
  }

  const qualityOk =
    (input.supportRate === null || input.supportRate < t.supportRateCeiling) &&
    (input.refundRate === null || input.refundRate < t.refundRateCeiling);

  if (trials >= t.minTrialsForSignificance && qualityOk) {
    return verdict("scale", "all_green",
      `CPA ${input.cpa} в пределах ${t.cpaCeiling}, конверсия ${input.trialToSubCr}% выше цели ${t.trialToSubTarget}%, качество в норме.`);
  }
  return verdict("continue_testing", "green_but_thin",
    `Показатели в норме, но выборка ${trials} триалов ещё не подтверждает их — продолжаем тест.`);
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

function funnelBudgetShare(funnel: ReportFunnelRow, totalSpend: number | null): number {
  const spend = metricValue(funnel.metrics, "spend");
  if (spend === null || totalSpend === null || totalSpend <= 0) return 0.25;
  return spend / totalSpend;
}

function push(findings: Finding[], finding: Finding): void {
  findings.push(finding);
}

/**
 * Evaluate every rule over a snapshot.
 *
 * Deliberately returns everything it finds; choosing the handful that make the
 * "Главное за неделю" block is a separate, visible step (`rankFindings`), so
 * the operator can see what was considered and not just what survived.
 */
export function evaluateRules(
  snapshot: ReportSnapshot,
  thresholds: ReportThresholds = DEFAULT_THRESHOLDS,
): Finding[] {
  const findings: Finding[] = [];
  const totalSpend = snapshot.kpi.spend?.current.value ?? null;

  // ---- project level -------------------------------------------------------
  const blendedCpa = snapshot.kpi.blended_cpa;
  if (blendedCpa && isSignificant(blendedCpa) && blendedCpa.current.value !== null) {
    const better = blendedCpa.delta?.better === true;
    push(findings, {
      id: "project.blended_cpa",
      kind: "cpa_move",
      severity: better ? "medium" : "high",
      polarity: better ? "good" : "bad",
      scope: null,
      claim: `Blended CPA ${better ? "снизился" : "вырос"} до ${blendedCpa.current.rendered} (${blendedCpa.delta?.percentRendered} к прошлому периоду).`,
      evidence: ["kpi.blended_cpa", "kpi.spend", "kpi.trials"],
      sampleSize: blendedCpa.sampleSize,
      score: scoreFinding({
        severity: better ? "medium" : "high", budgetShare: 1,
        sampleSize: blendedCpa.sampleSize, minSample: thresholds.minTrialsForSignificance,
      }),
    });
  }

  const refundRate = snapshot.kpi.refund_rate;
  if (refundRate?.current.value !== null && refundRate?.current.value !== undefined &&
      refundRate.current.value > thresholds.refundRateCeiling) {
    push(findings, {
      id: "project.refund_rate",
      kind: "refund_rise",
      severity: refundRate.current.value > thresholds.refundRateCeiling * 1.5 ? "high" : "medium",
      polarity: "bad",
      scope: null,
      claim: `Refund rate ${refundRate.current.rendered} против цели ${thresholds.refundRateCeiling}%.`,
      evidence: ["kpi.refund_rate", "kpi.refund_amount", "kpi.gross_revenue"],
      sampleSize: refundRate.sampleSize,
      score: scoreFinding({
        severity: "high", budgetShare: 1,
        sampleSize: refundRate.sampleSize, minSample: thresholds.minTrialsForSignificance,
      }),
    });
  }

  // ---- data quality --------------------------------------------------------
  for (const reason of snapshot.provisionalReasons) {
    push(findings, {
      id: `data.${reason}`,
      kind: "data_quality",
      severity: reason === "warehouse_moved_during_collection" ? "high" : "medium",
      polarity: "neutral",
      scope: null,
      claim: DATA_QUALITY_CLAIMS[reason] ?? `Данные периода неполные: ${reason}.`,
      evidence: ["provisionalReasons"],
      sampleSize: null,
      score: scoreFinding({ severity: "medium", budgetShare: 0.4, sampleSize: null, minSample: 1 }),
    });
  }
  for (const gap of snapshot.gaps) {
    push(findings, {
      id: `gap.${gap.key}`,
      kind: "data_quality",
      severity: "low",
      polarity: "neutral",
      scope: null,
      claim: `${gap.label}: ${gap.reason}`,
      evidence: [`gaps.${gap.key}`],
      sampleSize: null,
      score: scoreFinding({ severity: "low", budgetShare: 0.2, sampleSize: null, minSample: 1 }),
    });
  }

  // ---- per funnel ----------------------------------------------------------
  for (const funnel of snapshot.funnels) {
    const share = funnelBudgetShare(funnel, totalSpend);
    const trials = metricValue(funnel.metrics, "trials");
    const cpa = funnel.metrics.blended_cpa;
    const cr = funnel.metrics.trial_to_sub_cr;
    const upsell = funnel.metrics.upsell_cr;
    const support = funnel.metrics.support_rate;
    const scope = funnel.funnelPath;

    if (funnel.isNew) {
      push(findings, {
        id: `${scope}.new`,
        kind: "new_funnel_start",
        severity: "medium",
        polarity: "neutral",
        scope,
        claim: cpa?.current.value !== null && cpa?.current.value !== undefined
          ? `Новая воронка ${scope}: стартовый CPA ${cpa.current.rendered}, триалов ${funnel.metrics.trials?.current.rendered ?? "—"}.`
          : `Новая воронка ${scope}: запущена, данных для оценки пока нет.`,
        evidence: [`funnels[${scope}].blended_cpa`, `funnels[${scope}].trials`],
        sampleSize: trials,
        score: scoreFinding({ severity: "medium", budgetShare: share, sampleSize: trials, minSample: thresholds.minTrialsForSignificance }),
      });
    }

    if (isSignificant(cpa) && cpa?.current.value !== null) {
      const better = cpa?.delta?.better === true;
      push(findings, {
        id: `${scope}.cpa`,
        kind: "cpa_move",
        severity: better ? "medium" : "high",
        polarity: better ? "good" : "bad",
        scope,
        claim: `${scope}: CPA ${better ? "снизился" : "вырос"} до ${cpa!.current.rendered} (${cpa!.delta?.percentRendered}).`,
        evidence: [`funnels[${scope}].blended_cpa`],
        sampleSize: trials,
        score: scoreFinding({ severity: better ? "medium" : "high", budgetShare: share, sampleSize: trials, minSample: thresholds.minTrialsForSignificance }),
      });
    }

    if (isSignificant(cr) && cr?.current.value !== null) {
      const better = cr?.delta?.better === true;
      push(findings, {
        id: `${scope}.cr`,
        kind: "conversion_move",
        severity: better ? "medium" : "high",
        polarity: better ? "good" : "bad",
        scope,
        claim: `${scope}: конверсия из триала в подписку ${better ? "выросла" : "просела"} до ${cr!.current.rendered} (было ${cr!.delta?.previousRendered}).`,
        evidence: [`funnels[${scope}].trial_to_sub_cr`],
        sampleSize: cr?.sampleSize ?? null,
        score: scoreFinding({ severity: better ? "medium" : "high", budgetShare: share, sampleSize: cr?.sampleSize ?? null, minSample: thresholds.minTrialsForSignificance }),
      });
    }

    if (isSignificant(upsell) && upsell?.current.value !== null) {
      const better = upsell?.delta?.better === true;
      push(findings, {
        id: `${scope}.upsell`,
        kind: "upsell_move",
        severity: "low",
        polarity: better ? "good" : "bad",
        scope,
        claim: `${scope}: конверсия в апсейл ${better ? "выросла" : "снизилась"} до ${upsell!.current.rendered}.`,
        evidence: [`funnels[${scope}].upsell_cr`],
        sampleSize: trials,
        score: scoreFinding({ severity: "low", budgetShare: share, sampleSize: trials, minSample: thresholds.minTrialsForSignificance }),
      });
    }

    if (support?.current.value !== null && support?.current.value !== undefined &&
        support.current.value > thresholds.supportRateCeiling) {
      push(findings, {
        id: `${scope}.support`,
        kind: "support_rise",
        severity: support.current.value > thresholds.supportRateCeiling * 2 ? "high" : "medium",
        polarity: "bad",
        scope,
        claim: `${scope}: обращения в support ${support.current.rendered} при цели до ${thresholds.supportRateCeiling}%.`,
        evidence: [`funnels[${scope}].support_rate`],
        sampleSize: trials,
        score: scoreFinding({ severity: "high", budgetShare: share, sampleSize: trials, minSample: thresholds.minTrialsForSignificance }),
      });
    }

    // Composite reads — the ones the weekly reports actually act on.
    const cpaValue = cpa?.current.value ?? null;
    const crValue = cr?.current.value ?? null;
    const spendDelta = funnel.metrics.spend?.delta;

    if (cpaValue !== null && crValue !== null) {
      if (cpaValue <= thresholds.cpaCeiling && crValue < thresholds.trialToSubTarget * 0.7) {
        push(findings, {
          id: `${scope}.cheap_but_weak`,
          kind: "cheap_but_weak",
          severity: "medium",
          polarity: "bad",
          scope,
          claim: `${scope}: трафик дешёвый (CPA ${cpa!.current.rendered}), но конверсия ${cr!.current.rendered} — аудитория плохо платит.`,
          evidence: [`funnels[${scope}].blended_cpa`, `funnels[${scope}].trial_to_sub_cr`],
          sampleSize: cr?.sampleSize ?? null,
          score: scoreFinding({ severity: "medium", budgetShare: share, sampleSize: cr?.sampleSize ?? null, minSample: thresholds.minTrialsForSignificance }),
        });
      }
      if (cpaValue > thresholds.cpaCeiling && crValue >= thresholds.trialToSubTarget) {
        push(findings, {
          id: `${scope}.expensive_but_converting`,
          kind: "expensive_but_converting",
          severity: "medium",
          polarity: "neutral",
          scope,
          claim: `${scope}: конверсия ${cr!.current.rendered} выше цели, но CPA ${cpa!.current.rendered} — потенциал есть, нужен зацеп.`,
          evidence: [`funnels[${scope}].blended_cpa`, `funnels[${scope}].trial_to_sub_cr`],
          sampleSize: cr?.sampleSize ?? null,
          score: scoreFinding({ severity: "medium", budgetShare: share, sampleSize: cr?.sampleSize ?? null, minSample: thresholds.minTrialsForSignificance }),
        });
      }
    }

    if (spendDelta?.direction === "up" && spendDelta.significant &&
        cpa?.delta?.direction === "up" && cpa.delta.significant) {
      push(findings, {
        id: `${scope}.degrading_while_scaling`,
        kind: "degrading_while_scaling",
        severity: "high",
        polarity: "bad",
        scope,
        claim: `${scope}: объём вырос (${spendDelta.percentRendered}), но вместе с ним вырос и CPA (${cpa.delta.percentRendered}) — масштабирование пока не держит эффективность.`,
        evidence: [`funnels[${scope}].spend`, `funnels[${scope}].blended_cpa`],
        sampleSize: trials,
        score: scoreFinding({ severity: "high", budgetShare: share, sampleSize: trials, minSample: thresholds.minTrialsForSignificance }),
      });
    }

    if (spendDelta?.direction === "up" && spendDelta.significant &&
        cpa?.delta?.direction === "down" && cpa.delta.significant) {
      push(findings, {
        id: `${scope}.scaling_success`,
        kind: "scaling_success",
        severity: "high",
        polarity: "good",
        scope,
        claim: `${scope}: объём вырос (${spendDelta.percentRendered}) при снижении CPA до ${cpa.current.rendered} — масштабирование идёт без потери эффективности.`,
        evidence: [`funnels[${scope}].spend`, `funnels[${scope}].blended_cpa`],
        sampleSize: trials,
        score: scoreFinding({ severity: "high", budgetShare: share, sampleSize: trials, minSample: thresholds.minTrialsForSignificance }),
      });
    }

    if (funnel.status.status === "insufficient_data" && (trials ?? 0) > 0) {
      push(findings, {
        id: `${scope}.thin`,
        kind: "insufficient_sample",
        severity: "info",
        polarity: "neutral",
        scope,
        claim: `${scope}: ${funnel.status.because}`,
        evidence: [`funnels[${scope}].trials`],
        sampleSize: trials,
        score: scoreFinding({ severity: "info", budgetShare: share, sampleSize: trials, minSample: thresholds.minTrialsForSignificance }),
      });
    }
  }

  return findings;
}

const DATA_QUALITY_CLAIMS: Record<string, string> = {
  spend_unavailable: "Рекламные расходы за период недоступны — метрики стоимости привлечения не посчитаны.",
  conversion_immature: "Конверсия из триала в подписку ещё не измерима: триалы периода не закончились.",
  spend_incomplete: "В периоде есть дни с известным пробелом в данных о расходах — суммы занижены.",
  warehouse_moved_during_collection: "Склад обновился во время сбора: числа периода и периода сравнения могли быть прочитаны в разных состояниях.",
  immature_cohorts_present: "Часть когорт периода ещё не прошла триал — конверсия считается только по зрелым.",
};

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

export interface RankOptions {
  limit?: number;
  /** Cap per funnel so one loud funnel cannot take over the whole block. */
  maxPerScope?: number;
}

/**
 * Pick the handful of findings that become "Главное за неделю".
 *
 * The per-scope cap is the important part: without it a single funnel having a
 * dramatic week fills all eight slots and the block stops being a summary of
 * the business. Ties break on id so the order is stable across runs.
 */
export function rankFindings(findings: readonly Finding[], options: RankOptions = {}): Finding[] {
  const limit = options.limit ?? 8;
  const maxPerScope = options.maxPerScope ?? 2;

  const sorted = [...findings].sort((a, b) =>
    b.score - a.score || a.id.localeCompare(b.id));

  const perScope = new Map<string, number>();
  const picked: Finding[] = [];
  for (const finding of sorted) {
    if (picked.length >= limit) break;
    const key = finding.scope ?? "__project__";
    const used = perScope.get(key) ?? 0;
    // Project-level findings are not capped: they are the headline by nature.
    if (finding.scope !== null && used >= maxPerScope) continue;
    perScope.set(key, used + 1);
    picked.push(finding);
  }
  return picked;
}

/**
 * Re-classify every funnel in a snapshot. Returns a new snapshot — the input is
 * never mutated, so a saved snapshot cannot be re-scored in place.
 */
export function applyFunnelStatuses(
  snapshot: ReportSnapshot,
  thresholds: ReportThresholds = DEFAULT_THRESHOLDS,
  overrides: Readonly<Record<string, Partial<ReportThresholds>>> = {},
): ReportSnapshot {
  const funnels = snapshot.funnels.map((funnel) => {
    const resolved = resolveThresholds(thresholds, overrides, {
      funnel: funnel.funnelPath,
      billingPeriod: funnel.passport.billingPeriod,
    });
    const status = classifyFunnel({
      trials: metricValue(funnel.metrics, "trials"),
      matureTrials: funnel.metrics.trial_to_sub_cr?.sampleSize ?? null,
      cpa: metricValue(funnel.metrics, "blended_cpa"),
      trialToSubCr: metricValue(funnel.metrics, "trial_to_sub_cr"),
      supportRate: metricValue(funnel.metrics, "support_rate"),
      refundRate: metricValue(funnel.metrics, "refund_rate"),
      cpaTrendImproving: funnel.metrics.blended_cpa?.delta
        ? funnel.metrics.blended_cpa.delta.direction === "down"
        : null,
      thresholds: resolved,
    });
    return { ...funnel, status };
  });
  return { ...snapshot, funnels };
}
