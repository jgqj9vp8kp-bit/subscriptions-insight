// Client half of the Banks tab: query shape, request building, response
// validation. Mirrors paymentAnalyticsDataSource — same edge function, its own
// action.
import { runClickHouseBankAnalytics } from "@/services/clickhouse";
import type {
  BankAnalyticsBundle,
  BankDetailBundle,
} from "../../supabase/functions/_shared/clickhouse/bankContract";

export type {
  BankAnalyticsBundle,
  BankDetailBundle,
  IssuerCoverage,
  IssuerGroupRow,
  IssuerRow,
  IssuerTrendPoint,
} from "../../supabase/functions/_shared/clickhouse/bankContract";

export interface BankAnalyticsQuery {
  dateBasis: "transaction" | "cohort";
  dateFrom: string | null;
  dateTo: string | null;
  funnel: string[];
  campaignPath: string[];
  issuer: string[];
  issuerGroup: string[];
  cardNetwork: string[];
  paymentMethod: string[];
  issuerCountry: string[];
  stage: string[];
  outcome: "all" | "success" | "failed";
}

export const EMPTY_BANK_QUERY: BankAnalyticsQuery = {
  dateBasis: "transaction", dateFrom: null, dateTo: null,
  funnel: [], campaignPath: [], issuer: [], issuerGroup: [],
  cardNetwork: [], paymentMethod: [], issuerCountry: [], stage: [],
  outcome: "all",
};

export function buildBankAnalyticsRequest(q: BankAnalyticsQuery): Record<string, unknown> {
  return {
    action: "banks",
    filters: {
      date_basis: q.dateBasis,
      date_from: q.dateFrom,
      date_to: q.dateTo,
      funnel: q.funnel,
      campaign_path: q.campaignPath,
      issuer: q.issuer,
      issuer_group: q.issuerGroup,
      card_network: q.cardNetwork,
      payment_method: q.paymentMethod,
      issuer_country: q.issuerCountry,
      stage: q.stage,
      outcome: q.outcome,
    },
  };
}

export async function loadBankAnalytics(query: BankAnalyticsQuery): Promise<BankAnalyticsBundle> {
  const response = await runClickHouseBankAnalytics<BankAnalyticsBundle>(buildBankAnalyticsRequest(query));
  if (!response.ok) throw new Error(response.error || "ClickHouse bank analytics failed.");
  // The edge router falls through to the Payment Pass bundle on any
  // unrecognized action — which is ok:true and carries no issuer rows. The
  // discriminator turns that silent empty table into an error.
  if (response.action !== "banks" || !Array.isArray(response.issuer_rows)) {
    throw new Error("Сервер вернул не банковскую аналитику — обновите Edge-функцию clickhouse-payment-analytics.");
  }
  return response;
}

export async function loadBankDetail(query: BankAnalyticsQuery, issuerKey: string): Promise<BankDetailBundle> {
  const base = buildBankAnalyticsRequest(query);
  const response = await runClickHouseBankAnalytics<BankDetailBundle>({
    ...base,
    action: "bank_detail",
    issuer_key: issuerKey,
  });
  if (!response.ok) throw new Error(response.error || "ClickHouse bank detail failed.");
  if (response.action !== "bank_detail") {
    throw new Error("Сервер вернул не карточку банка — обновите Edge-функцию clickhouse-payment-analytics.");
  }
  return response;
}

// ---------------------------------------------------------------------------
// Volume badges (Wilson interval) — computed in TS from raw counts so the
// table, the export and any future consumer agree by construction.
// ---------------------------------------------------------------------------

export type VolumeBadge = "too_few" | "low_volume" | "indicative" | null;

export function volumeBadge(attempts: number): VolumeBadge {
  if (attempts < 30) return "too_few";
  if (attempts < 100) return "low_volume";
  if (attempts < 300) return "indicative";
  return null;
}

export const VOLUME_BADGE_LABELS: Record<Exclude<VolumeBadge, null>, string> = {
  too_few: "Мало данных",
  low_volume: "Малый объём",
  indicative: "Ориентировочно",
};

/** Wilson 95% interval for a proportion. Wilson rather than the normal
 * approximation because the interesting banks live at the extremes, where the
 * normal interval lies. */
export function wilsonInterval(successes: number, attempts: number): { low: number; high: number } {
  if (attempts <= 0) return { low: 0, high: 1 };
  const z = 1.959963984540054;
  const p = successes / attempts;
  const z2 = z * z;
  const denom = 1 + z2 / attempts;
  const centre = p + z2 / (2 * attempts);
  const spread = z * Math.sqrt((p * (1 - p) + z2 / (4 * attempts)) / attempts);
  return { low: Math.max(0, (centre - spread) / denom), high: Math.min(1, (centre + spread) / denom) };
}

export type SignalBadge = "below_account" | "above_account" | null;

/** Only meaningful at n >= 30; below that the interval spans everything. */
export function signalBadge(successes: number, attempts: number, accountRate: number): SignalBadge {
  if (attempts < 30) return null;
  const { low, high } = wilsonInterval(successes, attempts);
  if (high < accountRate) return "below_account";
  if (low > accountRate) return "above_account";
  return null;
}
