// Browser-side surface for the shared support taxonomy (ARCHITECTURE.md:15-19:
// business logic lives in supabase/functions/_shared/clickhouse and is re-exported
// here, so the Edge job, the ClickHouse sync and the UI share one definition).
export {
  SUPPORT_CLASSIFICATION_VERSION_V2,
  SUPPORT_CATEGORIES_V1,
  SUPPORT_CATEGORIES_ADDED_V2,
  SUPPORT_CATEGORIES_V2,
  SUBCATEGORY_BY_CATEGORY,
  CATEGORY_GUIDE,
  FALLBACK_CATEGORY,
  normalizeCategory,
  deriveFlags,
  applyUrgencyFloor,
  buildSystemPrompt,
  buildUserPrompt,
  buildResponseSchema,
  normalizeClassificationEntry,
  parseClassificationResponse,
  type SupportCategoryV2,
  type SupportUrgency,
  type SupportSentiment,
  type SupportEmailToClassify,
  type SupportClassificationResult,
  type SupportClassificationFlags,
} from "../../supabase/functions/_shared/clickhouse/supportTaxonomy";
