const SUPABASE_URL_FALLBACK = "https://wsjbpkderyhdefukppvb.supabase.co";
const SUPABASE_ANON_KEY_FALLBACK = "sb_publishable_9_YvJkk65zgFHZhacO2nHw_8C_ty5xD";

export const publicRuntimeConfig = {
  supabaseUrl: import.meta.env.VITE_SUPABASE_URL?.trim() || SUPABASE_URL_FALLBACK,
  supabaseAnonKey: import.meta.env.VITE_SUPABASE_ANON_KEY?.trim() || SUPABASE_ANON_KEY_FALLBACK,
  funnelFoxMock: import.meta.env.VITE_FUNNELFOX_MOCK ?? "false",
  useTransactionWarehouse: import.meta.env.VITE_USE_TRANSACTION_WAREHOUSE !== "false",
  // Cohorts read path feature flag: "clickhouse" (server-side ClickHouse drives
  // the table; the client compute stays as the on-failure fallback) or "legacy"
  // (client compute only). Only ONE engine drives the table at a time — they are
  // never executed simultaneously for comparison. Default: clickhouse.
  cohortsDataSource: (import.meta.env.VITE_COHORTS_DATA_SOURCE?.trim() === "legacy" ? "legacy" : "clickhouse") as "legacy" | "clickhouse",
  // Users / Payment Analytics read path: "clickhouse" (default; server-side Edge
  // drives the table/filters/sort/pagination, no browser transaction scan) or
  // "legacy" (client compute only). Never both at once.
  usersDataSource: (import.meta.env.VITE_USERS_DATA_SOURCE?.trim() === "legacy" ? "legacy" : "clickhouse") as "legacy" | "clickhouse",
  // Payment Pass Analytics read path: "clickhouse" (default; server-side Edge is
  // the single source of truth, incl. canonical warehouse decline_reason; no
  // browser transaction scan) or "legacy" (client compute only). Never both.
  paymentAnalyticsDataSource: (import.meta.env.VITE_PAYMENT_ANALYTICS_DATA_SOURCE?.trim() === "legacy" ? "legacy" : "clickhouse") as "legacy" | "clickhouse",
  funnelFoxProxyUrl:
    import.meta.env.VITE_FUNNELFOX_PROXY_URL?.trim() || `${SUPABASE_URL_FALLBACK}/functions/v1`,
};
