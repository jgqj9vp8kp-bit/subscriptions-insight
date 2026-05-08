import { createClient } from "@supabase/supabase-js";
import { publicRuntimeConfig } from "@/config/publicRuntimeConfig";

const supabaseUrl = publicRuntimeConfig.supabaseUrl;
const supabaseAnonKey = publicRuntimeConfig.supabaseAnonKey;

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

if (!isSupabaseConfigured) {
  console.warn(
    "Supabase Auth is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY, then restart npm run dev.",
  );
}

export const supabase = isSupabaseConfigured
  ? createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        autoRefreshToken: true,
        detectSessionInUrl: true,
        persistSession: true,
      },
    })
  : null;
