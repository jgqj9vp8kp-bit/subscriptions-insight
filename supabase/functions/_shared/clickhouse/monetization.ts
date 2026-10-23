import type { Transaction } from "./serviceTypes.ts";
import {
  isKnownTokenAmount,
  matchesKnownTokenProduct,
  matchesKnownUpsellProduct,
} from "./monetizationProductMap.ts";
import { pricePointForTransaction, type OneOffRule } from "./monetizationTyping.ts";

// Shared monetization classification for the Cohorts page.
//
// `transaction_type` stays the single source of truth for the payment lifecycle
// (trial / upsell / first_subscription / renewal_* / token_purchase). The
// MonetizationCategory below is a pure projection on top of it. Upsell slots
// (Upsell 1/2/3/extra) are NOT part of the category: the warehouse audit showed
// funnel upsells carry no ordinal signal, so the slot is assigned by the ORDER
// of the user's successful upsell purchases inside computeCohorts.
export type MonetizationCategory =
  | "trial"
  | "first_subscription"
  | "renewal"
  | "funnel_upsell"
  | "token_purchase"
  /** In-product upsell (read-time typing only; see monetizationTyping.ts). */
  | "app_upsell"
  | "unknown_addon";

const UPSELL_MARKER_PATTERN = /upsell/i;
const ADDON_MARKER_PATTERN = /\b(one[\s_-]?time|add[\s_-]?ons?)\b/i;

const METADATA_PRODUCT_NAME_KEYS = [
  "product",
  "product_name",
  "plan",
  "plan_name",
  "offer",
  "offer_name",
  "ff_product",
  "ff_offer",
] as const;

const METADATA_PRODUCT_ID_KEYS = ["product_id", "sku", "ff_product_id"] as const;

type ProductSignalSource = Pick<Transaction, "product" | "billing_reason"> &
  Partial<Pick<Transaction, "metadata" | "amount_usd" | "gross_amount_usd" | "currency">>;

function metadataStrings(tx: ProductSignalSource, keys: readonly string[]): string[] {
  const metadata = tx.metadata;
  if (!metadata || typeof metadata !== "object") return [];
  const values: string[] = [];
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) values.push(value.trim());
  }
  return values;
}

/** First explicit product id found on the transaction (none in current Palmer data). */
export function productIdForTransaction(tx: ProductSignalSource): string | null {
  return metadataStrings(tx, METADATA_PRODUCT_ID_KEYS)[0] ?? null;
}

/** Product-name-like strings we can safely pattern-match (never card/geo fields). */
export function productNamesForTransaction(tx: ProductSignalSource): string[] {
  const names: string[] = [];
  if (tx.product) names.push(String(tx.product));
  names.push(...metadataStrings(tx, METADATA_PRODUCT_NAME_KEYS));
  return names;
}

/** Funnel marks its upsells via ff_billing_reason (audit: the ONLY upsell signal). */
export function hasUpsellMarker(tx: ProductSignalSource): boolean {
  if (UPSELL_MARKER_PATTERN.test(String(tx.billing_reason ?? ""))) return true;
  const productId = productIdForTransaction(tx);
  return productNamesForTransaction(tx).some((name) => matchesKnownUpsellProduct(productId, name));
}

/**
 * A web-app token/minute pack purchase, resolved via monetizationProductMap:
 * known product id → known name pattern → known pack price+currency.
 * An explicit upsell marker always wins: funnel upsells can be minute packs
 * themselves and must stay in the upsell funnel metrics.
 */
export function isTokenPurchaseTransaction(tx: ProductSignalSource): boolean {
  if (hasUpsellMarker(tx)) return false;
  const productId = productIdForTransaction(tx);
  if (productId && matchesKnownTokenProduct(productId, null)) return true;
  if (productNamesForTransaction(tx).some((name) => matchesKnownTokenProduct(null, name))) return true;
  const amount = tx.gross_amount_usd ?? tx.amount_usd;
  return typeof amount === "number" && isKnownTokenAmount(amount, tx.currency);
}

/** Explicit one-time/add-on marker that is neither an upsell nor a token pack. */
export function hasAddonMarker(tx: ProductSignalSource): boolean {
  return ADDON_MARKER_PATTERN.test(String(tx.billing_reason ?? ""));
}

/**
 * Monetization category for a transaction — a projection of transaction_type
 * plus product signals. Returns null for rows that carry no monetization
 * meaning (failed payments, refunds, chargebacks, plain unknowns).
 */
export function monetizationCategoryForTransaction(tx: Transaction): MonetizationCategory | null {
  switch (tx.transaction_type) {
    case "trial":
      return "trial";
    case "first_subscription":
      return "first_subscription";
    case "renewal_2":
    case "renewal_3":
    case "renewal":
      return "renewal";
    case "token_purchase":
      return "token_purchase";
    case "app_upsell":
      return "app_upsell";
    case "upsell":
      return "funnel_upsell";
    case "unknown":
      return hasAddonMarker(tx) && !isTokenPurchaseTransaction(tx) ? "unknown_addon" : null;
    default:
      return null;
  }
}

// ---- Token pack analytics ----

export interface TokenPackRow {
  product_id: string | null;
  product: string;
  /** Original currency of `price` (server token packs since the 2026-10-23
   * split; absent on the legacy client engine and on cached responses). */
  currency?: string;
  price: number;
  purchases: number;
  buyers: number;
  gross_revenue: number;
  /** Share of the token gross revenue this pack contributed, in percent. */
  revenue_share: number;
}

interface MutableTokenPack {
  product_id: string | null;
  product: string;
  price: number;
  purchases: number;
  buyerIds: Set<string>;
  gross_revenue: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function tokenPackKey(product: string, price: number): string {
  return `${product}|${price.toFixed(2)}`;
}

export function createTokenPackAccumulator(): Map<string, MutableTokenPack> {
  return new Map();
}

export function addTokenPurchaseToPacks(
  packs: Map<string, MutableTokenPack>,
  tx: Pick<Transaction, "product" | "user_id"> & Partial<Pick<Transaction, "metadata" | "billing_reason">>,
  grossAmount: number,
): void {
  const product = tx.product?.trim() || "Unknown pack";
  const price = round2(grossAmount);
  const key = tokenPackKey(product, price);
  const pack = packs.get(key) ?? {
    product_id: productIdForTransaction({ product: tx.product ?? "", billing_reason: tx.billing_reason, metadata: tx.metadata }),
    product,
    price,
    purchases: 0,
    buyerIds: new Set<string>(),
    gross_revenue: 0,
  };
  pack.purchases += 1;
  pack.buyerIds.add(tx.user_id);
  pack.gross_revenue += grossAmount;
  packs.set(key, pack);
}

export function finalizeTokenPacks(packs: Map<string, MutableTokenPack>): TokenPackRow[] {
  const totalGross = Array.from(packs.values()).reduce((sum, pack) => sum + pack.gross_revenue, 0);
  return Array.from(packs.values())
    .map((pack) => ({
      product_id: pack.product_id,
      product: pack.product,
      price: pack.price,
      purchases: pack.purchases,
      buyers: pack.buyerIds.size,
      gross_revenue: round2(pack.gross_revenue),
      revenue_share: totalGross > 0 ? (pack.gross_revenue / totalGross) * 100 : 0,
    }))
    .sort((a, b) => b.gross_revenue - a.gross_revenue || a.product.localeCompare(b.product));
}

/** Group successful token purchases by pack (product + price). */
export function buildTokenPackBreakdown(
  txs: Array<
    Pick<Transaction, "product" | "user_id" | "status" | "transaction_type" | "gross_amount_usd" | "amount_usd"> &
      Partial<Pick<Transaction, "metadata" | "billing_reason">>
  >,
): TokenPackRow[] {
  const packs = createTokenPackAccumulator();
  for (const tx of txs) {
    if (tx.status !== "success" || tx.transaction_type !== "token_purchase") continue;
    const gross = tx.gross_amount_usd ?? (tx.amount_usd > 0 ? tx.amount_usd : 0);
    addTokenPurchaseToPacks(packs, tx, gross);
  }
  return finalizeTokenPacks(packs);
}

/** A pack's merge key: product id, currency and price when the row carries a
 * currency (server packs: a price id priced in its own currency), else the
 * legacy product + price key. */
function aggregatePackKey(row: TokenPackRow): string {
  if (row.currency) return `${row.product_id || row.product}|${row.currency}|${row.price.toFixed(2)}`;
  return tokenPackKey(row.product, row.price);
}

/**
 * Merge per-cohort pack breakdowns into one aggregate table (used for the
 * selected-cohorts summary). Buyer counts are summed: a buyer belongs to
 * exactly one cohort, so cross-cohort sums stay unique per user.
 */
export function aggregateTokenPackBreakdowns(breakdowns: ReadonlyArray<readonly TokenPackRow[]>): TokenPackRow[] {
  const merged = new Map<string, TokenPackRow>();
  for (const rows of breakdowns) {
    for (const row of rows) {
      const key = aggregatePackKey(row);
      const current = merged.get(key);
      if (!current) {
        merged.set(key, { ...row });
        continue;
      }
      current.purchases += row.purchases;
      current.buyers += row.buyers;
      current.gross_revenue = round2(current.gross_revenue + row.gross_revenue);
    }
  }
  const totalGross = Array.from(merged.values()).reduce((sum, row) => sum + row.gross_revenue, 0);
  return Array.from(merged.values())
    .map((row) => ({
      ...row,
      revenue_share: totalGross > 0 ? (row.gross_revenue / totalGross) * 100 : 0,
    }))
    .sort((a, b) => b.gross_revenue - a.gross_revenue || a.product.localeCompare(b.product));
}

// ---- Unknown-product diagnostics (Phase 8) ----

export type UnknownProductCategory = "token_candidate" | "addon_candidate" | "app_upsell_candidate";

/** One unmapped product. The legacy client engine groups by price id (or
 * product id) + product name + USD amount + currency + suggested category and
 * keeps an example transaction id; the server (materialized Cohorts list, data
 * owner only) groups by price id + original amount and currency, names the
 * rule that typed it and never sends a transaction id. */
export interface UnknownProductRow {
  product_id: string | null;
  product_name: string;
  amount: number;
  currency: string;
  count: number;
  users: number;
  example_transaction_id?: string;
  suggested_category: UnknownProductCategory;
  /** The lifecycle type the row got. */
  classified_as?: string;
  /** The typing rule that decided it (monetizationTyping.ts OneOffRule; the
   * client fills it for the two fallback candidates only). */
  rule?: string;
  median_minutes_after_trial?: number;
}

interface MutableUnknownProduct {
  product_id: string | null;
  product_name: string;
  amount: number;
  currency: string;
  count: number;
  userIds: Set<string>;
  example_transaction_id: string;
  suggested_category: UnknownProductCategory;
  classified_as: string;
  rule?: OneOffRule;
}

export function createUnknownProductAccumulator(): Map<string, MutableUnknownProduct> {
  return new Map();
}

export function addUnknownProduct(
  acc: Map<string, MutableUnknownProduct>,
  tx: Transaction,
  suggested: UnknownProductCategory,
  rule?: OneOffRule,
): void {
  const amount = round2(tx.gross_amount_usd ?? tx.amount_usd);
  const currency = String(tx.currency ?? "USD").toUpperCase();
  const productName = tx.product?.trim() || "Unknown product";
  // Hydrated Primer rows share one product name: the FunnelFox price id is what
  // tells unlisted products apart (and what the config needs).
  const productId = productIdForTransaction(tx) ?? (pricePointForTransaction(tx) || null);
  const key = `${productId ?? ""}|${productName}|${amount.toFixed(2)}|${currency}|${suggested}`;
  const row = acc.get(key) ?? {
    product_id: productId,
    product_name: productName,
    amount,
    currency,
    count: 0,
    userIds: new Set<string>(),
    example_transaction_id: tx.transaction_id,
    suggested_category: suggested,
    classified_as: tx.transaction_type,
    ...(rule ? { rule } : {}),
  };
  row.count += 1;
  row.userIds.add(tx.user_id);
  acc.set(key, row);
}

export function finalizeUnknownProducts(acc: Map<string, MutableUnknownProduct>): UnknownProductRow[] {
  return Array.from(acc.values())
    .map(({ userIds, ...row }) => ({ ...row, users: userIds.size }))
    .sort((a, b) => b.count - a.count || a.product_name.localeCompare(b.product_name));
}
