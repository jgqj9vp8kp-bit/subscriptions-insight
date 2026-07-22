export type FbCohortSource =
  | "facebook"
  | "tiktok"
  | "google"
  | "organic"
  | "direct"
  | "unknown"
  | "other";

// These aliases were validated against the authoritative trial Campaign ID
// and the Campaign ID stored in the FB export. They are classification-only:
// they must never rewrite authoritative attribution or participate in cost
// allocation.
export const CONFIRMED_FB_CAMPAIGN_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  "120246043987330040": "120246043987330050",
  "120245959195250040": "120245959195250050",
  "120244275409590040": "120244275409590050",
  "120247414960140040": "120247414960140030",
  "120247775356480040": "120247775356480030",
  "120247335249650040": "120247335249650050",
  "120246497969430040": "120246497969430050",
  "120244275442850040": "120244275442850050",
  "120243877527920040": "120243877527920030",
  "120251449476800360": "120251449476800350",
  "120251448942000360": "120251448942000350",
  "120247335409540040": "120247335409540030",
  "120245497757300040": "120245497757300030",
  "120243953442810040": "120243953442810050",
  "120243953333110040": "120243953333110050",
  "120247479512190040": "120247479512190050",
  "120243218480090040": "120243218480090050",
  "120247848842100040": "120247848842100030",
  "120246244454250040": "120246244454250050",
  "120243352781740040": "120243352781740030",
  "120244323656240040": "120244323656240030",
  "120244076558070040": "120244076558070050",
});

export const CONFIRMED_FB_CAMPAIGN_ALIAS_IDS = Object.freeze([
  ...new Set([
    ...Object.keys(CONFIRMED_FB_CAMPAIGN_ALIASES),
    ...Object.values(CONFIRMED_FB_CAMPAIGN_ALIASES),
  ]),
].sort());

const SOURCE_PATTERNS: Readonly<Record<Exclude<FbCohortSource, "unknown">, readonly string[]>> = {
  facebook: ["fb", "facebook", "ig", "instagram", "meta"],
  tiktok: ["tiktok", "tik tok", "tik_tok"],
  google: ["google", "adwords", "google ads"],
  organic: ["organic", "seo"],
  direct: ["direct", "none", "(none)"],
  other: ["bing", "snapchat", "pinterest", "reddit", "email", "affiliate"],
};

export function normalizeSourceValue(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, " ");
}

function sourceMatches(value: string, patterns: readonly string[]): boolean {
  if (!value) return false;
  return patterns.some((pattern) => {
    const normalizedPattern = normalizeSourceValue(pattern);
    if (value === normalizedPattern) return true;
    const escaped = normalizedPattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(value);
  });
}

export function normalizeTrafficSource(values: readonly unknown[]): FbCohortSource {
  const normalized = values.map(normalizeSourceValue).filter(Boolean);
  for (const source of ["facebook", "tiktok", "google", "organic", "direct", "other"] as const) {
    if (normalized.some((value) => sourceMatches(value, SOURCE_PATTERNS[source]))) return source;
  }
  return "unknown";
}

function campaignId(value: unknown): string {
  const normalized = String(value ?? "").trim();
  return !normalized || ["unknown", "null", "n/a", "none"].includes(normalized.toLowerCase()) ? "" : normalized;
}

export interface FbCohortSourceSignals {
  sourceValues?: readonly unknown[];
  campaignId?: unknown;
  fbCampaignIds?: Iterable<string>;
  confirmedAliasIds?: Iterable<string>;
  fbc?: unknown;
  /** Deliberately accepted but never used as standalone Meta evidence. */
  fbp?: unknown;
  gclid?: unknown;
  ttclid?: unknown;
}

export function classifyFbCohortSource(input: FbCohortSourceSignals): FbCohortSource {
  const explicit = normalizeTrafficSource(input.sourceValues ?? []);
  if (explicit === "facebook") return "facebook";

  const authoritativeCampaignId = campaignId(input.campaignId);
  const fbCampaignIds = new Set([...(input.fbCampaignIds ?? [])].map(campaignId).filter(Boolean));
  if (authoritativeCampaignId && fbCampaignIds.has(authoritativeCampaignId)) return "facebook";

  const aliasIds = new Set([...(input.confirmedAliasIds ?? CONFIRMED_FB_CAMPAIGN_ALIAS_IDS)].map(campaignId).filter(Boolean));
  if (authoritativeCampaignId && aliasIds.has(authoritativeCampaignId)) return "facebook";

  // A paid Campaign ID together with Meta's click cookie is sufficient. _fbp
  // alone is only a browser cookie and is intentionally not evidence here.
  if (authoritativeCampaignId && String(input.fbc ?? "").trim()) return "facebook";

  if (explicit === "tiktok" || String(input.ttclid ?? "").trim()) return "tiktok";
  if (explicit === "google" || String(input.gclid ?? "").trim()) return "google";
  return explicit;
}

export interface FbSourceCounts {
  all: number;
  facebook: number;
  tiktok: number;
  google: number;
  organic: number;
  direct: number;
  unknown: number;
  other: number;
}

export interface FbSourceReconciliation extends FbSourceCounts {
  fbAnalyticsPurchases: number;
  allocatedFbPurchases: number;
  allocationGap: number;
  allocationCoverage: number | null;
  sourceMixDifference: number;
  metaAuthoritativeDifference: number;
}

const finiteCount = (value: unknown): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

export function buildFbSourceReconciliation(input: {
  counts: Partial<FbSourceCounts>;
  fbAnalyticsPurchases: unknown;
  allocatedFbPurchases: unknown;
}): FbSourceReconciliation {
  const counts: FbSourceCounts = {
    all: finiteCount(input.counts.all),
    facebook: finiteCount(input.counts.facebook),
    tiktok: finiteCount(input.counts.tiktok),
    google: finiteCount(input.counts.google),
    organic: finiteCount(input.counts.organic),
    direct: finiteCount(input.counts.direct),
    unknown: finiteCount(input.counts.unknown),
    other: finiteCount(input.counts.other),
  };
  const fbAnalyticsPurchases = finiteCount(input.fbAnalyticsPurchases);
  const allocatedFbPurchases = finiteCount(input.allocatedFbPurchases);
  return {
    ...counts,
    fbAnalyticsPurchases,
    allocatedFbPurchases,
    allocationGap: fbAnalyticsPurchases - allocatedFbPurchases,
    allocationCoverage: fbAnalyticsPurchases > 0
      ? Math.round((allocatedFbPurchases / fbAnalyticsPurchases) * 10_000) / 100
      : null,
    sourceMixDifference: counts.all - fbAnalyticsPurchases,
    metaAuthoritativeDifference: counts.facebook - fbAnalyticsPurchases,
  };
}
