// Report data collection (R5).
//
// The thin, impure shell around the pure builder. It fetches nothing new: it
// calls the SAME edge action the Cohorts page calls, so the numbers in a report
// are literally the objects that page shows. A second collection path would be
// a second set of formulas and a silent drift — the mistake this codebase has
// already paid for once on cohorts.
//
// Consistency is DETECTED, not guaranteed: the two periods are two sequential
// calls, so the warehouse fingerprint is read from each response and compared.
// A mismatch marks the draft provisional rather than pretending atomicity.
import { runClickHouseCohorts } from "@/services/clickhouse";
import { listFunnels, type FunnelRecord } from "@/services/funnels";
import { listReportTargets } from "@/services/reportWorkItems";
import { buildReportSnapshot, type SnapshotStatus } from "@/services/reportBuilder";
import { applyFunnelStatuses, DEFAULT_THRESHOLDS, evaluateRules, rankFindings, type Finding } from "@/services/reportRules";
import type {
  ReportBindings, ReportEngineVersions, ReportFunnelPassport, ReportGap,
  ReportProvenanceEntry, ReportSnapshot,
} from "@/services/reportContract";
import type { CohortAggregateRow, CohortResponse } from "../../supabase/functions/_shared/clickhouse/cohortContract";

/**
 * Sources the weekly report references but the warehouse does not carry. Named
 * here rather than left as blanks, so the UI can show them, the prompt can
 * state them, and no section quietly invents a number instead.
 */
export const KNOWN_REPORT_GAPS: readonly ReportGap[] = [
  {
    key: "email_marketing",
    label: "Email-метрики",
    reason: "Нет интеграции с почтовым сервисом: отправки, открытия и клики нигде не хранятся.",
    affectsSections: ["email"],
    manualEntryAvailable: true,
  },
  {
    key: "product_funnel",
    label: "Конверсия воронки и пэйвола",
    reason: "Продуктовая аналитика (PostHog) не подключена — событий внутри воронки в дашборде нет.",
    affectsSections: ["funnels"],
    manualEntryAvailable: true,
  },
  {
    key: "non_fb_spend",
    label: "Спенд TikTok и Google",
    reason: "Есть только метка канала на транзакции; расходы этих каналов в склад не приходят.",
    affectsSections: ["channels", "kpi"],
    manualEntryAvailable: true,
  },
  {
    key: "processor_split",
    label: "Разрез Stripe / Adyen",
    reason: "В витрине нет транзакций Adyen — сравнение процессоров из текущих данных не строится.",
    affectsSections: ["geo_payments"],
    manualEntryAvailable: false,
  },
];

function passportFromFunnel(funnel: FunnelRecord): ReportFunnelPassport {
  return {
    funnelPath: funnel.funnel_path,
    displayName: funnel.display_name || funnel.funnel_path,
    trialPrice: funnel.trial_price,
    trialCurrency: funnel.trial_currency,
    trialDurationDays: funnel.trial_duration_days,
    subscriptionPrice: funnel.subscription_price,
    subscriptionCurrency: funnel.subscription_currency,
    billingPeriod: funnel.billing_period,
    upsells: funnel.upsells ?? [],
    defaultLanguage: funnel.default_language,
    defaultCurrency: funnel.default_currency,
    geoLocalization: funnel.geo_localization ?? [],
    destination: funnel.destination,
    product: funnel.product,
    trafficSources: funnel.traffic_sources ?? [],
    incomplete: funnel.trial_duration_days === null || funnel.subscription_price === null,
  };
}

/**
 * Read the snapshot state out of a cohorts response.
 *
 * This decides whether spend exists at all: computeFbCohortStats runs only on
 * the materialized path, so a response served by the dynamic classifier carries
 * no fb_* fields no matter how healthy it looks.
 */
function snapshotStatusOf(response: CohortResponse): SnapshotStatus {
  const diagnostics = response.diagnostics;
  if (!diagnostics?.active_snapshot_version) return "missing";
  if (diagnostics.snapshot_stale === true) return "stale";
  if (diagnostics.snapshot_status && diagnostics.snapshot_status !== "current") return "stale";
  return "current";
}

function requestFor(period: { from: string; to: string }, bindings: ReportBindings) {
  return {
    action: "list" as const,
    date_from: period.from,
    date_to: period.to,
    filters: {
      funnel: [],
      campaign_path: bindings.funnels,
      campaign_id: [],
      traffic_source: bindings.trafficSources,
      price_plan: [],
      media_buyer: bindings.mediaBuyers,
      country: bindings.countries,
      card_type: [],
      platform: [],
      currency: bindings.currency ? [bindings.currency] : [],
      transaction_type: [],
      refund_status: "all" as const,
    },
  };
}

export interface CollectedReport {
  snapshot: ReportSnapshot;
  findings: Finding[];
  highlights: Finding[];
}

export interface CollectOptions {
  bindings: ReportBindings;
  engineVersions: ReportEngineVersions;
  /** Injected so a collection can be replayed in a test with a fixed clock. */
  now: string;
}

/**
 * Collect a period and its comparison, then build the deterministic report.
 *
 * The two cohort calls run sequentially rather than in parallel on purpose:
 * each already fans out ~6 concurrent ClickHouse queries inside its own 25s
 * budget, and firing both at once is how you turn a slow week into a timeout.
 */
export async function collectReport(options: CollectOptions): Promise<CollectedReport> {
  const { bindings, now } = options;
  const provenance: ReportProvenanceEntry[] = [];

  const periodResponse = await runClickHouseCohorts(requestFor(bindings.period, bindings));
  if (!periodResponse.ok) {
    throw new Error(periodResponse.error || "Не удалось прочитать когорты за отчётный период.");
  }
  const warehouseVersionBefore = periodResponse.diagnostics?.current_warehouse_version ?? null;
  provenance.push({
    key: "cohorts.period",
    engine: "clickhouse-cohorts",
    action: "list",
    rowsRead: periodResponse.rows?.length ?? 0,
    durationMs: periodResponse.query_duration_ms ?? null,
    warehouseVersion: warehouseVersionBefore,
    collectedAt: now,
  });

  let compareRows: CohortAggregateRow[] = [];
  let warehouseVersionAfter = warehouseVersionBefore;
  if (bindings.compare) {
    const compareResponse = await runClickHouseCohorts(requestFor(bindings.compare, bindings));
    if (!compareResponse.ok) {
      throw new Error(compareResponse.error || "Не удалось прочитать когорты за период сравнения.");
    }
    compareRows = compareResponse.rows ?? [];
    warehouseVersionAfter = compareResponse.diagnostics?.current_warehouse_version ?? warehouseVersionBefore;
    provenance.push({
      key: "cohorts.compare",
      engine: "clickhouse-cohorts",
      action: "list",
      rowsRead: compareRows.length,
      durationMs: compareResponse.query_duration_ms ?? null,
      warehouseVersion: warehouseVersionAfter,
      collectedAt: now,
    });
  }

  const [funnels, targets] = await Promise.all([
    listFunnels().catch(() => [] as FunnelRecord[]),
    listReportTargets().catch(() => []),
  ]);
  const passports: Record<string, ReportFunnelPassport> = {};
  for (const funnel of funnels) passports[funnel.funnel_path] = passportFromFunnel(funnel);

  const snapshot = buildReportSnapshot({
    period: bindings.period,
    compare: bindings.compare,
    periodRows: periodResponse.rows ?? [],
    compareRows,
    passports,
    targets,
    gaps: KNOWN_REPORT_GAPS,
    provenance,
    engineVersions: options.engineVersions,
    snapshotStatus: snapshotStatusOf(periodResponse),
    warehouseVersionBefore,
    warehouseVersionAfter,
    collectedAt: now,
  });

  const scored = applyFunnelStatuses(snapshot, DEFAULT_THRESHOLDS);
  const findings = evaluateRules(scored, DEFAULT_THRESHOLDS);
  return { snapshot: scored, findings, highlights: rankFindings(findings) };
}

// ---------------------------------------------------------------------------
// Period helpers
// ---------------------------------------------------------------------------

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function shift(day: string, delta: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return iso(date);
}

/** The Monday–Sunday week containing `day`, and the week before it. Weeks are
 * the unit the reports have always used, so it is the default rather than a
 * rolling seven days. */
export function weekWindows(day: string): { period: { from: string; to: string }; compare: { from: string; to: string } } {
  const date = new Date(`${day}T00:00:00Z`);
  const weekday = (date.getUTCDay() + 6) % 7; // Monday = 0
  const from = shift(day, -weekday);
  const to = shift(from, 6);
  return { period: { from, to }, compare: { from: shift(from, -7), to: shift(from, -1) } };
}

/** Last completed week as of `today` — what "создать отчёт за прошлую неделю"
 * means, and the default the wizard opens on. */
export function lastCompletedWeek(today: string) {
  return weekWindows(shift(today, -7));
}
