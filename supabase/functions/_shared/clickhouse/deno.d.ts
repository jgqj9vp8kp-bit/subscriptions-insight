declare const Deno: {
  env: {
    get(name: string): string | undefined;
  };
  serve(handler: (request: Request) => Response | Promise<Response>): void;
};

declare module "https://esm.sh/@supabase/supabase-js@2" {
  import type { SupabaseAuthClient } from "./types.ts";

  export function createClient(url: string, key: string, options?: Record<string, unknown>): SupabaseAuthClient;
}
