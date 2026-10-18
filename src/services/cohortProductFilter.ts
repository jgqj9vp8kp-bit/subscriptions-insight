// Cohorts "Product" filter: a product is a FunnelFox project (Azora, Brainza,
// FoxIQ, …). The server serves the path -> project map (clickhouse-cohorts
// action product_paths, supabase/functions/_shared/clickhouse/cohortProducts.ts);
// here a selection of products resolves to campaign paths, which reach every
// engine through the existing campaign_path filter.
import type { CohortProductOption } from "../../supabase/functions/_shared/clickhouse/cohortProducts";

export type { CohortProductOption };

/** Selection key of the bucket without FunnelFox metadata (project_id ""). */
export const UNKNOWN_PRODUCT_KEY = "unknown";

/** Sent as the only campaign path when the product and path selections do not
 * overlap: it matches no cohort, so the report is empty instead of widening to
 * "every path". */
export const NO_PRODUCT_PATH = "\u0001no_product_path\u0001";

export function productKey(product: Pick<CohortProductOption, "project_id">): string {
  return product.project_id || UNKNOWN_PRODUCT_KEY;
}

/** Campaign paths of the selected products; null = no product filter (nothing
 * selected, or the product list is not available). */
export function productPathSet(
  products: readonly CohortProductOption[] | null,
  selectedProducts: readonly string[],
): Set<string> | null {
  if (!products || selectedProducts.length === 0) return null;
  const selected = new Set(selectedProducts);
  const paths = new Set<string>();
  for (const product of products) {
    if (selected.has(productKey(product))) product.campaign_paths.forEach((path) => paths.add(path));
  }
  return paths;
}

/** The campaign_path filter the report runs with: the picked paths, narrowed
 * to the selected products (or all of their paths when no path is picked). */
export function effectiveCampaignPaths(selectedPaths: readonly string[], productPaths: Set<string> | null): string[] {
  if (!productPaths) return [...selectedPaths];
  const paths = selectedPaths.length ? selectedPaths.filter((path) => productPaths.has(path)) : [...productPaths].sort();
  return paths.length ? paths : [NO_PRODUCT_PATH];
}

export function productSummary(products: readonly CohortProductOption[] | null, selectedProducts: readonly string[]): string {
  if (selectedProducts.length === 0) return "All products";
  if (selectedProducts.length > 1) return `${selectedProducts.length} products`;
  const product = products?.find((option) => productKey(option) === selectedProducts[0]);
  return product?.label ?? selectedProducts[0];
}
