const SUPABASE_URL_FALLBACK = "https://wsjbpkderyhdefukppvb.supabase.co";
const SUPABASE_ANON_KEY_FALLBACK = "sb_publishable_9_YvJkk65zgFHZhacO2nHw_8C_ty5xD";

export const publicRuntimeConfig = {
  supabaseUrl: import.meta.env.VITE_SUPABASE_URL?.trim() || SUPABASE_URL_FALLBACK,
  supabaseAnonKey: import.meta.env.VITE_SUPABASE_ANON_KEY?.trim() || SUPABASE_ANON_KEY_FALLBACK,
  funnelFoxMock: import.meta.env.VITE_FUNNELFOX_MOCK ?? "false",
  funnelFoxProxyUrl:
    import.meta.env.VITE_FUNNELFOX_PROXY_URL?.trim() || `${SUPABASE_URL_FALLBACK}/functions/v1`,
};