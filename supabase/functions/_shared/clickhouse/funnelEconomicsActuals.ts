// FunnelActualsProvider — the observed-facts boundary of the FunnelEconomics module
// (v3 spec §5). Pure derivation + a source-agnostic provider factory: the module
// never fetches or reads app state itself; a row loader is injected by the caller
// (live cohort endpoint, in-memory computeCohorts, snapshots, imports — anything
// that yields cohort-shaped rows). Unavailable facts are null + a warning — NEVER 0.
import {
  type DataCoverage,
  type DataWarning,
  type DateWindow,
  type FunnelActuals,
  type FunnelActualsProvider,
  type FunnelActualsRequest,
  type FunnelActualsResult,
  type HistoricalWindowPolicy,
} from "./funnelEconomicsTypes.ts";

/** Structural cohort-row slice accepted from either cohort engine (client CohortRow
 * or server CohortAggregateRow). All metric fields are optional-tolerant — absence
 * means "not observed", which is different from an observed zero. */
export interface CohortRowLike {
  cohort_date: string;
  funnel?: string;
  campaign_path?: string;
  trial_users: number;
  first_subscription_users?: number;
  renewal_users_by_level?: Record<number, number>;
  renewal_2_users?: number;
  renewal_3_users?: number;
  renewal_4_users?: number;
  renewal_5_users?: number;
  renewal_6_users?: number;
  trial_revenue?: number;
  first_subscription_revenue?: number;
  upsell_users?: number;
  upsell_revenue?: number;
  upsell_1_users?: number;
  upsell_1_revenue?: number;
  upsell_2_users?: number;
  upsell_2_revenue?: number;
  upsell_3_users?: number;
  upsell_3_revenue?: number;
  token_net_revenue?: number;
  amount_refunded?: number;
  gross_revenue?: number;
  fb_spend?: number | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RENEWAL_LEVEL = 12;
export const LOW_VOLUME_TRIALS_THRESHOLD = 50;

function renewalUsersAtLevel(row: CohortRowLike, level: number): number | null {
  const byLevel = row.renewal_users_by_level?.[level];
  if (typeof byLevel === "number") return byLevel;
  const flat = (row as Record<string, unknown>)[`renewal_${level}_users`];
  return typeof flat === "number" ? flat : null;
}

function sumPresent(rows: CohortRowLike[], pick: (row: CohortRowLike) => number | null | undefined): { sum: number; present: boolean } {
  let sum = 0;
  let present = false;
  for (const row of rows) {
    const value = pick(row);
    if (typeof value === "number" && Number.isFinite(value)) {
      sum += value;
      present = true;
    }
  }
  return { sum, present };
}

/** Pure rollup: cohort rows (one funnel) → immutable FunnelActuals + coverage + warnings.
 *
 * Conversion-chain maturity gating: level k (k=1 → first paid, k≥2 → renewal_k) is
 * derived ONLY from cohorts old enough to have reached that level (age ≥ k·periodDays).
 * Without this, week-old cohorts contribute structural zeroes ("nobody renewed yet")
 * that would be indistinguishable from real churn and poison the survival tail. */
export function deriveFunnelActualsFromCohortRows(input: {
  funnelId: string;
  rows: CohortRowLike[];
  asOf: string;
  window?: DateWindow | null;
  /** Length of one billing period in days (monthly 30, weekly 7). Default 30. */
  periodDays?: number;
}): Omit<FunnelActualsResult, "sourceMetadata"> {
  const warnings: DataWarning[] = [];
  const rows = input.rows.filter((row) => Number.isFinite(row.trial_users));
  const trials = rows.reduce((sum, row) => sum + row.trial_users, 0);

  const emptyCoverage: DataCoverage = {
    cohorts: rows.length,
    trialUsers: trials,
    spendCoverage: null,
    observedRetentionDepth: 0,
    maturityDays: 0,
  };
  if (rows.length === 0 || trials <= 0) {
    warnings.push({ code: "no_data", message: "No cohort rows (or no trial users) in the requested window — actuals unavailable." });
    return { actuals: null, coverage: emptyCoverage, warnings };
  }

  const dates = rows.map((row) => row.cohort_date).filter(Boolean).sort();
  const window: DateWindow = input.window ?? { from: dates[0] ?? input.asOf.slice(0, 10), to: dates[dates.length - 1] ?? input.asOf.slice(0, 10) };
  const oldestMs = Date.parse(`${dates[0] ?? input.asOf.slice(0, 10)}T00:00:00Z`);
  const maturityDays = Math.max(0, Math.floor((Date.parse(input.asOf) - oldestMs) / DAY_MS));

  // Spend: only rows that actually carry spend count toward it; absence ≠ 0.
  const spendRows = rows.filter((row) => typeof row.fb_spend === "number" && Number.isFinite(row.fb_spend));
  const spend = spendRows.length > 0 ? spendRows.reduce((sum, row) => sum + (row.fb_spend as number), 0) : null;
  const spendTrials = spendRows.reduce((sum, row) => sum + row.trial_users, 0);
  const spendCoverage = spend === null ? null : trials > 0 ? spendTrials / trials : null;
  if (spend === null) {
    warnings.push({ code: "spend_unavailable", message: "No cohort in the window carries attributed spend — CPA seed unavailable." });
  } else if ((spendCoverage ?? 0) < 0.8) {
    warnings.push({ code: "spend_partial", message: `Attributed spend covers only ${Math.round((spendCoverage ?? 0) * 100)}% of trial users — actual CPA may be understated.` });
  }
  const cpaActual = spend !== null && spendTrials > 0 ? spend / spendTrials : null;

  // Retention chain (maturity-gated): c1 = first-paid conversion over cohorts aged
  // ≥ 1 period; c_k = renewal_k / renewal_{k−1} over the SAME subset of cohorts aged
  // ≥ k periods. An empty mature subset ends the chain (unobservable ≠ zero); a real
  // zero among mature cohorts records 0 and ends it (later levels can't exist).
  const periodDays = input.periodDays ?? 30;
  const asOfMs = Date.parse(input.asOf);
  const rowAgeDays = (row: CohortRowLike): number =>
    Math.floor((asOfMs - Date.parse(`${row.cohort_date}T00:00:00Z`)) / DAY_MS);
  const matureRows = (level: number): CohortRowLike[] =>
    rows.filter((row) => rowAgeDays(row) >= level * periodDays);

  const c1Rows = matureRows(1);
  const c1Trials = c1Rows.reduce((sum, row) => sum + row.trial_users, 0);
  const firstSub = sumPresent(c1Rows, (row) => row.first_subscription_users);
  const firstPaidConversion = firstSub.present && c1Trials > 0 ? firstSub.sum / c1Trials : null;
  const renewalConversions: number[] = [];
  if (firstSub.present && firstSub.sum > 0) {
    for (let level = 2; level <= MAX_RENEWAL_LEVEL; level += 1) {
      const subset = matureRows(level);
      if (subset.length === 0) break; // no cohort is old enough to observe this level yet
      const previous = level === 2
        ? sumPresent(subset, (row) => row.first_subscription_users)
        : sumPresent(subset, (row) => renewalUsersAtLevel(row, level - 1));
      const current = sumPresent(subset, (row) => renewalUsersAtLevel(row, level));
      if (!current.present || !previous.present) break; // field absent — not an observed zero
      if (previous.sum <= 0) break; // nobody reached the prior level in the mature subset
      renewalConversions.push(current.sum / previous.sum);
      if (current.sum <= 0) break; // real zero among mature cohorts: chain ends
    }
  }
  const observedRetentionDepth = 1 + (firstPaidConversion !== null ? 1 : 0) + renewalConversions.length;

  // Prices from realized revenue.
  const trialRevenue = sumPresent(rows, (row) => row.trial_revenue);
  const trialPriceActual = trialRevenue.present && trials > 0 ? trialRevenue.sum / trials : null;
  const firstSubRevenue = sumPresent(rows, (row) => row.first_subscription_revenue);
  const subPriceActual = firstSubRevenue.present && firstSub.sum > 0 ? firstSubRevenue.sum / firstSub.sum : null;

  // Upsell tiers: tiered fields when present, else one blended tier.
  const upsellTiersActual: FunnelActuals["upsellTiersActual"] = [];
  const hasTierFields = rows.some((row) => typeof row.upsell_1_users === "number");
  if (hasTierFields) {
    for (const tier of [1, 2, 3] as const) {
      const users = sumPresent(rows, (row) => (row as Record<string, unknown>)[`upsell_${tier}_users`] as number | undefined);
      const revenue = sumPresent(rows, (row) => (row as Record<string, unknown>)[`upsell_${tier}_revenue`] as number | undefined);
      if (!users.present || users.sum <= 0) continue;
      upsellTiersActual.push({
        takeRate: users.sum / trials,
        price: revenue.present ? revenue.sum / users.sum : 0,
        revenue: revenue.present ? revenue.sum : 0,
      });
    }
  } else {
    const users = sumPresent(rows, (row) => row.upsell_users);
    const revenue = sumPresent(rows, (row) => row.upsell_revenue);
    if (users.present && users.sum > 0) {
      upsellTiersActual.push({
        takeRate: users.sum / trials,
        price: revenue.present ? revenue.sum / users.sum : 0,
        revenue: revenue.present ? revenue.sum : 0,
      });
    }
  }

  const tokenRevenue = sumPresent(rows, (row) => row.token_net_revenue);
  const tokenArpuPerTrialActual = tokenRevenue.present && trials > 0 ? tokenRevenue.sum / trials : null;

  const refunded = sumPresent(rows, (row) => row.amount_refunded);
  const gross = sumPresent(rows, (row) => row.gross_revenue);
  const refundRateActual = refunded.present && gross.present && gross.sum > 0 ? refunded.sum / gross.sum : null;

  if (trials < LOW_VOLUME_TRIALS_THRESHOLD) {
    warnings.push({ code: "low_volume", message: `Only ${Math.round(trials)} trial users in the window — auto-derived rates are noisy; consider a benchmark curve.` });
  }
  if (renewalConversions.length < 2) {
    warnings.push({ code: "shallow_retention", message: "Fewer than 2 observed renewal cycles — most of the survival curve will be extrapolated." });
  }

  const actuals: FunnelActuals = {
    funnelId: input.funnelId,
    window,
    maturityDays,
    trials,
    spend,
    cpaActual,
    trialPriceActual,
    subPriceActual,
    firstPaidConversion,
    renewalConversions,
    observedRetentionDepth,
    upsellTiersActual,
    tokenArpuPerTrialActual,
    refundRateActual,
    realizedRevenueByDay: [],
    realizedPaybackDay: null,
  };

  return {
    actuals,
    coverage: {
      cohorts: rows.length,
      trialUsers: trials,
      spendCoverage,
      observedRetentionDepth,
      maturityDays,
    },
    warnings,
  };
}

/** Resolve a window policy against a reference instant (pure; no Date.now inside). */
export function resolveHistoricalWindow(policy: HistoricalWindowPolicy, asOf: string): DateWindow | null {
  const asOfDay = asOf.slice(0, 10);
  if (policy.kind === "fixed") return policy.window;
  if (policy.kind === "last_days") {
    const from = new Date(Date.parse(`${asOfDay}T00:00:00Z`) - policy.days * DAY_MS).toISOString().slice(0, 10);
    return { from, to: asOfDay };
  }
  if (policy.kind === "maturity_filtered") {
    const to = new Date(Date.parse(`${asOfDay}T00:00:00Z`) - policy.minMaturityDays * DAY_MS).toISOString().slice(0, 10);
    return { from: "1970-01-01", to };
  }
  return null;
}

/** Source-agnostic provider factory. The row loader is the ONLY integration point —
 * live endpoint, in-memory engine, snapshot or import all satisfy it. */
export function createCohortRowActualsProvider(deps: {
  source: string;
  asOf?: string;
  loadCohortRows: (window: DateWindow | null, request: FunnelActualsRequest) => Promise<CohortRowLike[]>;
}): FunnelActualsProvider {
  return {
    async getFunnelActuals(request: FunnelActualsRequest): Promise<FunnelActualsResult> {
      const asOf = deps.asOf ?? new Date().toISOString();
      const window = resolveHistoricalWindow(request.windowPolicy, asOf);
      const rows = await deps.loadCohortRows(window, request);
      const periodDaysByCadence: Record<string, number> = { monthly: 30, weekly: 7, quarterly: 90, annual: 365 };
      const derived = deriveFunnelActualsFromCohortRows({
        funnelId: request.funnelId,
        rows,
        asOf,
        window,
        periodDays: request.pricingCadence ? periodDaysByCadence[request.pricingCadence] ?? 30 : 30,
      });
      return {
        ...derived,
        sourceMetadata: { source: deps.source, generatedAt: asOf, windowResolved: window },
      };
    },
  };
}
